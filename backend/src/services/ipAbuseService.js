// src/services/ipAbuseService.js
// ─────────────────────────────────────────────────────────────────────────────
// IP ABUSE TRACKING — exponential backoff and signal aggregation
//
// WHAT THIS MODULE DOES
// ─────────────────────
// Tracks per-IP abuse signals and translates accumulated offences into
// progressively longer rate-limit windows. Each time an IP is penalised
// (rate limit hit, suspicious request, guard rejection), its offence count
// is incremented. The resulting backoff window doubles with each offence,
// capped at BACKOFF_MAX_MS.
//
// BACKOFF SCHEDULE (defaults)
// ────────────────────────────
//   Offence 1 → 15 min  (standard window — same as the base rate limit)
//   Offence 2 → 30 min
//   Offence 3 → 60 min
//   Offence 4 → 120 min (2 hr)
//   Offence 5 → 240 min (4 hr)
//   Offence 6 → 480 min (8 hr)
//   Offence 7 → 960 min (16 hr) ← capped here by default
//
// SIGNALS THAT INCREMENT THE OFFENCE COUNTER
// ────────────────────────────────────────────
//   RATE_LIMIT_HIT    — any 429 from any of the rate limiters
//   GUARD_REJECTION   — requestGuard rejected the request (malformed/hostile)
//   SUSPICIOUS        — suspiciousActivityDetector matched a pattern
//   AUTH_ABUSE        — repeated failed logins from this IP (cross-reported
//                        by lockoutService when many accounts targeted)
//
//  Each signal type carries a weight. Minor signals (a single 429) add 1 point.
//  Severe signals (scanner fingerprint, injection attempt) add more. When the
//  accumulated points cross AUTO_BLACKLIST_THRESHOLD the IP is auto-blacklisted.
//
// RELATION TO OTHER MODULES
// ──────────────────────────
//   abuseDetector middleware → calls recordSignal() on every penalised request
//   rateLimiter              → calls getBackoffMs() to set its windowMs
//   ipBlacklist              → autoBlacklist() is called when threshold crossed
//   requestGuard             → calls recordSignal(GUARD_REJECTION) on rejection
//
// PRODUCTION NOTE
// ───────────────
//   Replace the in-memory Map with Redis:
//     INCR  abuse:{ip}:offences
//     EXPIRE abuse:{ip}:offences <decay_seconds>
//     INCRBY abuse:{ip}:points   <weight>
//     GET   abuse:{ip}:backoff
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const logger = require('../utils/logger');

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE_WINDOW_MS        = parseInt(process.env.RATE_WINDOW_MS        || String(15 * 60 * 1000), 10);
const BACKOFF_MULTIPLIER    = parseFloat(process.env.BACKOFF_MULTIPLIER  || '2');
const BACKOFF_MAX_MS        = parseInt(process.env.BACKOFF_MAX_MS        || String(16 * 60 * 60 * 1000), 10); // 16 hr
const AUTO_BLACKLIST_POINTS = parseInt(process.env.AUTO_BLACKLIST_POINTS || '20', 10);
const DECAY_WINDOW_MS       = parseInt(process.env.ABUSE_DECAY_MS        || String(24 * 60 * 60 * 1000), 10); // 24 hr

// Signal types and their point weights.
// Higher weight = faster path to auto-blacklist.
const SIGNAL = Object.freeze({
  RATE_LIMIT_HIT:  { name: 'RATE_LIMIT_HIT',  points: 1 },
  GUARD_REJECTION: { name: 'GUARD_REJECTION',  points: 3 },
  SUSPICIOUS:      { name: 'SUSPICIOUS',       points: 5 },
  AUTH_ABUSE:      { name: 'AUTH_ABUSE',       points: 4 },
  SCANNER:         { name: 'SCANNER',          points: 8 },
});

// ── In-memory store ───────────────────────────────────────────────────────────
// Map<ip → AbuseRecord>
//
// AbuseRecord: {
//   offences:     number   — total discrete penalisation events
//   points:       number   — weighted sum of signal weights
//   firstSeenAt:  number   — ms timestamp of first recorded signal
//   lastSignalAt: number   — ms timestamp of most recent signal
//   signals:      string[] — ring buffer of last 20 signal names (for diagnostics)
// }

const _records = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Normalise an IP string. Strips IPv6 loopback/localhost to a canonical form
 * so ::1 and 127.0.0.1 resolve to the same key in tests/development.
 * @param {string} ip
 * @returns {string}
 */
function normaliseIp(ip) {
  if (!ip) return 'unknown';
  if (ip === '::1' || ip === '::ffff:127.0.0.1') return '127.0.0.1';
  return ip;
}

/**
 * Compute the backoff window for a given offence count.
 * Uses geometric progression: BASE * MULTIPLIER^(offences - 1), capped at MAX.
 *
 * @param {number} offences  — total number of penalisation events so far
 * @returns {number}  milliseconds
 */
function computeBackoffMs(offences) {
  if (offences <= 0) return BASE_WINDOW_MS;
  const raw = BASE_WINDOW_MS * Math.pow(BACKOFF_MULTIPLIER, offences - 1);
  return Math.min(raw, BACKOFF_MAX_MS);
}

/**
 * Get or initialise a record for an IP.
 */
function _getOrCreate(ip) {
  let record = _records.get(ip);
  if (!record) {
    record = {
      offences:     0,
      points:       0,
      firstSeenAt:  Date.now(),
      lastSignalAt: Date.now(),
      signals:      [],
    };
    _records.set(ip, record);
  }
  return record;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Record an abuse signal for an IP.
 *
 * @param {string} ip
 * @param {typeof SIGNAL[keyof typeof SIGNAL]} signal
 * @param {object} [meta]  — extra context for logging (path, reason, etc.)
 * @returns {{ offences: number, points: number, backoffMs: number, autoBlacklisted: boolean }}
 */
function recordSignal(ip, signal, meta = {}) {
  const normIp  = normaliseIp(ip);
  const record  = _getOrCreate(normIp);
  const now     = Date.now();

  record.offences++;
  record.points       += signal.points;
  record.lastSignalAt  = now;

  // Ring buffer — keep last 20 signal names for diagnostics
  record.signals.push(signal.name);
  if (record.signals.length > 20) record.signals.shift();

  const backoffMs = computeBackoffMs(record.offences);

  logger.warn('Abuse signal recorded', {
    ip:       normIp,
    signal:   signal.name,
    offences: record.offences,
    points:   record.points,
    backoffMs,
    ...meta,
  });

  // Cross-module: trigger auto-blacklist if points threshold crossed
  let autoBlacklisted = false;
  if (record.points >= AUTO_BLACKLIST_POINTS) {
    // Lazy import to break circular dependency: ipBlacklist → ipAbuseService
    const { autoBlacklist } = require('./ipBlacklist');
    const reason = `Auto-blacklisted: ${record.points} abuse points (threshold ${AUTO_BLACKLIST_POINTS})`;
    autoBlacklist(normIp, reason, record.signals);
    autoBlacklisted = true;
  }

  return { offences: record.offences, points: record.points, backoffMs, autoBlacklisted };
}

/**
 * Get the current backoff window for an IP.
 * Returns BASE_WINDOW_MS if no record exists (clean IP).
 *
 * @param {string} ip
 * @returns {number} milliseconds
 */
function getBackoffMs(ip) {
  const normIp = normaliseIp(ip);
  const record = _records.get(normIp);
  if (!record) return BASE_WINDOW_MS;
  return computeBackoffMs(record.offences);
}

/**
 * Get full abuse status for an IP (for diagnostics / admin endpoints).
 *
 * @param {string} ip
 * @returns {object|null}
 */
function getStatus(ip) {
  const normIp = normaliseIp(ip);
  const record = _records.get(normIp);
  if (!record) return null;
  return {
    ip:           normIp,
    offences:     record.offences,
    points:       record.points,
    backoffMs:    computeBackoffMs(record.offences),
    firstSeenAt:  new Date(record.firstSeenAt).toISOString(),
    lastSignalAt: new Date(record.lastSignalAt).toISOString(),
    signals:      [...record.signals],
  };
}

/**
 * Reset abuse record for an IP (admin use, e.g. after false-positive review).
 * @param {string} ip
 */
function resetRecord(ip) {
  const normIp = normaliseIp(ip);
  _records.delete(normIp);
  logger.info('Abuse record reset', { ip: normIp });
}

// ── Periodic decay ────────────────────────────────────────────────────────────
// Clean up records that have not fired a signal in DECAY_WINDOW_MS.
// IPs that go quiet for 24 hours start fresh next time they appear.
setInterval(() => {
  const now   = Date.now();
  let deleted = 0;
  for (const [ip, record] of _records.entries()) {
    if (now - record.lastSignalAt > DECAY_WINDOW_MS) {
      _records.delete(ip);
      deleted++;
    }
  }
  if (deleted > 0) {
    logger.info(`Abuse records decayed: ${deleted} stale records removed`);
  }
}, 60 * 60 * 1000).unref(); // run hourly, don't block process exit

module.exports = {
  recordSignal,
  getBackoffMs,
  getStatus,
  resetRecord,
  computeBackoffMs,  // exported for tests
  normaliseIp,       // exported for tests
  SIGNAL,
  BASE_WINDOW_MS,
  AUTO_BLACKLIST_POINTS,
};

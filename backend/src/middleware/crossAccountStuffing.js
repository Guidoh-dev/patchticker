// src/middleware/crossAccountStuffing.js
// ─────────────────────────────────────────────────────────────────────────────
// CROSS-ACCOUNT CREDENTIAL STUFFING DETECTOR
//
// THE GAP THIS FILLS
// ───────────────────
// lockoutService protects individual accounts (5 failures → lock that account).
// loginLimiter protects per-IP (10 req/15min from one IP → 429).
//
// Neither catches this pattern:
//   One IP → 500 different email addresses, 4 failures each
//   Result: 2000 failed logins, no single account locked, IP under rate limit
//
// This middleware tracks UNIQUE ACCOUNTS FAILED per IP per window.
// When one IP fails against more than UNIQUE_ACCOUNT_THRESHOLD different accounts,
// it fires an AUTH_ABUSE signal (which feeds ipAbuseService → auto-blacklist).
//
// THRESHOLDS
// ───────────
//   STUFFING_WINDOW_MS         — sliding window (default 15 min)
//   STUFFING_UNIQUE_THRESHOLD  — unique accounts before signal fires (default 10)
//   STUFFING_SIGNAL_EVERY      — re-fire signal every N more unique accounts (default 5)
//
// STORAGE
// ────────
// In-memory Map<ip → Set<emailHmac>>. Replace with Redis SADD/SCARD/EXPIRE
// for multi-process deployments.
//
// PLACEMENT
// ──────────
// Mounted on POST /api/auth/login as post-response middleware via res.on('finish').
// Only records failed attempts (401 responses). Does not block requests itself —
// blocking is delegated to ipAbuseService via the AUTH_ABUSE signal.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { hmac }                   = require('../utils/encrypt');
const { recordSignal, SIGNAL }   = require('../services/ipAbuseService');
const logger                     = require('../utils/logger');

const WINDOW_MS          = parseInt(process.env.STUFFING_WINDOW_MS         || String(15 * 60 * 1000), 10);
const UNIQUE_THRESHOLD   = parseInt(process.env.STUFFING_UNIQUE_THRESHOLD  || '10', 10);
const SIGNAL_EVERY       = parseInt(process.env.STUFFING_SIGNAL_EVERY      || '5',  10);

// Map<ip → { accounts: Set<emailHmac>, windowStart: number }>
const _tracker = new Map();

/**
 * Record a failed login attempt for cross-account stuffing detection.
 * Called after the response is sent (res.on('finish')) so it doesn't
 * add latency to the login route.
 *
 * @param {string} ip
 * @param {string} email  — plaintext email (will be HMACed before storage)
 */
function recordStuffingAttempt(ip, email) {
  if (!ip || !email) return;

  const now       = Date.now();
  const emailKey  = hmac(email.toLowerCase().trim());
  let   entry     = _tracker.get(ip);

  // Reset window if expired
  if (!entry || (now - entry.windowStart) > WINDOW_MS) {
    entry = { accounts: new Set(), windowStart: now };
    _tracker.set(ip, entry);
  }

  const sizeBefore = entry.accounts.size;
  entry.accounts.add(emailKey);
  const sizeAfter = entry.accounts.size;

  // Only proceed if this is a new unique account
  if (sizeAfter <= sizeBefore) return;

  // Fire AUTH_ABUSE signal when threshold crossed, then every SIGNAL_EVERY after
  if (sizeAfter === UNIQUE_THRESHOLD ||
      (sizeAfter > UNIQUE_THRESHOLD && (sizeAfter - UNIQUE_THRESHOLD) % SIGNAL_EVERY === 0)) {

    const result = recordSignal(ip, SIGNAL.AUTH_ABUSE, {
      reason:         'cross-account credential stuffing',
      uniqueAccounts: sizeAfter,
      windowMs:       WINDOW_MS,
    });

    logger.warn('[stuffing] Cross-account stuffing detected', {
      ip,
      uniqueAccounts:  sizeAfter,
      threshold:       UNIQUE_THRESHOLD,
      offences:        result.offences,
      points:          result.points,
      autoBlacklisted: result.autoBlacklisted,
    });
  }
}

/**
 * Express middleware — attach post-response hook to login route.
 * Must be mounted BEFORE the login handler on POST /api/auth/login.
 *
 * @type {import('express').RequestHandler}
 */
function crossAccountStuffingDetector(req, res, next) {
  const ip    = req.ip;
  const email = req.body?.email;

  // Hook fires after response is sent — no latency impact
  res.on('finish', () => {
    // Only track failed authentication attempts
    if (res.statusCode === 401) {
      recordStuffingAttempt(ip, email);
    }
  });

  next();
}

// ── Periodic cleanup ──────────────────────────────────────────────────────────
setInterval(() => {
  const now     = Date.now();
  let   deleted = 0;
  for (const [ip, entry] of _tracker.entries()) {
    if ((now - entry.windowStart) > WINDOW_MS * 2) {
      _tracker.delete(ip);
      deleted++;
    }
  }
  if (deleted > 0) logger.info(`[stuffing] Cleaned ${deleted} stale tracking entries`);
}, WINDOW_MS).unref();

module.exports = crossAccountStuffingDetector;
module.exports.recordStuffingAttempt = recordStuffingAttempt; // exported for tests

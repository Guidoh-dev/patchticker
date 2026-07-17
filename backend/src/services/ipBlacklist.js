// src/services/ipBlacklist.js
// ─────────────────────────────────────────────────────────────────────────────
// IP BLACKLIST — permanent and TTL-based IP bans with CIDR range support
//
// TYPES OF ENTRY
// ──────────────
//   Permanent     — no expiry, survives server restarts if persisted (see note)
//   TTL-based     — expires after a given duration (auto-blacklists use this)
//   CIDR range    — blocks an entire subnet e.g. 192.168.1.0/24
//
// HOW AUTO-BLACKLISTING WORKS
// ────────────────────────────
//   ipAbuseService calls autoBlacklist() when an IP accumulates enough abuse
//   points. Auto-entries expire after AUTO_BLACKLIST_TTL_MS (default 24 hr).
//   Repeat offenders who re-accumulate points will be re-blacklisted, at which
//   point a human should review and promote to a permanent ban.
//
// CIDR MATCHING
// ──────────────
//   Implemented without external dependencies. Supports IPv4 CIDR notation
//   (e.g. 10.0.0.0/8). IPv6 CIDR is not supported in this implementation —
//   add a dependency like `ip-cidr` if needed.
//
// BOOTSTRAP BLOCKLIST
// ─────────────────────
//   Pre-populate known-bad ranges at startup via the BLOCKED_CIDRS env var:
//     BLOCKED_CIDRS=10.0.0.0/8,192.168.100.0/24
//
// PRODUCTION NOTE
// ───────────────
//   Replace in-memory Maps with Redis:
//     SET   blacklist:{ip} <reason> EX <ttl_seconds>   — for TTL entries
//     SET   blacklist:{ip} <reason>                    — for permanent entries
//     SADD  blacklist:cidrs <cidr>                     — for CIDR entries
//   The abuseDetector middleware should check these keys before processing
//   each request. Redis SINTERSTORE can batch-check multiple keys.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const logger = require('../utils/logger');

// ── Constants ─────────────────────────────────────────────────────────────────

// How long auto-blacklist entries live before expiry (default 24 hr)
const AUTO_BLACKLIST_TTL_MS = parseInt(
  process.env.AUTO_BLACKLIST_TTL_MS || String(24 * 60 * 60 * 1000),
  10
);

// ── In-memory stores ──────────────────────────────────────────────────────────

// Map<ip → BlacklistEntry>
// BlacklistEntry: { reason, addedAt, expiresAt|null, permanent, autoAdded, signals[] }
const _entries = new Map();

// Set of CIDR strings e.g. '192.168.1.0/24'
const _cidrs = new Set();

// ── CIDR helpers ──────────────────────────────────────────────────────────────

/**
 * Convert a dotted IPv4 string to a 32-bit unsigned integer.
 * @param {string} ip  e.g. '192.168.1.42'
 * @returns {number}
 */
function _ipToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

/**
 * Check whether a dotted IPv4 address falls inside a CIDR block.
 * @param {string} ip    e.g. '192.168.1.42'
 * @param {string} cidr  e.g. '192.168.1.0/24'
 * @returns {boolean}
 */
function _ipInCidr(ip, cidr) {
  try {
    const [network, prefixStr] = cidr.split('/');
    const prefix = parseInt(prefixStr, 10);
    if (isNaN(prefix) || prefix < 0 || prefix > 32) return false;

    const mask       = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    const networkInt = _ipToInt(network) & mask;
    const ipInt      = _ipToInt(ip) & mask;

    return networkInt === ipInt;
  } catch {
    return false;
  }
}

/**
 * Check whether an IPv4 address matches any registered CIDR block.
 * @param {string} ip
 * @returns {{ matched: boolean, cidr: string|null }}
 */
function _matchesCidr(ip) {
  // Skip CIDR checks for IPv6 addresses — not supported
  if (!ip || ip.includes(':')) return { matched: false, cidr: null };
  for (const cidr of _cidrs) {
    if (_ipInCidr(ip, cidr)) return { matched: true, cidr };
  }
  return { matched: false, cidr: null };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check whether an IP is blacklisted (by exact match or CIDR).
 *
 * @param {string} ip
 * @returns {{ blocked: boolean, reason: string|null, permanent: boolean, expiresAt: number|null }}
 */
function isBlacklisted(ip) {
  const now = Date.now();

  // Exact IP match
  const entry = _entries.get(ip);
  if (entry) {
    if (entry.expiresAt !== null && entry.expiresAt <= now) {
      // TTL expired — clean up and allow through
      _entries.delete(ip);
      logger.info('Blacklist entry expired', { ip, reason: entry.reason });
    } else {
      return {
        blocked:    true,
        reason:     entry.reason,
        permanent:  entry.permanent,
        expiresAt:  entry.expiresAt,
      };
    }
  }

  // CIDR range match
  const cidrMatch = _matchesCidr(ip);
  if (cidrMatch.matched) {
    return {
      blocked:   true,
      reason:    `IP ${ip} falls within blocked CIDR range ${cidrMatch.cidr}`,
      permanent: true,
      expiresAt: null,
    };
  }

  return { blocked: false, reason: null, permanent: false, expiresAt: null };
}

/**
 * Permanently blacklist an IP.
 *
 * @param {string} ip
 * @param {string} reason
 */
function blacklist(ip, reason) {
  _entries.set(ip, {
    reason,
    addedAt:   Date.now(),
    expiresAt: null,
    permanent: true,
    autoAdded: false,
    signals:   [],
  });
  logger.warn('IP permanently blacklisted', { ip, reason });
}

/**
 * Temporarily blacklist an IP (used by ipAbuseService auto-blacklisting).
 * If the IP is already permanently blacklisted, this is a no-op.
 *
 * @param {string} ip
 * @param {string} reason
 * @param {string[]} [signals]  — recent signal history from ipAbuseService
 * @param {number}  [ttlMs]     — TTL override (defaults to AUTO_BLACKLIST_TTL_MS)
 */
function autoBlacklist(ip, reason, signals = [], ttlMs = AUTO_BLACKLIST_TTL_MS) {
  const existing = _entries.get(ip);
  if (existing && existing.permanent) {
    // Already permanently blocked — don't downgrade to TTL
    return;
  }

  const expiresAt = Date.now() + ttlMs;
  _entries.set(ip, {
    reason,
    addedAt:   Date.now(),
    expiresAt,
    permanent: false,
    autoAdded: true,
    signals:   signals.slice(-20),
  });
  logger.warn('IP auto-blacklisted (TTL)', {
    ip,
    reason,
    expiresAtIso: new Date(expiresAt).toISOString(),
    ttlMs,
    recentSignals: signals.slice(-5),
  });
}

/**
 * Remove an IP from the blacklist (admin action after false-positive review).
 * @param {string} ip
 * @returns {boolean} true if an entry was removed, false if not found
 */
function unblacklist(ip) {
  const existed = _entries.has(ip);
  _entries.delete(ip);
  if (existed) {
    logger.info('IP removed from blacklist', { ip });
  }
  return existed;
}

/**
 * Block an entire CIDR range permanently.
 * @param {string} cidr  e.g. '192.168.1.0/24'
 * @param {string} reason
 */
function blockCidr(cidr, reason) {
  _cidrs.add(cidr);
  logger.warn('CIDR range blocked', { cidr, reason });
}

/**
 * Remove a CIDR block.
 * @param {string} cidr
 */
function unblockCidr(cidr) {
  _cidrs.delete(cidr);
  logger.info('CIDR range unblocked', { cidr });
}

/**
 * List all current blacklist entries (for admin diagnostics).
 * @returns {object[]}
 */
function listBlacklist() {
  const now     = Date.now();
  const entries = [];
  for (const [ip, entry] of _entries.entries()) {
    // Skip already-expired entries
    if (entry.expiresAt !== null && entry.expiresAt <= now) continue;
    entries.push({
      ip,
      reason:     entry.reason,
      permanent:  entry.permanent,
      autoAdded:  entry.autoAdded,
      addedAtIso: new Date(entry.addedAt).toISOString(),
      expiresAtIso: entry.expiresAt ? new Date(entry.expiresAt).toISOString() : null,
    });
  }
  return entries;
}

/**
 * List all blocked CIDR ranges.
 * @returns {string[]}
 */
function listCidrs() {
  return [..._cidrs];
}

// ── Bootstrap: CIDR blocks from env ──────────────────────────────────────────
// Pre-populate known-bad ranges from BLOCKED_CIDRS env var at startup.
//   BLOCKED_CIDRS=10.0.0.0/8,192.168.100.0/24
const _envCidrs = process.env.BLOCKED_CIDRS || '';
if (_envCidrs) {
  for (const cidr of _envCidrs.split(',').map(s => s.trim()).filter(Boolean)) {
    blockCidr(cidr, 'Loaded from BLOCKED_CIDRS env var');
  }
}

// ── Periodic cleanup ──────────────────────────────────────────────────────────
// Purge expired TTL entries every hour to prevent unbounded Map growth.
setInterval(() => {
  const now     = Date.now();
  let deleted   = 0;
  for (const [ip, entry] of _entries.entries()) {
    if (entry.expiresAt !== null && entry.expiresAt <= now) {
      _entries.delete(ip);
      deleted++;
    }
  }
  if (deleted > 0) {
    logger.info(`Blacklist: ${deleted} expired TTL entries removed`);
  }
}, 60 * 60 * 1000).unref();

module.exports = {
  isBlacklisted,
  blacklist,
  autoBlacklist,
  unblacklist,
  blockCidr,
  unblockCidr,
  listBlacklist,
  listCidrs,
  // exported for tests
  _ipInCidr,
  _matchesCidr,
  AUTO_BLACKLIST_TTL_MS,
};

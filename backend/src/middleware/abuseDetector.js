// src/middleware/abuseDetector.js
// ─────────────────────────────────────────────────────────────────────────────
// ABUSE DETECTOR — blacklist enforcement and signal recording
//
// TWO RESPONSIBILITIES
// ─────────────────────
//
//  1. BLACKLIST ENFORCEMENT (runs on every request)
//     Checks the requesting IP against ipBlacklist before any other
//     middleware runs. Permanently blocked IPs get an immediate 403 with
//     no further processing. TTL-blocked IPs also get 403 with the
//     approximate unlock time included in the response.
//
//     Why 403 instead of 404?
//       404 is a common tactic to hide blocking from scanners.
//       We use 403 deliberately — it stops browsers/clients retrying
//       with different paths and clearly signals "you are blocked".
//       Truly opaque blocking (no response) is only appropriate at the
//       network layer (firewall), not at the application layer.
//
//  2. RATE LIMIT SIGNAL RECORDING (wraps response to catch 429s)
//     Intercepts the response status code by wrapping res.status().
//     When a 429 is issued by any downstream limiter, it records a
//     RATE_LIMIT_HIT signal against that IP via ipAbuseService.
//     This feeds the backoff counter so repeat offenders get longer windows.
//
// PLACEMENT IN MIDDLEWARE CHAIN
// ──────────────────────────────
//   abuseDetector must run BEFORE:
//     - requestGuard (blacklisted IPs don't need firewall processing)
//     - all rate limiters (so the 429 interception works)
//     - body parsing (no need to parse blocked requests)
//   abuseDetector must run AFTER:
//     - trust proxy setting (req.ip must be correctly resolved)
//     - HTTPS redirect (we want HTTPS before blacklist check)
//     - security headers (all responses should have security headers)
//     - CORS (OPTIONS preflight must be handled before blacklist)
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { isBlacklisted }      = require('../services/ipBlacklist');
const { recordSignal, SIGNAL } = require('../services/ipAbuseService');
const logger                 = require('../utils/logger');

/**
 * Format remaining block time into a human-readable string.
 * @param {number|null} expiresAt  ms timestamp or null
 * @returns {string}
 */
function formatBlockRemaining(expiresAt) {
  if (!expiresAt) return 'indefinitely';
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return 'shortly';
  const hours   = Math.floor(remaining / 3600000);
  const minutes = Math.ceil((remaining % 3600000) / 60000);
  if (hours > 0) return `approximately ${hours}h ${minutes}m`;
  return `approximately ${minutes} minute${minutes !== 1 ? 's' : ''}`;
}

/**
 * Abuse detector middleware.
 * @type {import('express').RequestHandler}
 */
function abuseDetector(req, res, next) {
  const ip = req.ip;

  // ── 1. Blacklist check ────────────────────────────────────────────────────
  const check = isBlacklisted(ip);
  if (check.blocked) {
    logger.warn('Blocked request from blacklisted IP', {
      ip,
      reason:    check.reason,
      permanent: check.permanent,
      method:    req.method,
      path:      req.path,
    });
    return res.status(403).json({
      error:    'Access denied.',
      blockedFor: formatBlockRemaining(check.expiresAt),
    });
  }

  // ── 2. Intercept 429 responses to record abuse signals ───────────────────
  // Wrap res.status() so we can observe the status code before it's sent.
  // We only need to intercept — we never modify the response.
  const originalStatus = res.status.bind(res);
  res.status = function interceptStatus(code) {
    if (code === 429) {
      // Record a rate-limit-hit signal — this feeds the backoff counter
      recordSignal(ip, SIGNAL.RATE_LIMIT_HIT, {
        path:   req.path,
        method: req.method,
      });
      // Restore original immediately so chained .json() works normally
      res.status = originalStatus;
    }
    return originalStatus(code);
  };

  next();
}

module.exports = abuseDetector;

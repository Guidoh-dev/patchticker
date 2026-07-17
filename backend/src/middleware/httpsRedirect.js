// src/middleware/httpsRedirect.js
// ─────────────────────────────────────────────────────────────────────────────
// HTTPS ENFORCEMENT MIDDLEWARE
//
// Redirects HTTP → HTTPS in production. Works correctly behind any
// TLS-terminating reverse proxy (Nginx, Cloudflare, AWS ALB, Heroku, etc.)
// by reading forwarded protocol headers before deciding whether to redirect.
//
// PROTOCOL DETECTION (in priority order)
// ─────────────────────────────────────────
//   1. req.cfVisitor.scheme    — set by cloudflare.js middleware from CF-Visitor
//                                JSON header; most authoritative when behind CF
//   2. req.secure              — Express derives from X-Forwarded-Proto when
//                                trust proxy is configured
//   3. req.protocol === 'https' — same derivation path as req.secure
//   4. X-Forwarded-Proto: https — raw header check as belt-and-suspenders
//
// WHY CF-VISITOR FIRST?
// ──────────────────────
// Cloudflare sets CF-Visitor: {"scheme":"https"} when the *browser* connected
// to Cloudflare over HTTPS, regardless of what protocol Cloudflare uses to
// reach the origin. Checking it first prevents false redirect loops in
// "Full (strict)" SSL mode where Cloudflare connects to the origin over HTTPS
// but the internal request still arrives with X-Forwarded-Proto: https.
// In practice both agree — CF-Visitor is a more explicit source.
//
// CLOUDFLARE LOOP SAFETY
// ───────────────────────
// With Cloudflare in "Full" or "Full (strict)" SSL mode:
//   - The browser connects to CF over HTTPS
//   - CF connects to the origin over HTTPS (or HTTP depending on mode)
//   - CF sets X-Forwarded-Proto: https AND CF-Visitor: {"scheme":"https"}
//   - req.secure = true (because trust proxy resolves it)
//   - httpsRedirect sees isHttps() = true → no redirect → no loop ✓
//
// With Cloudflare in "Flexible" SSL mode (NOT RECOMMENDED):
//   - Browser connects over HTTPS, CF connects to origin over HTTP
//   - CF-Visitor: {"scheme":"https"} (browser was HTTPS)
//   - This middleware correctly reports isHttps() = true (browser was HTTPS)
//   - No redirect issued ✓
//
// HEALTH CHECK EXEMPTION
// ───────────────────────
// GET /api/health is exempt. Load balancers and health probes often use HTTP
// on the internal network — redirecting them breaks availability checks.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const cfg    = require('../config/security');
const logger = require('../utils/logger');

// Paths that bypass HTTPS redirect regardless of protocol
const EXEMPT_PATHS = new Set(['/api/health']);

/**
 * Determine whether the original client request arrived over HTTPS.
 * Checks multiple sources in priority order for maximum proxy compatibility.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isHttps(req) {
  // 1. CF-Visitor (most authoritative when behind Cloudflare)
  //    Set by cloudflare.js middleware from the CF-Visitor JSON header.
  if (req.cfVisitor === 'https') return true;
  if (req.cfVisitor === 'http')  return false;

  // 2. req.secure — set by Express when trust proxy is configured and
  //    X-Forwarded-Proto: https is present
  if (req.secure) return true;

  // 3. req.protocol — same derivation as req.secure, explicit check
  if (req.protocol === 'https') return true;

  // 4. Raw X-Forwarded-Proto header — belt-and-suspenders for non-CF proxies
  if (req.headers['x-forwarded-proto'] === 'https') return true;

  return false;
}

/**
 * HTTPS redirect middleware.
 *
 * @type {import('express').RequestHandler}
 */
function httpsRedirect(req, res, next) {
  if (!cfg.HTTPS_REDIRECT) return next();
  if (EXEMPT_PATHS.has(req.path)) return next();

  if (!isHttps(req)) {
    const httpsUrl = `https://${req.hostname}${req.originalUrl}`;
    logger.info('HTTP→HTTPS redirect', { ip: req.ip, from: req.originalUrl });
    // 301: permanent — cached by browsers, so repeat visitors skip HTTP entirely
    return res.redirect(301, httpsUrl);
  }

  next();
}

module.exports = httpsRedirect;

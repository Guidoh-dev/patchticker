// src/middleware/csrf.js
// ─────────────────────────────────────────────────────────────────────────────
// CSRF PROTECTION — Double-Submit Cookie Pattern via csrf-csrf
//
// WHY CSRF PROTECTION IS NEEDED HERE
// ────────────────────────────────────
//  The refresh token is stored in an HTTP-only cookie.
//  HTTP-only cookies are sent automatically by the browser on same-origin and
//  cross-origin requests (subject to SameSite policy). A malicious page on
//  evil.com could trigger a POST to our /api/auth/refresh endpoint and the
//  browser would include the refresh cookie automatically.
//
//  CSRF protection requires that mutation requests also include a secret that
//  only JavaScript running on our actual domain can read.
//
// IMPLEMENTATION: DOUBLE-SUBMIT COOKIE PATTERN
// ─────────────────────────────────────────────
//  1. Server sets a CSRF token in a non-HttpOnly cookie (readable by JS)
//  2. Client JS reads it and echoes it in the X-CSRF-Token request header
//  3. Server verifies header value matches the cookie value (HMAC-signed)
//
//  An attacker page on evil.com cannot read our cookies (SOP), so it cannot
//  forge the header, so the request is rejected even though the refresh cookie
//  is attached.
//
// ROUTES PROTECTED
// ─────────────────
//  All state-mutating auth routes:
//    POST /api/auth/login
//    POST /api/auth/register
//    POST /api/auth/refresh
//    POST /api/auth/logout
//
// CSRF COOKIE NAME : pp-csrf
// CSRF HEADER NAME : x-csrf-token
//
// HOW THE FRONTEND GETS THE TOKEN
// ─────────────────────────────────
//  GET /api/auth/csrf-token — returns the token in the response body AND
//  sets the CSRF cookie. Frontend calls this once on page load, stores
//  the token value, and attaches it as a header on subsequent mutations.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { doubleCsrf } = require('csrf-csrf');
const logger  = require('../utils/logger');
const secrets = require('../config/secrets');

const isProd = process.env.NODE_ENV === 'production';

const {
  generateToken,
  doubleCsrfProtection,
} = doubleCsrf({
  // Return all valid secrets so csrf-csrf tries each one during validation.
  // During a rotation overlap window this returns [current, previous], so
  // tokens signed with the old secret remain valid for ROTATION_OVERLAP_MS.
  // After the overlap window only [current] is returned.
  getSecret: () => secrets.getCsrfSecrets(),
  cookieName:      'pp-csrf',
  cookieOptions: {
    sameSite: 'strict',   // blocks cross-site CSRF entirely for modern browsers
    httpOnly: false,      // MUST be false — JS needs to read this cookie
    secure:   isProd,     // HTTPS only in production
    path:     '/',
  },
  size:            64,    // token size in bytes
  getTokenFromRequest: (req) => {
    // Accept token from header only — not from body or query string
    return req.headers['x-csrf-token'];
  },
  errorConfig: {
    statusCode: 403,
    message:    'Invalid CSRF token',
  },
});

/**
 * Express middleware that validates the CSRF token on state-mutating routes.
 * Attach to POST /api/auth/* routes.
 *
 * @type {import('express').RequestHandler}
 */
function csrfProtection(req, res, next) {
  try {
    doubleCsrfProtection(req, res, next);
  } catch (err) {
    logger.warn('CSRF validation failed', { ip: req.ip, path: req.path });
    res.status(403).json({ error: 'Invalid CSRF token' });
  }
}

/**
 * Generate and return a CSRF token. Call from GET /api/auth/csrf-token.
 * Sets the pp-csrf cookie and returns the token value for the JS header.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
function sendCsrfToken(req, res) {
  const token = generateToken(req, res);
  res.json({ csrfToken: token });
}

module.exports = { csrfProtection, sendCsrfToken };

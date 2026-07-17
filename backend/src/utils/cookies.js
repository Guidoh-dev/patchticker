// src/utils/cookies.js
// ─────────────────────────────────────────────────────────────────────────────
// REFRESH TOKEN COOKIE CONFIGURATION
//
// Security properties:
//   httpOnly : true  — not readable by JavaScript; XSS cannot exfiltrate it
//   secure   : true  — HTTPS only in production (prevents network sniffing)
//   sameSite : 'strict' — not sent on cross-site requests (primary CSRF defence)
//   path     : '/api/auth' — scoped; not sent on requests to other paths
//
// Why 'strict' SameSite + CSRF token (double layer)?
//   SameSite=strict stops most CSRF on its own, but has edge cases:
//     • Top-level navigation (link clicks) may bypass SameSite=strict
//     • Older browsers don't support SameSite
//   The CSRF double-submit cookie adds explicit cryptographic verification
//   for all auth mutation endpoints.
//
// Cookie name: pp-rt (short, non-descriptive — reduces information leakage)
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { REFRESH_TTL } = require('../services/tokenService');

const COOKIE_NAME = 'pp-rt';
const isProd      = process.env.NODE_ENV === 'production';

/**
 * Cookie options for the refresh token.
 * @type {import('express').CookieOptions}
 */
const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,            // NOT readable by JavaScript
  secure:   isProd,          // HTTPS only in production
  sameSite: 'strict',        // not sent cross-site
  path:     '/api/auth',     // scoped to auth routes only
  maxAge:   REFRESH_TTL * 1000, // milliseconds
};

/**
 * Set the refresh token as an HTTP-only secure cookie on the response.
 * @param {import('express').Response} res
 * @param {string} token   raw refresh token
 */
function setRefreshCookie(res, token) {
  res.cookie(COOKIE_NAME, token, REFRESH_COOKIE_OPTIONS);
}

/**
 * Clear the refresh token cookie (used on logout).
 * @param {import('express').Response} res
 */
function clearRefreshCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure:   isProd,
    sameSite: 'strict',
    path:     '/api/auth',
  });
}

/**
 * Read the raw refresh token from the request cookie.
 * @param {import('express').Request} req
 * @returns {string | undefined}
 */
function getRefreshToken(req) {
  return req.cookies?.[COOKIE_NAME];
}

module.exports = { setRefreshCookie, clearRefreshCookie, getRefreshToken, COOKIE_NAME };

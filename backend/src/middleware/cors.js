// src/middleware/cors.js
// ─────────────────────────────────────────────────────────────────────────────
// CORS POLICY — production-hardened, multi-origin, fully annotated
//
// WHAT CORS PROTECTS AGAINST
// ────────────────────────────
// The Same-Origin Policy (SOP) prevents evil.com from reading responses from
// api.patchticker.app. CORS is the controlled relaxation of SOP — it lets
// *our* frontend origins read our API responses while blocking everyone else.
//
// WHAT CORS DOES NOT PROTECT AGAINST
// ─────────────────────────────────────
// CORS is enforced by browsers. Server-to-server requests, curl, and
// non-browser clients bypass it entirely. Never rely on CORS alone for
// access control — use authentication (JWT, session) for that.
//
// CONFIGURATION
// ──────────────
//   ALLOWED_ORIGINS  (from config/security.js, sourced from env)
//   Comma-separated list: https://patchticker.app,https://www.patchticker.app
//
// ALLOWED METHODS
// ─────────────────
//   GET, POST, OPTIONS
//   OPTIONS is required for preflight requests.
//
// ALLOWED HEADERS
// ─────────────────
//   Content-Type       — required for JSON request bodies
//   Authorization      — Bearer <access_token> for protected routes
//   X-CSRF-Token       — CSRF token header (double-submit cookie pattern)
//
// EXPOSED HEADERS
// ─────────────────
//   X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
//   Set by express-rate-limit — visible to browser JS for UX messaging.
//
// CREDENTIALS
// ────────────
//   true — required to send cookies (the HTTP-only refresh token cookie).
//   When credentials:true, origin CANNOT be wildcard '*'.
//
// PREFLIGHT CACHING
// ──────────────────
//   maxAge: 86400 (24 hours) — browser caches the preflight result.
//   Without this, every non-simple request fires an OPTIONS preflight,
//   doubling latency.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const cors   = require('cors');
const cfg    = require('../config/security');
const logger = require('../utils/logger');

// Build a Set for O(1) origin lookups
const _allowedSet = new Set(cfg.ALLOWED_ORIGINS);

/**
 * Origin callback for the cors package.
 * @param {string|undefined} origin
 * @param {Function} callback
 */
function originCallback(origin, callback) {
  // No Origin header — same-origin, server-to-server, or curl.
  // Not a cross-origin browser request — allow through.
  if (!origin) {
    return callback(null, true);
  }

  if (_allowedSet.has(origin)) {
    return callback(null, true);
  }

  logger.warn('CORS: blocked request from unlisted origin', {
    origin,
    allowedOrigins: cfg.ALLOWED_ORIGINS,
  });

  const err = new Error(`CORS policy: origin '${origin}' is not allowed`);
  err.status = 403;
  return callback(err);
}

const corsOptions = {
  origin: originCallback,

  // Only what the API actually uses
  methods: ['GET', 'POST', 'OPTIONS'],

  // Headers the browser is allowed to send
  allowedHeaders: [
    'Content-Type',    // JSON bodies
    'Authorization',   // Bearer <access_token>
    'X-CSRF-Token',    // CSRF double-submit header
  ],

  // Rate limit headers need to be visible to browser JS
  exposedHeaders: [
    'X-RateLimit-Limit',
    'X-RateLimit-Remaining',
    'X-RateLimit-Reset',
  ],

  // Required for cookies (refresh token). Forbids wildcard origin when true.
  credentials: true,

  // Cache preflight 24 hours — prevents OPTIONS round-trip on every request
  maxAge: 86400,

  optionsSuccessStatus: 204,
};

module.exports = cors(corsOptions);

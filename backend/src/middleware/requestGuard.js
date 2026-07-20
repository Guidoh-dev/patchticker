// src/middleware/requestGuard.js
// ─────────────────────────────────────────────────────────────────────────────
// PRE-ROUTE REQUEST FIREWALL
//
// Runs on every request BEFORE route handlers. Rejects obviously malformed or
// hostile requests at the middleware layer so route + service code never sees them.
//
// Checks performed:
//   1. Content-Type enforcement for POST/PUT/PATCH
//      — Rejects requests with non-JSON bodies (prevents multipart smuggling,
//        XML injection, form-encoded parameter pollution)
//
//   2. Oversized JSON body guard (belt-and-suspenders over Express body size limit)
//      — Content-Length header checked against MAX_BODY_BYTES before parsing
//
//   3. Null-byte detection in URL path
//      — Null bytes in URLs can bypass extension filters or confuse C-based parsers
//
//   4. Path traversal detection in URL
//      — Rejects any URL containing ../ or ..\
//
//   5. HTTP method allowlist
//      — Only GET and POST are valid for this API; everything else is rejected
//
//   6. Oversized individual query parameter values
//      — Prevents DoS via enormous query strings that pass through to service code
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const logger = require('../utils/logger');
const { recordSignal, SIGNAL } = require('../services/ipAbuseService');

const MAX_BODY_BYTES        = 16 * 1024;       // 16 KB — matches server.js body-parser limit
const MAX_QUERY_VALUE_LEN   = 200;             // max length of any single query param value
const ALLOWED_METHODS       = new Set(['GET', 'POST', 'OPTIONS', 'HEAD']);

/**
 * Log, record an abuse signal, and reject a suspicious request.
 * @param {import('express').Response} res
 * @param {number} status
 * @param {string} reason
 * @param {import('express').Request} req
 */
function reject(res, status, reason, req) {
  logger.warn(`requestGuard: ${reason}`, {
    ip:     req.ip,
    method: req.method,
    url:    req.originalUrl.slice(0, 200), // truncate for log safety
  });
  // Every guard rejection is an abuse signal — feeds exponential backoff
  recordSignal(req.ip, SIGNAL.GUARD_REJECTION, {
    reason,
    method: req.method,
    url:    req.originalUrl.slice(0, 200),
  });
  return res.status(status).json({ error: reason });
}

/**
 * @type {import('express').RequestHandler}
 */
function requestGuard(req, res, next) {
  const { method, path: urlPath } = req;

  // ── 1. HTTP method allowlist ────────────────────────────────────────────────
  if (!ALLOWED_METHODS.has(method)) {
    return reject(res, 405, `Method ${method} not allowed`, req);
  }

  // ── 2. Null bytes in URL ────────────────────────────────────────────────────
  if (/\0/.test(req.originalUrl)) {
    return reject(res, 400, 'Null byte in request URL', req);
  }

  // ── 3. Path traversal in URL ────────────────────────────────────────────────
  if (/\.\.(\/|\\|%2F|%5C)/i.test(req.originalUrl)) {
    return reject(res, 400, 'Path traversal detected in URL', req);
  }

  // ── 4. Content-Type for mutation methods ────────────────────────────────────
  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    const ct = req.headers['content-type'] || '';
    const contentLengthHeader = req.headers['content-length'];
    const hasBody = req.headers['transfer-encoding'] ||
      (contentLengthHeader && parseInt(contentLengthHeader, 10) > 0);
    // Empty POSTs are valid for authenticated action endpoints such as
    // /api/billing/cancel and /api/billing/reactivate. Enforce JSON only when
    // a request body is actually being sent.
    if (hasBody && !ct.toLowerCase().includes('application/json')) {
      return reject(res, 415, 'Content-Type must be application/json', req);
    }
  }

  // ── 5. Oversized body (Content-Length header check, pre-parse) ──────────────
  // Note: the Express body-parser also enforces size — this is a pre-parse guard
  // that saves us from even attempting to parse a known-oversized request.
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  if (!isNaN(contentLength) && contentLength > MAX_BODY_BYTES) {
    return reject(res, 413, `Request body too large (max ${MAX_BODY_BYTES} bytes)`, req);
  }

  // ── 6. Oversized query param values ─────────────────────────────────────────
  for (const [key, value] of Object.entries(req.query)) {
    const val = Array.isArray(value) ? value.join('') : String(value ?? '');
    if (val.length > MAX_QUERY_VALUE_LEN) {
      return reject(
        res, 400,
        `Query parameter "${key}" exceeds maximum length of ${MAX_QUERY_VALUE_LEN}`,
        req
      );
    }
    // Reject array-style query params: ?platform[]=AMD (common NoSQL injection vector)
    if (Array.isArray(value)) {
      return reject(res, 400, `Query parameter "${key}" must be a scalar value, not an array`, req);
    }
    // Reject object-style query params: ?platform[$ne]=AMD
    if (value !== null && typeof value === 'object') {
      return reject(res, 400, `Query parameter "${key}" must be a scalar value, not an object`, req);
    }
  }

  next();
}

module.exports = requestGuard;

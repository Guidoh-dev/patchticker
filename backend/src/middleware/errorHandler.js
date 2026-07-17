// src/middleware/errorHandler.js
// ─────────────────────────────────────────────────────────────────────────────
// STRUCTURED ERROR HANDLER — catches all unhandled Express errors
//
// STRUCTURED LOG FORMAT
// ──────────────────────
//  Every error produces a single structured log entry with these fields:
//    requestId    — correlates with all other logs for this request
//    userId       — present if the request was authenticated
//    method       — HTTP method
//    path         — request path (not including query string)
//    statusCode   — HTTP status code sent to client
//    errorName    — err.constructor.name (e.g. "ZodError", "SyntaxError")
//    errorMessage — err.message (only logged, never sent to client for 5xx)
//    stack        — full stack trace (only in error log, never in response)
//    ip           — client IP
//    userAgent    — User-Agent header (truncated)
//    body         — SANITIZED request body (passwords/tokens stripped)
//
// BODY SANITIZATION
// ──────────────────
//  req.body is logged only for non-GET requests, and only after stripping
//  sensitive fields (password, token, secret, authorization, key, etc.).
//  This prevents credentials from appearing in error logs or external
//  log services (Logtail, Sentry).
//
// CLIENT vs SERVER ERRORS
// ────────────────────────
//  4xx: message is safe to return to the client (validation error).
//       Logged at 'warn' level.
//  5xx: message is NEVER returned — client always gets "Internal server error".
//       Logged at 'error' level with full stack.
//       Triggers a SPIKE_5XX counter increment (may fire an alert).
//
// 5xx ALERT INTEGRATION
// ──────────────────────
//  Each 5xx error increments the SPIKE_5XX counter in alerting.js.
//  If the threshold is crossed (default: 10 errors in 2 minutes),
//  an alert fires to the configured webhook (Slack/PagerDuty/generic).
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const logger                           = require('../utils/logger');
const { alert, trackEvent, ALERT_TYPE } = require('../utils/alerting');

// ── Sensitive field names — stripped from logged request bodies ───────────────
const SENSITIVE_FIELDS = new Set([
  'password', 'passwd', 'pass',
  'token', 'accesstoken', 'refreshtoken',
  'secret', 'clientsecret',
  'authorization', 'auth',
  'key', 'apikey', 'api_key',
  'credential', 'credentials',
  'ssn', 'cvv', 'cardnumber', 'card_number',
  'otp', 'pin',
  'privatekey', 'private_key',
  'cookie',
]);

/**
 * Recursively strip sensitive fields from an object.
 * Returns a new object — does not mutate the original.
 * @param {unknown} obj
 * @param {number}  [depth=0]
 * @returns {unknown}
 */
function sanitizeBody(obj, depth = 0) {
  if (depth > 5) return '[truncated]';
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.slice(0, 20).map(v => sanitizeBody(v, depth + 1));

  const out = {};
  for (const [key, val] of Object.entries(obj)) {
    out[key] = SENSITIVE_FIELDS.has(key.toLowerCase())
      ? '[REDACTED]'
      : sanitizeBody(val, depth + 1);
  }
  return out;
}

// ── Error handler ─────────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // CORS policy violations — cors middleware throws these
  if (err.message && err.message.startsWith('CORS policy')) {
    logger.warn('CORS policy violation', {
      requestId: req.requestId,
      origin:    req.headers['origin'],
      ip:        req.ip,
    });
    return res.status(403).json({ error: err.message, requestId: req.requestId });
  }

  const status    = err.status || err.statusCode || 500;
  const is5xx     = status >= 500;
  const errorName = err.constructor?.name || 'Error';

  // Sanitize body before logging — strip passwords, tokens, secrets
  const safeBody = req.method !== 'GET' && req.body
    ? sanitizeBody(req.body)
    : undefined;

  if (is5xx) {
    logger.error(`${req.method} ${req.path} → ${status} (${errorName})`, {
      requestId:    req.requestId,
      userId:       req.user?.id,
      method:       req.method,
      path:         req.path,
      statusCode:   status,
      errorName,
      errorMessage: err.message,
      stack:        err.stack,
      ip:           req.ip,
      userAgent:    (req.headers['user-agent'] || '').slice(0, 200),
      ...(safeBody !== undefined && { body: safeBody }),
    });

    // Spike alert: fires webhook if > threshold 5xx errors in the window
    if (trackEvent(ALERT_TYPE.SPIKE_5XX)) {
      alert(ALERT_TYPE.SPIKE_5XX, '5xx error rate spike detected', {
        requestId: req.requestId,
        lastPath:  req.path,
        lastError: errorName,
      });
    }
  } else {
    logger.warn(`${req.method} ${req.path} → ${status}: ${err.message}`, {
      requestId:  req.requestId,
      userId:     req.user?.id,
      method:     req.method,
      path:       req.path,
      statusCode: status,
      errorName,
      ip:         req.ip,
    });
  }

  // Client response: never leak internals for 5xx
  const clientMessage = is5xx ? 'Internal server error' : err.message;

  res.status(status).json({
    error:     clientMessage,
    requestId: req.requestId,
    ...(process.env.NODE_ENV === 'development' && is5xx && {
      detail: err.message,
      stack:  err.stack,
    }),
  });
}

// ── 404 handler ───────────────────────────────────────────────────────────────

function notFound(req, res) {
  logger.warn('404 Not Found', {
    requestId: req.requestId,
    method:    req.method,
    url:       req.originalUrl,
    ip:        req.ip,
  });
  res.status(404).json({
    error:     `Route not found: ${req.originalUrl}`,
    requestId: req.requestId,
  });
}

module.exports = { errorHandler, notFound, sanitizeBody };

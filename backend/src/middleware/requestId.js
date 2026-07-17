// src/middleware/requestId.js
// ─────────────────────────────────────────────────────────────────────────────
// REQUEST ID — attach a unique UUID to every inbound request
//
// WHY THIS EXISTS
// ────────────────
//  Without a requestId, you cannot correlate log entries across the access
//  log, error handler, and service layer for the same request. When something
//  goes wrong in production you get:
//    12:04:01 WARN  Failed login attempt | {ip: "1.2.3.4"}
//    12:04:01 ERROR POST /api/auth/login → 429 | {ip: "1.2.3.4"}
//  …but you can't tell if they're the same request or two simultaneous ones.
//
//  With requestId every log entry from the same request shares a UUID:
//    {"requestId":"a3f2","level":"warn","message":"Failed login attempt",...}
//    {"requestId":"a3f2","level":"error","message":"POST /api/auth/login → 429",...}
//
// WHAT THIS MIDDLEWARE DOES
// ──────────────────────────
//  1. Reads X-Request-Id header if present (allows tracing across services;
//     upstream proxy or client can set their own ID). Validated to be safe
//     (alphanumeric + hyphens, max 64 chars) to prevent header injection.
//  2. Generates a fresh UUID v4 if no valid header was provided.
//  3. Sets req.requestId and res.setHeader('X-Request-Id', id).
//  4. Creates req.log — a child logger with requestId pre-bound.
//     After requireAuth runs, req.log also binds userId.
//
// USAGE IN ROUTE HANDLERS
// ────────────────────────
//  Instead of:
//    logger.info('Bug report submitted', { reportId, userId: req.user?.id });
//  Use:
//    req.log.info('Bug report submitted', { reportId });
//  The requestId and userId are automatically included in the output.
//
// PLACEMENT IN MIDDLEWARE CHAIN
// ──────────────────────────────
//  Must run after trust proxy (so req.ip is correct) but before everything
//  else — requestId should be on every log entry including security events.
//  In server.js: add as middleware slot 1.5 (after trust proxy, before httpsRedirect).
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { v4: uuidv4 } = require('uuid');
const logger         = require('../utils/logger');

// Allowlist for incoming X-Request-Id headers.
// Only alphanumeric characters and hyphens; max 64 chars.
// Anything else is silently ignored and a new UUID is generated.
const SAFE_REQUEST_ID = /^[a-zA-Z0-9-]{1,64}$/;

/**
 * Attach a requestId to every request and create req.log.
 *
 * @type {import('express').RequestHandler}
 */
function requestId(req, res, next) {
  // Accept an upstream request ID only if it's safe
  const incoming = req.headers['x-request-id'];
  const id = (incoming && SAFE_REQUEST_ID.test(incoming))
    ? incoming
    : uuidv4();

  req.requestId = id;
  res.setHeader('X-Request-Id', id);

  // Create a child logger bound to this requestId.
  // After requireAuth populates req.user, routes should call:
  //   req.log = req.log.child({ userId: req.user.id })
  // or use req.log directly (userId will be absent for unauthenticated requests).
  req.log = logger.child({ requestId: id });

  next();
}

/**
 * Middleware that binds userId to req.log once authentication is confirmed.
 * Place this immediately after requireAuth in any route that needs it, or
 * call it once in a global post-auth middleware if all routes are protected.
 *
 * Exported separately so it can be applied selectively.
 *
 * @type {import('express').RequestHandler}
 */
function bindUserId(req, res, next) {
  if (req.user && req.requestId) {
    req.log = logger.child({ requestId: req.requestId, userId: req.user.id });
  }
  next();
}

module.exports = { requestId, bindUserId };

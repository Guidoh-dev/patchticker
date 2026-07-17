// src/middleware/requireAuth.js
// ─────────────────────────────────────────────────────────────────────────────
// JWT ACCESS TOKEN GUARD
//
// Attaches to any route that requires authentication.
//
// Protocol:
//   1. Expect Authorization: Bearer <accessToken> header
//   2. Strip "Bearer " prefix
//   3. Verify JWT signature + expiry (via tokenService.verifyAccessToken)
//   4. Confirm user still exists in the DB (handles deleted accounts)
//   5. Attach req.user = { id, email } for downstream handlers
//
// findUserById is async (DB query) — this middleware is therefore async.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { verifyAccessToken } = require('../services/tokenService');
const { findUserById }      = require('../services/userService');
const logger                = require('../utils/logger');

/**
 * Express middleware. Rejects unauthenticated requests with 401.
 * On success, sets req.user = { id, email }.
 *
 * @type {import('express').RequestHandler}
 */
async function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];

  // SSE connections cannot send custom headers (EventSource API limitation).
  // Accept token via ?token= query param for /api/feed/stream only.
  // This is intentionally limited to SSE Accept type to avoid misuse.
  const isSSE = req.headers['accept'] === 'text/event-stream';
  const queryToken = isSSE ? req.query.token : null;

  if (!authHeader?.startsWith('Bearer ') && !queryToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = queryToken ?? authHeader.slice(7);

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      logger.debug('Expired access token', { ip: req.ip });
    } else {
      logger.warn('Invalid access token', { ip: req.ip, error: err.message });
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // findUserById is now async — await the DB lookup
    const user = await findUserById(payload.sub);
    if (!user) {
      logger.warn('Access token for unknown user', { sub: payload.sub, ip: req.ip });
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Attach role — used by requireRole middleware for RBAC
    req.user = { id: user.id, email: user.email, role: user.role || 'free' };
    next();
  } catch (err) {
    logger.error('requireAuth DB error', { message: err.message, ip: req.ip });
    next(err);
  }
}

module.exports = requireAuth;

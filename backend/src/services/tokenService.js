// src/services/tokenService.js
// ─────────────────────────────────────────────────────────────────────────────
// JWT ACCESS TOKENS + REFRESH TOKEN STORE (PostgreSQL backend)
//
// REFRESH TOKEN SECURITY
// ───────────────────────
//  • Raw tokens are UUIDs — never stored. Only SHA-256(token) is persisted.
//  • Rotation: each use issues a new token and marks the old as replaced=true.
//  • Replay detection: if a replaced token is presented, all user sessions revoked.
//  • Expiry enforced in DB query (expires_at < now()) and application layer.
//
// PARAMETERIZED QUERIES
// ──────────────────────
//  All DB operations use $1/$2 placeholders. No SQL interpolation.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const logger  = require('../utils/logger');
const secrets = require('../config/secrets');
const db      = require('../config/db');

const ACCESS_TTL  = parseInt(process.env.JWT_ACCESS_EXPIRES_IN  || '900',    10);
const REFRESH_TTL = parseInt(process.env.JWT_REFRESH_EXPIRES_IN || '604800', 10);

// ── In-memory fallback store (no DB configured) ───────────────────────────────
const _store = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ── Access tokens ─────────────────────────────────────────────────────────────

/**
 * Issue a signed JWT access token. Always signed with current secret.
 */
function issueAccessToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, jti: uuidv4() },
    secrets.getJwtAccessSecret(),
    { algorithm: 'HS256', expiresIn: ACCESS_TTL }
  );
}

/**
 * Verify a JWT. During rotation overlap, tries current then previous secret.
 * TokenExpiredError propagates immediately — expired is expired.
 */
function verifyAccessToken(token) {
  const validSecrets = secrets.getJwtAccessSecrets();
  let lastErr;
  for (const secret of validSecrets) {
    try {
      return jwt.verify(token, secret, { algorithms: ['HS256'], clockTolerance: 0 });
    } catch (err) {
      if (err.name === 'TokenExpiredError') throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

// ── Refresh tokens ────────────────────────────────────────────────────────────

/**
 * Issue a new opaque refresh token and persist to DB (or in-memory fallback).
 */
async function issueRefreshToken({ userId, ip, userAgent }) {
  const raw       = uuidv4();
  const hash      = hashToken(raw);
  const expiresAt = new Date(Date.now() + REFRESH_TTL * 1000);
  const ua        = typeof userAgent === 'string' ? userAgent.slice(0, 200) : '';

  if (db.isAvailable()) {
    await db.query(
      `INSERT INTO refresh_tokens (token_hash, user_id, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [hash, userId, expiresAt, ip || null, ua || null]
    );
  } else {
    _store.set(hash, {
      userId,
      expiresAt: expiresAt.getTime(),
      createdAt: Date.now(),
      ip,
      userAgent: ua,
      replaced:  false,
    });
  }

  logger.info('Refresh token issued', { userId, ip });
  return raw;
}

/**
 * Consume a refresh token:
 *   1. Look up by hash
 *   2. Check expiry
 *   3. Check not already replaced (replay detection)
 *   4. Mark replaced
 *   5. Return session info for new token issuance
 */
async function consumeRefreshToken(rawToken) {
  if (!rawToken) return null;
  const hash = hashToken(rawToken);

  if (db.isAvailable()) {
    const result = await db.query(
      `SELECT user_id, expires_at, replaced, ip, user_agent
       FROM refresh_tokens
       WHERE token_hash = $1`,
      [hash]
    );

    if (result.rowCount === 0) return null;
    const row = result.rows[0];

    if (row.replaced) {
      logger.warn('Refresh token replay detected — revoking all user sessions', { userId: row.user_id });
      await revokeAllUserSessions(row.user_id);
      return null;
    }

    if (new Date(row.expires_at) < new Date()) {
      await db.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [hash]);
      return null;
    }

    // Mark as replaced — prevents any future use of this exact token
    await db.query(
      'UPDATE refresh_tokens SET replaced = TRUE WHERE token_hash = $1',
      [hash]
    );

    return {
      userId:    row.user_id,
      ip:        row.ip,
      userAgent: row.user_agent,
    };
  }

  // ── In-memory fallback ────────────────────────────────────────────────────
  const record = _store.get(hash);
  if (!record) return null;
  if (record.replaced) {
    logger.warn('Refresh token replay detected', { userId: record.userId });
    revokeAllUserSessionsMem(record.userId);
    return null;
  }
  if (record.expiresAt < Date.now()) {
    _store.delete(hash);
    return null;
  }
  record.replaced = true;
  return { userId: record.userId, ip: record.ip, userAgent: record.userAgent };
}

/**
 * Revoke a single refresh token (logout from current device).
 */
async function revokeRefreshToken(rawToken) {
  if (!rawToken) return;
  const hash = hashToken(rawToken);
  if (db.isAvailable()) {
    await db.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [hash]);
  } else {
    _store.delete(hash);
  }
}

/**
 * Revoke all refresh tokens for a user (logout everywhere / compromise response).
 */
async function revokeAllUserSessions(userId) {
  if (db.isAvailable()) {
    const result = await db.query(
      'DELETE FROM refresh_tokens WHERE user_id = $1',
      [userId]
    );
    logger.info('All sessions revoked', { userId, count: result.rowCount });
  } else {
    revokeAllUserSessionsMem(userId);
  }
}

function revokeAllUserSessionsMem(userId) {
  let count = 0;
  for (const [hash, record] of _store.entries()) {
    if (record.userId === userId) { _store.delete(hash); count++; }
  }
  logger.info('All sessions revoked (in-memory)', { userId, count });
}

// Periodic cleanup of expired tokens (fallback store only)
setInterval(() => {
  const now = Date.now();
  for (const [hash, record] of _store.entries()) {
    if (record.expiresAt < now) _store.delete(hash);
  }
  if (db.isAvailable()) {
    // In DB mode, delegate to the Postgres cleanup function
    db.query('SELECT cleanup_expired_tokens()').catch(() => {});
  }
}, 10 * 60 * 1000).unref();

module.exports = {
  issueAccessToken,
  verifyAccessToken,
  issueRefreshToken,
  consumeRefreshToken,
  revokeRefreshToken,
  revokeAllUserSessions,
  ACCESS_TTL,
  REFRESH_TTL,
};

// src/services/authTokenService.js
// ─────────────────────────────────────────────────────────────────────────────
// AUTH TOKEN SERVICE — Email verification + password reset tokens
//
// SECURITY MODEL
// ──────────────
//  • Tokens are 32-byte cryptographically random values (hex encoded = 64 chars)
//  • Only SHA-256(token) is stored in the DB — raw tokens never persisted
//  • Each token is single-use: used_at is set on redemption, query checks used_at IS NULL
//  • Expiry is enforced in SQL: WHERE expires_at > now()
//  • Old unused tokens for the same user are purged on new issuance
//    (prevents token accumulation from repeated forgot-password requests)
//
// TIMING SAFETY
// ──────────────
//  verifyEmailToken and verifyPasswordResetToken return null for any failure
//  (expired, used, not found) with a single code path to prevent timing attacks
//  that distinguish "token not found" from "token expired".
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger');
const db     = require('../config/db');
const { markEmailVerified } = require('./userService');

const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;     // 1 hour

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateRawToken() {
  return crypto.randomBytes(32).toString('hex'); // 64-char hex string
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// ── In-memory fallback stores (no DB) ────────────────────────────────────────
// Used in test/dev environments without a live database.

const _emailVerifyStore  = new Map(); // tokenHash → { userId, expiresAt, usedAt }
const _passwordResetStore = new Map();

// ── Email verification tokens ─────────────────────────────────────────────────

/**
 * Issue a new email verification token for a user.
 * Invalidates any previous unused tokens for the same user.
 *
 * @param {string} userId
 * @returns {Promise<string>} raw token (to embed in email link)
 */
async function issueEmailVerificationToken(userId) {
  const raw       = generateRawToken();
  const hash      = hashToken(raw);
  const expiresAt = new Date(Date.now() + EMAIL_VERIFY_TTL_MS);

  if (db.isAvailable()) {
    // Delete any previous unused tokens for this user to prevent accumulation
    await db.query(
      `DELETE FROM email_verification_tokens
       WHERE user_id = $1 AND used_at IS NULL`,
      [userId]
    );

    await db.query(
      `INSERT INTO email_verification_tokens (token_hash, user_id, expires_at)
       VALUES ($1, $2, $3)`,
      [hash, userId, expiresAt]
    );
  } else {
    // Purge previous tokens for user
    for (const [k, v] of _emailVerifyStore.entries()) {
      if (v.userId === userId && !v.usedAt) _emailVerifyStore.delete(k);
    }
    _emailVerifyStore.set(hash, { userId, expiresAt: expiresAt.getTime(), usedAt: null });
  }

  logger.info('[authToken] Email verification token issued', { userId });
  return raw;
}

/**
 * Verify and consume an email verification token.
 * Returns userId on success, null on any failure.
 *
 * @param {string} rawToken
 * @returns {Promise<string|null>} userId or null
 */
async function verifyEmailToken(rawToken) {
  if (!rawToken) return null;
  const hash = hashToken(rawToken);

  if (db.isAvailable()) {
    const result = await db.query(
      `SELECT user_id FROM email_verification_tokens
       WHERE token_hash = $1
         AND expires_at > now()
         AND used_at IS NULL`,
      [hash]
    );
    if (result.rowCount === 0) return null;

    const userId = result.rows[0].user_id;

    // Mark token as used
    await db.query(
      `UPDATE email_verification_tokens SET used_at = now() WHERE token_hash = $1`,
      [hash]
    );

    // Mark user as verified
    await db.query(
      `UPDATE users SET email_verified = TRUE, email_verified_at = now(), updated_at = now()
       WHERE id = $1`,
      [userId]
    );

    logger.info('[authToken] Email verified', { userId });
    return userId;
  }

  // In-memory fallback
  const record = _emailVerifyStore.get(hash);
  if (!record || record.usedAt || record.expiresAt < Date.now()) return null;
  record.usedAt = Date.now();
  await markEmailVerified(record.userId);
  logger.info('[authToken] Email verified (in-memory)', { userId: record.userId });
  return record.userId;
}

// ── Password reset tokens ─────────────────────────────────────────────────────

/**
 * Issue a password reset token.
 * Invalidates any previous unused reset tokens for the same user.
 *
 * @param {string} userId
 * @returns {Promise<string>} raw token
 */
async function issuePasswordResetToken(userId) {
  const raw       = generateRawToken();
  const hash      = hashToken(raw);
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

  if (db.isAvailable()) {
    await db.query(
      `DELETE FROM password_reset_tokens
       WHERE user_id = $1 AND used_at IS NULL`,
      [userId]
    );

    await db.query(
      `INSERT INTO password_reset_tokens (token_hash, user_id, expires_at)
       VALUES ($1, $2, $3)`,
      [hash, userId, expiresAt]
    );
  } else {
    for (const [k, v] of _passwordResetStore.entries()) {
      if (v.userId === userId && !v.usedAt) _passwordResetStore.delete(k);
    }
    _passwordResetStore.set(hash, { userId, expiresAt: expiresAt.getTime(), usedAt: null });
  }

  logger.info('[authToken] Password reset token issued', { userId });
  return raw;
}

/**
 * Verify and consume a password reset token.
 * Returns userId on success, null on any failure.
 *
 * @param {string} rawToken
 * @returns {Promise<string|null>} userId or null
 */
async function verifyPasswordResetToken(rawToken) {
  if (!rawToken) return null;
  const hash = hashToken(rawToken);

  if (db.isAvailable()) {
    const result = await db.query(
      `SELECT user_id FROM password_reset_tokens
       WHERE token_hash = $1
         AND expires_at > now()
         AND used_at IS NULL`,
      [hash]
    );
    if (result.rowCount === 0) return null;

    const userId = result.rows[0].user_id;

    // Mark used — actual password update is caller's responsibility
    await db.query(
      `UPDATE password_reset_tokens SET used_at = now() WHERE token_hash = $1`,
      [hash]
    );

    logger.info('[authToken] Password reset token consumed', { userId });
    return userId;
  }

  const record = _passwordResetStore.get(hash);
  if (!record || record.usedAt || record.expiresAt < Date.now()) return null;
  record.usedAt = Date.now();
  return record.userId;
}

// ── Periodic cleanup ──────────────────────────────────────────────────────────
// In DB mode, delegates to the SQL function. In-memory fallback handles itself.
setInterval(() => {
  if (db.isAvailable()) {
    db.query('SELECT cleanup_expired_auth_tokens()').catch(() => {});
  } else {
    const now = Date.now();
    for (const [k, v] of _emailVerifyStore.entries()) {
      if (v.expiresAt < now) _emailVerifyStore.delete(k);
    }
    for (const [k, v] of _passwordResetStore.entries()) {
      if (v.expiresAt < now) _passwordResetStore.delete(k);
    }
  }
}, 60 * 60 * 1000).unref(); // every hour

module.exports = {
  issueEmailVerificationToken,
  verifyEmailToken,
  issuePasswordResetToken,
  verifyPasswordResetToken,
};

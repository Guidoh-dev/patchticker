// src/services/userService.js
// ─────────────────────────────────────────────────────────────────────────────
// USER STORE — PostgreSQL backend with field-level encryption
//
// STORAGE MODEL
// ──────────────
//   email_encrypted  — AES-256-GCM ciphertext. Decrypted on read.
//   email_hmac       — HMAC-SHA256(normalised_email). Used for WHERE lookups.
//                      Deterministic so equality checks work without decrypting.
//   password_hash    — argon2id hash. Never decryptable. Not encrypted separately.
//
// WHY ENCRYPT EMAIL?
// ───────────────────
//   If the DB is breached (stolen backup, snapshot leak), the email column is
//   unreadable without DB_ENCRYPTION_KEY. Emails are PII under GDPR/CCPA —
//   a breach without key exposure is not a notifiable data breach for this field.
//
// WHY HMAC FOR LOOKUPS?
// ──────────────────────
//   AES-GCM is non-deterministic (random IV each call), so the same email
//   produces a different ciphertext each time. We can't use WHERE email_encrypted = ?
//   Instead, HMAC-SHA256(email, key) is deterministic and used for lookups.
//   The HMAC uses the same DB_ENCRYPTION_KEY — useless without it.
//
// PARAMETERIZED QUERIES
// ──────────────────────
//   Every SQL statement uses $1/$2 placeholders. User input is NEVER
//   interpolated into SQL strings. This module is the only place that
//   touches the users table.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const argon2            = require('argon2');
const logger            = require('../utils/logger');
const db                = require('../config/db');
const { encrypt, decrypt, hmac } = require('../utils/encrypt');

// ── Argon2id configuration ────────────────────────────────────────────────────
const ARGON2_OPTIONS = {
  type:        argon2.argon2id,
  memoryCost:  65536,
  timeCost:    3,
  parallelism: 4,
  hashLength:  32,
};

let _dummyHash = null;
async function getDummyHash() {
  if (!_dummyHash) {
    _dummyHash = await argon2.hash('dummy-password-for-timing-safety', ARGON2_OPTIONS);
  }
  return _dummyHash;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function normaliseEmail(email) {
  return email.toLowerCase().trim();
}

/**
 * Map a raw DB row to a safe public user object.
 * Decrypts email. Never returns passwordHash.
 */
function rowToUser(row) {
  if (!row) return null;
  return {
    id:            row.id,
    email:         decrypt(row.email_encrypted),
    role:          row.role || 'free',
    emailVerified: row.email_verified || false,
    createdAt:     row.created_at.toISOString(),
  };
}

// ── In-memory fallback (when DB is not configured) ────────────────────────────
// Allows unit tests and development without a live database.
// Services use the in-memory store when db.isAvailable() returns false.

const _memUsers = new Map();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a new user. Hashes password with argon2id, encrypts email.
 * @param {{ email: string, password: string }} param0
 * @returns {Promise<{ id: string, email: string, createdAt: string }>}
 * @throws {Error} status 409 if email already registered
 */
async function createUser({ email, password }) {
  const normEmail    = normaliseEmail(email);
  const emailHmac    = hmac(normEmail);
  const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);

  if (db.isAvailable()) {
    // Check for duplicate before encrypting (faster — uses HMAC index)
    const existing = await db.query(
      'SELECT id FROM users WHERE email_hmac = $1',
      [emailHmac]
    );
    if (existing.rowCount > 0) {
      const err = new Error('Email address is already registered');
      err.status = 409;
      throw err;
    }

    const emailEncrypted = encrypt(normEmail);

    const result = await db.query(
      `INSERT INTO users (email_encrypted, email_hmac, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email_encrypted, created_at`,
      [emailEncrypted, emailHmac, passwordHash]
    );

    const user = rowToUser(result.rows[0]);
    logger.info('User registered', { userId: user.id });
    return user;
  }

  // ── In-memory fallback ────────────────────────────────────────────────────
  if (_memUsers.has(emailHmac)) {
    const err = new Error('Email address is already registered');
    err.status = 409;
    throw err;
  }
  const { v4: uuidv4 } = require('uuid');
  const now  = new Date().toISOString();
  const user = {
    id:              uuidv4(),
    email_encrypted: encrypt(normEmail),
    email_hmac:      emailHmac,
    password_hash:   passwordHash,
    role:            'free',
    email_verified:  false,
    created_at:      now,
  };
  _memUsers.set(emailHmac, user);
  logger.info('User registered (in-memory)', { userId: user.id });
  return { id: user.id, email: normEmail, role: 'free', emailVerified: false, createdAt: now };
}

/**
 * Verify credentials. Always constant-time via argon2.verify().
 * Returns safe user record on success, null on failure.
 */
async function verifyCredentials({ email, password }) {
  const normEmail = normaliseEmail(email);
  const emailHmac = hmac(normEmail);

  if (db.isAvailable()) {
    const result = await db.query(
      'SELECT id, email_encrypted, password_hash, role, email_verified, created_at FROM users WHERE email_hmac = $1',
      [emailHmac]
    );

    if (result.rowCount === 0) {
      await argon2.verify(await getDummyHash(), password); // timing-safe
      return null;
    }

    const row   = result.rows[0];
    const valid = await argon2.verify(row.password_hash, password);
    if (!valid) return null;

    // Re-hash if argon2 parameters have been upgraded
    if (argon2.needsRehash(row.password_hash, ARGON2_OPTIONS)) {
      logger.info('Re-hashing password with updated parameters', { userId: row.id });
      const newHash = await argon2.hash(password, ARGON2_OPTIONS);
      await db.query(
        'UPDATE users SET password_hash = $1 WHERE id = $2',
        [newHash, row.id]
      );
    }

    return rowToUser(row);
  }

  // ── In-memory fallback ────────────────────────────────────────────────────
  const memUser = _memUsers.get(emailHmac);
  if (!memUser) {
    await argon2.verify(await getDummyHash(), password);
    return null;
  }
  const valid = await argon2.verify(memUser.password_hash, password);
  if (!valid) return null;
  return { id: memUser.id, email: normEmail, role: memUser.role || 'free', emailVerified: !!memUser.email_verified, createdAt: memUser.created_at };
}

/**
 * Find a user by UUID (used by requireAuth middleware).
 */
async function findUserById(id) {
  if (db.isAvailable()) {
    const result = await db.query(
      'SELECT id, email_encrypted, role, email_verified, created_at FROM users WHERE id = $1',
      [id]
    );
    return result.rowCount > 0 ? rowToUser(result.rows[0]) : null;
  }

  // ── In-memory fallback ────────────────────────────────────────────────────
  for (const u of _memUsers.values()) {
    if (u.id === id) {
      return { id: u.id, email: decrypt(u.email_encrypted), role: u.role || 'free', emailVerified: !!u.email_verified, createdAt: u.created_at };
    }
  }
  return null;
}



async function markEmailVerified(userId) {
  if (db.isAvailable()) {
    await db.query(
      'UPDATE users SET email_verified = TRUE, email_verified_at = now(), updated_at = now() WHERE id = $1',
      [userId]
    );
    return;
  }

  for (const u of _memUsers.values()) {
    if (u.id === userId) {
      u.email_verified = true;
      break;
    }
  }
}

/**
 * Update a user's password hash (used by password reset flow).
 * Rehashes with current ARGON2_OPTIONS.
 */
async function updateUserPassword(userId, newPassword) {
  const passwordHash = await argon2.hash(newPassword, ARGON2_OPTIONS);

  if (db.isAvailable()) {
    await db.query(
      'UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2',
      [passwordHash, userId]
    );
    logger.info('User password updated', { userId });
    return;
  }

  // In-memory fallback
  for (const u of _memUsers.values()) {
    if (u.id === userId) {
      u.password_hash = passwordHash;
      break;
    }
  }
  logger.info('User password updated (in-memory)', { userId });
}

/**
 * Find a user by their email HMAC (for password reset / email resend flows).
 */
async function findUserByEmail(email) {
  const normEmail = normaliseEmail(email);
  const emailHmac = hmac(normEmail);

  if (db.isAvailable()) {
    const result = await db.query(
      'SELECT id, email_encrypted, role, email_verified, created_at FROM users WHERE email_hmac = $1',
      [emailHmac]
    );
    return result.rowCount > 0 ? rowToUser(result.rows[0]) : null;
  }

  const memUser = _memUsers.get(emailHmac);
  if (!memUser) return null;
  return { id: memUser.id, email: normEmail, role: memUser.role || 'free', emailVerified: !!memUser.email_verified, createdAt: memUser.created_at };
}

module.exports = { createUser, verifyCredentials, findUserById, findUserByEmail, updateUserPassword, markEmailVerified };

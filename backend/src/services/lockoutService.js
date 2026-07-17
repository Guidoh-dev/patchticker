// src/services/lockoutService.js
// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNT LOCKOUT — PostgreSQL backend
//
// Keyed on email_hmac (HMAC-SHA256 of normalised email) so the lockout table
// never exposes plaintext emails even in a breach.
//
// All DB operations use parameterized queries ($1/$2 placeholders).
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const logger   = require('../utils/logger');
const db       = require('../config/db');
const { hmac } = require('../utils/encrypt');

const MAX_ATTEMPTS     = parseInt(process.env.LOCKOUT_MAX_ATTEMPTS       || '5',   10);
const LOCKOUT_DURATION = parseInt(process.env.LOCKOUT_DURATION_SECONDS   || '900', 10) * 1000;
const ATTEMPT_WINDOW   = 15 * 60 * 1000;

// ── In-memory fallback ────────────────────────────────────────────────────────
const _records = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

function emailKey(email) {
  return hmac(email.toLowerCase().trim());
}

// ── Public API ────────────────────────────────────────────────────────────────

async function checkLockout(email) {
  const key = emailKey(email);

  if (db.isAvailable()) {
    const result = await db.query(
      `SELECT locked_until FROM account_lockouts
       WHERE email_hmac = $1 AND locked_until IS NOT NULL AND locked_until > now()`,
      [key]
    );
    if (result.rowCount === 0) return { locked: false, remainingMs: 0 };
    const remaining = new Date(result.rows[0].locked_until) - Date.now();
    return { locked: true, remainingMs: Math.max(0, remaining) };
  }

  // ── In-memory fallback ────────────────────────────────────────────────────
  const record = _records.get(key);
  if (!record?.lockedUntil) return { locked: false, remainingMs: 0 };
  const remaining = record.lockedUntil - Date.now();
  if (remaining <= 0) { _records.delete(key); return { locked: false, remainingMs: 0 }; }
  return { locked: true, remainingMs: remaining };
}

async function recordFailedAttempt(email, ip = 'unknown') {
  const key = emailKey(email);
  const now = new Date();

  if (db.isAvailable()) {
    // Upsert: insert new record or increment existing one.
    // Reset if outside the attempt window and not locked.
    const result = await db.query(
      `INSERT INTO account_lockouts (email_hmac, attempts, first_attempt_at)
       VALUES ($1, 1, now())
       ON CONFLICT (email_hmac) DO UPDATE SET
         attempts = CASE
           WHEN account_lockouts.locked_until IS NULL
            AND (now() - account_lockouts.first_attempt_at) > ($2 * interval '1 millisecond')
           THEN 1
           ELSE account_lockouts.attempts + 1
         END,
         first_attempt_at = CASE
           WHEN account_lockouts.locked_until IS NULL
            AND (now() - account_lockouts.first_attempt_at) > ($2 * interval '1 millisecond')
           THEN now()
           ELSE account_lockouts.first_attempt_at
         END
       RETURNING attempts, locked_until`,
      [key, ATTEMPT_WINDOW]
    );

    const attempts = result.rows[0].attempts;

    if (attempts >= MAX_ATTEMPTS) {
      const lockedUntil = new Date(Date.now() + LOCKOUT_DURATION);
      await db.query(
        'UPDATE account_lockouts SET locked_until = $1 WHERE email_hmac = $2',
        [lockedUntil, key]
      );
      logger.warn('Account locked after repeated failed logins', {
        attempts, ip, lockedUntilIso: lockedUntil.toISOString(),
      });
      return { locked: true, attemptsRemaining: 0 };
    }

    const attemptsRemaining = MAX_ATTEMPTS - attempts;
    logger.warn('Failed login attempt', { attempts, attemptsRemaining, ip });
    return { locked: false, attemptsRemaining };
  }

  // ── In-memory fallback ────────────────────────────────────────────────────
  let record = _records.get(key);
  if (!record) { record = { attempts: 0, firstAttemptAt: now.getTime(), lockedUntil: null }; _records.set(key, record); }
  if (!record.lockedUntil && (now.getTime() - record.firstAttemptAt) > ATTEMPT_WINDOW) {
    record.attempts = 0; record.firstAttemptAt = now.getTime();
  }
  record.attempts++;
  if (record.attempts >= MAX_ATTEMPTS) {
    record.lockedUntil = now.getTime() + LOCKOUT_DURATION;
    logger.warn('Account locked', { attempts: record.attempts, ip });
    return { locked: true, attemptsRemaining: 0 };
  }
  const attemptsRemaining = MAX_ATTEMPTS - record.attempts;
  logger.warn('Failed login attempt', { attempts: record.attempts, attemptsRemaining, ip });
  return { locked: false, attemptsRemaining };
}

async function clearAttempts(email) {
  const key = emailKey(email);
  if (db.isAvailable()) {
    await db.query('DELETE FROM account_lockouts WHERE email_hmac = $1', [key]);
  } else {
    _records.delete(key);
  }
}

async function forceUnlock(email) {
  const key = emailKey(email);
  if (db.isAvailable()) {
    await db.query('DELETE FROM account_lockouts WHERE email_hmac = $1', [key]);
  } else {
    _records.delete(key);
  }
  logger.info('Account manually unlocked', { email: email.toLowerCase().trim() });
}

// Periodic cleanup
setInterval(async () => {
  if (db.isAvailable()) {
    db.query('SELECT cleanup_stale_lockouts($1)', [Math.floor(ATTEMPT_WINDOW / 1000)]).catch(() => {});
  } else {
    const now = Date.now();
    for (const [key, record] of _records.entries()) {
      const expired = record.lockedUntil
        ? record.lockedUntil < now
        : (now - record.firstAttemptAt) > ATTEMPT_WINDOW * 2;
      if (expired) _records.delete(key);
    }
  }
}, 30 * 60 * 1000).unref();

module.exports = { checkLockout, recordFailedAttempt, clearAttempts, forceUnlock, MAX_ATTEMPTS };

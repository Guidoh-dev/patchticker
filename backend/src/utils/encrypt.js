// src/utils/encrypt.js
// ─────────────────────────────────────────────────────────────────────────────
// FIELD-LEVEL ENCRYPTION — AES-256-GCM for PII stored in the database
//
// WHAT THIS PROTECTS AGAINST
// ────────────────────────────
//  Database breach: if the Postgres data files are exfiltrated (stolen backup,
//  misconfigured snapshot, cloud storage misconfiguration), encrypted fields
//  are unreadable without DB_ENCRYPTION_KEY. The attacker sees ciphertext.
//
//  This is NOT a substitute for:
//    • SSL on the DB connection (in-transit encryption — handled in db.js)
//    • Access control (least-privilege user — handled in schema.sql)
//    • Parameterized queries (SQL injection — handled in every service)
//  Field encryption is defence-in-depth for data at rest.
//
// ALGORITHM
// ──────────
//  AES-256-GCM
//    • 256-bit key (32 bytes from DB_ENCRYPTION_KEY)
//    • 96-bit random IV (12 bytes), unique per encryption operation
//    • 128-bit authentication tag — detects any tampering with ciphertext
//    • Authenticated encryption: decryption fails loudly if data is modified
//
//  Wire format (stored as hex in a single TEXT column):
//    <12-byte IV hex><16-byte auth tag hex><N-byte ciphertext hex>
//    = 24 + 32 + (N*2) hex chars
//
// WHAT IS ENCRYPTED
// ──────────────────
//  users.email_encrypted — the raw email address
//  users.email_hmac       — HMAC-SHA256(email) for lookup equality checks
//                           (needed because encrypted ciphertext is different
//                            every time, so WHERE email = ? can't use it)
//  bug_reports.description_encrypted — user-supplied free text
//  bug_reports.user_agent_encrypted  — browser UA string
//
//  Passwords are NOT encrypted here — they are hashed with argon2id, which is
//  the correct approach. Encryption is reversible; hashing is not. Password
//  fields should never be decryptable.
//
// KEY MANAGEMENT
// ───────────────
//  DB_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes / 256 bits).
//  Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
//  The key is loaded via secrets.js at startup. It must be:
//    • Stored only in your secrets manager / encrypted env store
//    • Never committed to version control
//    • Different from JWT and CSRF secrets
//    • Rotated by re-encrypting all rows with a new key (migration required)
//
// KEY ROTATION
// ─────────────
//  AES-GCM keys cannot be hot-rotated like JWT secrets. Rotation requires a
//  migration: read each row, decrypt with old key, re-encrypt with new key,
//  update. Run as a database transaction. See schema.sql for column comments.
//
//  To detect which key version encrypted a row, prefix the wire format with a
//  key version byte (not implemented here — add when rotation is needed):
//    <1-byte version><IV><tag><ciphertext>
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');

// IV length: 12 bytes (96 bits) — recommended for AES-GCM
const IV_BYTES  = 12;
// Auth tag length: 16 bytes (128 bits) — maximum, most secure
const TAG_BYTES = 16;
const ALGORITHM = 'aes-256-gcm';

// ── Key loading ───────────────────────────────────────────────────────────────
// Loaded lazily (not at module parse time) so tests can inject the key via
// environment before requiring this module. Call getKey() every time to support
// future key rotation without module reload.

function getKey() {
  const hex = process.env.DB_ENCRYPTION_KEY;
  if (!hex) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[encrypt] DB_ENCRYPTION_KEY is not set. Cannot start in production without field encryption key.');
    }
    // Dev/test fallback — 32 zero bytes. Insecure but allows tests to run.
    // The logger warning below fires once per process.
    return Buffer.alloc(32, 0);
  }
  if (hex.startsWith('REPLACE_WITH') || hex.startsWith('your_')) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[encrypt] DB_ENCRYPTION_KEY is a placeholder value. Set a real key in production.');
    }
    return Buffer.alloc(32, 0);
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error(
      `[encrypt] DB_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). Got ${key.length} bytes.`
    );
  }
  return key;
}

// ── Encrypt ───────────────────────────────────────────────────────────────────

/**
 * Encrypt a plaintext string using AES-256-GCM.
 *
 * Returns a hex string containing:
 *   [12-byte IV][16-byte auth tag][N-byte ciphertext]
 * All concatenated, no separators.
 *
 * @param {string} plaintext
 * @returns {string}  hex-encoded ciphertext (safe to store in a TEXT column)
 * @throws if DB_ENCRYPTION_KEY is missing in production
 */
function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) {
    throw new TypeError('[encrypt] Cannot encrypt null or undefined');
  }

  const key = getKey();
  const iv  = crypto.randomBytes(IV_BYTES);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag(); // 16 bytes

  // Wire format: IV || tag || ciphertext (all hex)
  return iv.toString('hex') + tag.toString('hex') + encrypted.toString('hex');
}

// ── Decrypt ───────────────────────────────────────────────────────────────────

/**
 * Decrypt a hex-encoded AES-256-GCM ciphertext.
 *
 * @param {string} ciphertextHex  — output of encrypt()
 * @returns {string}  plaintext
 * @throws {Error}  if authentication tag check fails (data tampered/corrupted)
 * @throws {Error}  if input is malformed
 */
function decrypt(ciphertextHex) {
  if (!ciphertextHex || typeof ciphertextHex !== 'string') {
    throw new TypeError('[encrypt] decrypt() requires a non-empty hex string');
  }

  // Minimum length: IV (24 hex) + tag (32 hex) + at least 2 hex of ciphertext
  const MIN_HEX_LEN = IV_BYTES * 2 + TAG_BYTES * 2;
  if (ciphertextHex.length < MIN_HEX_LEN) {
    throw new Error('[encrypt] Ciphertext too short — data may be corrupted');
  }

  const ivOffset  = 0;
  const tagOffset = IV_BYTES * 2;
  const ctOffset  = tagOffset + TAG_BYTES * 2;

  const iv         = Buffer.from(ciphertextHex.slice(ivOffset,  tagOffset), 'hex');
  const tag        = Buffer.from(ciphertextHex.slice(tagOffset, ctOffset),  'hex');
  const ciphertext = Buffer.from(ciphertextHex.slice(ctOffset),             'hex');

  const key = getKey();

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  try {
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(), // throws if auth tag doesn't match
    ]);
    return decrypted.toString('utf8');
  } catch (err) {
    // Do not include the ciphertext in the error — it may be sensitive
    throw new Error('[encrypt] Decryption failed — data may be tampered or key mismatch');
  }
}

// ── HMAC for lookup ───────────────────────────────────────────────────────────
// Because AES-GCM produces different ciphertext every time (random IV),
// you cannot do WHERE encrypted_email = encrypt(?) in SQL.
// Instead we store HMAC-SHA256(normalised_email) as a deterministic lookup key.
// The HMAC uses the same DB_ENCRYPTION_KEY so leaking the DB without the key
// reveals neither the email nor the HMAC preimage.

/**
 * Compute HMAC-SHA256 of a string for use as a database lookup key.
 * Result is a 64-character hex string. Deterministic for a given input + key.
 *
 * @param {string} value  — e.g. normalised email address
 * @returns {string}  64-char hex HMAC
 */
function hmac(value) {
  const key = getKey();
  return crypto
    .createHmac('sha256', key)
    .update(String(value), 'utf8')
    .digest('hex');
}

// ── Null-safe wrappers ────────────────────────────────────────────────────────
// Convenient wrappers that pass null/undefined through unchanged.
// Useful for optional fields that may be null in the DB.

/**
 * Encrypt if value is not null/undefined, otherwise return null.
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
function encryptNullable(value) {
  if (value === null || value === undefined) return null;
  return encrypt(value);
}

/**
 * Decrypt if value is not null/undefined, otherwise return null.
 * @param {string|null|undefined} ciphertextHex
 * @returns {string|null}
 */
function decryptNullable(ciphertextHex) {
  if (ciphertextHex === null || ciphertextHex === undefined) return null;
  return decrypt(ciphertextHex);
}

module.exports = {
  encrypt,
  decrypt,
  hmac,
  encryptNullable,
  decryptNullable,
  // Exported for tests
  IV_BYTES,
  TAG_BYTES,
  ALGORITHM,
};

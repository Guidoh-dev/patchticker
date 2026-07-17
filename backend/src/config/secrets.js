// src/config/secrets.js
// ─────────────────────────────────────────────────────────────────────────────
// SECRET MANAGEMENT — centralised loading, validation, and rotation support
//
// DESIGN GOALS
// ─────────────
//  1. Single source of truth — every secret is loaded here and ONLY here.
//     No other file reads JWT_* or CSRF_* directly from process.env.
//
//  2. Fail-fast validation — missing or placeholder secrets cause an immediate
//     startup error in production. The server will not accept requests with
//     insecure configuration.
//
//  3. Live secret rotation without process restart — secrets are stored in a
//     versioned structure. During a rotation window, both the current and
//     previous secret are retained. JWT verification tries both; CSRF accepts
//     both. After the overlap window, the old secret is dropped.
//
//  4. Rotation overlap window — prevents "token flash" where legitimate users
//     who received tokens signed with the old secret get logged out the moment
//     rotation happens. Tokens signed with the previous secret remain valid for
//     ROTATION_OVERLAP_MS after rotation.
//
// ROTATION WORKFLOW
// ──────────────────
//  Option A — environment variable update (requires process restart):
//    1. Generate new secrets (see commands below)
//    2. Update JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, CSRF_SECRET in .env
//    3. Restart process — old tokens expire naturally within ACCESS_TTL seconds
//
//  Option B — live rotation via rotating env vars (no restart needed):
//    1. Move current secret → JWT_ACCESS_SECRET_PREV
//    2. Set new secret → JWT_ACCESS_SECRET
//    3. Call secrets.rotate() or send SIGUSR2 to the process
//    4. After ROTATION_OVERLAP_MS, the old secret is dropped automatically
//    This allows hot rotation on platforms that support env var updates
//    (Heroku config vars, Railway, Kubernetes secrets with auto-reload).
//
//  Option C — periodic auto-rotation (for high-security deployments):
//    Set SECRET_AUTO_ROTATE_MS to enable periodic reloading from env vars.
//    Pair with a secrets manager (AWS Secrets Manager, Vault, GCP Secret
//    Manager) that updates the env vars on a schedule.
//
// GENERATING SECRETS
// ───────────────────
//  JWT secrets (64 bytes = 512 bits):
//    node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
//
//  CSRF secret (32 bytes = 256 bits):
//    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
//  Reddit client secret: generated in your Reddit app at reddit.com/prefs/apps
//
// PRODUCTION CHECKLIST
// ─────────────────────
//  □ JWT_ACCESS_SECRET  — 64+ bytes hex, unique to this deployment
//  □ JWT_REFRESH_SECRET — 64+ bytes hex, DIFFERENT from access secret
//  □ CSRF_SECRET        — 32+ bytes hex, DIFFERENT from both JWT secrets
//  □ No secret appears in .env.example, git history, or logs
//  □ Secrets are stored in your secrets manager / encrypted env store
//  □ Secret rotation is scheduled and tested
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger');

// ── Constants ─────────────────────────────────────────────────────────────────

const isProd = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

// How long the previous secret remains valid after rotation (30 minutes).
// Tokens signed with the old secret continue to work during this window.
const ROTATION_OVERLAP_MS = parseInt(
  process.env.ROTATION_OVERLAP_MS || String(30 * 60 * 1000),
  10
);

// Minimum required lengths for each secret type.
// Shorter secrets are rejected — they don't meet security baselines.
const MIN_SECRET_BYTES = {
  JWT_ACCESS_SECRET:  32,   // 32 bytes = 256 bits minimum
  JWT_REFRESH_SECRET: 32,
  CSRF_SECRET:        16,   // 16 bytes = 128 bits minimum
};

// Placeholder patterns that indicate the .env.example value was not replaced.
// A server running with a placeholder secret is misconfigured.
const PLACEHOLDER_PATTERNS = [
  /^REPLACE_WITH/i,
  /^YOUR_/i,
  /^your_/,
  /^changeme/i,
  /^example/i,
  /^todo/i,
];

// ── Validation helpers ────────────────────────────────────────────────────────

/**
 * Check whether a string looks like a placeholder value that was never replaced.
 * @param {string} val
 * @returns {boolean}
 */
function isPlaceholder(val) {
  return PLACEHOLDER_PATTERNS.some(p => p.test(val));
}

/**
 * Validate a secret value against minimum length and placeholder patterns.
 * In production, throws on any violation. In dev/test, logs a warning instead.
 *
 * @param {string} name  — env var name (for error messages)
 * @param {string} val   — the secret value
 * @param {number} minBytes — minimum byte length (hex string = 2× byte count)
 * @returns {string}  the validated value
 * @throws {Error}  in production when validation fails
 */
function validateSecret(name, val, minBytes = 16) {
  const fail = (msg) => {
    if (isProd) {
      throw new Error(`[secrets] ${msg} Server will not start with insecure configuration.`);
    }
    if (!isTest) {
      logger.warn(`[secrets] INSECURE: ${msg} Use a real secret in production.`);
    }
  };

  if (!val) {
    fail(`${name} is missing.`);
    return '';
  }

  if (isPlaceholder(val)) {
    fail(`${name} is still set to a placeholder value.`);
  }

  // For hex-encoded secrets: minBytes bytes → minBytes*2 hex chars
  // We allow non-hex secrets (e.g. base64, passphrase) — just check total length.
  const effectiveMin = minBytes * 2; // conservative: assume hex encoding
  if (val.length < effectiveMin) {
    fail(
      `${name} is too short (${val.length} chars; minimum is ${effectiveMin} chars / ${minBytes} bytes).`
    );
  }

  return val;
}

/**
 * Check that two secrets are not identical to each other.
 * Using the same value for ACCESS and REFRESH secret would let an access token
 * be used as a refresh token and vice versa.
 *
 * @param {string} nameA
 * @param {string} valA
 * @param {string} nameB
 * @param {string} valB
 */
function requireDistinct(nameA, valA, nameB, valB) {
  if (valA && valB && valA === valB) {
    const msg = `${nameA} and ${nameB} must be different values.`;
    if (isProd) throw new Error(`[secrets] ${msg}`);
    if (!isTest) logger.warn(`[secrets] INSECURE: ${msg}`);
  }
}

// ── Secret store ──────────────────────────────────────────────────────────────
//
// Each secret is stored as an object with:
//   current  : { value: string, loadedAt: number }
//   previous : { value: string, rotatedAt: number } | null
//
// "previous" is set during rotation and cleared after ROTATION_OVERLAP_MS.

const _secrets = {
  jwtAccess:  { current: null, previous: null },
  jwtRefresh: { current: null, previous: null },
  csrf:       { current: null, previous: null },
  reddit:     { current: null, previous: null }, // { clientId, clientSecret, userAgent }
};

// ── Secret loading ────────────────────────────────────────────────────────────

/**
 * Load (or reload) all secrets from environment variables.
 * Called once at startup, and again during live rotation if triggered.
 *
 * Reads:
 *   JWT_ACCESS_SECRET, JWT_ACCESS_SECRET_PREV
 *   JWT_REFRESH_SECRET, JWT_REFRESH_SECRET_PREV
 *   CSRF_SECRET, CSRF_SECRET_PREV
 *   REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USER_AGENT
 */
function load() {
  const now = Date.now();

  // ── JWT Access Secret ────────────────────────────────────────────────────
  const jwtAccessVal = validateSecret(
    'JWT_ACCESS_SECRET',
    process.env.JWT_ACCESS_SECRET,
    MIN_SECRET_BYTES.JWT_ACCESS_SECRET
  );
  _secrets.jwtAccess.current = { value: jwtAccessVal, loadedAt: now };

  // Previous secret (optional — used during rotation overlap window)
  const jwtAccessPrev = process.env.JWT_ACCESS_SECRET_PREV;
  if (jwtAccessPrev && !isPlaceholder(jwtAccessPrev)) {
    _secrets.jwtAccess.previous = { value: jwtAccessPrev, rotatedAt: now };
  }

  // ── JWT Refresh Secret ───────────────────────────────────────────────────
  const jwtRefreshVal = validateSecret(
    'JWT_REFRESH_SECRET',
    process.env.JWT_REFRESH_SECRET,
    MIN_SECRET_BYTES.JWT_REFRESH_SECRET
  );
  _secrets.jwtRefresh.current = { value: jwtRefreshVal, loadedAt: now };

  const jwtRefreshPrev = process.env.JWT_REFRESH_SECRET_PREV;
  if (jwtRefreshPrev && !isPlaceholder(jwtRefreshPrev)) {
    _secrets.jwtRefresh.previous = { value: jwtRefreshPrev, rotatedAt: now };
  }

  // ── Distinct check ───────────────────────────────────────────────────────
  requireDistinct(
    'JWT_ACCESS_SECRET', jwtAccessVal,
    'JWT_REFRESH_SECRET', jwtRefreshVal
  );

  // ── CSRF Secret ──────────────────────────────────────────────────────────
  const csrfVal = validateSecret(
    'CSRF_SECRET',
    process.env.CSRF_SECRET,
    MIN_SECRET_BYTES.CSRF_SECRET
  );
  _secrets.csrf.current = { value: csrfVal, loadedAt: now };

  const csrfPrev = process.env.CSRF_SECRET_PREV;
  if (csrfPrev && !isPlaceholder(csrfPrev)) {
    _secrets.csrf.previous = { value: csrfPrev, rotatedAt: now };
  }

  // ── Reddit credentials ───────────────────────────────────────────────────
  // Not validated strictly — Reddit integration is optional.
  // If missing, the updatesService skips the Reddit fetch.
  _secrets.reddit.current = {
    value: {
      clientId:     process.env.REDDIT_CLIENT_ID     || null,
      clientSecret: process.env.REDDIT_CLIENT_SECRET || null,
      userAgent:    process.env.REDDIT_USER_AGENT     || 'PatchTicker/1.0',
    },
    loadedAt: now,
  };

  // ── DB encryption key ────────────────────────────────────────────────────
  // Validated here for fail-fast startup consistency. The actual key Buffer
  // is loaded lazily in encrypt.js (so tests can inject it before require).
  // Here we just confirm the env var is present and not a placeholder.
  const dbKeyHex = process.env.DB_ENCRYPTION_KEY;
  if (!dbKeyHex || isPlaceholder(dbKeyHex)) {
    if (isProd) {
      throw new Error(
        '[secrets] DB_ENCRYPTION_KEY is missing or a placeholder. ' +
        'Field-level encryption requires a real key in production.'
      );
    }
    if (!isTest) {
      logger.warn('[secrets] DB_ENCRYPTION_KEY not set — field encryption using insecure dev fallback.');
    }
  } else if (Buffer.from(dbKeyHex, 'hex').length !== 32) {
    throw new Error(
      `[secrets] DB_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). ` +
      `Got ${Buffer.from(dbKeyHex, 'hex').length} bytes.`
    );
  }

  logger.info('Secrets loaded', {
    jwtAccessLoaded:    Boolean(jwtAccessVal),
    jwtRefreshLoaded:   Boolean(jwtRefreshVal),
    csrfLoaded:         Boolean(csrfVal),
    dbEncryptionLoaded: Boolean(dbKeyHex && !isPlaceholder(dbKeyHex)),
    redditConfigured:   Boolean(_secrets.reddit.current.value.clientId),
    hasPrevAccess:      Boolean(_secrets.jwtAccess.previous),
    hasPrevRefresh:     Boolean(_secrets.jwtRefresh.previous),
    hasPrevCsrf:        Boolean(_secrets.csrf.previous),
  });
}

// ── Rotation overlap cleanup ──────────────────────────────────────────────────

/**
 * Drop expired previous-secret entries after the rotation overlap window.
 * Called periodically and immediately after a rotation.
 */
function _prunePreviousSecrets() {
  const now = Date.now();
  for (const slot of Object.values(_secrets)) {
    if (slot.previous && (now - slot.previous.rotatedAt) >= ROTATION_OVERLAP_MS) {
      slot.previous = null;
    }
  }
}

// Prune every minute — overlap window is 30 min by default
setInterval(_prunePreviousSecrets, 60 * 1000).unref();

// ── Live rotation ─────────────────────────────────────────────────────────────

/**
 * Perform a live secret rotation.
 *
 * The caller is responsible for updating the environment variables before
 * calling this function:
 *   - Set JWT_ACCESS_SECRET to the new value
 *   - Optionally set JWT_ACCESS_SECRET_PREV to the old value for overlap
 *   (Same pattern for REFRESH and CSRF.)
 *
 * After rotation:
 *   - New secrets are used for all new token issuance
 *   - Old secrets remain valid for ROTATION_OVERLAP_MS
 *   - After the overlap window, old secrets are dropped automatically
 *
 * @returns {{ rotatedAt: string, overlapMs: number }}
 */
function rotate() {
  const rotatedAt = new Date().toISOString();
  logger.warn('Secret rotation initiated', { rotatedAt, overlapMs: ROTATION_OVERLAP_MS });

  // Preserve current secrets as "previous" before reloading
  const prev = {
    jwtAccess:  _secrets.jwtAccess.current?.value,
    jwtRefresh: _secrets.jwtRefresh.current?.value,
    csrf:       _secrets.csrf.current?.value,
  };

  // Reload from environment (new values must already be set)
  load();

  // Promote old "current" to "previous" if the values actually changed
  const now = Date.now();
  if (prev.jwtAccess && prev.jwtAccess !== _secrets.jwtAccess.current?.value) {
    _secrets.jwtAccess.previous = { value: prev.jwtAccess, rotatedAt: now };
  }
  if (prev.jwtRefresh && prev.jwtRefresh !== _secrets.jwtRefresh.current?.value) {
    _secrets.jwtRefresh.previous = { value: prev.jwtRefresh, rotatedAt: now };
  }
  if (prev.csrf && prev.csrf !== _secrets.csrf.current?.value) {
    _secrets.csrf.previous = { value: prev.csrf, rotatedAt: now };
  }

  logger.warn('Secret rotation complete', {
    rotatedAt,
    overlapMs:     ROTATION_OVERLAP_MS,
    hasPrevAccess: Boolean(_secrets.jwtAccess.previous),
    hasPrevCsrf:   Boolean(_secrets.csrf.previous),
  });

  return { rotatedAt, overlapMs: ROTATION_OVERLAP_MS };
}

// ── Auto-rotation from environment ───────────────────────────────────────────
//
// If SECRET_AUTO_ROTATE_MS is set, periodically re-read secrets from the
// environment. Pair with a secrets manager that rotates the env vars
// on a schedule (AWS Secrets Manager Lambda, Vault agent, etc.).
//
// This enables zero-downtime rotation on platforms that support live env
// var updates without process restart (Heroku, Railway, Kubernetes Secrets
// with projected volumes).

const AUTO_ROTATE_MS = parseInt(process.env.SECRET_AUTO_ROTATE_MS || '0', 10);

if (AUTO_ROTATE_MS > 0 && AUTO_ROTATE_MS >= 60 * 1000) {
  setInterval(() => {
    try {
      rotate();
    } catch (err) {
      // Never crash the process on rotation failure — keep using current secrets
      logger.error('Auto-rotation failed — continuing with existing secrets', {
        message: err.message,
      });
    }
  }, AUTO_ROTATE_MS).unref();

  logger.info('Secret auto-rotation enabled', { intervalMs: AUTO_ROTATE_MS });
}

// ── SIGUSR2 — manual rotation trigger ────────────────────────────────────────
//
// Send SIGUSR2 to the Node process to trigger a live rotation:
//   kill -USR2 $(cat .pid)    or    pkill -USR2 -f "node src/server.js"
//
// Before sending the signal:
//   1. Update JWT_ACCESS_SECRET (and optionally JWT_ACCESS_SECRET_PREV) in the
//      environment via your platform's env update mechanism.
//   2. Send SIGUSR2 — the process will reload secrets without restarting.
//
// On Windows: SIGUSR2 is not supported. Use the HTTP /api/admin/rotate-secrets
// endpoint (requires admin auth) or restart the process instead.

if (process.platform !== 'win32') {
  process.on('SIGUSR2', () => {
    logger.warn('SIGUSR2 received — triggering secret rotation');
    try {
      rotate();
    } catch (err) {
      logger.error('SIGUSR2 rotation failed', { message: err.message });
    }
  });
}

// ── Public accessors ──────────────────────────────────────────────────────────
//
// These functions return current and (if within overlap window) previous secret
// values. Call sites never access _secrets directly.

/**
 * Get all currently valid JWT access secrets.
 * Returns [current] normally, [current, previous] during rotation overlap.
 * @returns {string[]}
 */
function getJwtAccessSecrets() {
  const secrets = [_secrets.jwtAccess.current?.value].filter(Boolean);
  if (_secrets.jwtAccess.previous) secrets.push(_secrets.jwtAccess.previous.value);
  return secrets;
}

/**
 * Get the current JWT access secret (for signing new tokens).
 * Always the most recent value.
 * @returns {string}
 */
function getJwtAccessSecret() {
  const s = _secrets.jwtAccess.current?.value;
  if (!s) throw new Error('[secrets] JWT_ACCESS_SECRET not loaded');
  return s;
}

/**
 * Get all currently valid JWT refresh secrets.
 * @returns {string[]}
 */
function getJwtRefreshSecrets() {
  const secrets = [_secrets.jwtRefresh.current?.value].filter(Boolean);
  if (_secrets.jwtRefresh.previous) secrets.push(_secrets.jwtRefresh.previous.value);
  return secrets;
}

/**
 * Get the current JWT refresh secret (for signing).
 * @returns {string}
 */
function getJwtRefreshSecret() {
  const s = _secrets.jwtRefresh.current?.value;
  if (!s) throw new Error('[secrets] JWT_REFRESH_SECRET not loaded');
  return s;
}

/**
 * Get all currently valid CSRF secrets (current + previous during overlap).
 * csrf-csrf accepts an array of secrets, trying each in order.
 * @returns {string[]}
 */
function getCsrfSecrets() {
  const secrets = [_secrets.csrf.current?.value].filter(Boolean);
  if (_secrets.csrf.previous) secrets.push(_secrets.csrf.previous.value);
  return secrets;
}

/**
 * Get the current CSRF secret (for signing new tokens).
 * @returns {string}
 */
function getCsrfSecret() {
  const s = _secrets.csrf.current?.value;
  if (!s) throw new Error('[secrets] CSRF_SECRET not loaded');
  return s;
}

/**
 * Get Reddit API credentials.
 * @returns {{ clientId: string|null, clientSecret: string|null, userAgent: string }}
 */
function getRedditCredentials() {
  return _secrets.reddit.current?.value || { clientId: null, clientSecret: null, userAgent: 'PatchTicker/1.0' };
}

/**
 * Diagnostic snapshot for health/admin endpoints.
 * NEVER includes actual secret values — only metadata.
 * @returns {object}
 */
function getRotationStatus() {
  const now = Date.now();
  const overlapRemaining = (slot) => {
    if (!slot.previous) return null;
    const remaining = ROTATION_OVERLAP_MS - (now - slot.previous.rotatedAt);
    return remaining > 0 ? remaining : 0;
  };

  return {
    jwtAccess: {
      loadedAt:        _secrets.jwtAccess.current?.loadedAt
                         ? new Date(_secrets.jwtAccess.current.loadedAt).toISOString()
                         : null,
      hasPrevious:     Boolean(_secrets.jwtAccess.previous),
      overlapRemainingMs: overlapRemaining(_secrets.jwtAccess),
    },
    jwtRefresh: {
      loadedAt:        _secrets.jwtRefresh.current?.loadedAt
                         ? new Date(_secrets.jwtRefresh.current.loadedAt).toISOString()
                         : null,
      hasPrevious:     Boolean(_secrets.jwtRefresh.previous),
      overlapRemainingMs: overlapRemaining(_secrets.jwtRefresh),
    },
    csrf: {
      loadedAt:        _secrets.csrf.current?.loadedAt
                         ? new Date(_secrets.csrf.current.loadedAt).toISOString()
                         : null,
      hasPrevious:     Boolean(_secrets.csrf.previous),
      overlapRemainingMs: overlapRemaining(_secrets.csrf),
    },
    rotationOverlapMs:   ROTATION_OVERLAP_MS,
    autoRotateMs:        AUTO_ROTATE_MS || null,
  };
}

// ── Constant-time secret comparison ──────────────────────────────────────────
//
// Use this when comparing a user-supplied secret to a stored one.
// crypto.timingSafeEqual prevents timing attacks that can reveal secret length
// or content through response time differences.

/**
 * Compare two strings in constant time.
 * Returns true if they are equal, false otherwise.
 * Safe against timing side-channel attacks.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqual(a, b) {
  try {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) {
      // Length differs — must still do a comparison to avoid early-exit timing leak
      crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
      return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

// ── Initialise at module load ─────────────────────────────────────────────────
// Secrets are loaded synchronously when this module is first required.
// The server.js requires this before creating the Express app, so any
// startup validation error will prevent the server from binding to the port.

load();

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // Secret accessors (rotation-aware)
  getJwtAccessSecret,
  getJwtAccessSecrets,
  getJwtRefreshSecret,
  getJwtRefreshSecrets,
  getCsrfSecret,
  getCsrfSecrets,
  getRedditCredentials,

  // Rotation management
  rotate,
  load,
  getRotationStatus,

  // Utilities
  timingSafeEqual,
  isPlaceholder,      // exported for tests
  validateSecret,     // exported for tests
};

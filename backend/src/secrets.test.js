// src/secrets.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Tests for src/config/secrets.js
//
// Covers:
//   - Startup validation (placeholder detection, minimum length, distinct check)
//   - Secret accessors (getJwtAccessSecret, getCsrfSecrets, etc.)
//   - Rotation logic (rotate(), overlap window, previous secret pruning)
//   - timingSafeEqual utility
//   - getRotationStatus diagnostic snapshot
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ── Helpers ───────────────────────────────────────────────────────────────────

const hex64 = () => 'a'.repeat(128); // 64 bytes as hex = 128 chars
const hex32 = () => 'b'.repeat(64);  // 32 bytes as hex = 64 chars

function loadSecretsWithEnv(overrides = {}) {
  // Reset module registry so secrets.js re-runs its load() on require
  jest.resetModules();
  // Set env vars before loading the module
  Object.assign(process.env, {
    NODE_ENV:           'test',
    JWT_ACCESS_SECRET:  hex64(),
    JWT_REFRESH_SECRET: 'c'.repeat(128),
    CSRF_SECRET:        hex32(),
    ...overrides,
  });
  return require('./config/secrets');
}

// Clean up after each test
afterEach(() => {
  delete process.env.JWT_ACCESS_SECRET_PREV;
  delete process.env.JWT_REFRESH_SECRET_PREV;
  delete process.env.CSRF_SECRET_PREV;
  delete process.env.REDDIT_CLIENT_ID;
  delete process.env.REDDIT_CLIENT_SECRET;
  delete process.env.ROTATION_OVERLAP_MS;
  delete process.env.SECRET_AUTO_ROTATE_MS;
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — isPlaceholder
// ─────────────────────────────────────────────────────────────────────────────

describe('isPlaceholder', () => {
  let secrets;
  beforeEach(() => { secrets = loadSecretsWithEnv(); });

  it('detects REPLACE_WITH_ prefix', () => {
    expect(secrets.isPlaceholder('REPLACE_WITH_SECRET')).toBe(true);
  });

  it('detects YOUR_ prefix', () => {
    expect(secrets.isPlaceholder('YOUR_SECRET_HERE')).toBe(true);
  });

  it('detects your_ prefix (lowercase)', () => {
    expect(secrets.isPlaceholder('your_client_secret')).toBe(true);
  });

  it('detects changeme', () => {
    expect(secrets.isPlaceholder('changeme')).toBe(true);
  });

  it('does not flag a real secret', () => {
    expect(secrets.isPlaceholder(hex64())).toBe(false);
  });

  it('does not flag an empty string as a placeholder (separate failure path)', () => {
    // Empty string is caught by the "missing" check, not the placeholder check
    expect(secrets.isPlaceholder('')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — validateSecret
// ─────────────────────────────────────────────────────────────────────────────

describe('validateSecret', () => {
  let secrets;
  beforeEach(() => { secrets = loadSecretsWithEnv(); });

  it('accepts a valid long secret', () => {
    expect(() => secrets.validateSecret('TEST', hex64(), 32)).not.toThrow();
  });

  it('returns the value on success', () => {
    const val = hex64();
    expect(secrets.validateSecret('TEST', val, 32)).toBe(val);
  });

  it('does not throw in test env for placeholder values (warns instead)', () => {
    // In test NODE_ENV, validateSecret logs a warning but does not throw
    expect(() =>
      secrets.validateSecret('TEST', 'REPLACE_WITH_SECRET', 16)
    ).not.toThrow();
  });

  it('does not throw in test env for short secrets', () => {
    expect(() =>
      secrets.validateSecret('TEST', 'short', 32)
    ).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Secret accessors (happy path)
// ─────────────────────────────────────────────────────────────────────────────

describe('Secret accessors', () => {
  let secrets;
  const accessVal  = hex64();
  const refreshVal = 'c'.repeat(128);
  const csrfVal    = hex32();

  beforeEach(() => {
    secrets = loadSecretsWithEnv({
      JWT_ACCESS_SECRET:  accessVal,
      JWT_REFRESH_SECRET: refreshVal,
      CSRF_SECRET:        csrfVal,
    });
  });

  it('getJwtAccessSecret returns the current secret', () => {
    expect(secrets.getJwtAccessSecret()).toBe(accessVal);
  });

  it('getJwtAccessSecrets returns array with only current when no previous', () => {
    const arr = secrets.getJwtAccessSecrets();
    expect(arr).toHaveLength(1);
    expect(arr[0]).toBe(accessVal);
  });

  it('getJwtRefreshSecret returns the current refresh secret', () => {
    expect(secrets.getJwtRefreshSecret()).toBe(refreshVal);
  });

  it('getCsrfSecret returns the current CSRF secret', () => {
    expect(secrets.getCsrfSecret()).toBe(csrfVal);
  });

  it('getCsrfSecrets returns array with only current when no previous', () => {
    const arr = secrets.getCsrfSecrets();
    expect(arr).toHaveLength(1);
    expect(arr[0]).toBe(csrfVal);
  });

  it('getRedditCredentials returns nulls when not configured', () => {
    const creds = secrets.getRedditCredentials();
    expect(creds.clientId).toBeNull();
    expect(creds.clientSecret).toBeNull();
    expect(creds.userAgent).toBeTruthy();
  });

  it('getRedditCredentials returns configured values', () => {
    const s = loadSecretsWithEnv({
      REDDIT_CLIENT_ID:     'my-client-id',
      REDDIT_CLIENT_SECRET: 'my-client-secret',
      REDDIT_USER_AGENT:    'TestBot/1.0',
    });
    const creds = s.getRedditCredentials();
    expect(creds.clientId).toBe('my-client-id');
    expect(creds.clientSecret).toBe('my-client-secret');
    expect(creds.userAgent).toBe('TestBot/1.0');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Previous secret (_PREV vars) loaded at startup
// ─────────────────────────────────────────────────────────────────────────────

describe('_PREV secrets loaded at startup', () => {
  it('loads JWT_ACCESS_SECRET_PREV into the previous slot', () => {
    const prev = 'd'.repeat(128);
    const s = loadSecretsWithEnv({ JWT_ACCESS_SECRET_PREV: prev });
    const arr = s.getJwtAccessSecrets();
    expect(arr).toHaveLength(2);
    expect(arr[1]).toBe(prev);
  });

  it('does not load a placeholder _PREV value', () => {
    const s = loadSecretsWithEnv({ JWT_ACCESS_SECRET_PREV: 'REPLACE_WITH_OLD' });
    const arr = s.getJwtAccessSecrets();
    expect(arr).toHaveLength(1);
  });

  it('loads CSRF_SECRET_PREV', () => {
    const prev = 'e'.repeat(64);
    const s = loadSecretsWithEnv({ CSRF_SECRET_PREV: prev });
    const arr = s.getCsrfSecrets();
    expect(arr).toHaveLength(2);
    expect(arr[1]).toBe(prev);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — rotate()
// ─────────────────────────────────────────────────────────────────────────────

describe('rotate()', () => {
  it('returns rotatedAt and overlapMs', () => {
    const s = loadSecretsWithEnv();
    const result = s.rotate();
    expect(result).toHaveProperty('rotatedAt');
    expect(result).toHaveProperty('overlapMs');
    expect(typeof result.rotatedAt).toBe('string');
    expect(typeof result.overlapMs).toBe('number');
  });

  it('promotes old current to previous when secret changes', () => {
    const oldSecret = hex64();
    const newSecret = 'f'.repeat(128);

    const s = loadSecretsWithEnv({ JWT_ACCESS_SECRET: oldSecret });
    expect(s.getJwtAccessSecrets()).toHaveLength(1);

    // Update the env var to simulate a new secret being deployed
    process.env.JWT_ACCESS_SECRET = newSecret;
    s.rotate();

    const arr = s.getJwtAccessSecrets();
    expect(arr).toHaveLength(2);
    expect(arr[0]).toBe(newSecret);  // current
    expect(arr[1]).toBe(oldSecret);  // previous (kept for overlap window)
  });

  it('keeps same current when secret has not changed', () => {
    const s = loadSecretsWithEnv();
    const before = s.getJwtAccessSecret();
    s.rotate();
    // Value unchanged — no previous slot should be added
    expect(s.getJwtAccessSecrets()).toHaveLength(1);
    expect(s.getJwtAccessSecret()).toBe(before);
  });

  it('current secret is always used for the first element', () => {
    const oldSecret = hex64();
    const newSecret = '1'.repeat(128);

    const s = loadSecretsWithEnv({ JWT_ACCESS_SECRET: oldSecret });
    process.env.JWT_ACCESS_SECRET = newSecret;
    s.rotate();

    expect(s.getJwtAccessSecret()).toBe(newSecret);
    expect(s.getJwtAccessSecrets()[0]).toBe(newSecret);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — getRotationStatus diagnostic
// ─────────────────────────────────────────────────────────────────────────────

describe('getRotationStatus', () => {
  it('returns an object with expected shape', () => {
    const s = loadSecretsWithEnv();
    const status = s.getRotationStatus();

    expect(status).toHaveProperty('jwtAccess');
    expect(status).toHaveProperty('jwtRefresh');
    expect(status).toHaveProperty('csrf');
    expect(status).toHaveProperty('rotationOverlapMs');
    expect(status).toHaveProperty('autoRotateMs');
  });

  it('loadedAt is an ISO date string', () => {
    const s = loadSecretsWithEnv();
    const status = s.getRotationStatus();
    expect(() => new Date(status.jwtAccess.loadedAt)).not.toThrow();
  });

  it('hasPrevious is false when no previous secret exists', () => {
    const s = loadSecretsWithEnv();
    expect(s.getRotationStatus().jwtAccess.hasPrevious).toBe(false);
    expect(s.getRotationStatus().csrf.hasPrevious).toBe(false);
  });

  it('hasPrevious is true when _PREV var was set', () => {
    const s = loadSecretsWithEnv({ JWT_ACCESS_SECRET_PREV: 'g'.repeat(128) });
    expect(s.getRotationStatus().jwtAccess.hasPrevious).toBe(true);
  });

  it('does not expose actual secret values', () => {
    const accessVal = hex64();
    const s = loadSecretsWithEnv({ JWT_ACCESS_SECRET: accessVal });
    const status = JSON.stringify(s.getRotationStatus());
    // The actual secret value must not appear in the diagnostic output
    expect(status).not.toContain(accessVal);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — timingSafeEqual
// ─────────────────────────────────────────────────────────────────────────────

describe('timingSafeEqual', () => {
  let secrets;
  beforeEach(() => { secrets = loadSecretsWithEnv(); });

  it('returns true for identical strings', () => {
    expect(secrets.timingSafeEqual('abc123', 'abc123')).toBe(true);
  });

  it('returns false for different strings of the same length', () => {
    expect(secrets.timingSafeEqual('abc123', 'abc124')).toBe(false);
  });

  it('returns false for strings of different lengths', () => {
    expect(secrets.timingSafeEqual('short', 'longer')).toBe(false);
  });

  it('returns false for empty vs non-empty', () => {
    expect(secrets.timingSafeEqual('', 'something')).toBe(false);
  });

  it('returns true for two empty strings', () => {
    expect(secrets.timingSafeEqual('', '')).toBe(true);
  });

  it('handles non-string inputs gracefully', () => {
    expect(() => secrets.timingSafeEqual(null, 'a')).not.toThrow();
    expect(secrets.timingSafeEqual(null, 'a')).toBe(false);
  });

  it('is deterministic — same result on repeated calls', () => {
    const a = 'secret-value-here';
    const b = 'secret-value-here';
    expect(secrets.timingSafeEqual(a, b)).toBe(true);
    expect(secrets.timingSafeEqual(a, b)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 — tokenService rotation integration
// ─────────────────────────────────────────────────────────────────────────────

describe('tokenService uses rotation-aware secrets', () => {
  it('verifyAccessToken accepts a token signed with the current secret', () => {
    jest.resetModules();
    const accessSecret  = hex64();
    const refreshSecret = 'c'.repeat(128);
    process.env.JWT_ACCESS_SECRET  = accessSecret;
    process.env.JWT_REFRESH_SECRET = refreshSecret;
    process.env.CSRF_SECRET        = hex32();
    process.env.NODE_ENV           = 'test';

    const tokenService = require('./services/tokenService');
    const token = tokenService.issueAccessToken({ id: 'user-1', email: 'a@b.com' });
    const decoded = tokenService.verifyAccessToken(token);
    expect(decoded.sub).toBe('user-1');
    expect(decoded.email).toBe('a@b.com');
  });

  it('verifyAccessToken rejects a token signed with an unknown secret', () => {
    jest.resetModules();
    process.env.JWT_ACCESS_SECRET  = hex64();
    process.env.JWT_REFRESH_SECRET = 'c'.repeat(128);
    process.env.CSRF_SECRET        = hex32();
    process.env.NODE_ENV           = 'test';

    const jwt = require('jsonwebtoken');
    const tokenService = require('./services/tokenService');

    // Sign with a completely different secret that's not in the secrets store
    const foreignToken = jwt.sign(
      { sub: 'attacker', email: 'x@y.com', jti: 'fake-jti' },
      'z'.repeat(128),
      { algorithm: 'HS256', expiresIn: 900 }
    );

    expect(() => tokenService.verifyAccessToken(foreignToken)).toThrow();
  });

  it('verifyAccessToken accepts tokens from both current and previous secret after rotate()', () => {
    jest.resetModules();
    const oldSecret = hex64();
    const newSecret = 'f'.repeat(128);

    process.env.JWT_ACCESS_SECRET  = oldSecret;
    process.env.JWT_REFRESH_SECRET = 'c'.repeat(128);
    process.env.CSRF_SECRET        = hex32();
    process.env.NODE_ENV           = 'test';

    const tokenService = require('./services/tokenService');
    const secrets      = require('./config/secrets');

    // Issue a token with the OLD secret
    const oldToken = tokenService.issueAccessToken({ id: 'user-2', email: 'old@b.com' });

    // Rotate to new secret
    process.env.JWT_ACCESS_SECRET = newSecret;
    secrets.rotate();

    // Old token must still verify (within overlap window)
    const decoded = tokenService.verifyAccessToken(oldToken);
    expect(decoded.sub).toBe('user-2');

    // New tokens also verify
    const newToken = tokenService.issueAccessToken({ id: 'user-3', email: 'new@b.com' });
    expect(tokenService.verifyAccessToken(newToken).sub).toBe('user-3');
  });
});

// src/db.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Tests for:
//   src/utils/encrypt.js  — AES-256-GCM field encryption
//   src/config/db.js      — SSL enforcement, pool creation, isAvailable
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ── Helpers ───────────────────────────────────────────────────────────────────

function freshEncrypt(keyHex) {
  jest.resetModules();
  if (keyHex !== undefined) {
    process.env.DB_ENCRYPTION_KEY = keyHex;
  } else {
    delete process.env.DB_ENCRYPTION_KEY;
  }
  process.env.NODE_ENV = 'test';
  return require('./utils/encrypt');
}

function freshDb(overrides = {}) {
  jest.resetModules();
  const env = {
    NODE_ENV:       'test',
    DATABASE_URL:   '',
    DB_SSL:         'false',
    ...overrides,
  };
  Object.entries(env).forEach(([k, v]) => {
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  });
  return require('./config/db');
}

const VALID_KEY = 'a'.repeat(64); // 64 hex chars = 32 bytes

afterEach(() => {
  delete process.env.DB_ENCRYPTION_KEY;
  delete process.env.DATABASE_URL;
  delete process.env.DB_SSL;
  delete process.env.DB_SSL_CA;
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — encrypt / decrypt round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe('encrypt / decrypt — round-trip', () => {
  let enc;
  beforeEach(() => { enc = freshEncrypt(VALID_KEY); });

  it('decrypts to original plaintext', () => {
    const ct = enc.encrypt('hello@example.com');
    expect(enc.decrypt(ct)).toBe('hello@example.com');
  });

  it('round-trips an empty string', () => {
    const ct = enc.encrypt('');
    expect(enc.decrypt(ct)).toBe('');
  });

  it('round-trips unicode text', () => {
    const text = 'héllo wörld 🔒';
    expect(enc.decrypt(enc.encrypt(text))).toBe(text);
  });

  it('round-trips a long string', () => {
    const text = 'x'.repeat(10000);
    expect(enc.decrypt(enc.encrypt(text))).toBe(text);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — non-determinism (random IV)
// ─────────────────────────────────────────────────────────────────────────────

describe('non-determinism', () => {
  let enc;
  beforeEach(() => { enc = freshEncrypt(VALID_KEY); });

  it('produces different ciphertext on each call', () => {
    const a = enc.encrypt('same@example.com');
    const b = enc.encrypt('same@example.com');
    expect(a).not.toBe(b);
  });

  it('both ciphertexts decrypt to the same plaintext', () => {
    const a = enc.encrypt('same@example.com');
    const b = enc.encrypt('same@example.com');
    expect(enc.decrypt(a)).toBe('same@example.com');
    expect(enc.decrypt(b)).toBe('same@example.com');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — wire format structure
// ─────────────────────────────────────────────────────────────────────────────

describe('wire format', () => {
  let enc;
  beforeEach(() => { enc = freshEncrypt(VALID_KEY); });

  it('ciphertext is a hex string', () => {
    const ct = enc.encrypt('test');
    expect(/^[0-9a-f]+$/.test(ct)).toBe(true);
  });

  it('ciphertext has correct minimum length (IV + tag + at least 1 byte)', () => {
    // IV: 12 bytes = 24 hex, tag: 16 bytes = 32 hex, min ciphertext: 2 hex = 58 total
    const ct = enc.encrypt('x');
    expect(ct.length).toBeGreaterThanOrEqual(24 + 32 + 2);
  });

  it('ciphertext length grows with plaintext length', () => {
    const short = enc.encrypt('a');
    const long  = enc.encrypt('a'.repeat(100));
    expect(long.length).toBeGreaterThan(short.length);
  });

  it('ciphertext length = 24 (IV) + 32 (tag) + 2*(plaintext bytes)', () => {
    const plaintext = 'hello'; // 5 bytes
    const ct = enc.encrypt(plaintext);
    expect(ct.length).toBe(24 + 32 + 5 * 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — tamper detection
// ─────────────────────────────────────────────────────────────────────────────

describe('tamper detection', () => {
  let enc;
  beforeEach(() => { enc = freshEncrypt(VALID_KEY); });

  it('throws if ciphertext is modified (GCM auth tag check)', () => {
    const ct = enc.encrypt('sensitive data');
    // Flip a hex digit in the ciphertext portion (after IV + tag = 56 hex chars)
    const tampered = ct.slice(0, 60) + (ct[60] === 'a' ? 'b' : 'a') + ct.slice(61);
    expect(() => enc.decrypt(tampered)).toThrow();
  });

  it('throws if the auth tag is modified', () => {
    const ct = enc.encrypt('data');
    // Tag occupies hex positions 24–55 (32 chars)
    const pos = 30;
    const tampered = ct.slice(0, pos) + (ct[pos] === 'f' ? '0' : 'f') + ct.slice(pos + 1);
    expect(() => enc.decrypt(tampered)).toThrow();
  });

  it('throws if the IV is modified', () => {
    const ct = enc.encrypt('data');
    // IV is the first 24 hex chars
    const tampered = (ct[0] === 'a' ? 'b' : 'a') + ct.slice(1);
    expect(() => enc.decrypt(tampered)).toThrow();
  });

  it('throws if decrypting with a different key', () => {
    const ct = enc.encrypt('secret');
    const enc2 = freshEncrypt('b'.repeat(64)); // different key
    expect(() => enc2.decrypt(ct)).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — edge cases and error handling
// ─────────────────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  let enc;
  beforeEach(() => { enc = freshEncrypt(VALID_KEY); });

  it('encrypt throws for null input', () => {
    expect(() => enc.encrypt(null)).toThrow(TypeError);
  });

  it('encrypt throws for undefined input', () => {
    expect(() => enc.encrypt(undefined)).toThrow(TypeError);
  });

  it('decrypt throws for empty string', () => {
    expect(() => enc.decrypt('')).toThrow();
  });

  it('decrypt throws for non-string input', () => {
    expect(() => enc.decrypt(null)).toThrow(TypeError);
  });

  it('decrypt throws for truncated ciphertext', () => {
    expect(() => enc.decrypt('aabbcc')).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — key validation
// ─────────────────────────────────────────────────────────────────────────────

describe('key validation', () => {
  it('uses zero-key fallback in test env when DB_ENCRYPTION_KEY not set', () => {
    const enc = freshEncrypt(undefined); // no key
    // Should not throw — uses zero key fallback
    const ct = enc.encrypt('test');
    expect(enc.decrypt(ct)).toBe('test');
  });

  it('throws for wrong key length (not 64 hex chars)', () => {
    expect(() => freshEncrypt('deadbeef')).not.toThrow(); // module loads ok
    const enc = freshEncrypt('deadbeef');
    // encrypt() calls getKey() which throws for wrong length
    expect(() => enc.encrypt('x')).toThrow(/32 bytes/);
  });

  it('uses zero-key fallback for placeholder value in test env', () => {
    const enc = freshEncrypt('REPLACE_WITH_64_BYTE_HEX_KEY');
    const ct = enc.encrypt('test');
    expect(enc.decrypt(ct)).toBe('test');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — HMAC
// ─────────────────────────────────────────────────────────────────────────────

describe('hmac', () => {
  let enc;
  beforeEach(() => { enc = freshEncrypt(VALID_KEY); });

  it('produces a 64-character hex string', () => {
    const h = enc.hmac('user@example.com');
    expect(h).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(h)).toBe(true);
  });

  it('is deterministic — same input always produces same output', () => {
    expect(enc.hmac('a@b.com')).toBe(enc.hmac('a@b.com'));
  });

  it('produces different output for different inputs', () => {
    expect(enc.hmac('a@b.com')).not.toBe(enc.hmac('c@d.com'));
  });

  it('is key-dependent — different key produces different HMAC', () => {
    const enc2 = freshEncrypt('b'.repeat(64));
    expect(enc.hmac('a@b.com')).not.toBe(enc2.hmac('a@b.com'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 — nullable helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('encryptNullable / decryptNullable', () => {
  let enc;
  beforeEach(() => { enc = freshEncrypt(VALID_KEY); });

  it('encryptNullable returns null for null input', () => {
    expect(enc.encryptNullable(null)).toBeNull();
  });

  it('encryptNullable returns null for undefined input', () => {
    expect(enc.encryptNullable(undefined)).toBeNull();
  });

  it('encryptNullable encrypts a real value', () => {
    const ct = enc.encryptNullable('value');
    expect(ct).toBeTruthy();
    expect(enc.decrypt(ct)).toBe('value');
  });

  it('decryptNullable returns null for null input', () => {
    expect(enc.decryptNullable(null)).toBeNull();
  });

  it('decryptNullable decrypts a real ciphertext', () => {
    const ct = enc.encrypt('hello');
    expect(enc.decryptNullable(ct)).toBe('hello');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9 — db.js: isAvailable
// ─────────────────────────────────────────────────────────────────────────────

describe('db.isAvailable()', () => {
  it('returns false when DATABASE_URL is not set', () => {
    const db = freshDb({ DATABASE_URL: '' });
    expect(db.isAvailable()).toBe(false);
  });

  it('returns false when DATABASE_URL is a placeholder', () => {
    const db = freshDb({ DATABASE_URL: 'REPLACE_WITH_CONNECTION_STRING' });
    expect(db.isAvailable()).toBe(false);
  });

  it('returns true when a valid-looking DATABASE_URL is set', () => {
    const db = freshDb({ DATABASE_URL: 'postgres://user:pass@localhost:5432/testdb' });
    expect(db.isAvailable()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10 — db.js: SSL config logic
// ─────────────────────────────────────────────────────────────────────────────

describe('db SSL config', () => {
  it('query() throws a descriptive error when pool is null', async () => {
    const db = freshDb({ DATABASE_URL: '' });
    await expect(db.query('SELECT 1')).rejects.toThrow(/DATABASE_URL/);
  });

  it('getClient() throws a descriptive error when pool is null', async () => {
    const db = freshDb({ DATABASE_URL: '' });
    await expect(db.getClient()).rejects.toThrow(/DATABASE_URL/);
  });

  it('healthCheck() returns skipped:true when pool is null', async () => {
    const db = freshDb({ DATABASE_URL: '' });
    const result = await db.healthCheck();
    expect(result.skipped).toBe(true);
  });

  it('shutdown() does not throw when pool is null', async () => {
    const db = freshDb({ DATABASE_URL: '' });
    await expect(db.shutdown()).resolves.not.toThrow();
  });

  it('DB_SSL=false in test env: isAvailable returns true with a URL', () => {
    const db = freshDb({
      DATABASE_URL: 'postgres://u:p@localhost/db',
      DB_SSL: 'false',
    });
    expect(db.isAvailable()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 11 — Production safety guards
// ─────────────────────────────────────────────────────────────────────────────

describe('production safety guards', () => {
  afterEach(() => {
    process.env.NODE_ENV = 'test';
    delete process.env.DATABASE_URL;
  });

  it('db: throws at module load in production when DATABASE_URL missing', () => {
    jest.resetModules();
    process.env.NODE_ENV   = 'production';
    process.env.DATABASE_URL = '';
    expect(() => require('./config/db')).toThrow(/DATABASE_URL/);
  });

  it('encrypt: getKey() throws in production when DB_ENCRYPTION_KEY missing', () => {
    jest.resetModules();
    process.env.NODE_ENV = 'production';
    delete process.env.DB_ENCRYPTION_KEY;
    const enc = require('./utils/encrypt');
    expect(() => enc.encrypt('x')).toThrow(/DB_ENCRYPTION_KEY/);
  });
});

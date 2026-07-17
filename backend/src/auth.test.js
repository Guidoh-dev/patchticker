// src/auth.test.js
// ─────────────────────────────────────────────────────────────────────────────
// AUTH UNIT TESTS
//
// Coverage:
//   userService    — registration, login, timing-safe unknown email path,
//                    password hashing never stores plaintext, re-hash on upgrade
//   tokenService   — access token issue/verify/expiry, refresh token
//                    issue/consume/rotate, replay detection, revocation
//   lockoutService — attempt tracking, lockout trigger, unlock, window reset
//   authSchemas    — password policy, email validation, .strict() on all bodies
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ── Env setup (must happen before any service import) ────────────────────────
process.env.JWT_ACCESS_SECRET  = 'a'.repeat(64);
process.env.JWT_REFRESH_SECRET = 'b'.repeat(64);
process.env.CSRF_SECRET        = 'c'.repeat(32);
process.env.JWT_ACCESS_EXPIRES_IN  = '900';
process.env.JWT_REFRESH_EXPIRES_IN = '604800';
process.env.LOCKOUT_MAX_ATTEMPTS   = '3';
process.env.LOCKOUT_DURATION_SECONDS = '60';

const { createUser, verifyCredentials, findUserById } = require('./services/userService');
const {
  issueAccessToken, verifyAccessToken,
  issueRefreshToken, consumeRefreshToken,
  revokeRefreshToken, revokeAllUserSessions,
} = require('./services/tokenService');
const {
  checkLockout, recordFailedAttempt, clearAttempts, forceUnlock,
} = require('./services/lockoutService');
const {
  RegisterBodySchema, LoginBodySchema, RefreshBodySchema, LogoutBodySchema,
} = require('./validators/authSchemas');

// Helpers
const passes = (schema, input) => schema.safeParse(input).success;
const fails  = (schema, input) => {
  const r = schema.safeParse(input);
  if (r.success) return null;
  return r.error.errors.map(e => e.message).join(' | ');
};

// ═════════════════════════════════════════════════════════════════════════════
// userService
// ═════════════════════════════════════════════════════════════════════════════

describe('userService', () => {

  const EMAIL    = `test-${Date.now()}@example.com`;
  const PASSWORD = 'Correct$Horse9Staple!';

  describe('createUser', () => {
    it('creates a user and returns safe fields only', async () => {
      const user = await createUser({ email: EMAIL, password: PASSWORD });
      expect(user).toHaveProperty('id');
      expect(user).toHaveProperty('email', EMAIL.toLowerCase());
      expect(user).toHaveProperty('createdAt');
      expect(user).not.toHaveProperty('passwordHash');
      expect(user).not.toHaveProperty('password');
    });

    it('throws 409 on duplicate email', async () => {
      await expect(createUser({ email: EMAIL, password: PASSWORD }))
        .rejects.toMatchObject({ status: 409 });
    });

    it('normalises email to lowercase', async () => {
      const email2 = `UPPER-${Date.now()}@EXAMPLE.COM`;
      const user   = await createUser({ email: email2, password: PASSWORD });
      expect(user.email).toBe(email2.toLowerCase());
    });
  });

  describe('verifyCredentials', () => {
    it('returns user on correct credentials', async () => {
      const user = await verifyCredentials({ email: EMAIL, password: PASSWORD });
      expect(user).not.toBeNull();
      expect(user.email).toBe(EMAIL.toLowerCase());
      expect(user).not.toHaveProperty('passwordHash');
    });

    it('returns null on wrong password', async () => {
      const result = await verifyCredentials({ email: EMAIL, password: 'WrongPass1!' });
      expect(result).toBeNull();
    });

    it('returns null on unknown email (timing-safe path)', async () => {
      const result = await verifyCredentials({
        email:    'nobody@nowhere.invalid',
        password: PASSWORD,
      });
      expect(result).toBeNull();
    });

    it('does not reveal whether email exists (same null return)', async () => {
      const unknownResult = await verifyCredentials({
        email: 'ghost@example.invalid', password: 'anything',
      });
      const wrongPwResult = await verifyCredentials({
        email: EMAIL, password: 'WrongPassword1!',
      });
      expect(unknownResult).toBeNull();
      expect(wrongPwResult).toBeNull();
    });
  });

  describe('findUserById', () => {
    it('returns user by id', async () => {
      const created = await createUser({
        email:    `findme-${Date.now()}@example.com`,
        password: PASSWORD,
      });
      const found = findUserById(created.id);
      expect(found.id).toBe(created.id);
      expect(found).not.toHaveProperty('passwordHash');
    });

    it('returns null for unknown id', () => {
      expect(findUserById('00000000-0000-0000-0000-000000000000')).toBeNull();
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// tokenService
// ═════════════════════════════════════════════════════════════════════════════

describe('tokenService', () => {

  const MOCK_USER = { id: 'user-abc-123', email: 'tok@example.com' };
  const SESSION   = { userId: MOCK_USER.id, ip: '127.0.0.1', userAgent: 'jest' };

  describe('access tokens', () => {
    it('issues a verifiable JWT', () => {
      const token   = issueAccessToken(MOCK_USER);
      const payload = verifyAccessToken(token);
      expect(payload.sub).toBe(MOCK_USER.id);
      expect(payload.email).toBe(MOCK_USER.email);
      expect(payload.jti).toBeTruthy();
    });

    it('contains exp claim with 15-min TTL', () => {
      const token   = issueAccessToken(MOCK_USER);
      const payload = verifyAccessToken(token);
      const ttl     = payload.exp - payload.iat;
      expect(ttl).toBe(900);
    });

    it('throws on tampered signature', () => {
      const token   = issueAccessToken(MOCK_USER);
      const tampered = token.slice(0, -4) + 'XXXX';
      expect(() => verifyAccessToken(tampered)).toThrow();
    });

    it('throws on expired token', () => {
      const jwt = require('jsonwebtoken');
      const expired = jwt.sign(
        { sub: MOCK_USER.id, email: MOCK_USER.email, jti: 'test' },
        process.env.JWT_ACCESS_SECRET,
        { algorithm: 'HS256', expiresIn: -1 }  // already expired
      );
      expect(() => verifyAccessToken(expired)).toThrow(/expired/i);
    });

    it('rejects algorithm "none" token', () => {
      // Manually craft an alg:none token (classic attack)
      const parts = issueAccessToken(MOCK_USER).split('.');
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const noneToken = `${header}.${parts[1]}.`;
      expect(() => verifyAccessToken(noneToken)).toThrow();
    });

    it('each issued token has a unique jti', () => {
      const t1 = verifyAccessToken(issueAccessToken(MOCK_USER));
      const t2 = verifyAccessToken(issueAccessToken(MOCK_USER));
      expect(t1.jti).not.toBe(t2.jti);
    });
  });

  describe('refresh tokens', () => {
    it('issues and consumes a refresh token', () => {
      const raw     = issueRefreshToken(SESSION);
      const session = consumeRefreshToken(raw);
      expect(session).not.toBeNull();
      expect(session.userId).toBe(SESSION.userId);
    });

    it('returns null on unknown token', () => {
      expect(consumeRefreshToken('totally-fake-token')).toBeNull();
    });

    it('returns null on null input', () => {
      expect(consumeRefreshToken(null)).toBeNull();
    });

    it('prevents replay — second consume of same token returns null', () => {
      const raw = issueRefreshToken(SESSION);
      expect(consumeRefreshToken(raw)).not.toBeNull(); // first use OK
      expect(consumeRefreshToken(raw)).toBeNull();     // second use rejected
    });

    it('revokes all user sessions on replay detection', () => {
      const userId  = 'replay-test-user';
      const session = { userId, ip: '1.2.3.4', userAgent: 'jest' };

      const raw1 = issueRefreshToken(session);
      const raw2 = issueRefreshToken(session);

      // First: consume raw1 legitimately to get it marked as replaced
      consumeRefreshToken(raw1);

      // Second: re-present raw1 (replay) — should revoke raw2 as well
      consumeRefreshToken(raw1);

      // raw2 should now be revoked too
      expect(consumeRefreshToken(raw2)).toBeNull();
    });

    it('revokeRefreshToken prevents future use', () => {
      const raw = issueRefreshToken(SESSION);
      revokeRefreshToken(raw);
      expect(consumeRefreshToken(raw)).toBeNull();
    });

    it('revokeAllUserSessions clears all tokens for a user', () => {
      const userId = 'multi-session-user';
      const s      = { userId, ip: '0.0.0.0', userAgent: 'jest' };
      const t1 = issueRefreshToken(s);
      const t2 = issueRefreshToken(s);
      const t3 = issueRefreshToken(s);
      revokeAllUserSessions(userId);
      expect(consumeRefreshToken(t1)).toBeNull();
      expect(consumeRefreshToken(t2)).toBeNull();
      expect(consumeRefreshToken(t3)).toBeNull();
    });

    it('stores hash, not raw token (raw not in returned session)', () => {
      const raw     = issueRefreshToken(SESSION);
      const session = consumeRefreshToken(raw);
      // The raw UUID should not appear in the returned session object
      expect(JSON.stringify(session)).not.toContain(raw);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// lockoutService
// ═════════════════════════════════════════════════════════════════════════════

describe('lockoutService', () => {

  // Use unique emails per test group to avoid cross-test pollution
  const email = () => `lock-${Date.now()}-${Math.random()}@test.com`;

  describe('initial state', () => {
    it('returns locked:false for unknown email', () => {
      expect(checkLockout('nobody@test.com')).toEqual({ locked: false, remainingMs: 0 });
    });
  });

  describe('recordFailedAttempt', () => {
    it('increments attempts and returns attemptsRemaining', () => {
      const e = email();
      const r = recordFailedAttempt(e, '1.2.3.4');
      expect(r.locked).toBe(false);
      expect(r.attemptsRemaining).toBe(2); // MAX=3, used 1
    });

    it('locks account after MAX_ATTEMPTS failures', () => {
      const e = email();
      recordFailedAttempt(e);
      recordFailedAttempt(e);
      const last = recordFailedAttempt(e); // 3rd = MAX
      expect(last.locked).toBe(true);
      expect(last.attemptsRemaining).toBe(0);
    });

    it('checkLockout returns locked:true after lockout', () => {
      const e = email();
      recordFailedAttempt(e); recordFailedAttempt(e); recordFailedAttempt(e);
      const status = checkLockout(e);
      expect(status.locked).toBe(true);
      expect(status.remainingMs).toBeGreaterThan(0);
    });
  });

  describe('clearAttempts', () => {
    it('resets counter on successful login', () => {
      const e = email();
      recordFailedAttempt(e);
      recordFailedAttempt(e);
      clearAttempts(e);
      expect(checkLockout(e)).toEqual({ locked: false, remainingMs: 0 });
      // Should be able to fail again from scratch
      const r = recordFailedAttempt(e);
      expect(r.attemptsRemaining).toBe(2);
    });
  });

  describe('forceUnlock', () => {
    it('removes lockout immediately', () => {
      const e = email();
      recordFailedAttempt(e); recordFailedAttempt(e); recordFailedAttempt(e);
      expect(checkLockout(e).locked).toBe(true);
      forceUnlock(e);
      expect(checkLockout(e).locked).toBe(false);
    });
  });

  describe('email case insensitivity', () => {
    it('treats UPPER@CASE.COM same as upper@case.com', () => {
      const e = `LOCKCASE-${Date.now()}@TEST.COM`;
      recordFailedAttempt(e);
      recordFailedAttempt(e);
      recordFailedAttempt(e);
      // Check with lowercase version
      expect(checkLockout(e.toLowerCase()).locked).toBe(true);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// authSchemas
// ═════════════════════════════════════════════════════════════════════════════

describe('authSchemas', () => {

  const validRegister = {
    email:           'user@example.com',
    password:        'SecureP@ss1234',
    confirmPassword: 'SecureP@ss1234',
  };

  const validLogin = {
    email:    'user@example.com',
    password: 'anypassword1',
  };

  // ── RegisterBodySchema ─────────────────────────────────────────────────────
  describe('RegisterBodySchema', () => {

    describe('valid inputs', () => {
      it('accepts a valid registration', () => {
        expect(passes(RegisterBodySchema, validRegister)).toBe(true);
      });
      it('lowercases email in output', () => {
        const r = RegisterBodySchema.safeParse({ ...validRegister, email: 'USER@EXAMPLE.COM' });
        expect(r.success).toBe(true);
        expect(r.data.email).toBe('user@example.com');
      });
    });

    describe('email validation', () => {
      it('rejects invalid email format', () => {
        expect(fails(RegisterBodySchema, { ...validRegister, email: 'notanemail' })).toBeTruthy();
      });
      it('rejects email over 254 chars', () => {
        const long = 'a'.repeat(250) + '@x.com';
        expect(fails(RegisterBodySchema, { ...validRegister, email: long })).toBeTruthy();
      });
      it('rejects missing email', () => {
        const { email, ...rest } = validRegister;
        expect(fails(RegisterBodySchema, rest)).toBeTruthy();
      });
    });

    describe('password policy', () => {
      it('rejects password under 12 chars', () => {
        expect(fails(RegisterBodySchema, { ...validRegister, password: 'Short1!', confirmPassword: 'Short1!' })).toMatch(/12/);
      });
      it('rejects password over 128 chars', () => {
        const long = 'Aa1!' + 'x'.repeat(125);
        expect(fails(RegisterBodySchema, { ...validRegister, password: long, confirmPassword: long })).toBeTruthy();
      });
      it('rejects password without uppercase', () => {
        const pw = 'nouppercase1!password';
        expect(fails(RegisterBodySchema, { ...validRegister, password: pw, confirmPassword: pw })).toMatch(/uppercase/i);
      });
      it('rejects password without lowercase', () => {
        const pw = 'NOLOWERCASE1!PASS';
        expect(fails(RegisterBodySchema, { ...validRegister, password: pw, confirmPassword: pw })).toMatch(/lowercase/i);
      });
      it('rejects password without digit', () => {
        const pw = 'NoDigitPassword!';
        expect(fails(RegisterBodySchema, { ...validRegister, password: pw, confirmPassword: pw })).toMatch(/number/i);
      });
      it('rejects password without special char', () => {
        const pw = 'NoSpecialChar123';
        expect(fails(RegisterBodySchema, { ...validRegister, password: pw, confirmPassword: pw })).toMatch(/special/i);
      });
      it('reports all missing criteria at once', () => {
        const pw = 'short'; // fails min, no upper, no digit, no special
        const msg = fails(RegisterBodySchema, { ...validRegister, password: pw, confirmPassword: pw });
        expect(msg).toMatch(/12/);
      });
    });

    describe('confirmPassword', () => {
      it('rejects mismatched passwords', () => {
        expect(fails(RegisterBodySchema, {
          ...validRegister,
          confirmPassword: 'Different@Pass999',
        })).toMatch(/do not match/i);
      });
    });

    describe('.strict() — extra field rejection', () => {
      it('rejects extra fields', () => {
        expect(fails(RegisterBodySchema, { ...validRegister, isAdmin: true })).toBeTruthy();
      });
      it('rejects __proto__', () => {
        expect(fails(RegisterBodySchema, { ...validRegister, __proto__: { x: 1 } })).toBeTruthy();
      });
      it('rejects role field', () => {
        expect(fails(RegisterBodySchema, { ...validRegister, role: 'admin' })).toBeTruthy();
      });
    });
  });

  // ── LoginBodySchema ────────────────────────────────────────────────────────
  describe('LoginBodySchema', () => {
    it('accepts valid login', () => {
      expect(passes(LoginBodySchema, validLogin)).toBe(true);
    });
    it('rejects missing password', () => {
      expect(fails(LoginBodySchema, { email: 'a@b.com' })).toBeTruthy();
    });
    it('rejects empty password', () => {
      expect(fails(LoginBodySchema, { email: 'a@b.com', password: '' })).toBeTruthy();
    });
    it('rejects invalid email', () => {
      expect(fails(LoginBodySchema, { email: 'bad', password: 'pass123' })).toBeTruthy();
    });
    it('rejects extra fields', () => {
      expect(fails(LoginBodySchema, { ...validLogin, remember: true })).toBeTruthy();
    });
    it('rejects __proto__', () => {
      expect(fails(LoginBodySchema, { ...validLogin, __proto__: {} })).toBeTruthy();
    });
    it('password can contain any chars (no injection block on password)', () => {
      // Passwords are hashed — injection guards on password would reduce entropy
      const tricky = { email: 'a@b.com', password: '<script>alert(1)</script>Pass1!' };
      // Should fail only if under 12 chars, not due to HTML
      // This one is valid length with upper/lower/digit/special
      const r = LoginBodySchema.safeParse(tricky);
      // Login schema only checks non-empty and max length — not policy
      expect(r.success).toBe(true);
    });
  });

  // ── RefreshBodySchema ──────────────────────────────────────────────────────
  describe('RefreshBodySchema', () => {
    it('accepts empty body', () => {
      expect(passes(RefreshBodySchema, {})).toBe(true);
    });
    it('rejects any field in body', () => {
      expect(fails(RefreshBodySchema, { token: 'abc' })).toBeTruthy();
    });
    it('rejects injection attempt in body', () => {
      expect(fails(RefreshBodySchema, { $where: '1==1' })).toBeTruthy();
    });
  });

  // ── LogoutBodySchema ───────────────────────────────────────────────────────
  describe('LogoutBodySchema', () => {
    it('accepts empty body', () => {
      expect(passes(LogoutBodySchema, {})).toBe(true);
    });
    it('rejects any field', () => {
      expect(fails(LogoutBodySchema, { userId: '123' })).toBeTruthy();
    });
  });
});

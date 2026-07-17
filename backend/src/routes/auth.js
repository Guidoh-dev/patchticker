// src/routes/auth.js
// ─────────────────────────────────────────────────────────────────────────────
// AUTH ROUTES
//
//  GET  /api/auth/csrf-token  — issue CSRF token (call before any mutation)
//  POST /api/auth/register    — create account (CSRF protected)
//  POST /api/auth/login       — authenticate (CSRF protected, lockout enforced)
//  POST /api/auth/refresh     — rotate tokens (CSRF protected, cookie auth)
//  POST /api/auth/logout      — revoke refresh token (CSRF protected)
//  GET  /api/auth/me          — current user info (JWT protected)
//  POST /api/auth/verify-email  — consume email verification token
//  POST /api/auth/resend-verification — resend verification email
//  POST /api/auth/forgot-password — request password reset email
//  POST /api/auth/reset-password  — consume reset token + set new password
//
// TOKEN FLOW
// ──────────
//  Register / Login:
//    → Response body:  { accessToken, expiresIn, user }
//    → Response cookie: pp-rt (HTTP-only, Secure, SameSite=Strict)
//
//  Refresh:
//    → Client sends: pp-rt cookie (automatic) + X-CSRF-Token header
//    → Response body:  { accessToken, expiresIn }
//    → Response cookie: new pp-rt (old one invalidated)
//
//  Logout:
//    → Refresh token revoked in store
//    → pp-rt cookie cleared
//    → Client should discard the access token from memory
//
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express  = require('express');
const router   = express.Router();

const validate                 = require('../middleware/validate');
const requireAuth              = require('../middleware/requireAuth');
const { csrfProtection, sendCsrfToken } = require('../middleware/csrf');
const { authLimiter, loginLimiter } = require('../middleware/rateLimiter');
const verifyCaptcha            = require('../middleware/captcha');
const blockDisposableEmails    = require('../services/disposableEmail');
const crossAccountStuffing     = require('../middleware/crossAccountStuffing');

const { RegisterBodySchema, LoginBodySchema, RefreshBodySchema, LogoutBodySchema }
  = require('../validators/authSchemas');

const { createUser, verifyCredentials }    = require('../services/userService');
const { issueAccessToken, issueRefreshToken,
        consumeRefreshToken, revokeRefreshToken,
        ACCESS_TTL }                        = require('../services/tokenService');
const { checkLockout, recordFailedAttempt, clearAttempts }
  = require('../services/lockoutService');
const { setRefreshCookie, clearRefreshCookie, getRefreshToken }
  = require('../utils/cookies');
const logger = require('../utils/logger');

const {
  issueEmailVerificationToken,
  verifyEmailToken,
  issuePasswordResetToken,
  verifyPasswordResetToken,
} = require('../services/authTokenService');
const { findUserByEmail, updateUserPassword } = require('../services/userService');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../services/emailService');

// ── GET /api/auth/csrf-token ──────────────────────────────────────────────────
// Must be called by the frontend before any auth mutation.
// Sets the pp-csrf cookie and returns the token value for the X-CSRF-Token header.
router.get('/csrf-token', (req, res) => {
  sendCsrfToken(req, res);
});

// ── POST /api/auth/register ───────────────────────────────────────────────────
router.post(
  '/register',
  authLimiter,
  csrfProtection,
  validate({ body: RegisterBodySchema }),
  blockDisposableEmails,  // reject throwaway domains before any DB work
  verifyCaptcha,          // hCaptcha server-side verification (bot defence)
  async (req, res, next) => {
    try {
      const { email, password } = req.body;

      const user         = await createUser({ email, password });
      const accessToken  = issueAccessToken(user);
      const refreshToken = issueRefreshToken({
        userId:    user.id,
        ip:        req.ip,
        userAgent: req.headers['user-agent'],
      });

      setRefreshCookie(res, refreshToken);

      logger.info('User registered', {
        userId: user.id,
        ip:     req.ip,
        captchaScore: req.captcha?.score ?? null,
      });

      // Issue + send verification email (non-blocking — don't fail registration if email fails)
      issueEmailVerificationToken(user.id)
        .then((token) => sendVerificationEmail(user.email, token))
        .catch((e) => logger.warn('Failed to send verification email', { userId: user.id, message: e.message }));

      res.status(201).json({
        accessToken,
        expiresIn: ACCESS_TTL,
        user: { id: user.id, email: user.email, role: user.role || 'free', emailVerified: false },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post(
  '/login',
  loginLimiter,              // strict per-IP rate limit on login attempts
  csrfProtection,
  crossAccountStuffing,      // detect one IP trying many different accounts
  validate({ body: LoginBodySchema }),
  async (req, res, next) => {
    try {
      const { email, password } = req.body;
      const ip                  = req.ip;

      // 1. Check lockout BEFORE doing any crypto work
      const lockout = await checkLockout(email);
      if (lockout.locked) {
        const minutes = Math.ceil(lockout.remainingMs / 60000);
        return res.status(429).json({
          error: `Account locked due to repeated failed login attempts. Try again in ${minutes} minute${minutes !== 1 ? 's' : ''}.`,
        });
      }

      // 2. Verify credentials (always constant-time via argon2.verify)
      const user = await verifyCredentials({ email, password });

      if (!user) {
        const result = await recordFailedAttempt(email, ip);
        // Generic message — never distinguish email-not-found from wrong-password
        if (result.locked) {
          const minutes = Math.ceil(
            parseInt(process.env.LOCKOUT_DURATION_SECONDS || '900', 10) / 60
          );
          return res.status(429).json({
            error: `Invalid credentials. Account locked for ${minutes} minute${minutes !== 1 ? 's' : ''} due to repeated failures.`,
          });
        }
        logger.warn('Failed login attempt', {
          ip,
          attemptsRemaining: result.attemptsRemaining,
          // email deliberately omitted from log — enumeration risk
        });
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // 3. Successful login — clear lockout, issue tokens
      await clearAttempts(email);

      const accessToken  = issueAccessToken(user);
      const refreshToken = issueRefreshToken({
        userId:    user.id,
        ip,
        userAgent: req.headers['user-agent'],
      });

      setRefreshCookie(res, refreshToken);

      logger.info('User logged in', { userId: user.id, ip });

      res.json({
        accessToken,
        expiresIn: ACCESS_TTL,
        user: { id: user.id, email: user.email, role: user.role || 'free', emailVerified: user.emailVerified || false },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/auth/refresh ────────────────────────────────────────────────────
router.post(
  '/refresh',
  authLimiter,
  csrfProtection,
  validate({ body: RefreshBodySchema }),
  async (req, res, next) => {
    try {
      const rawToken = getRefreshToken(req);

      if (!rawToken) {
        return res.status(401).json({ error: 'No refresh token' });
      }

      // consumeRefreshToken handles expiry check + replay detection
      const session = consumeRefreshToken(rawToken);

      if (!session) {
        // Token invalid, expired, or replayed — clear the cookie
        clearRefreshCookie(res);
        return res.status(401).json({ error: 'Refresh token invalid or expired' });
      }

      // Fetch fresh user data (handles account changes since last login)
      const { findUserById } = require('../services/userService');
      const user = await findUserById(session.userId);

      if (!user) {
        clearRefreshCookie(res);
        return res.status(401).json({ error: 'User not found' });
      }

      // Rotate: new access token + new refresh token
      const newAccessToken  = issueAccessToken(user);
      const newRefreshToken = issueRefreshToken({
        userId:    user.id,
        ip:        req.ip,
        userAgent: req.headers['user-agent'],
      });

      setRefreshCookie(res, newRefreshToken);

      logger.info('Tokens rotated', { userId: user.id, ip: req.ip });

      res.json({
        accessToken: newAccessToken,
        expiresIn:   ACCESS_TTL,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
router.post(
  '/logout',
  authLimiter,
  csrfProtection,
  validate({ body: LogoutBodySchema }),
  (req, res) => {
    const rawToken = getRefreshToken(req);
    revokeRefreshToken(rawToken);   // no-op if token absent / already revoked
    clearRefreshCookie(res);

    logger.info('User logged out', { ip: req.ip });
    res.json({ message: 'Logged out successfully' });
  }
);

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
// Protected — requires valid access token in Authorization: Bearer header
router.get(
  '/me',
  requireAuth,
  (req, res) => {
    // req.user is set by requireAuth (id, email, role)
    res.json({ user: req.user });
  }
);


// ── POST /api/auth/verify-email ───────────────────────────────────────────────
// Consume a one-time email verification token (from the link in the welcome email).
const VerifyEmailSchema = require('zod').object({ token: require('zod').string().min(64).max(64) }).strict();

router.post(
  '/verify-email',
  authLimiter,
  validate({ body: VerifyEmailSchema }),
  async (req, res, next) => {
    try {
      const userId = await verifyEmailToken(req.body.token);
      if (!userId) {
        return res.status(400).json({ error: 'Verification link is invalid or has expired' });
      }
      logger.info('Email verified', { userId });
      res.json({ message: 'Email verified successfully' });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/auth/resend-verification ───────────────────────────────────────
// Re-send the verification email. Rate limited to prevent abuse.
const ResendVerifySchema = require('zod').object({}).strict();

router.post(
  '/resend-verification',
  authLimiter,
  requireAuth,
  validate({ body: ResendVerifySchema }),
  async (req, res, next) => {
    try {
      const user = await findUserById(req.user.id);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      if (user.emailVerified) {
        return res.status(400).json({ error: 'Email is already verified' });
      }

      const token = await issueEmailVerificationToken(user.id);
      await sendVerificationEmail(user.email, token);

      logger.info('Verification email resent', { userId: user.id });
      res.json({ message: 'Verification email sent' });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/auth/forgot-password ───────────────────────────────────────────
// Request a password reset email. Always responds 200 to prevent email enumeration.
const ForgotPasswordSchema = require('../validators/authSchemas').LoginBodySchema
  .pick({ email: true });

router.post(
  '/forgot-password',
  authLimiter,
  validate({ body: require('zod').object({ email: require('../validators/authSchemas').LoginBodySchema.shape.email }).strict() }),
  async (req, res, next) => {
    try {
      // Constant-time response — always 200, even if email not found
      const user = await findUserByEmail(req.body.email);

      if (user) {
        const token = await issuePasswordResetToken(user.id);
        sendPasswordResetEmail(user.email, token).catch((e) =>
          logger.warn('Failed to send reset email', { userId: user.id, message: e.message })
        );
        logger.info('Password reset requested', { userId: user.id });
      } else {
        logger.info('Password reset requested for unknown email (suppressed)');
      }

      // Always 200 — never reveal whether email exists
      res.json({ message: 'If an account exists for this email, a reset link has been sent.' });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/auth/reset-password ────────────────────────────────────────────
// Consume a password reset token and set a new password.
const { z: _z } = require('zod');
const { _hardened: _h } = require('../validators/schemas');
const ResetPasswordSchema = _z.object({
  token:           _z.string().min(64).max(64),
  password:        require('../validators/authSchemas').RegistrationPasswordField,
  confirmPassword: _z.string().min(1, 'Please confirm your password'),
}).strict().superRefine(({ password, confirmPassword }, ctx) => {
  if (password !== confirmPassword) {
    ctx.addIssue({ code: _z.ZodIssueCode.custom, path: ['confirmPassword'], message: 'Passwords do not match' });
  }
});

router.post(
  '/reset-password',
  authLimiter,
  validate({ body: ResetPasswordSchema }),
  async (req, res, next) => {
    try {
      const userId = await verifyPasswordResetToken(req.body.token);
      if (!userId) {
        return res.status(400).json({ error: 'Reset link is invalid or has expired' });
      }

      await updateUserPassword(userId, req.body.password);

      // Revoke all existing sessions (forces re-login with new password)
      const { revokeAllUserSessions } = require('../services/tokenService');
      await revokeAllUserSessions(userId);

      logger.info('Password reset completed', { userId });
      res.json({ message: 'Password updated successfully. Please log in again.' });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;

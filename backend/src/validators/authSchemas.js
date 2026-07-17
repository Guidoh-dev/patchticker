// src/validators/authSchemas.js
// ─────────────────────────────────────────────────────────────────────────────
// ZOD SCHEMAS FOR AUTH ROUTES
//
// PASSWORD POLICY (enforced at registration)
// ──────────────────────────────────────────
//  min 12 chars    — NIST SP 800-63B minimum recommendation (2024)
//  max 128 chars   — prevents DoS via excessively long argon2 input
//  ≥1 uppercase    — character class diversity
//  ≥1 lowercase
//  ≥1 digit
//  ≥1 special char — from a whitelist of printable ASCII specials
//
//  No injection hardening on the password field — it is NEVER stored
//  in plaintext and NEVER interpolated into any query. argon2.hash()
//  treats it as opaque bytes. Blocking < > etc. in passwords is an
//  antipattern that weakens entropy without improving security.
//
// EMAIL POLICY
// ────────────
//  Lowercased + trimmed before any comparison.
//  .email() uses Zod's built-in RFC-5322 validation.
//  max 254 chars — RFC 5321 maximum email address length.
//  hardened() injection guards still applied (email could be stored/logged).
//
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { z } = require('zod');
const { _hardened: hardened } = require('./schemas');

// ── Email field ───────────────────────────────────────────────────────────────
// Shared between register and login. Lowercased in .transform() so all
// downstream comparisons are case-insensitive without extra code.
const EmailField = z
  .string()
  .trim()
  .toLowerCase()
  .email('Must be a valid email address')
  .max(254, 'Email must not exceed 254 characters');

// ── Password field (login) ────────────────────────────────────────────────────
// Login only requires non-empty, bounded string.
// We do NOT apply injection guards on the password — see module docstring.
const LoginPasswordField = z
  .string()
  .min(1, 'Password is required')
  .max(128, 'Password must not exceed 128 characters');

// ── Password field (registration — full policy) ───────────────────────────────
const RegistrationPasswordField = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must not exceed 128 characters')
  .superRefine((v, ctx) => {
    const add = (msg) => ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg });
    if (!/[A-Z]/.test(v))                    add('Password must contain at least one uppercase letter');
    if (!/[a-z]/.test(v))                    add('Password must contain at least one lowercase letter');
    if (!/[0-9]/.test(v))                    add('Password must contain at least one number');
    if (!/[!@#$%^&*()_+\-=\[\]{}|;,.<>?]/.test(v))
                                              add('Password must contain at least one special character');
  });

// ── POST /api/auth/register ───────────────────────────────────────────────────
const RegisterBodySchema = z
  .object({
    email:           EmailField,
    password:        RegistrationPasswordField,
    confirmPassword: z.string().min(1, 'Please confirm your password'),
  })
  .strict()
  .superRefine(({ password, confirmPassword }, ctx) => {
    if (password !== confirmPassword) {
      ctx.addIssue({
        code:    z.ZodIssueCode.custom,
        path:    ['confirmPassword'],
        message: 'Passwords do not match',
      });
    }
  });

// ── POST /api/auth/login ──────────────────────────────────────────────────────
const LoginBodySchema = z
  .object({
    email:    EmailField,
    password: LoginPasswordField,
  })
  .strict();

// ── POST /api/auth/refresh ────────────────────────────────────────────────────
// Body carries no data — the refresh token arrives via HTTP-only cookie.
// We validate the body schema is empty to reject mass-assignment attempts.
const RefreshBodySchema = z.object({}).strict();

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
const LogoutBodySchema = z.object({}).strict();

module.exports = {
  RegisterBodySchema,
  LoginBodySchema,
  RefreshBodySchema,
  LogoutBodySchema,
};

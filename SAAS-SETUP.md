# PatchTicker — SaaS Architecture Setup Guide

## Overview

This document covers the complete SaaS-ready architecture added to PatchTicker. All 10 features are implemented and tested.

---

## What Was Built

### Backend

| Feature | File(s) |
|---|---|
| JWT authentication | `services/tokenService.js`, `middleware/requireAuth.js` |
| Argon2id password hashing | `services/userService.js` |
| Role-based access (free/pro/admin) | `middleware/requireRole.js` |
| Subscription table + DB model | `schema-saas.sql`, `services/subscriptionService.js` |
| Stripe checkout + billing portal | `routes/billing.js`, `services/subscriptionService.js` |
| Stripe webhook handler | `routes/webhooks.js` |
| Paid route protection | `middleware/requireRole.js` (requirePro) |
| Subscription status validation | `middleware/requireRole.js` (live DB check on every pro request) |
| Email verification flow | `services/authTokenService.js`, `routes/auth.js`, `services/emailService.js` |
| Password reset flow | `services/authTokenService.js`, `routes/auth.js`, `services/emailService.js` |

### Frontend

| Feature | File(s) |
|---|---|
| Login / Register pages | `src/main.js` (renderLogin, renderRegister) |
| Forgot / Reset password pages | `src/main.js` (renderForgotPassword, renderResetPassword) |
| Email verification landing | `src/main.js` (renderVerifyEmail) |
| Pricing page (3 tiers) | `src/main.js` (renderPricing) |
| Subscription status banner | `src/main.js` (renderSubscriptionBanner) |
| Dashboard with role gating | `src/main.js` (renderDashboard) |
| Auth-aware API client | `src/api.js` (auto-refresh, CSRF protection) |
| Client auth state manager | `src/auth.js` |
| Hash-based router | `src/router.js` |

---

## Quick Start

### 1. Apply the database schema

```bash
psql "$DATABASE_URL" -f schema.sql        # base schema
psql "$DATABASE_URL" -f schema-saas.sql   # SaaS additions
```

### 2. Configure the backend

```bash
cd backend
cp .env.example .env
# Fill in every REPLACE_WITH_* value
```

Required values before launch:

```env
JWT_ACCESS_SECRET=<64-byte hex>
JWT_REFRESH_SECRET=<64-byte hex>
CSRF_SECRET=<32-byte hex>
DB_ENCRYPTION_KEY=<64-byte hex>
HEALTH_SECRET=<48-char hex>
ALLOWED_ORIGINS=https://yourdomain.com
APP_URL=https://yourdomain.com
DATABASE_URL=postgres://...
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PRO_MONTHLY=price_...
STRIPE_PRICE_PRO_ANNUAL=price_...
```

Optional email transport (pick one):

```env
SENDGRID_API_KEY=SG.xxx          # Option 1: SendGrid
# OR
SMTP_HOST=smtp.yourprovider.com  # Option 2: Custom SMTP
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
```

### 3. Configure the frontend

```bash
cd frontend
cp .env.example .env
```

```env
VITE_STRIPE_PRICE_MONTHLY=price_xxx
VITE_STRIPE_PRICE_ANNUAL=price_xxx
```

### 4. Set up Stripe webhooks

Forward events in development:

```bash
stripe listen --forward-to localhost:4000/api/webhooks/stripe
```

In production, create a webhook endpoint in the Stripe Dashboard pointing to:
```
https://yourdomain.com/api/webhooks/stripe
```

Required events to subscribe to:
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_succeeded`
- `invoice.payment_failed`
- `checkout.session.completed`

### 5. Run tests

```bash
cd backend
npm install
npm test -- --testPathPattern=saas
```

Expected: **15 test suites, 55+ assertions, all passing**.

---

## Architecture Notes

### Token Flow

```
Register/Login
  → POST /api/auth/register|login
  → Response body: { accessToken, expiresIn, user }
  → Response cookie: pp-rt (HTTP-only, Secure, SameSite=Strict)

Authenticated Requests
  → Authorization: Bearer <accessToken>

Token Refresh (auto, handled by api.js)
  → POST /api/auth/refresh (sends pp-rt cookie automatically)
  → Response: { accessToken, expiresIn }
  → Old refresh token invalidated (rotation)
  → Replay detection: reused token revokes ALL user sessions
```

### Role Hierarchy

```
admin (rank 2) → bypasses all checks, never downgraded by Stripe
pro   (rank 1) → active/trialing Stripe subscription required
free  (rank 0) → default for all new users
```

### Subscription State Machine

```
Stripe event → webhook → syncSubscription() → upsert subscriptions row
                                             → update users.role
                                             → send transactional email
```

`requirePro` middleware performs a **live DB check** on every request to catch webhook lag. Admin role is never downgraded.

### Email Tokens (Security Model)

- 32-byte cryptographically random raw token (hex → 64 chars)
- Only `SHA-256(token)` stored in DB — raw token never persisted
- Single-use: `used_at` set on redemption
- Expiry enforced in SQL
- Previous tokens for same user purged on new issuance

### Password Security

- **argon2id** with `memoryCost: 65536`, `timeCost: 3`, `parallelism: 4`
- Constant-time comparison (argon2.verify)
- Automatic rehash if parameters are upgraded
- Timing-safe dummy hash for unknown email

---

## Route Reference

### Auth routes (`/api/auth/*`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/csrf-token` | None | Issue CSRF token |
| POST | `/register` | None | Create account |
| POST | `/login` | None | Authenticate |
| POST | `/refresh` | Cookie | Rotate tokens |
| POST | `/logout` | Cookie | Revoke session |
| GET | `/me` | Bearer | Current user |
| POST | `/verify-email` | None | Consume email token |
| POST | `/resend-verification` | Bearer | Resend verify email |
| POST | `/forgot-password` | None | Request reset email |
| POST | `/reset-password` | None | Consume reset token |

### Billing routes (`/api/billing/*`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/checkout` | Bearer | Create Stripe Checkout session |
| POST | `/portal` | Bearer | Create Stripe Billing Portal session |
| GET | `/status` | Bearer | Current subscription status |

### Webhook routes (`/api/webhooks/*`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/stripe` | Stripe-Signature | Receive Stripe events |

---

## Frontend Routes

| Hash | Page | Auth required |
|------|------|---------------|
| `#/` | Dashboard | Yes → redirects to `#/login` |
| `#/login` | Sign in | No |
| `#/register` | Create account | No |
| `#/pricing` | Pricing page | No |
| `#/forgot-password` | Forgot password | No |
| `#/reset-password?token=xxx` | Reset password | No |
| `#/verify-email?token=xxx` | Email verification | No |

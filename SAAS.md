# PatchTicker — SaaS Architecture

> Software update intelligence platform with full SaaS billing, role-based access, and email flows.

---

## Architecture Overview

```
Frontend (Vite/Vanilla JS)
  │
  ├── Auth views: login, register, forgot-password, reset-password, verify-email
  ├── Pricing page (Stripe Checkout, Billing Portal)
  ├── Dashboard (role-aware: Free / Pro / Admin)
  └── api.js — token-refreshing, CSRF-protected fetch client
          │
          ▼
Backend (Express / Node.js)
  │
  ├── /api/auth        — JWT auth, email verification, password reset
  ├── /api/billing     — Stripe Checkout + Portal sessions, subscription status
  ├── /api/webhooks    — Stripe webhook receiver (signature-verified, idempotent)
  ├── /api/updates     — public update feed (free + pro)
  ├── /api/bug-reports — pro-gated report submission
  ├── /api/admin       — admin-only user/subscription management
  └── /api/health      — liveness, readiness, ops dashboard
          │
          ▼
PostgreSQL (Railway / Supabase / Neon / RDS)
  │
  ├── users                      — argon2id hashed passwords, AES-256-GCM email
  ├── refresh_tokens             — opaque tokens (SHA-256 hash only)
  ├── subscriptions              — Stripe billing state mirror
  ├── subscription_events        — Stripe webhook audit log
  ├── email_verification_tokens  — 24h one-time tokens (SHA-256 hash only)
  └── password_reset_tokens      — 1h one-time tokens (SHA-256 hash only)
```

---

## Role Hierarchy

| Role    | Access                                             |
|---------|----------------------------------------------------|
| `free`  | Public update feed, account management             |
| `pro`   | All free features + bug report submission, API     |
| `admin` | All pro features + user management, stats          |

Roles are set by Stripe webhook events (active/trialing → `pro`) and reset on cancellation (`free`). Admins are never downgraded by billing events. Role can also be manually overridden via `PATCH /api/admin/users/:id/role`.

---

## Quick Start

### 1. Install dependencies

```bash
cd backend && npm install
cd ../frontend && npm install
```

### 2. Configure environment

```bash
cp backend/.env.example backend/.env
```

Generate required secrets:
```bash
# JWT access + refresh secrets (must be different)
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# CSRF secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# DB encryption key (AES-256-GCM — for PII at rest)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Fill in `.env`:
- `JWT_ACCESS_SECRET` — 64+ hex chars
- `JWT_REFRESH_SECRET` — 64+ hex chars (different from above)
- `CSRF_SECRET` — 32+ hex chars
- `DB_ENCRYPTION_KEY` — 64 hex chars exactly
- `DATABASE_URL` — PostgreSQL connection string
- `ALLOWED_ORIGINS` — comma-separated frontend origins

### 3. Set up the database

```bash
# Apply schema (idempotent — safe to re-run)
psql "$DATABASE_URL" -f schema-complete.sql
```

The schema creates:
- `patchticker_owner` role (DBA, owns all objects)
- `patchticker_app` role (app runtime — least privilege)
- All tables with indexes, triggers, and row-level security hooks

Set `DATABASE_URL` to connect as `patchticker_app` at runtime.

### 4. Configure Stripe

1. Create a Stripe account at [dashboard.stripe.com](https://dashboard.stripe.com)
2. Create a Product with two Prices (monthly + annual)
3. Copy your keys into `.env`:

```env
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PRO_MONTHLY=price_...
STRIPE_PRICE_PRO_ANNUAL=price_...
STRIPE_TRIAL_DAYS=14
```

4. Register the webhook endpoint:
   - **URL:** `https://yourdomain.com/api/webhooks/stripe`
   - **Events to listen for:**
     - `customer.subscription.created`
     - `customer.subscription.updated`
     - `customer.subscription.deleted`
     - `invoice.payment_succeeded`
     - `invoice.payment_failed`
     - `checkout.session.completed`

**Local webhook testing:**
```bash
stripe listen --forward-to localhost:4000/api/webhooks/stripe
```

### 5. Configure email

Choose one transport:

**Option A — SendGrid:**
```env
SENDGRID_API_KEY=SG.xxx
EMAIL_FROM_ADDRESS=noreply@yourdomain.com
```

**Option B — Custom SMTP:**
```env
SMTP_HOST=smtp.mailgun.org
SMTP_PORT=587
SMTP_USER=postmaster@mg.yourdomain.com
SMTP_PASS=xxx
```

**Option C — Development (Ethereal):**
Leave both blank. Preview URLs will be logged to console.

### 6. Run

```bash
# Development
cd backend && npm run dev
cd frontend && npm run dev

# Production
cd backend && npm start
cd frontend && npm run build  # then serve /dist
```

---

## API Reference

### Auth Endpoints

| Method | Path                           | Auth     | Description                       |
|--------|--------------------------------|----------|-----------------------------------|
| GET    | /api/auth/csrf-token           | None     | Get CSRF token (call before POST) |
| POST   | /api/auth/register             | CSRF     | Create account + send verify email|
| POST   | /api/auth/login                | CSRF     | Login → access + refresh tokens   |
| POST   | /api/auth/refresh              | CSRF+Cookie | Rotate tokens                  |
| POST   | /api/auth/logout               | CSRF     | Revoke refresh token              |
| GET    | /api/auth/me                   | Bearer   | Get current user                  |
| POST   | /api/auth/verify-email         | CSRF     | Consume email verification token  |
| POST   | /api/auth/resend-verification  | Bearer   | Resend verification email         |
| POST   | /api/auth/forgot-password      | CSRF     | Request password reset email      |
| POST   | /api/auth/reset-password       | CSRF     | Consume reset token + set password|

### Billing Endpoints

| Method | Path                   | Auth       | Description                    |
|--------|------------------------|------------|--------------------------------|
| POST   | /api/billing/checkout  | Bearer     | Create Stripe Checkout session |
| POST   | /api/billing/portal    | Bearer     | Create Stripe Portal session   |
| GET    | /api/billing/status    | Bearer     | Current subscription status    |

### Admin Endpoints (admin role only)

| Method | Path                        | Auth          | Description                |
|--------|-----------------------------|---------------|----------------------------|
| GET    | /api/admin/users            | Bearer+Admin  | List all users (paginated) |
| GET    | /api/admin/users/:id        | Bearer+Admin  | Single user + subscriptions|
| PATCH  | /api/admin/users/:id/role   | Bearer+Admin  | Set role (free/pro/admin)  |
| GET    | /api/admin/subscriptions    | Bearer+Admin  | All subscriptions          |
| GET    | /api/admin/stats            | Bearer+Admin  | Aggregate counts           |

---

## Token Flow

```
Register/Login:
  POST /api/auth/register  →  { accessToken, user }  +  pp-rt cookie (HttpOnly)

Authenticated requests:
  GET /api/auth/me
  Authorization: Bearer <accessToken>

Token refresh (auto, every ~14 min via frontend):
  POST /api/auth/refresh   →  { accessToken }  +  new pp-rt cookie
  (pp-rt cookie sent automatically; X-CSRF-Token required)

Logout:
  POST /api/auth/logout  →  pp-rt cookie cleared, token revoked in DB
```

Access tokens: 15 min TTL, JWT HS256.
Refresh tokens: 7 day TTL, opaque UUID (SHA-256 stored in DB).

---

## Subscription Lifecycle

```
User clicks "Upgrade" → POST /api/billing/checkout { priceId }
  → Stripe Checkout Session created
  → Frontend redirects to session.url

User completes checkout
  → Stripe fires: checkout.session.completed
  → Stripe fires: customer.subscription.created (status: trialing or active)
  → Webhook: syncSubscription() mirrors state to DB
  → Webhook: users.role updated to 'pro'
  → Confirmation email sent

Monthly renewal
  → Stripe fires: invoice.payment_succeeded
  → Stripe fires: customer.subscription.updated
  → Webhook: syncs new current_period_end

Payment failure
  → Stripe fires: invoice.payment_failed
  → Stripe fires: customer.subscription.updated (status: past_due)
  → Webhook: users.role downgraded to 'free'

Cancellation
  → User opens Billing Portal via POST /api/billing/portal
  → Sets cancel_at_period_end = true  OR  immediate cancellation
  → Stripe fires: customer.subscription.deleted
  → Webhook: users.role → 'free'
  → Cancellation email sent
```

---

## Security Features

| Feature                    | Implementation                                |
|----------------------------|-----------------------------------------------|
| Password hashing           | argon2id (memory: 64MB, time: 3, par: 4)      |
| JWT signing                | HS256 with secret rotation + overlap window   |
| Refresh token storage      | SHA-256(token) only — raw never persisted     |
| Refresh token replay       | Detection → revoke all sessions automatically |
| CSRF protection            | Double-submit HMAC cookie pattern             |
| Email storage              | AES-256-GCM field encryption (PII at rest)    |
| Email lookups              | HMAC-SHA256 lookup keys (deterministic)       |
| Email verification tokens  | SHA-256 stored, 24h TTL, single-use           |
| Password reset tokens      | SHA-256 stored, 1h TTL, single-use            |
| Stripe webhook auth        | Signature verification (HMAC-SHA256)          |
| Webhook idempotency        | Event IDs stored + checked before processing  |
| Rate limiting              | 5 tiers + exponential backoff + auto-blacklist|
| Account lockout            | 5 attempts → 15min, keyed on HMAC(email)      |
| Input validation           | 4-layer: guard → Zod.strict() → sanitize → parameterized SQL |
| CSP                        | no unsafe-inline, no unsafe-eval              |
| DB security                | Two-role model, SSL enforced, pool timeout    |

---

## Deploying to Production

### Railway

```bash
# Set all env vars in Railway dashboard, then:
railway up
```

Set `DATABASE_URL` from the private network address (not public TCP).

### Environment checklist

- [ ] `NODE_ENV=production`
- [ ] `HTTPS_REDIRECT=true`
- [ ] `HSTS_MAX_AGE=31536000`
- [ ] `TRUST_PROXY=1` (or your proxy count)
- [ ] `ALLOWED_ORIGINS` set to production domain(s) only
- [ ] `DATABASE_URL` using private network address
- [ ] `DB_SSL=true`
- [ ] `DB_SSL_CA` set to CA certificate path (recommended)
- [ ] All `REPLACE_WITH_*` values replaced with real secrets
- [ ] `STRIPE_SECRET_KEY` using `sk_live_` key
- [ ] `STRIPE_WEBHOOK_SECRET` from live webhook endpoint
- [ ] Stripe webhook events registered for live endpoint
- [ ] Email transport configured (SendGrid or SMTP)
- [ ] `APP_URL` set to production URL (used in email links)
- [ ] `HEALTH_SECRET` set (protects ops endpoints)

---

## Running Tests

```bash
cd backend
npm test
```

The test suite covers 30+ scenarios across:
- JWT issue/verify/expiry
- Argon2id credential verification
- requireRole middleware (all role combinations)
- Subscription status → role mapping
- Email verification token lifecycle (issue/verify/replay/expiry)
- Password reset token lifecycle
- HTTP auth endpoint integration (register/login/logout/me/forgot/reset/verify)
- Role-gated route enforcement (bug reports, billing, admin)
- Stripe config guards
- Webhook idempotency

All tests run without a live database or Stripe account (in-memory fallbacks).

---

## Making a User Admin

```sql
-- Direct DB (run as patchticker_owner)
UPDATE users
SET role = 'admin', updated_at = now()
WHERE email_hmac = encode(
  hmac(lower(trim('admin@yourdomain.com')), decode('<DB_ENCRYPTION_KEY>', 'hex'), 'sha256'),
  'hex'
);
```

Or via admin API (requires an existing admin user):
```bash
curl -X PATCH https://yourdomain.com/api/admin/users/<uuid>/role \
  -H "Authorization: Bearer <admin-access-token>" \
  -H "X-CSRF-Token: <csrf>" \
  -H "Content-Type: application/json" \
  -d '{"role":"admin"}'
```

The first admin must be set via SQL. All subsequent admin promotions can use the API.

# PatchTicker deployment handoff

## Repository

Use GitHub repo name: `patchticker`.

Important: this project folder lives under a parent Git repo at `/Users/andrew`. Push only the PatchTicker project folder, not the parent home-directory repo.

## Supabase

Create a new Supabase project named `patchticker`.
Run:

```sql
supabase/migrations/202607160001_initial_patchticker_schema.sql
```

The schema includes custom auth, refresh tokens, lockouts, subscriptions, ratings, bug reports, watchlists, scraper update storage, and AI analysis logs.

## Required service/API keys

Backend production secrets live in `backend/.env` and should never be committed.

Minimum required for launch:

```env
NODE_ENV=production
PORT=4000
BIND_HOST=127.0.0.1
TRUST_PROXY=1
ALLOWED_ORIGINS=https://patchticker.app
APP_URL=https://patchticker.app
DATABASE_URL=...
DB_SSL=true
JWT_ACCESS_SECRET=...
JWT_REFRESH_SECRET=...
CSRF_SECRET=...
DB_ENCRYPTION_KEY=...
HEALTH_SECRET=...
STRIPE_SECRET_KEY=...
STRIPE_WEBHOOK_SECRET=...
STRIPE_PUBLISHABLE_KEY=...
STRIPE_PRICE_PRO_MONTHLY=...
STRIPE_PRICE_PRO_ANNUAL=...
EMAIL_FROM_ADDRESS=...
HCAPTCHA_SECRET_KEY=...
HCAPTCHA_SITE_KEY=...
ANTHROPIC_API_KEY=...
STEAM_TRACKED_APP_IDS=730,553850,108694,1172470,570,252490,271590,1245620
DISCORD_STATUS_RSS_URL=https://discordstatus.com/history.rss
BATTLENET_TRACKING_ENABLED=true
GOG_TRACKING_ENABLED=true
```

Optional but recommended:

```env
SENDGRID_API_KEY=...
REDDIT_CLIENT_ID=...
REDDIT_CLIENT_SECRET=...
REDDIT_USER_AGENT=PatchTicker/1.0 by DornVentures
CLOUDFLARE_MODE=true
```

## Auth

PatchTicker uses custom JWT auth with argon2id password hashes and encrypted emails. Supabase Auth is not currently wired into the frontend/backend.

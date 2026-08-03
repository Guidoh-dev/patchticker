# PatchTicker public launch runbook

This repo is now ready for a standard VPS launch behind Cloudflare + Nginx.
Do **not** commit `.env` files or production secrets.

## 1. Server baseline

```bash
sudo adduser --system --group --home /opt/patchticker patchticker
sudo mkdir -p /opt/patchticker
sudo chown -R patchticker:patchticker /opt/patchticker
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx git
# Install Node.js 22+ from NodeSource, nvm, or your preferred package source.
```

Clone the repo as the `patchticker` user:

```bash
sudo -u patchticker git clone https://github.com/Guidoh-dev/patchticker.git /opt/patchticker
cd /opt/patchticker
npm ci --workspaces
```

## 2. Environment files

Create production env files on the server only:

```bash
sudo -u patchticker cp /opt/patchticker/backend/.env.example /opt/patchticker/backend/.env
sudo -u patchticker cp /opt/patchticker/frontend/.env.example /opt/patchticker/frontend/.env
```

Backend production minimum:

```env
NODE_ENV=production
PORT=4000
BIND_HOST=127.0.0.1
TRUST_PROXY=1
CLOUDFLARE_MODE=true
CLOUDFLARE_VALIDATE_IPS=false
HTTPS_REDIRECT=true
ALLOWED_ORIGINS=https://patchticker.app,https://www.patchticker.app
APP_URL=https://patchticker.app

DATABASE_URL=postgresql://postgres.PROJECT_REF:POOLER_PASSWORD@aws-0-us-east-1.pooler.supabase.com:6543/postgres
DB_SSL=true

JWT_ACCESS_SECRET=64_plus_bytes_random_hex
JWT_REFRESH_SECRET=64_plus_bytes_random_hex_different
CSRF_SECRET=32_plus_bytes_random_hex
DB_ENCRYPTION_KEY=64_hex_chars_exactly
HEALTH_SECRET=random_ops_secret

STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_PRICE_PRO_MONTHLY=price_...
STRIPE_PRICE_PRO_ANNUAL=price_...
STRIPE_TRIAL_DAYS=5

HCAPTCHA_SECRET_KEY=...
HCAPTCHA_SITE_KEY=...
HCAPTCHA_ENABLED=true

EMAIL_FROM_NAME=PatchTicker
EMAIL_FROM_ADDRESS=noreply@patchticker.app
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_brevo_smtp_login
SMTP_PASS=your_brevo_smtp_key

ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-20250514
```

Frontend production minimum:

```env
VITE_APP_URL=https://patchticker.app
VITE_STRIPE_PUBLISHABLE_KEY=pk_live_...
VITE_STRIPE_PRICE_MONTHLY=price_...
VITE_STRIPE_PRICE_ANNUAL=price_...
VITE_HCAPTCHA_SITE_KEY=...
```

## 3. Supabase

Run these migrations in order:

```bash
supabase/migrations/202607160001_initial_patchticker_schema.sql
supabase/migrations/202607200001_email_delivery_log.sql
```

Use the Supabase transaction pooler on port `6543`; direct `db.<ref>.supabase.co:5432` has already caused local DNS failures.

## 4. Nginx + systemd

```bash
sudo cp /opt/patchticker/deploy/systemd/patchticker-api.service /etc/systemd/system/patchticker-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now patchticker-api

sudo cp /opt/patchticker/deploy/nginx/patchticker.conf /etc/nginx/sites-available/patchticker.conf
sudo ln -sf /etc/nginx/sites-available/patchticker.conf /etc/nginx/sites-enabled/patchticker.conf
sudo nginx -t
```

First issue the cert, then reload Nginx:

```bash
sudo certbot --nginx -d patchticker.app -d www.patchticker.app
sudo systemctl reload nginx
```

## 5. DNS and third-party dashboards

- Cloudflare DNS: `A patchticker.app -> VPS_IP`, `A www -> VPS_IP` or CNAME `www -> patchticker.app`.
- Stripe webhook endpoint: `https://patchticker.app/api/webhooks/stripe`.
- Stripe webhook events: checkout/session completed, subscription updated/deleted, invoice payment succeeded/failed.
- hCaptcha allowed domains: `patchticker.app`, `www.patchticker.app`.
- Brevo: authenticate `patchticker.app` sender/domain and use SMTP credentials in backend `.env`.

## 6. Verification commands

Run from `/opt/patchticker`:

```bash
npm run build
npm test
npm run audit
npm run check:launch:strict
curl -fsS https://patchticker.app/api/health
curl -fsS https://patchticker.app/api/updates | head
```

For deploys after launch:

```bash
APP_DIR=/opt/patchticker BRANCH=main /opt/patchticker/deploy/scripts/deploy.sh
```

## Current non-code blockers

The repo can be made production-ready, but the site cannot be fully public on `patchticker.app` until these external items are done:

1. A public server/VPS is available and reachable.
2. Cloudflare DNS points `patchticker.app` and `www.patchticker.app` to that server.
3. Production secrets are placed in the server `.env` files.
4. Certbot SSL has been issued on the server.
5. Stripe, hCaptcha, Brevo, and Supabase production settings match the live domain.

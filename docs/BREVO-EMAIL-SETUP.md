# PatchTicker Brevo Email Setup

PatchTicker uses Brevo SMTP for production transactional email on the free tier.

## What Brevo sends

- Email verification
- Password reset links
- Patch/watchlist alerts
- Subscription/payment notices
- Admin test emails

## Brevo dashboard steps

1. Open Brevo → **SMTP & API**.
2. Open the **SMTP** tab.
3. Copy the **SMTP login** into `BREVO_SMTP_LOGIN`.
4. Generate/copy an **SMTP key** into `BREVO_SMTP_KEY`.
   - Do not use your Brevo account password.
5. Verify `patchticker.app` or `noreply@patchticker.app` in Brevo.
6. Add Brevo SPF/DKIM DNS records in Cloudflare.
7. Restart the backend.
8. In PatchTicker Admin → Pipeline, send a test email.

## Required backend env

```env
EMAIL_FROM_NAME=PatchTicker
EMAIL_FROM_ADDRESS=noreply@patchticker.app

BREVO_SMTP_LOGIN=your_brevo_smtp_login
BREVO_SMTP_KEY=your_brevo_smtp_key
BREVO_SMTP_PORT=587
```

## Optional generic SMTP fallback

Only use this if you switch away from Brevo:

```env
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
```

## Supabase logging

Email attempts are logged to `email_delivery_log` without storing plain recipient emails. The table stores:

- `recipient_hash`
- `subject`
- `category`
- `provider`
- `status`
- `message_id`
- `error_msg`
- `created_at`

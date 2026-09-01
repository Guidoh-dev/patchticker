# PatchTicker Supabase setup

Create a new Supabase project named `patchticker`, then run the migrations in order.

## Option A: Supabase CLI

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

## Option B: Supabase SQL editor

Open the SQL editor and run these files in order:

```sql
-- 1. supabase/migrations/202607160001_initial_patchticker_schema.sql
-- 2. supabase/migrations/202607200001_email_delivery_log.sql
-- 3. supabase/migrations/202608040001_launch_schema_repair.sql
-- 4. supabase/migrations/20260815152854_steam_games_and_email_quota.sql
-- 5. supabase/migrations/20260901232532_enable_rls_for_public_tables.sql
```

The final migration enables RLS on every PatchTicker table, revokes direct
Data API access from `anon` and `authenticated`, and keeps database access
limited to the backend `patchticker_app` role (plus database-owner operations).

## Required backend `.env` values

Use the Supabase transaction pooler on port `6543`. Do not use the direct `db.<project-ref>.supabase.co:5432` host for local review if DNS does not resolve:

```env
DATABASE_URL=postgresql://postgres.YOUR_PROJECT_REF:YOUR_POOLER_PASSWORD@aws-0-us-east-1.pooler.supabase.com:6543/postgres
DB_SSL=true
```

PatchTicker currently uses custom JWT authentication. Supabase is used as the PostgreSQL host, not Supabase Auth.

## Environment/branch recommendation

Use three deployment environments:

- `production` — live PatchTicker app
- `staging` — production-like deploy rehearsal
- `development` — scraper/auth/billing testing

If Supabase database branching is unavailable on the selected plan, use separate Supabase projects for staging/development.

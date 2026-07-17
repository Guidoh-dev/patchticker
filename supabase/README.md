# PatchTicker Supabase setup

Create a new Supabase project named `patchticker`, then run the schema migration.

## Option A: Supabase CLI

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

## Option B: Supabase SQL editor

Open the SQL editor and run:

```sql
-- supabase/migrations/202607160001_initial_patchticker_schema.sql
```

## Required backend `.env` values

Use the Supabase transaction pooler on port `6543`:

```env
DATABASE_URL=postgresql://postgres.YOUR_PROJECT_REF:YOUR_POOLER_PASSWORD@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require
DB_SSL=true
```

PatchTicker currently uses custom JWT authentication. Supabase is used as the PostgreSQL host, not Supabase Auth.

## Environment/branch recommendation

Use three deployment environments:

- `production` — live PatchTicker app
- `staging` — production-like deploy rehearsal
- `development` — scraper/auth/billing testing

If Supabase database branching is unavailable on the selected plan, use separate Supabase projects for staging/development.

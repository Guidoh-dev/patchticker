-- schema-saas.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- PatchTicker — SaaS Schema Additions
--
-- HOW TO APPLY
-- ─────────────
--   psql "$DATABASE_URL" -f schema.sql       # base schema first
--   psql "$DATABASE_URL" -f schema-saas.sql  # SaaS additions
--
-- WHAT THIS ADDS
-- ──────────────
--   1. roles column on users (free | pro | admin)
--   2. email_verified + email_verified_at on users
--   3. email_verification_tokens table
--   4. password_reset_tokens table
--   5. subscriptions table (Stripe-backed)
--   6. subscription_events table (webhook audit log)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Extend users table ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    CREATE TYPE user_role AS ENUM ('free', 'pro', 'admin');
  END IF;
END $$;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role              user_role   NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS email_verified    BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

COMMENT ON COLUMN users.role              IS 'Access tier: free | pro | admin.';
COMMENT ON COLUMN users.email_verified    IS 'True after clicking verification link.';
COMMENT ON COLUMN users.email_verified_at IS 'Timestamp when email was first verified.';

GRANT UPDATE (role, email_verified, email_verified_at, updated_at) ON users TO patchticker_app;
CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);

-- ── Email verification tokens ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  token_hash   CHAR(64)    PRIMARY KEY,
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ
);

COMMENT ON TABLE email_verification_tokens IS 'One-time email verification tokens. Raw token never stored.';
CREATE INDEX IF NOT EXISTS idx_evtokens_user_id    ON email_verification_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_evtokens_expires_at ON email_verification_tokens (expires_at);
GRANT SELECT, INSERT, UPDATE ON email_verification_tokens TO patchticker_app;

-- ── Password reset tokens ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash   CHAR(64)    PRIMARY KEY,
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ
);

COMMENT ON TABLE password_reset_tokens IS 'One-time password reset tokens. Raw token never stored.';
CREATE INDEX IF NOT EXISTS idx_prtokens_user_id    ON password_reset_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_prtokens_expires_at ON password_reset_tokens (expires_at);
GRANT SELECT, INSERT, UPDATE ON password_reset_tokens TO patchticker_app;

-- ── Subscriptions ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subscription_status') THEN
    CREATE TYPE subscription_status AS ENUM (
      'trialing','active','past_due','canceled',
      'unpaid','incomplete','incomplete_expired','paused'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS subscriptions (
  id                     BIGSERIAL           PRIMARY KEY,
  user_id                UUID                NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id     TEXT                NOT NULL,
  stripe_subscription_id TEXT                UNIQUE,
  stripe_price_id        TEXT,
  status                 subscription_status NOT NULL DEFAULT 'incomplete',
  current_period_start   TIMESTAMPTZ,
  current_period_end     TIMESTAMPTZ,
  cancel_at_period_end   BOOLEAN             NOT NULL DEFAULT FALSE,
  canceled_at            TIMESTAMPTZ,
  trial_end              TIMESTAMPTZ,
  created_at             TIMESTAMPTZ         NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ         NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id            ON subscriptions (user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer_id ON subscriptions (stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status             ON subscriptions (status);

GRANT SELECT, INSERT, UPDATE ON subscriptions TO patchticker_app;
GRANT USAGE ON SEQUENCE subscriptions_id_seq TO patchticker_app;

DROP TRIGGER IF EXISTS set_updated_at_subscriptions ON subscriptions;
CREATE TRIGGER set_updated_at_subscriptions
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ── Subscription events (webhook audit log) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS subscription_events (
  id              BIGSERIAL   PRIMARY KEY,
  stripe_event_id TEXT        NOT NULL UNIQUE,
  event_type      TEXT        NOT NULL,
  user_id         UUID        REFERENCES users(id) ON DELETE SET NULL,
  payload_json    TEXT        NOT NULL,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sub_events_user_id    ON subscription_events (user_id);
CREATE INDEX IF NOT EXISTS idx_sub_events_event_type ON subscription_events (event_type);
CREATE INDEX IF NOT EXISTS idx_sub_events_processed  ON subscription_events (processed_at DESC);

GRANT SELECT, INSERT ON subscription_events TO patchticker_app;
GRANT USAGE ON SEQUENCE subscription_events_id_seq TO patchticker_app;

-- ── Cleanup function ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION cleanup_expired_auth_tokens()
RETURNS INTEGER AS $$
DECLARE deleted INTEGER := 0; tmp INTEGER;
BEGIN
  DELETE FROM email_verification_tokens WHERE expires_at < now() AND used_at IS NULL;
  GET DIAGNOSTICS tmp = ROW_COUNT; deleted := deleted + tmp;
  DELETE FROM password_reset_tokens WHERE expires_at < now() AND used_at IS NULL;
  GET DIAGNOSTICS tmp = ROW_COUNT; deleted := deleted + tmp;
  RETURN deleted;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION cleanup_expired_auth_tokens() TO patchticker_app;

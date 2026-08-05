-- PatchTicker launch schema repair
-- Keeps existing data and only adds columns/indexes needed by current app flows.

ALTER TABLE bug_reports
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_bug_reports_user_id ON bug_reports (user_id);

ALTER TABLE email_verification_tokens
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE password_reset_tokens
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE platform_watchlist
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE user_webhooks
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Some early schemas used processed_at only; keep payload_json as the canonical
-- event payload column because subscriptionService writes to it.
ALTER TABLE subscription_events
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'patchticker_app') THEN
    GRANT SELECT, INSERT ON bug_reports TO patchticker_app;
    GRANT SELECT, INSERT, UPDATE ON email_verification_tokens TO patchticker_app;
    GRANT SELECT, INSERT, UPDATE ON password_reset_tokens TO patchticker_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON platform_watchlist TO patchticker_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON user_webhooks TO patchticker_app;
    GRANT SELECT, INSERT ON subscription_events TO patchticker_app;
  END IF;
END $$;

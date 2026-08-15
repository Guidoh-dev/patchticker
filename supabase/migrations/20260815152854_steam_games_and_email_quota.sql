-- Material Steam-game update metadata plus a durable Brevo free-tier guard.
-- Additive/idempotent migration: no existing PatchTicker data is removed.

ALTER TABLE software_updates
  ADD COLUMN IF NOT EXISTS display_version VARCHAR(64),
  ADD COLUMN IF NOT EXISTS source_kind VARCHAR(32),
  ADD COLUMN IF NOT EXISTS source_ref VARCHAR(128),
  ADD COLUMN IF NOT EXISTS product_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS release_size_bytes BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'software_updates_release_size_bytes_check'
      AND conrelid = 'software_updates'::regclass
  ) THEN
    ALTER TABLE software_updates
      ADD CONSTRAINT software_updates_release_size_bytes_check
      CHECK (release_size_bytes IS NULL OR release_size_bytes >= 0);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_updates_source_ref
  ON software_updates (source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_updates_product_id
  ON software_updates (product_id) WHERE product_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS email_daily_usage (
  usage_date     DATE         NOT NULL,
  quota_scope    VARCHAR(16)  NOT NULL CHECK (quota_scope IN ('global','alerts')),
  attempt_count  INTEGER      NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (usage_date, quota_scope)
);
ALTER TABLE email_daily_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON email_daily_usage FROM PUBLIC;

CREATE OR REPLACE FUNCTION reserve_patchticker_email_quota(
  p_category TEXT,
  p_global_limit INTEGER DEFAULT 300,
  p_alert_limit INTEGER DEFAULT 250
)
RETURNS TABLE (allowed BOOLEAN, global_used INTEGER, alert_used INTEGER)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_day DATE := (now() AT TIME ZONE 'UTC')::date;
  v_global_limit INTEGER := LEAST(300, GREATEST(0, COALESCE(p_global_limit, 300)));
  v_alert_limit INTEGER;
  v_global_used INTEGER := 0;
  v_alert_used INTEGER := 0;
  v_is_alert BOOLEAN := COALESCE(p_category, '') = 'patch_alert';
BEGIN
  v_alert_limit := LEAST(
    GREATEST(0, v_global_limit - 50),
    GREATEST(0, COALESCE(p_alert_limit, 250))
  );

  PERFORM pg_advisory_xact_lock(19045, 300);

  SELECT
    COALESCE(MAX(attempt_count) FILTER (WHERE quota_scope = 'global'), 0),
    COALESCE(MAX(attempt_count) FILTER (WHERE quota_scope = 'alerts'), 0)
  INTO v_global_used, v_alert_used
  FROM email_daily_usage
  WHERE usage_date = v_day;

  IF v_global_used >= v_global_limit OR (v_is_alert AND v_alert_used >= v_alert_limit) THEN
    RETURN QUERY SELECT FALSE, v_global_used, v_alert_used;
    RETURN;
  END IF;

  INSERT INTO email_daily_usage (usage_date, quota_scope, attempt_count, updated_at)
  VALUES (v_day, 'global', 1, now())
  ON CONFLICT (usage_date, quota_scope)
  DO UPDATE SET attempt_count = email_daily_usage.attempt_count + 1, updated_at = now();
  v_global_used := v_global_used + 1;

  IF v_is_alert THEN
    INSERT INTO email_daily_usage (usage_date, quota_scope, attempt_count, updated_at)
    VALUES (v_day, 'alerts', 1, now())
    ON CONFLICT (usage_date, quota_scope)
    DO UPDATE SET attempt_count = email_daily_usage.attempt_count + 1, updated_at = now();
    v_alert_used := v_alert_used + 1;
  END IF;

  RETURN QUERY SELECT TRUE, v_global_used, v_alert_used;
END;
$$;

REVOKE EXECUTE ON FUNCTION reserve_patchticker_email_quota(TEXT, INTEGER, INTEGER) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'patchticker_app') THEN
    GRANT SELECT, INSERT, UPDATE ON software_updates TO patchticker_app;
    GRANT SELECT, INSERT, UPDATE ON email_daily_usage TO patchticker_app;
    GRANT EXECUTE ON FUNCTION reserve_patchticker_email_quota(TEXT, INTEGER, INTEGER) TO patchticker_app;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'email_daily_usage'
        AND policyname = 'email_daily_usage_app_only'
    ) THEN
      EXECUTE 'CREATE POLICY email_daily_usage_app_only ON email_daily_usage FOR ALL TO patchticker_app USING (true) WITH CHECK (true)';
    END IF;
  END IF;
END $$;

-- ── Email delivery log (transactional email audit, no plain recipient storage) ──
CREATE TABLE IF NOT EXISTS email_delivery_log (
  id              BIGSERIAL PRIMARY KEY,
  recipient_hash  CHAR(64)      NOT NULL,
  subject         VARCHAR(200)  NOT NULL,
  category        VARCHAR(40)   NOT NULL,
  provider        VARCHAR(32)   NOT NULL,
  status          VARCHAR(16)   NOT NULL CHECK (status IN ('sent','failed')),
  message_id      TEXT,
  error_msg       TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_delivery_created ON email_delivery_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_delivery_status  ON email_delivery_log (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_delivery_hash    ON email_delivery_log (recipient_hash);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'patchticker_app') THEN
    GRANT SELECT, INSERT ON email_delivery_log TO patchticker_app;
    GRANT USAGE ON SEQUENCE email_delivery_log_id_seq TO patchticker_app;
  END IF;
END $$;

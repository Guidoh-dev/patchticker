-- PatchTicker uses custom JWT authentication and accesses Postgres only from
-- the Express backend. Browser clients must never access these tables through
-- Supabase's Data API. RLS therefore permits the least-privileged application
-- role while denying anon/authenticated roles by default.

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
  FROM PUBLIC, anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, anon, authenticated;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_lockouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bug_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_verification_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_watchlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.update_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.software_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_analysis_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_delivery_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_daily_usage ENABLE ROW LEVEL SECURITY;

-- Policies do not grant SQL privileges. Existing per-table GRANT statements
-- remain the authority for which operations patchticker_app may perform.
DROP POLICY IF EXISTS users_app_only ON public.users;
CREATE POLICY users_app_only ON public.users
  FOR ALL TO patchticker_app USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS refresh_tokens_app_only ON public.refresh_tokens;
CREATE POLICY refresh_tokens_app_only ON public.refresh_tokens
  FOR ALL TO patchticker_app USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS account_lockouts_app_only ON public.account_lockouts;
CREATE POLICY account_lockouts_app_only ON public.account_lockouts
  FOR ALL TO patchticker_app USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS bug_reports_app_only ON public.bug_reports;
CREATE POLICY bug_reports_app_only ON public.bug_reports
  FOR ALL TO patchticker_app USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS email_verification_tokens_app_only ON public.email_verification_tokens;
CREATE POLICY email_verification_tokens_app_only ON public.email_verification_tokens
  FOR ALL TO patchticker_app USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS password_reset_tokens_app_only ON public.password_reset_tokens;
CREATE POLICY password_reset_tokens_app_only ON public.password_reset_tokens
  FOR ALL TO patchticker_app USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS subscriptions_app_only ON public.subscriptions;
CREATE POLICY subscriptions_app_only ON public.subscriptions
  FOR ALL TO patchticker_app USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS subscription_events_app_only ON public.subscription_events;
CREATE POLICY subscription_events_app_only ON public.subscription_events
  FOR ALL TO patchticker_app USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS community_posts_app_only ON public.community_posts;
CREATE POLICY community_posts_app_only ON public.community_posts
  FOR ALL TO patchticker_app USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS platform_watchlist_app_only ON public.platform_watchlist;
CREATE POLICY platform_watchlist_app_only ON public.platform_watchlist
  FOR ALL TO patchticker_app USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS user_webhooks_app_only ON public.user_webhooks;
CREATE POLICY user_webhooks_app_only ON public.user_webhooks
  FOR ALL TO patchticker_app USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS update_ratings_app_only ON public.update_ratings;
CREATE POLICY update_ratings_app_only ON public.update_ratings
  FOR ALL TO patchticker_app USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS software_updates_app_only ON public.software_updates;
CREATE POLICY software_updates_app_only ON public.software_updates
  FOR ALL TO patchticker_app USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS ai_analysis_log_app_only ON public.ai_analysis_log;
CREATE POLICY ai_analysis_log_app_only ON public.ai_analysis_log
  FOR ALL TO patchticker_app USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS email_delivery_log_app_only ON public.email_delivery_log;
CREATE POLICY email_delivery_log_app_only ON public.email_delivery_log
  FOR ALL TO patchticker_app USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS email_daily_usage_app_only ON public.email_daily_usage;
CREATE POLICY email_daily_usage_app_only ON public.email_daily_usage
  FOR ALL TO patchticker_app USING (true) WITH CHECK (true);

-- Pin function resolution to trusted schemas and remove the implicit PUBLIC
-- execute grant. The backend's explicit EXECUTE grants remain unchanged.
ALTER FUNCTION public.trigger_set_updated_at() SET search_path = pg_catalog, public;
ALTER FUNCTION public.cleanup_expired_tokens() SET search_path = pg_catalog, public;
ALTER FUNCTION public.cleanup_stale_lockouts(INTEGER) SET search_path = pg_catalog, public;
ALTER FUNCTION public.cleanup_expired_auth_tokens() SET search_path = pg_catalog, public;

REVOKE EXECUTE ON FUNCTION public.trigger_set_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_tokens() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_stale_lockouts(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_auth_tokens() FROM PUBLIC, anon, authenticated;

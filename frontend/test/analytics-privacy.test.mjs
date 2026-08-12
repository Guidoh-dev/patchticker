import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const analytics = await readFile(resolve(root, 'src/analytics.js'), 'utf8');
const main = await readFile(resolve(root, 'src/main.js'), 'utf8');
const router = await readFile(resolve(root, 'src/router.js'), 'utf8');

test('analytics vendors require an explicit granted consent state', () => {
  assert.match(analytics, /readConsent\(\) !== 'granted'/);
  assert.match(analytics, /else if \(readConsent\(\) === null\) renderConsentPanel/);
  assert.match(analytics, /analytics_Storage: 'granted'/);
  assert.match(analytics, /ad_Storage: 'denied'/);
});

test('session replay and automatic PostHog capture are disabled at the SDK boundary', () => {
  assert.match(analytics, /autocapture: false/);
  assert.match(analytics, /capture_pageview: false/);
  assert.match(analytics, /disable_session_recording: true/);
  assert.match(analytics, /disable_external_dependency_loading: true/);
});

test('sensitive fields and free text receive both vendor mask directives', () => {
  for (const selector of ['input', 'textarea', 'form', 'email', 'search', 'token', 'webhook']) {
    assert.match(analytics, new RegExp(selector));
  }
  assert.match(analytics, /data-clarity-mask/);
  assert.match(analytics, /data-ph-no-capture/);
  assert.match(main, /applyAnalyticsPrivacyMasks\(app\)/);
});

test('application events use an allowlist and never expose raw preference content', () => {
  assert.match(analytics, /SAFE_PROPERTY_KEYS/);
  assert.match(analytics, /BLOCKED_VENDOR_PROPERTY/);
  assert.match(analytics, /query_length/);
  assert.doesNotMatch(main, /captureAnalytics\([^\n]+\{[^}]*\b(?:email|search|query|token|webhook_url|watchlist)\s*:/s);
  assert.match(main, /watchlist_type: 'platform'/);
  assert.match(main, /item_count:/);
});

test('routes are normalized before analytics receives them', () => {
  assert.match(analytics, /return '\/updates\/:id'/);
  assert.match(analytics, /return '\/platform\/:name'/);
  assert.match(router, /new CustomEvent\('app:route'/);
});

test('signed-in analytics identity is the internal user id without profile PII', () => {
  assert.match(analytics, /currentUserId = user\?\.id \? String\(user\.id\) : null/);
  assert.match(analytics, /posthog\.identify\(currentUserId\)/);
  assert.doesNotMatch(analytics, /posthog\.identify\([^\n]*(?:email|name)/i);
});

test('privacy policy names analytics vendors, safeguards, and retention windows', () => {
  assert.match(main, /<strong>PostHog<\/strong>/);
  assert.match(main, /<strong>Microsoft Clarity<\/strong>/);
  assert.match(main, /raw search text, watchlist contents, notification tokens/);
  assert.match(main, /retained for up to 12 months/);
  assert.match(main, /session playback is retained for 30 days/);
  assert.match(main, /Privacy choices/);
});

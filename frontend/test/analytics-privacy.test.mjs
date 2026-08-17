import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const analytics = await readFile(resolve(root, 'src/analytics.js'), 'utf8');
const main = await readFile(resolve(root, 'src/main.js'), 'utf8');
const router = await readFile(resolve(root, 'src/router.js'), 'utf8');
const viteConfig = await readFile(resolve(root, 'vite.config.js'), 'utf8');

test('analytics vendors require an explicit granted consent state', () => {
  assert.match(analytics, /readConsent\(\) !== 'granted'/);
  assert.match(analytics, /else if \(readConsent\(\) === null\) renderConsentPanel/);
  assert.match(analytics, /analytics_Storage: 'granted'/);
  assert.match(analytics, /ad_Storage: 'denied'/);
});

test('PostHog billing requires a separate explicit production opt-in', () => {
  assert.match(analytics, /VITE_POSTHOG_ENABLED === 'true'/);
  assert.match(analytics, /POSTHOG_PROJECT_KEY_VALID = POSTHOG_KEY\.startsWith\('phc_'\)/);
  assert.match(analytics, /!POSTHOG_ENABLED \|\| !POSTHOG_PROJECT_KEY_VALID/);
});

test('frontend builds reject PostHog personal and project-secret API keys', () => {
  assert.match(viteConfig, /function assertPublicPostHogKey\(env\)/);
  assert.match(viteConfig, /key && !key\.startsWith\('phc_'\)/);
  assert.match(viteConfig, /Personal and project-secret API keys must remain in the backend environment/);
  assert.match(viteConfig, /assertPublicPostHogKey\(env\)/);
});

test('session replay and automatic PostHog capture are disabled at the SDK boundary', () => {
  assert.match(analytics, /autocapture: false/);
  assert.match(analytics, /capture_pageview: false/);
  assert.match(analytics, /disable_session_recording: true/);
  assert.match(analytics, /disable_external_dependency_loading: true/);
});

test('the privacy scrubber preserves only PostHog transport data required for ingestion', () => {
  assert.match(analytics, /if \(key === 'token'\)/);
  assert.match(analytics, /if \(value === POSTHOG_KEY\) properties\.token = POSTHOG_KEY/);
  assert.match(analytics, /POSTHOG_INTERNAL_EVENTS = new Set\(\['\$identify', '\$pageview', '\$pageleave'\]\)/);
});

test('SPA page views use normalized routes without enabling invasive autocapture', () => {
  assert.match(analytics, /captureWebEvent\('\$pageview', nextRoute\)/);
  assert.match(analytics, /captureWebEvent\('\$pageleave', activeRoute/);
  assert.match(analytics, /\$current_url: canonicalRouteUrl\(normalizedRoute\)/);
  assert.match(analytics, /\$pathname: normalizedRoute/);
  assert.match(analytics, /autocapture: false/);
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

test('every emitted application event survives the privacy allowlist', () => {
  const emittedEvents = [...main.matchAll(/captureAnalytics\('([a-z0-9_]+)'/g)]
    .map(match => match[1]);
  for (const eventName of new Set(emittedEvents)) {
    assert.match(analytics, new RegExp(`'${eventName}'`), `${eventName} is emitted but not allowlisted`);
  }
  assert.match(analytics, /'has_search'/);
});

test('routes are normalized before analytics receives them', () => {
  assert.match(analytics, /return '\/updates\/:id'/);
  assert.match(analytics, /return '\/platform\/:name'/);
  assert.match(router, /new CustomEvent\('app:route'/);
});

test('signed-in analytics identity is the internal user id without profile PII', () => {
  assert.match(analytics, /currentUserId = user\?\.id \? String\(user\.id\) : null/);
  assert.match(analytics, /posthog\.identify\(currentUserId\)/);
  assert.match(analytics, /else if \(previousUserId\)/);
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

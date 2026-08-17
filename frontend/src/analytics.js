// Privacy-first analytics adapter for PostHog (product analytics) and
// Microsoft Clarity (strictly masked session replay / heatmaps).
// Neither vendor is initialized until the visitor explicitly opts in.

import posthog from 'posthog-js/dist/module.no-external';

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY || '';
const POSTHOG_PROJECT_KEY_VALID = POSTHOG_KEY.startsWith('phc_');
const POSTHOG_HOST = import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com';
// PostHog is an explicit cost opt-in. A stored project key alone must never
// activate billable analytics traffic after a deploy or account-plan change.
const POSTHOG_ENABLED = import.meta.env.VITE_POSTHOG_ENABLED === 'true';
const CLARITY_PROJECT_ID = import.meta.env.VITE_CLARITY_PROJECT_ID || '';
const CONSENT_KEY = 'patchticker.analytics.consent.v1';
const CONSENT_VERSION = 1;

const ALLOWED_EVENTS = new Set([
  'route_viewed', 'update_opened', 'official_source_clicked',
  'platform_filter_selected', 'status_filter_selected', 'sort_changed',
  'filters_applied', 'search_completed', 'watchlist_item_added', 'watchlist_item_removed',
  'notification_preference_changed', 'update_feedback_submitted',
  'signup_completed', 'login_completed', 'subscription_checkout_started',
]);
const POSTHOG_INTERNAL_EVENTS = new Set(['$identify', '$pageview', '$pageleave']);

const SAFE_PROPERTY_KEYS = new Set([
  'route', 'update_id', 'platform', 'status', 'sort', 'vote', 'source_type',
  'query_length', 'result_count', 'has_results', 'item_count', 'watchlist_type',
  'enabled', 'has_search', 'plan', 'billing_period',
]);
const BLOCKED_VENDOR_PROPERTY = /(url|uri|href|referrer|pathname|search|query|string|token|secret|password|email|name|watchlist|webhook|endpoint|content|text)/i;
const EMAIL_VALUE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const URL_VALUE = /^(?:https?:\/\/|\/\/)/i;

let posthogReady = false;
let clarityReady = false;
let currentUserId = null;
let activeRoute = null;
let maskObserver = null;

function configured() {
  return Boolean((POSTHOG_ENABLED && POSTHOG_PROJECT_KEY_VALID) || CLARITY_PROJECT_ID);
}

function readConsent() {
  try {
    const value = JSON.parse(localStorage.getItem(CONSENT_KEY) || 'null');
    if (value?.version !== CONSENT_VERSION) return null;
    return value.choice === 'granted' || value.choice === 'denied' ? value.choice : null;
  } catch {
    return null;
  }
}

function writeConsent(choice) {
  localStorage.setItem(CONSENT_KEY, JSON.stringify({
    version: CONSENT_VERSION,
    choice,
    updatedAt: new Date().toISOString(),
  }));
}

function normalizeRoute(rawPath = '/') {
  const path = String(rawPath).split('?')[0].split('#')[0] || '/';
  if (/^\/updates?\/[^/]+$/.test(path)) return '/updates/:id';
  if (/^\/platform\/[^/]+$/.test(path)) return '/platform/:name';
  const routes = new Set([
    '/', '/updates', '/login', '/register', '/pricing', '/forgot-password',
    '/reset-password', '/verify-email', '/account', '/settings', '/games',
    '/categories', '/admin', '/about', '/privacy', '/terms',
  ]);
  return routes.has(path) ? path : '/not-found';
}

function currentRoute() {
  return normalizeRoute(window.location.hash.slice(1) || '/');
}

function canonicalRouteUrl(route) {
  return `${window.location.origin}${normalizeRoute(route)}`;
}

function sanitizeValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const clean = value.slice(0, 160);
  if (EMAIL_VALUE.test(clean) || URL_VALUE.test(clean)) return undefined;
  return clean;
}

function safeAppProperties(properties = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!SAFE_PROPERTY_KEYS.has(key)) continue;
    const clean = sanitizeValue(value);
    if (clean !== undefined) safe[key] = clean;
  }
  return safe;
}

function sanitizePostHogEvent(event) {
  if (!event || (!ALLOWED_EVENTS.has(event.event) && !POSTHOG_INTERNAL_EVENTS.has(event.event))) return null;
  const isWebEvent = event.event === '$pageview' || event.event === '$pageleave';
  const properties = {};
  for (const [key, value] of Object.entries(event.properties || {})) {
    // `token` is the browser-safe project token PostHog itself adds to every
    // event. Removing it makes ingestion reject the event. Preserve only the
    // exact configured token so similarly named application fields stay out.
    if (key === 'token') {
      if (value === POSTHOG_KEY) properties.token = POSTHOG_KEY;
      continue;
    }
    if (isWebEvent && key === '$pathname') {
      properties.$pathname = normalizeRoute(value);
      continue;
    }
    if (isWebEvent && key === '$current_url') {
      properties.$current_url = canonicalRouteUrl(new URL(String(value), window.location.origin).pathname);
      continue;
    }
    if (BLOCKED_VENDOR_PROPERTY.test(key) && key !== 'query_length') continue;
    if (!['string', 'number', 'boolean'].includes(typeof value)) continue;
    if (EMAIL_VALUE.test(String(value ?? '')) || URL_VALUE.test(String(value ?? ''))) continue;
    properties[key] = typeof value === 'string' ? value.slice(0, 160) : value;
  }
  event.properties = properties;
  return event;
}

function initPostHog() {
  if (!POSTHOG_ENABLED || !POSTHOG_PROJECT_KEY_VALID || posthogReady) return;
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    defaults: '2026-05-30',
    autocapture: false,
    rageclick: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_performance: false,
    disable_session_recording: true,
    disable_external_dependency_loading: true,
    mask_all_text: true,
    mask_all_element_attributes: true,
    person_profiles: 'identified_only',
    persistence: 'localStorage',
    cross_subdomain_cookie: false,
    secure_cookie: true,
    opt_out_capturing_by_default: true,
    consent_persistence_name: 'patchticker.analytics.posthog.consent',
    respect_dnt: true,
    before_send: sanitizePostHogEvent,
  });
  posthog.opt_in_capturing();
  posthogReady = true;
  if (currentUserId) posthog.identify(currentUserId);
}

function initClarity() {
  if (!CLARITY_PROJECT_ID || clarityReady) return;
  window.clarity = window.clarity || function clarityQueue() {
    (window.clarity.q = window.clarity.q || []).push(arguments);
  };
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.clarity.ms/tag/${encodeURIComponent(CLARITY_PROJECT_ID)}`;
  script.dataset.patchtickerAnalytics = 'clarity';
  document.head.appendChild(script);
  window.clarity('consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' });
  clarityReady = true;
}

function startVendors() {
  if (readConsent() !== 'granted') return;
  initPostHog();
  if (posthogReady) posthog.opt_in_capturing();
  initClarity();
}

function stopVendors() {
  if (posthogReady) {
    posthog.reset();
    posthog.opt_out_capturing();
  }
  if (window.clarity) {
    window.clarity('consentv2', { ad_Storage: 'denied', analytics_Storage: 'denied' });
    window.clarity('consent', false);
  }
}

function removeConsentPanel() {
  document.getElementById('analytics-consent')?.remove();
}

function renderConsentPanel({ preferences = false } = {}) {
  if (!configured()) return;
  removeConsentPanel();
  const panel = document.createElement('section');
  panel.id = 'analytics-consent';
  panel.className = 'analytics-consent';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', preferences ? 'true' : 'false');
  panel.setAttribute('aria-labelledby', 'analytics-consent-title');

  const copy = document.createElement('div');
  copy.className = 'analytics-consent-copy';
  const title = document.createElement('strong');
  title.id = 'analytics-consent-title';
  title.textContent = preferences ? 'Analytics privacy choices' : 'Help improve PatchTicker?';
  const detail = document.createElement('p');
  detail.textContent = 'With your permission, PostHog measures product usage and Microsoft Clarity provides strictly masked session replay and heatmaps. We never send email addresses, raw searches, watchlist contents, or notification tokens.';
  const policy = document.createElement('a');
  policy.href = '#/privacy';
  policy.textContent = 'Privacy policy';
  copy.append(title, detail, policy);

  const actions = document.createElement('div');
  actions.className = 'analytics-consent-actions';
  const decline = document.createElement('button');
  decline.type = 'button';
  decline.className = 'btn btn--outline btn--sm';
  decline.textContent = 'Decline';
  const allow = document.createElement('button');
  allow.type = 'button';
  allow.className = 'btn btn--primary btn--sm';
  allow.textContent = 'Allow analytics';
  actions.append(decline, allow);
  panel.append(copy, actions);
  document.body.appendChild(panel);

  decline.addEventListener('click', () => {
    writeConsent('denied');
    stopVendors();
    removeConsentPanel();
    if (posthogReady || clarityReady) window.location.reload();
  });
  allow.addEventListener('click', () => {
    writeConsent('granted');
    startVendors();
    captureWebEvent('$pageview', activeRoute || currentRoute());
    removeConsentPanel();
  });
  allow.focus();
}

export function applyAnalyticsPrivacyMasks(root = document) {
  const selectors = [
    'input', 'textarea', 'select', '[contenteditable="true"]', 'form',
    '.nav-email', '.account-page', '.auth-card', '.feed-compose',
    '[id*="email" i]', '[name*="email" i]', '[id*="search" i]',
    '[name*="search" i]', '[id*="token" i]', '[name*="token" i]',
    '[id*="webhook" i]', '[name*="webhook" i]',
  ];
  const selector = selectors.join(',');
  if (root instanceof Element && root.matches(selector)) {
    root.setAttribute('data-clarity-mask', 'true');
    root.setAttribute('data-ph-no-capture', 'true');
    root.classList.add('ph-no-capture');
  }
  root.querySelectorAll?.(selector).forEach((element) => {
    element.setAttribute('data-clarity-mask', 'true');
    element.setAttribute('data-ph-no-capture', 'true');
    element.classList.add('ph-no-capture');
  });
}

export function initializeAnalyticsConsent() {
  applyAnalyticsPrivacyMasks(document);
  if (!maskObserver) {
    maskObserver = new MutationObserver((mutations) => {
      mutations.forEach(({ addedNodes }) => addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) applyAnalyticsPrivacyMasks(node);
      }));
    });
    maskObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
  window.addEventListener('app:route', (event) => {
    const nextRoute = normalizeRoute(event.detail?.path);
    if (activeRoute && activeRoute !== nextRoute) captureWebEvent('$pageleave', activeRoute);
    activeRoute = nextRoute;
    captureAnalytics('route_viewed', { route: nextRoute });
    captureWebEvent('$pageview', nextRoute);
  });
  window.addEventListener('pagehide', () => {
    if (activeRoute) captureWebEvent('$pageleave', activeRoute, { transport: 'sendBeacon', send_instantly: true });
  });
  if (readConsent() === 'granted') startVendors();
  else if (readConsent() === null) renderConsentPanel();
}

export function openAnalyticsPreferences() {
  renderConsentPanel({ preferences: true });
}

export function syncAnalyticsIdentity(user) {
  const previousUserId = currentUserId;
  currentUserId = user?.id ? String(user.id) : null;
  if (!posthogReady) return;
  if (currentUserId) {
    posthog.opt_in_capturing();
    if (currentUserId !== previousUserId) posthog.identify(currentUserId);
  } else if (previousUserId) {
    // Reset only on an actual logout. Resetting every anonymous page load
    // fragments visitors and clears the consent state before events can send.
    posthog.reset(true);
    if (readConsent() === 'granted') posthog.opt_in_capturing();
  }
}

function captureWebEvent(eventName, route, options) {
  if (!POSTHOG_INTERNAL_EVENTS.has(eventName) || readConsent() !== 'granted') return;
  if (!posthogReady) initPostHog();
  if (!posthogReady) return;
  const normalizedRoute = normalizeRoute(route);
  posthog.capture(eventName, {
    $current_url: canonicalRouteUrl(normalizedRoute),
    $pathname: normalizedRoute,
  }, options);
}

export function captureAnalytics(eventName, properties = {}) {
  if (!ALLOWED_EVENTS.has(eventName) || readConsent() !== 'granted') return;
  if (!posthogReady) initPostHog();
  if (posthogReady) posthog.capture(eventName, safeAppProperties(properties));
}

export const analyticsPrivacy = Object.freeze({
  consentStorageKey: CONSENT_KEY,
  allowedEvents: [...ALLOWED_EVENTS],
});

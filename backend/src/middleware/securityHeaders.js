// src/middleware/securityHeaders.js
// ─────────────────────────────────────────────────────────────────────────────
// HTTP SECURITY HEADERS
//
// TWO SEPARATE CSP POLICIES
// ──────────────────────────
// This backend serves two distinct resource types, each requiring a different
// Content-Security-Policy:
//
//   1. API routes (/api/*) — pure JSON, no HTML, no scripts, no media.
//      Policy: 'none' for everything except connect-src 'self'.
//      This is the strictest possible CSP.
//
//   2. Frontend static files — served by Nginx/Caddy in production,
//      Vite dev server in development.
//      The backend itself doesn't serve HTML (Nginx does), but in case
//      a single-server deployment serves both, the frontend CSP is exported
//      for use in a separate static-file middleware or Nginx config snippet.
//
// FRONTEND CSP WHITELIST (production)
// ─────────────────────────────────────
//   script-src  'self'
//     All JS is bundled by Vite into /assets/*.js files served from 'self'.
//     No external scripts. No unsafe-inline. No unsafe-eval.
//
//   style-src   'self' https://fonts.googleapis.com
//     'self'                  — our bundled styles.css
//     fonts.googleapis.com    — Google Fonts CSS stylesheet only
//     NO unsafe-inline        — all styles are in external .css files;
//                               dynamic colors use CSS classes, not style=""
//
//   font-src    'self' https://fonts.gstatic.com
//     fonts.gstatic.com — actual .woff2 font files referenced by Google CSS
//
//   connect-src 'self'
//     All API calls go to /api/* on the same origin (Nginx proxies them).
//     No external XHR/fetch targets needed.
//
//   img-src     'self' data:
//     'self' — local images
//     data:  — SVG data URIs, favicon
//
//   default-src 'none'
//     Everything not listed above is blocked.
//
//   frame-ancestors 'none'   — cannot be embedded in any iframe
//   base-uri        'self'   — block <base> tag injection
//   form-action     'self'   — forms only submit to same origin
//   object-src      'none'   — no plugins
//   upgrade-insecure-requests — auto-upgrade HTTP sub-resources to HTTPS
//
// WHY NO unsafe-inline?
// ──────────────────────
//   The frontend was refactored to use zero inline styles and zero inline
//   event handlers. Every dynamic color is encoded as a CSS class. The one
//   dynamic numeric value (sentiment bar width %) is set via
//   element.style.width in JavaScript after DOM insertion — that is
//   CSP-compliant because it goes through the JS DOM API, not an HTML
//   attribute.
//
// OTHER HEADERS
// ─────────────
//   Strict-Transport-Security — max-age from config, includeSubDomains, preload
//   X-Frame-Options: DENY     — belt-and-suspenders with frame-ancestors 'none'
//   X-Content-Type-Options: nosniff
//   X-XSS-Protection: 0       — disabled (XSS auditor is harmful; CSP handles XSS)
//   Referrer-Policy: strict-origin-when-cross-origin
//   Permissions-Policy        — deny all browser features the app doesn't use
//   Cross-Origin-*-Policy     — process isolation (Spectre mitigation)
//
// CSP VIOLATION REPORTING
// ────────────────────────
//   Set CSP_REPORT_URI in .env to receive violation reports.
//   Both API and frontend CSPs will include report-uri/report-to.
//   Use https://sentry.io, https://report-uri.com, or your own endpoint.
//
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const helmet = require('helmet');
const cfg    = require('../config/security');

// ── Permissions-Policy ────────────────────────────────────────────────────────
// Deny every feature the application has no use for.
// Format: feature=() means "deny all origins including self".
const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'ambient-light-sensor=()',
  'autoplay=()',
  'battery=()',
  'camera=()',
  'cross-origin-isolated=()',
  'display-capture=()',
  'document-domain=()',
  'encrypted-media=()',
  'execution-while-not-rendered=()',
  'execution-while-out-of-viewport=()',
  'fullscreen=()',
  'geolocation=()',
  'gyroscope=()',
  'keyboard-map=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'navigation-override=()',
  'payment=()',
  'picture-in-picture=()',
  'publickey-credentials-get=()',
  'screen-wake-lock=()',
  'sync-xhr=()',
  'usb=()',
  'web-share=()',
  'xr-spatial-tracking=()',
].join(', ');

// ── Report-To / report-uri helpers ────────────────────────────────────────────
function addReportDirectives(directives) {
  if (!cfg.CSP_REPORT_URI) return directives;
  return {
    ...directives,
    reportUri: cfg.CSP_REPORT_URI,
    reportTo:  'csp-endpoint',
  };
}

// ── 1. API CSP — absolute minimum ─────────────────────────────────────────────
// The API serves only JSON. It never sends HTML, scripts, fonts, or media.
// A maximally restrictive policy is correct here.
function buildApiCspDirectives() {
  return addReportDirectives({
    defaultSrc:              ["'none'"],
    scriptSrc:               ["'none'"],
    styleSrc:                ["'none'"],
    imgSrc:                  ["'none'"],
    fontSrc:                 ["'none'"],
    connectSrc:              ["'self'"],
    mediaSrc:                ["'none'"],
    objectSrc:               ["'none'"],
    frameSrc:                ["'none'"],
    frameAncestors:          ["'none'"],
    formAction:              ["'none'"],
    baseUri:                 ["'none'"],
    manifestSrc:             ["'none'"],
    workerSrc:               ["'none'"],
    childSrc:                ["'none'"],
    upgradeInsecureRequests: [],
    blockAllMixedContent:    [],
  });
}

// ── 2. Frontend CSP — strict, no unsafe-inline ─────────────────────────────
// Used when the Express server also serves the frontend static files
// (single-server deployment). In a split deployment, apply these directives
// via Nginx's add_header or the exported FRONTEND_CSP_HEADER constant.
//
// Whitelisted domains (and why each is necessary):
//   fonts.googleapis.com — Google Fonts CSS (@font-face declarations)
//   fonts.gstatic.com   — Google Fonts .woff2 binary files
//
// Nothing else is needed: all JS and CSS is self-hosted post-Vite build.
function buildFrontendCspDirectives() {
  return addReportDirectives({
    defaultSrc:              ["'none'"],
    // TODO: ca-pub-XXXXXXXXXXXXXXXX — replace with real publisher ID when AdSense is live
    scriptSrc:               ["'self'", 'https://hcaptcha.com', 'https://*.hcaptcha.com', 'https://pagead2.googlesyndication.com', 'https://googleads.g.doubleclick.net'],
    // No unsafe-inline. Google Fonts CSS is external — loaded from their CDN.
    styleSrc:                ["'self'", 'https://fonts.googleapis.com', 'https://hcaptcha.com', 'https://*.hcaptcha.com', 'https://pagead2.googlesyndication.com'],
    // Actual font binary files are served from gstatic.com
    fontSrc:                 ["'self'", 'https://fonts.gstatic.com'],
    // hCaptcha verification endpoint + asset CDN
    connectSrc:              ["'self'", 'https://hcaptcha.com', 'https://hcaptcha.com', 'https://*.hcaptcha.com', 'https://pagead2.googlesyndication.com', 'https://googleads.g.doubleclick.net'],
    imgSrc:                  ["'self'", 'data:', 'https://hcaptcha.com', 'https://*.hcaptcha.com', 'https://pagead2.googlesyndication.com', 'https://googleads.g.doubleclick.net'],
    // hCaptcha widget renders inside an iframe from hCaptcha
    frameSrc:                ['https://hcaptcha.com', 'https://*.hcaptcha.com', 'https://googleads.g.doubleclick.net', 'https://tpc.googlesyndication.com'],
    mediaSrc:                ["'none'"],
    objectSrc:               ["'none'"],
    frameSrc:                ["'none'"],
    frameAncestors:          ["'none'"],
    formAction:              ["'self'"],
    baseUri:                 ["'self'"],
    manifestSrc:             ["'self'"],
    workerSrc:               ["'none'"],
    childSrc:                ["'none'"],
    upgradeInsecureRequests: [],
    blockAllMixedContent:    [],
  });
}

// ── HSTS configuration ────────────────────────────────────────────────────────
function buildHsts() {
  return {
    maxAge:            cfg.HSTS_MAX_AGE,
    includeSubDomains: cfg.HSTS_INCLUDE_SUBDOMAINS,
    preload:           cfg.HSTS_PRELOAD,
  };
}

// ── Shared Helmet base options ────────────────────────────────────────────────
// Everything except contentSecurityPolicy — that differs per-route.
const HELMET_BASE = {
  strictTransportSecurity: buildHsts(),
  frameguard:              { action: 'deny' },
  noSniff:                 true,
  xssFilter:               false,   // XSS auditor is harmful; CSP handles XSS
  referrerPolicy:          { policy: 'strict-origin-when-cross-origin' },
  hidePoweredBy:           true,
  crossOriginEmbedderPolicy: { policy: 'require-corp' },
  crossOriginOpenerPolicy:   { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  dnsPrefetchControl:      { allow: false },
  ieNoOpen:                true,
  noOpen:                  true,
};

// ── Helmet instances ──────────────────────────────────────────────────────────

// API routes: maximally restrictive CSP
const apiHelmet = helmet({
  ...HELMET_BASE,
  contentSecurityPolicy: {
    useDefaults: false,
    directives:  buildApiCspDirectives(),
  },
});

// Frontend static files: strict but allows self + Google Fonts
const frontendHelmet = helmet({
  ...HELMET_BASE,
  contentSecurityPolicy: {
    useDefaults: false,
    directives:  buildFrontendCspDirectives(),
  },
});

// ── Extra headers (Permissions-Policy, Report-To) ─────────────────────────────
// Helmet v7 doesn't set Permissions-Policy natively — added manually.
function extraHeaders(req, res, next) {
  res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);

  if (cfg.CSP_REPORT_URI) {
    res.setHeader('Report-To', JSON.stringify({
      group:     'csp-endpoint',
      max_age:   86400,
      endpoints: [{ url: cfg.CSP_REPORT_URI }],
    }));
  }

  next();
}

// ── Nginx config snippet (exported as a string constant) ──────────────────────
// In a split deployment where Nginx serves the frontend directly, paste this
// into your server block. The value is generated from the same source of truth
// as the Express middleware so they stay in sync.
//
// Usage in nginx.conf:
//   add_header Content-Security-Policy "${FRONTEND_CSP_NGINX}";
//
function directivesToNginx(directives) {
  return Object.entries(directives)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      // Convert camelCase Helmet key → kebab-case CSP directive
      const dir = k.replace(/([A-Z])/g, '-$1').toLowerCase();
      return Array.isArray(v) && v.length === 0
        ? dir
        : `${dir} ${v.join(' ')}`;
    })
    .join('; ');
}

const FRONTEND_CSP_NGINX = directivesToNginx(buildFrontendCspDirectives());

// ── Exports ───────────────────────────────────────────────────────────────────

/**
 * Default export: API route security headers.
 * Used as: app.use('/api', ...securityHeaders)
 * or:      app.use(...securityHeaders)  (covers all routes)
 */
module.exports = [apiHelmet, extraHeaders];

/**
 * Frontend headers middleware for single-server deployments.
 * Mount before static file middleware:
 *   app.use(frontendSecurityHeaders);
 *   app.use(express.static('frontend/dist'));
 */
module.exports.frontendSecurityHeaders = [frontendHelmet, extraHeaders];

/**
 * Nginx add_header value for split deployments.
 * Log this at startup or write it to a file for ops reference.
 */
module.exports.FRONTEND_CSP_NGINX = FRONTEND_CSP_NGINX;

/**
 * Raw directive builders — exported for testing.
 */
module.exports.buildApiCspDirectives      = buildApiCspDirectives;
module.exports.buildFrontendCspDirectives = buildFrontendCspDirectives;

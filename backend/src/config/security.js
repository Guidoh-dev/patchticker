// src/config/security.js
// ─────────────────────────────────────────────────────────────────────────────
// SECURITY CONFIGURATION — single source of truth for every security-sensitive
// setting. All middleware imports from here; nothing reads process.env directly.
//
// STARTUP VALIDATION
// ──────────────────
// This module throws at require-time if any production-required variable is
// missing or still set to its placeholder value. The server refuses to start
// with broken security config.
//
// ENV VARS OWNED BY THIS MODULE
// ──────────────────────────────
//   NODE_ENV                development | production | test
//   PORT                    TCP port (default 4000)
//   ALLOWED_ORIGINS         Comma-separated list of allowed CORS origins
//
//   TRUST_PROXY             How Express resolves req.ip from X-Forwarded-For.
//                           Accepts: a number (proxy hops), 'loopback',
//                           'linklocal', 'uniquelocal', 'true', or a
//                           comma-separated list of trusted CIDR ranges.
//                           CLOUDFLARE: set to 'cloudflare' — this module
//                           converts that to Express-compatible config and
//                           enables CF-Connecting-IP extraction middleware.
//                           See cloudflare.js for full Cloudflare setup.
//
//   CLOUDFLARE_MODE         'true' — enable CF-specific headers and validation.
//                           When true, CF-Connecting-IP is used as the
//                           authoritative client IP (cannot be spoofed by
//                           clients, unlike X-Forwarded-For).
//
//   CLOUDFLARE_VALIDATE_IPS 'true' — validate that requests arrive from known
//                           Cloudflare IP ranges (blocks origin-direct access).
//                           Requires periodic refresh of CF IP list.
//
//   HTTPS_REDIRECT          'true' to enforce HTTPS redirect in production
//   HSTS_MAX_AGE            HSTS max-age seconds (default 31536000 = 1 year)
//   HSTS_PRELOAD            'true' to include preload directive
//   CSP_REPORT_URI          Optional URI for CSP violation reports
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const isProd = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';
const isDev  = !isProd && !isTest;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Require an env var in production. In dev/test, fall back to devDefault.
 * Throws at startup if the prod value is missing or still a placeholder.
 */
function prodRequired(name, devDefault) {
  const val = process.env[name];
  if (isProd) {
    if (!val || val.startsWith('REPLACE_WITH') || val.startsWith('your_')) {
      throw new Error(
        `[security] Missing or placeholder value for required production env var: ${name}. ` +
        `Server will not start with insecure configuration.`
      );
    }
    return val;
  }
  return val || devDefault;
}

/**
 * Parse a comma-separated list of origins, stripping whitespace and empties.
 */
function parseOrigins(raw) {
  if (!raw) return [];
  return raw.split(',').map(o => o.trim()).filter(Boolean);
}

/**
 * Parse TRUST_PROXY env var into the value Express accepts.
 *
 * Express app.set('trust proxy', value) accepts:
 *   • boolean  — true trusts all proxies (insecure), false disables
 *   • number   — trust N leftmost hops in X-Forwarded-For
 *   • string   — 'loopback', 'linklocal', 'uniquelocal', or CSV of CIDR ranges
 *
 * Special handling:
 *   'cloudflare' → returns 'loopback, linklocal, uniquelocal' for Express
 *                  (Cloudflare IPs are handled by CF-Connecting-IP middleware
 *                   when CLOUDFLARE_MODE=true — see middleware/cloudflare.js)
 *   '0'/'false'  → false (no proxy trust)
 *   '1', '2' …  → integer
 *   anything else → pass through as string (CIDR list, named network)
 *
 * @param {string|undefined} raw
 * @returns {boolean|number|string}
 */
function parseTrustProxy(raw) {
  if (!raw || raw === '0' || raw === 'false') return false;
  if (raw === 'true') return true;
  if (raw === 'cloudflare') {
    // Express doesn't have a built-in 'cloudflare' name. When CLOUDFLARE_MODE
    // is on, CF-Connecting-IP middleware overrides req.ip before any rate
    // limiting or abuse detection reads it. We still need trust proxy enabled
    // so Express resolves X-Forwarded-For correctly for the HTTPS detection.
    // 'loopback, linklocal, uniquelocal' trusts only RFC-1918/loopback ranges,
    // which covers most typical deployment topologies (server behind LB on VPC).
    return 'loopback, linklocal, uniquelocal';
  }
  const asInt = parseInt(raw, 10);
  // Only treat as integer if the entire string is a number
  if (!isNaN(asInt) && String(asInt) === raw.trim()) return asInt;
  // Pass through as string (named network or CIDR list)
  return raw;
}

// ── Environment ───────────────────────────────────────────────────────────────

const NODE_ENV = process.env.NODE_ENV || 'development';
const PORT     = parseInt(process.env.PORT || '4000', 10);

// BIND_HOST controls which network interface Node listens on.
//
// '127.0.0.1' — loopback only. Node is unreachable from the internet.
//               Traffic must arrive via a reverse proxy (Nginx, Caddy, etc.)
//               that forwards from port 80/443 to this port. This is the
//               correct production setting when Cloudflare → Nginx → Node.
//
// '0.0.0.0'   — all interfaces. Node is directly reachable on every NIC.
//               Only appropriate if Node is the public-facing process itself
//               (e.g. behind a cloud load balancer with no Nginx layer).
//
// Default: '127.0.0.1' in production, '0.0.0.0' in dev/test so localhost
// tooling (Vite proxy, curl, Postman) can reach the API without extra config.
const BIND_HOST = process.env.BIND_HOST || (isProd ? '127.0.0.1' : '0.0.0.0');

// ── Cloudflare ────────────────────────────────────────────────────────────────

/**
 * CLOUDFLARE_MODE: when true, the cloudflare.js middleware runs and:
 *   1. Reads CF-Connecting-IP as the authoritative client IP (overwrites req.ip)
 *   2. Reads CF-Visitor JSON to detect the actual connection scheme (http/https)
 *   3. Optionally validates that the request comes from a known Cloudflare IP
 */
const CLOUDFLARE_MODE = process.env.CLOUDFLARE_MODE === 'true';

/**
 * CLOUDFLARE_VALIDATE_IPS: when true, every request is checked against the
 * published Cloudflare IPv4/IPv6 ranges. Requests arriving directly (bypassing
 * Cloudflare) are rejected with 403. This blocks origin-direct access.
 *
 * ⚠  Only enable after whitelisting Cloudflare IPs at your firewall/VPC level
 *    AND confirming all legitimate traffic flows through Cloudflare. Enabling
 *    prematurely will break health checks from monitoring services.
 */
const CLOUDFLARE_VALIDATE_IPS = CLOUDFLARE_MODE &&
  process.env.CLOUDFLARE_VALIDATE_IPS === 'true';

// ── Proxy trust ───────────────────────────────────────────────────────────────

const _rawTrustProxy = process.env.TRUST_PROXY;

// If CLOUDFLARE_MODE is on but TRUST_PROXY wasn't explicitly set, default to
// 'cloudflare' (which parseTrustProxy converts to the loopback/linklocal range)
// rather than the numeric '1' default, to avoid trusting arbitrary hop counts.
const _effectiveTrustProxy = _rawTrustProxy
  ? _rawTrustProxy
  : (CLOUDFLARE_MODE ? 'cloudflare' : '1');

const TRUST_PROXY = parseTrustProxy(_effectiveTrustProxy);

// ── CORS ──────────────────────────────────────────────────────────────────────

const _rawOrigins  = prodRequired('ALLOWED_ORIGINS', 'http://localhost:3000');
const ALLOWED_ORIGINS = parseOrigins(_rawOrigins);

if (isProd && ALLOWED_ORIGINS.length === 0) {
  throw new Error('[security] ALLOWED_ORIGINS must contain at least one origin in production.');
}
if (isProd) {
  for (const origin of ALLOWED_ORIGINS) {
    if (!origin.startsWith('https://')) {
      throw new Error(
        `[security] All ALLOWED_ORIGINS must use HTTPS in production. Got: ${origin}`
      );
    }
  }
}

// ── HTTPS / HSTS ──────────────────────────────────────────────────────────────

// Force HTTP → HTTPS redirect. In Cloudflare mode this is safe: Cloudflare
// always forwards requests to the origin with X-Forwarded-Proto: https (or
// the CF-Visitor JSON scheme field) when the browser connected over HTTPS.
// The httpsRedirect middleware reads both headers so it won't redirect-loop.
const HTTPS_REDIRECT      = process.env.HTTPS_REDIRECT === 'true' || isProd;
const HSTS_MAX_AGE        = parseInt(process.env.HSTS_MAX_AGE || '31536000', 10);
const HSTS_INCLUDE_SUBDOMAINS = true;
const HSTS_PRELOAD        = process.env.HSTS_PRELOAD === 'true';

// ── Content Security Policy ───────────────────────────────────────────────────

const CSP_REPORT_URI = process.env.CSP_REPORT_URI || null;

// ── Exports ───────────────────────────────────────────────────────────────────

const config = Object.freeze({
  // Environment
  NODE_ENV,
  BIND_HOST,
  isProd,
  isTest,
  isDev,
  PORT,

  // Proxy + Cloudflare
  TRUST_PROXY,
  CLOUDFLARE_MODE,
  CLOUDFLARE_VALIDATE_IPS,

  // CORS
  ALLOWED_ORIGINS,

  // HTTPS
  HTTPS_REDIRECT,
  HSTS_MAX_AGE,
  HSTS_INCLUDE_SUBDOMAINS,
  HSTS_PRELOAD,

  // CSP
  CSP_REPORT_URI,
});

module.exports = config;

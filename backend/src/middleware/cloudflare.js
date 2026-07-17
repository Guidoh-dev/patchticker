// src/middleware/cloudflare.js
// ─────────────────────────────────────────────────────────────────────────────
// CLOUDFLARE-SPECIFIC MIDDLEWARE
//
// WHY THIS EXISTS
// ────────────────
// When a request flows through Cloudflare, the network topology looks like:
//
//   Client → Cloudflare edge → (public internet) → Origin server (Node.js)
//
// X-Forwarded-For is set by Cloudflare but can ALSO be spoofed by clients
// before the request reaches Cloudflare — they prepend their own values:
//
//   Client sends: X-Forwarded-For: 1.1.1.1
//   Cloudflare receives it and appends the real client IP:
//   X-Forwarded-For: 1.1.1.1, <real-client-ip>
//
// Express trust proxy = N reads the Nth-from-right entry, which is
// Cloudflare's value — correct. But this still requires knowing the
// exact hop count, which varies with Cloudflare's network.
//
// CF-Connecting-IP IS DIFFERENT:
//   • Set by Cloudflare, never forwarded from the client
//   • Always the real client IP that connected to the Cloudflare edge
//   • Cannot be spoofed (Cloudflare strips any client-supplied version)
//   • Present on every request through Cloudflare (Free, Pro, Business, Enterprise)
//
// This middleware sets req.ip from CF-Connecting-IP when CLOUDFLARE_MODE=true,
// making it the authoritative source for all downstream middleware
// (rate limiting, abuse detection, logging).
//
// CF-VISITOR (HTTPS DETECTION)
// ─────────────────────────────
// Cloudflare sets CF-Visitor: {"scheme":"https"} or {"scheme":"http"} on
// every request. This is more reliable than X-Forwarded-Proto for detecting
// whether the original client connected over HTTPS. The httpsRedirect
// middleware already checks X-Forwarded-Proto (which Cloudflare also sets
// correctly); CF-Visitor is an additional signal parsed here and attached
// to req as req.cfVisitor for middleware that needs it.
//
// CLOUDFLARE IP VALIDATION
// ─────────────────────────
// When CLOUDFLARE_VALIDATE_IPS=true, every request's socket IP (the actual
// TCP peer — not the forwarded IP) must be a known Cloudflare range. Requests
// arriving directly at the origin (bypassing Cloudflare) are rejected with 403.
//
// Cloudflare publishes its ranges at:
//   https://www.cloudflare.com/ips-v4
//   https://www.cloudflare.com/ips-v6
//
// The IP list below is from December 2024. For production use, automate
// refreshing this list via a cron job hitting those URLs. The list changes
// infrequently (a few times per year) but does change.
//
// ⚠ ONLY enable CLOUDFLARE_VALIDATE_IPS once you have:
//   1. Confirmed ALL legitimate traffic flows through Cloudflare
//   2. Configured firewall/security-group rules to block non-CF origin access
//   3. Exempted any health check IPs at the network layer
//   ENABLING PREMATURELY WILL BREAK UPTIME MONITORING AND HEALTH CHECKS.
//
// PLACEMENT IN MIDDLEWARE CHAIN
// ──────────────────────────────
// Must run AFTER app.set('trust proxy') is applied but BEFORE any middleware
// that reads req.ip. In server.js this is slot 1.5 (after trust proxy,
// before httpsRedirect and all security checks). It runs before:
//   - httpsRedirect
//   - abuseDetector
//   - rateLimiter
//   - suspiciousActivityDetector
//   - auth middleware
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const cfg    = require('../config/security');
const logger = require('../utils/logger');

// ── Cloudflare published IP ranges (Dec 2024) ────────────────────────────────
// Source: https://www.cloudflare.com/ips-v4 + https://www.cloudflare.com/ips-v6
// Refresh with: curl -s https://www.cloudflare.com/ips-v4
//
// For automated refresh, use the cfIpRefresher.js script (see scripts/ dir).
// Replace this list in production using CLOUDFLARE_IP_RANGES env var (JSON array).
const CF_CIDR_LIST = [
  // IPv4
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '108.162.192.0/18',
  '131.0.72.0/22',
  '141.101.64.0/18',
  '162.158.0.0/15',
  '172.64.0.0/13',
  '173.245.48.0/20',
  '188.114.96.0/20',
  '190.93.240.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  // IPv6
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

// Parse CLOUDFLARE_IP_RANGES env var override (JSON array of CIDR strings)
let _cfRanges = CF_CIDR_LIST;
if (process.env.CLOUDFLARE_IP_RANGES) {
  try {
    const parsed = JSON.parse(process.env.CLOUDFLARE_IP_RANGES);
    if (Array.isArray(parsed) && parsed.length > 0) {
      _cfRanges = parsed;
      logger.info('[cloudflare] Using custom IP ranges from CLOUDFLARE_IP_RANGES env var', {
        count: parsed.length,
      });
    }
  } catch (e) {
    logger.error('[cloudflare] Failed to parse CLOUDFLARE_IP_RANGES — using built-in list', {
      message: e.message,
    });
  }
}

// ── IP-in-CIDR check (IPv4 only — IPv6 needs BigInt) ─────────────────────────

/**
 * Convert a dotted-decimal IPv4 string to a 32-bit unsigned integer.
 * @param {string} ip
 * @returns {number}
 */
function ipToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) | parseInt(octet, 10), 0) >>> 0;
}

/**
 * Convert a compressed IPv6 address to a BigInt (128-bit).
 * Handles '::' expansion and IPv4-mapped IPv6.
 * @param {string} ip
 * @returns {bigint}
 */
function ipv6ToBigInt(ip) {
  // Strip IPv6-mapped IPv4 prefix
  if (ip.startsWith('::ffff:') && ip.includes('.')) {
    ip = ip.slice(7);
    const parts = ip.split('.').map(Number);
    return BigInt((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]);
  }

  // Expand '::' shorthand
  if (ip.includes('::')) {
    const [left, right] = ip.split('::');
    const leftParts  = left  ? left.split(':')  : [];
    const rightParts = right ? right.split(':') : [];
    const fill = 8 - leftParts.length - rightParts.length;
    const full = [...leftParts, ...Array(fill).fill('0'), ...rightParts];
    return full.reduce((acc, part) => (acc << 16n) | BigInt(parseInt(part || '0', 16)), 0n);
  }

  return ip.split(':').reduce(
    (acc, part) => (acc << 16n) | BigInt(parseInt(part || '0', 16)),
    0n
  );
}

/**
 * Test whether an IP address falls within a CIDR range.
 * Supports both IPv4 and IPv6.
 * @param {string} ip     — dotted-decimal IPv4 or colon-separated IPv6
 * @param {string} cidr   — CIDR notation string (e.g. '104.16.0.0/13')
 * @returns {boolean}
 */
function ipInCidr(ip, cidr) {
  const [range, bits] = cidr.split('/');
  const prefix = parseInt(bits, 10);

  const isIpv6 = ip.includes(':') || cidr.includes(':');

  if (!isIpv6) {
    // IPv4 path — 32-bit integer arithmetic
    const mask    = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    const ipInt   = ipToInt(ip);
    const rangeInt = ipToInt(range);
    return (ipInt & mask) === (rangeInt & mask);
  }

  // IPv6 path — BigInt arithmetic
  const ipBig    = ipv6ToBigInt(ip);
  const rangeBig = ipv6ToBigInt(range);
  const mask     = prefix === 0 ? 0n : (~0n << BigInt(128 - prefix));
  return (ipBig & mask) === (rangeBig & mask);
}

/**
 * Returns true if the given IP is in any of the Cloudflare published ranges.
 * @param {string} ip
 * @returns {boolean}
 */
function isCloudflareIp(ip) {
  if (!ip) return false;
  // Strip port if present (e.g. '::ffff:127.0.0.1:1234' shouldn't happen, but guard)
  const cleanIp = ip.split('%')[0]; // strip zone ID from IPv6
  return _cfRanges.some(cidr => {
    try {
      return ipInCidr(cleanIp, cidr);
    } catch {
      return false;
    }
  });
}

// ── Parse CF-Visitor header ───────────────────────────────────────────────────

/**
 * Parse the CF-Visitor header (JSON: {"scheme":"https"}) and return the scheme.
 * Returns null if the header is absent or malformed.
 * @param {string|undefined} raw
 * @returns {'https'|'http'|null}
 */
function parseCfVisitor(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed.scheme === 'https' ? 'https'
         : parsed.scheme === 'http'  ? 'http'
         : null;
  } catch {
    return null;
  }
}

// ── Main middleware ───────────────────────────────────────────────────────────

/**
 * Cloudflare request normalisation middleware.
 *
 * When CLOUDFLARE_MODE=true:
 *   1. Reads CF-Connecting-IP as the authoritative client IP
 *   2. Overrides req.ip with the real client IP
 *   3. Parses CF-Visitor for HTTPS scheme detection
 *   4. Optionally validates the socket IP is a Cloudflare range
 *
 * When CLOUDFLARE_MODE=false (or undefined):
 *   This middleware is a transparent no-op. Import and use it unconditionally
 *   in server.js — it self-disables when CF mode is off.
 *
 * @type {import('express').RequestHandler}
 */
function cloudflareMiddleware(req, res, next) {
  if (!cfg.CLOUDFLARE_MODE) return next();

  // ── 1. Validate socket IP is a known Cloudflare range ────────────────────
  // req.socket.remoteAddress is the actual TCP peer — not forwarded/spoofable.
  // In Cloudflare deployments this should always be a CF edge IP.
  if (cfg.CLOUDFLARE_VALIDATE_IPS) {
    const socketIp = req.socket?.remoteAddress || '';
    // Exempt loopback (Docker, local dev with tunnel)
    const isLoopback = socketIp === '127.0.0.1' || socketIp === '::1'
      || socketIp === '::ffff:127.0.0.1';

    if (!isLoopback && !isCloudflareIp(socketIp)) {
      logger.warn('[cloudflare] Request from non-Cloudflare IP blocked', {
        socketIp,
        path:   req.path,
        method: req.method,
      });
      return res.status(403).json({
        error: 'Direct origin access is not permitted. Please use the Cloudflare-proxied URL.',
      });
    }
  }

  // ── 2. Extract real client IP from CF-Connecting-IP ───────────────────────
  // CF-Connecting-IP: always the real client IP that connected to CF edge.
  // Cloudflare strips any client-supplied CF-Connecting-IP header before
  // adding its own — it cannot be spoofed by end clients.
  const cfConnectingIp = req.headers['cf-connecting-ip'];

  if (cfConnectingIp) {
    // Validate it looks like an IP address (basic sanity check)
    const trimmed = cfConnectingIp.trim();
    // Simple regex: IPv4 or IPv6 characters only — no injection possible
    if (/^[0-9a-fA-F:.\[\]%]+$/.test(trimmed) && trimmed.length < 50) {
      // Override req.ip — Express uses a getter/setter backed by a private
      // property. We set req._realIp and patch the property with defineProperty
      // only if it hasn't been patched already.
      Object.defineProperty(req, 'ip', {
        get:          () => trimmed,
        configurable: true,
        enumerable:   true,
      });
    }
  }

  // ── 3. Parse CF-Visitor for HTTPS scheme ──────────────────────────────────
  // Attach to req so httpsRedirect and any other middleware can use it.
  req.cfVisitor = parseCfVisitor(req.headers['cf-visitor']);

  // ── 4. Attach Cloudflare metadata for logging ─────────────────────────────
  req.cloudflare = {
    country:    req.headers['cf-ipcountry'] || null,   // e.g. 'US', 'GB'
    rayId:      req.headers['cf-ray']       || null,   // e.g. '7c4b2a...'
    datacenter: (req.headers['cf-ray'] || '').split('-').pop() || null,
  };

  next();
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = cloudflareMiddleware;
module.exports.isCloudflareIp  = isCloudflareIp;
module.exports.parseCfVisitor  = parseCfVisitor;
module.exports.ipInCidr        = ipInCidr;
module.exports.CF_CIDR_LIST    = CF_CIDR_LIST;

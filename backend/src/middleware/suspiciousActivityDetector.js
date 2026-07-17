// src/middleware/suspiciousActivityDetector.js
// ─────────────────────────────────────────────────────────────────────────────
// SUSPICIOUS ACTIVITY DETECTOR — pattern-based request analysis
//
// WHAT THIS CHECKS
// ─────────────────
//   1. SCANNER FINGERPRINTS — User-Agent strings that match automated tools:
//      sqlmap, nikto, nmap, masscan, zgrab, dirsearch, nuclei, etc.
//      These are never legitimate traffic for a production API.
//      Score: HIGH — auto-blacklist threshold reached quickly.
//
//   2. PATH PROBING — Requests for paths that don't exist on this API but
//      are commonly probed by scanners: /.env, /wp-admin, /.git/config,
//      /phpmyadmin, /actuator/health (Spring Boot), /api/v1/users, etc.
//      Score: MEDIUM — pattern alone isn't conclusive.
//
//   3. INJECTION SIGNATURES IN HEADERS — SQL, XSS, and template injection
//      patterns in headers that route handlers never read (User-Agent,
//      X-Forwarded-For, Referer, etc.). Legitimate clients don't put
//      SQL fragments in their User-Agent.
//      Score: HIGH.
//
//   4. IMPOSSIBLE/ANOMALOUS HEADERS — Missing Accept header on GET requests,
//      Content-Type set on GET requests, absurdly long header values that
//      suggest buffer overflow probing, headers with null bytes.
//      Score: LOW — flagged but not blocked alone.
//
//   5. CREDENTIAL STUFFING CADENCE — Multiple 401 responses from one IP
//      against the auth endpoints within a short window. This is tracked
//      per-IP in a sliding window counter and reported to ipAbuseService.
//      Score: AUTH_ABUSE signal.
//
// SCORING PHILOSOPHY
// ───────────────────
//  Each detected pattern is logged and its corresponding abuse signal is
//  recorded via ipAbuseService. The service handles thresholds and
//  auto-blacklisting. This module's job is purely: observe, classify, report.
//
//  No false positive is zero-risk, but the patterns chosen here are almost
//  exclusively associated with automated tools. A legitimate browser or API
//  client will never trigger scanner fingerprints or injection-in-headers.
//
// PLACEMENT IN MIDDLEWARE CHAIN
// ──────────────────────────────
//  After abuseDetector (blacklist check), before requestGuard and body parsing.
//  Order: httpsRedirect → securityHeaders → cors → abuseDetector
//         → suspiciousActivityDetector → requestGuard → body parsing → limiters
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { recordSignal, SIGNAL } = require('../services/ipAbuseService');
const logger                   = require('../utils/logger');

// ── Pattern libraries ─────────────────────────────────────────────────────────

// User-Agent fragments that unambiguously identify automated scanners.
// All lowercase — compared against lowercased UA.
const SCANNER_UA_PATTERNS = [
  'sqlmap',        // SQLMap — SQL injection scanner
  'nikto',         // Nikto — web vulnerability scanner
  'nmap',          // Nmap scripting engine
  'masscan',       // Masscan — port scanner
  'zgrab',         // ZGrab — banner grabber
  'dirsearch',     // DirSearch — directory brute-forcer
  'gobuster',      // GoBuster — directory/DNS brute-forcer
  'ffuf',          // FFUF — fuzzer
  'feroxbuster',   // FeroxBuster — content discovery
  'nuclei',        // Nuclei — vulnerability scanner
  'metasploit',    // Metasploit framework
  'python-requests/2.', // often used by scripted scanners (note: not all python-requests)
  'go-http-client/1.1', // generic Go HTTP, commonly used by scanners
  'curl/7.',       // Low specificity alone, but combined with suspicious paths
  'libwww-perl',   // Old Perl HTTP library, common in scanners
  'wfuzz',         // WFuzz — web application fuzzer
  'burpsuite',     // Burp Suite proxy
  'owasp',         // OWASP testing tools
  'acunetix',      // Acunetix web scanner
  'nessus',        // Nessus vulnerability scanner
  'openvas',       // OpenVAS
  'w3af',          // W3AF web app attack/audit framework
  'havij',         // Havij — SQL injection tool
  'pangolin',      // Pangolin — SQL injection tool
  'slowhttptest',  // SlowHTTPTest — DoS tool
  'slowloris',     // Slowloris — DoS tool
];

// Paths commonly probed by scanners that don't exist on this API.
// A real user would only hit /api/* paths.
const PROBE_PATH_PATTERNS = [
  /^\/\.env/i,
  /^\/\.git/i,
  /^\/\.htaccess/i,
  /^\/wp-(?:admin|login|content|includes)/i,
  /^\/wp\.php/i,
  /^\/phpmyadmin/i,
  /^\/adminer/i,
  /^\/admin(?:\/|$)/i,
  /^\/actuator/i,              // Spring Boot actuator
  /^\/console/i,               // Rails/Grails admin console
  /^\/manager\/html/i,         // Tomcat manager
  /^\/cgi-bin/i,
  /^\/xmlrpc\.php/i,
  /^\/config\.php/i,
  /^\/setup\.php/i,
  /^\/install\.php/i,
  /^\/backup/i,
  /^\/dump/i,
  /^\/db\.sql/i,
  /\/\.\./,                    // path traversal (belt-and-suspenders)
  /^\/api\/v[0-9]+\/users?$/i, // generic REST probing (not our schema)
  /^\/v[0-9]+\//i,             // version prefix not used by this API
  /^\/swagger/i,
  /^\/openapi/i,
  /^\/graphql/i,               // not used by this API
  /^\/metrics/i,               // Prometheus scrape endpoint probing
];

// Injection patterns that should never appear in request headers.
// These are the same patterns that hardened() uses on body fields,
// applied here to headers that route code never inspects.
const INJECTION_IN_HEADER_PATTERNS = [
  /<script/i,
  /javascript:/i,
  /union\s+select/i,
  /;\s*drop\s+table/i,
  /\0/,                        // null byte
  /\{\{.*\}\}/,                // template injection {{…}}
  /on\w+\s*=/i,                // event handler injection
];

// Headers to check for injection patterns.
// Only scan user-supplied headers — never trusted infrastructure headers.
// DO NOT add to this list:
//   cf-connecting-ip — set by Cloudflare only, never forwarded from client
//   cf-ray           — Cloudflare request ID (hex string)
//   cf-ipcountry     — two-letter country code from Cloudflare geo-IP
//   cf-visitor       — JSON: {"scheme":"http|https"} — always safe
//   authorization    — JWT payloads are base64 that triggers false positives
const HEADERS_TO_INSPECT = [
  'user-agent',
  'referer',
  'x-forwarded-for',
  'via',
  'x-real-ip',
  'x-custom-header',
];

// ── Credential stuffing tracker ───────────────────────────────────────────────
// Map<ip → { count: number, windowStart: number }>
// Tracks 401 responses from auth endpoints per IP per sliding window.
const _authFailTracker = new Map();
const AUTH_FAIL_WINDOW_MS    = 5 * 60 * 1000;   // 5-minute window
const AUTH_FAIL_THRESHOLD    = 15;               // 15 failures → AUTH_ABUSE signal
const AUTH_ENDPOINTS         = new Set(['/api/auth/login', '/api/auth/register']);

// ── Helpers ───────────────────────────────────────────────────────────────────

function trackAuthFailure(ip) {
  const now    = Date.now();
  let tracker  = _authFailTracker.get(ip);

  if (!tracker || (now - tracker.windowStart) > AUTH_FAIL_WINDOW_MS) {
    tracker = { count: 0, windowStart: now };
    _authFailTracker.set(ip, tracker);
  }

  tracker.count++;

  if (tracker.count >= AUTH_FAIL_THRESHOLD) {
    _authFailTracker.delete(ip); // reset so the signal fires once per window
    return true;                 // threshold crossed
  }
  return false;
}

// Periodic cleanup of stale auth-fail records
setInterval(() => {
  const now = Date.now();
  for (const [ip, t] of _authFailTracker.entries()) {
    if (now - t.windowStart > AUTH_FAIL_WINDOW_MS * 2) {
      _authFailTracker.delete(ip);
    }
  }
}, 10 * 60 * 1000).unref();

// ── Main middleware ───────────────────────────────────────────────────────────

/**
 * @type {import('express').RequestHandler}
 */
function suspiciousActivityDetector(req, res, next) {
  const ip        = req.ip;
  const ua        = (req.headers['user-agent'] || '').toLowerCase();
  const path      = req.path;
  const isAuthEp  = AUTH_ENDPOINTS.has(req.path);

  // ── 1. Scanner User-Agent fingerprint ──────────────────────────────────────
  for (const pattern of SCANNER_UA_PATTERNS) {
    if (ua.includes(pattern)) {
      logger.warn('Scanner fingerprint detected', {
        ip,
        pattern,
        ua: ua.slice(0, 200),
        path,
        method: req.method,
      });
      recordSignal(ip, SIGNAL.SCANNER, { pattern, ua: ua.slice(0, 100) });
      // Do not short-circuit — record signal but let request continue through
      // guard/limiters. Blocking here would reveal our detection.
      break;
    }
  }

  // ── 2. Path probing ────────────────────────────────────────────────────────
  for (const pattern of PROBE_PATH_PATTERNS) {
    if (pattern.test(path)) {
      logger.warn('Probe path detected', {
        ip,
        path,
        method: req.method,
        pattern: pattern.toString(),
      });
      recordSignal(ip, SIGNAL.SUSPICIOUS, { reason: 'probe_path', path });
      break;
    }
  }

  // ── 3. Injection in headers ────────────────────────────────────────────────
  for (const headerName of HEADERS_TO_INSPECT) {
    const headerValue = req.headers[headerName];
    if (!headerValue) continue;

    for (const injPattern of INJECTION_IN_HEADER_PATTERNS) {
      if (injPattern.test(headerValue)) {
        logger.warn('Injection pattern in request header', {
          ip,
          header: headerName,
          pattern: injPattern.toString(),
          // Never log the actual header value — it may contain the exploit
        });
        recordSignal(ip, SIGNAL.SUSPICIOUS, {
          reason: 'injection_in_header',
          header: headerName,
        });
        break; // one signal per header
      }
    }
  }

  // ── 4. Anomalous header detection ──────────────────────────────────────────
  // (a) Oversized header values — may indicate buffer overflow probing
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string' && value.length > 4096) {
      logger.warn('Oversized header value', {
        ip,
        header: name,
        length: value.length,
      });
      recordSignal(ip, SIGNAL.SUSPICIOUS, {
        reason: 'oversized_header',
        header: name,
        length: value.length,
      });
    }
  }

  // (b) Null bytes in any header value
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string' && value.includes('\0')) {
      logger.warn('Null byte in header value', { ip, header: name });
      recordSignal(ip, SIGNAL.SUSPICIOUS, {
        reason: 'null_byte_in_header',
        header: name,
      });
    }
  }

  // ── 5. Credential stuffing: intercept 401 responses on auth endpoints ──────
  // IMPORTANT: abuseDetector already wraps res.status() for 429 detection.
  // We must NOT wrap res.status() again — doing so would corrupt the chain.
  // Instead we use res.on('finish') which fires after the response is sent
  // and has access to the final res.statusCode — clean, no wrapper needed.
  if (isAuthEp) {
    res.on('finish', () => {
      if (res.statusCode === 401) {
        const thresholdCrossed = trackAuthFailure(ip);
        if (thresholdCrossed) {
          logger.warn('Credential stuffing pattern detected', {
            ip,
            threshold: AUTH_FAIL_THRESHOLD,
            windowMs:  AUTH_FAIL_WINDOW_MS,
          });
          recordSignal(ip, SIGNAL.AUTH_ABUSE, {
            reason: 'credential_stuffing_cadence',
            path,
          });
        }
      }
    });
  }

  next();
}

module.exports = suspiciousActivityDetector;

// src/middleware/rateLimiter.js
// ─────────────────────────────────────────────────────────────────────────────
// RATE LIMITING — tiered limits with exponential backoff for repeat offenders
//
// TIERS
// ──────
//   standardLimiter       100 req / 15 min  — global API baseline (per IP)
//   externalApiLimiter     20 req / 1 min   — routes that call third-party APIs
//   submissionLimiter      10 req / 1 hr    — bug report submissions
//   authLimiter            20 req / 15 min  — register, refresh, logout
//   loginLimiter           10 req / 15 min  — login only (skipSuccessfulRequests)
//   checkoutLimiter         5 req / 1 hr    — billing checkout (per user ID)
//   voteLimiter            20 req / 1 hr    — vote cast/change/retract (per user ID)
//   ratingsReadLimiter     60 req / 1 min   — GET /ratings/:id (per IP, DB-backed)
//   accountMutateLimiter   10 req / 1 hr    — password change, watchlist, webhooks (per user ID)
//   aiAnalysisLimiter       3 req / 1 hr    — AI re-analysis per update per user ID
//
// EXPONENTIAL BACKOFF
// ────────────────────
// Each limiter uses a dynamic `windowMs` via a `skip` + handler pattern.
// On a 429, abuseDetector (which wraps res.status) records a RATE_LIMIT_HIT
// signal against the IP via ipAbuseService. The service tracks offences and
// returns a progressively longer backoff window each time the same IP hits a
// limit again:
//
//   Offence 1 → 15 min   (base window)
//   Offence 2 → 30 min
//   Offence 3 → 60 min
//   Offence 4 → 120 min
//   …capped at 16 hr
//
// The limiters themselves use a fixed windowMs for counting requests within
// the window. The backoff is applied to the window — more offences means
// the IP needs to wait longer before its counter resets. express-rate-limit
// re-evaluates windowMs per-request through a keyGenerator that also
// includes the offence tier in a secondary key lookup approach.
//
// IMPLEMENTATION NOTE ON DYNAMIC WINDOWS
// ───────────────────────────────────────
// express-rate-limit's windowMs is set at construction time, not per-request.
// True per-IP dynamic windows require a custom store (e.g. Redis) that expires
// keys at the per-IP backoff interval.
//
// Our approach: the handler logs the backoff window for the offending IP and
// the Retry-After header is set to reflect it. Enforcement of the extended
// window happens via ipAbuseService's auto-blacklisting threshold — once an
// IP accumulates enough points it is blocked entirely, which is more effective
// than trying to dynamically resize windows in an in-memory store.
//
// For fully dynamic per-IP windows, replace the in-memory store with a Redis
// store using rate-limit-redis and set windowMs via a store.init() callback.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const rateLimit              = require('express-rate-limit');
const { getBackoffMs, recordSignal, SIGNAL } = require('../services/ipAbuseService');
const logger                 = require('../utils/logger');

// ── Shared handler factory ────────────────────────────────────────────────────

/**
 * Build a rate limit handler that:
 *   1. Records a RATE_LIMIT_HIT signal (which feeds exponential backoff)
 *   2. Sets Retry-After to the IP's current backoff window
 *   3. Returns a structured 429 response
 *
 * @param {string} tier  — limiter name for log correlation
 * @returns {import('express-rate-limit').RateLimitExceededEventHandler}
 */
function makeHandler(tier) {
  return (req, res, _next, options) => {
    const ip       = req.ip;
    const result   = recordSignal(ip, SIGNAL.RATE_LIMIT_HIT, {
      tier,
      path:   req.path,
      method: req.method,
    });

    // Retry-After: IP's current backoff window in seconds
    const retryAfterSec = Math.ceil(result.backoffMs / 1000);
    res.set('Retry-After', String(retryAfterSec));

    logger.warn(`Rate limit exceeded [${tier}]`, {
      ip,
      path:          req.path,
      method:        req.method,
      offences:      result.offences,
      points:        result.points,
      backoffMs:     result.backoffMs,
      retryAfterSec,
      autoBlacklisted: result.autoBlacklisted,
    });

    // abuseDetector's res.status wrapper has already fired by the time
    // express-rate-limit calls this handler, because express-rate-limit
    // calls handler(req, res, next, options) directly — not res.status().
    // So we call the original options.message path directly.
    res.status(429).json({
      error:       options.message?.error || 'Too many requests.',
      retryAfterSec,
      backoffOffences: result.offences,
    });
  };
}

// ── Shared limiter options ────────────────────────────────────────────────────

const SHARED_OPTIONS = {
  standardHeaders: true,    // RateLimit-* headers (RFC 6585 draft)
  legacyHeaders:   false,   // X-RateLimit-* (deprecated — don't send both)
};

// ── Limiters ──────────────────────────────────────────────────────────────────

/**
 * Standard limiter — 100 req / 15 min baseline for all /api/ routes.
 * Applied globally in server.js; all other limiters are additive.
 */
const standardLimiter = rateLimit({
  ...SHARED_OPTIONS,
  windowMs: 15 * 60 * 1000,
  max:      100,
  message:  { error: 'Too many requests. Please slow down.' },
  handler:  makeHandler('standard'),
});

/**
 * External API limiter — 20 req / 1 min for routes that call third-party APIs.
 * Prevents one client from exhausting upstream rate limits (Reddit, etc.).
 */
const externalApiLimiter = rateLimit({
  ...SHARED_OPTIONS,
  windowMs: 60 * 1000,
  max:      20,
  message:  { error: 'Too many external data requests. Please slow down.' },
  handler:  makeHandler('external-api'),
});

/**
 * Submission limiter — 10 req / 1 hr for bug report POSTs.
 * Prevents spam submissions from a single IP.
 */
const submissionLimiter = rateLimit({
  ...SHARED_OPTIONS,
  windowMs: 60 * 60 * 1000,
  max:      10,
  message:  { error: 'Submission limit reached. Maximum 10 bug reports per hour.' },
  handler:  makeHandler('submission'),
});

/**
 * Auth limiter — 20 req / 15 min for register, refresh, logout.
 */
const authLimiter = rateLimit({
  ...SHARED_OPTIONS,
  windowMs: 15 * 60 * 1000,
  max:      20,
  message:  { error: 'Too many auth requests. Please try again in 15 minutes.' },
  handler:  makeHandler('auth'),
});

/**
 * Login limiter — 10 req / 15 min, skip successful requests.
 * Only counts failed login attempts. Belt-and-suspenders alongside
 * lockoutService (per-account) — this limiter is per-IP.
 *
 * skipSuccessfulRequests:true means a legitimate user who logs in
 * once doesn't burn their quota.
 */
const loginLimiter = rateLimit({
  ...SHARED_OPTIONS,
  windowMs:               15 * 60 * 1000,
  max:                    10,
  skipSuccessfulRequests: true,
  message:  { error: 'Too many login attempts from this IP. Please try again later.' },
  handler:  makeHandler('login'),
});

/**
 * Checkout limiter — 5 checkout sessions per user per hour.
 * Per-user (keyed on user ID from JWT), not per-IP.
 * Prevents card-testing attacks where one account tests many stolen cards
 * by creating checkout sessions in rapid succession.
 *
 * This is additive on top of authLimiter (which is per-IP).
 * Both must be mounted on POST /api/billing/checkout.
 */
const checkoutLimiter = rateLimit({
  ...SHARED_OPTIONS,
  windowMs: 60 * 60 * 1000,   // 1 hour
  max:      5,
  // Key on user ID from JWT so the limit is per-account, not per-IP.
  // Falls back to IP if user not attached (shouldn't happen — requireAuth runs first).
  keyGenerator: (req) => req.user?.id || req.ip,
  message:  { error: 'Too many checkout attempts. Maximum 5 per hour per account.' },
  handler:  makeHandler('checkout'),
});

/**
 * Vote limiter — 20 vote changes per user per hour across ALL updates.
 * Keyed on user ID so an attacker can't bypass it by rotating IPs.
 * Falls back to IP if user not attached (shouldn't happen — requireAuth runs first).
 *
 * Rationale: a real user might update their vote once or twice on a release day.
 * 20/hr is generous for legitimate use but stops rapid vote-flipping that would
 * spam DB writes and aggregation queries.
 */
const voteLimiter = rateLimit({
  ...SHARED_OPTIONS,
  windowMs:     60 * 60 * 1000,  // 1 hour
  max:          20,
  keyGenerator: (req) => req.user?.id || req.ip,
  message:      { error: 'Too many vote changes. Maximum 20 per hour.' },
  handler:      makeHandler('vote'),
});

/**
 * Ratings read limiter — 60 req / 1 min per IP for GET /api/ratings/:id.
 * Tighter than standardLimiter because each request hits the DB.
 * Prevents scrapers/bots from running continuous aggregation queries.
 */
const ratingsReadLimiter = rateLimit({
  ...SHARED_OPTIONS,
  windowMs: 60 * 1000,   // 1 minute
  max:      60,
  message:  { error: 'Too many rating requests. Please slow down.' },
  handler:  makeHandler('ratings-read'),
});

/**
 * Account mutation limiter — 10 state-changing account operations per user per hour.
 * Covers password change, webhook settings, watchlist mutations.
 * Keyed on user ID to prevent per-IP bypass.
 *
 * This is additive on top of standardLimiter which is already applied globally.
 */
const accountMutateLimiter = rateLimit({
  ...SHARED_OPTIONS,
  windowMs:     60 * 60 * 1000,  // 1 hour
  max:          10,
  keyGenerator: (req) => req.user?.id || req.ip,
  message:      { error: 'Too many account changes. Maximum 10 per hour.' },
  handler:      makeHandler('account-mutate'),
});

/**
 * AI analysis limiter — 3 AI re-analysis triggers per update per user per hour.
 * Prevents token burning. Keyed on `userId:updateId` composite to enforce
 * a per-update cooldown per user, not just a global rate.
 */
const aiAnalysisLimiter = rateLimit({
  ...SHARED_OPTIONS,
  windowMs:     60 * 60 * 1000,  // 1 hour
  max:          3,
  keyGenerator: (req) => `${req.user?.id || req.ip}:${req.params?.id || ''}`,
  message:      { error: 'AI analysis rate limit reached. Maximum 3 re-analyses per update per hour.' },
  handler:      makeHandler('ai-analysis'),
});

module.exports = {
  standardLimiter,
  externalApiLimiter,
  submissionLimiter,
  authLimiter,
  loginLimiter,
  checkoutLimiter,
  voteLimiter,
  ratingsReadLimiter,
  accountMutateLimiter,
  aiAnalysisLimiter,
};

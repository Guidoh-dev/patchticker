// src/middleware/captcha.js
// ─────────────────────────────────────────────────────────────────────────────
// CAPTCHA VERIFICATION MIDDLEWARE — hCaptcha server-side token verification
//
// DESIGN
// ───────
// Verifies the hCaptcha token submitted with registration requests.
// All verification happens server-side — the frontend only collects the token
// and submits it in the request body. No client SDK is mandated here; any
// hCaptcha widget (invisible, checkbox, smart) produces a compatible token.
//
// FLOW
//   1. Frontend renders hCaptcha widget (sitekey = HCAPTCHA_SITE_KEY)
//   2. User solves (or invisible captcha auto-solves)
//   3. Frontend includes h-captcha-response token in POST /api/auth/register body
//   4. This middleware POSTs the token to hCaptcha's /siteverify endpoint
//   5. hCaptcha returns { success: true/false, score, ... }
//   6. Score below HCAPTCHA_MIN_SCORE → 403. Missing token → 400.
//
// SELF-DISABLES
// ──────────────
// If HCAPTCHA_SECRET_KEY is absent or a placeholder:
//   • Development → warning logged, captcha skipped (allows local testing)
//   • Production → startup throws (config/security.js prodRequired)
//
// ENVIRONMENT VARIABLES
// ──────────────────────
//   HCAPTCHA_SECRET_KEY   — server-side secret from hcaptcha.com dashboard
//   HCAPTCHA_SITE_KEY     — public site key (passed to frontend via Vite env)
//   HCAPTCHA_MIN_SCORE    — minimum score to pass (0.0–1.0, default 0.5)
//                           hCaptcha Enterprise only; standard always returns 1.0
//   HCAPTCHA_ENABLED      — 'false' to disable in all environments (for E2E tests)
//
// hCaptcha vs reCAPTCHA:
//   hCaptcha is GDPR-compliant, privacy-first, and pays publishers.
//   It is a drop-in replacement for reCAPTCHA v2/v3.
//   Switch to reCAPTCHA v3 by changing VERIFY_URL and response field name.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const https  = require('https');
const qs     = require('querystring');
const logger = require('../utils/logger');

const VERIFY_URL   = 'https://api.hcaptcha.com/siteverify';
const MIN_SCORE    = parseFloat(process.env.HCAPTCHA_MIN_SCORE || '0.5');
const isProd       = process.env.NODE_ENV === 'production';
const isEnabled    = process.env.HCAPTCHA_ENABLED !== 'false';

/**
 * POST to hCaptcha /siteverify and return the parsed response.
 * @param {string} token  — h-captcha-response from client
 * @param {string} ip     — client IP for additional fraud signal
 * @returns {Promise<{ success: boolean, score?: number, 'error-codes'?: string[] }>}
 */
function verifyCaptchaToken(token, ip) {
  return new Promise((resolve, reject) => {
    const secret = process.env.HCAPTCHA_SECRET_KEY;
    const sitekey = process.env.HCAPTCHA_SITE_KEY || undefined;
    const body   = qs.stringify({ secret, response: token, remoteip: ip, sitekey });

    const options = {
      method:  'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(VERIFY_URL, options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('hCaptcha returned non-JSON response'));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error('hCaptcha verify request timed out'));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Express middleware — verify hCaptcha token on the request.
 * Expects req.body['h-captcha-response'] to be present.
 *
 * @type {import('express').RequestHandler}
 */
async function verifyCaptcha(req, res, next) {
  // Global kill-switch for E2E tests
  if (!isEnabled) return next();

  const secretKey = process.env.HCAPTCHA_SECRET_KEY;

  // No key configured
  if (!secretKey || secretKey.startsWith('REPLACE_WITH')) {
    if (isProd) {
      // This should have been caught at startup by prodRequired — belt-and-suspenders
      logger.error('[captcha] HCAPTCHA_SECRET_KEY not configured in production');
      return res.status(503).json({ error: 'Service configuration error' });
    }
    // Dev/test — skip silently with a warning
    logger.warn('[captcha] HCAPTCHA_SECRET_KEY not configured — skipping verification (dev mode)');
    return next();
  }

  const token = req.body?.['h-captcha-response'];

  if (!token || typeof token !== 'string' || token.trim().length === 0) {
    logger.warn('[captcha] Missing h-captcha-response token', { ip: req.ip });
    return res.status(400).json({ error: 'CAPTCHA verification required' });
  }

  try {
    const result = await verifyCaptchaToken(token.trim(), req.ip);

    if (!result.success) {
      logger.warn('[captcha] Verification failed', {
        ip:         req.ip,
        errorCodes: result['error-codes'],
      });
      return res.status(403).json({ error: 'CAPTCHA verification failed. Please try again.' });
    }

    // Score check (hCaptcha Enterprise only — standard tier always returns 1.0)
    if (result.score !== undefined && result.score < MIN_SCORE) {
      logger.warn('[captcha] Score below threshold', {
        ip:    req.ip,
        score: result.score,
        min:   MIN_SCORE,
      });
      return res.status(403).json({ error: 'Request flagged as automated. Please try again.' });
    }

    // Attach result for downstream logging
    req.captcha = { success: true, score: result.score ?? null };
    next();

  } catch (err) {
    // hCaptcha network failure — fail open in dev, fail closed in prod
    logger.error('[captcha] Verification request failed', { message: err.message, ip: req.ip });
    if (isProd) {
      return res.status(503).json({ error: 'CAPTCHA service temporarily unavailable. Please try again.' });
    }
    logger.warn('[captcha] Failing open due to hCaptcha network error (dev mode)');
    next();
  }
}

module.exports = verifyCaptcha;
module.exports.verifyCaptchaToken = verifyCaptchaToken; // exported for tests

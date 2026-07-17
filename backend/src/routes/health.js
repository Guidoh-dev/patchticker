// src/routes/health.js
// ─────────────────────────────────────────────────────────────────────────────
// HEALTH & OBSERVABILITY ENDPOINTS
//
//   GET  /api/health          — basic liveness probe (public)
//   GET  /api/health/ready    — readiness probe: DB + alerting (internal/ops)
//   GET  /api/health/alerts   — spike counters + alert cooldown status (ops)
//
// SECURITY
// ─────────
//   /api/health          — no auth (load balancer liveness probe)
//   /api/health/ready    — no auth but no sensitive data (just up/down)
//   /api/health/alerts   — protected by HEALTH_SECRET header in production.
//                          Set HEALTH_SECRET to a random token; pass it as
//                          X-Health-Secret: <token> from ops tooling/dashboards.
//                          Falls through (403) if wrong or missing in production.
//
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express     = require('express');
const router      = express.Router();
const validate    = require('../middleware/validate');
const { HealthQuerySchema } = require('../validators/schemas');
const db          = require('../config/db');
const { getEventCount, getCooldownStatus, ALERT_TYPE, SPIKE_CONFIG } = require('../utils/alerting');
const { timingSafeEqual } = require('../config/secrets');

const isProd = process.env.NODE_ENV === 'production';

// ── Internal auth guard ───────────────────────────────────────────────────────
// Protects the detailed /ready and /alerts endpoints in production.
// Uses timing-safe comparison to prevent timing attacks on the secret.

function requireHealthSecret(req, res, next) {
  if (!isProd) return next(); // allow in dev/test without a secret

  const secret = process.env.HEALTH_SECRET;
  if (!secret || secret.startsWith('REPLACE_WITH')) {
    // No secret configured — deny access in production (fail closed)
    return res.status(503).json({ error: 'Health endpoint not configured' });
  }

  const provided = req.headers['x-health-secret'] || '';
  // timingSafeEqual prevents length-leaking timing attacks
  if (!timingSafeEqual(provided, secret)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  next();
}

// ── GET /api/health — liveness probe ─────────────────────────────────────────
// Simple: returns 200 if the process is running. No auth, no DB check.
// Used by load balancers, Docker HEALTHCHECK, Kubernetes liveness probe.

router.get(
  '/',
  validate({ query: HealthQuerySchema }),
  (req, res) => {
    res.json({
      status:    'ok',
      uptime:    Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      // env only exposed in non-production (leaks deployment context)
      ...(isProd ? {} : { env: process.env.NODE_ENV }),
    });
  }
);

// ── GET /api/health/ready — readiness probe ────────────────────────────────────
// Checks that external dependencies (DB) are reachable.
// Kubernetes readiness probe: returns 503 if not ready to serve traffic.

router.get(
  '/ready',
  requireHealthSecret,
  async (req, res) => {
    const checks = {};
    let allOk    = true;

    // Database check
    if (db.isAvailable()) {
      try {
        await db.query('SELECT 1');
        checks.database = { status: 'ok' };
      } catch (err) {
        checks.database = { status: 'error', message: 'Query failed' };
        allOk = false;
      }
    } else {
      checks.database = { status: 'not_configured' };
    }

    const status  = allOk ? 'ready' : 'not_ready';
    const code    = allOk ? 200 : 503;

    res.status(code).json({
      status,
      uptime:    Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      checks,
    });
  }
);

// ── GET /api/health/alerts — spike counters + alert status ────────────────────
// Ops dashboard endpoint: current spike counts and alert cooldown status.
// Shows whether alert webhooks are in cooldown and current event rates.

router.get(
  '/alerts',
  requireHealthSecret,
  (req, res) => {
    // Spike event counts (events in the current sliding window)
    const spikeCounts = {};
    for (const type of Object.keys(SPIKE_CONFIG)) {
      const cfg   = SPIKE_CONFIG[type];
      const count = getEventCount(type);
      spikeCounts[type] = {
        count,
        threshold: cfg.threshold,
        windowMs:  cfg.windowMs,
        ratio:     `${count}/${cfg.threshold}`,
      };
    }

    res.json({
      timestamp:    new Date().toISOString(),
      uptime:       Math.floor(process.uptime()),
      pid:          process.pid,
      environment:  process.env.NODE_ENV,
      // Current spike counts vs thresholds
      spikeCounters: spikeCounts,
      // Alert cooldown status — which alerts have fired recently
      alertCooldowns: getCooldownStatus(),
      // Configuration summary (not secrets)
      alertConfig: {
        webhookConfigured:  Boolean(process.env.ALERT_WEBHOOK_URL && !process.env.ALERT_WEBHOOK_URL.startsWith('REPLACE_WITH')),
        webhookType:        process.env.ALERT_WEBHOOK_TYPE || 'generic',
        logtailConfigured:  Boolean(process.env.LOGTAIL_TOKEN && !process.env.LOGTAIL_TOKEN.startsWith('REPLACE_WITH')),
        sentryConfigured:   Boolean(process.env.SENTRY_DSN && !process.env.SENTRY_DSN.startsWith('REPLACE_WITH')),
      },
    });
  }
);

module.exports = router;

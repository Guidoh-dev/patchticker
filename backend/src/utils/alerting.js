// src/utils/alerting.js
// ─────────────────────────────────────────────────────────────────────────────
// ALERTING — typed alerts dispatched to Slack, PagerDuty, or generic webhooks
//
// WHAT THIS MODULE DOES
// ──────────────────────
//  Provides a fire-and-forget alert() function that:
//    1. Logs the alert at the appropriate level (so it always hits the files
//       and any external log service regardless of webhook config)
//    2. Dispatches to the configured webhook (Slack/PagerDuty/generic)
//    3. Rate-limits: each alert TYPE has a cooldown window so one bad burst
//       doesn't flood your Slack channel
//
//  Also provides spike counters for server-side metrics:
//    trackEvent() — increment a named counter
//    checkThreshold() — returns true if counter exceeds threshold in window
//  These are used by httpLogger and server.js to detect 5xx spikes, blacklist
//  spikes, and auth-abuse spikes, and fire alerts when thresholds are crossed.
//
// ALERT TYPES
// ────────────
//   CRASH             — uncaughtException or unhandledRejection
//   STARTUP_FAILURE   — server failed to start (DB down, misconfiguration)
//   SPIKE_5XX         — > N 5xx responses in M minutes
//   SPIKE_BLACKLIST   — > N auto-blacklist events in M minutes
//   SPIKE_AUTH_ABUSE  — > N failed-login events in M minutes
//   SPIKE_RATE_LIMIT  — > N rate-limit hits in M minutes
//   DB_ERROR          — database connection lost or repeated query failures
//
// WEBHOOK CONFIGURATION
// ──────────────────────
//   ALERT_WEBHOOK_URL  — full URL (Slack incoming webhook, PagerDuty, or custom)
//   ALERT_WEBHOOK_TYPE — 'slack' | 'pagerduty' | 'generic'  (default: 'generic')
//
//   Slack:     ALERT_WEBHOOK_URL=https://hooks.slack.com/services/T.../B.../xxx
//   PagerDuty: ALERT_WEBHOOK_URL=https://events.pagerduty.com/v2/enqueue
//              ALERT_PAGERDUTY_KEY=<integration key>
//
// RATE LIMITING
// ──────────────
//   Each alert type has an independent cooldown. If an alert fires during a
//   cooldown, it is logged (so the event is never lost) but the webhook is
//   not called again until the cooldown expires. This prevents alert fatigue
//   and webhook rate-limit bans during incident floods.
//
//   Defaults:
//     CRASH            — cooldown 5 min  (every crash is significant)
//     SPIKE_*          — cooldown 15 min (one alert per spike window)
//     STARTUP_FAILURE  — cooldown 1 min  (retries during restart loops)
//     DB_ERROR         — cooldown 10 min
//
// SPIKE DETECTION
// ────────────────
//   trackEvent(type) increments a sliding-window counter.
//   checkThreshold(type) compares against configured thresholds:
//
//     ALERT_THRESHOLD_5XX        (default: 10 events in 2 minutes)
//     ALERT_THRESHOLD_BLACKLIST  (default: 5  events in 5 minutes)
//     ALERT_THRESHOLD_AUTH_ABUSE (default: 20 events in 5 minutes)
//     ALERT_THRESHOLD_RATE_LIMIT (default: 50 events in 1 minute)
//
//   Call trackEvent() on each relevant event and checkThreshold() to decide
//   whether to fire an alert. See httpLogger.js and server.js for usage.
//
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const https  = require('https');
const http   = require('http');
const logger = require('./logger');

// ── Alert type constants ──────────────────────────────────────────────────────

const ALERT_TYPE = Object.freeze({
  CRASH:            'CRASH',
  STARTUP_FAILURE:  'STARTUP_FAILURE',
  SPIKE_5XX:        'SPIKE_5XX',
  SPIKE_BLACKLIST:  'SPIKE_BLACKLIST',
  SPIKE_AUTH_ABUSE: 'SPIKE_AUTH_ABUSE',
  SPIKE_RATE_LIMIT: 'SPIKE_RATE_LIMIT',
  DB_ERROR:         'DB_ERROR',
});

// ── Severity levels ───────────────────────────────────────────────────────────

const SEVERITY = Object.freeze({
  CRITICAL: 'critical',
  ERROR:    'error',
  WARNING:  'warning',
  INFO:     'info',
});

// Default severity per alert type
const DEFAULT_SEVERITY = {
  [ALERT_TYPE.CRASH]:            SEVERITY.CRITICAL,
  [ALERT_TYPE.STARTUP_FAILURE]:  SEVERITY.CRITICAL,
  [ALERT_TYPE.SPIKE_5XX]:        SEVERITY.ERROR,
  [ALERT_TYPE.SPIKE_BLACKLIST]:  SEVERITY.WARNING,
  [ALERT_TYPE.SPIKE_AUTH_ABUSE]: SEVERITY.WARNING,
  [ALERT_TYPE.SPIKE_RATE_LIMIT]: SEVERITY.WARNING,
  [ALERT_TYPE.DB_ERROR]:         SEVERITY.ERROR,
};

// ── Cooldown configuration (ms) ───────────────────────────────────────────────

const COOLDOWNS = {
  [ALERT_TYPE.CRASH]:            5  * 60 * 1000,
  [ALERT_TYPE.STARTUP_FAILURE]:  1  * 60 * 1000,
  [ALERT_TYPE.SPIKE_5XX]:        15 * 60 * 1000,
  [ALERT_TYPE.SPIKE_BLACKLIST]:  15 * 60 * 1000,
  [ALERT_TYPE.SPIKE_AUTH_ABUSE]: 15 * 60 * 1000,
  [ALERT_TYPE.SPIKE_RATE_LIMIT]: 15 * 60 * 1000,
  [ALERT_TYPE.DB_ERROR]:         10 * 60 * 1000,
};

// Map<alertType → lastFiredAt (ms timestamp)>
const _lastFired = new Map();

// ── Spike detection counters ──────────────────────────────────────────────────
// Sliding-window event counters. Each counter tracks events in a rolling window.

const SPIKE_CONFIG = {
  [ALERT_TYPE.SPIKE_5XX]: {
    threshold: parseInt(process.env.ALERT_THRESHOLD_5XX        || '10', 10),
    windowMs:  2 * 60 * 1000,   // 2 minutes
  },
  [ALERT_TYPE.SPIKE_BLACKLIST]: {
    threshold: parseInt(process.env.ALERT_THRESHOLD_BLACKLIST  || '5',  10),
    windowMs:  5 * 60 * 1000,
  },
  [ALERT_TYPE.SPIKE_AUTH_ABUSE]: {
    threshold: parseInt(process.env.ALERT_THRESHOLD_AUTH_ABUSE || '20', 10),
    windowMs:  5 * 60 * 1000,
  },
  [ALERT_TYPE.SPIKE_RATE_LIMIT]: {
    threshold: parseInt(process.env.ALERT_THRESHOLD_RATE_LIMIT || '50', 10),
    windowMs:  1 * 60 * 1000,   // 1 minute
  },
};

// Map<alertType → number[]>  (arrays of event timestamps)
const _counters = new Map(
  Object.keys(SPIKE_CONFIG).map(k => [k, []])
);

/**
 * Record an event for spike detection.
 * Returns true if the threshold was just crossed (alert should fire).
 *
 * @param {string} type  — one of ALERT_TYPE.SPIKE_*
 * @returns {boolean}  true = threshold just crossed, caller should call alert()
 */
function trackEvent(type) {
  const cfg = SPIKE_CONFIG[type];
  if (!cfg) return false;

  const now    = Date.now();
  const bucket = _counters.get(type);

  // Add current event, prune old ones outside the window
  bucket.push(now);
  const cutoff = now - cfg.windowMs;
  while (bucket.length > 0 && bucket[0] < cutoff) bucket.shift();

  return bucket.length >= cfg.threshold;
}

/**
 * Get the current event count for a spike type (for diagnostics).
 * @param {string} type
 * @returns {number}
 */
function getEventCount(type) {
  const cfg = SPIKE_CONFIG[type];
  if (!cfg) return 0;
  const now    = Date.now();
  const bucket = _counters.get(type);
  const cutoff = now - cfg.windowMs;
  return bucket.filter(t => t >= cutoff).length;
}

// ── Webhook formatters ────────────────────────────────────────────────────────

/**
 * Format an alert payload for Slack.
 * @param {string} type
 * @param {string} message
 * @param {object} meta
 * @param {string} severity
 * @returns {object}  Slack Block Kit payload
 */
function _formatSlack(type, message, meta, severity) {
  const emoji = {
    [SEVERITY.CRITICAL]: ':rotating_light:',
    [SEVERITY.ERROR]:    ':red_circle:',
    [SEVERITY.WARNING]:  ':warning:',
    [SEVERITY.INFO]:     ':information_source:',
  }[severity] || ':bell:';

  const colour = {
    [SEVERITY.CRITICAL]: '#FF0000',
    [SEVERITY.ERROR]:    '#FF6B00',
    [SEVERITY.WARNING]:  '#FFB800',
    [SEVERITY.INFO]:     '#0088FF',
  }[severity] || '#808080';

  const metaLines = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `*${k}:* ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('\n');

  return {
    attachments: [{
      color: colour,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${emoji} *[${severity.toUpperCase()}] ${type}*\n${message}`,
          },
        },
        metaLines && {
          type: 'section',
          text: { type: 'mrkdwn', text: metaLines },
        },
        {
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            text: `*Service:* patchticker-api · *Env:* ${process.env.NODE_ENV} · *PID:* ${process.pid} · *Time:* ${new Date().toISOString()}`,
          }],
        },
      ].filter(Boolean),
    }],
  };
}

/**
 * Format an alert payload for PagerDuty Events v2 API.
 * Requires ALERT_PAGERDUTY_KEY integration key.
 */
function _formatPagerDuty(type, message, meta, severity) {
  const pd_severity = {
    [SEVERITY.CRITICAL]: 'critical',
    [SEVERITY.ERROR]:    'error',
    [SEVERITY.WARNING]:  'warning',
    [SEVERITY.INFO]:     'info',
  }[severity] || 'warning';

  return {
    routing_key:  process.env.ALERT_PAGERDUTY_KEY || '',
    event_action: 'trigger',
    dedup_key:    `patchticker-${type.toLowerCase()}`,
    payload: {
      summary:        `[${type}] ${message}`,
      severity:       pd_severity,
      source:         `patchticker-api/${process.env.NODE_ENV}`,
      timestamp:      new Date().toISOString(),
      custom_details: {
        ...meta,
        pid:         process.pid,
        environment: process.env.NODE_ENV,
      },
    },
  };
}

/**
 * Generic JSON payload (works with most custom webhooks).
 */
function _formatGeneric(type, message, meta, severity) {
  return {
    type,
    severity,
    message,
    service:     'patchticker-api',
    environment: process.env.NODE_ENV,
    pid:         process.pid,
    timestamp:   new Date().toISOString(),
    ...meta,
  };
}

// ── HTTP dispatch ─────────────────────────────────────────────────────────────

/**
 * Send a JSON payload to a URL. Fire-and-forget.
 * @param {string} url
 * @param {object} body
 */
function _dispatch(url, body) {
  try {
    const parsed  = new URL(url);
    const payload = JSON.stringify(body);
    const mod     = parsed.protocol === 'https:' ? https : http;

    const req = mod.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent':     'PatchTicker-Alerting/1.0',
      },
    });

    req.on('error',   () => { /* swallow — webhook outage must not affect app */ });
    req.on('response', (res) => {
      res.resume(); // drain the response body so the socket is freed
    });
    req.setTimeout(8000, () => req.destroy());
    req.write(payload);
    req.end();
  } catch {
    // Invalid URL or other sync error — log and continue
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fire an alert. Always logs the event; dispatches to the webhook if
 * configured and not in cooldown.
 *
 * @param {string} type        — one of ALERT_TYPE.*
 * @param {string} message     — human-readable description
 * @param {object} [meta={}]   — additional structured context
 */
function alert(type, message, meta = {}) {
  const severity = DEFAULT_SEVERITY[type] || SEVERITY.WARNING;
  const logLevel = severity === SEVERITY.CRITICAL || severity === SEVERITY.ERROR
    ? 'error' : 'warn';

  // Always log — the event is never lost even if webhook is not configured
  logger[logLevel](`ALERT [${type}]: ${message}`, {
    alertType: type,
    severity,
    ...meta,
  });

  const webhookUrl = process.env.ALERT_WEBHOOK_URL;
  if (!webhookUrl || webhookUrl.startsWith('REPLACE_WITH')) return;

  // Cooldown check
  const cooldown    = COOLDOWNS[type] || 15 * 60 * 1000;
  const lastFiredAt = _lastFired.get(type) || 0;
  const now         = Date.now();

  if (now - lastFiredAt < cooldown) {
    // Still in cooldown — logged above, skip webhook
    logger.debug(`Alert [${type}] suppressed (cooldown: ${Math.round((cooldown - (now - lastFiredAt)) / 1000)}s remaining)`);
    return;
  }

  _lastFired.set(type, now);

  // Format payload based on webhook type
  const webhookType = (process.env.ALERT_WEBHOOK_TYPE || 'generic').toLowerCase();
  let payload;
  if (webhookType === 'slack') {
    payload = _formatSlack(type, message, meta, severity);
  } else if (webhookType === 'pagerduty') {
    payload = _formatPagerDuty(type, message, meta, severity);
  } else {
    payload = _formatGeneric(type, message, meta, severity);
  }

  _dispatch(webhookUrl, payload);
}

/**
 * Reset a cooldown (for testing or after manual acknowledgement).
 * @param {string} type
 */
function resetCooldown(type) {
  _lastFired.delete(type);
}

/**
 * Get the current cooldown status for all alert types (for diagnostics).
 * @returns {object}
 */
function getCooldownStatus() {
  const now = Date.now();
  return Object.fromEntries(
    Object.values(ALERT_TYPE).map(type => {
      const lastFiredAt = _lastFired.get(type) || 0;
      const cooldown    = COOLDOWNS[type] || 0;
      const remaining   = Math.max(0, cooldown - (now - lastFiredAt));
      return [type, {
        lastFiredAt: lastFiredAt ? new Date(lastFiredAt).toISOString() : null,
        cooldownMs:  cooldown,
        remainingMs: remaining,
        active:      remaining > 0,
      }];
    })
  );
}

module.exports = {
  alert,
  trackEvent,
  getEventCount,
  resetCooldown,
  getCooldownStatus,
  ALERT_TYPE,
  SEVERITY,
  SPIKE_CONFIG,
  // Internals exposed for testing
  _lastFired,
  _counters,
};

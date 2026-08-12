// src/middleware/httpLogger.js
// ─────────────────────────────────────────────────────────────────────────────
// HTTP ACCESS LOGGING + SPIKE DETECTION
//
// WHAT THIS MODULE PROVIDES
// ──────────────────────────
//   httpLogger        — Morgan middleware piped to Winston (structured JSON)
//   accessLogAnalyser — post-response hook for suspicious pattern detection
//                       and spike-based alerting
//
// STRUCTURED ACCESS LOG
// ──────────────────────
//   Each HTTP request produces a structured log entry at level 'http':
//     requestId    — from req.requestId (set by requestId middleware)
//     method       — GET, POST, etc.
//     url          — full path including query string
//     statusCode   — numeric HTTP status
//     responseTime — ms (number)
//     contentLength — bytes (number or null)
//     ip           — proxy-aware client IP
//
// POST-RESPONSE ANALYSIS
// ───────────────────────
//   After each response, accessLogAnalyser checks:
//
//   1. SLOW RESPONSE — elapsed > SLOW_RESPONSE_MS → warn log
//
//   2. HIGH-FREQUENCY 4xx PROBING — per-IP counter; threshold crossed
//      → SUSPICIOUS signal to ipAbuseService
//
//   3. 5xx RESPONSE — logged at warn + SPIKE_5XX counter incremented.
//      Threshold crossed → SPIKE_5XX alert (webhook dispatch).
//      Also records SUSPICIOUS signal to ipAbuseService.
//
//   4. RATE LIMIT HIT (429) — SPIKE_RATE_LIMIT counter incremented.
//      Threshold crossed → SPIKE_RATE_LIMIT alert.
//
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const morgan                           = require('morgan');
const logger                           = require('../utils/logger');
const { recordSignal, SIGNAL }         = require('../services/ipAbuseService');
const { alert, trackEvent, ALERT_TYPE } = require('../utils/alerting');

// ── Configuration ─────────────────────────────────────────────────────────────

const SLOW_RESPONSE_MS     = parseInt(process.env.SLOW_RESPONSE_MS     || '2000', 10);
const CLIENT_ERR_THRESHOLD = parseInt(process.env.CLIENT_ERR_THRESHOLD || '20',   10);
const CLIENT_ERR_WINDOW_MS = 5 * 60 * 1000;

// ── Per-IP 4xx tracker ────────────────────────────────────────────────────────
const _clientErrTracker = new Map();

// Low-cardinality, process-local traffic counters. These give operators a
// truthful health snapshot even when the host plan does not expose request
// metrics. Counters reset on deploy/restart and never retain paths, IPs, or
// user identifiers.
const _requestMetrics = {
  startedAt:           new Date().toISOString(),
  total:               0,
  responseTimeTotalMs: 0,
  slowResponses:       0,
  lastRequestAt:       null,
  last5xxAt:           null,
  last429At:           null,
  byStatusClass:       { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
  byMethod:            {},
};

function recordRequestMetric(method, status, elapsed) {
  _requestMetrics.total++;
  _requestMetrics.responseTimeTotalMs += Math.max(0, Number(elapsed) || 0);
  _requestMetrics.lastRequestAt = new Date().toISOString();
  _requestMetrics.byMethod[method] = (_requestMetrics.byMethod[method] || 0) + 1;
  const statusClass = `${Math.floor(status / 100)}xx`;
  if (Object.hasOwn(_requestMetrics.byStatusClass, statusClass)) {
    _requestMetrics.byStatusClass[statusClass]++;
  }
  if (status >= 500) _requestMetrics.last5xxAt = _requestMetrics.lastRequestAt;
  if (status === 429) _requestMetrics.last429At = _requestMetrics.lastRequestAt;
}

function getRequestMetrics() {
  return {
    startedAt:     _requestMetrics.startedAt,
    total:         _requestMetrics.total,
    averageMs:     _requestMetrics.total
      ? Number((_requestMetrics.responseTimeTotalMs / _requestMetrics.total).toFixed(2))
      : 0,
    slowResponses: _requestMetrics.slowResponses,
    lastRequestAt: _requestMetrics.lastRequestAt,
    last5xxAt:     _requestMetrics.last5xxAt,
    last429At:     _requestMetrics.last429At,
    byStatusClass: { ..._requestMetrics.byStatusClass },
    byMethod:      { ..._requestMetrics.byMethod },
  };
}

function resetRequestMetrics() {
  _requestMetrics.startedAt = new Date().toISOString();
  _requestMetrics.total = 0;
  _requestMetrics.responseTimeTotalMs = 0;
  _requestMetrics.slowResponses = 0;
  _requestMetrics.lastRequestAt = null;
  _requestMetrics.last5xxAt = null;
  _requestMetrics.last429At = null;
  _requestMetrics.byStatusClass = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  _requestMetrics.byMethod = {};
}

function trackClientError(ip) {
  const now     = Date.now();
  let   tracker = _clientErrTracker.get(ip);

  if (!tracker || (now - tracker.windowStart) > CLIENT_ERR_WINDOW_MS) {
    tracker = { count: 0, windowStart: now };
    _clientErrTracker.set(ip, tracker);
  }

  tracker.count++;

  if (tracker.count >= CLIENT_ERR_THRESHOLD) {
    _clientErrTracker.delete(ip);
    return true;
  }
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, t] of _clientErrTracker.entries()) {
    if (now - t.windowStart > CLIENT_ERR_WINDOW_MS * 2) _clientErrTracker.delete(ip);
  }
}, 10 * 60 * 1000).unref();

// ── Morgan tokens ─────────────────────────────────────────────────────────────

// Proxy-aware client IP
// In Cloudflare deployments, cloudflare.js middleware has already overridden
// req.ip with CF-Connecting-IP before this token runs. Falling back to
// req.socket?.remoteAddress (not req.connection — deprecated in Node 18+)
// will return the Cloudflare edge IP, not the client; label it accordingly.
morgan.token('client-ip', (req) => {
  if (req.ip) return req.ip;
  const socketIp = req.socket?.remoteAddress;
  return socketIp ? `edge:${socketIp}` : 'unknown';
});
// requestId for correlation
morgan.token('request-id',  (req) => req.requestId || '-');
// Numeric response time (no "ms" suffix — we log it as a number)
morgan.token('response-time-ms', (req, res) => {
  if (!req._startAt || !res._startAt) return '0';
  const ms = (res._startAt[0] - req._startAt[0]) * 1e3
           + (res._startAt[1] - req._startAt[1]) * 1e-6;
  return ms.toFixed(3);
});

// ── Structured Morgan stream ──────────────────────────────────────────────────
// Instead of a format string, we use a custom token that emits a JSON object.
// This keeps the access log consistent with all other log entries.

morgan.token('structured', (req, res) => {
  return JSON.stringify({
    requestId:      req.requestId || undefined,
    method:         req.method,
    // Query values can contain reset/verification tokens or private searches.
    // Paths are sufficient for request diagnostics and traffic measurement.
    url:            String(req.originalUrl || req.url || '').split('?')[0],
    statusCode:     res.statusCode,
    responseTimeMs: parseFloat(
      (() => {
        if (!req._startAt || !res._startAt) return '0';
        const ms = (res._startAt[0] - req._startAt[0]) * 1e3
                 + (res._startAt[1] - req._startAt[1]) * 1e-6;
        return ms.toFixed(3);
      })()
    ),
    contentLength: parseInt(res.getHeader('content-length'), 10) || null,
    ip:            req.ip || (req.socket?.remoteAddress ? `edge:${req.socket.remoteAddress}` : 'unknown'),
  });
});

// The Morgan format string emits a single JSON blob per request.
// Winston's http stream parses it back — keeping one flat JSON object per line.
const _stream = {
  write: (message) => {
    try {
      const parsed = JSON.parse(message.trim());
      logger.http('http request', parsed);
    } catch {
      // Fallback: emit as plain message if JSON parse fails
      logger.http(message.trim());
    }
  },
};

const httpLogger = morgan(':structured', { stream: _stream });

// ── Post-response analyser + spike detection ──────────────────────────────────

/**
 * @type {import('express').RequestHandler}
 */
function accessLogAnalyser(req, res, next) {
  const ip      = req.ip;
  const startAt = Date.now();

  res.on('finish', () => {
    const status  = res.statusCode;
    const elapsed = Date.now() - startAt;
    const path    = req.path;
    const method  = req.method;
    const rid     = req.requestId;

    recordRequestMetric(method, status, elapsed);

    // ── 1. Slow response ──────────────────────────────────────────────────
    if (elapsed > SLOW_RESPONSE_MS) {
      _requestMetrics.slowResponses++;
      logger.warn('Slow response detected', {
        requestId:   rid,
        ip, method, path, status,
        elapsedMs:   elapsed,
        thresholdMs: SLOW_RESPONSE_MS,
      });
    }

    // ── 2. 4xx probing ────────────────────────────────────────────────────
    if (status >= 400 && status < 500 && status !== 429) {
      if (trackClientError(ip)) {
        logger.warn('High-frequency 4xx probing detected', {
          requestId: rid, ip,
          threshold: CLIENT_ERR_THRESHOLD,
          windowMs:  CLIENT_ERR_WINDOW_MS,
          lastPath:  path,
        });
        recordSignal(ip, SIGNAL.SUSPICIOUS, {
          reason: 'high_frequency_4xx', lastPath: path,
        });
      }
    }

    // ── 3. 5xx — log warn + spike counter ────────────────────────────────
    if (status >= 500) {
      logger.warn('5xx response', { requestId: rid, ip, method, path, status });
      // recordSignal accumulates towards auto-blacklist for repeat offenders
      recordSignal(ip, SIGNAL.SUSPICIOUS, { reason: '5xx_response', path, status });
      // Spike detection: threshold → alert (also fires in errorHandler but
      // some 5xx responses may bypass it, e.g. express-rate-limit 500s)
      if (trackEvent(ALERT_TYPE.SPIKE_5XX)) {
        alert(ALERT_TYPE.SPIKE_5XX, '5xx error rate spike', {
          requestId: rid, lastPath: path, ip,
        });
      }
    }

    // ── 4. Rate-limit spike ───────────────────────────────────────────────
    if (status === 429) {
      if (trackEvent(ALERT_TYPE.SPIKE_RATE_LIMIT)) {
        alert(ALERT_TYPE.SPIKE_RATE_LIMIT, 'Rate-limit hit spike detected', {
          requestId: rid, lastPath: path, ip,
        });
      }
    }
  });

  next();
}

module.exports = {
  httpLogger,
  accessLogAnalyser,
  getRequestMetrics,
  _resetRequestMetrics: resetRequestMetrics,
};

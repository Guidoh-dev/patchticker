// src/utils/logger.js
// ─────────────────────────────────────────────────────────────────────────────
// STRUCTURED LOGGING — Winston with JSON (prod) + human-readable (dev)
//
// TRANSPORTS
// ───────────
//   Console          — always active in dev/test; colorised human format
//   error-YYYY.log   — error level only, 14-day rotation
//   security-YYYY.log — warn+ from the security pipeline, 90-day retention
//   combined-YYYY.log — all levels, 7-day rotation
//   Logtail/BetterStack — HTTP transport (prod only), LOGTAIL_TOKEN required
//   Sentry           — error-level only (prod only), SENTRY_DSN required
//                      Errors are sent as Sentry events with full context.
//
// STRUCTURED FORMAT (production / log files)
// ───────────────────────────────────────────
//   Every log line is a JSON object with these guaranteed fields:
//     timestamp  — ISO 8601, UTC
//     level      — 'error' | 'warn' | 'info' | 'http' | 'debug'
//     message    — human-readable description
//     service    — 'patchticker-api' (constant)
//     environment — NODE_ENV
//     pid        — process.pid
//     requestId  — present when request context is available (via req.log)
//     userId     — present when authenticated context is available
//     ...meta    — any additional fields passed by the caller
//
// CONSOLE FORMAT (development)
//   [HH:mm:ss] LEVEL: message | {meta}
//
// ADDING REQUEST CONTEXT
// ───────────────────────
//   Use req.log (set by requestId middleware) to bind requestId + userId:
//     req.log.info('User action', { action: 'view_update' });
//   This is equivalent to logger.info() but with request fields pre-bound.
//
// LOGTAIL TRANSPORT
// ──────────────────
//   Sends JSON payloads to https://in.logs.betterstack.com via HTTPS.
//   Uses a fire-and-forget HTTP approach — transport failures are silent
//   so a Logtail outage never takes down the application.
//   Set LOGTAIL_TOKEN in .env (or secrets manager) to enable.
//
// SENTRY TRANSPORT
// ─────────────────
//   Captures error-level log entries as Sentry events.
//   Set SENTRY_DSN to enable. Integrates with Sentry's @sentry/node SDK.
//   For non-SDK usage (no install), set SENTRY_DSN and the transport sends
//   via the Sentry HTTP Envelope API — no SDK dependency.
//
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { createLogger, format, transports } = require('winston');
require('winston-daily-rotate-file');
const path  = require('path');
const https = require('https');
const { v4: uuidv4 } = require('uuid');

const logDir   = process.env.LOG_DIR   || './logs';
const logLevel = process.env.LOG_LEVEL || 'info';
const isProd   = process.env.NODE_ENV  === 'production';
const isTest   = process.env.NODE_ENV  === 'test';

// ── Default metadata added to every log entry ─────────────────────────────────

const DEFAULT_META = {
  service:     'patchticker-api',
  environment: process.env.NODE_ENV || 'development',
  pid:         process.pid,
};

// ── Formats ───────────────────────────────────────────────────────────────────

// JSON format for log files and external transports.
// Every entry is a flat JSON object — queryable by any log aggregator.
const jsonFormat = format.combine(
  format.timestamp({ format: () => new Date().toISOString() }),
  format.errors({ stack: true }),
  format((info) => {
    // Merge default metadata into every entry
    return Object.assign({}, DEFAULT_META, info);
  })(),
  format.json()
);

// Human-readable format for development console.
const { colorize, timestamp, printf } = format;
const humanFormat = format.combine(
  colorize(),
  timestamp({ format: 'HH:mm:ss' }),
  format.errors({ stack: true }),
  printf(({ level, message, timestamp: ts, stack, requestId, userId, ...meta }) => {
    const ctx     = [requestId && `req=${requestId}`, userId && `uid=${userId}`]
      .filter(Boolean).join(' ');
    const metaStr = Object.keys(meta)
      .filter(k => !['service','environment','pid'].includes(k) && meta[k] !== undefined)
      .reduce((acc, k) => { acc[k] = meta[k]; return acc; }, {});
    const metaPart = Object.keys(metaStr).length ? ` | ${JSON.stringify(metaStr)}` : '';
    const ctxPart  = ctx ? ` [${ctx}]` : '';
    return `[${ts}] ${level}: ${stack || message}${ctxPart}${metaPart}`;
  })
);

// ── File transports ───────────────────────────────────────────────────────────

const fileTransportBase = {
  datePattern:    'YYYY-MM-DD',
  zippedArchive:  true,
  format:         jsonFormat,
};

const errorFileTransport = new transports.DailyRotateFile({
  ...fileTransportBase,
  filename:  path.join(logDir, 'error-%DATE%.log'),
  level:     'error',
  maxFiles:  '14d',
});

// Security events: warn+ only. 90-day retention for forensics / SIEM.
const securityFileTransport = new transports.DailyRotateFile({
  ...fileTransportBase,
  filename:  path.join(logDir, 'security-%DATE%.log'),
  level:     'warn',
  maxFiles:  '90d',
});

const combinedFileTransport = new transports.DailyRotateFile({
  ...fileTransportBase,
  filename:  path.join(logDir, 'combined-%DATE%.log'),
  maxFiles:  '7d',
});

// ── Logtail / Better Stack transport ─────────────────────────────────────────
// Sends JSON payloads over HTTPS to Better Stack's ingest endpoint.
// No SDK required — uses Node's built-in https module.
// Transport errors are swallowed so a Logtail outage never affects the app.

class LogtailTransport extends transports.Stream {
  constructor(token, opts = {}) {
    // Pipe through a no-op stream; we handle the actual sending ourselves.
    const { PassThrough } = require('stream');
    const stream = new PassThrough();
    super({ stream, ...opts });
    this.token    = token;
    this.level    = opts.level || 'info';
    this.name     = 'logtail';
    this._pending = 0; // in-flight requests
  }

  log(info, callback) {
    setImmediate(callback); // release Winston immediately; don't block the pipeline

    // Batch: Logtail expects an array of log objects
    const body = JSON.stringify([{
      dt:      info.timestamp || new Date().toISOString(),
      level:   info.level,
      message: info.message,
      ...info,
    }]);

    const req = https.request({
      hostname: 'in.logs.betterstack.com',
      path:     '/',
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization':  `Bearer ${this.token}`,
      },
    });

    req.on('error', () => { /* swallow — Logtail outage must not affect app */ });
    req.setTimeout(5000, () => req.destroy());
    req.write(body);
    req.end();
  }
}

// ── Sentry transport (no-SDK, HTTP Envelope API) ──────────────────────────────
// Sends error-level log entries to Sentry via the HTTP Envelope API.
// This avoids adding @sentry/node as a dependency.
// If you want full SDK features (breadcrumbs, profiling), install @sentry/node
// and replace this with the official integration.
//
// DSN format: https://<key>@<host>/sentry/<project_id>
// Envelope endpoint: https://<host>/api/<project_id>/envelope/

class SentryTransport extends transports.Stream {
  constructor(dsn, opts = {}) {
    const { PassThrough } = require('stream');
    super({ stream: new PassThrough(), ...opts });
    this.level = 'error';
    this.name  = 'sentry';
    this._dsn  = this._parseDsn(dsn);
  }

  _parseDsn(dsn) {
    try {
      const url     = new URL(dsn);
      const parts   = url.pathname.split('/').filter(Boolean);
      const project = parts[parts.length - 1];
      return {
        host:    url.hostname,
        key:     url.username,
        project,
        path:    `/api/${project}/envelope/`,
      };
    } catch {
      return null;
    }
  }

  log(info, callback) {
    setImmediate(callback);
    if (!this._dsn) return;

    const eventId = uuidv4().replace(/-/g, '');
    const now     = new Date().toISOString();

    // Sentry envelope format: header\n{}\nevent_header\n{event}
    const envelopeHeader = JSON.stringify({
      event_id: eventId,
      sent_at:  now,
      dsn:      `https://${this._dsn.key}@${this._dsn.host}/${this._dsn.project}`,
    });

    const eventHeader = JSON.stringify({ type: 'event' });

    const event = JSON.stringify({
      event_id:  eventId,
      timestamp: now,
      level:     'error',
      platform:  'node',
      logger:    'winston',
      message:   info.message,
      extra: Object.fromEntries(
        Object.entries(info).filter(([k]) =>
          !['level','message','timestamp','service'].includes(k)
        )
      ),
      tags: {
        environment: info.environment || process.env.NODE_ENV,
        service:     info.service     || 'patchticker-api',
      },
      exception: info.stack ? {
        values: [{
          type:  info.errorType || 'Error',
          value: info.message,
          stacktrace: { frames: parseStack(info.stack) },
        }],
      } : undefined,
    });

    const envelope = `${envelopeHeader}\n${eventHeader}\n${event}`;

    const req = https.request({
      hostname: this._dsn.host,
      path:     this._dsn.path,
      method:   'POST',
      headers: {
        'Content-Type':   'application/x-sentry-envelope',
        'Content-Length': Buffer.byteLength(envelope),
        'X-Sentry-Auth':  `Sentry sentry_version=7, sentry_key=${this._dsn.key}`,
      },
    });

    req.on('error', () => { /* swallow — Sentry outage must not affect app */ });
    req.setTimeout(5000, () => req.destroy());
    req.write(envelope);
    req.end();
  }
}

/**
 * Parse a Node.js stack trace string into Sentry frame objects.
 * @param {string} stack
 * @returns {object[]}
 */
function parseStack(stack) {
  if (!stack || typeof stack !== 'string') return [];
  return stack
    .split('\n')
    .slice(1)  // skip the "Error: message" first line
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      // Typical format: "at FunctionName (file.js:line:col)"
      const match = line.match(/at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/);
      if (!match) return { filename: line };
      return {
        function: match[1] || '<anonymous>',
        filename: match[2],
        lineno:   parseInt(match[3], 10),
        colno:    parseInt(match[4], 10),
        in_app:   !match[2].includes('node_modules'),
      };
    })
    .reverse(); // Sentry expects innermost frame first
}

// ── Build transport list ──────────────────────────────────────────────────────

const winstonTransports = [
  errorFileTransport,
  securityFileTransport,
  combinedFileTransport,
];

// Console: dev + test get human format; test suppresses unless LOG_LEVEL=debug
if (!isProd) {
  winstonTransports.push(new transports.Console({
    format: humanFormat,
    silent: isTest && logLevel !== 'debug',
  }));
}

// Logtail: production only, requires LOGTAIL_TOKEN
const logtailToken = process.env.LOGTAIL_TOKEN;
if (isProd && logtailToken && !logtailToken.startsWith('REPLACE_WITH')) {
  winstonTransports.push(new LogtailTransport(logtailToken, { level: 'info' }));
}

// Sentry: production only, requires SENTRY_DSN
const sentryDsn = process.env.SENTRY_DSN;
if (isProd && sentryDsn && !sentryDsn.startsWith('REPLACE_WITH')) {
  winstonTransports.push(new SentryTransport(sentryDsn, { level: 'error' }));
}

// ── Logger instance ───────────────────────────────────────────────────────────

const logger = createLogger({
  level:       logLevel,
  // Base format for file transports (JSON). Console has its own format.
  format:      jsonFormat,
  transports:  winstonTransports,
  exitOnError: false,
  // Attach default meta to every entry
  defaultMeta: DEFAULT_META,
});

// ── Child logger factory ──────────────────────────────────────────────────────
// Creates a logger with pre-bound fields (requestId, userId).
// Used by requestId middleware to create req.log.
//
// Winston 3.3+ has a native .child(meta) method on Logger instances that
// returns a derived logger sharing the same transports — no duplicate file
// handles, no duplicate transport registrations. We use that directly.
//
// If for any reason the native child() is unavailable (very old Winston 3.x),
// we fall back to a wrapper that passes meta through.
//
// Usage:
//   req.log = logger.child({ requestId: id });
//   req.log.info('message', { extra: 'fields' });
//   // → { requestId: id, message: 'message', extra: 'fields', ...DEFAULT_META }

/**
 * Create a child logger bound to a specific request context.
 * All entries from this child automatically include requestId and userId.
 *
 * Uses Winston's native .child() which shares transports — no duplicate
 * file handles or external transport connections are created.
 *
 * @param {{ requestId: string, userId?: string }} ctx
 * @returns {import('winston').Logger}
 */
const _winstonChild = logger.child?.bind(logger);
logger.child = function(ctx) {
  if (typeof _winstonChild === 'function') {
    // Native Winston 3.3+ child: shares transports, merges defaultMeta
    return _winstonChild(ctx);
  }
  // Fallback: wrap the parent logger, injecting meta on every call.
  // Less efficient but correct for older Winston 3.x builds.
  const wrapper = Object.create(logger);
  ['error', 'warn', 'info', 'http', 'debug'].forEach(level => {
    wrapper[level] = (message, meta = {}) => logger[level](message, { ...ctx, ...meta });
  });
  return wrapper;
};

// ── Transport info logged at startup ──────────────────────────────────────────
if (!isTest) {
  const activeTransports = ['files'];
  if (logtailToken && !logtailToken.startsWith('REPLACE_WITH') && isProd) activeTransports.push('logtail');
  if (sentryDsn   && !sentryDsn.startsWith('REPLACE_WITH')   && isProd) activeTransports.push('sentry');
  if (!isProd)               activeTransports.push('console');
  logger.info('Logger initialised', {
    level:      logLevel,
    logDir,
    transports: activeTransports,
  });
}

module.exports = logger;

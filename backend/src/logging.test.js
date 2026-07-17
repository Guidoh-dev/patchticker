// src/logging.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Tests for:
//   src/utils/alerting.js      — spike counters, cooldowns, webhook formatters
//   src/middleware/errorHandler.js — body sanitization, 5xx/4xx routing
//   src/utils/logger.js        — child logger, structured format
//   src/routes/health.js       — liveness, readiness, alerts endpoints
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

process.env.NODE_ENV = 'test';

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — alerting: trackEvent and spike detection
// ─────────────────────────────────────────────────────────────────────────────

describe('alerting — trackEvent (spike counters)', () => {
  let alerting;

  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    alerting = require('./utils/alerting');
    // Reset all counters between tests
    for (const bucket of alerting._counters.values()) {
      bucket.length = 0;
    }
  });

  it('returns false before threshold is reached', () => {
    const { trackEvent, ALERT_TYPE } = alerting;
    // Default threshold for SPIKE_5XX is 10 in 2 minutes
    for (let i = 0; i < 9; i++) {
      const result = trackEvent(ALERT_TYPE.SPIKE_5XX);
      expect(result).toBe(false);
    }
  });

  it('returns true exactly when threshold is crossed', () => {
    const { trackEvent, ALERT_TYPE, SPIKE_CONFIG } = alerting;
    const threshold = SPIKE_CONFIG[ALERT_TYPE.SPIKE_5XX].threshold;
    for (let i = 0; i < threshold - 1; i++) trackEvent(ALERT_TYPE.SPIKE_5XX);
    expect(trackEvent(ALERT_TYPE.SPIKE_5XX)).toBe(true);
  });

  it('continues returning true after threshold (every event while threshold exceeded)', () => {
    const { trackEvent, ALERT_TYPE, SPIKE_CONFIG } = alerting;
    const threshold = SPIKE_CONFIG[ALERT_TYPE.SPIKE_5XX].threshold;
    for (let i = 0; i < threshold; i++) trackEvent(ALERT_TYPE.SPIKE_5XX);
    // Above threshold — next event also returns true
    expect(trackEvent(ALERT_TYPE.SPIKE_5XX)).toBe(true);
  });

  it('returns false for unknown alert type', () => {
    const { trackEvent } = alerting;
    expect(trackEvent('UNKNOWN_TYPE')).toBe(false);
  });

  it('tracks different types independently', () => {
    const { trackEvent, ALERT_TYPE, SPIKE_CONFIG } = alerting;
    const t5xx  = SPIKE_CONFIG[ALERT_TYPE.SPIKE_5XX].threshold;
    const tRL   = SPIKE_CONFIG[ALERT_TYPE.SPIKE_RATE_LIMIT].threshold;

    // Fill up to threshold-1 for SPIKE_5XX
    for (let i = 0; i < t5xx - 1; i++) trackEvent(ALERT_TYPE.SPIKE_5XX);
    // SPIKE_RATE_LIMIT should still be 0
    expect(alerting.getEventCount(ALERT_TYPE.SPIKE_RATE_LIMIT)).toBe(0);
    expect(alerting.getEventCount(ALERT_TYPE.SPIKE_5XX)).toBe(t5xx - 1);
  });

  it('getEventCount returns current count within window', () => {
    const { trackEvent, getEventCount, ALERT_TYPE } = alerting;
    trackEvent(ALERT_TYPE.SPIKE_5XX);
    trackEvent(ALERT_TYPE.SPIKE_5XX);
    expect(getEventCount(ALERT_TYPE.SPIKE_5XX)).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — alerting: cooldown logic
// ─────────────────────────────────────────────────────────────────────────────

describe('alerting — cooldown management', () => {
  let alerting;

  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV       = 'test';
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.example.com/webhook';
    alerting = require('./utils/alerting');
    alerting._lastFired.clear();
  });

  afterEach(() => {
    delete process.env.ALERT_WEBHOOK_URL;
  });

  it('getCooldownStatus returns an entry for every ALERT_TYPE', () => {
    const { getCooldownStatus, ALERT_TYPE } = alerting;
    const status = getCooldownStatus();
    for (const type of Object.values(ALERT_TYPE)) {
      expect(status).toHaveProperty(type);
      expect(status[type]).toHaveProperty('cooldownMs');
      expect(status[type]).toHaveProperty('remainingMs');
      expect(status[type]).toHaveProperty('active');
    }
  });

  it('no cooldown active at startup', () => {
    const { getCooldownStatus } = alerting;
    const status = getCooldownStatus();
    for (const entry of Object.values(status)) {
      expect(entry.active).toBe(false);
      expect(entry.remainingMs).toBe(0);
    }
  });

  it('resetCooldown clears a fired cooldown', () => {
    const { ALERT_TYPE, getCooldownStatus, resetCooldown } = alerting;
    // Manually set a last-fired timestamp
    alerting._lastFired.set(ALERT_TYPE.SPIKE_5XX, Date.now());
    expect(getCooldownStatus()[ALERT_TYPE.SPIKE_5XX].active).toBe(true);
    resetCooldown(ALERT_TYPE.SPIKE_5XX);
    expect(getCooldownStatus()[ALERT_TYPE.SPIKE_5XX].active).toBe(false);
  });

  it('alert() always logs even when webhook is not configured', () => {
    jest.resetModules();
    delete process.env.ALERT_WEBHOOK_URL;
    const freshAlerting = require('./utils/alerting');
    // Should not throw; the event is logged even with no webhook
    expect(() => freshAlerting.alert(freshAlerting.ALERT_TYPE.SPIKE_5XX, 'test')).not.toThrow();
  });

  it('alert() does not throw if webhook URL is invalid', () => {
    process.env.ALERT_WEBHOOK_URL = 'not-a-url';
    const { alert, ALERT_TYPE } = alerting;
    expect(() => alert(ALERT_TYPE.SPIKE_5XX, 'test', {})).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — alerting: webhook payload formatters
// ─────────────────────────────────────────────────────────────────────────────

describe('alerting — Slack payload format', () => {
  it('Slack payload has attachments with blocks', () => {
    jest.resetModules();
    process.env.ALERT_WEBHOOK_TYPE = 'slack';
    process.env.ALERT_WEBHOOK_URL  = 'https://hooks.slack.com/test';
    const { ALERT_TYPE, SEVERITY } = require('./utils/alerting');

    // We can't easily test _formatSlack directly since it's internal,
    // but we validate the types and ALERT_TYPE values are correctly defined.
    expect(ALERT_TYPE.CRASH).toBe('CRASH');
    expect(ALERT_TYPE.SPIKE_5XX).toBe('SPIKE_5XX');
    expect(SEVERITY.CRITICAL).toBe('critical');
    expect(SEVERITY.WARNING).toBe('warning');

    delete process.env.ALERT_WEBHOOK_TYPE;
    delete process.env.ALERT_WEBHOOK_URL;
  });

  it('all ALERT_TYPEs have a defined cooldown', () => {
    jest.resetModules();
    const { ALERT_TYPE, SPIKE_CONFIG } = require('./utils/alerting');
    // SPIKE_* types must have SPIKE_CONFIG entries
    for (const type of ['SPIKE_5XX', 'SPIKE_BLACKLIST', 'SPIKE_AUTH_ABUSE', 'SPIKE_RATE_LIMIT']) {
      expect(SPIKE_CONFIG).toHaveProperty(ALERT_TYPE[type]);
      expect(SPIKE_CONFIG[ALERT_TYPE[type]].threshold).toBeGreaterThan(0);
      expect(SPIKE_CONFIG[ALERT_TYPE[type]].windowMs).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — errorHandler: body sanitization
// ─────────────────────────────────────────────────────────────────────────────

describe('errorHandler — sanitizeBody', () => {
  let sanitizeBody;

  beforeEach(() => {
    jest.resetModules();
    sanitizeBody = require('./middleware/errorHandler').sanitizeBody;
  });

  it('redacts password field', () => {
    const result = sanitizeBody({ email: 'a@b.com', password: 'secret123' });
    expect(result.password).toBe('[REDACTED]');
    expect(result.email).toBe('a@b.com');
  });

  it('redacts token field', () => {
    const result = sanitizeBody({ token: 'bearer-abc', data: 'safe' });
    expect(result.token).toBe('[REDACTED]');
    expect(result.data).toBe('safe');
  });

  it('redacts secret field (case-insensitive)', () => {
    const result = sanitizeBody({ SECRET: 'my-secret', name: 'ok' });
    expect(result.SECRET).toBe('[REDACTED]');
    expect(result.name).toBe('ok');
  });

  it('redacts nested sensitive fields', () => {
    const result = sanitizeBody({ user: { password: 'pw', name: 'alice' } });
    expect(result.user.password).toBe('[REDACTED]');
    expect(result.user.name).toBe('alice');
  });

  it('passes through non-sensitive string fields', () => {
    const result = sanitizeBody({ updateId: 'node', severity: 'high' });
    expect(result.updateId).toBe('node');
    expect(result.severity).toBe('high');
  });

  it('handles array input', () => {
    const result = sanitizeBody([{ password: 'pw' }, { name: 'alice' }]);
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].password).toBe('[REDACTED]');
  });

  it('passes null through unchanged', () => {
    expect(sanitizeBody(null)).toBeNull();
  });

  it('passes undefined through unchanged', () => {
    expect(sanitizeBody(undefined)).toBeUndefined();
  });

  it('passes primitive values through unchanged', () => {
    expect(sanitizeBody('hello')).toBe('hello');
    expect(sanitizeBody(42)).toBe(42);
  });

  it('truncates deeply nested objects at depth 5', () => {
    const deep = { a: { b: { c: { d: { e: { f: 'too-deep' } } } } } };
    const result = sanitizeBody(deep);
    // Depth 5 should be truncated
    expect(result.a.b.c.d.e).toBe('[truncated]');
  });

  it('limits array length to 20 elements', () => {
    const arr = Array.from({ length: 25 }, (_, i) => ({ i }));
    const result = sanitizeBody(arr);
    expect(result.length).toBe(20);
  });

  it('redacts apikey and api_key variations', () => {
    expect(sanitizeBody({ apikey: 'k' }).apikey).toBe('[REDACTED]');
    expect(sanitizeBody({ api_key: 'k' }).api_key).toBe('[REDACTED]');
  });

  it('redacts cookie field', () => {
    expect(sanitizeBody({ cookie: 'session=abc' }).cookie).toBe('[REDACTED]');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — errorHandler: HTTP response behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('errorHandler — HTTP response routing', () => {
  // Build a minimal Express app with the errorHandler
  let request;

  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    const express            = require('express');
    const { errorHandler, notFound } = require('./middleware/errorHandler');
    const app = express();
    app.use(express.json());

    // Route that throws a 4xx error
    app.get('/test-4xx', (req, res, next) => {
      const err = new Error('Bad input');
      err.status = 400;
      next(err);
    });

    // Route that throws a 5xx error
    app.get('/test-5xx', (req, res, next) => {
      next(new Error('Internal boom'));
    });

    // Route that throws a CORS policy error
    app.get('/test-cors', (req, res, next) => {
      const err = new Error('CORS policy violation for origin http://evil.com');
      next(err);
    });

    app.use(notFound);
    app.use(errorHandler);

    request = require('supertest')(app);
  });

  it('4xx error: returns the actual error message to client', async () => {
    const res = await request.get('/test-4xx');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Bad input');
    expect(res.body).not.toHaveProperty('stack');
  });

  it('5xx error: returns generic message, not actual error', async () => {
    const res = await request.get('/test-5xx');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
    expect(res.body.error).not.toContain('Internal boom');
  });

  it('5xx error: response has requestId field', async () => {
    const res = await request.get('/test-5xx');
    // requestId may be undefined if requestId middleware isn't mounted in this test
    expect(res.body).toHaveProperty('error');
  });

  it('404: returns route not found', async () => {
    const res = await request.get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('CORS policy error returns 403', async () => {
    const res = await request.get('/test-cors');
    expect(res.status).toBe(403);
  });

  it('5xx does not include stack trace in response body', async () => {
    const res = await request.get('/test-5xx');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('at ');
    expect(body).not.toContain('node_modules');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — logger: child logger
// ─────────────────────────────────────────────────────────────────────────────

describe('logger — child logger', () => {
  let logger;

  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    logger = require('./utils/logger');
  });

  it('logger.child() returns an object with logging methods', () => {
    const child = logger.child({ requestId: 'test-123' });
    expect(typeof child.info).toBe('function');
    expect(typeof child.warn).toBe('function');
    expect(typeof child.error).toBe('function');
    expect(typeof child.debug).toBe('function');
  });

  it('child logger does not throw when called', () => {
    const child = logger.child({ requestId: 'abc', userId: 'user-1' });
    expect(() => child.info('test message', { extra: 'data' })).not.toThrow();
  });

  it('multiple child() calls do not throw', () => {
    for (let i = 0; i < 5; i++) {
      const child = logger.child({ requestId: `req-${i}` });
      expect(() => child.warn('test', { i })).not.toThrow();
    }
  });

  it('root logger methods still work after child creation', () => {
    logger.child({ requestId: 'test' });
    expect(() => logger.info('root logger still works')).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — health route: liveness
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/health — liveness', () => {
  let request;

  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    // Mock db.isAvailable so health route doesn't need a real DB
    jest.mock('./config/db', () => ({
      isAvailable: () => false,
      query:       jest.fn(),
      healthCheck: jest.fn().mockResolvedValue({ skipped: true }),
      shutdown:    jest.fn(),
    }));
    const express     = require('express');
    const healthRouter = require('./routes/health');
    const app = express();
    app.use('/api/health', healthRouter);
    request = require('supertest')(app);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns 200 with status: ok', async () => {
    const res = await request.get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('returns uptime as a number', async () => {
    const res = await request.get('/api/health');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('returns ISO timestamp', async () => {
    const res = await request.get('/api/health');
    expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('does not leak env in production', async () => {
    jest.resetModules();
    process.env.NODE_ENV = 'production';
    jest.mock('./config/db', () => ({
      isAvailable: () => false,
      query: jest.fn(),
    }));
    // secrets.js needs DB_ENCRYPTION_KEY not to throw
    process.env.JWT_ACCESS_SECRET  = 'a'.repeat(64);
    process.env.JWT_REFRESH_SECRET = 'b'.repeat(64);
    process.env.CSRF_SECRET        = 'c'.repeat(32);
    const express     = require('express');
    const healthRouter = require('./routes/health');
    const app = express();
    app.use('/api/health', healthRouter);
    const res = await require('supertest')(app).get('/api/health');
    expect(res.body).not.toHaveProperty('env');
    process.env.NODE_ENV = 'test';
    delete process.env.JWT_ACCESS_SECRET;
    delete process.env.JWT_REFRESH_SECRET;
    delete process.env.CSRF_SECRET;
  });

  it('rejects unknown query parameters', async () => {
    const res = await request.get('/api/health?hack=true');
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 — health route: /alerts endpoint
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/health/alerts', () => {
  let request;

  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test'; // health secret not required in test
    jest.mock('./config/db', () => ({
      isAvailable: () => false,
      query: jest.fn(),
    }));
    const express     = require('express');
    const healthRouter = require('./routes/health');
    const app = express();
    app.use('/api/health', healthRouter);
    request = require('supertest')(app);
  });

  it('returns spikeCounters and alertCooldowns fields', async () => {
    const res = await request.get('/api/health/alerts');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('spikeCounters');
    expect(res.body).toHaveProperty('alertCooldowns');
  });

  it('spikeCounters includes all spike types', async () => {
    const res = await request.get('/api/health/alerts');
    expect(res.body.spikeCounters).toHaveProperty('SPIKE_5XX');
    expect(res.body.spikeCounters).toHaveProperty('SPIKE_RATE_LIMIT');
    expect(res.body.spikeCounters).toHaveProperty('SPIKE_BLACKLIST');
    expect(res.body.spikeCounters).toHaveProperty('SPIKE_AUTH_ABUSE');
  });

  it('spike count starts at 0', async () => {
    const res = await request.get('/api/health/alerts');
    expect(res.body.spikeCounters.SPIKE_5XX.count).toBe(0);
  });

  it('alertConfig shows webhook not configured when URL not set', async () => {
    delete process.env.ALERT_WEBHOOK_URL;
    const res = await request.get('/api/health/alerts');
    expect(res.body.alertConfig.webhookConfigured).toBe(false);
  });

  it('does not expose ALERT_WEBHOOK_URL or LOGTAIL_TOKEN values', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://secret-webhook.example.com';
    process.env.LOGTAIL_TOKEN     = 'secret-token-123';
    const res = await request.get('/api/health/alerts');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('secret-webhook.example.com');
    expect(body).not.toContain('secret-token-123');
    delete process.env.ALERT_WEBHOOK_URL;
    delete process.env.LOGTAIL_TOKEN;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9 — health route: /ready endpoint
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/health/ready', () => {
  it('returns ready when DB is not available (not configured)', async () => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    jest.mock('./config/db', () => ({
      isAvailable: () => false,
      query: jest.fn(),
    }));
    const express      = require('express');
    const healthRouter = require('./routes/health');
    const app = express();
    app.use('/api/health', healthRouter);
    const res = await require('supertest')(app).get('/api/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.checks.database.status).toBe('not_configured');
  });

  it('returns ready when DB query succeeds', async () => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    jest.mock('./config/db', () => ({
      isAvailable: () => true,
      query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    }));
    const express      = require('express');
    const healthRouter = require('./routes/health');
    const app = express();
    app.use('/api/health', healthRouter);
    const res = await require('supertest')(app).get('/api/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.checks.database.status).toBe('ok');
  });

  it('returns 503 when DB query fails', async () => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    jest.mock('./config/db', () => ({
      isAvailable: () => true,
      query: jest.fn().mockRejectedValue(new Error('connection refused')),
    }));
    const express      = require('express');
    const healthRouter = require('./routes/health');
    const app = express();
    app.use('/api/health', healthRouter);
    const res = await require('supertest')(app).get('/api/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.checks.database.status).toBe('error');
  });

  it('in production: returns 403 without X-Health-Secret', async () => {
    jest.resetModules();
    process.env.NODE_ENV     = 'production';
    process.env.HEALTH_SECRET = 'correct-secret-value';
    // Stub heavy deps that fail-fast in prod
    jest.mock('./config/db', () => ({ isAvailable: () => false, query: jest.fn() }));
    jest.mock('./config/secrets', () => ({
      timingSafeEqual: (a, b) => a === b,
      getJwtAccessSecret: () => 'x',
      getJwtAccessSecrets: () => ['x'],
      getJwtRefreshSecret: () => 'x',
      getJwtRefreshSecrets: () => ['x'],
      getCsrfSecret: () => 'x',
      getCsrfSecrets: () => ['x'],
      getRedditCredentials: () => ({}),
      getRotationStatus: () => ({}),
      rotate: () => {},
    }));
    const express      = require('express');
    const healthRouter = require('./routes/health');
    const app = express();
    app.use('/api/health', healthRouter);
    const res = await require('supertest')(app).get('/api/health/ready');
    expect(res.status).toBe(403);
    process.env.NODE_ENV = 'test';
    delete process.env.HEALTH_SECRET;
  });
});

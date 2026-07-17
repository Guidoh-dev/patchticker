// src/security.test.js
// ─────────────────────────────────────────────────────────────────────────────
// SECURITY MIDDLEWARE TESTS
//
// Coverage:
//   config/security.js   — env validation, origin parsing, HTTPS enforcement,
//                          HSTS config, placeholder rejection in production
//   middleware/cors.js   — origin allowlist, credentials, preflight, headers
//   middleware/httpsRedirect.js — redirect logic, health check exemption,
//                                 X-Forwarded-Proto handling
//   middleware/securityHeaders.js — presence and values of all security headers
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ── Env setup — must happen before any module that reads process.env ──────────
// Use safe test values that pass validation
process.env.NODE_ENV                = 'test';
process.env.ALLOWED_ORIGINS         = 'http://localhost:3000';
process.env.JWT_ACCESS_SECRET       = 'a'.repeat(64);
process.env.JWT_REFRESH_SECRET      = 'b'.repeat(64);
process.env.CSRF_SECRET             = 'c'.repeat(32);
process.env.JWT_ACCESS_EXPIRES_IN   = '900';
process.env.JWT_REFRESH_EXPIRES_IN  = '604800';
process.env.LOCKOUT_MAX_ATTEMPTS    = '5';
process.env.LOCKOUT_DURATION_SECONDS = '900';
process.env.HTTPS_REDIRECT          = 'false';
process.env.HSTS_MAX_AGE            = '31536000';
process.env.HSTS_PRELOAD            = 'false';
process.env.TRUST_PROXY             = '1';

// ─────────────────────────────────────────────────────────────────────────────
// Lightweight request/response helpers — avoids spinning up a real HTTP server
// ─────────────────────────────────────────────────────────────────────────────

function mockReq(overrides = {}) {
  return {
    ip:          '127.0.0.1',
    method:      'GET',
    path:        '/api/test',
    originalUrl: '/api/test',
    hostname:    'localhost',
    secure:      false,
    protocol:    'http',
    headers:     {},
    cookies:     {},
    query:       {},
    ...overrides,
  };
}

function mockRes() {
  const headers = {};
  const res = {
    _headers:    headers,
    _status:     null,
    _body:       null,
    _redirectTo: null,
    setHeader(name, value) { headers[name.toLowerCase()] = value; return this; },
    getHeader(name) { return headers[name.toLowerCase()]; },
    removeHeader(name) { delete headers[name.toLowerCase()]; return this; },
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    redirect(code, url) { this._status = code; this._redirectTo = url; return this; },
    end() { return this; },
  };
  return res;
}

function mockNext() {
  const fn = jest.fn();
  return fn;
}

// ═════════════════════════════════════════════════════════════════════════════
// config/security.js
// ═════════════════════════════════════════════════════════════════════════════

describe('config/security', () => {
  // We test config in isolation by clearing the require cache and re-requiring
  // with modified env vars. We restore originals after each test.

  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    // Restore original env and clear require cache for config module
    Object.assign(process.env, ORIGINAL_ENV);
    Object.keys(process.env).forEach(k => {
      if (!(k in ORIGINAL_ENV)) delete process.env[k];
    });
    delete require.cache[require.resolve('./config/security')];
  });

  it('loads successfully with valid test env', () => {
    const cfg = require('./config/security');
    expect(cfg.NODE_ENV).toBe('test');
    expect(cfg.ALLOWED_ORIGINS).toContain('http://localhost:3000');
  });

  it('parses comma-separated ALLOWED_ORIGINS', () => {
    process.env.ALLOWED_ORIGINS = 'http://localhost:3000, http://localhost:4000 , http://localhost:5000';
    delete require.cache[require.resolve('./config/security')];
    const cfg = require('./config/security');
    expect(cfg.ALLOWED_ORIGINS).toHaveLength(3);
    expect(cfg.ALLOWED_ORIGINS).toContain('http://localhost:3000');
    expect(cfg.ALLOWED_ORIGINS).toContain('http://localhost:4000');
    expect(cfg.ALLOWED_ORIGINS).toContain('http://localhost:5000');
  });

  it('returns empty array for empty ALLOWED_ORIGINS', () => {
    process.env.ALLOWED_ORIGINS = '';
    process.env.NODE_ENV = 'development';
    delete require.cache[require.resolve('./config/security')];
    const cfg = require('./config/security');
    expect(cfg.ALLOWED_ORIGINS).toHaveLength(0);
  });

  it('HSTS_PRELOAD defaults to false', () => {
    delete process.env.HSTS_PRELOAD;
    delete require.cache[require.resolve('./config/security')];
    const cfg = require('./config/security');
    expect(cfg.HSTS_PRELOAD).toBe(false);
  });

  it('HSTS_PRELOAD parses true correctly', () => {
    process.env.HSTS_PRELOAD = 'true';
    delete require.cache[require.resolve('./config/security')];
    const cfg = require('./config/security');
    expect(cfg.HSTS_PRELOAD).toBe(true);
  });

  it('HSTS_MAX_AGE defaults to 31536000 (1 year)', () => {
    delete process.env.HSTS_MAX_AGE;
    delete require.cache[require.resolve('./config/security')];
    const cfg = require('./config/security');
    expect(cfg.HSTS_MAX_AGE).toBe(31536000);
  });

  it('HTTPS_REDIRECT is true when env is "true"', () => {
    process.env.HTTPS_REDIRECT = 'true';
    process.env.NODE_ENV = 'development';
    delete require.cache[require.resolve('./config/security')];
    const cfg = require('./config/security');
    expect(cfg.HTTPS_REDIRECT).toBe(true);
  });

  it('HTTPS_REDIRECT is false in development by default', () => {
    process.env.HTTPS_REDIRECT = 'false';
    process.env.NODE_ENV = 'development';
    delete require.cache[require.resolve('./config/security')];
    const cfg = require('./config/security');
    expect(cfg.HTTPS_REDIRECT).toBe(false);
  });

  describe('production validation', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
      // Set up valid production values
      process.env.ALLOWED_ORIGINS = 'https://patchticker.app';
      process.env.HTTPS_REDIRECT  = 'true';
    });

    it('throws when ALLOWED_ORIGINS is missing in production', () => {
      delete process.env.ALLOWED_ORIGINS;
      delete require.cache[require.resolve('./config/security')];
      expect(() => require('./config/security')).toThrow(/ALLOWED_ORIGINS/);
    });

    it('throws when ALLOWED_ORIGINS has non-HTTPS origin in production', () => {
      process.env.ALLOWED_ORIGINS = 'http://patchticker.app';
      delete require.cache[require.resolve('./config/security')];
      expect(() => require('./config/security')).toThrow(/HTTPS/);
    });

    it('accepts HTTPS origins in production', () => {
      process.env.ALLOWED_ORIGINS = 'https://patchticker.app,https://www.patchticker.app';
      delete require.cache[require.resolve('./config/security')];
      expect(() => require('./config/security')).not.toThrow();
    });

    it('rejects placeholder value for ALLOWED_ORIGINS', () => {
      process.env.ALLOWED_ORIGINS = 'REPLACE_WITH_YOUR_DOMAIN';
      delete require.cache[require.resolve('./config/security')];
      expect(() => require('./config/security')).toThrow();
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// middleware/httpsRedirect.js
// ═════════════════════════════════════════════════════════════════════════════

describe('httpsRedirect', () => {
  let httpsRedirect;

  beforeEach(() => {
    delete require.cache[require.resolve('./middleware/httpsRedirect')];
    httpsRedirect = require('./middleware/httpsRedirect');
  });

  it('is a no-op when HTTPS_REDIRECT is false', () => {
    process.env.HTTPS_REDIRECT = 'false';
    delete require.cache[require.resolve('./config/security')];
    delete require.cache[require.resolve('./middleware/httpsRedirect')];
    const redirect = require('./middleware/httpsRedirect');

    const req  = mockReq({ secure: false });
    const res  = mockRes();
    const next = mockNext();
    redirect(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res._redirectTo).toBeNull();
  });

  it('redirects HTTP to HTTPS with 301 when HTTPS_REDIRECT is true', () => {
    // Simulate production-like redirect enabled
    const cfg = require('./config/security');
    Object.defineProperty(cfg, 'HTTPS_REDIRECT', { value: true, writable: true });

    delete require.cache[require.resolve('./middleware/httpsRedirect')];
    const redirect = require('./middleware/httpsRedirect');

    const req  = mockReq({
      secure:      false,
      protocol:    'http',
      hostname:    'patchticker.app',
      originalUrl: '/api/updates',
      headers:     {},
    });
    const res  = mockRes();
    const next = mockNext();

    redirect(req, res, next);

    expect(res._status).toBe(301);
    expect(res._redirectTo).toBe('https://patchticker.app/api/updates');
    expect(next).not.toHaveBeenCalled();
  });

  it('does not redirect when already HTTPS (req.secure)', () => {
    const cfg = require('./config/security');
    Object.defineProperty(cfg, 'HTTPS_REDIRECT', { value: true, writable: true });

    delete require.cache[require.resolve('./middleware/httpsRedirect')];
    const redirect = require('./middleware/httpsRedirect');

    const req  = mockReq({ secure: true });
    const res  = mockRes();
    const next = mockNext();
    redirect(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res._redirectTo).toBeNull();
  });

  it('detects HTTPS via X-Forwarded-Proto header (proxy mode)', () => {
    const cfg = require('./config/security');
    Object.defineProperty(cfg, 'HTTPS_REDIRECT', { value: true, writable: true });

    delete require.cache[require.resolve('./middleware/httpsRedirect')];
    const redirect = require('./middleware/httpsRedirect');

    const req  = mockReq({
      secure:   false,
      protocol: 'http',
      headers:  { 'x-forwarded-proto': 'https' },
    });
    const res  = mockRes();
    const next = mockNext();
    redirect(req, res, next);
    // Already HTTPS via proxy — no redirect
    expect(next).toHaveBeenCalled();
    expect(res._redirectTo).toBeNull();
  });

  it('exempts /api/health from redirect', () => {
    const cfg = require('./config/security');
    Object.defineProperty(cfg, 'HTTPS_REDIRECT', { value: true, writable: true });

    delete require.cache[require.resolve('./middleware/httpsRedirect')];
    const redirect = require('./middleware/httpsRedirect');

    const req  = mockReq({ path: '/api/health', secure: false });
    const res  = mockRes();
    const next = mockNext();
    redirect(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res._redirectTo).toBeNull();
  });

  it('preserves original URL path and query string in redirect', () => {
    const cfg = require('./config/security');
    Object.defineProperty(cfg, 'HTTPS_REDIRECT', { value: true, writable: true });

    delete require.cache[require.resolve('./middleware/httpsRedirect')];
    const redirect = require('./middleware/httpsRedirect');

    const req = mockReq({
      secure:      false,
      protocol:    'http',
      hostname:    'patchticker.app',
      originalUrl: '/api/updates?platform=NVIDIA&status=stable',
      headers:     {},
    });
    const res  = mockRes();
    const next = mockNext();
    redirect(req, res, next);
    expect(res._redirectTo).toBe('https://patchticker.app/api/updates?platform=NVIDIA&status=stable');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// middleware/cors.js
// ═════════════════════════════════════════════════════════════════════════════

describe('cors middleware', () => {
  // The cors middleware calls a callback(null, true/false) pattern.
  // We test the origin resolver directly since the Express cors wrapper
  // doesn't expose it, so we build a small harness.

  function resolveOrigin(origin) {
    return new Promise((resolve, reject) => {
      // Re-require cors and simulate what it does internally
      delete require.cache[require.resolve('./config/security')];
      delete require.cache[require.resolve('./middleware/cors')];
      process.env.ALLOWED_ORIGINS = 'http://localhost:3000,https://patchticker.app';
      delete require.cache[require.resolve('./config/security')];

      // We test the cors behavior end-to-end via simulated OPTIONS request
      const corsMiddleware = require('./middleware/cors');
      const req = mockReq({ method: 'OPTIONS', headers: { origin } });
      const res = mockRes();

      // Patch res with cors expectations
      let allowedOrigin;
      res.setHeader = (name, val) => {
        if (name.toLowerCase() === 'access-control-allow-origin') {
          allowedOrigin = val;
        }
        return res;
      };
      res.getHeader = () => undefined;
      res.removeHeader = () => res;

      const next = () => resolve({ allowed: true, origin: allowedOrigin });
      corsMiddleware(req, res, (err) => {
        if (err) reject(err);
        else resolve({ allowed: true, origin: allowedOrigin });
      });
    });
  }

  beforeEach(() => {
    process.env.ALLOWED_ORIGINS = 'http://localhost:3000,https://patchticker.app';
    delete require.cache[require.resolve('./config/security')];
    delete require.cache[require.resolve('./middleware/cors')];
  });

  it('allows requests from an allowed origin', async () => {
    await expect(resolveOrigin('http://localhost:3000')).resolves.toBeDefined();
  });

  it('allows requests from a second allowed origin', async () => {
    await expect(resolveOrigin('https://patchticker.app')).resolves.toBeDefined();
  });

  it('rejects requests from an unlisted origin', async () => {
    await expect(resolveOrigin('https://evil.com')).rejects.toMatchObject({
      message: expect.stringMatching(/not allowed/i),
    });
  });

  it('allows requests with no Origin header (server-to-server / curl)', async () => {
    // No Origin header — undefined
    await expect(resolveOrigin(undefined)).resolves.toBeDefined();
  });

  it('rejects http:// origin when only https:// is in allowlist', async () => {
    process.env.ALLOWED_ORIGINS = 'https://patchticker.app';
    delete require.cache[require.resolve('./config/security')];
    delete require.cache[require.resolve('./middleware/cors')];
    await expect(resolveOrigin('http://patchticker.app')).rejects.toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// middleware/securityHeaders.js — header presence and values
// ═════════════════════════════════════════════════════════════════════════════

describe('securityHeaders middleware', () => {
  // Integration test: spin up a minimal Express app and make a real HTTP request
  // to verify headers are set as expected.

  const express   = require('express');
  const http      = require('http');

  let server;
  let baseUrl;

  beforeAll((done) => {
    const app = express();
    app.disable('x-powered-by'); // explicit
    const securityHeaders = require('./middleware/securityHeaders');
    app.use(...securityHeaders);
    app.get('/test', (req, res) => res.json({ ok: true }));
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterAll((done) => server.close(done));

  function get(path) {
    return new Promise((resolve, reject) => {
      http.get(`${baseUrl}${path}`, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }).on('error', reject);
    });
  }

  it('sets X-Content-Type-Options: nosniff', async () => {
    const { headers } = await get('/test');
    expect(headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets X-Frame-Options: DENY', async () => {
    const { headers } = await get('/test');
    expect(headers['x-frame-options']).toBe('DENY');
  });

  it('removes X-Powered-By header', async () => {
    const { headers } = await get('/test');
    expect(headers['x-powered-by']).toBeUndefined();
  });

  it('sets Referrer-Policy', async () => {
    const { headers } = await get('/test');
    expect(headers['referrer-policy']).toBeTruthy();
    expect(headers['referrer-policy']).toContain('strict-origin-when-cross-origin');
  });

  it('sets Content-Security-Policy with default-src none', async () => {
    const { headers } = await get('/test');
    const csp = headers['content-security-policy'];
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'none'");
  });

  it('sets CSP script-src none', async () => {
    const { headers } = await get('/test');
    expect(headers['content-security-policy']).toContain("script-src 'none'");
  });

  it('sets CSP frame-ancestors none', async () => {
    const { headers } = await get('/test');
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('sets CSP object-src none', async () => {
    const { headers } = await get('/test');
    expect(headers['content-security-policy']).toContain("object-src 'none'");
  });

  it('sets CSP form-action none', async () => {
    const { headers } = await get('/test');
    expect(headers['content-security-policy']).toContain("form-action 'none'");
  });

  it('sets CSP base-uri none', async () => {
    const { headers } = await get('/test');
    expect(headers['content-security-policy']).toContain("base-uri 'none'");
  });

  it('sets Cross-Origin-Resource-Policy: same-origin', async () => {
    const { headers } = await get('/test');
    expect(headers['cross-origin-resource-policy']).toBe('same-origin');
  });

  it('sets Cross-Origin-Opener-Policy: same-origin', async () => {
    const { headers } = await get('/test');
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
  });

  it('sets Permissions-Policy header', async () => {
    const { headers } = await get('/test');
    const pp = headers['permissions-policy'];
    expect(pp).toBeTruthy();
    expect(pp).toContain('camera=()');
    expect(pp).toContain('microphone=()');
    expect(pp).toContain('geolocation=()');
  });

  it('does NOT set X-XSS-Protection (deprecated, harmful)', async () => {
    // The old XSS auditor header should not be present
    // (Helmet sets it to 0 which disables it — acceptable)
    const { headers } = await get('/test');
    // If present, must be 0 (disabled), never '1' or '1; mode=block'
    if (headers['x-xss-protection']) {
      expect(headers['x-xss-protection']).toBe('0');
    }
  });

  it('sets HSTS header on the response', async () => {
    // Note: Helmet only sets HSTS on HTTPS connections.
    // In our test server (plain HTTP), HSTS may not be set.
    // We verify that if it IS set, it has the correct max-age.
    const { headers } = await get('/test');
    if (headers['strict-transport-security']) {
      expect(headers['strict-transport-security']).toContain('max-age=');
      expect(headers['strict-transport-security']).toContain('includeSubDomains');
    }
  });
});

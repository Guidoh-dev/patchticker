// src/csp.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Tests for:
//   src/middleware/securityHeaders.js — CSP directives, API vs frontend split
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

process.env.NODE_ENV = 'test';

// Helper: parse a CSP header string into a directive → sources map
function parseCSP(headerValue) {
  const result = {};
  headerValue.split(';').forEach(part => {
    const trimmed = part.trim();
    if (!trimmed) return;
    const [directive, ...rest] = trimmed.split(/\s+/);
    result[directive.toLowerCase()] = rest;
  });
  return result;
}

// Build a CSP string from Helmet's directive object format (camelCase keys)
function helmetDirectivesToString(directives) {
  return Object.entries(directives)
    .filter(([, v]) => v !== undefined)
    .map(([key, sources]) => {
      const directive = key.replace(/([A-Z])/g, '-$1').toLowerCase();
      return Array.isArray(sources) && sources.length === 0
        ? directive
        : `${directive} ${sources.join(' ')}`;
    })
    .join('; ');
}

describe('API CSP directives', () => {
  let buildApiCspDirectives;

  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    delete process.env.CSP_REPORT_URI;
    // Stub security config
    jest.mock('./config/security', () => ({
      HSTS_MAX_AGE:            31536000,
      HSTS_INCLUDE_SUBDOMAINS: true,
      HSTS_PRELOAD:            false,
      TRUST_PROXY:             1,
      PORT:                    4000,
      NODE_ENV:                'test',
      ALLOWED_ORIGINS:         [],
      HTTPS_REDIRECT:          false,
      CSP_REPORT_URI:          null,
    }));
    ({ buildApiCspDirectives } = require('./middleware/securityHeaders'));
  });

  it('default-src is none', () => {
    const d = buildApiCspDirectives();
    expect(d.defaultSrc).toEqual(["'none'"]);
  });

  it('script-src is none', () => {
    const d = buildApiCspDirectives();
    expect(d.scriptSrc).toEqual(["'none'"]);
  });

  it('style-src is none', () => {
    const d = buildApiCspDirectives();
    expect(d.styleSrc).toEqual(["'none'"]);
  });

  it('font-src is none', () => {
    const d = buildApiCspDirectives();
    expect(d.fontSrc).toEqual(["'none'"]);
  });

  it('connect-src is self only', () => {
    const d = buildApiCspDirectives();
    expect(d.connectSrc).toEqual(["'self'"]);
    expect(d.connectSrc).toHaveLength(1);
  });

  it('frame-ancestors is none', () => {
    const d = buildApiCspDirectives();
    expect(d.frameAncestors).toEqual(["'none'"]);
  });

  it('form-action is none', () => {
    const d = buildApiCspDirectives();
    expect(d.formAction).toEqual(["'none'"]);
  });

  it('object-src is none', () => {
    const d = buildApiCspDirectives();
    expect(d.objectSrc).toEqual(["'none'"]);
  });

  it('upgrade-insecure-requests is present', () => {
    const d = buildApiCspDirectives();
    expect(d.upgradeInsecureRequests).toBeDefined();
  });

  it('no unsafe-inline in any directive', () => {
    const d = buildApiCspDirectives();
    const allSources = Object.values(d).flat().join(' ');
    expect(allSources).not.toContain("'unsafe-inline'");
  });

  it('no unsafe-eval in any directive', () => {
    const d = buildApiCspDirectives();
    const allSources = Object.values(d).flat().join(' ');
    expect(allSources).not.toContain("'unsafe-eval'");
  });

  it('no report-uri when CSP_REPORT_URI not set', () => {
    const d = buildApiCspDirectives();
    expect(d.reportUri).toBeUndefined();
  });
});

describe('Frontend CSP directives', () => {
  let buildFrontendCspDirectives;

  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    delete process.env.CSP_REPORT_URI;
    jest.mock('./config/security', () => ({
      HSTS_MAX_AGE:            31536000,
      HSTS_INCLUDE_SUBDOMAINS: true,
      HSTS_PRELOAD:            false,
      TRUST_PROXY:             1,
      PORT:                    4000,
      NODE_ENV:                'test',
      ALLOWED_ORIGINS:         [],
      HTTPS_REDIRECT:          false,
      CSP_REPORT_URI:          null,
    }));
    ({ buildFrontendCspDirectives } = require('./middleware/securityHeaders'));
  });

  it('script-src is self only — no external scripts', () => {
    const d = buildFrontendCspDirectives();
    expect(d.scriptSrc).toContain("'self'");
    expect(d.scriptSrc).toHaveLength(1);
  });

  it('style-src allows self and fonts.googleapis.com only', () => {
    const d = buildFrontendCspDirectives();
    expect(d.styleSrc).toContain("'self'");
    expect(d.styleSrc).toContain('https://fonts.googleapis.com');
    expect(d.styleSrc).toHaveLength(2);
  });

  it('style-src does NOT contain unsafe-inline', () => {
    const d = buildFrontendCspDirectives();
    expect(d.styleSrc).not.toContain("'unsafe-inline'");
  });

  it('font-src allows self and fonts.gstatic.com only', () => {
    const d = buildFrontendCspDirectives();
    expect(d.fontSrc).toContain("'self'");
    expect(d.fontSrc).toContain('https://fonts.gstatic.com');
    expect(d.fontSrc).toHaveLength(2);
  });

  it('connect-src is self only — no external API calls', () => {
    const d = buildFrontendCspDirectives();
    expect(d.connectSrc).toEqual(["'self'"]);
  });

  it('img-src allows self and data: URIs only', () => {
    const d = buildFrontendCspDirectives();
    expect(d.imgSrc).toContain("'self'");
    expect(d.imgSrc).toContain('data:');
    expect(d.imgSrc).toHaveLength(2);
  });

  it('default-src is none', () => {
    const d = buildFrontendCspDirectives();
    expect(d.defaultSrc).toEqual(["'none'"]);
  });

  it('frame-ancestors is none', () => {
    const d = buildFrontendCspDirectives();
    expect(d.frameAncestors).toEqual(["'none'"]);
  });

  it('base-uri is self — prevents base tag injection', () => {
    const d = buildFrontendCspDirectives();
    expect(d.baseUri).toEqual(["'self'"]);
  });

  it('form-action is self only', () => {
    const d = buildFrontendCspDirectives();
    expect(d.formAction).toEqual(["'self'"]);
  });

  it('object-src is none', () => {
    const d = buildFrontendCspDirectives();
    expect(d.objectSrc).toEqual(["'none'"]);
  });

  it('no unsafe-inline anywhere', () => {
    const d = buildFrontendCspDirectives();
    const allSources = Object.values(d).flat().join(' ');
    expect(allSources).not.toContain("'unsafe-inline'");
  });

  it('no unsafe-eval anywhere', () => {
    const d = buildFrontendCspDirectives();
    const allSources = Object.values(d).flat().join(' ');
    expect(allSources).not.toContain("'unsafe-eval'");
  });

  it('no wildcards (*) in any directive', () => {
    const d = buildFrontendCspDirectives();
    const allSources = Object.values(d).flat().join(' ');
    // Only 'data:' is expected; no bare * wildcards
    expect(allSources.match(/(?<![a-z])\*/g)).toBeNull();
  });

  it('upgrade-insecure-requests is present', () => {
    const d = buildFrontendCspDirectives();
    expect(d.upgradeInsecureRequests).toBeDefined();
  });
});

describe('CSP report-uri inclusion', () => {
  let buildApiCspDirectives, buildFrontendCspDirectives;

  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV    = 'test';
    process.env.CSP_REPORT_URI = 'https://report.example.com/csp';
    jest.mock('./config/security', () => ({
      HSTS_MAX_AGE:            31536000,
      HSTS_INCLUDE_SUBDOMAINS: true,
      HSTS_PRELOAD:            false,
      TRUST_PROXY:             1,
      PORT:                    4000,
      NODE_ENV:                'test',
      ALLOWED_ORIGINS:         [],
      HTTPS_REDIRECT:          false,
      CSP_REPORT_URI:          'https://report.example.com/csp',
    }));
    ({ buildApiCspDirectives, buildFrontendCspDirectives } = require('./middleware/securityHeaders'));
  });

  afterEach(() => {
    delete process.env.CSP_REPORT_URI;
  });

  it('API CSP includes reportUri when configured', () => {
    const d = buildApiCspDirectives();
    expect(d.reportUri).toBe('https://report.example.com/csp');
  });

  it('Frontend CSP includes reportUri when configured', () => {
    const d = buildFrontendCspDirectives();
    expect(d.reportUri).toBe('https://report.example.com/csp');
  });

  it('API CSP includes reportTo when configured', () => {
    const d = buildApiCspDirectives();
    expect(d.reportTo).toBe('csp-endpoint');
  });
});

describe('API vs Frontend CSP: key differences', () => {
  let buildApiCspDirectives, buildFrontendCspDirectives;

  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    jest.mock('./config/security', () => ({
      HSTS_MAX_AGE: 31536000, HSTS_INCLUDE_SUBDOMAINS: true,
      HSTS_PRELOAD: false, TRUST_PROXY: 1, PORT: 4000,
      NODE_ENV: 'test', ALLOWED_ORIGINS: [], HTTPS_REDIRECT: false, CSP_REPORT_URI: null,
    }));
    ({ buildApiCspDirectives, buildFrontendCspDirectives } = require('./middleware/securityHeaders'));
  });

  it('API script-src is none; frontend is self', () => {
    expect(buildApiCspDirectives().scriptSrc).toEqual(["'none'"]);
    expect(buildFrontendCspDirectives().scriptSrc).toContain("'self'");
  });

  it('API style-src is none; frontend allows fonts.googleapis.com', () => {
    expect(buildApiCspDirectives().styleSrc).toEqual(["'none'"]);
    expect(buildFrontendCspDirectives().styleSrc).toContain('https://fonts.googleapis.com');
  });

  it('API font-src is none; frontend allows fonts.gstatic.com', () => {
    expect(buildApiCspDirectives().fontSrc).toEqual(["'none'"]);
    expect(buildFrontendCspDirectives().fontSrc).toContain('https://fonts.gstatic.com');
  });

  it('both have frame-ancestors none', () => {
    expect(buildApiCspDirectives().frameAncestors).toEqual(["'none'"]);
    expect(buildFrontendCspDirectives().frameAncestors).toEqual(["'none'"]);
  });

  it('both have object-src none', () => {
    expect(buildApiCspDirectives().objectSrc).toEqual(["'none'"]);
    expect(buildFrontendCspDirectives().objectSrc).toEqual(["'none'"]);
  });

  it('both have connect-src self only', () => {
    expect(buildApiCspDirectives().connectSrc).toEqual(["'self'"]);
    expect(buildFrontendCspDirectives().connectSrc).toEqual(["'self'"]);
  });

  it('frontend img-src has data:; api does not', () => {
    expect(buildApiCspDirectives().imgSrc).toEqual(["'none'"]);
    expect(buildFrontendCspDirectives().imgSrc).toContain('data:');
  });
});

describe('NGINX CSP export', () => {
  it('FRONTEND_CSP_NGINX is a non-empty string', () => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    jest.mock('./config/security', () => ({
      HSTS_MAX_AGE: 31536000, HSTS_INCLUDE_SUBDOMAINS: true,
      HSTS_PRELOAD: false, TRUST_PROXY: 1, PORT: 4000,
      NODE_ENV: 'test', ALLOWED_ORIGINS: [], HTTPS_REDIRECT: false, CSP_REPORT_URI: null,
    }));
    const { FRONTEND_CSP_NGINX } = require('./middleware/securityHeaders');
    expect(typeof FRONTEND_CSP_NGINX).toBe('string');
    expect(FRONTEND_CSP_NGINX.length).toBeGreaterThan(0);
  });

  it('FRONTEND_CSP_NGINX does not contain unsafe-inline', () => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    jest.mock('./config/security', () => ({
      HSTS_MAX_AGE: 31536000, HSTS_INCLUDE_SUBDOMAINS: true,
      HSTS_PRELOAD: false, TRUST_PROXY: 1, PORT: 4000,
      NODE_ENV: 'test', ALLOWED_ORIGINS: [], HTTPS_REDIRECT: false, CSP_REPORT_URI: null,
    }));
    const { FRONTEND_CSP_NGINX } = require('./middleware/securityHeaders');
    expect(FRONTEND_CSP_NGINX).not.toContain("'unsafe-inline'");
  });

  it('FRONTEND_CSP_NGINX contains fonts.googleapis.com', () => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    jest.mock('./config/security', () => ({
      HSTS_MAX_AGE: 31536000, HSTS_INCLUDE_SUBDOMAINS: true,
      HSTS_PRELOAD: false, TRUST_PROXY: 1, PORT: 4000,
      NODE_ENV: 'test', ALLOWED_ORIGINS: [], HTTPS_REDIRECT: false, CSP_REPORT_URI: null,
    }));
    const { FRONTEND_CSP_NGINX } = require('./middleware/securityHeaders');
    expect(FRONTEND_CSP_NGINX).toContain('fonts.googleapis.com');
  });
});

// src/validators/schemas.test.js
// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA VALIDATION TEST SUITE
//
// Coverage:
//   - Valid inputs (happy path)
//   - Boundary values (min/max edge cases)
//   - Type attacks (wrong types, coercion attempts)
//   - Injection payloads:
//       XSS (tags, event handlers, javascript: URIs)
//       SQL injection (comments, UNION SELECT, statement terminators)
//       Path traversal (../ ..\  null bytes)
//       Template injection ({{ }} ${ } #{ })
//       CRLF injection (\r \n)
//       NoSQL operator injection ($where, $ne, $gt)
//       Prototype pollution (__proto__, constructor, prototype)
//   - .strict() — unknown field rejection (mass-assignment)
//   - Enum enforcement (case sensitivity, unknown values)
//   - HealthQuerySchema — rejects any query params
//   - hardened() helper — tested directly
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const {
  GetUpdatesQuerySchema,
  GetUpdateByIdParamSchema,
  GetBugReportsByUpdateIdParamSchema,
  PostBugReportBodySchema,
  HealthQuerySchema,
  _hardened,
} = require('./schemas');
const { z } = require('zod');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns true if the schema accepts the input. */
const passes = (schema, input) => schema.safeParse(input).success;

/** Returns joined error messages if the schema rejects, or null if it passes. */
const fails = (schema, input) => {
  const result = schema.safeParse(input);
  if (result.success) return null;
  return result.error.errors.map(e => e.message).join(' | ');
};

/** Parsed output value for a passing schema. */
const parsed = (schema, input) => {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error('Expected schema to pass but it failed: ' + result.error.errors.map(e => e.message).join(', '));
  return result.data;
};

// ═════════════════════════════════════════════════════════════════════════════
// hardened() helper — unit tests for the injection guard itself
// ═════════════════════════════════════════════════════════════════════════════

describe('hardened() — injection guard helper', () => {
  // Build a minimal base schema to test hardened() in isolation
  const schema = _hardened(z.string().trim().min(5).max(500));

  describe('HTML / XSS', () => {
    const xssPayloads = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '<svg onload=alert(1)>',
      '"><script>alert(document.cookie)</script>',
      '<body onload=alert(1)>',
      '<iframe src="evil.com">',
      '<a href="x">click</a>',
    ];
    it.each(xssPayloads)('rejects HTML tag payload: %s', (p) => {
      expect(fails(schema, p)).toMatch(/HTML tag/i);
    });
  });

  describe('javascript: URIs', () => {
    const uriPayloads = [
      "javascript:alert('xss')",
      'JAVASCRIPT:alert(1)',
      'javascript :alert(1)',  // space before colon
    ];
    it.each(uriPayloads)('rejects javascript: URI: %s', (p) => {
      // wrap to hit min length if needed
      const v = p.length >= 5 ? p : p + 'xxxxx';
      expect(fails(schema, v)).toMatch(/javascript/i);
    });
  });

  describe('inline event handlers', () => {
    const handlerPayloads = [
      'text onclick=alert(1) more text here',
      'text onerror=bad() extra',
      'onmouseover=evil() padding here',
    ];
    it.each(handlerPayloads)('rejects inline handler: %s', (p) => {
      expect(fails(schema, p)).toMatch(/event handler/i);
    });
  });

  describe('SQL injection', () => {
    it('rejects -- comment sequence', () => {
      expect(fails(schema, 'valid text -- comment')).toMatch(/SQL comment/i);
    });
    it('rejects /* block comment */', () => {
      expect(fails(schema, 'value /* comment */ end')).toMatch(/SQL comment/i);
    });
    it('rejects UNION SELECT', () => {
      expect(fails(schema, 'foo UNION SELECT null bar')).toMatch(/UNION SELECT/i);
    });
    it('rejects union select (lowercase)', () => {
      expect(fails(schema, 'foo union select null bar')).toMatch(/UNION SELECT/i);
    });
    it('rejects ; DROP TABLE', () => {
      expect(fails(schema, 'text; DROP TABLE users end')).toMatch(/SQL statement/i);
    });
    it('rejects ; SELECT', () => {
      expect(fails(schema, 'text; SELECT * FROM users')).toMatch(/SQL statement/i);
    });
    it('rejects ; INSERT', () => {
      expect(fails(schema, 'text; INSERT INTO t VALUES(1)')).toMatch(/SQL statement/i);
    });
    it('rejects ; DELETE', () => {
      expect(fails(schema, 'text; DELETE FROM t end text')).toMatch(/SQL statement/i);
    });
  });

  describe('path traversal', () => {
    it('rejects ../', () => {
      expect(fails(schema, '../../etc/passwd')).toMatch(/path traversal/i);
    });
    it('rejects ..\\', () => {
      expect(fails(schema, '..\\..\\windows\\system32')).toMatch(/path traversal/i);
    });
    it('rejects null byte', () => {
      expect(fails(schema, 'file\0.php valid length here')).toMatch(/null byte/i);
    });
  });

  describe('template injection', () => {
    const templatePayloads = [
      '{{constructor.constructor("alert(1)")()}} padding',
      '${process.env.SECRET} padding here',
      '#{7*7} ruby erb padding here',
      '{{ 7 * 7 }} padding here long enough',
    ];
    it.each(templatePayloads)('rejects template expression: %s', (p) => {
      expect(fails(schema, p)).toMatch(/template/i);
    });
  });

  describe('CRLF injection', () => {
    it('rejects \\n (LF)', () => {
      expect(fails(schema, 'line1\ninjected line')).toMatch(/line break/i);
    });
    it('rejects \\r\\n (CRLF)', () => {
      expect(fails(schema, 'line1\r\nHTTP/1.1 200 OK')).toMatch(/line break/i);
    });
    it('rejects bare \\r', () => {
      expect(fails(schema, 'line1\rfake log line')).toMatch(/line break/i);
    });
  });

  describe('valid inputs pass through', () => {
    it('accepts clean descriptive text', () => {
      expect(passes(schema, 'Game crashes after loading the main menu screen.')).toBe(true);
    });
    it('accepts text with numbers and punctuation', () => {
      expect(passes(schema, 'RTX 4090 — FPS drops from 120 to 30 fps (v2.3.1).')).toBe(true);
    });
    it('accepts text with question marks', () => {
      expect(passes(schema, 'Is this a known issue with RX 7900 XT?')).toBe(true);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// HealthQuerySchema
// ═════════════════════════════════════════════════════════════════════════════

describe('HealthQuerySchema', () => {
  it('accepts empty query object', () => {
    expect(passes(HealthQuerySchema, {})).toBe(true);
  });
  it('rejects any query parameter', () => {
    expect(fails(HealthQuerySchema, { debug: 'true' })).toBeTruthy();
  });
  it('rejects injection attempt via query', () => {
    expect(fails(HealthQuerySchema, { $where: '1==1' })).toBeTruthy();
  });
  it('rejects __proto__ key', () => {
    expect(fails(HealthQuerySchema, { __proto__: { x: 1 } })).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GetUpdatesQuerySchema
// ═════════════════════════════════════════════════════════════════════════════

describe('GetUpdatesQuerySchema', () => {

  describe('valid inputs', () => {
    it('accepts empty query (both fields optional)', () => {
      expect(passes(GetUpdatesQuerySchema, {})).toBe(true);
    });
    it('accepts valid platform only', () => {
      expect(passes(GetUpdatesQuerySchema, { platform: 'NVIDIA' })).toBe(true);
    });
    it('accepts valid status only', () => {
      expect(passes(GetUpdatesQuerySchema, { status: 'stable' })).toBe(true);
    });
    it('accepts both valid fields together', () => {
      expect(passes(GetUpdatesQuerySchema, { platform: 'AMD', status: 'avoid' })).toBe(true);
    });
    it('accepts all platform enum values', () => {
      for (const p of ['Apple', 'NVIDIA', 'AMD', 'PS5', 'Windows', 'Steam']) {
        expect(passes(GetUpdatesQuerySchema, { platform: p })).toBe(true);
      }
    });
    it('accepts all status enum values', () => {
      for (const s of ['stable', 'caution', 'avoid']) {
        expect(passes(GetUpdatesQuerySchema, { status: s })).toBe(true);
      }
    });
  });

  describe('enum enforcement', () => {
    it('rejects unknown platform value', () => {
      expect(fails(GetUpdatesQuerySchema, { platform: 'Linux' })).toBeTruthy();
    });
    it('rejects empty string platform', () => {
      expect(fails(GetUpdatesQuerySchema, { platform: '' })).toBeTruthy();
    });
    it('rejects lowercase platform (case-sensitive)', () => {
      expect(fails(GetUpdatesQuerySchema, { platform: 'nvidia' })).toBeTruthy();
    });
    it('rejects mixed-case platform', () => {
      expect(fails(GetUpdatesQuerySchema, { platform: 'Nvidia' })).toBeTruthy();
    });
    it('rejects unknown status value', () => {
      expect(fails(GetUpdatesQuerySchema, { status: 'good' })).toBeTruthy();
    });
    it('rejects uppercase status', () => {
      expect(fails(GetUpdatesQuerySchema, { status: 'STABLE' })).toBeTruthy();
    });
  });

  describe('.strict() — extra field rejection', () => {
    it('rejects __proto__ key', () => {
      expect(fails(GetUpdatesQuerySchema, { platform: 'AMD', __proto__: { polluted: true } })).toBeTruthy();
    });
    it('rejects constructor key', () => {
      expect(fails(GetUpdatesQuerySchema, { constructor: 'x' })).toBeTruthy();
    });
    it('rejects $where (NoSQL injection)', () => {
      expect(fails(GetUpdatesQuerySchema, { $where: '1==1' })).toBeTruthy();
    });
    it('rejects $ne operator injection', () => {
      expect(fails(GetUpdatesQuerySchema, { platform: { $ne: 'AMD' } })).toBeTruthy();
    });
    it('rejects $gt operator injection', () => {
      expect(fails(GetUpdatesQuerySchema, { status: { $gt: '' } })).toBeTruthy();
    });
    it('rejects arbitrary extra field', () => {
      expect(fails(GetUpdatesQuerySchema, { platform: 'AMD', injected: 'x' })).toBeTruthy();
    });
    it('rejects prototype key', () => {
      expect(fails(GetUpdatesQuerySchema, { prototype: {} })).toBeTruthy();
    });
  });

  describe('type attacks', () => {
    it('rejects array platform value (?platform[]=AMD)', () => {
      expect(fails(GetUpdatesQuerySchema, { platform: ['AMD', 'NVIDIA'] })).toBeTruthy();
    });
    it('rejects numeric status', () => {
      expect(fails(GetUpdatesQuerySchema, { status: 1 })).toBeTruthy();
    });
    it('rejects null platform', () => {
      expect(fails(GetUpdatesQuerySchema, { platform: null })).toBeTruthy();
    });
    it('rejects boolean platform', () => {
      expect(fails(GetUpdatesQuerySchema, { platform: true })).toBeTruthy();
    });
    it('rejects object platform (?platform[$ne]=AMD)', () => {
      expect(fails(GetUpdatesQuerySchema, { platform: { $ne: 'AMD' } })).toBeTruthy();
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GetUpdateByIdParamSchema
// ═════════════════════════════════════════════════════════════════════════════

describe('GetUpdateByIdParamSchema', () => {

  const validIds = [
    'amd-adrenalin-25-3-1',
    'nvidia-572-16',
    'apple-ios-18-4',
    'ps5-fw-25-01-10-00',
    'windows-kb5043064',
    'steam-feb-2025',
  ];

  describe('valid inputs', () => {
    it.each(validIds)('accepts valid id: %s', (id) => {
      expect(passes(GetUpdateByIdParamSchema, { id })).toBe(true);
    });
  });

  describe('invalid / attack inputs', () => {
    it('rejects unknown slug', () => {
      expect(fails(GetUpdateByIdParamSchema, { id: 'unknown-update' })).toBeTruthy();
    });
    it('rejects empty string', () => {
      expect(fails(GetUpdateByIdParamSchema, { id: '' })).toBeTruthy();
    });
    it('rejects path traversal attempt', () => {
      expect(fails(GetUpdateByIdParamSchema, { id: '../../etc/passwd' })).toBeTruthy();
    });
    it('rejects null byte injection', () => {
      expect(fails(GetUpdateByIdParamSchema, { id: 'nvidia-572-16\0' })).toBeTruthy();
    });
    it('rejects SQL injection in param', () => {
      expect(fails(GetUpdateByIdParamSchema, { id: "'; DROP TABLE updates;--" })).toBeTruthy();
    });
    it('rejects XSS in param', () => {
      expect(fails(GetUpdateByIdParamSchema, { id: '<script>alert(1)</script>' })).toBeTruthy();
    });
    it('rejects numeric id', () => {
      expect(fails(GetUpdateByIdParamSchema, { id: 123 })).toBeTruthy();
    });
    it('rejects template injection in param', () => {
      expect(fails(GetUpdateByIdParamSchema, { id: '{{7*7}}' })).toBeTruthy();
    });
    it('rejects CRLF in param', () => {
      expect(fails(GetUpdateByIdParamSchema, { id: 'nvidia-572-16\r\n' })).toBeTruthy();
    });
  });

  describe('.strict() — extra field rejection', () => {
    it('rejects extra key alongside valid id', () => {
      expect(fails(GetUpdateByIdParamSchema, { id: 'nvidia-572-16', extra: 'x' })).toBeTruthy();
    });
    it('rejects __proto__ alongside valid id', () => {
      expect(fails(GetUpdateByIdParamSchema, { id: 'nvidia-572-16', __proto__: {} })).toBeTruthy();
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PostBugReportBodySchema
// ═════════════════════════════════════════════════════════════════════════════

describe('PostBugReportBodySchema', () => {

  const valid = {
    updateId:    'nvidia-572-16',
    severity:    'high',
    description: 'Game crashes to desktop after 10 minutes of play on RTX 3080.',
  };

  describe('valid inputs', () => {
    it('accepts a well-formed report', () => {
      expect(passes(PostBugReportBodySchema, valid)).toBe(true);
    });
    it('accepts description at exactly 10 chars', () => {
      expect(passes(PostBugReportBodySchema, { ...valid, description: 'A'.repeat(10) })).toBe(true);
    });
    it('accepts description at exactly 1000 chars', () => {
      expect(passes(PostBugReportBodySchema, { ...valid, description: 'A'.repeat(1000) })).toBe(true);
    });
    it('trims leading/trailing whitespace from description', () => {
      const result = PostBugReportBodySchema.safeParse({ ...valid, description: '  valid description here  ' });
      expect(result.success).toBe(true);
      expect(result.data.description).toBe('valid description here');
    });
    it('accepts all severity levels', () => {
      for (const s of ['critical', 'high', 'medium', 'low']) {
        expect(passes(PostBugReportBodySchema, { ...valid, severity: s })).toBe(true);
      }
    });
    it('accepts all valid updateId values', () => {
      const ids = ['amd-adrenalin-25-3-1','nvidia-572-16','apple-ios-18-4','ps5-fw-25-01-10-00','windows-kb5043064','steam-feb-2025'];
      for (const id of ids) {
        expect(passes(PostBugReportBodySchema, { ...valid, updateId: id })).toBe(true);
      }
    });
  });

  describe('length bounds', () => {
    it('rejects description shorter than 10 chars', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, description: 'short' })).toMatch(/10/);
    });
    it('rejects description longer than 1000 chars', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, description: 'A'.repeat(1001) })).toMatch(/1000/);
    });
    it('rejects empty description', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, description: '' })).toBeTruthy();
    });
    it('rejects whitespace-only description (becomes empty after trim)', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, description: '          ' })).toBeTruthy();
    });
    it('rejects description of exactly 9 chars', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, description: 'A'.repeat(9) })).toBeTruthy();
    });
    it('rejects description of exactly 1001 chars', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, description: 'A'.repeat(1001) })).toBeTruthy();
    });
  });

  describe('XSS — HTML tags', () => {
    const tagPayloads = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '<svg onload=alert(1)>',
      '"><script>alert(document.cookie)</script>',
      '<body onload=alert(1)>',
    ];
    it.each(tagPayloads)('rejects HTML tag: %s', (payload) => {
      expect(fails(PostBugReportBodySchema, { ...valid, description: payload })).toBeTruthy();
    });
  });

  describe('XSS — script patterns', () => {
    it('rejects javascript: URI in description', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, description: 'click javascript:void(0) to proceed with this' })).toBeTruthy();
    });
    it('rejects JAVASCRIPT: (uppercase)', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, description: 'click JAVASCRIPT:alert(1) here for details' })).toBeTruthy();
    });
    it('rejects inline onclick= handler in description', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, description: 'text onclick=alert(1) more text here now' })).toBeTruthy();
    });
    it('rejects onmouseover= handler', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, description: 'text onmouseover=evil() more text here long' })).toBeTruthy();
    });
  });

  describe('SQL injection', () => {
    const sqlPayloads = [
      "'; DROP TABLE updates; --",
      "1; SELECT * FROM users WHERE 1=1",
      "' UNION SELECT null, null, null --",
      "/* comment */ SELECT 1 FROM users now",
      "'; INSERT INTO users VALUES ('hacker','pw'); --",
      "'; DELETE FROM updates; -- comment now",
    ];
    it.each(sqlPayloads)('rejects SQL injection: %s', (payload) => {
      expect(fails(PostBugReportBodySchema, { ...valid, description: payload })).toBeTruthy();
    });
    it('rejects standalone -- comment', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, description: 'valid text -- this is a comment' })).toBeTruthy();
    });
    it('rejects /* block comment */', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, description: 'value /* block comment */ rest here long' })).toBeTruthy();
    });
    it('rejects UNION SELECT (case insensitive)', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, description: 'text union select null null null extra' })).toBeTruthy();
    });
  });

  describe('path traversal', () => {
    it('rejects ../', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, description: '../../etc/passwd contents here' })).toBeTruthy();
    });
    it('rejects ..\\', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, description: '..\\..\\windows\\system32 file' })).toBeTruthy();
    });
    it('rejects null byte', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, description: 'file\0.php extension bypass attempt here' })).toBeTruthy();
    });
  });

  describe('template injection', () => {
    it('rejects {{ }} Mustache/Handlebars', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, description: '{{constructor.constructor("alert(1)")()}}' })).toBeTruthy();
    });
    it('rejects ${ } JS template literal', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, description: 'Value is ${process.env.SECRET} here now' })).toBeTruthy();
    });
    it('rejects #{ } Ruby ERB', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, description: 'Value #{7*7} here in output now long' })).toBeTruthy();
    });
  });

  describe('CRLF injection', () => {
    it('rejects \\n newline', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, description: 'line1\ninjected: fake log here' })).toBeTruthy();
    });
    it('rejects \\r\\n CRLF', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, description: 'line1\r\nHTTP/1.1 200 OK fake' })).toBeTruthy();
    });
    it('rejects bare \\r', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, description: 'line1\rfake log line here now' })).toBeTruthy();
    });
  });

  describe('.strict() — extra field rejection (mass-assignment)', () => {
    it('rejects __proto__ key', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, __proto__: { isAdmin: true } })).toBeTruthy();
    });
    it('rejects constructor key', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, constructor: 'x' })).toBeTruthy();
    });
    it('rejects prototype key', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, prototype: {} })).toBeTruthy();
    });
    it('rejects userId field', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, userId: 1 })).toBeTruthy();
    });
    it('rejects score field (score manipulation)', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, score: 10 })).toBeTruthy();
    });
    it('rejects isVerified field', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, isVerified: true })).toBeTruthy();
    });
    it('rejects isAdmin field', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, isAdmin: true })).toBeTruthy();
    });
    it('rejects role field', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, role: 'admin' })).toBeTruthy();
    });
  });

  describe('enum enforcement', () => {
    it('rejects unknown updateId', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, updateId: 'fake-update-1-0' })).toBeTruthy();
    });
    it('rejects unknown severity', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, severity: 'urgent' })).toBeTruthy();
    });
    it('rejects empty updateId', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, updateId: '' })).toBeTruthy();
    });
    it('rejects uppercase severity', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, severity: 'HIGH' })).toBeTruthy();
    });
  });

  describe('type confusion attacks', () => {
    it('rejects numeric description', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, description: 12345678901 })).toBeTruthy();
    });
    it('rejects boolean severity', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, severity: true })).toBeTruthy();
    });
    it('rejects array updateId', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, updateId: ['nvidia-572-16'] })).toBeTruthy();
    });
    it('rejects null updateId', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, updateId: null })).toBeTruthy();
    });
    it('rejects object description (NoSQL-style)', () => {
      expect(fails(PostBugReportBodySchema, { ...valid, description: { $ne: null } })).toBeTruthy();
    });
    it('rejects missing required field: updateId', () => {
      const { updateId, ...rest } = valid;
      expect(fails(PostBugReportBodySchema, rest)).toBeTruthy();
    });
    it('rejects missing required field: severity', () => {
      const { severity, ...rest } = valid;
      expect(fails(PostBugReportBodySchema, rest)).toBeTruthy();
    });
    it('rejects missing required field: description', () => {
      const { description, ...rest } = valid;
      expect(fails(PostBugReportBodySchema, rest)).toBeTruthy();
    });
    it('rejects completely empty body', () => {
      expect(fails(PostBugReportBodySchema, {})).toBeTruthy();
    });
  });

  describe('output correctness — parsed data shape', () => {
    it('returns only declared fields (no extra keys)', () => {
      const data = parsed(PostBugReportBodySchema, valid);
      const keys = Object.keys(data);
      expect(keys).toEqual(expect.arrayContaining(['updateId', 'severity', 'description']));
      expect(keys.length).toBe(3);
    });
    it('trims description whitespace in output', () => {
      const data = parsed(PostBugReportBodySchema, { ...valid, description: '  trimmed value here  ' });
      expect(data.description).toBe('trimmed value here');
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GetBugReportsByUpdateIdParamSchema
// ═════════════════════════════════════════════════════════════════════════════

describe('GetBugReportsByUpdateIdParamSchema', () => {
  it('accepts valid updateId', () => {
    expect(passes(GetBugReportsByUpdateIdParamSchema, { updateId: 'amd-adrenalin-25-3-1' })).toBe(true);
  });
  it('rejects invalid updateId', () => {
    expect(fails(GetBugReportsByUpdateIdParamSchema, { updateId: 'not-real' })).toBeTruthy();
  });
  it('rejects path traversal', () => {
    expect(fails(GetBugReportsByUpdateIdParamSchema, { updateId: '../admin' })).toBeTruthy();
  });
  it('rejects null byte', () => {
    expect(fails(GetBugReportsByUpdateIdParamSchema, { updateId: 'amd-adrenalin-25-3-1\0' })).toBeTruthy();
  });
  it('rejects XSS in updateId', () => {
    expect(fails(GetBugReportsByUpdateIdParamSchema, { updateId: '<script>x</script>' })).toBeTruthy();
  });
  it('rejects template injection in updateId', () => {
    expect(fails(GetBugReportsByUpdateIdParamSchema, { updateId: '{{7*7}}' })).toBeTruthy();
  });
  it('rejects extra fields', () => {
    expect(fails(GetBugReportsByUpdateIdParamSchema, { updateId: 'nvidia-572-16', page: 1 })).toBeTruthy();
  });
  it('rejects __proto__ alongside valid updateId', () => {
    expect(fails(GetBugReportsByUpdateIdParamSchema, { updateId: 'nvidia-572-16', __proto__: {} })).toBeTruthy();
  });
});

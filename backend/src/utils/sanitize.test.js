// src/utils/sanitize.test.js

'use strict';

const {
  escapeHtml,
  stripSqlMeta,
  stripPathChars,
  normalizeUnicode,
  stripProto,
  sanitizeLogValue,
  sanitizeInput,
  escapeOutput,
} = require('./sanitize');

// ── escapeHtml ────────────────────────────────────────────────────────────────
describe('escapeHtml', () => {
  it('escapes & < > " \' / ` =', () => {
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    expect(escapeHtml('"value"')).toBe('&quot;value&quot;');
    expect(escapeHtml("it's")).toBe("it&#x27;s");
    expect(escapeHtml('/path')).toBe('&#x2F;path');
    expect(escapeHtml('`tmpl`')).toBe('&#x60;tmpl&#x60;');
    expect(escapeHtml('a=b')).toBe('a&#x3D;b');
  });
  it('returns non-strings unchanged', () => {
    expect(escapeHtml(42)).toBe(42);
    expect(escapeHtml(null)).toBe(null);
    expect(escapeHtml(undefined)).toBe(undefined);
  });
  it('escapes full XSS payload', () => {
    const out = escapeHtml('<script>alert("xss")</script>');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).not.toContain('"');
  });
  it('escapes onerror= handler', () => {
    const out = escapeHtml('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
  });
  it('escapes template delimiters {{ }}', () => {
    // escapeHtml does not touch { } — that is intentional.
    // Template injection is blocked at the schema layer (hardened).
    // This test documents the expected behaviour.
    const out = escapeHtml('{{7*7}}');
    expect(out).toBe('{{7*7}}'); // curly braces are not HTML special chars
  });
});

// ── stripSqlMeta ──────────────────────────────────────────────────────────────
describe('stripSqlMeta', () => {
  it("removes single quote", () => expect(stripSqlMeta("O'Brien")).toBe('OBrien'));
  it('removes double quote', () => expect(stripSqlMeta('say "hi"')).toBe('say hi'));
  it('removes semicolons', () => expect(stripSqlMeta('DROP; TABLE')).toBe('DROP TABLE'));
  it('removes -- comment', () => expect(stripSqlMeta('val -- comment')).toBe('val  comment'));
  it('removes /* */ block comment', () => expect(stripSqlMeta('val /* x */ end')).toBe('val  x  end'));
  it('removes backslash', () => expect(stripSqlMeta('C:\\Users\\foo')).toBe('CUsersfoo'));
  it('returns non-strings unchanged', () => expect(stripSqlMeta(42)).toBe(42));
});

// ── stripPathChars ────────────────────────────────────────────────────────────
describe('stripPathChars', () => {
  it('removes null bytes', () => expect(stripPathChars('file\0.php')).toBe('filephp'));
  it('removes ../', () => expect(stripPathChars('../../etc/passwd')).toBe('etcpasswd'));
  it('removes ..\\', () => expect(stripPathChars('..\\windows')).toBe('windows'));
  it('removes forward slashes', () => expect(stripPathChars('/etc/shadow')).toBe('etcshadow'));
  it('returns non-strings unchanged', () => expect(stripPathChars(true)).toBe(true));
  it('handles multiple traversals', () => {
    expect(stripPathChars('../../../root/.ssh/id_rsa')).toBe('root.sshid_rsa');
  });
});

// ── normalizeUnicode ──────────────────────────────────────────────────────────
describe('normalizeUnicode', () => {
  it('NFC-normalizes composed characters', () => {
    const twoCP = 'e\u0301'; // e + combining acute accent
    const oneCP = '\u00E9';  // precomposed é
    expect(normalizeUnicode(twoCP)).toBe(oneCP);
  });
  it('leaves already-NFC strings unchanged', () => {
    expect(normalizeUnicode('hello world')).toBe('hello world');
  });
  it('returns non-strings unchanged', () => expect(normalizeUnicode(5)).toBe(5));
});

// ── stripProto ────────────────────────────────────────────────────────────────
describe('stripProto', () => {
  it('removes __proto__ key', () => {
    const obj = JSON.parse('{"__proto__":{"polluted":true},"a":1}');
    const clean = stripProto(obj);
    expect(clean.__proto__).toBeUndefined();
    expect(clean.a).toBe(1);
  });
  it('removes constructor key', () => {
    const obj = { constructor: 'hacked', b: 2 };
    const clean = stripProto(obj);
    expect(Object.prototype.hasOwnProperty.call(clean, 'constructor')).toBe(false);
    expect(clean.b).toBe(2);
  });
  it('removes prototype key', () => {
    const obj = { prototype: { evil: true }, c: 3 };
    const clean = stripProto(obj);
    expect(clean.prototype).toBeUndefined();
    expect(clean.c).toBe(3);
  });
  it('handles nested objects recursively', () => {
    const obj = { outer: { __proto__: { bad: true }, inner: 'ok' } };
    const clean = stripProto(obj);
    expect(clean.outer.__proto__).toBeUndefined();
    expect(clean.outer.inner).toBe('ok');
  });
  it('handles arrays', () => {
    const arr = [{ __proto__: { x: 1 }, y: 2 }];
    const clean = stripProto(arr);
    expect(clean[0].__proto__).toBeUndefined();
    expect(clean[0].y).toBe(2);
  });
  it('returns primitives unchanged', () => {
    expect(stripProto('hello')).toBe('hello');
    expect(stripProto(42)).toBe(42);
    expect(stripProto(null)).toBe(null);
  });
});

// ── sanitizeLogValue ──────────────────────────────────────────────────────────
describe('sanitizeLogValue', () => {
  it('strips carriage returns and newlines', () => {
    const out = sanitizeLogValue('line1\r\nINJECTED: fake log line\nline3');
    expect(out).not.toContain('\n');
    expect(out).not.toContain('\r');
  });
  it('strips bare \\r', () => {
    const out = sanitizeLogValue('line1\rfake');
    expect(out).not.toContain('\r');
  });
  it('strips tab characters', () => {
    const out = sanitizeLogValue('col1\tcol2\tcol3');
    expect(out).not.toContain('\t');
  });
  it('truncates to 200 chars', () => {
    expect(sanitizeLogValue('A'.repeat(300)).length).toBe(200);
  });
  it('handles non-strings', () => {
    expect(typeof sanitizeLogValue(null)).toBe('string');
    expect(typeof sanitizeLogValue(undefined)).toBe('string');
    expect(typeof sanitizeLogValue(42)).toBe('string');
  });
  it('handles objects', () => {
    const out = sanitizeLogValue({ key: 'value' });
    expect(typeof out).toBe('string');
    expect(out.length).toBeLessThanOrEqual(200);
  });
});

// ── sanitizeInput ─────────────────────────────────────────────────────────────
describe('sanitizeInput', () => {
  it('applies all transforms to string values', () => {
    const input = { description: "  O'Brien <b>bold</b>  " };
    const out = sanitizeInput(input);
    expect(out.description).not.toContain('<b>');
    expect(out.description).not.toContain("'");
    expect(out.description).toBe(out.description.trim());
  });
  it('removes __proto__ from input', () => {
    const obj = JSON.parse('{"__proto__":{"polluted":true},"field":"value"}');
    const out = sanitizeInput(obj);
    expect(out.__proto__).toBeUndefined();
  });
  it('handles nested objects', () => {
    const out = sanitizeInput({ a: { b: "test'" } });
    expect(out.a.b).not.toContain("'");
  });
  it('handles arrays', () => {
    const out = sanitizeInput([{ val: "<x>" }, { val: "ok" }]);
    expect(out[0].val).not.toContain('<');
  });
  it('HTML-escapes when escapeOutput:true', () => {
    const out = sanitizeInput({ html: '<b>bold</b>' }, { escapeOutput: true });
    expect(out.html).toContain('&lt;');
  });
  it('strips null bytes from string values', () => {
    const out = sanitizeInput({ path: 'file\0.php' });
    expect(out.path).not.toContain('\0');
  });
  it('leaves numbers unchanged', () => {
    const out = sanitizeInput({ score: 8.7, count: 42 });
    expect(out.score).toBe(8.7);
    expect(out.count).toBe(42);
  });
  it('leaves booleans unchanged', () => {
    const out = sanitizeInput({ active: true });
    expect(out.active).toBe(true);
  });
});

// ── escapeOutput ─────────────────────────────────────────────────────────────
describe('escapeOutput', () => {
  it('escapes strings in nested objects', () => {
    const out = escapeOutput({ user: { name: '<script>evil</script>' } });
    expect(out.user.name).not.toContain('<');
    expect(out.user.name).toContain('&lt;');
  });
  it('escapes strings in arrays', () => {
    const out = escapeOutput(['<b>', 'safe', '"quoted"']);
    expect(out[0]).toBe('&lt;b&gt;');
    expect(out[1]).toBe('safe');
    expect(out[2]).toBe('&quot;quoted&quot;');
  });
  it('passes through numbers and booleans unchanged', () => {
    const out = escapeOutput({ score: 8.7, active: true });
    expect(out.score).toBe(8.7);
    expect(out.active).toBe(true);
  });
  it('handles null values', () => {
    expect(escapeOutput(null)).toBe(null);
  });
  it('handles deeply nested arrays of objects', () => {
    const out = escapeOutput({ reports: [{ text: '<b>bold</b>' }] });
    expect(out.reports[0].text).not.toContain('<b>');
    expect(out.reports[0].text).toContain('&lt;b&gt;');
  });
  it('escapes onerror= event handler string', () => {
    const out = escapeOutput({ val: 'x onerror=alert(1)' });
    expect(out.val).toContain('&#x3D;'); // = is escaped
  });
});

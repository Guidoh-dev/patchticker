'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classifyAuditResult, collect } = require('./collect-dependency-audit');

const report = counts => JSON.stringify({
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, ...counts } },
  vulnerabilities: {},
});

test('valid clean results pass, and valid findings remain distinct from scanner errors', () => {
  assert.equal(classifyAuditResult({ status: 0, stdout: report({}) }).state, 'clean');
  assert.deepEqual(classifyAuditResult({ status: 1, stdout: report({ critical: 1 }) }).counts.critical, 1);
  assert.equal(classifyAuditResult({ status: 1, stdout: report({ critical: 1 }) }).state, 'vulnerable');
});

test('registry errors, missing reports, and contradictory exit codes cannot look clean', () => {
  for (const result of [
    { status: 1, stdout: 'registry unavailable' },
    { status: 0, stdout: '' },
    { status: 1, stdout: JSON.stringify({ error: { code: 'E403' } }) },
    { status: 0, stdout: report({ critical: 1 }) },
    { status: 1, stdout: report({}) },
    { status: 2, stdout: report({}) },
    { status: null, stdout: report({}), error: new Error('network failure') },
  ]) assert.equal(classifyAuditResult(result).state, 'error');
});

test('collection audits both scopes from the root lockfile and persists failures', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patchticker-audit-test-'));
  const calls = [];
  try {
    const exitCode = collect(dir, (_bin, args, options) => {
      calls.push({ args, cwd: options.cwd });
      return calls.length === 1
        ? { status: 1, stdout: 'registry unavailable' }
        : { status: 0, stdout: report({}) };
    });
    assert.equal(exitCode, 2);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].cwd, path.resolve(__dirname, '..'));
    assert.equal(calls[0].args.includes('--workspaces'), false);
    assert.equal(calls[1].args.includes('--omit=dev'), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'))).all.state, 'error');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'))).production.state, 'clean');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

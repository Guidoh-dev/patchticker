#!/usr/bin/env node
'use strict';

// Both npm workspaces share the repository-root lockfile. Never treat a failed
// registry request, malformed JSON, or an absent report as a clean audit.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const levels = ['info', 'low', 'moderate', 'high', 'critical'];

function classifyAuditResult({ status, stdout, error }) {
  if (error || ![0, 1].includes(status)) return { state: 'error', reason: 'npm audit did not complete' };
  let report;
  try { report = JSON.parse(stdout); }
  catch { return { state: 'error', reason: 'npm audit returned invalid JSON' }; }
  if (!report || report.error || !report.metadata?.vulnerabilities ||
    !report.vulnerabilities || typeof report.vulnerabilities !== 'object') {
    return { state: 'error', reason: 'npm audit returned an incomplete report' };
  }
  const counts = report.metadata.vulnerabilities;
  if (levels.some(level => !Number.isInteger(counts[level]) || counts[level] < 0)) {
    return { state: 'error', reason: 'npm audit returned invalid vulnerability counts' };
  }
  const actionable = counts.moderate + counts.high + counts.critical;
  if ((status === 1) !== (actionable > 0)) {
    return { state: 'error', reason: 'npm audit exit code and report disagree' };
  }
  return { state: actionable ? 'vulnerable' : 'clean', counts: Object.fromEntries(levels.map(level => [level, counts[level]])) };
}

function collect(reportDir = path.join(root, 'audit-reports'), run = spawnSync) {
  fs.mkdirSync(reportDir, { recursive: true });
  const summary = {};
  for (const [scope, extra] of [['all', []], ['production', ['--omit=dev']]]) {
    const result = run('npm', ['audit', '--json', '--audit-level=moderate', ...extra], {
      cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
    });
    fs.writeFileSync(path.join(reportDir, `${scope}.json`), result.stdout || '');
    summary[scope] = classifyAuditResult(result);
    console.log(`${scope}: ${summary[scope].state}${summary[scope].counts ? ` (${JSON.stringify(summary[scope].counts)})` : ` (${summary[scope].reason})`}`);
  }
  fs.writeFileSync(path.join(reportDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  if (Object.values(summary).some(result => result.state === 'error')) return 2;
  if (Object.values(summary).some(result => result.state === 'vulnerable')) return 1;
  return 0;
}

if (require.main === module) {
  const flag = process.argv.indexOf('--report-dir');
  if (flag >= 0 && !process.argv[flag + 1]) {
    console.error('Usage: node scripts/collect-dependency-audit.js [--report-dir DIRECTORY]');
    process.exitCode = 2;
  } else {
    process.exitCode = collect(flag >= 0 ? path.resolve(process.argv[flag + 1]) : undefined);
  }
}

module.exports = { classifyAuditResult, collect };

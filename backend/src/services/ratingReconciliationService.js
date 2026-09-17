'use strict';

const db = require('../config/db');
const logger = require('../utils/logger');
const {
  deriveDeterministicScoreBreakdown,
  deriveDeterministicImpactScore,
  requireValidScore,
  statusForScore,
} = require('../utils/updateScore');

const DEFAULT_LIVE_DAYS = 240;

function list(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function objectValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function scoringInput(row) {
  const evidence = list(row.evidence);
  return {
    platform: row.platform,
    name: row.name,
    version: row.version,
    sourceKind: row.source_kind,
    changelog: list(row.changelog),
    knownIssues: list(row.known_issues),
    knownIssuesAuthoritative: evidence.some(item => item?.knownIssuesAuthoritative === true),
    riskFactors: list(row.risk_factors),
    evidence,
    securityCriticality: objectValue(row.security_criticality),
  };
}

function reconcileRow(row) {
  const input = scoringInput(row);
  const breakdown = deriveDeterministicScoreBreakdown(input);
  const score = requireValidScore(breakdown.score, 'reconciled score');
  const impactScore = requireValidScore(deriveDeterministicImpactScore(input), 'reconciled impact score');
  const status = statusForScore(score);
  const oldScore = Number(row.score);
  const oldImpactScore = row.impact_score === null ? null : Number(row.impact_score);
  return {
    id: row.id,
    score,
    status,
    impactScore,
    changed: oldScore !== score || row.status !== status || oldImpactScore !== impactScore,
  };
}

async function run({ liveDays = DEFAULT_LIVE_DAYS, dryRun = false } = {}) {
  if (!db.isAvailable()) return { status: 'db_unavailable', scanned: 0, changed: 0, updated: 0 };
  const boundedDays = Math.max(1, Math.min(365, Math.floor(Number(liveDays) || DEFAULT_LIVE_DAYS)));
  const client = await db.getClient();
  try {
    const result = await client.query(
      `SELECT id, platform, name, version, source_kind, score, status, impact_score,
              changelog, known_issues, risk_factors, evidence, security_criticality
         FROM software_updates
        WHERE released_at >= CURRENT_DATE - $1::integer
        ORDER BY released_at DESC, id ASC`,
      [boundedDays],
    );
    const reconciled = result.rows.map(reconcileRow);
    const changed = reconciled.filter(row => row.changed);
    if (dryRun || !changed.length) {
      return { status: dryRun ? 'dry_run' : 'current', scanned: reconciled.length, changed: changed.length, updated: 0 };
    }

    await client.query('BEGIN');
    try {
      for (const row of changed) {
        await client.query(
          `UPDATE software_updates
              SET score = $2, status = $3, impact_score = $4, updated_at = now()
            WHERE id = $1`,
          [row.id, row.score, row.status, row.impactScore],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    logger.info('[ratings] Deterministic ratings reconciled', {
      liveDays: boundedDays,
      scanned: reconciled.length,
      updated: changed.length,
    });
    return { status: 'updated', scanned: reconciled.length, changed: changed.length, updated: changed.length };
  } finally {
    client.release();
  }
}

module.exports = { run, __test: { scoringInput, reconcileRow } };

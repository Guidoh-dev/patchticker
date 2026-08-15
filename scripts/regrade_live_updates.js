#!/usr/bin/env node
'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../backend/.env') });

const db = require('../backend/src/config/db');
const {
  deriveDeterministicScoreBreakdown,
  deriveDeterministicImpactScore,
  requireValidScore,
  statusForScore,
} = require('../backend/src/utils/updateScore');

const APPLY = process.argv.includes('--apply');
const LIVE_DAYS = 240;

function list(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function objectValue(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function distribution(rows, field) {
  return Object.fromEntries([...rows.reduce((counts, row) => {
    const key = String(row[field]);
    counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
  }, new Map())].sort(([a], [b]) => Number(a) - Number(b)));
}

function toScoringInput(row) {
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

async function main() {
  await db.healthCheck();
  const client = await db.getClient();

  try {
    const result = await client.query(
      `SELECT id, platform, name, version, source_kind, released_at,
              score, status, impact_score, changelog, known_issues,
              risk_factors, evidence, security_criticality
         FROM software_updates
        WHERE released_at >= CURRENT_DATE - $1::integer
        ORDER BY released_at DESC, id ASC`,
      [LIVE_DAYS],
    );

    const regraded = result.rows.map(row => {
      const input = toScoringInput(row);
      const breakdown = deriveDeterministicScoreBreakdown(input);
      const score = requireValidScore(breakdown.score, 'regraded score');
      const impactScore = requireValidScore(deriveDeterministicImpactScore(input), 'regraded impact score');
      const status = statusForScore(score);
      return {
        id: row.id,
        oldScore: Number(row.score),
        score,
        oldStatus: row.status,
        status,
        oldImpactScore: row.impact_score === null ? null : Number(row.impact_score),
        impactScore,
        changed: Number(row.score) !== score || row.status !== status || Number(row.impact_score) !== impactScore,
        breakdown,
      };
    });

    if (regraded.some(row => !Number.isFinite(row.score) || row.score < 0 || row.score > 10)) {
      throw new Error('Regrade aborted: one or more ratings failed bounds validation.');
    }

    console.log(`PatchTicker deterministic rating regrade (${APPLY ? 'APPLY' : 'DRY RUN'})`);
    console.log(`Live window: ${LIVE_DAYS} days | rows: ${regraded.length} | changed: ${regraded.filter(row => row.changed).length}`);
    console.log('Old score distribution:', distribution(regraded, 'oldScore'));
    console.log('New score distribution:', distribution(regraded, 'score'));
    console.log('Old status distribution:', distribution(regraded, 'oldStatus'));
    console.log('New status distribution:', distribution(regraded, 'status'));

    for (const row of regraded) {
      const signals = row.breakdown.signals;
      console.log(
        `${row.id}: ${row.oldScore.toFixed(1)} -> ${row.score.toFixed(1)} (${row.oldStatus} -> ${row.status}); `
        + `sources=${signals.officialSources}, issues=${signals.unresolvedIssues}, risks=${signals.unresolvedRisks}, `
        + `fixes=${signals.resolvedChanges}, security=${signals.securityLevel}`,
      );
    }

    if (!APPLY) {
      console.log('\nDry run only. Re-run with --apply after reviewing this distribution.');
      return;
    }

    await client.query('BEGIN');
    let updated = 0;
    try {
      for (const row of regraded) {
        const update = await client.query(
          `UPDATE software_updates
              SET score = $2, status = $3, impact_score = $4, updated_at = now()
            WHERE id = $1`,
          [row.id, row.score, row.status, row.impactScore],
        );
        updated += update.rowCount;
      }
      if (updated !== regraded.length) {
        throw new Error(`Regrade aborted: expected ${regraded.length} updates, wrote ${updated}.`);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    const verification = await client.query(
      `SELECT COUNT(*)::integer AS rows,
              COUNT(*) FILTER (WHERE score < 0 OR score > 10 OR score IS NULL)::integer AS invalid_scores,
              COUNT(*) FILTER (
                WHERE status <> CASE
                  WHEN score >= 7.5 THEN 'stable'
                  WHEN score >= 5 THEN 'caution'
                  ELSE 'avoid'
                END
              )::integer AS invalid_statuses
         FROM software_updates
        WHERE released_at >= CURRENT_DATE - $1::integer`,
      [LIVE_DAYS],
    );
    const check = verification.rows[0];
    if (check.rows !== regraded.length || check.invalid_scores !== 0 || check.invalid_statuses !== 0) {
      throw new Error(`Post-commit verification failed: ${JSON.stringify(check)}`);
    }
    console.log(`\nApplied and verified ${updated} live ratings.`);
  } finally {
    client.release();
    await db.shutdown();
  }
}

main().catch(async error => {
  console.error(`Regrade failed: ${error.message}`);
  try { await db.shutdown(); } catch {}
  process.exitCode = 1;
});

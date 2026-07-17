// src/services/pipelineService.js
// ─────────────────────────────────────────────────────────────────────────────
// LIVE DATA PIPELINE — orchestrates the full update detection flow
//
// Flow per platform:
//   1. scraperService.detectPlatform(platform) → detected version
//   2. Check software_updates table — is this version already known?
//   3. If NEW: insert row, trigger AI analysis, fire watchlist alerts
//   4. If SAME: skip (no-op)
//
// This service is called by the cron job in cronService.js.
// It can also be triggered manually via POST /api/admin/pipeline/run (admin only).
//
// IDEMPOTENT — safe to run multiple times. The UNIQUE(platform, version)
// constraint on software_updates prevents duplicate rows.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const crypto           = require('crypto');
const db               = require('../config/db');
const logger           = require('../utils/logger');
const scraperService   = require('./scraperService');
const aiAnalysisService= require('./aiAnalysisService');
const watchlistService = require('./watchlistService');

// ── ID generation ─────────────────────────────────────────────────────────────
// Deterministic slug from platform + version: "nvidia-572-16"

function makeUpdateId(platform, version) {
  const slug = `${platform}-${version}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  return slug;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function getLatestKnownVersion(platform) {
  if (!db.isAvailable()) return null;
  const row = await db.query(
    `SELECT version FROM software_updates
     WHERE platform = $1
     ORDER BY released_at DESC, created_at DESC
     LIMIT 1`,
    [platform]
  );
  return row.rows[0]?.version || null;
}

async function insertUpdate(update) {
  await db.query(
    `INSERT INTO software_updates
       (id, platform, name, version, released_at, status, score,
        impact_score, bug_count, affects, verdict, reasoning,
        changelog, known_issues, risk_factors, evidence,
        security_criticality, subreddits,
        ai_generated, ai_model, ai_generated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     ON CONFLICT (id) DO NOTHING`,
    [
      update.id,
      update.platform,
      update.name,
      update.version,
      update.releasedAt,
      update.status          || 'caution',
      update.score           ?? 5.0,
      update.impactScore     ?? null,
      update.bugCount        ?? 0,
      update.affects         || null,
      update.verdict         || null,
      update.reasoning       || null,
      JSON.stringify(update.changelog      || []),
      JSON.stringify(update.knownIssues    || []),
      JSON.stringify(update.riskFactors    || []),
      JSON.stringify(update.evidence       || []),
      update.securityCriticality ? JSON.stringify(update.securityCriticality) : null,
      JSON.stringify(update.subreddits     || []),
      update.aiGenerated     || false,
      update.aiModel         || null,
      update.aiGeneratedAt   || null,
    ]
  );
}

async function updateWithAiResults(id, ai) {
  await db.query(
    `UPDATE software_updates SET
       status             = $2,
       score              = $3,
       impact_score       = $4,
       verdict            = $5,
       reasoning          = $6,
       security_criticality = $7,
       changelog          = $8,
       known_issues       = $9,
       ai_generated       = TRUE,
       ai_model           = $10,
       ai_generated_at    = $11,
       updated_at         = now()
     WHERE id = $1`,
    [
      id,
      ai.status              || 'caution',
      ai.score               ?? 5.0,
      ai.impactScore         ?? null,
      ai.verdict             || null,
      ai.reasoning           || null,
      ai.securityCriticality ? JSON.stringify(ai.securityCriticality) : null,
      JSON.stringify(ai.changelog   || []),
      JSON.stringify(ai.knownIssues || []),
      ai.aiModel             || null,
      ai.aiGeneratedAt       || null,
    ]
  );
}

// ── Status deriver ────────────────────────────────────────────────────────────
// Before AI runs we need a rough status to store. AI will refine it.

function deriveInitialStatus(score) {
  if (score >= 7.5) return 'stable';
  if (score >= 5.0) return 'caution';
  return 'avoid';
}

// ── Platform subreddit map ────────────────────────────────────────────────────

const PLATFORM_SUBREDDITS = {
  Windows: ['Windows11', 'sysadmin'],
  NVIDIA:  ['nvidia', 'hardware'],
  AMD:     ['Amd', 'Amd_drivers'],
  Apple:   ['iphone', 'ios'],
  macOS:   ['MacOS', 'apple'],
  Steam:   ['Steam', 'SteamDeck', 'linux_gaming'],
  Epic:    ['EpicGamesPC', 'pcgaming'],
  Xbox:    ['XboxSeriesX', 'xboxone'],
  PS5:     ['PS5', 'playstation'],
  Intel:   ['IntelArc', 'hardware'],
  Switch:  ['NintendoSwitch'],
  Discord: ['discordapp'],
  BattleNet: ['Blizzard', 'pcgaming'],
  GOG: ['gog', 'pcgaming'],
};

// ── Main: process a single platform ──────────────────────────────────────────

async function processPlatform(platform) {
  const logCtx = { platform };

  // 1. Detect latest version from vendor source
  const detected = await scraperService.detectPlatform(platform);
  if (!detected) {
    logger.info('[pipeline] No update detected', logCtx);
    return { platform, status: 'no_update', version: null };
  }

  logCtx.version = detected.version;

  // 2. Compare to latest known version in DB
  if (!db.isAvailable()) {
    logger.warn('[pipeline] DB unavailable — skipping upsert', logCtx);
    return { platform, status: 'db_unavailable', version: detected.version };
  }

  const knownVersion = await getLatestKnownVersion(platform);
  if (knownVersion === detected.version) {
    logger.info('[pipeline] Version unchanged', { ...logCtx, knownVersion });
    return { platform, status: 'unchanged', version: detected.version };
  }

  logger.info('[pipeline] New version detected', { ...logCtx, knownVersion, newVersion: detected.version });

  // 3. Build initial update row with placeholder score
  const id = makeUpdateId(platform, detected.version);
  const initialUpdate = {
    id,
    platform,
    name:        detected.name,
    version:     detected.version,
    releasedAt:  detected.releasedAt,
    status:      'caution',   // default until AI refines
    score:       5.0,
    bugCount:    0,
    changelog:   detected.changelog || [],
    knownIssues: [],
    riskFactors: [],
    evidence:    detected.sourceUrl
      ? [{ source: platform, url: detected.sourceUrl, text: `New ${platform} update detected` }]
      : [],
    subreddits:  PLATFORM_SUBREDDITS[platform] || [],
  };

  // 4. Insert into DB (ON CONFLICT DO NOTHING = idempotent)
  await insertUpdate(initialUpdate);
  logger.info('[pipeline] Inserted new update', logCtx);

  // 5. Run AI analysis if configured
  if (aiAnalysisService.isEnabled()) {
    try {
      const ai = await aiAnalysisService.analyseUpdate(initialUpdate);
      if (ai) {
        // Derive status from AI score
        ai.status = deriveInitialStatus(ai.score);
        await updateWithAiResults(id, ai);
        logger.info('[pipeline] AI analysis applied', { ...logCtx, score: ai.score, status: ai.status });

        // Use AI-enriched data for alerts
        Object.assign(initialUpdate, ai);
        initialUpdate.status = ai.status;
        initialUpdate.score  = ai.score;
      }
    } catch (err) {
      logger.warn('[pipeline] AI analysis failed — proceeding with defaults', { ...logCtx, error: err.message });
    }
  }

  // 6. Fire watchlist alerts to subscribed Pro users
  try {
    await watchlistService.notifySubscribers(platform, {
      id:      id,
      name:    initialUpdate.name,
      version: initialUpdate.version,
      status:  initialUpdate.status,
      score:   initialUpdate.score,
      verdict: initialUpdate.verdict || `New ${platform} update available: ${initialUpdate.name}`,
    });
  } catch (err) {
    logger.warn('[pipeline] Watchlist notify failed', { ...logCtx, error: err.message });
  }

  return {
    platform,
    status:  'new_update',
    version: detected.version,
    id,
    score:   initialUpdate.score,
    aiRan:   aiAnalysisService.isEnabled(),
  };
}

// ── Run all platforms ─────────────────────────────────────────────────────────

async function runAll() {
  const platforms = Object.keys(scraperService.DETECTORS);
  logger.info('[pipeline] Starting full run', { platforms: platforms.length });

  const results = await Promise.allSettled(
    platforms.map(p => processPlatform(p))
  );

  const summary = {
    total:      platforms.length,
    newUpdates: 0,
    unchanged:  0,
    failed:     0,
    results:    [],
  };

  for (const r of results) {
    if (r.status === 'fulfilled') {
      summary.results.push(r.value);
      if (r.value.status === 'new_update') summary.newUpdates++;
      else if (r.value.status === 'unchanged') summary.unchanged++;
    } else {
      summary.failed++;
      logger.error('[pipeline] Platform run failed', { error: r.reason?.message });
    }
  }

  logger.info('[pipeline] Run complete', {
    newUpdates: summary.newUpdates,
    unchanged:  summary.unchanged,
    failed:     summary.failed,
  });

  return summary;
}

module.exports = { processPlatform, runAll };

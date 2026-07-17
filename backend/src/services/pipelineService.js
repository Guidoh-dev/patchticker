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


function platformContext(platform, detected) {
  const defaults = {
    Windows: {
      affects: 'Windows PCs / cumulative updates / security fixes / system stability / enterprise deployment',
      verdict: 'Review the KB notes and early install reports before broad rollout; security fixes usually make this worth scheduling quickly.',
      reasoning: 'Windows cumulative updates can include security patches, servicing-stack changes, driver interactions, and known issues. PatchTicker tracks the official Microsoft support article and watches for rollback or install-failure patterns.',
    },
    NVIDIA: {
      affects: 'NVIDIA GeForce GPUs / Game Ready driver / DLSS / game compatibility / creator workflows',
      verdict: 'Install if the listed game support or fixes apply; wait if your current driver is stable and you do not need the new profile support.',
      reasoning: 'NVIDIA Game Ready drivers often improve new-game support and fix GPU-specific issues, but driver updates can affect performance, overlays, capture tools, and multi-monitor setups.',
    },
    AMD: {
      affects: 'AMD Radeon GPUs / Adrenalin driver / Windows gaming performance / game compatibility',
      verdict: 'Check game-specific fixes and known issues before updating, especially if your current Radeon driver is stable.',
      reasoning: 'AMD Adrenalin releases can improve game support and fix crashes, but driver updates may also introduce regressions for specific GPU families or titles.',
    },
    Apple: {
      affects: 'iPhone / iPad / WebKit / system security / app compatibility',
      verdict: 'Prioritize this update when it includes security fixes, especially for WebKit, kernel, or actively exploited vulnerabilities.',
      reasoning: 'Apple security updates frequently include CVE fixes that are safest to apply promptly after checking device eligibility and app compatibility.',
    },
    macOS: {
      affects: 'Mac / macOS / Safari-WebKit / system security / device stability',
      verdict: 'Prioritize security updates, but confirm compatibility for work-critical apps, extensions, VPNs, and device-management tools.',
      reasoning: 'macOS releases can affect security posture, Safari/WebKit behavior, kernel extensions, peripherals, and managed-device workflows.',
    },
    Steam: {
      affects: 'Steam client / SteamOS / Steam Deck / game library / downloads / compatibility layers',
      verdict: 'Good candidate for Steam Deck or Steam client users unless early reports mention install, compatibility, or download regressions.',
      reasoning: 'Steam and SteamOS updates can change handheld behavior, controller input, Proton compatibility, downloads, library management, and client stability.',
    },
    Switch: {
      affects: 'Nintendo Switch / system firmware / eShop / online play / controller behavior',
      verdict: 'Install for online services and compatibility unless early reports flag firmware or controller regressions.',
      reasoning: 'Switch firmware updates can affect online play, eShop access, Joy-Con behavior, system stability, and game compatibility.',
    },
    Discord: {
      affects: 'Discord desktop / voice chat / overlay / streaming / API and gateway services',
      verdict: 'Safe for most users, but verify overlay and voice behavior if Discord is part of your gaming setup.',
      reasoning: 'Discord incidents and client changes can affect voice chat, overlay, streaming, notifications, and rich presence during gaming sessions.',
    },
    BattleNet: {
      affects: 'Battle.net desktop app / Blizzard games / login / patch downloads / launcher services',
      verdict: 'Watch login and patch-download reports before major game sessions; launcher issues can block play even when games are stable.',
      reasoning: 'Battle.net changes can affect authentication, patch delivery, game launch, social features, and service availability for Blizzard titles.',
    },
    GOG: {
      affects: 'GOG Galaxy / library sync / cloud saves / cross-store integrations / Windows and macOS client',
      verdict: 'Safe for most users, but check cloud-save and library-sync behavior if you use GOG Galaxy as a launcher hub.',
      reasoning: 'GOG Galaxy updates can affect library sync, cloud saves, installed-game detection, and integrations with other storefronts.',
    },
    PS5: {
      affects: 'PlayStation 5 / system software / online services / controller and game compatibility',
      verdict: 'Install for online play and system security unless early user reports flag a PS5-specific regression.',
      reasoning: 'PS5 system updates can affect online play, firmware behavior, controller support, rest mode, and system stability.',
    },
    Xbox: {
      affects: 'Xbox Series X|S / Xbox One / dashboard / network services / controller and game compatibility',
      verdict: 'Install for normal console use unless community reports show dashboard, network, or game-launch regressions.',
      reasoning: 'Xbox system updates can change dashboard behavior, networking, controller handling, game launch, and store/service reliability.',
    },
    Intel: {
      affects: 'Intel Arc GPUs / Core Ultra Arc graphics / Windows graphics driver / game compatibility',
      verdict: 'Good candidate for Arc users chasing game fixes or compatibility updates; wait if your current driver is stable and no listed fix applies.',
      reasoning: 'Intel graphics drivers often bundle game optimizations, device support, display fixes, and compatibility updates for Arc and Core Ultra graphics.',
    },
    Epic: {
      affects: 'Epic Games Launcher / store services / game downloads / account login',
      verdict: 'Wait for user reports if the launcher update affects downloads, sign-in, or game launch before a planned session.',
      reasoning: 'Epic launcher or service changes can affect sign-in, game downloads, cloud saves, and library access.',
    },
  }[platform] || {};
  const verdict = detected.verdict || defaults.verdict || `New ${platform} update available: ${detected.name}`;
  const reasoning = detected.reasoning || defaults.reasoning || `PatchTicker detected a new ${platform} release from the vendor source and is tracking user reports, known issues, and install confidence as more evidence arrives.`;
  return {
    affects: detected.affects || defaults.affects || `${platform} devices, software, and related services`,
    verdict,
    reasoning,
    changelog: detected.changelog?.length ? detected.changelog : [reasoning],
    knownIssues: detected.knownIssues || [],
    riskFactors: detected.riskFactors || [],
    evidence: detected.evidence || (detected.sourceUrl ? [{ source: platform, url: detected.sourceUrl, text: `Current ${platform} update verified from official source` }] : []),
  };
}

async function updateExistingMetadata(platform, version, detected) {
  const context = platformContext(platform, detected);
  await db.query(
    `UPDATE software_updates SET
       affects = COALESCE($3, affects),
       verdict = COALESCE($4, verdict),
       reasoning = COALESCE($5, reasoning),
       changelog = CASE WHEN $6::jsonb <> '[]'::jsonb THEN $6::jsonb ELSE changelog END,
       known_issues = CASE WHEN $7::jsonb <> '[]'::jsonb THEN $7::jsonb ELSE known_issues END,
       risk_factors = CASE WHEN $8::jsonb <> '[]'::jsonb THEN $8::jsonb ELSE risk_factors END,
       evidence = CASE WHEN $9::jsonb <> '[]'::jsonb THEN $9::jsonb ELSE evidence END,
       updated_at = now()
     WHERE platform = $1 AND version = $2`,
    [
      platform,
      version,
      context.affects,
      context.verdict,
      context.reasoning,
      JSON.stringify(context.changelog),
      JSON.stringify(context.knownIssues),
      JSON.stringify(context.riskFactors),
      JSON.stringify(context.evidence),
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
    await updateExistingMetadata(platform, detected.version, detected);
    logger.info('[pipeline] Version unchanged — metadata refreshed', { ...logCtx, knownVersion });
    return { platform, status: 'unchanged', version: detected.version };
  }

  logger.info('[pipeline] New version detected', { ...logCtx, knownVersion, newVersion: detected.version });

  // 3. Build initial update row with placeholder score
  const id = makeUpdateId(platform, detected.version);
  const context = platformContext(platform, detected);
  const initialUpdate = {
    id,
    platform,
    name:        detected.name,
    version:     detected.version,
    releasedAt:  detected.releasedAt,
    status:      'caution',   // default until AI refines
    score:       5.0,
    bugCount:    0,
    affects:     context.affects,
    verdict:     context.verdict,
    reasoning:   context.reasoning,
    changelog:   context.changelog,
    knownIssues: context.knownIssues,
    riskFactors: context.riskFactors,
    evidence:    context.evidence,
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

  results.forEach((r, index) => {
    const platform = platforms[index];
    if (r.status === 'fulfilled') {
      summary.results.push(r.value);
      if (r.value.status === 'new_update') summary.newUpdates++;
      else if (r.value.status === 'unchanged') summary.unchanged++;
    } else {
      summary.failed++;
      const message = r.reason?.message || 'Unknown pipeline error';
      summary.results.push({ platform, status: 'failed', error: message });
      logger.error('[pipeline] Platform run failed', { platform, error: message });
    }
  });

  logger.info('[pipeline] Run complete', {
    newUpdates: summary.newUpdates,
    unchanged:  summary.unchanged,
    failed:     summary.failed,
  });

  return summary;
}

module.exports = { processPlatform, runAll };

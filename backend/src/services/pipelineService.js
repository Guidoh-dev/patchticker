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

const db               = require('../config/db');
const logger           = require('../utils/logger');
const scraperService   = require('./scraperService');
const aiAnalysisService= require('./aiAnalysisService');
const watchlistService = require('./watchlistService');
const { PLATFORM_KEYS } = require('../config/platformRegistry');
const {
  deriveDeterministicScore,
  deriveDeterministicImpactScore,
  requireValidScore,
  statusForScore,
} = require('../utils/updateScore');

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

const SOURCE_REGRESSION_TOLERANCE_MS = 36 * 60 * 60 * 1000;
const MONTH_PLACEHOLDER_PLATFORMS = new Set(['BattleNet', 'GOG', 'Xbox']);

function isCanonicalPipelineRelease(release) {
  const platform = String(release?.platform || '');
  const version = String(release?.version || '').trim();
  if (!version) return false;
  if (platform === 'PS5') return /^PUP-\d{4}\.\d{2}\.\d{2}-[a-f0-9]{8}$/i.test(version);
  if (MONTH_PLACEHOLDER_PLATFORMS.has(platform) && /^\d{4}-\d{2}$/.test(version)) return false;
  if (['Steam', 'Discord'].includes(platform) && /^[A-Z][a-z]{2,8}\s+\d{4}$/.test(version)) return false;
  return true;
}

async function getLatestKnownRelease(platform) {
  if (!db.isAvailable()) return null;
  const sourceScope = platform === 'Steam'
    ? "AND source_kind IS DISTINCT FROM 'steam-game-news'"
    : '';
  const result = await (db.queryRead || db.query)(
    `SELECT id, platform, version, released_at FROM software_updates
     WHERE platform = $1
     ${sourceScope}
     ORDER BY released_at DESC, created_at DESC
     LIMIT 20`,
    [platform]
  );
  return result.rows.find(isCanonicalPipelineRelease) || null;
}

async function getKnownReleaseByVersion(platform, version) {
  if (!db.isAvailable()) return null;
  const sourceScope = platform === 'Steam'
    ? "AND source_kind IS DISTINCT FROM 'steam-game-news'"
    : '';
  const row = await (db.queryRead || db.query)(
    `SELECT id, version, released_at FROM software_updates
     WHERE platform = $1 AND version = $2
     ${sourceScope}
     LIMIT 1`,
    [platform, version]
  );
  return row.rows[0] || null;
}

function isSourceVersionRegression(latest, detected) {
  if (!latest?.version || latest.version === detected?.version) return false;
  const latestMs = Date.parse(latest.released_at || latest.releasedAt || '');
  const detectedMs = Date.parse(detected?.releasedAt || '');
  if (!Number.isFinite(latestMs) || !Number.isFinite(detectedMs)) return false;
  return detectedMs + SOURCE_REGRESSION_TOLERANCE_MS < latestMs;
}

async function insertUpdate(update) {
  let score;
  let impactScore;
  try {
    score = requireValidScore(update.score);
    impactScore = update.impactScore === null || update.impactScore === undefined
      ? null
      : requireValidScore(update.impactScore, 'impact score');
  } catch (error) {
    logger.error('[pipeline] Rejected update with invalid deterministic rating', {
      updateId: update?.id || null,
      field: error.field || null,
      reason: error.reason || error.message,
    });
    throw error;
  }
  const status = statusForScore(score);
  const result = await db.query(
    `INSERT INTO software_updates
       (id, platform, name, version, display_version, source_kind, source_ref, product_id,
        released_at, status, score,
        impact_score, bug_count, affects, verdict, reasoning,
        changelog, known_issues, risk_factors, evidence,
        security_criticality, subreddits,
        ai_generated, ai_model, ai_generated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      update.id,
      update.platform,
      update.name,
      update.version,
      update.displayVersion || null,
      update.sourceKind || null,
      update.sourceRef || null,
      update.productId || null,
      update.releasedAt,
      status,
      score,
      impactScore,
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
  return Boolean(result.rows?.[0]?.id);
}

async function updateWithAiResults(id, ai) {
  await db.query(
    `UPDATE software_updates SET
       verdict            = $2,
       reasoning          = $3,
       ai_generated       = TRUE,
       ai_model           = $4,
       ai_generated_at    = $5,
       updated_at         = now()
     WHERE id = $1`,
    [
      id,
      ai.verdict             || null,
      ai.reasoning           || null,
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
  }[platform] || {};
  const verdict = detected.verdict || defaults.verdict || `New ${platform} update available: ${detected.name}`;
  const reasoning = detected.reasoning || defaults.reasoning || `PatchTicker detected a new ${platform} release from the vendor source and is tracking user reports, known issues, and install confidence as more evidence arrives.`;
  const baseEvidence = detected.evidence?.length
    ? detected.evidence
    : (detected.sourceUrl ? [{ source: platform, url: detected.sourceUrl, text: `Current ${platform} update verified from official source` }] : []);
  const evidence = baseEvidence.map(item => ({
    ...item,
    ...(detected.knownIssuesAuthoritative === true ? { knownIssuesAuthoritative: true } : {}),
  }));
  return {
    affects: detected.affects || defaults.affects || `${platform} devices, software, and related services`,
    verdict,
    reasoning,
    changelog: detected.changelog?.length ? detected.changelog : [reasoning],
    knownIssues: detected.knownIssues || [],
    knownIssuesAuthoritative: detected.knownIssuesAuthoritative === true,
    riskFactors: detected.riskFactors || [],
    evidence,
    securityCriticality: detected.securityCriticality || null,
  };
}

async function updateExistingMetadata(platform, version, detected) {
  const context = platformContext(platform, detected);
  const fallbackScore = deriveInitialScore(platform, detected, context);
  const fallbackStatus = deriveInitialStatus(fallbackScore);
  await db.query(
    `UPDATE software_updates SET
       name = COALESCE($3, name),
       released_at = COALESCE($4, released_at),
       affects = COALESCE($5, affects),
       verdict = COALESCE($6, verdict),
       reasoning = COALESCE($7, reasoning),
       changelog = CASE WHEN $8::jsonb <> '[]'::jsonb THEN $8::jsonb ELSE changelog END,
       known_issues = CASE WHEN $9::jsonb <> '[]'::jsonb OR $15::boolean THEN $9::jsonb ELSE known_issues END,
       risk_factors = CASE WHEN $10::jsonb <> '[]'::jsonb THEN $10::jsonb ELSE risk_factors END,
       evidence = CASE WHEN $11::jsonb <> '[]'::jsonb THEN $11::jsonb ELSE evidence END,
       security_criticality = COALESCE($12::jsonb, security_criticality),
       score = $13,
       status = $14,
       display_version = COALESCE($16, display_version),
       source_kind = COALESCE($17, source_kind),
       source_ref = COALESCE($18, source_ref),
       product_id = COALESCE($19, product_id),
       updated_at = now()
     WHERE platform = $1 AND version = $2`,
    [
      platform,
      version,
      detected.name,
      detected.releasedAt,
      context.affects,
      context.verdict,
      context.reasoning,
      JSON.stringify(context.changelog),
      JSON.stringify(context.knownIssues),
      JSON.stringify(context.riskFactors),
      JSON.stringify(context.evidence),
      context.securityCriticality ? JSON.stringify(context.securityCriticality) : null,
      fallbackScore,
      fallbackStatus,
      context.knownIssuesAuthoritative,
      detected.displayVersion || null,
      detected.sourceKind || null,
      detected.sourceRef || null,
      detected.productId || null,
    ]
  );
}

// ── Status deriver ────────────────────────────────────────────────────────────
// Before AI runs we need a rough status to store. AI will refine it.

function deriveInitialStatus(score) {
  return statusForScore(score);
}

function deriveInitialScore(platform, detected, context) {
  return deriveDeterministicScore({
    platform,
    name: detected?.name,
    version: detected?.version,
    releaseChannel: detected?.releaseChannel,
    changelog: context?.changelog,
    knownIssues: context?.knownIssues,
    knownIssuesAuthoritative: context?.knownIssuesAuthoritative,
    riskFactors: context?.riskFactors,
    evidence: context?.evidence,
    securityCriticality: context?.securityCriticality,
  });
}

// ── Platform subreddit map ────────────────────────────────────────────────────

const PLATFORM_SUBREDDITS = {
  Windows: ['Windows11', 'sysadmin'],
  NVIDIA:  ['nvidia', 'hardware'],
  AMD:     ['Amd', 'Amd_drivers'],
  Apple:   ['iphone', 'ios'],
  macOS:   ['MacOS', 'apple'],
  Steam:   ['Steam', 'SteamDeck', 'linux_gaming'],
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
  const detection = await scraperService.detectPlatformDetailed(platform);
  if (!detection.ok) {
    logger.warn('[pipeline] Source unavailable', { ...logCtx, attempts: detection.attempts, error: detection.error });
    return {
      platform,
      status: 'source_unavailable',
      version: null,
      attempts: detection.attempts,
      latencyMs: detection.latencyMs,
      error: detection.error,
    };
  }
  const detected = detection.result;

  logCtx.version = detected.version;

  // 2. Compare to latest known version in DB
  if (!db.isAvailable()) {
    logger.warn('[pipeline] DB unavailable — skipping upsert', logCtx);
    return { platform, status: 'db_unavailable', version: detected.version, latencyMs: detection.latencyMs };
  }

  const latestKnown = await getLatestKnownRelease(platform);
  const knownVersion = latestKnown?.version || null;
  if (knownVersion === detected.version) {
    await updateExistingMetadata(platform, detected.version, detected);
    logger.info('[pipeline] Version unchanged — metadata refreshed', { ...logCtx, knownVersion });
    return { platform, status: 'unchanged', version: detected.version, latencyMs: detection.latencyMs, attempts: detection.attempts };
  }

  // Vendor APIs and CDNs can briefly return a cached older artifact. Refresh
  // known history without alerting, and reject unknown releases whose source
  // date materially predates the current release. This keeps a source wobble
  // from becoming a false "new update" notification.
  const historicalRelease = await getKnownReleaseByVersion(platform, detected.version);
  if (historicalRelease) {
    await updateExistingMetadata(platform, detected.version, detected);
    logger.warn('[pipeline] Historical source version refreshed without alerting', {
      ...logCtx,
      currentVersion: knownVersion,
    });
    return {
      platform,
      status: 'historical_refresh',
      version: detected.version,
      currentVersion: knownVersion,
      latencyMs: detection.latencyMs,
      attempts: detection.attempts,
    };
  }

  if (isSourceVersionRegression(latestKnown, detected)) {
    logger.warn('[pipeline] Rejected regressed source version', {
      ...logCtx,
      currentVersion: knownVersion,
      currentReleasedAt: latestKnown?.released_at,
      detectedReleasedAt: detected.releasedAt,
    });
    return {
      platform,
      status: 'source_regression',
      version: detected.version,
      currentVersion: knownVersion,
      latencyMs: detection.latencyMs,
      attempts: detection.attempts,
    };
  }

  logger.info('[pipeline] New version detected', { ...logCtx, knownVersion, newVersion: detected.version });

  // 3. Build initial update row with deterministic fallback scoring.
  // AI can refine this later, but the public feed should never default every
  // newly detected patch to 5/10 when an AI provider is unavailable.
  const id = makeUpdateId(platform, detected.version);
  const context = platformContext(platform, detected);
  const initialScore = deriveInitialScore(platform, detected, context);
  const initialImpactScore = deriveDeterministicImpactScore({
    changelog: context.changelog,
    riskFactors: context.riskFactors,
    securityCriticality: context.securityCriticality,
  });
  const initialUpdate = {
    id,
    platform,
    name:        detected.name,
    version:     detected.version,
    displayVersion: detected.displayVersion || null,
    sourceKind:  detected.sourceKind || null,
    sourceRef:   detected.sourceRef || null,
    productId:   detected.productId || null,
    releasedAt:  detected.releasedAt,
    status:      deriveInitialStatus(initialScore),
    score:       initialScore,
    impactScore: initialImpactScore,
    bugCount:    0,
    affects:     context.affects,
    verdict:     context.verdict,
    reasoning:   context.reasoning,
    changelog:   context.changelog,
    knownIssues: context.knownIssues,
    riskFactors: context.riskFactors,
    evidence:    context.evidence,
    securityCriticality: context.securityCriticality,
    subreddits:  PLATFORM_SUBREDDITS[platform] || [],
  };

  // 4. Insert into DB (ON CONFLICT DO NOTHING = idempotent)
  const inserted = await insertUpdate(initialUpdate);
  if (!inserted) {
    logger.warn('[pipeline] Duplicate release ignored without alerting', logCtx);
    return {
      platform,
      status: 'duplicate',
      version: detected.version,
      id,
      latencyMs: detection.latencyMs,
      attempts: detection.attempts,
    };
  }
  logger.info('[pipeline] Inserted new update', logCtx);

  // 5. Run AI analysis if configured
  let aiApplied = false;
  if (aiAnalysisService.isEnabled()) {
    try {
      const ai = await aiAnalysisService.analyseUpdate(initialUpdate);
      if (ai) {
        await updateWithAiResults(id, ai);
        logger.info('[pipeline] Grounded text analysis applied; deterministic rating preserved', {
          ...logCtx,
          score: initialUpdate.score,
          status: initialUpdate.status,
        });

        // Generated text may enrich the brief, but can never replace the
        // deterministic score, impact score, or status.
        Object.assign(initialUpdate, ai);
        aiApplied = true;
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
    aiRan:   aiApplied,
    latencyMs: detection.latencyMs,
    attempts: detection.attempts,
  };
}

// ── Run all platforms ─────────────────────────────────────────────────────────

async function runAll() {
  const platforms = PLATFORM_KEYS.filter(platform => scraperService.DETECTORS[platform]);
  logger.info('[pipeline] Starting full run', { platforms: platforms.length });

  // Keep database work below the Supabase transaction-pooler ceiling while
  // still overlapping vendor network requests. This is especially important
  // when a sleeping Render instance performs its startup catch-up scan.
  const concurrency = Math.max(1, Number(process.env.PIPELINE_CONCURRENCY || 2));
  const results = [];
  for (let i = 0; i < platforms.length; i += concurrency) {
    const batch = platforms.slice(i, i + concurrency);
    results.push(...await Promise.allSettled(batch.map(p => processPlatform(p))));
  }

  const summary = {
    total:      platforms.length,
    newUpdates: 0,
    unchanged:  0,
    historicalRefreshes: 0,
    regressed:  0,
    duplicates: 0,
    unavailable: 0,
    failed:     0,
    results:    [],
  };

  results.forEach((r, index) => {
    const platform = platforms[index];
    if (r.status === 'fulfilled') {
      summary.results.push(r.value);
      if (r.value.status === 'new_update') summary.newUpdates++;
      else if (r.value.status === 'unchanged') summary.unchanged++;
      else if (r.value.status === 'historical_refresh') summary.historicalRefreshes++;
      else if (r.value.status === 'source_regression') summary.regressed++;
      else if (r.value.status === 'duplicate') summary.duplicates++;
      else if (r.value.status === 'source_unavailable') summary.unavailable++;
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
    historicalRefreshes: summary.historicalRefreshes,
    regressed:  summary.regressed,
    duplicates: summary.duplicates,
    unavailable: summary.unavailable,
    failed:     summary.failed,
  });

  return summary;
}

module.exports = {
  processPlatform,
  runAll,
  __test: {
    platformContext,
    getLatestKnownRelease,
    getKnownReleaseByVersion,
    updateExistingMetadata,
    updateWithAiResults,
    deriveInitialScore,
    deriveInitialStatus,
    isCanonicalPipelineRelease,
    isSourceVersionRegression,
  },
};

// src/services/steamGamePipelineService.js
// Tracks material game releases for the vetted >15k-average Steam roster.
//
// Cost controls:
//   - Uses Valve's public ISteamNews endpoint (no API key or paid service).
//   - Never calls the Anthropic analysis service.
//   - Polls a fixed, reviewed game roster with bounded concurrency.
//
// Editorial controls:
//   - Only first-party Steam Community announcements are considered.
//   - Hotfixes, maintenance, previews/PTBs, and minor updates are rejected.
//   - A release must materially change gameplay or system requirements.
//   - Package size is recorded only when the publisher explicitly states it.

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('node:url');
const db = require('../config/db');
const logger = require('../utils/logger');
const {
  deriveDeterministicScore,
  deriveDeterministicImpactScore,
  requireValidScore,
  statusForScore,
} = require('../utils/updateScore');
const {
  STEAM_GAME_CANDIDATE_SNAPSHOT,
  STEAM_GAME_CANDIDATES,
} = require('../data/steamGameCandidates');

const STEAM_NEWS_URL = 'https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/';
const OFFICIAL_FEED = 'steam_community_announcements';
const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_POST_COUNT = 10;
const MAX_POST_CHARACTERS = 12000;
const MIN_EXPLICIT_PACKAGE_BYTES = 250 * 1024 * 1024;

const SMALL_RELEASE_RE = /\b(?:hot[ -]?fix|micro[ -]?patch|bug[ -]?fix(?:es)?(?: patch)?|minor update|small update|quick fix|update fixes|maintenance(?: update)?|server maintenance)\b/i;
const PRERELEASE_RE = /\b(?:ptb|public test build|test server|beta|preview|experimental|playtest|developer update|dev diary|dev blog|roadmap|coming soon|what we(?:'|’)re working on|state of the game|community crunch|deep dive|research trip|wishlist now)\b/i;
const DATED_ARRIVAL_RE = /\barrives?\s+(?:on\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{1,2})\b/i;
const SMALL_OPENING_RE = /^(?:this\s+(?:release|update|patch)\s+(?:is\s+)?(?:a\s+)?|a\s+)?(?:hot[ -]?fix|micro[ -]?patch|minor update|small update|quick fix|maintenance update)\b/i;
const TITLE_RELEASE_RE = /\b(?:patch(?: notes?)?|gameplay patch|content update|major update|title update|update|release notes?|stable released|version \d)\b/i;
const BODY_RELEASE_RE = /\b(?:patch notes?|update (?:is )?(?:now )?(?:live|available|out now)|has been released|stable (?:build )?released|version \d+(?:\.\d+)+ (?:is )?(?:now )?(?:live|available))\b/i;
const MAJOR_RELEASE_RE = /\b(?:major (?:gameplay )?update|gameplay patch|content update|title update|new season|season \d|expansion|new chapter|chapter \d|overhaul|rework|launch update|update (?:is )?(?:live|available|out now))\b/i;
const GAMEPLAY_RE = /\b(?:gameplay|game mode|map|level|weapon|hero|character|class|ability|skill|quest|mission|boss|enemy|vehicle|combat|movement|physics|matchmaking|progression|economy|crafting|building|ranked|balance|rework|overhaul|new biome|new area|new faction|new mechanic|loot|inventory|level cap)\b/i;
const REQUIREMENTS_RE = /\b(?:system requirements?|minimum specs?|recommended specs?|directx\s*1[12]|vulkan|64-bit|windows\s*(?:10|11)|macos|linux|steam deck|anti-cheat|kernel driver|engine upgrade|unreal engine\s*5|dropped support|no longer support|now requires?|hardware requirement)\b/i;
const STABILITY_RISK_RE = /\b(?:known issue|crash|data loss|save corruption|rollback|disabled|degraded|performance regression|stutter|disconnect|cannot launch|failed to launch)\b/i;

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function stripSteamMarkup(value) {
  const withBreaks = String(value || '')
    .replace(/\[(?:br|p)\]/gi, '\n')
    .replace(/\[\/(?:p|h[1-6]|list)\]/gi, '\n')
    .replace(/\[\*\]/gi, '\n• ')
    .replace(/\[url=[^\]]+\]([\s\S]*?)\[\/url\]/gi, '$1')
    .replace(/\[img\][\s\S]*?\[\/img\]/gi, ' ')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/<\/(?:li|p|h[1-6]|div)>/gi, '\n')
    .replace(/<br\s*\/?\s*>/gi, '\n');
  const decoded = cheerio.load(`<body>${withBreaks}</body>`).text();
  return decoded
    .replace(/\r/g, '')
    // Valve's bounded news response can flatten heading markup completely
    // ("INTROWelcome" or "UPDATESGameplay"). Restore readable boundaries
    // before extracting sentences and changelog items.
    .replace(/\b(CHANGES AND UPDATES|BUG FIXES|KNOWN ISSUES|PERFORMANCE AND STABILITY|PERFORMANCE & STABILITY|GAMEPLAY|GENERAL|VISUALS|AUDIO|INTRO)(?=[A-Z][a-z])/g, '$1\n')
    .replace(/\b([A-Z][A-Z0-9 &/:'’()-]{2,}?)(?=[A-Z][a-z])/g, '$1\n')
    .replace(/([.!?])(?=[A-Z][a-z])/g, '$1\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function uniqueText(items, max = 12) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const clean = stripSteamMarkup(item).replace(/^[-•]\s*/, '').trim();
    const key = clean.toLowerCase();
    if (clean.length < 18 || seen.has(key)) continue;
    seen.add(key);
    out.push(clean.slice(0, 520));
    if (out.length >= max) break;
  }
  return out;
}

function releaseNotesFromPost(post) {
  const raw = String(post?.contents || '');
  const $ = cheerio.load(`<body>${raw}</body>`);
  const listItems = [
    ...[...raw.matchAll(/\[\*\]([\s\S]*?)(?=\[\*\]|\[\/list\])/gi)].map(match => match[1]),
    ...$('li').map((_, element) => $(element).text()).get(),
  ];
  const headings = [
    ...[...raw.matchAll(/\[h[1-6]\]([\s\S]*?)\[\/h[1-6]\]/gi)].map(match => match[1]),
    ...$('h1,h2,h3,h4,h5,h6').map((_, element) => $(element).text()).get(),
  ];
  const plain = stripSteamMarkup(raw);
  const lines = plain.split('\n').map(line => line.replace(/^[-•]\s*/, '').trim());
  // Valve's bounded `maxlength` response sometimes flattens publisher markup
  // into one long string. Sentence extraction preserves a useful, readable
  // breakdown instead of publishing a single 520-character blob.
  const sentences = plain.match(/[^.!?\n]{25,360}[.!?]+/g) || [];
  const changelog = uniqueText([...headings, ...listItems, ...sentences, ...lines], 12);
  return {
    raw,
    plain,
    changelog: changelog.length ? changelog : [plain.slice(0, 520)].filter(Boolean),
    bulletCount: listItems.length,
  };
}

function explicitPackageSizeBytes(text) {
  const raw = String(text || '');
  const patterns = [
    /(?:download|install|patch|update)(?:\s+size)?[^\d]{0,24}(\d+(?:\.\d+)?)\s*(GB|MB)\b/i,
    /(\d+(?:\.\d+)?)\s*(GB|MB)\b[^.\n]{0,32}(?:download|install|patch|update)/i,
  ];
  const match = patterns.map(pattern => raw.match(pattern)).find(Boolean);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * (match[2].toUpperCase() === 'GB' ? 1024 ** 3 : 1024 ** 2));
}

function classifyMaterialUpdate(post) {
  const notes = releaseNotesFromPost(post);
  const title = stripSteamMarkup(post?.title || '');
  const opening = notes.plain.slice(0, 700);
  const identity = `${title} ${opening}`;
  const combined = `${title} ${notes.plain}`;
  const packageSizeBytes = explicitPackageSizeBytes(combined);
  const gameplay = GAMEPLAY_RE.test(combined);
  const requirements = REQUIREMENTS_RE.test(combined);
  const explicitMajor = MAJOR_RELEASE_RE.test(identity);
  const semanticReleaseTitle = /\b\d+\.\d+(?:\.\d+){1,3}[a-z]?\b/i.test(title) && notes.plain.length >= 1200;
  const releaseSignal = TITLE_RELEASE_RE.test(title) || semanticReleaseTitle || BODY_RELEASE_RE.test(opening);
  // Steam publishers mix BBCode, HTML lists, tables, and plain paragraphs.
  // Measure the normalized note breadth as well as literal list markup so a
  // 12,000-character release does not fail merely because Valve flattened it.
  const scopeDepth = notes.plain.length >= 3000;
  const deepNotes = notes.plain.length >= 6000;
  const materialChange = gameplay || requirements;
  const official = post?.feedname === OFFICIAL_FEED;
  const fixOnlyTitle = /\b(?:bug[ -]?fix(?:es)?|update fixes|fixes and improvements|stability fixes?)\b/i.test(title) && !explicitMajor;
  // Reject explicit small-release labels without disqualifying a large update
  // merely because its full notes contain a later hotfix section.
  const small = SMALL_RELEASE_RE.test(title) || SMALL_OPENING_RE.test(opening.trim()) || fixOnlyTitle;
  // "Incoming" in a headline is pre-release marketing, while the same word
  // commonly appears inside live sci-fi patch notes (for example, an incoming
  // transmission). Scope that signal to the title to avoid rejecting releases.
  const prerelease = PRERELEASE_RE.test(identity) || /\bincoming\b/i.test(title) || DATED_ARRIVAL_RE.test(identity);
  const sizeQualifies = packageSizeBytes !== null && packageSizeBytes >= MIN_EXPLICIT_PACKAGE_BYTES;
  const eligible = official
    && !small
    && !prerelease
    && releaseSignal
    && materialChange
    && (explicitMajor || sizeQualifies || scopeDepth || deepNotes);

  const signals = [
    gameplay ? 'gameplay' : null,
    requirements ? 'requirements' : null,
    explicitMajor ? 'major-release' : null,
    sizeQualifies ? 'publisher-size' : null,
    scopeDepth || deepNotes ? 'substantial-notes' : null,
  ].filter(Boolean);
  const impactScore = Math.max(5, Math.min(9.5,
    5
    + (gameplay ? 1.2 : 0)
    + (requirements ? 1.3 : 0)
    + (explicitMajor ? 0.8 : 0)
    + (sizeQualifies ? 0.5 : 0)
    + (notes.plain.length >= 5000 ? 0.5 : 0)
  ));

  return {
    eligible,
    official,
    small,
    prerelease,
    releaseSignal,
    gameplay,
    requirements,
    packageSizeBytes,
    signals,
    impactScore: Math.round(impactScore * 10) / 10,
    scopeScore: signals.length * 10 + Math.min(20, notes.bulletCount) + Math.min(20, Math.floor(notes.plain.length / 500)),
    ...notes,
  };
}

function trustedSteamNewsUrl(post, appId) {
  try {
    const parsed = new URL(post?.url || '');
    const trusted = parsed.protocol === 'https:' && (
      parsed.hostname === 'store.steampowered.com'
      || parsed.hostname.endsWith('.steampowered.com')
      || parsed.hostname.endsWith('.steamcommunity.com')
      || parsed.hostname.endsWith('.akamaihd.net')
    );
    if (trusted) return parsed.toString();
  } catch { /* use canonical official page below */ }
  return `https://store.steampowered.com/news/app/${encodeURIComponent(appId)}`;
}

function postReleasedAt(post) {
  const timestamp = Number(post?.date) * 1000;
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp) : null;
}

function explicitReleaseDateFromTitle(rawTitle) {
  const title = stripSteamMarkup(rawTitle || '');
  const compactDate = title.match(/\b(20\d{2})(\d{2})(\d{2})\b/);
  if (compactDate) {
    const parsed = new Date(`${compactDate[1]}-${compactDate[2]}-${compactDate[3]}T12:00:00.000Z`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const monthDate = title.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s+(20\d{2})\b/i);
  if (!monthDate) return null;
  const parsed = new Date(`${monthDate[1]} ${monthDate[2]}, ${monthDate[3]} 12:00:00 UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function displayVersion(post, releasedAt) {
  const title = stripSteamMarkup(post?.title || '');
  const titledReleaseDate = explicitReleaseDateFromTitle(title);
  if (titledReleaseDate) return titledReleaseDate.toISOString().slice(0, 10).replaceAll('-', '.');

  const seasonBuild = title.match(/\b(Y\d+S\d+(?:\.\d+)*)\b/i)?.[1];
  if (seasonBuild) return seasonBuild.toUpperCase();

  const labeled = title.match(/\b(?:version|ver\.?|build|patch|update)\s*(?:v(?:ersion)?\s*)?(\d+(?:\.\d+){1,3}[a-z]?)\b/i)?.[1];
  if (labeled) return labeled;

  const explicitV = title.match(/\bv(\d+(?:\.\d+){1,3}[a-z]?)\b/i)?.[1];
  if (explicitV) return explicitV;

  const bareSemantic = title.match(/\b(\d+(?:\.\d+){2,3}[a-z]?)\b/i)?.[1];
  return bareSemantic || releasedAt.toISOString().slice(0, 10).replaceAll('-', '.');
}

function knownIssuesFromNotes(changelog) {
  return uniqueText((changelog || []).filter(item => STABILITY_RISK_RE.test(item)), 6);
}

function releaseTitle(gameName, postTitle) {
  const cleanTitle = stripSteamMarkup(postTitle || 'Major update');
  const comparable = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return comparable(cleanTitle).startsWith(comparable(gameName))
    ? cleanTitle
    : `${gameName}: ${cleanTitle}`;
}

function toDatabaseUpdate(game, post, classification) {
  const publishedAt = postReleasedAt(post);
  const releasedAt = explicitReleaseDateFromTitle(post?.title) || publishedAt;
  const gid = String(post.gid || '').replace(/\D/g, '');
  const version = `${game.appId}:${gid}`.slice(0, 64);
  const sourceUrl = trustedSteamNewsUrl(post, game.appId);
  const knownIssues = knownIssuesFromNotes(classification.changelog);
  const statedSize = classification.packageSizeBytes;
  const sizeSentence = statedSize
    ? 'The publisher explicitly states a package/download size in its notes.'
    : 'The publisher does not state a download size; PatchTicker qualified this release by the breadth of documented gameplay or requirement changes.';

  const evidence = [{
    source: `${game.name} official Steam announcement`,
    url: sourceUrl,
    text: `${stripSteamMarkup(post.title || 'Update')}; material signals: ${classification.signals.join(', ')}.`,
    dateBasis: 'published',
    releaseType: 'official-game-update',
    publishedAt: publishedAt.toISOString(),
    steamAppId: game.appId,
    steamNewsGid: gid,
    averagePlayersSnapshot: game.averagePlayers,
    averagePlayersObservedAt: STEAM_GAME_CANDIDATE_SNAPSHOT.observedAt,
    ...(statedSize ? { sizeBytes: statedSize } : {}),
  }];
  const riskFactors = [
    ...(classification.requirements ? [{ level: 'medium', text: 'The release changes or discusses platform, hardware, anti-cheat, or system requirements; confirm compatibility before updating.' }] : []),
    ...knownIssues.slice(0, 2).map(text => ({ level: 'medium', text })),
  ];
  const score = deriveDeterministicScore({
    name: releaseTitle(game.name, post.title),
    version,
    changelog: classification.changelog,
    knownIssues,
    riskFactors,
    evidence,
  });

  return {
    id: `steam-${game.appId}-${gid}`.slice(0, 64),
    platform: 'Steam',
    name: releaseTitle(game.name, post.title).slice(0, 180),
    version,
    displayVersion: displayVersion(post, releasedAt),
    releasedAt: releasedAt.toISOString().slice(0, 10),
    status: statusForScore(score),
    score,
    impactScore: deriveDeterministicImpactScore({ changelog: classification.changelog, riskFactors }),
    affects: `${game.name} on Steam / gameplay / compatibility / installation requirements`,
    verdict: 'This is a material game update, not a routine hotfix. Review the official gameplay and system-requirement changes before installing; a user rating appears only after real votes are recorded.',
    reasoning: `PatchTicker tracks this release because ${game.name} exceeded 15,000 average Steam players in the reviewed 30-day snapshot and its first-party notes document material ${classification.signals.join(', ')} changes. ${sizeSentence}`,
    changelog: classification.changelog,
    knownIssues,
    riskFactors,
    evidence,
    sourceKind: 'steam-game-news',
    sourceRef: `steam-news:${game.appId}:${gid}`,
    productId: String(game.appId),
    releaseSizeBytes: statedSize,
  };
}

function selectBestMaterialPost(posts, now = Date.now(), lookbackDays = DEFAULT_LOOKBACK_DAYS) {
  const cutoff = now - (lookbackDays * 24 * 60 * 60 * 1000);
  const eligible = (posts || [])
    .map(post => ({ post, classification: classifyMaterialUpdate(post), releasedAt: postReleasedAt(post) }))
    .filter(item => item.releasedAt && item.releasedAt.getTime() >= cutoff && item.releasedAt.getTime() <= now + 48 * 60 * 60 * 1000)
    .filter(item => item.classification.eligible)
    .sort((a, b) => b.releasedAt - a.releasedAt);
  if (!eligible.length) return null;

  // Publishers often post a marketing announcement and full notes a few hours
  // apart. Prefer the richer first-party notes within the same release window.
  const latestAt = eligible[0].releasedAt.getTime();
  return eligible
    .filter(item => latestAt - item.releasedAt.getTime() <= 36 * 60 * 60 * 1000)
    .sort((a, b) => b.classification.scopeScore - a.classification.scopeScore || b.releasedAt - a.releasedAt)[0];
}

async function fetchGameNews(game, options = {}) {
  const postCount = boundedInteger(options.postCount || process.env.STEAM_GAME_POST_COUNT, DEFAULT_POST_COUNT, 3, 20);
  const response = await axios.get(STEAM_NEWS_URL, {
    timeout: boundedInteger(process.env.STEAM_GAME_REQUEST_TIMEOUT_MS, 12000, 3000, 30000),
    maxContentLength: 2 * 1024 * 1024,
    // Ask Valve only for the official announcement lane and cap each article.
    // Twelve thousand characters is ample for classification and the curated
    // changelog while bounding Render transfer to roughly 10 MB/scan worst-case
    // for the current 81-game roster instead of accepting unbounded bodies.
    params: {
      appid: game.appId,
      count: postCount,
      maxlength: MAX_POST_CHARACTERS,
      feeds: OFFICIAL_FEED,
      format: 'json',
    },
    headers: { 'User-Agent': 'PatchTicker/1.0 (+https://patchticker.app)', 'Accept': 'application/json' },
  });
  return response.data?.appnews?.newsitems || [];
}

async function upsertMaterialUpdate(update, dryRun = false) {
  if (dryRun) return { inserted: false, dryRun: true };
  let score;
  let impactScore;
  try {
    score = requireValidScore(update.score);
    impactScore = requireValidScore(update.impactScore, 'impact score');
  } catch (error) {
    logger.error('[steam-games] Rejected material update with invalid deterministic rating', {
      updateId: update?.id || null,
      field: error.field || null,
      reason: error.reason || error.message,
    });
    throw error;
  }
  const result = await db.query(
    `INSERT INTO software_updates
       (id, platform, name, version, display_version, released_at, status, score,
        impact_score, bug_count, affects, verdict, reasoning, changelog,
        known_issues, risk_factors, evidence, security_criticality, subreddits,
        ai_generated, source_kind, source_ref, product_id, release_size_bytes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$11,$12,$13,$14,$15,$16,NULL,'[]',FALSE,$17,$18,$19,$20)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       display_version = EXCLUDED.display_version,
       released_at = EXCLUDED.released_at,
       status = EXCLUDED.status,
       score = EXCLUDED.score,
       impact_score = EXCLUDED.impact_score,
       affects = EXCLUDED.affects,
       verdict = EXCLUDED.verdict,
       reasoning = EXCLUDED.reasoning,
       changelog = EXCLUDED.changelog,
       known_issues = EXCLUDED.known_issues,
       risk_factors = EXCLUDED.risk_factors,
       evidence = EXCLUDED.evidence,
       release_size_bytes = EXCLUDED.release_size_bytes,
       updated_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [
      update.id, update.platform, update.name, update.version, update.displayVersion,
      update.releasedAt, statusForScore(score), score, impactScore, update.affects,
      update.verdict, update.reasoning, JSON.stringify(update.changelog),
      JSON.stringify(update.knownIssues), JSON.stringify(update.riskFactors),
      JSON.stringify(update.evidence), update.sourceKind, update.sourceRef,
      update.productId, update.releaseSizeBytes,
    ]
  );
  return { inserted: result.rows[0]?.inserted === true, id: result.rows[0]?.id || update.id };
}

async function run(options = {}) {
  if (process.env.STEAM_GAME_TRACKING_ENABLED === 'false') {
    return { status: 'disabled', candidates: 0, material: 0, inserted: 0, failed: 0, results: [] };
  }
  if (!options.dryRun && !db.isAvailable()) {
    return { status: 'db_unavailable', candidates: 0, material: 0, inserted: 0, failed: 0, results: [] };
  }

  const limit = boundedInteger(options.limit || process.env.STEAM_GAME_CANDIDATE_LIMIT, STEAM_GAME_CANDIDATES.length, 1, STEAM_GAME_CANDIDATES.length);
  const concurrency = boundedInteger(options.concurrency || process.env.STEAM_GAME_CONCURRENCY, DEFAULT_CONCURRENCY, 1, 8);
  const lookbackDays = boundedInteger(options.lookbackDays || process.env.STEAM_GAME_LOOKBACK_DAYS, DEFAULT_LOOKBACK_DAYS, 1, 60);
  const candidates = STEAM_GAME_CANDIDATES.slice(0, limit);
  const results = [];

  for (let index = 0; index < candidates.length; index += concurrency) {
    const batch = candidates.slice(index, index + concurrency);
    const settled = await Promise.all(batch.map(async game => {
      try {
        const posts = await fetchGameNews(game, options);
        const selected = selectBestMaterialPost(posts, options.now || Date.now(), lookbackDays);
        if (!selected) return { appId: game.appId, game: game.name, status: 'no_material_update' };
        const update = toDatabaseUpdate(game, selected.post, selected.classification);
        const saved = await upsertMaterialUpdate(update, options.dryRun === true);
        return {
          appId: game.appId,
          game: game.name,
          status: saved.inserted ? 'inserted' : (options.dryRun ? 'material_dry_run' : 'refreshed'),
          id: update.id,
          title: update.name,
          releasedAt: update.releasedAt,
          signals: selected.classification.signals,
        };
      } catch (error) {
        logger.warn('[steam-games] Candidate scan failed', { appId: game.appId, game: game.name, error: error.message });
        return { appId: game.appId, game: game.name, status: 'failed', error: error.message };
      }
    }));
    results.push(...settled);
    if (index + concurrency < candidates.length) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  const summary = {
    status: 'complete',
    candidates: candidates.length,
    threshold: STEAM_GAME_CANDIDATE_SNAPSHOT.minimumAveragePlayers,
    observedAt: STEAM_GAME_CANDIDATE_SNAPSHOT.observedAt,
    material: results.filter(result => ['inserted', 'refreshed', 'material_dry_run'].includes(result.status)).length,
    inserted: results.filter(result => result.status === 'inserted').length,
    failed: results.filter(result => result.status === 'failed').length,
    results,
  };
  logger.info('[steam-games] Scan complete', {
    candidates: summary.candidates,
    material: summary.material,
    inserted: summary.inserted,
    failed: summary.failed,
  });
  return summary;
}

module.exports = {
  run,
  __test: {
    classifyMaterialUpdate,
    displayVersion,
    explicitReleaseDateFromTitle,
    explicitPackageSizeBytes,
    releaseNotesFromPost,
    selectBestMaterialPost,
    stripSteamMarkup,
    toDatabaseUpdate,
  },
};

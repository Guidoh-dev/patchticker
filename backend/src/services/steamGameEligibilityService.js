'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('../utils/logger');
const {
  STRICT_STEAM_GAME_POLICY,
  VERIFIED_STEAM_GAME_CANDIDATE_SNAPSHOT,
  STRICT_STEAM_GAME_CANDIDATES,
  auditStrictSteamCandidates,
} = require('../data/steamGameCandidates');

const STEAMCHARTS_BASE_URL = 'https://steamcharts.com';
const STEAM_US_CHART_URL = 'https://store.steampowered.com/charts/topselling/US';
const STEAMCHARTS_PAGES = Object.freeze(['top', 'top/p.2', 'top/p.3', 'top/p.4', 'top/p.5', 'top/p.6']);
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12000;
const MINIMUM_SAFE_ROSTER_SIZE = 8;

// These chart entries are utilities, idle counters, compatibility test apps,
// or non-game launch surfaces. High concurrency alone does not make their
// announcements useful PatchTicker game releases.
const EDITORIAL_EXCLUSIONS = new Set([480, 2676230, 3419430, 3678970, 431960]);

let cache = {
  candidates: STRICT_STEAM_GAME_CANDIDATES,
  source: 'reviewed_snapshot',
  refreshedAt: VERIFIED_STEAM_GAME_CANDIDATE_SNAPSHOT.observedAt,
  attemptedAt: null,
  error: null,
};
let refreshPromise = null;

function parseSteamChartsPage(html) {
  const $ = cheerio.load(String(html || ''));
  const rows = [];
  $('table.common-table tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    const href = $(cells[1]).find('a').attr('href') || '';
    const appId = Number((href.match(/^\/app\/(\d+)/) || [])[1]);
    const hoursPlayed = Number($(cells[5]).text().replace(/,/g, '').trim());
    const name = $(cells[1]).text().replace(/\s+/g, ' ').trim();
    if (!Number.isInteger(appId) || !name || !Number.isFinite(hoursPlayed) || hoursPlayed <= 0) return;
    rows.push({
      appId,
      name,
      hoursPlayed,
      averageConcurrentPlayers: Math.round(hoursPlayed / (STRICT_STEAM_GAME_POLICY.windowDays * 24)),
    });
  });
  return rows;
}

function parseSteamUsChart(html) {
  const $ = cheerio.load(String(html || ''));
  const rows = [];
  const seen = new Set();
  $('a[href*="/app/"]').each((_, link) => {
    const href = $(link).attr('href') || '';
    const appId = Number((href.match(/\/app\/(\d+)/) || [])[1]);
    if (!Number.isInteger(appId) || seen.has(appId)) return;
    const name = $(link).text().replace(/\s+/g, ' ').replace(/\(hidden by your preferences\)$/i, '').trim();
    seen.add(appId);
    rows.push({ appId, name, rank: rows.length + 1 });
  });
  return rows.slice(0, STRICT_STEAM_GAME_POLICY.maximumMarketRank);
}

function buildCandidateRoster(steamChartsRows, usChartRows, observedAt = new Date().toISOString()) {
  const usByAppId = new Map((usChartRows || []).map(row => [Number(row.appId), row]));
  const steamByAppId = new Map();
  for (const row of steamChartsRows || []) {
    const appId = Number(row?.appId);
    if (!Number.isInteger(appId)) continue;
    const current = steamByAppId.get(appId);
    if (!current || Number(row.averageConcurrentPlayers) > Number(current.averageConcurrentPlayers)) {
      steamByAppId.set(appId, row);
    }
  }
  const candidates = [...steamByAppId.values()]
    .filter(row => Number(row.averageConcurrentPlayers) > STRICT_STEAM_GAME_POLICY.minimumAverageConcurrentPlayers)
    .filter(row => !EDITORIAL_EXCLUSIONS.has(Number(row.appId)))
    .filter(row => usByAppId.has(Number(row.appId)))
    .map(row => ({
      appId: Number(row.appId),
      name: String(row.name || usByAppId.get(Number(row.appId))?.name || '').trim(),
      averageConcurrentPlayers: Number(row.averageConcurrentPlayers),
      averagePlayers: Number(row.averageConcurrentPlayers),
      region: STRICT_STEAM_GAME_POLICY.region,
      windowDays: STRICT_STEAM_GAME_POLICY.windowDays,
      market: STRICT_STEAM_GAME_POLICY.market,
      usMarketRank: Number(usByAppId.get(Number(row.appId)).rank),
      sourceUrl: `${STEAMCHARTS_BASE_URL}/app/${Number(row.appId)}`,
      marketSourceUrl: STEAM_US_CHART_URL,
      observedAt,
      marketObservedAt: observedAt,
    }))
    .sort((a, b) => b.averageConcurrentPlayers - a.averageConcurrentPlayers);
  return auditStrictSteamCandidates(candidates);
}

async function fetchHtml(url) {
  const response = await axios.get(url, {
    timeout: REQUEST_TIMEOUT_MS,
    maxContentLength: 3 * 1024 * 1024,
    responseType: 'text',
    headers: {
      'User-Agent': 'PatchTicker/1.0 (+https://patchticker.app)',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  return response.data;
}

function currentSteamGameRoster() {
  return Object.freeze({
    candidates: cache.candidates,
    policy: STRICT_STEAM_GAME_POLICY,
    source: cache.source,
    refreshedAt: cache.refreshedAt,
    attemptedAt: cache.attemptedAt,
    stale: Date.now() - Date.parse(cache.refreshedAt || 0) > CACHE_TTL_MS,
    error: cache.error,
  });
}

async function refreshSteamGameRoster(options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const force = options.force === true;
  const cacheAge = now - Date.parse(cache.refreshedAt || 0);
  if (!force && cache.source === 'live_charts' && cacheAge >= 0 && cacheAge < CACHE_TTL_MS) {
    return currentSteamGameRoster();
  }
  if (refreshPromise) return refreshPromise;

  const loader = options.fetchHtml || fetchHtml;
  refreshPromise = (async () => {
    const attemptedAt = new Date(now).toISOString();
    try {
      const [usHtml, ...steamChartsHtml] = await Promise.all([
        loader(STEAM_US_CHART_URL),
        ...STEAMCHARTS_PAGES.map(page => loader(`${STEAMCHARTS_BASE_URL}/${page}`)),
      ]);
      const steamRows = steamChartsHtml.flatMap(parseSteamChartsPage);
      const usRows = parseSteamUsChart(usHtml);
      const audit = buildCandidateRoster(steamRows, usRows, attemptedAt);
      if (usRows.length < 50 || audit.accepted.length < MINIMUM_SAFE_ROSTER_SIZE || audit.rejected.length > 0) {
        throw new Error(`chart validation failed (US rows=${usRows.length}, accepted=${audit.accepted.length}, rejected=${audit.rejected.length})`);
      }
      cache = {
        candidates: audit.accepted,
        source: 'live_charts',
        refreshedAt: attemptedAt,
        attemptedAt,
        error: null,
      };
      logger.info('[steam-games] Eligibility roster refreshed', {
        candidates: audit.accepted.length,
        globalRows: steamRows.length,
        usRows: usRows.length,
        threshold: STRICT_STEAM_GAME_POLICY.minimumAverageConcurrentPlayers,
      });
    } catch (error) {
      cache = {
        ...cache,
        attemptedAt,
        error: error.message,
      };
      logger.warn('[steam-games] Eligibility refresh failed; preserving reviewed roster', {
        candidates: cache.candidates.length,
        source: cache.source,
        error: error.message,
      });
    }
    return currentSteamGameRoster();
  })().finally(() => { refreshPromise = null; });

  return refreshPromise;
}

function resetCacheForTests() {
  cache = {
    candidates: STRICT_STEAM_GAME_CANDIDATES,
    source: 'reviewed_snapshot',
    refreshedAt: VERIFIED_STEAM_GAME_CANDIDATE_SNAPSHOT.observedAt,
    attemptedAt: null,
    error: null,
  };
  refreshPromise = null;
}

module.exports = {
  currentSteamGameRoster,
  refreshSteamGameRoster,
  __test: {
    parseSteamChartsPage,
    parseSteamUsChart,
    buildCandidateRoster,
    resetCacheForTests,
    EDITORIAL_EXCLUSIONS,
    CACHE_TTL_MS,
    STEAMCHARTS_PAGES,
    STEAM_US_CHART_URL,
  },
};

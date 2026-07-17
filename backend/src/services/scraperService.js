// src/services/scraperService.js
// ─────────────────────────────────────────────────────────────────────────────
// LIVE PATCH DETECTION — polls vendor release pages for new versions
//
// Each platform has a dedicated detector that returns:
//   { platform, name, version, releasedAt, changelog, sourceUrl }
//
// Detectors are intentionally simple — we only need the version string and
// release date. The AI analysis service generates everything else.
//
// SOURCES
// ───────
//   Windows   — Microsoft Windows Release Health RSS feed (official)
//   NVIDIA    — NVIDIA driver download page (scrape latest version)
//   AMD       — AMD driver download page JSON API
//   Apple iOS — Apple Security Updates HTML page
//   macOS     — Apple Security Updates HTML page
//   Steam     — Steam news RSS feed
//   Epic      — Epic Games Launcher update subreddit + patch notes page
//   Xbox      — Xbox Wire RSS feed
//   PS5       — PlayStation RSS feed
//   Intel     — Intel download center JSON API
//
// All detectors fail silently — a scrape failure never crashes the cron job.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');
const logger  = require('../utils/logger');

const TIMEOUT = 12000; // 12 seconds per request

const UA = 'Mozilla/5.0 (compatible; PatchTicker/1.0; +https://patchticker.app)';

// ── Shared fetch helpers ──────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await axios.get(url, {
    timeout: TIMEOUT,
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
  });
  return res.data;
}

async function fetchJson(url, headers = {}) {
  const res = await axios.get(url, {
    timeout: TIMEOUT,
    headers: { 'User-Agent': UA, 'Accept': 'application/json', ...headers },
  });
  return res.data;
}

async function fetchXml(url) {
  const res = await axios.get(url, {
    timeout: TIMEOUT,
    headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/xml, text/xml' },
  });
  return res.data;
}

// ── Parse RSS helper ──────────────────────────────────────────────────────────

function parseRssItems(xml, limit = 5) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const items = [];
  $('item').slice(0, limit).each((_, el) => {
    items.push({
      title:       $(el).find('title').text().trim(),
      link:        $(el).find('link').text().trim(),
      description: $(el).find('description').text().replace(/<[^>]+>/g, '').trim().slice(0, 500),
      pubDate:     $(el).find('pubDate').text().trim(),
    });
  });
  return items;
}

// ── Platform detectors ────────────────────────────────────────────────────────

/**
 * Windows — Microsoft Windows Release Health RSS
 * https://learn.microsoft.com/api/search/rss?search=&locale=en-us&facet=product&facet=content_type&$top=5&metaDataScope=Windows%2011
 */
async function detectWindows() {
  try {
    const xml = await fetchXml(
      'https://support.microsoft.com/en-us/feed/rss/6ae59d69-36fc-8e4d-23dd-631d98bf74a9'
    );
    const items = parseRssItems(xml, 3);
    // Look for KB articles (Cumulative Update / Security Update)
    const update = items.find(i =>
      /KB\d{7}|Cumulative Update|Security Update/i.test(i.title)
    );
    if (!update) return null;

    const kbMatch = update.title.match(/KB\d{7}/);
    const version = kbMatch ? kbMatch[0] : update.title.slice(0, 40);

    return {
      platform:   'Windows',
      name:       update.title.slice(0, 120),
      version,
      releasedAt: update.pubDate ? new Date(update.pubDate).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
      changelog:  [update.description].filter(Boolean),
      sourceUrl:  update.link || 'https://learn.microsoft.com/windows/release-health/release-information',
    };
  } catch (err) {
    logger.warn('[scraper] Windows detection failed', { error: err.message });
    return null;
  }
}

/**
 * NVIDIA — scrape the NVIDIA driver download page for the latest Game Ready version
 */
async function detectNvidia() {
  try {
    // NVIDIA has a lookup API used by their download page
    const data = await fetchJson(
      'https://gfwsl.geforce.com/services_toolkit/services/com/nvidia/services/AjaxDriverService.php?' +
      'func=DriverManualLookup&pfid=899&osID=57&languageCode=1033&isWHQL=1&dch=1&sort1=0&numberOfResults=1'
    );
    const driver = data?.IDS?.[0]?.downloadInfo;
    if (!driver) return null;

    return {
      platform:   'NVIDIA',
      name:       `NVIDIA Game Ready Driver ${driver.Version}`,
      version:    driver.Version,
      releasedAt: driver.ReleaseDateTime?.slice(0, 10) || new Date().toISOString().slice(0, 10),
      changelog:  driver.ReleaseNotes ? [driver.ReleaseNotes.slice(0, 400)] : [],
      sourceUrl:  `https://www.nvidia.com/Download/driverResults.aspx/${driver.DownloadURL}`,
    };
  } catch (err) {
    logger.warn('[scraper] NVIDIA detection failed', { error: err.message });
    return null;
  }
}

/**
 * AMD — AMD driver JSON feed
 */
async function detectAmd() {
  try {
    const html = await fetchHtml('https://www.amd.com/en/support/downloads/drivers.html/graphics/radeon-rx/radeon-rx-7000-series/amd-radeon-rx-7900-xtx.html');
    const $ = cheerio.load(html);

    // Look for the version number in the page
    const versionText = $('[data-testid="driver-version"], .driver-version, .download-detail-version').first().text().trim();
    const dateText    = $('[data-testid="release-date"], .driver-release-date').first().text().trim();

    if (!versionText) return null;

    return {
      platform:   'AMD',
      name:       `AMD Adrenalin Edition ${versionText}`,
      version:    versionText,
      releasedAt: dateText ? new Date(dateText).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
      changelog:  [],
      sourceUrl:  'https://www.amd.com/en/support/downloads/drivers.html',
    };
  } catch (err) {
    logger.warn('[scraper] AMD detection failed', { error: err.message });
    return null;
  }
}

/**
 * Apple iOS — Apple Security Updates page
 */
async function detectAppleIos() {
  try {
    const html = await fetchHtml('https://support.apple.com/en-us/111900');
    const $ = cheerio.load(html);

    // Find the first row mentioning iOS in the releases table
    let result = null;
    $('table tr').each((_, row) => {
      if (result) return;
      const cells = $(row).find('td');
      const nameCell = cells.eq(0).text().trim();
      const linkCell = cells.eq(0).find('a').attr('href') || '';
      const dateCell = cells.eq(2).text().trim();

      if (/iOS \d+\.\d+/i.test(nameCell)) {
        const versionMatch = nameCell.match(/iOS (\d+\.\d+[\.\d]*)/i);
        result = {
          platform:   'Apple',
          name:       nameCell.slice(0, 80),
          version:    versionMatch ? versionMatch[1] : nameCell,
          releasedAt: dateCell ? new Date(dateCell).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
          changelog:  [],
          sourceUrl:  linkCell ? `https://support.apple.com${linkCell}` : 'https://support.apple.com/en-us/111900',
        };
      }
    });
    return result;
  } catch (err) {
    logger.warn('[scraper] Apple iOS detection failed', { error: err.message });
    return null;
  }
}

/**
 * macOS — Apple Security Updates page
 */
async function detectMacos() {
  try {
    const html = await fetchHtml('https://support.apple.com/en-us/111900');
    const $ = cheerio.load(html);

    let result = null;
    $('table tr').each((_, row) => {
      if (result) return;
      const cells    = $(row).find('td');
      const nameCell = cells.eq(0).text().trim();
      const linkCell = cells.eq(0).find('a').attr('href') || '';
      const dateCell = cells.eq(2).text().trim();

      if (/macOS\s+\w+\s+\d+\.\d+/i.test(nameCell)) {
        const versionMatch = nameCell.match(/(\d+\.\d+[\.\d]*)/);
        result = {
          platform:   'macOS',
          name:       nameCell.slice(0, 80),
          version:    versionMatch ? versionMatch[1] : nameCell,
          releasedAt: dateCell ? new Date(dateCell).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
          changelog:  [],
          sourceUrl:  linkCell ? `https://support.apple.com${linkCell}` : 'https://support.apple.com/en-us/111900',
        };
      }
    });
    return result;
  } catch (err) {
    logger.warn('[scraper] macOS detection failed', { error: err.message });
    return null;
  }
}

/**
 * Steam — Steam RSS news feed (client updates)
 */
async function detectSteam() {
  try {
    const trackedAppIds = String(process.env.STEAM_TRACKED_APP_IDS || '')
      .split(',')
      .map(id => id.trim())
      .filter(Boolean)
      .slice(0, 25);
    const feeds = await Promise.allSettled([
      fetchXml('https://store.steampowered.com/feeds/news/?appids=0&appids=&type=events'),
      fetchXml('https://store.steampowered.com/feeds/news/app/1675200/?cc=US&l=english'),
      ...trackedAppIds.map(id => fetchXml(`https://store.steampowered.com/feeds/news/app/${encodeURIComponent(id)}/?cc=US&l=english`)),
    ]);
    const items = feeds
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => parseRssItems(r.value, 10))
      .sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
    const update = items.find(i => /Steam Client|Steam Update|Steam Deck|SteamOS/i.test(i.title));
    if (!update) return null;

    return {
      platform:   'Steam',
      name:       update.title.slice(0, 100),
      version:    update.pubDate ? new Date(update.pubDate).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : 'Latest',
      releasedAt: update.pubDate ? new Date(update.pubDate).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
      changelog:  [update.description].filter(Boolean),
      sourceUrl:  update.link || 'https://store.steampowered.com/news/',
    };
  } catch (err) {
    logger.warn('[scraper] Steam detection failed', { error: err.message });
    return null;
  }
}

/**
 * Switch — Nintendo Switch system update history
 */
async function detectSwitch() {
  try {
    const html = await fetchHtml('https://en-americas-support.nintendo.com/app/answers/detail/a_id/22525');
    const $ = cheerio.load(html);
    const text = $('body').text().replace(/\s+/g, ' ');
    const versionMatch = text.match(/Ver\.?\s*(\d+\.\d+\.\d+)/i) || text.match(/version\s+(\d+\.\d+\.\d+)/i);
    if (!versionMatch) return null;

    return {
      platform:   'Switch',
      name:       `Nintendo Switch System Update ${versionMatch[1]}`,
      version:    versionMatch[1],
      releasedAt: new Date().toISOString().slice(0, 10),
      changelog:  ['Nintendo Switch system update detected from official support history'],
      sourceUrl:  'https://en-americas-support.nintendo.com/app/answers/detail/a_id/22525',
    };
  } catch (err) {
    logger.warn('[scraper] Switch detection failed', { error: err.message });
    return null;
  }
}


/**
 * Discord — Discord status history RSS
 */
async function detectDiscord() {
  try {
    const xml = await fetchXml(process.env.DISCORD_STATUS_RSS_URL || 'https://discordstatus.com/history.rss');
    const items = parseRssItems(xml, 10);
    const update = items.find(i => /resolved|monitoring|incident|maintenance|desktop|voice|api|gateway/i.test(`${i.title} ${i.description}`)) || items[0];
    if (!update) return null;
    return {
      platform:   'Discord',
      name:       `Discord Status / Client Signal — ${update.title}`.slice(0, 100),
      version:    update.pubDate ? new Date(update.pubDate).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : 'Latest',
      releasedAt: update.pubDate ? new Date(update.pubDate).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
      changelog:  [update.description].filter(Boolean),
      sourceUrl:  update.link || 'https://discordstatus.com/history',
    };
  } catch (err) {
    logger.warn('[scraper] Discord detection failed', { error: err.message });
    return null;
  }
}

/**
 * Battle.net — Blizzard launcher/support signal fallback
 */
async function detectBattleNet() {
  try {
    const html = await fetchHtml('https://us.battle.net/support/en/');
    const $ = cheerio.load(html);
    const title = $('h1, h2, a').filter((_, el) => /Battle\.net|Blizzard|desktop app|launcher|maintenance/i.test($(el).text())).first().text().trim();
    return {
      platform:   'BattleNet',
      name:       (title || 'Battle.net Desktop App Update Signal').slice(0, 100),
      version:    new Date().toISOString().slice(0, 7),
      releasedAt: new Date().toISOString().slice(0, 10),
      changelog:  ['Battle.net support and launcher status checked for client-impacting changes'],
      sourceUrl:  'https://us.battle.net/support/en/',
    };
  } catch (err) {
    logger.warn('[scraper] Battle.net detection failed', { error: err.message });
    return null;
  }
}

/**
 * GOG Galaxy — GOG news feed / Galaxy signal
 */
async function detectGog() {
  try {
    const html = await fetchHtml('https://www.gog.com/news');
    const $ = cheerio.load(html);
    const card = $('article, a').filter((_, el) => /GOG GALAXY|Galaxy|client|update/i.test($(el).text())).first();
    const title = card.text().replace(/\s+/g, ' ').trim().slice(0, 100);
    return {
      platform:   'GOG',
      name:       title || 'GOG Galaxy Update Signal',
      version:    new Date().toISOString().slice(0, 7),
      releasedAt: new Date().toISOString().slice(0, 10),
      changelog:  ['GOG news monitored for Galaxy client and library-sync updates'],
      sourceUrl:  'https://www.gog.com/news',
    };
  } catch (err) {
    logger.warn('[scraper] GOG detection failed', { error: err.message });
    return null;
  }
}

/**
 * Epic — Epic Games Launcher release notes page
 */
async function detectEpic() {
  try {
    const html = await fetchHtml('https://www.epicgames.com/site/en-US/news?category=release-notes');
    const $ = cheerio.load(html);

    const firstCard = $('article, [data-component="ArticleCard"]').first();
    const title     = firstCard.find('h3, h2, [data-testid="card-title"]').first().text().trim();
    const date      = firstCard.find('time').attr('datetime') || '';

    if (!title) return null;

    const versionMatch = title.match(/(\d+\.\d+[\.\d]*)/);

    return {
      platform:   'Epic',
      name:       title.slice(0, 100),
      version:    versionMatch ? versionMatch[1] : 'Latest',
      releasedAt: date ? new Date(date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
      changelog:  [],
      sourceUrl:  'https://www.epicgames.com/site/en-US/news?category=release-notes',
    };
  } catch (err) {
    logger.warn('[scraper] Epic detection failed', { error: err.message });
    return null;
  }
}

/**
 * Xbox — Xbox Wire RSS
 */
async function detectXbox() {
  try {
    const xml = await fetchXml('https://news.xbox.com/en-us/feed/');
    const items = parseRssItems(xml, 10);
    const update = items.find(i => /system update|dashboard update|firmware/i.test(i.title));
    if (!update) return null;

    const versionMatch = update.title.match(/(\d+\.\d+[\.\d]*)/);

    return {
      platform:   'Xbox',
      name:       update.title.slice(0, 100),
      version:    versionMatch ? versionMatch[1] : 'Latest',
      releasedAt: update.pubDate ? new Date(update.pubDate).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
      changelog:  [update.description].filter(Boolean),
      sourceUrl:  update.link || 'https://news.xbox.com',
    };
  } catch (err) {
    logger.warn('[scraper] Xbox detection failed', { error: err.message });
    return null;
  }
}

/**
 * PS5 — PlayStation Blog RSS
 */
async function detectPs5() {
  try {
    const xml = await fetchXml('https://blog.playstation.com/feed/');
    const items = parseRssItems(xml, 10);
    const update = items.find(i => /system software|firmware update|PS5 update/i.test(i.title));
    if (!update) return null;

    const versionMatch = update.title.match(/(\d+\.\d+[\.\d-]*)/);

    return {
      platform:   'PS5',
      name:       update.title.slice(0, 100),
      version:    versionMatch ? versionMatch[1] : 'Latest',
      releasedAt: update.pubDate ? new Date(update.pubDate).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
      changelog:  [update.description].filter(Boolean),
      sourceUrl:  update.link || 'https://blog.playstation.com',
    };
  } catch (err) {
    logger.warn('[scraper] PS5 detection failed', { error: err.message });
    return null;
  }
}

/**
 * Intel — Intel download center API
 */
async function detectIntel() {
  try {
    const data = await fetchJson(
      'https://www.intel.com/content/www/us/en/download-center/home.html',
    );
    // Fallback: scrape Intel Arc driver page
    const html = await fetchHtml('https://www.intel.com/content/www/us/en/download/785597/intel-arc-iris-xe-graphics-windows.html');
    const $ = cheerio.load(html);

    const versionEl = $('[data-version], .dc-page-available-downloads-version').first().text().trim();
    const dateEl    = $('[data-download-date], .dc-page-available-downloads-date').first().text().trim();

    if (!versionEl) return null;

    return {
      platform:   'Intel',
      name:       `Intel Arc & Iris Xe Graphics Driver ${versionEl}`,
      version:    versionEl,
      releasedAt: dateEl ? new Date(dateEl).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
      changelog:  [],
      sourceUrl:  'https://www.intel.com/content/www/us/en/download/785597/intel-arc-iris-xe-graphics-windows.html',
    };
  } catch (err) {
    logger.warn('[scraper] Intel detection failed', { error: err.message });
    return null;
  }
}

// ── Master detector map ───────────────────────────────────────────────────────

const DETECTORS = {
  Windows: detectWindows,
  NVIDIA:  detectNvidia,
  AMD:     detectAmd,
  Apple:   detectAppleIos,
  macOS:   detectMacos,
  Steam:   detectSteam,
  Epic:    detectEpic,
  Xbox:    detectXbox,
  PS5:     detectPs5,
  Intel:   detectIntel,
  Switch:  detectSwitch,
  Discord: detectDiscord,
  BattleNet: detectBattleNet,
  GOG:      detectGog,
};

/**
 * Run a single platform detector.
 * Returns the detected update object or null on failure.
 */
async function detectPlatform(platform) {
  const fn = DETECTORS[platform];
  if (!fn) {
    logger.warn('[scraper] No detector for platform', { platform });
    return null;
  }
  try {
    return await fn();
  } catch (err) {
    logger.error('[scraper] Detector threw', { platform, error: err.message });
    return null;
  }
}

/**
 * Run all detectors in parallel.
 * Returns array of { platform, result } — result is null on failure.
 */
async function detectAll() {
  const results = await Promise.allSettled(
    Object.keys(DETECTORS).map(async (platform) => ({
      platform,
      result: await detectPlatform(platform),
    }))
  );
  return results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);
}

module.exports = { detectPlatform, detectAll, DETECTORS };

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
const { PLATFORM_KEYS } = require('../config/platformRegistry');

const TIMEOUT = 20000; // 20 seconds per request; AMD/Intel release pages can be slow

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ── Shared fetch helpers ──────────────────────────────────────────────────────

async function fetchHtml(url) {
  try {
    const res = await axios.get(url, {
      timeout: TIMEOUT,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
    });
    return res.data;
  } catch (err) {
    if (err.response?.status !== 403 || typeof fetch !== 'function') throw err;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
      });
      if (!res.ok) throw err;
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }
}

async function fetchJson(url, headers = {}) {
  const res = await axios.get(url, {
    timeout: TIMEOUT,
    headers: { 'User-Agent': UA, 'Accept': 'application/json,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', ...headers },
  });
  return res.data;
}

async function fetchXml(url) {
  const res = await axios.get(url, {
    timeout: TIMEOUT,
    headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/xml, text/xml,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
  });
  return res.data;
}


function toIsoDate(value, fallback = new Date()) {
  if (!value) return fallback.toISOString().slice(0, 10);
  const raw = String(value).trim();
  const candidates = [raw];
  if (/^[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}$/i.test(raw)) {
    candidates.push(`${raw} ${new Date().getFullYear()}`);
  }
  for (const candidate of candidates) {
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  return fallback.toISOString().slice(0, 10);
}

function cleanText(value, max = 500) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function unique(values) {
  return [...new Set(values.map(v => cleanText(v, 280)).filter(Boolean))];
}

function firstVersion(text) {
  return cleanText(text, 2000).match(/\b\d{1,4}(?:\.\d{1,5}){1,5}(?:[-.]\d{1,5})?\b/)?.[0] || null;
}

function collectBullets($, root, max = 5) {
  const bullets = [];
  root.find('li').each((_, el) => {
    const t = cleanText($(el).text(), 240);
    if (t && !/^download|subscribe|share$/i.test(t)) bullets.push(t);
  });
  return unique(bullets).slice(0, max);
}

function sectionBullets($, labels, max = 5) {
  const wanted = labels.map(l => l.toLowerCase());
  const bullets = [];
  $('h2,h3,h4').each((_, heading) => {
    const h = cleanText($(heading).text(), 120).toLowerCase();
    if (!wanted.some(label => h.includes(label))) return;
    let node = $(heading).next();
    let guard = 0;
    while (node.length && guard++ < 8 && !/^h[234]$/i.test(node[0]?.tagName || '')) {
      node.find('li').each((__, li) => bullets.push(cleanText($(li).text(), 240)));
      const p = cleanText(node.text(), 240);
      if (p && bullets.length < 2) bullets.push(p);
      node = node.next();
    }
  });
  return unique(bullets).slice(0, max);
}

function sourceEvidence(source, url, text) {
  return [{ source, url, text: cleanText(text, 260) }];
}

function metaContent($, name) {
  return $(`meta[name="${name}"], meta[property="${name}"]`).attr('content') || '';
}

function amdNestedBullets($, label, max = 5) {
  const bullets = [];
  $('li').each((_, li) => {
    const own = cleanText($(li).clone().children('ul,ol').remove().end().text(), 120);
    if (!new RegExp(label, 'i').test(own)) return;
    $(li).children('ul,ol').first().children('li').each((__, child) => {
      bullets.push(cleanText($(child).text(), 260));
    });
  });
  return unique(bullets).slice(0, max);
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
      releasedAt: toIsoDate(update.pubDate),
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
      releasedAt: toIsoDate(driver.ReleaseDateTime),
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
  const releaseUrls = [
    'https://www.amd.com/en/resources/support-articles/release-notes/RN-RAD-WIN-26-6-4.html',
    'https://www.amd.com/en/resources/support-articles/release-notes/RN-RAD-WIN-26-6-1.html',
    'https://www.amd.com/en/resources/support-articles/release-notes/RN-RAD-WIN-25-3-1.html',
  ];
  try {
    for (const url of releaseUrls) {
      const html = await fetchHtml(url);
      const $ = cheerio.load(html);
      const title = cleanText($('h1').first().text() || $('title').text(), 120);
      const body = cleanText($('body').text(), 5000);
      const version = title.match(/Adrenalin Edition\s+([\d.]+)/i)?.[1] || firstVersion(body);
      if (!version) continue;
      const dateText = cleanText($('p').filter((_, el) => /Last Updated/i.test($(el).text())).first().text(), 120)
        .match(/([A-Z][a-z]+\s+\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i)
        ?.slice(1, 3).join(', ')
        || body.match(/(?:Last Updated|Date|Released)[:\s]+([A-Z][a-z]+\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1]?.replace(/(\d)(st|nd|rd|th)/i, '$1');
      const fixed = amdNestedBullets($, 'Fixed Issues?', 5);
      const known = amdNestedBullets($, 'Known Issues?', 5);
      return {
        platform: 'AMD',
        name: title || `AMD Software: Adrenalin Edition ${version}`,
        version,
        releasedAt: toIsoDate(dateText),
        affects: 'AMD Radeon GPUs / Adrenalin driver / Windows gaming performance / game compatibility',
        changelog: fixed.length ? fixed : [`AMD Software: Adrenalin Edition ${version} release notes detected from AMD.`],
        knownIssues: known,
        riskFactors: known.slice(0, 3).map(text => ({ level: 'medium', text })),
        verdict: 'Check game-specific fixes and known issues before updating, especially if your current Radeon driver is stable.',
        reasoning: 'AMD Adrenalin releases can improve game support and fix crashes, but driver updates may also introduce regressions for specific GPU families or titles. PatchTicker tracks the official AMD release notes and highlights fixed and known issues.',
        evidence: sourceEvidence('AMD Release Notes', url, `${title}. ${fixed[0] || known[0] || 'Official AMD driver release notes.'}`),
        sourceUrl: url,
      };
    }
    return null;
  } catch (err) {
    logger.warn('[scraper] AMD detection failed', { error: err.message });
    return null;
  }
}

/**
 * Apple iOS — Apple Security Updates page
 */
async function parseAppleSecurityRelease(kind) {
  const url = 'https://support.apple.com/en-us/100100';
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const rows = [];
  $('tr').each((_, row) => {
    const cells = $(row).find('td');
    const product = cleanText(cells.eq(0).text(), 160);
    const link = cells.eq(0).find('a').attr('href') || '';
    const date = cleanText(cells.eq(2).text() || cells.eq(1).text(), 80);
    if (product) rows.push({ product, link, date });
  });
  const match = rows.find(r => kind === 'ios'
    ? /iOS|iPadOS/i.test(r.product)
    : /macOS/i.test(r.product));
  if (!match) return null;
  const version = firstVersion(match.product) || match.product;
  const sourceUrl = match.link ? (match.link.startsWith('http') ? match.link : `https://support.apple.com${match.link}`) : url;
  return {
    platform: kind === 'ios' ? 'Apple' : 'macOS',
    name: match.product.slice(0, 100),
    version,
    releasedAt: toIsoDate(match.date),
    affects: kind === 'ios'
      ? 'iPhone / iPad / WebKit / system security / app compatibility'
      : 'Mac / macOS / Safari-WebKit / system security / device stability',
    changelog: [`Apple security release listed for ${match.product}. Review CVEs and device eligibility before installing.`],
    knownIssues: [],
    riskFactors: [{ level: 'low', text: 'Security updates are usually recommended quickly, but older devices and managed fleets should verify app compatibility first.' }],
    verdict: 'Prioritize this update when it includes security fixes, especially for WebKit, kernel, or actively exploited vulnerabilities.',
    reasoning: 'Apple security releases often include CVE fixes that are not fully discussed until patches are available. PatchTicker tracks Apple’s official security release index and links the advisory for review.',
    evidence: sourceEvidence('Apple Security Releases', sourceUrl, `${match.product} listed on Apple security releases page.`),
    sourceUrl,
  };
}

async function detectAppleIos() {
  try { return await parseAppleSecurityRelease('ios'); }
  catch (err) {
    logger.warn('[scraper] Apple iOS detection failed', { error: err.message });
    return null;
  }
}

async function detectMacos() {
  try { return await parseAppleSecurityRelease('macos'); }
  catch (err) {
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
      releasedAt: toIsoDate(update.pubDate),
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
      releasedAt: toIsoDate(),
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
      releasedAt: toIsoDate(update.pubDate),
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
      releasedAt: toIsoDate(),
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
      releasedAt: toIsoDate(),
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
      releasedAt: toIsoDate(date),
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
    const url = 'https://support.xbox.com/en-US/help/hardware-network/settings-updates/whats-new-xbox-one-system-updates';
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    const body = cleanText($('body').text(), 6000);
    const os = body.match(/OS version[:\s]+([A-Z0-9_\\.\-]+)/i)?.[1] || firstVersion(body) || 'Latest';
    const date = body.match(/(?:Released|Available|Mandatory)[:\s]+([A-Z][a-z]+\s+\d{1,2},\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1];
    const bullets = sectionBullets($, ['New Features', 'Fixes', 'Known Issues', 'System Update Details'], 6);
    return {
      platform: 'Xbox',
      name: `Xbox System Update ${os}`.slice(0, 100),
      version: os,
      releasedAt: toIsoDate(date),
      affects: 'Xbox Series X|S / Xbox One / dashboard / network services / controller and game compatibility',
      changelog: bullets.length ? bullets : ['Official Xbox system update notes checked for dashboard, system, and stability changes.'],
      knownIssues: sectionBullets($, ['Known Issues'], 5),
      riskFactors: [{ level: 'low', text: 'Console updates are generally safe, but dashboard or network changes can temporarily affect party chat, store access, or game launch behavior.' }],
      verdict: 'Install for normal console use unless community reports show dashboard, network, or game-launch regressions.',
      reasoning: 'Xbox system updates can change dashboard behavior, networking, controller handling, and game compatibility. PatchTicker tracks the official Xbox Support update notes rather than relying on blog posts.',
      evidence: sourceEvidence('Xbox Support', url, `Xbox update notes detected OS/version ${os}.`),
      sourceUrl: url,
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
    const url = 'https://www.playstation.com/en-us/support/hardware/ps5/system-software/';
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    const body = cleanText($('body').text(), 6000);
    const version = body.match(/Version[:\s]+([\d.\-]+)/i)?.[1]
      || body.match(/system software[^\d]+([\d]{2}\.\d{2}[\d.\-]*)/i)?.[1]
      || firstVersion(body)
      || 'Latest';
    const bullets = collectBullets($, $('body'), 8).filter(b => /update|software|system|feature|stability|security|download/i.test(b)).slice(0, 5);
    return {
      platform: 'PS5',
      name: `PS5 System Software ${version}`,
      version,
      releasedAt: toIsoDate(),
      affects: 'PlayStation 5 / system software / online services / controller and game compatibility',
      changelog: bullets.length ? bullets : ['Official PS5 system software page checked for update/install guidance and release information.'],
      knownIssues: [],
      riskFactors: [{ level: 'low', text: 'System updates are usually required for online features, but phased releases can surface early regressions in rest mode, network, or accessory behavior.' }],
      verdict: 'Install for online play and system security unless early user reports flag a PS5-specific regression.',
      reasoning: 'PS5 system software updates can affect online play, firmware behavior, controller support, and system stability. PatchTicker uses the official PlayStation support page for the current update signal.',
      evidence: sourceEvidence('PlayStation Support', url, `Official PS5 system software page detected version ${version}.`),
      sourceUrl: url,
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
    const url = 'https://www.intel.com/content/www/us/en/download/785597/intel-arc-graphics-windows.html';
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    const title = cleanText($('h1').first().text() || metaContent($, 'title') || 'Intel Arc Graphics - Windows', 100);
    const body = cleanText($('body').text(), 7000);
    const description = metaContent($, 'description') || metaContent($, 'og:description');
    const version = metaContent($, 'DownloadVersion')
      || body.match(/Version\s+([\d.]+)\s*\(Latest\)/i)?.[1]
      || body.match(/Graphics Driver\s+([\d.]+)/i)?.[1]
      || firstVersion(description)
      || firstVersion(body);
    if (!version) return null;
    const date = metaContent($, 'lastModifieddate')
      || body.match(/Date\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1];
    const intro = description || body.match(/Introduction\s+(.{40,420}?)(?:Available Downloads|Detailed Description|$)/i)?.[1];
    return {
      platform: 'Intel',
      name: `${title} ${version}`.slice(0, 120),
      version,
      releasedAt: toIsoDate(date),
      affects: 'Intel Arc GPUs / Core Ultra Arc graphics / Windows graphics driver / game compatibility',
      changelog: [cleanText(intro, 260) || `Intel Graphics Driver ${version} detected for Intel Arc graphics on Windows.`],
      knownIssues: [],
      riskFactors: [{ level: 'medium', text: 'Graphics driver updates can affect game performance, display output, sleep/wake behavior, and compatibility with capture or overlay tools.' }],
      verdict: 'Good candidate for Arc users chasing game fixes or compatibility updates; wait if your current driver is stable and no listed fix applies to your setup.',
      reasoning: 'Intel graphics drivers often bundle game optimizations, device support, and display fixes. PatchTicker tracks Intel’s official Download Center page and extracts the latest version/date directly from that listing.',
      evidence: sourceEvidence('Intel Download Center', url, `${title} version ${version}. ${intro || ''}`),
      sourceUrl: url,
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function validateDetectedUpdate(platform, detected) {
  if (!detected || typeof detected !== 'object') {
    throw new Error('No update object returned');
  }
  if (!detected.name || !detected.version) {
    throw new Error('Detector returned incomplete update data');
  }
  return {
    ...detected,
    platform: detected.platform || platform,
    releasedAt: toIsoDate(detected.releasedAt),
    changelog: Array.isArray(detected.changelog) ? detected.changelog.filter(Boolean).slice(0, 12) : [],
    knownIssues: Array.isArray(detected.knownIssues) ? detected.knownIssues.filter(Boolean).slice(0, 12) : [],
    riskFactors: Array.isArray(detected.riskFactors) ? detected.riskFactors.slice(0, 12) : [],
    evidence: Array.isArray(detected.evidence) ? detected.evidence.slice(0, 8) : [],
  };
}

async function detectPlatformDetailed(platform, opts = {}) {
  const fn = DETECTORS[platform];
  const attempts = Math.max(1, Number(opts.attempts || process.env.SCRAPER_RETRY_ATTEMPTS || 2));
  const backoffMs = Math.max(100, Number(opts.backoffMs || process.env.SCRAPER_RETRY_BACKOFF_MS || 750));

  if (!fn) {
    return { platform, ok: false, result: null, attempts: 0, error: 'No detector registered for platform' };
  }

  let lastError = null;
  const startedAt = Date.now();
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const detected = validateDetectedUpdate(platform, await fn());
      return {
        platform,
        ok: true,
        result: detected,
        attempts: attempt,
        latencyMs: Date.now() - startedAt,
        error: null,
      };
    } catch (err) {
      lastError = err;
      logger.warn('[scraper] Detector attempt failed', { platform, attempt, attempts, error: err.message });
      if (attempt < attempts) await sleep(backoffMs * attempt);
    }
  }

  return {
    platform,
    ok: false,
    result: null,
    attempts,
    latencyMs: Date.now() - startedAt,
    error: lastError?.message || 'Detector failed',
  };
}

/**
 * Run a single platform detector.
 * Returns the detected update object or null on failure.
 */
async function detectPlatform(platform) {
  const detailed = await detectPlatformDetailed(platform);
  if (!detailed.ok) {
    logger.error('[scraper] Detector failed', { platform, attempts: detailed.attempts, error: detailed.error });
    return null;
  }
  return detailed.result;
}

/**
 * Run all detectors with detailed status for operations/admin display.
 */
async function detectAllDetailed(platforms = PLATFORM_KEYS) {
  const results = [];
  for (const platform of platforms) {
    results.push(await detectPlatformDetailed(platform));
  }
  return results;
}

/**
 * Run all detectors.
 * Returns array of { platform, result } — result is null on failure.
 */
async function detectAll() {
  return (await detectAllDetailed()).map(({ platform, result }) => ({ platform, result }));
}

module.exports = { detectPlatform, detectPlatformDetailed, detectAll, detectAllDetailed, DETECTORS };

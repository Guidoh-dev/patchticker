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
//   Xbox      — Xbox Support structured content API
//   PS5       — PlayStation Support system software page
//   Intel     — Intel download center JSON API
//   Discord   — Discord Patch Notes index + article (official)
//   Battle.net— Blizzard regional version manifests + HTTPS CDN build config
//   GOG       — GOG GALAXY installer manifest + artifact timestamp
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
    if (err.response?.status !== 403 || typeof globalThis.fetch !== 'function') throw err;
    const controller = new globalThis.AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      const res = await globalThis.fetch(url, {
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

async function fetchHead(url) {
  const res = await axios.head(url, {
    timeout: TIMEOUT,
    maxRedirects: 5,
    headers: { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9' },
  });
  return res.headers || {};
}

async function fetchTextResponse(url) {
  const res = await axios.get(url, {
    timeout: TIMEOUT,
    responseType: 'text',
    transformResponse: [data => data],
    headers: { 'User-Agent': UA, 'Accept': 'text/plain,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
  });
  return { data: String(res.data || ''), headers: res.headers || {} };
}

async function fetchXml(url) {
  try {
    const res = await axios.get(url, {
      timeout: TIMEOUT,
      headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/xml, text/xml,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
    });
    return res.data;
  } catch (err) {
    if (err.response?.status !== 403 || typeof globalThis.fetch !== 'function') throw err;
    const controller = new globalThis.AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      const res = await globalThis.fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/xml, text/xml,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
      });
      if (!res.ok) throw err;
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }
}


function toIsoDate(value, fallback = null) {
  if (!value) return fallback ? toIsoDate(fallback) : null;
  const raw = String(value).trim();
  const candidates = [raw];
  if (/^[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}$/i.test(raw)) {
    candidates.push(`${raw} ${new Date().getFullYear()}`);
  }
  for (const candidate of candidates) {
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  return fallback ? toIsoDate(fallback) : null;
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

function unique(values, max = 280) {
  return [...new Set(values.map(v => cleanText(v, max)).filter(Boolean))];
}

function firstVersion(text) {
  return cleanText(text, 2000).match(/\b\d{1,4}(?:\.\d{1,5}){1,5}(?:[-.]\d{1,5})?\b/)?.[0] || null;
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

function sourceEvidence(source, url, text, meta = {}) {
  return [{
    source,
    url,
    text: cleanText(text, 260),
    checkedAt: new Date().toISOString(),
    ...meta,
  }];
}

function absoluteUrl(url, base) {
  if (!url) return base;
  try { return new globalThis.URL(url, base).toString(); }
  catch { return base; }
}

function versionFromDate(value, fallback = null) {
  const iso = toIsoDate(value, fallback);
  return iso ? iso.slice(0, 7) : null;
}

function safeDecode(value) {
  try { return decodeURIComponent(String(value || '').replace(/\+/g, ' ')); }
  catch { return String(value || ''); }
}

function metaContent($, name) {
  return $(`meta[name="${name}"], meta[property="${name}"]`).attr('content') || '';
}

function parseGogRemoteConfig(config, installerLastModified) {
  const windows = config?.content?.windows;
  const macos = config?.content?.osx;
  const releasedAt = toIsoDate(installerLastModified);
  if (!windows?.version || !/^https:\/\//i.test(windows.downloadLink || '') || !releasedAt) return null;
  return {
    version: String(windows.version),
    releasedAt,
    windowsDownloadUrl: windows.downloadLink,
    macVersion: macos?.version ? String(macos.version) : null,
  };
}

function parseBattleNetVersionManifest(text, region = 'us') {
  const rows = String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !line.startsWith('Region!'));
  const columns = rows
    .map(line => line.split('|'))
    .find(parts => parts[0]?.toLowerCase() === region.toLowerCase());
  if (!columns || columns.length < 7) return null;

  const [manifestRegion, buildConfig, cdnConfig, , buildId, version, productConfig] = columns;
  if (!/^[a-f0-9]{32}$/i.test(buildConfig || '')) return null;
  if (!/^[a-f0-9]{32}$/i.test(cdnConfig || '')) return null;
  if (!/^\d{1,4}(?:\.\d{1,5}){3}$/.test(version || '')) return null;
  if (!/^\d+$/.test(buildId || '') || !version.endsWith(`.${buildId}`)) return null;

  return { region: manifestRegion, buildConfig, cdnConfig, buildId, version, productConfig };
}

function parseBattleNetBuildConfig(text) {
  const value = key => String(text || '').match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'mi'))?.[1]?.trim() || null;
  const buildId = value('build-num');
  const buildName = value('build-name');
  const branch = value('build-branch');
  const releaseVersion = (branch || buildName || '').match(/release_(\d+(?:\.\d+){2})/i)?.[1] || null;
  if (!/^\d+$/.test(buildId || '') || !releaseVersion) return null;
  return { buildId, buildName, branch, version: `${releaseVersion}.${buildId}` };
}

function parseDiscordPatchIndex(html, baseUrl = 'https://discord.com/tags/patch-notes') {
  const $ = cheerio.load(String(html || ''));
  const releases = [];

  $('a[href*="/blog/discord-patch-notes-"]').each((_, link) => {
    const title = cleanText($(link).attr('aria-label') || $(link).text(), 120);
    const dateText = title.match(/^Discord Patch Notes:\s*(.+)$/i)?.[1] || null;
    const releasedAt = toIsoDate(dateText);
    if (!releasedAt) return;
    releases.push({
      title,
      releasedAt,
      url: absoluteUrl($(link).attr('href'), baseUrl),
    });
  });

  return releases
    .filter((release, index, rows) => rows.findIndex(row => row.url === release.url) === index)
    .sort((a, b) => Date.parse(b.releasedAt) - Date.parse(a.releasedAt))[0] || null;
}

function parseDiscordPatchPage(html) {
  const $ = cheerio.load(String(html || ''));
  const title = cleanText($('h1').first().text() || metaContent($, 'og:title'), 120);
  const dateText = title.match(/^Discord Patch Notes:\s*(.+)$/i)?.[1] || null;
  const releasedAt = toIsoDate(dateText);
  if (!releasedAt) return null;

  const candidates = [];
  $('section.article_content.new article.article_rich-text-2').each((articleIndex, article) => {
    const section = cleanText($(article).find('h2').first().text(), 70) || 'Changes';
    $(article).find('li').each((itemIndex, item) => {
      if ($(item).children('ul,ol').length) return;
      const text = cleanText($(item).text(), 360);
      if (text.length < 24) return;
      const signalText = `${section} ${text}`.toLowerCase();
      let score = section.toLowerCase() === 'highlights' ? 20 : 0;
      if (/desktop/.test(signalText)) score += 8;
      if (/crash|freeze|overlay|voice|stream|update|electron|performance|cpu|memory|security/.test(signalText)) score += 7;
      if (/fixed|resolved|improved|upgraded|shipped/.test(signalText)) score += 3;
      candidates.push({
        text: section === 'Highlights' ? text : `${section}: ${text}`,
        score,
        order: (articleIndex * 1000) + itemIndex,
      });
    });
  });

  const changelog = unique(
    candidates
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .map(candidate => candidate.text),
    360
  ).slice(0, 12);
  if (!changelog.length) return null;

  return {
    title,
    releasedAt,
    version: releasedAt.replace(/-/g, '.'),
    changelog,
  };
}

function parseSteamReleaseNotes(html) {
  const $ = cheerio.load(String(html || ''));
  const summary = [];
  const sections = new Map();
  let currentSection = 'Changes';

  $('body').children().each((_, node) => {
    const tag = String(node.tagName || '').toLowerCase();
    const element = $(node);
    if (tag === 'p') {
      const heading = cleanText(element.children('b,strong').first().text(), 100);
      const fullText = cleanText(element.text(), 300);
      if (heading && heading === fullText) {
        currentSection = heading;
        if (!sections.has(currentSection)) sections.set(currentSection, []);
      } else if (fullText && currentSection === 'Changes') {
        summary.push(fullText);
      }
      return;
    }
    if (!['ul', 'ol'].includes(tag)) return;
    const items = [];
    element.children('li').each((__, li) => {
      const paragraphs = $(li).find('p').map((___, p) => cleanText($(p).text(), 260)).get().filter(Boolean);
      items.push(cleanText(paragraphs.length ? paragraphs.join(' ') : $(li).text(), 650));
    });
    if (items.length) sections.set(currentSection, [...(sections.get(currentSection) || []), ...items]);
  });

  const knownIssues = [];
  const changelog = [...summary.slice(0, 2)];
  const changeSections = [];
  for (const [heading, items] of sections.entries()) {
    if (/known issues?/i.test(heading)) {
      knownIssues.push(...items);
      continue;
    }
    changeSections.push({ heading, items });
  }
  for (let itemIndex = 0; changelog.length < 12; itemIndex++) {
    let added = false;
    for (const { heading, items } of changeSections) {
      if (!items[itemIndex] || changelog.length >= 12) continue;
      changelog.push(`${heading}: ${items[itemIndex]}`);
      added = true;
    }
    if (!added) break;
  }
  return {
    changelog: unique(changelog, 520).slice(0, 12),
    knownIssues: unique(knownIssues, 650).slice(0, 8),
  };
}

function parseXboxContentApi(payload) {
  const releases = [];
  for (const entry of payload?.ContentList || []) {
    for (const section of entry?.ContentItem?.SectionList || []) {
      const releasedAt = toIsoDate(String(section?.Heading || '').replace(/^Release date:\s*/i, ''));
      const osSection = (section?.SectionItems || []).find(item => /OS version:/i.test(item?.Heading || item?.['#Name'] || ''));
      const version = String(osSection?.Heading || osSection?.['#Name'] || '').match(/OS version:\s*([\d.]+)/i)?.[1];
      if (!releasedAt || !version) continue;

      const changelog = [];
      const knownIssues = [];
      for (const item of osSection?.SectionItems || []) {
        const heading = cleanText(item?.Heading || item?.['#Name'], 120);
        const detail = (item?.SectionItems || [])
          .map(child => cleanText(child?.HtmlContent || child?.Heading || child?.['#Name'], 360))
          .filter(Boolean)
          .join(' ');
        const summary = cleanText(detail || heading, 520);
        if (!summary) continue;
        const line = heading && summary !== heading ? `${heading}: ${summary}` : summary;
        if (/known issues?/i.test(heading)) knownIssues.push(line);
        else changelog.push(line);
      }
      const orderedChangelog = unique(changelog, 520).sort((a, b) =>
        Number(/bug fixes?|security|stability/i.test(b)) - Number(/bug fixes?|security|stability/i.test(a))
      );
      releases.push({ version, releasedAt, changelog: orderedChangelog.slice(0, 12), knownIssues: unique(knownIssues, 650).slice(0, 8) });
    }
  }
  return releases.sort((a, b) => Date.parse(b.releasedAt) - Date.parse(a.releasedAt))[0] || null;
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

function parseSwitchReleasePage(html) {
  const $ = cheerio.load(html);
  const releaseNodes = $('h1,h2,h3,h4,h5,p,strong,b').toArray();
  let release = null;

  for (const el of releaseNodes) {
    const text = cleanText($(el).text(), 220);
    const match = text.match(/(?:Ver\.?|Version)\s*(\d+(?:\.\d+){2})\s*\(Released\s+([^)]+)\)/i);
    if (!match) continue;
    release = { el, version: match[1], releasedAt: toIsoDate(match[2]), heading: match[0] };
    break;
  }

  if (!release?.releasedAt) return null;

  const bullets = [];
  const releaseEl = $(release.el);
  const anchor = releaseEl.is('strong,b') ? releaseEl.closest('p,h1,h2,h3,h4,h5') : releaseEl;
  let node = anchor.next();
  let guard = 0;
  while (node.length && guard++ < 12) {
    const nodeText = cleanText(node.text(), 1000);
    if (/(?:Ver\.?|Version)\s*\d+(?:\.\d+){2}\s*\(Released/i.test(nodeText)) break;
    node.find('li').each((_, li) => {
      const ownText = cleanText($(li).clone().children('ul,ol').remove().end().text(), 280);
      if (ownText) bullets.push(ownText);
    });
    if (!node.find('li').length && /improvement|change|feature|stability|issue|shop|video|pin/i.test(nodeText)) {
      bullets.push(nodeText);
    }
    node = node.next();
  }

  return {
    version: release.version,
    releasedAt: release.releasedAt,
    changelog: unique(bullets).slice(0, 8),
    heading: release.heading,
  };
}

function parsePs5SupportPage(html) {
  const $ = cheerio.load(html);
  const artifactUrl = $('a[href*="pc.ps5.update.playstation.net"][href$="PS5UPDATE.PUP"]')
    .map((_, link) => $(link).attr('href'))
    .get()
    .find(url => /\/sys_[a-f0-9]{64}\/PS5UPDATE\.PUP$/i.test(url || ''))
    || String(html || '').match(/https:\/\/pc\.ps5\.update\.playstation\.net\/[^"'<>\s]+\/sys_[a-f0-9]{64}\/PS5UPDATE\.PUP/i)?.[0]
    || null;
  const artifactHash = artifactUrl?.match(/\/sys_([a-f0-9]{64})\/PS5UPDATE\.PUP$/i)?.[1] || null;
  const artifactBuildDate = artifactUrl?.match(/\/image\/(\d{4})_(\d{4})\//i);
  if (!artifactUrl || !artifactHash || !artifactBuildDate) return null;
  return {
    artifactUrl,
    artifactHash,
    artifactBuildDate: `${artifactBuildDate[1]}-${artifactBuildDate[2].slice(0, 2)}-${artifactBuildDate[2].slice(2)}`,
  };
}

// ── Parse RSS helper ──────────────────────────────────────────────────────────

function parseRssItems(xml, limit = 5) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const items = [];
  $('item').slice(0, limit).each((_, el) => {
    const descriptionHtml = $(el).find('description').text().trim();
    items.push({
      title:       $(el).find('title').text().trim(),
      link:        $(el).find('link').text().trim(),
      description: cleanText(descriptionHtml, 1000),
      descriptionHtml: descriptionHtml.slice(0, 20000),
      pubDate:     $(el).find('pubDate').text().trim(),
    });
  });
  return items;
}

// ── Platform detectors ────────────────────────────────────────────────────────

/**
 * Windows — Microsoft Support Windows 11 update history pages.
 * The old Microsoft Support RSS endpoint now returns HTTP 410, so this parser
 * reads the official update-history index and then opens the newest KB detail
 * page for release notes / known issues context.
 */
async function detectWindows() {
  const historyUrls = [
    'https://support.microsoft.com/en-us/servicing/os/windows-11/2025/07/windows-11-version-25h2-update-history',
    'https://support.microsoft.com/en-us/servicing/os/windows-11/2024/09/windows-11-version-24h2-update-history',
  ];

  try {
    const candidates = [];

    for (const historyUrl of historyUrls) {
      const html = await fetchHtml(historyUrl);
      const $ = cheerio.load(html);

      $('a[href*="/kb"], a[href*="KB"], a[href*="-kb"]').each((_, a) => {
        const title = cleanText($(a).text(), 180);
        if (!/KB\d{7}/i.test(title)) return;
        if (/\.NET Framework|Dynamic Update|Safe OS|Setup Dynamic/i.test(title)) return;

        const kb = title.match(/KB\d{7}/i)?.[0]?.toUpperCase();
        const dateText = title.match(/[A-Z][a-z]+\s+\d{1,2},\s+20\d{2}/)?.[0];
        candidates.push({
          title,
          kb,
          releasedAt: toIsoDate(dateText),
          sourceUrl: absoluteUrl($(a).attr('href'), historyUrl),
          isPreview: /preview/i.test(title),
        });
      });
    }

    const uniqueByKb = new Map();
    for (const c of candidates) {
      if (!uniqueByKb.has(c.kb)) uniqueByKb.set(c.kb, c);
    }

    const sorted = [...uniqueByKb.values()].sort((a, b) => {
      const dateDelta = new Date(b.releasedAt) - new Date(a.releasedAt);
      if (dateDelta !== 0) return dateDelta;
      return Number(a.isPreview) - Number(b.isPreview);
    });

    const update = sorted[0];
    if (!update) return null;

    let changelog = [];
    let knownIssues = [];
    try {
      const detailHtml = await fetchHtml(update.sourceUrl);
      const detail = cheerio.load(detailHtml);
      changelog = sectionBullets(detail, ['Highlights', 'Improvements', 'This update'], 5);
      knownIssues = sectionBullets(detail, ['Known issues'], 4);
      if (!changelog.length) {
        const firstBody = cleanText(detail('main p, article p').first().text(), 260);
        if (firstBody) changelog = [firstBody];
      }
    } catch (detailErr) {
      logger.warn('[scraper] Windows detail page parse failed', { error: detailErr.message, url: update.sourceUrl });
    }

    const previewNote = update.isPreview
      ? 'This is a Microsoft preview update; preview releases are generally optional and should be reviewed before broad installation.'
      : 'This is an official Microsoft cumulative update; review the KB page for deployment notes and known issues.';

    return {
      platform:   'Windows',
      name:       `Windows 11 ${update.title}`.slice(0, 140),
      version:    update.kb,
      releasedAt: update.releasedAt,
      affects:    'Windows 11 supported releases / cumulative OS servicing / security and quality updates',
      changelog:  unique([previewNote, ...changelog]).slice(0, 6),
      knownIssues,
      evidence:   sourceEvidence('Microsoft Support', update.sourceUrl, update.title, { dateBasis: 'released', releaseType: 'official-release' }),
      sourceUrl:  update.sourceUrl,
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
    const sourceUrl = driver.DetailsURL || absoluteUrl(driver.DownloadURL || '', 'https://www.nvidia.com/en-us/geforce/drivers/');
    const decodedNotes = cleanText(safeDecode(driver.ReleaseNotes), 1200);
    const usefulStart = decodedNotes.search(/Game Ready for|Fixed Gaming Bugs|Release Highlights/i);
    const releaseNotes = cleanText(usefulStart >= 0 ? decodedNotes.slice(usefulStart) : decodedNotes, 520);

    return {
      platform:   'NVIDIA',
      name:       `NVIDIA Game Ready Driver ${driver.Version}`,
      version:    driver.Version,
      releasedAt: toIsoDate(driver.ReleaseDateTime),
      changelog:  releaseNotes ? [releaseNotes] : [],
      evidence:   sourceEvidence('NVIDIA Driver Downloads', sourceUrl, `Game Ready Driver ${driver.Version}`, { dateBasis: 'released', releaseType: 'official-release' }),
      sourceUrl,
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
        evidence: sourceEvidence('AMD Release Notes', url, `${title}. ${fixed[0] || known[0] || 'Official AMD driver release notes.'}`, { dateBasis: 'released', releaseType: 'official-release' }),
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
    evidence: sourceEvidence('Apple Security Releases', sourceUrl, `${match.product} listed on Apple security releases page.`, { dateBasis: 'released', releaseType: 'official-release' }),
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
    const sourceUrl = update.link || 'https://store.steampowered.com/news/';
    const version = firstVersion(`${update.title} ${update.description}`) || versionFromDate(update.pubDate);
    const description = cleanText(update.description, 900);
    const notes = parseSteamReleaseNotes(update.descriptionHtml || update.description);
    const isPreview = /\b(?:beta|preview)\b/i.test(`${update.title} ${description}`);
    const riskFactors = [];
    if (isPreview) riskFactors.push({ level: 'medium', text: 'This release is on a Beta or Preview channel and is intended for users testing changes before stable rollout.' });
    if (notes.knownIssues.length) riskFactors.push({ level: 'medium', text: notes.knownIssues[0] });

    return {
      platform:   'Steam',
      name:       update.title.slice(0, 100),
      version,
      releasedAt: toIsoDate(update.pubDate),
      changelog:  notes.changelog.length ? notes.changelog : [description].filter(Boolean),
      knownIssues: notes.knownIssues,
      riskFactors,
      verdict: isPreview
        ? 'Use the stable channel unless you need these fixes for testing; this build has an acknowledged performance regression.'
        : 'Install if the listed SteamOS or Steam Deck fixes apply to your setup; otherwise wait for normal rollout confidence.',
      reasoning: isPreview
        ? 'This SteamOS build is explicitly marked Beta/Preview by Valve. PatchTicker separates its acknowledged issues from the full change list so stable-channel users can avoid treating a test build as a routine update.'
        : 'PatchTicker reads Valve’s official Steam news feed and separates release changes from known issues before scoring the update.',
      evidence: sourceEvidence('Steam News', sourceUrl, `${update.title}. ${description}`, { dateBasis: 'published', releaseType: 'official-release' }),
      sourceUrl,
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
  const sourceUrl = 'https://en-americas-support.nintendo.com/app/answers/detail/a_id/22525';
  try {
    const parsed = parseSwitchReleasePage(await fetchHtml(sourceUrl));
    if (!parsed) return null;
    const changelog = parsed.changelog.length
      ? parsed.changelog
      : ['Nintendo published a system stability and feature update for supported Switch consoles.'];

    return {
      platform:   'Switch',
      name:       `Nintendo Switch System Update ${parsed.version}`,
      version:    parsed.version,
      releasedAt: parsed.releasedAt,
      affects:    'Nintendo Switch / Switch OLED / Switch Lite / system firmware / eShop / online services',
      changelog,
      evidence:   sourceEvidence('Nintendo Support', sourceUrl, `${parsed.heading}. ${changelog[0]}`, { dateBasis: 'released', releaseType: 'official-release' }),
      sourceUrl,
    };
  } catch (err) {
    logger.warn('[scraper] Switch detection failed', { error: err.message });
    return null;
  }
}


/**
 * Discord — official Patch Notes index and article.
 *
 * Discord Status incidents describe service availability, not installable
 * client releases. They must never be promoted into the patch feed.
 */
async function detectDiscord() {
  const indexUrl = process.env.DISCORD_PATCH_NOTES_URL || 'https://discord.com/tags/patch-notes';
  try {
    const release = parseDiscordPatchIndex(await fetchHtml(indexUrl), indexUrl);
    if (!release?.url) return null;
    const parsed = parseDiscordPatchPage(await fetchHtml(release.url));
    if (!parsed || parsed.releasedAt !== release.releasedAt) return null;
    return {
      platform:   'Discord',
      name:       parsed.title,
      version:    parsed.version,
      releasedAt: parsed.releasedAt,
      affects:    'Discord desktop / Windows / macOS / Linux / overlay / voice / streaming / client reliability',
      changelog:  parsed.changelog,
      knownIssues: [],
      riskFactors: [{ level: 'low', text: 'Discord notes that fixes may roll out gradually by client platform, so availability can differ by device.' }],
      verdict:    'Review the Desktop sections for overlay, voice, streaming, and crash fixes that apply to your setup; rollout timing may vary by platform.',
      reasoning:  'PatchTicker tracks Discord’s official technical Patch Notes rather than service-status incidents. The notes combine shipped reliability, performance, accessibility, and client fixes across Desktop and mobile.',
      evidence:   sourceEvidence('Discord Patch Notes', release.url, `${parsed.title}. ${parsed.changelog.slice(0, 2).join(' ')}`, { dateBasis: 'published', releaseType: 'official-release', publishedAt: parsed.releasedAt }),
      sourceUrl:  release.url,
    };
  } catch (err) {
    logger.warn('[scraper] Discord detection failed', { error: err.message });
    return null;
  }
}

/**
 * Battle.net — Blizzard patch-service manifests, cross-validated against the
 * content-addressed HTTPS CDN build configuration. Blizzard's version service
 * is served on its legacy patch port; the public build is accepted only when
 * at least two independent regions agree and the referenced HTTPS config
 * matches exactly.
 */
async function detectBattleNet() {
  const manifestUrls = [
    process.env.BATTLENET_VERSION_URL || 'http://us.patch.battle.net:1119/bna/versions',
    process.env.BATTLENET_VERSION_URL_SECONDARY || 'http://eu.patch.battle.net:1119/bna/versions',
    process.env.BATTLENET_VERSION_URL_TERTIARY || 'http://kr.patch.battle.net:1119/bna/versions',
  ];
  try {
    const regionalResponses = await Promise.allSettled(manifestUrls.map(url => fetchTextResponse(url)));
    const manifests = regionalResponses
      .filter(response => response.status === 'fulfilled')
      .map(response => parseBattleNetVersionManifest(response.value.data, 'us'))
      .filter(Boolean);
    if (manifests.length < 2) throw new Error('Fewer than two official Battle.net regional manifests were available');

    const manifest = manifests[0];
    if (manifests.some(candidate =>
      candidate.version !== manifest.version || candidate.buildConfig !== manifest.buildConfig
    )) {
      throw new Error('Official Battle.net regional manifests disagree');
    }

    const hash = manifest.buildConfig;
    const configUrl = `https://level3.ssl.blizzard.com/tpr/bnt002/config/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
    const configResponse = await fetchTextResponse(configUrl);
    const buildConfig = parseBattleNetBuildConfig(configResponse.data);
    const releasedAt = toIsoDate(configResponse.headers['last-modified']);
    if (!buildConfig || buildConfig.version !== manifest.version || buildConfig.buildId !== manifest.buildId || !releasedAt) {
      throw new Error('Battle.net HTTPS build config did not validate the manifest');
    }

    const regionsVerified = manifests.length;
    return {
      platform:   'BattleNet',
      name:       `Battle.net Desktop App ${manifest.version}`,
      version:    manifest.version,
      releasedAt,
      affects:    'Battle.net launcher / Blizzard game updates / login, repair, download, and patch installation flow',
      changelog:  [
        `Blizzard's official patch service currently publishes Battle.net Desktop App build ${manifest.version}.`,
        `${regionsVerified} official regional manifest${regionsVerified === 1 ? '' : 's'} validated the same public build and content-addressed build configuration.`,
        `The HTTPS build configuration identifies ${buildConfig.buildName || buildConfig.branch || `build ${manifest.buildId}`}.`,
      ],
      knownIssues: [],
      riskFactors: [
        { level: 'medium', text: 'Launcher or service issues can block game patching, downloads, login, or repair loops even when the game update itself is healthy.' },
        { level: 'low', text: 'Blizzard does not publish a complete public changelog for every desktop-app build; version and source date are verified, but feature-level changes may be unavailable.' },
      ],
      verdict: 'This is the current public launcher build confirmed by Blizzard’s official regional manifests and HTTPS build config. Let the built-in updater install it normally; avoid forced reinstalls unless the launcher is failing.',
      reasoning: 'PatchTicker cross-checks Blizzard’s official regional version manifests against the referenced HTTPS, content-addressed build configuration and uses that artifact’s update timestamp as the source date.',
      evidence: [
        ...sourceEvidence('Battle.net CDN Build Manifest', configUrl, `Official HTTPS build config validates Battle.net ${manifest.version}; last modified ${releasedAt}.`, { dateBasis: 'source-updated', releaseType: 'official-version', publishedAt: releasedAt }),
        ...sourceEvidence('Battle.net Download', 'https://download.battle.net/en-us/desktop', 'Official Battle.net desktop app distribution page for Windows and macOS.', { dateBasis: 'checked', releaseType: 'official-download' }),
      ],
      sourceUrl:  configUrl,
    };
  } catch (err) {
    logger.warn('[scraper] Battle.net detection failed', { error: err.message });
    return null;
  }
}

/**
 * GOG Galaxy — official remote installer manifest plus artifact timestamp.
 * GOG's public news surface does not consistently publish client versions;
 * the signed installer manifest is the authoritative current-version signal.
 */
async function detectGog() {
  const configUrl = 'https://remote-config.gog.com/components/webinstaller?component_version=2.0.0';
  try {
    const config = await fetchJson(configUrl);
    const windows = config?.content?.windows;
    if (!windows?.downloadLink) return null;
    const headers = await fetchHead(windows.downloadLink);
    const parsed = parseGogRemoteConfig(config, headers['last-modified']);
    if (!parsed) return null;
    const platformSummary = parsed.macVersion
      ? `Windows ${parsed.version}; macOS ${parsed.macVersion}`
      : `Windows ${parsed.version}`;
    return {
      platform:   'GOG',
      name:       `GOG GALAXY ${parsed.version}`,
      version:    parsed.version,
      releasedAt: parsed.releasedAt,
      affects:    'GOG GALAXY desktop client / Windows and macOS / library sync / cloud saves / game installation',
      changelog:  [
        `GOG's official installer manifest currently serves ${platformSummary}.`,
        'The installer artifact timestamp changed with this release; GOG does not expose a complete public per-build changelog on this endpoint.',
      ],
      knownIssues: [],
      riskFactors: [{ level: 'low', text: 'Launcher updates can affect library sync, cloud saves, downloads, and cross-store integrations.' }],
      verdict: 'Install normally, but confirm cloud-save and library synchronization if GOG GALAXY is your primary launcher hub.',
      reasoning: 'PatchTicker verifies the current GOG GALAXY build from GOG’s official remote installer manifest and dates it from the published installer artifact, avoiding stale news cards and guessed monthly versions.',
      evidence: sourceEvidence('GOG GALAXY Installer Manifest', configUrl, `Official installer manifest serves ${platformSummary}; Windows artifact last modified ${parsed.releasedAt}.`, { dateBasis: 'source-updated', releaseType: 'official-version', publishedAt: parsed.releasedAt }),
      sourceUrl: configUrl,
    };
  } catch (err) {
    logger.warn('[scraper] GOG detection failed', { error: err.message });
    return null;
  }
}


/**
 * Xbox — official Xbox Support structured content endpoint.
 * The public page is a JavaScript shell; its public content API contains the
 * worldwide OS version, release date, feature notes, and bug fixes.
 */
async function detectXbox() {
  try {
    const sourceUrl = 'https://support.xbox.com/en-US/help/hardware-network/settings-updates/whats-new-xbox-one-system-updates';
    const apiUrl = 'https://content.support.xboxlive.com/content?path=%2FSXC%2Fhardware-network%2Fsettings-updates%2Fwhats-new-xbox-one-system-updates&market=US&language=en-US';
    const payload = await fetchJson(apiUrl, {
      'xa-Origin': 'support.xbox.com',
      'xa-Origin-Version': '1',
      'xa-Client-UIVersion': '1',
    });
    const parsed = parseXboxContentApi(payload);
    if (!parsed) return null;
    return {
      platform: 'Xbox',
      name: `Xbox System Update ${parsed.version}`.slice(0, 100),
      version: parsed.version,
      releasedAt: parsed.releasedAt,
      affects: 'Xbox Series X|S / Xbox One / dashboard / network services / controller and game compatibility',
      changelog: parsed.changelog.length ? parsed.changelog : ['Official Xbox system update notes checked for dashboard, system, and stability changes.'],
      knownIssues: parsed.knownIssues,
      riskFactors: [{ level: 'low', text: 'Console updates are generally safe, but dashboard or network changes can temporarily affect party chat, store access, or game launch behavior.' }],
      verdict: 'Install for normal console use unless community reports show dashboard, network, or game-launch regressions.',
      reasoning: 'Xbox system updates can change dashboard behavior, networking, controller handling, and game compatibility. PatchTicker tracks the official Xbox Support update notes rather than relying on blog posts.',
      evidence: sourceEvidence('Xbox Support', sourceUrl, `Official Xbox update notes list OS version ${parsed.version}, released ${parsed.releasedAt}.`, { dateBasis: 'released', releaseType: 'official-release', publishedAt: parsed.releasedAt }),
      sourceUrl,
    };
  } catch (err) {
    logger.warn('[scraper] Xbox detection failed', { error: err.message });
    return null;
  }
}

/**
 * PS5 — official PlayStation Support release version.
 */
async function detectPs5() {
  try {
    const url = 'https://www.playstation.com/en-us/support/hardware/ps5/system-software/';
    const html = await fetchHtml(url);
    const parsed = parsePs5SupportPage(html);
    if (!parsed) return null;
    const artifactHeaders = await fetchHead(parsed.artifactUrl);
    const releasedAt = toIsoDate(artifactHeaders['last-modified']);
    if (!releasedAt) return null;
    const artifactId = parsed.artifactHash.slice(0, 8);
    const version = `PUP-${releasedAt.replace(/-/g, '.')}-${artifactId}`;
    return {
      platform: 'PS5',
      name: `PS5 System Software — ${releasedAt}`,
      version,
      releasedAt,
      affects: 'PlayStation 5 / system software / online services / controller and game compatibility',
      changelog: [
        `Sony’s current official PS5 system software artifact was published ${releasedAt}.`,
        `Artifact fingerprint ${artifactId}; package build path ${parsed.artifactBuildDate}.`,
        'Sony does not expose a public console build number or per-build changelog on this support page, so PatchTicker identifies the release by the official package fingerprint instead of the page’s unrelated CMS revision.',
      ],
      knownIssues: [],
      riskFactors: [{ level: 'low', text: 'System updates are usually required for online features, but phased releases can surface early regressions in rest mode, network, or accessory behavior.' }],
      verdict: 'Install for online play and system security unless early user reports flag a PS5-specific regression.',
      reasoning: 'PS5 system software updates can affect online play, firmware behavior, controller support, and system stability. PatchTicker validates Sony’s official system package URL and Last-Modified timestamp; it does not mislabel the support page’s CMS deployment revision as console firmware.',
      evidence: sourceEvidence('PlayStation System Software', url, `Official PS5 package ${artifactId} published ${releasedAt}; package build path ${parsed.artifactBuildDate}.`, { dateBasis: 'artifact-published', releaseType: 'official-artifact', publishedAt: releasedAt, artifactHash: parsed.artifactHash }),
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
      evidence: sourceEvidence('Intel Download Center', url, `${title} version ${version}. ${intro || ''}`, { dateBasis: 'released', releaseType: 'official-release' }),
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
  const releasedAt = toIsoDate(detected.releasedAt);
  if (!releasedAt) {
    throw new Error('Detector returned no trustworthy release/source date');
  }
  if (Date.parse(releasedAt) > Date.now() + (48 * 60 * 60 * 1000)) {
    throw new Error('Detector returned a future-dated release');
  }
  if (!detected.sourceUrl || !/^https:\/\//i.test(detected.sourceUrl)) {
    throw new Error('Detector returned no trustworthy HTTPS source');
  }
  return {
    ...detected,
    platform: detected.platform || platform,
    releasedAt,
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
async function detectAllDetailed(platforms = PLATFORM_KEYS, opts = {}) {
  const results = [];
  for (const platform of platforms) {
    results.push(await detectPlatformDetailed(platform, opts));
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

module.exports = {
  detectPlatform,
  detectPlatformDetailed,
  detectAll,
  detectAllDetailed,
  DETECTORS,
  __test: { parseSwitchReleasePage, parsePs5SupportPage, parseGogRemoteConfig, parseBattleNetVersionManifest, parseBattleNetBuildConfig, parseDiscordPatchIndex, parseDiscordPatchPage, parseSteamReleaseNotes, parseXboxContentApi, safeDecode, validateDetectedUpdate },
};

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
//   Chrome    — Google Chrome Releases Atom feed (full Stable desktop only)
//   Firefox   — Mozilla current-version JSON + release notes + security advisory
//   Edge      — Microsoft Learn Stable release notes + security release notes
//
// All detectors fail silently — a scrape failure never crashes the cron job.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');
const { URL } = require('node:url');
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

function artifactSizeBytes(headers = {}) {
  const contentRange = String(headers['content-range'] || headers.get?.('content-range') || '');
  const total = Number(contentRange.match(/\/(\d+)$/)?.[1]);
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

async function fetchOfficialArtifactMetadata(url, allowedHosts) {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== 'https:' || !allowedHosts.includes(parsedUrl.hostname)) {
    throw new Error(`Untrusted update artifact host: ${parsedUrl.hostname}`);
  }
  const res = await axios.get(parsedUrl.toString(), {
    timeout: TIMEOUT,
    responseType: 'arraybuffer',
    maxRedirects: 5,
    maxContentLength: 1024,
    maxBodyLength: 1024,
    headers: {
      'User-Agent': UA,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Range': 'bytes=0-0',
    },
    validateStatus: status => status === 200 || status === 206,
  });
  return {
    headers: res.headers || {},
    sizeBytes: artifactSizeBytes(res.headers),
  };
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

async function fetchOfficialPdfText(url, allowedHosts) {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== 'https:' || !allowedHosts.includes(parsedUrl.hostname)) {
    throw new Error(`Untrusted release-notes PDF host: ${parsedUrl.hostname}`);
  }
  const res = await axios.get(parsedUrl.toString(), {
    timeout: TIMEOUT,
    responseType: 'arraybuffer',
    maxContentLength: 8 * 1024 * 1024,
    maxBodyLength: 8 * 1024 * 1024,
    headers: { 'User-Agent': UA, 'Accept': 'application/pdf', 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
  const data = Buffer.from(res.data || []);
  if ((!contentType.includes('application/pdf') && !data.subarray(0, 4).equals(Buffer.from('%PDF'))) || data.length > 8 * 1024 * 1024) {
    throw new Error('Official release-notes response was not a supported PDF');
  }

  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText();
    return String(result.text || '');
  } finally {
    await parser.destroy();
  }
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

function boundedText(value, max = 360) {
  const text = cleanText(value, Math.max(max * 4, max + 1));
  if (text.length <= max) {
    return text;
  }
  const candidate = text.slice(0, Math.max(1, max - 1));
  const sentenceEnd = Math.max(candidate.lastIndexOf('. '), candidate.lastIndexOf('; '));
  const wordEnd = candidate.lastIndexOf(' ');
  const cut = sentenceEnd >= Math.floor(max * 0.55) ? sentenceEnd + 1 : wordEnd;
  return `${candidate.slice(0, Math.max(1, cut)).trim()}…`;
}

function unique(values, max = 280) {
  return [...new Set(values.map(v => boundedText(v, max)).filter(Boolean))];
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
      node.find('li').each((__, li) => bullets.push(boundedText($(li).text(), 420)));
      const p = boundedText(node.text(), 420);
      if (p && bullets.length < 2) bullets.push(p);
      node = node.next();
    }
  });
  return unique(bullets, 420).slice(0, max);
}

function sourceEvidence(source, url, text, meta = {}) {
  return [{
    source,
    url,
    text: boundedText(text, 260),
    checkedAt: new Date().toISOString(),
    ...meta,
  }];
}

function cleanDriverText(value, max = 360) {
  return boundedText(value, max)
    .replace(/[®™]/g, '')
    .replace(/\*/g, '')
    .replace(/\s+([,.;:])/g, '$1')
    .trim();
}

function strongSection($, label) {
  const heading = $('strong').filter((_, element) => cleanText($(element).text(), 100).toLowerCase().includes(label.toLowerCase())).first();
  if (!heading.length) return { intro: '', bullets: [] };

  const intro = [];
  let list = null;
  let node = heading.get(0)?.next || null;
  while (node) {
    if (node.type === 'tag' && node.name === 'strong') break;
    if (node.type === 'tag' && node.name === 'ul') {
      list = node;
      break;
    }
    const text = node.type === 'text' ? node.data : $(node).text();
    if (text) intro.push(text);
    node = node.next;
  }

  const bullets = list
    ? $(list).find('li').map((_, li) => cleanDriverText($(li).text())).get().filter(Boolean)
    : [];
  return { intro: cleanDriverText(intro.join(' '), 620), bullets: unique(bullets, 360) };
}

function pdfSection(text, startPattern, endPattern) {
  const source = String(text || '');
  const starts = [...source.matchAll(new RegExp(startPattern.source, `${startPattern.flags.replace('g', '')}g`))];
  const start = starts.at(-1);
  if (!start) return '';
  const tail = source.slice(start.index + start[0].length);
  const end = tail.search(endPattern);
  return end >= 0 ? tail.slice(0, end) : tail;
}

function markedPdfBullets(section) {
  const entries = [];
  let heading = '';
  let current = null;
  const flush = () => {
    if (current?.text) {
      const text = cleanDriverText(current.text, 620)
        .replace(/\s+RN-[A-Z0-9._-]+(?:\s+v\d+)?\s*\|[\s\S]*$/i, '')
        .replace(/\s+--\s*\d+\s+of\s+\d+\s*--[\s\S]*$/i, '')
        .trim();
      if (text) entries.push({ heading, text: cleanDriverText(text, 520) });
    }
    current = null;
  };

  for (const rawLine of String(section || '').replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim();
    if (!line || /^--\s*\d+\s+of\s+\d+\s*--$/i.test(line) || /Intel Corporation|Other names and brands/i.test(line)) continue;
    if (/^We continuously strive to improve/i.test(line)) {
      flush();
      continue;
    }
    if (!/^[▪>]\s*/.test(line) && /:$/.test(line) && line.length < 130) {
      flush();
      heading = cleanDriverText(line.replace(/:$/, ''), 140);
      continue;
    }
    if (/^[▪>]\s*/.test(line)) {
      flush();
      current = { text: line.replace(/^[▪>]\s*/, '') };
      continue;
    }
    if (current) current.text += ` ${line}`;
  }
  flush();
  return entries.filter(entry => entry.text);
}

function compactIntelFamily(heading) {
  const value = cleanDriverText(heading, 160);
  if (/Core Ultra Series 3/i.test(value)) return 'Core Ultra Series 3';
  if (/Core Ultra Series 2/i.test(value)) return 'Core Ultra Series 2';
  if (/Core Ultra Series 1/i.test(value)) return 'Core Ultra Series 1';
  if (/Arc B-Series/i.test(value)) return 'Arc B-Series';
  if (/Arc A-Series/i.test(value)) return 'Arc A-Series';
  if (/Graphics Software/i.test(value)) return 'Intel Graphics Software';
  return value;
}

function dedupeIntelIssues(entries) {
  const byIssue = new Map();
  for (const entry of entries) {
    const text = cleanDriverText(entry.text, 520);
    const key = text.toLowerCase();
    if (!key) continue;
    if (!byIssue.has(key)) byIssue.set(key, { text, families: new Set() });
    const family = compactIntelFamily(entry.heading);
    if (family) byIssue.get(key).families.add(family);
  }
  return [...byIssue.values()].map(({ text, families }) => {
    const labels = [...families];
    const allArcAndUltra = ['Arc A-Series', 'Arc B-Series', 'Core Ultra Series 1', 'Core Ultra Series 2', 'Core Ultra Series 3']
      .every(label => labels.includes(label));
    const scope = allArcAndUltra ? 'Arc A/B + Core Ultra Series 1–3' : labels.join(', ');
    return scope ? `${text} (${scope})` : text;
  });
}

function isIntelGameTitle(value) {
  const text = cleanDriverText(value, 180);
  if (!text || text.length > 120) return false;
  return !/\b(?:may|might|can|could|will)\s+(?:experience|display|show|fail|crash|stop)|\b(?:crash|corruption|artifact|known issue|recommendation|currently in beta|no action|workaround|unavailable)\b/i.test(text);
}

function parseNvidiaPdfReleaseDetails(pdfText) {
  const source = String(pdfText || '');
  const gameReady = pdfSection(
    source,
    /2\.4\.1\s+Game Ready for\s*/i,
    /2\.4\.1\.1\s+Other Changes/i,
  );
  const heading = gameReady.split(/This new Game Ready Driver/i)[0]
    .replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' ')
    .replace(/RN-\S+[^\n]*/gi, ' ')
    .replace(/Release \d+ Driver[^\n]*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const gameTitles = unique(
    heading
      .split(/\s*(?:,|&|\band\b)\s*/i)
      .map(title => cleanDriverText(title, 120))
      .filter(title => title && title.length <= 100 && !/^Game Ready/i.test(title)),
    120,
  );
  const gameIntro = cleanDriverText(gameReady.match(/This new Game Ready Driver[\s\S]*?(?=Learn more|$)/i)?.[0], 520);
  const fixedGaming = pdfSection(
    source,
    /3\.1\.1\s+Fixed Gaming Bugs\s*/i,
    /3\.1\.2\s+Fixed General Bugs/i,
  );
  const fixedGeneral = pdfSection(
    source,
    /3\.1\.2\s+Fixed General Bugs\s*/i,
    /3\.2\s+Open Issues in Version/i,
  );
  const bulletText = section => unique(
    markedPdfBullets(section)
      .map(entry => entry.text)
      .filter(text => text && !/^N\/?A\.?$/i.test(text)),
    520,
  );

  return {
    gameTitles,
    gameIntro,
    gamingFixes: bulletText(fixedGaming),
    generalFixes: bulletText(fixedGeneral),
  };
}

function parseNvidiaReleaseNotes(encodedNotes, encodedOtherNotes = '', pdfText = '') {
  const notesHtml = safeDecode(encodedNotes);
  const otherHtml = safeDecode(encodedOtherNotes);
  const $ = cheerio.load(`<div id="nvidia-notes">${notesHtml}</div>`);
  const gameReady = strongSection($, 'Game Ready for');
  const pdfDetails = parseNvidiaPdfReleaseDetails(pdfText);
  const gamingFixes = unique([...strongSection($, 'Fixed Gaming Bugs').bullets, ...pdfDetails.gamingFixes], 520);
  const generalFixes = unique([...strongSection($, 'Fixed General Bugs').bullets, ...pdfDetails.generalFixes], 520);
  const includedGames = gameReady.intro.match(/including\s+(.+?)(?:\.|$)/i)?.[1] || '';
  const gameTitles = unique([...includedGames
    .replace(/,\s+and\s+/i, ', ')
    .split(/\s*,\s*/)
    .map(title => cleanDriverText(title, 100)), ...pdfDetails.gameTitles], 100);
  const other$ = cheerio.load(otherHtml);
  const releaseNotesUrl = other$('a[href$=".pdf"]').filter((_, link) => /release notes/i.test(other$(link).text())).first().attr('href')
    || otherHtml.match(/https:\/\/[^"'\s]+release-notes\.pdf/i)?.[0]
    || null;
  const openSection = pdfSection(pdfText, /3\.2\s+Open Issues in Version[^\n]*/i, /3\.3\s+Issues Not Caused/i);
  const knownIssues = unique(markedPdfBullets(openSection).map(entry => entry.text), 520);
  const changelog = unique([
    gameTitles.length ? `Game support — ${gameTitles.join('; ')}.` : gameReady.intro || pdfDetails.gameIntro,
    ...gamingFixes.map(item => `Game fix — ${item}`),
    ...generalFixes.map(item => `General fix — ${item}`),
  ], 520);

  return {
    changelog,
    knownIssues,
    releaseNotesUrl,
    gameTitles,
    gameSupportCount: gameTitles.length,
    gameFixCount: gamingFixes.length,
    generalFixCount: generalFixes.length,
    knownIssueCount: knownIssues.length,
  };
}

function nvidiaImpactMetadata(driver, parsed) {
  return {
    gameSupportCount: parsed.gameSupportCount,
    gameFixCount: parsed.gameFixCount,
    generalFixCount: parsed.generalFixCount,
    knownIssueCount: parsed.knownIssueCount,
    whql: true,
    packageSize: cleanText(driver?.DownloadURLFileSize, 48) || undefined,
  };
}

function parseNvidiaCompatibility(drivers = []) {
  const alignedDrivers = (Array.isArray(drivers) ? drivers : [drivers]).filter(Boolean);
  const seen = new Set();
  const hardware = [];
  const operatingSystems = [];
  const sourceUrls = [];

  for (const driver of alignedDrivers) {
    if (driver.DetailsURL) sourceUrls.push(driver.DetailsURL);
    for (const os of driver.OSList || []) {
      const label = cleanDriverText(safeDecode(os?.OSName), 100);
      if (label) operatingSystems.push(label);
    }
    for (const series of driver.series || []) {
      const seriesLabel = cleanDriverText(safeDecode(series?.seriesname), 120);
      const notebook = /notebook|laptop/i.test(seriesLabel);
      for (const product of series?.products || []) {
        const label = cleanDriverText(safeDecode(product?.productName), 160);
        const key = label.toLowerCase();
        if (!label || seen.has(key)) continue;
        seen.add(key);
        const withoutNvidia = label.replace(/^NVIDIA\s+/i, '');
        const withoutGeForce = withoutNvidia.replace(/^GeForce\s+/i, '');
        hardware.push({
          label,
          category: notebook || /laptop/i.test(label) ? 'mobile' : 'desktop',
          matchType: 'exact-model',
          aliases: unique([
            label.toLowerCase(),
            withoutNvidia.toLowerCase(),
            withoutGeForce.toLowerCase(),
          ], 120),
        });
      }
    }
  }

  if (!hardware.length || !operatingSystems.length) return null;
  return {
    schemaVersion: 1,
    vendor: 'NVIDIA',
    scope: 'graphics-driver',
    authoritative: true,
    catalogCompleteness: 'official-driver-lookup-products',
    hardware,
    operatingSystems: unique(operatingSystems, 100),
    exclusions: [],
    sourceUrls: unique(sourceUrls, 260),
    guidance: 'NVIDIA lists these desktop and notebook GPUs for this Game Ready package. Notebook owners should still check the computer manufacturer’s certified driver first.',
  };
}

function parseIntelReleaseNotes(pdfText) {
  const source = String(pdfText || '');
  const versionLine = source.match(/Driver Version:\s*([\d.]+)\s*(Non-WHQL|WHQL)?/i);
  const highlights = pdfSection(
    source,
    /^\s*Highlights:\s*$/im,
    /^\s*(?:Fixed Issues|Known Issues|Intel[^\n]*Graphics Software Known Issues|Notes|Driver Package Contents):\s*$/im,
  );
  const fixed = pdfSection(
    source,
    /^\s*Fixed Issues:\s*$/im,
    /^\s*(?:Known Issues|Intel[^\n]*Graphics Software Known Issues|Notes|Driver Package Contents):\s*$/im,
  );
  const known = pdfSection(source, /^\s*Known Issues:\s*$/im, /^\s*Intel[^\n]*Graphics Software Known Issues:\s*$/im);
  const softwareKnown = pdfSection(source, /^\s*Intel[^\n]*Graphics Software Known Issues:\s*$/im, /^\s*Intel[^\n]*Graphics Software Performance Tuning/im);
  const gameTitles = unique(markedPdfBullets(highlights).map(entry => entry.text).filter(isIntelGameTitle), 140);
  const fixedIssues = dedupeIntelIssues(markedPdfBullets(fixed));
  const gameKnownIssues = dedupeIntelIssues(markedPdfBullets(known));
  const softwareKnownIssues = dedupeIntelIssues(markedPdfBullets(softwareKnown));
  const knownIssueCount = gameKnownIssues.length + softwareKnownIssues.length;
  const compatibility = parseIntelCompatibility(source);

  return {
    version: versionLine?.[1] || null,
    whql: versionLine?.[2]?.toLowerCase() === 'whql',
    releasedAt: toIsoDate(source.match(/Date:\s*([^\n]+)/i)?.[1]),
    gameTitles,
    changelog: unique([
      gameTitles.length ? `Game support — ${gameTitles.join('; ')}.` : '',
      ...fixedIssues.map(item => `Fixed — ${item}`),
    ], 520),
    knownIssues: [...gameKnownIssues, ...softwareKnownIssues].slice(0, 14),
    gameSupportCount: gameTitles.length,
    gameFixCount: fixedIssues.length,
    knownIssueCount,
    compatibility,
  };
}

function reconcileIntelReleaseDates(catalogDate, releaseNotesDate) {
  const catalog = toIsoDate(catalogDate);
  const releaseNotes = toIsoDate(releaseNotesDate);
  const releasedAt = releaseNotes || catalog;
  const discrepancyDays = catalog && releaseNotes
    ? Math.round(Math.abs(Date.parse(releaseNotes) - Date.parse(catalog)) / 86_400_000)
    : 0;

  return {
    releasedAt,
    catalogDate: catalog,
    releaseNotesDate: releaseNotes,
    hasDiscrepancy: Boolean(catalog && releaseNotes && catalog !== releaseNotes),
    discrepancyDays,
  };
}

function absoluteUrl(url, base) {
  if (!url) return base;
  try { return new globalThis.URL(url, base).toString(); }
  catch { return base; }
}

function safeDecode(value) {
  try { return decodeURIComponent(String(value || '').replace(/\+/g, ' ')); }
  catch { return String(value || ''); }
}

function metaContent($, name) {
  return $(`meta[name="${name}"], meta[property="${name}"]`).attr('content') || '';
}

function microsoftSecurityCriticality(title, sourceUrl = '') {
  if (/security(?:\s+|-)update/i.test(`${title || ''} ${sourceUrl || ''}`)) {
    return { level: 'medium', label: 'Microsoft security update; CVE details are published in the Security Update Guide', cves: [], totalCves: null };
  }
  return { level: 'none', label: 'No security classification published on this KB page', cves: [], totalCves: null };
}

function normalizeWindowsDetailNotes(changelog = [], knownIssues = []) {
  const usefulChanges = unique(changelog, 520).filter(text =>
    !/^[A-Z][a-z]+\s+\d{1,2},\s+\d{4}\s*[-—]\s*KB\d+/i.test(text)
    && !/^This update includes new features and quality improvements that were part of the following update:?$/i.test(text)
  );
  const unresolvedIssues = unique(knownIssues, 650).filter(text =>
    !/not currently aware of any issues|no known issues/i.test(text)
  );
  return { changelog: usefulChanges, knownIssues: unresolvedIssues };
}

function parseWindowsKnownIssues($, max = 8) {
  const heading = $('h2,h3').filter((_, element) => /known issues in this update/i.test(cleanText($(element).text(), 120))).first();
  if (!heading.length) return [];

  const issues = [];
  heading.nextUntil('h2').filter('details').each((_, detail) => {
    const node = $(detail);
    const title = cleanText(node.children('summary').first().text(), 220);
    const symptom = node.children('p').filter((__, paragraph) => {
      const text = cleanText($(paragraph).text(), 700);
      const label = cleanText($(paragraph).find('strong').first().text(), 80);
      return text
        && !/^(?:symptoms?|next steps?|resolution|microsoft support)\b/i.test(label)
        && !/^(?:symptoms?|next steps?|resolution|microsoft support)\b/i.test(text.replace(/^[^A-Za-z]+/, ''));
    }).first();
    const description = boundedText(symptom.text(), 520);
    const symptomItems = node.children('ul,ol').first().children('li')
      .map((__, item) => boundedText($(item).text(), 180))
      .get()
      .filter(Boolean)
      .slice(0, 4);
    const symptomLabel = /\bsymptoms?:\s*$/i.test(description) ? '' : 'Symptoms: ';
    const symptomSummary = symptomItems.length
      ? `${description}${description ? ' ' : ''}${symptomLabel}${symptomItems.join(' ')}`
      : description;
    const combined = title && symptomSummary && !symptomSummary.toLowerCase().startsWith(title.toLowerCase())
      ? `${title}: ${symptomSummary}`
      : title || symptomSummary;
    if (combined) issues.push(boundedText(combined, 650));
  });

  // Older KB templates publish ordinary lists instead of disclosure panels.
  return unique(issues.length ? issues : sectionBullets($, ['Known issues'], max), 650).slice(0, max);
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

function parseAppleSecurityAdvisory(html) {
  const $ = cheerio.load(String(html || ''));
  const sections = $('#sections');
  if (!sections.length) return null;

  const title = cleanText(sections.find('h1').first().text() || $('h1').first().text(), 180);
  const product = cleanText(
    sections.find('h2').filter((_, heading) => !/about apple security updates|additional recognition|apple footer/i.test($(heading).text())).first().text(),
    160
  );
  const sectionsText = cleanText(sections.text(), 200000);
  const releasedAt = toIsoDate(
    sectionsText.match(/\bReleased\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/i)?.[1]
  );
  if (!title || !product || !releasedAt) return null;

  const entries = [];
  sections.find('h3').each((order, heading) => {
    const component = cleanText($(heading).text(), 100);
    const paragraphs = [];
    let node = $(heading).next();
    let guard = 0;
    while (node.length && guard++ < 12 && !/^h[23]$/i.test(node[0]?.tagName || '')) {
      const text = cleanText(node.text(), 1200);
      if (text) paragraphs.push(text);
      node = node.next();
    }

    const impact = paragraphs.find(text => /^Impact:/i.test(text))?.replace(/^Impact:\s*/i, '') || null;
    if (!component || !impact) return;
    const availability = paragraphs.find(text => /^Available for:/i.test(text))?.replace(/^Available for:\s*/i, '') || null;
    const description = paragraphs.find(text => /^Description:/i.test(text))?.replace(/^Description:\s*/i, '') || null;
    const cves = unique(paragraphs.flatMap(text => text.match(/CVE-\d{4}-\d{4,7}/g) || []), 40);
    const entryText = `${component} ${impact} ${description || ''} ${paragraphs.join(' ')}`;
    const activelyExploited = /aware of a report[^.]{0,240}(?:actively )?exploited|may have been actively exploited|has been actively exploited/i.test(entryText);

    let priority = activelyExploited ? 100 : 0;
    if (/arbitrary code|code execution|kernel privileges?|root privileges?/i.test(impact)) priority += 30;
    if (/authenticate[^.]{0,120}without valid credentials|bypass|sensitive user data|security restrictions?/i.test(impact)) priority += 22;
    if (/kernel|webkit|screen sharing|apple neural engine/i.test(component)) priority += 8;
    if (/unexpected system termination|denial of service|crash/i.test(impact)) priority += 5;

    entries.push({ component, impact, availability, description, cves, activelyExploited, priority, order });
  });
  if (!entries.length) return null;

  const cves = unique(entries.flatMap(entry => entry.cves), 40);
  const activelyExploited = entries.some(entry => entry.activelyExploited);
  const highImpact = entries.some(entry => /arbitrary code|code execution|kernel privileges?|root privileges?|without valid credentials|security restrictions?/i.test(entry.impact));
  const ranked = [...entries].sort((a, b) => b.priority - a.priority || a.order - b.order);
  const changelog = ranked.slice(0, 12).map(entry => {
    const cveLabel = entry.cves.length
      ? ` (${entry.cves[0]}${entry.cves.length > 1 ? ` +${entry.cves.length - 1} more` : ''})`
      : '';
    return cleanText(`${entry.component}: ${entry.impact}${cveLabel}`, 420);
  });

  const level = activelyExploited ? 'critical' : highImpact ? 'high' : cves.length ? 'medium' : 'low';
  const label = activelyExploited
    ? `${cves.length} documented CVEs, including actively exploited issues`
    : cves.length
      ? `${cves.length} documented CVE${cves.length === 1 ? '' : 's'} across ${entries.length} security component${entries.length === 1 ? '' : 's'}`
      : `${entries.length} security component${entries.length === 1 ? '' : 's'} documented by Apple`;

  return {
    title,
    product,
    releasedAt,
    entries,
    changelog,
    securityCriticality: {
      level,
      label,
      cves: cves.slice(0, 50),
      totalCves: cves.length,
      activelyExploited,
    },
  };
}

function parseAppleSecurityIndex(html) {
  const $ = cheerio.load(String(html || ''));
  const rows = [];
  $('tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 2) return;

    // Apple sometimes publishes a release directly in the index without an
    // advisory link (for example when there are no published CVE entries).
    // Read only the leading product paragraph so the adjacent note does not
    // become part of the release name/version identity.
    const productCell = cells.eq(0);
    const product = cleanText(
      productCell.find(':scope > p').first().text()
        || productCell.find('a').first().text()
        || productCell.clone().children('.note').remove().end().text(),
      160
    );
    const link = productCell.find('a').first().attr('href') || '';
    const note = cleanText(productCell.find('.note').first().text(), 240);
    const date = cleanText(cells.eq(2).text() || cells.eq(1).text(), 80);
    if (product) rows.push({ product, link, note, date });
  });
  return rows;
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

function parsePlainSteamReleaseNotes(value) {
  const text = cleanText(value, 3600);
  if (!text) return { changelog: [], knownIssues: [] };
  const body = text.replace(/^.*?following changes:\s*/i, '');
  const headings = [
    'Security and stability improvements', 'Known Issues', 'Desktop Mode',
    'Gaming Mode', 'Docked Mode', 'Steam Input', 'Display', 'Graphics',
    'Audio', 'Bluetooth', 'Wi-Fi', 'Network', 'General',
  ];
  const pattern = new RegExp(`(${headings.map(heading => heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=[A-Z])`, 'g');
  const matches = [...body.matchAll(pattern)];
  if (!matches.length) return { changelog: [text], knownIssues: [] };

  const changelog = [];
  const knownIssues = [];
  matches.forEach((match, index) => {
    const heading = match[1];
    const start = match.index + heading.length;
    const end = matches[index + 1]?.index ?? body.length;
    const detail = cleanText(body.slice(start, end), 900);
    if (!detail) return;
    if (/known issues?/i.test(heading)) knownIssues.push(detail);
    else changelog.push(`${heading}: ${detail}`);
  });
  return {
    changelog: unique(changelog, 920).slice(0, 12),
    knownIssues: unique(knownIssues, 650).slice(0, 8),
  };
}

function isSteamPreviewRelease(title, contents) {
  if (/\b(?:beta|preview|experimental)\b/i.test(String(title || ''))) return true;
  // Stable posts sometimes explain that one reverted fix remains available in
  // Beta. Reject only an explicit channel declaration, not every incidental
  // mention of a prerelease channel inside otherwise stable release notes.
  const opening = cleanText(contents, 500);
  return /(?:this update is for|have just shipped|has just shipped)[^.!]{0,220}\b(?:beta|preview|experimental)\b[^.!]{0,80}\bchannels?\b/i.test(opening);
}

function steamClientReleaseIdentity(sourceUrl, publishedAt, productIdOverride = null) {
  const releasedAt = toIsoDate(publishedAt);
  const articleId = String(sourceUrl || '').match(/\/view\/(\d+)/i)?.[1] || null;
  const displayVersion = releasedAt ? releasedAt.replace(/-/g, '.') : null;
  const productId = String(productIdOverride || '').trim()
    || String(sourceUrl || '').match(/\/news\/app\/(\d+)/i)?.[1]
    || '593110';
  const isDeckLane = productId === '1675200';
  return {
    version: articleId
      ? `${isDeckLane ? 'deck-client' : 'client'}-${articleId}`
      : (displayVersion ? `${isDeckLane ? 'deck-client' : 'client'}-${displayVersion}` : null),
    displayVersion,
    sourceKind: isDeckLane ? 'steam-deck-news' : 'steam-client-news',
    sourceRef: articleId
      ? `${isDeckLane ? 'steam-deck' : 'steam-client'}:${articleId}`
      : (displayVersion ? `${isDeckLane ? 'steam-deck' : 'steam-client'}:${displayVersion}` : null),
    productId,
  };
}

function steamDeckReleaseFromPost(post) {
  const title = cleanText(post?.title, 160);
  if (!/(?:\bSteamOS\s+\d|Steam Deck.+Update)/i.test(title)) return null;
  if (isSteamPreviewRelease(title, post?.contents)) return null;

  const publishedMs = Number(post?.date) * 1000;
  const releasedAt = Number.isFinite(publishedMs) && publishedMs > 0
    ? toIsoDate(new Date(publishedMs).toISOString())
    : null;
  const sourceUrl = String(post?.url || '').trim();
  if (!releasedAt || !/^https:\/\/(?:store\.steampowered\.com|steamstore-a\.akamaihd\.net)\//i.test(sourceUrl)) return null;

  const rawContents = String(post?.contents || '');
  const notes = /<\/?[a-z][^>]*>/i.test(rawContents)
    ? parseSteamReleaseNotes(rawContents)
    : parsePlainSteamReleaseNotes(rawContents);
  const description = cleanText(post?.contents, 900);
  const explicitVersion = firstVersion(title);
  const articleId = String(post?.gid || '').replace(/\D/g, '')
    || sourceUrl.match(/\/(?:view|steam_community_announcements)\/(\d+)/i)?.[1]
    || null;
  const isSteamOs = /\bSteamOS\b/i.test(title);
  const identity = steamClientReleaseIdentity(
    articleId ? `https://store.steampowered.com/news/app/1675200/view/${articleId}` : sourceUrl,
    releasedAt,
    '1675200',
  );
  const sourceKind = isSteamOs ? 'steamos-news' : identity.sourceKind;
  const sourceRef = articleId
    ? `${isSteamOs ? 'steamos' : 'steam-deck'}:${articleId}`
    : identity.sourceRef;

  return {
    platform: 'Steam',
    name: title,
    version: explicitVersion || identity.version,
    displayVersion: explicitVersion || identity.displayVersion,
    sourceKind,
    sourceRef,
    productId: '1675200',
    releasedAt,
    affects: isSteamOs
      ? 'Steam Deck / SteamOS / handheld compatibility / system firmware / desktop mode'
      : 'Steam Deck client / controller input / library / downloads / handheld interface',
    changelog: notes.changelog.length ? notes.changelog : [description].filter(Boolean),
    knownIssues: notes.knownIssues,
    riskFactors: notes.knownIssues.length
      ? [{ level: 'medium', text: notes.knownIssues[0] }]
      : [],
    verdict: isSteamOs
      ? 'Install if the listed stable SteamOS fixes apply to your Steam Deck; review hardware and dock changes before updating a travel-critical device.'
      : 'Allow the stable Steam Deck client update when its controller, library, or download fixes apply to your setup.',
    reasoning: isSteamOs
      ? 'PatchTicker tracks Valve’s stable SteamOS lane separately from Beta and desktop-client releases, so a newer PC client post cannot hide the latest Steam Deck system update.'
      : 'PatchTicker tracks Valve’s stable Steam Deck client lane separately from desktop Steam and excludes Beta or Preview releases.',
    evidence: sourceEvidence('Steam Deck News', sourceUrl, `${title}. ${description}`, {
      dateBasis: 'published',
      releaseType: 'official-release',
      publishedAt: releasedAt,
      steamAppId: '1675200',
    }),
    sourceUrl,
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
  const pattern = label instanceof RegExp ? label : new RegExp(label, 'i');
  const bullets = [];
  $('li').each((_, li) => {
    const own = cleanText($(li).clone().children('ul,ol').remove().end().text(), 160).replace(/:\s*$/, '');
    pattern.lastIndex = 0;
    if (!pattern.test(own)) return;
    $(li).children('ul,ol').first().children('li').each((__, child) => {
      bullets.push(cleanDriverText($(child).text(), 520));
    });
  });
  return unique(bullets, 520).slice(0, max);
}

function amdHeadingBullets($, label, max = 12) {
  const pattern = label instanceof RegExp ? label : new RegExp(label, 'i');
  const bullets = [];
  const heading = $('h2,h3,h4').filter((_, element) => {
    pattern.lastIndex = 0;
    return pattern.test(cleanText($(element).text(), 160));
  }).first();
  if (!heading.length) return bullets;

  let node = heading.next();
  let guard = 0;
  while (node.length && guard++ < 8 && !/^h[234]$/i.test(node[0]?.tagName || '')) {
    const items = node.is('ul,ol') ? node.children('li') : node.find('li');
    items.each((_, item) => bullets.push(cleanDriverText($(item).text(), 520)));
    node = node.next();
  }
  return unique(bullets, 520).slice(0, max);
}

function headingSectionRows($, label, max = 40) {
  const pattern = label instanceof RegExp ? label : new RegExp(label, 'i');
  const heading = $('h2,h3').filter((_, element) => {
    pattern.lastIndex = 0;
    return pattern.test(cleanDriverText($(element).text(), 180));
  }).first();
  if (!heading.length) return [];

  const rows = [];
  let node = heading.next();
  let guard = 0;
  while (node.length && guard++ < 12 && !/^h[23]$/i.test(node[0]?.tagName || '')) {
    node.find('tr').each((_, row) => {
      $(row).find('th,td').each((__, cell) => {
        const text = cleanDriverText($(cell).text(), 240);
        if (text && !/^(?:desktop|mobile)$/i.test(text)) rows.push(text);
      });
    });
    node.find('li').each((_, item) => {
      const text = cleanDriverText($(item).text(), 240);
      if (text) rows.push(text);
    });
    node = node.next();
  }
  return unique(rows, 240).slice(0, max);
}

function amdHardwareAliases(label) {
  const text = cleanDriverText(label, 240);
  const aliases = [];
  const addModels = (pattern, prefix) => {
    for (const match of text.matchAll(pattern)) {
      const model = cleanDriverText(match[0], 24).toLowerCase();
      aliases.push(`${prefix} ${model}`, model);
    }
  };

  if (/Radeon\s+RX/i.test(text)) addModels(/\b\d{4}M?\b/gi, 'radeon rx');
  else if (/Radeon\s+AI\s+PRO/i.test(text)) addModels(/\bR\d{4}[A-Z]?\b/gi, 'radeon ai pro');
  else if (/Radeon\s+PRO/i.test(text)) addModels(/\bW\d{4}M?\b/gi, 'radeon pro');

  return unique(aliases, 80).map(alias => alias.toLowerCase());
}

function parseAmdCompatibility($) {
  const desktop = headingSectionRows($, /^Radeon Product Compatibility$/i);
  const mobility = headingSectionRows($, /^Mobility Radeon Product Compatibility$/i);
  const processor = headingSectionRows($, /Processors with Radeon Graphics Product Compatibility/i);
  const operatingSystems = headingSectionRows($, /^Compatible Operating Systems$/i);
  const hardware = [
    ...desktop.map(label => ({ label, category: 'desktop', matchType: 'model-family', aliases: amdHardwareAliases(label) })),
    ...mobility.map(label => ({ label, category: 'mobile', matchType: 'model-family', aliases: amdHardwareAliases(label) })),
    ...processor.map(label => ({
      label,
      category: 'integrated',
      matchType: 'family',
      aliases: [cleanDriverText(label, 160).toLowerCase()],
    })),
  ].filter(entry => entry.aliases.length);

  if (!hardware.length || !operatingSystems.length) return null;
  return {
    schemaVersion: 1,
    vendor: 'AMD',
    scope: 'graphics-driver',
    authoritative: true,
    catalogCompleteness: 'explicit-discrete-models-and-broad-integrated-families',
    hardware,
    operatingSystems,
    exclusions: [
      { label: 'Apple Boot Camp', aliases: ['apple boot camp', 'boot camp', 'macos', 'mac os'] },
      { label: 'Handheld gaming devices require an OEM driver', aliases: ['steam deck', 'rog ally', 'legion go', 'handheld gaming'] },
    ],
    guidance: 'AMD identifies this as a reference driver. Laptop, all-in-one, and integrated-graphics systems should prefer the computer manufacturer’s validated driver.',
  };
}

function parseIntelCompatibility(pdfText) {
  const section = pdfSection(
    pdfText,
    /^\s*Operating System Support:\s*$/im,
    /^\s*More on Intel Products:\s*$/im,
  );
  if (!section) return null;
  const searchable = section.replace(/[®™]/g, '').replace(/\s+/g, ' ');

  const modelTokens = unique(
    [...section.matchAll(/\b(?:A\d{3,4}(?:M|E)?|B\d{2,3})(?:\s+LP)?\b/gi)].map(match => match[0]),
    24,
  );
  const hardware = modelTokens.map(token => {
    const model = cleanDriverText(token, 24);
    const isPro = /^B(?:50|60|65|70)$/i.test(model);
    const label = `Intel Arc${isPro ? ' Pro' : ''} ${model}`;
    return {
      label,
      category: /M$/i.test(model) ? 'mobile' : 'graphics',
      matchType: 'exact-model',
      aliases: [`intel arc ${model}`, `arc ${model}`, model].map(alias => alias.toLowerCase()),
    };
  });

  if (/Core Ultra Series 3/i.test(searchable)) {
    hardware.push({
      label: 'Intel Core Ultra Series 3 with built-in Intel Arc graphics',
      category: 'integrated',
      matchType: 'family',
      aliases: ['intel core ultra series 3', 'core ultra series 3', 'panther lake'],
    });
  }
  if (/Core Ultra with built-in Intel/i.test(searchable)) {
    hardware.push({
      label: 'Intel Core Ultra with built-in Intel Arc graphics',
      category: 'integrated',
      matchType: 'family',
      aliases: ['core ultra with intel arc', 'meteor lake', 'lunar lake', 'arrow lake'],
    });
  }
  if (/Core Series 3 with built-in/i.test(searchable)) {
    hardware.push({
      label: 'Intel Core Series 3 with built-in Intel graphics',
      category: 'integrated',
      matchType: 'family',
      aliases: ['intel core series 3', 'core series 3', 'wildcat lake'],
    });
  }

  if (!hardware.length) return null;
  return {
    schemaVersion: 1,
    vendor: 'Intel',
    scope: 'graphics-driver',
    authoritative: true,
    catalogCompleteness: 'official-driver-support-table',
    hardware,
    operatingSystems: [
      'Windows 11 64-bit versions 21H2 through 25H2',
      'Windows 10 64-bit version 22H2',
    ],
    exclusions: [],
    guidance: 'Intel’s generic driver supports the listed graphics families, but computer manufacturers may provide a customized driver. Corporate and OEM-managed systems should use the manufacturer-validated package.',
  };
}

function parseIntelDownloadCompatibility($) {
  const labels = unique(
    $('.dc-page-detailed-other-valid-products-panel__product--fixed')
      .map((_, link) => cleanDriverText($(link).text(), 180))
      .get()
      .filter(Boolean),
    180,
  );
  const graphics = labels.filter(label => /\bIntel\s+Arc\b/i.test(label));
  if (!graphics.length) return null;

  const hardware = graphics.map(label => {
    const compact = cleanDriverText(label.replace(/\s*\([^)]*\)\s*/g, ' '), 150);
    const model = compact.match(/\b(?:A\d{3,4}(?:M|E)?|B\d{2,3}|1[034]\d[TV])(?:\s+LP)?\b/i)?.[0] || '';
    const aliases = unique([
      compact.toLowerCase(),
      compact.replace(/^Intel\s+/i, '').toLowerCase(),
      model ? `intel arc ${model}`.toLowerCase() : '',
      model ? `arc ${model}`.toLowerCase() : '',
      model.toLowerCase(),
    ].filter(Boolean), 80);
    return {
      label: compact,
      category: /M$/i.test(model) ? 'mobile' : /\b(?:130|140)[TV]\b/i.test(model) ? 'integrated' : 'graphics',
      matchType: 'exact-model',
      aliases,
    };
  });

  // Do not truncate before the platform-support block; Intel's long valid-
  // products list can push that text well beyond a generic summary limit.
  const body = String($('body').text() || '').replace(/[®™]/g, '').replace(/\s+/g, ' ').trim();
  if (/Intel Core Ultra processor family/i.test(body)) {
    hardware.push({
      label: 'Intel Core Ultra processors with built-in Intel Arc graphics',
      category: 'integrated',
      matchType: 'family',
      aliases: ['intel core ultra', 'core ultra'],
    });
  }
  if (/Intel\s+Core\s+processor family\s*\(Codename Wildcat Lake\)/i.test(body)) {
    hardware.push({
      label: 'Intel Core processor family (Wildcat Lake) with built-in Intel graphics',
      category: 'integrated',
      matchType: 'family',
      aliases: ['wildcat lake', 'intel core series 3', 'core series 3'],
    });
  }

  return {
    schemaVersion: 1,
    vendor: 'Intel',
    scope: 'graphics-driver',
    authoritative: true,
    catalogCompleteness: 'official-download-valid-products-and-release-notes',
    hardware,
    operatingSystems: [
      'Windows 11 64-bit versions 21H2 through 25H2',
      'Windows 10 64-bit version 22H2',
    ],
    exclusions: [],
    guidance: 'Intel’s generic driver supports the listed graphics families, but computer manufacturers may provide a customized driver. Corporate and OEM-managed systems should use the manufacturer-validated package.',
  };
}

function mergeCompatibilityProfiles(primary, secondary) {
  if (!primary) return secondary || null;
  if (!secondary) return primary;
  const seenLabels = new Set();
  const seenAliases = new Set();
  const hardware = [...(primary.hardware || []), ...(secondary.hardware || [])].filter(entry => {
    const key = cleanDriverText(entry.label, 180).toLowerCase();
    const aliases = unique(entry.aliases || [], 100).map(alias => cleanDriverText(alias, 100).toLowerCase()).filter(Boolean);
    if (!key || seenLabels.has(key) || aliases.some(alias => seenAliases.has(alias))) return false;
    seenLabels.add(key);
    aliases.forEach(alias => seenAliases.add(alias));
    return true;
  });
  return {
    ...secondary,
    ...primary,
    hardware,
    operatingSystems: unique([...(primary.operatingSystems || []), ...(secondary.operatingSystems || [])], 180),
    exclusions: [...(primary.exclusions || []), ...(secondary.exclusions || [])],
  };
}

function compareVersionParts(left, right) {
  const a = String(left || '').split('.').map(Number);
  const b = String(right || '').split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta) return delta;
  }
  return 0;
}

function parseAmdDriverPage(html, baseUrl) {
  const $ = cheerio.load(html);
  const candidates = $('a[href*="/release-notes/RN-RAD-WIN-"]')
    .map((_, link) => {
      const url = absoluteUrl($(link).attr('href'), baseUrl);
      const version = url.match(/RN-RAD-WIN-(\d+(?:-\d+)+)\.html/i)?.[1]?.replace(/-/g, '.') || null;
      const article = $(link).closest('article');
      const packageSize = cleanText(
        article.find('strong').filter((__, label) => /^File Size$/i.test(cleanText($(label).text(), 40)))
          .first().nextAll('p').first().text(),
        48
      );
      const articleHtml = article.html() || '';
      const releaseChannel = articleHtml.match(/\bWHQL\s+(Recommended|Optional)\b/i)?.[1]?.toLowerCase() || null;
      return version && /^https:\/\/www\.amd\.com\/en\/resources\/support-articles\/release-notes\/RN-RAD-WIN-/i.test(url)
        ? {
            url,
            version,
            whql: Boolean(releaseChannel) || /(?:\/whql\/|whql-amd-software)/i.test(articleHtml),
            ...(releaseChannel ? { releaseChannel } : {}),
            ...(packageSize ? { packageSize } : {}),
          }
        : null;
    })
    .get()
    .filter(Boolean)
    .sort((a, b) => compareVersionParts(b.version, a.version));
  const latest = candidates[0];
  if (!latest) return null;
  return latest;
}

function parseIntelPackageSize(html) {
  const $ = cheerio.load(html);
  const value = cleanText(
    $('li').filter((_, item) => /^Size\s*:/i.test(cleanText($(item).text(), 80))).first().text(),
    80
  ).replace(/^Size\s*:\s*/i, '');
  return /^\d+(?:[.,]\d+)?\s*(?:KB|MB|GB|TB)$/i.test(value) ? value : null;
}

function parseAmdReleaseNotes(html, sourceUrl, options = {}) {
  const $ = cheerio.load(html);
  const title = cleanDriverText($('h1').first().text() || $('title').text(), 160);
  const body = cleanText($('body').text(), 12000);
  const version = title.match(/Adrenalin Edition\s+(\d+(?:\.\d+)+)/i)?.[1]
    || sourceUrl?.match(/RN-RAD-WIN-(\d+(?:-\d+)+)\.html/i)?.[1]?.replace(/-/g, '.')
    || null;
  const dateText = cleanText($('p').filter((_, element) => /Last Updated/i.test($(element).text())).first().text(), 160)
    .match(/([A-Z][a-z]+\s+\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i)
    ?.slice(1, 3).join(', ')
    || body.match(/(?:Last Updated|Date|Released)[:\s]+([A-Z][a-z]+\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1]?.replace(/(\d)(st|nd|rd|th)/i, '$1');
  const gameTitles = amdNestedBullets($, /^New Game Support$/i, 10);
  const fsrTitles = amdNestedBullets($, /^New Game Support for AMD FidelityFX/i, 12);
  const productSupport = amdNestedBullets($, /^New Product Support$/i, 8);
  const fixedIssues = amdNestedBullets($, /^Fixed Issues?(?: and Improvements)?$/i, 12);
  const knownIssues = unique([
    ...amdHeadingBullets($, /^Known Issues$/i, 12),
    ...amdNestedBullets($, /^Known Issues$/i, 12),
  ], 520).slice(0, 12);
  const compatibility = parseAmdCompatibility($);
  const supportedGames = unique([...gameTitles, ...fsrTitles], 140);
  const changelog = unique([
    gameTitles.length ? `Game support — ${gameTitles.join('; ')}.` : '',
    fsrTitles.length ? `FSR support — ${fsrTitles.join('; ')}.` : '',
    productSupport.length ? `Product support — ${productSupport.join('; ')}.` : '',
    ...fixedIssues.map(item => `Fixed — ${item}`),
  ], 520);

  if (!version || !toIsoDate(dateText)) return null;
  return {
    title: title || `AMD Software: Adrenalin Edition ${version}`,
    version,
    releasedAt: toIsoDate(dateText),
    changelog,
    knownIssues,
    gameSupportCount: supportedGames.length,
    gameFixCount: fixedIssues.length,
    knownIssueCount: knownIssues.length,
    productSupportCount: productSupport.length,
    whql: Boolean(options.whql),
    releaseChannel: options.releaseChannel || (/\bOptional\b/i.test(title) ? 'optional' : null),
    compatibility,
  };
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

function parseNintendoSecurityNoticeIndex(html, baseUrl = 'https://www.nintendo.com/security-advisories/en/index.html') {
  const $ = cheerio.load(String(html || ''));
  const notices = $('.section-news-listitem').map((_, item) => {
    const node = $(item);
    const date = toIsoDate(cleanText(node.find('.section-news-date').first().text(), 40).replace(/\./g, '-'));
    const link = node.find('.section-news-text a').first();
    const title = cleanText(link.text(), 220);
    const url = absoluteUrl(link.attr('href'), baseUrl);
    return date && title && /^https:\/\/www\.nintendo\.com\/security-advisories\/assets\/pdf\//i.test(url)
      ? { title, date, url }
      : null;
  }).get().filter(Boolean);
  return notices.sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0] || null;
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

function parsePs5SystemSoftwareInfo(html) {
  const $ = cheerio.load(String(html || ''));
  const versionHeading = $('h1,h2,h3,h4,h5,h6')
    .filter((_, heading) => /^\s*Version\s*:\s*[0-9]{2}\.[0-9]{2}-[0-9.]+\s*$/i.test(cleanText($(heading).text(), 120)))
    .first();
  if (!versionHeading.length) return null;

  const version = cleanText(versionHeading.text(), 120)
    .match(/^\s*Version\s*:\s*([0-9]{2}\.[0-9]{2}-[0-9.]+)\s*$/i)?.[1] || null;
  if (!version) return null;

  // Sony places each release heading and its list in one content block. Read
  // only the list attached to the first (current) heading so an expanded
  // "Previous updates" accordion cannot leak old notes into the new release.
  const releaseBlock = versionHeading.parent();
  const primaryList = versionHeading.nextAll('ul,ol').first();
  const list = primaryList.length ? primaryList : releaseBlock.find('ul,ol').first();
  const changelog = [];
  list.children('li').each((_, item) => {
    const node = $(item);
    const summaryNode = node.clone();
    summaryNode.find('ul,ol').remove();
    const summary = cleanText(summaryNode.text(), 520);
    const details = node.children('ul,ol').first().children('li').map((__, detail) => (
      cleanText($(detail).text(), 360)
    )).get().filter(Boolean);
    const combined = [summary, ...details].filter(Boolean).join(' ');
    if (combined) changelog.push(combined);
  });

  return {
    version,
    changelog: unique(changelog, 520).slice(0, 10),
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
      knownIssues = parseWindowsKnownIssues(detail, 8);
      if (!changelog.length) {
        const firstBody = cleanText(detail('main p, article p').first().text(), 260);
        if (firstBody) changelog = [firstBody];
      }
    } catch (detailErr) {
      logger.warn('[scraper] Windows detail page parse failed', { error: detailErr.message, url: update.sourceUrl });
    }

    ({ changelog, knownIssues } = normalizeWindowsDetailNotes(changelog, knownIssues));

    const previewNote = update.isPreview
      ? 'This is a Microsoft preview update; preview releases are generally optional and should be reviewed before broad installation.'
      : 'This is an official Microsoft cumulative update; review the KB page for deployment notes and known issues.';
    const securityCriticality = microsoftSecurityCriticality(update.title, update.sourceUrl);
    const isSecurityUpdate = securityCriticality.level !== 'none';

    return {
      platform:   'Windows',
      name:       `Windows 11 ${update.title}`.slice(0, 140),
      version:    update.kb,
      releasedAt: update.releasedAt,
      affects:    'Windows 11 supported releases / cumulative OS servicing / security and quality updates',
      changelog:  unique([previewNote, ...changelog]).slice(0, 6),
      knownIssues,
      knownIssuesAuthoritative: true,
      securityCriticality,
      evidence:   sourceEvidence('Microsoft Support', update.sourceUrl, update.title, {
        dateBasis: 'released',
        publishedAt: update.releasedAt,
        releaseType: isSecurityUpdate ? 'official-security-release' : 'official-release',
      }),
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
    // Query one current desktop and one current notebook product. NVIDIA's
    // lookup response then supplies the full official product matrix for that
    // package. The previous single product id (899) returned notebook-only
    // coverage while the public record claimed desktop support as well.
    const lookupUrl = pfid => (
      'https://gfwsl.geforce.com/services_toolkit/services/com/nvidia/services/AjaxDriverService.php?' +
      `func=DriverManualLookup&pfid=${pfid}&osID=57&languageCode=1033&isWHQL=1&dch=1&sort1=0&numberOfResults=1`
    );
    const [desktopData, notebookData] = await Promise.all([
      fetchJson(lookupUrl(1066)), // GeForce RTX 5090 desktop
      fetchJson(lookupUrl(1073)), // GeForce RTX 5090 Laptop GPU
    ]);
    const driver = desktopData?.IDS?.[0]?.downloadInfo;
    if (!driver) return null;
    const notebookDriver = notebookData?.IDS?.[0]?.downloadInfo;
    const compatibleDrivers = [
      driver,
      ...(notebookDriver?.Version === driver.Version ? [notebookDriver] : []),
    ];
    const compatibility = parseNvidiaCompatibility(compatibleDrivers);
    const sourceUrl = driver.DetailsURL || absoluteUrl(driver.DownloadURL || '', 'https://www.nvidia.com/en-us/geforce/drivers/');
    const initial = parseNvidiaReleaseNotes(driver.ReleaseNotes, driver.OtherNotes);
    let releasePdfText = '';
    if (initial.releaseNotesUrl) {
      try {
        releasePdfText = await fetchOfficialPdfText(initial.releaseNotesUrl, ['us.download.nvidia.com']);
      } catch (pdfErr) {
        logger.warn('[scraper] NVIDIA release-notes PDF parse failed', { error: pdfErr.message, url: initial.releaseNotesUrl });
      }
    }
    const parsed = parseNvidiaReleaseNotes(driver.ReleaseNotes, driver.OtherNotes, releasePdfText);
    const impactMeta = nvidiaImpactMetadata(driver, parsed);
    const releasedAt = toIsoDate(driver.ReleaseDateTime);

    return {
      platform:   'NVIDIA',
      name:       `NVIDIA Game Ready Driver ${driver.Version}`,
      version:    driver.Version,
      releasedAt,
      affects:    'NVIDIA GeForce desktop and notebook GPUs listed for this Game Ready package / DLSS / G-SYNC / NVIDIA App overlays',
      changelog:  parsed.changelog,
      knownIssues: parsed.knownIssues,
      knownIssuesAuthoritative: Boolean(releasePdfText),
      riskFactors: [{ level: 'low', text: 'NVIDIA recommends notebook owners check their manufacturer’s certified driver before replacing an OEM-tuned graphics package.' }],
      verdict: parsed.knownIssueCount
        ? 'Install if the listed game support or fixes apply; otherwise wait if your current driver is stable, especially on notebooks or systems using Prefer Maximum Performance.'
        : 'Install if the listed game support or fixes apply; otherwise wait if your current driver is stable.',
      reasoning: `NVIDIA’s official notes document ${parsed.gameSupportCount} supported game${parsed.gameSupportCount === 1 ? '' : 's'}, ${parsed.gameFixCount} gaming fix${parsed.gameFixCount === 1 ? '' : 'es'}, ${parsed.generalFixCount} general fix${parsed.generalFixCount === 1 ? '' : 'es'}, and ${parsed.knownIssueCount} open issue${parsed.knownIssueCount === 1 ? '' : 's'} for this WHQL release.`,
      evidence: [
        ...sourceEvidence('NVIDIA Driver Downloads', sourceUrl, `Game Ready Driver ${driver.Version}; ${parsed.gameSupportCount} supported games, ${parsed.gameFixCount} gaming fixes, ${parsed.generalFixCount} general fixes, and ${compatibility?.hardware?.length || 0} supported desktop/notebook GPU entries documented.`, { dateBasis: 'released', publishedAt: releasedAt, releaseType: 'official-release', ...impactMeta, compatibility: compatibility || undefined }),
        ...(parsed.releaseNotesUrl ? sourceEvidence('NVIDIA Release Notes', parsed.releaseNotesUrl, `Official WHQL release-notes PDF for driver ${driver.Version}; ${parsed.generalFixCount} general fixes and ${parsed.knownIssueCount} open issue${parsed.knownIssueCount === 1 ? '' : 's'} documented.`, { dateBasis: 'released', publishedAt: releasedAt, releaseType: 'official-release-notes', ...impactMeta }) : []),
      ],
      sourceUrl,
    };
  } catch (err) {
    logger.warn('[scraper] NVIDIA detection failed', { error: err.message });
    return null;
  }
}

/**
 * AMD — official Radeon product download page + Adrenalin release notes
 */
async function detectAmd() {
  const driverPageUrl = 'https://www.amd.com/en/support/downloads/drivers.html/graphics/radeon-rx/radeon-rx-9000-series/amd-radeon-rx-9070-xt.html';
  let discovered = null;
  try {
    discovered = parseAmdDriverPage(await fetchHtml(driverPageUrl), driverPageUrl);
  } catch (err) {
    logger.warn('[scraper] AMD latest-release discovery failed', { error: err.message });
  }

  const fallbackUrls = [
    'https://www.amd.com/en/resources/support-articles/release-notes/RN-RAD-WIN-26-7-1.html',
    'https://www.amd.com/en/resources/support-articles/release-notes/RN-RAD-WIN-26-6-4.html',
  ];
  const releaseUrls = [...new Set([discovered?.url, ...fallbackUrls].filter(Boolean))];

  for (const url of releaseUrls) {
    try {
      const parsed = parseAmdReleaseNotes(await fetchHtml(url), url, {
        whql: discovered?.url === url && discovered.whql,
        releaseChannel: discovered?.url === url ? discovered.releaseChannel : null,
      });
      if (!parsed) continue;
      const isDiscoveredRelease = discovered?.url === url && discovered?.version === parsed.version;
      const releaseLabel = parsed.whql
        ? `WHQL${parsed.releaseChannel ? ` ${parsed.releaseChannel[0].toUpperCase()}${parsed.releaseChannel.slice(1)}` : ''}`
        : null;
      const impactMeta = {
        gameSupportCount: parsed.gameSupportCount,
        gameFixCount: parsed.gameFixCount,
        knownIssueCount: parsed.knownIssueCount,
        productSupportCount: parsed.productSupportCount,
        whql: parsed.whql,
        releaseChannel: parsed.releaseChannel || undefined,
        packageSize: discovered?.version === parsed.version ? discovered.packageSize : undefined,
      };
      return {
        platform: 'AMD',
        name: parsed.title,
        version: parsed.version,
        releasedAt: parsed.releasedAt,
        affects: 'AMD Radeon RX 5000–9000 series / Radeon mobile GPUs / Adrenalin driver / Windows gaming and creator workloads',
        changelog: parsed.changelog,
        knownIssues: parsed.knownIssues,
        knownIssuesAuthoritative: true,
        riskFactors: [{
          level: 'low',
          text: 'AMD’s package is a reference driver for notebooks, is not intended for Apple Boot Camp, and excludes handheld gaming devices; use the OEM-qualified driver for those systems.',
        }],
        verdict: parsed.knownIssueCount
          ? 'Install if the new game, product, or listed fixes apply to your Radeon setup; otherwise wait if your current driver is stable and review the game-specific known issues first.'
          : 'Install if the new game, product, or listed fixes apply to your Radeon setup; otherwise stay on your current stable OEM-qualified driver.',
        reasoning: `AMD’s official ${releaseLabel ? `${releaseLabel} ` : ''}release documents ${parsed.gameSupportCount} supported game${parsed.gameSupportCount === 1 ? '' : 's'}, ${parsed.gameFixCount} fixed issue${parsed.gameFixCount === 1 ? '' : 's'}, ${parsed.productSupportCount} newly supported product${parsed.productSupportCount === 1 ? '' : 's'}, and ${parsed.knownIssueCount} known issue${parsed.knownIssueCount === 1 ? '' : 's'}.`,
        evidence: [
          ...(isDiscoveredRelease ? sourceEvidence('AMD Driver Downloads', driverPageUrl, `AMD’s Radeon RX driver page identifies Adrenalin Edition ${parsed.version} as the current ${releaseLabel ? `${releaseLabel} ` : ''}package.`, { dateBasis: 'checked', releaseType: 'official-download-index', ...impactMeta }) : []),
          ...sourceEvidence('AMD Release Notes', url, `${parsed.title}; ${parsed.gameFixCount} fixed and ${parsed.knownIssueCount} known issues documented.`, { dateBasis: 'released', publishedAt: parsed.releasedAt, releaseType: 'official-release-notes', ...impactMeta, compatibility: parsed.compatibility || undefined }),
        ],
        sourceUrl: url,
      };
    } catch (err) {
      logger.warn('[scraper] AMD release candidate failed', { error: err.message, url });
    }
  }
  return null;
}

/**
 * Apple iOS — Apple Security Updates page
 */
async function parseAppleSecurityRelease(kind) {
  const url = 'https://support.apple.com/en-us/100100';
  const html = await fetchHtml(url);
  const rows = parseAppleSecurityIndex(html);
  const match = rows.find(r => kind === 'ios'
    ? /iOS|iPadOS/i.test(r.product)
    : /macOS/i.test(r.product));
  if (!match) return null;
  const version = firstVersion(match.product) || match.product;
  const sourceUrl = match.link ? (match.link.startsWith('http') ? match.link : `https://support.apple.com${match.link}`) : url;
  const releasedAt = toIsoDate(match.date);
  const advisory = sourceUrl !== url ? parseAppleSecurityAdvisory(await fetchHtml(sourceUrl)) : null;
  const noPublishedCves = /no published CVE entries/i.test(match.note || '');
  if ((!advisory && !noPublishedCves) || (advisory && advisory.releasedAt !== releasedAt)) {
    throw new Error(`Apple ${kind} advisory did not match the security release index`);
  }
  const security = advisory?.securityCriticality || {
    level: 'none',
    label: 'Apple reports no published CVE entries for this release',
    cves: [],
    totalCves: 0,
    activelyExploited: false,
  };
  const entries = advisory?.entries || [];
  const cveSummary = security.totalCves
    ? `${security.totalCves} CVE${security.totalCves === 1 ? '' : 's'} across ${entries.length} documented security component${entries.length === 1 ? '' : 's'}`
    : noPublishedCves
      ? 'no published CVE entries'
      : `${entries.length} documented security component${entries.length === 1 ? '' : 's'}`;
  return {
    platform: kind === 'ios' ? 'Apple' : 'macOS',
    name: match.product.slice(0, 100),
    version,
    releasedAt,
    affects: kind === 'ios'
      ? 'iPhone / iPad / WebKit / system security / app compatibility'
      : 'Mac / macOS / Safari-WebKit / system security / device stability',
    changelog: advisory?.changelog || [
      `${match.product} is listed by Apple as released on ${match.date}.`,
      match.note,
    ].filter(Boolean),
    knownIssues: [],
    securityCriticality: security,
    riskFactors: [{ level: 'low', text: 'Security updates are usually recommended quickly, but older devices and managed fleets should verify app compatibility first.' }],
    verdict: security.activelyExploited
      ? 'Install promptly after confirming device compatibility; Apple identifies at least one issue in this release as exploited in the wild.'
      : noPublishedCves
        ? 'Install after confirming device compatibility; Apple lists this release without published CVE entries.'
        : `Install promptly after confirming device compatibility; Apple documents ${cveSummary} in this release.`,
    reasoning: advisory
      ? `PatchTicker matched Apple’s release index to the full security advisory and prioritized the highest-impact entries. The advisory documents ${cveSummary}; the update brief links each displayed risk back to Apple’s published CVE record.`
      : `PatchTicker verified this release and date in Apple’s security releases index. Apple states that the update has ${cveSummary}, so PatchTicker does not infer undocumented security fixes.`,
    evidence: sourceEvidence(
      advisory ? 'Apple Security Advisory' : 'Apple Security Releases',
      sourceUrl,
      `${match.product}: ${cveSummary}.`,
      {
        dateBasis: 'released',
        releaseType: advisory ? 'official-security-advisory' : 'official-security-index',
        publishedAt: advisory?.releasedAt || releasedAt,
        cveCount: security.totalCves,
      }
    ),
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
    // 593110 is Valve's official desktop Steam Client news app. SteamOS and
    // Steam Deck use a separate internal detector so neither lane can mask the
    // other merely by publishing a newer article.
    const items = parseRssItems(
      await fetchXml('https://store.steampowered.com/feeds/news/app/593110/?cc=US&l=english'),
      10,
    )
      .sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
    const update = items.find(i =>
      /(?:Steam Client Update|SteamOS\s+\d|Steam Deck.+Update)/i.test(i.title)
      && !/\b(?:beta|preview|experimental)\b/i.test(`${i.title} ${i.description || ''}`)
    );
    if (!update) return null;
    const sourceUrl = update.link || 'https://store.steampowered.com/news/';
    const releasedAt = toIsoDate(update.pubDate);
    const explicitVersion = firstVersion(`${update.title} ${update.description}`);
    const identity = steamClientReleaseIdentity(sourceUrl, update.pubDate);
    const version = explicitVersion || identity.version;
    const description = cleanText(update.description, 900);
    const notes = parseSteamReleaseNotes(update.descriptionHtml || update.description);
    const isPreview = /\b(?:beta|preview)\b/i.test(`${update.title} ${description}`);
    const isSteamOs = /\bSteamOS\b|Steam Deck/i.test(update.title);
    const riskFactors = [];
    if (isPreview) riskFactors.push({ level: 'medium', text: 'This release is on a Beta or Preview channel and is intended for users testing changes before stable rollout.' });
    if (notes.knownIssues.length) riskFactors.push({ level: 'medium', text: notes.knownIssues[0] });

    return {
      platform:   'Steam',
      name:       update.title.slice(0, 100),
      version,
      displayVersion: explicitVersion || identity.displayVersion,
      sourceKind: identity.sourceKind,
      sourceRef: identity.sourceRef,
      productId: identity.productId,
      releasedAt,
      affects: isSteamOs
        ? 'Steam Deck / SteamOS / handheld compatibility and system software'
        : 'Steam desktop client / login / library / downloads / local network transfers',
      changelog:  notes.changelog.length ? notes.changelog : [description].filter(Boolean),
      knownIssues: notes.knownIssues,
      riskFactors,
      verdict: isPreview
        ? 'Use the stable channel unless you need these fixes for testing; this build has an acknowledged performance regression.'
        : isSteamOs
          ? 'Install if the listed SteamOS or Steam Deck fixes apply to your setup; otherwise wait for the normal rollout.'
          : 'Allow the normal Steam client rollout if the listed login, library, download, or transfer fixes apply to your setup.',
      reasoning: isPreview
        ? 'This SteamOS build is explicitly marked Beta/Preview by Valve. PatchTicker separates its acknowledged issues from the full change list so stable-channel users can avoid treating a test build as a routine update.'
        : isSteamOs
          ? 'PatchTicker reads Valve’s official Steam Deck feed and separates SteamOS release changes from known issues before scoring the update.'
          : 'PatchTicker reads Valve’s official Steam Client feed and separates desktop client changes from known issues before scoring the update.',
      evidence: sourceEvidence('Steam News', sourceUrl, `${update.title}. ${description}`, { dateBasis: 'published', publishedAt: releasedAt, releaseType: 'official-release' }),
      sourceUrl,
    };
  } catch (err) {
    logger.warn('[scraper] Steam detection failed', { error: err.message });
    return null;
  }
}

/**
 * Steam Deck / SteamOS — latest stable Valve release from app 1675200.
 * This detector is scheduled as an internal lane but persists platform=Steam.
 */
async function detectSteamDeck() {
  try {
    const payload = await fetchJson(
      'https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=1675200&count=50&maxlength=12000&feeds=steam_community_announcements&format=json',
    );
    const releases = (payload?.appnews?.newsitems || [])
      .map(steamDeckReleaseFromPost)
      .filter(Boolean)
      .sort((a, b) => Date.parse(b.releasedAt) - Date.parse(a.releasedAt));
    return releases[0] || null;
  } catch (err) {
    logger.warn('[scraper] Steam Deck detection failed', { error: err.message });
    return null;
  }
}

/**
 * Switch — Nintendo Switch system update history
 */
async function detectSwitch() {
  const sourceUrl = 'https://en-americas-support.nintendo.com/app/answers/detail/a_id/22525';
  const securityIndexUrl = 'https://www.nintendo.com/security-advisories/en/index.html';
  try {
    const parsed = parseSwitchReleasePage(await fetchHtml(sourceUrl));
    if (!parsed) return null;
    let securityNotice = null;
    try {
      const candidate = parseNintendoSecurityNoticeIndex(await fetchHtml(securityIndexUrl), securityIndexUrl);
      const daysAfterRelease = candidate
        ? (Date.parse(candidate.date) - Date.parse(parsed.releasedAt)) / 86_400_000
        : Number.POSITIVE_INFINITY;
      if (daysAfterRelease >= 0 && daysAfterRelease <= 7) securityNotice = candidate;
    } catch (securityErr) {
      logger.warn('[scraper] Nintendo security notice parse failed', { error: securityErr.message });
    }
    const releaseNotes = parsed.changelog.length
      ? parsed.changelog
      : ['Nintendo published a system stability and feature update for supported Switch consoles.'];
    const changelog = unique([
      ...releaseNotes,
      ...(securityNotice ? [`Security: ${securityNotice.title}.`] : []),
    ], 520).slice(0, 8);
    const evidence = [
      ...sourceEvidence('Nintendo Support', sourceUrl, `${parsed.heading}. ${changelog[0]}`, { dateBasis: 'released', publishedAt: parsed.releasedAt, releaseType: 'official-release' }),
      ...(securityNotice ? sourceEvidence('Nintendo Security Advisory', securityNotice.url, securityNotice.title, {
        dateBasis: 'published',
        releaseType: 'official-security-advisory',
        publishedAt: securityNotice.date,
      }) : []),
    ];

    return {
      platform:   'Switch',
      name:       `Nintendo Switch System Update ${parsed.version}`,
      version:    parsed.version,
      releasedAt: parsed.releasedAt,
      affects:    'Nintendo Switch / Switch OLED / Switch Lite / system firmware / eShop / online services',
      changelog,
      securityCriticality: securityNotice ? {
        level: 'unclassified',
        label: 'Nintendo links this system version to a published security advisory; severity is not stated on the index',
        cves: [],
        totalCves: null,
        activelyExploited: false,
      } : null,
      evidence,
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

function parseChromeStableFeed(xml) {
  const $ = cheerio.load(String(xml || ''), { xmlMode: true });
  const releases = [];

  $('entry').each((_, element) => {
    const entry = $(element);
    const title = cleanText(entry.find('title').first().text(), 120);
    const categories = entry.find('category').map((__, category) =>
      cleanText($(category).attr('term'), 80).toLowerCase()
    ).get();

    // Google publishes Beta, Dev, Early Stable, Extended Stable, mobile, and
    // ChromeOS posts through this feed. PatchTicker intentionally admits only
    // the full desktop Stable channel so the lane never overstates rollout.
    if (title !== 'Stable Channel Update for Desktop'
      || !categories.includes('desktop update')
      || !categories.includes('stable updates')
      || categories.includes('early stable updates')
      || categories.includes('extended stable updates')) return;

    const rawUrl = entry.find('link[rel="alternate"]').attr('href');
    let sourceUrl;
    try {
      const parsedUrl = new URL(rawUrl);
      if (parsedUrl.hostname !== 'chromereleases.googleblog.com') return;
      parsedUrl.protocol = 'https:';
      sourceUrl = parsedUrl.toString();
    } catch {
      return;
    }

    const releasedAt = toIsoDate(entry.find('published').first().text());
    const articleHtml = entry.find('content').first().text();
    const articleText = cleanText(cheerio.load(articleHtml).text(), 40_000);
    const versionMatch = articleText.match(/updated to\s+(\d+\.\d+\.\d+)\.(\d+)(?:\/\.(\d+))?/i);
    if (!releasedAt || !versionMatch) return;

    const versionBase = versionMatch[1];
    const buildVariants = [versionMatch[2], versionMatch[3]].filter(Boolean).map(Number);
    const version = `${versionBase}.${Math.max(...buildVariants)}`;
    const displayVersion = versionMatch[3]
      ? `${versionBase}.${versionMatch[2]}/.${versionMatch[3]}`
      : `${versionBase}.${versionMatch[2]}`;
    const securityFixCount = Number(articleText.match(/includes\s+(\d+)\s+security fixes/i)?.[1] || 0);
    const vulnerabilities = [...articleText.matchAll(
      /\b(Critical|High|Medium|Low)\s+(CVE-\d{4}-\d+):\s*(.*?)(?=\.\s*Reported by)/gi
    )].map(match => ({
      severity: match[1].toLowerCase(),
      cve: match[2].toUpperCase(),
      summary: cleanText(match[3], 180),
    }));
    const severityCounts = vulnerabilities.reduce((counts, vulnerability) => {
      counts[vulnerability.severity] = (counts[vulnerability.severity] || 0) + 1;
      return counts;
    }, {});
    const securityLevel = severityCounts.critical
      ? 'critical'
      : severityCounts.high
        ? 'high'
        : severityCounts.medium
          ? 'medium'
          : severityCounts.low
            ? 'low'
            : 'none';
    const severitySummary = [
      severityCounts.critical ? `${severityCounts.critical} critical` : '',
      severityCounts.high ? `${severityCounts.high} high` : '',
      severityCounts.medium ? `${severityCounts.medium} medium` : '',
      severityCounts.low ? `${severityCounts.low} low` : '',
    ].filter(Boolean).join(', ');
    const rolloutText = articleText.match(/which will roll out over the coming days\/weeks/i)
      ? 'Google is rolling this Stable release out over the coming days and weeks, so availability can differ by device.'
      : null;

    releases.push({
      platform: 'Chrome',
      name: `Google Chrome Stable ${displayVersion}`,
      version,
      releasedAt,
      affects: 'Google Chrome Stable / Windows / macOS / Linux / browser security / extensions and web compatibility',
      changelog: unique([
        `Chrome Stable ${displayVersion} was published for Windows and macOS; Linux received ${versionBase}.${versionMatch[2]}.`,
        securityFixCount ? `Google documents ${securityFixCount} security fixes in this desktop Stable release.` : '',
        ...vulnerabilities.slice(0, 6).map(item => `${item.severity[0].toUpperCase()}${item.severity.slice(1)} ${item.cve}: ${item.summary}.`),
      ], 360),
      knownIssues: [],
      knownIssuesAuthoritative: false,
      riskFactors: rolloutText ? [{ level: 'low', text: rolloutText }] : [],
      securityCriticality: {
        level: securityLevel,
        label: securityFixCount
          ? `${securityFixCount} security fixes${severitySummary ? ` (${severitySummary})` : ''}`
          : 'Google published this Stable release without a security-fix count in the checked post',
        cves: unique(vulnerabilities.map(item => item.cve), 32),
        totalCves: securityFixCount || vulnerabilities.length,
        activelyExploited: /exploited in the wild/i.test(articleText),
      },
      verdict: securityLevel === 'critical' || securityLevel === 'high'
        ? 'Install promptly and restart Chrome to apply the documented security fixes.'
        : 'Install through Chrome’s normal Stable rollout, then restart the browser to finish applying the update.',
      reasoning: securityFixCount
        ? `Google’s official Stable-channel post documents ${securityFixCount} security fixes${severitySummary ? `, including ${severitySummary} severity findings` : ''}. PatchTicker excludes Beta, Dev, Early Stable, Extended Stable, ChromeOS, and mobile posts from this lane.`
        : 'PatchTicker verified this as Google’s full desktop Stable-channel release and excluded preview, extended, mobile, and ChromeOS channels.',
      evidence: sourceEvidence('Google Chrome Releases', sourceUrl, `Desktop Stable ${displayVersion}; ${securityFixCount || vulnerabilities.length} documented security fixes.`, {
        dateBasis: 'published',
        releaseType: securityFixCount || vulnerabilities.length ? 'official-security-release' : 'official-release',
        publishedAt: releasedAt,
        releaseChannel: 'stable',
        securityFixCount,
        severityCounts,
      }),
      sourceUrl,
    });
  });

  return releases.sort((a, b) => Date.parse(b.releasedAt) - Date.parse(a.releasedAt))[0] || null;
}

/**
 * Google Chrome — full Stable desktop channel only.
 */
async function detectChrome() {
  const feedUrl = 'https://chromereleases.googleblog.com/feeds/posts/default?alt=rss';
  try {
    return parseChromeStableFeed(await fetchXml(feedUrl));
  } catch (err) {
    logger.warn('[scraper] Chrome detection failed', { error: err.message });
    return null;
  }
}

function firefoxAdvisoryUrl(releaseHtml, releaseUrl) {
  const $ = cheerio.load(String(releaseHtml || ''));
  const href = $('a[href*="/security/advisories/mfsa"]').first().attr('href');
  if (!href) return null;
  try {
    const parsed = new URL(href, releaseUrl);
    if (parsed.protocol !== 'https:'
      || parsed.hostname !== 'www.mozilla.org'
      || !/^\/(?:[a-z]{2}-[A-Z]{2}\/)?security\/advisories\/mfsa\d{4}-\d+\/$/.test(parsed.pathname)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function parseFirefoxStableRelease(versionMetadata, releaseHtml, advisoryHtml, urls = {}) {
  const expectedVersion = cleanText(versionMetadata?.LATEST_FIREFOX_VERSION, 40);
  const expectedDate = toIsoDate(versionMetadata?.LAST_RELEASE_DATE);
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(expectedVersion) || !expectedDate) return null;

  const releaseUrl = String(urls.releaseUrl || '');
  const versionsUrl = String(urls.versionsUrl || 'https://product-details.mozilla.org/1.0/firefox_versions.json');
  let parsedReleaseUrl;
  try {
    parsedReleaseUrl = new URL(releaseUrl);
  } catch {
    return null;
  }
  if (parsedReleaseUrl.protocol !== 'https:'
    || !['www.firefox.com', 'firefox.com'].includes(parsedReleaseUrl.hostname)
    || !parsedReleaseUrl.pathname.endsWith(`/firefox/${expectedVersion}/releasenotes/`)) return null;

  const release$ = cheerio.load(String(releaseHtml || ''));
  const actualVersion = cleanText(release$('.c-release-version').first().text(), 40);
  const actualDate = toIsoDate(release$('.c-release-date').first().text());
  const releaseChannelText = cleanText(release$('.c-release-first-title').first().text(), 220);
  if (actualVersion !== expectedVersion
    || actualDate !== expectedDate
    || !new RegExp(`Version\\s+${expectedVersion.replace(/\./g, '\\.')}.*Release channel`, 'i').test(releaseChannelText)) return null;

  const advisoryUrl = String(urls.advisoryUrl || firefoxAdvisoryUrl(releaseHtml, releaseUrl) || '');
  let parsedAdvisoryUrl;
  try {
    parsedAdvisoryUrl = new URL(advisoryUrl);
  } catch {
    return null;
  }
  if (parsedAdvisoryUrl.protocol !== 'https:'
    || parsedAdvisoryUrl.hostname !== 'www.mozilla.org'
    || !/^\/(?:[a-z]{2}-[A-Z]{2}\/)?security\/advisories\/mfsa\d{4}-\d+\/$/.test(parsedAdvisoryUrl.pathname)) return null;

  const advisory$ = cheerio.load(String(advisoryHtml || ''));
  const advisoryHeading = cleanText(advisory$('.advisory h2').first().text(), 160);
  const advisorySummary = advisory$('.advisory > dl.summary').first();
  const advisoryDate = toIsoDate(advisorySummary.find('dt').filter((_, el) => cleanText(advisory$(el).text(), 40) === 'Announced').next('dd').text());
  const fixedIn = cleanText(advisorySummary.find('dt').filter((_, el) => cleanText(advisory$(el).text(), 40) === 'Fixed in').next('dd').text(), 120);
  const products = cleanText(advisorySummary.find('dt').filter((_, el) => cleanText(advisory$(el).text(), 40) === 'Products').next('dd').text(), 120);
  const majorVersion = expectedVersion.split('.')[0];
  if (!new RegExp(`Security Vulnerabilities fixed in Firefox\\s+${majorVersion}\\b`, 'i').test(advisoryHeading)
    || advisoryDate !== expectedDate
    || !new RegExp(`Firefox\\s+${majorVersion}\\b`, 'i').test(fixedIn)
    || !/^Firefox$/i.test(products)) return null;

  const severityMap = { critical: 'critical', high: 'high', moderate: 'medium', medium: 'medium', low: 'low' };
  const vulnerabilities = [];
  advisory$('section.cve').each((_, element) => {
    const section = advisory$(element);
    const heading = cleanText(section.find('h4').first().text().replace(/^#/, ''), 260);
    const match = heading.match(/\b(CVE-\d{4}-\d+)\s*:\s*(.+)$/i);
    const rawSeverity = cleanText(section.find('span.level').first().text(), 40).toLowerCase();
    const severity = severityMap[rawSeverity];
    if (!match || !severity) return;
    vulnerabilities.push({
      cve: match[1].toUpperCase(),
      summary: cleanText(match[2], 190),
      severity,
    });
  });
  if (!vulnerabilities.length) return null;

  const severityCounts = vulnerabilities.reduce((counts, vulnerability) => {
    counts[vulnerability.severity] = (counts[vulnerability.severity] || 0) + 1;
    return counts;
  }, {});
  const securityLevel = severityCounts.critical
    ? 'critical'
    : severityCounts.high
      ? 'high'
      : severityCounts.medium
        ? 'medium'
        : 'low';
  const severitySummary = [
    severityCounts.critical ? `${severityCounts.critical} critical` : '',
    severityCounts.high ? `${severityCounts.high} high` : '',
    severityCounts.medium ? `${severityCounts.medium} medium` : '',
    severityCounts.low ? `${severityCounts.low} low` : '',
  ].filter(Boolean).join(', ');

  const releaseNotes = [];
  for (const [sectionId, label, limit] of [['new', 'New', 3], ['fixed', 'Fixed', 5], ['changed', 'Changed', 3]]) {
    release$(`#${sectionId} li.release-note .release-note-content`).slice(0, limit).each((_, element) => {
      const text = cleanText(release$(element).text(), 320);
      if (text && !/^Various security fixes\.?$/i.test(text)) releaseNotes.push(`${label}: ${text}`);
    });
  }
  const activelyExploited = /(?:known to be|actively|currently) exploited(?: in the wild)?|active exploitation/i.test(cleanText(advisory$('.advisory').text(), 100_000));

  return {
    platform: 'Firefox',
    name: `Mozilla Firefox ${expectedVersion}`,
    version: expectedVersion,
    releasedAt: expectedDate,
    affects: 'Mozilla Firefox Release channel / Windows / macOS / Linux / browser security / extensions and web compatibility',
    changelog: unique([
      `Firefox ${expectedVersion} was first offered to Release channel users on ${expectedDate}.`,
      `Mozilla documents ${vulnerabilities.length} CVEs in the matching security advisory (${severitySummary}).`,
      ...releaseNotes,
    ], 360).slice(0, 12),
    knownIssues: [],
    knownIssuesAuthoritative: false,
    riskFactors: [{
      level: securityLevel === 'critical' || securityLevel === 'high' ? 'high' : 'medium',
      text: `${vulnerabilities.length} documented security vulnerabilities are fixed in this release; the highest Mozilla impact rating is ${securityLevel}.`,
    }],
    securityCriticality: {
      level: securityLevel,
      label: `${vulnerabilities.length} Mozilla security advisories (${severitySummary})`,
      cves: unique(vulnerabilities.map(item => item.cve), 32),
      totalCves: vulnerabilities.length,
      activelyExploited,
    },
    verdict: securityLevel === 'critical' || securityLevel === 'high'
      ? 'Install promptly and restart Firefox to apply Mozilla’s documented security fixes.'
      : 'Install through Firefox’s normal Release channel, then restart the browser to finish applying the update.',
    reasoning: `Mozilla’s current-version endpoint, Release-channel notes, and security advisory agree on Firefox ${expectedVersion} dated ${expectedDate}. The advisory documents ${vulnerabilities.length} CVEs (${severitySummary}); Beta, Nightly, ESR, Android, and iOS release lanes are not admitted by this detector.`,
    evidence: [
      ...sourceEvidence('Mozilla Firefox Version Service', versionsUrl, `Current Firefox Release version ${expectedVersion}; release date ${expectedDate}.`, { dateBasis: 'released', releaseType: 'official-version', publishedAt: expectedDate, releaseChannel: 'stable' }),
      ...sourceEvidence('Firefox Release Notes', releaseUrl, `Firefox ${expectedVersion} Release channel notes dated ${expectedDate}; ${releaseNotes.length} bounded feature and fix notes parsed.`, { dateBasis: 'released', releaseType: 'official-release-notes', publishedAt: expectedDate, releaseChannel: 'stable' }),
      ...sourceEvidence('Mozilla Security Advisory', advisoryUrl, `Firefox ${majorVersion} advisory documents ${vulnerabilities.length} CVEs (${severitySummary}).`, { dateBasis: 'announced', releaseType: 'official-security-advisory', publishedAt: expectedDate, severityCounts, securityFixCount: vulnerabilities.length }),
    ],
    sourceUrl: releaseUrl,
  };
}

/**
 * Mozilla Firefox — current desktop Release channel only.
 * The version service, exact release-notes page, and exact security advisory
 * must agree before PatchTicker accepts a release.
 */
async function detectFirefox() {
  const versionsUrl = 'https://product-details.mozilla.org/1.0/firefox_versions.json';
  try {
    const versions = await fetchJson(versionsUrl);
    const version = cleanText(versions?.LATEST_FIREFOX_VERSION, 40);
    if (!/^\d+\.\d+(?:\.\d+)?$/.test(version)) return null;
    const releaseUrl = `https://www.firefox.com/en-US/firefox/${version}/releasenotes/`;
    const releaseHtml = await fetchHtml(releaseUrl);
    const advisoryUrl = firefoxAdvisoryUrl(releaseHtml, releaseUrl);
    if (!advisoryUrl) return null;
    const advisoryHtml = await fetchHtml(advisoryUrl);
    return parseFirefoxStableRelease(versions, releaseHtml, advisoryHtml, { versionsUrl, releaseUrl, advisoryUrl });
  } catch (err) {
    logger.warn('[scraper] Firefox detection failed', { error: err.message });
    return null;
  }
}

function trustedMicrosoftLearnUrl(value, expectedPath) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.hostname === 'learn.microsoft.com'
      && parsed.pathname.toLowerCase() === expectedPath.toLowerCase();
  } catch {
    return false;
  }
}

function parseEdgeStableRelease(stableHtml, securityHtml, urls = {}) {
  const stableUrl = String(urls.stableUrl || 'https://learn.microsoft.com/en-us/deployedge/microsoft-edge-relnote-stable-channel');
  const securityUrl = String(urls.securityUrl || 'https://learn.microsoft.com/en-us/deployedge/microsoft-edge-relnotes-security');
  if (!trustedMicrosoftLearnUrl(stableUrl, '/en-us/deployedge/microsoft-edge-relnote-stable-channel')
    || !trustedMicrosoftLearnUrl(securityUrl, '/en-us/deployedge/microsoft-edge-relnotes-security')) {
    return null;
  }

  const stable$ = cheerio.load(String(stableHtml || ''));
  let releaseHeading = null;
  let version = null;
  let releasedAt = null;
  stable$('.content h2').each((_, element) => {
    if (releaseHeading) {
      return;
    }
    const text = cleanText(stable$(element).text(), 220);
    const match = text.match(/^Version\s+(\d+\.\d+\.\d+\.\d+):\s+(.+?)\s+\(Stable\)(?:\s+-.*)?$/i);
    const date = match ? toIsoDate(match[2]) : null;
    if (!match || !date || /extended stable/i.test(text)) {
      return;
    }
    releaseHeading = stable$(element);
    version = match[1];
    releasedAt = date;
  });
  if (!releaseHeading || !version || !releasedAt) {
    return null;
  }

  const releaseNodes = releaseHeading.nextUntil('h2');
  const summaryRows = [];
  const summaryHeading = releaseNodes.filter('h3').filter((_, element) => /release summary/i.test(cleanText(stable$(element).text(), 80))).first();
  summaryHeading.next('table').find('tbody tr').each((_, row) => {
    const cells = stable$(row).find('td');
    const category = cleanText(cells.eq(0).text(), 80);
    const description = cleanText(cells.eq(1).text(), 300);
    if (category && description && !/^(?:security|announcements|feature updates)$/i.test(category)) {
      summaryRows.push(`${category}: ${description}`);
    }
  });

  function edgeSectionBullets(label, limit) {
    const heading = releaseNodes.filter('h3').filter((_, element) => cleanText(stable$(element).text(), 80).toLowerCase() === label.toLowerCase()).first();
    if (!heading.length) {
      return [];
    }
    return unique(heading.nextUntil('h2,h3').find('li').map((_, item) => boundedText(stable$(item).text(), 320)).get(), 320).slice(0, limit);
  }

  const announcements = edgeSectionBullets('Announcement', 2);
  const featureUpdates = edgeSectionBullets('Feature updates', 5);
  if (!summaryRows.length && !announcements.length && !featureUpdates.length) {
    return null;
  }

  const security$ = cheerio.load(String(securityHtml || ''));
  let matchingSecuritySection = null;
  let matchingSecurityText = '';
  const pendingNotices = [];
  security$('.content h2').each((_, element) => {
    const heading = security$(element);
    const noticeDate = toIsoDate(cleanText(heading.text(), 100));
    if (!noticeDate) {
      return;
    }
    const nodes = heading.nextUntil('h2');
    const sectionText = cleanText(nodes.text(), 6000);
    const escapedVersion = version.replace(/\./g, '\\.');
    const exactStable = new RegExp(`Microsoft Edge (?:for )?Stable(?: Channel)? \\(Version ${escapedVersion}\\)`, 'i').test(sectionText)
      && !new RegExp(`(?:Android|iOS)[^.]*(?:Version ${escapedVersion})`, 'i').test(sectionText);
    if (noticeDate === releasedAt && exactStable) {
      matchingSecuritySection = nodes;
      matchingSecurityText = sectionText;
    }
    if (Date.parse(noticeDate) > Date.parse(releasedAt)
      && /recent Chromium security fixes/i.test(sectionText)
      && /actively working on releasing a security fix/i.test(sectionText)) {
      pendingNotices.push({ date: noticeDate, text: sectionText });
    }
  });
  if (!matchingSecuritySection) {
    return null;
  }

  const cves = unique(matchingSecuritySection.find('a').map((_, link) => {
    const match = cleanText(security$(link).text(), 80).match(/CVE-\d{4}-\d+/i);
    return match?.[0]?.toUpperCase() || '';
  }).get(), 32);
  const activelyExploited = /exploit(?:ed)? in the wild/i.test(matchingSecurityText);
  const cveListPending = /CVE'?s will be added as soon as available/i.test(matchingSecurityText);
  const pendingNotice = pendingNotices.sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0] || null;
  const pendingText = pendingNotice
    ? `On ${pendingNotice.date}, Microsoft said it was aware of newer Chromium security fixes and was still preparing an Edge security update.`
    : '';
  const securityLevel = activelyExploited ? 'high' : 'medium';

  return {
    platform: 'Edge',
    name: `Microsoft Edge Stable ${version}`,
    version,
    releasedAt,
    affects: 'Microsoft Edge Stable / Windows / macOS / Linux / browser security / enterprise policy / WebView2 compatibility',
    changelog: unique([
      `Microsoft Edge ${version} was released to the Stable channel on ${releasedAt}.`,
      ...summaryRows,
      ...announcements.map(note => `Announcement: ${note}`),
      ...featureUpdates.map(note => `Feature update: ${note}`),
    ], 360).slice(0, 12),
    knownIssues: pendingText ? [pendingText] : [],
    knownIssuesAuthoritative: false,
    riskFactors: [
      ...(pendingText ? [{ level: 'medium', text: pendingText }] : []),
      ...(cveListPending ? [{ level: 'low', text: 'Microsoft says the CVE list for this Stable release will be added when available.' }] : []),
    ],
    securityCriticality: {
      level: securityLevel,
      label: pendingText
        ? 'Newer Chromium security fix pending from Microsoft'
        : cves.length
          ? `${cves.length} documented Edge security fix${cves.length === 1 ? '' : 'es'}`
          : 'Chromium security updates included; CVE list pending',
      cves,
      totalCves: cves.length,
      activelyExploited,
      pendingVendorFix: Boolean(pendingText),
    },
    verdict: pendingText
      ? `Install Edge ${version} if you are behind, then keep automatic updates enabled—Microsoft says a newer Chromium security fix is still pending.`
      : activelyExploited
        ? 'Install promptly and restart Edge; Microsoft identifies an in-the-wild exploit fixed by this Stable release.'
        : 'Install through Edge’s Stable channel and restart the browser to finish applying the update.',
    reasoning: pendingText
      ? `Microsoft’s Stable notes and security notes agree on Edge ${version} dated ${releasedAt}. The release includes documented feature and policy changes, but Microsoft posted a newer ${pendingNotice.date} notice saying another Chromium security fix was still being prepared; PatchTicker therefore keeps that caveat visible instead of treating this build as fully current.`
      : `Microsoft’s Stable notes and security notes agree on Edge ${version} dated ${releasedAt}. Extended Stable, Beta, Dev, Canary, Android, and iOS entries are excluded from this lane.`,
    evidence: [
      ...sourceEvidence('Microsoft Edge Stable Release Notes', stableUrl, `Edge Stable ${version}, released ${releasedAt}; ${featureUpdates.length} feature updates and ${announcements.length} announcements parsed.`, { dateBasis: 'released', releaseType: 'official-release-notes', publishedAt: releasedAt, releaseChannel: 'stable' }),
      ...sourceEvidence('Microsoft Edge Security Release Notes', securityUrl, `Edge Stable ${version} incorporates Chromium security updates.${pendingText ? ` Microsoft posted a newer pending-fix notice on ${pendingNotice.date}.` : ''}`, { dateBasis: 'released', releaseType: 'official-security-release', publishedAt: releasedAt, releaseChannel: 'stable', securityFixCount: cves.length, cveListPending, pendingVendorFix: Boolean(pendingText), pendingNoticeAt: pendingNotice?.date || null }),
    ],
    sourceUrl: stableUrl,
  };
}

/** Microsoft Edge — full desktop Stable channel only. */
async function detectEdge() {
  const stableUrl = 'https://learn.microsoft.com/en-us/deployedge/microsoft-edge-relnote-stable-channel';
  const securityUrl = 'https://learn.microsoft.com/en-us/deployedge/microsoft-edge-relnotes-security';
  try {
    const [stableHtml, securityHtml] = await Promise.all([fetchHtml(stableUrl), fetchHtml(securityUrl)]);
    return parseEdgeStableRelease(stableHtml, securityHtml, { stableUrl, securityUrl });
  } catch (err) {
    logger.warn('[scraper] Edge detection failed', { error: err.message });
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
    const releaseNotesUrl = 'https://www.playstation.com/en-us/support/hardware/ps5/system-software-info/';
    const [html, releaseNotesHtml] = await Promise.all([
      fetchHtml(url),
      fetchHtml(releaseNotesUrl).catch(error => {
        logger.warn('[scraper] PS5 release-notes page unavailable; retaining artifact-only verification', { error: error.message });
        return '';
      }),
    ]);
    const parsed = parsePs5SupportPage(html);
    if (!parsed) return null;
    const release = parsePs5SystemSoftwareInfo(releaseNotesHtml);
    const artifact = await fetchOfficialArtifactMetadata(parsed.artifactUrl, ['pc.ps5.update.playstation.net']);
    const releasedAt = toIsoDate(artifact.headers['last-modified']);
    if (!releasedAt) return null;
    const artifactId = parsed.artifactHash.slice(0, 8);
    const version = `PUP-${releasedAt.replace(/-/g, '.')}-${artifactId}`;
    const hasOfficialNotes = Boolean(release?.version && release.changelog.length);
    const displayVersion = release?.version || null;
    const name = displayVersion
      ? `PS5 System Software ${displayVersion}`
      : `PS5 System Software — ${releasedAt}`;
    const changelog = hasOfficialNotes ? release.changelog : [
      `Sony’s current official PS5 system software artifact was published ${releasedAt}.`,
      `Artifact fingerprint ${artifactId}; package build path ${parsed.artifactBuildDate}.`,
      'Sony’s detailed release-notes page was temporarily unavailable, so PatchTicker retained the verified package identity without inferring undocumented changes.',
    ];
    const evidence = [
      ...sourceEvidence('PlayStation System Software Package', url, `Official PS5 package ${artifactId} published ${releasedAt}; package build path ${parsed.artifactBuildDate}.`, {
        dateBasis: 'artifact-published',
        releaseType: 'official-artifact',
        publishedAt: releasedAt,
        artifactHash: parsed.artifactHash,
        sizeBytes: artifact.sizeBytes || undefined,
      }),
      ...(hasOfficialNotes ? sourceEvidence(
        'PlayStation System Software Update Features',
        releaseNotesUrl,
        `Sony’s current release-notes page identifies PS5 system software ${displayVersion} and lists ${release.changelog.length} top-level changes.`,
        {
          releaseType: 'official-release-notes',
          officialVersion: displayVersion,
          pairedWithArtifact: artifactId,
        }
      ) : []),
    ];
    return {
      platform: 'PS5',
      name,
      version,
      displayVersion,
      sourceKind: hasOfficialNotes ? 'official-release-notes' : 'official-artifact',
      sourceRef: `ps5-system:${parsed.artifactHash}`,
      releasedAt,
      affects: hasOfficialNotes && changelog.some(note => /PS5 Pro|PSSR/i.test(note))
        ? 'All PlayStation 5 consoles / system software / online services; PSSR image-quality changes apply only to PS5 Pro'
        : 'PlayStation 5 / system software / online services / controller and game compatibility',
      changelog,
      knownIssues: [],
      riskFactors: hasOfficialNotes ? [] : [{
        level: 'low',
        text: 'Sony’s detailed notes could not be read during this check, so feature and issue coverage is limited to the verified system package metadata.',
      }],
      verdict: 'Install for online play and system security unless early user reports flag a PS5-specific regression.',
      reasoning: hasOfficialNotes
        ? `Sony identifies the current public build as ${displayVersion}. PatchTicker pairs those official release notes with Sony’s current signed package fingerprint and publication timestamp, rather than treating the support page’s unrelated CMS revision as firmware.`
        : 'PS5 system software updates can affect online play, firmware behavior, controller support, and system stability. PatchTicker validates Sony’s official system package URL and Last-Modified timestamp and does not invent release-note details when Sony’s notes page cannot be read.',
      evidence,
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
    const packageSize = parseIntelPackageSize(html);
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
    const releaseNotesUrl = $('a[href]').filter((_, link) => /release notes/i.test($(link).text()) && /\.pdf(?:$|\?)/i.test($(link).attr('href') || '')).first().attr('href');
    const officialReleaseNotesUrl = releaseNotesUrl ? absoluteUrl(releaseNotesUrl, url) : null;
    let releasePdfText = '';
    if (officialReleaseNotesUrl) {
      try {
        releasePdfText = await fetchOfficialPdfText(officialReleaseNotesUrl, ['downloadmirror.intel.com']);
      } catch (pdfErr) {
        logger.warn('[scraper] Intel release-notes PDF parse failed', { error: pdfErr.message, url: officialReleaseNotesUrl });
      }
    }
    const parsed = parseIntelReleaseNotes(releasePdfText);
    const sourceDates = reconcileIntelReleaseDates(date, parsed.releasedAt);
    const compatibility = mergeCompatibilityProfiles(parseIntelDownloadCompatibility($), parsed.compatibility);
    const pageHighlights = sectionBullets($, ['Highlights'], 5).map(item => cleanDriverText(item));
    const changelog = parsed.changelog.length
      ? parsed.changelog
      : unique([...pageHighlights.map(item => `Game support — ${item}`), cleanText(intro, 260)], 520);
    const parsedVersion = parsed.version || version;
    const isWhql = releasePdfText ? parsed.whql : !/Non-WHQL/i.test(body);
    const impactMeta = {
      gameSupportCount: parsed.gameSupportCount || pageHighlights.length,
      gameFixCount: parsed.gameFixCount,
      knownIssueCount: parsed.knownIssueCount,
      whql: isWhql,
      packageSize: packageSize || undefined,
    };
    return {
      platform: 'Intel',
      name: `Intel Arc Graphics Driver ${parsedVersion}${isWhql ? ' WHQL' : ' Non-WHQL'}`.slice(0, 120),
      version: parsedVersion,
      releasedAt: sourceDates.releasedAt,
      affects: 'Intel Arc GPUs / Core Ultra Arc graphics / Windows graphics driver / game compatibility',
      changelog,
      knownIssues: parsed.knownIssues,
      knownIssuesAuthoritative: Boolean(releasePdfText),
      riskFactors: [
        ...(!isWhql ? [{ level: 'medium', text: 'This is a Non-WHQL driver; it has not completed Microsoft’s WHQL certification path.' }] : []),
        { level: 'low', text: 'Intel warns that its generic package overwrites OEM-customized graphics drivers; laptops and prebuilt systems should check the manufacturer’s validated build first.' },
      ],
      verdict: !isWhql
        ? 'Install only if the Game On support or listed fixes apply; otherwise wait for a WHQL or OEM-qualified build.'
        : 'Install if the listed game support or fixes apply; otherwise stay on your current stable OEM-qualified driver.',
      reasoning: releasePdfText
        ? `Intel’s official release notes document ${impactMeta.gameSupportCount} Game On title${impactMeta.gameSupportCount === 1 ? '' : 's'}, ${impactMeta.gameFixCount} distinct fixed issue${impactMeta.gameFixCount === 1 ? '' : 's'}, and ${impactMeta.knownIssueCount} distinct known issue${impactMeta.knownIssueCount === 1 ? '' : 's'} across supported Arc and Core Ultra families.`
        : 'Intel’s download page confirms the current package and Game On support, but the detailed release-notes PDF could not be parsed during this check.',
      evidence: [
        ...sourceEvidence('Intel Download Center', url, `${title} version ${parsedVersion}; official download metadata and OEM overwrite guidance.${sourceDates.catalogDate ? ` Catalog metadata dated ${sourceDates.catalogDate}.` : ''}`, {
          dateBasis: releasePdfText ? 'catalog-updated' : 'released',
          publishedAt: sourceDates.catalogDate || undefined,
          releaseType: 'official-release',
          ...impactMeta,
        }),
        ...(officialReleaseNotesUrl ? sourceEvidence('Intel Release Notes', officialReleaseNotesUrl, `Official ${isWhql ? 'WHQL' : 'Non-WHQL'} release-notes PDF for driver ${parsedVersion}; ${impactMeta.gameFixCount} fixed and ${impactMeta.knownIssueCount} known issues documented.${sourceDates.releaseNotesDate ? ` Document dated ${sourceDates.releaseNotesDate}.` : ''}`, {
          dateBasis: 'released',
          publishedAt: sourceDates.releaseNotesDate || undefined,
          releaseType: 'official-release-notes',
          ...impactMeta,
          compatibility: compatibility || undefined,
          provenanceNote: sourceDates.hasDiscrepancy
            ? `Intel's catalog metadata is dated ${sourceDates.catalogDate}, while this release-notes document is dated ${sourceDates.releaseNotesDate}. PatchTicker uses the document's explicit release date.`
            : undefined,
        }) : []),
      ],
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
  SteamDeck: detectSteamDeck,
  Xbox:    detectXbox,
  PS5:     detectPs5,
  Intel:   detectIntel,
  Switch:  detectSwitch,
  Discord: detectDiscord,
  BattleNet: detectBattleNet,
  GOG:      detectGog,
  Chrome:   detectChrome,
  Firefox:  detectFirefox,
  Edge:     detectEdge,
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
  __test: { parseSwitchReleasePage, parseNintendoSecurityNoticeIndex, parsePs5SupportPage, parsePs5SystemSoftwareInfo, artifactSizeBytes, parseGogRemoteConfig, parseBattleNetVersionManifest, parseBattleNetBuildConfig, parseDiscordPatchIndex, parseDiscordPatchPage, parseChromeStableFeed, parseFirefoxStableRelease, firefoxAdvisoryUrl, parseEdgeStableRelease, parseAppleSecurityIndex, parseAppleSecurityAdvisory, parseSteamReleaseNotes, parsePlainSteamReleaseNotes, steamClientReleaseIdentity, steamDeckReleaseFromPost, parseXboxContentApi, parseAmdDriverPage, parseAmdReleaseNotes, parseAmdCompatibility, parseNvidiaReleaseNotes, parseNvidiaPdfReleaseDetails, nvidiaImpactMetadata, parseNvidiaCompatibility, parseIntelPackageSize, parseIntelReleaseNotes, reconcileIntelReleaseDates, parseIntelCompatibility, parseIntelDownloadCompatibility, mergeCompatibilityProfiles, microsoftSecurityCriticality, normalizeWindowsDetailNotes, parseWindowsKnownIssues, safeDecode, validateDetectedUpdate },
};

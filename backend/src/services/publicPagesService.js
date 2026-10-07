'use strict';

const { getPlatform } = require('../config/platformRegistry');

const SITE = 'https://patchticker.app';
const VERSION_ONLY = new Set(['official-version', 'official-artifact']);
const DETAILED_SINGLE_NOTE_SOURCES = new Set(['official-release', 'official-release-notes', 'official-security-advisory']);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function safeUrl(value) {
  try { const url = new URL(String(value || '')); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}
function isoDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}
const notes = update => (Array.isArray(update?.changelog) ? update.changelog : []).filter(item => typeof item === 'string' && item.trim()).slice(0, 30);
const releasePath = update => '/releases/' + encodeURIComponent(update.id);
const platformPath = platform => '/platforms/' + encodeURIComponent(platform);
const platformLabel = key => getPlatform(key)?.label || key;
function hasSubstantiveSingleNote(update, entries) {
  if (entries.length !== 1 || !DETAILED_SINGLE_NOTE_SOURCES.has(update.sourceKind)) return false;
  if (update.dateBasis === 'catalog-updated' || (Array.isArray(update.evidence) && update.evidence.some(item => item?.detailsUnavailable === true))) return false;
  const note = entries[0].trim();
  if (note.length < 80) return false;
  return (/\b(?:fixed|resolved|addressed)\b/i.test(note) && /\b(?:issue|bug|crash|error|regression|vulnerabilit\w*|security flaw)\b/i.test(note))
    || /\bCVE-\d{4}-\d{4,}\b/i.test(note);
}
function isIndexable(update) {
  if (!update || VERSION_ONLY.has(update.sourceKind) || !safeUrl(update.sourceUrl) || !isoDate(update.releasedAt)) return false;
  const entries = notes(update);
  return entries.length >= 2 || hasSubstantiveSingleNote(update, entries);
}
const section = (title, content) => '<section class="discovery-section"><h2>' + esc(title) + '</h2>' + content + '</section>';
const list = (items, empty) => items.length ? '<ul class="discovery-notes">' + items.map(item => '<li>' + esc(item) + '</li>').join('') + '</ul>' : '<p>' + esc(empty) + '</p>';
function shell({ title, description, path, body, noindex = false, type = 'website', rssPath = '/releases.xml' }) {
  const fullTitle = esc(title) + ' | PatchTicker';
  const url = esc(SITE + path);
  const desc = esc(description);
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + fullTitle + '</title><meta name="description" content="' + desc + '">' +
    '<link rel="icon" type="image/png" sizes="48x48" href="/patchticker-mark-48.png">' +
    '<link rel="apple-touch-icon" sizes="180x180" href="/patchticker-mark-180.png">' +
    '<meta name="robots" content="' + (noindex ? 'noindex,follow' : 'index,follow') + '">' +
    '<link rel="canonical" href="' + url + '"><meta property="og:type" content="' + esc(type) + '">' +
    '<meta property="og:title" content="' + fullTitle + '"><meta property="og:description" content="' + desc + '">' +
    '<meta property="og:url" content="' + url + '"><meta property="og:image" content="' + SITE + '/og-image.png">' +
    '<meta name="twitter:card" content="summary_large_image">' +
    '<link rel="alternate" type="application/rss+xml" title="PatchTicker release feed" href="' + esc(SITE + rssPath) + '">' +
    '<link rel="stylesheet" href="/discovery.css"></head><body>' +
    '<header class="discovery-header"><a class="discovery-brand" href="/"><img class="discovery-brand-mark" src="/patchticker-mark.svg" width="28" height="28" alt="" aria-hidden="true"><span class="discovery-brand-wordmark"><span>Patch</span>Ticker</span></a>' +
    '<nav aria-label="Main navigation"><a href="/briefing">Update brief</a><a href="/releases">Release notes</a><a href="/#/updates">Live dashboard</a><a href="/#/pricing">Pricing</a></nav></header>' +
    '<main id="main">' + body + '</main><footer class="discovery-footer"><span>PatchTicker · Know before you update.</span>' +
    '<a href="/releases.xml">RSS feed</a><a href="/#/about">About</a><a href="/#/privacy">Privacy</a><a href="/#/terms">Terms</a></footer></body></html>';
}
function card(update) {
  const date = isoDate(update.releasedAt);
  const path = esc(releasePath(update));
  return '<article class="discovery-card"><div class="discovery-card-meta"><span>' + esc(platformLabel(update.platform)) + '</span>' +
    (date ? '<time datetime="' + date + '">' + date + '</time>' : '') + '</div><h3><a href="' + path + '">' +
    esc(update.name) + '</a></h3>' + (update.verdict ? '<p>' + esc(update.verdict) + '</p>' : '') +
    '<a class="discovery-card-more" href="' + path + '">Read release details →</a></article>';
}
function renderIndex(updates, platforms) {
  const qualified = updates.filter(isIndexable).slice(0, 18);
  const links = platforms.map(platform => '<a href="' + esc(platformPath(platform.key)) + '">' + esc(platform.label) + '</a>').join('');
  return shell({
    title: 'Recent software updates and release notes',
    description: 'Source-linked release notes and install guidance for Windows, GPU drivers, browsers, consoles and games. Browse recent patches by platform.',
    path: '/releases',
    body: '<div class="discovery-hero"><p class="discovery-kicker">THE RELEASE DESK</p><h1>Recent software updates, with the source beside the score.</h1>' +
      '<p>See what changed before you install. Community ratings appear only when people have actually voted.</p>' +
      '<a class="discovery-cta" href="/briefing">Read the current update brief →</a></div>' +
      section('Browse by platform', '<div class="discovery-platforms">' + links + '</div>') +
      section('Latest sourced releases', '<div class="discovery-grid">' + qualified.map(card).join('') + '</div>' +
        '<p><a href="/releases.xml">Follow every new sourced release via RSS →</a></p>'),
  });
}
function briefingPicks(updates, now = Date.now()) {
  const recent = updates.filter(update => isIndexable(update)
    && Number.isFinite(Date.parse(update.releasedAt))
    && Date.parse(update.releasedAt) <= now + 24 * 60 * 60 * 1000
    && now - Date.parse(update.releasedAt) <= 30 * 24 * 60 * 60 * 1000)
    .sort((a, b) => Date.parse(b.releasedAt) - Date.parse(a.releasedAt));
  const seen = new Set();
  const unique = recent.filter(update => {
    if (seen.has(update.platform)) return false;
    seen.add(update.platform);
    return true;
  });
  const pick = status => unique.find(update => update.status === status
    && typeof update.score === 'number' && Number.isFinite(update.score)
    && update.score >= 0 && update.score <= 10);
  const featured = [pick('stable'), pick('caution'), pick('avoid')].filter(Boolean);
  const selected = new Set(featured.map(update => update.id));
  return [...featured, ...unique.filter(update => !selected.has(update.id))].slice(0, 6);
}
function renderBriefing(updates) {
  const picks = briefingPicks(updates);
  const newest = updates.filter(isIndexable).slice(0, 12);
  const decision = update => {
    const label = update.status === 'stable' ? 'Stable' : update.status === 'caution' ? 'Caution' : update.status === 'avoid' ? 'Avoid' : 'Review';
    const score = typeof update.score === 'number' && Number.isFinite(update.score) && update.score >= 0 && update.score <= 10
      ? update.score.toFixed(1) + '/10 source-based' : 'Not graded';
    return '<article class="discovery-decision discovery-decision--' + esc(update.status || 'review') + '">' +
      '<div class="discovery-card-meta"><span>' + esc(platformLabel(update.platform)) + '</span><time datetime="' + esc(isoDate(update.releasedAt)) + '">' + esc(isoDate(update.releasedAt)) + '</time></div>' +
      '<h3><a href="' + esc(releasePath(update)) + '">' + esc(update.name) + '</a></h3>' +
      '<p class="discovery-decision-rating"><strong>' + esc(label) + '</strong><span>' + esc(score) + '</span></p>' +
      '<p>' + esc(update.verdict || notes(update)[0] || 'Read the vendor notes before installing.') + '</p>' +
      '<a class="discovery-card-more" href="' + esc(releasePath(update)) + '">Why this assessment? →</a></article>';
  };
  return shell({
    title: 'Current update brief — what to install, wait on, or avoid',
    description: 'A concise, source-linked read on recent software updates. See documented changes, known issues, and install guidance before deciding.',
    path: '/briefing', noindex: !picks.length,
    body: '<div class="discovery-hero discovery-brief-hero"><p class="discovery-kicker">THE CURRENT UPDATE BRIEF</p>' +
      '<h1>What is worth updating right now?</h1><p>A concise selection of recent releases across different platforms. Start with the decision, then check the actual notes and source before installing.</p>' +
      '<div class="discovery-actions"><a class="discovery-cta" href="/#/updates">Search your setup →</a><a href="/releases.xml">Subscribe to the free RSS feed ↗</a></div></div>' +
      '<p class="discovery-caveat">Scores summarize published evidence, not hands-on testing or a guarantee of compatibility. A source check is not the same as a new release.</p>' +
      section('Recent releases to check', picks.length ? '<div class="discovery-brief-grid">' + picks.map(decision).join('') + '</div>' :
        '<p>No recent releases have enough verified detail for a brief yet. The live dashboard remains available.</p>') +
      section('More source-backed notes', newest.length ? '<div class="discovery-brief-links">' + newest.map(update => '<a href="' + esc(releasePath(update)) + '">' +
        '<span>' + esc(platformLabel(update.platform)) + '</span><strong>' + esc(update.name) + '</strong><time datetime="' + esc(isoDate(update.releasedAt)) + '">' + esc(isoDate(update.releasedAt)) + '</time></a>').join('') + '</div>' : '<p>No additional verified notes are available.</p>'),
  });
}
function renderRss(updates, platform = null) {
  const qualified = updates.filter(update => isIndexable(update) && (!platform || update.platform === platform)).slice(0, 30);
  const label = platform ? platformLabel(platform) + ' releases' : 'source-backed releases';
  const home = SITE + (platform ? platformPath(platform) : '/releases');
  const items = qualified.map(update => {
    const url = SITE + releasePath(update);
    const summary = [update.verdict, notes(update)[0]].filter(Boolean).join(' — ').slice(0, 600);
    const date = ['source-updated', 'catalog-updated', 'artifact-published'].includes(update.dateBasis)
      ? null : isoDate(update.releasedAt);
    return '<item><title>' + esc(update.name) + '</title><link>' + esc(url) + '</link><guid isPermaLink="true">' + esc(url) + '</guid>' +
      '<description>' + esc(summary) + '</description>' + (date ? '<pubDate>' + new Date(date + 'T00:00:00Z').toUTCString() + '</pubDate>' : '') + '</item>';
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>PatchTicker — ' + esc(label) + '</title>' +
    '<link>' + esc(home) + '</link><description>Vendor-source-linked software update notes and install guidance. Scores are not hands-on testing.</description>' +
    items + '</channel></rss>';
}
function renderPlatform(platform, updates) {
  const qualified = updates.filter(update => update.platform === platform.key && isIndexable(update));
  return shell({
    title: platform.label + ' updates and release notes',
    description: 'Recent ' + platform.label + ' software updates with source links, release notes and PatchTicker install guidance.',
    path: platformPath(platform.key), noindex: qualified.length === 0,
    rssPath: '/releases.xml?platform=' + encodeURIComponent(platform.key),
    body: '<div class="discovery-hero"><p class="discovery-kicker"><a href="/releases">← All releases</a> / ' + esc(platform.label) +
      '</p><h1>' + esc(platform.label) + ' updates</h1><p>Recent sourced releases and their published changes.</p>' +
      '<div class="discovery-actions"><a class="discovery-cta" href="/#/platform/' + encodeURIComponent(platform.key) + '">Explore ' + esc(platform.label) + ' in PatchTicker →</a>' +
      '<a href="/releases.xml?platform=' + encodeURIComponent(platform.key) + '">Follow ' + esc(platform.label) + ' via RSS ↗</a></div></div>' +
      section('Release notes', qualified.length ? '<div class="discovery-grid">' + qualified.map(card).join('') + '</div>' :
        '<p>Full release notes are not available yet. Version-only detections remain in the live dashboard.</p>'),
  });
}
function renderRelease(update) {
  const date = isoDate(update.releasedAt);
  const noindex = !isIndexable(update);
  const sourceEvidence = Array.isArray(update.evidence) ? update.evidence : [];
  const limitedCatalog = sourceEvidence
    .some(item => item?.detailsUnavailable === true && item?.dateBasis === 'catalog-updated');
  const sourceUpdated = update.dateBasis === 'source-updated'
    || sourceEvidence.some(item => item?.url === update.sourceUrl && item?.dateBasis === 'source-updated');
  const artifactDated = update.dateBasis === 'artifact-published';
  const dateLabel = limitedCatalog ? 'Catalog updated' : sourceUpdated ? 'Source updated' : artifactDated ? 'Package updated'
    : update.dateBasis === 'published' ? 'Published' : 'Released';
  const score = typeof update.score === 'number' && Number.isFinite(update.score) && update.score >= 0 && update.score <= 10 && !noindex
    ? update.score.toFixed(1) + '/10' : 'Not graded';
  const issues = (Array.isArray(update.knownIssues) ? update.knownIssues : []).filter(item => typeof item === 'string' && item.trim()).slice(0, 20);
  const risks = (Array.isArray(update.riskFactors) ? update.riskFactors : [])
    .map(item => typeof item === 'string' ? item : item?.text)
    .filter(item => typeof item === 'string' && item.trim()).slice(0, 8);
  const cves = (Array.isArray(update.securityCriticality?.cves) ? update.securityCriticality.cves : [])
    .filter(item => /^CVE-\d{4}-\d{4,}$/i.test(String(item))).slice(0, 12);
  const related = (Array.isArray(update.related) ? update.related : []).filter(isIndexable).slice(0, 4);
  const source = safeUrl(update.sourceUrl);
  const sourceLink = source ? '<a href="' + esc(source) + '" rel="noopener noreferrer" target="_blank">View official source ↗</a>' : 'Official source link unavailable';
  const evidence = (Array.isArray(update.evidence) ? update.evidence : []).filter(item => safeUrl(item?.url)).slice(0, 8)
    .map(item => '<li><a href="' + esc(safeUrl(item.url)) + '" rel="noopener noreferrer" target="_blank">' +
      esc(item.source || 'Source') + ' ↗</a>' + (item.text ? ' — ' + esc(item.text) : '') + '</li>').join('');
  const fact = (label, value) => '<div><dt>' + esc(label) + '</dt><dd>' + value + '</dd></div>';
  const facts = '<dl class="discovery-facts">' +
    fact('Platform', '<a href="' + esc(platformPath(update.platform)) + '">' + esc(platformLabel(update.platform)) + '</a>') +
    fact('Version', esc(update.version || 'Not stated')) +
    fact(dateLabel, date ? '<time datetime="' + date + '">' + date + '</time>' : 'Date unverified') +
    fact('PatchTicker assessment', score) + '</dl>';
  const caveat = limitedCatalog
    ? 'The vendor catalog confirms the package, but the release date and full notes could not be verified. This is not a hands-on compatibility test.'
    : sourceUpdated
      ? 'This date is when the vendor source or installer artifact was updated, not a confirmed public release date. A full per-build changelog may be unavailable; this is not a hands-on compatibility test.'
    : artifactDated
      ? 'This date comes from the vendor package metadata, not a confirmed public release announcement. The notes describe the named software version and may not document a package-only revision; this is not a hands-on compatibility test.'
    : noindex ? 'Only the version or limited release information is verified. Full notes and a stability conclusion are unavailable.'
      : 'This is source-based guidance, not a hands-on compatibility test. Check the vendor notes and your exact hardware before installing.';
  return shell({
    title: update.name + (limitedCatalog ? ' — verified package details' : noindex ? ' — verified version details' : ' — release notes and install guidance'),
    description: String(update.verdict || update.name + (limitedCatalog ? ' verified package details.' : noindex ? ' verified version details.' : ' release notes and install guidance.')).slice(0, 240),
    path: releasePath(update), noindex, type: 'article',
    body: '<div class="discovery-hero"><p class="discovery-kicker"><a href="/releases">All releases</a> / <a href="' +
      esc(platformPath(update.platform)) + '">' + esc(platformLabel(update.platform)) + '</a></p><h1>' + esc(update.name) + '</h1>' +
      '<p class="discovery-verdict">' + esc(update.verdict || 'Review the release notes before updating.') + '</p>' +
      '<div class="discovery-actions"><a class="discovery-cta" href="/#/updates/' + encodeURIComponent(update.id) +
      '">Check compatibility and user feedback →</a>' + sourceLink + '</div></div>' + facts +
      '<p class="discovery-caveat">' + esc(caveat) + '</p>' +
      (update.reasoning && !noindex ? section('Why this assessment', '<p>' + esc(update.reasoning) + '</p>' +
        (risks.length ? '<h3>Documented risk factors</h3>' + list(risks, '') : '') +
        (cves.length ? '<h3>Referenced CVEs</h3>' + list(cves, '') : '')) : '') +
      section('What changed', list(notes(update), 'A full changelog is not available from the vendor.')) +
      section('Known issues', list(issues, update.knownIssuesAuthoritative ? 'No known issues were listed in the vendor notes.' : 'Known issues have not been verified for this release.')) +
      (update.affects ? section('Affected products and devices', '<p>' + esc(update.affects) + '</p>') : '') +
      section('Sources', evidence ? '<ul class="discovery-sources">' + evidence + '</ul>' : '<p>' + sourceLink + '</p>') +
      (related.length ? section('Related releases', '<div class="discovery-grid">' + related.map(card).join('') + '</div>') : ''),
  });
}
function renderSitemap(updates, platforms) {
  const qualified = updates.filter(isIndexable);
  const active = new Set(qualified.map(update => update.platform));
  const entries = [
    { path: '/' }, { path: '/briefing' }, { path: '/releases' },
    ...platforms.filter(platform => active.has(platform.key)).map(platform => ({ path: platformPath(platform.key) })),
    // updatedAt changes on every source recheck, even when the release page
    // itself has not materially changed. A false daily lastmod is worse than
    // omitting this optional hint until content edits have their own timestamp.
    ...qualified.map(update => ({ path: releasePath(update) })),
  ];
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    entries.map(({ path, lastmod }) => '  <url><loc>' + esc(SITE + path) + '</loc>' +
      (lastmod ? '<lastmod>' + lastmod + '</lastmod>' : '') + '</url>').join('\n') + '\n</urlset>\n';
}

module.exports = { esc, safeUrl, isIndexable, briefingPicks, renderBriefing, renderRss, renderIndex, renderPlatform, renderRelease, renderSitemap };

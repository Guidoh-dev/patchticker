'use strict';

const SITE = 'https://patchticker.app';
const VERSION_ONLY = new Set(['official-version', 'official-artifact']);
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
const isIndexable = update => !!update && !VERSION_ONLY.has(update.sourceKind) && !!safeUrl(update.sourceUrl) && !!isoDate(update.releasedAt) && notes(update).length >= 2;
const section = (title, content) => '<section class="discovery-section"><h2>' + esc(title) + '</h2>' + content + '</section>';
const list = (items, empty) => items.length ? '<ul class="discovery-notes">' + items.map(item => '<li>' + esc(item) + '</li>').join('') + '</ul>' : '<p>' + esc(empty) + '</p>';
function shell({ title, description, path, body, noindex = false, type = 'website' }) {
  const fullTitle = esc(title) + ' | PatchTicker';
  const url = esc(SITE + path);
  const desc = esc(description);
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + fullTitle + '</title><meta name="description" content="' + desc + '">' +
    '<meta name="robots" content="' + (noindex ? 'noindex,follow' : 'index,follow') + '">' +
    '<link rel="canonical" href="' + url + '"><meta property="og:type" content="' + esc(type) + '">' +
    '<meta property="og:title" content="' + fullTitle + '"><meta property="og:description" content="' + desc + '">' +
    '<meta property="og:url" content="' + url + '"><meta property="og:image" content="' + SITE + '/og-image.png">' +
    '<meta name="twitter:card" content="summary_large_image"><link rel="stylesheet" href="/discovery.css"></head><body>' +
    '<header class="discovery-header"><a class="discovery-brand" href="/"><span>Patch</span>Ticker</a>' +
    '<nav aria-label="Main navigation"><a href="/releases">Release notes</a><a href="/#/updates">Live dashboard</a><a href="/#/pricing">Pricing</a></nav></header>' +
    '<main id="main">' + body + '</main><footer class="discovery-footer"><span>PatchTicker · Know before you update.</span>' +
    '<a href="/#/about">About</a><a href="/#/privacy">Privacy</a><a href="/#/terms">Terms</a></footer></body></html>';
}
function card(update) {
  const date = isoDate(update.releasedAt);
  const path = esc(releasePath(update));
  return '<article class="discovery-card"><div class="discovery-card-meta"><span>' + esc(update.platform) + '</span>' +
    (date ? '<time datetime="' + date + '">' + date + '</time>' : '') + '</div><h3><a href="' + path + '">' +
    esc(update.name) + '</a></h3>' + (update.verdict ? '<p>' + esc(update.verdict) + '</p>' : '') +
    '<a class="discovery-card-more" href="' + path + '">Read release details →</a></article>';
}
function renderIndex(updates, platforms) {
  const qualified = updates.filter(isIndexable);
  const links = platforms.map(platform => '<a href="' + esc(platformPath(platform.key)) + '">' + esc(platform.label) + '</a>').join('');
  return shell({
    title: 'Recent software updates and release notes',
    description: 'Source-linked release notes and install guidance for Windows, GPU drivers, browsers, consoles and games. Browse recent patches by platform.',
    path: '/releases',
    body: '<div class="discovery-hero"><p class="discovery-kicker">THE RELEASE DESK</p><h1>Recent software updates, with the source beside the score.</h1>' +
      '<p>See what changed before you install. Community ratings appear only when people have actually voted.</p>' +
      '<a class="discovery-cta" href="/#/updates">Open the live dashboard →</a></div>' +
      section('Browse by platform', '<div class="discovery-platforms">' + links + '</div>') +
      section('Latest sourced releases', '<div class="discovery-grid">' + qualified.map(card).join('') + '</div>'),
  });
}
function renderPlatform(platform, updates) {
  const qualified = updates.filter(update => update.platform === platform.key && isIndexable(update));
  return shell({
    title: platform.label + ' updates and release notes',
    description: 'Recent ' + platform.label + ' software updates with source links, release notes and PatchTicker install guidance.',
    path: platformPath(platform.key), noindex: qualified.length === 0,
    body: '<div class="discovery-hero"><p class="discovery-kicker"><a href="/releases">← All releases</a> / ' + esc(platform.label) +
      '</p><h1>' + esc(platform.label) + ' updates</h1><p>Recent sourced releases and their published changes.</p>' +
      '<a class="discovery-cta" href="/#/platform/' + encodeURIComponent(platform.key) + '">Explore ' + esc(platform.label) + ' in PatchTicker →</a></div>' +
      section('Release notes', qualified.length ? '<div class="discovery-grid">' + qualified.map(card).join('') + '</div>' :
        '<p>Full release notes are not available yet. Version-only detections remain in the live dashboard.</p>'),
  });
}
function renderRelease(update) {
  const date = isoDate(update.releasedAt);
  const noindex = !isIndexable(update);
  const score = typeof update.score === 'number' && Number.isFinite(update.score) && update.score >= 0 && update.score <= 10 && !noindex
    ? update.score.toFixed(1) + '/10' : 'Not graded';
  const issues = (Array.isArray(update.knownIssues) ? update.knownIssues : []).filter(item => typeof item === 'string' && item.trim()).slice(0, 20);
  const related = (Array.isArray(update.related) ? update.related : []).filter(isIndexable).slice(0, 4);
  const source = safeUrl(update.sourceUrl);
  const sourceLink = source ? '<a href="' + esc(source) + '" rel="noopener noreferrer" target="_blank">View official source ↗</a>' : 'Official source link unavailable';
  const evidence = (Array.isArray(update.evidence) ? update.evidence : []).filter(item => safeUrl(item?.url)).slice(0, 8)
    .map(item => '<li><a href="' + esc(safeUrl(item.url)) + '" rel="noopener noreferrer" target="_blank">' +
      esc(item.source || 'Source') + ' ↗</a>' + (item.text ? ' — ' + esc(item.text) : '') + '</li>').join('');
  const fact = (label, value) => '<div><dt>' + esc(label) + '</dt><dd>' + value + '</dd></div>';
  const facts = '<dl class="discovery-facts">' +
    fact('Platform', '<a href="' + esc(platformPath(update.platform)) + '">' + esc(update.platform) + '</a>') +
    fact('Version', esc(update.version || 'Not stated')) +
    fact('Released', date ? '<time datetime="' + date + '">' + date + '</time>' : 'Date unverified') +
    fact('PatchTicker assessment', score) + '</dl>';
  const caveat = noindex ? 'Only the version or limited release information is verified. Full notes and a stability conclusion are unavailable.' :
    'This is source-based guidance, not a hands-on compatibility test. Check the vendor notes and your exact hardware before installing.';
  return shell({
    title: update.name + ' — release notes and install guidance',
    description: String(update.verdict || update.name + ' release notes and install guidance.').slice(0, 240),
    path: releasePath(update), noindex, type: 'article',
    body: '<div class="discovery-hero"><p class="discovery-kicker"><a href="/releases">All releases</a> / <a href="' +
      esc(platformPath(update.platform)) + '">' + esc(update.platform) + '</a></p><h1>' + esc(update.name) + '</h1>' +
      '<p class="discovery-verdict">' + esc(update.verdict || 'Review the release notes before updating.') + '</p>' +
      '<div class="discovery-actions"><a class="discovery-cta" href="/#/updates/' + encodeURIComponent(update.id) +
      '">Open interactive update page →</a>' + sourceLink + '</div></div>' + facts +
      '<p class="discovery-caveat">' + esc(caveat) + '</p>' +
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
    { path: '/' }, { path: '/releases' },
    ...platforms.filter(platform => active.has(platform.key)).map(platform => ({ path: platformPath(platform.key) })),
    ...qualified.map(update => ({ path: releasePath(update), lastmod: isoDate(update.updatedAt || update.releasedAt) })),
  ];
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    entries.map(({ path, lastmod }) => '  <url><loc>' + esc(SITE + path) + '</loc>' +
      (lastmod ? '<lastmod>' + lastmod + '</lastmod>' : '') + '</url>').join('\n') + '\n</urlset>\n';
}

module.exports = { esc, safeUrl, isIndexable, renderIndex, renderPlatform, renderRelease, renderSitemap };

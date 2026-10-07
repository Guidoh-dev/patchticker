'use strict';

const express = require('express');
const request = require('supertest');
const { createPublicPagesRouter } = require('./routes/publicPages');
const { isIndexable, briefingPicks, renderBriefing, renderRss, renderRelease, renderSitemap } = require('./services/publicPagesService');
const { PLATFORMS } = require('./config/platformRegistry');

const update = {
  id: 'nvidia-599-10', platform: 'NVIDIA', name: 'NVIDIA Driver 599.10',
  version: '599.10', releasedAt: '2026-09-20T00:00:00Z',
  sourceKind: 'official-release-notes', sourceUrl: 'https://www.nvidia.com/download/index.aspx',
  score: 8.2, verdict: 'Read the driver notes before installing.',
  changelog: ['Fixed game crashes.', 'Improved stability.'],
  knownIssues: ['Some displays may flicker.'],
  evidence: [{ source: 'NVIDIA', url: 'https://www.nvidia.com/download/index.aspx', text: 'Official release notes' }],
  related: [],
};
const versionOnly = {
  ...update, id: 'gog-2-1', platform: 'GOG', name: 'GOG Galaxy 2.1',
  sourceKind: 'official-version', score: 5.9,
};

test('public pages escape release text and source URLs', () => {
  const html = renderRelease({ ...update, name: '<script>alert(1)</script>', verdict: 'A & B', sourceUrl: 'javascript:alert(1)' });
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(html).not.toContain('<script>alert');
  expect(html).not.toContain('href="javascript:');
  expect(html).toContain('A &amp; B');
});

test('crawlable release pages expose the same PatchTicker mark and favicon as the SPA', () => {
  const html = renderRelease(update);
  expect(html).toContain('rel="icon" type="image/png" sizes="48x48" href="/patchticker-mark-48.png"');
  expect(html).toContain('class="discovery-brand-mark" src="/patchticker-mark.svg"');
  expect(html).toContain('<span class="discovery-brand-wordmark"><span>Patch</span>Ticker</span>');
});

test('release pages explain the score using escaped evidence, not just a vendor-note copy', () => {
  const html = renderRelease({ ...update, reasoning: 'Confirmed fixes & one issue <unverified>',
    riskFactors: [{ text: 'Display flicker on selected models' }],
    securityCriticality: { cves: ['CVE-2026-12345', '<script>'] } });
  expect(html).toContain('Why this assessment');
  expect(html).toContain('Confirmed fixes &amp; one issue &lt;unverified&gt;');
  expect(html).toContain('Display flicker on selected models');
  expect(html).toContain('CVE-2026-12345');
  expect(html).not.toContain('<script>');
  expect(html).toContain('Check compatibility and user feedback');
});

test('version-only detections are noindex, ungraded, and omitted from sitemap', () => {
  expect(isIndexable(update)).toBe(true);
  expect(isIndexable(versionOnly)).toBe(false);
  const html = renderRelease(versionOnly);
  expect(html).toContain('content="noindex,follow"');
  expect(html).toContain('Not graded');
  expect(html).not.toContain('5.9/10');
  const sitemap = renderSitemap([update, versionOnly], PLATFORMS);
  expect(sitemap).toContain('https://patchticker.app/releases/nvidia-599-10');
  expect(sitemap).toContain('https://patchticker.app/briefing');
  expect(sitemap).not.toContain('https://patchticker.app/releases/gog-2-1');
  expect(sitemap).not.toContain('#/');
});

test('the current brief selects distinct platforms and never promotes version-only records', () => {
  const fresh = { ...update, releasedAt: new Date().toISOString(), status: 'stable' };
  const cautious = { ...fresh, id: 'amd-1', platform: 'AMD', status: 'caution', score: 6.1, name: 'AMD driver 1' };
  const duplicate = { ...fresh, id: 'nvidia-older', releasedAt: new Date(Date.now() - 86400000).toISOString() };
  const picks = briefingPicks([fresh, cautious, duplicate, { ...versionOnly, releasedAt: fresh.releasedAt }]);
  expect(picks.map(item => item.id)).toEqual(['nvidia-599-10', 'amd-1']);
  const html = renderBriefing([fresh, cautious, duplicate, versionOnly]);
  expect(html).toContain('What is worth updating right now?');
  expect(html).toContain('6.1/10 source-based');
  expect(html).not.toContain('GOG Galaxy 2.1');
  expect(html).toContain('/releases.xml');
});

test('RSS is well-escaped, source-qualified, and can be narrowed to one platform', () => {
  const malicious = { ...update, name: 'Driver <next> & safer', verdict: 'Fix & test before installing' };
  const xml = renderRss([malicious, versionOnly]);
  expect(xml).toContain('<rss version="2.0">');
  expect(xml).toContain('Driver &lt;next&gt; &amp; safer');
  expect(xml).not.toContain('<next>');
  expect(xml).not.toContain('GOG Galaxy 2.1');
  expect(renderRss([malicious], 'AMD')).not.toContain('<item>');
});

test('a specific one-note vendor fix is discoverable without inventing extra release notes', () => {
  const switch2 = {
    ...update, id: 'switch2-23-0-1', platform: 'Switch2', name: 'Nintendo Switch 2 System Update 23.0.1',
    version: '23.0.1', releasedAt: '2026-09-30T00:00:00Z', sourceKind: 'official-release',
    sourceUrl: 'https://en-americas-support.nintendo.com/app/answers/detail/a_id/68473',
    changelog: ['Fixed an issue from system version 23.0.0 where software occasionally took a long time to start, pause, or close.'],
    score: 7,
  };
  expect(isIndexable(switch2)).toBe(true);
  const html = renderRelease(switch2);
  expect(html).toContain('content="index,follow"');
  expect(html).toContain('7.0/10');
  expect(html).toContain('>Switch 2</a>');
  expect(html).not.toContain('>Switch2</a>');
  const sitemap = renderSitemap([switch2], PLATFORMS);
  expect(sitemap).toContain('https://patchticker.app/releases/switch2-23-0-1');
  expect(sitemap).toContain('https://patchticker.app/platforms/Switch2');
});

test('a detailed single CVE remains discoverable while generic single notes stay noindex', () => {
  const security = { ...update, platform: 'macOS', sourceKind: 'official-security-advisory',
    changelog: ['Screen Sharing: An attacker on the network may be able to authenticate to Screen Sharing without valid credentials (CVE-2026-65400)'] };
  const generic = { ...update, changelog: ['Microsoft Edge was released to the Stable channel with Chromium security updates.'] };
  const catalog = { ...security, dateBasis: 'catalog-updated' };
  expect(isIndexable(security)).toBe(true);
  expect(isIndexable(generic)).toBe(false);
  expect(isIndexable(catalog)).toBe(false);
  expect(renderRelease(generic)).toContain('content="noindex,follow"');
});

test('a catalog-only build never presents the catalog timestamp as a verified release date', () => {
  const catalogOnly = {
    ...update, id: 'intel-9033', platform: 'Intel', name: 'Intel Arc Graphics Driver 9033',
    changelog: ['Current package listed.'],
    evidence: [{ source: 'Intel Download Center', url: update.sourceUrl, dateBasis: 'catalog-updated', detailsUnavailable: true }],
  };
  const html = renderRelease(catalogOnly);
  expect(html).toContain('Catalog updated');
  expect(html).toContain('release date and full notes could not be verified');
  expect(html).toContain('verified package details');
  expect(html).not.toContain('release notes and install guidance | PatchTicker');
  expect(html).toContain('content="noindex,follow"');
});

test('version-only source timestamps are not presented as confirmed release dates', () => {
  const manifestOnly = {
    ...versionOnly, dateBasis: 'source-updated',
    evidence: [{ source: 'GOG Installer Manifest', url: versionOnly.sourceUrl, dateBasis: 'source-updated' }],
  };
  const html = renderRelease(manifestOnly);
  expect(html).toContain('<dt>Source updated</dt>');
  expect(html).not.toContain('<dt>Released</dt>');
  expect(html).toContain('not a confirmed public release date');
  expect(html).toContain('content="noindex,follow"');
  expect(html).toContain('Not graded');
});

test('PS5 package timestamps are not described as confirmed firmware release dates', () => {
  const ps5Package = { ...update, id: 'ps5-pup-2026-10-01-c1738494', platform: 'PS5',
    name: 'PS5 System Software 26.06-14.10.00', dateBasis: 'artifact-published' };
  const html = renderRelease(ps5Package);
  expect(html).toContain('<dt>Package updated</dt>');
  expect(html).toContain('not a confirmed public release announcement');
  expect(html).not.toContain('<dt>Released</dt>');
});

test('routine source rechecks do not claim every release page changed in the sitemap', () => {
  const rechecked = { ...update, createdAt: '2026-09-20T12:00:00Z', updatedAt: '2026-09-30T22:00:00Z' };
  const sitemap = renderSitemap([rechecked], PLATFORMS);
  expect(sitemap).toContain('https://patchticker.app/releases/nvidia-599-10');
  expect(sitemap).not.toContain('<lastmod>2026-09-30</lastmod>');
});

test('release routes, platform pages, and sitemap serve crawlable HTML', async () => {
  const app = express().use(createPublicPagesRouter({
    listUpdates: async () => [update, versionOnly],
    findUpdate: async id => id === update.id ? update : null,
  }));
  const index = await request(app).get('/releases').expect(200);
  expect(index.text).toContain('<h1>');
  expect(index.text).toContain('/releases/nvidia-599-10');
  expect(index.text).not.toContain('/releases/gog-2-1');
  const briefing = await request(app).get('/briefing').expect(200);
  expect(briefing.text).toContain('<link rel="canonical" href="https://patchticker.app/briefing">');
  const rss = await request(app).get('/releases.xml').expect(200);
  expect(rss.headers['content-type']).toMatch(/application\/rss\+xml/);
  expect(rss.text).toContain('/releases/nvidia-599-10');
  await request(app).get('/releases.xml?platform=unknown').expect(404);
  const platformFeed = await request(app).get('/releases.xml?platform=NVIDIA').expect(200);
  expect(platformFeed.text).toContain('/releases/nvidia-599-10');
  expect((await request(app).get('/platforms/NVIDIA').expect(200)).text)
    .toContain('href="https://patchticker.app/releases.xml?platform=NVIDIA"');
  const detail = await request(app).get('/releases/nvidia-599-10').expect(200);
  expect(detail.text).toContain('<link rel="canonical" href="https://patchticker.app/releases/nvidia-599-10">');
  expect(detail.text).toContain('Fixed game crashes.');
  expect(detail.text).toContain('View official source');
  const platform = await request(app).get('/platforms/NVIDIA').expect(200);
  expect(platform.text).toContain('NVIDIA updates');
  const sitemap = await request(app).get('/sitemap.xml').expect(200);
  expect(sitemap.headers['content-type']).toContain('application/xml');
  await request(app).get('/releases/missing').expect(404);
  await request(app).get('/platforms/Unknown').expect(404);
});

test('legacy release URLs redirect to the current canonical release', async () => {
  const app = express().use(createPublicPagesRouter({
    listUpdates: async () => [update],
    findUpdate: async () => update,
  }));
  const response = await request(app).get('/releases/old-nvidia-link').expect(301);
  expect(response.headers.location).toBe('/releases/nvidia-599-10');
});

test('empty feed is not presented to crawlers as a healthy index', async () => {
  const app = express().use(createPublicPagesRouter({ listUpdates: async () => [] }));
  const response = await request(app).get('/sitemap.xml').expect(503);
  expect(response.headers['x-robots-tag']).toBe('noindex');
});

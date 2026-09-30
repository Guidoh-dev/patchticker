'use strict';

const express = require('express');
const request = require('supertest');
const { createPublicPagesRouter } = require('./routes/publicPages');
const { isIndexable, renderRelease, renderSitemap } = require('./services/publicPagesService');
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

test('version-only detections are noindex, ungraded, and omitted from sitemap', () => {
  expect(isIndexable(update)).toBe(true);
  expect(isIndexable(versionOnly)).toBe(false);
  const html = renderRelease(versionOnly);
  expect(html).toContain('content="noindex,follow"');
  expect(html).toContain('Not graded');
  expect(html).not.toContain('5.9/10');
  const sitemap = renderSitemap([update, versionOnly], PLATFORMS);
  expect(sitemap).toContain('https://patchticker.app/releases/nvidia-599-10');
  expect(sitemap).not.toContain('https://patchticker.app/releases/gog-2-1');
  expect(sitemap).not.toContain('#/');
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

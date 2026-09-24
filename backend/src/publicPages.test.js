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

test('empty feed is not presented to crawlers as a healthy index', async () => {
  const app = express().use(createPublicPagesRouter({ listUpdates: async () => [] }));
  const response = await request(app).get('/sitemap.xml').expect(503);
  expect(response.headers['x-robots-tag']).toBe('noindex');
});

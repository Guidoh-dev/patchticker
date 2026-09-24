'use strict';

const express = require('express');
const { PLATFORMS, getPlatform } = require('../config/platformRegistry');
const { getUpdates, getUpdateById } = require('../services/updatesService');
const { renderIndex, renderPlatform, renderRelease, renderSitemap } = require('../services/publicPagesService');
const logger = require('../utils/logger');
const db = require('../config/db');

const FEED_CACHE_MS = 5 * 60 * 1000;

function createPublicPagesRouter({ listUpdates = getUpdates, findUpdate = getUpdateById } = {}) {
  const router = express.Router();
  let cache = { until: 0, updates: [] };
  async function publicUpdates() {
    if (Date.now() < cache.until && cache.updates.length) return cache.updates;
    const updates = await listUpdates();
    // An empty production feed is more likely an upstream outage than a useful
    // search page. Do not cache it or tell crawlers there are zero releases.
    if (!updates.length) return [];
    cache = { until: Date.now() + FEED_CACHE_MS, updates };
    return updates;
  }
  const html = (res, value) => res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600').type('html').send(value);
  const unavailable = res => res.set('Retry-After', '300').set('X-Robots-Tag', 'noindex').status(503).type('text').send('Release information temporarily unavailable.');
  const handle = handler => async (req, res, next) => {
    try { await handler(req, res); }
    catch (error) { logger.warn('[public-pages] Render failed', { path: req.path, error: error.message }); next(error); }
  };

  router.get('/sitemap.xml', handle(async (_req, res) => {
    const updates = await publicUpdates();
    if (!updates.length) return unavailable(res);
    res.set('Cache-Control', 'public, max-age=300').type('application/xml').send(renderSitemap(updates, PLATFORMS));
  }));
  router.get('/releases', handle(async (_req, res) => {
    const updates = await publicUpdates();
    if (!updates.length) return unavailable(res);
    html(res, renderIndex(updates, PLATFORMS));
  }));
  router.get('/platforms/:platform', handle(async (req, res) => {
    const platform = getPlatform(req.params.platform);
    if (!platform) return res.status(404).type('text').send('Platform not found');
    const updates = await publicUpdates();
    if (!updates.length) return unavailable(res);
    html(res, renderPlatform(platform, updates));
  }));
  router.get('/releases/:id', handle(async (req, res) => {
    if (!/^[a-z0-9][a-z0-9._-]{0,159}$/i.test(req.params.id)) return res.status(404).type('text').send('Release not found');
    if (process.env.NODE_ENV === 'production' && !db.isAvailable()) return unavailable(res);
    const update = await findUpdate(req.params.id);
    if (!update) return res.status(404).type('text').send('Release not found');
    html(res, renderRelease(update));
  }));
  return router;
}

module.exports = { createPublicPagesRouter };

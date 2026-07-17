// src/routes/watchlist.js
// ─────────────────────────────────────────────────────────────────────────────
// WATCHLIST — Pro feature
//
//  GET    /api/watchlist              — get user's watched platforms
//  PUT    /api/watchlist/:platform    — add/update platform watch
//  DELETE /api/watchlist/:platform    — remove platform watch
//  GET    /api/watchlist/webhooks     — get webhook settings
//  PUT    /api/watchlist/webhooks     — upsert webhook settings
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router  = express.Router();
const { z }   = require('zod');

const requireAuth        = require('../middleware/requireAuth');
const { requirePro }     = require('../middleware/requireRole');
const validate           = require('../middleware/validate');
const { standardLimiter, accountMutateLimiter } = require('../middleware/rateLimiter');
const watchlistService   = require('../services/watchlistService');

const VALID_PLATFORMS = ['AMD','NVIDIA','Intel','Apple','macOS','Windows','Steam','Epic','Xbox','PS5','Switch','Discord','BattleNet','GOG'];

const PlatformParamSchema = z.object({
  platform: z.enum(VALID_PLATFORMS),
}).strict();

const UpsertWatchSchema = z.object({
  notifyEmail:   z.boolean().default(true),
  notifyWebhook: z.boolean().default(false),
}).strict();

const WebhookSchema = z.object({
  webhookUrl: z.string().url().optional().or(z.literal('')),
  slackUrl:   z.string().url().optional().or(z.literal('')),
  enabled:    z.boolean().default(true),
}).strict();

router.use(requireAuth, requirePro, standardLimiter);

// GET /api/watchlist
router.get('/', async (req, res, next) => {
  try {
    const list = await watchlistService.getWatchlist(req.user.id);
    res.json({ data: list });
  } catch (err) { next(err); }
});

// PUT /api/watchlist/:platform
router.put(
  '/:platform',
  accountMutateLimiter,
  validate({ params: PlatformParamSchema, body: UpsertWatchSchema }),
  async (req, res, next) => {
    try {
      await watchlistService.upsertWatch(req.user.id, req.params.platform, req.body);
      res.json({ ok: true });
    } catch (err) { next(err); }
  }
);

// DELETE /api/watchlist/:platform
router.delete(
  '/:platform',
  accountMutateLimiter,
  validate({ params: PlatformParamSchema }),
  async (req, res, next) => {
    try {
      await watchlistService.removeWatch(req.user.id, req.params.platform);
      res.json({ ok: true });
    } catch (err) { next(err); }
  }
);

// GET /api/watchlist/webhooks
router.get('/webhooks', async (req, res, next) => {
  try {
    const settings = await watchlistService.getWebhookSettings(req.user.id);
    res.json({ data: settings });
  } catch (err) { next(err); }
});

// PUT /api/watchlist/webhooks
router.put(
  '/webhooks',
  accountMutateLimiter,
  validate({ body: WebhookSchema }),
  async (req, res, next) => {
    try {
      await watchlistService.upsertWebhookSettings(req.user.id, req.body);
      res.json({ ok: true });
    } catch (err) { next(err); }
  }
);

module.exports = router;

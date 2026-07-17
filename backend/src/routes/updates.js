// src/routes/updates.js
// ─────────────────────────────────────────────────────────────────────────────
// UPDATES — public feed + AI-enriched detail pages
//
//  GET  /api/updates         — list (open; ?platform= ?status= ?sort= ?search=)
//  GET  /api/updates/summary — aggregated counts (open)
//  GET  /api/updates/:id     — single update, live ratings merged
//  POST /api/updates/:id/analyse  (Pro) — trigger AI re-analysis on demand
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router  = express.Router();

const { externalApiLimiter } = require('../middleware/rateLimiter');
const requireAuth             = require('../middleware/requireAuth');
const { requirePro }          = require('../middleware/requireRole');
const validate                = require('../middleware/validate');
const {
  GetUpdatesQuerySchema,
  GetUpdateByIdParamSchema,
} = require('../validators/schemas');
const { getUpdates, getUpdateById, getSentimentSummary, getUpdateHistory } = require('../services/updatesService');
const aiService        = require('../services/aiAnalysisService');
const { escapeOutput } = require('../utils/sanitize');
const db               = require('../config/db');
const logger           = require('../utils/logger');
const { aiAnalysisLimiter } = require('../middleware/rateLimiter');

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getLiveRatings(updateId) {
  if (!db.isAvailable()) return null;
  try {
    const row = await db.query(
      `SELECT
         COUNT(*)                                        AS total,
         COUNT(*) FILTER (WHERE vote = 'install')        AS install_count,
         COUNT(*) FILTER (WHERE vote = 'wait')           AS wait_count,
         COUNT(*) FILTER (WHERE vote = 'avoid')          AS avoid_count
       FROM update_ratings WHERE update_id = $1`,
      [updateId]
    );
    const r     = row.rows[0];
    const total = parseInt(r.total, 10);
    if (total === 0) return null;

    const install = parseInt(r.install_count, 10);
    const wait    = parseInt(r.wait_count,    10);
    const avoid   = parseInt(r.avoid_count,   10);
    const score   = +((install * 10 + wait * 5) / total).toFixed(1);

    return {
      score,
      totalVotes: total,
      breakdown: {
        install: Math.round((install / total) * 100),
        wait:    Math.round((wait    / total) * 100),
        avoid:   Math.round((avoid   / total) * 100),
      },
    };
  } catch { return null; }
}

async function getUserVote(updateId, userId) {
  if (!db.isAvailable() || !userId) return null;
  try {
    const row = await db.query(
      `SELECT vote FROM update_ratings WHERE update_id = $1 AND user_id = $2`,
      [updateId, userId]
    );
    return row.rows[0]?.vote || null;
  } catch { return null; }
}

// ── GET /api/updates ──────────────────────────────────────────────────────────

router.get(
  '/',
  externalApiLimiter,
  validate({ query: GetUpdatesQuerySchema }),
  async (req, res, next) => {
    try {
      const { platform, status, sort, search } = req.query;
      const updates = await getUpdates({ platform, status, sort, search });
      logger.info(`GET /updates — returned ${updates.length} items`, { platform, status });
      res.json({ data: updates, count: updates.length });
    } catch (err) { next(err); }
  }
);

// ── GET /api/updates/summary ──────────────────────────────────────────────────

router.get('/summary', async (req, res, next) => {
  try {
    const summary = await getSentimentSummary();
    res.json({ data: summary });
  } catch (err) { next(err); }
});

// ── GET /api/updates/:platform/history ───────────────────────────────────────

router.get(
  '/:platform/history',
  externalApiLimiter,
  async (req, res, next) => {
    try {
      const platform = req.params.platform;
      const limit    = Math.min(parseInt(req.query.limit, 10) || 20, 50);
      const history  = await getUpdateHistory(platform, limit);
      res.json({ data: history, platform });
    } catch (err) { next(err); }
  }
);

// ── POST /api/updates/:id/analyse  (Pro) ─────────────────────────────────────

router.post(
  '/:id/analyse',
  requireAuth,
  requirePro,
  aiAnalysisLimiter,
  validate({ params: GetUpdateByIdParamSchema }),
  async (req, res, next) => {
    try {
      const update = await getUpdateById(req.params.id);
      if (!update) return res.status(404).json({ error: 'Update not found' });
      if (!aiService.isEnabled()) return res.status(503).json({ error: 'AI analysis not configured' });

      const enriched = await aiService.analyseUpdate(update);
      if (!enriched) return res.status(500).json({ error: 'AI analysis failed' });

      res.json({ data: enriched });
    } catch (err) { next(err); }
  }
);

// ── GET /api/updates/:id ──────────────────────────────────────────────────────

router.get(
  '/:id',
  externalApiLimiter,
  validate({ params: GetUpdateByIdParamSchema }),
  async (req, res, next) => {
    try {
      const update = await getUpdateById(req.params.id);
      if (!update) return res.status(404).json({ error: 'Update not found' });

      const userId = req.user?.id ?? null;
      const [liveRatings, userVote] = await Promise.all([
        getLiveRatings(req.params.id),
        getUserVote(req.params.id, userId),
      ]);

      const enriched = {
        ...update,
        userRating:  liveRatings ?? update.userRating,
        userVote,
        ratingsLive: !!liveRatings,
      };

      logger.info(`GET /updates/${req.params.id}`, { hasLiveRatings: !!liveRatings });
      res.json({ data: escapeOutput(enriched) });
    } catch (err) { next(err); }
  }
);

module.exports = router;

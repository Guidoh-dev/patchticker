// src/routes/ratings.js
// ─────────────────────────────────────────────────────────────────────────────
// USER RATINGS — one vote per user per update
//
// SECURITY MODEL
// ──────────────
//  1. GET  — ratingsReadLimiter (60/min per IP) + standardLimiter global.
//             No auth required: aggregated counts are public.
//
//  2. POST — requireAuth + requireEmailVerified + voteLimiter (20/hr per user ID).
//             UNIQUE(update_id, user_id) DB constraint prevents duplicate rows.
//             ON CONFLICT DO UPDATE = idempotent upsert, not an insert-on-every-call.
//             Changing your vote is allowed; the row is just updated in place.
//
//  3. DELETE — same auth + email-verified chain. Also voteLimiter.
//
//  All write paths log userId + IP for abuse tracing.
//
// ANTI-SPAM LAYERS (in order)
// ────────────────────────────
//  a. Email verification required — throwaway accounts cannot vote.
//  b. requireAuth — must hold a valid short-lived JWT (15-min access token).
//  c. voteLimiter — 20 vote changes per user per hour (keyed on user ID).
//  d. standardLimiter — 100/15 min global IP baseline (applied in server.js).
//  e. DB UNIQUE constraint — double-vote at the DB layer is a no-op (upsert).
//  f. Zod validation — updateId must match /^[a-z0-9-]+$/, vote must be enum.
//  g. abuseDetector + suspiciousActivityDetector — in server.js middleware chain.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router  = express.Router();
const { z }   = require('zod');

const requireAuth         = require('../middleware/requireAuth');
const validate            = require('../middleware/validate');
const {
  ratingsReadLimiter,
  voteLimiter,
}                         = require('../middleware/rateLimiter');
const db                  = require('../config/db');
const logger              = require('../utils/logger');

// ── Inline email-verified guard ───────────────────────────────────────────────
// Prevents throwaway / unverified accounts from padding votes.
// We check req.user.emailVerified which is set by requireAuth → findUserById.
function requireEmailVerified(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (!req.user.emailVerified) {
    return res.status(403).json({
      error: 'Email verification required to vote. Please verify your email address.',
    });
  }
  next();
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const UpdateIdParamSchema = z.object({
  updateId: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, 'Invalid update ID'),
}).strict();

const VoteSchema = z.object({
  vote: z.enum(['install','wait','avoid']),
}).strict();

// ── Aggregation helper ────────────────────────────────────────────────────────

async function getAggregated(updateId) {
  if (!db.isAvailable()) return null;
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
  if (total === 0) return { totalVotes: 0, breakdown: { install: 0, wait: 0, avoid: 0 }, score: null };

  const install = parseInt(r.install_count, 10);
  const wait    = parseInt(r.wait_count,    10);
  const avoid   = parseInt(r.avoid_count,   10);

  // Weighted score: install=10, wait=5, avoid=0 → normalised to 0–10
  const score = +((install * 10 + wait * 5) / total).toFixed(1);

  return {
    totalVotes: total,
    breakdown: {
      install: Math.round((install / total) * 100),
      wait:    Math.round((wait    / total) * 100),
      avoid:   Math.round((avoid   / total) * 100),
    },
    score,
  };
}

// ── GET /api/ratings/:updateId ────────────────────────────────────────────────
// Public. Own limiter (60/min) tighter than standard to protect DB.

router.get(
  '/:updateId',
  ratingsReadLimiter,
  validate({ params: UpdateIdParamSchema }),
  async (req, res, next) => {
    try {
      const agg = await getAggregated(req.params.updateId);
      // Cache for 30s — reduces DB hit on popular updates
      res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
      res.json({ data: agg });
    } catch (err) { next(err); }
  }
);

// ── POST /api/ratings/:updateId ───────────────────────────────────────────────
// requireAuth → requireEmailVerified → voteLimiter (per user ID) → Zod

router.post(
  '/:updateId',
  requireAuth,
  requireEmailVerified,
  voteLimiter,
  validate({ params: UpdateIdParamSchema, body: VoteSchema }),
  async (req, res, next) => {
    if (!db.isAvailable()) return res.status(503).json({ error: 'Database unavailable' });
    try {
      const { updateId } = req.params;
      const { vote }     = req.body;
      const userId       = req.user.id;

      // Upsert: idempotent — changing vote just overwrites the existing row.
      // DB UNIQUE(update_id, user_id) guarantees at most one row per user per update.
      await db.query(
        `INSERT INTO update_ratings (update_id, user_id, vote, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (update_id, user_id)
         DO UPDATE SET vote = $3, updated_at = now()`,
        [updateId, userId, vote]
      );

      const agg = await getAggregated(updateId);
      logger.info('[ratings] Vote cast', {
        updateId,
        vote,
        userId,
        ip: req.ip,
      });

      // No-cache on write responses — client must always see fresh data after voting
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, data: agg });
    } catch (err) { next(err); }
  }
);

// ── DELETE /api/ratings/:updateId ─────────────────────────────────────────────
// requireAuth → requireEmailVerified → voteLimiter

router.delete(
  '/:updateId',
  requireAuth,
  requireEmailVerified,
  voteLimiter,
  validate({ params: UpdateIdParamSchema }),
  async (req, res, next) => {
    if (!db.isAvailable()) return res.status(503).json({ error: 'Database unavailable' });
    try {
      const userId = req.user.id;
      await db.query(
        `DELETE FROM update_ratings WHERE update_id = $1 AND user_id = $2`,
        [req.params.updateId, userId]
      );

      const agg = await getAggregated(req.params.updateId);
      logger.info('[ratings] Vote retracted', { updateId: req.params.updateId, userId, ip: req.ip });

      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, data: agg });
    } catch (err) { next(err); }
  }
);

module.exports = router;

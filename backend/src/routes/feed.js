// src/routes/feed.js
// ─────────────────────────────────────────────────────────────────────────────
// COMMUNITY FEED — live post stream + post submission
//
// GET  /api/feed/stream   — SSE stream of recent + live posts (auth required)
// GET  /api/feed/recent   — last 40 posts as JSON (for initial render)
// POST /api/feed/post     — submit a post (auth required, rate limited)
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express     = require('express');
const rateLimit   = require('express-rate-limit');
const requireAuth = require('../middleware/requireAuth');
const db          = require('../config/db');
const logger      = require('../utils/logger');
const { z }       = require('zod');

const router = express.Router();

// ── Rate limiter: 1 post per 4 seconds per user ───────────────────────────────
const postLimiter = rateLimit({
  windowMs: 4_000,
  max: 1,
  keyGenerator: (req) => `feed:${req.user?.id ?? req.ip}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Slow down — 1 post per 4 seconds.' },
  skip: (req) => req.method !== 'POST',
});

const PostSchema = z.object({
  body:     z.string().min(1).max(280).trim(),
  platform: z.enum(['AMD','NVIDIA','Apple','PS5','Windows','Steam','macOS','Intel','Epic','Xbox','Switch','Discord','BattleNet','GOG']).optional(),
});

// ── In-process SSE client registry ───────────────────────────────────────────
// Map<userId, Set<res>>  — multiple tabs per user supported
const _clients = new Map();

function broadcast(post) {
  const payload = `data: ${JSON.stringify(post)}\n\n`;
  for (const clientSet of _clients.values()) {
    for (const res of clientSet) {
      try { res.write(payload); } catch { /* client disconnected */ }
    }
  }
}

function register(userId, res) {
  if (!_clients.has(userId)) _clients.set(userId, new Set());
  _clients.get(userId).add(res);
}

function unregister(userId, res) {
  _clients.get(userId)?.delete(res);
  if (_clients.get(userId)?.size === 0) _clients.delete(userId);
}

// ── GET /api/feed/recent — initial payload ────────────────────────────────────
router.get('/recent', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query(`
      SELECT
        cp.id,
        cp.body,
        cp.platform,
        cp.created_at  AS "createdAt",
        u.email        AS "userEmail"
      FROM community_posts cp
      JOIN users u ON u.id = cp.user_id
      WHERE cp.created_at > NOW() - INTERVAL '24 hours'
      ORDER BY cp.created_at DESC
      LIMIT 60
    `);
    // Return oldest-first so the client can append in order
    res.json(result.rows.reverse());
  } catch (err) {
    next(err);
  }
});

// ── GET /api/feed/stream — SSE ────────────────────────────────────────────────
router.get('/stream', requireAuth, (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering
  res.flushHeaders();

  const userId = req.user.id;
  register(userId, res);

  // Heartbeat every 25s to prevent proxy timeouts
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unregister(userId, res);
  });
});

// ── POST /api/feed/post ───────────────────────────────────────────────────────
router.post('/post', requireAuth, postLimiter, async (req, res, next) => {
  const parse = PostSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: parse.error.issues[0]?.message ?? 'Invalid input' });
  }

  const { body, platform } = parse.data;
  const userId = req.user.id;

  try {
    const result = await db.query(`
      INSERT INTO community_posts (user_id, body, platform)
      VALUES ($1, $2, $3)
      RETURNING id, body, platform, created_at AS "createdAt"
    `, [userId, body, platform ?? null]);

    const post = {
      ...result.rows[0],
      userEmail: req.user.email,
    };

    broadcast(post);
    logger.info('Feed post created', { userId, postId: post.id });
    res.status(201).json(post);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

// src/routes/feed.js
// ─────────────────────────────────────────────────────────────────────────────
// LIVE FEED — verified release events + community post stream
//
// GET  /api/feed/stream   — SSE stream of recent + live posts (auth required)
// GET  /api/feed/recent   — last 60 posts as JSON (for initial render)
// POST /api/feed/post     — submit a post (auth required, rate limited)
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express     = require('express');
const rateLimit   = require('express-rate-limit');
const requireAuth = require('../middleware/requireAuth');
const db          = require('../config/db');
const logger      = require('../utils/logger');
const liveFeed    = require('../services/liveFeedService');
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

const streamTicketLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  keyGenerator: (req) => `feed-ticket:${req.user?.id ?? req.ip}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many live-chat connection attempts. Please wait a moment.' },
});

const postQuotaLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => `feed-quota:${req.user?.id ?? req.ip}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Live-chat limit reached. Maximum 30 posts per hour.' },
});

const PostSchema = z.object({
  body:     z.string().min(1).max(280).trim(),
  platform: z.enum(['AMD','NVIDIA','Apple','PS5','Windows','Steam','macOS','Intel','Xbox','Switch','Discord','BattleNet','GOG']).optional(),
});

function feedUserLabel(userId) {
  return `Member ${String(userId || '').slice(0, 4).toUpperCase() || 'USER'}`;
}

function requireVerifiedMember(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!req.user.emailVerified) {
    return res.status(403).json({ error: 'Verify your email before joining live chat.' });
  }
  next();
}

// ── GET /api/feed/recent — initial payload ────────────────────────────────────
router.get('/recent', async (req, res, next) => {
  // Community chat is supplemental to the verified release feed. During a DB
  // outage, return an empty activity list so the client can render its
  // verified-release fallback instead of turning a server fault into repeated
  // 500 responses (and, consequently, false abuse strikes against readers).
  if (typeof db.isAvailable === 'function' && !db.isAvailable()) {
    logger.warn('Recent community feed unavailable; serving verified-release fallback');
    return res.json([]);
  }

  try {
    const result = await db.query(`
      SELECT
        cp.id,
        cp.body,
        cp.platform,
        cp.created_at  AS "createdAt",
        CONCAT('Member ', UPPER(LEFT(cp.user_id::text, 4))) AS "userLabel"
      FROM community_posts cp
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

// Exchange the normal Authorization header for a single-use, short-lived SSE
// ticket. This keeps access JWTs out of URLs, proxy logs, and browser history.
router.post('/stream-ticket', requireAuth, requireVerifiedMember, streamTicketLimiter, (req, res) => {
  res.json({
    ticket: liveFeed.issueStreamTicket(req.user.id),
    expiresIn: Math.floor(liveFeed.STREAM_TICKET_TTL_MS / 1000),
  });
});

// ── GET /api/feed/stream — SSE ────────────────────────────────────────────────
router.get('/stream', (req, res) => {
  const session = liveFeed.consumeStreamTicket(req.query.ticket);
  if (!session) {
    return res.status(401).json({ error: 'Invalid or expired live-chat ticket' });
  }

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering
  res.flushHeaders();

  const userId = session.userId;
  liveFeed.register(userId, res);

  // Heartbeat every 25s to prevent proxy timeouts
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    liveFeed.unregister(userId, res);
  });
});

// ── POST /api/feed/post ───────────────────────────────────────────────────────
router.post('/post', requireAuth, requireVerifiedMember, postLimiter, postQuotaLimiter, async (req, res, next) => {
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
      userLabel: feedUserLabel(userId),
    };

    liveFeed.publish(post);
    logger.info('Feed post created', { userId, postId: post.id });
    res.status(201).json(post);
  } catch (err) {
    next(err);
  }
});

router.__test = {
  issueStreamTicket: liveFeed.issueStreamTicket,
  consumeStreamTicket: liveFeed.consumeStreamTicket,
  register: liveFeed.register,
  unregister: liveFeed.unregister,
  publishRelease: liveFeed.publishRelease,
};
module.exports = router;

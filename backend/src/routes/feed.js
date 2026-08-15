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
const crypto      = require('node:crypto');
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

const streamTicketLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  keyGenerator: (req) => `feed-ticket:${req.user?.id ?? req.ip}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many live-chat connection attempts. Please wait a moment.' },
});

const PostSchema = z.object({
  body:     z.string().min(1).max(280).trim(),
  platform: z.enum(['AMD','NVIDIA','Apple','PS5','Windows','Steam','macOS','Intel','Xbox','Switch','Discord','BattleNet','GOG']).optional(),
});

function feedUserLabel(userId) {
  return `Member ${String(userId || '').slice(0, 4).toUpperCase() || 'USER'}`;
}

// ── In-process SSE client registry ───────────────────────────────────────────
// Map<userId, Set<res>>  — multiple tabs per user supported
const _clients = new Map();
const _streamTickets = new Map();
const STREAM_TICKET_TTL_MS = 60_000;

function issueStreamTicket(userId) {
  const now = Date.now();
  for (const [ticket, record] of _streamTickets) {
    if (record.expiresAt <= now) _streamTickets.delete(ticket);
  }
  const ticket = crypto.randomBytes(32).toString('base64url');
  _streamTickets.set(ticket, { userId, expiresAt: now + STREAM_TICKET_TTL_MS });
  return ticket;
}

function consumeStreamTicket(ticket) {
  const record = _streamTickets.get(String(ticket || ''));
  _streamTickets.delete(String(ticket || ''));
  if (!record || record.expiresAt <= Date.now()) return null;
  return record;
}

function broadcast(post) {
  const payload = `data: ${JSON.stringify(post)}\n\n`;
  for (const clientSet of _clients.values()) {
    for (const res of clientSet) {
      try { res.write(payload); } catch { /* client disconnected */ }
    }
  }
}

function register(userId, res) {
  if (!_clients.has(userId)) {
    _clients.set(userId, new Set());
  }
  _clients.get(userId).add(res);
}

function unregister(userId, res) {
  _clients.get(userId)?.delete(res);
  if (_clients.get(userId)?.size === 0) {
    _clients.delete(userId);
  }
}

// ── GET /api/feed/recent — initial payload ────────────────────────────────────
router.get('/recent', async (req, res, next) => {
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
router.post('/stream-ticket', requireAuth, streamTicketLimiter, (req, res) => {
  res.json({ ticket: issueStreamTicket(req.user.id), expiresIn: Math.floor(STREAM_TICKET_TTL_MS / 1000) });
});

// ── GET /api/feed/stream — SSE ────────────────────────────────────────────────
router.get('/stream', (req, res) => {
  const session = consumeStreamTicket(req.query.ticket);
  if (!session) return res.status(401).json({ error: 'Invalid or expired live-chat ticket' });

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering
  res.flushHeaders();

  const userId = session.userId;
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
      userLabel: feedUserLabel(userId),
    };

    broadcast(post);
    logger.info('Feed post created', { userId, postId: post.id });
    res.status(201).json(post);
  } catch (err) {
    next(err);
  }
});

router.__test = { issueStreamTicket, consumeStreamTicket };
module.exports = router;

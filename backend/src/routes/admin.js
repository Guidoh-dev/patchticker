// src/routes/admin.js
// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTES — user and subscription management
//
//  All routes require:  requireAuth → requireAdmin  (role = 'admin' only)
//
//  GET  /api/admin/users              — list all users (paginated)
//  GET  /api/admin/users/:id          — single user + subscription detail
//  PATCH /api/admin/users/:id/role    — manually set role (free|pro|admin)
//  GET  /api/admin/subscriptions      — all subscriptions (paginated)
//  GET  /api/admin/stats              — aggregate counts
//
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express       = require('express');
const router        = express.Router();
const { z }         = require('zod');

const requireAuth   = require('../middleware/requireAuth');
const { requireAdmin } = require('../middleware/requireRole');
const validate      = require('../middleware/validate');
const { standardLimiter } = require('../middleware/rateLimiter');
const db            = require('../config/db');
const logger        = require('../utils/logger');
const { decrypt }   = require('../utils/encrypt');
const aiService     = require('../services/aiAnalysisService');
const cronService   = require('../services/cronService');

// All admin routes: authenticate first, then require admin role
router.use(requireAuth, requireAdmin);
router.use(standardLimiter);

// ── Pagination helper ─────────────────────────────────────────────────────────

const PaginationSchema = z.object({
  page:  z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

// ── GET /api/admin/users ──────────────────────────────────────────────────────

router.get(
  '/users',
  validate({ query: PaginationSchema }),
  async (req, res, next) => {
    if (!db.isAvailable()) {
      return res.status(503).json({ error: 'Database not available' });
    }
    try {
      const { page, limit } = req.query;
      const offset = (page - 1) * limit;

      const [rows, countRow] = await Promise.all([
        db.query(
          `SELECT u.id, u.email_encrypted, u.role, u.email_verified,
                  u.created_at, u.updated_at,
                  s.status AS sub_status,
                  s.current_period_end,
                  s.stripe_customer_id
           FROM users u
           LEFT JOIN LATERAL (
             SELECT status, current_period_end, stripe_customer_id
             FROM subscriptions
             WHERE user_id = u.id
             ORDER BY created_at DESC LIMIT 1
           ) s ON true
           ORDER BY u.created_at DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset]
        ),
        db.query('SELECT COUNT(*) AS total FROM users'),
      ]);

      const total = parseInt(countRow.rows[0].total, 10);

      const users = rows.rows.map(r => ({
        id:            r.id,
        email:         safeDecrypt(r.email_encrypted),
        role:          r.role,
        emailVerified: r.email_verified,
        createdAt:     r.created_at,
        updatedAt:     r.updated_at,
        subscription: r.sub_status ? {
          status:           r.sub_status,
          currentPeriodEnd: r.current_period_end,
          stripeCustomerId: r.stripe_customer_id,
        } : null,
      }));

      res.json({
        users,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/admin/users/:id ──────────────────────────────────────────────────

const UuidParamSchema = z.object({
  id: z.string().uuid('Invalid user ID'),
}).strict();

router.get(
  '/users/:id',
  validate({ params: UuidParamSchema }),
  async (req, res, next) => {
    if (!db.isAvailable()) return res.status(503).json({ error: 'Database not available' });
    try {
      const [userRow, subRows, tokenRow] = await Promise.all([
        db.query(
          `SELECT id, email_encrypted, role, email_verified,
                  email_verified_at, created_at, updated_at
           FROM users WHERE id = $1`,
          [req.params.id]
        ),
        db.query(
          `SELECT id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
                  status, current_period_start, current_period_end,
                  cancel_at_period_end, canceled_at, trial_end, created_at
           FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC`,
          [req.params.id]
        ),
        db.query(
          `SELECT COUNT(*) AS active_sessions
           FROM refresh_tokens
           WHERE user_id = $1 AND expires_at > now() AND replaced = FALSE`,
          [req.params.id]
        ),
      ]);

      if (userRow.rowCount === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const u = userRow.rows[0];
      res.json({
        user: {
          id:              u.id,
          email:           safeDecrypt(u.email_encrypted),
          role:            u.role,
          emailVerified:   u.email_verified,
          emailVerifiedAt: u.email_verified_at,
          createdAt:       u.created_at,
          updatedAt:       u.updated_at,
          activeSessions:  parseInt(tokenRow.rows[0].active_sessions, 10),
        },
        subscriptions: subRows.rows,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /api/admin/users/:id/role ──────────────────────────────────────────

const PatchRoleSchema = z.object({
  role: z.enum(['free', 'pro', 'admin'], { required_error: 'role is required' }),
}).strict();

router.patch(
  '/users/:id/role',
  validate({ params: UuidParamSchema, body: PatchRoleSchema }),
  async (req, res, next) => {
    if (!db.isAvailable()) return res.status(503).json({ error: 'Database not available' });
    try {
      const { id }   = req.params;
      const { role } = req.body;

      // Prevent admins from demoting themselves (safety rail)
      if (id === req.user.id && role !== 'admin') {
        return res.status(400).json({ error: 'Cannot change your own admin role' });
      }

      const result = await db.query(
        `UPDATE users SET role = $1, updated_at = now()
         WHERE id = $2
         RETURNING id, role, updated_at`,
        [role, id]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      logger.warn('[admin] User role changed', {
        targetUserId: id,
        newRole:      role,
        adminId:      req.user.id,
        adminIp:      req.ip,
      });

      res.json({ user: result.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/admin/subscriptions ──────────────────────────────────────────────

router.get(
  '/subscriptions',
  validate({ query: PaginationSchema }),
  async (req, res, next) => {
    if (!db.isAvailable()) return res.status(503).json({ error: 'Database not available' });
    try {
      const { page, limit } = req.query;
      const offset = (page - 1) * limit;

      const [rows, countRow] = await Promise.all([
        db.query(
          `SELECT s.id, s.user_id, s.stripe_customer_id, s.stripe_subscription_id,
                  s.stripe_price_id, s.status, s.current_period_end,
                  s.cancel_at_period_end, s.trial_end, s.created_at,
                  u.email_encrypted, u.role
           FROM subscriptions s
           JOIN users u ON u.id = s.user_id
           ORDER BY s.created_at DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset]
        ),
        db.query('SELECT COUNT(*) AS total FROM subscriptions'),
      ]);

      const total = parseInt(countRow.rows[0].total, 10);

      const subscriptions = rows.rows.map(r => ({
        ...r,
        email: safeDecrypt(r.email_encrypted),
        email_encrypted: undefined,
      }));

      res.json({
        subscriptions,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/admin/stats ──────────────────────────────────────────────────────

router.get('/stats', async (req, res, next) => {
  if (!db.isAvailable()) return res.status(503).json({ error: 'Database not available' });
  try {
    const [userStats, subStats, eventStats] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE role = 'free')  AS free_users,
          COUNT(*) FILTER (WHERE role = 'pro')   AS pro_users,
          COUNT(*) FILTER (WHERE role = 'admin') AS admin_users,
          COUNT(*) FILTER (WHERE email_verified) AS verified_users,
          COUNT(*)                               AS total_users,
          COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '24 hours') AS new_today,
          COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '7 days')   AS new_this_week
        FROM users
      `),
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'active')   AS active,
          COUNT(*) FILTER (WHERE status = 'trialing') AS trialing,
          COUNT(*) FILTER (WHERE status = 'past_due') AS past_due,
          COUNT(*) FILTER (WHERE status = 'canceled') AS canceled,
          COUNT(*)                                    AS total
        FROM subscriptions
      `),
      db.query(`
        SELECT COUNT(*) AS total_events,
               COUNT(*) FILTER (WHERE processed_at > now() - INTERVAL '24 hours') AS events_today
        FROM subscription_events
      `),
    ]);

    res.json({
      users:         userStats.rows[0],
      subscriptions: subStats.rows[0],
      webhookEvents: eventStats.rows[0],
      generatedAt:   new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/ai-log ─────────────────────────────────────────────────────

router.get('/ai-log', async (req, res, next) => {
  try {
    const limit    = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const updateId = req.query.updateId || undefined;
    const entries  = await aiService.getAiLog({ limit, updateId });
    res.json({ data: entries });
  } catch (err) { next(err); }
});

// ── POST /api/admin/pipeline/run — trigger full scan manually ─────────────────

router.post('/pipeline/run', async (req, res, next) => {
  try {
    const platform = req.body?.platform || null;
    logger.info('[admin] Manual pipeline trigger', { adminId: req.user.id, platform });
    // Run async — don't block the HTTP response for a 10-platform scan
    cronService.triggerManual(platform).then(summary => {
      logger.info('[admin] Manual pipeline complete', summary);
    }).catch(err => {
      logger.error('[admin] Manual pipeline error', { error: err.message });
    });
    res.json({ ok: true, message: platform ? `Pipeline triggered for ${platform}` : 'Full pipeline triggered' });
  } catch (err) { next(err); }
});

// ── GET /api/admin/pipeline/status — last run summary ────────────────────────

router.get('/pipeline/status', async (req, res, next) => {
  if (!db.isAvailable()) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const rows = await db.query(`
      SELECT platform,
             MAX(created_at)  AS last_detected,
             MAX(released_at) AS last_release,
             MAX(version)     AS latest_version,
             COUNT(*)         AS total_versions
      FROM software_updates
      GROUP BY platform
      ORDER BY platform
    `);
    res.json({ data: rows.rows });
  } catch (err) { next(err); }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeDecrypt(val) {
  if (!val) return null;
  try { return decrypt(val); } catch { return '[encrypted]'; }
}

module.exports = router;

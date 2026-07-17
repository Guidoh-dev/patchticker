// src/middleware/requireRole.js
// ─────────────────────────────────────────────────────────────────────────────
// ROLE-BASED ACCESS CONTROL MIDDLEWARE
//
// Usage:
//   router.get('/pro-feature', requireAuth, requireRole('pro'), handler)
//   router.delete('/admin-action', requireAuth, requireRole('admin'), handler)
//
// Role hierarchy:
//   admin > pro > free
//   admin can access any role-protected route.
//   pro can access 'free' and 'pro' routes.
//   free can only access 'free' routes.
//
// Always chain AFTER requireAuth — this middleware assumes req.user is set.
//
// SUBSCRIPTION VALIDATION
// ────────────────────────
//  For 'pro' routes: in addition to role check, if the DB is available we
//  cross-check subscription status. This handles edge cases where users.role
//  is 'pro' but their Stripe subscription has lapsed (webhook delivery failure).
//  If the subscription check fails, the user's role is downgraded to 'free'
//  before the 403 is returned.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const logger  = require('../utils/logger');
const db      = require('../config/db');
const { isActiveSubscription } = require('../services/subscriptionService');

// ── Role ordering ─────────────────────────────────────────────────────────────

const ROLE_RANK = { free: 0, pro: 1, admin: 2 };

/**
 * Build a middleware that requires the authenticated user to have at minimum
 * the specified role.
 *
 * @param {'free'|'pro'|'admin'} requiredRole
 * @returns {import('express').RequestHandler}
 */
function requireRole(requiredRole) {
  if (!ROLE_RANK.hasOwnProperty(requiredRole)) {
    throw new Error(`requireRole: unknown role "${requiredRole}"`);
  }

  return async function roleGuard(req, res, next) {
    // requireAuth must have run first
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const userRole = req.user.role || 'free';
    const userRank = ROLE_RANK[userRole] ?? 0;
    const required = ROLE_RANK[requiredRole];

    // Admin passes all checks
    if (userRole === 'admin') return next();

    // Role rank check
    if (userRank < required) {
      logger.warn('[requireRole] Access denied — insufficient role', {
        userId:       req.user.id,
        userRole,
        requiredRole,
        ip:           req.ip,
        path:         req.path,
      });
      return res.status(403).json({
        error:        'Forbidden',
        requiredRole,
        upgradeUrl:   `${process.env.APP_URL || ''}/pricing`,
      });
    }

    // For 'pro' routes: validate live subscription status from DB
    // Catches webhook lag / missed events that could leave role stale
    if (requiredRole === 'pro' && db.isAvailable()) {
      try {
        const result = await db.query(
          `SELECT status FROM subscriptions
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT 1`,
          [req.user.id]
        );

        if (result.rowCount === 0 || !isActiveSubscription(result.rows[0].status)) {
          // Subscription lapsed — downgrade role silently
          await db.query(
            `UPDATE users SET role = 'free', updated_at = now()
             WHERE id = $1 AND role != 'admin'`,
            [req.user.id]
          );

          logger.warn('[requireRole] Subscription not active — downgrading role', {
            userId:             req.user.id,
            subscriptionStatus: result.rows[0]?.status ?? 'none',
            ip:                 req.ip,
          });

          return res.status(403).json({
            error:      'Subscription required',
            upgradeUrl: `${process.env.APP_URL || ''}/pricing`,
          });
        }
      } catch (err) {
        // DB error: fail open (don't block the user because of a DB hiccup)
        logger.error('[requireRole] Subscription DB check failed — failing open', {
          userId:  req.user.id,
          message: err.message,
        });
        // Continue to next() — user's JWT role claim is still valid
      }
    }

    next();
  };
}

/**
 * Convenience shorthands:
 *   requirePro   — equivalent to requireRole('pro')
 *   requireAdmin — equivalent to requireRole('admin')
 */
const requirePro   = requireRole('pro');
const requireAdmin = requireRole('admin');

module.exports = { requireRole, requirePro, requireAdmin };

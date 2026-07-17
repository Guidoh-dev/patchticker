// src/routes/account.js
// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNT SETTINGS
//
//  GET    /api/account/me           — full profile (email, role, subscription)
//  PATCH  /api/account/password     — change password
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express  = require('express');
const router   = express.Router();
const { z }    = require('zod');

const requireAuth         = require('../middleware/requireAuth');
const validate            = require('../middleware/validate');
const { standardLimiter, accountMutateLimiter } = require('../middleware/rateLimiter');
const userService         = require('../services/userService');
const db                  = require('../config/db');
const { decrypt }         = require('../utils/encrypt');
const logger              = require('../utils/logger');

router.use(requireAuth, standardLimiter);

// GET /api/account/me
router.get('/me', async (req, res, next) => {
  try {
    const userId = req.user.id;
    let subscription = null;

    if (db.isAvailable()) {
      const subRow = await db.query(
        `SELECT status, current_period_end, cancel_at_period_end, trial_end, stripe_customer_id
         FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );
      if (subRow.rows[0]) subscription = subRow.rows[0];
    }

    res.json({
      data: {
        id:            req.user.id,
        email:         req.user.email,
        role:          req.user.role,
        subscription,
      },
    });
  } catch (err) { next(err); }
});

// PATCH /api/account/password
const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword:     z.string().min(8, 'New password must be at least 8 characters'),
  confirmPassword: z.string().min(1),
}).strict().refine(d => d.newPassword === d.confirmPassword, {
  message: 'Passwords do not match',
  path:    ['confirmPassword'],
});

router.patch(
  '/password',
  accountMutateLimiter,
  validate({ body: ChangePasswordSchema }),
  async (req, res, next) => {
    try {
      const { currentPassword, newPassword } = req.body;

      // Verify current password
      const user = await userService.verifyCredentials({ email: req.user.email, password: currentPassword });
      if (!user) return res.status(400).json({ error: 'Current password is incorrect' });

      await userService.updateUserPassword(req.user.id, newPassword);

      logger.info('[account] Password changed', { userId: req.user.id, ip: req.ip });
      res.json({ ok: true });
    } catch (err) { next(err); }
  }
);

module.exports = router;

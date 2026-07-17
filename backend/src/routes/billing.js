// src/routes/billing.js
// ─────────────────────────────────────────────────────────────────────────────
// BILLING ROUTES (all require authentication)
//
//  POST /api/billing/checkout    — create Stripe Checkout session → redirect URL
//  POST /api/billing/portal      — create Stripe Billing Portal session → redirect URL
//  GET  /api/billing/status      — current subscription state for the user
//  POST /api/billing/cancel      — schedule cancellation at period end
//  POST /api/billing/reactivate  — undo a scheduled cancellation
//
// SECURITY
// ─────────
//  All routes require a valid JWT (requireAuth). STRIPE_SECRET_KEY never
//  leaves the server — the frontend only receives a redirect URL or status JSON.
//
// STRIPE KEY USAGE
// ─────────────────
//  STRIPE_SECRET_KEY is accessed only inside subscriptionService.getStripe().
//  It is never imported here, never logged, and never sent to the frontend.
//  The frontend uses VITE_STRIPE_PUBLISHABLE_KEY (separate env var) for
//  Stripe.js if embedded elements are ever needed — that key is safe to expose.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router  = express.Router();
const { z }   = require('zod');

const requireAuth         = require('../middleware/requireAuth');
const validate            = require('../middleware/validate');
const { authLimiter, checkoutLimiter } = require('../middleware/rateLimiter');
const logger              = require('../utils/logger');
const {
  createCheckoutSession,
  createPortalSession,
  getSubscription,
  cancelSubscription,
  reactivateSubscription,
} = require('../services/subscriptionService');

// ── Error normaliser ──────────────────────────────────────────────────────────
// Maps known error conditions to clean HTTP responses.
// Falls through to global error handler for unexpected errors.
function handleBillingError(err, res, next) {
  if (err.message?.includes('STRIPE_SECRET_KEY') || err.message?.includes('not configured')) {
    return res.status(503).json({ error: 'Billing is not configured' });
  }
  if (err.type === 'StripeCardError') {
    return res.status(402).json({ error: err.message });
  }
  if (err.status === 404) {
    return res.status(404).json({ error: err.message });
  }
  next(err);
}

// ── POST /api/billing/checkout ────────────────────────────────────────────────
// Returns a Stripe Checkout hosted URL. The frontend does window.location.href = url.
// STRIPE_SECRET_KEY is used inside createCheckoutSession — never exposed here.

const CheckoutSchema = z.object({
  priceId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^price_/, 'Must be a valid Stripe Price ID (starts with price_)'),
}).strict();

router.post(
  '/checkout',
  requireAuth,
  authLimiter,       // per-IP limit
  checkoutLimiter,   // per-user limit (5/hr) — blocks card-testing on one account
  validate({ body: CheckoutSchema }),
  async (req, res, next) => {
    try {
      // Gate: only verified emails can initiate checkout.
      // Unverified accounts have higher chargeback risk and are more likely
      // to be bots or stolen-card testers.
      if (req.user.emailVerified === false) {
        logger.warn('[billing] Checkout blocked — email not verified', {
          userId: req.user.id, ip: req.ip,
        });
        return res.status(403).json({
          error: 'Please verify your email address before subscribing.',
          code:  'EMAIL_NOT_VERIFIED',
        });
      }

      // Pass real client IP and User-Agent to Stripe Radar fraud scoring.
      // req.ip is the actual client IP (CF-Connecting-IP if behind Cloudflare).
      const userWithContext = {
        ...req.user,
        ip:        req.ip,
        userAgent: req.headers['user-agent'] || null,
      };
      const { url, sessionId } = await createCheckoutSession(
        userWithContext,
        req.body.priceId
      );

      logger.info('[billing] Checkout session created', {
        userId:    req.user.id,
        sessionId,
        priceId:   req.body.priceId,
      });

      res.json({ url, sessionId });
    } catch (err) {
      handleBillingError(err, res, next);
    }
  }
);

// ── POST /api/billing/portal ──────────────────────────────────────────────────
// Returns a Stripe Billing Portal URL where the user can:
//   • Update their payment method
//   • View invoice history
//   • Cancel their subscription
//   • Reactivate a scheduled cancellation

router.post(
  '/portal',
  requireAuth,
  authLimiter,
  async (req, res, next) => {
    try {
      const { url } = await createPortalSession(req.user);

      logger.info('[billing] Portal session created', { userId: req.user.id });

      res.json({ url });
    } catch (err) {
      handleBillingError(err, res, next);
    }
  }
);

// ── GET /api/billing/status ───────────────────────────────────────────────────
// Returns the full subscription state needed by the frontend dashboard and
// pricing page to render the correct UI (plan badge, renewal date, etc.)

router.get(
  '/status',
  requireAuth,
  async (req, res, next) => {
    try {
      const sub = await getSubscription(req.user.id);

      res.json({
        role: req.user.role,
        subscription: sub
          ? {
              status:             sub.status,
              priceId:            sub.stripe_price_id,
              currentPeriodStart: sub.current_period_start,
              currentPeriodEnd:   sub.current_period_end,
              cancelAtPeriodEnd:  sub.cancel_at_period_end,
              canceledAt:         sub.canceled_at,
              trialEnd:           sub.trial_end,
            }
          : null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/billing/cancel ──────────────────────────────────────────────────
// Schedules the subscription to cancel at the end of the current billing period.
// The user keeps Pro access until currentPeriodEnd — no immediate access loss.
// This calls Stripe directly with the server-side key; no client involvement.

router.post(
  '/cancel',
  requireAuth,
  authLimiter,
  async (req, res, next) => {
    try {
      const result = await cancelSubscription(req.user.id);

      logger.info('[billing] Subscription cancel scheduled', {
        userId:          req.user.id,
        currentPeriodEnd: result.currentPeriodEnd,
      });

      res.json({
        message:         'Subscription will cancel at the end of the billing period',
        cancelAtPeriodEnd: result.cancelAtPeriodEnd,
        currentPeriodEnd:  result.currentPeriodEnd,
      });
    } catch (err) {
      handleBillingError(err, res, next);
    }
  }
);

// ── POST /api/billing/reactivate ──────────────────────────────────────────────
// Undoes a scheduled cancellation — sets cancel_at_period_end = false.
// Billing continues normally at the next renewal date.

router.post(
  '/reactivate',
  requireAuth,
  authLimiter,
  async (req, res, next) => {
    try {
      const result = await reactivateSubscription(req.user.id);

      logger.info('[billing] Subscription reactivated', { userId: req.user.id });

      res.json({
        message:          'Subscription reactivated — billing will continue normally',
        cancelAtPeriodEnd: result.cancelAtPeriodEnd,
      });
    } catch (err) {
      handleBillingError(err, res, next);
    }
  }
);

module.exports = router;

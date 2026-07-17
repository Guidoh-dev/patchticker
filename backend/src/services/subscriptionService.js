// src/services/subscriptionService.js
// ─────────────────────────────────────────────────────────────────────────────
// SUBSCRIPTION SERVICE — Stripe customer/subscription lifecycle + DB mirror
//
// ARCHITECTURE
// ─────────────
//  Stripe is the source of truth for billing state. This service:
//    1. Creates Stripe customers on demand (one per user, ever)
//    2. Mirrors subscription state into local DB for fast reads / RBAC checks
//    3. Provides helpers consumed by webhook handlers and billing routes
//    4. Keeps users.role in sync with Stripe subscription status
//
// STATUS → ROLE MAPPING
// ──────────────────────
//  active | trialing  →  'pro'
//  everything else    →  'free'
//  admin role is NEVER changed by this service
//
// KEY INVARIANTS
// ───────────────
//  • STRIPE_SECRET_KEY is only accessed inside getStripe() — never at module load
//  • All SQL uses $N placeholders — no string interpolation
//  • syncSubscription is idempotent — safe to call multiple times for same event
//  • fetchAndSync fetches the live subscription from Stripe then calls syncSubscription,
//    used when a webhook event only carries a subscription ID (invoices, checkout)
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const db     = require('../config/db');
const logger = require('../utils/logger');

// ── Stripe singleton — lazy-loaded so startup never throws ───────────────────
let _stripe = null;

function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || key.startsWith('REPLACE_WITH') || key.startsWith('sk_test_REPLACE')) {
    throw new Error('[subscriptionService] STRIPE_SECRET_KEY is not configured');
  }
  // apiVersion pinned — protects against breaking changes in future Stripe SDK upgrades
  _stripe = require('stripe')(key, { apiVersion: '2024-04-10' });
  return _stripe;
}

// ── Status helpers ────────────────────────────────────────────────────────────

/**
 * Map a Stripe subscription status string to a PatchTicker user role.
 * Only 'active' and 'trialing' grant Pro access.
 */
function statusToRole(stripeStatus) {
  return (stripeStatus === 'active' || stripeStatus === 'trialing') ? 'pro' : 'free';
}

/**
 * Returns true when the subscription status grants Pro feature access.
 */
function isActiveSubscription(status) {
  return status === 'active' || status === 'trialing';
}

// ── Customer management ───────────────────────────────────────────────────────

/**
 * Return an existing Stripe customer ID for this user, or create a new one.
 *
 * ONE customer per user — we check the subscriptions table first, then create
 * in Stripe and insert a placeholder row so future calls find it instantly.
 *
 * @param {{ id: string, email: string }} user
 * @returns {Promise<string>}  Stripe customer ID (cus_xxx)
 */
async function getOrCreateStripeCustomer(user) {
  if (!db.isAvailable()) {
    throw new Error('[subscriptionService] Database required for Stripe customer management');
  }

  const existing = await db.query(
    'SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1 LIMIT 1',
    [user.id]
  );
  if (existing.rowCount > 0) {
    return existing.rows[0].stripe_customer_id;
  }

  const stripe   = getStripe();
  const customer = await stripe.customers.create({
    email:    user.email,
    metadata: { patchticker_user_id: user.id },
  });

  // Placeholder row — status will be updated by the first webhook event
  await db.query(
    `INSERT INTO subscriptions (user_id, stripe_customer_id, status)
     VALUES ($1, $2, 'incomplete')
     ON CONFLICT DO NOTHING`,
    [user.id, customer.id]
  );

  logger.info('[subscription] Stripe customer created', {
    userId: user.id, customerId: customer.id,
  });

  return customer.id;
}

// ── Checkout session ──────────────────────────────────────────────────────────

/**
 * Create a Stripe Checkout session for a new or upgraded subscription.
 *
 * The session is in 'subscription' mode. On completion Stripe fires
 * checkout.session.completed → customer.subscription.created which we handle
 * in the webhook to sync state.
 *
 * @param {{ id: string, email: string }} user
 * @param {string} priceId  Stripe Price ID (price_xxx)
 * @returns {Promise<{ url: string, sessionId: string }>}
 */
/**
 * @param {{ id: string, email: string, ip?: string, userAgent?: string }} user
 * @param {string} priceId
 */
async function createCheckoutSession(user, priceId) {
  const stripe     = getStripe();
  const customerId = await getOrCreateStripeCustomer(user);

  // ── Stripe Radar fraud signals ───────────────────────────────────────────────
  // ip_address and user_agent are fed to Radar's ML model to score the session.
  // Without these, Radar has no behavioural data and card-testing goes undetected.
  // user.ip and user.userAgent are set by billing.js from req.ip / req headers.
  const radarOptions = {};
  if (user.ip)        radarOptions.ip_address = user.ip;
  if (user.userAgent) radarOptions.user_agent  = user.userAgent;

  const session = await stripe.checkout.sessions.create({
    mode:     'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],

    // success_url carries the session_id so the frontend can display a confirmation
    success_url: `${process.env.APP_URL}/#/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${process.env.APP_URL}/#/pricing?checkout=canceled`,

    subscription_data: {
      metadata: {
        patchticker_user_id: user.id,
        // Embed IP at subscription level for chargeback evidence
        signup_ip: user.ip || 'unknown',
      },
      trial_period_days: process.env.STRIPE_TRIAL_DAYS
        ? parseInt(process.env.STRIPE_TRIAL_DAYS, 10)
        : undefined,
    },

    // Radar: pass fraud signals so Stripe can score the session
    ...(Object.keys(radarOptions).length > 0 && { payment_intent_data: radarOptions }),

    allow_promotion_codes: true,

    // Keep billing address in sync (needed for tax)
    customer_update: { address: 'auto' },
  });

  logger.info('[subscription] Checkout session created', {
    userId: user.id, sessionId: session.id, priceId,
  });

  return { url: session.url, sessionId: session.id };
}

// ── Billing portal ────────────────────────────────────────────────────────────

/**
 * Create a Stripe Billing Portal session.
 * Users land here to cancel, update payment method, or view invoices.
 */
async function createPortalSession(user) {
  const stripe     = getStripe();
  const customerId = await getOrCreateStripeCustomer(user);

  const session = await stripe.billingPortal.sessions.create({
    customer:   customerId,
    return_url: `${process.env.APP_URL}/#/`,
  });

  return { url: session.url };
}

// ── Subscription management (server-side mutations) ───────────────────────────

/**
 * Cancel subscription at period end (does NOT immediately revoke access).
 * Sets cancel_at_period_end = true on the Stripe subscription.
 * The customer keeps Pro access until current_period_end.
 *
 * @param {string} userId
 * @returns {Promise<{ cancelAtPeriodEnd: boolean, currentPeriodEnd: Date | null }>}
 */
async function cancelSubscription(userId) {
  if (!db.isAvailable()) {
    throw new Error('[subscriptionService] Database required to cancel subscription');
  }

  const row = await db.query(
    `SELECT stripe_subscription_id FROM subscriptions
     WHERE user_id = $1 AND stripe_subscription_id IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );

  if (row.rowCount === 0) {
    const err = new Error('No active subscription found');
    err.status = 404;
    throw err;
  }

  const subId  = row.rows[0].stripe_subscription_id;
  const stripe = getStripe();

  const updated = await stripe.subscriptions.update(subId, {
    cancel_at_period_end: true,
  });

  // Sync immediately — don't wait for webhook
  await syncSubscription(updated);

  logger.info('[subscription] Cancellation scheduled', { userId, subscriptionId: subId });

  return {
    cancelAtPeriodEnd: updated.cancel_at_period_end,
    currentPeriodEnd:  updated.current_period_end
      ? new Date(updated.current_period_end * 1000)
      : null,
  };
}

/**
 * Reactivate a subscription that was set to cancel at period end.
 * Clears cancel_at_period_end — billing continues normally.
 *
 * @param {string} userId
 * @returns {Promise<{ cancelAtPeriodEnd: boolean }>}
 */
async function reactivateSubscription(userId) {
  if (!db.isAvailable()) {
    throw new Error('[subscriptionService] Database required to reactivate subscription');
  }

  const row = await db.query(
    `SELECT stripe_subscription_id FROM subscriptions
     WHERE user_id = $1 AND stripe_subscription_id IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );

  if (row.rowCount === 0) {
    const err = new Error('No subscription found');
    err.status = 404;
    throw err;
  }

  const subId  = row.rows[0].stripe_subscription_id;
  const stripe = getStripe();

  const updated = await stripe.subscriptions.update(subId, {
    cancel_at_period_end: false,
  });

  await syncSubscription(updated);

  logger.info('[subscription] Reactivated', { userId, subscriptionId: subId });

  return { cancelAtPeriodEnd: updated.cancel_at_period_end };
}

// ── DB reads ──────────────────────────────────────────────────────────────────

/**
 * Fetch the most recent subscription row for a user.
 * Returns null when no subscription exists or DB is unavailable.
 */
async function getSubscription(userId) {
  if (!db.isAvailable()) return null;

  const result = await db.query(
    `SELECT id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
            status, current_period_start, current_period_end,
            cancel_at_period_end, canceled_at, trial_end, created_at, updated_at
     FROM subscriptions
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId]
  );
  return result.rowCount > 0 ? result.rows[0] : null;
}

// ── Webhook helpers ───────────────────────────────────────────────────────────

/**
 * Verify the Stripe-Signature header and return the parsed event.
 * Throws if the signature is invalid — caller must return 400.
 *
 * IMPORTANT: req.body must be the raw Buffer, not a parsed object.
 * See server.js: app.use('/api/webhooks/stripe', express.raw(...))
 */
function constructWebhookEvent(rawBody, signature) {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || secret.startsWith('REPLACE_WITH')) {
    throw new Error('[subscriptionService] STRIPE_WEBHOOK_SECRET is not configured');
  }
  // stripe.webhooks.constructEvent validates HMAC-SHA256 signature + timestamp tolerance
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

/**
 * Check whether this Stripe event ID has already been recorded.
 * Returns false when DB is unavailable (fail-open — process the event).
 */
async function eventAlreadyProcessed(stripeEventId) {
  if (!db.isAvailable()) return false;
  const result = await db.query(
    'SELECT 1 FROM subscription_events WHERE stripe_event_id = $1',
    [stripeEventId]
  );
  return result.rowCount > 0;
}

/**
 * Insert a processed Stripe event into the audit log.
 * No-op when DB is unavailable.
 */
async function recordEvent(stripeEventId, eventType, userId, payload) {
  if (!db.isAvailable()) return;
  await db.query(
    `INSERT INTO subscription_events (stripe_event_id, event_type, user_id, payload_json)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (stripe_event_id) DO NOTHING`,
    [stripeEventId, eventType, userId || null, JSON.stringify(payload)]
  );
}

/**
 * Fetch a live subscription object from Stripe by ID, then sync to DB.
 *
 * Used by invoice event handlers that carry only a subscription ID string,
 * not the full subscription object. Ensures the DB always reflects the
 * current Stripe state even if subscription.updated fires out of order.
 *
 * @param {string} subscriptionId  Stripe subscription ID (sub_xxx)
 * @returns {Promise<string|null>}  userId or null
 */
async function fetchAndSync(subscriptionId) {
  try {
    const stripe = getStripe();
    const sub    = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['items.data.price'],
    });
    return syncSubscription(sub);
  } catch (err) {
    logger.error('[subscription] fetchAndSync failed', {
      subscriptionId, message: err.message,
    });
    return null;
  }
}

/**
 * Upsert a subscription row from a Stripe Subscription object and sync users.role.
 *
 * This is the single source of truth writer — called from every webhook path
 * that touches subscription state. It is deliberately idempotent.
 *
 * admin role is never touched: WHERE role != 'admin' guard on the UPDATE.
 *
 * @param {import('stripe').Stripe.Subscription} sub
 * @returns {Promise<string|null>}  userId or null
 */
async function syncSubscription(sub) {
  if (!db.isAvailable()) {
    logger.warn('[subscription] DB unavailable — cannot sync', {
      subscriptionId: sub.id, status: sub.status,
    });
    return null;
  }

  const customerId = typeof sub.customer === 'string'
    ? sub.customer
    : sub.customer?.id;

  // ── Resolve user_id ────────────────────────────────────────────────────────
  // Primary: look up via customer ID already in our subscriptions table
  // Fallback: metadata set during checkout session creation
  let userId = null;

  const custRow = await db.query(
    'SELECT user_id FROM subscriptions WHERE stripe_customer_id = $1 LIMIT 1',
    [customerId]
  );

  if (custRow.rowCount > 0) {
    userId = custRow.rows[0].user_id;
  } else {
    userId = sub.metadata?.patchticker_user_id || null;
    if (!userId) {
      logger.warn('[subscription] Cannot resolve user for customer', {
        customerId, subscriptionId: sub.id,
      });
      return null;
    }
  }

  // ── Map Stripe timestamps → JS Dates ──────────────────────────────────────
  const toDate = (ts) => (ts ? new Date(ts * 1000) : null);

  const priceId     = sub.items?.data?.[0]?.price?.id || null;
  const periodStart = toDate(sub.current_period_start);
  const periodEnd   = toDate(sub.current_period_end);
  const canceledAt  = toDate(sub.canceled_at);
  const trialEnd    = toDate(sub.trial_end);
  const newRole     = statusToRole(sub.status);

  // ── Upsert subscriptions row ───────────────────────────────────────────────
  // Conflict target: stripe_subscription_id (unique across all subscriptions).
  // On the placeholder row (no sub ID yet), a new row is inserted with the real ID.
  await db.query(
    `INSERT INTO subscriptions
       (user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
        status, current_period_start, current_period_end,
        cancel_at_period_end, canceled_at, trial_end)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (stripe_subscription_id) DO UPDATE SET
       status               = EXCLUDED.status,
       stripe_price_id      = EXCLUDED.stripe_price_id,
       current_period_start = EXCLUDED.current_period_start,
       current_period_end   = EXCLUDED.current_period_end,
       cancel_at_period_end = EXCLUDED.cancel_at_period_end,
       canceled_at          = EXCLUDED.canceled_at,
       trial_end            = EXCLUDED.trial_end,
       updated_at           = now()`,
    [userId, customerId, sub.id, priceId, sub.status,
     periodStart, periodEnd, sub.cancel_at_period_end, canceledAt, trialEnd]
  );

  // ── Sync user role — admins are never downgraded ───────────────────────────
  await db.query(
    `UPDATE users
     SET    role = $1, updated_at = now()
     WHERE  id = $2 AND role != 'admin'`,
    [newRole, userId]
  );

  logger.info('[subscription] Synced', {
    userId,
    subscriptionId:    sub.id,
    status:            sub.status,
    role:              newRole,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
  });

  return userId;
}

module.exports = {
  // Customer + session
  getOrCreateStripeCustomer,
  createCheckoutSession,
  createPortalSession,
  // Subscription mutations
  cancelSubscription,
  reactivateSubscription,
  // DB reads
  getSubscription,
  // Webhook processing
  constructWebhookEvent,
  eventAlreadyProcessed,
  recordEvent,
  fetchAndSync,
  syncSubscription,
  // Helpers
  isActiveSubscription,
  statusToRole,
};

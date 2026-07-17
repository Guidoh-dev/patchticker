// src/routes/webhooks.js
// ─────────────────────────────────────────────────────────────────────────────
// STRIPE WEBHOOK ENDPOINT
//
//  POST /api/webhooks/stripe
//
// SECURITY
// ─────────
//  Stripe-Signature is verified with stripe.webhooks.constructEvent() before
//  any processing. Invalid or missing signatures return 400 immediately.
//  Raw body is preserved via express.raw() mounted in server.js BEFORE
//  express.json() — never swap that order.
//
// IDEMPOTENCY
//  Every processed event ID is recorded in subscription_events.
//  Stripe may retry any event up to 3 days — duplicate delivery is normal.
//  The idempotency check at the top of each request ensures we process once.
//
// EVENT HANDLING STRATEGY
// ────────────────────────
//  Subscription state is ALWAYS read from the Subscription object, never
//  inferred from the invoice. This means:
//
//   customer.subscription.{created,updated,deleted}
//     → Subscription object is directly in event.data.object — sync it.
//
//   invoice.payment_succeeded / invoice.payment_failed
//     → Invoice carries only a subscription ID string.
//       We call fetchAndSync() to retrieve the live Subscription from Stripe
//       and sync, so our DB always reflects Stripe's current state.
//
//   checkout.session.completed
//     → Same pattern: session carries subscription ID, we fetch + sync.
//
// This avoids the "stale status" bug that occurs when invoice events arrive
// before or instead of subscription.updated events.
//
// RETURN CODES
//  200 — event received and processed (or duplicate-skipped)
//  400 — missing/invalid signature (Stripe will NOT retry)
//  500 — processing error (Stripe WILL retry — we want this for transient DB errors)
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router  = express.Router();

const logger = require('../utils/logger');
const {
  constructWebhookEvent,
  eventAlreadyProcessed,
  recordEvent,
  syncSubscription,
  fetchAndSync,
} = require('../services/subscriptionService');
// getStripe() accessed lazily inside dispute handler via require() to avoid
// circular dependency at module load time
const { findUserById } = require('../services/userService');
const {
  sendSubscriptionConfirm,
  sendSubscriptionCanceled,
  sendCancelScheduled,
  sendPaymentFailed,
} = require('../services/emailService');

// ── Lazy Stripe accessor (for dispute handler) ───────────────────────────────
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || key.startsWith('REPLACE_WITH')) {
    throw new Error('[webhooks] STRIPE_SECRET_KEY not configured');
  }
  return require('stripe')(key, { apiVersion: '2024-04-10' });
}

// ── POST /api/webhooks/stripe ─────────────────────────────────────────────────

router.post('/stripe', async (req, res) => {
  // ── 1. Verify signature ────────────────────────────────────────────────────
  const signature = req.headers['stripe-signature'];
  if (!signature) {
    logger.warn('[webhook] Missing Stripe-Signature header', { ip: req.ip });
    return res.status(400).json({ error: 'Missing signature' });
  }

  let event;
  try {
    event = constructWebhookEvent(req.body, signature);
  } catch (err) {
    logger.warn('[webhook] Signature verification failed', {
      message: err.message, ip: req.ip,
    });
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // ── 2. Idempotency guard ───────────────────────────────────────────────────
  try {
    if (await eventAlreadyProcessed(event.id)) {
      logger.info('[webhook] Duplicate event — skipping', {
        eventId: event.id, type: event.type,
      });
      return res.status(200).json({ received: true, duplicate: true });
    }
  } catch (err) {
    // DB unavailable: continue — better to process twice than miss an event
    logger.error('[webhook] Idempotency check failed — continuing', {
      message: err.message,
    });
  }

  logger.info('[webhook] Processing event', { eventId: event.id, type: event.type });

  let userId = null;

  try {
    switch (event.type) {

      // ── Subscription lifecycle ─────────────────────────────────────────────
      // The subscription object arrives directly — sync it immediately.

      case 'customer.subscription.created': {
        const sub = event.data.object;
        userId = await syncSubscription(sub);

        // New active subscription → send welcome email
        if (userId && sub.status === 'active') {
          const user     = await findUserById(userId).catch(() => null);
          const planName = sub.items?.data?.[0]?.price?.nickname || 'Pro';
          if (user) {
            sendSubscriptionConfirm(user.email, planName).catch((e) =>
              logger.warn('[webhook] Failed to send confirm email', { message: e.message })
            );
          }
        }
        break;
      }

      case 'customer.subscription.updated': {
        // Detect the previous values to decide whether an email is warranted
        const sub      = event.data.object;
        const prevAttr = event.data.previous_attributes || {};

        userId = await syncSubscription(sub);

        if (userId) {
          const user = await findUserById(userId).catch(() => null);
          if (user) {
            // cancel_at_period_end just flipped to true → cancellation scheduled
            if (!prevAttr.cancel_at_period_end === false && sub.cancel_at_period_end === true) {
              sendCancelScheduled(user.email, sub.current_period_end
                ? new Date(sub.current_period_end * 1000)
                : null
              ).catch((e) =>
                logger.warn('[webhook] Failed to send cancel-scheduled email', { message: e.message })
              );
            }

            // cancel_at_period_end just flipped back to false → reactivated
            if (prevAttr.cancel_at_period_end === true && sub.cancel_at_period_end === false) {
              const planName = sub.items?.data?.[0]?.price?.nickname || 'Pro';
              sendSubscriptionConfirm(user.email, planName).catch((e) =>
                logger.warn('[webhook] Failed to send reactivation email', { message: e.message })
              );
            }
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        // Hard cancellation — subscription.status is now 'canceled'
        const sub = event.data.object;
        userId = await syncSubscription(sub);

        if (userId) {
          const user = await findUserById(userId).catch(() => null);
          if (user) {
            sendSubscriptionCanceled(user.email).catch((e) =>
              logger.warn('[webhook] Failed to send canceled email', { message: e.message })
            );
          }
        }
        break;
      }

      // ── Invoice events ─────────────────────────────────────────────────────
      // Invoices carry only a subscription ID string — we fetch the live
      // subscription from Stripe and sync it to get the authoritative status.

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;

        // Only act on subscription invoices (not one-off charges)
        if (!invoice.subscription) break;

        // Belt-and-suspenders sync: subscription.updated fires alongside this
        // in most cases, but race conditions and retry scenarios can cause
        // invoice.payment_succeeded to arrive without a paired subscription event.
        userId = await fetchAndSync(invoice.subscription);

        logger.info('[webhook] Payment succeeded', {
          subscriptionId: invoice.subscription,
          customerId:     invoice.customer,
          amountPaid:     invoice.amount_paid,
          currency:       invoice.currency,
        });
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;

        if (!invoice.subscription) break;

        // Sync subscription — Stripe may have moved it to past_due
        userId = await fetchAndSync(invoice.subscription);

        logger.warn('[webhook] Payment failed', {
          subscriptionId: invoice.subscription,
          customerId:     invoice.customer,
          attemptCount:   invoice.attempt_count,
          nextAttempt:    invoice.next_payment_attempt,
        });

        // Send payment-failed email with retry info
        if (userId) {
          const user = await findUserById(userId).catch(() => null);
          if (user) {
            // Build billing portal URL for the customer to update their card.
            // We use the static portal URL format — the customer-specific session
            // is created on-demand from the frontend (POST /api/billing/portal).
            const nextRetryDate = invoice.next_payment_attempt
              ? new Date(invoice.next_payment_attempt * 1000).toLocaleDateString(
                  'en-US', { year: 'numeric', month: 'long', day: 'numeric' }
                )
              : null;

            sendPaymentFailed(user.email, {
              attemptCount:      invoice.attempt_count,
              nextRetryDate,
              updatePaymentUrl:  `${process.env.APP_URL}/#/pricing`,
            }).catch((e) =>
              logger.warn('[webhook] Failed to send payment-failed email', { message: e.message })
            );
          }
        }
        break;
      }

      // ── Checkout completed ─────────────────────────────────────────────────
      // The session object carries a subscription ID — fetch and sync the
      // full subscription so our DB is updated before the user lands on
      // the success page.

      case 'checkout.session.completed': {
        const session = event.data.object;

        if (session.mode !== 'subscription' || !session.subscription) break;

        userId = await fetchAndSync(session.subscription);

        logger.info('[webhook] Checkout session completed', {
          sessionId:      session.id,
          subscriptionId: session.subscription,
          customerId:     session.customer,
        });
        break;
      }

      // ── Chargeback / dispute opened ───────────────────────────────────────
      // A customer has disputed a charge. This is the primary chargeback signal.
      // We log it prominently, alert ops, and revoke Pro access immediately to
      // limit further exposure on a potentially fraudulent account.
      case 'charge.dispute.created': {
        const dispute  = event.data.object;
        const chargeId = dispute.charge;

        logger.warn('[webhook] CHARGEBACK: dispute opened', {
          disputeId:  dispute.id,
          chargeId,
          amount:     dispute.amount,
          currency:   dispute.currency,
          reason:     dispute.reason,
          status:     dispute.status,
        });

        // Look up the charge to find the customer, then find the user
        try {
          const stripe   = getStripe();
          const charge   = await stripe.charges.retrieve(chargeId);
          const cusId    = typeof charge.customer === 'string'
            ? charge.customer : charge.customer?.id;

          if (cusId) {
            // Revoke Pro access immediately — reinstated after dispute resolution
            const { syncSubscriptionByCustomer } = require('../services/subscriptionService');
            // If no helper, downgrade via direct DB update as fallback
            const db = require('../config/db');
            if (db.isAvailable()) {
              const row = await db.query(
                "SELECT user_id FROM subscriptions WHERE stripe_customer_id = $1 LIMIT 1",
                [cusId]
              );
              if (row.rowCount > 0) {
                const uid = row.rows[0].user_id;
                await db.query(
                  "UPDATE users SET role = 'free', updated_at = now() WHERE id = $1 AND role != 'admin'",
                  [uid]
                );
                userId = uid;
                logger.warn('[webhook] CHARGEBACK: Pro access revoked pending resolution', {
                  userId: uid, customerId: cusId, disputeId: dispute.id,
                });
              }
            }
          }
        } catch (disputeErr) {
          logger.error('[webhook] CHARGEBACK: failed to revoke access', {
            disputeId: dispute.id, message: disputeErr.message,
          });
        }

        // Alert ops via the alerting webhook (Slack/PagerDuty)
        const { alert, ALERT_TYPE } = require('../utils/alerting');
        alert(ALERT_TYPE.SECURITY, `Chargeback opened: dispute ${dispute.id}`, {
          disputeId: dispute.id,
          chargeId,
          amount:    `${(dispute.amount / 100).toFixed(2)} ${dispute.currency.toUpperCase()}`,
          reason:    dispute.reason,
        });

        break;
      }

      case 'charge.dispute.closed': {
        const dispute = event.data.object;
        logger.info('[webhook] Dispute closed', {
          disputeId: dispute.id,
          status:    dispute.status,  // 'won', 'lost', 'warning_closed'
        });
        // If won: consider re-granting Pro access manually or via admin action.
        // Automated re-grant is intentionally omitted — disputes that are 'won'
        // still warrant manual review before restoring access.
        break;
      }

      // ── Unhandled events — logged only ────────────────────────────────────
      default:
        logger.info('[webhook] Unhandled event type (no action needed)', {
          type: event.type, eventId: event.id,
        });
    }

    // ── 3. Record event in audit log ───────────────────────────────────────
    await recordEvent(event.id, event.type, userId, {
      id:         event.id,
      type:       event.type,
      objectId:   event.data?.object?.id,
      objectType: event.data?.object?.object,
    });

  } catch (err) {
    logger.error('[webhook] Event processing error', {
      eventId: event.id,
      type:    event.type,
      message: err.message,
      stack:   err.stack,
    });
    // Return 500 → Stripe retries (correct behaviour for transient failures)
    return res.status(500).json({ error: 'Processing failed' });
  }

  return res.status(200).json({ received: true });
});

module.exports = router;

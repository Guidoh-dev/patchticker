// src/services/watchlistService.js
// ─────────────────────────────────────────────────────────────────────────────
// Platform watchlist — Pro feature.
//
// Users subscribe to platforms they care about. When a new update drops or
// a score changes, we look up subscribers and fire email + optional webhook.
//
// Tables used: platform_watchlist, user_webhooks
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const db           = require('../config/db');
const emailService = require('./emailService');
const logger       = require('../utils/logger');

const { PLATFORM_KEYS: VALID_PLATFORMS, isValidPlatform } = require('../config/platformRegistry');

// ── Watchlist CRUD ────────────────────────────────────────────────────────────

async function getWatchlist(userId) {
  if (!db.isAvailable()) return [];
  const rows = await db.query(
    `SELECT platform, notify_email, notify_webhook, created_at
     FROM platform_watchlist WHERE user_id = $1 ORDER BY platform`,
    [userId]
  );
  return rows.rows;
}

async function upsertWatch(userId, platform, { notifyEmail = true, notifyWebhook = false } = {}) {
  if (!isValidPlatform(platform)) throw new Error('Invalid platform');
  if (!db.isAvailable()) throw new Error('Database unavailable');

  await db.query(
    `INSERT INTO platform_watchlist (user_id, platform, notify_email, notify_webhook)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, platform)
     DO UPDATE SET notify_email = $3, notify_webhook = $4`,
    [userId, platform, notifyEmail, notifyWebhook]
  );
}

async function removeWatch(userId, platform) {
  if (!db.isAvailable()) throw new Error('Database unavailable');
  await db.query(
    `DELETE FROM platform_watchlist WHERE user_id = $1 AND platform = $2`,
    [userId, platform]
  );
}

// ── SSRF protection ───────────────────────────────────────────────────────────
// Block webhook URLs that point to private/loopback/link-local addresses.
// Without this a Pro user could set their webhook to http://localhost:5432
// or http://169.254.169.254 (AWS metadata endpoint) and exfiltrate internal data.

const PRIVATE_IP_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,  // 172.16.0.0 – 172.31.255.255
  /^169\.254\./,                   // link-local (AWS metadata etc.)
  /^::1$/,                         // IPv6 loopback
  /^fc[0-9a-f]{2}:/i,              // IPv6 unique-local
  /^fe80:/i,                       // IPv6 link-local
  /^0\./,                          // 0.0.0.0/8
  /^fd[0-9a-f]{2}:/i,              // IPv6 ULA
];

function assertSafeWebhookUrl(rawUrl) {
  if (!rawUrl) return;

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Webhook URL is not a valid URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Webhook URLs must use HTTPS');
  }

  const hostname = parsed.hostname.toLowerCase();
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(hostname)) {
      throw new Error('Webhook URLs must point to a public internet host');
    }
  }

  // Block numeric IPv4 that wasn't caught above — anything that looks like an IP
  // but didn't match a private range is still suspicious for production webhook use.
  // We only block private ranges; public IPs are fine (CDN origins, etc.).
}

// ── Webhook settings ──────────────────────────────────────────────────────────

async function getWebhookSettings(userId) {
  if (!db.isAvailable()) return null;
  const row = await db.query(
    `SELECT webhook_url, slack_url, enabled FROM user_webhooks WHERE user_id = $1`,
    [userId]
  );
  return row.rows[0] || null;
}

async function upsertWebhookSettings(userId, { webhookUrl, slackUrl, enabled = true }) {
  if (!db.isAvailable()) throw new Error('Database unavailable');
  // SSRF: block private/loopback targets; require HTTPS
  assertSafeWebhookUrl(webhookUrl || null);
  assertSafeWebhookUrl(slackUrl   || null);
  await db.query(
    `INSERT INTO user_webhooks (user_id, webhook_url, slack_url, enabled, updated_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (user_id)
     DO UPDATE SET webhook_url=$2, slack_url=$3, enabled=$4, updated_at=now()`,
    [userId, webhookUrl || null, slackUrl || null, enabled]
  );
}

// ── Alert dispatch (called when a new update is published) ────────────────────

/**
 * Notify all subscribers watching `platform` about a new update.
 * @param {string} platform
 * @param {object} update  - { id, name, version, status, score, verdict }
 */
async function notifySubscribers(platform, update) {
  if (!db.isAvailable()) return;
  try {
    const rows = await db.query(
      `SELECT pw.user_id, pw.notify_email, pw.notify_webhook,
              uw.webhook_url, uw.slack_url, uw.enabled AS webhook_enabled
       FROM platform_watchlist pw
       LEFT JOIN user_webhooks uw ON uw.user_id = pw.user_id
       JOIN users u ON u.id = pw.user_id AND u.role IN ('pro','admin')
       WHERE pw.platform = $1`,
      [platform]
    );

    let emailsSent = 0, webhooksSent = 0;

    for (const sub of rows.rows) {
      // Email alert
      if (sub.notify_email) {
        try {
          await emailService.sendPatchAlert(sub.user_id, platform, update);
          emailsSent++;
        } catch (e) {
          logger.warn('[watchlist] Email alert failed', { userId: sub.user_id, error: e.message });
        }
      }

      // Webhook alert
      if (sub.notify_webhook && sub.webhook_enabled) {
        const url = sub.slack_url || sub.webhook_url;
        if (url) {
          try {
            await dispatchWebhook(url, platform, update);
            webhooksSent++;
          } catch (e) {
            logger.warn('[watchlist] Webhook dispatch failed', { userId: sub.user_id, error: e.message });
          }
        }
      }
    }

    logger.info('[watchlist] Notifications sent', { platform, emailsSent, webhooksSent });
  } catch (err) {
    logger.error('[watchlist] notifySubscribers error', { platform, error: err.message });
  }
}

async function dispatchWebhook(url, platform, update) {
  // Re-validate at dispatch time — defence in depth for URLs stored before SSRF check was added
  assertSafeWebhookUrl(url);
  const statusEmoji = { stable: '✅', caution: '⚠️', avoid: '🚨' }[update.status] || '📦';
  const body = url.includes('hooks.slack.com')
    ? {
        text: `${statusEmoji} *${platform}* — New update: *${update.name}*`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `${statusEmoji} *${platform}* — New update: *${update.name}* (v${update.version})\n*Status:* ${update.status.toUpperCase()} · *Score:* ${update.score}/10` } },
          { type: 'section', text: { type: 'mrkdwn', text: update.verdict || 'No verdict yet.' } },
          { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'View on PatchTicker' }, url: `${process.env.APP_URL || 'https://patchticker.app'}/#/update/${update.id}` }] },
        ],
      }
    : { platform, update: { id: update.id, name: update.name, version: update.version, status: update.status, score: update.score, verdict: update.verdict }, timestamp: new Date().toISOString() };

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Webhook HTTP ${res.status}`);
}

module.exports = { getWatchlist, upsertWatch, removeWatch, getWebhookSettings, upsertWebhookSettings, notifySubscribers };

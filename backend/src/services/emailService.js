// src/services/emailService.js
// ─────────────────────────────────────────────────────────────────────────────
// EMAIL SERVICE — Brevo API/SMTP + SendGrid/Nodemailer delivery
//
// TRANSPORT SELECTION
// ────────────────────
//  1. If BREVO_API_KEY is set    → use Brevo HTTPS Transactional Email API
//  2. If BREVO_SMTP_KEY is set   → use Brevo SMTP relay
//  3. If SENDGRID_API_KEY is set → use SendGrid SMTP relay
//  4. If SMTP_HOST is set        → use custom SMTP server
//  5. Otherwise (dev/test)       → use Ethereal (auto-created test account)
//     Ethereal messages are never delivered; preview them at ethereal.email
//
// EMAILS SENT BY THIS SERVICE
// ────────────────────────────
//  • sendVerificationEmail(email, token)  — welcome + verify link
//  • sendPasswordResetEmail(email, token) — reset link (1h TTL)
//  • sendSubscriptionConfirm(email, plan) — pro upgrade confirmation
//  • sendSubscriptionCanceled(email)      — cancellation notice
//  • sendTestEmail(email)                 — admin-only delivery smoke test
//
// SECURITY
// ─────────
//  • All links contain a cryptographically random token (32 bytes)
//  • Links are HTTPS-only in production
//  • Tokens expire quickly (verify: 24h, reset: 1h)
//  • Email content is text/html + text/plain (multi-part)
//  • No user-controlled data is interpolated unescaped into HTML
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const crypto     = require('crypto');
const nodemailer = require('nodemailer');
const https      = require('https');
const db         = require('../config/db');
const logger     = require('../utils/logger');

// ── HTML escape helper ────────────────────────────────────────────────────────
const H = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;',
}[c]));

// ── Transport factory ─────────────────────────────────────────────────────────

let _transport = null;

function brevoApiKey() {
  const key = process.env.BREVO_API_KEY;
  if (!key || key.startsWith('REPLACE_WITH')) return null;
  return key;
}

function brevoApiConfigured() {
  return !!brevoApiKey();
}

function wantsBrevo() {
  return !!(process.env.BREVO_SMTP_LOGIN || process.env.BREVO_SMTP_USER || process.env.BREVO_SMTP_KEY || process.env.SMTP_HOST === 'smtp-relay.brevo.com');
}

function brevoConfigured() {
  return !!((process.env.BREVO_SMTP_KEY && brevoUser()) ||
    (process.env.SMTP_HOST === 'smtp-relay.brevo.com' && process.env.SMTP_USER && process.env.SMTP_PASS));
}

function brevoUser() {
  return process.env.BREVO_SMTP_LOGIN || process.env.BREVO_SMTP_USER || process.env.SMTP_USER;
}

function brevoPass() {
  return process.env.BREVO_SMTP_KEY || process.env.SMTP_PASS;
}

async function getTransport() {
  if (_transport) return _transport;

  if (brevoConfigured()) {
    _transport = nodemailer.createTransport({
      host:   'smtp-relay.brevo.com',
      port:   parseInt(process.env.BREVO_SMTP_PORT || process.env.SMTP_PORT || '587', 10),
      secure: false,
      auth: {
        user: brevoUser(),
        pass: brevoPass(),
      },
    });
    logger.info('[email] Transport: Brevo SMTP relay');
    return _transport;
  }

  if (wantsBrevo()) {
    throw new Error('Brevo SMTP selected but BREVO_SMTP_LOGIN and BREVO_SMTP_KEY are not both configured');
  }

  if (process.env.SENDGRID_API_KEY) {
    _transport = nodemailer.createTransport({
      host:   'smtp.sendgrid.net',
      port:   587,
      secure: false,
      auth: {
        user: 'apikey',
        pass: process.env.SENDGRID_API_KEY,
      },
    });
    logger.info('[email] Transport: SendGrid SMTP relay');
    return _transport;
  }

  if (process.env.SMTP_HOST) {
    _transport = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth:   process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
    logger.info('[email] Transport: SMTP', { host: process.env.SMTP_HOST });
    return _transport;
  }

  // Dev fallback — Ethereal (messages viewable at https://ethereal.email)
  const testAccount = await nodemailer.createTestAccount();
  _transport = nodemailer.createTransport({
    host:   'smtp.ethereal.email',
    port:   587,
    secure: false,
    auth: { user: testAccount.user, pass: testAccount.pass },
  });
  logger.warn('[email] Transport: Ethereal test account (emails not delivered)', {
    user: testAccount.user,
  });
  return _transport;
}

// ── Config helpers ────────────────────────────────────────────────────────────

function fromAddress() {
  const name = process.env.EMAIL_FROM_NAME || 'PatchTicker';
  const addr = process.env.EMAIL_FROM_ADDRESS || 'noreply@patchticker.app';
  return `"${name}" <${addr}>`;
}

function appBaseUrl() {
  return (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function appTokenUrl(route, rawToken) {
  return `${appBaseUrl()}/#/${route}?token=${encodeURIComponent(rawToken)}`;
}

function senderObject() {
  return {
    name:  process.env.EMAIL_FROM_NAME || 'PatchTicker',
    email: process.env.EMAIL_FROM_ADDRESS || 'noreply@patchticker.app',
  };
}

function postJsonHttps(url, headers, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept':       'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
      timeout: 10000,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          return resolve({ statusCode: res.statusCode, body: parsed });
        }
        const msg = parsed.message || parsed.error || raw || `HTTP ${res.statusCode}`;
        const err = new Error(`Brevo API send failed: ${msg}`);
        err.statusCode = res.statusCode;
        err.response = parsed;
        reject(err);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Brevo API request timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getJsonHttps(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json', ...headers },
      timeout: 10000,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          return resolve({ statusCode: res.statusCode, body: parsed });
        }
        const msg = parsed.message || parsed.error || raw || `HTTP ${res.statusCode}`;
        const err = new Error(`Brevo API verification failed: ${msg}`);
        err.statusCode = res.statusCode;
        reject(err);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Brevo API verification timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function sendViaBrevoApi({ to, subject, html, text, category }) {
  const sender = senderObject();
  const response = await postJsonHttps(
    'https://api.brevo.com/v3/smtp/email',
    { 'api-key': brevoApiKey() },
    {
      sender,
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text,
      tags: category ? [category] : undefined,
    }
  );
  return {
    messageId: response.body?.messageId || response.body?.message_id || null,
    response,
    provider: 'brevo-api',
  };
}

function getEmailConfigStatus() {
  const provider = brevoApiConfigured()
    ? 'brevo-api'
    : wantsBrevo()
      ? 'brevo'
      : process.env.SENDGRID_API_KEY
        ? 'sendgrid'
        : process.env.SMTP_HOST
          ? 'smtp'
          : 'ethereal';
  const from = process.env.EMAIL_FROM_ADDRESS || 'noreply@patchticker.app';
  const configured = provider === 'brevo-api'
    ? brevoApiConfigured()
    : provider === 'brevo'
      ? brevoConfigured()
      : provider === 'sendgrid'
        ? !!process.env.SENDGRID_API_KEY
        : provider === 'smtp'
          ? !!process.env.SMTP_HOST && (!process.env.SMTP_USER || !!process.env.SMTP_PASS)
          : false;
  return {
    provider,
    from,
    fromName: process.env.EMAIL_FROM_NAME || 'PatchTicker',
    configured,
    deliverableInProduction: configured && !!from,
    brevoApi: {
      configured: brevoApiConfigured(),
      endpoint: 'https://api.brevo.com/v3/smtp/email',
    },
    brevo: {
      configured: brevoConfigured(),
      host: 'smtp-relay.brevo.com',
      port: parseInt(process.env.BREVO_SMTP_PORT || process.env.SMTP_PORT || '587', 10),
      usernameConfigured: !!brevoUser(),
    },
    sendgrid: {
      configured: !!process.env.SENDGRID_API_KEY,
      host: 'smtp.sendgrid.net',
      port: 587,
      username: 'apikey',
    },
  };
}

async function verifyEmailTransport() {
  if (process.env.NODE_ENV === 'test') return getEmailConfigStatus();
  if (brevoApiConfigured()) {
    // Presence is not proof that the key still authenticates. Keep this
    // health check read-only so it can safely run from the admin panel.
    await getJsonHttps(
      'https://api.brevo.com/v3/account',
      { 'api-key': brevoApiKey() }
    );
    return getEmailConfigStatus();
  }
  const transport = await getTransport();
  await transport.verify();
  return getEmailConfigStatus();
}

// ── Core send function ────────────────────────────────────────────────────────

function recipientHash(email) {
  return crypto.createHash('sha256').update(String(email || '').trim().toLowerCase()).digest('hex');
}

function emailQuotaLimits() {
  // Brevo Free is 300/day. Never permit an environment typo to raise the hard
  // application ceiling above that amount. Alerts are capped at 250 so account
  // verification, password reset, and billing mail retain 50 daily slots.
  const configuredGlobal = Number(process.env.EMAIL_DAILY_LIMIT || 300);
  const global = Math.max(0, Math.min(300, Number.isFinite(configuredGlobal) ? Math.floor(configuredGlobal) : 300));
  const configuredAlerts = Number(process.env.EMAIL_ALERT_DAILY_LIMIT || 250);
  const alerts = Math.max(0, Math.min(
    Math.max(0, global - 50),
    Number.isFinite(configuredAlerts) ? Math.floor(configuredAlerts) : 250
  ));
  return { global, alerts };
}

function quotaRequired() {
  return getEmailConfigStatus().provider !== 'ethereal';
}

async function reserveDailyEmailQuota(category) {
  if (!quotaRequired()) return { allowed: true, bypassed: true, globalUsed: 0, alertUsed: 0 };
  if (!db.isAvailable()) {
    const error = new Error('Email delivery paused because the durable daily quota store is unavailable');
    error.code = 'EMAIL_QUOTA_UNAVAILABLE';
    throw error;
  }
  const limits = emailQuotaLimits();
  const result = await db.query(
    `SELECT allowed, global_used, alert_used
     FROM reserve_patchticker_email_quota($1, $2, $3)`,
    [category || 'transactional', limits.global, limits.alerts]
  );
  const quota = result.rows?.[0] || {};
  if (quota.allowed !== true) {
    const error = new Error(category === 'patch_alert'
      ? `Daily patch-alert email cap reached (${limits.alerts})`
      : `Daily email cap reached (${limits.global})`);
    error.code = 'EMAIL_DAILY_LIMIT_REACHED';
    error.globalUsed = Number(quota.global_used || 0);
    error.alertUsed = Number(quota.alert_used || 0);
    throw error;
  }
  return {
    allowed: true,
    bypassed: false,
    globalUsed: Number(quota.global_used || 0),
    alertUsed: Number(quota.alert_used || 0),
    limits,
  };
}

async function logEmailDelivery({ to, subject, category, status, messageId = null, error = null }) {
  if (!db.isAvailable()) return;
  try {
    await db.query(
      `INSERT INTO email_delivery_log (recipient_hash, subject, category, provider, status, message_id, error_msg)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [recipientHash(to), String(subject || '').slice(0, 200), category || 'transactional', getEmailConfigStatus().provider, status, messageId, error ? String(error).slice(0, 500) : null]
    );
  } catch (err) {
    logger.warn('[email] Delivery log skipped', { error: err.message });
  }
}

async function send({ to, subject, html, text, category = 'transactional' }) {
  // Tests must never consume provider quota just because a developer's .env
  // contains production credentials.
  if (process.env.NODE_ENV === 'test') {
    return { messageId: 'test-noop', provider: 'test-noop' };
  }

  const safeRecipientHash = recipientHash(to).slice(0, 12);
  try {
    // Reserve before contacting a real provider. Reservations count attempts and
    // are intentionally not released after provider timeouts: the remote side
    // may have accepted an ambiguous request, so reusing that slot could exceed
    // the user's hard 300/day ceiling.
    const quota = await reserveDailyEmailQuota(category);
    if (!quota.bypassed) {
      logger.debug('[email] Daily quota reserved', {
        category,
        globalUsed: quota.globalUsed,
        globalLimit: quota.limits.global,
        alertUsed: quota.alertUsed,
        alertLimit: quota.limits.alerts,
      });
    }
    if (brevoApiConfigured()) {
      const info = await sendViaBrevoApi({ to, subject, html, text, category });
      logger.info('[email] Sent via Brevo API', { messageId: info.messageId, recipientHash: safeRecipientHash, category });
      await logEmailDelivery({ to, subject, category, status: 'sent', messageId: info.messageId || null });
      return info;
    }

    const transport = await getTransport();
    const info = await transport.sendMail({
      from:    fromAddress(),
      to,
      subject,
      html,
      text,
    });

    // Log Ethereal preview URL in dev
    const preview = nodemailer.getTestMessageUrl(info);
    if (preview) {
      logger.info('[email] Preview URL (Ethereal)', { url: preview, recipientHash: safeRecipientHash, category });
    } else {
      logger.info('[email] Sent', { messageId: info.messageId, recipientHash: safeRecipientHash, category });
    }
    await logEmailDelivery({ to, subject, category, status: 'sent', messageId: info.messageId || null });
    return info;
  } catch (err) {
    await logEmailDelivery({ to, subject, category, status: 'failed', error: err.message });
    logger.error('[email] Send failed', { message: err.message, recipientHash: safeRecipientHash, category });
    throw err;
  }
}

// ── Email templates ───────────────────────────────────────────────────────────

function wrapTemplate(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${H(title)}</title>
  <style>
    body{margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e5e5e5}
    .wrap{max-width:560px;margin:40px auto;background:#141414;border:1px solid #222;border-radius:8px;overflow:hidden}
    .header{background:#000;padding:24px 32px;border-bottom:1px solid #222}
    .header h1{margin:0;font-size:20px;font-weight:700;color:#fff;letter-spacing:.5px}
    .header h1 span{color:#16c96e}
    .body{padding:32px}
    .body p{margin:0 0 16px;line-height:1.6;color:#ccc;font-size:15px}
    .btn{display:inline-block;margin:8px 0 20px;padding:14px 28px;background:#16c96e;color:#000;text-decoration:none;border-radius:6px;font-size:15px;font-weight:700}
    .note{font-size:13px;color:#666;margin-top:4px}
    .footer{padding:20px 32px;border-top:1px solid #1a1a1a;font-size:12px;color:#555;text-align:center}
    code{background:#1e1e1e;padding:2px 6px;border-radius:3px;font-family:monospace;font-size:13px;color:#16c96e}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header"><h1><span>Patch</span>Ticker</h1></div>
    <div class="body">${bodyHtml}</div>
    <div class="footer">PatchTicker · You're receiving this because you have an account · <a href="${H(appBaseUrl())}" style="color:#555">patchticker.app</a></div>
  </div>
</body>
</html>`;
}

// ── sendVerificationEmail ──────────────────────────────────────────────────────

async function sendVerificationEmail(email, rawToken) {
  const link = appTokenUrl('verify-email', rawToken);

  const html = wrapTemplate('Verify your email — PatchTicker', `
    <p>Welcome to PatchTicker! Please verify your email address to activate your account.</p>
    <a href="${H(link)}" class="btn">Verify Email Address</a>
    <p class="note">This link expires in 24 hours.</p>
    <p>If you didn't create an account, you can safely ignore this email.</p>
    <p class="note">If the button doesn't work, copy this link into your browser:<br>
    <code>${H(link)}</code></p>
  `);

  const text = [
    'Welcome to PatchTicker!',
    '',
    'Please verify your email address by visiting:',
    link,
    '',
    'This link expires in 24 hours.',
    'If you didn\'t create an account, ignore this email.',
  ].join('\n');

  return send({ to: email, subject: 'Verify your PatchTicker email address', html, text, category: 'email_verification' });
}

// ── sendPasswordResetEmail ────────────────────────────────────────────────────

async function sendPasswordResetEmail(email, rawToken) {
  const link = appTokenUrl('reset-password', rawToken);

  const html = wrapTemplate('Reset your password — PatchTicker', `
    <p>We received a request to reset your PatchTicker password.</p>
    <a href="${H(link)}" class="btn">Reset Password</a>
    <p class="note">This link expires in 1 hour.</p>
    <p>If you didn't request a password reset, your account is safe — no changes were made.</p>
    <p class="note">If the button doesn't work, copy this link into your browser:<br>
    <code>${H(link)}</code></p>
  `);

  const text = [
    'Reset your PatchTicker password',
    '',
    'Visit this link to reset your password (expires in 1 hour):',
    link,
    '',
    'If you didn\'t request this, ignore this email — no changes were made.',
  ].join('\n');

  return send({ to: email, subject: 'Reset your PatchTicker password', html, text, category: 'password_reset' });
}

// ── sendSubscriptionConfirm ───────────────────────────────────────────────────

async function sendSubscriptionConfirm(email, planName) {
  const html = wrapTemplate('Welcome to Pro — PatchTicker', `
    <p>🎉 Your <strong>${H(planName)}</strong> subscription is now active!</p>
    <p>You now have access to all Pro features:</p>
    <p>• Real-time update alerts &nbsp;• Advanced filtering &nbsp;• Priority bug report queue &nbsp;• API access</p>
    <a href="${H(appBaseUrl())}/#/updates" class="btn">Open PatchTicker</a>
    <p>Questions? Reply to this email — we're happy to help.</p>
  `);

  const text = [
    `Your PatchTicker ${planName} subscription is now active!`,
    '',
    'You now have access to all Pro features.',
    `Open PatchTicker: ${appBaseUrl()}/#/updates`,
  ].join('\n');

  return send({ to: email, subject: `Welcome to PatchTicker ${planName}!`, html, text, category: 'subscription' });
}

// ── sendSubscriptionCanceled ──────────────────────────────────────────────────

async function sendSubscriptionCanceled(email) {
  const html = wrapTemplate('Subscription canceled — PatchTicker', `
    <p>Your PatchTicker Pro subscription has been canceled.</p>
    <p>You'll keep Pro access until the end of your current billing period.</p>
    <p>We're sorry to see you go. If there's something we could have done better, we'd love to hear from you.</p>
    <a href="${H(appBaseUrl())}/pricing" class="btn">Reactivate Pro</a>
  `);

  const text = [
    'Your PatchTicker Pro subscription has been canceled.',
    '',
    'You\'ll keep Pro access until the end of your current billing period.',
    `Reactivate: ${appBaseUrl()}/pricing`,
  ].join('\n');

  return send({ to: email, subject: 'Your PatchTicker subscription has been canceled', html, text, category: 'subscription' });
}

// (exports extended below)

// ── sendPaymentFailed ─────────────────────────────────────────────────────────

async function sendPaymentFailed(email, { attemptCount, nextRetryDate, updatePaymentUrl }) {
  const retryLine = nextRetryDate
    ? `<p>Stripe will automatically retry on <strong>${H(nextRetryDate)}</strong>.</p>`
    : '';

  const html = wrapTemplate('Payment failed — PatchTicker', `
    <p>We couldn't process your PatchTicker Pro payment${attemptCount > 1 ? ` (attempt ${H(String(attemptCount))})` : ''}.</p>
    <p>Your Pro access remains active while we retry, but please update your payment method to avoid losing access.</p>
    ${retryLine}
    <a href="${H(updatePaymentUrl)}" class="btn">Update Payment Method</a>
    <p class="note">If you have questions, reply to this email and we'll help.</p>
  `);

  const text = [
    `PatchTicker: Payment failed${attemptCount > 1 ? ` (attempt ${attemptCount})` : ''}.`,
    '',
    'Please update your payment method to keep your Pro subscription active.',
    `Update here: ${updatePaymentUrl}`,
    nextRetryDate ? `We will retry on ${nextRetryDate}.` : '',
  ].filter(Boolean).join('\n');

  return send({
    to:      email,
    subject: 'Action required: PatchTicker payment failed',
    html,
    text,
  });
}

// ── sendCancelScheduled ───────────────────────────────────────────────────────

async function sendCancelScheduled(email, periodEndDate) {
  const end = periodEndDate
    ? new Date(periodEndDate).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })
    : 'the end of your billing period';

  const html = wrapTemplate('Subscription cancellation scheduled — PatchTicker', `
    <p>We've received your request to cancel your PatchTicker Pro subscription.</p>
    <p>You'll keep full Pro access until <strong>${H(end)}</strong>. No further charges will be made after that date.</p>
    <p>Changed your mind? You can reactivate any time before ${H(end)} from your dashboard.</p>
    <a href="${H(appBaseUrl())}/#/" class="btn">Go to Dashboard</a>
  `);

  const text = [
    'Your PatchTicker Pro subscription is scheduled for cancellation.',
    `You keep Pro access until ${end}.`,
    `Reactivate any time at ${appBaseUrl()}/#/`,
  ].join('\n');

  return send({
    to:      email,
    subject: 'PatchTicker subscription cancellation scheduled',
    html,
    text,
  });
}

// ── sendPatchAlert ────────────────────────────────────────────────────────────
// Requires userId so we can look up email from the DB.
const { decrypt } = require('../utils/encrypt');

async function sendPatchAlert(userId, platform, update) {
  let email;
  if (db.isAvailable()) {
    const row = await db.query('SELECT email_encrypted FROM users WHERE id = $1', [userId]);
    if (!row.rows[0]) return;
    try { email = decrypt(row.rows[0].email_encrypted); } catch { return; }
  } else return;

  const statusEmoji = { stable: '✅', caution: '⚠️', avoid: '🚨' }[update.status] || '📦';
  const appUrl = appBaseUrl();

  const html = wrapTemplate(`${platform} update alert — PatchTicker`, `
    <p style="font-size:13px;color:#888;margin:0 0 24px">Platform alert · PatchTicker</p>
    <h2 style="margin:0 0 8px;font-size:22px">${statusEmoji} ${platform} — New Update</h2>
    <p style="font-size:18px;font-weight:700;margin:0 0 4px">${update.name}</p>
    <p style="font-size:13px;color:#888;margin:0 0 24px">v${update.version} · Score: ${update.score}/10 · ${update.status.toUpperCase()}</p>
    <p style="font-size:14px;line-height:1.6;margin:0 0 28px">${update.verdict || 'A new update has been published. Visit PatchTicker for the full analysis.'}</p>
    <a href="${appUrl}/#/update/${update.id}" style="display:inline-block;background:#fff;color:#000;padding:12px 24px;font-weight:700;font-size:13px;text-decoration:none;border-radius:4px">View Full Analysis →</a>
    <p style="font-size:11px;color:#555;margin:32px 0 0">You're receiving this because you're watching <strong>${platform}</strong> on PatchTicker. <a href="${appUrl}/#/account" style="color:#888">Manage watchlist</a></p>
  `);
  const text = `${platform} — New Update: ${update.name} (v${update.version})\nStatus: ${update.status.toUpperCase()} · Score: ${update.score}/10\n\n${update.verdict || ''}\n\nView: ${appUrl}/#/update/${update.id}`;

  return send({ to: email, subject: `[PatchTicker] ${platform} update: ${update.name}`, html, text, category: 'patch_alert' });
}


async function sendTestEmail(email) {
  const status = getEmailConfigStatus();
  const html = wrapTemplate('PatchTicker email test', `
    <p>This is a PatchTicker transactional email test.</p>
    <p>If you received this, the configured <strong>${H(status.provider)}</strong> transport can send mail from <strong>${H(status.from)}</strong>.</p>
    <p class="note">Use this before launch after setting SendGrid domain authentication and production env vars.</p>
  `);
  const text = [
    'PatchTicker email test',
    '',
    `Provider: ${status.provider}`,
    `From: ${status.from}`,
    'If you received this, transactional email delivery is working.',
  ].join('\n');
  return send({ to: email, subject: '[PatchTicker] Email delivery test', html, text, category: 'admin_test' });
}

module.exports = {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendSubscriptionConfirm,
  sendSubscriptionCanceled,
  sendPaymentFailed,
  sendCancelScheduled,
  sendPatchAlert,
  sendTestEmail,
  getEmailConfigStatus,
  verifyEmailTransport,
  _test: { appTokenUrl, recipientHash, emailQuotaLimits, reserveDailyEmailQuota },
};

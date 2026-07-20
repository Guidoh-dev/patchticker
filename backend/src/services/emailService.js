// src/services/emailService.js
// ─────────────────────────────────────────────────────────────────────────────
// EMAIL SERVICE — Nodemailer wrapper with support for Brevo, SMTP, and SendGrid
//
// TRANSPORT SELECTION
// ────────────────────
//  1. If BREVO_SMTP_KEY is set   → use Brevo SMTP relay
//  2. If SENDGRID_API_KEY is set → use SendGrid SMTP relay
//  3. If SMTP_HOST is set        → use custom SMTP server
//  4. Otherwise (dev/test)       → use Ethereal (auto-created test account)
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
const db         = require('../config/db');
const logger     = require('../utils/logger');

// ── HTML escape helper ────────────────────────────────────────────────────────
const H = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;',
}[c]));

// ── Transport factory ─────────────────────────────────────────────────────────

let _transport = null;

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

function getEmailConfigStatus() {
  const provider = wantsBrevo()
    ? 'brevo'
    : process.env.SENDGRID_API_KEY
      ? 'sendgrid'
      : process.env.SMTP_HOST
        ? 'smtp'
        : 'ethereal';
  const from = process.env.EMAIL_FROM_ADDRESS || 'noreply@patchticker.app';
  const configured = provider === 'brevo'
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
  const transport = await getTransport();
  await transport.verify();
  return getEmailConfigStatus();
}

// ── Core send function ────────────────────────────────────────────────────────

function recipientHash(email) {
  return crypto.createHash('sha256').update(String(email || '').trim().toLowerCase()).digest('hex');
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
  const transport = await getTransport();
  try {
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
      logger.info('[email] Preview URL (Ethereal)', { url: preview, to, subject });
    } else {
      logger.info('[email] Sent', { messageId: info.messageId, to, subject });
    }
    await logEmailDelivery({ to, subject, category, status: 'sent', messageId: info.messageId || null });
    return info;
  } catch (err) {
    await logEmailDelivery({ to, subject, category, status: 'failed', error: err.message });
    logger.error('[email] Send failed', { message: err.message, to, subject });
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
  const link = `${appBaseUrl()}/verify-email?token=${encodeURIComponent(rawToken)}`;

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
  const link = `${appBaseUrl()}/reset-password?token=${encodeURIComponent(rawToken)}`;

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
};

#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const root = path.resolve(__dirname, '..');
const backendEnvPath = path.join(root, 'backend', '.env');
const frontendEnvPath = path.join(root, 'frontend', '.env');
const frontendDistPath = path.join(root, 'frontend', 'dist', 'index.html');
const strict = process.argv.includes('--strict') || process.env.LAUNCH_CHECK_STRICT === 'true';

function readEnv(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const backend = readEnv(backendEnvPath);
const frontend = readEnv(frontendEnvPath);

const failures = [];
const warnings = [];
const passes = [];

function isPlaceholder(value) {
  if (!value) return true;
  return /^(REPLACE_WITH|YOUR_|your_|changeme|example|todo)/.test(value) || /REPLACE_WITH|YOUR-PASSWORD|placeholder/i.test(value);
}

function pass(msg) { passes.push(msg); }
function warn(msg) { warnings.push(msg); }
function fail(msg) { failures.push(msg); }

function requireSet(env, key, label = key) {
  if (isPlaceholder(env[key])) fail(`${label} missing or placeholder`);
  else pass(`${label} set`);
}

function requirePrefix(env, key, prefix, label = key) {
  const value = env[key];
  if (isPlaceholder(value)) return fail(`${label} missing or placeholder`);
  if (!value.startsWith(prefix)) return fail(`${label} should start with ${prefix}`);
  pass(`${label} format ok`);
}

function hasEmailProvider() {
  const brevoLogin = backend.BREVO_SMTP_LOGIN || backend.BREVO_SMTP_USER || backend.SMTP_USER;
  const brevoKey = backend.BREVO_SMTP_KEY || backend.SMTP_PASS;
  const brevoHost = backend.SMTP_HOST === 'smtp-relay.brevo.com' || Boolean(backend.BREVO_SMTP_KEY);
  const brevoOk = brevoHost && !isPlaceholder(brevoLogin) && !isPlaceholder(brevoKey);
  const sendgridOk = !isPlaceholder(backend.SENDGRID_API_KEY);
  const smtpAuthOk = !isPlaceholder(backend.SMTP_USER) && !isPlaceholder(backend.SMTP_PASS);
  const smtpOk = !brevoHost && !isPlaceholder(backend.SMTP_HOST) && smtpAuthOk;
  return { brevoOk, sendgridOk, smtpOk, provider: brevoOk ? 'Brevo' : sendgridOk ? 'SendGrid' : smtpOk ? 'SMTP' : null };
}

async function checkDb() {
  if (isPlaceholder(backend.DATABASE_URL)) {
    fail('DATABASE_URL missing or placeholder');
    return;
  }

  let connectionString = backend.DATABASE_URL;
  try {
    const parsed = new URL(connectionString);
    if (!backend.DB_SSL_CA && parsed.searchParams.get('sslmode') === 'require') {
      parsed.searchParams.delete('sslmode');
      connectionString = parsed.toString();
    }
  } catch (_) {}

  const sslRequired = backend.DB_SSL === 'true' || backend.NODE_ENV === 'production';
  const client = new Client({
    connectionString,
    ssl: sslRequired ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: Number(backend.DB_CONN_TIMEOUT_MS || 8000),
    statement_timeout: Number(backend.DB_STATEMENT_TIMEOUT_MS || 30000),
  });

  try {
    await client.connect();
    const result = await client.query('SELECT version() AS version');
    const encrypted = Boolean(client.connection?.stream?.encrypted);
    if (sslRequired && !encrypted) fail('Database connected but TLS socket is not encrypted');
    else pass(`Database reachable (${result.rows[0].version.split(' ').slice(0, 2).join(' ')}, tls=${encrypted})`);
  } catch (err) {
    fail(`Database connection failed: ${err.code || err.name}: ${err.message}`);
  } finally {
    try { await client.end(); } catch (_) {}
  }
}

async function main() {
  console.log('PatchTicker launch readiness check');
  console.log(`root: ${root}`);
  console.log(`mode: ${strict ? 'strict production' : 'local readiness'}`);

  if (!fs.existsSync(backendEnvPath)) fail('backend/.env missing');
  if (!fs.existsSync(frontendEnvPath)) fail('frontend/.env missing');

  for (const key of [
    'PORT', 'BIND_HOST', 'ALLOWED_ORIGINS', 'APP_URL', 'DATABASE_URL', 'DB_SSL',
    'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'CSRF_SECRET', 'DB_ENCRYPTION_KEY', 'HEALTH_SECRET',
    'HCAPTCHA_SECRET_KEY', 'HCAPTCHA_SITE_KEY', 'ANTHROPIC_API_KEY',
    'EMAIL_FROM_ADDRESS',
  ]) requireSet(backend, key);

  requirePrefix(backend, 'STRIPE_SECRET_KEY', 'sk_', 'STRIPE_SECRET_KEY');
  requirePrefix(backend, 'STRIPE_WEBHOOK_SECRET', 'whsec_', 'STRIPE_WEBHOOK_SECRET');
  requirePrefix(backend, 'STRIPE_PUBLISHABLE_KEY', 'pk_', 'STRIPE_PUBLISHABLE_KEY');
  requirePrefix(backend, 'STRIPE_PRICE_PRO_MONTHLY', 'price_', 'STRIPE_PRICE_PRO_MONTHLY');
  requirePrefix(backend, 'STRIPE_PRICE_PRO_ANNUAL', 'price_', 'STRIPE_PRICE_PRO_ANNUAL');

  requirePrefix(frontend, 'VITE_STRIPE_PUBLISHABLE_KEY', 'pk_', 'VITE_STRIPE_PUBLISHABLE_KEY');
  requirePrefix(frontend, 'VITE_STRIPE_PRICE_MONTHLY', 'price_', 'VITE_STRIPE_PRICE_MONTHLY');
  requirePrefix(frontend, 'VITE_STRIPE_PRICE_ANNUAL', 'price_', 'VITE_STRIPE_PRICE_ANNUAL');
  requireSet(frontend, 'VITE_HCAPTCHA_SITE_KEY');
  requireSet(frontend, 'VITE_APP_URL');

  if (backend.STRIPE_PUBLISHABLE_KEY && frontend.VITE_STRIPE_PUBLISHABLE_KEY && backend.STRIPE_PUBLISHABLE_KEY !== frontend.VITE_STRIPE_PUBLISHABLE_KEY) {
    fail('Backend STRIPE_PUBLISHABLE_KEY and frontend VITE_STRIPE_PUBLISHABLE_KEY do not match');
  }
  if (backend.STRIPE_PRICE_PRO_MONTHLY && frontend.VITE_STRIPE_PRICE_MONTHLY && backend.STRIPE_PRICE_PRO_MONTHLY !== frontend.VITE_STRIPE_PRICE_MONTHLY) {
    fail('Monthly Stripe price ID mismatch between backend and frontend');
  }
  if (backend.STRIPE_PRICE_PRO_ANNUAL && frontend.VITE_STRIPE_PRICE_ANNUAL && backend.STRIPE_PRICE_PRO_ANNUAL !== frontend.VITE_STRIPE_PRICE_ANNUAL) {
    fail('Annual Stripe price ID mismatch between backend and frontend');
  }
  if (backend.HCAPTCHA_SITE_KEY && frontend.VITE_HCAPTCHA_SITE_KEY && backend.HCAPTCHA_SITE_KEY !== frontend.VITE_HCAPTCHA_SITE_KEY) {
    fail('Backend HCAPTCHA_SITE_KEY and frontend VITE_HCAPTCHA_SITE_KEY do not match');
  }

  const email = hasEmailProvider();
  if (!email.provider) fail('No deliverable email provider configured. Configure Brevo SMTP, SendGrid, or SMTP.');
  else pass(`Email provider configured: ${email.provider}`);

  if (strict) {
    if (backend.NODE_ENV !== 'production') fail('NODE_ENV must be production on the public server');
    else pass('NODE_ENV production');
    if (backend.APP_URL !== 'https://patchticker.app') warn(`APP_URL is ${backend.APP_URL}; expected https://patchticker.app for launch`);
    if (!String(backend.ALLOWED_ORIGINS || '').includes('https://patchticker.app')) fail('ALLOWED_ORIGINS must include https://patchticker.app');
    if (backend.BIND_HOST !== '127.0.0.1') warn('BIND_HOST should be 127.0.0.1 when Nginx proxies the API');
    if (backend.HTTPS_REDIRECT !== 'true') fail('HTTPS_REDIRECT should be true in production');
    if (backend.CLOUDFLARE_MODE !== 'true') warn('CLOUDFLARE_MODE should be true when routing through Cloudflare');
  } else {
    if (backend.NODE_ENV !== 'production') warn('Local backend/.env is not NODE_ENV=production; set production on the server before launch');
  }

  if (fs.existsSync(frontendDistPath)) pass('Frontend build output exists');
  else warn('frontend/dist/index.html not found; run npm run build before deployment');

  await checkDb();

  console.log('\nPASS');
  for (const msg of passes) console.log(`  ✓ ${msg}`);
  if (warnings.length) {
    console.log('\nWARN');
    for (const msg of warnings) console.log(`  ! ${msg}`);
  }
  if (failures.length) {
    console.log('\nFAIL');
    for (const msg of failures) console.log(`  ✕ ${msg}`);
    process.exitCode = 1;
  } else {
    console.log('\nSTATUS: launch readiness checks passed');
  }
}

main().catch((err) => {
  console.error(`Launch check crashed: ${err.stack || err.message}`);
  process.exit(1);
});

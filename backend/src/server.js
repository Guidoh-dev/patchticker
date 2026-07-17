// src/server.js
// PatchTicker — Express entry point
//
// MIDDLEWARE EXECUTION ORDER (must not be reordered without reason)
// ═══════════════════════════════════════════════════════════════════
//
//  1.  trust proxy              — resolves req.ip from X-Forwarded-For
//                                 before ANY middleware reads it
//
//  1.5 cloudflare               — when CLOUDFLARE_MODE=true:
//                                 • overrides req.ip with CF-Connecting-IP
//                                   (authoritative real client IP, not spoofable)
//                                 • parses CF-Visitor for HTTPS scheme detection
//                                 • optionally validates socket IP is a CF range
//                                 Must run after trust proxy, before everything else
//
//  2.  httpsRedirect            — short-circuits HTTP → HTTPS before
//                                 anything else touches the request.
//                                 Reads req.cfVisitor (set by cloudflare middleware)
//                                 to detect the real scheme behind Cloudflare.
//
//  3.  securityHeaders          — Helmet + extras on every response
//
//  4.  corsMiddleware           — OPTIONS preflight handled before requestGuard
//
//  5.  accessLogAnalyser        — registers res.on('finish') listener early
//
//  6.  httpLogger (Morgan)      — logs each request/response pair
//
//  7.  cookieParser             — before CSRF and auth cookie reads
//
//  8.  abuseDetector            — blacklist check + 429 interception
//
//  9.  suspiciousActivityDetector — pattern analysis (UA, path probing, injection)
//
//  10. requestGuard             — method allowlist, null bytes, path traversal,
//                                 Content-Type enforcement, body-size pre-check
//
//  11. express.json / urlencoded — body parsing after guard approves request
//
//  12. standardLimiter          — 100 req/15 min baseline
//
//  13. routes                   — application logic

'use strict';

require('dotenv').config();

// Load and validate security config at startup — throws if misconfigured
const cfg = require('./config/security');

const express      = require('express');
const cookieParser = require('cookie-parser');

const securityHeaders              = require('./middleware/securityHeaders');
const httpsRedirect                = require('./middleware/httpsRedirect');
const corsMiddleware               = require('./middleware/cors');
const { httpLogger, accessLogAnalyser } = require('./middleware/httpLogger');
const abuseDetector                = require('./middleware/abuseDetector');
const suspiciousActivityDetector   = require('./middleware/suspiciousActivityDetector');
const requestGuard                 = require('./middleware/requestGuard');
const { standardLimiter }          = require('./middleware/rateLimiter');
const { errorHandler, notFound }   = require('./middleware/errorHandler');
const { requestId: attachRequestId } = require('./middleware/requestId');
const logger = require('./utils/logger');
const db     = require('./config/db');
const { alert, ALERT_TYPE }          = require('./utils/alerting');

const cloudflare       = require('./middleware/cloudflare');

const healthRouter     = require('./routes/health');
const updatesRouter    = require('./routes/updates');
const bugReportsRouter = require('./routes/bugReports');
const authRouter       = require('./routes/auth');
const billingRouter    = require('./routes/billing');
const webhooksRouter   = require('./routes/webhooks');
const adminRouter      = require('./routes/admin');
const cronService    = require('./services/cronService');
const watchlistRouter  = require('./routes/watchlist');
const ratingsRouter    = require('./routes/ratings');
const accountRouter    = require('./routes/account');

const app = express();

// ── 1. Proxy trust ────────────────────────────────────────────────────────────
app.set('trust proxy', cfg.TRUST_PROXY);
app.disable('x-powered-by'); // belt-and-suspenders over Helmet's hidePoweredBy

// ── 1.5. Request ID ──────────────────────────────────────────────────────────
// Attach a UUID to every request before any other middleware reads req.ip.
// Creates req.log (child logger with requestId pre-bound).
app.use(attachRequestId);

// ── 1.5. Cloudflare middleware ────────────────────────────────────────────────
// Self-disables when CLOUDFLARE_MODE=false. When enabled:
//   • Overrides req.ip with CF-Connecting-IP (real client IP, cannot be spoofed)
//   • Parses CF-Visitor JSON for HTTPS scheme detection
//   • Optionally rejects non-Cloudflare IPs (CLOUDFLARE_VALIDATE_IPS=true)
// Must run after trust proxy is applied and before every other middleware.
app.use(cloudflare);

// ── 2. HTTPS redirect ─────────────────────────────────────────────────────────
app.use(httpsRedirect);

// ── 3. Security headers ───────────────────────────────────────────────────────
app.use(...securityHeaders);

// ── 4. CORS ───────────────────────────────────────────────────────────────────
app.use(corsMiddleware);

// ── 5. Post-response log analyser ─────────────────────────────────────────────
// Registers res.on('finish') early so the listener fires on every response,
// including those short-circuited by later middleware (403, 429, 400, etc.)
app.use(accessLogAnalyser);

// ── 6. HTTP access logger ─────────────────────────────────────────────────────
app.use(httpLogger);

// ── 7. Cookie parser ──────────────────────────────────────────────────────────
app.use(cookieParser());

// ── 8. Abuse detector (blacklist + 429 interception) ─────────────────────────
app.use(abuseDetector);

// ── 9. Suspicious activity detector ──────────────────────────────────────────
app.use(suspiciousActivityDetector);

// ── 10. Request firewall ──────────────────────────────────────────────────────
app.use(requestGuard);

// ── 11. Body parsing ──────────────────────────────────────────────────────────
// Stripe webhooks need the raw body for signature verification — mount BEFORE
// express.json() so the raw Buffer is preserved on this specific path.
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json', limit: '512kb' }));

app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));

// ── 12. Global rate limit ─────────────────────────────────────────────────────
app.use('/api/', standardLimiter);

// ── 13. Routes ────────────────────────────────────────────────────────────────
app.use('/api/health',      healthRouter);
app.use('/api/auth',        authRouter);
app.use('/api/billing',     billingRouter);
app.use('/api/webhooks',    webhooksRouter);
app.use('/api/updates',     updatesRouter);
app.use('/api/bug-reports', bugReportsRouter);
app.use('/api/admin',       adminRouter);
app.use('/api/feed',        feedRouter);
app.use('/api/watchlist',   watchlistRouter);
app.use('/api/ratings',     ratingsRouter);
app.use('/api/account',     accountRouter);

// ── 404 & global error handler ────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  // Run DB health check before accepting traffic.
  // Verifies SSL is active in production and the pool can connect.
  db.healthCheck()
    .then(() => {
      app.listen(cfg.PORT, cfg.BIND_HOST, () => {
        logger.info(`PatchTicker API on ${cfg.BIND_HOST}:${cfg.PORT} [${cfg.NODE_ENV}]`);
        logger.info(`Allowed origins: ${cfg.ALLOWED_ORIGINS.join(', ') || '(none)'}`);
        logger.info(`HTTPS redirect: ${cfg.HTTPS_REDIRECT}`);
        logger.info(`HSTS max-age: ${cfg.HSTS_MAX_AGE}s | preload: ${cfg.HSTS_PRELOAD}`);
        logger.info(`Trust proxy: ${cfg.TRUST_PROXY}`);
        logger.info(`Cloudflare mode: ${cfg.CLOUDFLARE_MODE} | validate IPs: ${cfg.CLOUDFLARE_VALIDATE_IPS}`);
        logger.info(`Environment: isProd=${cfg.isProd} | isDev=${cfg.isDev} | isTest=${cfg.isTest}`);

        // Start live data pipeline cron jobs
        cronService.start();
      });
    })
    .catch((err) => {
      logger.error('DB health check failed — refusing to start', { message: err.message });
      alert(ALERT_TYPE.STARTUP_FAILURE, 'Server failed to start — DB health check failed', {
        error: err.message,
      });
      // Give the alert webhook a moment to dispatch before exiting
      setTimeout(() => process.exit(1), 500);
    });
}

// ── Process-level error handlers ──────────────────────────────────────────────
process.on('SIGTERM', async () => {
  logger.info('SIGTERM — shutting down gracefully');
  cronService.stop();
  await db.shutdown();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — process will exit', {
    errorName: err.name, message: err.message, stack: err.stack,
  });
  alert(ALERT_TYPE.CRASH, `Uncaught exception: ${err.message}`, {
    errorName: err.name,
    stack:     err.stack?.split('\n').slice(0, 5).join(' | '),
  });
  // Brief delay so logger/alert can flush before exit
  setTimeout(() => process.exit(1), 500);
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack   = reason instanceof Error ? reason.stack   : undefined;
  logger.error('Unhandled promise rejection', { message, stack });
  alert(ALERT_TYPE.CRASH, `Unhandled rejection: ${message}`, {
    stack: stack?.split('\n').slice(0, 5).join(' | '),
  });
});

module.exports = app;

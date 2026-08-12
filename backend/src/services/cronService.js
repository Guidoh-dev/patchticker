// src/services/cronService.js
// ─────────────────────────────────────────────────────────────────────────────
// CRON SCHEDULER — runs the live data pipeline on a schedule
//
// Schedule:
//   On production startup — catch-up scan (covers hosts that sleep)
//   Every 6 hours         — full platform scan (all tracked platforms)
//   Every 2 hours         — drivers, Steam, and launcher/client platforms
//   Every 1 hour          — security-priority platforms (Windows, Apple, macOS)
//
// The 1-hour scan for security platforms ensures zero-days and critical
// security patches (like Apple WebKit exploits) are surfaced quickly.
//
// node-cron expression format: second(opt) minute hour dom month dow
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const cron            = require('node-cron');
const logger          = require('../utils/logger');
const pipelineService = require('./pipelineService');
const { SECURITY_PLATFORM_KEYS, HIGH_VELOCITY_PLATFORM_KEYS } = require('../config/platformRegistry');

let _fullScanJob     = null;
let _fastScanJob     = null;
let _securityScanJob = null;
let _startupScanTimer= null;
let _isRunning       = false;
let _lastManualRun    = null;

// ── Security-priority platforms — scanned hourly ──────────────────────────────
const SECURITY_PLATFORMS = SECURITY_PLATFORM_KEYS;
const HIGH_VELOCITY_PLATFORMS = HIGH_VELOCITY_PLATFORM_KEYS;

async function runTargetedScan(label, platforms) {
  if (_isRunning) {
    logger.info(`[cron] Skipping ${label} scan — pipeline already running`);
    return;
  }
  _isRunning = true;
  logger.info(`[cron] ${label} scan starting`, { platforms });
  try {
    const { processPlatform } = pipelineService;
    const results = await Promise.allSettled(
      platforms.map(p => processPlatform(p))
    );
    const newUpdates = results.filter(
      r => r.status === 'fulfilled' && r.value.status === 'new_update'
    ).length;
    const unavailable = results.filter(
      r => r.status === 'fulfilled' && r.value.status === 'source_unavailable'
    ).length;
    const regressed = results.filter(
      r => r.status === 'fulfilled' && r.value.status === 'source_regression'
    ).length;
    const historicalRefreshes = results.filter(
      r => r.status === 'fulfilled' && r.value.status === 'historical_refresh'
    ).length;
    const failed = results.filter(r => r.status === 'rejected').length;
    logger.info(`[cron] ${label} scan complete`, { newUpdates, historicalRefreshes, regressed, unavailable, failed });
  } catch (err) {
    logger.error(`[cron] ${label} scan error`, { error: err.message });
  } finally {
    _isRunning = false;
  }
}

async function runSecurityScan() {
  return runTargetedScan('Security', SECURITY_PLATFORMS);
}

async function runFastScan() {
  return runTargetedScan('High-velocity', HIGH_VELOCITY_PLATFORMS);
}

async function runFullScan() {
  if (_isRunning) {
    logger.info('[cron] Skipping full scan — already running');
    return;
  }
  _isRunning = true;
  logger.info('[cron] Full pipeline scan starting');
  try {
    const summary = await pipelineService.runAll();
    logger.info('[cron] Full scan complete', summary);
  } catch (err) {
    logger.error('[cron] Full scan error', { error: err.message });
  } finally {
    _isRunning = false;
  }
}

// ── Start / stop ──────────────────────────────────────────────────────────────

function start() {
  if (_fullScanJob || _fastScanJob || _securityScanJob) {
    logger.warn('[cron] Already started — skipping');
    return;
  }

  // Security-priority platforms: every hour at minute 5
  // "5 * * * *" = at :05 of every hour
  _securityScanJob = cron.schedule('5 * * * *', runSecurityScan, {
    scheduled: true,
    timezone:  'UTC',
  });

  // High-velocity clients and drivers: every two hours at minute 25.
  _fastScanJob = cron.schedule('25 */2 * * *', runFastScan, {
    scheduled: true,
    timezone:  'UTC',
  });

  // Full scan: every 6 hours at minute 15
  // "15 */6 * * *" = at :15 past every 6th hour
  _fullScanJob = cron.schedule('15 */6 * * *', runFullScan, {
    scheduled: true,
    timezone:  'UTC',
  });

  const isProduction = process.env.NODE_ENV === 'production';
  const startupScanEnabled = process.env.PIPELINE_SCAN_ON_STARTUP === 'true'
    || (isProduction && process.env.PIPELINE_SCAN_ON_STARTUP !== 'false');
  if (startupScanEnabled) {
    const delayMs = Math.max(1000, Number(process.env.PIPELINE_STARTUP_SCAN_DELAY_MS || 15000));
    _startupScanTimer = setTimeout(() => {
      _startupScanTimer = null;
      runFullScan().catch(err => logger.error('[cron] Startup catch-up scan error', { error: err.message }));
    }, delayMs);
    _startupScanTimer.unref?.();
  }

  logger.info('[cron] Scheduler started', {
    securityScan: 'every hour at :05',
    highVelocityScan: 'every 2 hours at :25',
    fullScan:     'every 6 hours at :15',
    startupCatchUp: startupScanEnabled,
  });
}

function stop() {
  _fullScanJob?.stop();
  _fastScanJob?.stop();
  _securityScanJob?.stop();
  if (_startupScanTimer) clearTimeout(_startupScanTimer);
  _fullScanJob     = null;
  _fastScanJob     = null;
  _securityScanJob = null;
  _startupScanTimer= null;
  logger.info('[cron] Scheduler stopped');
}

// ── Manual trigger (used by admin route) ─────────────────────────────────────

async function triggerManual(platform = null) {
  if (_isRunning) {
    const err = new Error('Pipeline is already running');
    err.code = 'PIPELINE_RUNNING';
    throw err;
  }

  _isRunning = true;
  const startedAt = new Date().toISOString();
  try {
    const summary = platform
      ? await pipelineService.processPlatform(platform)
      : await pipelineService.runAll();
    _lastManualRun = { ok: true, platform, startedAt, finishedAt: new Date().toISOString(), summary };
    return summary;
  } catch (err) {
    _lastManualRun = { ok: false, platform, startedAt, finishedAt: new Date().toISOString(), error: err.message };
    throw err;
  } finally {
    _isRunning = false;
  }
}

function getPipelineRuntimeState() {
  return { isRunning: _isRunning, lastManualRun: _lastManualRun };
}

module.exports = { start, stop, triggerManual, getPipelineRuntimeState };

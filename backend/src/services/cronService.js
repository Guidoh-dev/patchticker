// src/services/cronService.js
// ─────────────────────────────────────────────────────────────────────────────
// CRON SCHEDULER — runs the live data pipeline on a schedule
//
// Schedule:
//   Every 6 hours  — full platform scan (all 10 platforms)
//   Every 1 hour   — security-priority platforms only (Windows, Apple, macOS)
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
const { SECURITY_PLATFORM_KEYS } = require('../config/platformRegistry');

let _fullScanJob     = null;
let _securityScanJob = null;
let _isRunning       = false;
let _lastManualRun    = null;

// ── Security-priority platforms — scanned hourly ──────────────────────────────
const SECURITY_PLATFORMS = SECURITY_PLATFORM_KEYS;

async function runSecurityScan() {
  if (_isRunning) {
    logger.info('[cron] Skipping security scan — pipeline already running');
    return;
  }
  logger.info('[cron] Security scan starting', { platforms: SECURITY_PLATFORMS });
  try {
    const { processPlatform } = pipelineService;
    const results = await Promise.allSettled(
      SECURITY_PLATFORMS.map(p => processPlatform(p))
    );
    const newUpdates = results.filter(
      r => r.status === 'fulfilled' && r.value.status === 'new_update'
    ).length;
    logger.info('[cron] Security scan complete', { newUpdates });
  } catch (err) {
    logger.error('[cron] Security scan error', { error: err.message });
  }
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
  if (_fullScanJob || _securityScanJob) {
    logger.warn('[cron] Already started — skipping');
    return;
  }

  // Security-priority platforms: every hour at minute 5
  // "5 * * * *" = at :05 of every hour
  _securityScanJob = cron.schedule('5 * * * *', runSecurityScan, {
    scheduled: true,
    timezone:  'UTC',
  });

  // Full scan: every 6 hours at minute 15
  // "15 */6 * * *" = at :15 past every 6th hour
  _fullScanJob = cron.schedule('15 */6 * * *', runFullScan, {
    scheduled: true,
    timezone:  'UTC',
  });

  logger.info('[cron] Scheduler started', {
    securityScan: 'every hour at :05',
    fullScan:     'every 6 hours at :15',
  });
}

function stop() {
  _fullScanJob?.stop();
  _securityScanJob?.stop();
  _fullScanJob     = null;
  _securityScanJob = null;
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

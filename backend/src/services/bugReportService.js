// src/services/bugReportService.js
// ─────────────────────────────────────────────────────────────────────────────
// BUG REPORT STORE — PostgreSQL backend with field-level encryption
//
// description and user_agent are user-supplied free text — encrypted at rest
// using AES-256-GCM. The update_id and severity are enum values validated by
// Zod before reaching this service — no free-text SQL risk.
//
// All DB operations use parameterized queries.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const logger          = require('../utils/logger');
const db              = require('../config/db');
const { encrypt, decrypt, encryptNullable, decryptNullable } = require('../utils/encrypt');
const { VALID_PLATFORMS, VALID_SEVERITIES } = require('../validators/schemas');

// ── In-memory fallback ────────────────────────────────────────────────────────
const _reports = [];
let   _nextId  = 1;

// ── Row mapping ───────────────────────────────────────────────────────────────

function rowToReport(row) {
  return {
    id:          row.id,
    updateId:    row.update_id,
    severity:    row.severity,
    description: decrypt(row.description_encrypted),
    userAgent:   decryptNullable(row.user_agent_encrypted) || 'unknown',
    createdAt:   row.created_at.toISOString(),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

async function createReport({ updateId, severity, description, userAgent }) {
  if (!VALID_PLATFORMS.includes(updateId)) {
    const err = new Error(`Unknown update ID: ${updateId}`);
    err.status = 400;
    throw err;
  }

  const descEncrypted = encrypt(description);
  const uaEncrypted   = encryptNullable(
    typeof userAgent === 'string' ? userAgent.slice(0, 200) : null
  );

  if (db.isAvailable()) {
    const result = await db.query(
      `INSERT INTO bug_reports (update_id, severity, description_encrypted, user_agent_encrypted)
       VALUES ($1, $2, $3, $4)
       RETURNING id, update_id, severity, description_encrypted, user_agent_encrypted, created_at`,
      [updateId, severity, descEncrypted, uaEncrypted]
    );
    const report = rowToReport(result.rows[0]);
    logger.info('Bug report submitted', { updateId, severity, reportId: report.id });
    return report;
  }

  // ── In-memory fallback ────────────────────────────────────────────────────
  const report = {
    id:                     _nextId++,
    update_id:              updateId,
    severity,
    description_encrypted:  descEncrypted,
    user_agent_encrypted:   uaEncrypted,
    created_at:             new Date(),
  };
  _reports.push(report);
  const mapped = rowToReport(report);
  logger.info('Bug report submitted (in-memory)', { updateId, severity, reportId: mapped.id });
  return mapped;
}

async function getReportsByUpdateId(updateId) {
  if (db.isAvailable()) {
    const result = await db.query(
      `SELECT id, update_id, severity, description_encrypted, user_agent_encrypted, created_at
       FROM bug_reports WHERE update_id = $1
       ORDER BY created_at DESC`,
      [updateId]
    );
    return result.rows.map(rowToReport);
  }
  return _reports.filter(r => r.update_id === updateId).map(rowToReport);
}

async function getReportCounts() {
  if (db.isAvailable()) {
    const result = await db.query(
      `SELECT update_id, COUNT(*)::int AS count
       FROM bug_reports GROUP BY update_id`
    );
    return result.rows.reduce((acc, row) => {
      acc[row.update_id] = row.count;
      return acc;
    }, {});
  }
  return _reports.reduce((acc, r) => {
    acc[r.update_id] = (acc[r.update_id] || 0) + 1;
    return acc;
  }, {});
}

module.exports = {
  createReport,
  getReportsByUpdateId,
  getReportCounts,
  VALID_PLATFORMS,
  VALID_SEVERITIES,
};

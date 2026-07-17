// src/routes/bugReports.js

'use strict';

const express = require('express');
const router = express.Router();

const { submissionLimiter } = require('../middleware/rateLimiter');
const requireAuth   = require('../middleware/requireAuth');
const { requirePro }  = require('../middleware/requireRole');
const validate = require('../middleware/validate');
const {
  PostBugReportBodySchema,
  GetBugReportsByUpdateIdParamSchema,
} = require('../validators/schemas');
const { createReport, getReportsByUpdateId } = require('../services/bugReportService');
const { escapeOutput } = require('../utils/sanitize');
const logger = require('../utils/logger');

// POST /api/bug-reports — submit a new bug report
router.post(
  '/',
  requireAuth,
  requirePro,
  submissionLimiter,
  validate({ body: PostBugReportBodySchema }),
  async (req, res, next) => {
    try {
      // req.body is Zod-parsed + sanitized at this point
      const { updateId, severity, description } = req.body;
      const userAgent = req.headers['user-agent'];
      const report = await createReport({ updateId, severity, description, userAgent });
      // escapeOutput ensures any persisted user text is safe to reflect back
      res.status(201).json({
        data: escapeOutput(report),
        message: 'Bug report submitted. Thank you.',
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/bug-reports/:updateId — list reports for an update
router.get(
  '/:updateId',
  validate({ params: GetBugReportsByUpdateIdParamSchema }),
  async (req, res, next) => {
    try {
      const reports = await getReportsByUpdateId(req.params.updateId);
      res.json({ data: escapeOutput(reports), count: reports.length });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;

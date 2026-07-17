// src/services/aiAnalysisService.js
// ─────────────────────────────────────────────────────────────────────────────
// AI-powered analysis of software updates using Anthropic claude-sonnet-4-20250514.
//
// Generates: verdict, reasoning, safety score, impact score, security
// criticality assessment, changelog bullets, and known issues.
//
// Falls back gracefully when ANTHROPIC_API_KEY is not set.
// All AI outputs are logged to ai_analysis_log for auditing.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const crypto  = require('crypto');
const db      = require('../config/db');
const logger  = require('../utils/logger');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL             = 'claude-sonnet-4-20250514';

function isEnabled() {
  const key = process.env.ANTHROPIC_API_KEY;
  return !!(key && key.length > 10 && !key.startsWith('REPLACE_WITH'));
}

// ── Core API call ─────────────────────────────────────────────────────────────

async function callAnthropic(systemPrompt, userPrompt) {
  if (!isEnabled()) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const t0 = Date.now();
  const res = await fetch(ANTHROPIC_API_URL, {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: 1200,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }],
    }),
  });

  const latency = Date.now() - t0;

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw Object.assign(new Error(`Anthropic API error ${res.status}: ${body}`), { status: res.status, latency });
  }

  const data    = await res.json();
  const text    = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const tokensIn  = data.usage?.input_tokens  ?? null;
  const tokensOut = data.usage?.output_tokens ?? null;

  return { text, tokensIn, tokensOut, latency };
}

// ── Log AI call to DB ─────────────────────────────────────────────────────────

async function logAiCall({ updateId, promptHash, tokensIn, tokensOut, latency, success, errorMsg }) {
  if (!db.isAvailable()) return;
  try {
    await db.query(
      `INSERT INTO ai_analysis_log
         (update_id, model, prompt_hash, tokens_in, tokens_out, latency_ms, success, error_msg)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [updateId, MODEL, promptHash, tokensIn, tokensOut, latency, success, errorMsg || null]
    );
  } catch (e) {
    logger.warn('[ai] Failed to write ai_analysis_log', { error: e.message });
  }
}

// ── Parse JSON from model output (strips markdown fences) ────────────────────

function parseJson(text) {
  const clean = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  return JSON.parse(clean);
}

// ── Main: generate full analysis for an update ────────────────────────────────

/**
 * Generates a full AI analysis for a software update.
 *
 * @param {object} update - The raw update object (id, platform, name, version,
 *                          releasedAt, changelog, knownIssues, riskFactors, evidence)
 * @returns {object} - Enriched update fields: verdict, reasoning, score,
 *                     impactScore, securityCriticality, changelog, knownIssues
 */
async function analyseUpdate(update) {
  const systemPrompt = `You are PatchTicker's AI analyst. You assess software updates for safety, security impact, and install risk.
You respond ONLY with a valid JSON object — no preamble, no markdown fences, no explanation.

JSON schema:
{
  "score": <number 0-10, safety/stability score>,
  "impactScore": <number 0-10, how broadly this update affects users>,
  "verdict": <string, 1-2 sentence plain-English install recommendation>,
  "reasoning": <string, 3-5 sentence detailed analysis>,
  "securityCriticality": {
    "level": <"critical"|"high"|"medium"|"low">,
    "label": <string, e.g. "Critical CVEs — Actively Exploited">,
    "cves": [<string>, ...]
  },
  "changelog": [<string>, ...],
  "knownIssues": [<string>, ...]
}

Scoring rubric:
- 9-10: Exceptionally clean, no regressions, minimal reports
- 7-8: Stable with minor issues only
- 5-6: Caution warranted, real issues but manageable
- 3-4: Significant regressions affecting many users
- 1-2: Critical failures, avoid entirely

Impact score rubric:
- 9-10: Core OS/driver update affecting nearly all users
- 6-8: Major platform update, wide hardware coverage
- 3-5: Feature update, moderate scope
- 1-2: Minor launcher/cosmetic update`;

  const userPrompt = `Analyse this software update and return JSON only:

Platform: ${update.platform}
Name: ${update.name}
Version: ${update.version}
Released: ${update.releasedAt || update.released_at}
Bug reports filed: ${update.bugCount ?? update.bug_count ?? 0}
Affects: ${update.affects || 'Unknown'}

Existing changelog entries: ${JSON.stringify(update.changelog || [])}
Existing known issues: ${JSON.stringify(update.knownIssues || update.known_issues || [])}
Risk factors: ${JSON.stringify((update.riskFactors || update.risk_factors || []).map(r => r.text || r))}
Evidence sources: ${JSON.stringify((update.evidence || []).map(e => e.text || e))}`;

  const promptHash = crypto.createHash('sha256').update(systemPrompt + userPrompt).digest('hex');
  let tokensIn = null, tokensOut = null, latency = 0;

  try {
    const result = await callAnthropic(systemPrompt, userPrompt);
    tokensIn  = result.tokensIn;
    tokensOut = result.tokensOut;
    latency   = result.latency;

    const parsed = parseJson(result.text);

    await logAiCall({ updateId: update.id, promptHash, tokensIn, tokensOut, latency, success: true });

    logger.info('[ai] Analysis complete', {
      updateId: update.id,
      score:    parsed.score,
      tokensIn,
      tokensOut,
      latencyMs: latency,
    });

    return {
      score:               Math.max(0, Math.min(10, Number(parsed.score) || 5)),
      impactScore:         Math.max(0, Math.min(10, Number(parsed.impactScore) || 5)),
      verdict:             String(parsed.verdict || '').slice(0, 500),
      reasoning:           String(parsed.reasoning || '').slice(0, 2000),
      securityCriticality: parsed.securityCriticality || { level: 'low', label: 'No Security Patches', cves: [] },
      changelog:           Array.isArray(parsed.changelog)   ? parsed.changelog   : (update.changelog   || []),
      knownIssues:         Array.isArray(parsed.knownIssues) ? parsed.knownIssues : (update.knownIssues || []),
      aiGenerated:         true,
      aiModel:             MODEL,
      aiGeneratedAt:       new Date().toISOString(),
    };
  } catch (err) {
    await logAiCall({
      updateId:  update.id,
      promptHash,
      tokensIn,
      tokensOut,
      latency,
      success:   false,
      errorMsg:  err.message,
    });

    logger.warn('[ai] Analysis failed — using static data', { updateId: update.id, error: err.message });
    return null; // caller falls back to static data
  }
}

// ── Admin: fetch recent AI log entries ────────────────────────────────────────

async function getAiLog({ limit = 50, updateId } = {}) {
  if (!db.isAvailable()) return [];
  const params = [Math.min(limit, 200)];
  const where  = updateId ? `WHERE update_id = $2` : '';
  if (updateId) params.push(updateId);

  const rows = await db.query(
    `SELECT id, update_id, model, tokens_in, tokens_out, latency_ms,
            success, error_msg, created_at
     FROM ai_analysis_log
     ${where}
     ORDER BY created_at DESC
     LIMIT $1`,
    params
  );
  return rows.rows;
}

module.exports = { analyseUpdate, getAiLog, isEnabled };

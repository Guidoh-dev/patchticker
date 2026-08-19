// src/services/aiAnalysisService.js
// ─────────────────────────────────────────────────────────────────────────────
// AI-powered analysis of software updates using Anthropic. Configure with ANTHROPIC_MODEL; defaults to Claude Opus 4.6.
//
// Generates only evidence-grounded verdict and reasoning copy. Ratings and all
// structured release facts remain controlled by deterministic code.
//
// Paid calls require ANTHROPIC_ENABLED=true as well as a valid key; otherwise
// deterministic first-party analysis remains active without provider spend.
// All AI outputs are logged to ai_analysis_log for auditing.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const crypto  = require('crypto');
const { z }   = require('zod');
const db      = require('../config/db');
const logger  = require('../utils/logger');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL             = process.env.ANTHROPIC_MODEL || 'claude-opus-4-6';

function isEnabled() {
  const key = process.env.ANTHROPIC_API_KEY;
  // Paid analysis is opt-in even when a key exists. This prevents a copied key
  // from turning scheduled scraper discoveries into unexpected API spend.
  return process.env.ANTHROPIC_ENABLED === 'true'
    && !!(key && key.length > 10 && !key.startsWith('REPLACE_WITH'));
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

const GroundedAnalysisSchema = z.object({
  verdict: z.string().min(1).max(500),
  reasoning: z.string().min(1).max(2000),
}).strict();

// ── Main: generate full analysis for an update ────────────────────────────────

/**
 * Generates a full AI analysis for a software update.
 *
 * @param {object} update - The raw update object (id, platform, name, version,
 *                          releasedAt, changelog, knownIssues, riskFactors, evidence)
 * @returns {object} - Enriched update fields: verdict and reasoning, plus
 *                     unchanged structured facts from the scraper.
 */
async function analyseUpdate(update) {
  const systemPrompt = `You are PatchTicker's evidence summarizer. Summarize only facts present in the supplied vendor material.
You respond ONLY with a valid JSON object — no preamble, no markdown fences, no explanation.
Never invent a score, severity, issue, requirement, CVE, or recommendation. PatchTicker calculates ratings separately with deterministic code.

JSON schema:
{
  "verdict": <string, 1-2 sentence plain-English install recommendation>,
  "reasoning": <string, 3-5 sentence evidence-grounded summary>
}`;

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

    const parsed = GroundedAnalysisSchema.parse(parseJson(result.text));

    await logAiCall({ updateId: update.id, promptHash, tokensIn, tokensOut, latency, success: true });

    logger.info('[ai] Analysis complete', {
      updateId: update.id,
      scoreAuthority: 'deterministic-engine',
      tokensIn,
      tokensOut,
      latencyMs: latency,
    });

    return {
      verdict:             String(parsed.verdict || '').slice(0, 500),
      reasoning:           String(parsed.reasoning || '').slice(0, 2000),
      // Structured source facts remain exactly as scraped. Generated text can
      // never create or remove CVEs, known issues, or changelog entries.
      securityCriticality: update.securityCriticality || { level: 'none', label: 'Security context not classified', cves: [] },
      changelog:           update.changelog || [],
      knownIssues:         update.knownIssues || [],
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

module.exports = { analyseUpdate, getAiLog, isEnabled, __test: { GroundedAnalysisSchema } };

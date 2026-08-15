'use strict';

const SCORE_MIN = 0;
const SCORE_MAX = 10;

const RISK_PENALTIES = Object.freeze({
  critical: 2.8,
  high: 1.8,
  medium: 0.8,
  low: 0.2,
});

function validateScore(value, { allowNull = false } = {}) {
  if (value === null || value === undefined || value === '') {
    return allowNull
      ? { ok: true, value: null, reason: null }
      : { ok: false, value: null, reason: 'missing' };
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return { ok: false, value: null, reason: 'not_finite' };
  }
  if (numeric < SCORE_MIN || numeric > SCORE_MAX) {
    return { ok: false, value: null, reason: 'out_of_bounds' };
  }

  return { ok: true, value: Math.round(numeric * 10) / 10, reason: null };
}

function requireValidScore(value, field = 'score') {
  const result = validateScore(value);
  if (result.ok) return result.value;

  const error = new TypeError(`Invalid ${field}: ${result.reason}`);
  error.code = 'INVALID_UPDATE_SCORE';
  error.field = field;
  error.reason = result.reason;
  throw error;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function officialSourceCount(evidence) {
  return list(evidence).filter(item => {
    const url = String(item?.url || '');
    const source = String(item?.source || '');
    return /^https?:\/\//i.test(url) && !/(?:reddit\.com|^r\/)/i.test(`${source} ${url}`);
  }).length;
}

function documentedReleaseChannel(input) {
  const explicit = String(input?.releaseChannel || '').toLowerCase().trim();
  if (explicit) return explicit;

  // These are vendor-authored release-channel labels, not inferred sentiment.
  const identity = `${input?.name || ''} ${input?.version || ''}`.toLowerCase();
  if (/\b(?:preview|beta|insider|canary|experimental|non-whql)\b/.test(identity)) return 'prerelease';
  return 'stable';
}

/**
 * Deterministic safety score derived only from documented release metadata.
 * No generated prose, community sentiment, or platform-specific bias is used.
 */
function deriveDeterministicScore(input = {}) {
  const changelog = list(input.changelog);
  const knownIssues = list(input.knownIssues);
  const riskFactors = list(input.riskFactors);
  const evidence = list(input.evidence);
  const noteCharacters = changelog.reduce((total, entry) => total + String(entry || '').trim().length, 0);

  let score = 6.8;

  // Documentation completeness controls confidence without pretending that a
  // long changelog is inherently safer.
  if (changelog.length === 0 || noteCharacters < 80) score -= 0.7;
  else if (changelog.length >= 3 && noteCharacters >= 300) score += 0.2;

  if (officialSourceCount(evidence) === 0) score -= 0.5;
  else score += 0.2;

  if (input.knownIssuesAuthoritative === true && knownIssues.length === 0) score += 0.4;
  score -= Math.min(3, knownIssues.length * 0.45);

  for (const risk of riskFactors) {
    score -= RISK_PENALTIES[String(risk?.level || '').toLowerCase()] || 0;
  }

  if (documentedReleaseChannel(input) === 'prerelease') score -= 1.4;

  return requireValidScore(Math.max(1, Math.min(9.2, score)), 'deterministic score');
}

function deriveDeterministicImpactScore(input = {}) {
  const changelog = list(input.changelog);
  const riskFactors = list(input.riskFactors);
  const noteCharacters = changelog.reduce((total, entry) => total + String(entry || '').trim().length, 0);
  const criticality = String(input.securityCriticality?.level || '').toLowerCase();

  let score = 2.5;
  score += Math.min(3.5, changelog.length * 0.45);
  score += Math.min(1.5, noteCharacters / 1400);
  if (riskFactors.some(risk => ['critical', 'high'].includes(String(risk?.level || '').toLowerCase()))) score += 1;
  if (['critical', 'high'].includes(criticality)) score += 1;

  return requireValidScore(Math.max(1, Math.min(9.5, score)), 'deterministic impact score');
}

function statusForScore(value) {
  const score = requireValidScore(value);
  if (score >= 7.5) return 'stable';
  if (score >= 5) return 'caution';
  return 'avoid';
}

module.exports = {
  SCORE_MIN,
  SCORE_MAX,
  validateScore,
  requireValidScore,
  deriveDeterministicScore,
  deriveDeterministicImpactScore,
  statusForScore,
};

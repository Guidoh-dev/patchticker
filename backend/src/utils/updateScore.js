'use strict';

const SCORE_MIN = 0;
const SCORE_MAX = 10;

const RISK_PENALTIES = Object.freeze({
  critical: 2.6,
  high: 1.55,
  medium: 0.7,
  low: 0.18,
});

const SECURITY_BONUSES = Object.freeze({
  critical: 1,
  high: 0.75,
  medium: 0.45,
  low: 0.15,
});

const RESOLUTION_RE = /\b(?:fixed|fixes|resolved|corrected|addressed|reduced|improved|mitigated|eliminated|prevented)\b/i;
const DOCUMENTED_BENEFIT_RE = /\b(?:add(?:ed|s)?|introduc(?:e|ed|es)|enabl(?:e|ed|es)|enhanc(?:e|ed|es)|improv(?:e|ed|es)|optimi[sz](?:e|ed|es)|restor(?:e|ed|es)|support(?:ed|s)|upgrad(?:e|ed|es)|fix(?:ed|es)?|resolv(?:e|ed|es)|correct(?:ed|s)?|address(?:ed|es)|reduc(?:e|ed|es)|mitigat(?:e|ed|es)|eliminat(?:e|ed|es)|prevent(?:ed|s)?)\b/i;
const UNRESOLVED_QUALIFIER_RE = /\b(?:remain(?:s|ing)?|may still|can still|continues? to|workaround|not fixed|unresolved|under investigation)\b/i;
const NEGATIVE_ISSUE_RE = /\b(?:not (?:currently )?aware of any issues?|no known issues?|no issues? (?:are )?(?:known|reported|listed|found|identified)|without known issues?)\b/i;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function validateScore(value, { allowNull = false } = {}) {
  if (value === null || value === undefined || value === '') {
    return allowNull
      ? { ok: true, value: null, reason: null }
      : { ok: false, value: null, reason: 'missing' };
  }

  // node-postgres returns NUMERIC columns as decimal strings, so bounded
  // decimal strings are intentionally accepted. Everything else is rejected
  // before coercion: Number(true), Number([]), and Number('   ') are all valid
  // JavaScript numbers, but none is a valid persisted PatchTicker rating.
  if (typeof value !== 'number' && typeof value !== 'string') {
    return { ok: false, value: null, reason: 'invalid_type' };
  }
  const normalized = typeof value === 'string' ? value.trim() : value;
  if (normalized === '') {
    return allowNull
      ? { ok: true, value: null, reason: null }
      : { ok: false, value: null, reason: 'missing' };
  }
  if (typeof normalized === 'string' && !/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) {
    return { ok: false, value: null, reason: 'invalid_format' };
  }

  const numeric = Number(normalized);
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

function textValue(entry) {
  if (typeof entry === 'string') return entry.trim();
  if (!entry || typeof entry !== 'object') return '';
  return String(entry.text || entry.description || entry.title || '').trim();
}

function isResolvedStatement(value) {
  const text = textValue(value);
  return Boolean(text && RESOLUTION_RE.test(text) && !UNRESOLVED_QUALIFIER_RE.test(text));
}

function isNegativeKnownIssueStatement(value) {
  return NEGATIVE_ISSUE_RE.test(textValue(value));
}

function isDocumentedBenefitStatement(value) {
  const text = textValue(value);
  return Boolean(text && DOCUMENTED_BENEFIT_RE.test(text) && !UNRESOLVED_QUALIFIER_RE.test(text));
}

function normalizedSignal(value) {
  return textValue(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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

function issuePenaltyForStatement(value) {
  const text = textValue(value);
  if (!text || isResolvedStatement(text) || isNegativeKnownIssueStatement(text)) return 0;
  if (/\b(?:data loss|save corruption|bricked?|boot loop|cannot boot|security bypass|privilege escalation|remote code execution)\b/i.test(text)) return 0.95;
  if (/\b(?:crash|freeze|hang|bsod|blue screen|install(?:ation)? fail|driver timeout|corrupt|cannot launch|failed to launch)\b/i.test(text)) return 0.65;
  if (/\b(?:stutter|flicker|performance|display|network|disconnect|controller|overlay|audio|latency|disabled|degraded)\b/i.test(text)) return 0.35;
  return 0.22;
}

function sourceKindAdjustment(input) {
  const evidenceKinds = list(input.evidence).map(item => String(item?.releaseType || item?.sourceKind || '').toLowerCase());
  const kind = [String(input.sourceKind || '').toLowerCase(), ...evidenceKinds].join(' ');

  if (/security-(?:advisory|release)|official-security/.test(kind)) return 0.25;
  if (/official-release-notes?/.test(kind)) return 0.16;
  if (/steam-game-news|official-game-update/.test(kind)) return 0.08;
  if (/official-release/.test(kind)) return 0.1;
  if (/official-version|version-only/.test(kind)) return -0.35;
  if (/official-artifact|artifact-only/.test(kind)) return -0.12;
  return 0;
}

function hasFullReleaseNotes(input) {
  const kinds = [
    input.sourceKind,
    ...list(input.evidence).flatMap(item => [item?.releaseType, item?.sourceKind]),
  ].filter(Boolean).map(kind => String(kind).toLowerCase().trim());
  return kinds.some(kind => /^(?:official-release|official-release-notes?|official-game-update|steam-game-news|security-advisory|security-release|official-security(?:-advisory|-release)?)(?:$|\b)/.test(kind));
}

function hasDocumentedSecurityEvidence(input) {
  const criticality = input.securityCriticality || {};
  if (list(criticality.cves).length > 0) return true;
  const sourceText = [input.sourceKind, ...list(input.evidence).flatMap(item => [item?.releaseType, item?.source, item?.text])]
    .filter(Boolean)
    .join(' ');
  return /\b(?:security|cve|vulnerabilit|advisory)\b/i.test(sourceText);
}

/**
 * Returns an auditable rating and its evidence-derived components. The model
 * never contributes to this calculation: generated prose is not rating data.
 */
function deriveDeterministicScoreBreakdown(input = {}) {
  const changelog = list(input.changelog);
  const knownIssues = list(input.knownIssues);
  const riskFactors = list(input.riskFactors);
  const evidence = list(input.evidence);
  const noteCharacters = changelog.reduce((total, entry) => total + textValue(entry).length, 0);
  const sources = officialSourceCount(evidence);
  const unresolvedIssues = knownIssues.filter(item => !isResolvedStatement(item) && !isNegativeKnownIssueStatement(item));
  const issueSignals = new Set(unresolvedIssues.map(normalizedSignal).filter(Boolean));
  const unresolvedRisks = riskFactors.filter(risk => (
    !isResolvedStatement(risk) && !isNegativeKnownIssueStatement(risk)
  ));
  const resolvedChangeCount = changelog.filter(isResolvedStatement).length;
  const documentedBenefitCount = changelog.filter(isDocumentedBenefitStatement).length;
  const securityLevel = String(input.securityCriticality?.level || '').toLowerCase();
  const cveCount = list(input.securityCriticality?.cves).length;
  const securityDocumented = hasDocumentedSecurityEvidence(input);
  const stableReleaseChannel = documentedReleaseChannel(input) === 'stable';
  const cleanDocumentedRelease = sources > 0
    && hasFullReleaseNotes(input)
    && stableReleaseChannel
    && documentedBenefitCount >= 2
    && unresolvedIssues.length === 0
    && unresolvedRisks.length === 0;

  const components = {
    baseline: 6.7,
    documentation: changelog.length === 0
      ? -0.9
      : clamp((Math.log10(Math.max(noteCharacters, 1)) - 2.2) * 0.32, -0.5, 0.28),
    sourceConfidence: sources === 0 ? -0.8 : 0.22 + Math.min(0.24, (sources - 1) * 0.12),
    sourceSpecificity: sourceKindAdjustment(input),
    knownIssueConfidence: input.knownIssuesAuthoritative === true && unresolvedIssues.length === 0
      ? 0.55
      : (input.knownIssuesAuthoritative !== true && unresolvedIssues.length === 0 ? -0.12 : 0),
    knownIssues: -Math.min(3.2, unresolvedIssues.reduce((sum, issue) => sum + issuePenaltyForStatement(issue), 0)),
    // If a severity-tagged risk repeats a known issue, use the stronger of the
    // two penalties rather than charging for the same evidence twice.
    riskFactors: -Math.min(3.2, unresolvedRisks.reduce((sum, risk) => {
      const severityPenalty = RISK_PENALTIES[String(risk?.level || '').toLowerCase()] || 0;
      const normalized = normalizedSignal(risk);
      if (normalized && issueSignals.has(normalized)) {
        return sum + Math.max(0, severityPenalty - issuePenaltyForStatement(risk));
      }
      return sum + severityPenalty;
    }, 0)),
    security: securityDocumented
      ? (SECURITY_BONUSES[securityLevel] || 0) + Math.min(0.25, cveCount * 0.02)
      : 0,
    // Concrete shipped fixes/features are positive install-confidence evidence,
    // not mere upbeat wording. This gives clean, well-documented releases room
    // to reach STABLE while remaining bounded by source and issue gates.
    documentedBenefits: Math.min(0.9, documentedBenefitCount * 0.15),
    cleanReleaseConfidence: cleanDocumentedRelease ? 0.45 : 0,
    changeSurface: -(
      Math.min(0.28, Math.max(0, changelog.length - 4) * 0.035)
      + Math.min(0.38, Math.max(0, noteCharacters - 500) / 3500)
    ),
    releaseChannel: stableReleaseChannel ? 0 : -1.4,
  };

  let rawScore = Object.values(components).reduce((sum, value) => sum + value, 0);
  if (sources === 0) rawScore = Math.min(rawScore, 6.4);

  const sourceKind = String(input.sourceKind || '').toLowerCase();
  if (/official-version|version-only/.test(sourceKind)) rawScore = Math.min(rawScore, 6.3);
  if (input.knownIssuesAuthoritative !== true && !securityDocumented) {
    // Absence of an authoritative issue list still limits confidence. However,
    // an official stable release with multiple concrete improvements and no
    // captured risks is no longer artificially trapped below the green band.
    const confidenceCap = cleanDocumentedRelease
      ? 8.3
      : (sources > 0 && hasFullReleaseNotes(input) && documentedBenefitCount > 0 ? 7.6 : 7.4);
    rawScore = Math.min(rawScore, confidenceCap);
  }
  if (!securityDocumented && (unresolvedIssues.length > 0 || unresolvedRisks.length > 0)) {
    // A long list of positive changes cannot erase a vendor-documented active
    // defect. Non-security releases with any unresolved risk remain CAUTION.
    rawScore = Math.min(rawScore, 7.4);
  }

  const score = requireValidScore(clamp(rawScore, 1, 9.2), 'deterministic score');
  return {
    score,
    rawScore: Math.round(rawScore * 1000) / 1000,
    components: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, Math.round(value * 1000) / 1000])),
    signals: {
      changelogEntries: changelog.length,
      noteCharacters,
      officialSources: sources,
      unresolvedIssues: unresolvedIssues.length,
      unresolvedRisks: unresolvedRisks.length,
      resolvedChanges: resolvedChangeCount,
      documentedBenefits: documentedBenefitCount,
      cleanDocumentedRelease,
      securityLevel: securityDocumented ? securityLevel || 'documented' : 'none',
      cveCount,
      releaseChannel: documentedReleaseChannel(input),
    },
  };
}

/**
 * Deterministic install-confidence score derived only from documented release
 * metadata. No generated prose, community sentiment, hash noise, or vendor
 * favoritism is used.
 */
function deriveDeterministicScore(input = {}) {
  return deriveDeterministicScoreBreakdown(input).score;
}

function deriveDeterministicImpactScore(input = {}) {
  const changelog = list(input.changelog);
  const riskFactors = list(input.riskFactors);
  const noteCharacters = changelog.reduce((total, entry) => total + textValue(entry).length, 0);
  const criticality = String(input.securityCriticality?.level || '').toLowerCase();

  let score = 2.5;
  score += Math.min(3.5, changelog.length * 0.45);
  score += Math.min(1.5, noteCharacters / 1400);
  if (riskFactors.some(risk => ['critical', 'high'].includes(String(risk?.level || '').toLowerCase()))) score += 1;
  if (['critical', 'high'].includes(criticality)) score += 1;

  return requireValidScore(clamp(score, 1, 9.5), 'deterministic impact score');
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
  isResolvedStatement,
  isNegativeKnownIssueStatement,
  isDocumentedBenefitStatement,
  issuePenaltyForStatement,
  deriveDeterministicScoreBreakdown,
  deriveDeterministicScore,
  deriveDeterministicImpactScore,
  statusForScore,
};

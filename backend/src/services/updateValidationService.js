'use strict';

const MAX_FUTURE_SKEW_MS = 48 * 60 * 60 * 1000;

function removeControlCharacters(value) {
  return [...String(value)].filter(character => {
    const code = character.charCodeAt(0);
    return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
  }).join('');
}

class UpdateValidationError extends TypeError {
  constructor(errors, warnings = []) {
    super(`Update rejected by persistence validation: ${errors.join('; ')}`);
    this.name = 'UpdateValidationError';
    this.code = 'UPDATE_VALIDATION_REJECTED';
    this.errors = errors;
    this.warnings = warnings;
  }
}

function sanitizeText(value, maxLength = 4000) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return removeControlCharacters(value)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength);
}

function sanitizeValue(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return null;
  if (typeof value === 'string') return sanitizeText(value, 8000) || null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const rows = value.map(item => sanitizeValue(item, depth + 1)).filter(item => item !== null);
    return rows.length ? rows : null;
  }
  if (typeof value !== 'object') return null;
  const entries = Object.entries(value)
    .map(([key, item]) => [sanitizeText(key, 80), sanitizeValue(item, depth + 1)])
    .filter(([key, item]) => key && item !== null);
  return entries.length ? Object.fromEntries(entries) : null;
}

function sanitizeList(value, maxItems = 12) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => sanitizeValue(item))
    .filter(item => item !== null)
    .slice(0, maxItems);
}

function normalizeRating(value, field, explicitScale = null) {
  if (value === null || value === undefined || value === '') {
    if (field === 'impactScore') return { value: null, sourceScale: null };
    throw new UpdateValidationError([`${field}: missing`]);
  }
  if (!['number', 'string'].includes(typeof value)) {
    throw new UpdateValidationError([`${field}: invalid type`]);
  }
  const raw = typeof value === 'string' ? value.trim() : value;
  if (raw === '' || (typeof raw === 'string' && !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw))) {
    throw new UpdateValidationError([`${field}: invalid numeric format`]);
  }
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) {
    throw new UpdateValidationError([`${field}: NaN or infinite`]);
  }

  const requestedScale = Number(explicitScale);
  const scale = requestedScale === 10 || requestedScale === 100
    ? requestedScale
    : (numeric > 10 ? 100 : 10);
  if (numeric < 0 || numeric > scale) {
    throw new UpdateValidationError([`${field}: outside 0-${scale}`]);
  }
  return {
    value: Math.round((scale === 100 ? numeric / 10 : numeric) * 10) / 10,
    sourceScale: scale,
  };
}

function toUtcIso(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  const text = sanitizeText(value, 80);
  if (!text) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function officialPublishedAt(evidence) {
  const authoritativeDateBasis = /^(?:published|released|artifact-published|source-updated)$/;
  for (const item of evidence) {
    if (!item || typeof item !== 'object') continue;
    if (!authoritativeDateBasis.test(String(item.dateBasis || ''))) continue;
    const timestamp = toUtcIso(item.publishedAt);
    if (timestamp) return timestamp;
  }
  return null;
}

function validateUpdateForPersistence(input, options = {}) {
  const errors = [];
  const warnings = [];
  if (!input || typeof input !== 'object') {
    throw new UpdateValidationError(['payload: expected an object']);
  }

  const value = { ...input };
  const requiredText = {
    id: 64,
    platform: 64,
    name: 180,
    version: 128,
    verdict: 2000,
    reasoning: 4000,
  };
  for (const [field, maxLength] of Object.entries(requiredText)) {
    value[field] = sanitizeText(input[field], maxLength);
    if (!value[field]) errors.push(`${field}: missing valid text`);
  }

  for (const [field, maxLength] of Object.entries({
    displayVersion: 128,
    sourceKind: 80,
    sourceRef: 220,
    productId: 80,
    affects: 2000,
  })) {
    const clean = sanitizeText(input[field], maxLength);
    value[field] = clean || null;
  }

  value.changelog = sanitizeList(input.changelog, 20);
  value.knownIssues = sanitizeList(input.knownIssues, 16);
  value.riskFactors = sanitizeList(input.riskFactors, 16);
  value.evidence = sanitizeList(input.evidence, 12);
  value.subreddits = sanitizeList(input.subreddits, 12)
    .map(item => typeof item === 'string' ? item : '')
    .filter(Boolean);
  value.securityCriticality = sanitizeValue(input.securityCriticality);
  if (!value.changelog.length && value.reasoning) {
    value.changelog = [value.reasoning];
    warnings.push('changelog: replaced empty payload with validated reasoning');
  }
  if (!value.changelog.length) errors.push('changelog: no valid summary text');

  let scoreResult;
  let impactResult;
  try {
    scoreResult = normalizeRating(input.score, 'score', input.scoreScale);
    impactResult = normalizeRating(input.impactScore, 'impactScore', input.impactScoreScale || input.scoreScale);
  } catch (error) {
    if (error instanceof UpdateValidationError) errors.push(...error.errors);
    else throw error;
  }
  if (scoreResult) value.score = scoreResult.value;
  if (impactResult) value.impactScore = impactResult.value;

  const suppliedReleasedAt = toUtcIso(input.releasedAt);
  if (!suppliedReleasedAt) errors.push('releasedAt: invalid or missing');
  const evidencePublishedAt = officialPublishedAt(value.evidence);
  value.releasedAt = evidencePublishedAt || suppliedReleasedAt;
  if (evidencePublishedAt && suppliedReleasedAt && evidencePublishedAt !== suppliedReleasedAt) {
    warnings.push('releasedAt: normalized to official publication timestamp');
  } else if (!evidencePublishedAt) {
    warnings.push('releasedAt: no evidence publication timestamp; validated vendor release date retained');
  }
  if (value.releasedAt && Date.parse(value.releasedAt) > (options.now || Date.now()) + MAX_FUTURE_SKEW_MS) {
    errors.push('releasedAt: future-dated beyond allowed source skew');
  }

  if (errors.length) throw new UpdateValidationError(errors, warnings);
  return {
    value,
    warnings,
    ratingScales: {
      score: scoreResult?.sourceScale || null,
      impactScore: impactResult?.sourceScale || null,
    },
    timestampSource: evidencePublishedAt ? 'official-evidence' : 'vendor-release-date',
  };
}

module.exports = {
  UpdateValidationError,
  validateUpdateForPersistence,
  __test: {
    normalizeRating,
    officialPublishedAt,
    sanitizeList,
    sanitizeText,
    sanitizeValue,
    toUtcIso,
  },
};

'use strict';

// One canonical evidence hierarchy is shared by ingestion, API hydration, and
// deterministic rating reconciliation. Older rows predate source_kind, so the
// evidence stored with the release remains the source of truth for backfills.
const SOURCE_KIND_PRIORITY = Object.freeze([
  'official-security-release',
  'official-security-advisory',
  'official-release-notes',
  'official-game-update',
  'official-release',
  'official-artifact',
  'official-version',
]);

const SOURCE_KIND_ALIASES = Object.freeze({
  'security-release': 'official-security-release',
  'security-advisory': 'official-security-advisory',
  'official-security-index': 'official-security-advisory',
  'version-only': 'official-version',
  'artifact-only': 'official-artifact',
});

function normalizedKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  return SOURCE_KIND_ALIASES[kind] || kind;
}

function isOfficialEvidence(item) {
  const url = String(item?.url || '').trim();
  const identity = `${item?.source || ''} ${url}`;
  if (/(?:reddit\.com|^r\/)/i.test(identity)) return false;
  const kind = normalizedKind(item?.sourceKind || item?.releaseType);
  return /^https:\/\//i.test(url)
    || SOURCE_KIND_PRIORITY.includes(kind)
    || kind === 'official-source';
}

function sourceKindFromEvidence(evidence) {
  const officialEvidence = (Array.isArray(evidence) ? evidence : []).filter(isOfficialEvidence);
  const kinds = new Set(
    officialEvidence
      .flatMap(item => [item?.sourceKind, item?.releaseType])
      .map(normalizedKind)
      .filter(Boolean)
  );
  return SOURCE_KIND_PRIORITY.find(kind => kinds.has(kind))
    || (officialEvidence.length ? 'official-source' : null);
}

module.exports = {
  SOURCE_KIND_PRIORITY,
  sourceKindFromEvidence,
  __test: { isOfficialEvidence, normalizedKind },
};

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

export function preferredReleaseAt(update = {}) {
  const fallback = update?.releasedAt || null;
  const fallbackTime = timestamp(fallback);
  if (!fallbackTime) return fallback;

  const releaseDay = new Date(fallbackTime).toISOString().slice(0, 10);
  const timedEvidence = (Array.isArray(update?.evidence) ? update.evidence : [])
    .filter(item => typeof item?.publishedAt === 'string' && /T\d{2}:\d{2}/.test(item.publishedAt))
    .filter(item => timestamp(item.publishedAt) && new Date(timestamp(item.publishedAt)).toISOString().slice(0, 10) === releaseDay);
  const primaryEvidence = timedEvidence.find(item => item.url && item.url === update.sourceUrl);

  return primaryEvidence?.publishedAt || timedEvidence[0]?.publishedAt || fallback;
}

function releaseTime(update) {
  return timestamp(preferredReleaseAt(update));
}

function arrivalTime(update) {
  return timestamp(update?.createdAt || update?.releasedAt);
}

export function selectUpdateBrief(updates = [], visitBaseline = Number.NaN) {
  const releases = [...updates].sort((left, right) => (
    releaseTime(right) - releaseTime(left)
    || arrivalTime(right) - arrivalTime(left)
  ));
  const isReturning = Number.isFinite(visitBaseline);
  const arrivals = isReturning
    ? [...updates]
      .filter(update => arrivalTime(update) > visitBaseline)
      .sort((left, right) => arrivalTime(right) - arrivalTime(left))
    : [];
  const featured = (arrivals.length ? arrivals : releases).slice(0, 4);

  return {
    isReturning,
    sinceLastVisit: arrivals,
    featured,
    latest: featured[0] || null,
  };
}

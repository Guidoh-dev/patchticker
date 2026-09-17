function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function releaseTime(update) {
  return timestamp(update?.releasedAt);
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

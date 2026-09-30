export const SETUP_LENSES = Object.freeze({
  pc: { label: 'PC & Steam', platforms: ['Windows', 'Chrome', 'Firefox', 'Edge', 'NVIDIA', 'AMD', 'Intel', 'Steam', 'Discord', 'BattleNet', 'GOG'] },
  console: { label: 'Console & handheld', platforms: ['Steam', 'Switch', 'PS5', 'Xbox'] },
  apple: { label: 'Apple devices', platforms: ['Apple', 'macOS'] },
});

export function filterUpdatesBySetup(updates, setup) {
  const platforms = SETUP_LENSES[setup]?.platforms || [];
  if (!platforms.length) return [...(updates || [])];
  return (updates || []).filter(update => platforms.includes(update?.platform));
}

// A completed database search already matched vendor notes, device tables,
// and inflected issue terms. Rechecking with the browser's smaller vocabulary
// silently discards valid results (for example "crashes" vs "crash").
export function filterSearchResultsByProvenance(updates, {
  authoritative = false, groups = [], searchText, contains,
} = {}) {
  const candidates = [...(updates || [])];
  if (authoritative || !groups.length) return candidates;
  return candidates.filter(update => (
    update.compatibilitySearchFallback
    || groups.every(group => group.some(term => contains(searchText(update), term)))
  ));
}

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

// Keep known product-coverage gaps separate from "no recent release". In
// particular, Switch 2 has its own Nintendo firmware history; first-generation
// Switch records must never be presented as evidence about Switch 2.
export function untrackedProductForSearch(query) {
  const text = String(query || '').toLowerCase().replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\bswitch\s*2\b/.test(text)) {
    return {
      name: 'Nintendo Switch 2',
      sourceUrl: 'https://en-americas-support.nintendo.com/app/answers/detail/a_id/68526',
    };
  }
  return null;
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

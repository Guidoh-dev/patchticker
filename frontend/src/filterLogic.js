export const SETUP_LENSES = Object.freeze({
  pc: { label: 'PC & Steam', platforms: ['Windows', 'NVIDIA', 'AMD', 'Intel', 'Steam', 'Discord', 'BattleNet', 'GOG'] },
  console: { label: 'Console & handheld', platforms: ['Steam', 'Switch', 'PS5', 'Xbox'] },
  apple: { label: 'Apple devices', platforms: ['Apple', 'macOS'] },
});

export function filterUpdatesBySetup(updates, setup) {
  const platforms = SETUP_LENSES[setup]?.platforms || [];
  if (!platforms.length) return [...(updates || [])];
  return (updates || []).filter(update => platforms.includes(update?.platform));
}

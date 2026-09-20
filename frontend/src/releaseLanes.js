function normaliseLanePart(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Return the stable identity used to decide which record is the latest release.
 *
 * A non-Steam platform is one release lane even when newer rows have richer
 * metadata than historical rows. Steam is the exception: its desktop client,
 * SteamOS, and each tracked game are independent products.
 */
export function releaseLaneKey(update = {}) {
  const platform = update.platform || 'unknown';
  if (platform !== 'Steam') return platform;

  if (update.sourceKind === 'steam-game-news') {
    const product = update.productId
      || normaliseLanePart(update.name)
      || normaliseLanePart(update.id)
      || 'unknown-game';
    return `Steam:game:${product}`;
  }
  if (update.sourceKind === 'steam-client-news') return 'Steam:client';
  if (update.sourceKind === 'steamos-news'
    || /steam(?:os| deck)/i.test(`${update.name || ''} ${update.affects || ''}`)) {
    return 'Steam:steamos';
  }

  return 'Steam:platform';
}


function normalize(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[®™]/g, '')
    .replace(/([a-z])([0-9])/gi, '$1 $2')
    .replace(/([0-9])([a-z])/gi, '$1 $2')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

function includesPhrase(input, phrase) {
  const left = ` ${normalize(input)} `;
  const right = ` ${normalize(phrase)} `;
  return right.trim().length >= 3 && left.includes(right);
}

export function compatibilityProfileFromUpdate(update) {
  const evidence = Array.isArray(update?.evidence) ? update.evidence : [];
  const item = evidence.find(entry => entry?.compatibility?.schemaVersion === 1);
  if (!item) return null;
  return {
    ...item.compatibility,
    sourceUrl: item.url || update?.sourceUrl || null,
    sourceLabel: item.source || `${item.compatibility.vendor || update?.platform || 'Vendor'} compatibility list`,
    checkedAt: item.checkedAt || update?.lastCheckedAt || null,
  };
}

function unsupportedVendor(profile, hardware) {
  const value = normalize(hardware);
  if (profile?.vendor === 'AMD') return /\b(?:nvidia|geforce|intel arc)\b/.test(value);
  if (profile?.vendor === 'Intel') return /\b(?:amd|radeon|nvidia|geforce)\b/.test(value);
  return false;
}

function looksLikeVendorModel(profile, hardware) {
  const value = normalize(hardware);
  // Only call a model unsupported when the input clearly belongs to a model
  // namespace exhaustively enumerated by the vendor table. Integrated graphics
  // families are broader than the release-note tables, so an absent match must
  // remain unverified rather than becoming a false negative.
  if (profile?.vendor === 'AMD') return /\b(?:rx|radeon pro)\b/.test(value) && /\d/.test(value);
  if (profile?.vendor === 'Intel') return /\b(?:arc|uhd|iris|[ab]\s?\d{2,4})\b/.test(value) && /\d/.test(value);
  return false;
}

export function evaluateCompatibility(profile, { hardware, operatingSystem = 'not-sure' } = {}) {
  const enteredHardware = String(hardware || '').trim();
  if (!enteredHardware) {
    return {
      status: 'needs-input',
      title: 'Enter a hardware model',
      detail: 'Use the exact GPU or graphics model shown in Windows Device Manager or your system specifications.',
    };
  }

  if (!profile?.authoritative || !Array.isArray(profile.hardware) || !profile.hardware.length) {
    return {
      status: 'unverified',
      title: 'Model-level check unavailable',
      detail: 'This update does not include a complete official hardware support table. PatchTicker will not guess from the product name.',
    };
  }

  const combinedInput = `${enteredHardware} ${operatingSystem}`;
  const excluded = (profile.exclusions || []).find(entry =>
    (entry.aliases || []).some(alias => includesPhrase(combinedInput, alias))
  );
  if (excluded) {
    return {
      status: 'unsupported',
      title: 'Not supported by this package',
      detail: excluded.label,
      matchedLabel: excluded.label,
    };
  }

  if (operatingSystem === 'other') {
    return {
      status: 'unsupported',
      title: 'Operating system not supported',
      detail: `The official package lists ${profile.operatingSystems.join(' and ')}.`,
    };
  }

  if (unsupportedVendor(profile, enteredHardware)) {
    return {
      status: 'unsupported',
      title: `Not a supported ${profile.vendor} device`,
      detail: `This ${profile.vendor} package cannot be installed for the hardware entered.`,
    };
  }

  const matches = profile.hardware.filter(entry =>
    (entry.aliases || []).some(alias => includesPhrase(enteredHardware, alias))
  );
  if (matches.length) {
    const best = matches.sort((left, right) =>
      Math.max(...(right.aliases || []).map(alias => normalize(alias).length), 0)
      - Math.max(...(left.aliases || []).map(alias => normalize(alias).length), 0)
    )[0];
    return {
      status: 'supported',
      title: best.matchType === 'family' ? 'Supported hardware family' : 'Supported by this package',
      detail: `Matched the vendor’s official compatibility entry: ${best.label}.`,
      matchedLabel: best.label,
      guidance: profile.guidance || '',
    };
  }

  if (looksLikeVendorModel(profile, enteredHardware)) {
    return {
      status: 'unsupported',
      title: 'Not listed by the vendor',
      detail: `${enteredHardware} does not match this release’s official ${profile.vendor} hardware support table. Check the vendor source before installing.`,
    };
  }

  return {
    status: 'unverified',
    title: 'Could not verify that model',
    detail: 'Try the exact graphics model, such as “Radeon RX 7900 XTX” or “Intel Arc A770.” A missing match is not treated as proof of compatibility.',
  };
}

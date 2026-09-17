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
    sourceUrls: [...new Set([
      item.url,
      ...(Array.isArray(item.compatibility.sourceUrls) ? item.compatibility.sourceUrls : []),
    ].filter(Boolean))],
    sourceLabel: item.source || `${item.compatibility.vendor || update?.platform || 'Vendor'} compatibility list`,
    checkedAt: item.checkedAt || update?.lastCheckedAt || null,
  };
}

function unsupportedVendor(profile, hardware) {
  const value = normalize(hardware);
  if (profile?.vendor === 'AMD') return /\b(?:nvidia|geforce|intel arc)\b/.test(value);
  if (profile?.vendor === 'Intel') return /\b(?:amd|radeon|nvidia|geforce)\b/.test(value);
  if (profile?.vendor === 'NVIDIA') return /\b(?:amd|radeon|intel arc)\b/.test(value);
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
  if (profile?.vendor === 'NVIDIA') return /\b(?:rtx|gtx|mx)\b/.test(value) && /\d/.test(value);
  return false;
}

function compatibilityAliasMatches(profile, entry, hardware, alias) {
  if (!includesPhrase(hardware, alias)) return false;

  // AMD publishes useful family aliases such as "7900", but a bare processor
  // number is not enough to prove graphics-driver compatibility. Preserve the
  // shorthand only when the entered model also identifies the matching Radeon
  // namespace. This prevents a Ryzen 9 7900X from being mistaken for an RX 7900.
  const normalizedAlias = normalize(alias).replace(/\s+/g, '');
  if (profile?.vendor === 'AMD' && /^\d{4}$/.test(normalizedAlias)) {
    const input = normalize(hardware);
    const label = normalize(entry?.label);
    if (/\bradeon rx\b/.test(label)) return /\b(?:radeon\s+rx|rx)\b/.test(input);
    if (/\bradeon (?:ai )?pro\b/.test(label)) {
      return /\b(?:radeon\s+(?:ai\s+)?pro|ai\s+pro|pro\s+w)\b/.test(input);
    }
    return /\b(?:radeon|ryzen|athlon|graphics)\b/.test(input);
  }
  return true;
}

function releaseOrdinal(value) {
  const match = String(value || '').toUpperCase().match(/^(\d{2})H([12])$/);
  return match ? (Number(match[1]) * 2) + Number(match[2]) : null;
}

function selectedOperatingSystem(value) {
  const match = String(value || '').toLowerCase().match(/^windows-(10|11)(?:-(\d{2}h[12]))?$/);
  if (!match) return null;
  return {
    family: `Windows ${match[1]}`,
    release: match[2]?.toUpperCase() || null,
  };
}

function operatingSystemSupport(profile, value) {
  if (!value || value === 'not-sure') return { supported: null, detail: '' };
  if (value === 'other') {
    return {
      supported: false,
      detail: `The official package lists ${(profile?.operatingSystems || []).join(' and ') || 'Windows only'}.`,
    };
  }

  const selected = selectedOperatingSystem(value);
  const published = Array.isArray(profile?.operatingSystems) ? profile.operatingSystems : [];
  if (!selected || !published.length) return { supported: null, detail: '' };

  const familyRows = published.filter(label => normalize(label).includes(normalize(selected.family)));
  if (!familyRows.length) {
    return {
      supported: false,
      detail: `The official package does not list ${selected.family}. It lists ${published.join(' and ')}.`,
    };
  }
  if (!selected.release) {
    return { supported: true, detail: `${selected.family} is listed by the vendor.` };
  }

  const selectedOrdinal = releaseOrdinal(selected.release);
  let sawVersionConstraint = false;
  for (const row of familyRows) {
    const upper = row.toUpperCase();
    const through = upper.match(/(\d{2}H[12])\s+THROUGH\s+(\d{2}H[12])/);
    if (through) {
      sawVersionConstraint = true;
      const start = releaseOrdinal(through[1]);
      const end = releaseOrdinal(through[2]);
      if (selectedOrdinal >= start && selectedOrdinal <= end) {
        return { supported: true, detail: `${selected.family} ${selected.release} is inside the vendor’s published ${through[1]}–${through[2]} range.` };
      }
      continue;
    }

    const later = upper.match(/(\d{2}H[12])\s+(?:AND\s+)?LATER/);
    if (later) {
      sawVersionConstraint = true;
      const minimum = releaseOrdinal(later[1]);
      if (selectedOrdinal >= minimum) {
        return { supported: true, detail: `${selected.family} ${selected.release} meets the vendor’s ${later[1]}-or-later requirement.` };
      }
      continue;
    }

    const explicit = [...upper.matchAll(/\b(\d{2}H[12])\b/g)].map(match => match[1]);
    if (explicit.length) {
      sawVersionConstraint = true;
      if (explicit.includes(selected.release)) {
        return { supported: true, detail: `${selected.family} ${selected.release} is explicitly listed by the vendor.` };
      }
    }
  }

  if (!sawVersionConstraint) {
    return { supported: true, detail: `${selected.family} is listed; the vendor does not narrow support to a specific feature release.` };
  }
  return {
    supported: false,
    detail: `${selected.family} ${selected.release} is outside the vendor’s published support range: ${familyRows.join(' and ')}.`,
  };
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

  const osSupport = operatingSystemSupport(profile, operatingSystem);
  if (osSupport.supported === false) {
    return {
      status: 'unsupported',
      title: 'Operating system not supported',
      detail: osSupport.detail,
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
    (entry.aliases || []).some(alias => compatibilityAliasMatches(profile, entry, enteredHardware, alias))
  );
  if (matches.length) {
    const best = matches.sort((left, right) =>
      Math.max(...(right.aliases || []).map(alias => normalize(alias).length), 0)
      - Math.max(...(left.aliases || []).map(alias => normalize(alias).length), 0)
    )[0];
    return {
      status: 'supported',
      title: best.matchType === 'family' ? 'Supported hardware family' : 'Supported by this package',
      detail: [`Matched the vendor’s official compatibility entry: ${best.label}.`, osSupport.detail].filter(Boolean).join(' '),
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
    detail: 'Try the exact graphics model, such as “Radeon RX 7900 XTX,” “Intel Arc A770,” or “GeForce RTX 5090.” A missing match is not treated as proof of compatibility.',
  };
}

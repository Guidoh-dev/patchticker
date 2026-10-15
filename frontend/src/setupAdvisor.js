import { compatibilityProfileFromUpdate, evaluateCompatibility } from './compatibility.js';
import { preferredReleaseAt } from './updateBrief.js';

export const SETUP_STORAGE_KEY = 'patchticker.setup.v1';
export const SETUP_DEVICES = [
  ['pc', 'Windows / Linux PC'], ['mac', 'Mac'], ['deck', 'Steam Deck'],
  ['ps5', 'PlayStation 5'], ['xbox', 'Xbox'], ['switch', 'Nintendo Switch'],
  ['switch2', 'Nintendo Switch 2'], ['mobile', 'iPhone / iPad'],
];
export const SETUP_OS = [
  ['not-sure', 'Choose OS / not sure'], ['windows-11-26h2', 'Windows 11 26H2'],
  ['windows-11-26h1', 'Windows 11 26H1'], ['windows-11-25h2', 'Windows 11 25H2'],
  ['windows-11-24h2', 'Windows 11 24H2'], ['windows-11-23h2', 'Windows 11 23H2'],
  ['windows-11', 'Windows 11 · version unknown'], ['windows-10-22h2', 'Windows 10 22H2'],
  ['other', 'Linux / another OS'],
];
const clean = value => String(value || '').trim().slice(0, 120);
const normalize = value => clean(value).toLowerCase().replace(/[™®]/g, '').replace(/([a-z])(\d)/g, '$1 $2').replace(/[^a-z0-9]+/g, ' ').trim();

export function normalizeSetup(raw = {}) {
  return {
    version: 1,
    device: SETUP_DEVICES.some(([key]) => key === raw.device) ? raw.device : 'pc',
    hardware: clean(raw.hardware), cpu: clean(raw.cpu),
    operatingSystem: SETUP_OS.some(([key]) => key === raw.operatingSystem) ? raw.operatingSystem : 'not-sure',
  };
}

export function validateSetup(raw) {
  const setup = normalizeSetup(raw);
  if (['pc', 'mac'].includes(setup.device) && !setup.hardware) return 'Enter your graphics card or Mac model to check the vendor’s support list.';
  return '';
}

export function readSavedSetup(session, local) {
  for (const storage of [session, local]) {
    try {
      const value = JSON.parse(storage?.getItem(SETUP_STORAGE_KEY) || 'null');
      if (value?.version === 1 && !validateSetup(value)) return normalizeSetup(value);
    } catch { /* Storage can be blocked or contain an old malformed value. */ }
  }
  return null;
}

export function saveSetup(raw, remember, session, local) {
  const setup = normalizeSetup(raw);
  if (validateSetup(setup)) return false;
  try {
    session?.setItem(SETUP_STORAGE_KEY, JSON.stringify(setup));
    if (remember) local?.setItem(SETUP_STORAGE_KEY, JSON.stringify(setup));
    else local?.removeItem(SETUP_STORAGE_KEY);
    return true;
  } catch { return false; }
}

export function clearSavedSetup(session, local) {
  for (const storage of [session, local]) {
    try { storage?.removeItem(SETUP_STORAGE_KEY); } catch { /* Keep the tool usable in private browsing. */ }
  }
}

export function graphicsVendor(hardware) {
  const text = normalize(hardware);
  if (/\b(?:nvidia|geforce|rtx|gtx|quadro)\b/.test(text)) return 'NVIDIA';
  if (/\b(?:radeon|rx)\b/.test(text)) return 'AMD';
  if (/\b(?:arc|iris|uhd)\b|\b[ab] \d{3}\b/.test(text)) return 'Intel';
  return null;
}

export function setupLabel(raw) {
  const setup = normalizeSetup(raw);
  return ['pc', 'mac'].includes(setup.device) ? setup.hardware : SETUP_DEVICES.find(([key]) => key === setup.device)?.[1] || 'Your setup';
}

function validScore(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10 ? value : null;
}

export function assessUpdateForSetup(update, raw) {
  const setup = normalizeSetup(raw);
  const profile = compatibilityProfileFromUpdate(update);
  const hardware = setup.device === 'deck' ? 'Steam Deck' : setup.hardware;
  const compatibility = evaluateCompatibility(profile, {
    hardware: hardware || setupLabel(setup), operatingSystem: setup.device === 'pc' ? setup.operatingSystem : 'not-sure',
  });
  const issues = (Array.isArray(update?.knownIssues) ? update.knownIssues : []).filter(value => typeof value === 'string' && value.trim());
  // Only identify a hardware-specific issue when the full entered identifier
  // occurs in the actual vendor issue. CPU brand alone must never match a GPU.
  const identifiers = [setup.hardware, setup.cpu].map(normalize).filter(value => value.length >= 5 && /\d/.test(value));
  const matchedIssues = issues.filter(issue => identifiers.some(identifier => ` ${normalize(issue)} `.includes(` ${identifier} `)));
  const sourceScore = validScore(update?.score);
  const severe = sourceScore !== null && sourceScore < 5;
  const caution = sourceScore !== null && sourceScore < 7.5;
  let title = 'Check the release notes';
  let tone = 'unverified';
  if (compatibility.status === 'unsupported') { title = 'This package does not match your setup'; tone = 'unsupported'; }
  else if (matchedIssues.length) { title = 'An issue names your hardware'; tone = 'caution'; }
  else if (severe) { title = 'Review the documented risks first'; tone = 'caution'; }
  else if (compatibility.status === 'supported') { title = caution || issues.length ? 'Support listed · review the issues' : 'Your hardware is listed'; tone = caution || issues.length ? 'caution' : 'supported'; }
  const devicePlatform = ({ ps5: 'PS5', xbox: 'Xbox', switch: 'Switch', switch2: 'Switch2', mobile: 'Apple' })[setup.device];
  const managedDevice = (devicePlatform && update?.platform === devicePlatform)
    || (setup.device === 'deck' && update?.sourceKind === 'steamos-news');
  const scopeDetail = managedDevice
    ? `These notes target ${setupLabel(setup)}. Use the device’s built-in updater to select the appropriate package and channel. Component-level performance and exact model eligibility have not been tested here.`
    : null;
  if (managedDevice && !severe && !matchedIssues.length) title = 'Device update · confirm your channel';
  return {
    update, compatibility, title, tone, sourceScore, issues, matchedIssues, scopeDetail,
    supportLabel: managedDevice ? 'Device updater selects the package' : null,
    issueSummary: issues.length ? `${issues.length} documented issue${issues.length === 1 ? '' : 's'} to review`
      : update?.knownIssuesAuthoritative ? 'Vendor lists no known issues' : 'No complete known-issue list supplied',
    sourceUrl: profile?.sourceUrl || update?.sourceUrl || (update?.evidence || []).find(item => item?.url)?.url || null,
  };
}

function relevantToSetup(update, setup) {
  const platform = update?.platform;
  const sourceKind = update?.sourceKind;
  if (setup.device === 'pc') {
    if (['AMD', 'NVIDIA', 'Intel'].includes(platform)) return platform === graphicsVendor(setup.hardware);
    if (platform === 'Windows') {
      if (!setup.operatingSystem.startsWith('windows') && setup.operatingSystem !== 'not-sure') return false;
      const family = setup.operatingSystem.match(/^windows-(10|11)/)?.[1];
      if (family && !new RegExp(`Windows\\s+${family}\\b`, 'i').test(update.name || '')) return false;
      const release = setup.operatingSystem.match(/(\d{2}h[12])$/i)?.[1];
      const namedReleases = String(update.name || '').match(/\b\d{2}H[12]\b/gi) || [];
      return !release || !namedReleases.length || namedReleases.some(value => value.toLowerCase() === release.toLowerCase());
    }
    return ['Chrome', 'Firefox', 'Edge', 'Discord', 'BattleNet', 'GOG'].includes(platform)
      || (platform === 'Steam' && sourceKind === 'steam-client-news');
  }
  if (setup.device === 'mac') return platform === 'macOS' || ['Chrome', 'Firefox', 'Edge'].includes(platform) || sourceKind === 'steam-client-news';
  if (setup.device === 'deck') return sourceKind === 'steamos-news' || sourceKind === 'steam-client-news';
  return platform === ({ ps5: 'PS5', xbox: 'Xbox', switch: 'Switch', switch2: 'Switch2', mobile: 'Apple' })[setup.device];
}

export function updatesForSetup(updates, raw) {
  const setup = normalizeSetup(raw);
  if (validateSetup(setup)) return [];
  const seen = new Set();
  const latest = [...(updates || [])].filter(update => relevantToSetup(update, setup))
    .sort((a, b) => Date.parse(preferredReleaseAt(b)) - Date.parse(preferredReleaseAt(a)))
    .filter(update => {
      const lane = update.sourceKind === 'steamos-news' ? 'SteamOS' : update.platform;
      if (seen.has(lane)) return false;
      seen.add(lane); return true;
    });
  return latest.map(update => assessUpdateForSetup(update, setup)).sort((a, b) => {
    const priority = item => item.update.platform === graphicsVendor(setup.hardware) || item.update.platform === 'macOS' || item.update.sourceKind === 'steamos-news' ? 0
      : item.update.platform === 'Windows' ? 1 : 2;
    return priority(a) - priority(b);
  });
}

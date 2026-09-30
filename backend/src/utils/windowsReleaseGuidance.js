'use strict';

const PREVIEW_VERDICT = 'Optional preview: wait unless you need a documented fix or feature. Check the KB’s known issues before installing on a primary PC.';
const PREVIEW_REASONING = 'Microsoft labels this Windows release as a preview. It is optional and should not be presented as a security update; review the listed changes and known issues before opting in.';
// Microsoft identifies these servicing lanes in the OS-build list on each KB.
// Use this only as a read-time repair for already-saved records; the scraper
// reads the authoritative "Applies To" section for future releases.
const WINDOWS_BUILD_LANES = Object.freeze({
  26100: '24H2',
  26200: '25H2',
  26300: '26H2',
  28000: '26H1',
});

function publicWindowsReleaseIdentity(platform, name, affects) {
  if (platform !== 'Windows' || !/^Windows 11 \d{2}H[12](?:\/\d{2}H[12])*/i.test(String(name || ''))) {
    return { name, affects };
  }
  const builds = String(name).match(/\(OS Builds? ([^)]+)\)/i)?.[1] || '';
  const prefixes = [...builds.matchAll(/\b(\d{5})\.\d+\b/g)].map(match => match[1]);
  if (prefixes.length < 2 || prefixes.some(prefix => !WINDOWS_BUILD_LANES[prefix])) {
    return { name, affects };
  }
  const versions = [...new Set(prefixes.map(prefix => WINDOWS_BUILD_LANES[prefix]))].sort();
  if (versions.length < 2) { return { name, affects }; }
  return {
    name: String(name).replace(/^Windows 11 \d{2}H[12](?:\/\d{2}H[12])*/i, `Windows 11 ${versions.join('/')}`),
    affects: `Windows 11 versions ${versions.join(', ')} / cumulative OS servicing`,
  };
}

function isWindowsPreview(platform, name) {
  return platform === 'Windows' && /\bpreview\b/i.test(String(name || ''));
}

function publicWindowsGuidance(platform, name, verdict, reasoning) {
  if (!isWindowsPreview(platform, name)) return { verdict, reasoning };
  return {
    verdict: !verdict || /security fixes usually make this worth scheduling quickly/i.test(verdict)
      ? PREVIEW_VERDICT : verdict,
    reasoning: !reasoning || /^Windows cumulative updates can include security patches/i.test(reasoning)
      ? PREVIEW_REASONING : reasoning,
  };
}

module.exports = { PREVIEW_VERDICT, PREVIEW_REASONING, isWindowsPreview, publicWindowsGuidance, publicWindowsReleaseIdentity };

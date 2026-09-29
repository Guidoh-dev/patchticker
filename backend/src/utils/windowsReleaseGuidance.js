'use strict';

const PREVIEW_VERDICT = 'Optional preview: wait unless you need a documented fix or feature. Check the KB’s known issues before installing on a primary PC.';
const PREVIEW_REASONING = 'Microsoft labels this Windows release as a preview. It is optional and should not be presented as a security update; review the listed changes and known issues before opting in.';

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

module.exports = { PREVIEW_VERDICT, PREVIEW_REASONING, isWindowsPreview, publicWindowsGuidance };

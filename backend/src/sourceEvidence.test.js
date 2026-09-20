'use strict';

const { sourceKindFromEvidence } = require('./utils/sourceEvidence');

describe('official source evidence classification', () => {
  test('uses the strongest official evidence regardless of input order', () => {
    expect(sourceKindFromEvidence([
      { url: 'https://vendor.example/version', releaseType: 'official-version' },
      { url: 'https://vendor.example/release', releaseType: 'official-release' },
      { url: 'https://vendor.example/security', releaseType: 'official-security-release' },
    ])).toBe('official-security-release');
  });

  test('canonicalizes legacy security, version, and artifact evidence labels', () => {
    expect(sourceKindFromEvidence([
      { url: 'https://support.apple.com/security', releaseType: 'official-security-index' },
    ])).toBe('official-security-advisory');
    expect(sourceKindFromEvidence([
      { url: 'https://vendor.example/manifest', releaseType: 'version-only' },
    ])).toBe('official-version');
    expect(sourceKindFromEvidence([
      { url: 'https://vendor.example/artifact', releaseType: 'artifact-only' },
    ])).toBe('official-artifact');
  });

  test('does not promote community evidence and safely labels untyped first-party evidence', () => {
    expect(sourceKindFromEvidence([
      { source: 'Reddit', url: 'https://reddit.com/r/vendor/comments/1', releaseType: 'official-release' },
    ])).toBeNull();
    expect(sourceKindFromEvidence([
      { source: 'Vendor', url: 'https://vendor.example/release' },
    ])).toBe('official-source');
  });
});

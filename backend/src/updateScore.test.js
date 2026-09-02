'use strict';

const {
  validateScore,
  requireValidScore,
  isResolvedStatement,
  isNegativeKnownIssueStatement,
  isDocumentedBenefitStatement,
  deriveDeterministicScoreBreakdown,
  deriveDeterministicScore,
  deriveDeterministicImpactScore,
  statusForScore,
} = require('./utils/updateScore');

describe('deterministic update scoring', () => {
  test.each([NaN, Infinity, -Infinity, null, undefined, '', '   ', 'not-a-score', -0.1, 10.1])(
    'rejects an invalid rating value: %p',
    value => expect(validateScore(value).ok).toBe(false),
  );

  test.each([true, false, [], [5], {}, '0x5', '5/10', '1e1'])(
    'rejects coercible but malformed rating input: %p',
    value => expect(validateScore(value).ok).toBe(false),
  );

  test.each([0, 0.1, 5, 9.9, 10, '7.4'])(
    'accepts and normalizes a bounded rating value: %p',
    value => expect(validateScore(value)).toEqual({ ok: true, value: Number(value), reason: null }),
  );

  test('throws instead of silently substituting a default score', () => {
    expect(() => requireValidScore(NaN)).toThrow(/Invalid score: not_finite/);
    expect(() => requireValidScore(11)).toThrow(/Invalid score: out_of_bounds/);
  });

  test('uses only documented metadata and is repeatable', () => {
    const input = {
      name: 'Vendor Driver 42.1',
      version: '42.1',
      changelog: ['Adds documented game support.', 'Corrects a documented rendering issue.', 'Updates the installer.'],
      knownIssues: ['A vendor-listed display issue remains.'],
      knownIssuesAuthoritative: true,
      riskFactors: [{ level: 'medium', text: 'Vendor lists a compatibility limitation.' }],
      evidence: [{ source: 'Vendor release notes', url: 'https://vendor.example/releases/42-1' }],
      securityCriticality: { level: 'low', label: 'No critical security issue', cves: [] },
    };

    const first = deriveDeterministicScore(input);
    const second = deriveDeterministicScore(JSON.parse(JSON.stringify(input)));
    expect(first).toBe(second);
    expect(validateScore(first).ok).toBe(true);
    expect(validateScore(deriveDeterministicImpactScore(input)).ok).toBe(true);
    expect(statusForScore(first)).toMatch(/stable|caution|avoid/);
  });

  test('returns the same bounded score through the auditable breakdown', () => {
    const input = {
      sourceKind: 'official-release-notes',
      changelog: ['Added support for new hardware.', 'Fixed a crash during installation.'],
      evidence: [{ source: 'Vendor', url: 'https://vendor.example/notes' }],
    };
    const breakdown = deriveDeterministicScoreBreakdown(input);
    expect(breakdown.score).toBe(deriveDeterministicScore(input));
    expect(validateScore(breakdown.score).ok).toBe(true);
    expect(breakdown.signals).toMatchObject({ unresolvedIssues: 0, resolvedChanges: 1 });
  });

  test('does not treat resolved defects or negative issue acknowledgements as active defects', () => {
    expect(isResolvedStatement('Fixed a bug that caused the game to crash.')).toBe(true);
    expect(isResolvedStatement('Reduced the crash rate on Nintendo Switch.')).toBe(true);
    expect(isResolvedStatement('Fixed one path, but crashes may still occur.')).toBe(false);
    expect(isNegativeKnownIssueStatement('Microsoft is not currently aware of any issues with this update.')).toBe(true);

    const base = {
      sourceKind: 'official-release-notes',
      changelog: ['Fixed a crash during startup.', 'Improved display compatibility.'],
      knownIssuesAuthoritative: true,
      evidence: [{ source: 'Vendor release notes', url: 'https://vendor.example/release' }],
    };
    const resolved = deriveDeterministicScore({
      ...base,
      knownIssues: ['Fixed a bug that caused the application to crash.'],
      riskFactors: [{ level: 'medium', text: 'Reduced the crash rate on supported devices.' }],
    });
    const active = deriveDeterministicScore({
      ...base,
      knownIssues: ['The application may crash during startup.'],
      riskFactors: [{ level: 'medium', text: 'A startup regression remains under investigation.' }],
    });
    expect(resolved).toBeGreaterThan(active);
  });

  test('lets clean official releases with concrete benefits reach the stable band', () => {
    const cleanRelease = {
      name: 'Vendor App 9.0',
      sourceKind: 'official-release-notes',
      changelog: [
        'Added native support for the latest operating system.',
        'Fixed a crash during application startup.',
        'Improved rendering performance on supported hardware.',
        'Resolved an installer reliability problem.',
      ],
      knownIssues: [],
      riskFactors: [],
      evidence: [{
        source: 'Vendor release notes',
        url: 'https://vendor.example/releases/9-0',
        releaseType: 'official-release-notes',
      }],
    };

    const breakdown = deriveDeterministicScoreBreakdown(cleanRelease);
    expect(breakdown.score).toBeGreaterThanOrEqual(7.5);
    expect(statusForScore(breakdown.score)).toBe('stable');
    expect(breakdown.signals).toMatchObject({
      documentedBenefits: 4,
      cleanDocumentedRelease: true,
    });
  });

  test('recognizes a generic official release as full notes without trusting version-only evidence', () => {
    const cleanOfficialRelease = {
      sourceKind: 'official-release',
      changelog: [
        'Added support for a new controller family.',
        'Improved download reliability.',
        'Fixed a crash while applying updates.',
      ],
      knownIssues: [],
      riskFactors: [],
      evidence: [{ source: 'Vendor', url: 'https://vendor.example/release', releaseType: 'official-release' }],
    };
    expect(deriveDeterministicScore(cleanOfficialRelease)).toBeGreaterThanOrEqual(7.5);

    const versionOnly = {
      ...cleanOfficialRelease,
      sourceKind: 'official-version',
      evidence: [{ source: 'Vendor', url: 'https://vendor.example/version', releaseType: 'official-version' }],
    };
    expect(deriveDeterministicScore(versionOnly)).toBeLessThanOrEqual(6.3);
  });

  test('does not reward upbeat prose without official evidence or concrete shipped changes', () => {
    expect(isDocumentedBenefitStatement('An amazing update with a fantastic experience.')).toBe(false);
    const ungrounded = deriveDeterministicScore({
      changelog: ['An amazing update with a fantastic experience.'],
      knownIssues: [],
      riskFactors: [],
      evidence: [],
    });
    expect(ungrounded).toBeLessThanOrEqual(6.4);
  });

  test('documented unresolved issues keep an otherwise positive release out of false-green territory', () => {
    const risky = deriveDeterministicScore({
      name: 'Vendor App 9.1',
      sourceKind: 'official-release-notes',
      changelog: [
        'Added a new renderer.',
        'Improved startup performance.',
        'Fixed an installer crash.',
        'Resolved display flickering.',
      ],
      knownIssues: ['The application may still crash during startup on supported devices.'],
      knownIssuesAuthoritative: true,
      riskFactors: [{ level: 'high', text: 'A startup regression remains under investigation.' }],
      evidence: [{ source: 'Vendor', url: 'https://vendor.example/releases/9-1', releaseType: 'official-release-notes' }],
    });
    expect(risky).toBeLessThan(7.5);
  });

  test('even a low unresolved risk blocks non-security releases from the stable band', () => {
    const risky = deriveDeterministicScore({
      name: 'Vendor Driver 10.0',
      sourceKind: 'official-release-notes',
      changelog: [
        'Added support for seven new games.',
        'Improved frame pacing.',
        'Fixed display flickering.',
        'Resolved an installer crash.',
        'Enhanced application performance.',
      ],
      knownIssues: ['Notebook vendors may provide a more compatible certified driver.'],
      riskFactors: [{ level: 'low', text: 'Notebook compatibility remains vendor-dependent.' }],
      evidence: [{ source: 'Vendor', url: 'https://vendor.example/releases/10', releaseType: 'official-release-notes' }],
    });
    expect(risky).toBeLessThan(7.5);
  });

  test('adds security urgency only when official security evidence is documented', () => {
    const base = {
      sourceKind: 'official-release-notes',
      changelog: ['Updates a documented system component.'],
      evidence: [{ source: 'Vendor release notes', url: 'https://vendor.example/release' }],
      securityCriticality: { level: 'high', cves: [] },
    };
    const ungrounded = deriveDeterministicScore(base);
    const grounded = deriveDeterministicScore({
      ...base,
      sourceKind: 'official-security-advisory',
      evidence: [{ source: 'Vendor security advisory', url: 'https://vendor.example/security/CVE-2026-1234' }],
      securityCriticality: { level: 'high', cves: ['CVE-2026-1234'] },
    });
    expect(grounded).toBeGreaterThan(ungrounded);
  });

  test('uses documented change surface instead of collapsing official releases to one default', () => {
    const fixture = (count, length, sourceKind = 'official-release-notes') => ({
      sourceKind,
      changelog: Array.from({ length: count }, (_, index) => `Documented release change ${index + 1}: ${'x'.repeat(length + index * 7)}`),
      evidence: [{ source: 'Vendor release notes', url: 'https://vendor.example/release' }],
    });
    const scores = [
      deriveDeterministicScore(fixture(3, 70)),
      deriveDeterministicScore(fixture(8, 105)),
      deriveDeterministicScore(fixture(14, 145, 'steam-game-news')),
      deriveDeterministicScore(fixture(1, 30, 'official-version')),
    ];
    expect(new Set(scores).size).toBeGreaterThanOrEqual(3);
    expect(scores.every(score => score !== 7.2)).toBe(true);
  });

  test('vendor-labelled prereleases and documented risk reduce the score', () => {
    const base = {
      changelog: ['A sufficiently detailed official release note describing the shipped changes.'],
      evidence: [{ source: 'Vendor', url: 'https://vendor.example/release' }],
    };
    const stable = deriveDeterministicScore({ ...base, name: 'Driver 12.0' });
    const preview = deriveDeterministicScore({
      ...base,
      name: 'Driver 12.1 Preview',
      riskFactors: [{ level: 'high', text: 'Vendor-documented regression.' }],
    });
    expect(preview).toBeLessThan(stable);
  });
});

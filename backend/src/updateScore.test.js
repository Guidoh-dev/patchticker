'use strict';

const {
  validateScore,
  requireValidScore,
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

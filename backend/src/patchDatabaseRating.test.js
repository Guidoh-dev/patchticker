const { ratingTest } = require('../../scripts/build_patch_database');

describe('patch research rating test', () => {
  test('does not confuse a supported beta game with a beta graphics driver', () => {
    const result = ratingTest({
      platform: 'Intel',
      name: 'Intel Arc Graphics Driver 32.0.101.8864 Non-WHQL',
      version: '32.0.101.8864',
      changelog: ['Game support — Gears of War: E-Day Open BETA.'],
      reasoning: '',
      evidence: [{ source: 'Intel Release Notes', url: 'https://downloadmirror.intel.com/release-notes.pdf' }],
      riskFactors: [
        { level: 'medium', text: 'This is a Non-WHQL driver.' },
        { level: 'low', text: 'Check the OEM-qualified package first.' },
      ],
      knownIssues: Array.from({ length: 12 }, (_, index) => `Hardware issue ${index + 1}`),
      bugCount: 0,
    });

    expect(result.score).toBe(6);
    expect(result.label).toBe('mixed/caution');
    expect(result.notes).not.toContain('Beta/preview channel language detected.');
  });

  test('still penalizes an explicitly labeled beta release', () => {
    const result = ratingTest({
      platform: 'Intel',
      name: 'Intel Arc Beta Driver',
      version: '1.2.3',
      changelog: [],
      reasoning: '',
      evidence: [{ source: 'Intel Release Notes', url: 'https://downloadmirror.intel.com/release-notes.pdf' }],
      riskFactors: [],
      knownIssues: [],
      bugCount: 0,
    });

    expect(result.score).toBe(7.2);
    expect(result.notes).toContain('Beta/preview channel language detected.');
  });
});

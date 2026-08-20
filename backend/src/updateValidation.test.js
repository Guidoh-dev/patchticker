'use strict';

const {
  UpdateValidationError,
  validateUpdateForPersistence,
} = require('./services/updateValidationService');

function validUpdate(overrides = {}) {
  return {
    id: 'nvidia-700-10',
    platform: 'NVIDIA',
    name: 'NVIDIA Game Ready Driver 700.10',
    version: '700.10',
    releasedAt: '2026-08-19',
    score: 8.4,
    impactScore: 65,
    verdict: 'Install when the documented game support applies.',
    reasoning: 'The official notes document a current driver release.',
    changelog: ['  Added game support.\u0000  ', '', null],
    knownIssues: ['', { level: 'medium', text: '  Display flicker may occur.  ', empty: '' }],
    riskFactors: [],
    evidence: [{
      source: 'NVIDIA Driver Downloads',
      url: 'https://www.nvidia.com/download/index.aspx',
      text: 'Official release metadata.',
      dateBasis: 'released',
      publishedAt: '2026-08-19T14:30:00-04:00',
    }],
    ...overrides,
  };
}

describe('pre-persistence update validation', () => {
  test('sanitizes content, normalizes 0-100 ratings, and uses official UTC publication time', () => {
    const result = validateUpdateForPersistence(validUpdate());
    expect(result.value.score).toBe(8.4);
    expect(result.value.impactScore).toBe(6.5);
    expect(result.ratingScales).toEqual({ score: 10, impactScore: 100 });
    expect(result.value.releasedAt).toBe('2026-08-19T18:30:00.000Z');
    expect(result.timestampSource).toBe('official-evidence');
    expect(result.value.changelog).toEqual(['Added game support.']);
    expect(result.value.knownIssues).toEqual([{ level: 'medium', text: 'Display flicker may occur.' }]);
  });

  test.each([NaN, Infinity, 'NaN', 101, -1])('rejects malformed or out-of-bounds ratings: %p', score => {
    expect(() => validateUpdateForPersistence(validUpdate({ score }))).toThrow(UpdateValidationError);
  });

  test('rejects corrupt required text and future timestamps before insertion', () => {
    expect(() => validateUpdateForPersistence(validUpdate({
      name: '\u0000\u0001',
      releasedAt: '2099-01-01',
      evidence: [],
    }), { now: Date.parse('2026-08-20T00:00:00.000Z') })).toThrow(expect.objectContaining({
      code: 'UPDATE_VALIDATION_REJECTED',
    }));
  });

  test('replaces an empty changelog only with validated reasoning', () => {
    const result = validateUpdateForPersistence(validUpdate({ changelog: ['', null] }));
    expect(result.value.changelog).toEqual([result.value.reasoning]);
    expect(result.warnings).toContain('changelog: replaced empty payload with validated reasoning');
  });
});

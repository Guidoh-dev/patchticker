'use strict';

jest.mock('./config/db', () => ({
  isAvailable: jest.fn(() => true),
  query: jest.fn(),
}));
jest.mock('./utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('./services/scraperService', () => ({ DETECTORS: {} }));
jest.mock('./services/aiAnalysisService', () => ({ isEnabled: jest.fn(() => false), analyseUpdate: jest.fn() }));
jest.mock('./services/watchlistService', () => ({ notifySubscribers: jest.fn() }));

const db = require('./config/db');
const { __test } = require('./services/pipelineService');

describe('pipeline source metadata preservation', () => {
  beforeEach(() => jest.clearAllMocks());

  test('platform context carries official security metadata into persistence', () => {
    const securityCriticality = {
      level: 'high',
      label: '86 documented CVEs',
      cves: ['CVE-2026-64732'],
      totalCves: 86,
    };
    expect(__test.platformContext('Apple', {
      name: 'iOS 26.6',
      changelog: ['WebKit: arbitrary code execution'],
      securityCriticality,
    }).securityCriticality).toEqual(securityCriticality);
  });

  test('same-version refresh updates security criticality without requiring a new release', async () => {
    const securityCriticality = {
      level: 'high',
      label: '86 documented CVEs',
      cves: ['CVE-2026-64732'],
      totalCves: 86,
    };
    db.query.mockResolvedValue({ rows: [] });

    await __test.updateExistingMetadata('Apple', '26.6', {
      name: 'iOS 26.6 and iPadOS 26.6',
      version: '26.6',
      releasedAt: '2026-07-27',
      changelog: ['WebKit: arbitrary code execution'],
      evidence: [{ source: 'Apple', url: 'https://support.apple.com/en-us/128066' }],
      securityCriticality,
    });

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('security_criticality = COALESCE($12::jsonb, security_criticality)');
    expect(JSON.parse(params[11])).toEqual(securityCriticality);
    expect(params[12]).toEqual(expect.any(Number));
    expect(params[13]).toMatch(/stable|caution|avoid/);
    expect(params[14]).toBe(false);
  });

  test('authoritative source refreshes can clear a resolved known-issue list', async () => {
    db.query.mockResolvedValue({ rows: [] });

    await __test.updateExistingMetadata('Windows', 'KB5121000', {
      name: 'Windows 11 KB5121000 Security Update',
      version: 'KB5121000',
      releasedAt: '2026-08-11',
      changelog: ['August 2026 Security Updates'],
      knownIssues: [],
      knownIssuesAuthoritative: true,
      evidence: [{ source: 'Microsoft Support', url: 'https://support.microsoft.com/kb5121000' }],
    });

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain("known_issues = CASE WHEN $9::jsonb <> '[]'::jsonb OR $15::boolean");
    expect(params[8]).toBe('[]');
    expect(params[14]).toBe(true);
  });

  test('a supported beta game does not misclassify the graphics driver as a beta release', () => {
    const detected = {
      name: 'Intel Arc Graphics Driver 32.0.101.8864 Non-WHQL',
      version: '32.0.101.8864',
    };
    const context = {
      changelog: ['Game support — Gears of War: E-Day Open BETA.'],
      knownIssues: Array.from({ length: 12 }, (_, index) => `Hardware-scoped issue ${index + 1}`),
      riskFactors: [
        { level: 'medium', text: 'This is a Non-WHQL driver.' },
        { level: 'low', text: 'Check the OEM-customized package first.' },
      ],
    };

    const score = __test.deriveInitialScore('Intel', detected, context);
    expect(score).toBe(5);
    expect(__test.deriveInitialStatus(score)).toBe('caution');
  });
});

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
  });
});

'use strict';

const mockQuery = jest.fn();
const mockRelease = jest.fn();

jest.mock('./config/db', () => ({
  isAvailable: jest.fn(() => true),
  getClient: jest.fn(async () => ({ query: mockQuery, release: mockRelease })),
}));
jest.mock('./utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const service = require('./services/ratingReconciliationService');

describe('rating reconciliation', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockRelease.mockReset();
  });

  test('updates only rows whose deterministic score, status, or impact drifted', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{
        id: 'intel-old',
        platform: 'Intel',
        name: 'Intel Driver 12.1 Non-WHQL',
        version: '12.1',
        source_kind: 'official-release-notes',
        score: '1.0',
        status: 'avoid',
        impact_score: '1.0',
        changelog: ['Added support for a new game.'],
        known_issues: ['A game may crash during startup.'],
        risk_factors: [{ level: 'medium', text: 'This is a Non-WHQL driver.' }],
        evidence: [{ source: 'Intel', url: 'https://intel.example/release', releaseType: 'official-release-notes', knownIssuesAuthoritative: true }],
        security_criticality: { level: 'none', cves: [] },
      }] })
      .mockResolvedValue({ rowCount: 1 });

    const result = await service.run();
    expect(result).toMatchObject({ status: 'updated', scanned: 1, changed: 1, updated: 1 });
    expect(mockQuery).toHaveBeenCalledWith('BEGIN');
    expect(mockQuery.mock.calls.some(([sql]) => /UPDATE software_updates/.test(sql))).toBe(true);
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  test('performs no write transaction when every live row is current', async () => {
    const row = {
      id: 'clean-release',
      platform: 'Discord',
      name: 'Discord 1.0',
      version: '1.0',
      source_kind: 'official-release-notes',
      status: 'stable',
      changelog: ['Added native support.', 'Fixed a startup crash.', 'Improved performance.'],
      known_issues: [],
      risk_factors: [],
      evidence: [{ source: 'Discord', url: 'https://discord.example/release', releaseType: 'official-release-notes', knownIssuesAuthoritative: true }],
      security_criticality: { level: 'none', cves: [] },
    };
    const current = service.__test.reconcileRow({ ...row, score: 0, impact_score: 0 });
    mockQuery.mockResolvedValueOnce({ rows: [{ ...row, score: current.score, impact_score: current.impactScore, status: current.status }] });

    const result = await service.run();
    expect(result).toEqual({ status: 'current', scanned: 1, changed: 0, updated: 0 });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});

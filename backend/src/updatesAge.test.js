'use strict';

const mockQuery = jest.fn();
const mockIsAvailable = jest.fn(() => false);

jest.mock('./config/db', () => ({
  query: mockQuery,
  isAvailable: mockIsAvailable,
}));
jest.mock('./config/secrets', () => ({
  getRedditCredentials: () => ({ clientId: '', clientSecret: '', userAgent: '' }),
}));
jest.mock('./utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const updatesService = require('./services/updatesService');
const originalNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-08-11T12:00:00Z'));
  mockQuery.mockReset();
  mockIsAvailable.mockReset().mockReturnValue(false);
});

afterEach(() => {
  jest.useRealTimers();
  process.env.NODE_ENV = originalNodeEnv;
});

test('static update listings exclude releases older than 240 days', async () => {
  const updates = await updatesService.getUpdates();
  const cutoff = Date.now() - (240 * 24 * 60 * 60 * 1000);

  expect(updates.length).toBeGreaterThan(0);
  expect(updates.every(update => Date.parse(update.releasedAt) >= cutoff)).toBe(true);
  expect(updates.some(update => update.id === 'steam-cs2-mar-2025')).toBe(false);
});

test('expired direct update permalinks no longer return update content', async () => {
  await expect(updatesService.getUpdateById('steam-cs2-mar-2025')).resolves.toBeNull();
  await expect(updatesService.getUpdateById('steam-apex-legends-july-2026')).resolves.toMatchObject({
    id: 'steam-apex-legends-july-2026',
  });
});

test('database update and history queries enforce the same 240-day window', async () => {
  mockIsAvailable.mockReturnValue(true);
  mockQuery.mockResolvedValue({ rows: [] });

  await updatesService.getUpdates();
  await updatesService.getUpdateHistory('Steam');

  const updateQueries = mockQuery.mock.calls
    .map(([sql]) => sql)
    .filter(sql => sql.includes('software_updates'));
  expect(updateQueries).toHaveLength(2);
  expect(updateQueries.every(sql => sql.includes("INTERVAL '240 days'"))).toBe(true);
});

test('successful database reads never mix static samples into the live feed', async () => {
  mockIsAvailable.mockReturnValue(true);
  mockQuery.mockImplementation(async (sql) => {
    if (sql.includes('FROM update_ratings')) return { rows: [] };
    return { rows: [{
      id: 'vendor-real-1-2-3', platform: 'Windows', name: 'Verified Vendor Release', version: '1.2.3',
      released_at: '2026-08-10', status: 'stable', score: '8.2', impact_score: '4.0', bug_count: 0,
      affects: 'Supported systems', verdict: 'Install', reasoning: 'Official notes loaded.', changelog: [],
      known_issues: [], risk_factors: [], evidence: [{ source: 'Vendor', url: 'https://vendor.example/release', releaseType: 'official-release' }],
      security_criticality: null, subreddits: [], ai_generated: false, ai_model: null, ai_generated_at: null,
      created_at: '2026-08-10T12:00:00Z', updated_at: '2026-08-11T11:00:00Z',
    }] };
  });

  const updates = await updatesService.getUpdates();
  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({ id: 'vendor-real-1-2-3', updatedAt: '2026-08-11T11:00:00Z' });
  expect(updates.some(update => update.id === 'steam-apex-legends-july-2026')).toBe(false);
});

test('successful empty DB reads stay empty instead of reviving static samples', async () => {
  mockIsAvailable.mockReturnValue(true);
  mockQuery.mockResolvedValue({ rows: [] });

  await expect(updatesService.getUpdates({ search: 'not-a-real-release' })).resolves.toEqual([]);
  await expect(updatesService.getUpdateById('steam-apex-legends-july-2026')).resolves.toBeNull();
});

test('monthly placeholders require official release metadata', () => {
  const base = { platform: 'PS5', version: '2026-08', releasedAt: '2026-08-05' };
  expect(updatesService.__test.isUpdateDisplayable({ ...base, evidence: [{ source: 'Support' }] })).toBe(false);
  expect(updatesService.__test.isUpdateDisplayable({
    ...base,
    evidence: [{ source: 'Support', releaseType: 'official-version' }],
  })).toBe(true);
});

test('production outages never expose static demo updates as live data', async () => {
  process.env.NODE_ENV = 'production';
  mockIsAvailable.mockReturnValue(false);

  await expect(updatesService.getUpdates()).resolves.toEqual([]);
  await expect(updatesService.getUpdateById('steam-apex-legends-july-2026')).resolves.toBeNull();
  await expect(updatesService.getSentimentSummary()).resolves.toMatchObject({
    stable: 0,
    caution: 0,
    avoid: 0,
    avgScore: null,
    dataMode: 'unavailable',
    sourceBacked: 0,
  });
});

test('feed metadata reports freshness and source coverage', () => {
  mockIsAvailable.mockReturnValue(true);
  const meta = updatesService.buildFeedMeta([
    { updatedAt: '2026-08-11T10:00:00Z', officialSourceCount: 1 },
    { updatedAt: '2026-08-06T10:00:00Z', officialSourceCount: 0 },
  ]);

  expect(meta).toEqual({
    dataMode: 'live',
    sourceBacked: 1,
    fresh24h: 1,
    stale96h: 1,
    lastCheckedAt: '2026-08-11T10:00:00Z',
  });
});

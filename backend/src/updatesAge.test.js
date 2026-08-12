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

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-08-11T12:00:00Z'));
  mockQuery.mockReset();
  mockIsAvailable.mockReset().mockReturnValue(false);
});

afterEach(() => {
  jest.useRealTimers();
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

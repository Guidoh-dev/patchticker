'use strict';

jest.mock('./utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  currentSteamGameRoster,
  refreshSteamGameRoster,
  __test,
} = require('./services/steamGameEligibilityService');

const steamPage = rows => `<table class="common-table"><tbody>${rows.map(row => `
  <tr><td></td><td><a href="/app/${row.appId}">${row.name}</a></td><td>1</td><td></td><td>2</td><td>${row.hours}</td></tr>
`).join('')}</tbody></table>`;

const usPage = rows => `<main>${rows.map(row => `<a href="https://store.steampowered.com/app/${row.appId}/">${row.name}</a>`).join('')}</main>`;

beforeEach(() => __test.resetCacheForTests());

test('derives global 30-day averages from SteamCharts hours played', () => {
  expect(__test.parseSteamChartsPage(steamPage([
    { appId: 730, name: 'Counter-Strike 2', hours: 72000000 },
  ]))).toEqual([expect.objectContaining({
    appId: 730,
    name: 'Counter-Strike 2',
    averageConcurrentPlayers: 100000,
  })]);
});

test('US chart parser keeps the official display order and unique app ids', () => {
  expect(__test.parseSteamUsChart(usPage([
    { appId: 730, name: 'Counter-Strike 2' },
    { appId: 570, name: 'Dota 2' },
    { appId: 730, name: 'Counter-Strike 2' },
  ]))).toEqual([
    { appId: 730, name: 'Counter-Strike 2', rank: 1 },
    { appId: 570, name: 'Dota 2', rank: 2 },
  ]);
});

test('roster requires both threshold qualification and a US-market match', () => {
  const audit = __test.buildCandidateRoster([
    { appId: 730, name: 'Counter-Strike 2', averageConcurrentPlayers: 50001 },
    { appId: 570, name: 'Dota 2', averageConcurrentPlayers: 50000 },
    { appId: 578080, name: 'PUBG', averageConcurrentPlayers: 300000 },
    { appId: 431960, name: 'Wallpaper Engine', averageConcurrentPlayers: 90000 },
  ], [
    { appId: 730, name: 'Counter-Strike 2', rank: 1 },
    { appId: 570, name: 'Dota 2', rank: 2 },
    { appId: 431960, name: 'Wallpaper Engine', rank: 3 },
  ], '2026-09-05T12:00:00.000Z');

  expect(audit.accepted).toEqual([expect.objectContaining({ appId: 730, usMarketRank: 1 })]);
  expect(audit.rejected).toHaveLength(0);
});

test('refresh accepts a healthy chart roster and caches it', async () => {
  const candidates = Array.from({ length: 8 }, (_, index) => ({
    appId: 1000 + index,
    name: `Game ${index}`,
    hours: 50001 * 720 + index * 720,
  }));
  const usRows = Array.from({ length: 50 }, (_, index) => ({
    appId: index < candidates.length ? candidates[index].appId : 5000 + index,
    name: index < candidates.length ? candidates[index].name : `US Game ${index}`,
  }));
  const loader = jest.fn(async url => url.includes('topselling/US') ? usPage(usRows) : steamPage(candidates));

  const refreshed = await refreshSteamGameRoster({ force: true, now: Date.parse('2026-09-05T12:00:00.000Z'), fetchHtml: loader });
  expect(refreshed).toMatchObject({ source: 'live_charts', stale: false });
  expect(refreshed.candidates).toHaveLength(8);

  await refreshSteamGameRoster({ now: Date.parse('2026-09-05T13:00:00.000Z'), fetchHtml: loader });
  expect(loader).toHaveBeenCalledTimes(7);
});

test('malformed live pages preserve the reviewed fallback roster', async () => {
  const fallback = currentSteamGameRoster();
  const refreshed = await refreshSteamGameRoster({
    force: true,
    now: Date.parse('2026-09-05T12:00:00.000Z'),
    fetchHtml: async () => '<html>blocked</html>',
  });
  expect(refreshed.source).toBe('reviewed_snapshot');
  expect(refreshed.candidates).toEqual(fallback.candidates);
  expect(refreshed.error).toMatch(/chart validation failed/);
});

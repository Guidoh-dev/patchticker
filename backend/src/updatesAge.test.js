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

test('database detail queries reject expired rows before hydration', async () => {
  mockIsAvailable.mockReturnValue(true);
  mockQuery.mockResolvedValue({ rows: [] });

  await updatesService.getUpdateById('expired-update');

  expect(mockQuery).toHaveBeenCalledWith(
    expect.stringContaining("released_at >= NOW() - INTERVAL '240 days'"),
    ['expired-update']
  );
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
      known_issues: [], risk_factors: [], evidence: [{ source: 'Vendor', url: 'https://vendor.example/release', releaseType: 'official-release', knownIssuesAuthoritative: true }],
      security_criticality: null, subreddits: [], ai_generated: false, ai_model: null, ai_generated_at: null,
      created_at: '2026-08-10T12:00:00Z', updated_at: '2026-08-11T11:00:00Z',
    }] };
  });

  const updates = await updatesService.getUpdates();
  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({
    id: 'vendor-real-1-2-3',
    analysisMethod: 'official-release-notes',
    firstSeenAt: '2026-08-10T12:00:00Z',
    updatedAt: '2026-08-11T11:00:00Z',
    knownIssuesAuthoritative: true,
    securityCriticality: { level: 'none', label: 'Security context not classified', cves: [] },
  });
  expect(updates.some(update => update.id === 'steam-apex-legends-july-2026')).toBe(false);
});

test('source scope distinguishes full notes, security advisories, and version-only verification', () => {
  const classify = updatesService.__test.analysisMethodForEvidence;
  expect(classify([{ releaseType: 'official-release-notes' }])).toBe('official-release-notes');
  expect(classify([{ releaseType: 'official-game-update' }])).toBe('official-release-notes');
  expect(classify([{ releaseType: 'official-security-advisory' }])).toBe('official-security-advisory');
  expect(classify([{ releaseType: 'official-version' }, { releaseType: 'official-download' }])).toBe('official-version');
  expect(classify([{ releaseType: 'official-artifact' }])).toBe('official-artifact');
  expect(classify([])).toBe('source-and-issue-signals');
});

test('verified evidence metadata is promoted for API clients without inference', () => {
  const baseRow = {
    id: 'steam-game-release', platform: 'Steam', name: 'Verified game update', version: '1.2.3',
    product_id: '2807960', released_at: '2026-08-10', status: 'caution', score: '7.2', impact_score: null,
    bug_count: 0, affects: 'Steam players', verdict: 'Review notes', reasoning: 'Official notes loaded.',
    changelog: [], known_issues: [], risk_factors: [], security_criticality: null, subreddits: [],
    release_size_bytes: null, created_at: '2026-08-10T12:00:00Z', updated_at: '2026-08-11T11:00:00Z',
  };
  const steam = updatesService.__test.rowToUpdate({
    ...baseRow,
    evidence: [{
      source: 'Steam', url: 'https://store.steampowered.com/news/app/2807960/view/1',
      releaseType: 'official-game-update', steamAppId: 2807960,
      averagePlayersSnapshot: 44566, averagePlayersObservedAt: '2026-08-15',
    }],
  });
  expect(steam).toMatchObject({
    steamAppId: '2807960',
    averagePlayersSnapshot: 44566,
    averagePlayersObservedAt: '2026-08-15',
    packageSize: null,
    whql: null,
  });

  const driver = updatesService.__test.rowToUpdate({
    ...baseRow,
    id: 'intel-driver-release', platform: 'Intel', product_id: null,
    evidence: [{
      source: 'Intel', url: 'https://intel.example/driver', releaseType: 'official-release-notes',
      packageSize: '872.2 MB', sizeBytes: 914568192, whql: true,
    }],
  });
  expect(driver).toMatchObject({
    releaseSizeBytes: 914568192,
    sizeBytes: 914568192,
    packageSize: '872.2 MB',
    whql: true,
    steamAppId: null,
  });
});

test('legacy vendor-feed text is safely normalized when rows are hydrated', () => {
  const update = updatesService.__test.rowToUpdate({
    id: 'legacy-text', platform: 'Steam', name: 'Release', version: '1.0.0',
    released_at: '2026-08-10', score: '7.1', impact_score: '4.0',
    changelog: ['{STEAM_CLAN_LOC_IMAGE}/123/a.png The release intro duces maps.General fixes landed.'],
    known_issues: ['Global modifiers:Apply to seasonal profiles.'],
    risk_factors: [{ level: 'low', text: 'PrivacyPlayers may need to reconnect.' }],
    evidence: [{ source: 'Steam', url: 'https://store.steampowered.com/news/app/1/view/2', text: 'Official notes intro duced this change.' }],
  });

  expect(update.changelog).toEqual(['The release introduces maps. General fixes landed.']);
  expect(update.knownIssues).toEqual(['Global modifiers: Apply to seasonal profiles.']);
  expect(update.riskFactors[0].text).toBe('Privacy: Players may need to reconnect.');
  expect(update.evidence[0].text).toBe('Official notes introduced this change.');
});

test('invalid persisted scores are dropped with their derived status', () => {
  const update = updatesService.__test.rowToUpdate({
    id: 'invalid-score', platform: 'Windows', name: 'Malformed score fixture', version: '1.0',
    released_at: '2026-08-10', status: 'stable', score: true, impact_score: null,
    bug_count: 0, changelog: [], known_issues: [], risk_factors: [], evidence: [],
    security_criticality: null, subreddits: [], created_at: '2026-08-10T12:00:00Z',
  });

  expect(update.score).toBeNull();
  expect(update.status).toBeNull();
});

test('detail pages rank same-product releases before same-lane and platform releases', async () => {
  const row = (overrides = {}) => ({
    id: 'steam-current', platform: 'Steam', name: 'Marvel Rivals current patch', version: '9.5',
    display_version: null, product_id: '2767030', source_kind: 'steam-game-news', source_ref: 'current',
    released_at: '2026-08-07', status: 'caution', score: '7.2', impact_score: null, bug_count: 0,
    affects: 'Marvel Rivals on Steam', verdict: 'Review notes', reasoning: 'Official notes loaded.',
    changelog: ['Documented gameplay changes.'], known_issues: [], risk_factors: [],
    evidence: [{ source: 'Steam', url: 'https://store.steampowered.com/news/app/2767030/view/1', releaseType: 'official-game-update' }],
    security_criticality: null, subreddits: [], release_size_bytes: null,
    created_at: '2026-08-07T12:00:00Z', updated_at: '2026-08-11T11:00:00Z',
    ...overrides,
  });
  mockIsAvailable.mockReturnValue(true);
  mockQuery
    .mockResolvedValueOnce({ rows: [row()] })
    .mockResolvedValueOnce({ rows: [
      row({
        id: 'steam-same-product', name: 'Marvel Rivals previous patch', version: '9.4', relation_type: 'same-product',
        evidence: [{ source: 'Steam', url: 'https://store.steampowered.com/news/app/2767030/view/2', releaseType: 'official-game-update' }],
      }),
      row({
        id: 'steam-same-lane', name: 'Another Steam game patch', version: '2.0', product_id: '570', relation_type: 'same-lane',
        evidence: [{ source: 'Steam', url: 'https://store.steampowered.com/news/app/570/view/3', releaseType: 'official-game-update' }],
      }),
      row({
        id: 'steam-same-platform', name: 'Steam client patch', version: '2026.08', product_id: '593110', source_kind: 'steam-client-news', relation_type: 'same-platform',
        evidence: [{ source: 'Steam', url: 'https://store.steampowered.com/news/app/593110/view/4', releaseType: 'official-release' }],
      }),
    ] });

  const detail = await updatesService.getUpdateById('steam-current');
  expect(detail.related.map(item => [item.id, item.relationType])).toEqual([
    ['steam-same-product', 'same-product'],
    ['steam-same-lane', 'same-lane'],
    ['steam-same-platform', 'same-platform'],
  ]);
  const [relatedSql, relatedParams] = mockQuery.mock.calls[1];
  expect(relatedSql).toMatch(/product_id = \$3[\s\S]+source_kind = \$4[\s\S]+released_at DESC/);
  expect(relatedParams).toEqual(['steam-current', 'Steam', '2767030', 'steam-game-news', 4]);
});

test('successful empty DB reads stay empty instead of reviving static samples', async () => {
  mockIsAvailable.mockReturnValue(true);
  mockQuery.mockResolvedValue({ rows: [] });

  await expect(updatesService.getUpdates({ search: 'not-a-real-release' })).resolves.toEqual([]);
  await expect(updatesService.getUpdateById('steam-apex-legends-july-2026')).resolves.toBeNull();
});

test('search shorthand expands to authoritative product-name aliases', () => {
  expect(updatesService.__test.expandSearchTerms('cs2')).toEqual(expect.arrayContaining([
    'cs2', 'counter-strike 2', 'counter strike 2',
  ]));
  expect(updatesService.__test.expandSearchTerms('SteamDeck')).toEqual(expect.arrayContaining([
    'steamdeck', 'steam deck', 'steamos',
  ]));
  expect(updatesService.__test.expandSearchTerms('NARAKA')).toEqual(['naraka']);
  expect(updatesService.__test.expandSearchTerms('macbook')).toEqual(expect.arrayContaining([
    'macbook', 'macos', 'mac os',
  ]));
  expect(updatesService.__test.expandSearchTerms('switch oled')).toEqual(['switch oled']);
});

test('multi-part searches require every term while aliases remain alternatives', async () => {
  expect(updatesService.__test.buildSearchTermGroups('intel 8974')).toEqual([
    ['intel'],
    ['8974'],
  ]);
  expect(updatesService.__test.buildSearchTermGroups('steam deck')).toEqual([
    expect.arrayContaining(['steam deck', 'steam os']),
  ]);
  expect(updatesService.__test.buildSearchTermGroups('macbook pro m4')).toEqual([
    ['macbook'],
    ['pro'],
    ['m4'],
  ]);
  expect(updatesService.__test.buildSearchTermGroups('macbook pro')).toEqual([
    ['macbook'],
    ['pro'],
  ]);
  expect(updatesService.__test.buildSearchTermGroups('m4')).toEqual([['m4']]);

  mockIsAvailable.mockReturnValue(true);
  mockQuery.mockResolvedValue({ rows: [] });
  await updatesService.getUpdates({ search: 'intel 8974', sort: 'relevance' });

  const [sql, params] = mockQuery.mock.calls[0];
  expect(sql).toContain('search_group_0');
  expect(sql).toContain('search_group_1');
  expect(sql).toMatch(/search_group_0[\s\S]+AND EXISTS \([\s\S]+search_group_1/);
  expect(params).toEqual([
    ['intel'],
    ['8974'],
    ['intel', '8974'],
  ]);
});

test('exact platform searches use platform equality instead of incidental note text', async () => {
  expect(updatesService.__test.exactPlatformForSearch('NVIDIA')).toBe('NVIDIA');
  expect(updatesService.__test.exactPlatformForSearch('Battle.net')).toBe('BattleNet');
  expect(updatesService.__test.exactPlatformForSearch('nvidia driver')).toBeNull();

  mockIsAvailable.mockReturnValue(true);
  mockQuery.mockResolvedValue({ rows: [] });
  await updatesService.getUpdates({ search: 'NVIDIA', sort: 'relevance' });

  const [sql, params] = mockQuery.mock.calls[0];
  expect(sql).toMatch(/LOWER\(platform\) = LOWER\(\$1\)/);
  expect(sql).not.toContain('search_group_0');
  expect(params).toEqual(['NVIDIA']);
});

test('an explicit platform filter and matching exact search do not add duplicate SQL params', async () => {
  mockIsAvailable.mockReturnValue(true);
  mockQuery.mockResolvedValue({ rows: [] });
  await updatesService.getUpdates({ platform: 'NVIDIA', search: 'nvidia' });

  const [sql, params] = mockQuery.mock.calls[0];
  expect((sql.match(/LOWER\(platform\) = LOWER/g) || [])).toHaveLength(1);
  expect(params).toEqual(['NVIDIA']);
});

test('search relevance favors direct product matches over incidental patch-note mentions', () => {
  const terms = updatesService.__test.expandSearchTerms('radeon');
  const amdRelease = {
    platform: 'AMD',
    name: 'AMD Software: Adrenalin Edition 26.8.1',
    affects: 'Radeon RX graphics',
    changelog: [],
  };
  const incidentalSteamRelease = {
    platform: 'Steam',
    name: 'Monster Hunter Wilds update',
    affects: 'PC players',
    changelog: ['Fixed an issue seen on some Radeon systems'],
  };

  expect(updatesService.__test.searchRelevanceScore(amdRelease, terms)).toBeGreaterThan(
    updatesService.__test.searchRelevanceScore(incidentalSteamRelease, terms)
  );
  expect(updatesService.__test.searchRelevanceScore(amdRelease, terms)).toBe(100);
  expect(updatesService.__test.searchRelevanceScore(incidentalSteamRelease, terms)).toBe(30);
});

test('exact multi-word product titles outrank the same phrase inside incidental notes', () => {
  const directGameRelease = {
    platform: 'Steam',
    name: 'Battlefield 6 Update 1.2.3',
    version: '1.2.3',
    changelog: ['Improved progression and map balance.'],
  };
  const incidentalDriverRelease = {
    platform: 'AMD',
    name: 'AMD Software: Adrenalin Edition 26.7.1',
    version: '26.7.1',
    changelog: ['Battlefield 6 may experience intermittent stutter on one GPU family.'],
  };

  expect(updatesService.__test.searchRelevanceScore(directGameRelease, 'Battlefield 6')).toBe(1000);
  expect(updatesService.__test.searchRelevanceScore(incidentalDriverRelease, 'Battlefield 6')).toBe(300);
  expect(updatesService.__test.searchRelevanceScore(directGameRelease, 'Battlefield 6')).toBeGreaterThan(
    updatesService.__test.searchRelevanceScore(incidentalDriverRelease, 'Battlefield 6')
  );
});

test('monthly placeholders require official release metadata', () => {
  const base = { platform: 'GOG', version: '2026-08', releasedAt: '2026-08-05' };
  expect(updatesService.__test.isUpdateDisplayable({ ...base, evidence: [{ source: 'Support' }] })).toBe(false);
  expect(updatesService.__test.isUpdateDisplayable({
    ...base,
    evidence: [{ source: 'Support', releaseType: 'official-version' }],
  })).toBe(true);
});

test('legacy Steam month labels require structured official article evidence', () => {
  const legacy = {
    platform: 'Steam',
    version: 'Aug 2026',
    releasedAt: '2026-08-03',
    evidence: [{
      source: 'Steam',
      url: 'https://store.steampowered.com/news/app/1675200/view/667247155276153538',
    }],
  };
  expect(updatesService.__test.isUpdateDisplayable(legacy)).toBe(false);
  expect(updatesService.__test.isUpdateDisplayable({
    ...legacy,
    evidence: [{
      ...legacy.evidence[0],
      releaseType: 'official-release',
    }],
  })).toBe(true);
});

test('article-level duplicates keep the release with stronger structured evidence', () => {
  const sharedUrl = 'https://store.steampowered.com/news/app/1675200/view/667247155276153538?l=english';
  const legacy = {
    id: 'steam-aug-2026',
    platform: 'Steam',
    version: 'Aug 2026',
    sourceUrl: sharedUrl,
    changelog: ['Unstructured release copy'],
    knownIssues: [],
    riskFactors: [],
    evidence: [{ source: 'Steam', url: sharedUrl }],
    updatedAt: '2026-08-11T18:15:11Z',
  };
  const canonical = {
    id: 'steam-3-8-25',
    platform: 'Steam',
    version: '3.8.25',
    sourceUrl: sharedUrl.replace('?l=english', '#notes'),
    changelog: ['Feature one', 'Feature two'],
    knownIssues: ['Known performance regression'],
    riskFactors: [{ level: 'medium', text: 'Beta channel' }],
    evidence: [{
      source: 'Steam News',
      url: sharedUrl,
      releaseType: 'official-release',
      checkedAt: '2026-08-12T21:27:25Z',
    }],
    updatedAt: '2026-08-12T21:27:25Z',
  };

  expect(updatesService.__test.dedupeArticleReleases([legacy, canonical])).toEqual([canonical]);
  expect(updatesService.__test.dedupeArticleReleases([canonical, legacy])).toEqual([canonical]);
});

test('rolling support pages do not collapse distinct console releases', () => {
  const sourceUrl = 'https://support.xbox.com/en-US/help/hardware-network/settings-updates/whats-new-xbox-one-system-updates';
  const releases = [
    { id: 'xbox-one', platform: 'Xbox', version: '10.0.1', sourceUrl, evidence: [] },
    { id: 'xbox-two', platform: 'Xbox', version: '10.0.2', sourceUrl, evidence: [] },
  ];

  expect(updatesService.__test.canonicalArticleSourceKey(releases[0])).toBeNull();
  expect(updatesService.__test.dedupeArticleReleases(releases)).toEqual(releases);
});

test('Discord service incidents are excluded while official technical patch notes remain visible', () => {
  const base = { platform: 'Discord', version: '2026.08.04', releasedAt: '2026-08-04' };
  expect(updatesService.__test.isUpdateDisplayable({
    ...base,
    evidence: [{ source: 'Discord Status', url: 'https://discordstatus.com/incidents/example', releaseType: 'official-status' }],
  })).toBe(false);
  expect(updatesService.__test.isUpdateDisplayable({
    ...base,
    evidence: [{ source: 'Discord Patch Notes', url: 'https://discord.com/blog/discord-patch-notes-august-4-2026', releaseType: 'official-release' }],
  })).toBe(true);
});

test('PS5 CMS revisions are excluded while official package fingerprints remain visible', () => {
  const base = { platform: 'PS5', releasedAt: '2026-07-23' };
  expect(updatesService.__test.isUpdateDisplayable({
    ...base,
    version: '2026.810',
    evidence: [{ source: 'PlayStation Support', releaseType: 'official-version' }],
  })).toBe(false);
  expect(updatesService.__test.isUpdateDisplayable({
    ...base,
    version: 'PUP-2026.07.23-767a94ea',
    evidence: [{ source: 'PlayStation System Software', releaseType: 'official-artifact' }],
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
    { platform: 'macOS', updatedAt: '2026-08-11T10:00:00Z', officialSourceCount: 1 },
    { platform: 'macOS', updatedAt: '2026-08-06T10:00:00Z', officialSourceCount: 1 },
    { platform: 'Windows', updatedAt: '2026-08-06T10:00:00Z', officialSourceCount: 1 },
    { platform: 'NoSource', updatedAt: '2026-08-11T11:00:00Z', officialSourceCount: 0 },
  ]);

  expect(meta).toEqual({
    dataMode: 'live',
    sourceBacked: 3,
    platformsTracked: 2,
    fresh24h: 1,
    stale96h: 1,
    withinCadence: 1,
    overdueCadence: 1,
    lastCheckedAt: '2026-08-11T10:00:00Z',
  });
});

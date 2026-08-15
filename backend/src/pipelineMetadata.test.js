'use strict';

jest.mock('./config/db', () => ({
  isAvailable: jest.fn(() => true),
  query: jest.fn(),
}));
jest.mock('./utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('./services/scraperService', () => ({
  DETECTORS: {},
  detectPlatformDetailed: jest.fn(),
}));
jest.mock('./services/aiAnalysisService', () => ({ isEnabled: jest.fn(() => false), analyseUpdate: jest.fn() }));
jest.mock('./services/watchlistService', () => ({ notifySubscribers: jest.fn() }));
jest.mock('./services/liveFeedService', () => ({ publishRelease: jest.fn() }));

const db = require('./config/db');
const scraperService = require('./services/scraperService');
const watchlistService = require('./services/watchlistService');
const liveFeedService = require('./services/liveFeedService');
const { processPlatform, __test } = require('./services/pipelineService');

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
    expect(sql).toContain('score = $13');
    expect(sql).toContain('status = $14');
    expect(sql).not.toContain('ai_generated = FALSE');
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

  test('generated summaries cannot overwrite ratings or structured source facts', async () => {
    db.query.mockResolvedValue({ rows: [] });

    await __test.updateWithAiResults('nvidia-610-88', {
      verdict: 'Review the official release notes.',
      reasoning: 'The generated layer is restricted to prose.',
      aiModel: 'test-model',
      aiGeneratedAt: '2026-08-15T12:00:00.000Z',
      score: 10,
      changelog: ['Invented change'],
      knownIssues: ['Invented issue'],
    });

    const [sql] = db.query.mock.calls[0];
    expect(sql).not.toMatch(/\bscore\s*=/);
    expect(sql).not.toMatch(/\bstatus\s*=/);
    expect(sql).not.toMatch(/\bchangelog\s*=/);
    expect(sql).not.toMatch(/\bknown_issues\s*=/);
    expect(sql).not.toMatch(/\bsecurity_criticality\s*=/);
  });

  test('known-issue authority is preserved inside source evidence for API clients', () => {
    const context = __test.platformContext('AMD', {
      name: 'AMD Software: Adrenalin Edition 26.7.1',
      knownIssues: [],
      knownIssuesAuthoritative: true,
      evidence: [{ source: 'AMD Release Notes', url: 'https://www.amd.com/release-notes' }],
    });

    expect(context.evidence).toEqual([
      expect.objectContaining({ knownIssuesAuthoritative: true }),
    ]);
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
    expect(score).toBe(1);
    expect(__test.deriveInitialStatus(score)).toBe('avoid');
  });

  test('materially older unknown source versions are rejected as regressions', () => {
    expect(__test.isSourceVersionRegression(
      { version: '2.0.0', released_at: '2026-08-12' },
      { version: '1.9.0', releasedAt: '2026-08-08' },
    )).toBe(true);
    expect(__test.isSourceVersionRegression(
      { version: '2.0.0', released_at: '2026-08-12' },
      { version: '2.0.1', releasedAt: '2026-08-11' },
    )).toBe(false);
  });

  test('legacy placeholder rows cannot become the pipeline current release', () => {
    expect(__test.isCanonicalPipelineRelease({ platform: 'PS5', version: '2026-08' })).toBe(false);
    expect(__test.isCanonicalPipelineRelease({ platform: 'PS5', version: '2026.810' })).toBe(false);
    expect(__test.isCanonicalPipelineRelease({ platform: 'PS5', version: 'PUP-2026.07.23-767a94ea' })).toBe(true);
    expect(__test.isCanonicalPipelineRelease({ platform: 'BattleNet', version: '2026-08' })).toBe(false);
    expect(__test.isCanonicalPipelineRelease({ platform: 'BattleNet', version: '2.52.8.17651' })).toBe(true);
    expect(__test.isCanonicalPipelineRelease({ platform: 'Steam', version: 'Aug 2026' })).toBe(false);
    expect(__test.isCanonicalPipelineRelease({ platform: 'Steam', version: '3.8.25' })).toBe(true);
  });

  test('Steam client freshness excludes game-news rows from the comparison lane', async () => {
    db.query.mockResolvedValue({ rows: [] });

    await __test.getLatestKnownRelease('Steam');
    await __test.getKnownReleaseByVersion('Steam', 'client-687512719325137168');

    for (const [sql] of db.query.mock.calls) {
      expect(sql).toContain("source_kind IS DISTINCT FROM 'steam-game-news'");
    }
  });

  test('SteamOS freshness is isolated from desktop client and game-news releases', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const detected = { sourceKind: 'steamos-news' };

    await __test.getLatestKnownRelease('Steam', detected);
    await __test.getKnownReleaseByVersion('Steam', '3.8.16', detected);

    expect(db.query.mock.calls[0][0]).toContain('source_kind = $2');
    expect(db.query.mock.calls[0][1]).toEqual(['Steam', 'steamos-news']);
    expect(db.query.mock.calls[1][0]).toContain('source_kind = $3');
    expect(db.query.mock.calls[1][1]).toEqual(['Steam', '3.8.16', 'steamos-news']);
  });

  test('internal Steam Deck detection persists and notifies as public Steam', async () => {
    scraperService.detectPlatformDetailed.mockResolvedValue({
      ok: true,
      attempts: 1,
      latencyMs: 25,
      result: {
        platform: 'Steam',
        name: 'SteamOS 3.8.16',
        version: '3.8.16',
        sourceKind: 'steamos-news',
        sourceRef: 'steamos:1838407329258215',
        productId: '1675200',
        releasedAt: '2026-07-17',
        changelog: ['Improved dock compatibility and display stability.'],
        knownIssues: [],
        evidence: [{ source: 'Steam Deck News', url: 'https://store.steampowered.com/news/app/1675200/view/1838407329258215' }],
      },
    });
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'steam-3-8-16' }] });

    const result = await processPlatform('SteamDeck');

    expect(scraperService.detectPlatformDetailed).toHaveBeenCalledWith('SteamDeck');
    expect(result).toMatchObject({ platform: 'Steam', status: 'new_update', id: 'steam-3-8-16' });
    const insertParams = db.query.mock.calls[2][1];
    expect(insertParams[0]).toBe('steam-3-8-16');
    expect(insertParams[1]).toBe('Steam');
    expect(insertParams[5]).toBe('steamos-news');
    expect(watchlistService.notifySubscribers).toHaveBeenCalledWith('Steam', expect.any(Object));
    expect(liveFeedService.publishRelease).toHaveBeenCalledWith(expect.objectContaining({ platform: 'Steam' }));
  });

  test('a cached historical version refreshes metadata without sending a new-update alert', async () => {
    scraperService.detectPlatformDetailed.mockResolvedValue({
      ok: true,
      attempts: 1,
      latencyMs: 25,
      result: {
        platform: 'NVIDIA',
        name: 'NVIDIA Driver 609.99',
        version: '609.99',
        releasedAt: '2026-07-20',
        changelog: ['Historical source metadata refreshed.'],
        evidence: [{ source: 'NVIDIA', url: 'https://www.nvidia.com/drivers/609-99' }],
      },
    });
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'nvidia-610-88', version: '610.88', released_at: '2026-07-28' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'nvidia-609-99', version: '609.99', released_at: '2026-07-20' }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await processPlatform('NVIDIA');

    expect(result).toMatchObject({ status: 'historical_refresh', version: '609.99', currentVersion: '610.88' });
    expect(watchlistService.notifySubscribers).not.toHaveBeenCalled();
  });

  test('an unknown regressed source version cannot insert or notify', async () => {
    scraperService.detectPlatformDetailed.mockResolvedValue({
      ok: true,
      attempts: 1,
      latencyMs: 25,
      result: {
        platform: 'NVIDIA',
        name: 'NVIDIA Driver 608.10',
        version: '608.10',
        releasedAt: '2026-07-01',
        changelog: ['Unexpected older source result.'],
        evidence: [{ source: 'NVIDIA', url: 'https://www.nvidia.com/drivers/608-10' }],
      },
    });
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'nvidia-610-88', version: '610.88', released_at: '2026-07-28' }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await processPlatform('NVIDIA');

    expect(result).toMatchObject({ status: 'source_regression', version: '608.10', currentVersion: '610.88' });
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(watchlistService.notifySubscribers).not.toHaveBeenCalled();
  });
});

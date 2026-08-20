'use strict';

jest.mock('./config/db', () => ({ isAvailable: jest.fn(() => false), query: jest.fn() }));
jest.mock('./utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { STEAM_GAME_CANDIDATES, STEAM_GAME_CANDIDATE_SNAPSHOT } = require('./data/steamGameCandidates');
const { __test } = require('./services/steamGamePipelineService');

function list(items) {
  return `[list]${items.map(item => `[*]${item}`).join('')}[/list]`;
}

describe('material Steam game update pipeline', () => {
  test('candidate roster contains only unique games above the requested average threshold', () => {
    expect(STEAM_GAME_CANDIDATES).toHaveLength(81);
    expect(new Set(STEAM_GAME_CANDIDATES.map(game => game.appId)).size).toBe(STEAM_GAME_CANDIDATES.length);
    expect(STEAM_GAME_CANDIDATES.every(game => game.averagePlayers > STEAM_GAME_CANDIDATE_SNAPSHOT.minimumAveragePlayers)).toBe(true);
    expect(STEAM_GAME_CANDIDATES.map(game => game.name)).not.toEqual(expect.arrayContaining([
      'Wallpaper Engine', 'OBS Studio', 'Crosshair X', 'Spacewar', 'FiveM', 'tModLoader',
    ]));
  });

  test('rejects hotfixes even when their notes mention gameplay', () => {
    const result = __test.classifyMaterialUpdate({
      feedname: 'steam_community_announcements',
      title: 'Hotfix 1.2.3',
      contents: list(Array.from({ length: 12 }, (_, i) => `Gameplay weapon balance fix ${i}`)),
    });
    expect(result.small).toBe(true);
    expect(result.eligible).toBe(false);

    const genericTitle = __test.classifyMaterialUpdate({
      feedname: 'steam_community_announcements',
      title: 'Update 1.2.4',
      contents: `This update is a hotfix for gameplay. ${list(Array.from({ length: 12 }, (_, i) => `Weapon balance fix ${i}`))}`,
    });
    expect(genericTitle.small).toBe(true);
    expect(genericTitle.eligible).toBe(false);
  });

  test('rejects previews, PTBs, third-party news, and cosmetic-only announcements', () => {
    const substantial = list(Array.from({ length: 12 }, (_, i) => `New gameplay map and combat system ${i}`));
    expect(__test.classifyMaterialUpdate({ feedname: 'steam_community_announcements', title: 'PTB Patch Notes 2.0', contents: substantial }).eligible).toBe(false);
    expect(__test.classifyMaterialUpdate({ feedname: 'PC Gamer', title: 'Major Update 2.0', contents: substantial }).eligible).toBe(false);
    expect(__test.classifyMaterialUpdate({
      feedname: 'steam_community_announcements',
      title: 'Summer Store Update',
      contents: list(Array.from({ length: 12 }, (_, i) => `New cosmetic bundle and profile sticker ${i}`)),
    }).eligible).toBe(false);
  });

  test('accepts substantial first-party gameplay and requirement releases', () => {
    const gameplay = __test.classifyMaterialUpdate({
      feedname: 'steam_community_announcements',
      title: 'Major Gameplay Update 7.0.0',
      contents: list([
        'Added a new ranked game mode and map rotation.',
        'Reworked combat movement and weapon handling.',
        'Added two new enemy classes and a boss encounter.',
        'Changed progression rewards and the in-game economy.',
        'Rebalanced hero abilities across every ranked tier.',
        'Added new missions, loot, and crafting recipes.',
      ]) + ' '.repeat(1300),
    });
    expect(gameplay.eligible).toBe(true);
    expect(gameplay.signals).toContain('gameplay');

    const requirements = __test.classifyMaterialUpdate({
      feedname: 'steam_community_announcements',
      title: 'Title Update 4.0',
      contents: `${list([
        'The game now requires Windows 10 64-bit.',
        'Upgraded the engine to Unreal Engine 5.',
        'Added Vulkan rendering and changed the minimum system requirements.',
        'Introduced a new anti-cheat kernel driver.',
        'Added a compatibility check before installation.',
      ])} Patch download size: 4.2 GB. ${'Requirements and compatibility. '.repeat(60)}`,
    });
    expect(requirements.eligible).toBe(true);
    expect(requirements.signals).toContain('requirements');
    expect(requirements.packageSizeBytes).toBeGreaterThan(4 * 1024 ** 3);
  });

  test('counts HTML release-note lists as material scope', () => {
    const result = __test.classifyMaterialUpdate({
      feedname: 'steam_community_announcements',
      title: 'Game Update 3.0.0',
      contents: `<h2>Gameplay</h2><ul>${Array.from({ length: 8 }, (_, i) => `<li>Changed the map, combat, weapon, and ranked progression system ${i}.</li>`).join('')}</ul>${'Detailed release notes. '.repeat(150)}`,
    });
    expect(result.bulletCount).toBe(8);
    expect(result.eligible).toBe(true);
  });

  test('restores readable boundaries in Valve-flattened release notes', () => {
    const plain = __test.stripSteamMarkup('INTROWelcome to the update.CHANGES AND UPDATESGameplayKickoff rules changed.MATCHMAKING TESTSIn Ranked, queues changed.BUG FIXESFixed a crash.');
    expect(plain).toContain('INTRO\nWelcome to the update.');
    expect(plain).toContain('UPDATES\nGameplay');
    expect(plain).toContain('BUG FIXES\nFixed a crash.');
    expect(plain).toContain('MATCHMAKING TESTS\nIn Ranked');
    const notes = __test.releaseNotesFromPost({ contents: plain });
    expect(notes.changelog.some(item => item.startsWith('Welcome to the update.'))).toBe(true);
  });

  test('preserves decimal versions and removes Steam image placeholders', () => {
    const notes = __test.releaseNotesFromPost({
      contents: '{STEAM_CLAN_LOC_IMAGE}/3703047/asset.png Version: Rocket League v2.72. GameplayKickoff rules changed. GeneralSnow Day maps can now use Soccar.',
    });

    expect(notes.plain).not.toContain('STEAM_CLAN_LOC_IMAGE');
    expect(notes.changelog).toContain('Version: Rocket League v2.72.');
    expect(notes.changelog).toContain('Kickoff rules changed.');
    expect(notes.changelog).toContain('Snow Day maps can now use Soccar.');
  });

  test('separates common publisher headings flattened into their first item', () => {
    const plain = __test.stripSteamMarkup('Seasons system and Season OneWith this release, seasons begin. Seasonal characterAdded a separate profile. Global modifiersApply to all seasonal players.');
    expect(plain).toContain('Season One\nWith this release');
    expect(plain).toContain('Seasonal character\nAdded a separate profile');
    expect(plain).toContain('Global modifiers\nApply to all seasonal players');
  });

  test('rejects dated pre-release announcements while allowing live releases', () => {
    const material = `${list(Array.from({ length: 8 }, (_, i) => `New gameplay map and combat system ${i}`))}${' gameplay '.repeat(150)}`;
    expect(__test.classifyMaterialUpdate({
      feedname: 'steam_community_announcements',
      title: 'The Final Biome Update Arrives August 11',
      contents: material,
    }).eligible).toBe(false);
    expect(__test.classifyMaterialUpdate({
      feedname: 'steam_community_announcements',
      title: 'The Final Biome Update Out Now',
      contents: `Incoming transmission from command. ${material}`,
    }).eligible).toBe(true);
  });

  test('prefers the richer official notes posted near the marketing announcement', () => {
    const date = Math.floor(Date.now() / 1000);
    const selected = __test.selectBestMaterialPost([
      {
        gid: '1', date, feedname: 'steam_community_announcements', title: 'Major Update Out Now',
        contents: `${list(['New gameplay map.', 'New weapon class.', 'Combat balance rework.', 'New mission.', 'Ranked progression change.'])}${' gameplay '.repeat(140)}`,
      },
      {
        gid: '2', date: date - 3600, feedname: 'steam_community_announcements', title: 'Major Update 5.0 Patch Notes',
        contents: `${list(Array.from({ length: 15 }, (_, i) => `Gameplay map, weapon, mission, and combat change ${i}.`))}${' detailed gameplay notes '.repeat(180)}`,
      },
    ]);
    expect(selected.post.gid).toBe('2');
  });

  test('derives display versions from the release title rather than unrelated body dates', () => {
    const releasedAt = new Date('2026-08-13T01:00:00.000Z');
    expect(__test.displayVersion({ title: 'NARAKA Update – August 13th, 2026', contents: 'Previously scheduled for 2026.08.12.' }, releasedAt)).toBe('2026.08.13');
    expect(__test.displayVersion({ title: 'Marvel Rivals Version 20260813 Patch Notes' }, releasedAt)).toBe('2026.08.13');
    expect(__test.displayVersion({ title: 'Y11S2.3 PATCH NOTES' }, releasedAt)).toBe('Y11S2.3');
    expect(__test.displayVersion({ title: 'Rocket League Patch Notes v2.72' }, releasedAt)).toBe('2.72');
    expect(__test.explicitReleaseDateFromTitle('NARAKA Update – August 13th, 2026').toISOString().slice(0, 10)).toBe('2026-08-13');
  });

  test('collapses publisher line breaks in release headings without flattening patch notes', () => {
    const update = __test.toDatabaseUpdate(
      { appId: '1203220', name: 'NARAKA: BLADEPOINT', averagePlayers: 20000 },
      {
        gid: '123456789',
        date: Math.floor(new Date('2026-08-13T12:00:00.000Z').getTime() / 1000),
        title: 'NARAKA: BLADEPOINT \nUpdate – August 13th, 2026',
      },
      { changelog: ['A substantial gameplay system was reworked for this release.'], signals: ['gameplay'], packageSizeBytes: null },
    );

    expect(update.name).toBe('NARAKA: BLADEPOINT Update – August 13th, 2026');
    expect(update.name).not.toMatch(/[\r\n]/);
  });

  test('keeps resolved crash fixes out of the active known-issues list', () => {
    const issues = __test.knownIssuesFromNotes([
      'Fixed a bug that caused the game to crash during matchmaking.',
      'Reduced the crash rate on Nintendo Switch.',
      'The game may crash when loading a ranked match.',
      'Microsoft is not currently aware of any issues with this update.',
    ]);

    expect(issues).toEqual(['The game may crash when loading a ranked match.']);
  });
});

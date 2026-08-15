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
});

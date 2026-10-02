'use strict';

jest.mock('./config/db', () => ({ isAvailable: jest.fn(() => false), query: jest.fn() }));
jest.mock('./utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const {
  STRICT_STEAM_GAME_POLICY,
  STEAM_GAME_CANDIDATES,
  VERIFIED_STEAM_GAME_CANDIDATES,
  STEAM_GAME_ELIGIBILITY_AUDIT,
  STRICT_STEAM_GAME_CANDIDATES,
  auditStrictSteamCandidates,
  loadConfiguredStrictSteamCandidates,
} = require('./data/steamGameCandidates');
const { __test } = require('./services/steamGamePipelineService');

function list(items) {
  return `[list]${items.map(item => `[*]${item}`).join('')}[/list]`;
}

describe('material Steam game update pipeline', () => {
  test('turns Valve Dota patch data into named, source-backed change summaries', () => {
    const parsed = __test.parseDotaPatchData({
      success: true,
      patch_number: '7.41f',
      patch_timestamp: 1789455600,
      heroes: [
        { hero_id: 1, abilities: [{ ability_notes: [{ note: 'Mana Burned as Damage increased from 60% to 65%' }] }] },
        { hero_id: 3, hero_notes: [{ note: 'Base Armor decreased by 1' }] },
      ],
      items: [{ ability_id: 265, ability_notes: [{ note: 'Mana Regen bonus decreased from +0.8 to +0.6' }] }],
      neutral_items: [{ title: 'Enchantment Changes', is_general_note: true }],
    }, {
      result: { data: { heroes: [
        { id: 1, name_loc: 'Anti-Mage' },
        { id: 3, name_loc: 'Bane' },
      ] } },
    }, {
      result: { data: { itemabilities: [{ id: 265, name_loc: 'Aether Lens' }] } },
    }, '7.41f');

    expect(parsed).toMatchObject({
      patchVersion: '7.41f', heroCount: 2, itemCount: 1, neutralItemCount: 1,
    });
    expect(parsed.changelog).toEqual(expect.arrayContaining([
      expect.stringContaining('2 heroes, 1 item, and 1 neutral-item entry'),
      expect.stringContaining('Anti-Mage — Mana Burned as Damage increased'),
      expect.stringContaining('Bane — Base Armor decreased'),
      expect.stringContaining('Aether Lens — Mana Regen bonus decreased'),
    ]));
  });

  test('rejects mismatched or empty Dota patch payloads instead of inventing notes', () => {
    expect(__test.parseDotaPatchData({ success: true, patch_number: '7.41e' }, {}, {}, '7.41f')).toBeNull();
    expect(__test.parseDotaPatchData({ success: true, patch_number: '7.41f', heroes: [], items: [] }, {}, {}, '7.41f')).toBeNull();
  });

  test('keeps the broad historical audit while activating only the reviewed roster', () => {
    expect(STEAM_GAME_CANDIDATES).toHaveLength(81);
    expect(new Set(STEAM_GAME_CANDIDATES.map(game => game.appId)).size).toBe(STEAM_GAME_CANDIDATES.length);
    expect(STEAM_GAME_CANDIDATES).toEqual(expect.arrayContaining([
      expect.objectContaining({ appId: 730, name: 'Counter-Strike 2' }),
    ]));
    expect(STEAM_GAME_CANDIDATES.map(game => game.name)).not.toEqual(expect.arrayContaining([
      'Wallpaper Engine', 'OBS Studio', 'Crosshair X', 'Spacewar', 'FiveM', 'tModLoader',
    ]));
    expect(VERIFIED_STEAM_GAME_CANDIDATES).toHaveLength(17);
    expect(STRICT_STEAM_GAME_CANDIDATES).toHaveLength(17);
    expect(STEAM_GAME_ELIGIBILITY_AUDIT.rejected).toHaveLength(0);
    expect(STEAM_GAME_ELIGIBILITY_AUDIT.accepted).toEqual(expect.arrayContaining([
      expect.objectContaining({ appId: 730, region: 'GLOBAL', market: 'US' }),
    ]));
  });

  test('requires a global 30-day average above 50,000 plus official US-market evidence', () => {
    const accepted = auditStrictSteamCandidates([{
      appId: 730,
      name: 'Counter-Strike 2',
      region: 'GLOBAL',
      windowDays: 30,
      averageConcurrentPlayers: 50001,
      sourceUrl: 'https://steamcharts.com/app/730',
      observedAt: '2026-09-02T04:52:00.000Z',
      market: 'US',
      usMarketRank: 2,
      marketSourceUrl: 'https://store.steampowered.com/charts/topselling/US',
      marketObservedAt: '2026-09-02T04:52:00.000Z',
    }]);
    expect(STRICT_STEAM_GAME_POLICY).toEqual(expect.objectContaining({
      region: 'GLOBAL', windowDays: 30, minimumAverageConcurrentPlayers: 50000, market: 'US',
    }));
    expect(accepted.accepted).toHaveLength(1);

    const thresholdTie = auditStrictSteamCandidates([{
      ...accepted.accepted[0], averageConcurrentPlayers: 50000,
    }]);
    expect(thresholdTie.accepted).toHaveLength(0);
    expect(thresholdTie.rejected[0].reasons).toContain('average_not_above_50000');

    const configured = loadConfiguredStrictSteamCandidates(JSON.stringify({ candidates: [{
      appId: 730,
      name: 'Counter-Strike 2',
      region: 'GLOBAL',
      windowDays: 30,
      averageConcurrentPlayers: 50001,
      sourceUrl: 'https://steamcharts.com/app/730',
      observedAt: '2026-09-02T04:52:00.000Z',
      market: 'US',
      usMarketRank: 2,
      marketSourceUrl: 'https://store.steampowered.com/charts/topselling/US',
      marketObservedAt: '2026-09-02T04:52:00.000Z',
    }] }));
    expect(configured.configured).toBe(true);
    expect(configured.accepted).toEqual([expect.objectContaining({ appId: 730, name: 'Counter-Strike 2' })]);
  });

  test('malformed configured regional data fails closed', () => {
    expect(loadConfiguredStrictSteamCandidates('{not-json')).toEqual(expect.objectContaining({
      configured: true,
      accepted: [],
      errors: [expect.stringContaining('STEAM_US_MARKET_CANDIDATES_JSON')],
    }));
  });

  test('excludes utilities and idlers from the active game roster', () => {
    expect(STRICT_STEAM_GAME_CANDIDATES.map(game => game.name)).not.toEqual(expect.arrayContaining([
      'Wallpaper Engine', 'Bongo Cat', 'TBH: Task Bar Hero',
    ]));
    expect(STRICT_STEAM_GAME_CANDIDATES.every(game => game.averageConcurrentPlayers > 50000)).toBe(true);
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

    const minorPatch = __test.classifyMaterialUpdate({
      feedname: 'steam_community_announcements',
      title: 'WARDOGS | Update 0.1.2 (Minor Patch)',
      contents: list(Array.from({ length: 12 }, (_, i) => `Gameplay and weapon change ${i}`)) + ' '.repeat(3000),
    });
    expect(minorPatch.small).toBe(true);
    expect(minorPatch.eligible).toBe(false);
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

  test('anti-cheat enforcement alone does not invent a hardware requirement', () => {
    const result = __test.classifyMaterialUpdate({
      feedname: 'steam_community_announcements',
      title: 'Season Midpoint Gameplay Update',
      contents: `${list([
        'Rebalanced legend abilities and ranked rewards.',
        'Adjusted healing loot and long-range weapon balance.',
        'Added systems to detect unauthorized controller hardware or software on all platforms.',
        'Players who trigger the anti-cheat detections may be banned after review.',
        'Improved map rotations, combat readability, and matchmaking.',
      ])} ${'Detailed gameplay and balance notes. '.repeat(120)}`,
    });

    expect(result.eligible).toBe(true);
    expect(result.signals).toContain('gameplay');
    expect(result.signals).not.toContain('requirements');
    expect(result.requirements).toBe(false);
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
      contents: '{STEAM_CLAN_LOC_IMAGE}/3703047/asset.png {STEAM_CLAN_IMAGE}/3703047/banner.png Version: Rocket League v2.72. GameplayKickoff rules changed. GeneralSnow Day maps can now use Soccar.',
    });

    expect(notes.plain).not.toMatch(/STEAM_CLAN(?:_LOC)?_IMAGE/);
    expect(notes.changelog).toContain('Version: Rocket League v2.72.');
    expect(notes.changelog).toContain('Kickoff rules changed.');
    expect(notes.changelog).toContain('Snow Day maps can now use Soccar.');
  });

  test('recovers publisher actions from flattened Steam news without breaking camel-cased identifiers', () => {
    const contents = 'An update to Team Fortress 2 has been released. The major changes include: New event! '
      + 'The event includes new maps and missions. '.repeat(20)
      + 'Featuring five new community maps and a new mode '
      + 'Added a new event case and community cosmetics '
      + 'Fixed client crash related to missing HUDAutoAim element (community fix from flower) '
      + 'Fixed TFBot crash related to moving control points (community fix from BetaM)';
    const notes = __test.releaseNotesFromPost({ contents });
    expect(notes.changelog).toContain('Fixed client crash related to missing HUDAutoAim element (community fix from flower)');
    expect(notes.changelog).toContain('Fixed TFBot crash related to moving control points (community fix from BetaM)');
    expect(notes.changelog.join(' ')).not.toMatch(/missing HUD\b(?!AutoAim)/);
  });

  test('flattened numbered resource notes surface progression and gameplay before cosmetics', () => {
    const notes = __test.releaseNotesFromPost({ contents:
      'Dear Pathfinders,Polaris Institute released a resource update. Please restart your client. '
      + 'Experience Improvements1. Updated the item acquisition notification icon for Irisalis.2. Improved the outfit showcase panel. '
      + 'Bug Fixes\\1. Fixed an issue where joining a friend early in the game could block progression.'
      + '2. Added Erlath, an enemy with group support abilities.'
      + '3. Increased Stellarys Starine drop rate on Chaos difficulty.'
      + '4. Fixed a rare game freeze when bringing Prismana Fulmintis along.'
      + '5. Added Erlath, an enemy with group support abilities. Defeat it first when encountered.',
    });
    expect(notes.changelog[0]).toContain('Pathfinders, Polaris');
    expect(notes.plain).toMatch(/Irisalis\.\n2\. Improved/);
    expect(notes.changelog).toContain('Added Erlath, an enemy with group support abilities.');
    expect(notes.changelog).toContain('Fixed an issue where joining a friend early in the game could block progression.');
    expect(notes.changelog.findIndex(item => item.includes('block progression')))
      .toBeLessThan(notes.changelog.findIndex(item => item.includes('notification icon')));
    expect(notes.changelog.filter(item => item.startsWith('Added Erlath'))).toHaveLength(1);
  });

  test('separates common publisher headings flattened into their first item', () => {
    const plain = __test.stripSteamMarkup('Seasons system and Season OneWith this release, seasons begin. Seasonal characterAdded a separate profile. Global modifiers:Apply to all seasonal players. Personal season modifiersPlayers can opt in. Streamer Mode & PrivacyPlayers are anonymized.');
    expect(plain).toContain('Season One\nWith this release');
    expect(plain).toContain('Seasonal character\nAdded a separate profile');
    expect(plain).toContain('Global modifiers\nApply to all seasonal players');
    expect(plain).toContain('Personal season modifiers\nPlayers can opt in');
    expect(plain).toContain('Streamer Mode & Privacy\nPlayers are anonymized');
  });

  test('never mistakes introduced or introduce for an Intro heading', () => {
    const plain = __test.stripSteamMarkup('This system has been introduced to players. Each season will introduce new rules. IntroWelcome to the actual update.');
    expect(plain).toContain('been introduced to players');
    expect(plain).toContain('will introduce new rules');
    expect(plain).not.toMatch(/intro\s+duced|intro\s+duce/);
    expect(plain).toContain('Intro\nWelcome');
  });

  test('drops overlong flattened paragraphs instead of publishing a clipped tail', () => {
    const longSentence = `This release begins with important context ${'and more context '.repeat(45)}before the final clause.`;
    const sentences = __test.extractSteamSentences(`${longSentence} A separate complete gameplay sentence remains readable.`);
    expect(sentences).not.toContain(expect.stringMatching(/^.{0,20}final clause/));
    expect(sentences).toContain('A separate complete gameplay sentence remains readable.');
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

  test('holds explicitly scheduled game notes until the publisher says the patch is live', () => {
    const post = {
      gid: '1844751498220444',
      date: Math.floor(Date.parse('2026-09-24T06:54:04Z') / 1000),
      feedname: 'steam_community_announcements',
      title: 'Marvel Rivals Version 20260924 Patch Notes',
      contents: "We're thrilled to announce the upcoming patch drops on September 24th, 2026, at 09 : 00 : 00 (UTC)! "
        + list(Array.from({ length: 12 }, (_, i) => `New gameplay map, hero, mission, and combat changes ${i}.`))
        + ' detailed gameplay and mission changes '.repeat(110),
    };
    expect(__test.classifyMaterialUpdate(post).eligible).toBe(true);
    expect(__test.scheduledReleaseAt(post).toISOString()).toBe('2026-09-24T09:00:00.000Z');
    expect(__test.selectBestMaterialPost([post], Date.parse('2026-09-24T08:59:59Z'))).toBeNull();
    expect(__test.selectBestMaterialPost([post], Date.parse('2026-09-24T09:00:00Z'))?.post.gid).toBe(post.gid);
    expect(__test.selectBestMaterialPost([{ ...post, contents: post.contents.replace('24th', '25th') }], Date.parse('2026-09-24T10:00:00Z'))).toBeNull();
    const saved = __test.toDatabaseUpdate(
      { appId: 2767030, name: 'Marvel Rivals', averagePlayers: 90000 },
      { ...post, url: 'https://store.steampowered.com/news/app/2767030/view/1844751498220444' },
      __test.classifyMaterialUpdate(post),
    );
    // Release rows store calendar dates; evidence retains the precise UTC hour.
    expect(new Date(saved.releasedAt).toISOString()).toBe('2026-09-24T00:00:00.000Z');
    expect(saved.evidence[0]).toMatchObject({
      publishedAt: '2026-09-24T06:54:04.000Z',
      availableAt: '2026-09-24T09:00:00.000Z',
      releaseTimeBasis: 'publisher-scheduled-utc',
    });
  });

  test('date-only release headlines cannot enter the feed before their named date', () => {
    const post = {
      gid: 'next-day',
      date: Math.floor(Date.parse('2026-09-23T18:00:00Z') / 1000),
      feedname: 'steam_community_announcements',
      title: 'Major Gameplay Update 20260924 Patch Notes',
      contents: list(Array.from({ length: 12 }, (_, i) => `New gameplay map, hero, mission, and combat changes ${i}.`))
        + ' detailed gameplay and mission changes '.repeat(110),
    };
    expect(__test.selectBestMaterialPost([post], Date.parse('2026-09-23T23:59:59Z'))).toBeNull();
    expect(__test.selectBestMaterialPost([post], Date.parse('2026-09-24T00:00:00Z'))?.post.gid).toBe(post.gid);
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
    expect(__test.displayVersion({ title: 'Dota 2 — 7.41f Gameplay Update' }, releasedAt)).toBe('7.41f');
    expect(__test.displayVersion({ title: 'Valheim 1.0 - The Deep North' }, releasedAt)).toBe('1.0');
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
    expect(update.evidence[0].checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(update.evidence[0].materialSignals).toEqual(['gameplay']);
  });

  test('keeps resolved crash fixes out of the active known-issues list', () => {
    const issues = __test.knownIssuesFromNotes([
      'Fixed a bug that caused the game to crash during matchmaking.',
      'A fix for the WD-L020 crash is included in this release.',
      'WD-L020 Crash Error FixFixed an issue that caused a crash on startup.',
      'Reduced the crash rate on Nintendo Switch.',
      'The game may crash when loading a ranked match.',
      'Microsoft is not currently aware of any issues with this update.',
    ]);

    expect(issues).toEqual(['The game may crash when loading a ranked match.']);
  });
});

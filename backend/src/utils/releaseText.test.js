'use strict';

const { normaliseReleaseText, normaliseReleaseTextArray } = require('./releaseText');

test('repairs only mechanically identifiable vendor-feed artifacts', () => {
  expect(normaliseReleaseText('{STEAM_CLAN_LOC_IMAGE}/123/image.png This update intro duces maps.GeneralSnow Day changed.'))
    .toBe('This update introduces maps. GeneralSnow Day changed.');
  expect(normaliseReleaseText('The system was intro duced. Global modifiers:Apply to all.'))
    .toBe('The system was introduced. Global modifiers: Apply to all.');
  expect(normaliseReleaseText('Streamer Mode & PrivacyPlayers are anonymized.'))
    .toBe('Streamer Mode & Privacy: Players are anonymized.');
  expect(normaliseReleaseText('Gameplay Kickoff rules changed.'))
    .toBe('Gameplay: Kickoff rules changed.');
  expect(normaliseReleaseText('Seasons system and Season One With this release, seasons begin.'))
    .toBe('Seasons system and Season One: With this release, seasons begin.');
});

test('normalizes release arrays and drops empty artifacts', () => {
  expect(normaliseReleaseTextArray(['  Valid note. ', '{STEAM_CLAN_LOC_IMAGE}/1/a.png']))
    .toEqual(['Valid note.']);
});

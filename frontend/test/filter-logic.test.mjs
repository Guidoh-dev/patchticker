import test from 'node:test';
import assert from 'node:assert/strict';
import { SETUP_LENSES, filterUpdatesBySetup, filterSearchResultsByProvenance } from '../src/filterLogic.js';

const updates = [
  { id: 'windows', platform: 'Windows' },
  { id: 'nvidia', platform: 'NVIDIA' },
  { id: 'steam', platform: 'Steam' },
  { id: 'switch', platform: 'Switch' },
  { id: 'apple', platform: 'Apple' },
  { id: 'macos', platform: 'macOS' },
  { id: 'chrome', platform: 'Chrome' },
  { id: 'firefox', platform: 'Firefox' },
  { id: 'edge', platform: 'Edge' },
];

test('setup lenses apply OR semantics inside each ecosystem', () => {
  assert.deepEqual(filterUpdatesBySetup(updates, 'console').map(update => update.id), ['steam', 'switch']);
  assert.deepEqual(filterUpdatesBySetup(updates, 'apple').map(update => update.id), ['apple', 'macos']);
  assert.deepEqual(filterUpdatesBySetup(updates, 'pc').map(update => update.id), ['windows', 'nvidia', 'steam', 'chrome', 'firefox', 'edge']);
});

test('everything and unknown setup lenses preserve the full feed', () => {
  assert.deepEqual(filterUpdatesBySetup(updates, ''), updates);
  assert.deepEqual(filterUpdatesBySetup(updates, 'unknown'), updates);
  assert.notEqual(filterUpdatesBySetup(updates, ''), updates);
});

test('setup definitions contain no duplicate platform memberships', () => {
  for (const setup of Object.values(SETUP_LENSES)) {
    assert.equal(new Set(setup.platforms).size, setup.platforms.length);
  }
});

test('completed database searches keep verified issue-inflection matches', () => {
  const matches = [
    { id: 'amd', platform: 'AMD', notes: 'Fixed a driver crash on launch.' },
    { id: 'intel', platform: 'Intel', notes: 'Known issue: application may crash.' },
  ];
  const options = {
    groups: [['crashes']],
    searchText: update => update.notes,
    contains: (text, term) => text.toLowerCase().includes(term),
  };
  assert.deepEqual(filterSearchResultsByProvenance(matches, { ...options, authoritative: true }), matches);
  assert.deepEqual(filterSearchResultsByProvenance(matches, { ...options, authoritative: false }), []);
});

test('cached local searches still require every term group and respect explicit setup filters', () => {
  const matches = [
    { id: 'amd', platform: 'AMD', notes: 'Driver crash on launch.' },
    { id: 'intel', platform: 'Intel', notes: 'Driver game support.' },
    { id: 'ps5', platform: 'PS5', notes: 'Driver crash on launch.' },
  ];
  const filtered = filterSearchResultsByProvenance(filterUpdatesBySetup(matches, 'pc'), {
    authoritative: false,
    groups: [['driver'], ['crash']],
    searchText: update => update.notes,
    contains: (text, term) => text.toLowerCase().includes(term),
  });
  assert.deepEqual(filtered.map(update => update.id), ['amd']);
});

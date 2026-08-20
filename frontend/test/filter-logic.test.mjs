import test from 'node:test';
import assert from 'node:assert/strict';
import { SETUP_LENSES, filterUpdatesBySetup } from '../src/filterLogic.js';

const updates = [
  { id: 'windows', platform: 'Windows' },
  { id: 'nvidia', platform: 'NVIDIA' },
  { id: 'steam', platform: 'Steam' },
  { id: 'switch', platform: 'Switch' },
  { id: 'apple', platform: 'Apple' },
  { id: 'macos', platform: 'macOS' },
];

test('setup lenses apply OR semantics inside each ecosystem', () => {
  assert.deepEqual(filterUpdatesBySetup(updates, 'console').map(update => update.id), ['steam', 'switch']);
  assert.deepEqual(filterUpdatesBySetup(updates, 'apple').map(update => update.id), ['apple', 'macos']);
  assert.deepEqual(filterUpdatesBySetup(updates, 'pc').map(update => update.id), ['windows', 'nvidia', 'steam']);
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

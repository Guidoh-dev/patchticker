import test from 'node:test';
import assert from 'node:assert/strict';
import { selectUpdateBrief } from '../src/updateBrief.js';

const updates = [
  {
    id: 'edge-old-release-new-row',
    name: 'Edge older release',
    platform: 'Edge',
    releasedAt: '2026-09-10T00:00:00.000Z',
    createdAt: '2026-09-17T17:00:00.000Z',
  },
  {
    id: 'valheim-new-release',
    name: 'Valheim newest release',
    platform: 'Steam',
    releasedAt: '2026-09-17T00:00:00.000Z',
    createdAt: '2026-09-17T12:00:00.000Z',
  },
  {
    id: 'firefox-middle-release',
    name: 'Firefox middle release',
    platform: 'Firefox',
    releasedAt: '2026-09-15T00:00:00.000Z',
    createdAt: '2026-09-15T12:00:00.000Z',
  },
];

test('first-visit briefing uses the true vendor release date, not row insertion time', () => {
  const brief = selectUpdateBrief(updates);
  assert.equal(brief.isReturning, false);
  assert.equal(brief.latest.id, 'valheim-new-release');
  assert.deepEqual(brief.featured.map(update => update.id), [
    'valheim-new-release',
    'firefox-middle-release',
    'edge-old-release-new-row',
  ]);
});

test('returning-visitor briefing separately ranks records that arrived after the visit', () => {
  const baseline = Date.parse('2026-09-17T14:00:00.000Z');
  const brief = selectUpdateBrief(updates, baseline);
  assert.equal(brief.isReturning, true);
  assert.equal(brief.sinceLastVisit.length, 1);
  assert.equal(brief.latest.id, 'edge-old-release-new-row');
});

test('caught-up returning visitors still see the true latest release', () => {
  const baseline = Date.parse('2026-09-18T00:00:00.000Z');
  const brief = selectUpdateBrief(updates, baseline);
  assert.equal(brief.sinceLastVisit.length, 0);
  assert.equal(brief.latest.id, 'valheim-new-release');
});

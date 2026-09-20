import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseLaneKey } from '../src/releaseLanes.js';

test('metadata enrichment never creates a second latest lane for a platform', () => {
  assert.equal(releaseLaneKey({ platform: 'Intel', sourceKind: 'official-release-notes' }), 'Intel');
  assert.equal(releaseLaneKey({ platform: 'Intel', sourceKind: null }), 'Intel');
  assert.equal(releaseLaneKey({ platform: 'NVIDIA', productId: 'legacy-import' }), 'NVIDIA');
});

test('Steam client, SteamOS, and individual games retain independent release lanes', () => {
  assert.equal(releaseLaneKey({ platform: 'Steam', sourceKind: 'steam-client-news' }), 'Steam:client');
  assert.equal(releaseLaneKey({ platform: 'Steam', sourceKind: 'steamos-news' }), 'Steam:steamos');
  assert.equal(releaseLaneKey({ platform: 'Steam', name: 'Steam Deck Stable Update' }), 'Steam:steamos');
  assert.equal(releaseLaneKey({ platform: 'Steam', sourceKind: 'steam-game-news', productId: '730' }), 'Steam:game:730');
  assert.equal(releaseLaneKey({ platform: 'Steam', sourceKind: 'steam-game-news', productId: '570' }), 'Steam:game:570');
});

test('legacy Steam game records without App IDs use a deterministic product fallback', () => {
  const legacy = { platform: 'Steam', sourceKind: 'steam-game-news', name: 'Counter-Strike 2' };
  assert.equal(releaseLaneKey(legacy), 'Steam:game:counter-strike-2');
  assert.equal(releaseLaneKey(legacy), releaseLaneKey({ ...legacy, id: 'different-row-id' }));
});


import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { route, resolveRoute } from '../src/router.js';

const root = resolve(import.meta.dirname, '..');
const mainSource = await readFile(resolve(root, 'src/main.js'), 'utf8');
const cssSource = await readFile(resolve(root, 'src/styles.css'), 'utf8');

test('router resolves exact and dynamic update directories', () => {
  const updatesHandler = () => 'updates';
  const detailHandler = () => 'detail';
  route('/updates', updatesHandler);
  route('/updates/:id', detailHandler);

  assert.equal(resolveRoute('/updates')?.handler, updatesHandler);
  assert.equal(resolveRoute('/updates/intel-32-0-101-8864')?.handler, detailHandler);
  assert.deepEqual(resolveRoute('/updates/intel-32-0-101-8864')?.params, {
    id: 'intel-32-0-101-8864',
  });
  assert.equal(resolveRoute('/updates/not%20encoded')?.params.id, 'not encoded');
});

test('application registers canonical navigation directories and aliases', () => {
  for (const path of [
    '/updates', '/updates/:id', '/games', '/categories', '/settings', '/about',
    '/account', '/pricing', '/privacy', '/terms', '/platform/:name',
  ]) {
    assert.match(mainSource, new RegExp(`route\\('${path.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}'`));
  }
  assert.match(mainSource, /fallback\(\(\{ path \}\) => renderNotFound\(path\)\)/);
});

test('dashboard section links remain inside the hash router', () => {
  assert.doesNotMatch(mainSource, /href=["']#(?:section|category)-/);
  assert.match(mainSource, /data-scroll-target="section-latest"/);
  assert.match(mainSource, /data-scroll-target="category-/);
});

test('user-facing setup filters no longer use stack terminology', () => {
  assert.doesNotMatch(mainSource, />[^<]*\bstacks?\b[^<]*</i);
  assert.match(mainSource, />PC &amp; Steam</);
  assert.match(mainSource, />Console &amp; handheld</);
  assert.match(mainSource, />Apple devices</);
});

test('triad dashboard resets legacy nested grid and uses horizontal metadata rows', () => {
  assert.match(cssSource, /\.dash-wrap--triad \.dash-main\s*\{[^}]*display:\s*block/s);
  assert.match(cssSource, /\.decision-card-link\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/s);
  assert.match(cssSource, /\.decision-card-metrics\s*\{[^}]*display:\s*flex/s);
  assert.match(cssSource, /\.detail-meta-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4,/s);
  assert.match(cssSource, /@media \(max-width: 640px\)[\s\S]*?\.detail-meta-grid\s*\{\s*grid-template-columns:\s*1fr;/);
});

test('non-default filters and sorting use the globally ordered result list', () => {
  assert.match(mainSource, /const keepsPlatformBrowse = sort === 'date_desc' && !status && !search/);
  assert.match(mainSource, /renderFilteredUpdateResults\(filtered, _filterState\)/);
  assert.match(mainSource, /updates\.map\(renderUpdateCard\)\.join\(''\)/);
});

test('theme and tracked-game preferences use persistent local storage keys', () => {
  assert.match(mainSource, /patchticker\.theme/);
  assert.match(mainSource, /patchticker\.followedSteamGames/);
  assert.match(mainSource, /document\.documentElement\.dataset\.theme/);
  assert.match(cssSource, /html\[data-theme="light"\]/);
});

test('sticky update filters collapse on downward scroll and remain accessible', () => {
  assert.match(mainSource, /function attachQuickbarScrollBehavior\(\)/);
  assert.match(mainSource, /delta > 8[\s\S]*?setCollapsed\(true\)/);
  assert.match(mainSource, /delta < -18[\s\S]*?setCollapsed\(false\)/);
  assert.match(mainSource, /aria-controls="dash-quickbar-details"/);
  assert.match(mainSource, /attachQuickbarScrollBehavior\(\)/);
  assert.match(mainSource, /_quickbarScrollController\?\.abort\(\)/);
  assert.match(cssSource, /\.dash-quickbar\.is-collapsed \.dash-quickbar-details\s*\{[^}]*max-height:\s*0/s);
  assert.match(cssSource, /\.dash-quickbar-toggle\s*\{[^}]*min-height:\s*44px/s);
  assert.match(cssSource, /@media \(max-width: 760px\)[\s\S]*?html, body, #app\s*\{[^}]*overflow-x:\s*clip/s);
});

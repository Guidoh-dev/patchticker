import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { route, resolveRoute } from '../src/router.js';

const root = resolve(import.meta.dirname, '..');
const mainSource = await readFile(resolve(root, 'src/main.js'), 'utf8');
const cssSource = await readFile(resolve(root, 'src/styles.css'), 'utf8');
const apiSource = await readFile(resolve(root, 'src/api.js'), 'utf8');

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

test('update detail columns cannot force horizontal page overflow', () => {
  assert.match(cssSource, /\.detail-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(280px, 380px\)/s);
  assert.match(cssSource, /\.detail-col-main,\s*\.detail-col-side\s*\{[^}]*min-width:\s*0/s);
  assert.match(cssSource, /\.detail-reasoning,[\s\S]*?\.detail-requirement-grid strong\s*\{[^}]*overflow-wrap:\s*anywhere/s);
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

test('sticky update filters retreat on downward scroll and return toward the top', () => {
  assert.match(mainSource, /function attachQuickbarScrollBehavior\(\)/);
  assert.match(mainSource, /currentY > 240 && delta >= 0[\s\S]*?setHidden\(true\)/);
  assert.match(mainSource, /delta < -12[\s\S]*?setHidden\(false\)[\s\S]*?setCollapsed\(true\)/);
  assert.match(mainSource, /currentY <= 140[\s\S]*?setHidden\(false\)[\s\S]*?setCollapsed\(false\)/);
  assert.match(mainSource, /aria-controls="dash-quickbar-details"/);
  assert.match(mainSource, /attachQuickbarScrollBehavior\(\)/);
  assert.match(mainSource, /_quickbarScrollController\?\.abort\(\)/);
  assert.doesNotMatch(mainSource, /quickbar\.contains\(document\.activeElement\)/);
  assert.match(mainSource, /document\.activeElement === search[\s\S]*?search\.blur\(\)/);
  assert.match(cssSource, /\.dash-quickbar\.is-collapsed \.dash-quickbar-details\s*\{[^}]*max-height:\s*0/s);
  assert.match(cssSource, /\.dash-quickbar\.is-scroll-hidden\s*\{[^}]*opacity:\s*0;[^}]*visibility:\s*hidden;[^}]*transform:\s*translateY\(calc\(-100% - 16px\)\)/s);
  assert.match(cssSource, /\.dash-quickbar-toggle\s*\{[^}]*min-height:\s*44px/s);
  assert.match(cssSource, /@media \(max-width: 760px\)[\s\S]*?html, body, #app\s*\{[^}]*overflow-x:\s*clip/s);
});

test('mobile ticker viewport clips its moving track without widening the page', () => {
  assert.match(cssSource, /\.update-tape-window\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*overflow:\s*hidden;/s);
  assert.doesNotMatch(cssSource, /\.dash-status-ribbon,\s*\.update-tape-window\s*\{[^}]*overflow-x:\s*auto;/s);
});

test('auth, feed, and history controls meet the touch target floor', () => {
  assert.match(cssSource, /\.chip\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px/s);
  assert.match(cssSource, /\.dash-search-row \.dash-search,\s*\.dash-sort\s*\{[^}]*min-height:\s*44px/s);
  assert.match(cssSource, /\.field-input\s*\{[^}]*min-height:\s*44px/s);
  assert.match(cssSource, /\.field-link\s*\{[^}]*min-height:\s*44px/s);
  assert.match(cssSource, /\.history-link\s*\{[^}]*min-width:\s*44px/s);
  assert.match(cssSource, /\.feed-input\s*\{[^}]*min-height:\s*44px/s);
  assert.match(cssSource, /\.feed-send\s*\{[^}]*min-height:\s*44px/s);
});

test('an unavailable or empty community feed renders a compact status state', () => {
  assert.match(mainSource, /Checking recent community activity/);
  assert.match(mainSource, /No community notes yet\. Live updates will appear here\./);
  assert.match(mainSource, /Community feed is reconnecting/);
  assert.match(cssSource, /\.dash-aside \.feed-messages:has\(> \.feed-empty:only-child\)\s*\{[^}]*min-height:\s*104px/s);
});

test('public community reads use privacy-safe display labels', () => {
  assert.match(apiSource, /request\('\/feed\/recent', \{ skipAuth: true \}\)/);
  assert.match(mainSource, /post\.userLabel \|\| post\.userEmail\?\.split/);
  assert.match(mainSource, /Community signal/);
});

test('expired update permalinks explain the 240-day display window', () => {
  assert.match(mainSource, /err\.status === 404/);
  assert.match(mainSource, /outside PatchTicker’s 240-day display window/);
});

test('update cards and detail pages expose compact source freshness signals', () => {
  assert.match(mainSource, /function freshnessMeta\(update\)/);
  assert.match(mainSource, /Fresh[\s\S]*Recent[\s\S]*Aging[\s\S]*Recheck due/);
  assert.match(mainSource, /decision-card-trust/);
  assert.match(mainSource, /detail-source-health/);
  assert.match(mainSource, /official source/);
  assert.match(mainSource, /Source \+ issue signals/);
  assert.match(mainSource, /\/10 PatchTicker score/);
  assert.match(mainSource, /updateDateLabel\(u\)/);
  assert.match(mainSource, /id="dash-coverage-pulse"/);
  assert.match(mainSource, /No demo records shown/);
  assert.match(cssSource, /\.freshness-signal--fresh\s*\{[^}]*var\(--green-primary\)/s);
  assert.match(cssSource, /\.freshness-signal--stale\s*\{[^}]*var\(--red\)/s);
  assert.match(cssSource, /\.dash-coverage-pulse\s*\{[^}]*border-radius:\s*999px/s);
});

test('offline update feeds remain honest instead of reviving demo records', () => {
  assert.match(mainSource, /function renderOfflineRails[\s\S]*?_allUpdates = \[\][\s\S]*?renderTapeAndLatest\(\[\], message\)/);
  assert.match(mainSource, /Verified patch data will return when the connection recovers/);
  assert.doesNotMatch(mainSource, /typeof getStaticUpdates === 'function'/);
});

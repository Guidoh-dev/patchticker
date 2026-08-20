import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { route, resolveRoute } from '../src/router.js';

const root = resolve(import.meta.dirname, '..');
const mainSource = await readFile(resolve(root, 'src/main.js'), 'utf8');
const cssSource = await readFile(resolve(root, 'src/styles.css'), 'utf8');
const apiSource = await readFile(resolve(root, 'src/api.js'), 'utf8');
const routerSource = await readFile(resolve(root, 'src/router.js'), 'utf8');
const filterLogicSource = await readFile(resolve(root, 'src/filterLogic.js'), 'utf8');

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

test('route renders reset stale page scroll before showing the next screen', () => {
  assert.match(mainSource, /function resetPageScroll\(\)\s*\{[\s\S]*?document\.scrollingElement \|\| document\.documentElement[\s\S]*?root\.style\.scrollBehavior = 'auto';[\s\S]*?root\.scrollTo\(\{ top: 0, left: 0, behavior: 'auto' \}\);[\s\S]*?app\.scrollTop = 0;/);
  assert.match(mainSource, /function setHTML\(html\)\s*\{[\s\S]*?document\.body\.classList\.remove\('dashboard-shell-active'\);[\s\S]*?resetPageScroll\(\);[\s\S]*?app\.innerHTML = html;[\s\S]*?resetPageScroll\(\);[\s\S]*?requestAnimationFrame\(resetPageScroll\);/);
  assert.match(routerSource, /typeof window !== 'undefined'[\s\S]*?window\.history\.scrollRestoration = 'manual'/);
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

test('triad dashboard uses one separated column flow and horizontal metadata rows', () => {
  assert.match(cssSource, /\.dash-wrap--triad \.dash-main\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*gap:\s*18px/s);
  assert.match(cssSource, /\.dash-wrap--triad \.dash-main > \.dash-quickbar,[\s\S]*?\.dash-wrap--triad \.dash-main > \.dash-panel\s*\{[^}]*margin-bottom:\s*0/s);
  assert.match(cssSource, /\.decision-card-link\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 148px/s);
  assert.match(cssSource, /\.decision-card-rating\s*\{[^}]*justify-items:\s*center/s);
  assert.match(cssSource, /\.detail-meta-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4,/s);
  assert.match(cssSource, /@media \(max-width: 640px\)[\s\S]*?\.detail-meta-grid\s*\{\s*grid-template-columns:\s*1fr;/);
});

test('update detail columns cannot force horizontal page overflow', () => {
  assert.match(cssSource, /\.detail-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(280px, 380px\)/s);
  assert.match(cssSource, /\.detail-col-main,\s*\.detail-col-side\s*\{[^}]*min-width:\s*0/s);
  assert.match(cssSource, /\.detail-reasoning,[\s\S]*?\.detail-requirement-grid strong\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(cssSource, /\.detail-meta-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4,/s);
  assert.match(cssSource, /\.detail-meta-grid > div:last-child\s*\{[^}]*grid-column:\s*1 \/ -1;/s);
  assert.match(cssSource, /\.detail-meta-grid > div:nth-child\(2\) strong\s*\{[^}]*white-space:\s*nowrap;/s);
  assert.match(cssSource, /@media \(max-width: 640px\)[\s\S]*?\.detail-hero-left\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*56px minmax\(0, 1fr\);[^}]*width:\s*100%/s);
  assert.match(cssSource, /\.detail-meta-grid,[\s\S]*?\.detail-source-timeline-wrap\s*\{[^}]*grid-column:\s*1 \/ -1;[^}]*width:\s*100%/s);
  assert.match(cssSource, /\.detail-hero-left > div\s*\{[^}]*flex:\s*1;[^}]*min-width:\s*0;/s);
  assert.match(cssSource, /@media \(max-width: 1120px\)[\s\S]*?\.detail-hero--brief\s*\{[^}]*flex-direction:\s*column;[^}]*\}[\s\S]*?\.detail-decision-panel\s*\{[^}]*width:\s*100%/s);
});

test('update cards organize title, release date, package size, and rating without fabricated size data', () => {
  assert.match(mainSource, /function packageSizeMeta\(update\)/);
  assert.match(mainSource, /update\?\.sizeBytes/);
  assert.match(mainSource, /Array\.isArray\(update\?\.downloads\)/);
  assert.match(mainSource, /return \{ value: 'Not listed', available: false, note: 'Not published by vendor' \}/);
  assert.match(mainSource, /class="decision-card-facts" aria-label="Update facts"/);
  assert.match(mainSource, /<dt>Package size<\/dt>/);
  assert.match(mainSource, /class="decision-card-rating" aria-label="Patch recommendation and rating"/);
  assert.match(mainSource, /const scoreLabel = rating\.votes \? 'User rating' : 'Safety score'/);
  assert.match(mainSource, /const ratingSource = rating\.votes \? 'Live community' : 'PatchTicker'/);
  assert.match(cssSource, /\.decision-card-facts\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s);
  assert.match(cssSource, /\.decision-card-link:hover,[\s\S]*?text-decoration:\s*none !important/s);
  assert.match(cssSource, /\.decision-card-rating-value strong\s*\{[^}]*font-size:\s*36px/s);
});

test('non-default filters and sorting use the globally ordered result list', () => {
  assert.match(mainSource, /const keepsPlatformBrowse = sort === 'date_desc' && !status && !search/);
  assert.match(mainSource, /renderFilteredUpdateResults\(filtered, _filterState\)/);
  assert.match(mainSource, /updates\.map\(update => renderUpdateCard\(\{/);
});

test('typed dashboard searches query the full database with race protection', () => {
  assert.match(apiSource, /fetchUpdates\(\{ platform, status, sort, search, signal \} = \{\}\)/);
  assert.match(mainSource, /async function runAuthoritativeSearch\(rawQuery\)/);
  assert.match(mainSource, /new AbortController\(\)/);
  assert.match(mainSource, /requestId !== _searchRequestId/);
  assert.match(mainSource, /fetchUpdates\(\{[\s\S]*?platform: _filterState\.platform,[\s\S]*?status: _filterState\.status,[\s\S]*?search: query,[\s\S]*?sort: _filterState\.sort,[\s\S]*?signal: controller\.signal/);
  assert.match(mainSource, /Searching every verified release/);
  assert.match(mainSource, /Database search ·/);
  assert.match(mainSource, /PatchTicker’s 240-day window/);
  assert.match(cssSource, /\.dash-search-status\.is-loading\s*\{[^}]*var\(--cyan\)/s);
  assert.match(cssSource, /\.empty-state--search\s*\{[^}]*display:\s*grid/s);
});

test('searches preserve precise terms, rank best matches, and explain each result', () => {
  assert.match(mainSource, /q === 'switch oled' \|\| q === 'switch lite'/);
  assert.match(mainSource, /const exactAlias = Object\.entries\(SEARCH_ALIASES\)\.find/);
  assert.match(mainSource, /function updateSearchRelevance\(update, query\)/);
  assert.match(mainSource, /exactQuery && haystack\.includes\(exactQuery\)[\s\S]*?weight \* 10/);
  assert.match(mainSource, /const crossFieldCoverage = groups\.reduce/);
  assert.match(mainSource, /function searchMatchReason\(update, query\)/);
  assert.match(mainSource, /<option value="relevance">Best match<\/option>/);
  assert.match(mainSource, /relevance:\s+\(a, b\) => updateSearchRelevance\(b, search\) - updateSearchRelevance\(a, search\)/);
  assert.match(mainSource, /Matched in \$\{H\(u\.matchReason\)\}/);
  assert.match(mainSource, /search && _draftFilterState\.sort === 'date_desc'[\s\S]*?'relevance'/);
  assert.match(cssSource, /\.decision-match-reason\s*\{[^}]*color:\s*var\(--cyan\)/s);
});

test('exact platform searches exclude incidental mentions from other release notes', () => {
  assert.match(mainSource, /const EXACT_PLATFORM_SEARCHES = new Map/);
  assert.match(mainSource, /function exactPlatformForSearch\(raw\)/);
  assert.match(mainSource, /filtered = filtered\.filter\(u => u\.platform === exactPlatform\)/);
  assert.match(mainSource, /Platform search · \$\{platformLabel\(exactPlatform\)\}/);
});

test('multi-part searches use strict all-term matching without phrase-order failures', () => {
  assert.match(mainSource, /function searchTermGroups\(raw\)/);
  assert.match(mainSource, /tokens\.length > 1[\s\S]*?map\(token => \[token\]\)/);
  assert.match(mainSource, /groups\.every\(group => group\.some\(needle => haystack\.includes\(needle\)\)\)/);
  assert.match(mainSource, /filtered = filtered\.filter\(u => \{[\s\S]*?groups\.every\(group => group\.some\(term => haystack\.includes\(term\)\)\)/);
  assert.match(mainSource, /return 'Across update details'/);
  assert.match(mainSource, /All \$\{H\(String\(matchedTermCount\)\)\} search terms matched/);
});

test('search results expose staged platform facets, verification timing, and honest recovery actions', () => {
  assert.match(mainSource, /class="search-result-facets" aria-label="Narrow search results by platform"/);
  assert.match(mainSource, /data-result-platform="\$\{H\(resultPlatform\)\}"/);
  assert.match(mainSource, /Sources checked \$\{H\(timeAgo\(latestCheck\)\)\}/);
  assert.match(mainSource, /function suggestedPlatformForSearch\(query\)/);
  assert.match(mainSource, /no matching official release is inside PatchTicker’s 240-day window/);
  assert.match(mainSource, /data-empty-platform="\$\{H\(browsePlatform\)\}"/);
  assert.match(mainSource, /setDraftFilters\(\{ platform: nextPlatform \}\)/);
  assert.match(mainSource, /Press Apply to update results/);
  assert.match(mainSource, /data-apply-result-facets disabled>Apply view/);
  assert.match(mainSource, /#dash-apply-filters, #dash-top-apply-filters, #search-result-apply/);
  assert.match(mainSource, /await applyDraftFilters\(\)/);
  assert.match(cssSource, /\.search-result-facet\s*\{[^}]*min-height:\s*44px/s);
  assert.match(cssSource, /\.search-result-apply\s*\{[^}]*min-height:\s*44px/s);
  assert.match(cssSource, /@media \(max-width: 640px\)[\s\S]*?\.search-result-facets\s*\{[^}]*overflow-x:\s*auto/s);
});

test('theme and tracked-game preferences use persistent local storage keys', () => {
  assert.match(mainSource, /patchticker\.theme/);
  assert.match(mainSource, /patchticker\.followedSteamGames/);
  assert.match(mainSource, /document\.documentElement\.dataset\.theme/);
  assert.match(cssSource, /html\[data-theme="light"\]/);
});

test('sticky update filters retreat on downward scroll and return toward the top', () => {
  assert.match(mainSource, /function attachQuickbarScrollBehavior\(\)/);
  assert.match(mainSource, /const QUICKBAR_TOP_ZONE_PX = 120/);
  assert.match(mainSource, /direction === 'down'[\s\S]*?setCollapsed\(true\)[\s\S]*?setHidden\(true\)/);
  assert.match(mainSource, /direction === 'up'[\s\S]*?setHidden\(false\)[\s\S]*?setCollapsed\(true\)/);
  assert.match(mainSource, /const collapseAtTop = true/);
  assert.match(mainSource, /currentY <= QUICKBAR_TOP_ZONE_PX[\s\S]*?setHidden\(false\)[\s\S]*?setCollapsed\(Date\.now\(\) < manualOpenUntil \? false : collapseAtTop\)/);
  assert.match(mainSource, /const scrollRoot = window\.matchMedia\('\(max-width: 768px\)'\)\.matches/);
  assert.match(mainSource, /scrollRoot\.addEventListener\('wheel', onWheel/);
  assert.match(mainSource, /scrollRoot\.addEventListener\('touchmove', onTouchMove/);
  assert.match(mainSource, /lockDirection\('down', 1200\)/);
  assert.match(mainSource, /lockDirection\('up', 1200\)/);
  assert.match(mainSource, /function settleScrollState|const settleScrollState/);
  assert.match(mainSource, /lastDirection !== 'up'[\s\S]*?setHidden\(true\)/);
  assert.match(mainSource, /aria-controls="dash-quickbar-details"/);
  assert.match(mainSource, /attachQuickbarScrollBehavior\(\)/);
  assert.match(mainSource, /_quickbarScrollController\?\.abort\(\)/);
  assert.doesNotMatch(mainSource, /quickbar\.contains\(document\.activeElement\)/);
  assert.match(mainSource, /document\.activeElement === search[\s\S]*?search\.blur\(\)/);
  assert.match(mainSource, /quickbar\.dataset\.scrollState = hidden \? 'hidden' : 'visible'/);
  assert.match(cssSource, /\.dash-quickbar\.is-collapsed \.dash-quickbar-details\s*\{[^}]*max-height:\s*0/s);
  assert.match(cssSource, /\.dash-quickbar\.is-scroll-hidden\s*\{[^}]*opacity:\s*0;[^}]*visibility:\s*hidden;[^}]*transform:\s*translateY\(calc\(-100% - 16px\)\)/s);
  assert.match(cssSource, /\.dash-quickbar-toggle\s*\{[^}]*min-height:\s*44px/s);
  assert.match(cssSource, /@media \(max-width: 760px\)[\s\S]*?html, body, #app\s*\{[^}]*overflow-x:\s*clip/s);
});

test('quick filters start collapsed and analytics consent stays compact on mobile', () => {
  assert.match(mainSource, /<section class="dash-quickbar is-collapsed"[^>]*data-collapsed="true"/);
  assert.match(mainSource, /aria-expanded="false" aria-label="Show update filters"/);
  assert.match(cssSource, /\.analytics-consent-detail--compact\s*\{\s*display:\s*none/);
  assert.match(cssSource, /@media \(max-width: 640px\)[\s\S]*?\.analytics-consent-detail--full\s*\{\s*display:\s*none;\s*\}[\s\S]*?\.analytics-consent-detail--compact\s*\{\s*display:\s*block;/);
});

test('default platform sections reveal deep history on demand instead of flooding the page', () => {
  assert.match(mainSource, /const initialCount = platform === 'Steam' \? 4 : 1/);
  assert.match(mainSource, /class="platform-feed-more"[^>]*hidden/);
  assert.match(mainSource, /data-expand-platform-releases=/);
  assert.match(mainSource, /target\.hidden = !willOpen/);
  assert.match(cssSource, /\.platform-more-toggle\s*\{[^}]*min-height:\s*44px/s);
});

test('featured decisions remain an editorial preview instead of duplicating the full feed', () => {
  assert.match(mainSource, /newest\.slice\(0, 3\)\.map\(renderMiniUpdateCard\)/);
  assert.match(cssSource, /\.latest-decisions-grid\s*\{[^}]*grid-auto-flow:\s*column/s);
});

test('mobile cards prioritize the decision and collapse low-value repetition', () => {
  assert.match(mainSource, /class="decision-card-checked"/);
  assert.match(mainSource, /class="decision-card-source-count"/);
  assert.match(cssSource, /@media \(max-width: 480px\)[\s\S]*?\.decision-card-facts > \.is-unavailable\s*\{\s*display:\s*none;/s);
  assert.match(cssSource, /\.decision-card-source-count,[\s\S]*?\.source-depth-signal\s*\{\s*display:\s*none;/s);
  assert.match(cssSource, /\.decision-card-rating\s*\{[^}]*grid-template-areas:\s*"action label value"/s);
});

test('the client applies the same 240-day update display ceiling as the API', () => {
  assert.match(mainSource, /const MAX_UPDATE_AGE_DAYS = 240/);
  assert.match(mainSource, /function isUpdateWithinDisplayWindow\(update/);
  assert.match(mainSource, /normaliseUpdatesResponse\(await fetchUpdates\(\{\}\)\)[\s\S]*?\.filter\(update => isUpdateWithinDisplayWindow\(update\)\)/);
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
  assert.match(cssSource, /\.feed-send\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px/s);
  assert.match(cssSource, /\.sub-upgrade-link\s*\{[^}]*display:\s*inline-flex;[^}]*min-height:\s*44px/s);
});

test('signup copy matches the enforced password policy and handles email outages', () => {
  assert.doesNotMatch(mainSource, /Min 8 chars/);
  assert.match(mainSource, /placeholder="12\+ characters"/);
  assert.match(mainSource, /Use uppercase, lowercase, a number, and a symbol/);
  assert.match(mainSource, /data\.verificationEmailSent === false/);
  assert.match(mainSource, /navigate\('\/verify-email'\)/);
  assert.match(cssSource, /\.field-hint\s*\{[^}]*var\(--text-3\)/s);
});

test('an empty community feed becomes a verified-release activity rail', () => {
  assert.match(mainSource, /Checking recent community activity/);
  assert.match(mainSource, /No community notes yet\. Start with recently verified releases\./);
  assert.match(mainSource, /Community notes are reconnecting\. These releases were recently verified\./);
  assert.match(mainSource, /function renderVerifiedFeedFallback/);
  assert.match(mainSource, /feed-verified-item/);
  assert.match(cssSource, /\.dash-aside \.feed-messages:has\(> \.feed-empty:only-child\)\s*\{[^}]*min-height:\s*104px/s);
  assert.match(cssSource, /\.feed-verified-item\s*\{[^}]*min-height:\s*54px/s);
});

test('public community reads use privacy-safe display labels', () => {
  assert.match(apiSource, /request\('\/feed\/recent', \{ skipAuth: true \}\)/);
  assert.match(mainSource, /post\.userLabel \|\| post\.userEmail\?\.split/);
  assert.match(mainSource, /Release wire \+ chat/);
  assert.match(mainSource, /First-party release events and member chat · no third-party tracker/);
});

test('filter controls stage draft state and only update the feed through Apply', () => {
  assert.match(mainSource, /let _draftFilterState = defaultFilterState\(\)/);
  assert.match(mainSource, /function setDraftFilters\(patch\)/);
  assert.match(mainSource, /function applyDraftFilters\(\)/);
  assert.match(mainSource, /_filterState = \{ \.\.\._draftFilterState \}/);
  assert.match(mainSource, /id="dash-apply-filters"[^>]*disabled>Apply filters/);
  assert.match(mainSource, /id="dash-top-apply-filters"[^>]*disabled>Apply/);
  assert.match(mainSource, /button\.addEventListener\('click', applyDraftFilters\)/);
  assert.match(mainSource, /if \(platform\) filtered = filtered\.filter/);
  assert.match(mainSource, /if \(status\)\s+filtered = filtered\.filter/);
  assert.match(mainSource, /groups\.every\(group => group\.some\(term => haystack\.includes\(term\)\)\)/);
  assert.doesNotMatch(mainSource, /setTimeout\(\(\) => runAuthoritativeSearch/);
});

test('setup lenses use ecosystem OR filters instead of impossible all-term searches', () => {
  assert.match(filterLogicSource, /const SETUP_LENSES = Object\.freeze/);
  assert.match(filterLogicSource, /pc:\s*\{[^}]*platforms:\s*\['Windows', 'NVIDIA', 'AMD', 'Intel', 'Steam'/s);
  assert.match(mainSource, /filtered = filterUpdatesBySetup\(filtered, setup\)/);
  assert.doesNotMatch(mainSource, /data-lens="windows nvidia amd intel/);
});

test('dashboard uses independent desktop scrollers and native mobile page scroll', () => {
  assert.match(mainSource, /document\.body\.classList\.add\('dashboard-shell-active'\)/);
  assert.match(cssSource, /@media \(min-width: 769px\)[\s\S]*?body\.dashboard-shell-active\s*\{[^}]*height:\s*100vh;[^}]*overflow:\s*hidden/s);
  assert.match(cssSource, /body\.dashboard-shell-active \.dash-sidebar,[\s\S]*?body\.dashboard-shell-active \.dash-aside\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(cssSource, /@media \(max-width: 768px\)[\s\S]*?body\.dashboard-shell-active \.dash-main,[\s\S]*?overflow-y:\s*visible/s);
  assert.match(cssSource, /body\.dashboard-shell-active \.dash-sidebar\s*\{\s*display:\s*none;/s);
});

test('sticky filters are opaque, isolated, and cannot bleed into the patch feed', () => {
  assert.match(cssSource, /@media \(min-width: 769px\)[\s\S]*?body\.dashboard-shell-active \.dash-main\s*\{[^}]*position:\s*relative;[^}]*isolation:\s*isolate;[^}]*scroll-padding-top:\s*80px/s);
  assert.match(cssSource, /body\.dashboard-shell-active \.dash-main \.dash-quickbar\s*\{[^}]*z-index:\s*50;[^}]*background:\s*var\(--bg\);[^}]*backdrop-filter:\s*none/s);
  assert.match(cssSource, /body\.dashboard-shell-active \.dash-layout,[\s\S]*?body\.dashboard-shell-active \.dash-aside\s*\{[^}]*max-height:\s*100%/s);
});

test('release cards contain hostile text and keep a consistent visual gap', () => {
  assert.match(cssSource, /\.updates-list--desk,[\s\S]*?\.category-feed-section\s*\{[^}]*gap:\s*14px/s);
  assert.match(cssSource, /\.decision-card,[\s\S]*?\.detail-requirement-grid strong\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*word-break:\s*break-word/s);
});

test('homepage narrative is centered without fixed horizontal offsets', () => {
  assert.match(cssSource, /\.landing-intro\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*justify-content:\s*center;[^}]*align-items:\s*center;[^}]*width:\s*100%;[^}]*text-align:\s*center/s);
  assert.match(cssSource, /\.landing-actions,[\s\S]*?\.landing-scroll-map\s*\{[^}]*justify-content:\s*center;[^}]*width:\s*100%/s);
  assert.match(cssSource, /\.landing-band\s*\{[^}]*flex-direction:\s*column;[^}]*justify-content:\s*center;[^}]*align-items:\s*center/s);
});

test('newest movement heading is centered across viewports', () => {
  assert.match(mainSource, /class="dash-panel-head update-tape-heading"/);
  assert.match(cssSource, /\.update-tape-panel\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);[^}]*align-items:\s*stretch/s);
  assert.match(cssSource, /\.update-tape-heading\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(116px, 1fr\) auto minmax\(116px, 1fr\);[^}]*text-align:\s*center/s);
  assert.match(cssSource, /\.update-tape-heading > div\s*\{[^}]*grid-column:\s*2/s);
  assert.match(cssSource, /\.update-tape-heading \.dash-panel-badge\s*\{[^}]*position:\s*static;[^}]*grid-column:\s*3;[^}]*justify-self:\s*end/s);
  assert.match(cssSource, /@media \(max-width: 768px\)[\s\S]*?\.update-tape-heading\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
});

test('native live chat uses one-time SSE tickets and completes the composer', () => {
  assert.match(apiSource, /createFeedStreamTicket\(\)/);
  assert.match(apiSource, /\/feed\/stream\?ticket=/);
  assert.doesNotMatch(apiSource, /\/feed\/stream\?token=/);
  assert.match(mainSource, /id="feed-platform"/);
  assert.match(mainSource, /id="feed-char-count">0\/280/);
  assert.match(mainSource, /appendMessage\(\{ \.\.\.created, isOwn: true \}, true\)/);
  assert.match(mainSource, /post\.eventType === 'release'/);
  assert.match(mainSource, /async function refreshReleaseFromWire\(updateId\)/);
  assert.match(mainSource, /await fetchUpdateById\(id\)/);
  assert.match(mainSource, /_allUpdates = annotateReleasePositions\(\[/);
  assert.match(mainSource, /post\?\.eventType === 'release'[\s\S]*?refreshReleaseFromWire\(post\.updateId\)/);
  assert.match(mainSource, /Open release →/);
  assert.match(cssSource, /\.feed-msg--release/);
  assert.match(mainSource, /const canChat = isAuthed && user\?\.emailVerified === true/);
  assert.match(mainSource, /Verify your email/);
  assert.match(mainSource, /_liveFeedCleanup = \(\) =>/);
});

test('invalid update scores are dropped rather than coerced to zero or five', () => {
  assert.match(mainSource, /function validScoreOrNull\(value\)/);
  assert.match(mainSource, /typeof value !== 'number' && typeof value !== 'string'/);
  assert.match(mainSource, /Number\.isFinite\(numeric\) && numeric >= 0 && numeric <= 10/);
  assert.match(mainSource, /score: validScoreOrNull\(update\?\.score\)/);
  assert.match(mainSource, /return score === null \? 'Not scored'/);
  assert.match(mainSource, /if \(score === null\) return \{ label: 'Review official notes', cls: 'unscored', action: 'REVIEW' \}/);
  assert.doesNotMatch(mainSource, /vote\.avoid.*decisionForUpdate|decisionForUpdate[\s\S]{0,500}vote\.wait/);
  assert.doesNotMatch(mainSource, /Number\(latest\.score\) \|\| 0/);
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
  assert.match(mainSource, /Official source \+ issue signals/);
  assert.match(mainSource, /scoreLabel = rating\.votes \? 'User rating' : 'Safety score'/);
  assert.match(mainSource, /ratingSource = rating\.votes \? 'Live community' : 'PatchTicker'/);
  assert.match(mainSource, /updateDateLabel\(u\)/);
  assert.match(mainSource, /id="dash-coverage-pulse"/);
  assert.match(mainSource, /No demo records shown/);
  assert.match(mainSource, /verified update[\s\S]*?platform/);
  assert.match(mainSource, /lanes checked in 24h/);
  assert.match(mainSource, /All live lanes on schedule/);
  assert.match(cssSource, /\.freshness-signal--fresh\s*\{[^}]*var\(--green-primary\)/s);
  assert.match(cssSource, /\.freshness-signal--stale\s*\{[^}]*var\(--red\)/s);
  assert.match(cssSource, /\.freshness-signal--archive\s*\{[^}]*var\(--purple\)/s);
  assert.match(cssSource, /\.dash-coverage-pulse\s*\{[^}]*border-radius:\s*999px/s);
  assert.match(cssSource, /\.dash-coverage-pulse\.is-degraded\s*\{[^}]*var\(--yellow\)/s);
});

test('source-depth labels distinguish full notes from version-only verification', () => {
  assert.match(mainSource, /function analysisMethodMeta\(update\)/);
  assert.match(mainSource, /Build verified · notes limited/);
  assert.match(mainSource, /Package verified · notes limited/);
  assert.match(mainSource, /Official security advisory/);
  assert.match(mainSource, /Official release notes/);
  assert.match(mainSource, /class="source-depth-signal source-depth-signal--\$\{H\(methodMeta\.tone\)\}"/);
  assert.match(mainSource, /\$\{H\(detailMethodMeta\.heading\)\}/);
  assert.match(mainSource, /\$\{H\(detailMethodMeta\.note\)\}/);
  assert.match(cssSource, /\.source-depth-signal--limited\s*\{[^}]*var\(--yellow\)/s);
  assert.match(cssSource, /\.detail-section-context\s*\{[^}]*font-family:\s*var\(--font-mono\)/s);
});

test('detail pages distinguish vendor release, first-seen, and recheck timing', () => {
  assert.match(mainSource, /function renderSourceTimeline\(update\)/);
  assert.match(mainSource, /label: 'First tracked'/);
  assert.match(mainSource, /label: 'Last verified'/);
  assert.match(mainSource, /Source timeline/);
  assert.match(cssSource, /\.detail-source-timeline\s*\{[\s\S]*grid-template-columns:\s*repeat\(3/);
  assert.match(cssSource, /@media \(max-width: 560px\)[\s\S]*\.detail-source-timeline\s*\{[\s\S]*grid-template-columns:\s*1fr/);
});

test('feed distinguishes the latest release from archived platform history', () => {
  assert.match(mainSource, /function annotateReleasePositions\(updates = \[\]\)/);
  assert.match(mainSource, /releasePosition: latestByLane/);
  assert.match(mainSource, /function releaseLaneKey\(update\)/);
  assert.match(mainSource, /sourceKind === 'steam-client-news'/);
  assert.match(mainSource, /sourceKind === 'steam-game-news'/);
  assert.match(mainSource, /Earlier release/);
  assert.match(mainSource, /Official source archived/);
  assert.match(cssSource, /\.release-position--previous/);
});

test('empty issue sections distinguish a verified clean list from missing vendor data', () => {
  assert.match(mainSource, /u\.knownIssuesAuthoritative/);
  assert.match(mainSource, /The vendor currently lists no known issues for this release/);
  assert.match(mainSource, /No authoritative known-issue list was available/);
  assert.match(cssSource, /\.detail-list-item--verified\s*\{[^}]*var\(--green-primary\)/s);
});

test('security releases expose bounded CVE context without flooding the detail page', () => {
  assert.match(mainSource, /function securitySignalMeta\(update\)/);
  assert.match(mainSource, /CVE\$\{total === 1 \? '' : 's'\} documented/);
  assert.match(mainSource, /const visibleCves = secCves\.slice\(0, 12\)/);
  assert.match(mainSource, /function decisionPanelFacts\(update, freshness\)/);
  assert.match(mainSource, /Documented CVE/);
  assert.match(mainSource, /more in the official advisory/);
  assert.match(mainSource, /security-signal--\$\{H\(securitySignal\.tone\)\}/);
  assert.match(cssSource, /\.security-signal--critical,[\s\S]*?\.security-signal--high\s*\{[^}]*var\(--red\)/s);
  assert.match(cssSource, /\.detail-cve-more\s*\{[^}]*font-family:\s*var\(--font-mono\)/s);
});

test('score panels expose evidence inputs rather than dead impact placeholders', () => {
  assert.match(mainSource, /Known issue/);
  assert.match(mainSource, /Vendor-known issues/);
  assert.match(mainSource, /Issue coverage/);
  assert.match(mainSource, /Official source/);
  assert.match(mainSource, /What shaped this score/);
  assert.doesNotMatch(mainSource, /Impact pending/);
  assert.match(cssSource, /\.detail-score-method\s*\{/);
  assert.match(cssSource, /\.detail-decision-fact--good strong\s*\{[^}]*var\(--green-score\)/s);
});

test('hardware driver cards expose compact game support, fix, and issue counts', () => {
  assert.match(mainSource, /function driverImpactMeta\(update\)/);
  assert.match(mainSource, /gameSupportCount/);
  assert.match(mainSource, /gameFixCount/);
  assert.match(mainSource, /knownIssueCount/);
  assert.match(mainSource, /driver-impact-signal platform--\$\{H\(pSuffix\)\}/);
  assert.match(cssSource, /\.driver-impact-signal\s*\{[^}]*display:\s*inline-flex;[^}]*border-radius:\s*999px/s);
});

test('Steam game cards explain tracking relevance with verified audience evidence', () => {
  assert.match(mainSource, /function steamAudienceMeta\(update\)/);
  assert.match(mainSource, /averagePlayersSnapshot/);
  assert.match(mainSource, /averagePlayersObservedAt/);
  assert.match(mainSource, /Steam App ID/);
  assert.match(mainSource, /Audience at scan/);
  assert.match(mainSource, /Avg players at scan/);
  assert.match(mainSource, /class="steam-audience-signal"/);
  assert.match(cssSource, /\.steam-audience-signal\s*\{[^}]*min-height:\s*24px;[^}]*var\(--cyan\)/s);
});

test('update details continue into honestly ranked related releases', () => {
  assert.match(mainSource, /function renderRelatedReleaseCard\(update\)/);
  assert.match(mainSource, /'same-product': 'Same product'/);
  assert.match(mainSource, /'same-lane': update\?\.sourceKind === 'steam-game-news' \? 'Steam game lane'/);
  assert.match(mainSource, /More releases for this product/);
  assert.match(mainSource, /More tracked Steam game updates/);
  assert.match(mainSource, /relatedReleases\.map\(renderRelatedReleaseCard\)/);
  assert.match(mainSource, /View \$\{H\(platformLabel\(u\.platform\)\)\} history/);
  assert.match(cssSource, /\.detail-related-grid\s*\{[^}]*repeat\(auto-fit, minmax\(min\(100%, 220px\), 1fr\)\)/s);
  assert.match(cssSource, /\.detail-related-header > a\s*\{[^}]*min-height:\s*44px/s);
});

test('source heartbeat makes per-platform check recency visible and filterable', () => {
  assert.match(mainSource, /id="coverage-heartbeats"/);
  assert.match(mainSource, /function renderSourceHeartbeats\(updates = \[\]\)/);
  assert.match(mainSource, /update\.lastCheckedAt \|\| update\.updatedAt/);
  assert.match(mainSource, /data-source-platform="\$\{H\(platform\)\}"/);
  assert.match(mainSource, /setPlatformFilter\(button\.dataset\.sourcePlatform \|\| ''\)/);
  assert.match(mainSource, /renderSourceHeartbeats\(_allUpdates\)/);
  assert.match(mainSource, /sourceCheckSlaHours/);
  assert.match(mainSource, /lanes within check schedule/);
  assert.match(mainSource, /All live lanes on schedule/);
  assert.match(cssSource, /\.dash-source-heartbeat-track\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(cssSource, /\.dash-source-heartbeat\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px/s);
  assert.match(cssSource, /\.dash-source-heartbeat--fresh > i\s*\{[^}]*var\(--green-primary\)/s);
});

test('offline update feeds remain honest instead of reviving demo records', () => {
  assert.match(mainSource, /function renderOfflineRails[\s\S]*?_allUpdates = \[\][\s\S]*?renderTapeAndLatest\(\[\], message\)/);
  assert.match(mainSource, /Verified patch data will return when the connection recovers/);
  assert.doesNotMatch(mainSource, /typeof getStaticUpdates === 'function'/);
});

test('landing page hydrates from verified updates instead of fabricated ratings', () => {
  assert.match(mainSource, /function hydrateLandingSignals\(\)/);
  assert.match(mainSource, /Promise\.all\(\[fetchUpdates\(\{ sort: 'date_desc' \}\), fetchSummary\(\)\]\)/);
  assert.match(mainSource, /latest\.userRating\?\.totalVotes/);
  assert.match(mainSource, /out of 10 PatchTicker score/);
  assert.match(mainSource, /No sample score is shown while verified source data is unavailable/);
  assert.doesNotMatch(mainSource, /Latest user signal/);
  assert.doesNotMatch(mainSource, /<strong>8\.7<\/strong>/);
  assert.doesNotMatch(mainSource, /Install 72%/);
  assert.match(cssSource, /\.landing-meter--10 span\s*\{\s*width:\s*100%/);
  assert.match(cssSource, /@media \(max-width: 980px\)[\s\S]*?\.landing-copy\s*\{\s*display:\s*contents;[\s\S]*?\.landing-panel\s*\{\s*order:\s*1;[\s\S]*?\.landing-proof\s*\{\s*order:\s*2;/);
});

test('returning visitors receive a truthful live briefing from persisted update history', () => {
  assert.match(mainSource, /UPDATE_VISIT_STORAGE_KEY = 'patchticker\.updates\.lastSeenAt'/);
  assert.match(mainSource, /function updateReturnBrief\(updates = \[\]\)/);
  assert.match(mainSource, /Date\.parse\(update\.createdAt \|\| update\.releasedAt\) > _updateVisitBaseline/);
  assert.match(mainSource, /updateReturnBrief\(_allUpdates\)/);
  assert.match(mainSource, /id="dash-return-headline"/);
  assert.match(cssSource, /\.dash-return-brief\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto auto/s);
  assert.match(cssSource, /\.dash-return-brief\.has-new\s*\{[^}]*var\(--green-primary\)/s);
});

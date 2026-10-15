import test from 'node:test';
import assert from 'node:assert/strict';
import { SETUP_STORAGE_KEY, normalizeSetup, validateSetup, graphicsVendor, assessUpdateForSetup, updatesForSetup, readSavedSetup, saveSetup, clearSavedSetup } from '../src/setupAdvisor.js';
import { renderSetupWorkspace, renderSetupDetail } from '../src/setupView.js';

const profile = (vendor, aliases, systems = ['Windows 11']) => ({ schemaVersion: 1, authoritative: true, vendor, hardware: [{ label: aliases[0], aliases, matchType: 'exact-model' }], operatingSystems: systems, exclusions: [] });
const release = (platform, id, overrides = {}) => ({
  platform, id, name: `${platform} release`, sourceKind: 'official-release-notes', releasedAt: '2026-10-13', score: 8.1,
  sourceUrl: 'https://vendor.example/notes', knownIssues: [],
  evidence: [], ...overrides,
});
const driver = (vendor, model, overrides = {}) => release(vendor, vendor, { evidence: [{ url: 'https://vendor.example/notes', compatibility: profile(vendor, [model]) }], ...overrides });
const pc = { device: 'pc', hardware: 'NVIDIA GeForce RTX 4070', cpu: 'AMD Ryzen 7 7800X3D', operatingSystem: 'windows-11-25h2' };

test('AMD CPU cannot route an NVIDIA graphics setup into the AMD driver lane', () => {
  const results = updatesForSetup([driver('AMD', 'Radeon RX 7800 XT'), driver('NVIDIA', pc.hardware), driver('Intel', 'Intel Arc A770')], pc);
  assert.deepEqual(results.map(item => item.update.platform), ['NVIDIA']);
  assert.equal(results[0].compatibility.status, 'supported');
});
test('AMD and Intel exact graphics identifiers use the matching vendor table', () => {
  for (const [vendor, hardware] of [['AMD', 'Radeon RX 7800 XT'], ['Intel', 'Intel Arc A770']]) {
    const result = updatesForSetup([driver(vendor, hardware)], { ...pc, hardware })[0];
    assert.equal(result.compatibility.status, 'supported');
  }
  assert.equal(graphicsVendor('AMD Ryzen 9 7900X'), null);
  assert.equal(graphicsVendor('7900'), null);
});
test('unknown hardware and missing official tables never become verified by a high source score', () => {
  const result = assessUpdateForSetup(release('AMD', 'amd', { score: 9.9 }), { ...pc, hardware: 'Radeon RX 7800 XT' });
  assert.equal(result.compatibility.status, 'unverified');
  assert.equal(result.tone, 'unverified');
  assert.equal(result.title, 'Check the release notes');
});
test('source score and compatibility result remain separate when a supported package has risks', () => {
  const result = assessUpdateForSetup(driver('Intel', 'Intel Arc A770', { score: 4.5 }), { ...pc, hardware: 'Intel Arc A770' });
  assert.equal(result.compatibility.status, 'supported');
  assert.equal(result.sourceScore, 4.5);
  assert.equal(result.tone, 'caution');
  assert.match(result.title, /risks/);
});
test('unsupported Windows version or GPU cannot inherit a favorable assessment', () => {
  const update = driver('NVIDIA', pc.hardware);
  const oldGpu = assessUpdateForSetup(update, { ...pc, hardware: 'GeForce GTX 750' });
  assert.equal(oldGpu.compatibility.status, 'unsupported');
  assert.equal(oldGpu.tone, 'unsupported');
  const linux = assessUpdateForSetup(update, { ...pc, operatingSystem: 'other' });
  assert.equal(linux.compatibility.status, 'unsupported');
});
test('CPU-specific issue flags require the full entered identifier in the issue text', () => {
  const update = driver('NVIDIA', pc.hardware, { knownIssues: ['AMD systems may stutter.', 'AMD Ryzen 7 7800X3D systems can freeze in this mode.'] });
  const result = assessUpdateForSetup(update, pc);
  assert.deepEqual(result.matchedIssues, ['AMD Ryzen 7 7800X3D systems can freeze in this mode.']);
  assert.match(result.title, /names your hardware/);
});
test('a sparse issue list never implies the vendor confirmed there are no bugs', () => {
  assert.equal(assessUpdateForSetup(driver('NVIDIA', pc.hardware), pc).issueSummary, 'No complete known-issue list supplied');
  assert.equal(assessUpdateForSetup(driver('NVIDIA', pc.hardware, { knownIssuesAuthoritative: true }), pc).issueSummary, 'Vendor lists no known issues');
});
test('invalid and missing source scores are omitted without changing hardware verification', () => {
  for (const score of [null, NaN, 11, -1, Infinity, '8.1']) {
    const result = assessUpdateForSetup(driver('NVIDIA', pc.hardware, { score }), pc);
    assert.equal(result.sourceScore, null);
    assert.equal(result.compatibility.status, 'supported');
  }
});
test('Windows release suggestions respect the entered OS servicing release', () => {
  const rows = [release('Windows', '26h1', { name: 'Windows 11 26H1 KB2' }), release('Windows', '25h2', { name: 'Windows 11 24H2/25H2/26H2 KB1' }), release('Windows', '10', { name: 'Windows 10 KB3' })];
  assert.deepEqual(updatesForSetup(rows, pc).map(item => item.update.id), ['25h2']);
});
test('each product has one current release and selection follows release time', () => {
  const rows = [driver('NVIDIA', pc.hardware, { id: 'old', releasedAt: '2026-10-01' }), driver('NVIDIA', pc.hardware, { id: 'new', releasedAt: '2026-10-13' })];
  assert.deepEqual(updatesForSetup(rows, pc).map(item => item.update.id), ['new']);
});
test('Switch 2 and Steam Deck never inherit another console or generic game driver', () => {
  const rows = [release('Switch', 'switch'), release('Switch2', 'switch2'), driver('AMD', 'Radeon RX 7800 XT'), release('Steam', 'game', { sourceKind: 'steam-game-news' }), release('Steam', 'deck', { sourceKind: 'steamos-news' })];
  assert.deepEqual(updatesForSetup(rows, { device: 'switch2' }).map(item => item.update.id), ['switch2']);
  assert.deepEqual(updatesForSetup(rows, { device: 'deck' }).map(item => item.update.id), ['deck']);
});
test('Mac uses the Apple hardware list while CPU alone does not verify a Mac model', () => {
  const update = release('macOS', 'macos', { evidence: [{ compatibility: profile('Apple', ['MacBook Pro M4'], ['macOS 27']) }] });
  assert.equal(updatesForSetup([update], { device: 'mac', hardware: 'MacBook Pro M4' })[0].compatibility.status, 'supported');
  assert.equal(assessUpdateForSetup(update, { device: 'mac', hardware: 'M4' }).compatibility.status, 'unverified');
});
test('input and persisted state are bounded and malformed storage fails safely', () => {
  assert.equal(normalizeSetup({ hardware: 'x'.repeat(500) }).hardware.length, 120);
  assert.ok(validateSetup({ device: 'pc' }));
  assert.equal(validateSetup({ device: 'ps5' }), '');
  assert.equal(readSavedSetup({ getItem: () => '{invalid' }, null), null);
  assert.equal(readSavedSetup({ getItem: () => JSON.stringify({ version: 1, device: 'pc' }) }, null), null);
});
test('remembering a setup is optional and clearing it removes both copies', () => {
  const makeStore = () => { const data = new Map(); return { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }; };
  const session = makeStore(), local = makeStore();
  saveSetup(pc, false, session, local);
  assert.equal(local.getItem(SETUP_STORAGE_KEY), undefined);
  assert.equal(readSavedSetup(session, local).hardware, pc.hardware);
  saveSetup(pc, true, session, local);
  assert.equal(readSavedSetup(null, local).hardware, pc.hardware);
  clearSavedSetup(session, local);
  assert.equal(readSavedSetup(session, local), null);
  assert.equal(saveSetup(pc, true, { setItem: () => { throw Error('blocked'); } }, null), false);
});

test('remembered hardware is escaped in both the form and update detail context', () => {
  const originalWindow = globalThis.window;
  globalThis.window = { sessionStorage: { getItem: () => JSON.stringify({ ...pc, version: 1, hardware: '<img src=x onerror=alert(1)>' }) }, localStorage: { getItem: () => null } };
  try {
    for (const html of [renderSetupWorkspace(), renderSetupDetail(release('NVIDIA', 'nvidia'))]) {
      assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
      assert.doesNotMatch(html, /<img src=x/);
    }
  } finally { globalThis.window = originalWindow; }
});

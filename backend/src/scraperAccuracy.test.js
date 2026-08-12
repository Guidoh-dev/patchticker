'use strict';

jest.mock('./utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { __test } = require('./services/scraperService');

describe('scraper accuracy guards', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-11T12:00:00Z'));
  });

  afterEach(() => jest.useRealTimers());

  test('Nintendo parser uses the official release date and release-note bullets', () => {
    const parsed = __test.parseSwitchReleasePage(`
      <section class="update-versions">
        <h3>Ver. 22.5.0 (Released June 15, 2026)</h3>
        <ul>
          <li>The Nintendo eShop layout has been redesigned.</li>
          <li>General system stability improvements.</li>
        </ul>
        <h3>Ver. 22.4.0 (Released May 1, 2026)</h3>
      </section>
    `);

    expect(parsed).toMatchObject({ version: '22.5.0', releasedAt: '2026-06-15' });
    expect(parsed.changelog).toEqual([
      'The Nintendo eShop layout has been redesigned.',
      'General system stability improvements.',
    ]);
  });

  test('PS5 parser fingerprints the official system package instead of the CMS revision', () => {
    const parsed = __test.parsePs5SupportPage(`
      <input name="lastcodedeployed-releaseversion" value=" - Release Version: 2026.807" />
      <a href="https://pc.ps5.update.playstation.net/update/ps5/official/token/image/2026_0717/sys_767a94eac034d33907a6ff57af05bc30ce057258ad1cf4b5ffb75d5e21112561/PS5UPDATE.PUP">Reinstall</a>
    `);

    expect(parsed).toEqual({
      artifactUrl: 'https://pc.ps5.update.playstation.net/update/ps5/official/token/image/2026_0717/sys_767a94eac034d33907a6ff57af05bc30ce057258ad1cf4b5ffb75d5e21112561/PS5UPDATE.PUP',
      artifactHash: '767a94eac034d33907a6ff57af05bc30ce057258ad1cf4b5ffb75d5e21112561',
      artifactBuildDate: '2026-07-17',
    });
    expect(JSON.stringify(parsed)).not.toContain('2026.807');
  });

  test('GOG parser uses the official installer version and artifact timestamp', () => {
    const parsed = __test.parseGogRemoteConfig({
      content: {
        windows: {
          version: '2.1.8.30',
          downloadLink: 'https://content-system.gog.com/open/galaxy/client/setup_galaxy_2.1.8.30.exe',
        },
        osx: { version: '2.1.8.32' },
      },
    }, 'Thu, 06 Aug 2026 08:00:58 GMT');

    expect(parsed).toEqual({
      version: '2.1.8.30',
      releasedAt: '2026-08-06',
      windowsDownloadUrl: 'https://content-system.gog.com/open/galaxy/client/setup_galaxy_2.1.8.30.exe',
      macVersion: '2.1.8.32',
    });
  });

  test('GOG parser fails closed without an official artifact timestamp', () => {
    expect(__test.parseGogRemoteConfig({
      content: {
        windows: {
          version: '2.1.8.30',
          downloadLink: 'https://content-system.gog.com/setup.exe',
        },
      },
    }, null)).toBeNull();
  });

  test('Battle.net parser validates the public build from the official version manifest', () => {
    const parsed = __test.parseBattleNetVersionManifest(`
      Region!STRING:0|BuildConfig!HEX:16|CDNConfig!HEX:16|KeyRing!HEX:16|BuildId!DEC:4|VersionsName!String:0|ProductConfig!HEX:16
      ## seqn = 3924930
      us|83e89bb98a1199169f122cd72478cd6b|551bcec947d3c1bce0f791e7d3e0e694||17651|2.52.8.17651|c9dc6de3a629d80327fc6e96256dd19e
      beta|6578af32081bac804e0cf83a96559919|551bcec947d3c1bce0f791e7d3e0e694||17652|2.52.8.17652|c9dc6de3a629d80327fc6e96256dd19e
    `);

    expect(parsed).toEqual({
      region: 'us',
      buildConfig: '83e89bb98a1199169f122cd72478cd6b',
      cdnConfig: '551bcec947d3c1bce0f791e7d3e0e694',
      buildId: '17651',
      version: '2.52.8.17651',
      productConfig: 'c9dc6de3a629d80327fc6e96256dd19e',
    });
  });

  test('Battle.net HTTPS config independently reconstructs the manifest version', () => {
    expect(__test.parseBattleNetBuildConfig(`
      # Build Configuration
      build-num = 17651
      build-name = 17651_release_2.52.8
      build-branch = release_2.52.8
      build-attributes = public
    `)).toEqual({
      buildId: '17651',
      buildName: '17651_release_2.52.8',
      branch: 'release_2.52.8',
      version: '2.52.8.17651',
    });
  });

  test('Battle.net manifest parser rejects a version/build mismatch', () => {
    expect(__test.parseBattleNetVersionManifest(
      'us|83e89bb98a1199169f122cd72478cd6b|551bcec947d3c1bce0f791e7d3e0e694||17651|2.52.8.99999|c9dc6de3a629d80327fc6e96256dd19e'
    )).toBeNull();
  });

  test('Discord index parser selects the newest official Patch Notes article by date', () => {
    expect(__test.parseDiscordPatchIndex(`
      <a aria-label="Discord Patch Notes: July 7, 2026" href="/blog/discord-patch-notes-july-7-2026">July</a>
      <a aria-label="Discord Patch Notes: August 4, 2026" href="/blog/discord-patch-notes-august-4-2026">August</a>
      <a aria-label="Unrelated Discord news" href="/blog/product-news">News</a>
    `)).toEqual({
      title: 'Discord Patch Notes: August 4, 2026',
      releasedAt: '2026-08-04',
      url: 'https://discord.com/blog/discord-patch-notes-august-4-2026',
    });
  });

  test('Discord article parser extracts dated client fixes instead of service incidents', () => {
    const parsed = __test.parseDiscordPatchPage(`
      <section class="article_content new">
        <h1>Discord Patch Notes: August 4, 2026</h1>
        <article class="article_rich-text-2">
          <h2>Highlights</h2>
          <ul><li>We upgraded our Desktop client to Electron 42 and improved CPU usage.</li></ul>
        </article>
        <article class="article_rich-text-2">
          <h2>Audio/Video</h2><h3>Desktop</h3>
          <ul>
            <li>Fixed an issue on Desktop where users were not rejoined after updating the client.</li>
            <li>Resolved a mobile spacing issue.</li>
          </ul>
        </article>
      </section>
    `);

    expect(parsed).toMatchObject({
      title: 'Discord Patch Notes: August 4, 2026',
      version: '2026.08.04',
      releasedAt: '2026-08-04',
    });
    expect(parsed.changelog).toEqual(expect.arrayContaining([
      'We upgraded our Desktop client to Electron 42 and improved CPU usage.',
      'Audio/Video: Fixed an issue on Desktop where users were not rejoined after updating the client.',
    ]));
    expect(parsed.changelog.join(' ')).not.toMatch(/incident|monitoring|resolved service/i);
  });

  test('Apple advisory parser ranks concrete impacts and preserves the full CVE count', () => {
    const parsed = __test.parseAppleSecurityAdvisory(`
      <div id="sections">
        <h1>About the security content of iOS 26.6 and iPadOS 26.6</h1>
        <h2>About Apple security updates</h2>
        <h2>iOS 26.6 and iPadOS 26.6</h2>
        <p>Released July 27, 2026</p>
        <h3>Accessibility</h3>
        <p>Available for: iPhone 11 and later</p>
        <p>Impact: An attacker with physical access may be able to access sensitive user data</p>
        <p>Description: This issue was addressed through improved state management.</p>
        <p>CVE-2026-64732: Researcher</p>
        <h3>WebKit</h3>
        <p>Available for: iPhone 11 and later</p>
        <p>Impact: Processing maliciously crafted web content may lead to arbitrary code execution</p>
        <p>Description: A memory corruption issue was addressed with improved validation.</p>
        <p>CVE-2026-65001: Researcher A</p>
        <p>CVE-2026-65002: Researcher B</p>
      </div>
    `);

    expect(parsed).toMatchObject({
      product: 'iOS 26.6 and iPadOS 26.6',
      releasedAt: '2026-07-27',
      securityCriticality: {
        level: 'high',
        totalCves: 3,
        activelyExploited: false,
      },
    });
    expect(parsed.securityCriticality.cves).toEqual([
      'CVE-2026-64732',
      'CVE-2026-65001',
      'CVE-2026-65002',
    ]);
    expect(parsed.changelog[0]).toMatch(/^WebKit:.*arbitrary code execution.*CVE-2026-65001/);
  });

  test('Apple advisory parser raises actively exploited releases above routine security updates', () => {
    const parsed = __test.parseAppleSecurityAdvisory(`
      <div id="sections">
        <h1>About the security content of macOS Tahoe 26.6.2</h1>
        <h2>macOS Tahoe 26.6.2</h2>
        <p>Released August 10, 2026</p>
        <h3>WebKit</h3>
        <p>Available for: macOS Tahoe</p>
        <p>Impact: Processing malicious web content may lead to arbitrary code execution</p>
        <p>Description: Apple is aware of a report that this issue may have been actively exploited.</p>
        <p>CVE-2026-65555: Researcher</p>
      </div>
    `);

    expect(parsed.securityCriticality).toMatchObject({
      level: 'critical',
      totalCves: 1,
      activelyExploited: true,
    });
  });

  test('Steam parser separates known issues from release changes', () => {
    const parsed = __test.parseSteamReleaseNotes(`
      <p>This update is for the SteamOS Beta and Preview channels.</p>
      <p><b>Known Issues - Beta</b></p>
      <ul><li>Performance may degrade when composition is required.</li></ul>
      <p><b>General</b></p>
      <ul>
        <li>Fixed slow Wi-Fi connections.</li>
        <li>Added controller support.</li>
      </ul>
    `);

    expect(parsed.knownIssues).toEqual(['Performance may degrade when composition is required.']);
    expect(parsed.changelog).toEqual([
      'This update is for the SteamOS Beta and Preview channels.',
      'General: Fixed slow Wi-Fi connections.',
      'General: Added controller support.',
    ]);
  });

  test('Xbox parser reads the newest worldwide OS release from structured support content', () => {
    const parsed = __test.parseXboxContentApi({
      ContentList: [{
        ContentItem: {
          SectionList: [{
            Heading: 'Release date: 7/15/2026',
            SectionItems: [{
              Heading: 'OS version: 10.0.26100.8866 (xb_flt_2607ge.260630-2200)',
              SectionItems: [
                { Heading: 'Library customization', SectionItems: [{ HtmlContent: 'Added richer library artwork.' }] },
                { Heading: 'Bug Fixes', SectionItems: [{ HtmlContent: 'Fixed a crash while installing updates.' }] },
              ],
            }],
          }],
        },
      }],
    });

    expect(parsed).toEqual({
      version: '10.0.26100.8866',
      releasedAt: '2026-07-15',
      changelog: [
        'Bug Fixes: Fixed a crash while installing updates.',
        'Library customization: Added richer library artwork.',
      ],
      knownIssues: [],
    });
  });

  test('encoded vendor notes are decoded before display', () => {
    expect(__test.safeDecode('Game+Ready+for+Halo%3A+Campaign+Evolved')).toBe('Game Ready for Halo: Campaign Evolved');
  });

  test('detectors fail closed without a source date or official HTTPS source', () => {
    const base = { name: 'Vendor Update 1.2.3', version: '1.2.3', sourceUrl: 'https://vendor.example/release' };
    expect(() => __test.validateDetectedUpdate('Vendor', base)).toThrow('no trustworthy release/source date');
    expect(() => __test.validateDetectedUpdate('Vendor', { ...base, releasedAt: '2026-08-10', sourceUrl: '' })).toThrow('no trustworthy HTTPS source');
    expect(() => __test.validateDetectedUpdate('Vendor', { ...base, releasedAt: '2026-08-20' })).toThrow('future-dated release');
  });
});

'use strict';

jest.mock('./utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { __test } = require('./services/scraperService');
const cheerio = require('cheerio');

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

  test('Nintendo security index parser captures only a dated official advisory asset', () => {
    expect(__test.parseNintendoSecurityNoticeIndex(`
      <ul><li class="section-news-listitem">
        <div class="section-news-date">2026.9.10</div>
        <div class="section-news-text"><a href="../assets/pdf/20260910e.pdf">Potential console information leak</a></div>
      </li></ul>
    `)).toEqual({
      title: 'Potential console information leak',
      date: '2026-09-10',
      url: 'https://www.nintendo.com/security-advisories/assets/pdf/20260910e.pdf',
    });
  });

  test('Microsoft KB classification distinguishes security releases from unclassified previews', () => {
    expect(__test.microsoftSecurityCriticality(
      'August 11, 2026—KB5121000 (OS Build 28000.2704)',
      'https://support.microsoft.com/en-us/servicing/os/windows-11/2026/08/kb5121000-windows-11-26h1-security-update'
    )).toMatchObject({
      level: 'medium',
      label: expect.stringContaining('Microsoft security update'),
    });
    expect(__test.microsoftSecurityCriticality('July 28, 2026—KB5101681 Preview')).toMatchObject({
      level: 'none',
      label: expect.stringContaining('No security classification published'),
    });
  });

  test('Windows note cleanup removes historical preview titles and false known-issue language', () => {
    expect(__test.normalizeWindowsDetailNotes([
      'This update includes new features and quality improvements that were part of the following update:',
      'July 28, 2026—KB5101681 (OS Build 28000.2608) Preview',
      'August 2026 Security Updates',
      '[Device] This update improves TPM maintenance reporting.',
    ], [
      'Microsoft is not currently aware of any issues with this update.',
    ])).toEqual({
      changelog: [
        'August 2026 Security Updates',
        '[Device] This update improves TPM maintenance reporting.',
      ],
      knownIssues: [],
    });
  });

  test('Windows parser keeps one complete entry per disclosure-style known issue', () => {
    const $ = require('cheerio').load(`
      <h2>Known issues in this update</h2>
      <details>
        <summary>USB audio devices might fail to start</summary>
        <p>&#8203;&#8203; <strong>Symptoms</strong></p>
        <p>After installing KB5124012, some USB Audio Class 1.0 devices might produce no sound.</p>
        <ul><li>No audio output.</li><li>Volume controls remain at zero.</li></ul>
        <p><strong>Next steps</strong></p><p>Microsoft is working on a resolution.</p>
      </details>
      <details>
        <summary>Host folder shares might be unavailable</summary>
        <p><strong>Symptoms</strong></p>
        <p>Linux VM host folders shared using Plan9 might not appear.</p>
      </details>
      <h2>How to get this update</h2>
    `);

    expect(__test.parseWindowsKnownIssues($)).toEqual([
      'USB audio devices might fail to start: After installing KB5124012, some USB Audio Class 1.0 devices might produce no sound. Symptoms: No audio output. Volume controls remain at zero.',
      'Host folder shares might be unavailable: Linux VM host folders shared using Plan9 might not appear.',
    ]);
  });

  test('Windows issue summaries keep bounded text on a complete word', () => {
    const $ = require('cheerio').load(`
      <h2>Known issues in this update</h2>
      <details>
        <summary>Long vendor disclosure</summary>
        <p><strong>Symptoms</strong></p>
        <p>${'Affected devices can lose audio after installation while Microsoft investigates the compatibility regression. '.repeat(12)}</p>
      </details>
      <h2>How to get this update</h2>
    `);
    const [issue] = __test.parseWindowsKnownIssues($);
    expect(issue.length).toBeGreaterThan(300);
    expect(issue.length).toBeLessThanOrEqual(650);
    expect(issue.endsWith('…')).toBe(true);
    expect(issue).not.toMatch(/\s…$/);
    expect(issue).not.toMatch(/regress…$/);
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

  test('Chrome parser admits only the full desktop Stable channel and preserves security severity', () => {
    const parsed = __test.parseChromeStableFeed(`
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <published>2026-09-16T16:09:00-07:00</published>
          <category term="Desktop Update"/><category term="Early Stable Updates"/>
          <title>Early Stable Update for Desktop</title>
          <link rel="alternate" href="http://chromereleases.googleblog.com/2026/09/early-stable.html"/>
          <content type="html">The Stable channel has been updated to 154.0.8037.44/.45.</content>
        </entry>
        <entry>
          <published>2026-09-15T13:13:26-07:00</published>
          <category term="Desktop Update"/><category term="Stable updates"/>
          <title>Stable Channel Update for Desktop</title>
          <link rel="alternate" href="http://chromereleases.googleblog.com/2026/09/stable-channel-update.html"/>
          <content type="html"><![CDATA[
            <p>The Stable channel has been updated to 153.0.8010.47/.48 for Windows and Mac and 153.0.8010.47 for Linux, which will roll out over the coming days/weeks.</p>
            <p>This update includes 3 security fixes.</p>
            <p>Critical CVE-2026-91726: Out of bounds read in WebGL. Reported by Google</p>
            <p>High CVE-2026-91724: Use after free in Input. Reported by Researcher</p>
            <p>Medium CVE-2026-91723: Race condition in WebAppInstalls. Reported by Researcher</p>
          ]]></content>
        </entry>
      </feed>
    `);

    expect(parsed).toMatchObject({
      platform: 'Chrome',
      name: 'Google Chrome Stable 153.0.8010.47/.48',
      version: '153.0.8010.48',
      releasedAt: '2026-09-15',
      sourceUrl: 'https://chromereleases.googleblog.com/2026/09/stable-channel-update.html',
      securityCriticality: {
        level: 'critical',
        totalCves: 3,
        cves: ['CVE-2026-91726', 'CVE-2026-91724', 'CVE-2026-91723'],
      },
    });
    expect(parsed.reasoning).toMatch(/3 security fixes.*1 critical.*1 high.*1 medium/i);
    expect(parsed.riskFactors[0].text).toMatch(/rolling.*days and weeks/i);
    expect(parsed.name).not.toContain('154.0');
  });

  test('Firefox parser requires matching Release notes and advisory while preserving CVE severity', () => {
    const releaseHtml = `
      <span class="c-release-version">156.0</span>
      <p class="c-release-date">September 15, 2026</p>
      <div class="c-release-first-title">Version 156.0, first offered to Release channel users on September 15, 2026</div>
      <section class="c-release-notes">
        <div id="new"><li class="release-note"><div class="release-note-content">Added a startup preference on macOS.</div></li></div>
        <div id="fixed">
          <li class="release-note"><div class="release-note-content">Fixed DNS over HTTPS site loading.</div></li>
          <li class="release-note"><div class="release-note-content">Various <a href="https://www.mozilla.org/security/advisories/mfsa2026-90/">security fixes</a>.</div></li>
        </div>
        <div id="changed"><li class="release-note"><div class="release-note-content">The PDF viewer starts faster.</div></li></div>
      </section>`;
    const advisoryHtml = `
      <div class="advisory">
        <h2>Security Vulnerabilities fixed in Firefox 156</h2>
        <dl class="summary">
          <dt>Announced</dt><dd>September 15, 2026</dd>
          <dt>Impact</dt><dd><span class="level high">high</span></dd>
          <dt>Products</dt><dd>Firefox</dd>
          <dt>Fixed in</dt><dd>Firefox 156</dd>
        </dl>
        <section class="cve"><h4>#CVE-2026-92005: Use-after-free in Web Codecs</h4><span class="level high">high</span></section>
        <section class="cve"><h4>#CVE-2026-92039: Mitigation bypass in Notifications</h4><span class="level moderate">moderate</span></section>
        <section class="cve"><h4>#CVE-2026-92060: Boundary issue in Internationalization</h4><span class="level low">low</span></section>
      </div>`;
    const parsed = __test.parseFirefoxStableRelease(
      { LATEST_FIREFOX_VERSION: '156.0', LAST_RELEASE_DATE: '2026-09-15' },
      releaseHtml,
      advisoryHtml,
      {
        versionsUrl: 'https://product-details.mozilla.org/1.0/firefox_versions.json',
        releaseUrl: 'https://www.firefox.com/en-US/firefox/156.0/releasenotes/',
        advisoryUrl: 'https://www.mozilla.org/security/advisories/mfsa2026-90/',
      }
    );

    expect(parsed).toMatchObject({
      platform: 'Firefox',
      name: 'Mozilla Firefox 156.0',
      version: '156.0',
      releasedAt: '2026-09-15',
      securityCriticality: {
        level: 'high',
        totalCves: 3,
        cves: ['CVE-2026-92005', 'CVE-2026-92039', 'CVE-2026-92060'],
        activelyExploited: false,
      },
    });
    expect(parsed.reasoning).toMatch(/3 CVEs \(1 high, 1 medium, 1 low\)/i);
    expect(parsed.changelog.join(' ')).toMatch(/startup preference.*DNS over HTTPS.*PDF viewer/i);
    expect(parsed.evidence).toHaveLength(3);

    expect(__test.parseFirefoxStableRelease(
      { LATEST_FIREFOX_VERSION: '157.0b2', LAST_RELEASE_DATE: '2026-09-15' },
      releaseHtml,
      advisoryHtml,
      { releaseUrl: 'https://www.firefox.com/en-US/firefox/157.0b2/releasenotes/' }
    )).toBeNull();
    expect(__test.parseFirefoxStableRelease(
      { LATEST_FIREFOX_VERSION: '156.0', LAST_RELEASE_DATE: '2026-09-16' },
      releaseHtml,
      advisoryHtml,
      {
        releaseUrl: 'https://www.firefox.com/en-US/firefox/156.0/releasenotes/',
        advisoryUrl: 'https://www.mozilla.org/security/advisories/mfsa2026-90/',
      }
    )).toBeNull();
  });

  test('Edge parser selects desktop Stable and keeps newer pending security work visible', () => {
    const stableHtml = `
      <div class="content">
        <h2>Version 152.0.4191.77: September 10, 2026 (Extended Stable) - Update 3</h2>
        <h3>Release Summary</h3><table><tbody><tr><td>Fixes</td><td>Extended release fixes.</td></tr></tbody></table>
        <h2>Version 153.0.4234.32: September 10, 2026 (Stable) - Main Release</h2>
        <h3>Release Summary</h3>
        <table><tbody>
          <tr><td>Feature Updates</td><td>Tracking prevention and WebView2 changes.</td></tr>
          <tr><td>Policy Updates</td><td>New and updated policies in Microsoft Edge.</td></tr>
          <tr><td>Security</td><td>Stable security updates are listed separately.</td></tr>
        </tbody></table>
        <h3>Announcement</h3><ul><li>Deprecating the unload event for web pages.</li></ul>
        <h3>Feature updates</h3><ul><li>Tracking prevention is now consistent in InPrivate windows.</li><li>WebView2 rollback supports four versions.</li></ul>
      </div>`;
    const securityHtml = `
      <div class="content">
        <h2>September 15, 2026</h2><p>Microsoft is aware of the recent Chromium security fixes. We are actively working on releasing a security fix.</p>
        <h2>September 14, 2026</h2><p>Microsoft released Microsoft Edge for Android and iOS (Version 153.0.4234.32).</p>
        <h2>September 10, 2026</h2>
        <p>Microsoft released the latest <strong>Microsoft Edge for Stable (Version 153.0.4234.32)</strong> which incorporates the latest Security Updates of the Chromium project.</p>
        <p><strong>Note:</strong> CVE's will be added as soon as available</p>
      </div>`;
    const parsed = __test.parseEdgeStableRelease(stableHtml, securityHtml, {
      stableUrl: 'https://learn.microsoft.com/en-us/deployedge/microsoft-edge-relnote-stable-channel',
      securityUrl: 'https://learn.microsoft.com/en-us/deployedge/microsoft-edge-relnotes-security',
    });

    expect(parsed).toMatchObject({
      platform: 'Edge',
      name: 'Microsoft Edge Stable 153.0.4234.32',
      version: '153.0.4234.32',
      releasedAt: '2026-09-10',
      securityCriticality: {
        level: 'medium',
        cves: [],
        totalCves: 0,
        pendingVendorFix: true,
      },
    });
    expect(parsed.knownIssues[0]).toMatch(/2026-09-15.*newer Chromium security fixes.*preparing/i);
    expect(parsed.verdict).toMatch(/install.*if you are behind.*automatic updates.*pending/i);
    expect(parsed.changelog.join(' ')).toMatch(/Policy Updates.*Deprecating the unload.*Tracking prevention/i);
    expect(parsed.changelog.join(' ')).not.toMatch(/Extended release fixes/i);
    expect(parsed.evidence).toHaveLength(2);

    expect(__test.parseEdgeStableRelease(stableHtml, securityHtml, {
      stableUrl: 'https://evil.example/edge',
      securityUrl: 'https://learn.microsoft.com/en-us/deployedge/microsoft-edge-relnotes-security',
    })).toBeNull();
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

  test('Apple index parser preserves an unlinked no-CVE release as a clean identity', () => {
    const rows = __test.parseAppleSecurityIndex(`
      <table><tr>
        <td><p>iOS 26.6.2 and iPadOS 26.6.2</p><div class="note"><p>This update has no published CVE entries.</p></div></td>
        <td><p>iPhone 11 and later</p></td>
        <td><p>08 Sep 2026</p></td>
      </tr></table>
    `);

    expect(rows).toEqual([{
      product: 'iOS 26.6.2 and iPadOS 26.6.2',
      link: '',
      note: 'This update has no published CVE entries.',
      date: '08 Sep 2026',
    }]);
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

  test('Steam client releases use article identity while showing a readable release date', () => {
    expect(__test.steamClientReleaseIdentity(
      'https://store.steampowered.com/news/app/593110/view/687512719325137168',
      'Mon, 03 Aug 2026 22:01:29 +0000',
    )).toEqual({
      version: 'client-687512719325137168',
      displayVersion: '2026.08.03',
      sourceKind: 'steam-client-news',
      sourceRef: 'steam-client:687512719325137168',
      productId: '593110',
    });
  });

  test('Steam Deck detector accepts stable SteamOS releases and rejects beta posts', () => {
    const stable = __test.steamDeckReleaseFromPost({
      gid: '1838407329258215',
      title: 'SteamOS 3.8.16',
      date: Math.floor(new Date('2026-07-17T01:04:09.000Z').getTime() / 1000),
      url: 'https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/1838407329258215',
      contents: "SteamOS 3.8.16 has just been released for all users with the following changes:GeneralReverted a blank-screen regression. The HDR fix will be available in Beta while the root cause is investigated.",
    });

    expect(stable).toMatchObject({
      platform: 'Steam',
      name: 'SteamOS 3.8.16',
      version: '3.8.16',
      sourceKind: 'steamos-news',
      sourceRef: 'steamos:1838407329258215',
      productId: '1675200',
      releasedAt: '2026-07-17',
    });
    expect(stable.affects).toMatch(/Steam Deck \/ SteamOS/);
    expect(stable.changelog).toContain("General: Reverted a blank-screen regression. The HDR fix will be available in Beta while the root cause is investigated.");

    expect(__test.steamDeckReleaseFromPost({
      ...stable,
      gid: '1840310314346837',
      title: 'SteamOS 3.8.25 Beta',
      date: Math.floor(new Date('2026-08-08T04:52:36.000Z').getTime() / 1000),
      url: 'https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/1840310314346837',
      contents: 'Beta channel release.',
    })).toBeNull();
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

  test('NVIDIA parser separates supported games, fixed bugs, and open PDF issues', () => {
    const parsed = __test.parseNvidiaReleaseNotes(`
      <strong>Game Ready for Halo & Gears</strong><br>
      Best experience for games including Halo: Campaign Evolved, Gears of War: E-Day Beta, and Mistfall Hunter.<br>
      <strong>Fixed Gaming Bugs</strong><br><ul>
        <li>Halo: Resolved crashes on RTX 50 Series.</li>
        <li>Path of Exile 2: Fixed long pauses in DX12.</li>
      </ul>
      <strong>Fixed General Bugs</strong><br><ul><li>Paint.NET may crash with Surround enabled.</li></ul>
    `, `
      Release Notes: <a href="https://us.download.nvidia.com/Windows/610.88/610.88-win11-win10-release-notes.pdf">Game Ready Driver Release Notes</a>
    `, `
      3.2 Open Issues in Version 610.88 WHQL
      > Prefer Maximum Performance mode may not be applied correctly [6007998]
      3.3 Issues Not Caused by NVIDIA Drivers
    `);

    expect(parsed).toMatchObject({
      gameSupportCount: 3,
      gameFixCount: 2,
      generalFixCount: 1,
      knownIssueCount: 1,
      releaseNotesUrl: 'https://us.download.nvidia.com/Windows/610.88/610.88-win11-win10-release-notes.pdf',
    });
    expect(__test.nvidiaImpactMetadata({ DownloadURLFileSize: '979.65 MB' }, parsed)).toMatchObject({
      packageSize: '979.65 MB',
      gameSupportCount: 3,
      gameFixCount: 2,
      whql: true,
    });
    expect(parsed.changelog[0]).toContain('Halo: Campaign Evolved');
    expect(parsed.knownIssues).toEqual(['Prefer Maximum Performance mode may not be applied correctly [6007998]']);
  });

  test('NVIDIA compatibility combines aligned desktop and notebook product matrices', () => {
    const compatibility = __test.parseNvidiaCompatibility([{
      Version: '616.92',
      DetailsURL: 'https://www.nvidia.com/en-us/drivers/details/278453/',
      OSList: [{ OSName: 'Windows%2010%2064-bit' }, { OSName: 'Windows%2011' }],
      series: [{
        seriesname: 'GeForce%20RTX%2050%20Series',
        products: [
          { productName: 'NVIDIA%20GeForce%20RTX%205090' },
          { productName: 'NVIDIA%20GeForce%20RTX%205080' },
        ],
      }],
    }, {
      Version: '616.92',
      DetailsURL: 'https://www.nvidia.com/en-us/drivers/details/278454/',
      OSList: [{ OSName: 'Windows%2011' }],
      series: [{
        seriesname: 'GeForce%20RTX%2050%20Series%20(Notebooks)',
        products: [{ productName: 'NVIDIA%20GeForce%20RTX%205090%20Laptop%20GPU' }],
      }],
    }]);

    expect(compatibility).toMatchObject({
      vendor: 'NVIDIA',
      authoritative: true,
      operatingSystems: ['Windows 10 64-bit', 'Windows 11'],
      sourceUrls: [
        'https://www.nvidia.com/en-us/drivers/details/278453/',
        'https://www.nvidia.com/en-us/drivers/details/278454/',
      ],
    });
    expect(compatibility.hardware).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'NVIDIA GeForce RTX 5090', category: 'desktop', aliases: expect.arrayContaining(['rtx 5090']) }),
      expect.objectContaining({ label: 'NVIDIA GeForce RTX 5090 Laptop GPU', category: 'mobile', aliases: expect.arrayContaining(['rtx 5090 laptop gpu']) }),
    ]));
  });

  test('NVIDIA parser recovers game support and general fixes when the dynamic download page omits release highlights', () => {
    const parsed = __test.parseNvidiaReleaseNotes('', '', `
      2.4.1 Game Ready for 007 First Light, Active Matter,
      Aniimo & WARDOGS
      This new Game Ready Driver provides the best gaming experience for the listed games.
      Learn more in our Game Ready Driver article here.
      2.4.1.1 Other Changes
      3.1.1 Fixed Gaming Bugs
      > N/A
      3.1.2 Fixed General Bugs
      > Intermittent flicker may be observed in browsers when navigating to certain websites [6673430]
      > Fixed an issue where virtual displays could not be created after updating [6674464]
      > Remote Desktop sessions may display a black screen after updating [6687328]
      3.2 Open Issues in Version 616.92 WHQL
      > Prefer Maximum Performance mode may not be applied correctly [6007998] RN-08399-616.92_ v01 | 15 Release 615 Driver for Windows
      3.3 Issues Not Caused by NVIDIA Drivers
    `);

    expect(parsed).toMatchObject({
      gameSupportCount: 4,
      gameFixCount: 0,
      generalFixCount: 3,
      knownIssueCount: 1,
      gameTitles: ['007 First Light', 'Active Matter', 'Aniimo', 'WARDOGS'],
    });
    expect(parsed.changelog).toEqual(expect.arrayContaining([
      'Game support — 007 First Light; Active Matter; Aniimo; WARDOGS.',
      expect.stringContaining('General fix — Intermittent flicker'),
      expect.stringContaining('General fix — Fixed an issue where virtual displays'),
    ]));
    expect(parsed.changelog.join(' ')).not.toMatch(/General fix — N\/?A/i);
    expect(parsed.knownIssues).toEqual(['Prefer Maximum Performance mode may not be applied correctly [6007998]']);
  });

  test('AMD driver page discovery selects the newest official Adrenalin notes', () => {
    const parsed = __test.parseAmdDriverPage(`
      <article><a href="/en/resources/support-articles/release-notes/RN-RAD-WIN-26-6-4.html">Release Notes</a></article>
      <article>
        <strong>Revision Number</strong><p>Adrenalin 26.7.1 (WHQL Recommended)</p>
        <strong>File Size</strong><p>849 MB</p>
        <a href="/en/resources/support-articles/release-notes/RN-RAD-WIN-26-7-1.html">Release Notes</a>
        <a href="https://drivers.amd.com/drivers/installer/26.10/whql/amd-software-adrenalin-edition-26.7.1.exe">Download</a>
      </article>
    `, 'https://www.amd.com/en/support/downloads/drivers.html/graphics/radeon-rx-9000.html');

    expect(parsed).toEqual({
      url: 'https://www.amd.com/en/resources/support-articles/release-notes/RN-RAD-WIN-26-7-1.html',
      version: '26.7.1',
      whql: true,
      releaseChannel: 'recommended',
      packageSize: '849 MB',
    });
  });

  test('AMD discovery preserves the vendor Optional channel label', () => {
    const parsed = __test.parseAmdDriverPage(`
      <article>
        <strong>Revision Number</strong><p>Adrenalin 26.9.1 (WHQL Optional)</p>
        <strong>File Size</strong><p>887 MB</p>
        <a href="/en/resources/support-articles/release-notes/RN-RAD-WIN-26-9-1.html">Release Notes</a>
      </article>
    `, 'https://www.amd.com/en/support/downloads/drivers.html/graphics/radeon-rx-9000.html');

    expect(parsed).toEqual({
      url: 'https://www.amd.com/en/resources/support-articles/release-notes/RN-RAD-WIN-26-9-1.html',
      version: '26.9.1',
      whql: true,
      releaseChannel: 'optional',
      packageSize: '887 MB',
    });
  });

  test('AMD release parser separates game support, fixes, and known issues', () => {
    const parsed = __test.parseAmdReleaseNotes(`
      <h1>AMD Software: Adrenalin Edition 26.7.1 Driver Release Notes</h1>
      <p>Last Updated: July 28th, 2026.</p>
      <h2>Highlights</h2>
      <ul>
        <li>New Product Support<ul><li>AMD Radeon RX 9050</li></ul></li>
        <li>New Game Support<ul><li>Gears of War: E-Day Open Beta Early Access</li><li>Out of Control Evolution</li></ul></li>
        <li>Fixed Issues:<ul><li>Directional indicators may fail to render in Fortnite.</li><li>Blender may crash on RX 7000 series products.</li></ul></li>
      </ul>
      <h2>Known Issues</h2>
      <ul><li>Battlefield 6 may experience a driver timeout.</li><li>Smart Access Memory may become disabled after installation.</li></ul>
      <h2>Additional Information</h2>
    `, 'https://www.amd.com/en/resources/support-articles/release-notes/RN-RAD-WIN-26-7-1.html', { whql: true, releaseChannel: 'recommended' });

    expect(parsed).toMatchObject({
      version: '26.7.1',
      releasedAt: '2026-07-28',
      gameSupportCount: 2,
      gameFixCount: 2,
      productSupportCount: 1,
      knownIssueCount: 2,
      whql: true,
      releaseChannel: 'recommended',
    });
    expect(parsed.changelog).toEqual(expect.arrayContaining([
      expect.stringContaining('Gears of War: E-Day Open Beta Early Access'),
      'Fixed — Directional indicators may fail to render in Fortnite.',
    ]));
    expect(parsed.knownIssues).toEqual([
      'Battlefield 6 may experience a driver timeout.',
      'Smart Access Memory may become disabled after installation.',
    ]);
  });

  test('Intel parser deduplicates model-specific fixes and preserves Non-WHQL risk context', () => {
    const parsed = __test.parseIntelReleaseNotes(`
      Date: July 20, 2026
      Driver Version: 32.0.101.8864 Non-WHQL
      Highlights:
      ▪ Beast of Reincarnation*
      ▪ Gears of War: E-Day Open BETA*
      Fixed Issues:
      Intel® Arc™ B-Series Graphics Products:
      ▪ Assassin's Creed Shadows* may crash after a driver upgrade.
      Intel® Arc™ A-Series Graphics Products:
      ▪ Assassin's Creed Shadows* may crash after a driver upgrade.
      Known Issues:
      Intel® Arc™ B-Series Graphics Products:
      ▪ Borderlands 4* may experience an intermittent application crash.
      Intel® Arc™ A-Series Graphics Products:
      ▪ Borderlands 4* may experience an intermittent application crash.
      Intel® Graphics Software Known Issues:
      ▪ Performance graphs may not hide when requested.
      Intel® Graphics Software Performance Tuning (BETA):
    `);

    expect(parsed).toMatchObject({
      version: '32.0.101.8864',
      releasedAt: '2026-07-20',
      whql: false,
      gameSupportCount: 2,
      gameFixCount: 1,
      knownIssueCount: 2,
    });
    expect(parsed.changelog).toEqual(expect.arrayContaining([
      expect.stringContaining("Assassin's Creed Shadows"),
    ]));
    expect(parsed.knownIssues).toEqual(expect.arrayContaining([
      expect.stringMatching(/Borderlands 4.*Arc B-Series, Arc A-Series/),
      'Performance graphs may not hide when requested.',
    ]));
  });

  test('Intel parser stops highlights at known issues when a release has no fixed-issues section', () => {
    const parsed = __test.parseIntelReleaseNotes(`
      Date: September 10, 2026
      Driver Version: 32.0.101.8993 Non-WHQL
      Highlights:
      Intel Game On Driver support for:
      ▪ WARDOGS*
      Known Issues:
      Intel® Core™ Ultra Series 3 Processors:
      ▪ Mafia: The Old Country* may experience an application crash during gameplay.
      ▪ Arena Breakout: Infinite* may experience an application crash during gameplay.
      Intel® Graphics Software Known Issues:
      ▪ Display page may show a blank value.
      Intel® Graphics Software Performance Tuning (BETA):
    `);

    expect(parsed).toMatchObject({
      version: '32.0.101.8993',
      releasedAt: '2026-09-10',
      whql: false,
      gameTitles: ['WARDOGS'],
      gameSupportCount: 1,
      gameFixCount: 0,
      knownIssueCount: 3,
    });
    expect(parsed.changelog).toEqual(['Game support — WARDOGS.']);
    expect(parsed.knownIssues).toEqual(expect.arrayContaining([
      expect.stringMatching(/Mafia: The Old Country.*Core Ultra Series 3/),
      expect.stringMatching(/Arena Breakout: Infinite.*Core Ultra Series 3/),
      'Display page may show a blank value.',
    ]));
  });

  test('Intel source-date conflicts preserve both dates and prefer the explicit release-notes date', () => {
    expect(__test.reconcileIntelReleaseDates('09/02/2026 00:00:00', 'September 10, 2026')).toEqual({
      releasedAt: '2026-09-10',
      catalogDate: '2026-09-02',
      releaseNotesDate: '2026-09-10',
      hasDiscrepancy: true,
      discrepancyDays: 8,
    });
    expect(__test.reconcileIntelReleaseDates('09/02/2026 00:00:00', null)).toEqual({
      releasedAt: '2026-09-02',
      catalogDate: '2026-09-02',
      releaseNotesDate: null,
      hasDiscrepancy: false,
      discrepancyDays: 0,
    });
  });

  test('official Intel and PlayStation artifact metadata preserves vendor package sizes', () => {
    expect(__test.parseIntelPackageSize(`
      <ul><li>Windows 11 Family</li><li>Size: 877.4 MB</li><li>SHA256: abc123</li></ul>
    `)).toBe('877.4 MB');
    expect(__test.artifactSizeBytes({
      'content-range': 'bytes 0-0/1247471104',
      'content-length': '1',
    })).toBe(1247471104);
    expect(__test.artifactSizeBytes({ 'content-length': '20' })).toBeNull();
  });

  test('AMD compatibility parser preserves the official discrete, mobile, OS, and exclusion scope', () => {
    const parsed = __test.parseAmdReleaseNotes(`
      <h1>AMD Software: Adrenalin Edition 26.9.1 Optional Driver Release Notes</h1>
      <p>Last Updated: September 3rd, 2026.</p>
      <h2>Radeon Product Compatibility</h2>
      <table><tr><td>AMD Radeon RX 7900/7800/7700 Series Graphics</td></tr></table>
      <h2>Mobility Radeon Product Compatibility</h2>
      <table><tr><td>AMD Radeon RX 7900M/7800M Series Graphics</td></tr></table>
      <h2>AMD Processors with Radeon Graphics Product Compatibility</h2>
      <table><tr><th>DESKTOP</th><th>MOBILE</th></tr><tr><td>AMD Ryzen Processors with Radeon Graphics</td><td>AMD Ryzen AI Series Processors with Radeon Graphics</td></tr></table>
      <h2>Compatible Operating Systems</h2>
      <ul><li>Windows 11 version 21H2 and later</li><li>Windows 10 64-bit version 21H2 and later</li></ul>
    `, 'https://www.amd.com/en/resources/support-articles/release-notes/RN-RAD-WIN-26-9-1.html');

    expect(parsed.compatibility).toMatchObject({
      vendor: 'AMD',
      authoritative: true,
      operatingSystems: [
        'Windows 11 version 21H2 and later',
        'Windows 10 64-bit version 21H2 and later',
      ],
    });
    expect(parsed.compatibility.hardware).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: expect.stringContaining('RX 7900/7800/7700'), aliases: expect.arrayContaining(['radeon rx 7900', '7900']) }),
      expect.objectContaining({ label: expect.stringContaining('RX 7900M/7800M'), aliases: expect.arrayContaining(['radeon rx 7900m', '7900m']) }),
    ]));
    expect(parsed.compatibility.exclusions.map(item => item.label)).toEqual(expect.arrayContaining([
      'Apple Boot Camp',
      'Handheld gaming devices require an OEM driver',
    ]));
  });

  test('Intel compatibility parser reads exact Arc models and supported Windows releases from the official PDF table', () => {
    const compatibility = __test.parseIntelCompatibility(`
      Operating System Support:
      Microsoft Windows 11 64-bit September 2025 Update (25H2)
      Microsoft Windows 10 64-bit October 2022 Update (22H2)
      Intel Core Ultra Series 3 with built-in Intel Arc GPUs B390, B370 and Intel Graphics (Codename Panther Lake)
      Intel Arc B580, B570 Graphics (Codename Battlemage)
      Intel Arc Pro B50, Pro B60, Pro B65, and Pro B70 GPUs
      Intel Core Ultra with built-in Intel Arc GPUs (Codename Meteor Lake, Lunar Lake, Arrow Lake)
      Intel Arc A770, A750, A580, A380, A310, A770M, A730M Graphics (Codename Alchemist)
      More on Intel Products:
    `);

    expect(compatibility).toMatchObject({
      vendor: 'Intel',
      authoritative: true,
      operatingSystems: expect.arrayContaining([
        expect.stringContaining('Windows 11'),
        expect.stringContaining('Windows 10'),
      ]),
    });
    expect(compatibility.hardware).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Intel Arc B580', aliases: expect.arrayContaining(['arc b580', 'b580']) }),
      expect.objectContaining({ label: 'Intel Arc A770', aliases: expect.arrayContaining(['arc a770', 'a770']) }),
      expect.objectContaining({ label: 'Intel Arc A770M', category: 'mobile' }),
      expect.objectContaining({ label: expect.stringContaining('Core Ultra Series 3'), matchType: 'family' }),
    ]));
  });

  test('Intel download compatibility includes officially listed integrated Arc products omitted from PDF shorthand', () => {
    const $ = cheerio.load(`
      <body>
        <p>Intel Core Ultra processor family (Codename Meteor Lake, Lunar Lake, Arrow Lake-S, Panther Lake)</p>
        <p>Intel Core processor family (Codename Wildcat Lake)</p>
        <a class="dc-page-detailed-other-valid-products-panel__product--fixed">Intel Arc 140V GPU</a>
        <a class="dc-page-detailed-other-valid-products-panel__product--fixed">Intel Arc B580 Graphics</a>
        <a class="dc-page-detailed-other-valid-products-panel__product--fixed">Intel Arc A770 Graphics (16GB)</a>
      </body>
    `);
    const compatibility = __test.parseIntelDownloadCompatibility($);

    expect(compatibility.hardware).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Intel Arc 140V GPU', aliases: expect.arrayContaining(['arc 140v', '140v']) }),
      expect.objectContaining({ label: 'Intel Arc B580 Graphics', aliases: expect.arrayContaining(['arc b580', 'b580']) }),
      expect.objectContaining({ label: expect.stringContaining('Core Ultra'), matchType: 'family' }),
      expect.objectContaining({ label: expect.stringContaining('Wildcat Lake'), matchType: 'family' }),
    ]));
  });

  test('merged compatibility tables collapse duplicate Intel models by official aliases', () => {
    const merged = __test.mergeCompatibilityProfiles({
      schemaVersion: 1,
      vendor: 'Intel',
      authoritative: true,
      hardware: [{
        label: 'Intel Arc A770 Graphics',
        aliases: ['intel arc a770 graphics', 'intel arc a770', 'arc a770', 'a770'],
        matchType: 'exact-model',
      }],
      operatingSystems: ['Windows 11 64-bit versions 21H2 through 25H2'],
      exclusions: [],
    }, {
      schemaVersion: 1,
      vendor: 'Intel',
      authoritative: true,
      hardware: [{
        label: 'Intel Arc A770',
        aliases: ['intel arc a770', 'arc a770', 'a770'],
        matchType: 'exact-model',
      }],
      operatingSystems: ['Windows 10 64-bit version 22H2'],
      exclusions: [],
    });

    expect(merged.hardware).toHaveLength(1);
    expect(merged.hardware[0].label).toBe('Intel Arc A770 Graphics');
    expect(merged.operatingSystems).toEqual(expect.arrayContaining([
      expect.stringContaining('Windows 11'),
      expect.stringContaining('Windows 10'),
    ]));
  });

  test('detectors fail closed without a source date or official HTTPS source', () => {
    const base = { name: 'Vendor Update 1.2.3', version: '1.2.3', sourceUrl: 'https://vendor.example/release' };
    expect(() => __test.validateDetectedUpdate('Vendor', base)).toThrow('no trustworthy release/source date');
    expect(() => __test.validateDetectedUpdate('Vendor', { ...base, releasedAt: '2026-08-10', sourceUrl: '' })).toThrow('no trustworthy HTTPS source');
    expect(() => __test.validateDetectedUpdate('Vendor', { ...base, releasedAt: '2026-08-20' })).toThrow('future-dated release');
  });
});

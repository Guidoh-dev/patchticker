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

  test('PS5 parser reads the embedded official build and source update timestamp', () => {
    const parsed = __test.parsePs5SupportPage(`
      <meta name="publish_date_timestamp" content="1784789508" />
      <input name="lastcodedeployed-releaseversion" value=" - Release Version: 2026.807" />
    `);

    expect(parsed).toEqual({ version: '2026.807', sourceUpdatedAt: '2026-07-23' });
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

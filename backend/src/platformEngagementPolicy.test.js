'use strict';

const { PLATFORMS } = require('./config/platformRegistry');

describe('non-Steam platform engagement boundaries', () => {
  test('every tracked platform is an official top-tier surface with an explicit boundary', () => {
    expect(PLATFORMS.length).toBeGreaterThan(0);
    for (const platform of PLATFORMS) {
      expect(platform.official).toBe(true);
      expect(platform.topTier).toBe(true);
      expect(platform.engagementBoundary).toMatch(/^(?:platform-wide-system|vendor-current-driver-family|official-core-client)$/);
    }
  });
});

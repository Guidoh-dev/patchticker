'use strict';

jest.mock('./config/db', () => ({ isAvailable: jest.fn(() => false), query: jest.fn() }));
jest.mock('./utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const aiAnalysisService = require('./services/aiAnalysisService');

describe('paid AI cost guard', () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;
  const originalEnabled = process.env.ANTHROPIC_ENABLED;

  afterAll(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    if (originalEnabled === undefined) delete process.env.ANTHROPIC_ENABLED;
    else process.env.ANTHROPIC_ENABLED = originalEnabled;
  });

  test('a configured key cannot create spend without explicit opt-in', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-' + 'x'.repeat(80);
    delete process.env.ANTHROPIC_ENABLED;
    expect(aiAnalysisService.isEnabled()).toBe(false);
    process.env.ANTHROPIC_ENABLED = 'false';
    expect(aiAnalysisService.isEnabled()).toBe(false);
    process.env.ANTHROPIC_ENABLED = 'true';
    expect(aiAnalysisService.isEnabled()).toBe(true);
  });
});

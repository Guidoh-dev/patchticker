'use strict';

const mockScheduledJobs = [];
const mockSchedule = jest.fn((expression, handler) => {
  const job = { expression, handler, stop: jest.fn() };
  mockScheduledJobs.push(job);
  return job;
});
const mockRunAll = jest.fn(async () => ({ total: 13, newUpdates: 0 }));
const mockProcessPlatform = jest.fn(async platform => ({ platform, status: 'unchanged' }));

jest.mock('node-cron', () => ({ schedule: mockSchedule }));
jest.mock('./services/pipelineService', () => ({
  runAll: mockRunAll,
  processPlatform: mockProcessPlatform,
}));
jest.mock('./utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const cronService = require('./services/cronService');
const { HIGH_VELOCITY_PLATFORM_KEYS } = require('./config/platformRegistry');

describe('pipeline scheduler', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalStartupSetting = process.env.PIPELINE_SCAN_ON_STARTUP;
  const originalStartupDelay = process.env.PIPELINE_STARTUP_SCAN_DELAY_MS;

  beforeEach(() => {
    jest.useFakeTimers();
    mockScheduledJobs.length = 0;
    mockSchedule.mockClear();
    mockRunAll.mockClear();
    mockProcessPlatform.mockClear();
    process.env.NODE_ENV = 'production';
    process.env.PIPELINE_SCAN_ON_STARTUP = 'true';
    process.env.PIPELINE_STARTUP_SCAN_DELAY_MS = '1000';
  });

  afterEach(() => {
    cronService.stop();
    jest.useRealTimers();
    process.env.NODE_ENV = originalNodeEnv;
    if (originalStartupSetting === undefined) delete process.env.PIPELINE_SCAN_ON_STARTUP;
    else process.env.PIPELINE_SCAN_ON_STARTUP = originalStartupSetting;
    if (originalStartupDelay === undefined) delete process.env.PIPELINE_STARTUP_SCAN_DELAY_MS;
    else process.env.PIPELINE_STARTUP_SCAN_DELAY_MS = originalStartupDelay;
  });

  test('schedules security, high-velocity, full, and startup catch-up scans', async () => {
    cronService.start();

    expect(mockSchedule.mock.calls.map(([expression]) => expression)).toEqual([
      '5 * * * *',
      '25 */2 * * *',
      '15 */6 * * *',
    ]);

    await jest.advanceTimersByTimeAsync(1000);
    expect(mockRunAll).toHaveBeenCalledTimes(1);
    expect(HIGH_VELOCITY_PLATFORM_KEYS).toEqual([
      'NVIDIA', 'AMD', 'Intel', 'Steam', 'Discord', 'BattleNet', 'GOG',
    ]);
  });

  test('stopping the scheduler clears every registered job', () => {
    cronService.start();
    cronService.stop();
    expect(mockScheduledJobs).toHaveLength(3);
    expect(mockScheduledJobs.every(job => job.stop.mock.calls.length === 1)).toBe(true);
  });
});

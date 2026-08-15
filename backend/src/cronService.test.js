'use strict';

const mockScheduledJobs = [];
const mockSchedule = jest.fn((expression, handler) => {
  const job = { expression, handler, stop: jest.fn() };
  mockScheduledJobs.push(job);
  return job;
});
const mockRunAll = jest.fn(async () => ({ total: 13, newUpdates: 0 }));
const mockProcessPlatform = jest.fn(async platform => ({ platform, status: 'unchanged' }));
const mockSteamGameRun = jest.fn(async () => ({ candidates: 81, material: 0, inserted: 0, failed: 0 }));

jest.mock('node-cron', () => ({ schedule: mockSchedule }));
jest.mock('./services/pipelineService', () => ({
  runAll: mockRunAll,
  processPlatform: mockProcessPlatform,
}));
jest.mock('./services/steamGamePipelineService', () => ({ run: mockSteamGameRun }));
jest.mock('./utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const cronService = require('./services/cronService');
const { HIGH_VELOCITY_PLATFORM_KEYS } = require('./config/platformRegistry');

describe('pipeline scheduler', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalStartupSetting = process.env.PIPELINE_SCAN_ON_STARTUP;
  const originalStartupDelay = process.env.PIPELINE_STARTUP_SCAN_DELAY_MS;
  const originalPipelineConcurrency = process.env.PIPELINE_CONCURRENCY;

  beforeEach(() => {
    jest.useFakeTimers();
    mockScheduledJobs.length = 0;
    mockSchedule.mockClear();
    mockRunAll.mockClear();
    mockProcessPlatform.mockClear();
    mockSteamGameRun.mockClear();
    process.env.NODE_ENV = 'production';
    process.env.PIPELINE_SCAN_ON_STARTUP = 'true';
    process.env.PIPELINE_STARTUP_SCAN_DELAY_MS = '1000';
    process.env.PIPELINE_CONCURRENCY = '2';
  });

  afterEach(() => {
    cronService.stop();
    jest.useRealTimers();
    process.env.NODE_ENV = originalNodeEnv;
    if (originalStartupSetting === undefined) delete process.env.PIPELINE_SCAN_ON_STARTUP;
    else process.env.PIPELINE_SCAN_ON_STARTUP = originalStartupSetting;
    if (originalStartupDelay === undefined) delete process.env.PIPELINE_STARTUP_SCAN_DELAY_MS;
    else process.env.PIPELINE_STARTUP_SCAN_DELAY_MS = originalStartupDelay;
    if (originalPipelineConcurrency === undefined) delete process.env.PIPELINE_CONCURRENCY;
    else process.env.PIPELINE_CONCURRENCY = originalPipelineConcurrency;
  });

  test('schedules security, high-velocity, full, and startup catch-up scans', async () => {
    cronService.start();

    expect(mockSchedule.mock.calls.map(([expression]) => expression)).toEqual([
      '5 * * * *',
      '25 */2 * * *',
      '45 */2 * * *',
      '15 */6 * * *',
    ]);

    await jest.advanceTimersByTimeAsync(1000);
    expect(mockRunAll).toHaveBeenCalledTimes(1);
    expect(mockSteamGameRun).toHaveBeenCalledTimes(1);
    expect(HIGH_VELOCITY_PLATFORM_KEYS).toEqual([
      'NVIDIA', 'AMD', 'Intel', 'Steam', 'Discord', 'BattleNet', 'GOG',
    ]);
  });

  test('stopping the scheduler clears every registered job', () => {
    cronService.start();
    cronService.stop();
    expect(mockScheduledJobs).toHaveLength(4);
    expect(mockScheduledJobs.every(job => job.stop.mock.calls.length === 1)).toBe(true);
  });

  test('targeted scans respect the configured concurrency ceiling', async () => {
    let active = 0;
    let peak = 0;
    mockProcessPlatform.mockImplementation(async platform => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return { platform, status: 'unchanged' };
    });

    cronService.start();
    await mockScheduledJobs[1].handler();

    expect(mockProcessPlatform).toHaveBeenCalledTimes(HIGH_VELOCITY_PLATFORM_KEYS.length + 1);
    expect(mockProcessPlatform).toHaveBeenCalledWith('SteamDeck');
    expect(peak).toBe(2);
  });

  test('Steam game candidates run on their own bounded two-hour schedule', async () => {
    cronService.start();
    await mockScheduledJobs[2].handler();
    expect(mockSteamGameRun).toHaveBeenCalledTimes(1);
  });
});

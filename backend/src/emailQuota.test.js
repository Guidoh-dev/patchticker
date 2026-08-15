'use strict';

const mockQuery = jest.fn();
const mockIsAvailable = jest.fn(() => true);

jest.mock('./config/db', () => ({ query: mockQuery, isAvailable: mockIsAvailable }));
jest.mock('./utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const emailService = require('./services/emailService');

describe('daily email provider quota', () => {
  const original = {};

  beforeAll(() => {
    for (const key of ['BREVO_API_KEY', 'EMAIL_DAILY_LIMIT', 'EMAIL_ALERT_DAILY_LIMIT']) original[key] = process.env[key];
  });

  beforeEach(() => {
    process.env.BREVO_API_KEY = 'x'.repeat(40);
    process.env.EMAIL_DAILY_LIMIT = '9999';
    process.env.EMAIL_ALERT_DAILY_LIMIT = '9999';
    mockQuery.mockReset();
    mockIsAvailable.mockReturnValue(true);
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('hard-clamps all email attempts to 300 and patch alerts to 250', () => {
    expect(emailService._test.emailQuotaLimits()).toEqual({ global: 300, alerts: 250 });
  });

  test('reserves quota atomically in PostgreSQL before provider delivery', async () => {
    mockQuery.mockResolvedValue({ rows: [{ allowed: true, global_used: 23, alert_used: 8 }] });
    const result = await emailService._test.reserveDailyEmailQuota('patch_alert');
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('reserve_patchticker_email_quota'), ['patch_alert', 300, 250]);
    expect(result).toMatchObject({ allowed: true, globalUsed: 23, alertUsed: 8 });
  });

  test('blocks provider delivery after the database quota rejects a reservation', async () => {
    mockQuery.mockResolvedValue({ rows: [{ allowed: false, global_used: 250, alert_used: 250 }] });
    await expect(emailService._test.reserveDailyEmailQuota('patch_alert')).rejects.toMatchObject({
      code: 'EMAIL_DAILY_LIMIT_REACHED',
    });
  });

  test('fails closed when the durable quota store is unavailable', async () => {
    mockIsAvailable.mockReturnValue(false);
    await expect(emailService._test.reserveDailyEmailQuota('email_verification')).rejects.toMatchObject({
      code: 'EMAIL_QUOTA_UNAVAILABLE',
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

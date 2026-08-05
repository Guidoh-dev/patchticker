'use strict';

const VALID_KEY = 'b'.repeat(64);

function freshService() {
  jest.resetModules();
  process.env.NODE_ENV = 'test';
  process.env.DB_ENCRYPTION_KEY = VALID_KEY;
  delete process.env.DATABASE_URL;
  process.env.DB_SSL = 'false';
  return require('./services/bugReportService');
}

afterEach(() => {
  delete process.env.DB_ENCRYPTION_KEY;
  delete process.env.DATABASE_URL;
  delete process.env.DB_SSL;
});

describe('bugReportService', () => {
  it('accepts real dynamic update slug IDs, not only platform names', async () => {
    const service = freshService();
    const report = await service.createReport({
      updateId: 'intel-32-0-101-8864',
      severity: 'high',
      description: 'Installer failed after reboot on a normal gaming PC.',
      userAgent: 'jest-agent/1.0',
      userId: '00000000-0000-4000-8000-000000000000',
    });

    expect(report.updateId).toBe('intel-32-0-101-8864');
    expect(report.severity).toBe('high');
    expect(report.description).toBe('Installer failed after reboot on a normal gaming PC.');
  });

  it('rejects malformed update IDs before persistence', async () => {
    const service = freshService();
    await expect(service.createReport({
      updateId: '../intel-32',
      severity: 'low',
      description: 'Bad update id should not persist.',
      userAgent: 'jest-agent/1.0',
    })).rejects.toMatchObject({ status: 400 });
  });
});

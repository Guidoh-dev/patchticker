'use strict';

const express = require('express');
const request = require('supertest');

const mockQuery = jest.fn();
const mockGetUpdateById = jest.fn();

jest.mock('./config/db', () => ({ isAvailable: () => true, query: mockQuery }));
jest.mock('./services/updatesService', () => ({
  getUpdates: jest.fn(), getUpdateById: mockGetUpdateById,
  getSentimentSummary: jest.fn(), getUpdateHistory: jest.fn(), buildFeedMeta: jest.fn(),
}));
jest.mock('./services/aiAnalysisService', () => ({ isEnabled: () => false }));
jest.mock('./services/steamGameEligibilityService', () => ({ refreshSteamGameRoster: jest.fn() }));
jest.mock('./middleware/rateLimiter', () => ({
  ratingsReadLimiter: (_req, _res, next) => next(),
  aiAnalysisLimiter: (_req, _res, next) => next(),
}));
jest.mock('./middleware/requireAuth', () => (req, res, next) => {
  if (req.headers.authorization !== 'Bearer valid') return res.status(401).json({ error: 'Unauthorized' });
  req.user = { id: 'voter-1' };
  next();
});
jest.mock('./utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const router = require('./routes/updates');
const app = express();
app.use('/api/updates', router);

beforeEach(() => {
  mockQuery.mockReset();
  mockGetUpdateById.mockReset().mockResolvedValue({ id: 'steam-test-patch', score: 8.4, status: 'stable' });
  mockQuery.mockImplementation(sql => sql.includes('SELECT vote')
    ? Promise.resolve({ rows: [{ vote: 'wait' }] })
    : Promise.resolve({ rows: [{ total: '1', install_count: '0', wait_count: '1', avoid_count: '0' }] }));
});

test('anonymous detail response remains public but has no personal vote', async () => {
  const response = await request(app).get('/api/updates/steam-test-patch');
  expect(response.status).toBe(200);
  expect(response.body.data.userVote).toBeNull();
  expect(response.body.data.userRating).toMatchObject({ score: 5, totalVotes: 1 });
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.headers.vary).toContain('Authorization');
  expect(mockQuery).toHaveBeenCalledTimes(1);
});

test('signed-in detail response restores only that user’s prior vote', async () => {
  const response = await request(app).get('/api/updates/steam-test-patch').set('Authorization', 'Bearer valid');
  expect(response.status).toBe(200);
  expect(response.body.data.userVote).toBe('wait');
  expect(response.body.data.score).toBe(8.4);
  expect(mockQuery).toHaveBeenCalledWith(
    expect.stringContaining('WHERE update_id = $1 AND user_id = $2'),
    ['steam-test-patch', 'voter-1']
  );
});

test('invalid supplied access token cannot retrieve personal vote', async () => {
  const response = await request(app).get('/api/updates/steam-test-patch').set('Authorization', 'Bearer invalid');
  expect(response.status).toBe(401);
  expect(mockGetUpdateById).not.toHaveBeenCalled();
});

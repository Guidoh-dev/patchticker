'use strict';

const express = require('express');
const request = require('supertest');

const mockQuery = jest.fn();
const mockRequireAuth = jest.fn((req, _res, next) => {
  req.user = { id: 'abcd1234-0000-0000-0000-000000000000', email: 'private@example.com' };
  next();
});

jest.mock('./config/db', () => ({ query: mockQuery }));
jest.mock('./middleware/requireAuth', () => mockRequireAuth);
jest.mock('./utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const feedRouter = require('./routes/feed');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/feed', feedRouter);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockRequireAuth.mockClear();
});

test('recent community posts are public and query only anonymous labels', async () => {
  mockQuery.mockResolvedValueOnce({ rows: [{ id: 'post-1', body: 'Stable here', userLabel: 'Member ABCD' }] });

  const response = await request(makeApp()).get('/api/feed/recent').expect(200);

  expect(mockRequireAuth).not.toHaveBeenCalled();
  expect(response.body).toEqual([{ id: 'post-1', body: 'Stable here', userLabel: 'Member ABCD' }]);
  const sql = mockQuery.mock.calls[0][0];
  expect(sql).toContain('AS "userLabel"');
  expect(sql).not.toMatch(/JOIN\s+users|u\.email/i);
});

test('new posts stay authenticated and never expose the account email', async () => {
  mockQuery.mockResolvedValueOnce({
    rows: [{ id: 'post-2', body: 'Installed cleanly', platform: 'NVIDIA', createdAt: new Date().toISOString() }],
  });

  const response = await request(makeApp())
    .post('/api/feed/post')
    .send({ body: 'Installed cleanly', platform: 'NVIDIA' })
    .expect(201);

  expect(mockRequireAuth).toHaveBeenCalled();
  expect(response.body.userLabel).toBe('Member ABCD');
  expect(response.body).not.toHaveProperty('userEmail');
  expect(JSON.stringify(response.body)).not.toContain('private@example.com');
});

test('live chat uses a short-lived ticket instead of exposing the access JWT in the SSE URL', async () => {
  const app = makeApp();
  const ticketResponse = await request(app)
    .post('/api/feed/stream-ticket')
    .send({})
    .expect(200);

  expect(ticketResponse.body.ticket).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  expect(ticketResponse.body.expiresIn).toBe(60);
  expect(mockRequireAuth).toHaveBeenCalled();
  expect(feedRouter.__test.consumeStreamTicket(ticketResponse.body.ticket)).toEqual(expect.objectContaining({
    userId: 'abcd1234-0000-0000-0000-000000000000',
  }));
  expect(feedRouter.__test.consumeStreamTicket(ticketResponse.body.ticket)).toBeNull();
});

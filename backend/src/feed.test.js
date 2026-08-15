'use strict';

const express = require('express');
const request = require('supertest');

const mockQuery = jest.fn();
const mockRequireAuth = jest.fn((req, _res, next) => {
  req.user = {
    id: 'abcd1234-0000-0000-0000-000000000000',
    email: 'private@example.com',
    emailVerified: true,
  };
  next();
});

jest.mock('./config/db', () => ({ query: mockQuery }));
jest.mock('./middleware/requireAuth', () => mockRequireAuth);
jest.mock('./utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const feedRouter = require('./routes/feed');
const requestGuard = require('./middleware/requestGuard');

function makeApp() {
  const app = express();
  // Match production ordering: the firewall evaluates the ticket query before
  // the feed router. This prevents a route-only test from missing the exact
  // regression that previously returned 400 on Render.
  app.use(requestGuard);
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

test('unverified members cannot write to the public chat', async () => {
  mockRequireAuth.mockImplementationOnce((req, _res, next) => {
    req.user = { id: 'unverified-user', emailVerified: false };
    next();
  });

  await request(makeApp())
    .post('/api/feed/post')
    .send({ body: 'This should not be stored.' })
    .expect(403);

  expect(mockQuery).not.toHaveBeenCalled();
});

test('live chat uses a short-lived ticket instead of exposing the access JWT in the SSE URL', async () => {
  const app = makeApp();
  const ticketResponse = await request(app)
    .post('/api/feed/stream-ticket')
    .send({})
    .expect(200);

  expect(ticketResponse.body.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(ticketResponse.body.ticket.length).toBeLessThanOrEqual(200);
  expect(ticketResponse.body.expiresIn).toBe(60);
  expect(mockRequireAuth).toHaveBeenCalled();
  expect(feedRouter.__test.consumeStreamTicket(ticketResponse.body.ticket)).toEqual(expect.objectContaining({
    userId: 'abcd1234-0000-0000-0000-000000000000',
  }));
  expect(feedRouter.__test.consumeStreamTicket(ticketResponse.body.ticket)).toBeNull();
});

test('production request guard accepts the short SSE ticket and drains legacy JWT clients without abuse strikes', async () => {
  const app = makeApp();
  const ticketResponse = await request(app)
    .post('/api/feed/stream-ticket')
    .send({})
    .expect(200);

  // Consume it first so the stream route terminates with 401. Reaching that
  // route (instead of the guard's 400) proves the opaque ticket fits through
  // the production firewall.
  feedRouter.__test.consumeStreamTicket(ticketResponse.body.ticket);
  await request(app)
    .get(`/api/feed/stream?ticket=${ticketResponse.body.ticket}`)
    .expect(401);

  // A stale first-party tab is allowed through the generic length guard, but
  // the feed route never authenticates it and returns 401. This avoids turning
  // a rolling frontend deployment into an IP auto-blacklist event.
  const legacyJwt = `eyJ${'a'.repeat(180)}.${'b'.repeat(40)}.${'c'.repeat(40)}`;
  await request(app)
    .get(`/api/feed/stream?token=${legacyJwt}`)
    .expect(401);

  const oversizedQuery = 's'.repeat(240);
  await request(app)
    .get(`/api/feed/stream?search=${oversizedQuery}`)
    .expect(400);
  const logger = require('./utils/logger');
  const guardLog = logger.warn.mock.calls.find(([message]) => message.startsWith('requestGuard:'));
  expect(guardLog?.[1]?.url).toBe('/api/feed/stream?[query-redacted]');
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(legacyJwt);
  expect(JSON.stringify(guardLog)).not.toContain(oversizedQuery);
});

test('new verified releases stream as privacy-safe first-party events', () => {
  const client = { write: jest.fn() };
  feedRouter.__test.register('feed-test-user', client);

  expect(feedRouter.__test.publishRelease({
    id: 'nvidia-999-1',
    platform: 'NVIDIA',
    name: 'Game Ready Driver 999.1',
    version: '999.1',
    reasoning: 'Internal text that must not enter the stream.',
  })).toBe(true);

  expect(client.write).toHaveBeenCalledTimes(1);
  const payload = client.write.mock.calls[0][0];
  expect(payload).toContain('"eventType":"release"');
  expect(payload).toContain('"updateId":"nvidia-999-1"');
  expect(payload).toContain('Game Ready Driver 999.1 is now verified.');
  expect(payload).not.toContain('999.1 999.1');
  expect(payload).not.toContain('Internal text');
  feedRouter.__test.unregister('feed-test-user', client);
});

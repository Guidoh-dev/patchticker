'use strict';

const mockRequireAuth = jest.fn();
jest.mock('./middleware/requireAuth', () => mockRequireAuth);
const optionalAuth = require('./middleware/optionalAuth');

beforeEach(() => mockRequireAuth.mockReset());

test('anonymous detail requests remain public', () => {
  const next = jest.fn();
  optionalAuth({ headers: {} }, {}, next);
  expect(next).toHaveBeenCalledTimes(1);
  expect(mockRequireAuth).not.toHaveBeenCalled();
});

test('authenticated detail requests validate the access token and attach identity', () => {
  const req = { headers: { authorization: 'Bearer signed-token' } };
  const res = {};
  const next = jest.fn();
  mockRequireAuth.mockImplementation((request, _response, done) => {
    request.user = { id: 'voter-1' };
    done();
  });
  optionalAuth(req, res, next);
  expect(mockRequireAuth).toHaveBeenCalledWith(req, res, next);
  expect(req.user).toEqual({ id: 'voter-1' });
  expect(next).toHaveBeenCalledTimes(1);
});

test('a supplied invalid token is not silently treated as anonymous', () => {
  const req = { headers: { authorization: 'Bearer invalid' } };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  mockRequireAuth.mockImplementation((_request, response) => response.status(401).json({ error: 'Unauthorized' }));
  optionalAuth(req, res, next);
  expect(res.status).toHaveBeenCalledWith(401);
  expect(next).not.toHaveBeenCalled();
});

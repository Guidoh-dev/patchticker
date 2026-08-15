'use strict';

const crypto = require('node:crypto');

const STREAM_TICKET_TTL_MS = 60_000;
const _clients = new Map();
const _streamTickets = new Map();

function issueStreamTicket(userId) {
  const now = Date.now();
  for (const [ticket, record] of _streamTickets) {
    if (record.expiresAt <= now) {
      _streamTickets.delete(ticket);
    }
  }
  const ticket = crypto.randomBytes(32).toString('base64url');
  _streamTickets.set(ticket, { userId, expiresAt: now + STREAM_TICKET_TTL_MS });
  return ticket;
}

function consumeStreamTicket(ticket) {
  const key = String(ticket || '');
  const record = _streamTickets.get(key);
  _streamTickets.delete(key);
  if (!record || record.expiresAt <= Date.now()) {
    return null;
  }
  return record;
}

function register(userId, res) {
  if (!_clients.has(userId)) {
    _clients.set(userId, new Set());
  }
  _clients.get(userId).add(res);
}

function unregister(userId, res) {
  _clients.get(userId)?.delete(res);
  if (_clients.get(userId)?.size === 0) {
    _clients.delete(userId);
  }
}

function publish(event) {
  if (!event?.id || !event?.body || !event?.createdAt) {
    return false;
  }
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const clientSet of _clients.values()) {
    for (const res of clientSet) {
      try { res.write(payload); } catch { /* disconnected clients are removed by close */ }
    }
  }
  return true;
}

function publishRelease(update) {
  const updateId = String(update?.id || '').trim();
  const name = String(update?.name || '').trim().slice(0, 180);
  if (!/^[a-z0-9-]{1,64}$/.test(updateId) || !name) {
    return false;
  }
  const version = String(update?.displayVersion || update?.version || '').trim().slice(0, 64);
  const versionSuffix = version && !name.toLowerCase().includes(version.toLowerCase())
    ? ` ${version}`
    : '';
  return publish({
    id: `release-${updateId}-${Date.now()}`,
    eventType: 'release',
    updateId,
    platform: String(update?.platform || '').trim() || null,
    userLabel: 'PatchTicker',
    body: `${name}${versionSuffix} is now verified.`,
    createdAt: new Date().toISOString(),
  });
}

module.exports = {
  STREAM_TICKET_TTL_MS,
  issueStreamTicket,
  consumeStreamTicket,
  register,
  unregister,
  publish,
  publishRelease,
};

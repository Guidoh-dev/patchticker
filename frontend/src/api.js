// src/api.js
// ─────────────────────────────────────────────────────────────────────────────
// Centralised API client — auth-aware, token-refreshing, CSRF-protected.
//
// TOKEN MANAGEMENT
//  Access tokens: memory only (never localStorage)
//  Refresh tokens: HTTP-only cookie (server-managed)
//  CSRF: fetched before any state-mutating request
//
// AUTO-REFRESH
//  On 401 from any authenticated endpoint, attempts one token refresh.
//  If refresh fails, dispatches 'auth:expired' event for UI to handle.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = '/api';

let _accessToken = null;
let _csrfToken   = null;
let _refreshing  = null;

export function setAccessToken(token) { _accessToken = token; }
export function getAccessToken()      { return _accessToken; }
export function clearAuth()           { _accessToken = null; _csrfToken = null; }

async function ensureCsrfToken() {
  if (_csrfToken) return _csrfToken;
  const data = await rawRequest('/auth/csrf-token', { method: 'GET' });
  _csrfToken = data.csrfToken;
  return _csrfToken;
}

async function rawRequest(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { const b = await res.json(); msg = b.error || msg; } catch(_) {}
    const err = new Error(msg); err.status = res.status; throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

async function tryRefresh() {
  if (_refreshing) return _refreshing;
  _refreshing = (async () => {
    try {
      const csrf = _csrfToken || (await rawRequest('/auth/csrf-token', { method: 'GET' })).csrfToken;
      _csrfToken = csrf;
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({}),
      });
      if (!res.ok) { clearAuth(); return false; }
      const json = await res.json();
      _accessToken = json.accessToken;
      return true;
    } catch { clearAuth(); return false; }
    finally   { _refreshing = null; }
  })();
  return _refreshing;
}

async function request(path, options = {}) {
  const { skipCsrf = false, skipAuth = false, retry = true, ...fetchOpts } = options;
  const method  = (fetchOpts.method || 'GET').toUpperCase();
  const headers = { 'Content-Type': 'application/json', ...fetchOpts.headers };

  if (!skipAuth && _accessToken)
    headers['Authorization'] = `Bearer ${_accessToken}`;

  if (!skipCsrf && ['POST','PUT','PATCH','DELETE'].includes(method))
    headers['X-CSRF-Token'] = await ensureCsrfToken();

  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include', ...fetchOpts, headers,
  });

  if (res.status === 401 && retry && !skipAuth) {
    const ok = await tryRefresh();
    if (ok) return request(path, { ...options, retry: false });
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new Error('Session expired. Please log in again.');
  }

  if (!res.ok) {
    let msg = `${res.status}`;
    try { const b = await res.json(); msg = b.error || msg; } catch(_) {}
    const err = new Error(msg); err.status = res.status; throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

// ── Auth ──────────────────────────────────────────────────────────────────────
export async function register({ email, password }) {
  const data = await request('/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) });
  _accessToken = data.accessToken; return data;
}
export async function login({ email, password }) {
  const data = await request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  _accessToken = data.accessToken; return data;
}
export async function logout() {
  try { await request('/auth/logout', { method: 'POST', body: JSON.stringify({}) }); }
  finally { clearAuth(); }
}
export async function refreshTokens() { return tryRefresh(); }
export async function getMe()          { return request('/auth/me'); }
export async function verifyEmail(token) {
  return request('/auth/verify-email', { method: 'POST', skipAuth: true, body: JSON.stringify({ token }) });
}
export async function resendVerification() {
  return request('/auth/resend-verification', { method: 'POST', body: JSON.stringify({}) });
}
export async function forgotPassword(email) {
  return request('/auth/forgot-password', { method: 'POST', skipAuth: true, body: JSON.stringify({ email }) });
}
export async function resetPassword({ token, password, confirmPassword }) {
  return request('/auth/reset-password', { method: 'POST', skipAuth: true, body: JSON.stringify({ token, password, confirmPassword }) });
}

// ── Billing ───────────────────────────────────────────────────────────────────
export async function createCheckout(priceId) {
  return request('/billing/checkout', { method: 'POST', body: JSON.stringify({ priceId }) });
}
export async function openBillingPortal() {
  return request('/billing/portal', { method: 'POST', body: JSON.stringify({}) });
}
export async function getBillingStatus() { return request('/billing/status'); }

// ── Updates ───────────────────────────────────────────────────────────────────
export async function fetchUpdates({ platform, status, sort, search } = {}) {
  const params = new URLSearchParams();
  if (platform) params.set('platform', platform);
  if (status)   params.set('status', status);
  if (sort)     params.set('sort', sort);
  if (search)   params.set('search', search);
  const qs = params.toString();
  return request(`/updates${qs ? `?${qs}` : ''}`, { skipAuth: true });
}
// ── Community feed ────────────────────────────────────────────────────────────

export async function fetchRecentPosts() {
  return request('/feed/recent');
}

export async function submitPost({ body, platform }) {
  return request('/feed/post', {
    method: 'POST',
    body: JSON.stringify({ body, platform: platform || undefined }),
  });
}

/**
 * Opens an SSE connection to /api/feed/stream.
 * Returns a function that closes the connection when called.
 *
 * @param {string}   accessToken
 * @param {Function} onMessage   — called with each parsed post object
 * @param {Function} onError     — called on connection error
 */
export function openFeedStream(accessToken, onMessage, onError) {
  // SSE doesn't support custom headers natively — pass token as query param.
  // The backend reads it from ?token= as a fallback for SSE connections.
  const url = `${window.__API_BASE__ || '/api'}/feed/stream?token=${encodeURIComponent(accessToken)}`;
  const es  = new EventSource(url);

  es.onmessage = (e) => {
    try {
      const post = JSON.parse(e.data);
      onMessage(post);
    } catch { /* malformed event — ignore */ }
  };

  es.onerror = (e) => {
    onError?.(e);
  };

  return () => es.close();
}

export async function fetchUpdateById(id) { return request(`/updates/${id}`, { skipAuth: true }); }
export async function fetchSummary()      { return request('/updates/summary', { skipAuth: true }); }

// ── Bug Reports ───────────────────────────────────────────────────────────────
export async function submitBugReport({ updateId, severity, description }) {
  return request('/bug-reports', { method: 'POST', body: JSON.stringify({ updateId, severity, description }) });
}
export async function fetchBugReports(updateId) { return request(`/bug-reports/${updateId}`, { skipAuth: true }); }

// ── Health ────────────────────────────────────────────────────────────────────
export async function fetchHealth() { return request('/health', { skipAuth: true }); }

// ── Account ───────────────────────────────────────────────────────────────────
export async function fetchAccountMe()           { return request('/account/me'); }
export async function changePassword(body)       { return request('/account/password', { method: 'PATCH', body: JSON.stringify(body) }); }

// ── Watchlist (Pro) ───────────────────────────────────────────────────────────
export async function fetchWatchlist()           { return request('/watchlist'); }
export async function upsertWatch(platform, opts) { return request(`/watchlist/${encodeURIComponent(platform)}`, { method: 'PUT', body: JSON.stringify(opts || {}) }); }
export async function removeWatch(platform)      { return request(`/watchlist/${encodeURIComponent(platform)}`, { method: 'DELETE' }); }
export async function fetchWebhookSettings()     { return request('/watchlist/webhooks'); }
export async function upsertWebhookSettings(body){ return request('/watchlist/webhooks', { method: 'PUT', body: JSON.stringify(body) }); }

// ── Ratings ───────────────────────────────────────────────────────────────────
export async function fetchRatings(updateId)     { return request(`/ratings/${encodeURIComponent(updateId)}`, { skipAuth: true }); }
export async function castVote(updateId, vote)   { return request(`/ratings/${encodeURIComponent(updateId)}`, { method: 'POST', body: JSON.stringify({ vote }) }); }
export async function retractVote(updateId)      { return request(`/ratings/${encodeURIComponent(updateId)}`, { method: 'DELETE' }); }

// ── AI Analysis (Pro) ─────────────────────────────────────────────────────────
export async function triggerAiAnalysis(updateId){ return request(`/updates/${encodeURIComponent(updateId)}/analyse`, { method: 'POST', body: '{}' }); }

// ── Admin ─────────────────────────────────────────────────────────────────────
export async function fetchAdminStats()          { return request('/admin/stats'); }
export async function fetchAdminUsers(page = 1)  { return request(`/admin/users?page=${page}&limit=50`); }
export async function fetchAdminSubscriptions(page = 1) { return request(`/admin/subscriptions?page=${page}&limit=50`); }
export async function patchUserRole(userId, role){ return request(`/admin/users/${encodeURIComponent(userId)}/role`, { method: 'PATCH', body: JSON.stringify({ role }) }); }
export async function fetchAiLog(limit = 50)     { return request(`/admin/ai-log?limit=${limit}`); }

// ── Platform history ──────────────────────────────────────────────────────────
export async function fetchPlatformHistory(platform, limit = 20) {
  return request(`/updates/${encodeURIComponent(platform)}/history?limit=${limit}`, { skipAuth: true });
}

// ── Pipeline (admin) ──────────────────────────────────────────────────────────
export async function triggerPipeline(platform = null) {
  return request('/admin/pipeline/run', { method: 'POST', body: JSON.stringify({ platform }) });
}
export async function fetchPipelineStatus() { return request('/admin/pipeline/status'); }
export async function fetchEmailStatus() { return request('/admin/email/status'); }
export async function sendAdminTestEmail(to) { return request('/admin/email/test', { method: 'POST', body: JSON.stringify({ to }) }); }

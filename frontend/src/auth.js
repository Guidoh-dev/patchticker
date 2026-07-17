// src/auth.js
// ─────────────────────────────────────────────────────────────────────────────
// CLIENT-SIDE AUTH STATE MANAGER
//
// Single source of truth for auth state in the frontend.
// Coordinates: initial session restore, login/logout, role checks,
// and route protection.
//
// STORAGE MODEL
//  • Access token: _state.accessToken (memory only — never persisted)
//  • User object:  _state.user (memory only)
//  • Session is restored on page load via /api/auth/refresh (uses HTTP-only
//    refresh token cookie automatically — no JS access to the cookie).
// ─────────────────────────────────────────────────────────────────────────────

import { refreshTokens, getMe, setAccessToken, clearAuth as clearApiAuth } from './api.js';

const _state = {
  user:        null,
  initialized: false,
};

const _listeners = new Set();

function emit(event, data) {
  _listeners.forEach(fn => fn(event, data));
}

export function onAuthChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export function getUser()          { return _state.user; }
export function isLoggedIn()       { return !!_state.user; }
export function isInitialized()    { return _state.initialized; }
export function hasRole(role)      {
  const ranks = { free: 0, pro: 1, admin: 2 };
  const userRank = ranks[_state.user?.role || 'free'] ?? 0;
  return userRank >= (ranks[role] ?? 0);
}

/**
 * Called on app boot. Attempts to restore session from refresh token cookie.
 * Resolves to user object or null.
 */
export async function restoreSession() {
  try {
    const ok = await refreshTokens();
    if (ok) {
      const { user } = await getMe();
      _state.user = user;
    }
  } catch {
    _state.user = null;
  } finally {
    _state.initialized = true;
    emit('init', _state.user);
  }
  return _state.user;
}

export function setUser(user) {
  _state.user = user;
  emit('login', user);
}

export function signOut() {
  _state.user = null;
  clearApiAuth();
  emit('logout', null);
}

// Listen for server-side auth expiry (from api.js)
window.addEventListener('auth:expired', () => {
  if (_state.user) {
    _state.user = null;
    clearApiAuth();
    emit('expired', null);
  }
});

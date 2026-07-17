// src/router.js
// ─────────────────────────────────────────────────────────────────────────────
// Minimal hash-based client-side router.
//
// Routes:
//   #/            — main dashboard (requires auth)
//   #/login       — login page
//   #/register    — register page
//   #/pricing     — pricing page
//   #/verify-email — email verification landing
//   #/reset-password — password reset form
//   #/forgot-password — forgot password form
// ─────────────────────────────────────────────────────────────────────────────

const _routes = new Map();
let _current  = null;

export function route(path, handler) {
  _routes.set(path, handler);
}

export function navigate(path) {
  window.location.hash = path;
}

export function currentPath() {
  const hash = window.location.hash.slice(1) || '/';
  return hash.split('?')[0];
}

export function queryParams() {
  const hash   = window.location.hash.slice(1);
  const idx    = hash.indexOf('?');
  if (idx === -1) return {};
  return Object.fromEntries(new URLSearchParams(hash.slice(idx + 1)));
}

function matchRoute(path) {
  // Exact match first
  if (_routes.has(path)) return { handler: _routes.get(path), params: {} };
  // Pattern match: /segment/:param
  for (const [pattern, handler] of _routes) {
    const patternParts = pattern.split('/');
    const pathParts    = path.split('/');
    if (patternParts.length !== pathParts.length) continue;
    const params = {};
    const matched = patternParts.every((part, i) => {
      if (part.startsWith(':')) { params[part.slice(1)] = decodeURIComponent(pathParts[i]); return true; }
      return part === pathParts[i];
    });
    if (matched) return { handler, params };
  }
  return null;
}

export function start() {
  function dispatch() {
    const path    = currentPath();
    const match   = matchRoute(path);
    if (match && _current !== path) {
      _current = path;
      match.handler({ ...queryParams(), ...match.params });
    } else if (!match) {
      _current = '/';
      const root = _routes.get('/');
      if (root) root({});
    }
  }

  window.addEventListener('hashchange', dispatch);
  dispatch(); // initial
}

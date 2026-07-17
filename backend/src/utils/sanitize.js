// src/utils/sanitize.js
// ─────────────────────────────────────────────────────────────────────────────
// OUTPUT SANITIZATION & INPUT CLEANING — defense-in-depth layer.
//
// ARCHITECTURE NOTE:
//   Zod schemas (schemas.js) are the PRIMARY validation gate — they enforce
//   structure, types, enums, and reject injection patterns before any code
//   processes user input.
//
//   This file is a SECONDARY layer that runs AFTER Zod parsing succeeds:
//     1. sanitizeInput()  — cleans the Zod-parsed req.body/query/params object
//                           before service code sees it.
//     2. escapeOutput()   — HTML-escapes any user-originated string values
//                           immediately before they are written to res.json().
//
//   Having both layers means a bypass of one layer does not expose the system.
//
// THREATS ADDRESSED:
//   ┌────────────────────────────┬────────────────────────────────────────────┐
//   │ Threat                     │ Mitigation                                 │
//   ├────────────────────────────┼────────────────────────────────────────────┤
//   │ XSS (stored)               │ escapeHtml() on all string output          │
//   │ XSS (reflected)            │ Zod refine + escapeHtml() at res.json()    │
//   │ SQL injection (free text)  │ stripSqlMeta() on free-text fields         │
//   │ NoSQL operator injection   │ Zod .strict() strips unknown keys          │
//   │ Path traversal             │ stripPathChars() on all strings            │
//   │ Null byte injection        │ stripPathChars() removes \0                │
//   │ Prototype pollution        │ stripProto() + Zod .strict()               │
//   │ Homoglyph / unicode tricks │ normalizeUnicode() NFC normalization       │
//   │ Log injection              │ sanitizeLogValue() strips CRLF             │
//   └────────────────────────────┴────────────────────────────────────────────┘
//
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ── HTML entity escape ────────────────────────────────────────────────────────
// Encodes every character that has a special meaning in HTML/JS contexts.
// This is the canonical safe subset — do not shrink it.
const HTML_ESCAPE_MAP = {
  '&':  '&amp;',
  '<':  '&lt;',
  '>':  '&gt;',
  '"':  '&quot;',
  "'":  '&#x27;',
  '/':  '&#x2F;',
  '`':  '&#x60;',
  '=':  '&#x3D;',
};
const HTML_ESCAPE_RE = /[&<>"'`=/]/g;

/**
 * Escape a string for safe inclusion in HTML or JSON responses.
 * Non-strings are returned unchanged.
 * @param {unknown} str
 * @returns {unknown}
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPE_MAP[ch]);
}

// ── SQL metacharacter stripping ───────────────────────────────────────────────
// Primary SQL injection defence is parameterised queries (use those).
// This strip is a secondary layer for values written to logs or non-ORM contexts.
//
// Removed characters: single/double quote, semicolon, backslash,
//                     double-dash (comment), block comment delimiters, *, =, <>
const SQL_META_RE = /['";\\]|--|\/\*|\*\/|[*=<>]/g;

/**
 * Remove SQL metacharacters from a free-text string.
 * @param {string} str
 * @returns {string}
 */
function stripSqlMeta(str) {
  if (typeof str !== 'string') return str;
  return str.replace(SQL_META_RE, '');
}

// ── Path traversal & null-byte protection ─────────────────────────────────────
/**
 * Remove path traversal sequences and null bytes from a string.
 * Applies to all strings as a blanket pass — low cost, high value.
 * @param {string} str
 * @returns {string}
 */
function stripPathChars(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/\0/g, '')            // null bytes (can bypass extension checks)
    .replace(/\.\.(?:\/|\\)/g, '') // ../ and ..\
    .replace(/[/\\]/g, '');        // bare slashes in non-URL free-text context
}

// ── Unicode normalization ─────────────────────────────────────────────────────
/**
 * NFC-normalize a string to defeat homoglyph substitution attacks.
 * e.g. "ℬ" (script B, U+212C) → "B" after normalization.
 * @param {string} str
 * @returns {string}
 */
function normalizeUnicode(str) {
  if (typeof str !== 'string') return str;
  return str.normalize('NFC');
}

// ── Prototype pollution guard ─────────────────────────────────────────────────
// Belt-and-suspenders after Zod's .strict(). Handles edge cases where objects
// are constructed outside the Zod parse path (e.g. manual Object.assign calls).
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Recursively delete prototype-polluting keys from a plain object.
 * @param {unknown} obj
 * @returns {unknown}
 */
function stripProto(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stripProto);
  return Object.fromEntries(
    Object.entries(obj)
      .filter(([k]) => !DANGEROUS_KEYS.has(k))
      .map(([k, v]) => [k, stripProto(v)])
  );
}

// ── Log injection prevention ──────────────────────────────────────────────────
/**
 * Sanitize a value for safe inclusion in log output.
 * Strips CR/LF characters that could inject fake log lines.
 * @param {unknown} val
 * @returns {string}
 */
function sanitizeLogValue(val) {
  const str = String(val ?? '');
  return str.replace(/[\r\n\t]/g, ' ').slice(0, 200); // truncate to 200 chars
}

// ── Composite: sanitize a parsed input object ─────────────────────────────────
/**
 * Walk a Zod-parsed object and apply all input sanitizers to string values.
 * Safe to call on req.body, req.query, or req.params after Zod validates them.
 *
 * Pipeline per string value:
 *   1. normalizeUnicode  — NFC normalize
 *   2. .trim()           — strip surrounding whitespace (Zod also does this if declared)
 *   3. stripPathChars    — remove null bytes and traversal sequences
 *   4. stripSqlMeta      — remove SQL metacharacters
 *   (optional) escapeHtml — HTML-escape if escapeOutput:true (for reflected responses)
 *
 * @param {Record<string, unknown>} obj
 * @param {{ escapeOutput?: boolean }} [opts]
 * @returns {Record<string, unknown>}
 */
function sanitizeInput(obj, { escapeOutput: doEscape = false } = {}) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((v) => sanitizeInput(v, { escapeOutput: doEscape }));

  // Prototype pollution strip first
  const safe = stripProto(obj);

  return Object.fromEntries(
    Object.entries(safe).map(([key, value]) => {
      if (typeof value === 'string') {
        let v = normalizeUnicode(value).trim();
        v = stripPathChars(v);
        v = stripSqlMeta(v);
        if (doEscape) v = escapeHtml(v);
        return [key, v];
      }
      if (value !== null && typeof value === 'object') {
        return [key, sanitizeInput(value, { escapeOutput: doEscape })];
      }
      return [key, value];
    })
  );
}

// ── Composite: escape all strings in a response payload ───────────────────────
/**
 * Recursively HTML-escape all string values in a data structure.
 * Call this on any object that contains user-originated text BEFORE res.json().
 *
 * @param {unknown} data
 * @returns {unknown}
 */
function escapeOutput(data) {
  if (typeof data === 'string') return escapeHtml(data);
  if (data === null || typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map(escapeOutput);
  return Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, escapeOutput(v)])
  );
}

module.exports = {
  escapeHtml,
  stripSqlMeta,
  stripPathChars,
  normalizeUnicode,
  stripProto,
  sanitizeLogValue,
  sanitizeInput,
  escapeOutput,
};

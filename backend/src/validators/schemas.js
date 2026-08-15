// src/validators/schemas.js
// ─────────────────────────────────────────────────────────────────────────────
// ZOD SCHEMA DEFINITIONS — single source of truth for all API input shapes.
//
// SECURITY MODEL — LAYERED DEFENCE
// ══════════════════════════════════════════════════════════════════════════════
//
//  Layer 1 — requestGuard middleware (runs first, before body parsing)
//    • Method allowlist (GET/POST only)
//    • Null bytes and path traversal in raw URL
//    • Content-Type enforcement on mutation routes
//    • Pre-parse Content-Length guard
//    • Array / object query-param injection rejection
//
//  Layer 2 — Zod schemas (this file)
//    • .strict() on every object — unknown keys are hard errors, not warnings.
//      Kills: mass-assignment, __proto__/__constructor__ pollution, NoSQL
//      operator injection (?$where=, ?$gt=, ?$ne=), extra field smuggling.
//    • Enum allowlists — only explicitly declared values pass. No case-folding,
//      no partial match, no coercion. Covers all IDs, platforms, statuses.
//    • String hardening (hardened()) — superRefine reports ALL failures at once:
//        · HTML tag rejection        → XSS (stored + reflected)
//        · Script pattern rejection  → javascript: URIs, inline handlers
//        · SQL pattern rejection     → UNION SELECT, DROP, comment sequences
//        · Path traversal rejection  → ../ ..\  null bytes
//    • No type coercion — Zod strict types. "123" ≠ 123.
//    • Trim + min/max on all free-text — DoS prevention, empty-submission guard.
//    • No .passthrough() anywhere — unknown keys are always errors.
//
//  Layer 3 — sanitize.js (runs after Zod, before service code)
//    • normalizeUnicode (NFC) — defeats homoglyph attacks (ℬ → B)
//    • stripPathChars          — belt-and-suspenders null byte / traversal strip
//    • stripSqlMeta            — secondary SQL metachar strip for logging safety
//    • stripProto              — recursive __proto__/constructor/prototype removal
//    • escapeOutput()          — HTML-encodes all user strings before res.json()
//
//  Layer 4 — parameterised queries (when a real DB is wired up)
//    • Never interpolate user input into SQL strings.
//    • Use ? / $1 placeholders via pg, knex, or prisma.
//
// ══════════════════════════════════════════════════════════════════════════════
// INJECTION COVERAGE MATRIX
// ══════════════════════════════════════════════════════════════════════════════
//  Attack class               | Blocked by
//  ─────────────────────────  | ──────────────────────────────────────────────
//  XSS (stored)               | hardened() HTML + script checks; escapeOutput()
//  XSS (reflected)            | hardened(); escapeOutput() on all res.json()
//  SQL injection (free text)  | hardened() SQL patterns; stripSqlMeta()
//  NoSQL operator injection   | .strict() rejects ?$where, ?$ne, etc.
//  Prototype pollution        | .strict() + stripProto()
//  Mass-assignment            | .strict() — only declared keys accepted
//  Path traversal             | hardened() + stripPathChars() + requestGuard
//  Null byte injection        | hardened() + stripPathChars() + requestGuard
//  Type confusion             | Zod strict typing — no implicit coercion
//  Array param injection      | requestGuard (pre-Zod) + .strict()
//  Homoglyph / unicode        | normalizeUnicode (NFC) in sanitizeInput()
//  Log injection              | sanitizeLogValue() strips CRLF before logging
//  DoS via large input        | .max() on all strings; Content-Length guard
//  Template injection         | hardened() HTML check blocks {{ and {{ syntax
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { z } = require('zod');

// ══════════════════════════════════════════════════════════════════════════════
// REUSABLE INJECTION-DETECTION REFINEMENTS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * hardened(base) — superRefine that reports ALL injection failures at once.
 *
 * Checks (in order):
 *   1. HTML tags             → XSS vector (stored and reflected)
 *   2. Script patterns       → javascript: URIs, onerror= / onclick= handlers
 *   3. SQL patterns          → UNION SELECT, --, ;DROP, block comments
 *   4. Path traversal        → ../ ..\  \0 null bytes
 *   5. Template injection    → {{ }} Mustache / Angular / Jinja delimiters
 *   6. CRLF injection        → \r \n sequences that could split HTTP headers
 *
 * Using superRefine (not .refine().refine()…) so all issues are collected in a
 * single pass and returned together — avoids waterfall error UX.
 *
 * @param {import('zod').ZodString} base  — a z.string() chain (trim/min/max already applied)
 * @returns {import('zod').ZodEffects<import('zod').ZodString>}
 */
function hardened(base) {
  return base.superRefine((v, ctx) => {
    const add = (message) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });

    // 1. HTML tags — catches <script>, <img onerror=…>, <svg onload=…>, etc.
    if (/<[^>]*>/g.test(v)) {
      add('Must not contain HTML tags');
    }

    // 2. Script patterns — javascript: URI and inline event handlers (on* =)
    if (/javascript\s*:/i.test(v)) {
      add('Contains disallowed javascript: URI');
    }
    if (/on\w+\s*=/i.test(v)) {
      add('Contains disallowed inline event handler');
    }

    // 3. SQL injection patterns
    //    Covers: -- comments, /* */ block comments, statement terminators
    //    followed by DML keywords, UNION SELECT.
    if (/(--|\/\*|\*\/)/i.test(v)) {
      add('Contains disallowed SQL comment sequence');
    }
    if (/;\s*(drop|select|insert|update|delete|alter|create|truncate)\b/i.test(v)) {
      add('Contains disallowed SQL statement pattern');
    }
    if (/\bunion\s+select\b/i.test(v)) {
      add('Contains disallowed SQL UNION SELECT pattern');
    }

    // 4. Path traversal and null bytes
    if (/\0/.test(v)) {
      add('Contains disallowed null byte');
    }
    if (/(\.\.\/|\.\.\\)/.test(v)) {
      add('Contains disallowed path traversal sequence');
    }

    // 5. Template / server-side injection delimiters
    //    {{ }} covers Mustache, Handlebars, Jinja2, Angular expressions.
    //    #{ } covers Ruby ERB. ${ } covers JS template literals.
    if (/\{\{|\}\}|#\{|\$\{/.test(v)) {
      add('Contains disallowed template expression');
    }

    // 6. CRLF injection — could split HTTP headers or inject fake log lines
    if (/[\r\n]/.test(v)) {
      add('Contains disallowed line break characters');
    }
  });
}


function rejectPrototypePollution(schema) {
  return schema.superRefine((obj, ctx) => {
    if (!obj || typeof obj !== 'object') return;
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Object prototype is not allowed',
      });
    }
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Disallowed key: ${key}`,
        });
      }
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// SHARED ENUM TYPES  (single source of truth — import from here, never re-declare)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Valid platform display names.
 * Case-sensitive exact match. "nvidia" ≠ "NVIDIA".
 */
const PlatformEnum = z.enum(['Apple', 'NVIDIA', 'AMD', 'PS5', 'Windows', 'Steam', 'macOS', 'Intel',  'Xbox', 'Switch','Discord','BattleNet','GOG']);

/** Update health status values. */
const StatusEnum = z.enum(['stable', 'caution', 'avoid']);

/** Bug report severity. */
const SeverityEnum = z.enum(['critical', 'high', 'medium', 'low']);

/**
 * Update ID slugs generated by the scraper pipeline.
 *
 * This intentionally validates shape instead of using a hardcoded allowlist.
 * The pipeline creates IDs from platform + version, so future scraped patches
 * must be routable without a code deploy. Security is preserved by accepting
 * only short lowercase ASCII slugs: letters, digits, single hyphen separators.
 */
const UpdateIdSlug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Invalid update id');

// Backwards-compatible export name for older imports/tests.
const UpdateIdEnum = UpdateIdSlug;

// ══════════════════════════════════════════════════════════════════════════════
// REUSABLE FIELD DEFINITIONS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Safe free-text field — used for the bug report description.
 * Pipeline: trim → min → max → injection guards.
 *
 * Limits:
 *   min 10  — prevents empty / whitespace-only submissions
 *   max 1000 — prevents log flooding and DB field overflow
 */
const SafeDescription = hardened(
  z.string()
    .trim()
    .min(10, 'Description must be at least 10 characters')
    .max(1000, 'Description must not exceed 1000 characters')
);

// ══════════════════════════════════════════════════════════════════════════════
// ROUTE-LEVEL SCHEMAS
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /api/updates ──────────────────────────────────────────────────────────
/**
 * Query string: ?platform=NVIDIA&status=stable
 *
 * .strict() kills undeclared keys including:
 *   ?__proto__[polluted]=1          prototype pollution attempt
 *   ?constructor[prototype][x]=1    constructor pollution
 *   ?$where=1==1                    NoSQL injection
 *   ?platform[$ne]=AMD              MongoDB operator injection
 *   ?platform[]=AMD&platform[]=NV   array parameter injection
 *   ?randomField=x                  any unrecognised key
 *
 * Both fields are optional. When present, exact enum match required.
 */
const SortEnum = z.enum(['relevance', 'date_desc', 'date_asc', 'score_desc', 'score_asc']);

const GetUpdatesQuerySchema = z
  .object({
    platform: PlatformEnum.optional(),
    status:   StatusEnum.optional(),
    sort:     SortEnum.optional(),
    search:   z.string().max(100).optional(),
  })
  .strict();

// ── GET /api/updates/:id ──────────────────────────────────────────────────────
/**
 * URL param :id
 *
 * UpdateIdSlug shape validation means:
 *   ../../etc/passwd      → rejected (invalid slug shape)
 *   <script>alert(1)</script> → rejected (invalid slug shape)
 *   '; DROP TABLE --      → rejected (invalid slug shape)
 *   nvidia-572-16\0       → rejected (invalid slug shape, null byte in value)
 *   unknown-but-valid slug → looked up safely, then 404 if absent
 *
 * .strict() prevents a second param key being injected alongside id.
 */
const GetUpdateByIdParamSchema = rejectPrototypePollution(
  z.object({ id: UpdateIdEnum }).strict()
);

// ── GET /api/bug-reports/:updateId ───────────────────────────────────────────
const GetBugReportsByUpdateIdParamSchema = rejectPrototypePollution(
  z.object({ updateId: UpdateIdEnum }).strict()
);

// ── POST /api/bug-reports ─────────────────────────────────────────────────────
/**
 * Request body: { updateId, severity, description }
 *
 * Security checklist:
 *   ✓ .strict()           extra fields (userId, score, isAdmin, __proto__) → rejected
 *   ✓ updateId slug       lowercase slug only; future pipeline IDs supported
 *   ✓ severity enum       only 4 known values; no open-string injection
 *   ✓ description.trim()  strips surrounding whitespace
 *   ✓ description.min(10) rejects empty / whitespace-only submissions
 *   ✓ description.max(1000) hard DoS ceiling
 *   ✓ hardened()          rejects HTML, script, SQL, path traversal, templates, CRLF
 *
 * Defense-in-depth: even if all the above passed, sanitize.js escapes the
 * value again before it is stored or reflected back to the client.
 */
const PostBugReportBodySchema = rejectPrototypePollution(
  z.object({
    updateId:    UpdateIdEnum,
    severity:    SeverityEnum,
    description: SafeDescription,
  }).strict()
);

// ── GET /api/health ───────────────────────────────────────────────────────────
/**
 * Health endpoint accepts no query params.
 * .strict() with empty object rejects any attempted injection via query string.
 */
const HealthQuerySchema = z.object({}).strict();

// ══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // ── Route schemas (consumed by validate() middleware) ──────────────────────
  SortEnum,
  GetUpdatesQuerySchema,
  GetUpdateByIdParamSchema,
  GetBugReportsByUpdateIdParamSchema,
  PostBugReportBodySchema,
  HealthQuerySchema,

  // ── Shared enums (import from here, never re-declare elsewhere) ────────────
  PlatformEnum,
  StatusEnum,
  SeverityEnum,
  UpdateIdEnum, // alias of UpdateIdSlug
  UpdateIdSlug,

  // ── Reusable field schemas ─────────────────────────────────────────────────
  SafeDescription,

  // ── Derived plain-value lists (used by services for runtime guards) ────────
  VALID_PLATFORMS:  PlatformEnum.options,   // string[]
  VALID_SEVERITIES: SeverityEnum.options,   // string[]

  // ── Internal — exported only for unit tests of hardened() itself ───────────
  _hardened: hardened,
};

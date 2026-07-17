// src/middleware/validate.js
// ─────────────────────────────────────────────────────────────────────────────
// ZOD VALIDATION MIDDLEWARE FACTORY
//
// Usage:
//   router.get('/',    validate({ query:  GetUpdatesQuerySchema }),           handler)
//   router.get('/:id', validate({ params: GetUpdateByIdParamSchema }),        handler)
//   router.post('/',   validate({ body:   PostBugReportBodySchema }),         handler)
//
// What this does for each declared target (body / query / params):
//   1. Runs schema.safeParse() — never throws, always returns { success, data/error }
//   2. On failure:  returns 422 with structured { field, message } errors.
//                   Stack traces and internal Zod paths are never exposed.
//   3. On success:  REPLACES req[key] with the Zod-parsed output.
//                   This means downstream handlers receive:
//                     - Only declared fields (unknown keys stripped by .strict())
//                     - Trimmed strings (if schema declares .trim())
//                     - Correctly typed values (no string "123" for a number field)
//   4. Then runs sanitizeInput() on the already-parsed data as a second pass.
//
// WHY REPLACE req[key] WITH PARSED OUTPUT?
//   Express gives handlers the raw string-keyed query/params objects.
//   By replacing them with Zod's output we guarantee that:
//     - No unvalidated keys reach service code
//     - Types are exactly what the schema declares
//     - Any .transform() or .default() applied in the schema takes effect
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { ZodError } = require('zod');
const logger = require('../utils/logger');
const { sanitizeInput } = require('../utils/sanitize');

/**
 * Format a ZodError into client-safe { field, message } pairs.
 * We deliberately omit Zod's internal `code` and `received` fields so as not
 * to leak schema structure to potential attackers.
 *
 * @param {ZodError} zodError
 * @returns {{ field: string, message: string }[]}
 */
function formatZodErrors(zodError) {
  return zodError.errors.map((issue) => ({
    field:   issue.path.length ? issue.path.join('.') : 'input',
    message: issue.message,
  }));
}

/**
 * Validation middleware factory.
 *
 * @param {{
 *   body?:   import('zod').ZodTypeAny,
 *   query?:  import('zod').ZodTypeAny,
 *   params?: import('zod').ZodTypeAny,
 * }} schemas
 * @returns {import('express').RequestHandler}
 */
function validate(schemas = {}) {
  // Validate at startup that callers passed actual Zod schemas (not plain objects).
  for (const [key, schema] of Object.entries(schemas)) {
    if (schema && typeof schema.safeParse !== 'function') {
      throw new TypeError(
        `validate(): schemas.${key} must be a Zod schema (missing .safeParse). ` +
        `Did you pass a plain object instead?`
      );
    }
  }

  return (req, res, next) => {
    const targets = [
      { key: 'body',   schema: schemas.body,   source: req.body   },
      { key: 'query',  schema: schemas.query,  source: req.query  },
      { key: 'params', schema: schemas.params, source: req.params },
    ];

    for (const { key, schema, source } of targets) {
      if (!schema) continue;

      const result = schema.safeParse(source);

      if (!result.success) {
        const fields = formatZodErrors(result.error);

        // Log with IP for security monitoring — but never log the raw input value
        // (it may contain the attack payload itself).
        logger.warn(`Validation failed [${key}] ${req.method} ${req.path}`, {
          ip:     req.ip,
          fields: fields.map(f => `${f.field}: ${f.message}`),
        });

        return res.status(422).json({
          error:  'Validation failed',
          source: key,
          fields,
        });
      }

      // Replace raw Express input with the clean, type-safe Zod output.
      // Then run sanitizeInput as a defense-in-depth pass.
      req[key] = sanitizeInput(result.data);
    }

    next();
  };
}

module.exports = validate;

// src/validators/index.js
// Re-exports all Zod schemas from schemas.js.
// This file exists for backward compatibility with any imports of validators/index.js
// New code should import directly from validators/schemas.js

module.exports = require('./schemas');

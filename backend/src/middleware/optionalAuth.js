'use strict';

const requireAuth = require('./requireAuth');

// Public reads remain anonymous; a supplied token is verified so responses can
// include user-specific state without trusting an unvalidated identity.
function optionalAuth(req, res, next) {
  if (!req.headers.authorization) return next();
  return requireAuth(req, res, next);
}

module.exports = optionalAuth;

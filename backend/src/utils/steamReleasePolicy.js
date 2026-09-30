'use strict';

// Keep the publisher's explicit small-release labels in one place: ingestion
// must reject them, and public reads must hide any legacy rows already saved.
const SMALL_RELEASE_TITLE_RE = /\b(?:hot[ -]?fix|micro[ -]?patch|bug[ -]?fix(?:es)?(?: patch)?|minor (?:update|patch)|small (?:update|patch)|quick fix|update fixes|maintenance(?: update| patch)?|server maintenance)\b/i;

function isExplicitlySmallReleaseTitle(value) {
  return SMALL_RELEASE_TITLE_RE.test(String(value || ''));
}

module.exports = { isExplicitlySmallReleaseTitle };

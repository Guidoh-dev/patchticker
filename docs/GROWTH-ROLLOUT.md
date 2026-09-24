# PatchTicker growth rollout — 2026-09-24

## What the audit found

- The live app had 79 current updates across 16 tracked platforms, but its public sitemap listed fragment URLs such as /#/platform/NVIDIA. /updates returned the same empty HTML app shell as /, with a root canonical. Search engines cannot reliably treat fragment routes as separate content pages. This is the largest measurable discoverability defect, not proof of a specific traffic loss.
- Version-only detections for Battle.net and GOG were mixed with source-rich releases. They should remain useful in the live dashboard, but they are too thin for search landing pages or confident safety scoring.
- PatchTicker already has search, community voting, watchlists, hardware compatibility guidance, and game tracking. Better distribution and trustworthy evidence are higher leverage than adding another large feature before measuring acquisition.

## Phase 0 — Crawlability and shareability (implemented in this change)

- Add server-rendered /releases, /platforms/:platform, and /releases/:id pages with unique titles, descriptions, canonical URLs, internal links, release date, source links, notes, known issues, and a route into the interactive dashboard.
- Replace the fragment sitemap with a live XML sitemap of source-qualified releases and platforms; leave version-only and thin pages as noindex.
- Use /releases/:id for the Share action and link the release archive from the app footer. Preserve existing /#/updates/:id bookmarks.
- Verify: production build, backend/frontend tests, HTTP 200 + title + source link for a real release, XML sitemap free of fragments, 404 for unknown IDs.
- **Metric:** Search Console indexed release pages, organic landing sessions, release-page to dashboard click-through. Baseline first; no traffic uplift is guaranteed.

## Phase 1 — Trust and retention (next, after indexation baseline)

- Add an explicitly opted-in weekly digest using the existing watchlist and Brevo mail transport. Deduplicate notifications and obey the existing 300/day cap; defer mail rather than exceed the cap.
- Show “version verified; full notes unavailable” whenever vendor notes are missing, instead of a numerical stability conclusion. Do not backfill invented user ratings.
- On every release page, show source freshness and evidence limitations consistently; ask for device-specific issue reports only after install.
- **Metric:** weekly return visitors, alert-to-page click-through, percentage of releases with source-linked substantive notes, unsubscribes and bounces.

## Phase 2 — Focused acquisition (after measuring actual search demand)

- Use Search Console queries and consented PostHog funnels to identify the 3–5 release families people search for most. Prioritize official-source coverage and recurring release-note comparisons there, rather than adding dozens of low-signal feeds.
- Trial concise, shareable “what changed / who should wait” cards for sourced releases. Keep source, date, confidence limits, and exact release identity visible.
- Consider Android security bulletins, Linux distribution advisories, or major game launchers **only if** official release feeds and real query demand support them. New providers must fit current Render/Brevo cost caps.
- **Metric:** qualified organic clicks, engaged sessions, saves/watchlist follows, free-to-Pro conversion. Stop a channel if it drives impressions without meaningful engagement.

## Evidence and constraints

- Google advises against fragment URLs for distinct SPA content and recommends crawlable URLs: https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics
- Google recommends absolute canonical URLs in sitemaps and says sitemaps do not guarantee indexing: https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap
- Google advises substantial original analysis instead of scaled thin summaries: https://developers.google.com/search/docs/fundamentals/creating-helpful-content
- No paid service or new API key is needed for Phase 0. Search Console verification/submission requires the site owner's Google account; robots.txt already advertises the sitemap.

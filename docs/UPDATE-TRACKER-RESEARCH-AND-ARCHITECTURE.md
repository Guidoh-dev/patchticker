# PatchTicker update-tracker research and architecture

Research date: 2026-07-23
Scope: global consumer search intent, consumer and enterprise adoption behavior, vendor ingestion, normalization, and real-time delivery.

## Executive findings

- The defensible planning estimate is **0.65–1.75 million update-intent searches per ordinary day globally**, with a **1.08 million/day base case**. Major OS launches, actively exploited zero-days, and popular game-driver launches can lift the affected platform cluster by 3–8× for 24–72 hours. This is a modeled range, not a directly observed Google count.
- Intent is concentrated early. For a high-severity OS or console event, model 50% of release-attributed search demand in the first 6 hours and 80% in the first 24 hours. Driver demand is even more front-loaded around game launches. Background-updating utilities have lower urgency and a 2–3 day discovery tail.
- Consumer installation behavior and enterprise deployment behavior must not be combined. A representative German consumer survey found 44% update immediately and another 19% within several days, while Microsoft enterprise guidance explicitly uses deployment rings from immediate through 7–10 days. The proposed adoption curves below are segment-specific planning benchmarks.
- PatchTicker's useful advantage is not merely scraping first. It is detecting, verifying, normalizing, and routing one release across many vendors while the search-intent curve is still near its peak. The Tracking Efficiency Score (TES) makes that latency measurable.
- **SSE is the right default live-feed transport** because the product is server-to-client. Web Push is a separate, opt-in channel for critical alerts while the site is closed. WebSockets should be reserved for genuinely bidirectional features.

## 1. Search intent and daily volume

### Method and confidence

Google Trends is normalized from 0–100 and is not absolute volume; Google explicitly distinguishes it from advertising search-volume data. Google Keyword Planner exposes estimates of monthly searches, but complete global exports require an Ads account and were not available in this research environment ([Google Trends methodology](https://support.google.com/trends/answer/4365533?hl=en), [Keyword Planner](https://support.google.com/google-ads/answer/7337243?hl=en-419)). Therefore the following numbers are a **top-down market-sizing model** intended for capacity and product prioritization, not investor-grade audited keyword counts.

The model groups a broad multilingual query basket—`update`, `patch notes`, `release notes`, `driver`, `firmware`, `changelog`, `issues`, `status`, `download`, version numbers, and CVE/KB identifiers—and estimates ordinary-day global Google searches. It deliberately excludes in-product update checks, vendor support-site navigation without search, app-store searches, social searches, and AI-assistant queries. Ranges reflect query overlap, language coverage, seasonality, and release-day spikes.

### Global ordinary-day planning estimate

| Velocity tier | Included ecosystems | Dominant intent | Low/day | Base/day | High/day | Release-event multiplier | Peak intent window |
|---|---|---|---:|---:|---:|---:|---|
| 1. Consoles & OS | PS5, Xbox, Switch, iOS/iPadOS, macOS, Windows | availability/status 35%; notes/features 25%; issues/rollback 25%; security 15% | 360,000 | **590,000** | 950,000 | 3–8× | 0–24 h; security tail to 72 h |
| 2. Graphics & drivers | NVIDIA, AMD, Intel Arc | download/version 30%; game-ready performance 30%; issues/rollback 30%; notes 10% | 130,000 | **225,000** | 380,000 | 3–6× | −12 h to +24 h around game/driver launch |
| 3. Gaming distribution | Steam client/SteamOS, Epic, Battle.net | status/issues 40%; features 25%; patch availability 20%; rollback 15% | 55,000 | **95,000** | 165,000 | 2–5× | 0–48 h |
| 4. Browsers & utilities | Chrome, Firefox, Discord, VS Code | security/issues 35%; version/status 30%; features 25%; manual update 10% | 105,000 | **170,000** | 255,000 | 2–4× | 0–72 h |
| **Total** | Query basket above | — | **650,000** | **1,080,000** | **1,750,000** | — | — |

Do not sum these numbers with vendor brand searches or game-specific patch searches; that would materially inflate the addressable intent. Before using the estimate for paid acquisition or revenue forecasts, validate the maintained keyword basket quarterly with Keyword Planner exports by country/language, de-duplicate close variants, and calibrate against PatchTicker Search Console impressions.

The base case allocates to providers as follows. These are components of the tier totals—not independent keyword-tool observations—and should be rounded to the nearest 5,000.

| Tier | Provider cluster | Base searches/day | Representative high-intent queries |
|---|---|---:|---|
| 1 | Windows | 210,000 | `Windows update issues`, KB/build number, release health, rollback |
| 1 | Apple iOS/iPadOS/macOS | 190,000 | `iOS release notes`, macOS update problems, security update |
| 1 | PS5 | 80,000 | PS5 system update, firmware version, patch notes today |
| 1 | Nintendo Switch | 65,000 | Switch system update, firmware notes, update error |
| 1 | Xbox | 45,000 | Xbox system update, OS build, update stuck/issues |
| 2 | NVIDIA | 135,000 | NVIDIA driver update, Game Ready notes, issues/rollback |
| 2 | AMD | 55,000 | AMD Adrenalin driver, release notes, timeout/issues |
| 2 | Intel Arc | 35,000 | Intel Arc driver, Game On release, performance/issues |
| 3 | Steam client/SteamOS | 55,000 | Steam client update, SteamOS patch notes, update issue |
| 3 | Battle.net | 25,000 | Battle.net update, launcher stuck, patch notes |
| 3 | Epic Games Launcher | 15,000 | Epic launcher update, download/login issue |
| 4 | Google Chrome | 75,000 | Chrome update, release notes, zero-day/security version |
| 4 | Discord | 40,000 | Discord update, patch notes, update failed |
| 4 | VS Code | 35,000 | VS Code update, release notes, version/features |
| 4 | Firefox | 20,000 | Firefox update, release notes, security issue |
| **Total** | — | **1,080,000** | — |

### Priority and urgency interpretation

| Tier | User trigger | Product latency SLO | Recommended polling when active | Why users care now |
|---|---|---:|---:|---|
| 1 | OS/firmware release, CVE, service-blocking mandatory update | verified item p95 < 5 min for API/RSS; < 15 min for HTML | 1–3 min | Security exposure, online access, boot/stability risk |
| 2 | New game support, performance regression, driver crash | p95 < 10 min | 3–5 min | Users decide install vs. rollback immediately before play |
| 3 | Client/launcher release or outage-like regression | p95 < 20 min | 5–10 min | Mostly background installs; urgency rises if launch/login breaks |
| 4 | Silent auto-update, browser zero-day, utility regression | p95 < 15 min for critical security; < 30 min otherwise | 5–15 min | Routine releases are quiet, but exploited browser fixes are urgent |

Chrome's own documentation illustrates the cadence mismatch: Stable gets minor updates every 2–3 weeks and majors every four weeks, while Canary is daily ([Chrome release channels](https://developer.chrome.com/docs/web-platform/chrome-release-channels)). The pipeline therefore needs channel-aware rather than provider-wide polling.

## 2. Adoption and commitment model

### Evidence anchors

- Bitkom's representative 2023 survey of 780 German smartphone users found **44% install immediately, 19% within several days, 16% in following weeks, 5% wait until functionality is restricted, and 11% never update** ([Bitkom Research](https://bitkom-research.de/news/smartphone-updates-werden-meist-schnell-installiert)). This is self-reported consumer smartphone behavior in one country, not a global device-telemetry curve.
- An FTC mobile-update study reported very wide per-update uptake, but carriers said typically over 90% installed Android security updates within 2–4 weeks; security-update uptake among active devices ranged 53–89% in one manufacturer set ([FTC report, pp. 62–65](https://www.ftc.gov/system/files/documents/reports/mobile-security-updates-understanding-issues/mobile_security_updates_understanding_the_issues_publication_final.pdf)).
- Microsoft's 2024 Intune analysis found median adoption can lag availability by months on some enterprise Android models; 47 of 50 popular Android Enterprise Recommended knowledge-worker models had their median device updated within two months ([Microsoft analysis](https://techcommunity.microsoft.com/blog/vulnerability-management/research-analysis-and-guidance-ensuring-android-security-update-adoption/4216714)).
- Microsoft publishes a representative ring configuration of immediate, 2-day, 4-day, 7-day, and 10-day quality-update deferrals ([Windows deployment rings](https://learn.microsoft.com/en-us/compliance/anz/e8-patchos-configure-wufb-rings)). These are policy targets, not measured installation shares.

### Modeled cumulative adoption among eligible, active devices

These percentages are **benchmarks for product modeling** synthesized from the evidence above, auto-update behavior, and vendor rollout mechanics. They are not claims of measured global installation share. Each row is cumulative, so `<3d` includes Day 0 and `<1w` includes `<3d`.

| Segment / release type | Day 0 `<24h` | `<3d` | `<1w` | `>1w` or never | Confidence / interpretation |
|---|---:|---:|---:|---:|---|
| Consumer console & routine OS quality update | 38% | 62% | 79% | 21% | Medium; auto-download and online-service prompts drive adoption |
| Consumer critical OS/browser zero-day | 52% | 76% | 89% | 11% | Medium-low; urgency increases action, but staged eligibility caps Day 0 |
| Consumer GPU game-ready driver | 24% | 47% | 64% | 36% | Low-medium; gamers needing a named title skew early, stable users defer |
| Consumer launcher/distribution client | 57% | 78% | 88% | 12% | Medium; forced/background client updates dominate, not user commitment |
| Consumer browser/core utility auto-update | 48% | 72% | 87% | 13% | Medium; availability is staged and restart/app relaunch may delay activation |
| Managed enterprise quality/security update | 8% | 24% | 53% | 47% | Medium; test/pilot/broad rings intentionally shift installs right |
| Managed enterprise feature/major OS update | 2% | 7% | 18% | 82% | Medium; compatibility validation and 30–90 day deferrals are normal |

For a mutually exclusive dashboard cohort, derive buckets from the cumulative values:

```text
day_0          = adoption_lt_1d
day_1_to_3     = adoption_lt_3d - adoption_lt_1d
day_4_to_7     = adoption_lt_1w - adoption_lt_3d
after_day_7    = 100 - adoption_lt_1w
```

Do not treat “available from vendor” and “eligible on device” as the same timestamp. Staged rollouts, geography, hardware IDs, OEM/carrier packaging, update rings, and paused releases create separate `releasedAt`, `rolloutStartedAt`, and `availableAt` events.

## 3. Tracking Efficiency Score (TES)

### Definition

Let:

- `L = max(0, indexedAt − releasedAt)` in minutes.
- `H = intent half-life`: minutes after release when release-attributed search intensity has fallen to half its peak.
- `Q = source-quality multiplier`: official API/webhook `1.00`, official RSS/structured JSON `0.98`, official HTML `0.95`, verified secondary source awaiting official confirmation `0.75`.
- `C = content-completeness multiplier`: version + platform + official URL `0.85`; add release type/severity `+0.05`; parsed highlights/known issues `+0.05`; independently verified timestamps/download link `+0.05`, capped at `1.00`.

```text
TES = round(100 × Q × C × 2^(-L / H), 1)
```

This is a quality-adjusted share of peak-window value retained at indexing time. It penalizes latency exponentially rather than pretending that a post just inside an arbitrary window is fully valuable. Track the transparent companion metric `latencyWindowRatio = L / W80`, where `W80` is the estimated window containing 80% of release-attributed intent.

Recommended starting parameters:

| Event class | `H` | `W80` | Rationale |
|---|---:|---:|---|
| Actively exploited zero-day / mandatory console update | 180 min | 24 h | Search and alerts spike immediately |
| Game-ready GPU driver | 360 min | 24 h | Release/game-launch decision window |
| Routine OS / console / browser update | 720 min | 48 h | Notification and restart cycle spreads discovery |
| Background launcher / utility feature update | 1,440 min | 72 h | Lower urgency, longer discovery tail |

Example for a fully parsed official source (`Q=C=1`) with a 6-hour intent half-life:

| Indexing latency | TES | Peak-window value retained |
|---:|---:|---|
| 5 min | 99.0 | Essentially all |
| 30 min | 94.4 | Most |
| 4 h | 63.0 | Material loss |
| 12 h | 25.0 | Three quarters lost |
| 24 h | 6.3 | Too late for most launch intent |

This makes the comparison operational: a feed indexing an official release in 5 minutes scores 99, while a recap discovered 12 hours later scores 25 for the same event. Manufacturer pages remain the source of truth; PatchTicker's measurable value is cross-vendor detection, normalization, watchlists, historical correction tracking, and alert delivery without requiring users to monitor many separate pages.

### Telemetry required to calculate it honestly

Store immutable observations for `sourceFirstSeenAt`, vendor `publishedAt`, inferred `releasedAt`, `fetchedAt`, `parsedAt`, `verifiedAt`, `indexedAt`, `streamedAt`, and `notificationSentAt`. Also store the timestamp confidence and any later correction. Report p50/p95 by provider and ingestion mechanism, not only a global average.

## 4. Provider ingestion map

Prefer the most structured official source available. HTML scraping is a fallback, and undocumented vendor endpoints must be treated as unstable even if their pages use them internally.

| Provider/entity | Primary mechanism | Confirmation / enrichment | Polling & parsing notes |
|---|---|---|---|
| Apple iOS/iPadOS/macOS | Official HTML tables: [Apple security releases](https://support.apple.com/en-us/100100) and [Developer releases](https://developer.apple.com/news/releases/) | Product release notes and CVE pages | Conditional GET every 3–5 min; table-row fingerprint; distinguish OS release from later CVE-detail publication |
| Windows | Authenticated [Microsoft Graph Windows updates API](https://learn.microsoft.com/en-us/windows/deployment/update/check-release-health) for known issues; public [Windows release health](https://learn.microsoft.com/en-us/windows/release-health/) | KB pages, MSRC data, Update Catalog | API for issue state transitions; scrape public release tables for KB/build publication; expect corrections |
| PlayStation 5 | Official [PS5 system software support](https://www.playstation.com/en-us/support/hardware/ps5/system-software/) HTML | [PlayStation Blog system-update category](https://blog.playstation.com/category/playstation-system-software-update/) | Support page is canonical version; blog supplies narrative features; page often mutates in place |
| Xbox | [Xbox Wire system-update archive](https://news.xbox.com/en-us/tag/system-update/) RSS/HTML where available | Xbox support and Insider ring notes | Filter Insider vs. general availability; preserve ring and OS-build identifiers |
| Nintendo Switch | Official [Switch system-update history](https://www.nintendo.com/en-gb/Support/Nintendo-Switch/System-Updates/Nintendo-Switch-System-Update-Information-1445507.html) HTML | Regional Nintendo support pages | Compare locales because posting time/text can differ; canonicalize same firmware version |
| Steam client / SteamOS | Official Steam news/RSS; [ISteamNews API](https://partner.steamgames.com/doc/webapi/ISteamNews) for known app IDs | Steam client and Steam Deck update pages | API is app-centric, not a universal release API; use RSS/community sources for client branches and label beta/stable |
| Epic Games Launcher | Official Epic support/news HTML | Epic status API for incidents only | Launcher changelog coverage is inconsistent; separate availability updates from service incidents |
| Battle.net | Official Blizzard news / app patch-notes HTML | In-client notes where publicly addressable | Staged regional rollouts are possible; do not infer global GA from first client observation |
| NVIDIA GeForce / NVIDIA App | Official driver results/release-note HTML and linked PDFs | [NVIDIA RSS](https://www.nvidia.com/en-us/about-nvidia/rss/) for announcements | NVIDIA's RSS terms state non-commercial use; legal review is required before commercial ingestion. Prefer driver page polling and links over republishing text |
| AMD Adrenalin | Official [AMD release-note HTML](https://www.amd.com/en/resources/support-articles/release-notes/RN-RAD-WIN-24-5-1.html) and driver support pages | Download metadata and community announcement | Parse headings such as support, fixed issues, known issues; release-note URLs are predictable but discovery should not depend on guessing |
| Intel Arc | Official [Intel Download Center page](https://www.intel.com/content/www/us/en/download/785597/intel-arc-graphics-windows.html) and linked release-note PDF | Intel support listing | Preserve full seven-digit build comparison; distinguish WHQL/non-WHQL and generic/OEM drivers |
| Google Chrome | [Chrome for Testing JSON endpoints](https://github.com/GoogleChromeLabs/chrome-for-testing) for channel versions | Chrome Releases blog and ChromiumDash for security/change detail | JSON detects version availability; it does not replace consumer release notes; store channel + OS + rollout status |
| Mozilla Firefox | Official [product-details JSON](https://product-details.mozilla.org/1.0/) | [Firefox release notes](https://www.mozilla.org/en-US/firefox/releases/) | JSON for detection, notes HTML for content; independently monitor ESR, Beta, Developer, Nightly |
| Discord | Official [Discord Blog changelogs](https://discord.com/blog) | Status API for incidents; developer changelog is separate | Desktop build delivery can precede editorial patch notes; do not merge service incidents with client releases |
| VS Code | Official release notes and [GitHub releases API/webhook](https://docs.github.com/en/webhooks/webhook-events-and-payloads#release) for `microsoft/vscode` | Update docs / release blog | GitHub release webhook is best when an installable GitHub App is authorized; otherwise conditional REST polling |

### Scraping controls and red flags

- Read and record each source's terms, robots policy, rate limits, and content license. Detection metadata and links are safer than republishing full vendor prose. **NVIDIA explicitly limits its RSS service to non-commercial use**, which is a launch blocker unless counsel confirms a compliant approach or another permitted source is used.
- Use a descriptive user agent, contact URL, conditional requests (`ETag`, `If-Modified-Since`), jitter, exponential backoff, and a per-host circuit breaker.
- Store the raw response hash and a short-lived encrypted/raw snapshot for audit and parser replay, subject to the site's terms. Never execute page scripts in the ingestion worker unless necessary and isolated.
- Treat HTML selectors as versioned contracts. A changed page that produces zero releases is an alert, not proof that no update exists.
- Webhooks require signature validation, replay protection, timestamp tolerance, body-size limits, and idempotency keys. A webhook is a hint to fetch and verify the canonical source, not unquestioned release truth.

## 5. Normalization and changelog parsing

The canonical contract is defined in:

- `shared/update-feed-item.ts`
- `shared/update-feed-item.schema.json`

Parsing stages:

1. **Acquire:** retain source URL, HTTP validators, fetched time, content type, and SHA-256.
2. **Extract deterministically:** JSONPath/CSS selectors first; HTML-to-text with heading/list structure preserved; PDF text only when an official HTML note is unavailable.
3. **Identify:** normalize provider/product/channel, but keep `version.raw`. Never coerce every vendor into SemVer: Windows KB/builds, Apple build IDs, and date-based drivers are not SemVer.
4. **Classify:** map to `security`, `feature`, `hotfix`, `driver`, `firmware`, `quality`, or `maintenance`; attach severity and CVEs only when supported by evidence.
5. **Summarize:** an LLM may generate highlights from the extracted text, but it may not invent CVEs, affected products, severity, or download URLs. Every generated claim should retain source evidence and `parser.method = "llm-assisted"`.
6. **Validate:** JSON Schema validation, URL allow-listing for official downloads, timestamp sanity checks, and required-field gates.
7. **Review/escalate:** low-confidence version extraction, critical severity, selector drift, conflicting sources, or a release rollback enters a human review queue.

Deduplication key:

```text
canonicalKey = sha256(
  providerId + "\0" + productId + "\0" + channel + "\0" +
  version.raw + "\0" + sorted(target.os + target.arch + target.deviceFamily)
)
```

Use a secondary `sourceKey = sha256(source.provider + source.externalId)` to make retries idempotent. Do not deduplicate on title, URL, or version alone: one version may have separate platform builds, and vendor URLs can be edited in place.

## 6. Backend blueprint

### Recommended stack

Keep the existing Node.js service and PostgreSQL. Add Redis only for queues, rate coordination, cache, and cross-instance fan-out. Use a transactional PostgreSQL outbox as the durable source of delivery events; Redis Pub/Sub alone has at-most-once delivery and cannot be the system of record.

```text
Provider registry + scheduler
          │
          ▼
Fetch workers ──► raw observations ──► provider parsers ──► schema validation
                                                          │
                                                          ▼
                                                dedupe + reconciliation
                                                          │
                                     ┌────────────────────┴──────────────────┐
                                     ▼                                       ▼
                              update_feed_items                       review/dead-letter
                                     │
                             same DB transaction
                                     ▼
                               event_outbox
                                     │
                         outbox relay / Redis Streams
                          ┌──────────┼────────────┐
                          ▼          ▼            ▼
                        SSE       Web Push      analytics
                     live feed   critical opt-in  TES/SLO
```

Core production choices:

| Concern | Choice | Reason |
|---|---|---|
| Scheduler | BullMQ-compatible Redis queue or a dedicated scheduler with DB leases | Per-provider cadence, retry, jitter, and concurrency limits |
| Truth store | PostgreSQL | Transactions, unique indexes, JSONB changelog/source evidence, correction history |
| Durable event handoff | PostgreSQL outbox | Item write and publish intent commit atomically |
| Worker transport | Redis Streams / queue | Replay and consumer groups; avoid Pub/Sub as the only delivery path |
| Live browser feed | SSE over HTTP/2 | One-way updates, automatic reconnect, event IDs; MDN notes non-HTTP/2 per-origin connection limits ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)) |
| Closed-browser critical alerts | Web Push with explicit watchlist consent | Push works when the site is inactive; use TTL, urgency, and topic collapse ([web.dev](https://web.dev/articles/push-notifications-overview)) |
| Bidirectional collaboration | WebSocket only if required | More state and operational complexity; unnecessary for feed delivery |

### SSE contract

- Endpoint: `GET /api/v1/feed/stream?platform=...&severity=...`
- Event types: `update.created`, `update.corrected`, `update.withdrawn`, `heartbeat`.
- Set `id` to the monotonically ordered outbox event ID. Accept `Last-Event-ID` and replay from the durable outbox/read model before switching to live delivery.
- Send a comment heartbeat every 20–30 seconds; disable proxy buffering; enforce per-user connection limits and HTTP/2.
- Authorize filters server-side. Never broadcast private watchlist metadata in shared payloads.

The current `backend/src/routes/feed.js` keeps subscribers in process memory. That is acceptable for one instance but loses fan-out across replicas and cannot replay missed events. The outbox/Redis/SSE gateway replaces that limitation without requiring a rewrite of the existing Express application.

### Critical-alert workflow

1. Parser detects official security language, CVEs, and exploited-in-the-wild evidence.
2. Rules engine assigns provisional severity; `critical` requires authoritative evidence or review.
3. Persist item and outbox event atomically.
4. Match watchlists by provider/product/channel/device family and user quiet-hour policy.
5. Web Push payload contains item ID and minimal display text, not the full changelog. Use a short TTL for time-sensitive warnings and `topic = canonicalKey` so corrections replace pending notices.
6. Track accepted, push-service response, expired endpoint, click, dismissal (where observable), unsubscribe, and notification latency. Never label provider acceptance as device delivery.

### Operational SLOs and telemetry

| Metric | Target |
|---|---:|
| Official API/RSS release-to-index p95 | < 5 min |
| Official HTML release-to-index p95 | < 15 min |
| Index-to-SSE enqueue p95 | < 2 s |
| Critical index-to-push-service acceptance p95 | < 30 s |
| Duplicate visible items | < 0.1% |
| Parser false-positive publish rate | < 0.5%; 0 critical false positives target |
| Source freshness | alert at 2× expected cadence; page-shape failure immediately |
| SSE replay success after reconnect | > 99.9% |

Instrument OpenTelemetry spans across `fetch → parse → validate → dedupe → persist → outbox → deliver`, with provider, mechanism, parser version, result, and latency labels. Avoid raw URL labels containing unbounded query strings.

## 7. Delivery sequence

1. Land the schema and create `provider_sources`, `source_observations`, `update_feed_items`, `update_item_revisions`, and `event_outbox` tables.
2. Implement three high-signal structured connectors first: Chrome JSON, Mozilla JSON, and GitHub releases. Prove idempotency and replay.
3. Add Apple, Windows, PS5, Switch, NVIDIA, AMD, and Intel parsers with fixtures and selector-drift alarms.
4. Add durable SSE replay and replace in-process-only broadcast for update events.
5. Add Web Push only after watchlist consent, quiet hours, per-topic throttles, and security review exist.
6. Run a 30-day shadow collection. Calibrate provider release timestamps, intent half-lives, false positives, and the search-volume model using Search Console and Keyword Planner exports before publishing TES externally.

## Source notes

Primary technical and vendor sources were preferred. The Bitkom survey and FTC report are behavioral benchmarks with clear population limits; Microsoft Intune evidence is enterprise-skewed. Search-volume and adoption tables explicitly remain modeled estimates until PatchTicker collects first-party telemetry or licensed keyword data. Research links were live as of 2026-07-23; vendor endpoints and terms should be rechecked during connector implementation.

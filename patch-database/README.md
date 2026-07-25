# PatchTicker Local Patch Research Database

Generated: 2026-07-21
Window: 2026-05-22 through 2026-07-21 (<60 days)

This is a local file-based research database generated from current PatchTicker tracked platforms, Supabase `software_updates` rows, scraper results, and official-source links attached to each update. It does not modify Supabase.

## Platform Summary

| Platform | Lane | Updates | Avg local rating | Folder |
|---|---|---:|---:|---|
| Windows | security | 1 | 9 | [./windows/](./windows/) |
| Apple iOS | security | 1 | 8.7 | [./apple/](./apple/) |
| macOS | security | 1 | 8.7 | [./macos/](./macos/) |
| NVIDIA | drivers | 1 | 8.4 | [./nvidia/](./nvidia/) |
| AMD | drivers | 1 | 2.7 | [./amd/](./amd/) |
| Intel | drivers | 2 | 7.4 | [./intel/](./intel/) |
| Steam | gaming | 1 | 6.8 | [./steam/](./steam/) |
| Switch | console | 1 | 8.4 | [./switch/](./switch/) |
| Xbox | console | 1 | 7 | [./xbox/](./xbox/) |
| PS5 | console | 1 | 7.6 | [./ps5/](./ps5/) |
| Discord | services | 1 | 8.4 | [./discord/](./discord/) |
| Battle.net | services | 1 | 8.4 | [./battlenet/](./battlenet/) |
| GOG Galaxy | services | 1 | 8 | [./gog/](./gog/) |
| Epic Games | services | 1 | 5.4 | [./epic/](./epic/) |

## Rating Test Method

- Starts from a neutral-positive installability baseline.
- Adds weight for official/vendor evidence and security urgency.
- Penalizes beta/preview labels, concrete known issues, medium/high/critical risk factors, missing evidence, generic `Latest` versions, high bug counts, and scraper gaps.
- Labels: `positive` >= 7.2, `mixed/caution` 5.0–7.1, `negative` < 5.0.

## Immediate Coverage Gaps

- Epic: current scraper returned HTTP 403; use Epic Public Status + Epic support as fallback until scraper target is replaced.
- Reddit signal: `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` are not configured, so community scoring is not active.
- Anthropic analysis: `ANTHROPIC_API_KEY` is not configured, so AI enrichment is not active; local rating test was used instead.
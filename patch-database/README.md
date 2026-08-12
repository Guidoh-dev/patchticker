# PatchTicker Local Patch Research Database

Generated: 2026-08-12
Window: 2026-06-13 through 2026-08-12 (last 60 days)

This is a local file-based research database generated from current PatchTicker tracked platforms, Supabase `software_updates` rows, scraper results, and official-source links attached to each update. It does not modify Supabase.

## Platform Summary

| Platform | Lane | Updates | Avg local rating | Folder |
|---|---|---:|---:|---|
| Windows | security | 2 | 8.3 | [./windows/](./windows/) |
| Apple iOS | security | 1 | 9.1 | [./apple/](./apple/) |
| macOS | security | 2 | 8.8 | [./macos/](./macos/) |
| NVIDIA | drivers | 1 | 8 | [./nvidia/](./nvidia/) |
| AMD | drivers | 2 | 5.9 | [./amd/](./amd/) |
| Intel | drivers | 1 | 6 | [./intel/](./intel/) |
| Steam | gaming | 2 | 6.2 | [./steam/](./steam/) |
| Switch | console | 1 | 8.7 | [./switch/](./switch/) |
| Xbox | console | 1 | 8.5 | [./xbox/](./xbox/) |
| PS5 | console | 1 | 8.5 | [./ps5/](./ps5/) |
| Discord | services | 1 | 8.1 | [./discord/](./discord/) |
| Battle.net | services | 1 | 7.5 | [./battlenet/](./battlenet/) |
| GOG Galaxy | services | 1 | 8.1 | [./gog/](./gog/) |

## Rating Test Method

- Starts from a neutral-positive installability baseline.
- Adds weight for official/vendor evidence and security urgency.
- Penalizes beta/preview release-channel labels, concrete known issues, medium/high/critical risk factors, missing evidence, generic `Latest` versions, high bug counts, and scraper gaps.
- Labels: `positive` >= 7.2, `mixed/caution` 5.0–7.1, `negative` < 5.0.

## Interpretation Notes

- Community ratings are separate from this source audit and appear publicly only after verified user votes exist.
- Stored analysis metadata is preserved per update; the local rating test is a reproducible source-quality comparison, not a replacement for the public PatchTicker score.
# Steam eligibility audit

Audit date: 2026-08-20

## Required production policy

| Field | Rule |
|---|---|
| Geography | United States only |
| Measurement window | Trailing 14 days |
| Metric | Average concurrent Steam players |
| Threshold | Strictly greater than 60,000 |
| Evidence | Per-game HTTPS source, UTC observation timestamp, explicit region and window |

## Finding

The prior 81-game roster was based on a global, trailing-30-day SteamCharts snapshot with a greater-than-15,000 threshold. It cannot substantiate the new US-only, trailing-14-day rule and is now retained only as audit input.

Counter-Strike 2 (Steam App 730) is present in that historical audit roster, so the reported omission was checked. It is not activated by the strict pipeline until a qualifying regional record is available.

Valve's public `GetNumberOfCurrentPlayers` Web API returns one current total for an App ID. Its documented request has no country, region, or historical-window parameter. Therefore, changing the labels on the existing global snapshot would create unsupported regional data.

## Enforcement applied

- Runtime Steam-game polling accepts only rows with `region = US`, `windowDays = 14`, `averageConcurrentPlayers > 60000`, an HTTPS evidence URL, and a UTC observation timestamp.
- The old global rows fail that gate and cannot trigger polling, inserts, feed events, or game-follow choices.
- When no valid roster is loaded, the worker returns `eligibility_data_unavailable` before calling Valve or PostgreSQL.
- Non-Steam coverage is restricted to official platform-wide system surfaces, current vendor driver families, or official core clients. Each registry row declares that boundary.

## Required follow-up data

Load a licensed or first-party regional concurrency snapshot into `STEAM_US_14D_CANDIDATES_JSON`. The value may be an array or `{ "candidates": [] }`; every row must include `appId`, `name`, `region`, `windowDays`, `averageConcurrentPlayers`, `sourceUrl`, and `observedAt`. Once supplied, the existing gate will admit qualifying games automatically; no threshold change is needed.

Source: [Valve Steam Web API — ISteamUserStats/GetNumberOfCurrentPlayers](https://partner.steamgames.com/doc/webapi/isteamuserstats?l=english)

# Steam eligibility audit

Audit date: 2026-09-02

## Required production policy

| Field | Rule |
|---|---|
| Concurrency geography | Global (SteamCharts does not publish country concurrency) |
| Measurement window | Trailing 30 days |
| Metric | Average concurrent Steam players, calculated from SteamCharts' 30-day hours played |
| Threshold | Strictly greater than 50,000 |
| US relevance | Must also appear in Valve's official United States Top Sellers top 100 |
| Evidence | SteamCharts game URL, official Steam US chart URL, ranks, and UTC observation timestamps |

## Finding

The prior 81-game roster used a greater-than-15,000 global threshold. The reviewed active fallback roster now contains 17 actual games that clear 50,000 average concurrent players and also appear on Steam's United States chart. Utilities and idlers such as Wallpaper Engine, Bongo Cat, and Task Bar Hero are excluded from patch tracking.

The fallback roster is: Counter-Strike 2, Dota 2, Palworld, Apex Legends, Rust, Marvel Rivals, Project Zomboid, Slay the Spire 2, Rainbow Six Siege, Overwatch, Dead by Daylight, GTA V Enhanced, HELLDIVERS 2, Warframe, How to Fish, War Thunder, and Team Fortress 2. Production refreshes the roster from both charts every 12 hours and preserves this reviewed list if either source is unavailable or malformed.

Valve's public player-count data and SteamCharts are global. Neither offers a public country-level average-player metric. PatchTicker therefore never labels these values as “US average players”; US relevance is a separate official-store signal.

## Enforcement applied

- Runtime Steam-game polling accepts only rows with `region = GLOBAL`, `windowDays = 30`, `averageConcurrentPlayers > 50000`, `market = US`, an official US rank from 1–100, both HTTPS evidence URLs, and UTC observation timestamps.
- The old broad global rows fail that gate and cannot trigger polling, inserts, feed events, or game-follow choices.
- A malformed configured override fails closed before calling Valve or PostgreSQL.
- Non-Steam coverage is restricted to official platform-wide system surfaces, current vendor driver families, or official core clients. Each registry row declares that boundary.

## Required follow-up data

Refresh the reviewed roster periodically from the two named sources. `STEAM_US_MARKET_CANDIDATES_JSON` may override the built-in snapshot with an array or `{ "candidates": [] }`; every row must preserve the fields enforced by the audit gate.

Sources: [SteamCharts top games](https://steamcharts.com/top), [Steam United States Top Sellers](https://store.steampowered.com/charts/topselling/US), and [Valve Steam Web API — ISteamUserStats/GetNumberOfCurrentPlayers](https://partner.steamgames.com/doc/webapi/isteamuserstats?l=english)

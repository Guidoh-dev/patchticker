# Epic Games Store / Epic Online Services Status Research

- ID: `epic-status-jul-2026`
- Platform: Epic
- Version: Jul 2026
- Released: 2026-07-21
- Stored status: caution
- Stored score: not set/10
- Local rating test: 5.4/10 (mixed/caution)
- Recommendation: review before installing

## Contents of update

### Changelog
- Epic Games Public Status listed EOS maintenance on July 21, 2026.
- Epic Games Public Status listed Fortnite downtime for v41.20 on July 16, 2026.
- Epic support documents manual launcher update behavior through Restart and Update.

### Known issues
- PatchTicker Epic scraper currently returns 403 from the target page.

### Risk factors
- **medium** — Coverage gap: official status is available, but launcher release-note extraction is unreliable until scraper target changes.

## Rating test execution

Result: **5.4/10 — mixed/caution**

Signals used:
- Official/vendor source attached.
- 1 risk factor(s) attached.
- 1 known issue(s) attached.
- Scraper coverage gap exists.

## Evidence
- [Epic Games Public Status](https://status.epicgames.com/) — Recent official incidents and maintenance history for Epic services.
- [Epic Games Launcher Support](https://www.epicgames.com/help/c-202300000001639/c-202300000001735/update-the-epic-games-launcher-a202300000020032) — Official instructions for updating the Epic Games Launcher.
- [Epic Developer Recent Updates](https://dev.epicgames.com/docs/epic-games-store/whats-new/recent-updates) — Official Epic Games Store developer recent updates.

## Raw JSON
```json
{
  "id": "epic-status-jul-2026",
  "platform": "Epic",
  "name": "Epic Games Store / Epic Online Services Status Research",
  "version": "Jul 2026",
  "releasedAt": "2026-07-21",
  "status": "caution",
  "storedScore": null,
  "impactScore": null,
  "bugCount": 0,
  "affects": "Epic Games Launcher / Epic Games Store / EOS / downloads / authentication / Fortnite downtime",
  "verdict": "Do not treat Epic as fully covered yet. The official status and support sources are usable, but the current scraper is blocked by a 403 and needs a more reliable source strategy.",
  "reasoning": "Epic does not currently have a clean recent launcher release-note row in PatchTicker. Official status pages show recent maintenance and Fortnite downtime, and Epic support documents the launcher update path, but the scraper needs to be switched away from the blocked page.",
  "changelog": [
    "Epic Games Public Status listed EOS maintenance on July 21, 2026.",
    "Epic Games Public Status listed Fortnite downtime for v41.20 on July 16, 2026.",
    "Epic support documents manual launcher update behavior through Restart and Update."
  ],
  "knownIssues": [
    "PatchTicker Epic scraper currently returns 403 from the target page."
  ],
  "riskFactors": [
    {
      "level": "medium",
      "text": "Coverage gap: official status is available, but launcher release-note extraction is unreliable until scraper target changes."
    }
  ],
  "evidence": [
    {
      "source": "Epic Games Public Status",
      "url": "https://status.epicgames.com/",
      "text": "Recent official incidents and maintenance history for Epic services."
    },
    {
      "source": "Epic Games Launcher Support",
      "url": "https://www.epicgames.com/help/c-202300000001639/c-202300000001735/update-the-epic-games-launcher-a202300000020032",
      "text": "Official instructions for updating the Epic Games Launcher."
    },
    {
      "source": "Epic Developer Recent Updates",
      "url": "https://dev.epicgames.com/docs/epic-games-store/whats-new/recent-updates",
      "text": "Official Epic Games Store developer recent updates."
    }
  ],
  "securityCriticality": {
    "level": "low",
    "label": "No specific security advisory captured",
    "cves": []
  },
  "scraperGap": true,
  "ratingTest": {
    "score": 5.4,
    "label": "mixed/caution",
    "recommendation": "review before installing",
    "notes": [
      "Official/vendor source attached.",
      "1 risk factor(s) attached.",
      "1 known issue(s) attached.",
      "Scraper coverage gap exists."
    ]
  }
}
```
// Snapshot of Steam games whose trailing 30-day average exceeded 15,000
// concurrent players when reviewed on 2026-08-15. Runtime ingestion uses only
// Valve's public ISteamNews endpoint; SteamCharts is not called in production.
// Non-game utilities, mod loaders, test apps, and advertising entries are excluded.

'use strict';

const STEAM_GAME_CANDIDATE_SNAPSHOT = Object.freeze({
  observedAt: '2026-08-15',
  minimumAveragePlayers: 15000,
  source: 'https://steamcharts.com/top',
});

const STEAM_GAME_CANDIDATES = Object.freeze([
  {
    "appId": 730,
    "name": "Counter-Strike 2",
    "averagePlayers": 846236
  },
  {
    "appId": 570,
    "name": "Dota 2",
    "averagePlayers": 585714
  },
  {
    "appId": 578080,
    "name": "PUBG: BATTLEGROUNDS",
    "averagePlayers": 339602
  },
  {
    "appId": 1623730,
    "name": "Palworld",
    "averagePlayers": 460943
  },
  {
    "appId": 1172470,
    "name": "Apex Legends™",
    "averagePlayers": 116242
  },
  {
    "appId": 3419430,
    "name": "Bongo Cat",
    "averagePlayers": 149067
  },
  {
    "appId": 252490,
    "name": "Rust",
    "averagePlayers": 105874
  },
  {
    "appId": 2507950,
    "name": "Delta Force",
    "averagePlayers": 69741
  },
  {
    "appId": 3678970,
    "name": "TBH: Task Bar Hero",
    "averagePlayers": 179680
  },
  {
    "appId": 250900,
    "name": "The Binding of Isaac: Rebirth",
    "averagePlayers": 85846
  },
  {
    "appId": 413150,
    "name": "Stardew Valley",
    "averagePlayers": 66266
  },
  {
    "appId": 553850,
    "name": "HELLDIVERS™ 2",
    "averagePlayers": 33218
  },
  {
    "appId": 3527290,
    "name": "PEAK",
    "averagePlayers": 21918
  },
  {
    "appId": 2868840,
    "name": "Slay the Spire 2",
    "averagePlayers": 66040
  },
  {
    "appId": 108600,
    "name": "Project Zomboid",
    "averagePlayers": 55909
  },
  {
    "appId": 3405690,
    "name": "EA SPORTS FC™ 26",
    "averagePlayers": 95862
  },
  {
    "appId": 271590,
    "name": "Grand Theft Auto V Legacy",
    "averagePlayers": 66729
  },
  {
    "appId": 3240220,
    "name": "Grand Theft Auto V Enhanced",
    "averagePlayers": 67294
  },
  {
    "appId": 1203220,
    "name": "NARAKA: BLADEPOINT",
    "averagePlayers": 38072
  },
  {
    "appId": 236390,
    "name": "War Thunder",
    "averagePlayers": 50935
  },
  {
    "appId": 381210,
    "name": "Dead by Daylight",
    "averagePlayers": 62746
  },
  {
    "appId": 230410,
    "name": "Warframe",
    "averagePlayers": 58843
  },
  {
    "appId": 2357570,
    "name": "Overwatch®",
    "averagePlayers": 51600
  },
  {
    "appId": 2767030,
    "name": "Marvel Rivals",
    "averagePlayers": 85930
  },
  {
    "appId": 1091500,
    "name": "Cyberpunk 2077",
    "averagePlayers": 49744
  },
  {
    "appId": 1086940,
    "name": "Baldur's Gate 3",
    "averagePlayers": 48237
  },
  {
    "appId": 359550,
    "name": "Tom Clancy's Rainbow Six Siege",
    "averagePlayers": 56351
  },
  {
    "appId": 440,
    "name": "Team Fortress 2",
    "averagePlayers": 51467
  },
  {
    "appId": 322330,
    "name": "Don't Starve Together",
    "averagePlayers": 32211
  },
  {
    "appId": 394360,
    "name": "Hearts of Iron IV",
    "averagePlayers": 39167
  },
  {
    "appId": 438100,
    "name": "VRChat",
    "averagePlayers": 47632
  },
  {
    "appId": 238960,
    "name": "Path of Exile",
    "averagePlayers": 51801
  },
  {
    "appId": 2807960,
    "name": "Battlefield™ 6",
    "averagePlayers": 44566
  },
  {
    "appId": 289070,
    "name": "Sid Meier’s Civilization® VI",
    "averagePlayers": 30888
  },
  {
    "appId": 3551340,
    "name": "Football Manager 26",
    "averagePlayers": 32465
  },
  {
    "appId": 322170,
    "name": "Geometry Dash",
    "averagePlayers": 45034
  },
  {
    "appId": 221100,
    "name": "DayZ",
    "averagePlayers": 37169
  },
  {
    "appId": 3932890,
    "name": "Escape from Tarkov",
    "averagePlayers": 23750
  },
  {
    "appId": 261550,
    "name": "Mount & Blade II: Bannerlord",
    "averagePlayers": 26129
  },
  {
    "appId": 227300,
    "name": "Euro Truck Simulator 2",
    "averagePlayers": 28056
  },
  {
    "appId": 1142710,
    "name": "Total War: WARHAMMER III",
    "averagePlayers": 23244
  },
  {
    "appId": 105600,
    "name": "Terraria",
    "averagePlayers": 29784
  },
  {
    "appId": 2300320,
    "name": "Farming Simulator 25",
    "averagePlayers": 26330
  },
  {
    "appId": 251570,
    "name": "7 Days to Die",
    "averagePlayers": 29567
  },
  {
    "appId": 1245620,
    "name": "ELDEN RING",
    "averagePlayers": 28852
  },
  {
    "appId": 294100,
    "name": "RimWorld",
    "averagePlayers": 28322
  },
  {
    "appId": 1174180,
    "name": "Red Dead Redemption 2",
    "averagePlayers": 29996
  },
  {
    "appId": 1973530,
    "name": "Limbus Company",
    "averagePlayers": 33648
  },
  {
    "appId": 1364780,
    "name": "Street Fighter™ 6",
    "averagePlayers": 18894
  },
  {
    "appId": 2073620,
    "name": "Arena Breakout: Infinite",
    "averagePlayers": 24827
  },
  {
    "appId": 489830,
    "name": "The Elder Scrolls V: Skyrim Special Edition",
    "averagePlayers": 26827
  },
  {
    "appId": 2399830,
    "name": "ARK: Survival Ascended",
    "averagePlayers": 28181
  },
  {
    "appId": 2622380,
    "name": "ELDEN RING NIGHTREIGN",
    "averagePlayers": 17090
  },
  {
    "appId": 4000,
    "name": "Garry's Mod",
    "averagePlayers": 26434
  },
  {
    "appId": 550,
    "name": "Left 4 Dead 2",
    "averagePlayers": 27217
  },
  {
    "appId": 218620,
    "name": "PAYDAY 2",
    "averagePlayers": 29478
  },
  {
    "appId": 1938090,
    "name": "Call of Duty®",
    "averagePlayers": 28580
  },
  {
    "appId": 1222670,
    "name": "The Sims™ 4",
    "averagePlayers": 25290
  },
  {
    "appId": 2483190,
    "name": "Forza Horizon 6",
    "averagePlayers": 24396
  },
  {
    "appId": 1085660,
    "name": "Destiny 2",
    "averagePlayers": 35985
  },
  {
    "appId": 1158310,
    "name": "Crusader Kings III",
    "averagePlayers": 20018
  },
  {
    "appId": 3241660,
    "name": "R.E.P.O.",
    "averagePlayers": 24025
  },
  {
    "appId": 1665460,
    "name": "eFootball™",
    "averagePlayers": 20497
  },
  {
    "appId": 3472040,
    "name": "NBA 2K26",
    "averagePlayers": 20772
  },
  {
    "appId": 582660,
    "name": "Black Desert",
    "averagePlayers": 20457
  },
  {
    "appId": 346110,
    "name": "ARK: Survival Evolved",
    "averagePlayers": 19033
  },
  {
    "appId": 594650,
    "name": "Hunt: Showdown 1896",
    "averagePlayers": 15910
  },
  {
    "appId": 284160,
    "name": "BeamNG.drive",
    "averagePlayers": 22330
  },
  {
    "appId": 582010,
    "name": "Monster Hunter: World",
    "averagePlayers": 15785
  },
  {
    "appId": 2694490,
    "name": "Path of Exile 2",
    "averagePlayers": 28732
  },
  {
    "appId": 2246340,
    "name": "Monster Hunter Wilds",
    "averagePlayers": 15333
  },
  {
    "appId": 427520,
    "name": "Factorio",
    "averagePlayers": 17531
  },
  {
    "appId": 813780,
    "name": "Age of Empires II: Definitive Edition",
    "averagePlayers": 17145
  },
  {
    "appId": 1808500,
    "name": "ARC Raiders",
    "averagePlayers": 26557
  },
  {
    "appId": 292030,
    "name": "The Witcher 3: Wild Hunt",
    "averagePlayers": 15675
  },
  {
    "appId": 39210,
    "name": "FINAL FANTASY XIV Online",
    "averagePlayers": 20357
  },
  {
    "appId": 2252570,
    "name": "Football Manager 2024",
    "averagePlayers": 15214
  },
  {
    "appId": 526870,
    "name": "Satisfactory",
    "averagePlayers": 17985
  },
  {
    "appId": 892970,
    "name": "Valheim",
    "averagePlayers": 17366
  },
  {
    "appId": 881020,
    "name": "Granblue Fantasy: Relink",
    "averagePlayers": 22129
  },
  {
    "appId": 252950,
    "name": "Rocket League®",
    "averagePlayers": 16189
  }
].map(Object.freeze));

module.exports = { STEAM_GAME_CANDIDATE_SNAPSHOT, STEAM_GAME_CANDIDATES };

// Active game follows must use the same strict eligibility policy as backend
// ingestion. The historical global snapshot remains audit-only below.
export const STEAM_GAME_CANDIDATE_META = Object.freeze({
  "region": "US",
  "windowDays": 14,
  "minimumAveragePlayers": 60000,
  "comparison": "strictly-greater-than",
  "eligibilityDataAvailable": false
});

export const STEAM_GAME_AUDIT_CANDIDATES = Object.freeze([
  {
    "appId": "730",
    "name": "Counter-Strike 2",
    "averagePlayers": 846236,
    "tags": "counter-strike 2"
  },
  {
    "appId": "570",
    "name": "Dota 2",
    "averagePlayers": 585714,
    "tags": "dota 2"
  },
  {
    "appId": "578080",
    "name": "PUBG: BATTLEGROUNDS",
    "averagePlayers": 339602,
    "tags": "pubg: battlegrounds"
  },
  {
    "appId": "1623730",
    "name": "Palworld",
    "averagePlayers": 460943,
    "tags": "palworld"
  },
  {
    "appId": "1172470",
    "name": "Apex Legends™",
    "averagePlayers": 116242,
    "tags": "apex legends™"
  },
  {
    "appId": "3419430",
    "name": "Bongo Cat",
    "averagePlayers": 149067,
    "tags": "bongo cat"
  },
  {
    "appId": "252490",
    "name": "Rust",
    "averagePlayers": 105874,
    "tags": "rust"
  },
  {
    "appId": "2507950",
    "name": "Delta Force",
    "averagePlayers": 69741,
    "tags": "delta force"
  },
  {
    "appId": "3678970",
    "name": "TBH: Task Bar Hero",
    "averagePlayers": 179680,
    "tags": "tbh: task bar hero"
  },
  {
    "appId": "250900",
    "name": "The Binding of Isaac: Rebirth",
    "averagePlayers": 85846,
    "tags": "the binding of isaac: rebirth"
  },
  {
    "appId": "413150",
    "name": "Stardew Valley",
    "averagePlayers": 66266,
    "tags": "stardew valley"
  },
  {
    "appId": "553850",
    "name": "HELLDIVERS™ 2",
    "averagePlayers": 33218,
    "tags": "helldivers™ 2"
  },
  {
    "appId": "3527290",
    "name": "PEAK",
    "averagePlayers": 21918,
    "tags": "peak"
  },
  {
    "appId": "2868840",
    "name": "Slay the Spire 2",
    "averagePlayers": 66040,
    "tags": "slay the spire 2"
  },
  {
    "appId": "108600",
    "name": "Project Zomboid",
    "averagePlayers": 55909,
    "tags": "project zomboid"
  },
  {
    "appId": "3405690",
    "name": "EA SPORTS FC™ 26",
    "averagePlayers": 95862,
    "tags": "ea sports fc™ 26"
  },
  {
    "appId": "271590",
    "name": "Grand Theft Auto V Legacy",
    "averagePlayers": 66729,
    "tags": "grand theft auto v legacy"
  },
  {
    "appId": "3240220",
    "name": "Grand Theft Auto V Enhanced",
    "averagePlayers": 67294,
    "tags": "grand theft auto v enhanced"
  },
  {
    "appId": "1203220",
    "name": "NARAKA: BLADEPOINT",
    "averagePlayers": 38072,
    "tags": "naraka: bladepoint"
  },
  {
    "appId": "236390",
    "name": "War Thunder",
    "averagePlayers": 50935,
    "tags": "war thunder"
  },
  {
    "appId": "381210",
    "name": "Dead by Daylight",
    "averagePlayers": 62746,
    "tags": "dead by daylight"
  },
  {
    "appId": "230410",
    "name": "Warframe",
    "averagePlayers": 58843,
    "tags": "warframe"
  },
  {
    "appId": "2357570",
    "name": "Overwatch®",
    "averagePlayers": 51600,
    "tags": "overwatch®"
  },
  {
    "appId": "2767030",
    "name": "Marvel Rivals",
    "averagePlayers": 85930,
    "tags": "marvel rivals"
  },
  {
    "appId": "1091500",
    "name": "Cyberpunk 2077",
    "averagePlayers": 49744,
    "tags": "cyberpunk 2077"
  },
  {
    "appId": "1086940",
    "name": "Baldur's Gate 3",
    "averagePlayers": 48237,
    "tags": "baldur's gate 3"
  },
  {
    "appId": "359550",
    "name": "Tom Clancy's Rainbow Six Siege",
    "averagePlayers": 56351,
    "tags": "tom clancy's rainbow six siege"
  },
  {
    "appId": "440",
    "name": "Team Fortress 2",
    "averagePlayers": 51467,
    "tags": "team fortress 2"
  },
  {
    "appId": "322330",
    "name": "Don't Starve Together",
    "averagePlayers": 32211,
    "tags": "don't starve together"
  },
  {
    "appId": "394360",
    "name": "Hearts of Iron IV",
    "averagePlayers": 39167,
    "tags": "hearts of iron iv"
  },
  {
    "appId": "438100",
    "name": "VRChat",
    "averagePlayers": 47632,
    "tags": "vrchat"
  },
  {
    "appId": "238960",
    "name": "Path of Exile",
    "averagePlayers": 51801,
    "tags": "path of exile"
  },
  {
    "appId": "2807960",
    "name": "Battlefield™ 6",
    "averagePlayers": 44566,
    "tags": "battlefield™ 6"
  },
  {
    "appId": "289070",
    "name": "Sid Meier’s Civilization® VI",
    "averagePlayers": 30888,
    "tags": "sid meier’s civilization® vi"
  },
  {
    "appId": "3551340",
    "name": "Football Manager 26",
    "averagePlayers": 32465,
    "tags": "football manager 26"
  },
  {
    "appId": "322170",
    "name": "Geometry Dash",
    "averagePlayers": 45034,
    "tags": "geometry dash"
  },
  {
    "appId": "221100",
    "name": "DayZ",
    "averagePlayers": 37169,
    "tags": "dayz"
  },
  {
    "appId": "3932890",
    "name": "Escape from Tarkov",
    "averagePlayers": 23750,
    "tags": "escape from tarkov"
  },
  {
    "appId": "261550",
    "name": "Mount & Blade II: Bannerlord",
    "averagePlayers": 26129,
    "tags": "mount & blade ii: bannerlord"
  },
  {
    "appId": "227300",
    "name": "Euro Truck Simulator 2",
    "averagePlayers": 28056,
    "tags": "euro truck simulator 2"
  },
  {
    "appId": "1142710",
    "name": "Total War: WARHAMMER III",
    "averagePlayers": 23244,
    "tags": "total war: warhammer iii"
  },
  {
    "appId": "105600",
    "name": "Terraria",
    "averagePlayers": 29784,
    "tags": "terraria"
  },
  {
    "appId": "2300320",
    "name": "Farming Simulator 25",
    "averagePlayers": 26330,
    "tags": "farming simulator 25"
  },
  {
    "appId": "251570",
    "name": "7 Days to Die",
    "averagePlayers": 29567,
    "tags": "7 days to die"
  },
  {
    "appId": "1245620",
    "name": "ELDEN RING",
    "averagePlayers": 28852,
    "tags": "elden ring"
  },
  {
    "appId": "294100",
    "name": "RimWorld",
    "averagePlayers": 28322,
    "tags": "rimworld"
  },
  {
    "appId": "1174180",
    "name": "Red Dead Redemption 2",
    "averagePlayers": 29996,
    "tags": "red dead redemption 2"
  },
  {
    "appId": "1973530",
    "name": "Limbus Company",
    "averagePlayers": 33648,
    "tags": "limbus company"
  },
  {
    "appId": "1364780",
    "name": "Street Fighter™ 6",
    "averagePlayers": 18894,
    "tags": "street fighter™ 6"
  },
  {
    "appId": "2073620",
    "name": "Arena Breakout: Infinite",
    "averagePlayers": 24827,
    "tags": "arena breakout: infinite"
  },
  {
    "appId": "489830",
    "name": "The Elder Scrolls V: Skyrim Special Edition",
    "averagePlayers": 26827,
    "tags": "the elder scrolls v: skyrim special edition"
  },
  {
    "appId": "2399830",
    "name": "ARK: Survival Ascended",
    "averagePlayers": 28181,
    "tags": "ark: survival ascended"
  },
  {
    "appId": "2622380",
    "name": "ELDEN RING NIGHTREIGN",
    "averagePlayers": 17090,
    "tags": "elden ring nightreign"
  },
  {
    "appId": "4000",
    "name": "Garry's Mod",
    "averagePlayers": 26434,
    "tags": "garry's mod"
  },
  {
    "appId": "550",
    "name": "Left 4 Dead 2",
    "averagePlayers": 27217,
    "tags": "left 4 dead 2"
  },
  {
    "appId": "218620",
    "name": "PAYDAY 2",
    "averagePlayers": 29478,
    "tags": "payday 2"
  },
  {
    "appId": "1938090",
    "name": "Call of Duty®",
    "averagePlayers": 28580,
    "tags": "call of duty®"
  },
  {
    "appId": "1222670",
    "name": "The Sims™ 4",
    "averagePlayers": 25290,
    "tags": "the sims™ 4"
  },
  {
    "appId": "2483190",
    "name": "Forza Horizon 6",
    "averagePlayers": 24396,
    "tags": "forza horizon 6"
  },
  {
    "appId": "1085660",
    "name": "Destiny 2",
    "averagePlayers": 35985,
    "tags": "destiny 2"
  },
  {
    "appId": "1158310",
    "name": "Crusader Kings III",
    "averagePlayers": 20018,
    "tags": "crusader kings iii"
  },
  {
    "appId": "3241660",
    "name": "R.E.P.O.",
    "averagePlayers": 24025,
    "tags": "r.e.p.o."
  },
  {
    "appId": "1665460",
    "name": "eFootball™",
    "averagePlayers": 20497,
    "tags": "efootball™"
  },
  {
    "appId": "3472040",
    "name": "NBA 2K26",
    "averagePlayers": 20772,
    "tags": "nba 2k26"
  },
  {
    "appId": "582660",
    "name": "Black Desert",
    "averagePlayers": 20457,
    "tags": "black desert"
  },
  {
    "appId": "346110",
    "name": "ARK: Survival Evolved",
    "averagePlayers": 19033,
    "tags": "ark: survival evolved"
  },
  {
    "appId": "594650",
    "name": "Hunt: Showdown 1896",
    "averagePlayers": 15910,
    "tags": "hunt: showdown 1896"
  },
  {
    "appId": "284160",
    "name": "BeamNG.drive",
    "averagePlayers": 22330,
    "tags": "beamng.drive"
  },
  {
    "appId": "582010",
    "name": "Monster Hunter: World",
    "averagePlayers": 15785,
    "tags": "monster hunter: world"
  },
  {
    "appId": "2694490",
    "name": "Path of Exile 2",
    "averagePlayers": 28732,
    "tags": "path of exile 2"
  },
  {
    "appId": "2246340",
    "name": "Monster Hunter Wilds",
    "averagePlayers": 15333,
    "tags": "monster hunter wilds"
  },
  {
    "appId": "427520",
    "name": "Factorio",
    "averagePlayers": 17531,
    "tags": "factorio"
  },
  {
    "appId": "813780",
    "name": "Age of Empires II: Definitive Edition",
    "averagePlayers": 17145,
    "tags": "age of empires ii: definitive edition"
  },
  {
    "appId": "1808500",
    "name": "ARC Raiders",
    "averagePlayers": 26557,
    "tags": "arc raiders"
  },
  {
    "appId": "292030",
    "name": "The Witcher 3: Wild Hunt",
    "averagePlayers": 15675,
    "tags": "the witcher 3: wild hunt"
  },
  {
    "appId": "39210",
    "name": "FINAL FANTASY XIV Online",
    "averagePlayers": 20357,
    "tags": "final fantasy xiv online"
  },
  {
    "appId": "2252570",
    "name": "Football Manager 2024",
    "averagePlayers": 15214,
    "tags": "football manager 2024"
  },
  {
    "appId": "526870",
    "name": "Satisfactory",
    "averagePlayers": 17985,
    "tags": "satisfactory"
  },
  {
    "appId": "892970",
    "name": "Valheim",
    "averagePlayers": 17366,
    "tags": "valheim"
  },
  {
    "appId": "881020",
    "name": "Granblue Fantasy: Relink",
    "averagePlayers": 22129,
    "tags": "granblue fantasy: relink"
  },
  {
    "appId": "252950",
    "name": "Rocket League®",
    "averagePlayers": 16189,
    "tags": "rocket league®"
  }
].map(Object.freeze));

// Fail closed: global/30-day values are never exposed as eligible US/14-day
// games. Populate only from an approved regional snapshot carrying per-row
// source evidence.
export const STEAM_GAME_CANDIDATES = Object.freeze([]);

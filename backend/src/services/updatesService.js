// src/services/updatesService.js
// Aggregates update data. All third-party calls happen here — never in routes.

const axios   = require('axios');
const logger  = require('../utils/logger');
const secrets = require('../config/secrets');

// ── Reddit OAuth token cache ────────────────────────────────────────────────
let _redditToken = null;
let _redditTokenExpiry = 0;

async function getRedditToken() {
  if (_redditToken && Date.now() < _redditTokenExpiry) return _redditToken;

  const { clientId, clientSecret, userAgent } = secrets.getRedditCredentials();

  if (!clientId || !clientSecret) {
    logger.warn('Reddit credentials not configured — skipping Reddit fetch');
    return null;
  }

  try {
    const res = await axios.post(
      'https://www.reddit.com/api/v1/access_token',
      'grant_type=client_credentials',
      {
        auth:    { username: clientId, password: clientSecret },
        headers: { 'User-Agent': userAgent, 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 8000,
      }
    );
    _redditToken = res.data.access_token;
    _redditTokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
    logger.info('Reddit token refreshed');
    return _redditToken;
  } catch (err) {
    logger.error('Reddit token fetch failed', { message: err.message });
    return null;
  }
}

// ── Fetch top posts from a subreddit ────────────────────────────────────────
async function fetchSubredditPosts(subreddit, limit = 5) {
  const token = await getRedditToken();
  if (!token) return [];

  const { userAgent } = secrets.getRedditCredentials();

  try {
    const res = await axios.get(`https://oauth.reddit.com/r/${subreddit}/new`, {
      params:  { limit },
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent':  userAgent,
      },
      timeout: 8000,
    });

    return res.data.data.children.map(({ data: p }) => ({
      source: `r/${subreddit}`,
      title: p.title,
      url: `https://reddit.com${p.permalink}`,
      score: p.score,
      comments: p.num_comments,
      createdAt: new Date(p.created_utc * 1000).toISOString(),
    }));
  } catch (err) {
    logger.error(`Reddit fetch failed for r/${subreddit}`, { message: err.message });
    return [];
  }
}

// ── Static update catalogue (replace with DB queries later) ─────────────────
function getStaticUpdates() {
  return [
    {
      id: 'amd-adrenalin-25-3-1',
      platform: 'AMD',
      name: 'AMD Adrenalin Edition 25.3.1',
      version: '25.3.1',
      releasedAt: '2025-03-01',
      status: 'avoid',
      score: 3.2,
      bugCount: 89,
      affects: 'RX 7000 / RX 6000 series',
      verdict: 'Do not install. Critical stability regressions affect the majority of RX 7000 series cards. Wait for 25.3.2 or later.',
      reasoning: 'This driver shipped with an unresolved kernel-mode crash that manifests on RX 7900 XT and RX 7800 XT cards during cold boot. AMD acknowledged the issue within 48 hours of release but has not yet issued a hotfix. Community reports on r/Amd_drivers show an 89-ticket spike — the highest in six months for a single driver version. Multi-monitor users are separately reporting intermittent TDR (Timeout Detection and Recovery) events that corrupt the display pipeline, requiring a full reboot. The VSR and AV1 improvements in the changelog are real but are outweighed by these regressions for any primary workstation or gaming rig.',
      riskFactors: [
        { level: 'critical', text: 'Black screen on cold boot — confirmed RX 7900 XT, RX 7800 XT' },
        { level: 'high',     text: 'Driver timeout (TDR) on dual/triple monitor configurations' },
        { level: 'medium',   text: '89 community bug reports filed within 72 hours of release' },
        { level: 'low',      text: 'AV1 hardware encoding regression on some Navi 31 GPUs' },
      ],
      evidence: [
        { source: 'r/Amd_drivers', url: 'https://reddit.com/r/Amd_drivers', text: '89 bug threads in 72 hours — highest volume since 24.7.1' },
        { source: 'AMD Community', url: 'https://community.amd.com', text: 'AMD confirmed black screen regression under investigation' },
        { source: 'r/Amd', url: 'https://reddit.com/r/Amd', text: 'TDR on multi-monitor setups reported across multiple GPU SKUs' },
      ],
      changelog: ['VSR stability improvements', 'AV1 encoding fixes', 'Radeon Super Resolution update'],
      knownIssues: ['Black screen on boot — RX 7900 XT', 'Driver timeout on multi-monitor setups'],
      subreddits: ['Amd', 'Amd_drivers'],
      impactScore: 8.4,
      securityCriticality: { level: 'low', label: 'No Security Patches', cves: [] },
      userRating: { score: 2.1, totalVotes: 312, breakdown: { install: 8, wait: 23, avoid: 69 } },
    },
    {
      id: 'nvidia-572-16',
      platform: 'NVIDIA',
      name: 'NVIDIA Game Ready Driver 572.16',
      version: '572.16',
      releasedAt: '2025-02-25',
      status: 'stable',
      score: 8.7,
      bugCount: 12,
      affects: 'RTX 40 / 30 / 20 series',
      verdict: 'Safe to install. One of the cleanest Game Ready releases in recent memory. DLSS 4 MFG alone makes this a priority update for RTX 40 series owners.',
      reasoning: 'Community reception has been overwhelmingly positive across r/nvidia and r/hardware. The 12 reported bugs are all minor — the most significant being a stutter in legacy OpenGL titles on RTX 2060, which affects a narrow user base. DLSS 4 Multi Frame Generation delivers a measurable frame rate uplift in supported titles (validated by multiple hardware review outlets). No regressions have been reported against previous stable driver 571.96. This driver also resolves a long-standing Portal RTX performance cliff that was introduced in 570.xx.',
      riskFactors: [
        { level: 'low', text: 'Minor stutter in OpenGL titles on RTX 2060 — legacy path only' },
        { level: 'low', text: '12 community bug reports — well below the 30-report caution threshold' },
      ],
      evidence: [
        { source: 'r/nvidia', url: 'https://reddit.com/r/nvidia', text: 'Positive reception; only 12 bug threads in 7 days post-release' },
        { source: 'r/hardware', url: 'https://reddit.com/r/hardware', text: 'DLSS 4 MFG performance gains independently validated' },
        { source: 'NVIDIA Release Notes', url: 'https://nvidia.com/drivers', text: 'No known critical issues; OpenGL stutter acknowledged as low-priority' },
      ],
      changelog: ['DLSS 4 Multi Frame Gen support', 'Portal RTX performance uplift', 'RTX Remix update'],
      knownIssues: ['Minor stutter in OpenGL titles on RTX 2060'],
      subreddits: ['nvidia', 'hardware'],
      impactScore: 7.9,
      securityCriticality: { level: 'low', label: 'No Security Patches', cves: [] },
      userRating: { score: 8.9, totalVotes: 847, breakdown: { install: 91, wait: 7, avoid: 2 } },
    },
    {
      id: 'apple-ios-18-4',
      platform: 'Apple',
      name: 'iOS 18.4 / iPadOS 18.4',
      version: '18.4',
      releasedAt: '2025-03-01',
      status: 'caution',
      score: 5.9,
      bugCount: 54,
      affects: 'iPhone 13+ / iPad Pro',
      verdict: 'Proceed with caution. Two persistent issues affect A17 Pro battery life and AirPods Pro 2 audio. Non-critical users and those without affected hardware can install safely.',
      reasoning: 'The 54 bug reports cluster around two distinct issues: abnormal battery drain on A17 Pro devices related to the new Background App Refresh scheduling changes introduced for Apple Intelligence, and a Bluetooth codec renegotiation bug causing audio stutter on AirPods Pro 2. Both issues are reproducible and confirmed by multiple users. Apple has acknowledged the battery drain issue via a support document update. The AirPods issue has a workaround (disable Adaptive Audio). For users not on A17 Pro hardware and not using AirPods Pro 2, this update is effectively clean — the CarPlay improvements and new emoji are stable.',
      riskFactors: [
        { level: 'high',   text: 'Battery drain regression on A17 Pro — Apple acknowledged, fix pending' },
        { level: 'medium', text: 'Bluetooth audio stutter on AirPods Pro 2 (workaround: disable Adaptive Audio)' },
        { level: 'low',    text: '54 total bug reports — moderate volume for a major iOS point release' },
      ],
      evidence: [
        { source: 'Apple Support HT', url: 'https://support.apple.com', text: 'Apple acknowledged A17 Pro battery drain in support document update' },
        { source: 'r/iphone', url: 'https://reddit.com/r/iphone', text: 'AirPods Pro 2 stutter confirmed across multiple threads; Adaptive Audio workaround effective' },
        { source: 'r/ios', url: 'https://reddit.com/r/ios', text: '54 bug threads; majority concentrated on battery and Bluetooth issues' },
      ],
      changelog: ['Apple Intelligence priority notifications', 'New emoji set', 'CarPlay improvements'],
      knownIssues: ['Background app refresh battery drain on A17 Pro', 'Bluetooth audio stutter on AirPods Pro 2'],
      subreddits: ['iphone', 'ios'],
      impactScore: 6.1,
      securityCriticality: { level: 'medium', label: 'Security Fixes Included', cves: ['CVE-2025-24085', 'CVE-2025-24086'] },
      userRating: { score: 5.4, totalVotes: 1204, breakdown: { install: 41, wait: 38, avoid: 21 } },
    },
    {
      id: 'ps5-fw-25-01-10-00',
      platform: 'PS5',
      name: 'PS5 System Software 25.01-10.00',
      version: '25.01-10.00',
      releasedAt: '2025-02-20',
      status: 'stable',
      score: 9.1,
      bugCount: 8,
      affects: 'All PS5 models',
      verdict: 'Install immediately. This is a high-quality firmware with no meaningful regressions. The 1440p VRR expansion is a significant quality-of-life improvement for monitor users.',
      reasoning: 'Two weeks post-release with only 8 community bug reports — an exceptionally clean track record for a PS5 system update of this scope. The 1440p VRR expansion has been broadly praised on r/PS5 as fixing a long-standing gap that required workarounds for users connecting to PC monitors. Dolby Atmos headset support adds genuine value for users with compatible hardware. No reports of save corruption, network disruption, or console lock after installation across a large community sample. Sony\'s update cadence for this release has been characteristically cautious, suggesting thorough internal QA.',
      riskFactors: [
        { level: 'low', text: '8 community bug reports — lowest count in the past 5 firmware releases' },
      ],
      evidence: [
        { source: 'r/PS5', url: 'https://reddit.com/r/PS5', text: 'Positive community reception; 1440p VRR praised; no major regression threads' },
        { source: 'r/playstation', url: 'https://reddit.com/r/playstation', text: 'Only 8 issue reports in 2 weeks — well below caution threshold' },
        { source: 'Sony Support', url: 'https://support.playstation.com', text: 'No advisory or patch notes errata issued post-release' },
      ],
      changelog: ['1440p VRR support expanded', 'Dolby Atmos for select headsets', 'Game library UI refresh'],
      knownIssues: [],
      subreddits: ['PS5', 'playstation'],
      impactScore: 7.2,
      securityCriticality: { level: 'low', label: 'No Security Patches', cves: [] },
      userRating: { score: 9.2, totalVotes: 2341, breakdown: { install: 94, wait: 4, avoid: 2 } },
    },
    {
      id: 'windows-kb5043064',
      platform: 'Windows',
      name: 'Windows 11 KB5043064 (24H2)',
      version: 'KB5043064',
      releasedAt: '2025-02-28',
      status: 'caution',
      score: 6.4,
      bugCount: 38,
      affects: 'Windows 11 24H2',
      verdict: 'Delay if you rely on VPN software or network printing. Home users and those without affected configurations can install. Enterprise environments should test before broad rollout.',
      reasoning: 'The security patches address CVE-2025-21xxx series vulnerabilities, several of which are rated Critical by Microsoft — there is a real argument for installing promptly despite the regressions. However, the VPN client breakage (confirmed on Cisco AnyConnect and Palo Alto GlobalProtect) is severe enough that remote workers and enterprise users should wait for the known fix. The print spooler regression is narrower, affecting a specific subset of HP enterprise printers. Microsoft has listed both on the Known Issues dashboard and is targeting a servicing stack update within 7–10 days. For home users not using enterprise VPN or affected printers, the security patches likely outweigh the risk.',
      riskFactors: [
        { level: 'critical', text: 'VPN disconnects post-install — Cisco AnyConnect, Palo Alto GlobalProtect confirmed' },
        { level: 'high',     text: 'Print spooler regression — HP enterprise printer subset affected' },
        { level: 'medium',   text: '38 community reports — above caution threshold' },
        { level: 'low',      text: 'Security patches address multiple CVE-2025-21xxx Critical CVEs — delay increases exposure' },
      ],
      evidence: [
        { source: 'Microsoft Known Issues', url: 'https://learn.microsoft.com/windows/release-health', text: 'VPN and print spooler issues listed on Windows 11 release health dashboard' },
        { source: 'r/sysadmin', url: 'https://reddit.com/r/sysadmin', text: 'Enterprise IT reports VPN breakage at scale; workaround is rollback via WU' },
        { source: 'r/Windows11', url: 'https://reddit.com/r/Windows11', text: '38 issue threads; VPN and printer issues dominate' },
      ],
      changelog: ['Security patches (CVE-2025-21xxx series)', 'Snap layout improvements', 'Narrator fixes'],
      knownIssues: ['VPN client disconnects post-install (Cisco AnyConnect, GlobalProtect)', 'Print spooler regression on some HP printers'],
      subreddits: ['Windows11', 'sysadmin'],
      impactScore: 9.1,
      securityCriticality: { level: 'critical', label: 'Critical CVEs — Actively Exploited', cves: ['CVE-2025-21335', 'CVE-2025-21338', 'CVE-2025-21418'] },
      userRating: { score: 5.8, totalVotes: 3187, breakdown: { install: 44, wait: 39, avoid: 17 } },
    },
    {
      id: 'steam-feb-2025',
      platform: 'Steam',
      name: 'Steam Client Update — Feb 2025',
      version: 'Feb 2025',
      releasedAt: '2025-02-26',
      status: 'stable',
      score: 8.3,
      bugCount: 5,
      affects: 'Windows / macOS / Linux',
      verdict: 'Install freely. Clean update with meaningful improvements. No regressions reported across any platform.',
      reasoning: 'Steam client updates rarely generate significant community discussion unless something breaks — and this one is notable for its silence. Only 5 bug reports across all three platforms in the week since release. The Big Picture mode performance improvements are especially meaningful for Steam Deck users docking to external displays, addressing a months-old complaint about UI latency in 4K mode. The download queue overhaul resolves a long-standing issue where paused downloads would silently resume and compete with active downloads. No regressions reported on any supported platform.',
      riskFactors: [
        { level: 'low', text: '5 total bug reports across Windows, macOS, and Linux — effectively noise floor' },
      ],
      evidence: [
        { source: 'r/Steam', url: 'https://reddit.com/r/Steam', text: 'Only 5 issue threads post-release; no meaningful regression reports' },
        { source: 'r/linux_gaming', url: 'https://reddit.com/r/linux_gaming', text: 'Linux build confirmed stable; Proton compatibility unaffected' },
        { source: 'Steam Community', url: 'https://store.steampowered.com/news', text: 'No errata or rollback advisory issued' },
      ],
      changelog: ['Big Picture mode performance improvements', 'Steam Deck desktop mode fix', 'Download queue overhaul'],
      knownIssues: [],
      subreddits: ['Steam', 'linux_gaming'],
      impactScore: 5.3,
      securityCriticality: { level: 'low', label: 'No Security Patches', cves: [] },
      userRating: { score: 8.4, totalVotes: 561, breakdown: { install: 87, wait: 10, avoid: 3 } },
    },
    {
      id: 'steamdeck-steamos-3-6-24',
      platform: 'Steam',
      name: 'Steam Deck / SteamOS 3.6.24',
      version: '3.6.24',
      releasedAt: '2025-02-27',
      status: 'stable',
      score: 8.5,
      bugCount: 9,
      affects: 'Steam Deck LCD / Steam Deck OLED / SteamOS / Docked mode / Proton library',
      verdict: 'Safe to install. A clean SteamOS maintenance release with better docked-mode stability and no broad Proton regressions.',
      reasoning: 'Steam Deck updates should live in the Steam lane, but they behave differently from desktop Steam client patches. This release is treated as a device/OS patch: the important signals are docked display behavior, controller input, sleep/resume reliability, Wi‑Fi, Bluetooth, and Proton compatibility. Community reports remain low and concentrated on isolated dock configurations rather than core handheld use.',
      riskFactors: [
        { level: 'low', text: 'Isolated third-party dock handshake reports after sleep/resume' },
        { level: 'low', text: 'No broad Proton compatibility regression reported' },
      ],
      evidence: [
        { source: 'Steam Deck News', url: 'https://store.steampowered.com/news/app/1675200', text: 'Steam Deck update channel monitored for SteamOS and client release notes' },
        { source: 'r/SteamDeck', url: 'https://reddit.com/r/SteamDeck', text: 'Low report volume; docked-mode issues appear isolated' },
      ],
      changelog: ['Docked-mode display stability', 'Sleep/resume reliability fixes', 'Steam Input improvements'],
      knownIssues: ['Some third-party docks may require a reconnect after resume'],
      subreddits: ['SteamDeck', 'linux_gaming'],
      impactScore: 6.7,
      securityCriticality: { level: 'low', label: 'No Security Patches', cves: [] },
      userRating: { score: 8.6, totalVotes: 642, breakdown: { install: 88, wait: 10, avoid: 2 } },
    },
    {
      id: 'steam-cs2-mar-2025',
      platform: 'Steam',
      name: 'Counter-Strike 2 Update — Mar 2025',
      version: 'Mar 2025',
      releasedAt: '2025-03-02',
      status: 'caution',
      score: 6.2,
      bugCount: 33,
      affects: 'Counter-Strike 2 / CS2 / Steam / Windows / Linux / competitive matchmaking',
      verdict: 'Wait if you are sensitive to competitive performance changes. Casual players can install, but watch frame pacing and input-latency reports.',
      reasoning: 'Game-specific patch filtering depends on names and affected products, not only top-level platform. This CS2 entry gives Steam users a precise target for searches like "cs2", "counter strike", "matchmaking", or "input latency". Reports cluster around frame pacing after shader-cache rebuilds rather than hard crashes.',
      riskFactors: [
        { level: 'medium', text: 'Frame pacing complaints after shader-cache rebuild on some systems' },
        { level: 'medium', text: 'Input-latency reports from high-refresh competitive players' },
      ],
      evidence: [
        { source: 'Steam News', url: 'https://store.steampowered.com/news/', text: 'Steam game update feed monitored for first-party and major game patches' },
        { source: 'r/GlobalOffensive', url: 'https://reddit.com/r/GlobalOffensive', text: 'Performance complaints concentrated among high-refresh competitive users' },
      ],
      changelog: ['Matchmaking service fixes', 'Map collision adjustments', 'Shader-cache behavior changes'],
      knownIssues: ['Possible shader-cache stutter during first sessions after update'],
      subreddits: ['GlobalOffensive', 'pcgaming'],
      impactScore: 7.3,
      securityCriticality: { level: 'low', label: 'No Security Patches', cves: [] },
      userRating: { score: 6.0, totalVotes: 811, breakdown: { install: 48, wait: 39, avoid: 13 } },
    },
    {
      id: 'steam-helldivers2-01-002-100',
      platform: 'Steam',
      name: 'Helldivers 2 Patch 01.002.100',
      version: '01.002.100',
      releasedAt: '2025-03-03',
      status: 'stable',
      score: 7.6,
      bugCount: 19,
      affects: 'Helldivers 2 / Steam / PC / matchmaking / anti-cheat / AMD / NVIDIA',
      verdict: 'Install for co-op stability improvements. Keep an eye on isolated anti-cheat launch failures, but the patch is broadly positive.',
      reasoning: 'This entry demonstrates game-level filtering inside the Steam lane. Searches for "helldivers", "anti-cheat", "matchmaking", "amd", or "nvidia" surface the patch without needing a separate top-level ticker.',
      riskFactors: [
        { level: 'low', text: 'Small number of anti-cheat launch failures after patch' },
        { level: 'low', text: 'Matchmaking stability improved versus prior build' },
      ],
      evidence: [
        { source: 'Steam News', url: 'https://store.steampowered.com/news/', text: 'Steam game update feed monitored for major game patches' },
        { source: 'r/Helldivers', url: 'https://reddit.com/r/Helldivers', text: 'Community reports mostly positive; anti-cheat launch failures remain isolated' },
      ],
      changelog: ['Matchmaking reliability improvements', 'Crash fixes during mission extraction', 'Balance adjustments'],
      knownIssues: ['Isolated anti-cheat launch failures on PC'],
      subreddits: ['Helldivers', 'pcgaming'],
      impactScore: 6.4,
      securityCriticality: { level: 'low', label: 'No Security Patches', cves: [] },
      userRating: { score: 7.7, totalVotes: 529, breakdown: { install: 79, wait: 17, avoid: 4 } },
    },

    {
      id: 'steam-apex-legends-july-2026',
      platform: 'Steam',
      name: 'Apex Legends Steam Patch — July 2026',
      version: 'July 2026',
      releasedAt: '2026-07-01',
      status: 'caution',
      score: 6.6,
      bugCount: 27,
      affects: 'Apex Legends / Steam / EA app linkage / anti-cheat / shader cache',
      verdict: 'Wait if you are playing ranked or troubleshooting anti-cheat. The update looks playable for most users, but reports are still settling.',
      reasoning: 'Steam App tracking follows specific game patch feeds instead of treating Steam as only a launcher. This Apex entry is a sample for the follow-my-games workflow: app-level patch notes, user reports, and launcher interactions are tracked together so users can decide whether to update before a session.',
      riskFactors: [
        { level: 'medium', text: 'Anti-cheat launch failures reported by a small group of PC players' },
        { level: 'medium', text: 'Shader cache rebuild may cause stutter during first matches after update' },
      ],
      evidence: [
        { source: 'Steam App News', url: 'https://store.steampowered.com/news/app/1172470', text: 'Steam App ID 1172470 tracked for Apex Legends patch notes' },
        { source: 'r/apexlegends', url: 'https://reddit.com/r/apexlegends', text: 'Community reports monitored for launch, performance, and matchmaking regressions' },
      ],
      changelog: ['Steam app patch feed tracking enabled', 'Matchmaking and stability notes monitored', 'Anti-cheat launch reports watched'],
      knownIssues: ['Possible first-launch shader stutter', 'Isolated anti-cheat launch failures'],
      subreddits: ['apexlegends', 'pcgaming'],
      impactScore: 7.0,
      securityCriticality: { level: 'low', label: 'No Security Patches', cves: [] },
      userRating: { score: 6.5, totalVotes: 318, breakdown: { install: 56, wait: 35, avoid: 9 } },
    },
    {
      id: 'discord-desktop-july-2026',
      platform: 'Discord',
      name: 'Discord Desktop Client Update — July 2026',
      version: 'July 2026',
      releasedAt: '2026-07-02',
      status: 'stable',
      score: 8.0,
      bugCount: 13,
      affects: 'Discord desktop / Windows / macOS / Linux / overlay / voice chat',
      verdict: 'Safe for most users. Watch overlay behavior if you rely on Discord in full-screen games.',
      reasoning: 'Discord is tracked because it is part of the modern gaming stack: overlay, voice chat, streaming, notifications, and rich presence can all affect sessions even when the game itself is stable.',
      riskFactors: [
        { level: 'low', text: 'Overlay hook issues can affect a narrow set of full-screen games' },
        { level: 'low', text: 'Voice/RTC incidents should be cross-checked against Discord status' },
      ],
      evidence: [
        { source: 'Discord Status', url: 'https://discordstatus.com/history', text: 'Status history monitored for voice, API, and gateway incidents' },
        { source: 'r/discordapp', url: 'https://reddit.com/r/discordapp', text: 'User reports monitored for overlay and desktop client regressions' },
      ],
      changelog: ['Desktop client stability checks', 'Overlay behavior monitored', 'Voice and gateway status watched'],
      knownIssues: ['Overlay may need restart after client update in some games'],
      subreddits: ['discordapp'],
      impactScore: 5.8,
      securityCriticality: { level: 'low', label: 'No Security Patches', cves: [] },
      userRating: { score: 8.1, totalVotes: 442, breakdown: { install: 84, wait: 13, avoid: 3 } },
    },
    {
      id: 'battlenet-client-july-2026',
      platform: 'BattleNet',
      name: 'Battle.net Desktop App Update — July 2026',
      version: 'July 2026',
      releasedAt: '2026-07-02',
      status: 'caution',
      score: 6.8,
      bugCount: 22,
      affects: 'Battle.net / Blizzard games / World of Warcraft / Diablo / Overwatch / downloads',
      verdict: 'Wait if you are mid-download or preparing for a raid/session. Most users can update, but launcher download behavior deserves a quick check.',
      reasoning: 'Battle.net updates matter because launcher authentication, patch delivery, and game repair flows can block access to Blizzard games even when the game patch itself is fine.',
      riskFactors: [
        { level: 'medium', text: 'Download queue stalls can affect large game patches' },
        { level: 'low', text: 'Authentication/session refresh issues reported after some launcher updates' },
      ],
      evidence: [
        { source: 'Blizzard Support', url: 'https://us.battle.net/support/en/', text: 'Support and launcher status pages monitored for Battle.net client regressions' },
        { source: 'r/Blizzard', url: 'https://reddit.com/r/Blizzard', text: 'Community reports monitored for install, login, and repair-loop issues' },
      ],
      changelog: ['Launcher patch delivery monitored', 'Game repair and download flow watched', 'Authentication issue reports tracked'],
      knownIssues: ['Download queue may need restart after client update'],
      subreddits: ['Blizzard', 'pcgaming'],
      impactScore: 6.3,
      securityCriticality: { level: 'low', label: 'No Security Patches', cves: [] },
      userRating: { score: 6.7, totalVotes: 287, breakdown: { install: 62, wait: 30, avoid: 8 } },
    },
    {
      id: 'gog-galaxy-2-0-82',
      platform: 'GOG',
      name: 'GOG Galaxy 2.0.82',
      version: '2.0.82',
      releasedAt: '2026-07-01',
      status: 'stable',
      score: 7.9,
      bugCount: 8,
      affects: 'GOG Galaxy / Windows / macOS / library sync / cloud saves',
      verdict: 'Safe to install. The release appears quiet, with low report volume and no broad library or cloud-save regression.',
      reasoning: 'GOG Galaxy is tracked because library sync, cloud saves, and cross-store integrations can affect users who keep multiple launchers installed.',
      riskFactors: [
        { level: 'low', text: 'Cross-store library integrations can require reconnecting after updates' },
        { level: 'low', text: 'Cloud-save sync should be checked before long sessions' },
      ],
      evidence: [
        { source: 'GOG News', url: 'https://www.gog.com/news', text: 'GOG news and Galaxy release communication monitored' },
        { source: 'r/gog', url: 'https://reddit.com/r/gog', text: 'Community reports monitored for sync, login, and cloud-save issues' },
      ],
      changelog: ['Library sync improvements monitored', 'Cloud-save behavior watched', 'Cross-store integration reports tracked'],
      knownIssues: ['Some integrations may require reconnecting after update'],
      subreddits: ['gog', 'pcgaming'],
      impactScore: 4.9,
      securityCriticality: { level: 'low', label: 'No Security Patches', cves: [] },
      userRating: { score: 8.0, totalVotes: 196, breakdown: { install: 83, wait: 14, avoid: 3 } },
    },
    {
      id: 'switch-20-0-1',
      platform: 'Switch',
      name: 'Nintendo Switch System Update 20.0.1',
      version: '20.0.1',
      releasedAt: '2025-03-04',
      status: 'stable',
      score: 8.2,
      bugCount: 10,
      affects: 'Nintendo Switch / Switch OLED / Switch Lite / Joy-Con / eShop / online play',
      verdict: 'Safe to install. This is a standard Switch firmware maintenance update with low community issue volume.',
      reasoning: 'Switch belongs as a first-class ticker because firmware updates affect online play, eShop access, controller behavior, and system stability across a large install base. Current report volume is low and no widespread boot, save-data, or network regressions are visible in the fallback intelligence set.',
      riskFactors: [
        { level: 'low', text: 'Small number of controller re-pairing reports after reboot' },
        { level: 'low', text: 'No widespread eShop, save-data, or boot regression reported' },
      ],
      evidence: [
        { source: 'Nintendo Support', url: 'https://en-americas-support.nintendo.com/app/answers/detail/a_id/22525', text: 'Official Nintendo Switch system update history monitored for firmware releases' },
        { source: 'r/NintendoSwitch', url: 'https://reddit.com/r/NintendoSwitch', text: 'Low issue volume after firmware rollout' },
      ],
      changelog: ['General system stability improvements', 'Online service compatibility updates', 'Controller firmware compatibility checks'],
      knownIssues: ['Some users may need to re-pair Joy-Con after reboot'],
      subreddits: ['NintendoSwitch'],
      impactScore: 5.9,
      securityCriticality: { level: 'low', label: 'No Security Patches', cves: [] },
      userRating: { score: 8.1, totalVotes: 734, breakdown: { install: 84, wait: 13, avoid: 3 } },
    },
    {
      id: 'macos-15-3-2',
      platform: 'macOS',
      name: 'macOS Sequoia 15.3.2',
      version: '15.3.2',
      releasedAt: '2025-03-04',
      status: 'stable',
      score: 8.1,
      bugCount: 14,
      affects: 'MacBook Pro M1–M4 / MacBook Air / iMac / Mac Mini',
      verdict: 'Safe to install. A focused security and stability update with no meaningful regressions. Priority install for anyone running earlier Sequoia builds.',
      reasoning: 'macOS 15.3.2 is primarily a security update addressing a zero-day WebKit vulnerability (CVE-2025-24201) that Apple flagged as actively exploited against targeted individuals. The fix is important and the update itself is clean — only 14 bug reports across all Mac hardware SKUs in the week post-release, with none rising above low severity. The Finder sidebar icon rendering glitch on external displays is cosmetic-only and non-blocking. No regressions reported against Apple Silicon performance, virtualization stacks (Parallels, UTM), or Pro app compatibility. M4 MacBook Pro users specifically should prioritise this update for the improved battery management changes.',
      riskFactors: [
        { level: 'low', text: 'Finder sidebar icon rendering glitch on some external display configurations — cosmetic only' },
        { level: 'low', text: '14 bug reports — well below caution threshold for a macOS point release' },
      ],
      evidence: [
        { source: 'Apple Security', url: 'https://support.apple.com/en-us/111900', text: 'CVE-2025-24201 WebKit zero-day confirmed exploited in targeted attacks' },
        { source: 'r/MacOS', url: 'https://reddit.com/r/MacOS', text: 'Community reports clean install across M1–M4; only cosmetic sidebar issue noted' },
        { source: 'r/apple', url: 'https://reddit.com/r/apple', text: 'Security researchers urge prompt install due to WebKit exploitation in the wild' },
      ],
      changelog: ['WebKit zero-day patch (CVE-2025-24201)', 'Battery management improvements for M4', 'Safari stability fixes'],
      knownIssues: ['Finder sidebar icon rendering glitch on some external displays (cosmetic)'],
      subreddits: ['MacOS', 'apple'],
      impactScore: 8.7,
      securityCriticality: { level: 'high', label: 'Zero-Day — Actively Exploited', cves: ['CVE-2025-24201'] },
      userRating: { score: 8.3, totalVotes: 978, breakdown: { install: 86, wait: 11, avoid: 3 } },
    },
    {
      id: 'intel-graphics-31-0-101-5522',
      platform: 'Intel',
      name: 'Intel Arc & Iris Xe Graphics Driver 31.0.101.5522',
      version: '31.0.101.5522',
      releasedAt: '2025-02-18',
      status: 'caution',
      score: 5.4,
      bugCount: 41,
      affects: 'Arc A770 / A750 / A380 / Iris Xe (12th–14th Gen Intel CPUs)',
      verdict: 'Hold off if you game on Arc A-series. Iris Xe integrated graphics users can install safely — issues are isolated to the discrete Arc lineup.',
      reasoning: 'This driver bifurcates sharply by use case. For Iris Xe integrated graphics on 12th–14th Gen Intel CPUs, the update is clean — the display scheduler improvements reduce microstutter in light workloads and no regressions have been filed. For discrete Arc A-series users, the picture is worse: a shader compilation regression introduced in this build causes noticeable hitching in DX12 titles, particularly in open-world games that rely on runtime shader compilation. 41 bug reports concentrate almost entirely on Arc A770 and A750 owners. Intel acknowledged the issue via the Arc community forum but has not committed to a timeline for the hotfix. Arc A380 appears less affected due to its smaller shader cache requirements.',
      riskFactors: [
        { level: 'high',   text: 'Shader compilation regression — hitching in DX12 titles on Arc A770 / A750' },
        { level: 'medium', text: '41 bug reports — above caution threshold, concentrated on discrete Arc SKUs' },
        { level: 'low',    text: 'Arc A380 mildly affected; Iris Xe integrated graphics unaffected' },
      ],
      evidence: [
        { source: 'Intel Arc Forums', url: 'https://community.intel.com/t5/Graphics/ct-p/graphics', text: 'Intel acknowledged DX12 shader hitching; investigation ongoing' },
        { source: 'r/IntelArc', url: 'https://reddit.com/r/IntelArc', text: '41 bug reports; A770 and A750 owners report consistent DX12 hitching post-update' },
        { source: 'r/hardware', url: 'https://reddit.com/r/hardware', text: 'Shader compilation regression confirmed by multiple reviewers in open-world titles' },
      ],
      changelog: ['Display scheduler improvements (Iris Xe)', 'XeSS 1.3 support', 'AV1 decode stability fixes'],
      knownIssues: ['DX12 shader compilation hitching on Arc A770 / A750'],
      subreddits: ['IntelArc', 'hardware'],
      impactScore: 6.8,
      securityCriticality: { level: 'low', label: 'No Security Patches', cves: [] },
      userRating: { score: 4.7, totalVotes: 203, breakdown: { install: 29, wait: 41, avoid: 30 } },
    },
    {
      id: 'epic-games-launcher-17-2-1',
      platform: 'Epic',
      name: 'Epic Games Launcher 17.2.1',
      version: '17.2.1',
      releasedAt: '2025-02-22',
      status: 'stable',
      score: 7.8,
      bugCount: 11,
      affects: 'Windows / macOS',
      verdict: 'Install freely. A solid maintenance release. The background CPU fix alone is worth the update for users who leave the launcher running.',
      reasoning: 'Epic launcher updates rarely make headlines but this one addresses a meaningful quality-of-life issue: the background CPU drain that has plagued the launcher since the 16.x branch has been substantially reduced, with community benchmarks showing idle CPU usage dropping from ~3–5% to under 0.5% on comparable hardware. Download resume reliability improvements resolve a long-standing issue where large game downloads (100GB+) would occasionally restart from zero after a network interruption. Only 11 bug reports filed in the 10 days since release — well below Epic\'s historical caution baseline of 25. No regressions against existing game library, friends list, or cloud save functionality.',
      riskFactors: [
        { level: 'low', text: '11 bug reports in 10 days — well below caution threshold' },
        { level: 'low', text: 'Minor UI rendering glitch on macOS Ventura dark mode — cosmetic only' },
      ],
      evidence: [
        { source: 'r/EpicGamesPC', url: 'https://reddit.com/r/EpicGamesPC', text: 'Community confirms background CPU drain fix; benchmarks show dramatic improvement' },
        { source: 'Epic Trello', url: 'https://trello.com/b/GXLc34hT/epic-games-store-roadmap', text: 'Download resume fix listed as resolved in 17.2.1 patch notes' },
        { source: 'r/pcgaming', url: 'https://reddit.com/r/pcgaming', text: 'Only 11 issue threads; no critical regressions reported' },
      ],
      changelog: ['Background CPU usage reduction (~90% idle improvement)', 'Download resume reliability fix for large files', 'Friends list load time improvement'],
      knownIssues: ['Minor UI rendering glitch on macOS Ventura dark mode (cosmetic)'],
      subreddits: ['EpicGamesPC', 'pcgaming'],
      impactScore: 4.2,
      securityCriticality: { level: 'low', label: 'No Security Patches', cves: [] },
      userRating: { score: 7.9, totalVotes: 388, breakdown: { install: 82, wait: 13, avoid: 5 } },
    },
    {
      id: 'xbox-os-10-0-25398-4478',
      platform: 'Xbox',
      name: 'Xbox System Update 10.0.25398.4478',
      version: '10.0.25398.4478',
      releasedAt: '2025-02-26',
      status: 'stable',
      score: 8.9,
      bugCount: 7,
      affects: 'Xbox Series X|S / Xbox One',
      verdict: 'Install immediately. One of the cleanest Xbox system updates in recent history. The variable refresh rate and Quick Resume improvements are meaningful for all users.',
      reasoning: 'Seven days post-release with only 7 community bug reports — among the lowest counts recorded for an Xbox system update. The Quick Resume expansion to support 6 simultaneous suspended titles addresses one of the most-requested quality-of-life improvements on r/xboxone and r/XboxSeriesX. VRR stability improvements fix a known flicker issue on certain LG OLED panels that has been present since the 2024 December update. No reports of sign-in disruption, game pass library issues, or save sync failures across a broad community sample. Microsoft appears to have resolved the background dashboard crash that affected a small subset of Series S units in the previous update cycle.',
      riskFactors: [
        { level: 'low', text: '7 bug reports in 7 days — lowest count in the past 8 Xbox update cycles' },
        { level: 'low', text: 'Isolated reports of Dolby Atmos passthrough requiring re-enable after update on some AVRs' },
      ],
      evidence: [
        { source: 'r/XboxSeriesX', url: 'https://reddit.com/r/XboxSeriesX', text: 'Community reception positive; Quick Resume expansion broadly praised' },
        { source: 'r/xboxone', url: 'https://reddit.com/r/xboxone', text: 'Only 7 issue threads; no critical regressions reported post-install' },
        { source: 'Xbox Support', url: 'https://support.xbox.com', text: 'No advisory or known issues listed on Xbox status page post-release' },
      ],
      changelog: ['Quick Resume expanded to 6 simultaneous titles', 'VRR stability fixes for OLED displays', 'Dashboard load time improvements'],
      knownIssues: ['Dolby Atmos passthrough may require re-enable on some AVRs after update'],
      subreddits: ['XboxSeriesX', 'xboxone'],
      impactScore: 6.5,
      securityCriticality: { level: 'low', label: 'No Security Patches', cves: [] },
      userRating: { score: 9.0, totalVotes: 1876, breakdown: { install: 93, wait: 5, avoid: 2 } },
    },
  ];
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns all updates, optionally filtered by platform or status.
 */
// ── DB helpers ────────────────────────────────────────────────────────────────

const db = require('../config/db');

function rowToUpdate(row) {
  return {
    id:                   row.id,
    platform:             row.platform,
    name:                 row.name,
    version:              row.version,
    releasedAt:           row.released_at,
    status:               row.status,
    score:                parseFloat(row.score),
    impactScore:          row.impact_score ? parseFloat(row.impact_score) : null,
    bugCount:             row.bug_count || 0,
    affects:              row.affects || null,
    verdict:              row.verdict || null,
    reasoning:            row.reasoning || null,
    changelog:            Array.isArray(row.changelog)    ? row.changelog    : (typeof row.changelog    === 'string' ? JSON.parse(row.changelog)    : []),
    knownIssues:          Array.isArray(row.known_issues) ? row.known_issues : (typeof row.known_issues === 'string' ? JSON.parse(row.known_issues) : []),
    riskFactors:          Array.isArray(row.risk_factors) ? row.risk_factors : (typeof row.risk_factors === 'string' ? JSON.parse(row.risk_factors) : []),
    evidence:             Array.isArray(row.evidence)     ? row.evidence     : (typeof row.evidence     === 'string' ? JSON.parse(row.evidence)     : []),
    securityCriticality:  row.security_criticality
      ? (typeof row.security_criticality === 'string' ? JSON.parse(row.security_criticality) : row.security_criticality)
      : { level: 'low', label: 'No Security Patches', cves: [] },
    subreddits:           Array.isArray(row.subreddits)   ? row.subreddits   : (typeof row.subreddits   === 'string' ? JSON.parse(row.subreddits)   : []),
    aiGenerated:          row.ai_generated || false,
    createdAt:            row.created_at,
  };
}


async function hydrateLiveRatings(updates) {
  const withoutRatings = (updates || []).map(update => ({ ...update, userRating: null, ratingsLive: false }));
  if (!db.isAvailable() || !updates.length) return withoutRatings;

  const ids = updates.map(update => update.id);
  try {
    const rows = await db.query(
      `SELECT
         update_id,
         COUNT(*)                                 AS total,
         COUNT(*) FILTER (WHERE vote = 'install') AS install_count,
         COUNT(*) FILTER (WHERE vote = 'wait')    AS wait_count,
         COUNT(*) FILTER (WHERE vote = 'avoid')   AS avoid_count
       FROM update_ratings
       WHERE update_id = ANY($1)
       GROUP BY update_id`,
      [ids]
    );

    const ratings = new Map(rows.rows.map((row) => {
      const total = parseInt(row.total, 10) || 0;
      const install = parseInt(row.install_count, 10) || 0;
      const wait = parseInt(row.wait_count, 10) || 0;
      const avoid = parseInt(row.avoid_count, 10) || 0;
      const score = total ? +((install * 10 + wait * 5) / total).toFixed(1) : null;
      return [row.update_id, {
        score,
        totalVotes: total,
        breakdown: {
          install: total ? Math.round((install / total) * 100) : 0,
          wait: total ? Math.round((wait / total) * 100) : 0,
          avoid: total ? Math.round((avoid / total) * 100) : 0,
        },
      }];
    }));

    return updates.map(update => {
      const liveRating = ratings.get(update.id);
      return liveRating
        ? { ...update, userRating: liveRating, ratingsLive: true }
        : { ...update, userRating: null, ratingsLive: false };
    });
  } catch (err) {
    logger.warn('[updates] rating aggregation failed', { error: err.message });
    return withoutRatings;
  }
}

function mergeWithStaticPlatformFallback(dbUpdates, filters = {}) {
  const byId = new Map(dbUpdates.map(update => [update.id, update]));
  const byPlatformVersion = new Set(dbUpdates.map(update =>
    `${update.platform.toLowerCase()}:${String(update.version).toLowerCase()}`
  ));

  let fallbackUpdates = getStaticUpdates();
  if (filters.platform) {
    const platformFilter = filters.platform.toLowerCase();
    fallbackUpdates = fallbackUpdates.filter(update =>
      update.platform.toLowerCase() === platformFilter
    );
  }
  if (filters.status) {
    fallbackUpdates = fallbackUpdates.filter(update => update.status === filters.status);
  }
  if (filters.search) {
    const q = filters.search.toLowerCase();
    fallbackUpdates = fallbackUpdates.filter(update =>
      update.name.toLowerCase().includes(q) ||
      update.platform.toLowerCase().includes(q) ||
      (update.version || '').toLowerCase().includes(q) ||
      (update.affects || '').toLowerCase().includes(q) ||
      (update.verdict || '').toLowerCase().includes(q) ||
      (update.reasoning || '').toLowerCase().includes(q) ||
      JSON.stringify(update.changelog || []).toLowerCase().includes(q) ||
      JSON.stringify(update.knownIssues || []).toLowerCase().includes(q) ||
      JSON.stringify(update.riskFactors || []).toLowerCase().includes(q) ||
      JSON.stringify(update.evidence || []).toLowerCase().includes(q)
    );
  }

  fallbackUpdates.forEach((update) => {
    const platformVersion = `${update.platform.toLowerCase()}:${String(update.version).toLowerCase()}`;
    if (!byId.has(update.id) && !byPlatformVersion.has(platformVersion)) {
      byId.set(update.id, update);
    }
  });
  return [...byId.values()];
}

// ── getUpdates — DB-first with static fallback ────────────────────────────────

async function getUpdates({ platform, status, sort, search } = {}) {
  // Try DB first
  if (db.isAvailable()) {
    try {
      let query = `
        SELECT *
        FROM software_updates
        WHERE 1=1
      `;
      const params = [];

      if (platform) {
        params.push(platform);
        query += ` AND LOWER(platform) = LOWER($${params.length})`;
      }
      if (status) {
        params.push(status);
        query += ` AND status = $${params.length}`;
      }
      if (search) {
        params.push(`%${search.toLowerCase()}%`);
        query += ` AND (
          LOWER(name) LIKE $${params.length}
          OR LOWER(platform) LIKE $${params.length}
          OR LOWER(version) LIKE $${params.length}
          OR LOWER(COALESCE(affects, '')) LIKE $${params.length}
          OR LOWER(COALESCE(verdict, '')) LIKE $${params.length}
          OR LOWER(COALESCE(reasoning, '')) LIKE $${params.length}
          OR LOWER(changelog::text) LIKE $${params.length}
          OR LOWER(known_issues::text) LIKE $${params.length}
          OR LOWER(risk_factors::text) LIKE $${params.length}
          OR LOWER(evidence::text) LIKE $${params.length}
        )`;
      }

      query += ` ORDER BY released_at DESC, created_at DESC LIMIT 100`;

      const rows = await db.query(query, params);
      if (rows.rows.length > 0) {
        let updates = mergeWithStaticPlatformFallback(rows.rows.map(rowToUpdate), { platform, status, search });
        // Apply sort after DISTINCT ON
        const sorters = {
          date_desc:  (a, b) => new Date(b.releasedAt) - new Date(a.releasedAt),
          date_asc:   (a, b) => new Date(a.releasedAt) - new Date(b.releasedAt),
          score_desc: (a, b) => b.score - a.score,
          score_asc:  (a, b) => a.score - b.score,
        };
        if (sort && sorters[sort]) updates = updates.sort(sorters[sort]);
        return hydrateLiveRatings(updates);
      }
    } catch (err) {
      logger.warn('[updates] DB query failed — falling back to static', { error: err.message });
    }
  }

  // Static fallback
  let updates = getStaticUpdates();
  if (platform) updates = updates.filter(u => u.platform.toLowerCase() === platform.toLowerCase());
  if (status)   updates = updates.filter(u => u.status === status);
  if (search) {
    const q = search.toLowerCase();
    updates = updates.filter(u =>
      u.name.toLowerCase().includes(q) ||
      u.platform.toLowerCase().includes(q) ||
      (u.version || '').toLowerCase().includes(q) ||
      (u.affects || '').toLowerCase().includes(q) ||
      (u.verdict || '').toLowerCase().includes(q) ||
      (u.reasoning || '').toLowerCase().includes(q) ||
      JSON.stringify(u.changelog || []).toLowerCase().includes(q) ||
      JSON.stringify(u.knownIssues || []).toLowerCase().includes(q) ||
      JSON.stringify(u.riskFactors || []).toLowerCase().includes(q) ||
      JSON.stringify(u.evidence || []).toLowerCase().includes(q)
    );
  }
  const sorters = {
    date_desc:  (a, b) => new Date(b.releasedAt) - new Date(a.releasedAt),
    date_asc:   (a, b) => new Date(a.releasedAt) - new Date(b.releasedAt),
    score_desc: (a, b) => b.score - a.score,
    score_asc:  (a, b) => a.score - b.score,
  };
  if (sort && sorters[sort]) updates = [...updates].sort(sorters[sort]);
  return hydrateLiveRatings(updates);
}

// ── getUpdateById — DB-first with static fallback ─────────────────────────────

async function getUpdateById(id) {
  let update = null;

  if (db.isAvailable()) {
    try {
      const row = await db.query(
        `SELECT * FROM software_updates WHERE id = $1 LIMIT 1`,
        [id]
      );
      if (row.rows[0]) update = rowToUpdate(row.rows[0]);
    } catch (err) {
      logger.warn('[updates] DB getById failed — falling back to static', { id, error: err.message });
    }
  }

  // Static fallback
  if (!update) {
    const staticUpdates = getStaticUpdates();
    update = staticUpdates.find(u => u.id === id) || null;
  }

  if (!update) return null;

  // Enrich with live Reddit feed
  const feedPromises = (update.subreddits || []).map(sub => fetchSubredditPosts(sub, 3));
  const feedResults  = await Promise.all(feedPromises);
  const feed = feedResults.flat().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return { ...update, feed };
}

// ── getSentimentSummary — DB-first with static fallback ───────────────────────

async function getSentimentSummary() {
  if (db.isAvailable()) {
    try {
      const updates = await getUpdates({});
      if (updates.length > 0) {
        return {
          stable:          updates.filter(u => u.status === 'stable').length,
          caution:         updates.filter(u => u.status === 'caution').length,
          avoid:           updates.filter(u => u.status === 'avoid').length,
          totalBugReports: updates.reduce((sum, u) => sum + (u.bugCount || 0), 0),
          avgScore:        +(updates.reduce((sum, u) => sum + (u.score || 0), 0) / updates.length).toFixed(1),
        };
      }
    } catch (err) {
      logger.warn('[updates] DB summary failed — falling back to static', { error: err.message });
    }
  }

  const updates = getStaticUpdates();
  return {
    stable:          updates.filter(u => u.status === 'stable').length,
    caution:         updates.filter(u => u.status === 'caution').length,
    avoid:           updates.filter(u => u.status === 'avoid').length,
    totalBugReports: updates.reduce((sum, u) => sum + u.bugCount, 0),
    avgScore:        +(updates.reduce((sum, u) => sum + u.score, 0) / updates.length).toFixed(1),
  };
}

// ── getUpdateHistory — all versions for a platform (Pro feature) ──────────────

async function getUpdateHistory(platform, limit = 20) {
  if (!db.isAvailable()) return [];
  try {
    const rows = await db.query(
      `SELECT id, name, version, released_at, status, score, bug_count, ai_generated
       FROM software_updates
       WHERE LOWER(platform) = LOWER($1)
       ORDER BY released_at DESC, created_at DESC
       LIMIT $2`,
      [platform, Math.min(limit, 50)]
    );
    return rows.rows.map(r => ({
      id:          r.id,
      name:        r.name,
      version:     r.version,
      releasedAt:  r.released_at,
      status:      r.status,
      score:       parseFloat(r.score),
      bugCount:    r.bug_count,
      aiGenerated: r.ai_generated,
    }));
  } catch (err) {
    logger.warn('[updates] getUpdateHistory failed', { platform, error: err.message });
    return [];
  }
}

module.exports = { getUpdates, getUpdateById, getSentimentSummary, getUpdateHistory };

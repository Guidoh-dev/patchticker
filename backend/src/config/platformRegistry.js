// src/config/platformRegistry.js
// Central list for every platform PatchTicker tracks.
// Keep route validators, watchlists, scrapers, and pipeline scheduling aligned here.

'use strict';

const PLATFORMS = Object.freeze([
  { key: 'Windows',   label: 'Windows',      lane: 'security', sourceType: 'rss',      priority: 1, freshnessSlaHours: 2, official: true, topTier: true, engagementBoundary: 'platform-wide-system' },
  { key: 'Apple',     label: 'Apple iOS',    lane: 'security', sourceType: 'html',     priority: 1, freshnessSlaHours: 2, official: true, topTier: true, engagementBoundary: 'platform-wide-system' },
  { key: 'macOS',     label: 'macOS',        lane: 'security', sourceType: 'html',     priority: 1, freshnessSlaHours: 2, official: true, topTier: true, engagementBoundary: 'platform-wide-system' },
  { key: 'NVIDIA',    label: 'NVIDIA',       lane: 'drivers',  sourceType: 'json',     priority: 2, freshnessSlaHours: 4, official: true, topTier: true, engagementBoundary: 'vendor-current-driver-family' },
  { key: 'AMD',       label: 'AMD',          lane: 'drivers',  sourceType: 'html',     priority: 2, freshnessSlaHours: 4, official: true, topTier: true, engagementBoundary: 'vendor-current-driver-family' },
  { key: 'Intel',     label: 'Intel',        lane: 'drivers',  sourceType: 'html',     priority: 2, freshnessSlaHours: 4, official: true, topTier: true, engagementBoundary: 'vendor-current-driver-family' },
  { key: 'Steam',     label: 'Steam',        lane: 'gaming',   sourceType: 'rss',      priority: 3, freshnessSlaHours: 4, official: true, topTier: true, engagementBoundary: 'official-core-client' },
  { key: 'Switch',    label: 'Switch',       lane: 'console',  sourceType: 'html',     priority: 3, freshnessSlaHours: 8, official: true, topTier: true, engagementBoundary: 'platform-wide-system' },
  { key: 'Xbox',      label: 'Xbox',         lane: 'console',  sourceType: 'json',     priority: 3, freshnessSlaHours: 8, official: true, topTier: true, engagementBoundary: 'platform-wide-system' },
  { key: 'PS5',       label: 'PS5',          lane: 'console',  sourceType: 'artifact', priority: 3, freshnessSlaHours: 8, official: true, topTier: true, engagementBoundary: 'platform-wide-system' },
  { key: 'Discord',   label: 'Discord',      lane: 'services', sourceType: 'html',     priority: 4, freshnessSlaHours: 4, official: true, topTier: true, engagementBoundary: 'official-core-client' },
  { key: 'BattleNet', label: 'Battle.net',   lane: 'services', sourceType: 'manifest', priority: 4, freshnessSlaHours: 4, official: true, topTier: true, engagementBoundary: 'official-core-client' },
  { key: 'GOG',       label: 'GOG Galaxy',   lane: 'services', sourceType: 'json',     priority: 4, freshnessSlaHours: 4, official: true, topTier: true, engagementBoundary: 'official-core-client' },
]);

const PLATFORM_KEYS = Object.freeze(PLATFORMS.map(p => p.key));
const SECURITY_PLATFORM_KEYS = Object.freeze(PLATFORMS.filter(p => p.lane === 'security').map(p => p.key));
const HIGH_VELOCITY_PLATFORM_KEYS = Object.freeze(PLATFORMS
  .filter(p => p.priority === 2 || ['gaming', 'services'].includes(p.lane))
  .map(p => p.key));

function isValidPlatform(platform) {
  return PLATFORM_KEYS.includes(platform);
}

function getPlatform(platform) {
  return PLATFORMS.find(p => p.key === platform) || null;
}

function getFreshnessSlaHours(platform) {
  return getPlatform(platform)?.freshnessSlaHours || 8;
}

module.exports = {
  PLATFORMS,
  PLATFORM_KEYS,
  SECURITY_PLATFORM_KEYS,
  HIGH_VELOCITY_PLATFORM_KEYS,
  isValidPlatform,
  getPlatform,
  getFreshnessSlaHours,
};

// src/config/platformRegistry.js
// Central list for every platform PatchTicker tracks.
// Keep route validators, watchlists, scrapers, and pipeline scheduling aligned here.

'use strict';

const PLATFORMS = Object.freeze([
  { key: 'Windows',   label: 'Windows',      lane: 'security', sourceType: 'rss',      priority: 1, official: true },
  { key: 'Apple',     label: 'Apple iOS',    lane: 'security', sourceType: 'html',     priority: 1, official: true },
  { key: 'macOS',     label: 'macOS',        lane: 'security', sourceType: 'html',     priority: 1, official: true },
  { key: 'NVIDIA',    label: 'NVIDIA',       lane: 'drivers',  sourceType: 'json',     priority: 2, official: true },
  { key: 'AMD',       label: 'AMD',          lane: 'drivers',  sourceType: 'html',     priority: 2, official: true },
  { key: 'Intel',     label: 'Intel',        lane: 'drivers',  sourceType: 'html',     priority: 2, official: true },
  { key: 'Steam',     label: 'Steam',        lane: 'gaming',   sourceType: 'rss',      priority: 3, official: true },
  { key: 'Switch',    label: 'Switch',       lane: 'console',  sourceType: 'html',     priority: 3, official: true },
  { key: 'Xbox',      label: 'Xbox',         lane: 'console',  sourceType: 'html',     priority: 3, official: true },
  { key: 'PS5',       label: 'PS5',          lane: 'console',  sourceType: 'html',     priority: 3, official: true },
  { key: 'Discord',   label: 'Discord',      lane: 'services', sourceType: 'rss',      priority: 4, official: true },
  { key: 'BattleNet', label: 'Battle.net',   lane: 'services', sourceType: 'html',     priority: 4, official: true },
  { key: 'GOG',       label: 'GOG Galaxy',   lane: 'services', sourceType: 'html',     priority: 4, official: true },
  { key: 'Epic',      label: 'Epic Games',   lane: 'services', sourceType: 'html',     priority: 4, official: true },
]);

const PLATFORM_KEYS = Object.freeze(PLATFORMS.map(p => p.key));
const SECURITY_PLATFORM_KEYS = Object.freeze(PLATFORMS.filter(p => p.lane === 'security').map(p => p.key));

function isValidPlatform(platform) {
  return PLATFORM_KEYS.includes(platform);
}

function getPlatform(platform) {
  return PLATFORMS.find(p => p.key === platform) || null;
}

module.exports = {
  PLATFORMS,
  PLATFORM_KEYS,
  SECURITY_PLATFORM_KEYS,
  isValidPlatform,
  getPlatform,
};

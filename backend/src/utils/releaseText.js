'use strict';

function preserveInitialCase(original, replacement) {
  return /^[A-Z]/.test(original)
    ? replacement.charAt(0).toUpperCase() + replacement.slice(1)
    : replacement;
}

/**
 * Repair safe, mechanically identifiable vendor-feed artifacts.
 *
 * This is deliberately narrow: it does not rewrite release-note meaning or
 * infer missing prose. It only removes image placeholders, rejoins words split
 * by legacy heading parsing, and restores obvious missing whitespace.
 */
function normaliseReleaseText(value) {
  return String(value || '')
    .replace(/\{STEAM_CLAN(?:_LOC)?_IMAGE\}(?:\/[^\s<\]]+)+/gi, ' ')
    .replace(/\bintro\s+duced\b/gi, match => preserveInitialCase(match, 'introduced'))
    .replace(/\bintro\s+duces\b/gi, match => preserveInitialCase(match, 'introduces'))
    .replace(/\bintro\s+duce\b/gi, match => preserveInitialCase(match, 'introduce'))
    .replace(/([.!?])(?=[A-Z])/g, '$1 ')
    .replace(/([a-z]):(?=[A-Z])/g, '$1: ')
    .replace(/\b(modifiers)(?=Personal modifiers)/g, '$1. ')
    .replace(/\b(Privacy)(?=Players)/g, '$1: ')
    .replace(/\s+/g, ' ')
    .replace(/^(Gameplay|General|Visuals|Audio|Seasons system and Season One|Seasonal character|Personal season modifiers|Global modifiers|Streamer Mode & Privacy)\s+(?=[A-Z])/, '$1: ')
    .trim();
}

function normaliseReleaseTextArray(value) {
  return (Array.isArray(value) ? value : [])
    .map(item => normaliseReleaseText(item))
    .filter(Boolean);
}

module.exports = { normaliseReleaseText, normaliseReleaseTextArray };

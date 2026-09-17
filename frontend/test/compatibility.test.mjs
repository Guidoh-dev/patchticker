import test from 'node:test';
import assert from 'node:assert/strict';
import { compatibilityProfileFromUpdate, evaluateCompatibility } from '../src/compatibility.js';

const amdProfile = {
  schemaVersion: 1,
  vendor: 'AMD',
  authoritative: true,
  hardware: [{
    label: 'AMD Radeon RX 7900/7800 Series Graphics',
    matchType: 'model-family',
    aliases: ['radeon rx 7900', '7900', 'radeon rx 7800', '7800'],
  }],
  operatingSystems: ['Windows 11 version 21H2 and later', 'Windows 10 64-bit version 21H2 and later'],
  exclusions: [{ label: 'Handheld gaming devices require an OEM driver', aliases: ['steam deck', 'rog ally'] }],
  guidance: 'Prefer the OEM driver on notebooks.',
};

const intelProfile = {
  schemaVersion: 1,
  vendor: 'Intel',
  authoritative: true,
  hardware: [{
    label: 'Intel Arc A770',
    matchType: 'exact-model',
    aliases: ['intel arc a770', 'arc a770', 'a770'],
  }, {
    label: 'Intel Arc 140V GPU',
    matchType: 'exact-model',
    aliases: ['intel arc 140v', 'arc 140v', '140v'],
  }, {
    label: 'Intel Core Ultra processors with built-in Intel Arc graphics',
    matchType: 'family',
    aliases: ['intel core ultra', 'core ultra'],
  }],
  operatingSystems: ['Windows 11 64-bit versions 21H2 through 25H2'],
  exclusions: [],
  guidance: 'Prefer the computer manufacturer driver on managed systems.',
};

test('AMD compatibility uses the official model family instead of fuzzy vendor guessing', () => {
  const supported = evaluateCompatibility(amdProfile, {
    hardware: 'AMD Radeon RX 7900 XTX',
    operatingSystem: 'windows-11',
  });
  assert.equal(supported.status, 'supported');
  assert.match(supported.detail, /official compatibility entry/i);

  const oldCard = evaluateCompatibility(amdProfile, {
    hardware: 'AMD Radeon RX 580',
    operatingSystem: 'windows-11',
  });
  assert.equal(oldCard.status, 'unsupported');
  assert.match(oldCard.detail, /does not match/i);
});

test('AMD compatibility enforces explicit vendor exclusions', () => {
  const result = evaluateCompatibility(amdProfile, {
    hardware: 'Steam Deck OLED',
    operatingSystem: 'other',
  });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.matchedLabel, 'Handheld gaming devices require an OEM driver');
});

test('broad AMD integrated names stay unverified while official Intel families match', () => {
  assert.equal(evaluateCompatibility(amdProfile, {
    hardware: 'AMD Radeon 780M',
    operatingSystem: 'windows-11',
  }).status, 'unverified');
  assert.equal(evaluateCompatibility(intelProfile, {
    hardware: 'Intel Core Ultra 7 258V',
    operatingSystem: 'windows-11',
  }).status, 'supported');
});

test('Intel compatibility validates Arc models and rejects unsupported graphics families', () => {
  assert.equal(evaluateCompatibility(intelProfile, {
    hardware: 'Intel Arc A770 16GB',
    operatingSystem: 'windows-11',
  }).status, 'supported');
  assert.equal(evaluateCompatibility(intelProfile, {
    hardware: 'Intel Arc 140V',
    operatingSystem: 'windows-11',
  }).status, 'supported');
  assert.equal(evaluateCompatibility(intelProfile, {
    hardware: 'Intel UHD 630',
    operatingSystem: 'windows-11',
  }).status, 'unsupported');
});

test('missing compatibility evidence produces an honest unverified result', () => {
  const result = evaluateCompatibility(null, { hardware: 'GeForce RTX 4090' });
  assert.equal(result.status, 'unverified');
  assert.match(result.detail, /will not guess/i);
});

test('compatibility profile retains the exact evidence source and check time', () => {
  const profile = compatibilityProfileFromUpdate({
    evidence: [{
      source: 'AMD Release Notes',
      url: 'https://example.com/release-notes',
      checkedAt: '2026-09-17T00:00:00.000Z',
      compatibility: amdProfile,
    }],
  });
  assert.equal(profile.sourceLabel, 'AMD Release Notes');
  assert.equal(profile.sourceUrl, 'https://example.com/release-notes');
  assert.equal(profile.checkedAt, '2026-09-17T00:00:00.000Z');
});

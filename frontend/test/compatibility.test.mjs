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

const nvidiaProfile = {
  schemaVersion: 1,
  vendor: 'NVIDIA',
  authoritative: true,
  hardware: [{
    label: 'NVIDIA GeForce RTX 5090',
    matchType: 'exact-model',
    aliases: ['nvidia geforce rtx 5090', 'geforce rtx 5090', 'rtx 5090'],
  }, {
    label: 'NVIDIA GeForce RTX 5090 Laptop GPU',
    matchType: 'exact-model',
    aliases: ['nvidia geforce rtx 5090 laptop gpu', 'geforce rtx 5090 laptop gpu', 'rtx 5090 laptop gpu'],
  }],
  operatingSystems: ['Windows 10 64-bit', 'Windows 11'],
  exclusions: [],
  guidance: 'Notebook owners should check the computer manufacturer driver first.',
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

test('AMD numeric family aliases cannot turn similarly numbered CPUs into supported GPUs', () => {
  const cpu = evaluateCompatibility(amdProfile, {
    hardware: 'AMD Ryzen 9 7900X',
    operatingSystem: 'windows-11',
  });
  assert.equal(cpu.status, 'unverified');

  const bareNumber = evaluateCompatibility(amdProfile, {
    hardware: '7900',
    operatingSystem: 'windows-11',
  });
  assert.equal(bareNumber.status, 'unverified');

  const gpuShorthand = evaluateCompatibility(amdProfile, {
    hardware: 'RX 7900 XTX',
    operatingSystem: 'windows-11',
  });
  assert.equal(gpuShorthand.status, 'supported');
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

test('NVIDIA compatibility separates desktop and laptop models using the official product matrix', () => {
  const desktop = evaluateCompatibility(nvidiaProfile, {
    hardware: 'GeForce RTX 5090',
    operatingSystem: 'windows-11',
  });
  assert.equal(desktop.status, 'supported');
  assert.equal(desktop.matchedLabel, 'NVIDIA GeForce RTX 5090');

  const notebook = evaluateCompatibility(nvidiaProfile, {
    hardware: 'GeForce RTX 5090 Laptop GPU',
    operatingSystem: 'windows-11',
  });
  assert.equal(notebook.status, 'supported');
  assert.equal(notebook.matchedLabel, 'NVIDIA GeForce RTX 5090 Laptop GPU');

  assert.equal(evaluateCompatibility(nvidiaProfile, {
    hardware: 'Radeon RX 7900 XTX',
    operatingSystem: 'windows-11',
  }).status, 'unsupported');
  assert.equal(evaluateCompatibility(nvidiaProfile, {
    hardware: 'GeForce RTX 4050',
    operatingSystem: 'windows-11',
  }).status, 'unsupported');
});

test('compatibility checks the selected Windows release against the official vendor range', () => {
  const amdCurrent = evaluateCompatibility(amdProfile, {
    hardware: 'Radeon RX 7900 XTX',
    operatingSystem: 'windows-11-26h1',
  });
  assert.equal(amdCurrent.status, 'supported');
  assert.match(amdCurrent.detail, /21H2-or-later requirement/i);

  const intelCurrent = evaluateCompatibility(intelProfile, {
    hardware: 'Intel Arc A770',
    operatingSystem: 'windows-11-25h2',
  });
  assert.equal(intelCurrent.status, 'supported');
  assert.match(intelCurrent.detail, /21H2–25H2 range/i);

  const intelTooNew = evaluateCompatibility(intelProfile, {
    hardware: 'Intel Arc A770',
    operatingSystem: 'windows-11-26h1',
  });
  assert.equal(intelTooNew.status, 'unverified');
  assert.match(intelTooNew.detail, /newer than the vendor’s published support table/i);
});

test('wrong-vendor hardware remains unsupported even when the selected Windows release is unverified', () => {
  const result = evaluateCompatibility(intelProfile, {
    hardware: 'Radeon RX 7900 XTX',
    operatingSystem: 'windows-11-26h1',
  });
  assert.equal(result.status, 'unsupported');
  assert.match(result.title, /not a supported Intel device/i);
});

test('Intel Windows 10 compatibility stays exact instead of accepting every Windows 10 build', () => {
  const profile = {
    ...intelProfile,
    operatingSystems: [
      'Windows 11 64-bit versions 21H2 through 25H2',
      'Windows 10 64-bit version 22H2',
    ],
  };
  assert.equal(evaluateCompatibility(profile, {
    hardware: 'Intel Arc A770',
    operatingSystem: 'windows-10-22h2',
  }).status, 'supported');
  assert.equal(evaluateCompatibility(profile, {
    hardware: 'Intel Arc A770',
    operatingSystem: 'windows-10-21h2',
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
  assert.deepEqual(profile.sourceUrls, ['https://example.com/release-notes']);
  assert.equal(profile.checkedAt, '2026-09-17T00:00:00.000Z');
});

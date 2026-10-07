#!/usr/bin/env node
'use strict';

// IndexNow is an indexing notification, not an indexing guarantee. Run only
// after the changed canonical URLs and key file are publicly reachable.
const fs = require('node:fs');
const path = require('node:path');

const HOST = 'patchticker.app';
const SITE = `https://${HOST}`;
const key = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'public', 'indexnow-key.txt'), 'utf8').trim();
if (!/^[a-zA-Z0-9-]{8,128}$/.test(key)) throw new Error('Invalid IndexNow key file');

const dryRun = process.argv.includes('--dry-run');
const paths = process.argv.slice(2).filter(arg => arg !== '--dry-run');
if (!paths.length) {
  console.error('Usage: npm run search:notify -- /briefing /releases/firefox-157-0-1 [--dry-run]');
  process.exit(2);
}
const urlList = [...new Set(paths.map(value => {
  const url = new URL(value, SITE);
  if (url.protocol !== 'https:' || url.host !== HOST || url.hash || url.search) {
    throw new Error(`Only canonical ${SITE} paths without query or fragment are allowed`);
  }
  return url.href;
}))].slice(0, 100);

(async () => {
  if (dryRun) {
    console.log('Would notify IndexNow of:', urlList.join(', '));
    return;
  }
  const keyLocation = `${SITE}/indexnow-key.txt`;
  const keyResponse = await fetch(keyLocation, { signal: AbortSignal.timeout(10000) });
  if (!keyResponse.ok || (await keyResponse.text()).trim() !== key) {
    throw new Error('The deployed IndexNow key file is not reachable or does not match. Deploy first.');
  }
  for (const url of urlList) {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Canonical page is not live: ${url} (${response.status})`);
  }
  const response = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: HOST, key, keyLocation, urlList }),
    signal: AbortSignal.timeout(15000),
  });
  if (![200, 202].includes(response.status)) {
    throw new Error(`IndexNow rejected the notification: HTTP ${response.status}`);
  }
  console.log(`IndexNow received ${urlList.length} canonical URL notification(s): HTTP ${response.status}. Indexing is not guaranteed.`);
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

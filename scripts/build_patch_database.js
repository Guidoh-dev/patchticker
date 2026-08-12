const fs = require('fs');
const path = require('path');
const PROJECT_ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(PROJECT_ROOT, 'backend/.env') });
const db = require(path.join(PROJECT_ROOT, 'backend/src/config/db'));
const { PLATFORMS } = require(path.join(PROJECT_ROOT, 'backend/src/config/platformRegistry'));

const OUT = path.join(PROJECT_ROOT, 'patch-database');
const generatedAt = new Date();
const windowEnd = generatedAt.toISOString().slice(0, 10);
const cutoff = new Date(generatedAt);
cutoff.setUTCDate(cutoff.getUTCDate() - 60);

function arr(v) { return Array.isArray(v) ? v : (typeof v === 'string' ? JSON.parse(v || '[]') : []); }
function obj(v) { return v && typeof v === 'string' ? JSON.parse(v) : v; }
function dateOnly(d) { return new Date(d).toISOString().slice(0,10); }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,80); }
function esc(s) { return String(s ?? '').replace(/\|/g,'\\|').replace(/\n/g,' '); }

function normalizeRow(r) {
  return {
    id: r.id,
    platform: r.platform,
    name: r.name,
    version: r.version,
    releasedAt: dateOnly(r.released_at),
    status: r.status,
    storedScore: r.score == null ? null : Number(r.score),
    impactScore: r.impact_score == null ? null : Number(r.impact_score),
    bugCount: r.bug_count || 0,
    affects: r.affects || '',
    verdict: r.verdict || '',
    reasoning: r.reasoning || '',
    changelog: arr(r.changelog),
    knownIssues: arr(r.known_issues),
    riskFactors: arr(r.risk_factors),
    evidence: arr(r.evidence),
    securityCriticality: obj(r.security_criticality) || { level: 'low', label: 'No Security Patches', cves: [] },
    scraperGap: !!r.scraper_gap,
  };
}

function normalizeApiUpdate(update) {
  return {
    id: update.id,
    platform: update.platform,
    name: update.name,
    version: update.version,
    releasedAt: dateOnly(update.releasedAt),
    status: update.status,
    storedScore: update.score == null ? null : Number(update.score),
    impactScore: update.impactScore == null ? null : Number(update.impactScore),
    bugCount: update.bugCount || 0,
    affects: update.affects || '',
    verdict: update.verdict || '',
    reasoning: update.reasoning || '',
    changelog: arr(update.changelog),
    knownIssues: arr(update.knownIssues),
    riskFactors: arr(update.riskFactors),
    evidence: arr(update.evidence),
    securityCriticality: obj(update.securityCriticality) || { level: 'low', label: 'No security advisory attached', cves: [] },
    scraperGap: false,
  };
}

async function loadRecentUpdates() {
  if (db.isAvailable()) {
    const rows = await db.query(
      'select * from software_updates where released_at >= $1 order by platform asc, released_at desc, created_at desc',
      [dateOnly(cutoff)]
    );
    return rows.rows.map(normalizeRow);
  }

  const apiBase = String(process.env.PATCHTICKER_API_URL || 'https://patchticker.app/api').replace(/\/$/, '');
  const response = await fetch(`${apiBase}/updates`);
  if (!response.ok) throw new Error(`PatchTicker API returned HTTP ${response.status}`);
  const payload = await response.json();
  const updates = Array.isArray(payload) ? payload : payload.data;
  if (!Array.isArray(updates)) throw new Error('PatchTicker API returned an invalid update payload');
  return updates
    .filter(update => Date.parse(update.releasedAt) >= cutoff.getTime())
    .map(normalizeApiUpdate)
    .sort((a, b) => a.platform.localeCompare(b.platform) || Date.parse(b.releasedAt) - Date.parse(a.releasedAt));
}

function ratingTest(u) {
  let score = 8.0;
  const notes = [];
  const risks = u.riskFactors || [];
  const known = u.knownIssues || [];
  const evidence = u.evidence || [];
  const text = `${u.name} ${u.version} ${(u.changelog||[]).join(' ')} ${(u.reasoning||'')}`.toLowerCase();
  const releaseRiskText = `${u.name} ${u.version} ${risks.map(r => `${r.level || ''} ${r.label || ''} ${r.text || r}`).join(' ')}`.toLowerCase();

  if (!evidence.length) { score -= 1.2; notes.push('No evidence source attached.'); }
  else if (evidence.some(e => /official|support|download|status|release/i.test(`${e.source} ${e.url}`))) { score += 0.4; notes.push('Official/vendor source attached.'); }

  if (String(u.version).toLowerCase() === 'latest') { score -= 1.1; notes.push('Version parser returned “Latest” instead of a concrete build.'); }
  // A changelog can mention a supported beta game without making the driver
  // itself a beta. Only the release identity and explicit risk metadata are
  // reliable release-channel signals.
  if (/beta|preview|insider|canary|experimental/.test(releaseRiskText)) { score -= 1.2; notes.push('Beta/preview channel language detected.'); }
  if (/security|cve|critical vulnerability|actively exploited/.test(text)) { score += 0.6; notes.push('Security urgency detected.'); }

  for (const r of risks) {
    const lvl = String(r.level || '').toLowerCase();
    if (lvl === 'critical') score -= 2.8;
    else if (lvl === 'high') score -= 1.9;
    else if (lvl === 'medium') score -= 1.0;
    else if (lvl === 'low') score -= 0.2;
  }
  if (risks.length) notes.push(`${risks.length} risk factor(s) attached.`);

  if (known.length) {
    const hardwareScopedIssues = ['NVIDIA', 'AMD', 'Intel'].includes(u.platform);
    score -= hardwareScopedIssues
      ? Math.min(1.2, known.length * 0.2)
      : Math.min(3.0, known.length * 0.55);
    notes.push(`${known.length} known issue(s) attached.`);
  }
  if (u.bugCount >= 100) { score -= 2.0; notes.push('High bug report count.'); }
  else if (u.bugCount >= 25) { score -= 1.0; notes.push('Moderate bug report count.'); }
  else if (u.bugCount > 0) { score -= 0.25; notes.push('Low bug report count.'); }

  if (u.scraperGap) { score -= 1.5; notes.push('Scraper coverage gap exists.'); }
  if ((u.changelog || []).length >= 2 && !known.length) { score += 0.3; notes.push('Useful changelog with no known issues captured.'); }

  score = Math.max(0, Math.min(10, Math.round(score * 10) / 10));
  const label = score >= 7.2 ? 'positive' : score >= 5.0 ? 'mixed/caution' : 'negative';
  const recommendation = score >= 7.2 ? 'install candidate' : score >= 5.0 ? 'review before installing' : 'avoid or wait';
  return { score, label, recommendation, notes };
}

function mdFor(platformMeta, updates) {
  const lines = [];
  lines.push(`# ${platformMeta.label} Patch Research`);
  lines.push('');
  lines.push(`- Platform key: \`${platformMeta.key}\``);
  lines.push(`- Lane: ${platformMeta.lane}`);
  lines.push(`- Source type: ${platformMeta.sourceType}`);
  lines.push(`- Window: ${dateOnly(cutoff)} through ${windowEnd} (last 60 days)`);
  lines.push(`- Updates captured: ${updates.length}`);
  lines.push('');
  lines.push('| Release | Version | Rating test | Overall | Recommendation | Source |');
  lines.push('|---|---:|---:|---|---|---|');
  for (const u of updates) {
    const rt = u.ratingTest;
    const src = u.evidence?.[0]?.url ? `[${esc(u.evidence[0].source || 'source')}](${u.evidence[0].url})` : 'No source attached';
    lines.push(`| ${esc(u.name)} (${u.releasedAt}) | ${esc(u.version)} | ${rt.score}/10 | ${rt.label} | ${rt.recommendation} | ${src} |`);
  }
  if (!updates.length) lines.push('| No recent stored updates | — | — | coverage gap | Add scraper/source | — |');
  lines.push('');
  lines.push('## Notes');
  if (!updates.length) {
    lines.push('- No updates for this platform were present in `software_updates` inside the last 60 days.');
    lines.push('- This is a coverage gap, not proof that no vendor updates shipped.');
  } else {
    for (const u of updates) {
      lines.push(`### ${u.name}`);
      lines.push(`- ID: \`${u.id}\``);
      lines.push(`- Date: ${u.releasedAt}`);
      lines.push(`- Stored PatchTicker score/status: ${u.storedScore ?? 'not set'} / ${u.status}`);
      lines.push(`- Local rating test: ${u.ratingTest.score}/10 (${u.ratingTest.label}) — ${u.ratingTest.recommendation}`);
      lines.push(`- Affects: ${u.affects || 'Not specified'}`);
      lines.push(`- Verdict: ${u.verdict || 'Not specified'}`);
      lines.push(`- Rating test notes: ${u.ratingTest.notes.length ? u.ratingTest.notes.join(' ') : 'No major positive/negative modifiers detected.'}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

function updateMd(u) {
  const lines = [];
  lines.push(`# ${u.name}`);
  lines.push('');
  lines.push(`- ID: \`${u.id}\``);
  lines.push(`- Platform: ${u.platform}`);
  lines.push(`- Version: ${u.version}`);
  lines.push(`- Released: ${u.releasedAt}`);
  lines.push(`- Stored status: ${u.status}`);
  lines.push(`- Stored score: ${u.storedScore ?? 'not set'}/10`);
  lines.push(`- Local rating test: ${u.ratingTest.score}/10 (${u.ratingTest.label})`);
  lines.push(`- Recommendation: ${u.ratingTest.recommendation}`);
  lines.push('');
  lines.push('## Contents of update');
  lines.push('');
  lines.push('### Changelog');
  if (u.changelog?.length) u.changelog.forEach(x => lines.push(`- ${x}`)); else lines.push('- No changelog captured.');
  lines.push('');
  lines.push('### Known issues');
  if (u.knownIssues?.length) u.knownIssues.forEach(x => lines.push(`- ${x}`)); else lines.push('- No known issues captured.');
  lines.push('');
  lines.push('### Risk factors');
  if (u.riskFactors?.length) u.riskFactors.forEach(x => lines.push(`- **${x.level || 'unknown'}** — ${x.text || x}`)); else lines.push('- No risk factors captured.');
  lines.push('');
  lines.push('## Rating test execution');
  lines.push('');
  lines.push(`Result: **${u.ratingTest.score}/10 — ${u.ratingTest.label}**`);
  lines.push('');
  lines.push('Signals used:');
  if (u.ratingTest.notes.length) u.ratingTest.notes.forEach(x => lines.push(`- ${x}`)); else lines.push('- No major positive/negative modifiers detected.');
  lines.push('');
  lines.push('## Evidence');
  if (u.evidence?.length) u.evidence.forEach(e => lines.push(`- [${e.source || 'Source'}](${e.url}) — ${e.text || ''}`)); else lines.push('- No evidence source attached.');
  lines.push('');
  lines.push('## Raw JSON');
  lines.push('```json');
  lines.push(JSON.stringify(u, null, 2));
  lines.push('```');
  return lines.join('\n');
}

async function buildPatchDatabase() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const rows = await loadRecentUpdates();
  const byPlatform = new Map();
  for (const r of rows) {
    r.ratingTest = ratingTest(r);
    if (!byPlatform.has(r.platform)) byPlatform.set(r.platform, []);
    byPlatform.get(r.platform).push(r);
  }

  const indexRows = [];
  for (const meta of PLATFORMS) {
    const dir = path.join(OUT, slug(meta.key));
    fs.mkdirSync(dir, { recursive: true });
    const updates = byPlatform.get(meta.key) || [];
    fs.writeFileSync(path.join(dir, 'README.md'), mdFor(meta, updates));
    fs.writeFileSync(path.join(dir, 'updates.json'), JSON.stringify({ platform: meta, window: { from: dateOnly(cutoff), to: windowEnd }, updates }, null, 2));
    for (const u of updates) fs.writeFileSync(path.join(dir, `${u.releasedAt}-${slug(u.id)}.md`), updateMd(u));
    const avg = updates.length ? Math.round((updates.reduce((a,u)=>a+u.ratingTest.score,0)/updates.length)*10)/10 : null;
    indexRows.push({ platform: meta.key, label: meta.label, lane: meta.lane, updates: updates.length, averageRating: avg, folder: `./${slug(meta.key)}/` });
  }
  const index = [
    '# PatchTicker Local Patch Research Database', '',
    `Generated: ${windowEnd}`,
    `Window: ${dateOnly(cutoff)} through ${windowEnd} (last 60 days)`, '',
    'This is a local file-based research database generated from current PatchTicker tracked platforms, Supabase `software_updates` rows, scraper results, and official-source links attached to each update. It does not modify Supabase.', '',
    '## Platform Summary', '',
    '| Platform | Lane | Updates | Avg local rating | Folder |',
    '|---|---|---:|---:|---|',
    ...indexRows.map(r => `| ${r.label} | ${r.lane} | ${r.updates} | ${r.averageRating ?? '—'} | [${r.folder}](${r.folder}) |`),
    '',
    '## Rating Test Method', '',
    '- Starts from a neutral-positive installability baseline.',
    '- Adds weight for official/vendor evidence and security urgency.',
    '- Penalizes beta/preview release-channel labels, concrete known issues, medium/high/critical risk factors, missing evidence, generic `Latest` versions, high bug counts, and scraper gaps.',
    '- Labels: `positive` >= 7.2, `mixed/caution` 5.0–7.1, `negative` < 5.0.',
    '',
    '## Interpretation Notes', '',
    '- Community ratings are separate from this source audit and appear publicly only after verified user votes exist.',
    '- Stored analysis metadata is preserved per update; the local rating test is a reproducible source-quality comparison, not a replacement for the public PatchTicker score.',
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'README.md'), index);
  fs.writeFileSync(path.join(OUT, 'platform-summary.json'), JSON.stringify(indexRows, null, 2));
  await db.shutdown();
  console.log(`Wrote ${OUT}`);
  console.table(indexRows);
}

if (require.main === module) {
  buildPatchDatabase().catch(async error => {
    console.error(error);
    await db.shutdown();
    process.exitCode = 1;
  });
}

module.exports = { ratingTest, buildPatchDatabase };

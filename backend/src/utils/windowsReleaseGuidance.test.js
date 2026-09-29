'use strict';

const { publicWindowsGuidance, PREVIEW_VERDICT } = require('./windowsReleaseGuidance');
const { __test: pipeline } = require('../services/pipelineService');
const { __test: updates } = require('../services/updatesService');

const legacyVerdict = 'Review the KB notes and early install reports before broad rollout; security fixes usually make this worth scheduling quickly.';
const legacyReasoning = 'Windows cumulative updates can include security patches, servicing-stack changes, driver interactions, and known issues.';

test('future Windows previews receive optional-preview guidance at ingestion', () => {
  const context = pipeline.platformContext('Windows', { name: 'Windows 11 KB5124006 Preview' });
  expect(context.verdict).toBe(PREVIEW_VERDICT);
  expect(context.reasoning).toMatch(/optional/);
  expect(context.verdict).not.toMatch(/security fixes/i);
});

test('legacy preview rows receive corrected guidance on public reads', () => {
  const row = updates.rowToUpdate({
    id: 'windows-kb5124006', platform: 'Windows', name: 'Windows 11 KB5124006 Preview',
    version: 'KB5124006', released_at: new Date('2026-09-22'),
    score: 4.8, impact_score: 5, verdict: legacyVerdict, reasoning: legacyReasoning,
    changelog: '[]', known_issues: '[]', risk_factors: '[]', evidence: '[]', subreddits: '[]',
  });
  expect(row.verdict).toBe(PREVIEW_VERDICT);
  expect(row.reasoning).toMatch(/optional/);
  expect(row.score).toBe(4.8);
});

test('security updates and source-specific preview guidance stay unchanged', () => {
  expect(publicWindowsGuidance('Windows', 'Windows 11 KB5124012 Security', legacyVerdict, legacyReasoning))
    .toEqual({ verdict: legacyVerdict, reasoning: legacyReasoning });
  expect(publicWindowsGuidance('Windows', 'Windows 11 KB5124006 Preview', 'Wait for OEM testing.', 'Specific known issue.'))
    .toEqual({ verdict: 'Wait for OEM testing.', reasoning: 'Specific known issue.' });
});

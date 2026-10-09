'use strict';

// Steam's official announcement feed also carries progress reports. A news
// article is not an installable game build merely because its title says
// "update" or its body mentions gameplay.
function isEditorialReportTitle(value) {
  const title = String(value || '');
  return /(?:^|:\s*)(?:an?\s+)?update from (?:the|our) [\w -]{1,48} team\b/i.test(title)
    || /(?:^|:\s*)competitive integrity update\b/i.test(title);
}

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const RELEASE_TIME_RE = new RegExp(
  `\\b(?:upcoming patch drops? on|this update begins on|(?:the )?(?:update|patch) (?:goes live|launches) on)\\s+` +
  `(${MONTHS})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2}),?\\s+at\\s+` +
  `(\\d{1,2})\\s*:\\s*(\\d{2})(?:\\s*:\\s*(\\d{2}))?\\s*\\(?UTC\\)?`,
  'i'
);

function scheduledSteamReleaseAt(value) {
  const text = String(value || '').replace(/\s+/g, ' ').slice(0, 12000);
  const match = text.match(RELEASE_TIME_RE);
  if (!match) return null;
  const month = new Date(`${match[1]} 1, 2000 00:00:00 UTC`).getUTCMonth();
  const day = Number(match[2]);
  const year = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] || 0);
  if (day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(Date.UTC(year, month, day, hour, minute, second));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day ? date : null;
}

// Some publishers give a rollout day but no hour. That is evidence for the
// calendar date only, not proof that a build was available at midnight.
function scheduledSteamReleaseDay(value, publishedAt) {
  const text = String(value || '').replace(/\s+/g, ' ').slice(0, 1600);
  const publication = new Date(publishedAt);
  if (!Number.isFinite(publication.getTime())) return null;
  const match = text.match(new RegExp(
    `\\b(?:rolling out|plan to launch|planning to launch|will launch)\\b.{0,160}\\b(?:update|patch)\\b.{0,160}\\bon\\s+` +
    `(${MONTHS})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`, 'i'
  ));
  if (!match) return null;
  const month = new Date(`${match[1]} 1, 2000 00:00:00 UTC`).getUTCMonth();
  const day = Number(match[2]);
  let year = match[3] ? Number(match[3]) : publication.getUTCFullYear();
  let date = new Date(Date.UTC(year, month, day));
  if (!match[3] && date.getTime() < Date.UTC(publication.getUTCFullYear(), publication.getUTCMonth(), publication.getUTCDate())) {
    year += 1;
    date = new Date(Date.UTC(year, month, day));
  }
  const leadDays = (date.getTime() - publication.getTime()) / 86400000;
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day
    && leadDays >= -1 && leadDays <= 45 ? date : null;
}

module.exports = { isEditorialReportTitle, scheduledSteamReleaseAt, scheduledSteamReleaseDay };

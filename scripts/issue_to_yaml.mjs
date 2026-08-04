#!/usr/bin/env node
/**
 * Converts a GitHub "Add a workshop" issue-form body (markdown with
 * "### <Label>\n\n<value>" sections) into a workshop YAML file.
 * Used by .github/workflows/issue-to-pr.yml.
 *
 * Env:  ISSUE_BODY (required)
 * Out:  writes data/workshops/<conf>-<year>-<slug>.yml
 *       prints the created path on stdout (last line)
 * Exits non-zero with a human-readable message if required fields are missing.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { WORKSHOPS_DIR, recordDeadlineObservation } from '../lib/workshops.mjs';
import { resolveDeadlineUtcMs, isValidTimezone, assembleDeadline } from '../lib/dates.mjs';

const body = process.env.ISSUE_BODY;
if (!body) {
  console.error('ISSUE_BODY env var is empty.');
  process.exit(1);
}

// Parse "### Label\n\nvalue" sections.
const sections = {};
const re = /^###\s+(.+?)\s*\r?\n([\s\S]*?)(?=^###\s+|\s*$(?![\s\S]))/gm;
let m;
while ((m = re.exec(body)) !== null) {
  let value = m[2].trim();
  if (value === '_No response_' || value === 'None') value = '';
  sections[m[1].trim().toLowerCase()] = value;
}
const get = (label) => sections[label.toLowerCase()] ?? '';

const errors = [];
const name = get('Workshop name');
const conference = get('Conference').toLowerCase().trim();
const yearStr = get('Year').trim();
const website = get('Workshop website').trim();
const topicsStr = get('Topics');

if (!name) errors.push('Workshop name is required.');
if (!conference) errors.push('Conference is required.');
if (!/^\d{4}$/.test(yearStr)) errors.push(`Year must be a 4-digit year (got "${yearStr}").`);
if (!/^https?:\/\//.test(website)) errors.push('Workshop website must be a full http(s) URL.');
const topics = topicsStr
  .split(/[,\n]/)
  .map((t) => t.trim().toLowerCase())
  .filter(Boolean);
if (topics.length === 0) errors.push('At least one topic id is required (see data/topics.yml).');
// Deadline is picked from year/month/day/hour/minute dropdowns and reassembled
// here, so there's no free-text date to mis-format. assembleDeadline returns ''
// when nothing was picked and throws on a partial or impossible date.
let submissionDeadline = '';
try {
  submissionDeadline = assembleDeadline({
    year: get('Deadline year'),
    month: get('Deadline month'),
    day: get('Deadline day'),
    hour: get('Deadline hour'),
    minute: get('Deadline minute'),
  });
} catch (e) {
  errors.push(e.message);
}
if (errors.length) {
  console.error('Could not create a workshop entry from this issue:\n- ' + errors.join('\n- '));
  process.exit(1);
}

const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'workshop';
const acronym = get('Acronym');
const slugBase = slugify(acronym || name);
let filename = `${conference}-${yearStr}-${slugBase}.yml`;
let i = 2;
while (fs.existsSync(path.join(WORKSHOPS_DIR, filename))) {
  filename = `${conference}-${yearStr}-${slugBase}-${i++}.yml`;
}

const record = { name, acronym: acronym || '', conference, year: Number(yearStr), website, topics };
const optional = {
  submission_deadline: submissionDeadline,
  timezone: get('Timezone'),
  deadline_notes: get('Deadline notes'),
  notification_date: get('Notification date'),
  workshop_date: get('Workshop date'),
  openreview_venue_id: get('OpenReview venue ID'),
  proceedings_url: get('Accepted-papers page URL'),
  submission_portal: get('Submission portal').toLowerCase(),
};
for (const [k, v] of Object.entries(optional)) if (v) record[k] = v;
// timezone is meaningless without a deadline — drop an orphan one so the data
// stays clean (the form requires a timezone, but the deadline is optional).
if (record.timezone && !record.submission_deadline) delete record.timezone;

// Normalize a contributor's deadline to UTC so stored deadlines are uniform,
// without forcing them to do the math: they pick any timezone (AoE, a civil
// zone, whatever the CFP uses) and the bot converts to the equivalent UTC
// instant — same rule as the OpenReview importer. The original wall-clock +
// zone is kept in deadline_notes as a provenance breadcrumb that still matches
// the CFP. UTC needs no conversion.
if (record.submission_deadline && record.timezone && isValidTimezone(record.timezone)) {
  const tz = record.timezone;
  if (tz !== 'UTC') {
    const ms = resolveDeadlineUtcMs(record.submission_deadline, tz);
    if (Number.isFinite(ms)) {
      const d = new Date(ms);
      const pad = (n) => String(n).padStart(2, '0');
      const original = `${record.submission_deadline} ${tz}`;
      record.submission_deadline = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
      record.timezone = 'UTC';
      const note = `submitted as ${original}`;
      record.deadline_notes = record.deadline_notes ? `${record.deadline_notes} (${note})` : note;
    }
  }
}
const organizers = get('Organizers').split('\n').map((s) => s.trim()).filter(Boolean);
if (organizers.length) record.organizers = organizers;
const notes = get('Anything else');
if (notes) record.notes = notes;
// Seed the observation log so a contributed workshop starts with the same
// provenance a bot-discovered one gets: one entry for the value as submitted, in
// the zone it is stored in. Without this the log would only begin at the first
// later bot observation, and the board's "just announced" note would appear for
// discovered workshops but not contributed ones.
record.added = new Date().toISOString().slice(0, 10);
// Set directly rather than via recordDeadlineObservation(): that helper seeds
// from the value being replaced, so on a brand-new entry — where the value is
// already in place and nothing is changing — it correctly reports "no change" and
// writes nothing. This mirrors the importer's creation path.
if (record.submission_deadline) {
  record.deadline_history = [
    { value: record.submission_deadline, recorded: record.added, timezone: record.timezone || 'UTC' },
  ];
}

const outPath = path.join(WORKSHOPS_DIR, filename);
fs.writeFileSync(outPath, yaml.dump(record, { lineWidth: 120, quotingType: '"' }));
console.log(`Created ${path.relative(process.cwd(), outPath)}`);
console.log(outPath);

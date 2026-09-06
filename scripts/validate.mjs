#!/usr/bin/env node
/**
 * Validates every workshop YAML file:
 *   1. JSON Schema (schema/workshop.schema.json)
 *   2. Cross-file rules: conference/topic ids exist, filename matches
 *      conference+year, deadline parses & is sane, no duplicates.
 *   3. data/editions.yml: valid conference ids, parsable start/end dates,
 *      no duplicate rows; warns when a tracked current/future year has none.
 *   4. data/proposal_calls.yml: valid conference ids, a parsable deadline with
 *      a timezone, an http(s) url, known fields, no duplicate rows; warns when
 *      a conference's newest call closed over a year ago with no successor.
 *
 * Exit code 1 if any ERROR. Warnings never fail the build.
 *
 * Usage:
 *   node scripts/validate.mjs                  # print report to stdout
 *   node scripts/validate.mjs --report out.md  # also write markdown report
 */
import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { REPO_ROOT,
  listWorkshopFiles,
  readWorkshopFile,
  loadConferences,
  loadTopics,
  loadEditions, loadProposalCallRows, slugOfFile } from '../lib/workshops.mjs';
import { resolveDeadlineUtcMs, parseDateUtcMs, parseDeadlineString, isValidTimezone, DAY_MS, TWO_YEARS_MS } from '../lib/dates.mjs';
import { validateChangesFeed } from './validate_changes_feed.mjs';

const reportFlag = process.argv.indexOf('--report');
const reportPath = reportFlag !== -1 ? process.argv[reportFlag + 1] : null;

const schema = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'schema', 'workshop.schema.json'), 'utf8'),
);
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

const conferences = new Map(loadConferences().map((c) => [c.id, c]));
const topics = new Set(loadTopics().map((t) => t.id));
const editions = loadEditions();
const editionEnds = new Map(
  editions.filter((e) => e.end).map((e) => [`${e.conference}-${e.year}`, parseDateUtcMs(e.end)]),
);

const errors = []; // { file, msg }
const warnings = [];
const seen = new Map(); // dedupe key -> file

const normalizeName = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/\b(the|a|an|workshop|on|for|at|of|and|in|st|nd|rd|th|\d+(st|nd|rd|th)?)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const NOW = Date.now();

for (const filePath of listWorkshopFiles()) {
  const rel = path.relative(REPO_ROOT, filePath);
  let entry;
  try {
    entry = readWorkshopFile(filePath);
  } catch (e) {
    errors.push({ file: rel, msg: `YAML does not parse: ${e.message.split('\n')[0]}` });
    continue;
  }
  const w = entry.raw;
  if (w == null || typeof w !== 'object' || Array.isArray(w)) {
    errors.push({ file: rel, msg: 'File must contain a single YAML mapping (key: value pairs).' });
    continue;
  }

  // Drop empty-string optional fields so the template's blanks don't trip the schema.
  for (const k of Object.keys(w)) {
    if (w[k] === '' && !['name', 'website'].includes(k)) delete w[k];
    if (Array.isArray(w[k]) && w[k].length === 0 && k !== 'topics') delete w[k];
  }

  // 1. JSON Schema
  if (!validateSchema(w)) {
    for (const err of validateSchema.errors ?? []) {
      const where = err.instancePath ? `\`${err.instancePath.slice(1)}\`` : 'top level';
      errors.push({ file: rel, msg: `Schema: ${where} ${err.message}` });
    }
    // Fall through: the cross-file checks below are independent, so report
    // everything at once instead of making contributors fix-and-push twice.
  }
  if (typeof w.name !== 'string' || typeof w.conference !== 'string' || !Array.isArray(w.topics ?? [])) {
    continue; // too malformed for cross-checks to make sense
  }

  // 2. Cross-file rules
  if (!conferences.has(w.conference)) {
    errors.push({
      file: rel,
      msg: `Unknown conference \`${w.conference}\`. Valid ids: ${[...conferences.keys()].join(', ')} (see data/conferences.yml).`,
    });
  }
  for (const t of w.topics ?? []) {
    if (!topics.has(t)) {
      errors.push({ file: rel, msg: `Unknown topic \`${t}\`. See data/topics.yml for valid ids.` });
    }
  }

  const base = path.basename(filePath).replace(/\.ya?ml$/, '');
  const expectedPrefix = `${w.conference}-${w.year}-`;
  if (!base.startsWith(expectedPrefix)) {
    errors.push({
      file: rel,
      msg: `Filename must start with \`${expectedPrefix}\` (it encodes conference and year), e.g. \`${expectedPrefix}my-workshop.yml\`.`,
    });
  }
  if (!/^[a-z0-9-]+$/.test(base)) {
    errors.push({ file: rel, msg: 'Filename may only contain lowercase letters, digits, and hyphens.' });
  }

  if (w.timezone && !isValidTimezone(w.timezone)) {
    errors.push({
      file: rel,
      msg: `Invalid timezone \`${w.timezone}\`. Use "AoE", "UTC", or an IANA name like "America/Los_Angeles".`,
    });
  }

  let deadlineMs = null;
  if (w.submission_deadline) {
    // A deadline without a timezone is ambiguous (off by up to a day depending
    // on what the submitter meant), so require it explicitly rather than
    // silently assuming AoE. Date-only "YYYY-MM-DD" still needs a timezone too.
    if (!w.timezone) {
      errors.push({
        file: rel,
        msg: '`submission_deadline` is set but `timezone` is missing. Add `timezone: AoE` (Anywhere on Earth, the ML default), `timezone: UTC`, or an IANA name like `America/Los_Angeles` so the deadline is unambiguous.',
      });
    }
    deadlineMs = resolveDeadlineUtcMs(w.submission_deadline, w.timezone || 'AoE');
    if (deadlineMs == null) {
      errors.push({
        file: rel,
        msg: `\`submission_deadline\` "${w.submission_deadline}" is not a valid "YYYY-MM-DD" or "YYYY-MM-DD HH:MM".`,
      });
    } else {
      // Sanity: catch typos without rejecting historical entries.
      if (deadlineMs - NOW > TWO_YEARS_MS) {
        errors.push({
          file: rel,
          msg: '`submission_deadline` is more than 2 years in the future — please double-check the year.',
        });
      }
      const dlYear = Number(String(w.submission_deadline).slice(0, 4));
      if (Math.abs(dlYear - w.year) > 1) {
        errors.push({
          file: rel,
          msg: `\`submission_deadline\` year (${dlYear}) doesn't match the edition year (${w.year}).`,
        });
      }
    }
  } else if (w.year >= new Date(NOW).getUTCFullYear()) {
    const edEnd = editionEnds.get(`${w.conference}-${w.year}`);
    if (edEnd != null && NOW > edEnd + DAY_MS) {
      // Conference is over — the entry renders as "Past", which is fine.
    } else if (w.not_running) {
      // An edition that is not taking place has nothing to announce; asking for
      // a deadline would be asking to fill in a date that will never exist.
    } else {
      warnings.push({ file: rel, msg: 'No `submission_deadline` set for a current/future edition (will show as TBA).' });
    }
  }

  // Independent of the deadline branch above: an entry with neither a deadline
  // nor a website used to get no warning at all, because this sat inside the
  // has-deadline arm.
  if (!w.website) {
    warnings.push({ file: rel, msg: 'No `website` — the site will show a "help us add it" prompt.' });
  }

  // `not_running` and `review_ack.official_list` are the two opposite verdicts on
  // one question — "this entry is absent from the official list" — so an entry
  // carrying both is a contradiction, not a belt-and-braces.
  if (w.not_running && w.review_ack?.official_list) {
    errors.push({
      file: rel,
      msg:
        '`not_running` and `review_ack.official_list` are mutually exclusive: the first says this edition is not taking place, ' +
        'the second says it is running and merely absent from that list. Keep exactly one.',
    });
  }
  if (w.not_running?.reason === 'not_on_official_list' && !w.not_running.source) {
    warnings.push({
      file: rel,
      msg: '`not_running.reason: not_on_official_list` with no `source` — record the list URL, or the call cannot be re-checked without repeating the research.',
    });
  }

  // Per-track deadlines need an explicit, valid timezone too (same ambiguity).
  if (Array.isArray(w.tracks)) {
    for (const t of w.tracks) {
      if (t && t.submission_deadline) {
        if (!t.timezone) {
          errors.push({
            file: rel,
            msg: `Track "${t.name ?? '?'}" has a \`submission_deadline\` but no \`timezone\`. Add one (AoE / UTC / IANA name).`,
          });
        } else if (!isValidTimezone(t.timezone)) {
          errors.push({
            file: rel,
            msg: `Track "${t.name ?? '?'}" has invalid timezone \`${t.timezone}\`. Use "AoE", "UTC", or an IANA name.`,
          });
        }
        if (resolveDeadlineUtcMs(t.submission_deadline, t.timezone || 'AoE') == null) {
          errors.push({
            file: rel,
            msg: `Track "${t.name ?? '?'}" \`submission_deadline\` "${t.submission_deadline}" is not a valid "YYYY-MM-DD" or "YYYY-MM-DD HH:MM".`,
          });
        }
      }
    }
  }

  for (const [field, label] of [
    ['notification_date', 'notification_date'],
    ['workshop_date', 'workshop_date'],
  ]) {
    if (w[field] && parseDateUtcMs(w[field]) == null) {
      errors.push({ file: rel, msg: `\`${label}\` "${w[field]}" is not a valid calendar date.` });
    }
  }
  if (deadlineMs != null && w.notification_date) {
    const notif = parseDateUtcMs(w.notification_date);
    if (notif != null && notif + DAY_MS < deadlineMs) {
      warnings.push({ file: rel, msg: '`notification_date` is before the submission deadline — is that intended?' });
    }
  }
  if (deadlineMs != null && w.workshop_date) {
    const ws = parseDateUtcMs(w.workshop_date);
    if (ws != null && ws + DAY_MS < deadlineMs) {
      errors.push({ file: rel, msg: '`workshop_date` is before the submission deadline.' });
    }
  }

  // Duplicates: same conference+year+similar name
  const key = `${w.conference}|${w.year}|${normalizeName(w.name)}`;
  if (seen.has(key)) {
    errors.push({
      file: rel,
      msg: `Looks like a duplicate of \`${seen.get(key)}\` (same conference, year, and a very similar name).`,
    });
  } else {
    seen.set(key, rel);
  }
}

// ---- entries that cannot join their own series ----
// `openreview_venue_id` is what links editions of one workshop across years
// (Tier 4 in computeRelations, keyed on the trailing stem). The field is
// optional and its help text describes it as being about papers, so nothing
// tells a submitter it is also the identity key — an entry without one links to
// nothing, silently, and the page simply shows no "Other editions".
//
// Warning rather than error, and only when it actually costs something: another
// entry of the same conference already carries a matching acronym, so this one
// has a series to join and cannot. Every entry has the field today (the
// OpenReview crawler sets it unconditionally), so this is quiet until the first
// hand-submitted non-OpenReview workshop arrives — which is exactly when nobody
// would otherwise notice.
{
  const key = (w) =>
    `${w.conference}|${String(w.acronym ?? '')
      .toLowerCase()
      .replace(/(19|20)\d{2}/g, '')
      .replace(/[^a-z0-9]/g, '')}`;
  const byAcr = new Map();
  const rows = [];
  for (const f of listWorkshopFiles()) {
    // A YAML file carries no slug — it is derived from the filename — so the
    // file path is what identifies an entry here. A file that does not parse is
    // already an error from the main loop; skip it rather than reporting twice.
    let w;
    try {
      w = readWorkshopFile(f).raw;
    } catch {
      continue;
    }
    if (!w || !w.conference || !w.acronym) continue;
    rows.push([f, w]);
    const k = key(w);
    if (!byAcr.has(k)) byAcr.set(k, []);
    byAcr.get(k).push([f, w]);
  }
  for (const [f, w] of rows) {
    if (w.openreview_venue_id) continue;
    const peers = (byAcr.get(key(w)) ?? []).filter(([pf, p]) => pf !== f && p.year !== w.year);
    if (!peers.length) continue;
    warnings.push({
      file: path.relative(REPO_ROOT, f),
      msg:
        'No `openreview_venue_id`, so this entry cannot link to the other editions it appears to ' +
        `have (${peers.map(([, p]) => p.year).sort().join(', ')}). That field is the series ` +
        'identity key, not just a papers link — add it and the editions link themselves.',
    });
  }
}

// ---- data/editions.yml: row sanity + coverage for tracked years ----
{
  const seenEd = new Set();
  for (const e of editions) {
    const ref = `data/editions.yml (${e?.conference ?? '?'} ${e?.year ?? '?'})`;
    if (!conferences.has(e?.conference)) errors.push({ file: ref, msg: 'Unknown conference id.' });
    if (!Number.isInteger(e?.year)) errors.push({ file: ref, msg: '`year` must be an integer.' });
    const endMs = e?.end != null ? parseDateUtcMs(e.end) : null;
    if (endMs == null) errors.push({ file: ref, msg: '`end` is required and must be a valid YYYY-MM-DD date.' });
    if (e?.start != null) {
      const startMs = parseDateUtcMs(e.start);
      if (startMs == null) errors.push({ file: ref, msg: '`start` is not a valid calendar date.' });
      else if (endMs != null && startMs > endMs) errors.push({ file: ref, msg: '`start` is after `end`.' });
    }
    const k = `${e?.conference}-${e?.year}`;
    if (seenEd.has(k)) errors.push({ file: ref, msg: 'Duplicate conference-year row.' });
    seenEd.add(k);
  }
  const yearNow = new Date(NOW).getUTCFullYear();
  const trackedCY = new Set();
  for (const f of listWorkshopFiles()) {
    try {
      const { raw } = readWorkshopFile(f);
      if (raw?.conference && Number(raw?.year) >= yearNow) trackedCY.add(`${raw.conference}-${raw.year}`);
    } catch { /* unparseable files are reported above */ }
  }
  for (const k of [...trackedCY].sort()) {
    if (!editionEnds.has(k)) {
      warnings.push({
        file: 'data/editions.yml',
        msg: `No edition dates for tracked ${k.replace('-', ' ')} — "Past" detection falls back to typical_month.`,
      });
    }
  }
}

// ---- data/proposal_calls.yml: call-for-workshop-proposals rows ----
// Written daily by scripts/sync_proposal_calls.mjs for the conferences whose
// proposal venue is on OpenReview and by hand for the rest; either way a bad
// row reaches the homepage, so it is checked here like editions.yml.
{
  const rel = 'data/proposal_calls.yml';
  const ALLOWED = new Set(['conference', 'year', 'proposal_deadline', 'timezone', 'url', 'openreview_venue_id', 'deadline_notes', 'notes']);
  const seenCall = new Set();
  const newest = new Map(); // conference -> { year, ms } of its latest recorded cycle
  for (const r of loadProposalCallRows()) {
    if (!r || typeof r !== 'object') {
      errors.push({ file: rel, msg: 'Every row must be a mapping (conference, year, proposal_deadline, timezone, url).' });
      continue;
    }
    const ref = `${rel} (${r.conference ?? '?'} ${r.year ?? '?'})`;
    if (!conferences.has(r.conference)) errors.push({ file: ref, msg: 'Unknown conference id.' });
    if (!Number.isInteger(r.year)) errors.push({ file: ref, msg: '`year` must be an integer.' });
    if (!parseDeadlineString(r.proposal_deadline)) {
      errors.push({ file: ref, msg: '`proposal_deadline` must be a real date, YYYY-MM-DD or YYYY-MM-DD HH:MM (quoted).' });
    }
    if (!r.timezone) errors.push({ file: ref, msg: '`timezone` is required — UTC, AoE or an IANA name.' });
    else if (!isValidTimezone(r.timezone)) errors.push({ file: ref, msg: `Unknown timezone "${r.timezone}".` });
    if (typeof r.url !== 'string' || !/^https?:\/\/\S+$/.test(r.url)) errors.push({ file: ref, msg: '`url` must be an http(s) link to the call.' });
    for (const k of ['openreview_venue_id', 'deadline_notes', 'notes']) {
      if (r[k] != null && typeof r[k] !== 'string') errors.push({ file: ref, msg: `\`${k}\` must be a string.` });
    }
    for (const k of Object.keys(r)) if (!ALLOWED.has(k)) errors.push({ file: ref, msg: `Unknown field \`${k}\`.` });
    const key = `${r.conference}-${r.year}`;
    if (seenCall.has(key)) errors.push({ file: ref, msg: 'Duplicate conference-year row.' });
    seenCall.add(key);
    const ms = r.timezone ? resolveDeadlineUtcMs(r.proposal_deadline, r.timezone) : null;
    const cur = newest.get(r.conference);
    if (ms != null && (!cur || r.year > cur.year || (r.year === cur.year && ms > cur.ms))) newest.set(r.conference, { year: r.year, ms });
  }
  // A lapsed cycle: the conference's newest call closed long enough ago that
  // the next one has normally been announced, and nothing recorded it. The
  // daily sync only finds venues on OpenReview, so this is the nudge to add
  // the row by hand for a conference that publishes its call elsewhere.
  const LAPSED_MS = 365 * DAY_MS;
  for (const [conf, cur] of newest) {
    if (NOW - cur.ms > LAPSED_MS) {
      warnings.push({
        file: rel,
        msg: `The newest ${conferences.get(conf)?.name ?? conf} proposal call (${cur.year}) closed ${Math.round((NOW - cur.ms) / DAY_MS)} days ago and no later cycle is recorded.`,
      });
    }
  }
}

// ---- data/changes.json: the published /changes/ feed ----
//
// Shape only. It cannot know whether an extension was really 5 days — the
// workshop's own deadline_history says that — but it can refuse a row claiming
// a deadline moved without the two dates it moved between, which is what the
// retracted hand-authored feed looked like on every row.
{
  const rel = 'data/changes.json';
  const abs = path.join(REPO_ROOT, rel);
  if (fs.existsSync(abs)) {
    let feed = null;
    try {
      feed = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (e) {
      errors.push({ file: rel, msg: `JSON does not parse: ${e.message.split('\n')[0]}` });
    }
    if (feed !== null) {
      const slugs = new Set();
      const addedBySlug = new Map();
      for (const f of listWorkshopFiles()) {
        const slug = slugOfFile(f);
        slugs.add(slug);
        try {
          const { raw } = readWorkshopFile(f);
          if (raw?.added) addedBySlug.set(slug, String(raw.added));
        } catch { /* unparseable files are reported above */ }
      }
      for (const msg of validateChangesFeed(feed, { slugs, addedBySlug })) errors.push({ file: rel, msg });
    }
  }
  // Absent is fine: a fork, a fresh clone, or the period before the alerts
  // pipeline has run once. /changes/ renders its empty state.
}

// ---- Report ----
const lines = [];
const total = listWorkshopFiles().length;
if (errors.length === 0) {
  lines.push(`### ✅ Data validation passed`, '', `${total} workshop file(s) checked, no errors.`);
} else {
  lines.push(
    `### ❌ Data validation failed`,
    '',
    `${errors.length} error(s) across ${new Set(errors.map((e) => e.file)).size} file(s). Please fix the items below and push again — see \`data/workshops/_template.yml\` and CONTRIBUTING.md for the expected format.`,
    '',
  );
  for (const e of errors) lines.push(`- **${e.file}** — ${e.msg}`);
}
if (warnings.length) {
  lines.push('', `<details><summary>⚠️ ${warnings.length} warning(s) (non-blocking)</summary>`, '');
  for (const wn of warnings) lines.push(`- **${wn.file}** — ${wn.msg}`);
  lines.push('', '</details>');
}
const report = lines.join('\n') + '\n';
console.log(report);
if (reportPath) fs.writeFileSync(reportPath, report);
process.exit(errors.length ? 1 : 0);

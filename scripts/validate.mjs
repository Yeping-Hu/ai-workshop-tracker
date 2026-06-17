#!/usr/bin/env node
/**
 * Validates every workshop YAML file:
 *   1. JSON Schema (schema/workshop.schema.json)
 *   2. Cross-file rules: conference/topic ids exist, filename matches
 *      conference+year, deadline parses & is sane, no duplicates.
 *   3. data/editions.yml: valid conference ids, parsable start/end dates,
 *      no duplicate rows; warns when a tracked current/future year has none.
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
import {
  REPO_ROOT,
  listWorkshopFiles,
  readWorkshopFile,
  loadConferences,
  loadTopics,
  loadEditions,
} from '../lib/workshops.mjs';
import { resolveDeadlineUtcMs, parseDateUtcMs, isValidTimezone, DAY_MS } from '../lib/dates.mjs';

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
const TWO_YEARS = 2 * 366 * DAY_MS;

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
      if (deadlineMs - NOW > TWO_YEARS) {
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
  if (!w.website) {
    warnings.push({ file: rel, msg: 'No `website` — the site will show a "help us add it" prompt.' });
  }
  } else if (w.year >= new Date(NOW).getUTCFullYear()) {
    const edEnd = editionEnds.get(`${w.conference}-${w.year}`);
    if (edEnd != null && NOW > edEnd + DAY_MS) {
      // Conference is over — the entry renders as "Past", which is fine.
    } else {
      warnings.push({ file: rel, msg: 'No `submission_deadline` set for a current/future edition (will show as TBA).' });
    }
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

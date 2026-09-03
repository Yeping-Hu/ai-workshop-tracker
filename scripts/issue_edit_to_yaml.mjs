#!/usr/bin/env node
/**
 * Applies a GitHub "Edit a workshop" issue-form to an EXISTING workshop YAML.
 * Updates only the fields the contributor filled in and leaves everything else
 * — including the entry's identity (name/conference/year) and any fields not on
 * the form — untouched. A new deadline is converted from the contributor's
 * chosen timezone to UTC (same rule as the add path and the OpenReview importer),
 * so a maintainer never has to clean up a wrong-timezone manual edit. Runs via
 * the edit-to-pr workflow, which opens a PR the maintainer reviews.
 *
 * Env:  ISSUE_BODY (required)
 * Out:  rewrites data/workshops/<slug>.yml; prints the path (last line).
 * Exits non-zero with a human-readable message on any problem.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { WORKSHOPS_DIR, recordDeadlineObservation } from '../lib/workshops.mjs';
import { resolveDeadlineUtcMs, isValidTimezone, assembleDeadline } from '../lib/dates.mjs';
import { parseTopics, parseSections } from '../lib/issue_form.mjs';
import { syncedValue, LEGACY_IMPORT_NOTE, isAutoTopicsNote } from './discover_openreview.mjs';

/**
 * Pure transform: apply the filled-in edit fields to an existing record.
 * Returns { record, changes } (record is a fresh object) or throws Error with a
 * human-readable message. Exported for tests — no filesystem access.
 */
export function applyWorkshopEdit(existing, fields) {
  const r = { ...existing };
  const changes = [];
  const deadline = (fields.deadline || '').trim();
  const timezone = (fields.timezone || '').trim();
  const website = (fields.website || '').trim();
  const deadlineNotes = (fields.deadlineNotes || '').trim();
  const anything = (fields.anything || '').trim();
  // Topics arrive as the multi-select dropdown's chosen ids. Because a GitHub
  // issue form can't pre-check the entry's current topics, a selection here
  // *replaces* the whole list (it can't merge) — the form copy says so.
  const topics = Array.isArray(fields.topics)
    ? [...new Set(fields.topics.map((t) => String(t).trim().toLowerCase()).filter(Boolean))]
    : [];

  if (website) {
    if (!/^https?:\/\//.test(website)) throw new Error('Workshop website must be a full http(s) URL.');
    if (website !== r.website) { r.website = website; changes.push('website'); }
  }

  if (deadline) {
    // A new deadline needs a timezone so we can normalize it to a UTC instant.
    if (!timezone) throw new Error('You entered a new deadline but no timezone — pick the timezone the deadline is written in.');
    if (!isValidTimezone(timezone)) throw new Error(`Unknown timezone "${timezone}".`);
    const ms = resolveDeadlineUtcMs(deadline, timezone);
    if (!Number.isFinite(ms)) throw new Error(`Could not parse the deadline "${deadline}".`);

    let value = deadline;
    let provenance = null;
    if (timezone !== 'UTC') {
      const d = new Date(ms);
      const pad = (n) => String(n).padStart(2, '0');
      value = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
      provenance = `submitted as ${deadline} ${timezone}`;
    }
    // A human moving a deadline is an observation like any other: log it before
    // overwriting, so the history shows the move rather than silently jumping.
    recordDeadlineObservation(r, value, new Date().toISOString().slice(0, 10), 'UTC');
    r.submission_deadline = value;
    r.timezone = 'UTC';
    changes.push('submission_deadline');

    // Keep deadline_notes honest. A human edit must not keep looking bot-managed:
    // a machine-generated note (the bot's sync stamp or the legacy import marker)
    // is dropped/replaced so auto-sync stays frozen and the text isn't stale; a
    // human-written note is preserved (and gets the conversion breadcrumb).
    const machineNote = syncedValue(r.deadline_notes) != null || r.deadline_notes === LEGACY_IMPORT_NOTE;
    if (deadlineNotes) {
      r.deadline_notes = provenance ? `${deadlineNotes} (${provenance})` : deadlineNotes;
    } else if (provenance) {
      r.deadline_notes = machineNote || !r.deadline_notes ? provenance : `${r.deadline_notes} — ${provenance}`;
    } else if (machineNote) {
      delete r.deadline_notes; // UTC value, no note given: drop the now-stale machine note
    }
  } else if (deadlineNotes) {
    // Notes edited on their own (deadline unchanged).
    if (deadlineNotes !== r.deadline_notes) { r.deadline_notes = deadlineNotes; changes.push('deadline_notes'); }
  }

  if (anything && anything !== r.notes) { r.notes = anything; changes.push('notes'); }

  if (topics.length) {
    const sortedNew = [...topics].sort().join(',');
    const sortedOld = Array.isArray(r.topics) ? [...r.topics].map(String).sort().join(',') : '';
    if (sortedNew !== sortedOld) {
      r.topics = topics;
      changes.push('topics');
      // The topics are now human-curated, so the bot's "topics were auto-suggested"
      // note no longer applies — drop it (a contributor's own note wouldn't match).
      if (isAutoTopicsNote(r.notes)) delete r.notes;
    }
  }

  if (!changes.length) {
    throw new Error('No changes detected — every field was blank or already matched the current value.');
  }
  return { record: r, changes };
}

function main() {
  const body = process.env.ISSUE_BODY;
  if (!body) { console.error('ISSUE_BODY env var is empty.'); process.exit(1); }

  const sections = parseSections(body);
  const get = (label) => sections[label.toLowerCase()] ?? '';

  const slug = get('Entry to edit').trim();
  if (!slug) { console.error('Entry to edit (the slug) is required.'); process.exit(1); }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) { console.error(`The slug "${slug}" looks malformed — it should look like "icml-2026-myworkshop".`); process.exit(1); }
  const filePath = path.join(WORKSHOPS_DIR, `${slug}.yml`);
  if (!fs.existsSync(filePath)) { console.error(`No existing entry found for slug "${slug}" (expected data/workshops/${slug}.yml).`); process.exit(1); }

  const existing = yaml.load(fs.readFileSync(filePath, 'utf8')) || {};
  let result;
  try {
    const deadline = assembleDeadline({
      year: get('Deadline year'),
      month: get('Deadline month'),
      day: get('Deadline day'),
      hour: get('Deadline hour'),
      minute: get('Deadline minute'),
    });
    const topics = parseTopics(get('Topics'));
    result = applyWorkshopEdit(existing, {
      deadline,
      timezone: get('Timezone of the deadline'),
      website: get('Workshop website'),
      deadlineNotes: get('Deadline notes'),
      anything: get('Anything else'),
      topics,
    });
  } catch (e) {
    console.error(`Could not apply this edit: ${e.message}`);
    process.exit(1);
  }

  fs.writeFileSync(filePath, yaml.dump(result.record, { lineWidth: 120, quotingType: '"' }));
  console.log(`Updated ${path.relative(process.cwd(), filePath)} (${result.changes.join(', ')})`);
  console.log(filePath);
}

// Only run the CLI when invoked directly, so applyWorkshopEdit can be imported
// in tests without needing ISSUE_BODY or the filesystem.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

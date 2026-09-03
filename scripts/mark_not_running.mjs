#!/usr/bin/env node
/**
 * Record that one workshop edition is NOT taking place — or undo that.
 *
 * This is the only thing that writes `not_running`. No scheduled job ever does:
 * the weekly official-list check reports candidates and a human decides, because
 * an official accepted-workshop list is authoritative for PRESENCE, not for
 * ABSENCE. A workshop can be running and simply not be a "workshop" in that
 * list's sense — an affinity event, a competition, a co-located event in its own
 * OpenReview namespace. Those get `review_ack.official_list` instead (--ack).
 *
 * Marking an entry does NOT delete it, and must not: OpenReview keeps a rejected
 * proposal's venue group live, so the next weekly crawl would simply re-create a
 * deleted file. Keeping the file is what makes the decision stick — and it keeps
 * the page alive for anyone who already saved or linked it.
 *
 * Usage:
 *   node scripts/mark_not_running.mjs --slug neurips-2026-eiml --reason not_on_official_list
 *   node scripts/mark_not_running.mjs --slug <slug> --reason cancelled --source https://… --note "…"
 *   node scripts/mark_not_running.mjs --slug <slug> --ack            # keep it; stop reporting it
 *   node scripts/mark_not_running.mjs --slug <slug> --unmark
 *   ... add --dry-run to any of the above.
 */
import fs from 'node:fs';
import * as yaml from 'js-yaml';
import {
  listWorkshopFiles,
  readWorkshopFile,
  loadEditions,
  workshopFilePath,
} from '../lib/workshops.mjs';

const REASONS = ['not_on_official_list', 'withdrawn', 'cancelled'];

const args = process.argv.slice(2);
const getArg = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const slug = getArg('--slug');
const reason = getArg('--reason');
const note = getArg('--note');
const unmark = args.includes('--unmark');
const ack = args.includes('--ack');
const dryRun = args.includes('--dry-run');

const die = (msg) => {
  console.error(msg);
  process.exit(1);
};

if (!slug) die('Usage: node scripts/mark_not_running.mjs --slug <slug> (--reason <reason> | --ack | --unmark) [--source <url>] [--note <text>] [--dry-run]');
if ([reason, ack || null, unmark || null].filter(Boolean).length !== 1) {
  die('Choose exactly one of --reason <reason>, --ack, or --unmark.');
}
if (reason && !REASONS.includes(reason)) die(`--reason must be one of: ${REASONS.join(', ')}`);

const fp = workshopFilePath(slug);
if (!fp) die(`No workshop file found for slug "${slug}".`);
const { raw } = readWorkshopFile(fp);

/** The official accepted-workshop list configured for this entry's edition. */
const listUrl =
  loadEditions().find((e) => e.conference === raw.conference && e.year === raw.year)?.workshop_list_url ?? null;
// Default the evidence to that list rather than making the caller paste it: the
// whole point of `source` is that the call can be re-checked later, and typing
// it by hand is how it ends up missing or subtly wrong.
const source = getArg('--source') ?? (reason === 'not_on_official_list' || ack ? listUrl : null);

const today = new Date().toISOString().slice(0, 10);
let summary;

if (unmark) {
  if (!raw.not_running) die(`"${slug}" is not marked — nothing to undo.`);
  delete raw.not_running;
  summary = `${slug}: unmarked — it takes part again, and the deadline syncs resume.`;
} else if (ack) {
  if (raw.not_running) {
    die(`"${slug}" is marked not running. Unmark it first: the two are opposite verdicts on the same question.`);
  }
  if (!source) {
    die(
      `No official list is configured for ${raw.conference} ${raw.year}, and no --source was given.\n` +
        'Add `workshop_list_url` to that edition row in data/editions.yml, or pass the list URL explicitly.',
    );
  }
  raw.review_ack = { ...(raw.review_ack ?? {}), official_list: source };
  summary = `${slug}: acknowledged as legitimately absent from ${source}`;
} else {
  if (raw.review_ack?.official_list) {
    die(`"${slug}" carries review_ack.official_list — it was already reviewed and kept. Remove that first if the verdict has changed.`);
  }
  if (raw.not_running?.reason === reason) {
    console.log(`${slug}: already marked (${reason}, recorded ${raw.not_running.recorded}) — nothing to do.`);
    process.exit(0);
  }
  if (reason === 'not_on_official_list' && !source) {
    console.warn(
      `Warning: no official list is configured for ${raw.conference} ${raw.year}, so no \`source\` will be recorded.\n` +
        '         Without it the call cannot be re-checked without repeating the research.',
    );
  }
  // The deadline, deadline_notes and deadline_history are deliberately left
  // untouched: they are the record of what was observed, and the page says so.
  raw.not_running = {
    reason,
    recorded: today,
    ...(source ? { source } : {}),
    ...(note ? { note } : {}),
  };
  summary = `${slug}: marked not running (${reason})${source ? ` — ${source}` : ''}`;
}

console.log(summary);
if (dryRun) {
  console.log('(dry-run — no file written)');
  process.exit(0);
}
// Keep any leading comment block. A deadline-less entry carries the importer's
// DEADLINE_HINT header inviting a contributor to fill the deadline in, and
// yaml.dump() would silently drop it. The deadline-writing scripts drop it on
// purpose — they have just answered it — but this one never touches the
// deadline, so removing the prompt would be pure loss.
const header = fs.readFileSync(fp, 'utf8').match(/^(?:#[^\n]*\n)+/)?.[0] ?? '';
fs.writeFileSync(fp, header + yaml.dump(raw, { lineWidth: 200, quotingType: '"' }));
console.log(`Wrote ${fp}.`);

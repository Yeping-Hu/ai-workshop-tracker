#!/usr/bin/env node
/**
 * Record that one workshop edition is NOT taking place — or undo that.
 *
 * This is the only thing that writes `not_running`. No scheduled job ever does:
 * the weekly official-list check reports candidates and a human decides, because
 * an official accepted-workshop list is authoritative for PRESENCE, not for
 * ABSENCE. A workshop can be running and simply not be a "workshop" in that
 * list's sense — an affinity event, a competition — while the conference still
 * hosts it under its own OpenReview namespace. Those get `review_ack.official_list`
 * instead (--ack). An event that has moved to its own namespace is the opposite
 * case: co-located or not, it is no longer the conference's workshop and is
 * marked, with --note saying where it runs now.
 *
 * A later verdict supersedes the earlier one. Marking an entry that carries
 * `review_ack.official_list` drops the acknowledgement, and acknowledging a
 * marked entry unmarks it, each saying so on stdout. The two are opposite
 * answers to one question — validate.mjs rejects an entry holding both — and the
 * human dispatching the workflow is answering it again: UniReps 2026 was
 * acknowledged on 2026-08-28 and had left the NeurIPS namespace by 2026-08-31.
 * Refusing, as this script used to, failed the dispatch on exactly the change of
 * mind the reports ask for.
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
import { readWorkshopFile, loadEditions, workshopFilePath } from '../lib/workshops.mjs';

export const REASONS = ['not_on_official_list', 'withdrawn', 'cancelled'];

/**
 * Apply one verdict to a raw entry. Pure — the file is read and written by the
 * CLI below — and exported so the supersede rule is pinned by a test rather
 * than by memory.
 *
 * Exactly one of `reason`, `ack`, `unmark`. `listUrl` is the official list
 * configured for the entry's edition, which `source` defaults to for the two
 * verdicts that are about that list. Returns `{ raw, summary, noop, warning }`;
 * throws with a message meant for a human when the request makes no sense.
 */
export function decide(raw, { slug, reason = null, ack = false, unmark = false, source = null, note = null, listUrl = null, today }) {
  if ([reason, ack || null, unmark || null].filter(Boolean).length !== 1) {
    throw new Error('Choose exactly one of --reason <reason>, --ack, or --unmark.');
  }
  if (reason && !REASONS.includes(reason)) throw new Error(`--reason must be one of: ${REASONS.join(', ')}`);
  // Default the evidence to the configured list rather than making the caller
  // paste it: the whole point of `source` is that the call can be re-checked
  // later, and typing it by hand is how it ends up missing or subtly wrong.
  const evidence = source ?? (reason === 'not_on_official_list' || ack ? listUrl : null);
  const out = { ...raw };
  let summary;
  let warning = null;

  if (unmark) {
    if (!out.not_running) throw new Error(`"${slug}" is not marked — nothing to undo.`);
    delete out.not_running;
    summary = `${slug}: unmarked — it takes part again, and the deadline syncs resume.`;
    return { raw: out, summary, noop: false, warning };
  }

  if (ack) {
    if (!evidence) {
      throw new Error(
        `No official list is configured for ${out.conference} ${out.year}, and no --source was given.\n` +
          'Add `workshop_list_url` to that edition row in data/editions.yml, or pass the list URL explicitly.',
      );
    }
    let superseded = '';
    if (out.not_running) {
      superseded = ` — supersedes the not-running marking (${out.not_running.reason}, recorded ${out.not_running.recorded})`;
      delete out.not_running;
    }
    out.review_ack = { ...(out.review_ack ?? {}), official_list: evidence };
    summary = `${slug}: acknowledged as legitimately absent from ${evidence}${superseded}`;
    return { raw: out, summary, noop: false, warning };
  }

  if (out.not_running?.reason === reason) {
    return {
      raw: out,
      summary: `${slug}: already marked (${reason}, recorded ${out.not_running.recorded}) — nothing to do.`,
      noop: true,
      warning,
    };
  }
  if (reason === 'not_on_official_list' && !evidence) {
    warning =
      `Warning: no official list is configured for ${out.conference} ${out.year}, so no \`source\` will be recorded.\n` +
      '         Without it the call cannot be re-checked without repeating the research.';
  }
  let superseded = '';
  if (out.review_ack?.official_list) {
    superseded = ` — supersedes the acknowledgement against ${out.review_ack.official_list}`;
    const { official_list, ...rest } = out.review_ack;
    if (Object.keys(rest).length) out.review_ack = rest;
    else delete out.review_ack;
  }
  // The deadline, deadline_notes and deadline_history are deliberately left
  // untouched: they are the record of what was observed, and the page says so.
  out.not_running = {
    reason,
    recorded: today,
    ...(evidence ? { source: evidence } : {}),
    ...(note ? { note } : {}),
  };
  summary = `${slug}: marked not running (${reason})${evidence ? ` — ${evidence}` : ''}${superseded}`;
  return { raw: out, summary, noop: false, warning };
}

function main() {
  const args = process.argv.slice(2);
  const getArg = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
  const slug = getArg('--slug');
  const dryRun = args.includes('--dry-run');
  const die = (msg) => {
    console.error(msg);
    process.exit(1);
  };

  if (!slug) die('Usage: node scripts/mark_not_running.mjs --slug <slug> (--reason <reason> | --ack | --unmark) [--source <url>] [--note <text>] [--dry-run]');
  const fp = workshopFilePath(slug);
  if (!fp) die(`No workshop file found for slug "${slug}".`);
  const { raw } = readWorkshopFile(fp);

  /** The official accepted-workshop list configured for this entry's edition. */
  const listUrl =
    loadEditions().find((e) => e.conference === raw.conference && e.year === raw.year)?.workshop_list_url ?? null;

  let result;
  try {
    result = decide(raw, {
      slug,
      reason: getArg('--reason'),
      ack: args.includes('--ack'),
      unmark: args.includes('--unmark'),
      source: getArg('--source'),
      note: getArg('--note'),
      listUrl,
      today: new Date().toISOString().slice(0, 10),
    });
  } catch (e) {
    die(e.message);
  }
  if (result.warning) console.warn(result.warning);
  console.log(result.summary);
  if (result.noop) process.exit(0);
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
  fs.writeFileSync(fp, header + yaml.dump(result.raw, { lineWidth: 200, quotingType: '"' }));
  console.log(`Wrote ${fp}.`);
}

// Only run the CLI when invoked directly, so decide() can be imported by its test.
if (import.meta.url === `file://${process.argv[1]}`) main();

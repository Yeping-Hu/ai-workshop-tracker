#!/usr/bin/env node
/**
 * Weekly series-identity audit: asks Jev whether candidate pairs of entries are
 * editions of one workshop series, records every answer in
 * data/series_links.yml, and reports the ambiguous ones for a person.
 * lib/series_links.mjs has the candidate rules, the question and the policy;
 * lib/workshops.mjs consumes the file at build time (Tier 5 of
 * computeRelations). This script is the I/O around them.
 *
 * What a run does:
 *   1. drops records whose slugs have left the dataset;
 *   2. asks about every candidate pair with no matching record — a new entry,
 *      an entry whose identity fields changed since it was judged, or a file
 *      judged by a different pinned model — and records the probability;
 *   3. writes the file, prints what was linked, and writes the review band
 *      (REVIEW_MIN ≤ same < LINK_MIN, undecided) to --report for the issue.
 *
 * Unattended by construction: without a TYPESAFE_API_KEY nothing is asked and
 * the file is at most pruned; a pair Jev could not answer is left unrecorded
 * and asked again next week; the exit code is 0 unless the script itself is
 * broken. Newly linked pairs go to $SERIES_CHANGELOG so the commit message
 * says what changed, as every deadline write does.
 *
 * Usage:
 *   node scripts/series_audit.mjs [--dry-run] [--report <path>]
 *   node scripts/series_audit.mjs --decide <slug-a> <slug-b> same|different
 */
import fs from 'node:fs';
import {
  loadWorkshops,
  loadSeriesLinks,
  workshopFilePath,
  SERIES_LINKS_FILE,
  LINK_MIN,
} from '../lib/workshops.mjs';
import { auditSeries, decide, renderReport, serializeSeriesLinks } from '../lib/series_links.mjs';
import { jevUsageLine } from '../lib/jev.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const reportAt = args.indexOf('--report');
const reportPath = reportAt !== -1 ? args[reportAt + 1] : null;
const decideAt = args.indexOf('--decide');
const today = new Date().toISOString().slice(0, 10);

if (decideAt !== -1) {
  const [a, b, verdict] = args.slice(decideAt + 1, decideAt + 4);
  for (const slug of [a, b]) {
    if (!slug || !fs.existsSync(workshopFilePath(slug))) {
      console.error(`No such workshop: ${slug ?? '(missing)'} — pass two slugs (data/workshops filenames without .yml) and a verdict.`);
      process.exit(2);
    }
  }
  let next;
  try {
    next = decide(loadSeriesLinks(), a, b, verdict, today);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (!next.model) next.model = null;
  if (!dryRun) fs.writeFileSync(SERIES_LINKS_FILE, serializeSeriesLinks(next));
  console.log(`${dryRun ? '[dry-run] would record' : 'recorded'}: ${a} ~ ${b} → ${verdict}`);
  process.exit(0);
}

const entries = loadWorkshops();
const relations = new Map(entries.map((e) => [e.slug, { relatedTracks: e.relatedTracks, relatedEditions: e.relatedEditions }]));
const links = loadSeriesLinks();
const by = new Map(entries.map((e) => [e.slug, e]));

const result = await auditSeries({ entries, relations, links, today });

if (!dryRun) {
  const text = serializeSeriesLinks(result.links);
  const before = fs.existsSync(SERIES_LINKS_FILE) ? fs.readFileSync(SERIES_LINKS_FILE, 'utf8') : null;
  if (text !== before) fs.writeFileSync(SERIES_LINKS_FILE, text);
}

const report = renderReport({ review: result.review, linkedNow: result.linkedNow, by, today });
if (reportPath) fs.writeFileSync(reportPath, report ? `${report}\n` : '');
if (result.linkedNow.length && process.env.SERIES_CHANGELOG) {
  fs.appendFileSync(
    process.env.SERIES_CHANGELOG,
    result.linkedNow.map((p) => `- ${p.a} ~ ${p.b} (same-series ${p.same.toFixed(2)}, ${p.via})`).join('\n') + '\n',
  );
}

const linked = result.links.pairs.filter((p) => p.same >= LINK_MIN).length;
console.log(
  `series audit${dryRun ? ' [dry-run]' : ''}: ${entries.length} entries, ${result.asked} pair(s) to judge` +
  `${result.stale ? ' (model changed — every pair re-judged)' : ''}, ${result.answered} answered` +
  `${result.pruned ? `, ${result.pruned} stale record(s) pruned` : ''}.`,
);
console.log(
  `  recorded ${result.links.pairs.length} pair(s): ${linked} link (≥ ${LINK_MIN}), ${result.review.length} to confirm, ` +
  `${result.links.pairs.length - linked - result.review.length} different; ${result.links.decisions.length} decision(s).`,
);
for (const p of result.linkedNow) console.log(`    ↳ linked ${p.a} ~ ${p.b} (${p.same.toFixed(2)}, ${p.via})`);
const usage = jevUsageLine();
if (usage) console.log(`  ${usage}`);

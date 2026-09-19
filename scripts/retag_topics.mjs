/**
 * Re-tags every workshop whose topics are exactly ['other'] AND still carry the
 * auto-suggested-topics note — so a human-curated topic set is NEVER overwritten
 * (same freeze-on-touch idea the edit form uses). Only writes when a real topic
 * comes out.
 *
 * `--all` widens the sweep from the `other` bucket to every entry that still
 * carries the note, and re-derives each as a fresh import would (Jev's list;
 * the keyword table's when Jev answers and nothing fits). It exists because a
 * vocabulary or threshold change is a rule change, and a rule is applied to
 * the whole corpus or it is not a rule: on 2026-09-19 the matcher skipped four
 * CoRL workshops that the keyword table had never tagged `robotics`, and 933
 * of 944 entries were still carrying that table's tags. An entry Jev cannot be
 * asked about is left exactly as it is — without a key `--all` writes nothing —
 * so an outage never trades a judged list for a keyword guess. About $0.25 for
 * the corpus at 48 topics (350 input tokens a request plus ~125 a question).
 *
 * Jev first, then the keyword matcher: the same order discovery applies to a
 * new entry (lib/jev_topics.mjs). Without a `TYPESAFE_API_KEY` this is the old
 * sweep — the keyword table alone — so it still does something useful after the
 * table is broadened. With one, it is how the back catalogue the table could
 * not classify (157 entries on 2026-09-18) gets real topics in one pass.
 *
 * Title + acronym + host conference only: OpenReview exposes no venue
 * description, and the stored `name` is exactly the title we imported, so this
 * needs no OpenReview call — it's the same result a fresh import would produce.
 * Re-tagged entries keep the auto-suggested note (still machine-guessed, just
 * better), so the edit form's "drop the note when a human curates" behavior
 * still applies.
 *
 * Usage:
 *   node scripts/retag_topics.mjs --dry-run         # print the before/after, write nothing
 *   node scripts/retag_topics.mjs                   # apply to the `other` bucket
 *   node scripts/retag_topics.mjs --all [--dry-run] # re-judge every auto-suggested entry
 *   node scripts/retag_topics.mjs --all --slug <slug> [--slug <slug> …]   # only these
 */
import fs from 'node:fs';
import * as yaml from 'js-yaml';
import { listWorkshopFiles, readWorkshopFile, loadTopics, loadConferences, slugOfFile } from '../lib/workshops.mjs';
import { guessTopics, hasAutoTopicsNote, DEADLINE_HINT } from './discover_openreview.mjs';
import { askTopics, retagDecision } from '../lib/jev_topics.mjs';
import { jevUsageLine } from '../lib/jev.mjs';

const dryRun = process.argv.slice(2).includes('--dry-run');
const all = process.argv.slice(2).includes('--all');
// `--slug <slug>`, repeatable: the same sweep over named entries only — to
// finish a run Jev did not fully answer, or to re-judge a handful after a
// description changes, without paying for the corpus again.
const slugs = process.argv.slice(2).flatMap((a, i, args) => (a === '--slug' && args[i + 1] ? [args[i + 1]] : []));
// Requests in flight at once. Jev's limit is 1,200 a minute; this keeps a
// 157-entry sweep under half a minute without ever approaching it.
const CONCURRENCY = 8;

const topics = loadTopics();
const conferences = loadConferences();

const candidates = [];
for (const f of listWorkshopFiles()) {
  const { raw } = readWorkshopFile(f);
  const t = Array.isArray(raw.topics) ? raw.topics : [];
  if (!all && !(t.length === 1 && t[0] === 'other')) continue; // only the 'other' bucket, unless --all
  if (!hasAutoTopicsNote(raw.notes)) continue;         // never touch human-curated
  if (slugs.length && !slugs.includes(slugOfFile(f))) continue;
  // yaml.dump drops comments, and a deadline-less entry carries the importer's
  // "know the deadline?" hint as one; keep it exactly as the importer would.
  const hint = !raw.submission_deadline && fs.readFileSync(f, 'utf8').startsWith(DEADLINE_HINT);
  candidates.push({ f, raw, hint, stored: t });
}

const rows = [];
let changed = 0;
let unanswered = 0;
const via = { jev: 0, keywords: 0 };
for (let i = 0; i < candidates.length; i += CONCURRENCY) {
  const chunk = candidates.slice(i, i + CONCURRENCY);
  const answers = await Promise.all(chunk.map(({ raw }) => askTopics(raw, { topics, conferences })));
  chunk.forEach(({ f, raw, hint, stored }, j) => {
    const jev = answers[j];
    if (jev === null) unanswered++;
    // The policy is lib/jev_topics.mjs's retagDecision(); this loop is the I/O.
    const next = retagDecision(stored, jev, guessTopics(`${raw.name || ''} ${raw.acronym || ''}`), { all });
    if (!next) return;
    via[jev?.length ? 'jev' : 'keywords']++;
    rows.push({ to: next.join('+'), name: raw.name, via: jev?.length ? 'jev' : 'kw' });
    if (!dryRun) {
      raw.topics = next;
      fs.writeFileSync(f, (hint ? DEADLINE_HINT : '') + yaml.dump(raw, { lineWidth: 200, quotingType: '"' }));
    }
    changed++;
  });
}

console.log(`auto-suggested ${all ? 'entries' : "'other'"} scanned : ${candidates.length}`);
console.log(`${dryRun ? 'WOULD reclassify' : 'reclassified'}        : ${changed}  (jev ${via.jev}, keywords ${via.keywords})`);
console.log(`${all ? 'unchanged' : "still 'other' after"}            : ${candidates.length - changed}`);
if (unanswered) console.log(`no answer from Jev             : ${unanswered}${all ? '  (left exactly as they were; re-run to finish)' : ''}`);
const usage = jevUsageLine();
if (usage) console.log(usage);
console.log('');
for (const r of rows.sort((a, b) => a.to.localeCompare(b.to))) {
  console.log(`  ${r.via.padEnd(3)} ${r.to.padEnd(46)} <- ${r.name}`);
}

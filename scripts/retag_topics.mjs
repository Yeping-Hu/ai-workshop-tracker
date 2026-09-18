/**
 * Re-tags every workshop whose topics are exactly ['other'] AND still carry the
 * auto-suggested-topics note — so a human-curated topic set is NEVER overwritten
 * (same freeze-on-touch idea the edit form uses). Only writes when a real topic
 * comes out.
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
 *   node scripts/retag_topics.mjs --dry-run   # print the before/after, write nothing
 *   node scripts/retag_topics.mjs             # apply
 */
import fs from 'node:fs';
import * as yaml from 'js-yaml';
import { listWorkshopFiles, readWorkshopFile, loadTopics, loadConferences } from '../lib/workshops.mjs';
import { guessTopics, isAutoTopicsNote } from './discover_openreview.mjs';
import { suggestTopics } from '../lib/jev_topics.mjs';
import { jevUsageLine } from '../lib/jev.mjs';

const dryRun = process.argv.slice(2).includes('--dry-run');
// Requests in flight at once. Jev's limit is 1,200 a minute; this keeps a
// 157-entry sweep under half a minute without ever approaching it.
const CONCURRENCY = 8;

const topics = loadTopics();
const conferences = loadConferences();

const candidates = [];
for (const f of listWorkshopFiles()) {
  const { raw } = readWorkshopFile(f);
  const t = Array.isArray(raw.topics) ? raw.topics : [];
  if (!(t.length === 1 && t[0] === 'other')) continue; // only the 'other' bucket
  if (!isAutoTopicsNote(raw.notes)) continue;          // never touch human-curated
  candidates.push({ f, raw });
}

const rows = [];
let changed = 0;
const via = { jev: 0, keywords: 0 };
for (let i = 0; i < candidates.length; i += CONCURRENCY) {
  const chunk = candidates.slice(i, i + CONCURRENCY);
  const guesses = await Promise.all(chunk.map(({ raw }) => suggestTopics(raw, { topics, conferences })));
  chunk.forEach(({ f, raw }, j) => {
    const jev = guesses[j];
    const guess = jev ?? guessTopics(`${raw.name || ''} ${raw.acronym || ''}`);
    if (guess.length === 1 && guess[0] === 'other') return;      // still nothing to say
    via[jev ? 'jev' : 'keywords']++;
    rows.push({ to: guess.join('+'), name: raw.name, via: jev ? 'jev' : 'kw' });
    if (!dryRun) {
      raw.topics = guess;
      fs.writeFileSync(f, yaml.dump(raw, { lineWidth: 200, quotingType: '"' }));
    }
    changed++;
  });
}

console.log(`auto-suggested 'other' scanned : ${candidates.length}`);
console.log(`${dryRun ? 'WOULD reclassify' : 'reclassified'}        : ${changed}  (jev ${via.jev}, keywords ${via.keywords})`);
console.log(`still 'other' after            : ${candidates.length - changed}`);
const usage = jevUsageLine();
if (usage) console.log(usage);
console.log('');
for (const r of rows.sort((a, b) => a.to.localeCompare(b.to))) {
  console.log(`  ${r.via.padEnd(3)} ${r.to.padEnd(46)} <- ${r.name}`);
}

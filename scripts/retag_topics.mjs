#!/usr/bin/env node
/**
 * Re-runs the (now broadened) keyword matcher on every workshop whose topics
 * are exactly ['other'] AND still carry the auto-suggested-topics note — so a
 * human-curated topic set is NEVER overwritten (same freeze-on-touch idea the
 * edit form uses). Only writes when the matcher now produces a real topic.
 *
 * Title + acronym only: OpenReview exposes no venue description, and the stored
 * `name` is exactly the title we imported, so this needs no network — it's the
 * same result a fresh import would now produce. Re-tagged entries keep the
 * auto-suggested note (still machine-guessed, just better), so the edit form's
 * "drop the note when a human curates" behavior still applies.
 *
 * Usage:
 *   node scripts/retag_topics.mjs --dry-run   # print the before/after, write nothing
 *   node scripts/retag_topics.mjs             # apply
 */
import fs from 'node:fs';
import yaml from 'js-yaml';
import { listWorkshopFiles, readWorkshopFile } from '../lib/workshops.mjs';
import { guessTopics, isAutoTopicsNote } from './discover_openreview.mjs';

const dryRun = process.argv.slice(2).includes('--dry-run');

let scanned = 0;
let changed = 0;
const rows = [];
for (const f of listWorkshopFiles()) {
  const { raw } = readWorkshopFile(f);
  const topics = Array.isArray(raw.topics) ? raw.topics : [];
  if (!(topics.length === 1 && topics[0] === 'other')) continue; // only the 'other' bucket
  if (!isAutoTopicsNote(raw.notes)) continue;                    // never touch human-curated
  scanned++;
  const guess = guessTopics(`${raw.name || ''} ${raw.acronym || ''}`);
  if (guess.length === 1 && guess[0] === 'other') continue;      // matcher still finds nothing
  rows.push({ to: guess.join('+'), name: raw.name });
  if (!dryRun) {
    raw.topics = guess;
    fs.writeFileSync(f, yaml.dump(raw, { lineWidth: 200, quotingType: '"' }));
  }
  changed++;
}

console.log(`auto-suggested 'other' scanned : ${scanned}`);
console.log(`${dryRun ? 'WOULD reclassify' : 'reclassified'}        : ${changed}`);
console.log(`still 'other' after            : ${scanned - changed}`);
console.log('');
for (const r of rows.sort((a, b) => a.to.localeCompare(b.to))) {
  console.log(`  ${r.to.padEnd(34)} <- ${r.name}`);
}

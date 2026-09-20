#!/usr/bin/env node
/**
 * Sweep: remove entries for venues their organizers deleted.
 *
 * The importer now refuses them on arrival (isTombstonedVenue in
 * discover_openreview.mjs has the case: OpenReview cannot delete a venue group,
 * so organizers rename an abandoned one "Deleted"). This re-applies that rule to
 * the entries imported before it existed — one, on 2026-09-19:
 * neurips-2024-attrib-late, a page headed "Deleted" for a late-submissions
 * group that lived for a day.
 *
 * Keys on the STORED name, so it needs no network and is safe to re-run: an
 * entry whose name is a tombstone was imported as one. It removes the entry's
 * YAML and its paper cache, and only when that cache holds no papers — a
 * "deleted" venue with accepted papers is a contradiction for a person to look
 * at, not something to erase. Nothing else needs tidying: a saved slug that
 * leaves the dataset is handled on the reader's side (ARCHITECTURE.md), the
 * series audit prunes its own records, and the alerts diff ignores a slug that
 * is gone (its shrink guard is a ratio, not a count).
 *
 * Prints what it would remove and exits without writing unless --write is
 * passed. A no-op on a clean tree; tombstone_test.mjs fails if such an entry is
 * ever present again, which is the signal to re-run this (and to ask how it got
 * past the importer).
 *
 * Run:  node scripts/remove_tombstoned.mjs            # preview
 *       node scripts/remove_tombstoned.mjs --write    # apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { listWorkshopFiles, readWorkshopFile, slugOfFile, loadPaperCache, CACHE_DIR } from '../lib/workshops.mjs';
import { isTombstonedVenue } from './discover_openreview.mjs';

const write = process.argv.includes('--write');

let removed = 0;
let held = 0;
for (const f of listWorkshopFiles()) {
  const { raw } = readWorkshopFile(f);
  if (!isTombstonedVenue({ title: raw.name })) continue;
  const slug = slugOfFile(f);
  const papers = loadPaperCache(slug)?.paper_count ?? 0;
  if (papers > 0) {
    held++;
    console.log(`  ! ${slug}: named "${raw.name}" but holds ${papers} accepted paper(s) — left in place; look at ${raw.openreview_venue_id ?? 'the venue'} by hand`);
    continue;
  }
  const cache = path.join(CACHE_DIR, `${slug}.json`);
  console.log(`  ${write ? 'removed' : 'would remove'} ${slug} ("${raw.name}", ${raw.openreview_venue_id ?? 'no venue id'})${fs.existsSync(cache) ? ' and its empty paper cache' : ''}`);
  if (write) {
    fs.rmSync(f);
    fs.rmSync(cache, { force: true });
  }
  removed++;
}
console.log(`${removed} tombstoned entr${removed === 1 ? 'y' : 'ies'} ${write ? 'removed' : 'found'}${held ? `, ${held} held for a person` : ''}${!write && removed ? ' — re-run with --write to apply' : ''}.`);

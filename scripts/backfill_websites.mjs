#!/usr/bin/env node
/**
 * Fill a blank `website` from the venue's own OpenReview field.
 *
 * The importer already does this on every refresh; this sweep exists for the
 * same reason the identity sweep does — when the reader's rules improve, entries
 * that were skipped under the old rules stay blank until something re-reads
 * them. Accepting a scheme-less host (#46) unblocked a batch of them at once.
 *
 * Same rules as the importer, nothing separate:
 *   - only fills a BLANK website, never overwrites one;
 *   - runs the value through websiteFromContent(), so junk like "N/A" is
 *     rejected exactly as it is on import;
 *   - skips a URL recorded in `review_ack.website`, so a link removed as dead is
 *     not silently restored.
 *
 *   node scripts/backfill_websites.mjs --dry-run
 *   node scripts/backfill_websites.mjs
 */
import fs from 'node:fs';
import * as yaml from 'js-yaml';
import { listWorkshopFiles, readWorkshopFile } from '../lib/workshops.mjs';
import { websiteFromContent, normalizeWebsite } from './discover_openreview.mjs';
import { venuePrefix } from './deadline_crosscheck.mjs';
import { openreviewFetch } from '../lib/openreview.mjs';

const dryRun = process.argv.includes('--dry-run');
const entries = listWorkshopFiles()
  .map((file) => ({ file, ...readWorkshopFile(file) }))
  .filter((e) => e.raw?.openreview_venue_id && !e.raw.website);

// One listing per conference-year rather than one lookup per entry.
const prefixes = [...new Set(entries.map((e) => venuePrefix(e.raw.openreview_venue_id)).filter(Boolean))];
const byId = new Map();
for (const p of prefixes) {
  // openreviewFetch, never bare fetch: OpenReview allows 20 requests a minute and
  // the shared limiter is what keeps every job inside that budget.
  const r = await openreviewFetch(
    `https://api2.openreview.net/groups?prefix=${encodeURIComponent(p)}&limit=1000`,
    { headers: { 'User-Agent': 'ai-workshop-tracker', Accept: 'application/json' } },
  );
  if (r.ok) for (const g of (await r.json()).groups ?? []) byId.set(g.id, g);
  else console.log(`  ⚠ venue listing failed for ${p}: HTTP ${r.status}`);
}

let filled = 0;
let declined = 0;
for (const e of entries) {
  const g = byId.get(e.raw.openreview_venue_id);
  if (!g) continue;
  const website = websiteFromContent(g.content ?? {});
  if (!website) continue;
  const ack = e.raw.review_ack?.website;
  if (ack && normalizeWebsite(ack) === normalizeWebsite(website)) {
    declined += 1;
    continue;
  }
  console.log(`  ${e.slug.padEnd(34)} -> ${website}`);
  filled += 1;
  if (dryRun) continue;
  e.raw.website = website;
  fs.writeFileSync(e.file, yaml.dump(e.raw, { lineWidth: 200, quotingType: '"' }));
}
console.log(
  `\n${filled} blank website(s) ${dryRun ? 'would be ' : ''}filled from OpenReview` +
    `${declined ? `; ${declined} skipped as previously declined` : ''}.`,
);

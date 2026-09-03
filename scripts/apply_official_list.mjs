#!/usr/bin/env node
/**
 * Record a decision about a name or website that differs from the conference's
 * official accepted-workshop list.
 *
 * Two verdicts, and both are decisions worth storing:
 *   --adopt    take the official list's value
 *   --decline  keep ours, and remember the value we turned down (`review_ack`)
 *
 * The decline half is what stops the weekly report asking the same question
 * forever, and it stores the REJECTED VALUE rather than muting the entry — the
 * same rule the OpenReview cross-check follows, so if the list later publishes
 * something different you are asked again.
 *
 * The report classifies most rows for you (lib/official_match.mjs:
 * classifyNameDrift / classifyWebsiteDrift) and prints the command; this script
 * is the thing that writes it, so a decision lands in the data rather than in a
 * commit message.
 *
 * Usage:
 *   node scripts/apply_official_list.mjs --slug neurips-2026-agenticos --field name --adopt
 *   node scripts/apply_official_list.mjs --slug neurips-2026-ai4mat --field name --decline
 *   ... add --dry-run to either.
 */
import fs from 'node:fs';
import * as yaml from 'js-yaml';
import {
  listWorkshopFiles,
  readWorkshopFile,
  loadWorkshops,
  loadEditions,
  loadConferences,
  websiteKey,
} from '../lib/workshops.mjs';
import { extractListedWorkshops } from '../lib/official_list.mjs';
import { matchOfficialList } from '../lib/official_match.mjs';
import { declinedUpstreamValue } from './deadline_crosscheck.mjs';
import { fetchGroupById } from './recheck_imminent.mjs';
import { get as fetchListPage } from './official_list_check.mjs';

const args = process.argv.slice(2);
const getArg = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const slug = getArg('--slug');
const field = getArg('--field');
const adopt = args.includes('--adopt');
const decline = args.includes('--decline');
const dryRun = args.includes('--dry-run');

const die = (m) => {
  console.error(m);
  process.exit(1);
};

if (!slug || !['name', 'website'].includes(field ?? '') || adopt === decline) {
  die('Usage: node scripts/apply_official_list.mjs --slug <slug> --field name|website (--adopt | --decline) [--dry-run]');
}

const fp = listWorkshopFiles().find((p) => readWorkshopFile(p).slug === slug);
if (!fp) die(`No workshop file found for slug "${slug}".`);
const { raw } = readWorkshopFile(fp);

const edition = loadEditions().find((e) => e.conference === raw.conference && e.year === raw.year);
if (!edition?.workshop_list_url) {
  die(`No workshop_list_url is configured for ${raw.conference} ${raw.year} in data/editions.yml — nothing to compare against.`);
}

// Re-derive the official value rather than taking it on the command line: the
// value must be the one the report actually saw, or an ack can be recorded
// against something the list never said and the row keeps reporting.
// Through the report's own fetcher — same headers, same escalating retry on a
// 429/5xx or a dropped connection — so a transient refusal is retried rather
// than surfacing as a raw stack trace from a bare fetch().
const res = await fetchListPage(edition.workshop_list_url);
if (!res.ok) die(`Could not read ${edition.workshop_list_url}: ${res.reason}`);
const { items } = extractListedWorkshops(res.body, { baseUrl: edition.workshop_list_url });

const entries = loadWorkshops().filter((w) => w.conference === raw.conference && w.year === raw.year);
const conferenceWebsite = loadConferences().find((c) => c.id === raw.conference)?.website ?? null;
const { pairs, drifted } = matchOfficialList(entries, items, { listUrl: edition.workshop_list_url, conferenceWebsite });
const row = drifted.find((d) => d.entry.slug === slug && d.field === field);
const pair = pairs.find((p) => p.entry.slug === slug);

if (!row && !pair) {
  console.log(`${slug}: no entry on the official list matches it — nothing to decide.`);
  process.exit(0);
}
// The official value, whether or not it currently differs: --adopt stays
// idempotent, so re-running it on an entry already adopted still reconciles the
// OpenReview side below rather than exiting as a no-op.
const official = field === 'name' ? pair?.item.title : pair?.item.url;

if (decline) {
  if (!row) {
    console.log(`${slug}: its ${field} no longer differs from the official list — nothing to decline.`);
    process.exit(0);
  }
  raw.review_ack = { ...(raw.review_ack ?? {}), [field]: row.theirs };
  console.log(`${slug}: kept our ${field}, declined the official list's\n  ours:     ${row.ours}\n  declined: ${row.theirs}`);
} else {
  const before = raw[field];
  if (official && before !== official) {
    raw[field] = official;
    console.log(`${slug}: ${field} adopted from the official list\n  was:  ${before}\n  now:  ${official}`);
  } else {
    console.log(`${slug}: ${field} already matches the official list (${official}).`);
  }
  // A value we have now adopted must not also be recorded as one we declined.
  if (raw.review_ack && websiteKey(String(raw.review_ack[field] ?? '')) === websiteKey(String(official))) {
    delete raw.review_ack[field];
    if (!Object.keys(raw.review_ack).length) delete raw.review_ack;
  }
  await ackOpenReviewIfItDisagrees(raw, field);
}

/**
 * Taking the official list's value implicitly DECLINES OpenReview's, and the
 * daily cross-check has no way to know that — it would open a fresh "renamed on
 * OpenReview" / "website changed on OpenReview" row the very next morning, for a
 * decision that was just made deliberately. Record it as `review_ack`, which is
 * exactly that field's job.
 *
 * Uses the cross-check's own titleDrift/websiteDrift so the ack written here is
 * precisely the one that silences it — a second implementation of "does this
 * count as drift" would eventually disagree with the report it is meant to quiet.
 */
async function ackOpenReviewIfItDisagrees(record, which) {
  if (!record.openreview_venue_id) return;
  const group = await fetchGroupById(record.openreview_venue_id);
  const val = (k) => {
    const x = group?.content?.[k];
    return x && typeof x === 'object' && 'value' in x ? x.value : x;
  };
  const declined = declinedUpstreamValue(record, which, which === 'name' ? val('title') : val('website'));
  if (!declined) return;
  record.review_ack = { ...(record.review_ack ?? {}), [which]: declined };
  console.log(`  also declined OpenReview's ${which}: ${declined}\n  (so the daily cross-check does not re-open this tomorrow)`);
}

if (dryRun) {
  console.log('(dry-run — no file written)');
  process.exit(0);
}
// Preserve any leading comment block — a deadline-less entry carries the
// importer's DEADLINE_HINT header, and yaml.dump() would drop it.
const header = fs.readFileSync(fp, 'utf8').match(/^(?:#[^\n]*\n)+/)?.[0] ?? '';
fs.writeFileSync(fp, header + yaml.dump(raw, { lineWidth: 200, quotingType: '"' }));
console.log(`Wrote ${fp}.`);

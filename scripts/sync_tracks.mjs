#!/usr/bin/env node
/**
 * Track-aware deadline sync for MULTI-TRACK workshops (e.g. ECCV MARINE, which
 * splits into a Full track and a Short track with different deadlines).
 *
 * Why this exists: single-deadline venues are kept current by backfill (fills
 * blanks) and recheck (applies extensions), but both of those SKIP any entry
 * that has a `tracks` block, and the importer only *populates* tracks when they
 * are absent — it never refreshes them once present. So a multi-track workshop
 * was extracted once and then frozen: an added track stayed blank, and a track
 * whose deadline the organizers later extended never caught up. This job closes
 * that gap.
 *
 * What it does: for each bot-managed workshop that HAS `tracks` and an
 * `openreview_venue_id`, it descends into the venue's sub-track child groups
 * (MARINE/Full, MARINE/Short — the very same `subTrackInfo` the importer uses),
 * reads each track's live submission-invitation `duedate`, and merges it into
 * the stored tracks with the same human-safe policy the single-deadline sync
 * uses (see mergeTracks): a blank track is filled, a dated track follows
 * OpenReview LATER-only (extensions; never earlier or to null), and a brand-new
 * OpenReview track is added. A track OpenReview omits is left untouched.
 *
 * Freeze / provenance: the whole entry is gated exactly like the single-deadline
 * sync — it only runs while `deadline_notes` still holds the bot's own stamp
 * (syncedValue) or the legacy import marker. The moment a human writes a custom
 * note, the entry AND all its tracks freeze (the bot never touches it again).
 * When any track moves, the headline `submission_deadline` is re-derived as the
 * earliest track and `deadline_notes` re-stamped, so provenance — and the freeze
 * control — stays on the top-level note. Nothing is written when nothing moved.
 *
 * Note: this REFRESHES entries that already carry tracks. First-time discovery
 * of a new multi-track venue (creating the tracks block) remains the weekly
 * importer's job (scripts/discover_openreview.mjs), which shares subTrackInfo.
 *
 * Usage:
 *   node scripts/sync_tracks.mjs                        # every tracked venue
 *   node scripts/sync_tracks.mjs --slug eccv-2026-marine
 *   node scripts/sync_tracks.mjs --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { listWorkshopFiles, readWorkshopFile, recordDeadlineObservation } from '../lib/workshops.mjs';
import { resolveDeadlineUtcMs } from '../lib/dates.mjs';
import {
  subTrackInfo,
  fetchGroups,
  tracksToYaml,
  mergeTracks,
  syncNote,
  syncedValue,
  LEGACY_IMPORT_NOTE,
} from './discover_openreview.mjs';
import { fetchGroupById } from './recheck_imminent.mjs';

const ALLOW_EARLIER = false; // later-only, same default as the single-deadline sync
const TWO_YEARS_MS = 2 * 366 * 86_400_000;

/** True while the entry is still bot-managed and human-untouched: its note holds
 *  the value the bot last wrote, or the pre-sync legacy marker. Any human edit to
 *  the value or the note breaks the match and freezes the whole entry. */
function isBotManaged(raw) {
  if (raw.deadline_notes === LEGACY_IMPORT_NOTE) return true;
  const lastBot = syncedValue(raw.deadline_notes);
  return lastBot != null && lastBot === raw.submission_deadline;
}

/** Earliest dated track — the value we store as the headline `submission_deadline`
 *  (same "earliest child" convention the importer uses; the site re-derives the
 *  display headline from the tracks at build time regardless). */
function earliestTrack(tracks) {
  const dated = (tracks || []).filter((t) => t.submission_deadline);
  if (!dated.length) return null;
  return dated.reduce((a, b) =>
    resolveDeadlineUtcMs(a.submission_deadline, a.timezone || 'UTC') <=
    resolveDeadlineUtcMs(b.submission_deadline, b.timezone || 'UTC')
      ? a
      : b,
  );
}

async function main({ slug, dryRun }) {
  const today = new Date().toISOString().slice(0, 10);
  const files = listWorkshopFiles()
    .map((f) => ({ f, ...readWorkshopFile(f) }))
    .filter(({ raw }) => Array.isArray(raw?.tracks) && raw.tracks.length && raw.openreview_venue_id)
    .filter(({ slug: s }) => !slug || s === slug);

  if (slug && !files.length) {
    console.error(`No multi-track OpenReview-linked workshop found for slug "${slug}".`);
    process.exit(1);
  }
  console.log(`Multi-track OpenReview-linked workshops to check: ${files.length}`);

  let updated = 0, frozen = 0, skipped = 0;
  const changes = [];

  for (const { f: fp, raw } of files) {
    if (!isBotManaged(raw)) {
      frozen++;
      continue; // a human curated this entry — never touch it (no network call)
    }
    const g = await fetchGroupById(raw.openreview_venue_id);
    if (!g) { skipped++; continue; } // transient/missing — a later run is the backstop

    const sub = await subTrackInfo(g, fetchGroups);
    // subTrackInfo returns [] for a venue that isn't (any longer) genuinely
    // multi-track, or when throttled — either way there's nothing to apply.
    let orTracks = tracksToYaml(sub.tracks);

    // Plausibility, same spirit as the single-deadline guard: OpenReview's
    // machine duedate is normally clean, but a garbled child `date` line could
    // parse to nonsense — skip a track whose year is >1 off the workshop's year
    // or is absurdly far out, rather than writing it.
    orTracks = orTracks.filter((t) => {
      if (!t.submission_deadline) return true;
      const yr = Number(String(t.submission_deadline).slice(0, 4));
      const ms = resolveDeadlineUtcMs(t.submission_deadline, t.timezone || 'UTC');
      const ok = Number.isFinite(yr) && Math.abs(yr - raw.year) <= 1 && ms - Date.now() <= TWO_YEARS_MS;
      if (!ok) console.warn(`  ⚠ ${path.basename(fp)}: track "${t.name}" OpenReview date "${t.submission_deadline}" looks implausible — ignored`);
      return ok;
    });

    const { tracks: newTracks, changes: trackChanges } = mergeTracks(raw.tracks, orTracks, { allowEarlier: ALLOW_EARLIER });
    if (!trackChanges.length) { skipped++; continue; } // nothing moved — no write

    raw.tracks = newTracks;
    // Re-derive the headline + re-stamp so provenance (and the freeze control)
    // stays on the top-level note and the next run recognises the entry as its own.
    const head = earliestTrack(newTracks);
    if (head) {
      // The headline is derived from the tracks, so a track move shows up here as
      // a headline change and belongs in the log like any other observation.
      recordDeadlineObservation(raw, head.submission_deadline, today, head.timezone || 'UTC');
      raw.submission_deadline = head.submission_deadline;
      raw.timezone = head.timezone || 'UTC';
      raw.deadline_notes = syncNote(head.submission_deadline, today);
    }

    if (!dryRun) fs.writeFileSync(fp, yaml.dump(raw, { lineWidth: 200, quotingType: '"' }));
    updated++;
    for (const c of trackChanges) changes.push(`${raw.conference} ${raw.year} · ${path.basename(fp)} · ${c}`);
  }

  if (changes.length && process.env.DEADLINE_CHANGELOG) {
    fs.appendFileSync(process.env.DEADLINE_CHANGELOG, changes.map((c) => `- ${c}`).join('\n') + '\n');
  }
  console.log(
    `Checked ${files.length} multi-track workshop(s) — ${updated} updated` +
    `${frozen ? `, ${frozen} human-frozen` : ''}${skipped ? `, ${skipped} unchanged/unavailable` : ''}` +
    `${dryRun ? '  (dry-run — no files written)' : ''}.`,
  );
  for (const c of changes) console.log(`    ↳ ${c}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const getArg = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
  main({ slug: getArg('--slug'), dryRun: args.includes('--dry-run') }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

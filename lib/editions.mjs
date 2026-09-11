/**
 * Conference editions and acceptance rates, resolved for the pages.
 *
 * `data/editions.yml` holds one row per conference-year. It began as the
 * conference's dates (`end` is what flips a deadline-less workshop to "Past")
 * plus the official accepted-workshop list URL; the daily sync-editions job
 * (scripts/sync_editions.mjs) also keeps the MAIN conference's facts on the
 * same row — paper and abstract deadlines, notification date, place and the
 * edition's website — because "neurips 2026 deadline" and "icml 2026 dates"
 * are the largest family of queries this site is shown for, and the
 * conference-year page is where they land. This module is the one place a
 * row is turned into display fields, so the hub, the year page and anything
 * else that reads it cannot resolve the same row three ways.
 *
 * `data/acceptance_rates.yml` is the acceptance-rate history the same job
 * writes: one row per conference-year with the rate and, where the source
 * has them, the accepted and submitted counts.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { REPO_ROOT, loadEditions } from './workshops.mjs';
import {
  resolveDeadlineUtcMs,
  parseDateUtcMs,
  formatDeadlineWallClock,
  formatDateSpan,
  formatDateYmd,
  DAY_MS,
} from './dates.mjs';

/** Every field a row may carry, in the order the file is written. */
export const EDITION_FIELDS = [
  'conference',
  'year',
  'start',
  'end',
  'source',
  'workshop_list_url',
  'url',
  'place',
  'abstract_deadline',
  'paper_deadline',
  'timezone',
  'notification',
  'synced',
];
/** The fields the sync manages and stamps in `synced` (plus `from` and `on`). */
export const SYNCED_FIELDS = ['start', 'end', 'url', 'place', 'abstract_deadline', 'paper_deadline', 'timezone', 'notification'];

export { loadEditions };

/** Raw rows of data/acceptance_rates.yml; [] when the file is absent. */
export function loadAcceptanceRates() {
  const p = path.join(REPO_ROOT, 'data', 'acceptance_rates.yml');
  if (!fs.existsSync(p)) return [];
  const raw = yaml.load(fs.readFileSync(p, 'utf8'));
  return Array.isArray(raw) ? raw : [];
}

/**
 * Does the row say anything about the main conference beyond the dates a
 * person typed for status derivation? A deadline, a place or a site is what
 * the sync contributes and what the year page's key-dates block and the hub's
 * main-conference line are built from; a bare `end` is not.
 */
export function hasMainConference(row) {
  return !!(row && (row.paper_deadline != null || row.abstract_deadline != null || row.place != null || row.url != null));
}

/**
 * A row with its derived display fields. `nowMs` decides what is open; the
 * site passes its build time, so the daily rebuild keeps this current.
 */
export function resolveEdition(row, nowMs = Date.now()) {
  const zone = row.timezone || 'AoE';
  const startMs = row.start != null ? parseDateUtcMs(String(row.start)) : null;
  const endMs = row.end != null ? parseDateUtcMs(String(row.end)) : null;
  const paperMs = row.paper_deadline != null ? resolveDeadlineUtcMs(String(row.paper_deadline), zone) : null;
  const abstractMs = row.abstract_deadline != null ? resolveDeadlineUtcMs(String(row.abstract_deadline), zone) : null;
  return {
    ...row,
    startMs,
    endMs,
    dateSpan: formatDateSpan(row.start, row.end),
    paperDeadlineUtcMs: paperMs,
    paperDeadlineWallClock: paperMs != null ? formatDeadlineWallClock(String(row.paper_deadline), zone) : null,
    paperDeadlineIso: paperMs != null ? new Date(paperMs).toISOString() : null,
    paperOpen: paperMs != null && paperMs > nowMs,
    abstractDeadlineUtcMs: abstractMs,
    abstractDeadlineWallClock: abstractMs != null ? formatDeadlineWallClock(String(row.abstract_deadline), zone) : null,
    abstractDeadlineIso: abstractMs != null ? new Date(abstractMs).toISOString() : null,
    abstractOpen: abstractMs != null && abstractMs > nowMs,
    notificationLabel: row.notification != null && parseDateUtcMs(String(row.notification)) != null ? formatDateYmd(String(row.notification)) : null,
    // The conference is "over" the day after its end date, the same grace the
    // status ladder gives a workshop; "ahead" until its start.
    over: endMs != null && endMs + DAY_MS < nowMs,
    ahead: startMs != null ? startMs > nowMs : endMs != null && endMs > nowMs,
    hasMainConference: hasMainConference(row),
  };
}

/**
 * The edition a conference's hub should headline: the one whose paper deadline
 * is still open (the soonest, if two are), else the one still ahead or
 * running, else the most recent one — so the hub says "ICLR 2027: papers due
 * Sep 25" in September and "NeurIPS 2026: call closed May 7, conference Dec
 * 6–13" for the rest of the year. Only rows that know something about the
 * main conference qualify (hasMainConference).
 */
export function featuredEdition(editions, conferenceId, nowMs = Date.now()) {
  const mine = (editions ?? []).filter((e) => e.conference === conferenceId && e.hasMainConference);
  const open = mine.filter((e) => e.paperOpen).sort((a, b) => a.paperDeadlineUtcMs - b.paperDeadlineUtcMs);
  if (open.length) return open[0];
  const pending = mine.filter((e) => !e.over && (e.endMs != null || e.startMs != null)).sort((a, b) => a.year - b.year);
  if (pending.length) return pending[0];
  return [...mine].sort((a, b) => b.year - a.year)[0] ?? null;
}

/**
 * The most recent earlier edition with a paper deadline: what "last year's
 * deadline was …" means on a page whose own deadline is not announced yet.
 * Skips years without one, so a biennial conference finds its real
 * predecessor.
 */
export function previousEdition(editions, conferenceId, year) {
  return (
    (editions ?? [])
      .filter((e) => e.conference === conferenceId && e.year < year && e.paper_deadline != null)
      .sort((a, b) => b.year - a.year)[0] ?? null
  );
}

/** A conference's acceptance rows, newest first. */
export function acceptanceHistory(rates, conferenceId) {
  return (rates ?? [])
    .filter((r) => r && r.conference === conferenceId && Number.isFinite(Number(r.rate)))
    .sort((a, b) => Number(b.year) - Number(a.year));
}

/** The newest acceptance row of a conference, or null. */
export function latestAcceptanceRate(rates, conferenceId) {
  return acceptanceHistory(rates, conferenceId)[0] ?? null;
}

/** "24.5%" — one decimal unless the source gave two. */
export function formatRate(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n)) return '';
  return `${Number.isInteger(n * 10) ? n.toFixed(1) : n.toFixed(2)}%`;
}

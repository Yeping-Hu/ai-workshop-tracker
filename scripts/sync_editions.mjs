#!/usr/bin/env node
/**
 * Daily: keep the MAIN conference's facts in step with the community trackers
 * that already maintain them, so the conference hub and conference-year pages
 * can answer "neurips 2026 deadline", "icml 2026 dates" and "iclr acceptance
 * rate" — the largest family of queries this site is shown for (Semrush, Sept
 * 2026: ~13K US searches a month across the nine conferences) — without a
 * person typing a date that three other projects have already typed.
 *
 * Sources, all MIT-licensed, read as raw files from GitHub:
 *
 *   ccfddl/ccf-deadlines          conference/AI/<id>.yml — a deadline and an
 *                                 abstract deadline with a timezone, free-text
 *                                 dates ("July 6-12, 2026"), place, site
 *   huggingface/ai-deadlines      src/data/conferences/<id>.yml — typed
 *                                 deadlines (abstract, paper, notification),
 *                                 machine-readable start/end, city, country
 *   lixin4ever/Conference-Acceptance-Rate  README.md — the acceptance-rate
 *                                 table, "|NeurIPS'25| 24.5% (5290/21575) …"
 *
 * What is written:
 *
 *   data/editions.yml          the row a conference-year already has gains
 *                              paper_deadline, abstract_deadline, timezone,
 *                              notification, place and url; a row is created
 *                              for this year and next once a tracker knows
 *                              the edition's end date (validate.mjs requires
 *                              one; it is also what "Past" derives from)
 *   data/acceptance_rates.yml  one row per conference-year with the rate and,
 *                              where the table has them, the counts
 *
 * The rules, pinned by scripts/editions_sync_test.mjs:
 *
 *   - Two trackers, one record. Per field the first tracker with a value wins
 *     (PRECEDENCE): deadlines from ccfddl, the larger tracker and the quicker
 *     to record a call; dates and place from ai-deadlines, whose start/end
 *     and city/country are machine-readable; the edition's site from ccfddl.
 *     Start and end travel as a pair from one tracker. On 2026-09-10 the two
 *     agreed on every deadline they both held; a disagreement of more than an
 *     hour is printed, and the precedence still decides.
 *   - A deadline keeps the zone the call states when it is AoE or UTC, which
 *     is what an author expects to read back; a fixed offset ("UTC-8", "PST")
 *     is converted to the UTC instant, since it is not in this site's zone
 *     vocabulary (AoE, UTC, IANA). Seconds are dropped. Both deadlines of a
 *     row share its `timezone`; the second is expressed in the first's zone.
 *   - Hand-typed values are adopted, never overwritten. The bot records what
 *     it wrote, per field, in the row's `synced` mapping. A field whose value
 *     still matches its stamp is the bot's to update; one that differs was
 *     edited by a person and is frozen; one with no stamp is a person's and
 *     is filled only when blank. A changed `timezone` freezes both deadlines.
 *     Deadlines move later only, as every deadline on this site does — an
 *     earlier upstream value is printed, not applied; dates, place, site and
 *     notification follow an upstream correction in either direction.
 *   - New rows only for this year and next. Older years fill existing rows
 *     but never gain one, so a conference added later does not sprout year
 *     pages for years it has no workshops in.
 *   - Plausibility as everywhere: a deadline within a year of the edition
 *     and no more than two years out (lib/dates.mjs); otherwise that field
 *     is skipped and named.
 *   - Acceptance rates: rows the bot wrote (their `source` is the README's
 *     repo) are replaced by the fresh parse; a row anyone else wrote is kept
 *     and wins over a bot row for the same year. A parse that finds no rows
 *     is treated as a failed fetch and changes nothing.
 *   - A tracker that cannot be fetched is named and the others still apply;
 *     nothing is ever blanked or removed; the job exits 0. Each file is
 *     written only when a row changed, and each change is appended to
 *     $DEADLINE_CHANGELOG for the commit message, like every other data job.
 *
 * What the sync cannot settle goes to a person. `--report <file>` writes the
 * markdown body of ONE self-maintaining issue ("Data health: conference
 * editions to review", kept by sync-editions.yml; an empty report closes it),
 * listing only what a person has to decide, and only while it still matters
 * (the edition is not over, the deadline in question still ahead):
 *
 *   - a tracker gives an EARLIER deadline than the stored bot value
 *     (later-only declined it; a real correction is set by hand);
 *   - the two trackers disagree on a deadline by more than an hour;
 *   - a value a person typed differs from what the trackers now say;
 *   - a tracker value was skipped as implausible;
 *   - a tracker knows a deadline but no dates, so no row could be created;
 *   - the next cycle should have appeared by now — the previous call's
 *     anniversary (at the conference's own cadence, so a biennial one is not
 *     asked for yearly) is within 90 days and no later edition exists — and
 *     is dropped again 180 days past it, so a conference that stopped does
 *     not stay on the list forever;
 *   - a finished edition (120 days past its end) has no acceptance rate in
 *     the source table, or the table's row for a recent year contradicts
 *     itself and was skipped.
 *
 * Usage:
 *   node scripts/sync_editions.mjs
 *   node scripts/sync_editions.mjs --dry-run
 *   node scripts/sync_editions.mjs --report editions-review.md
 */
import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { REPO_ROOT, loadConferences, loadEditions } from '../lib/workshops.mjs';
import { loadAcceptanceRates, resolveEdition, EDITION_FIELDS, SYNCED_FIELDS } from '../lib/editions.mjs';
import {
  parseDeadlineString,
  parseDateUtcMs,
  isRealDate,
  isValidTimezone,
  zonedToUtcMs,
  utcMsToWallClock,
  resolveDeadlineUtcMs,
  plausibleDeadline,
  formatDeadlineWallClock,
  DAY_MS,
} from '../lib/dates.mjs';
import { decideDeadlineUpdate } from './discover_openreview.mjs';

const EDITIONS_FILE = path.join(REPO_ROOT, 'data', 'editions.yml');
const RATES_FILE = path.join(REPO_ROOT, 'data', 'acceptance_rates.yml');
const UA = 'ai-workshop-tracker/1.0 (open-source workshop aggregator; github)';

export const SOURCES = {
  ccfddl: {
    home: 'https://github.com/ccfddl/ccf-deadlines',
    url: (id) => `https://raw.githubusercontent.com/ccfddl/ccf-deadlines/main/conference/AI/${id}.yml`,
  },
  'ai-deadlines': {
    home: 'https://github.com/huggingface/ai-deadlines',
    url: (id) => `https://raw.githubusercontent.com/huggingface/ai-deadlines/main/src/data/conferences/${id}.yml`,
  },
};
export const ACCEPTANCE_SOURCE = 'lixin4ever/Conference-Acceptance-Rate';
export const ACCEPTANCE_URL = 'https://raw.githubusercontent.com/lixin4ever/Conference-Acceptance-Rate/master/README.md';

/** Where a tracker files a conference under a name other than our id. A new
 *  conference whose id matches the tracker's file name needs nothing here. */
export const SOURCE_IDS = { neurips: { ccfddl: 'nips' } };
export const sourceId = (conf, source) => SOURCE_IDS[conf]?.[source] ?? conf;

/** Which tracker a field comes from first. */
export const PRECEDENCE = {
  paper_deadline: ['ccfddl', 'ai-deadlines'],
  abstract_deadline: ['ccfddl', 'ai-deadlines'],
  start: ['ai-deadlines', 'ccfddl'],
  end: ['ai-deadlines', 'ccfddl'],
  place: ['ai-deadlines', 'ccfddl'],
  url: ['ccfddl', 'ai-deadlines'],
  notification: ['ai-deadlines', 'ccfddl'],
};

const pad = (n) => String(n).padStart(2, '0');
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Timezones and deadlines as the trackers write them
// ---------------------------------------------------------------------------

const NAMED_ZONES = { AOE: 'AoE', 'ANYWHERE ON EARTH': 'AoE', UTC: 'UTC', GMT: 'UTC', Z: 'UTC' };
// Abbreviations that name one offset. CST and IST are left out on purpose:
// each names two zones fourteen hours apart, and a wrong guess there is worse
// than a skipped deadline (which is printed and can be typed by hand).
const ABBREVIATIONS = {
  PST: -480, PDT: -420, MST: -420, MDT: -360, EST: -300, EDT: -240,
  BST: 60, CET: 60, CEST: 120, EET: 120, EEST: 180, JST: 540, KST: 540, AEST: 600, AEDT: 660,
};

/**
 * A tracker's timezone string as this site can store it: {zone: 'AoE'|'UTC'|
 * IANA} when the wall clock can be kept, {offset: minutes} when the instant
 * has to be converted, null when it cannot be read.
 */
export function normaliseZone(tz) {
  const s = String(tz ?? '').trim();
  if (!s) return null;
  const up = s.toUpperCase();
  if (NAMED_ZONES[up]) return { zone: NAMED_ZONES[up] };
  const m = up.match(/^(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/);
  if (m) {
    const minutes = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
    if (minutes === -720) return { zone: 'AoE' };
    if (minutes === 0) return { zone: 'UTC' };
    return { offset: minutes };
  }
  if (ABBREVIATIONS[up] != null) return { offset: ABBREVIATIONS[up] };
  if (s.includes('/') && isValidTimezone(s)) return { zone: s };
  return null;
}

/**
 * A tracker's deadline ("2026-09-25 23:59:59", "2026-05-07 11:59:00",
 * "2026-06-06") in a zone, as this site stores one: {value: "YYYY-MM-DD
 * HH:MM", timezone, ms} or null. AoE and UTC keep their wall clock; a fixed
 * offset becomes the UTC instant. A missing zone means AoE, the convention of
 * every call these trackers follow.
 */
export function storedDeadline(value, tz) {
  const m = String(value ?? '').trim().match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::\d{2})?)?$/);
  if (!m) return null;
  const wall = `${m[1]} ${m[2] ?? '23'}:${m[3] ?? '59'}`;
  const parts = parseDeadlineString(wall);
  if (!parts) return null;
  const z = normaliseZone(tz ?? 'AoE');
  if (!z) return null;
  if (z.zone) return { value: wall, timezone: z.zone, ms: zonedToUtcMs(parts, z.zone) };
  const ms = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - z.offset * 60_000;
  return { value: utcMsToWallClock(ms, 'UTC'), timezone: 'UTC', ms };
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function monthNo(word) {
  const k = String(word).toLowerCase().replace(/\.$/, '');
  const i = MONTHS.findIndex((m) => m === k || m.slice(0, 3) === k || (k === 'sept' && m === 'september'));
  return i === -1 ? null : i + 1;
}

/**
 * ccfddl's free-text dates as {start, end}: "July 6-12, 2026", "May 01-05,
 * 2026", "September 27 - October 1, 2026", "December 9-December 15, 2024",
 * "December 6, 2026". A range that ends in January started the year before.
 * Anything else ("TBD") is null.
 */
export function parseDateRange(text) {
  const t = String(text ?? '').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
  const m = t.match(/^([A-Za-z]+)\.?\s*(\d{1,2})(?:\s*-\s*(?:([A-Za-z]+)\.?\s*)?(\d{1,2}))?,?\s*(\d{4})$/);
  if (!m) return null;
  const m1 = monthNo(m[1]);
  const m2 = m[3] ? monthNo(m[3]) : m1;
  if (!m1 || !m2) return null;
  const d1 = Number(m[2]);
  const d2 = m[4] ? Number(m[4]) : d1;
  const y = Number(m[5]);
  const y1 = m2 < m1 ? y - 1 : y;
  if (!isRealDate(y1, m1, d1) || !isRealDate(y, m2, d2)) return null;
  const start = `${y1}-${pad(m1)}-${pad(d1)}`;
  const end = `${y}-${pad(m2)}-${pad(d2)}`;
  return start <= end ? { start, end } : null;
}

const isHttp = (s) => typeof s === 'string' && /^https?:\/\/\S+$/.test(s.trim());
// A tracker's "not announced yet" marker is not a fact to store.
const PLACEHOLDER = /^\s*(tbd|tba|t\.b\.d\.|to be announced|to be determined)\s*$/i;

// ---------------------------------------------------------------------------
// The two readers: tracker file -> records {conference, year, source, ...}
// ---------------------------------------------------------------------------

/** ccfddl's conference/AI/<id>.yml (a list of conferences, each with `confs`). */
export function readCcfddl(text, conf) {
  const doc = yaml.load(text);
  const out = [];
  for (const c of Array.isArray(doc) ? doc : []) {
    for (const e of Array.isArray(c?.confs) ? c.confs : []) {
      const year = Number(e?.year);
      if (!Number.isInteger(year)) continue;
      const rec = { conference: conf, year, source: 'ccfddl' };
      // One timeline entry per submission round; the round with the latest
      // deadline is the edition's headline, and its abstract stage goes with it.
      const rounds = (Array.isArray(e.timeline) ? e.timeline : [])
        .map((t) => ({ paper: storedDeadline(t?.deadline, e.timezone), abstract: storedDeadline(t?.abstract_deadline, e.timezone) }))
        .filter((r) => r.paper || r.abstract)
        .sort((a, b) => (b.paper ?? b.abstract).ms - (a.paper ?? a.abstract).ms);
      const r = rounds[0];
      if (r) {
        const zone = (r.paper ?? r.abstract).timezone;
        rec.timezone = zone;
        if (r.paper) rec.paper_deadline = r.paper.value;
        if (r.abstract) rec.abstract_deadline = utcMsToWallClock(r.abstract.ms, zone);
      }
      const range = parseDateRange(e.date);
      if (range) Object.assign(rec, range);
      if (typeof e.place === 'string' && e.place.trim() && !PLACEHOLDER.test(e.place)) rec.place = e.place.trim();
      if (isHttp(e.link)) rec.url = e.link.trim();
      out.push(rec);
    }
  }
  return out;
}

// A deadline entry that is not the main paper track, by its label.
const NOT_PAPER = /tutorial|workshop|demo|industry|\bart\b|challenge|competition|doctoral|student|video|supplement|proposal/i;

/** ai-deadlines' src/data/conferences/<id>.yml (a list of editions, or one). */
export function readAiDeadlines(text, conf) {
  const doc = yaml.load(text);
  const rows = Array.isArray(doc) ? doc : doc && typeof doc === 'object' ? [doc] : [];
  const out = [];
  for (const r of rows) {
    const year = Number(r?.year);
    if (!Number.isInteger(year)) continue;
    const rec = { conference: conf, year, source: 'ai-deadlines' };
    const list = (Array.isArray(r.deadlines) ? r.deadlines : []).filter((d) => d && typeof d === 'object');
    const label = (d) => String(d.label ?? '');
    const pick = (types, ok = () => true) => list.find((d) => types.includes(d.type) && ok(label(d)));
    // The paper track: a typed `paper` entry, else a `submission` whose label
    // says paper (ECCV files tutorial, workshop and art submissions under the
    // same type). The abstract stage: `abstract`, else a `registration` that
    // is the paper registration. Notification: the authors' decision date,
    // not the tutorial or workshop decisions.
    const paperEntry = pick(['paper'], (l) => !NOT_PAPER.test(l)) ?? pick(['submission'], (l) => /paper/i.test(l) && !NOT_PAPER.test(l));
    const abstractEntry = pick(['abstract'], (l) => !NOT_PAPER.test(l)) ?? pick(['registration'], (l) => /paper|abstract/i.test(l) && !NOT_PAPER.test(l));
    const noteEntry =
      list.find((d) => d.type === 'notification' && /author|final|paper|decision|acceptance/i.test(label(d)) && !NOT_PAPER.test(label(d))) ??
      list.find((d) => d.type === 'notification' && !NOT_PAPER.test(label(d)));
    // Older rows carry one flat `deadline` (and `abstract_deadline`) with a
    // row-level `timezone` instead of the list.
    const paper = paperEntry ? storedDeadline(paperEntry.date, paperEntry.timezone) : storedDeadline(r.deadline, r.timezone);
    const abstract = abstractEntry ? storedDeadline(abstractEntry.date, abstractEntry.timezone) : storedDeadline(r.abstract_deadline, r.timezone);
    const zone = (paper ?? abstract)?.timezone;
    if (zone) {
      rec.timezone = zone;
      if (paper) rec.paper_deadline = paper.value;
      if (abstract) rec.abstract_deadline = utcMsToWallClock(abstract.ms, zone);
    }
    // A date-only fact: the day the call states, whatever its zone.
    const note = noteEntry ? String(noteEntry.date ?? '').slice(0, 10) : '';
    if (parseDateUtcMs(note) != null) rec.notification = note;
    const start = typeof r.start === 'string' && parseDateUtcMs(r.start) != null ? r.start : null;
    const end = typeof r.end === 'string' && parseDateUtcMs(r.end) != null ? r.end : null;
    if (start && end && start <= end) Object.assign(rec, { start, end });
    else {
      const range = parseDateRange(r.date);
      if (range) Object.assign(rec, range);
    }
    const place =
      [r.city, r.country].filter((s) => typeof s === 'string' && s.trim() && !PLACEHOLDER.test(s)).map((s) => s.trim()).join(', ') ||
      (typeof r.venue === 'string' && !PLACEHOLDER.test(r.venue) ? r.venue.trim() : '');
    if (place) rec.place = place;
    if (isHttp(r.link)) rec.url = r.link.trim();
    out.push(rec);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Merge: one record per conference-year, by field precedence
// ---------------------------------------------------------------------------

/**
 * Records from every tracker -> Map<"conf-year", merged>. `provenance` names
 * the tracker each field came from, `from` the trackers that contributed,
 * `warnings` the deadlines the trackers disagree on by more than an hour.
 */
export function mergeRecords(records) {
  const groups = new Map();
  for (const r of records) {
    const k = `${r.conference}-${r.year}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = new Map();
  for (const [k, recs] of groups) {
    const by = Object.fromEntries(recs.map((r) => [r.source, r]));
    const m = { conference: recs[0].conference, year: recs[0].year, from: [], provenance: {}, warnings: [], conflicts: [] };
    // Deadlines and their zone are one unit, from the first tracker with a
    // paper deadline (or, failing that, an abstract deadline).
    const unitSrc =
      PRECEDENCE.paper_deadline.find((s) => by[s]?.paper_deadline) ?? PRECEDENCE.abstract_deadline.find((s) => by[s]?.abstract_deadline);
    if (unitSrc) {
      const u = by[unitSrc];
      m.timezone = u.timezone;
      m.provenance.timezone = unitSrc;
      if (u.paper_deadline) {
        m.paper_deadline = u.paper_deadline;
        m.provenance.paper_deadline = unitSrc;
      }
      const absSrc = u.abstract_deadline ? unitSrc : PRECEDENCE.abstract_deadline.find((s) => by[s]?.abstract_deadline);
      if (absSrc) {
        const ms = resolveDeadlineUtcMs(by[absSrc].abstract_deadline, by[absSrc].timezone);
        if (ms != null) {
          m.abstract_deadline = utcMsToWallClock(ms, m.timezone);
          m.provenance.abstract_deadline = absSrc;
        }
      }
      if (m.paper_deadline) {
        const mine = resolveDeadlineUtcMs(m.paper_deadline, m.timezone);
        for (const s of Object.keys(by)) {
          if (s === unitSrc || !by[s].paper_deadline) continue;
          const other = resolveDeadlineUtcMs(by[s].paper_deadline, by[s].timezone);
          if (mine != null && other != null && Math.abs(mine - other) > 3_600_000) {
            m.warnings.push(`${k}: ${unitSrc} says the paper deadline is ${m.paper_deadline} ${m.timezone}, ${s} says ${by[s].paper_deadline} ${by[s].timezone} — using ${unitSrc}`);
            m.conflicts.push({
              kind: 'disagreement',
              conf: m.conference,
              year: m.year,
              field: 'paper_deadline',
              chosen: `${m.paper_deadline} ${m.timezone}`,
              chosenSource: unitSrc,
              chosenMs: mine,
              other: `${by[s].paper_deadline} ${by[s].timezone}`,
              otherSource: s,
              otherMs: other,
            });
          }
        }
      }
    }
    // Start and end as a pair from one tracker, so a range is never half of each.
    const dateSrc = PRECEDENCE.start.find((s) => by[s]?.start && by[s]?.end) ?? PRECEDENCE.start.find((s) => by[s]?.start || by[s]?.end);
    if (dateSrc) {
      for (const f of ['start', 'end']) {
        if (by[dateSrc][f] != null) {
          m[f] = by[dateSrc][f];
          m.provenance[f] = dateSrc;
        }
      }
    }
    for (const f of ['place', 'url', 'notification']) {
      const s = PRECEDENCE[f].find((x) => by[x]?.[f] != null);
      if (s) {
        m[f] = by[s][f];
        m.provenance[f] = s;
      }
    }
    m.from = [...new Set(Object.values(m.provenance))];
    out.set(k, m);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The decision for one conference-year, pure over the stored row and the record
// ---------------------------------------------------------------------------

const SYNCED_KEY_ORDER = ['from', 'as_of', ...SYNCED_FIELDS];

/** A row with its keys in the file's order (unknown keys last, untouched). */
export function orderRow(r) {
  const out = {};
  for (const k of EDITION_FIELDS) if (r[k] != null && r[k] !== '') out[k] = r[k];
  for (const k of Object.keys(r)) if (!(k in out) && r[k] != null) out[k] = r[k];
  if (out.synced && typeof out.synced === 'object') {
    const s = {};
    for (const k of SYNCED_KEY_ORDER) if (out.synced[k] != null) s[k] = out.synced[k];
    for (const k of Object.keys(out.synced)) if (!(k in s) && out.synced[k] != null) s[k] = out.synced[k];
    out.synced = s;
  }
  return out;
}

const DEADLINE_FIELDS = ['abstract_deadline', 'paper_deadline'];
const PLAIN_FIELDS = ['start', 'end', 'url', 'place', 'notification'];
const skip = (reason, extra = {}) => ({ action: 'skip', reason, row: null, changes: [], warnings: [], frozen: [], review: [], ...extra });

/**
 * {action: 'create'|'update'|'skip', reason, row, changes, warnings, frozen,
 * review}. `row` is the complete replacement row; `changes` are changelog
 * lines; `frozen` names the fields a person's value kept; `review` holds
 * the structured items a person should look at (see the header), each
 * with the instants involved so relevantReview can drop the stale ones.
 */
export function decideEdition({ row, rec, conf, year, nowMs = Date.now(), today = isoDay(nowMs) }) {
  const thisYear = new Date(nowMs).getUTCFullYear();
  const label = `${conf} ${year}`;
  if (!rec) return skip('no-source');
  const changes = [];
  const warnings = [];
  const frozen = [];
  const review = [];
  const yearOf = (v) => Number(String(v).slice(0, 4));
  const plausible = (f) => {
    const ms = resolveDeadlineUtcMs(rec[f], rec.timezone);
    if (ms != null && plausibleDeadline(ms, yearOf(rec[f]), year, nowMs)) return ms;
    warnings.push(`${label}: ${rec.provenance[f]} gives ${f} ${rec[f]} ${rec.timezone}, which looks implausible for ${year} — skipped`);
    review.push({ kind: 'implausible', conf, year, field: f, tracker: `${rec[f]} ${rec.timezone}`, trackerMs: ms, source: rec.provenance[f] });
    return null;
  };

  if (!row) {
    if (year < thisYear) return skip('past-year');
    if (!rec.end) {
      return skip(
        'no-dates-yet',
        rec.paper_deadline
          ? { review: [{ kind: 'no-dates-yet', conf, year, tracker: `${rec.paper_deadline} ${rec.timezone}`, trackerMs: resolveDeadlineUtcMs(rec.paper_deadline, rec.timezone), source: rec.provenance.paper_deadline }] }
          : {},
      );
    }
    const next = { conference: conf, year };
    const synced = { from: rec.from.join(', '), as_of: today };
    for (const f of PLAIN_FIELDS) {
      if (rec[f] == null) continue;
      next[f] = rec[f];
      synced[f] = rec[f];
    }
    for (const f of DEADLINE_FIELDS) {
      if (rec[f] == null || plausible(f) == null) continue;
      next[f] = rec[f];
      synced[f] = rec[f];
      next.timezone = rec.timezone;
      synced.timezone = rec.timezone;
      changes.push(`${label} ${f}: none -> ${rec[f]} ${rec.timezone} (${rec.provenance[f]})`);
    }
    next.synced = synced;
    changes.unshift(`${label}: new row from ${rec.from.join(' and ')} (${[next.start && next.end ? `${next.start} to ${next.end}` : null, next.place].filter(Boolean).join(', ') || 'dates'})`);
    return { action: 'create', reason: 'new-edition', row: orderRow(next), changes, warnings, frozen, review };
  }

  const stamps = row.synced && typeof row.synced === 'object' ? row.synced : {};
  const synced = { ...stamps };
  const next = { ...row };
  let touched = false;
  const same = (a, b) => String(a) === String(b);
  const managed = (f) => row[f] != null && stamps[f] != null && same(stamps[f], row[f]);

  for (const f of PLAIN_FIELDS) {
    if (rec[f] == null) continue;
    if (row[f] == null) {
      next[f] = rec[f];
      synced[f] = rec[f];
      touched = true;
      changes.push(`${label} ${f}: none -> ${rec[f]} (${rec.provenance[f]})`);
    } else if (managed(f)) {
      if (!same(row[f], rec[f])) {
        changes.push(`${label} ${f}: ${row[f]} -> ${rec[f]} (${rec.provenance[f]})`);
        next[f] = rec[f];
        synced[f] = rec[f];
        touched = true;
      }
    } else if (!same(row[f], rec[f])) {
      frozen.push(f);
      review.push({ kind: 'frozen-diverged', conf, year, field: f, stored: String(row[f]), tracker: String(rec[f]), source: rec.provenance[f] });
    }
  }

  // A person who changed the row's zone owns both deadlines from then on.
  const zoneFrozen = row.timezone != null && stamps.timezone != null && !same(stamps.timezone, row.timezone);
  for (const f of DEADLINE_FIELDS) {
    if (rec[f] == null) continue;
    if (zoneFrozen) {
      frozen.push(f);
      const storedMs = resolveDeadlineUtcMs(row[f], row.timezone);
      const trackerMs = resolveDeadlineUtcMs(rec[f], rec.timezone);
      if (row[f] == null || storedMs !== trackerMs) {
        review.push({ kind: 'frozen-diverged', conf, year, field: f, stored: row[f] == null ? '(blank)' : `${row[f]} ${row.timezone}`, storedMs, tracker: `${rec[f]} ${rec.timezone}`, trackerMs, source: rec.provenance[f] });
      }
      continue;
    }
    const srcMs = plausible(f);
    if (srcMs == null) continue;
    // Written in the zone the row already has (a person's or the bot's), else the tracker's.
    const zone = next.timezone ?? rec.timezone;
    const value = utcMsToWallClock(srcMs, zone);
    if (row[f] == null) {
      next[f] = value;
      synced[f] = value;
      if (next.timezone == null) {
        next.timezone = zone;
        synced.timezone = zone;
      }
      touched = true;
      changes.push(`${label} ${f}: none -> ${value} ${zone} (${rec.provenance[f]})`);
    } else if (managed(f)) {
      const curMs = resolveDeadlineUtcMs(row[f], row.timezone);
      const d = decideDeadlineUpdate(curMs, srcMs, { allowEarlier: false });
      if (d.update) {
        next[f] = value;
        synced[f] = value;
        touched = true;
        changes.push(`${label} ${f}: ${row[f]} ${row.timezone} -> ${value} ${zone} (${d.reason}, ${rec.provenance[f]})`);
      } else if (d.reason === 'earlier-blocked') {
        warnings.push(`${label}: ${rec.provenance[f]} gives ${f} ${rec[f]} ${rec.timezone}, earlier than the stored ${row[f]} ${row.timezone} — left unchanged (later-only)`);
        review.push({ kind: 'earlier-blocked', conf, year, field: f, stored: `${row[f]} ${row.timezone}`, storedMs: curMs, tracker: `${rec[f]} ${rec.timezone}`, trackerMs: srcMs, source: rec.provenance[f] });
      }
    } else if (resolveDeadlineUtcMs(row[f], row.timezone) !== srcMs) {
      frozen.push(f);
      review.push({ kind: 'frozen-diverged', conf, year, field: f, stored: `${row[f]} ${row.timezone}`, storedMs: resolveDeadlineUtcMs(row[f], row.timezone), tracker: `${rec[f]} ${rec.timezone}`, trackerMs: srcMs, source: rec.provenance[f] });
    }
  }

  if (!touched) return skip(frozen.length ? 'frozen' : 'unchanged', { warnings, frozen, review });
  synced.from = rec.from.join(', ');
  synced.as_of = today;
  next.synced = synced;
  return { action: 'update', reason: 'synced', row: orderRow(next), changes, warnings, frozen, review };
}

/** The four conference-years a run looks at: two back, this year, next. */
export function syncYears(nowMs = Date.now()) {
  const y = new Date(nowMs).getUTCFullYear();
  return [y - 2, y - 1, y, y + 1];
}

// ---------------------------------------------------------------------------
// Serializers: one owner per file, so the header survives every rewrite
// ---------------------------------------------------------------------------

const EDITIONS_HEADER = `# Conference editions: one row per conference-year.
#
#   start / end          the conference's dates. \`end\` is what flips a workshop
#                        with no deadline and no workshop_date to "Past" the day
#                        the conference ends (lib/workshops.mjs); years missing
#                        here fall back to the coarser \`typical_month\` in
#                        data/conferences.yml.
#   source               where a person took the dates from (optional).
#   workshop_list_url    the conference's OFFICIAL accepted-workshop announcement;
#                        switches on the weekly reconciliation
#                        (scripts/official_list_check.mjs), which also proposes a
#                        candidate from the conference's \`announcement_feed\`.
#   url, place           the edition's website and city.
#   abstract_deadline, paper_deadline, timezone, notification
#                        the MAIN conference's call for papers (not a workshop's),
#                        shown on /conference/<id>/ and /conference/<id>/<year>/.
#   synced               what the daily sync-editions job last wrote, per field,
#                        with the trackers it read (\`from\`) and when (\`as_of\`).
#
# The main-conference fields, the dates and the place are kept in step with the
# community trackers ccfddl/ccf-deadlines and huggingface/ai-deadlines by
# scripts/sync_editions.mjs (daily): a row appears for this year and next once
# a tracker knows the edition's dates, blanks are filled, and a value the bot
# wrote follows the trackers (deadlines move later only). Edit any value and
# that field is frozen (yours wins); \`source\` and \`workshop_list_url\` are
# always yours. See CONTRIBUTING.md, "Conference editions".
`;

/** The file's text: header, then rows by year (a blank line between years),
 *  by start date within a year, in the fixed key order. */
export function serializeEditions(rows) {
  const sorted = [...rows]
    .map(orderRow)
    .sort(
      (a, b) =>
        Number(a.year) - Number(b.year) ||
        String(a.start ?? a.end ?? '').localeCompare(String(b.start ?? b.end ?? '')) ||
        String(a.conference).localeCompare(String(b.conference)),
    );
  let out = `${EDITIONS_HEADER}\n`;
  let prevYear = null;
  for (const r of sorted) {
    if (prevYear != null && r.year !== prevYear) out += '\n';
    out += yaml.dump([r], { lineWidth: 200, quotingType: '"', noRefs: true });
    prevYear = r.year;
  }
  return out;
}

const RATES_HEADER = `# Main-conference acceptance rates, one row per conference-year: the rate and,
# where the source publishes them, the accepted and submitted counts, shown on
# /conference/<id>/. Written by scripts/sync_editions.mjs (daily) from the
# community-maintained table at github.com/lixin4ever/Conference-Acceptance-Rate
# (MIT). Rows the bot wrote carry that \`source\` and are replaced on every run;
# any other row is kept as typed and wins over the bot's for the same year.
# validate.mjs checks every row: a known conference id, an integer year, a rate
# between 0 and 100 that agrees with the counts.
`;

const RATE_KEYS = ['conference', 'year', 'rate', 'accepted', 'submitted', 'detail', 'source'];

/** The file's text: header, then rows by conference and year. */
export function serializeAcceptanceRates(rows) {
  const ordered = rows.map((r) => {
    const o = {};
    for (const k of RATE_KEYS) if (r[k] != null) o[k] = r[k];
    for (const k of Object.keys(r)) if (!(k in o) && r[k] != null) o[k] = r[k];
    return o;
  });
  ordered.sort((a, b) => String(a.conference).localeCompare(String(b.conference)) || Number(a.year) - Number(b.year));
  return `${RATES_HEADER}\n${yaml.dump(ordered, { lineWidth: 200, quotingType: '"', noRefs: true })}`;
}

// ---------------------------------------------------------------------------
// Acceptance rates: the README table -> rows
// ---------------------------------------------------------------------------

/** Names the table uses that differ from our conference names. */
const RATE_ALIASES = { nips: 'neurips' };

/**
 * "|NeurIPS'25| 24.5% (5290/21575) (77 orals, 688 spotlights and 4525
 * posters) | - |" -> {conference: 'neurips', year: 2025, rate: 24.5, accepted:
 * 5290, submitted: 21575, detail: '77 orals, …'}. A "?" count is left out; a
 * detail with placeholders is left out; a row whose rate disagrees with its
 * counts by more than a point is reported and skipped; conferences this site
 * does not track, and the "Findings" rows, are ignored.
 */
export function parseAcceptanceReadme(md, conferences) {
  const byName = new Map();
  for (const c of conferences ?? []) {
    byName.set(String(c.name).toLowerCase(), c.id);
    byName.set(String(c.id).toLowerCase(), c.id);
  }
  for (const [alias, id] of Object.entries(RATE_ALIASES)) if ([...byName.values()].includes(id)) byName.set(alias, id);
  const rows = [];
  const skipped = [];
  const seen = new Set();
  for (const line of String(md ?? '').split('\n')) {
    const m = line.match(/^\|\s*([A-Za-z][A-Za-z-]*)'(\d{2})\s*\|\s*([\d.]+)%\s*\((\d+|\?)\/(\d+|\?)\)\s*(?:\(([^)]*)\))?/);
    if (!m) continue;
    const id = byName.get(m[1].toLowerCase());
    if (!id) continue;
    const year = 2000 + Number(m[2]);
    const key = `${id}-${year}`;
    if (seen.has(key)) continue;
    const rate = Number(m[3]);
    const accepted = m[4] === '?' ? null : Number(m[4]);
    const submitted = m[5] === '?' ? null : Number(m[5]);
    if (!(rate > 0 && rate < 100)) continue;
    if (accepted != null && submitted != null && (submitted === 0 || Math.abs(rate - (accepted / submitted) * 100) > 1)) {
      skipped.push({ conference: id, year, message: `${rate}% does not match ${accepted}/${submitted}` });
      continue;
    }
    seen.add(key);
    const detail = m[6] && !/[?]|(^|[\s(])-(\s|$)/.test(m[6]) ? m[6].trim() : null;
    rows.push({
      conference: id,
      year,
      rate,
      ...(accepted != null ? { accepted } : {}),
      ...(submitted != null ? { submitted } : {}),
      ...(detail ? { detail } : {}),
      source: ACCEPTANCE_SOURCE,
    });
  }
  return { rows, skipped };
}

// ---------------------------------------------------------------------------
// What a person has to decide: the review report
// ---------------------------------------------------------------------------

const DEADLINE_KINDS = new Set(['earlier-blocked', 'disagreement', 'implausible', 'no-dates-yet']);

/**
 * Only the items that still matter: the edition is not over, and for anything
 * about a deadline, the deadline in question (stored or the tracker's) is
 * still ahead. A tracker's other opinion about a call that closed in March is
 * not something to act on in September.
 */
export function relevantReview(items, resolved, nowMs = Date.now()) {
  const byKey = new Map((resolved ?? []).map((e) => [`${e.conference}-${e.year}`, e]));
  return (items ?? []).filter((it) => {
    const ed = byKey.get(`${it.conf}-${it.year}`);
    if (ed?.over) return false;
    const aboutDeadline = DEADLINE_KINDS.has(it.kind) || (it.kind === 'frozen-diverged' && /deadline/.test(it.field ?? ''));
    if (!aboutDeadline) return true;
    const instants = [it.storedMs, it.trackerMs, it.chosenMs, it.otherMs].filter((x) => x != null);
    return instants.length ? Math.max(...instants) > nowMs : true;
  });
}

/**
 * Conferences whose next call should have appeared by now. The previous
 * call's anniversary, at the conference's own cadence (the gap between its
 * last two dated editions, so a biennial conference is not asked for
 * yearly), is within `leadDays`, and no later edition has a deadline. Dropped
 * again `graceDays` past the anniversary: a conference that stopped or moved
 * its cycle should not sit on the list for ever. `hasRow` says whether a
 * dates-only row for that year already exists (then only the deadline is
 * missing).
 */
export function missingNextCycles(resolved, nowMs = Date.now(), { leadDays = 90, graceDays = 180 } = {}) {
  const byConf = new Map();
  for (const e of resolved ?? []) {
    if (!byConf.has(e.conference)) byConf.set(e.conference, []);
    byConf.get(e.conference).push(e);
  }
  const out = [];
  for (const [conf, eds] of byConf) {
    const dated = eds.filter((e) => e.paperDeadlineUtcMs != null).sort((a, b) => a.year - b.year);
    if (!dated.length) continue;
    const latest = dated[dated.length - 1];
    if (latest.paperDeadlineUtcMs > nowMs) continue;
    const cadence = dated.length > 1 ? Math.max(1, latest.year - dated[dated.length - 2].year) : 1;
    const expected = latest.paperDeadlineUtcMs + cadence * 365.25 * DAY_MS;
    if (nowMs < expected - leadDays * DAY_MS || nowMs > expected + graceDays * DAY_MS) continue;
    const nextYear = latest.year + cadence;
    out.push({
      kind: 'next-cycle-missing',
      conf,
      year: nextYear,
      lastYear: latest.year,
      last: latest.paperDeadlineWallClock,
      expected: isoDay(expected),
      hasRow: eds.some((e) => e.year === nextYear),
    });
  }
  return out;
}

/**
 * Acceptance rates the source has not caught up with: for each conference
 * that has any rate at all, the tracked editions that ended more than
 * `graceDays` ago without a row for their year; plus a recent row the parser
 * skipped because it contradicted itself (older contradictions are history).
 */
export function staleAcceptanceRates(resolved, rates, skipped = [], nowMs = Date.now(), { graceDays = 120 } = {}) {
  const have = new Set((rates ?? []).map((r) => `${r.conference}-${r.year}`));
  const rated = new Set((rates ?? []).map((r) => r.conference));
  const out = [];
  for (const conf of rated) {
    const years = (resolved ?? [])
      .filter((e) => e.conference === conf && e.endMs != null && e.endMs + graceDays * DAY_MS < nowMs && !have.has(`${conf}-${e.year}`))
      .map((e) => e.year)
      .sort((a, b) => a - b);
    if (years.length) out.push({ kind: 'rate-missing', conf, years });
  }
  const thisYear = new Date(nowMs).getUTCFullYear();
  for (const s of skipped) {
    if (s.year >= thisYear - 3 && !have.has(`${s.conference}-${s.year}`)) out.push({ kind: 'rate-contradiction', conf: s.conference, year: s.year, detail: s.message });
  }
  return out;
}

/** A stable identity per item, so the workflow can tell what is new. */
export const reviewKey = (it) => [it.kind, `${it.conf}-${it.year ?? (it.years ?? []).join('+')}`, it.field].filter(Boolean).join(':');

const SECTIONS = [
  ['earlier-blocked', 'A tracker says a deadline moved earlier (later-only, so not applied)', (it, n) => `**${n(it.conf)} ${it.year}** \`${it.field}\`: stored ${it.stored}; ${it.source} now says ${it.tracker}. If the correction is real, set the value by hand (the field is then yours).`],
  ['disagreement', 'The trackers disagree', (it, n) => `**${n(it.conf)} ${it.year}** paper deadline: ${it.chosenSource} says ${it.chosen} (used); ${it.otherSource} says ${it.other}. Check the official call and set the value by hand if the used one is wrong.`],
  ['frozen-diverged', 'A value you typed differs from the trackers', (it, n) => `**${n(it.conf)} ${it.year}** \`${it.field}\`: yours ${it.stored}; ${it.source} says ${it.tracker}. Yours stands; edit the row if the tracker is right.`],
  ['implausible', 'A tracker value looked implausible and was skipped', (it, n) => `**${n(it.conf)} ${it.year}** \`${it.field}\`: ${it.source} gives ${it.tracker}. Set it by hand if it is right after all.`],
  ['no-dates-yet', 'A deadline is known but the edition has no dates yet', (it, n) => `**${n(it.conf)} ${it.year}**: ${it.source} gives the paper deadline ${it.tracker} but no conference dates, so no row was created. Add a row with \`end\` (and \`start\`) by hand and the deadline flows in on the next run.`],
  ['next-cycle-missing', 'The next call should have appeared by now', (it, n) => `**${n(it.conf)} ${it.year}**: ${n(it.conf)} ${it.lastYear}'s paper deadline was ${it.last}, so the ${it.year} call is normally out around ${it.expected}, and ${it.hasRow ? 'its row has no deadline yet' : 'the trackers have nothing for it yet'}. Add the deadline by hand from the official call for papers, or wait for the trackers.`],
  ['rate-missing', 'Acceptance rates not yet in the source table', (it, n) => `**${n(it.conf)}** ${it.years.join(', ')}: the conference has ended but the source table (${ACCEPTANCE_SOURCE}) has no row. If the official numbers are out, add a row to \`data/acceptance_rates.yml\` with \`source\` set to where you read them; it wins over the bot's.`],
  ['rate-contradiction', 'A source row contradicts itself and was skipped', (it, n) => `**${n(it.conf)} ${it.year}**: ${it.detail}. Add the correct row by hand if you know it.`],
];

/**
 * The issue body: one section per kind, in a fixed order, or '' when there is
 * nothing to review (the workflow then closes the issue). The trailing HTML
 * comment carries every item's key so the workflow can comment on what is
 * genuinely new — editing an issue body notifies nobody.
 */
export function buildEditionsReport(items, { names = new Map() } = {}) {
  if (!items?.length) return '';
  const n = (id) => names.get(id) ?? id;
  const out = ['## Conference editions to review', ''];
  out.push(
    '_The cases the daily editions sync will not settle on its own — a person decides. Edit `data/editions.yml` (or `data/acceptance_rates.yml`) to set a value; a field you edit is yours from then on and the bot leaves it alone. This issue is updated automatically by the `sync-editions` workflow and closes itself when nothing is left._',
    '',
  );
  for (const [kind, heading, line] of SECTIONS) {
    const mine = items.filter((it) => it.kind === kind);
    if (!mine.length) continue;
    out.push(`### ${heading}`, '');
    for (const it of mine) out.push(`- ${line(it, n)}`);
    out.push('');
  }
  out.push(`<!-- editions-review-keys: ${items.map(reviewKey).join(', ')} -->`, '');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

async function fetchText(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 404) return { ok: false, reason: '404' };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { ok: true, text: await res.text() };
    } catch (e) {
      if (attempt) return { ok: false, reason: e.message };
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return { ok: false, reason: 'unreachable' };
}

async function main({ dryRun, reportPath }) {
  const nowMs = Date.now();
  const today = isoDay(nowMs);
  const confs = loadConferences();
  const notes = [];
  const warnings = [];
  const changes = [];
  const review = [];

  // --- editions ---------------------------------------------------------------
  const records = [];
  for (const c of confs) {
    for (const [name, src] of Object.entries(SOURCES)) {
      const r = await fetchText(src.url(sourceId(c.id, name)));
      if (!r.ok) {
        notes.push(`${c.id}: ${name} ${r.reason === '404' ? 'has no file for it' : `could not be fetched (${r.reason})`}`);
        continue;
      }
      try {
        records.push(...(name === 'ccfddl' ? readCcfddl(r.text, c.id) : readAiDeadlines(r.text, c.id)));
      } catch (e) {
        notes.push(`${c.id}: ${name} did not parse (${e.message.split('\n')[0]})`);
      }
    }
  }
  const merged = mergeRecords(records);
  const rows = loadEditions().map((r) => ({ ...r }));
  const index = new Map(rows.map((r, i) => [`${r.conference}-${r.year}`, i]));
  const tally = { create: 0, update: 0, skip: 0 };
  const skipped = new Map();
  for (const c of confs) {
    for (const year of syncYears(nowMs)) {
      const key = `${c.id}-${year}`;
      const row = index.has(key) ? rows[index.get(key)] : null;
      const rec = merged.get(key) ?? null;
      if (rec) {
        warnings.push(...rec.warnings);
        review.push(...rec.conflicts);
      }
      const d = decideEdition({ row, rec, conf: c.id, year, nowMs, today });
      tally[d.action]++;
      warnings.push(...d.warnings);
      review.push(...d.review);
      if (d.action === 'skip') {
        if (!skipped.has(d.reason)) skipped.set(d.reason, []);
        skipped.get(d.reason).push(key + (d.frozen?.length ? ` [${d.frozen.join(', ')}]` : ''));
        continue;
      }
      if (d.action === 'create') {
        index.set(key, rows.length);
        rows.push(d.row);
      } else rows[index.get(key)] = d.row;
      changes.push(...d.changes);
      console.log(`  ${d.action} ${key}${d.frozen.length ? ` (kept hand-typed: ${d.frozen.join(', ')})` : ''}`);
      for (const ch of d.changes) console.log(`      ${ch}`);
    }
  }
  const editionsTouched = tally.create + tally.update;
  if (editionsTouched && !dryRun) fs.writeFileSync(EDITIONS_FILE, serializeEditions(rows));

  // --- acceptance rates -------------------------------------------------------
  let ratesChanged = 0;
  let finalRates = loadAcceptanceRates();
  let rateSkips = [];
  const ratesRes = await fetchText(ACCEPTANCE_URL);
  if (!ratesRes.ok) notes.push(`acceptance rates: the README could not be fetched (${ratesRes.reason})`);
  else {
    const { rows: fresh, skipped: bad } = parseAcceptanceReadme(ratesRes.text, confs);
    rateSkips = bad;
    warnings.push(...bad.map((s) => `acceptance rates: ${s.conference} ${s.year}: ${s.message}`));
    if (!fresh.length) notes.push('acceptance rates: the README yielded no rows (format changed?) — file left as it is');
    else {
      const existing = finalRates;
      const kept = existing.filter((r) => r?.source !== ACCEPTANCE_SOURCE);
      const keptKeys = new Set(kept.map((r) => `${r.conference}-${r.year}`));
      const next = [...kept, ...fresh.filter((r) => !keptKeys.has(`${r.conference}-${r.year}`))];
      const before = new Map(existing.map((r) => [`${r.conference}-${r.year}`, JSON.stringify(r)]));
      for (const r of next) if (before.get(`${r.conference}-${r.year}`) !== JSON.stringify(r)) ratesChanged++;
      ratesChanged += existing.filter((r) => !next.some((n) => n.conference === r.conference && n.year === r.year)).length;
      const text = serializeAcceptanceRates(next);
      if ((ratesChanged || !fs.existsSync(RATES_FILE)) && !dryRun) fs.writeFileSync(RATES_FILE, text);
      if (ratesChanged) changes.push(`acceptance rates: ${ratesChanged} row(s) added or changed from ${ACCEPTANCE_SOURCE}`);
      finalRates = next;
    }
  }

  // --- what a person has to decide ---------------------------------------------
  const resolved = rows.map((r) => resolveEdition(r, nowMs));
  const items = [
    ...relevantReview(review, resolved, nowMs),
    ...missingNextCycles(resolved, nowMs),
    ...staleAcceptanceRates(resolved, finalRates, rateSkips, nowMs),
  ];
  const report = buildEditionsReport(items, { names: new Map(confs.map((c) => [c.id, c.name])) });
  if (reportPath) fs.writeFileSync(reportPath, report);

  if (changes.length && process.env.DEADLINE_CHANGELOG && !dryRun) {
    fs.appendFileSync(process.env.DEADLINE_CHANGELOG, changes.map((c) => `- ${c}`).join('\n') + '\n');
  }
  console.log(
    `${dryRun ? '[dry-run] ' : ''}Editions: ${confs.length * syncYears(nowMs).length} conference-year(s) checked — ` +
      `${tally.create} created, ${tally.update} updated, ${tally.skip} skipped; acceptance rates: ${ratesChanged} row(s) changed.`,
  );
  for (const [reason, keys] of skipped) console.log(`    skipped (${reason}): ${keys.join(', ')}`);
  for (const n of notes) console.log(`    note: ${n}`);
  for (const w of warnings) console.warn(`  ⚠ ${w}`);
  console.log(`    to review: ${items.length} item(s)${items.length ? ` — ${items.map(reviewKey).join(', ')}` : ''}${reportPath ? ` (report: ${reportPath})` : ''}`);
}

// Only run the CLI when invoked directly, so the pure exports can be imported
// by the test without the module hitting the network.
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const reportPath = argv.includes('--report') ? argv[argv.indexOf('--report') + 1] : null;
  main({ dryRun, reportPath }).catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}

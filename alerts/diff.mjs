/**
 * Snapshot projection + event classification. Pure functions — pinned by
 * scripts/alerts_diff_test.mjs.
 *
 * The daily Action fetches the site's public /api/workshops.json, projects it
 * down to the handful of fields a digest needs (~60 KB rather than the full
 * dump), and compares that projection against the previous day's snapshot held
 * in D1. What comes out is a list of dataset *observations* — the same
 * vocabulary the site itself uses on the board.
 *
 * Two safety rules, both learned from the data jobs in this repo:
 *
 *   - **A first run seeds silently.** With no snapshot, every workshop looks
 *     new; announcing 750 of them to every subscriber is the obvious disaster.
 *     The first run writes the snapshot and sends nothing.
 *   - **A shrunken dataset aborts.** If the live fetch returns markedly fewer
 *     workshops than the snapshot holds, that is a garbled or partial response,
 *     not 200 cancelled workshops. Abort loudly, write nothing. Same paranoia
 *     as the importer's later-only rule.
 *
 * The change threshold and rounding deliberately mirror `deriveDeadlineChange`
 * in lib/workshops.mjs, so an email can never report a move the site suppresses.
 */

import { MIN_CHANGE_MS, SNAPSHOT_SHRINK_GUARD } from './config.mjs';

/** Fields a digest can actually render. Everything else is dropped. */
export function projectWorkshop(w) {
  return {
    slug: w.slug,
    name: w.name,
    acronym: w.acronym ?? null,
    conference: w.conference,
    year: w.year,
    topics: w.topics ?? [],
    status: w.status ?? null,
    status_label: w.status_label ?? null,
    deadline_utc: w.deadline_utc ?? null,
    abstract_deadline_utc: w.abstract_deadline_utc ?? null,
    next_stage_utc: w.next_stage_utc ?? null,
    next_stage_is_abstract: !!w.next_stage_is_abstract,
    website: w.website ?? null,
  };
}

/** Build the snapshot object from a parsed /api/workshops.json payload. */
export function projectFeed(feed) {
  const list = Array.isArray(feed?.workshops) ? feed.workshops : [];
  const workshops = {};
  for (const w of list) {
    if (!w?.slug) continue;
    workshops[w.slug] = projectWorkshop(w);
  }
  return {
    generated_at: feed?.generated_at ?? null,
    count: Object.keys(workshops).length,
    workshops,
  };
}

/** max(1, round(|Δ| in days)) — exactly `deriveDeadlineChange`'s rounding. */
export function deltaDays(deltaMs) {
  return Math.max(1, Math.round(Math.abs(deltaMs) / 86_400_000));
}

/**
 * Compare the previous snapshot to the live projection.
 *
 * Returns `{ status, events, reason?, ... }` where status is one of:
 *   'seed'  — no previous snapshot; caller stores `live` and sends nothing
 *   'abort' — shrink guard tripped; caller writes nothing and fails the job
 *   'ok'    — `events` is the classified list for today
 *
 * `observed` is the ISO date (YYYY-MM-DD) of the run that saw the change — the
 * same "when *we* noticed" semantics as `deadline_history`, never a claim about
 * when organizers changed anything.
 */
export function diffSnapshot(prev, live, observed) {
  if (!prev || !prev.workshops || Object.keys(prev.workshops).length === 0) {
    return { status: 'seed', events: [], reason: 'no previous snapshot — seeding' };
  }

  const prevCount = Object.keys(prev.workshops).length;
  const liveCount = Object.keys(live.workshops).length;
  if (liveCount < SNAPSHOT_SHRINK_GUARD * prevCount) {
    return {
      status: 'abort',
      events: [],
      reason: `live dataset shrank to ${liveCount} from ${prevCount} ` +
        `(< ${Math.round(SNAPSHOT_SHRINK_GUARD * 100)}%) — refusing to diff a partial fetch`,
    };
  }

  const events = [];
  for (const [slug, now] of Object.entries(live.workshops)) {
    const before = prev.workshops[slug];

    // A slug we have never seen. Note we do NOT also emit a deadline event for
    // it even when it arrives with a date — "announced" already covers it, and
    // the digest would otherwise list the same workshop twice.
    if (!before) {
      events.push({ slug, kind: 'announced', old_utc: null, new_utc: now.deadline_utc ?? null, days: null });
      continue;
    }

    const oldMs = before.deadline_utc ? Date.parse(before.deadline_utc) : null;
    const newMs = now.deadline_utc ? Date.parse(now.deadline_utc) : null;

    // A deadline appearing where the venue had published none. Distinct from
    // 'announced' (the workshop itself is not new) and worth its own line.
    if (oldMs == null && newMs != null) {
      events.push({
        slug, kind: 'deadline_announced', old_utc: null, new_utc: now.deadline_utc, days: null,
      });
      continue;
    }

    // A deadline vanishing is a data problem, not news. Silent by design.
    if (oldMs == null || newMs == null) continue;
    if (!Number.isFinite(oldMs) || !Number.isFinite(newMs)) continue;

    const delta = newMs - oldMs;
    if (Math.abs(delta) < MIN_CHANGE_MS) continue; // timezone re-read, not a move

    events.push({
      slug,
      kind: delta > 0 ? 'extended' : 'earlier',
      old_utc: before.deadline_utc,
      new_utc: now.deadline_utc,
      days: deltaDays(delta),
    });
  }

  // Deleted slugs produce no event: removals are rare, usually corrections, and
  // "this workshop no longer exists" is not something anyone subscribed to.

  return { status: 'ok', events: events.map((e) => ({ ...e, observed })), reason: null };
}

/**
 * Workshops whose next actionable stage falls inside [now, now + windowMs).
 * Shared by the "closing soon" digest section and the urgent pass, so the two
 * can never disagree about what "imminent" means.
 */
export function closingWithin(workshops, nowMs, windowMs) {
  const out = [];
  for (const w of Object.values(workshops)) {
    const iso = w.next_stage_utc || w.deadline_utc;
    if (!iso) continue;
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) continue;
    if (ms >= nowMs && ms < nowMs + windowMs) out.push({ ...w, next_ms: ms });
  }
  return out.sort((a, b) => a.next_ms - b.next_ms);
}

/**
 * Subscriber ↔ workshop matching. Pure functions, no I/O — the whole file is
 * exercised by scripts/alerts_match_test.mjs.
 *
 * We store the subscriber's **filter** (conference ids + topic ids), never a
 * resolved list of workshops (decision D6). A workshop announced next month
 * therefore matches an existing subscription with no migration, which is the
 * entire point: the tracker's value is new entries appearing.
 *
 * Starred slugs are stored separately and bypass the filter completely — if you
 * went to the trouble of starring something, you want to hear about it even if
 * it sits outside the conferences and topics you picked.
 */

/** Empty filter arrays mean "everything", not "nothing" — say so in the UI. */
const isAll = (list) => !Array.isArray(list) || list.length === 0;

/* ------------------------------------------------------- what gets sent ----
 * Three independent notifications, not one axis:
 *
 *   weekly   the Monday digest
 *   urgent   a saved workshop's deadline is within 72 h
 *   changes  a saved workshop's deadline moved, same day
 *
 * They were radio buttons, which forced artificial combinations and produced a
 * label that lied: "only email me when a deadline changes" also sent the 72 h
 * alert, because the old `starred_changes` value enabled both. Independent
 * flags make every combination reachable and each one honestly named.
 *
 * Stored in the existing `cadence` column as a canonical comma-joined subset,
 * or 'off' when nothing is enabled — so there is no migration and no backfill.
 * The four historical values are still understood on read, forever.
 */
export const NOTIFY_KINDS = ['weekly', 'urgent', 'changes'];

const LEGACY_CADENCE = {
  weekly: { weekly: true, urgent: false, changes: false },
  // What it actually did, whatever its label claimed.
  weekly_urgent: { weekly: true, urgent: true, changes: false },
  starred_changes: { weekly: false, urgent: true, changes: true },
  off: { weekly: false, urgent: false, changes: false },
};

/** Parse a stored `cadence` value — canonical CSV or a legacy keyword. */
export function parseNotify(cadence) {
  const raw = String(cadence ?? '').trim();
  if (!raw) return { ...LEGACY_CADENCE.off };
  if (LEGACY_CADENCE[raw]) return { ...LEGACY_CADENCE[raw] };
  const on = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  return {
    weekly: on.has('weekly'),
    urgent: on.has('urgent'),
    changes: on.has('changes'),
  };
}

/** The value to store. 'off' rather than '' so the admin query's filter holds. */
export function serializeNotify(notify) {
  const on = NOTIFY_KINDS.filter((k) => notify?.[k]);
  return on.length ? on.join(',') : 'off';
}

/**
 * Normalize a D1 subscriber row (JSON columns arrive as strings) into the shape
 * the matcher and renderer expect. Tolerant by design: a corrupt JSON column
 * degrades to an empty array rather than throwing mid-digest and dropping the
 * whole run.
 */
export function normalizeSubscriber(row) {
  const arr = (v) => {
    if (Array.isArray(v)) return v;
    try {
      const parsed = JSON.parse(v || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  return {
    email: String(row.email ?? '').trim().toLowerCase(),
    nonce: row.nonce ?? '',
    conferences: arr(row.conferences),
    topics: arr(row.topics),
    starred_ws: arr(row.starred_ws),
    starred_papers: arr(row.starred_papers),
    // Rows created before the column existed have no value; 'all' is the
    // behaviour they already had.
    scope: row.scope === 'starred' ? 'starred' : 'all',
    // Null when unknown — the renderer then shows UTC only.
    tz: typeof row.tz === 'string' && row.tz ? row.tz : null,
    cadence: row.cadence || 'weekly',
    // Which of the three notifications are on. Derived from `cadence`, which
    // holds either the canonical CSV or one of the legacy keywords.
    notify: parseNotify(row.cadence || 'weekly'),
    confirmed_at: row.confirmed_at ?? null,
    suppressed_at: row.suppressed_at ?? null,
  };
}

/**
 * Does this workshop belong in this subscriber's digest?
 *
 *   scope 'starred':  slug ∈ starred_ws, and nothing else
 *   scope 'all':      slug ∈ starred_ws
 *                     OR ((conferences == [] OR conference ∈ conferences)
 *                         AND (topics == [] OR topics ∩ subscriber.topics ≠ ∅))
 *
 * Starred workshops are included under 'all' whatever the facets say — if you
 * went to the trouble of saving something, you want to hear about it even when
 * it sits outside the conferences and topics you picked. `scope: 'starred'` is
 * the opposite request: the saved list *is* the subscription. It exists because
 * empty facets mean "everything", so there was previously no way to ask for
 * nothing-but-my-saved-list.
 */
export function matchesSubscriber(workshop, sub) {
  if (!workshop) return false;
  const starred = new Set(sub.starred_ws ?? []);
  if (starred.has(workshop.slug)) return true;
  if (sub.scope === 'starred') return false;

  const confOk = isAll(sub.conferences) || sub.conferences.includes(workshop.conference);
  if (!confOk) return false;

  if (isAll(sub.topics)) return true;
  const wsTopics = workshop.topics ?? [];
  return wsTopics.some((t) => sub.topics.includes(t));
}

/** Convenience: filter a projection map's values for one subscriber. */
export function matchingWorkshops(workshops, sub) {
  return Object.values(workshops).filter((w) => matchesSubscriber(w, sub));
}

/**
 * Events carry only a slug, so matching one means looking its workshop up in
 * the live projection. An event for a workshop that has since disappeared from
 * the dataset can't be rendered (no name, no link), so it is dropped.
 */
export function matchingEvents(events, workshops, sub) {
  return events.filter((e) => {
    const w = workshops[e.slug];
    return w && matchesSubscriber(w, sub);
  });
}

/**
 * Subscribers we may mail at all: confirmed, not suppressed, and with at least
 * one notification enabled. Turning everything off *is* pausing — there is no
 * separate paused state to keep in step.
 */
export function isMailable(sub) {
  const n = sub.notify ?? parseNotify(sub.cadence);
  return !!sub.confirmed_at && !sub.suppressed_at && NOTIFY_KINDS.some((k) => n[k]);
}

const flag = (sub, kind) => isMailable(sub) && (sub.notify ?? parseNotify(sub.cadence))[kind];

/** The 72 h "a saved deadline is imminent" alert. */
export const wantsUrgent = (sub) => flag(sub, 'urgent');

/** Same-day mail when a saved workshop's deadline moves. */
export const wantsStarredChanges = (sub) => flag(sub, 'changes');

/** The Monday digest. */
export const wantsWeekly = (sub) => flag(sub, 'weekly');

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
    cadence: row.cadence || 'weekly',
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

/** Subscribers we may mail at all: confirmed, not suppressed, not paused. */
export function isMailable(sub) {
  return !!sub.confirmed_at && !sub.suppressed_at && sub.cadence !== 'off';
}

/**
 * The 72 h "a saved deadline is imminent" alert. Both opt-in cadences get it:
 * someone who asked to hear about their saved workshops the day something
 * changes plainly also wants to know the day before one closes.
 */
export function wantsUrgent(sub) {
  return isMailable(sub) && (sub.cadence === 'weekly_urgent' || sub.cadence === 'starred_changes');
}

/** Same-day mail when a saved workshop's deadline moves. Opt-in. */
export function wantsStarredChanges(sub) {
  return isMailable(sub) && sub.cadence === 'starred_changes';
}

/**
 * The Monday digest. `starred_changes` deliberately excludes it — that cadence
 * exists precisely for people who want their saved workshops and nothing on a
 * schedule.
 */
export function wantsWeekly(sub) {
  return isMailable(sub) && sub.cadence !== 'starred_changes';
}

/**
 * How many workshops use each topic — the vocabulary's one size rule.
 *
 * A topic earns its place with at least TOPIC_MIN_WORKSHOPS workshops. With
 * fewer it is not a subject people browse or subscribe to, it is one series'
 * private label: a filter that returns a single page, a calendar feed of one
 * event, a checkbox in the alerts form that will almost never fire. Such a
 * subject belongs in a wider topic's description, which is how "Graphs" (two
 * workshops once Jev read the titles) became "Graphs & geometry" (twelve).
 *
 * Counted in workshops, not entries: the tracks of one workshop are one
 * workshop (three tracks of NeurReps 2026 do not make geometry three deep),
 * while editions in different years are different events and each counts.
 *
 * validate.mjs WARNS with this and never fails: the count moves with ordinary
 * edits, and a contributor whose correction takes a topic from three to two
 * has done nothing wrong — the vocabulary is the maintainer's to fix. A new
 * topic also necessarily starts at zero, between the commit that adds it and
 * the sweep that applies it (retag_topics.mjs --all).
 *
 * Pure; scripts/topic_usage_test.mjs pins it.
 */
export const TOPIC_MIN_WORKSHOPS = 3;

/**
 * @param entries  resolved entries: { slug, topics, relatedTracks: [{ slug }] }
 * @param topics   the vocabulary: [{ id, label }]
 * @returns Map id -> number of distinct workshops (track groups) carrying it
 */
export function topicUsage(entries, topics) {
  const groups = new Map(topics.map((t) => [t.id, new Set()]));
  for (const w of entries) {
    // One key per workshop: the first slug, alphabetically, among its tracks.
    const key = [w.slug, ...(w.relatedTracks ?? []).map((r) => r.slug)].sort()[0];
    for (const id of w.topics ?? []) groups.get(id)?.add(key);
  }
  return new Map([...groups].map(([id, set]) => [id, set.size]));
}

/** Topics used by fewer than `min` workshops, thinnest first. `other` is a bucket, not a topic, and is exempt. */
export function thinTopics(entries, topics, min = TOPIC_MIN_WORKSHOPS) {
  const usage = topicUsage(entries, topics);
  return topics
    .filter((t) => t.id !== 'other' && usage.get(t.id) < min)
    .map((t) => ({ id: t.id, label: t.label, workshops: usage.get(t.id) }))
    .sort((a, b) => a.workshops - b.workshops || a.id.localeCompare(b.id));
}

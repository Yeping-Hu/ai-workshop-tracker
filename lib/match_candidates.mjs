/**
 * The matcher's candidate set: every open call, with what a judgment of "does
 * this paper fit here?" can be made on — the entry's identity and topics, and
 * a sample of the titles its series has accepted before. Built at deploy time
 * into /api/match-candidates.json (site/src/pages/api) and read by the alerts
 * Worker's /match endpoint, so the Worker holds no copy of the corpus and the
 * static build stays the one source of truth. Same direction as every other
 * flow: the Worker reads the site, and nothing flows back.
 *
 * Past titles come from the SERIES, not just the entry. An open call has no
 * accepted papers yet — that is what "open" means — so `relatedEditions`
 * (computeRelations, ARCHITECTURE.md "Related entries") is what connects it to
 * the papers its earlier editions took, and the series audit's links widen
 * that reach. A first edition has none and says so: `past_paper_count: 0`, so
 * the page can show "based on the name and topics" rather than imply evidence
 * it does not have. Once the edition's own papers arrive through the monthly
 * refresh, next year's call is matched on them with no change here.
 *
 * Pure; scripts/match_candidates_test.mjs pins it under Node.
 */

/**
 * Titles are a sample, not a corpus: Jev reads them as state alongside the
 * paper, and its accuracy falls as the state fills with detail the question
 * does not need. A dozen titles say what a workshop accepts; two hundred say
 * the same thing more slowly and less well.
 */
export const PAST_TITLES_MAX = 12;

/**
 * @param workshops        resolved entries (loadWorkshops): status, relatedEditions, deadlineIso, …
 * @param paperCache       slug -> { paper_count, papers: [{ title }] } | null (lib/workshops loadPaperCache)
 * @param conferenceById   Map id -> conference row
 * @param topics           the vocabulary, with `description` (data/topics.yml)
 * @param shortName        w -> the site's one-line identity for the entry
 * @param href             path -> URL under the configured base
 */
export function buildMatchCandidates(workshops, { paperCache, conferenceById, topics, shortName, href = (p) => p }) {
  const topicLabel = new Map(topics.map((t) => [t.id, t.label]));
  const bySlug = new Map(workshops.map((w) => [w.slug, w]));
  const candidates = [];
  for (const w of workshops) {
    // `upcoming` is the board's "Open call" — a deadline still ahead, or none
    // announced yet. A not-running edition is never a candidate, however live
    // its OpenReview group looks.
    if (w.status !== 'upcoming') continue;
    // Newest edition first, so the sample reflects what the series accepts now.
    const editions = (w.relatedEditions ?? [])
      .map((e) => bySlug.get(e.slug))
      .filter((e) => e && e.slug !== w.slug)
      .sort((a, b) => b.year - a.year || a.slug.localeCompare(b.slug));
    const titles = [];
    let pastPapers = 0;
    for (const e of [w, ...editions]) {
      const cache = paperCache(e.slug);
      const papers = Array.isArray(cache?.papers) ? cache.papers : [];
      pastPapers += papers.length;
      for (const p of papers) {
        if (titles.length >= PAST_TITLES_MAX) break;
        if (p?.title) titles.push(String(p.title));
      }
    }
    const conf = conferenceById.get(w.conference);
    candidates.push({
      slug: w.slug,
      url: href(`/workshop/${w.slug}/`),
      name: w.name,
      acronym: w.acronym || null,
      short_name: shortName(w),
      conference: { id: w.conference, name: conf?.name ?? w.conference, full_name: conf?.full_name ?? '' },
      year: w.year,
      topics: (w.topics ?? []).map((id) => ({ id, label: topicLabel.get(id) ?? id })),
      website: w.website || null,
      deadline_utc: w.deadlineIso ?? null,
      deadline_wall_clock: w.deadlineWallClock ?? null,
      // What the fit judgment can stand on. `past_paper_count` counts every
      // paper the series has, `past_titles` is the sample sent to the model.
      past_titles: titles,
      past_paper_count: pastPapers,
      editions: editions.length,
    });
  }
  // Soonest deadline first, unannounced last — the board's order, so a client
  // rendering the list unsorted still shows something sensible.
  candidates.sort((a, b) => {
    const da = a.deadline_utc ?? '9999';
    const db = b.deadline_utc ?? '9999';
    return da.localeCompare(db) || a.slug.localeCompare(b.slug);
  });
  return {
    count: candidates.length,
    // The vocabulary travels with the candidates so the Worker can ask which
    // topics a paper is about without holding its own copy of data/topics.yml.
    topics: topics.filter((t) => t.id !== 'other').map((t) => ({ id: t.id, label: t.label, description: t.description ?? '' })),
    candidates,
  };
}

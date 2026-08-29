/**
 * Reconcile the corpus against a conference's official accepted-workshop list.
 *
 * Pure: entries + listed items in, four buckets out. No network, no filesystem.
 *
 * What this is FOR. Every workshop record comes from an OpenReview venue group,
 * and OpenReview creates those during a conference's PROPOSAL phase — so a
 * rejected proposal keeps a live group with an open submission invitation and a
 * ticking duedate, indistinguishable from an accepted one. The official list is
 * the only second opinion that exists.
 *
 * What this is NOT for. The list is authoritative for PRESENCE, never for
 * ABSENCE: a workshop can be running and simply not be a "workshop" in the
 * list's sense — an affinity event, a competition, a co-located event in its own
 * OpenReview namespace. So `offList` is a bucket for a human to read, never an
 * instruction. Nothing here writes anything.
 */
import { websiteKey, siteRoot, nameTokens, namesAgree } from './workshops.mjs';

/**
 * @param entries  resolved workshops (statusLabel present) for ONE conference-year
 * @param listed   {url,title,section}[] from extractListedWorkshops()
 * @param listUrl  the list's own URL — compared against review_ack.official_list
 */
export function matchOfficialList(entries, listed, { listUrl = null } = {}) {
  const ackKey = listUrl ? websiteKey(listUrl) : null;

  // Entries already marked are actioned; re-listing them means the report never
  // empties. Counted, not listed.
  const marked = entries.filter((e) => e.status === 'not_running');
  const acked = entries.filter(
    (e) => e.status !== 'not_running' && ackKey && websiteKey(e.review_ack?.official_list ?? '') === ackKey,
  );
  const ackedSlugs = new Set(acked.map((e) => e.slug));
  const live = entries.filter((e) => e.status !== 'not_running' && !ackedSlugs.has(e.slug));

  const listedInfo = listed.map((item) => ({
    ...item,
    key: websiteKey(item.url),
    root: siteRoot(websiteKey(item.url)),
    tokens: nameTokens(item.title),
  }));

  const pairs = [];
  const matchedListed = new Set();
  const unmatched = [];

  for (const e of live) {
    const hit = matchOne(e, listedInfo);
    if (hit) {
      pairs.push({ entry: e, item: hit.item, how: hit.how });
      matchedListed.add(hit.item.key);
    } else {
      unmatched.push(e);
    }
  }

  // Matched-but-disagreeing. Suppressed by the SAME review_ack keys the
  // OpenReview cross-check uses: one decision should not have to be recorded
  // twice, and the two sources normally offer the same value.
  const drifted = [];
  for (const { entry, item, how } of pairs) {
    if (
      websiteKey(entry.name ?? '') !== websiteKey(item.title) &&
      !namesAgree(nameTokens(entry.name ?? ''), nameTokens(item.title)) &&
      websiteKey(entry.review_ack?.name ?? '') !== websiteKey(item.title)
    ) {
      drifted.push({ entry, item, field: 'name', ours: entry.name, theirs: item.title });
    }
    // Only worth reporting when we matched on something OTHER than the URL:
    // a URL match means they already agree.
    if (
      how !== 'url' &&
      entry.website &&
      websiteKey(entry.website) !== item.key &&
      websiteKey(entry.review_ack?.website ?? '') !== item.key
    ) {
      drifted.push({ entry, item, field: 'website', ours: entry.website, theirs: item.url });
    }
  }

  return {
    pairs,
    offList: unmatched,
    missing: listedInfo.filter((i) => !matchedListed.has(i.key)),
    drifted,
    counts: {
      listed: listed.length,
      tracked: entries.length,
      matched: matchedListed.size,
      offList: unmatched.length,
      missing: listed.length - matchedListed.size,
      marked: marked.length,
      acked: acked.length,
    },
  };
}

/**
 * Three tiers, in order. MANY-TO-ONE by design: several corpus entries may match
 * one listed workshop, which is what makes a workshop's separate track files
 * (NeurReps proceedings/findings/extended-abstracts, GenAI4Health's three paper
 * tracks) matched rather than reported as rejected. One entry never matches two.
 */
function matchOne(entry, listedInfo) {
  const key = websiteKey(entry.website ?? '');
  const tokens = nameTokens(entry.name ?? '');

  // Tier U — the same page. Path-prefix containment either way, because a list
  // routinely links a deeper path than we store (…/view/aaba4et vs …/aaba4et/home,
  // …/remucai vs …/remucai/description) and it is still the same site.
  if (key) {
    for (const item of listedInfo) {
      if (item.key === key || item.key.startsWith(key + '/') || key.startsWith(item.key + '/')) {
        return { item, how: 'url' };
      }
    }
  }

  // Tier H — same site root, names agreeing. siteRoot() already returns null for
  // the shared hosts (sites.google.com, github.io), so two unrelated workshops on
  // one of those can never match here.
  const root = key ? siteRoot(key) : null;
  if (root && tokens.size) {
    const hits = listedInfo.filter((i) => i.root === root && namesAgree(tokens, i.tokens));
    if (hits.length === 1) return { item: hits[0], how: 'host' };
  }

  // Tier T — names alone. Carries the entries with no stored website at all, and
  // the ones whose website is a placeholder pointing at the conference itself.
  //
  // NOT namesAgree() here. That rule ("two shared tokens, or half the union")
  // is calibrated for the already-narrowed groups computeRelations works on —
  // one website, or one venue stem. Turned loose on a hundred titles it matches
  // everything: "foundation models" alone agrees with twenty of the NeurIPS 2026
  // list. So this tier RANKS instead, and demands a clear winner: a high
  // absolute overlap AND a decisive margin over the runner-up. Ambiguity is
  // reported as off-list for a human to read, which is the safe direction.
  if (tokens.size) {
    const scored = listedInfo
      .map((item) => ({ item, score: overlap(tokens, item.tokens) }))
      .sort((a, b) => b.score - a.score);
    const [best, next] = scored;
    if (best && best.score >= TITLE_MIN_SCORE && best.score - (next?.score ?? 0) >= TITLE_MIN_MARGIN) {
      return { item: best.item, how: 'title' };
    }
  }

  return null;
}

/** Containment: shared tokens over the SHORTER name. A stored name is routinely
 *  an abbreviation of the listed one ("Physical Understanding for Decision-Making…"
 *  vs "NeurIPS 2026 Workshop on Physical Understanding for Decision-Making…"), so
 *  Jaccard would penalise the very case this tier exists to catch. */
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / Math.min(a.size, b.size);
}

const TITLE_MIN_SCORE = 0.6;
const TITLE_MIN_MARGIN = 0.15;

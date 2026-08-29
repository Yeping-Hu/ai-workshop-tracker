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
export function matchOfficialList(entries, listed, { listUrl = null, conferenceWebsite = null } = {}) {
  const ackKey = listUrl ? websiteKey(listUrl) : null;

  // Entries already marked are actioned; re-listing them means the report never
  // empties. Counted, not listed.
  const marked = entries.filter((e) => e.status === 'not_running');
  const acked = entries.filter(
    (e) => e.status !== 'not_running' && ackKey && websiteKey(e.review_ack?.official_list ?? '') === ackKey,
  );
  const ackedSlugs = new Set(acked.map((e) => e.slug));
  const live = entries.filter((e) => e.status !== 'not_running' && !ackedSlugs.has(e.slug));

  const listedInfo = listed.map((item, index) => ({
    ...item,
    index,
    // Some lists link a workshop's OpenReview GROUP rather than its homepage
    // (four of ICLR 2024's twenty do). That is not a website: websiteKey() drops
    // the query string, so every such link collapses to the single key
    // "openreview.net/group" — they would all match each other, and reporting
    // one as our "website" would be nonsense. Recognised here so it can be used
    // for what it actually is: a venue id.
    venueId: openreviewVenueId(item.url),
    key: websiteKey(item.url),
    root: siteRoot(websiteKey(item.url)),
    tokens: nameTokens(item.title),
  }));

  const pairs = [];
  const matchedListed = new Set(); // listedInfo indexes
  const unmatched = [];

  for (const e of live) {
    const hit = matchOne(e, listedInfo);
    if (hit) {
      pairs.push({ entry: e, item: hit.item, how: hit.how });
      matchedListed.add(hit.item.index);
    } else {
      unmatched.push(e);
    }
  }

  // Which listed workshops already have their official URL accounted for by one
  // of our entries. A workshop's separate track files all match ONE listed
  // workshop, but the list carries only that workshop's URL — so once any
  // sibling matches it exactly, a track pointing somewhere else is its own
  // competition/track site, not a disagreement with the list.
  const urlAccountedFor = new Set(pairs.filter((p) => p.how === 'url' || p.how === 'venue').map((p) => p.item.index));

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
      drifted.push({
        entry,
        item,
        field: 'name',
        ours: entry.name,
        theirs: item.title,
        verdict: classifyNameDrift(entry.name, item.title),
      });
    }
    // An OpenReview group URL is not a homepage, so it can never be evidence
    // that our `website` is wrong.
    // Only worth reporting when we matched on something OTHER than the URL (a
    // URL match means they already agree) AND no sibling already accounts for
    // the official URL.
    //
    // That second condition is not a nicety. IAB's competition paper track
    // stores https://glee-competition.com — its own site, recorded deliberately,
    // with a maintainer's note saying so — while the main IAB entry carries the
    // workshop URL the list publishes. Without this guard the track is reported
    // as disagreeing with the list and the suggested fix is to adopt the
    // workshop's URL, which would overwrite correct, hand-curated data with a
    // duplicate of its sibling's.
    if (
      how !== 'url' &&
      !item.venueId &&
      !urlAccountedFor.has(item.index) &&
      entry.website &&
      websiteKey(entry.website) !== item.key &&
      websiteKey(entry.review_ack?.website ?? '') !== item.key
    ) {
      drifted.push({
        entry,
        item,
        field: 'website',
        ours: entry.website,
        theirs: item.url,
        verdict: classifyWebsiteDrift(entry.website, conferenceWebsite),
      });
    }
  }

  return {
    pairs,
    offList: unmatched,
    missing: listedInfo.filter((i) => !matchedListed.has(i.index)),
    drifted,
    counts: {
      listed: listed.length,
      tracked: entries.length,
      matched: matchedListed.size,
      offList: unmatched.length,
      // Derived from the same array the report prints, never recomputed from
      // lengths: the two disagreed the moment a list linked four workshops to
      // OpenReview group URLs that normalise to one key.
      missing: listedInfo.length - matchedListed.size,
      marked: marked.length,
      acked: acked.length,
    },
  };
}

/**
 * What should be done about a name that differs from the official list?
 *
 * The three real NeurIPS 2026 cases were three different situations, which is
 * why "always adopt the list" is wrong:
 *   AgenticOS  ours "AgenticOS Workshop"          theirs the full title      -> adopt
 *   BabyVLM    ours "BabyVLM Workshop NEURIPS 2026"  theirs the full title   -> adopt
 *   AI4Mat     ours "AI for Accelerated Materials Design"  theirs "AI4Mat-NeurIPS-2026" -> decline
 *
 * nameTokens() already discards venue words, the year and "workshop", so the
 * comparison is between what the two titles actually SAY.
 *
 * @returns 'adopt' | 'decline' | 'unclear'
 */
export function classifyNameDrift(ours, theirs) {
  const a = nameTokens(ours ?? '');
  const b = nameTokens(theirs ?? '');
  if (!a.size || !b.size) return 'unclear';
  // A single surviving token is an acronym, not a name — "AI4Mat-NeurIPS-2026"
  // reduces to {ai4mat}. Storing that in `name` would put in one field what
  // `acronym` already holds, and is exactly the venue+acronym noise the importer
  // strips everywhere else.
  if (b.size <= 1 && a.size > b.size) return 'decline';
  const subset = (x, y) => [...x].every((t) => y.has(t));
  if (subset(a, b) && b.size > a.size) return 'adopt'; // theirs is ours plus its subtitle
  if (subset(b, a) && a.size > b.size) return 'decline'; // ours already says more
  return 'unclear'; // two genuinely different names — a person decides
}

/**
 * ...and for a website. One mechanical case is worth deciding automatically: a
 * stored website that is just the CONFERENCE's own site is a placeholder, never
 * a workshop's homepage, so the list's URL is strictly better. Anything else is
 * two plausible URLs and a person's call — OpenReview and the official list
 * genuinely disagree sometimes, and neither is authoritative.
 *
 * @returns 'adopt' | 'unclear'
 */
export function classifyWebsiteDrift(ours, conferenceWebsite) {
  if (!ours || !conferenceWebsite) return 'unclear';
  const host = (u) => websiteKey(u).split('/')[0];
  return host(ours) === host(conferenceWebsite) ? 'adopt' : 'unclear';
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

  // Tier O — the list linked the OpenReview venue itself. Strictly stronger
  // than a URL match: a venue id is the corpus's own primary key.
  if (entry.openreview_venue_id) {
    const want = String(entry.openreview_venue_id).toLowerCase();
    for (const item of listedInfo) {
      if (item.venueId && item.venueId.toLowerCase() === want) return { item, how: 'venue' };
    }
  }

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

/** The venue id inside an OpenReview group URL, or null. */
function openreviewVenueId(url) {
  const m = String(url ?? '').match(/openreview\.net\/group\?[^#]*\bid=([^&#]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}

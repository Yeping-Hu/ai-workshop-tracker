/**
 * Build-time bridge to the repo-root data libraries.
 * Everything here runs at build only (static output) — no client cost.
 */
// @ts-ignore - shared plain-JS module at the repo root
import {
  loadWorkshops,
  loadConferences,
  loadEditions,
  loadTopics,
  loadPaperCache,
  loadProposalCalls,
  sortByDeadline,
  workshopShortName,
  nameTokens,
  latestProposalCall,
  mergedSlugRedirects,
} from '../../../lib/workshops.mjs';

export type Workshop = Record<string, any>;
export type Conference = Record<string, any>;
export type Topic = { id: string; label: string };

export const workshops: Workshop[] = loadWorkshops();
export const conferences: Conference[] = loadConferences();
export const topics: Topic[] = loadTopics();
export const conferenceById = new Map(conferences.map((c: Conference) => [c.id, c]));
/** Conference edition dates (data/editions.yml), keyed `conf-year`. */
const editions: Record<string, any>[] = loadEditions();
export const editionByKey = new Map<string, Record<string, any>>(
  editions.map((e: Record<string, any>) => [`${e.conference}-${e.year}`, e]),
);
export const topicById = new Map(topics.map((t: Topic) => [t.id, t]));
export { loadPaperCache };

export const upcoming = sortByDeadline(workshops.filter((w: Workshop) => w.status === 'upcoming'));
export const upcomingWithDeadline = upcoming.filter((w: Workshop) => w.deadlineUtcMs != null);
export const upcomingTba = upcoming.filter((w: Workshop) => w.deadlineUtcMs == null);
export const proposalCalls = loadProposalCalls();

/**
 * Old slug -> current slug for every workshop that was merged away, derived
 * from `merged_venue_ids` (mergedSlugRedirects). astro.config.mjs turns the
 * same map into URL redirects; this copy is for the payloads a browser reads,
 * where a saved star pointing at the old slug has to be able to follow it.
 */
export const movedSlugs: Record<string, string> = Object.fromEntries(mergedSlugRedirects());

/**
 * Editions recorded as not taking place. `status: 'not_running'` is why none of
 * the four buckets above pick them up — the board, the TBA list and the archive
 * all drop them with no change here — while `[slug].astro` still builds a page
 * for every entry in `workshops`, so anyone who starred one still lands
 * somewhere. Exported so the count is greppable rather than implicit.
 */
export const notRunning = workshops.filter((w: Workshop) => w.status === 'not_running');

/** Summed from what loadWorkshops() already attached to each entry, rather
 *  than re-reading every paper cache a second time. */
export const paperCount = workshops.reduce((n: number, w: Workshop) => n + (w.paperCount ?? 0), 0);

/** Re-exported for pages that need a workshop's one-line identity. */
export { workshopShortName, nameTokens };
/** Re-exported for the hub's proposal-call line. */
export { latestProposalCall };

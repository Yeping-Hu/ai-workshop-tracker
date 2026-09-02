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
} from '../../../lib/workshops.mjs';

export type Workshop = Record<string, any>;
export type Conference = Record<string, any>;
export type Topic = { id: string; label: string };

export const workshops: Workshop[] = loadWorkshops();
export const conferences: Conference[] = loadConferences();
export const topics: Topic[] = loadTopics();
export const conferenceById = new Map(conferences.map((c: Conference) => [c.id, c]));
/** Conference edition dates (data/editions.yml), keyed `conf-year`. */
export const editionByKey = new Map<string, Record<string, any>>(
  loadEditions().map((e: Record<string, any>) => [`${e.conference}-${e.year}`, e]),
);
export const topicById = new Map(topics.map((t: Topic) => [t.id, t]));
export { loadPaperCache, sortByDeadline };

export const upcoming = sortByDeadline(workshops.filter((w: Workshop) => w.status === 'upcoming'));
export const upcomingWithDeadline = upcoming.filter((w: Workshop) => w.deadlineUtcMs != null);
export const upcomingTba = upcoming.filter((w: Workshop) => w.deadlineUtcMs == null);
export const proposalCalls = loadProposalCalls();
export const deadlinePassed = sortByDeadline(
  workshops.filter((w: Workshop) => w.status === 'deadline_passed'),
);
export const past = workshops
  .filter((w: Workshop) => w.status === 'past')
  .sort((a: Workshop, b: Workshop) => b.year - a.year || a.name.localeCompare(b.name));

/**
 * Editions recorded as not taking place. `status: 'not_running'` is why none of
 * the four buckets above pick them up — the board, the TBA list and the archive
 * all drop them with no change here — while `[slug].astro` still builds a page
 * for every entry in `workshops`, so anyone who starred one still lands
 * somewhere. Exported so the count is greppable rather than implicit.
 */
export const notRunning = workshops.filter((w: Workshop) => w.status === 'not_running');

export const paperCount = workshops.reduce((n: number, w: Workshop) => {
  const c = loadPaperCache(w.slug);
  return n + (c?.paper_count ?? 0);
}, 0);

/** Re-exported for pages that need a workshop's one-line identity. */
export { workshopShortName, nameTokens };

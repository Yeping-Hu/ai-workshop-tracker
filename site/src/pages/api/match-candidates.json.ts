/**
 * The candidate set for "Find workshops for your paper": every open call with
 * its identity, topics, deadline and a sample of the titles its series accepted
 * before, plus the topic vocabulary. Read by the alerts Worker's /match
 * endpoint on each request (cached there), never by the browser. Regenerated
 * on every build from the same data as the board, so the Worker holds no copy
 * of the corpus — see lib/match_candidates.mjs for the shape and the reasons.
 */
import type { APIRoute } from 'astro';
import { workshops, conferenceById, topics, loadPaperCache, workshopShortName } from '../../lib/data';
import { href, REPO_URL } from '../../lib/site';
import { buildMatchCandidates } from '../../../../lib/match_candidates.mjs';

export const GET: APIRoute = () => {
  const built = buildMatchCandidates(workshops, {
    paperCache: loadPaperCache,
    conferenceById,
    topics,
    shortName: (w: any) => workshopShortName(w, conferenceById.get(w.conference)?.name ?? w.conference).full,
    href,
  });
  const out = {
    generated_at: new Date().toISOString(),
    license: 'CC-BY-4.0',
    source: REPO_URL,
    ...built,
  };
  return new Response(JSON.stringify(out), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};

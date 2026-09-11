/**
 * The tracker's index of workshop papers, keyed by OpenReview forum id, for
 * the citation tools: an OpenReview link pasted into "URL to BibTeX" or the
 * BibTeX generator becomes an @inproceedings entry whose booktitle names the
 * workshop, its conference and its year (see fromWorkshopPaper in
 * lib/csl.mjs). The OpenReview API refuses browser calls, and no registry
 * knows which workshop a paper belongs to; this file does.
 *
 * Fetched only when an OpenReview link is pasted, so its size (a few MB for
 * ~20k papers) costs nothing on any other page. Regenerated on every build
 * from the committed caches, like /api/workshops.json.
 *
 * Shape: { count, workshops: { slug: [name, conference, year] },
 *          papers: { forumId: [title, [authors], slug] } }
 */
import type { APIRoute } from 'astro';
import { workshops, loadPaperCache, conferenceById } from '../../lib/data';

export const GET: APIRoute = () => {
  const ws: Record<string, [string, string, number]> = {};
  const papers: Record<string, [string, string[], string]> = {};
  for (const w of workshops) {
    const cache = loadPaperCache(w.slug);
    if (!cache?.papers?.length) continue;
    const conf = conferenceById.get(w.conference);
    ws[w.slug] = [String(w.name), String(conf?.name ?? w.conference), Number(w.year)];
    for (const p of cache.papers) {
      const m = String(p.forum_url ?? '').match(/[?&]id=([^&#]+)/);
      if (!m || !p.title) continue;
      papers[m[1]] = [String(p.title), Array.isArray(p.authors) ? p.authors.map(String) : [], w.slug];
    }
  }
  return new Response(JSON.stringify({ count: Object.keys(papers).length, workshops: ws, papers }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};

/** Generated llms.txt — describes the site, data, and conferences for AI crawlers.
 *  Derived from conferences.yml + workshop data, so new conferences (and current
 *  counts) appear here automatically on the next build. */
import type { APIRoute } from 'astro';
import { workshops, conferences, paperCount } from '../lib/data';
import { href } from '../lib/site';

export const GET: APIRoute = ({ site }) => {
  const origin = site ?? new URL('https://ai-workshop-tracker.pages.dev');
  const abs = (p: string) => new URL(href(p), origin).href;

  const confs = [...conferences].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const acronyms = confs.map((c) => c.name).join(', ');
  const ids = confs.map((c) => c.id).join(', ');
  const covered = confs
    .map((c) => (c.full_name ? `${c.name} (${c.full_name})` : c.name))
    .join(', ');

  const body = `# AI Workshop Tracker

> Submission deadlines, past editions, and accepted papers for the workshops of major AI / ML / Robotics conferences (${acronyms}). Community-maintained and open-source; deadlines should always be confirmed on each workshop's official page.

The site tracks one entry per workshop *edition* (a workshop at a specific conference and year). Each entry records the call-for-papers submission deadline (normalized to a single timezone), key dates, the official website, organizers, topics, and — where the workshop uses OpenReview — its list of accepted papers. As of the latest build there are ${workshops.length} workshop editions and ${paperCount.toLocaleString('en-US')} accepted papers across ${confs.length} conferences; the site is rebuilt daily.

## Data
- [Workshops JSON API](${abs('/api/workshops.json')}): Machine-readable list of every tracked workshop edition with resolved deadlines, dates, status, topics, and paper counts. This is the canonical structured source — prefer it over scraping the HTML.
- [New-workshops RSS feed](${abs('/rss.xml')}): Workshop editions as they are added.

## Key pages
- [Home / deadline board](${abs('/')}): Upcoming workshop submission deadlines with countdowns, plus full-text search across all workshops and papers.
- [About](${abs('/about/')}): What the project is, how the data is sourced, and how to contribute.
- Per-conference pages: \`${abs('/')}conference/<id>/\` — one conference's workshops across every tracked year (ids: ${ids}).
- Per-edition pages: \`${abs('/')}conference/<id>/<year>/\` — one conference year: its workshops with deadlines, dates, paper counts, and a FAQ.
- Workshop detail pages: \`${abs('/')}workshop/<slug>/\` — one per workshop edition, listing its deadline, dates, organizers, and accepted papers.

## Conferences covered
${covered}.

## About the data
- [Source repository (GitHub)](https://github.com/Yeping-Hu/ai-workshop-tracker): Open-source. Workshop data is one YAML file per edition; accepted-paper lists are cached from the OpenReview API; deadlines are normalized to a consistent timezone at build time.
- License: site code is MIT; the workshop dataset is CC-BY-4.0. Suggested attribution: "AI Workshop Tracker" by Yeping Hu. Deadlines are community-maintained and may contain errors — always confirm on the official workshop page before submitting.
`;

  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};

/** RSS feed of newly added workshops (sorted by the `added` date in each YAML). */
import type { APIRoute } from 'astro';
import { workshops, conferenceById, workshopShortName } from '../lib/data';
import { href } from '../lib/site';

const esc = (s: string) =>
  String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

export const GET: APIRoute = ({ site }) => {
  const origin = site ?? new URL('https://ai-workshop-tracker.pages.dev');
  const items = workshops
    .filter((w) => w.added)
    .sort((a, b) => String(b.added).localeCompare(String(a.added)))
    .slice(0, 50)
    .map((w) => {
      const conf = conferenceById.get(w.conference);
      const link = new URL(href(`/workshop/${w.slug}/`), origin).href;
      const deadline = w.deadlineWallClock ? `Deadline: ${w.deadlineWallClock}.` : 'Deadline TBA.';
      return `  <item>
   <title>${esc(`${workshopShortName(w, conf?.name ?? w.conference).full} (${conf?.name ?? w.conference} ${w.year})`)}</title>
   <link>${esc(link)}</link>
   <guid isPermaLink="true">${esc(link)}</guid>
   <pubDate>${new Date(`${w.added}T12:00:00Z`).toUTCString()}</pubDate>
   <description>${esc(`${deadline} ${w.website}`)}</description>
  </item>`;
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
 <channel>
  <title>AI Workshop Tracker — newly added workshops</title>
  <link>${esc(origin.href)}</link>
  <description>New workshop entries on the AI Workshop Tracker.</description>
${items}
 </channel>
</rss>`;
  return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
};

/**
 * Static Markdown exports, generated at build time:
 *   /exports/<conference>-<year>-workshops.md
 *
 * Conference pages link to these files instead of embedding the Markdown in
 * their HTML. Copy fetches the same URL that Download links to, so visitors
 * only transfer the export payload when they ask for it.
 */
import type { APIRoute } from 'astro';
import { conferences, workshops } from '../../lib/data.ts';
import { formatConferenceYear } from '../../lib/markdown.ts';

type ConferenceExport = {
  conference: any;
  year: number;
  workshops: any[];
};

const rank = (w: any) =>
  w.statusLabel === 'Open call' ? 0 : w.statusLabel === 'Deadline unknown' ? 1 : 2;

const EXPORTS = new Map<string, ConferenceExport>();

for (const conference of conferences) {
  const byYear = new Map<number, any[]>();
  for (const workshop of workshops) {
    if (workshop.conference !== conference.id) continue;
    if (!byYear.has(workshop.year)) byYear.set(workshop.year, []);
    byYear.get(workshop.year)!.push(workshop);
  }

  for (const [year, items] of byYear) {
    items.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        ((a.nextStageUtcMs ?? a.deadlineUtcMs) ?? Infinity) -
          ((b.nextStageUtcMs ?? b.deadlineUtcMs) ?? Infinity) ||
        (a.name || '').localeCompare(b.name || ''),
    );
    EXPORTS.set(`${conference.id}-${year}-workshops`, {
      conference,
      year,
      workshops: items,
    });
  }
}

export function getStaticPaths() {
  return [...EXPORTS.keys()].map((exportName) => ({ params: { export: exportName } }));
}

export const GET: APIRoute = ({ params }) => {
  const item = EXPORTS.get(params.export as string);
  if (!item) return new Response('Not found', { status: 404 });

  return new Response(formatConferenceYear(item.conference, item.year, item.workshops), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
};

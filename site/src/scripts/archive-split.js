/**
 * Where the saved list is cut in two, and the demo the empty shelf offers.
 *
 * /saved/ used to be one flat list that only ever grew: a workshop starred in
 * January was still sitting there in December, greyed out, between the reader
 * and the three open calls they actually came for. The Workshops section now
 * keeps what can still be acted on as board rows and hands everything concluded
 * to the archive shelf (site/src/scripts/archive-shelf.js).
 *
 * Both halves of that split live here rather than inline in saved.astro so
 * scripts/saved_archive_test.mjs can pin them without a browser.
 */

/**
 * Archived means the site already calls it Past.
 *
 * This is the same branch `deriveStatusLabel` takes in lib/workshops.mjs, and
 * saved_archive_test.mjs asserts the two agree across the whole corpus. Stated
 * as one rule in one place because the alternative — the shelf holding its own
 * opinion about "past" — is how a workshop ends up shelved while its row still
 * shows an Open call pill.
 *
 * `deadline_passed` (deadline gone, the event itself still ahead) is included
 * deliberately: it is the status that produced the pile-up this split exists to
 * clear, and the board already labels it Past everywhere else.
 */
export const isArchived = (w) => w.status === 'past' || w.status === 'deadline_passed';

/** Sort key for "most recently closed first" within one conference-year. */
const closedAt = (w) => (w.deadline_utc ? Date.parse(w.deadline_utc) : -Infinity);

/**
 * How many volumes each conference-year contributes to the demo, in order.
 *
 * Uneven on purpose. Equal-sized groups read as a generated grid, and real
 * reading never looks like that — the shelf is trying to look like a shelf.
 * The pattern repeats if it runs out, which is what makes up for a group too
 * thin to fill its share; see the loop below.
 */
const DEMO_SIZES = [4, 2, 5, 3, 2];

/**
 * A deterministic demo shelf, drawn from the live corpus.
 *
 * The empty archive offers this so a reader with nothing shelved yet — most
 * often someone who has starred nothing at all — can still see what the shelf
 * is for. Drawn from /api/workshops.json rather than written down, because a
 * hand-authored demo list would be a data artifact that no pipeline maintains
 * and would rot the first time a slug was renamed.
 *
 * Spread across conference-years on purpose: the break captions between groups
 * are half of what the shelf looks like, and the most recent volumes would
 * otherwise all belong to one conference.
 *
 * `limit` is 16 because the demo should read as an invitation, not as a
 * backlog. Sixteen volumes and their break captions fill about 60% of one
 * plank and never wrap to a second row: the shelf's content column is a fixed
 * ~1040px, so this holds at every desktop width, and even if every slug in a
 * future demo hashed to the widest spine — they vary .63–1.00 of the maximum
 * — the row still has room. A reader's OWN shelf is never capped; this applies
 * only to the demo.
 */
export function demoShelf(all, { limit = 16, sizes = DEMO_SIZES } = {}) {
  const groups = new Map();
  for (const w of all) {
    if (!isArchived(w)) continue;
    const k = `${w.conference}-${w.year}`;
    if (!groups.has(k)) groups.set(k, { conf: String(w.conference), year: Number(w.year), items: [] });
    groups.get(k).items.push(w);
  }

  // Newest year first, then conference A→Z — the order archive-shelf.js's own
  // group() paints in, so the demo reads the way a real shelf would.
  const ordered = [...groups.values()].sort((a, b) => b.year - a.year || a.conf.localeCompare(b.conf));

  const out = [];
  let si = 0; // which share of the pattern the next contributing group takes
  for (const g of ordered) {
    if (out.length >= limit) break;
    const want = Math.min(sizes[si % sizes.length], limit - out.length);
    const take = [...g.items].sort((a, b) => closedAt(b) - closedAt(a)).slice(0, want);
    out.push(...take);
    si++;
    // A group thinner than its share just gives what it has, and the loop walks
    // on into older conference-years until the shelf is full — so a sparse
    // newest year (January, say, when almost nothing has closed yet) costs the
    // demo an extra break caption, not four missing volumes.
  }
  return out;
}

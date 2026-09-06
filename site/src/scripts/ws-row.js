/**
 * One workshop row, rendered in the browser.
 *
 * The deadline board renders its row server-side from WorkshopRow.astro. Two
 * other surfaces have to render the same row after the page has loaded — the
 * saved list, because only the browser knows what a visitor starred, and the
 * homepage's search results, which arrive from Pagefind — and each used to
 * carry its own copy, which drifted: the saved list quietly lacked location,
 * topic chips and the deadline-change note, and the results had no countdown
 * or local time at all, so filtering the board looked nothing like the board.
 * This is the one client renderer both use. scripts/row_parity_test.mjs checks
 * that every field the board shows has an equivalent here and in the results'
 * metadata; scripts/vocabulary_test.mjs pins the deadline-change wording.
 *
 * `w` is API-shaped — the field names of /api/workshops.json (deadline_utc,
 * next_stage_utc, deadline_wall_clock, location_label, deadline_change, …).
 * The results page maps Pagefind metadata onto the same names before calling.
 *
 *   opts.base        site base path ('' or '/sub')
 *   opts.conf        { name, color } for the badge
 *   opts.topicLabel  topic id -> label
 *   opts.pill        emit the status pill. The results do; the saved list does
 *                    not, because its row already says it twice (the countdown
 *                    column reads "passed" or "TBA", a concluded row is greyed).
 *   opts.star        'on' — a saved row: ★, pressed; 'off' — ☆, which
 *                    favorites.js hydrates afterwards
 *   opts.titleClass  extra class on the name link
 *   opts.rowAttrs    extra attributes on the row element, already escaped
 */
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Mirrors the board's note exactly (WorkshopRow.astro): same classes, same
// wording, same tooltip. Any difference here shows up as two pages
// disagreeing about one workshop.
export function dlChangeHtml(w) {
  const c = w.deadline_change;
  if (!c) return '';
  const d = c.days === 1 ? 'day' : 'days';
  const body =
    c.kind === 'extended' ? `→ Extended ${c.days} ${d}`
    : c.kind === 'earlier' ? `△ Moved ${c.days} ${d} earlier`
    : c.kind === 'announced' ? 'First deadline posted'
    : '';
  if (!body) return '';
  const title = `Recorded ${esc(c.recorded)} — the date we observed this value, not necessarily when the organizers changed it.`;
  return `<div class="dl-change dl-${esc(c.kind)}" title="${title}">${body}</div>`;
}

// The pill's class from the label the site shows. "Not running" needs its own
// entry: the ?? fallback would paint a tombstoned edition like an ordinary
// past workshop.
const PILL_CLASS = { 'Open call': 'upcoming', 'Deadline unknown': 'unknown', 'Not running': 'not_running' };

export function wsRowHtml(w, opts = {}) {
  const {
    base = '',
    conf = { name: w.conference, color: '#888' },
    topicLabel = (id) => id,
    pill = false,
    star = 'off',
    titleClass = '',
    rowAttrs = '',
  } = opts;
  const ms = w.deadline_utc ? Date.parse(w.deadline_utc) : null;
  // Two-stage venues: the date shown stays the paper deadline, but the
  // countdown follows the next actionable stage and says which it is.
  const absOpen = !!w.next_stage_is_abstract;
  const cdMs = w.next_stage_utc ? Date.parse(w.next_stage_utc) : ms;
  const upcoming = w.status === 'upcoming';
  // Someone who starred a workshop that turned out not to be running comes
  // looking for it here. Without an explicit annotation the row reads
  // "passed", which is wrong in the way that matters: it suggests they missed
  // a deadline rather than that there was never a workshop.
  const notRunning = w.status === 'not_running';
  const name = esc(w.name);
  const slug = esc(w.slug);
  const label = w.status_label ?? (notRunning ? 'Not running' : '');
  const pillHtml = pill
    ? `<span class="pill ${PILL_CLASS[label] ?? 'past'}">${esc(label)}</span>`
    : notRunning
      ? '<span class="pill not_running">Not running</span>'
      : '';
  const starHtml =
    star === 'on'
      ? `<button class="star-btn" type="button" data-star-ws="${slug}" aria-pressed="true" aria-label="Remove ${name} from saved">★</button>`
      : `<button class="star-btn" type="button" data-star-ws="${slug}" aria-pressed="false" aria-label="Save ${name} to your list" title="Save for later (stays in this browser)">☆</button>`;
  const abstractWall = w.abstract_deadline_wall_clock ?? (w.abstract_deadline ? `${w.abstract_deadline} UTC` : null);
  return `
  <div class="board-row ${upcoming ? '' : 'row-passed'}" ${rowAttrs}>
    <span class="badge" style="--conf:${esc(conf.color)}">${esc(conf.name)}</span>
    <div class="ws-main">
      <div class="ws-name">
        <a${titleClass ? ` class="${esc(titleClass)}"` : ''} href="${base}/workshop/${slug}/">${name}</a>
        ${starHtml}
      </div>
      <div class="ws-meta">
        ${pillHtml}
        ${w.acronym ? `<span class="mono">${esc(w.acronym)}</span>` : ''}
        <span>${esc(conf.name)} ${esc(w.year)}</span>
        ${w.location_distinguishes && w.location_label ? `<span class="ws-where">${esc(w.location_label)}</span>` : ''}
        ${(w.topics ?? []).map((id) => `<span class="chip">${esc(topicLabel(id))}</span>`).join('')}
      </div>
    </div>
    <div class="ws-deadline">
      ${
        ms != null
          ? `<div class="wall">${esc(w.deadline_wall_clock ?? (w.submission_deadline + (w.timezone ? ' ' + w.timezone : '')))}</div>
             <div class="local js-local" data-iso="${esc(w.deadline_utc)}"></div>${
               abstractWall
                 ? `<div class="abs-stage small">${
                     absOpen
                       ? `<span class="abs-open">Abstract due ${esc(abstractWall)}</span>`
                       : `<span class="muted">Abstract closed ${esc(abstractWall)}</span>`
                   }<div class="local js-local" data-iso="${esc(w.abstract_deadline_utc ?? '')}"></div></div>`
                 : ''
             }${dlChangeHtml(w)}`
          : `<div class="muted">${upcoming ? 'Deadline TBA' : '—'}</div>`
      }
    </div>
    ${
      upcoming && ms != null
        ? `<span class="countdown" data-deadline-ms="${cdMs}"${absOpen ? ' data-stage="abstract"' : ''}>—</span>`
        : upcoming
          ? '<span class="countdown is-tba">TBA</span>'
          : notRunning
            ? '<span class="countdown is-over">not running</span>'
            : '<span class="countdown is-over">passed</span>'
    }
  </div>`;
}

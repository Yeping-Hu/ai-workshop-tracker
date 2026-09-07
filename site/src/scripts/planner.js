/**
 * The saved-page agenda: every dated stage of the workshops a visitor starred,
 * month by month, with a warning when deadlines pile up.
 *
 * A star says "I might submit here"; the board answers "when is the next
 * one?" but not "what does my autumn look like?". This is that view — the
 * same rows the saved list already holds, re-cut by month — so the page is
 * worth coming back to every week rather than once per deadline.
 *
 * Pure: `buildAgenda()` and `agendaHtml()` touch no DOM, so
 * scripts/planner_test.mjs runs them under plain Node. saved.astro owns the
 * DOM, calls them with the rows it already fetched from /api/workshops.json,
 * and hands the result to `window.awtBoardHydrate` so the deadline items get
 * the board's own live countdown rather than a second clock.
 *
 * Items, per starred workshop (skipped when `not_running`):
 *   deadline      `deadline_utc`            the paper deadline
 *   abstract      `abstract_deadline_utc`   the abstract stage of a two-stage venue
 *   notification  `notification_date`       date only; midnight UTC
 *   workshop      `workshop_date`           date only; midnight UTC
 * plus one `conference` item per distinct conference-year among the starred
 * workshops, from data/editions.yml (embedded at build by saved.astro rather
 * than added to the public API: it is display data for one page). Only ~10
 * entries in the corpus carry notification or workshop dates, so the
 * conference week is what gives most agendas a second line.
 *
 * Grouping is by UTC month, because every wall clock the site prints is UTC
 * (docs/ARCHITECTURE.md, "Deadlines are stored in UTC"); a local-time month
 * boundary would put the same deadline in different months for two readers.
 *
 * Collisions: COLLISION_N or more deadline/abstract items within
 * COLLISION_DAYS, found greedily left to right over the sorted future items,
 * non-overlapping. Three submissions in ten days is where a lab's calendar
 * usually breaks; it is a nudge, not a rule.
 */

export const COLLISION_DAYS = 10;
export const COLLISION_N = 3;
const DAY_MS = 86_400_000;

const KIND_LABEL = {
  deadline: 'paper deadline',
  abstract: 'abstract deadline',
  notification: 'notification',
  workshop: 'workshop day',
  conference: 'conference',
};

const dateOnlyMs = (s) => {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return null;
  const ms = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
};
const isoMs = (s) => {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
};

const monthFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });
const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const wdFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' });
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false });

export const monthKey = (ms) => new Date(ms).toISOString().slice(0, 7);
export const fmtDay = (ms) => dayFmt.format(ms);
export const fmtWeekday = (ms) => wdFmt.format(ms);
export const fmtTime = (ms) => `${timeFmt.format(ms)} UTC`;

/**
 * @param {Array} workshops rows from /api/workshops.json (already filtered to the starred slugs)
 * @param {{ nowMs?: number, editions?: Record<string, {start?: string, end?: string, label?: string}> }} opts
 *        `editions` is keyed `conf-year`.
 * @returns {{ months: Array<{key: string, label: string, items: Array}>,
 *             collisions: Array<{startMs: number, endMs: number, count: number, slugs: string[]}>,
 *             passed: number, total: number }}
 */
export function buildAgenda(workshops, { nowMs = Date.now(), editions = {} } = {}) {
  const rows = Array.isArray(workshops) ? workshops.filter((w) => w && w.status !== 'not_running') : [];
  const items = [];
  let passed = 0;
  const confYears = new Map(); // conf-year -> conference id

  for (const w of rows) {
    const base = { slug: w.slug, name: w.short_name || w.name || w.slug, conference: w.conference, year: w.year };
    const stages = [
      ['deadline', isoMs(w.deadline_utc)],
      ['abstract', isoMs(w.abstract_deadline_utc)],
      ['notification', dateOnlyMs(w.notification_date)],
      ['workshop', dateOnlyMs(w.workshop_date)],
    ];
    for (const [kind, ms] of stages) {
      if (ms == null) continue;
      if (ms <= nowMs) {
        if (kind === 'deadline') passed++;
        continue;
      }
      items.push({ ...base, kind, ms, timed: kind === 'deadline' || kind === 'abstract' });
    }
    if (w.conference && w.year) confYears.set(`${w.conference}-${w.year}`, w.conference);
  }

  for (const [key, conference] of confYears) {
    const ed = editions?.[key];
    const ms = ed ? dateOnlyMs(ed.start) ?? dateOnlyMs(ed.end) : null;
    if (ms == null || ms <= nowMs) continue;
    items.push({
      slug: null,
      name: ed.label || fmtDay(ms),
      conference,
      year: Number(key.slice(key.lastIndexOf('-') + 1)),
      kind: 'conference',
      ms,
      timed: false,
    });
  }

  items.sort((a, b) => a.ms - b.ms || a.kind.localeCompare(b.kind) || String(a.name).localeCompare(String(b.name)));

  const months = [];
  for (const it of items) {
    const key = monthKey(it.ms);
    let m = months[months.length - 1];
    if (!m || m.key !== key) {
      m = { key, label: monthFmt.format(it.ms), items: [] };
      months.push(m);
    }
    m.items.push(it);
  }

  const dl = items.filter((it) => it.timed);
  const collisions = [];
  let i = 0;
  while (i < dl.length) {
    let j = i;
    while (j + 1 < dl.length && dl[j + 1].ms - dl[i].ms <= COLLISION_DAYS * DAY_MS) j++;
    if (j - i + 1 >= COLLISION_N) {
      collisions.push({ startMs: dl[i].ms, endMs: dl[j].ms, count: j - i + 1, slugs: dl.slice(i, j + 1).map((d) => d.slug) });
      i = j + 1;
    } else {
      i++;
    }
  }

  return { months, collisions, passed, total: rows.length };
}

/** The GoatCounter bucket for `planner/rendered`: coarse on purpose. */
export function starBucket(n) {
  if (n <= 0) return '0';
  if (n === 1) return '1';
  if (n <= 4) return '2-4';
  if (n <= 9) return '5-9';
  return '10+';
}

/**
 * @param {ReturnType<typeof buildAgenda>} agenda
 * @param {{ base: string, esc: (s: unknown) => string, conf?: (id: string) => {name: string, color: string} }} opts
 */
export function agendaHtml(agenda, { base = '', esc, conf = (id) => ({ name: id, color: '#888' }) }) {
  if (typeof esc !== 'function') throw new Error('agendaHtml needs an escaper');
  if (!agenda.months.length) {
    const msg = agenda.passed > 0
      ? `Nothing ahead — ${agenda.passed === agenda.total ? 'all' : ''} ${agenda.passed} saved ${agenda.passed === 1 ? 'deadline has' : 'deadlines have'} passed.`.replace(/\s+/g, ' ')
      : 'Nothing scheduled yet — your saved workshops have no dates published.';
    return `<p class="muted planner-empty">${esc(msg)}</p>`;
  }
  const nameOf = (s) => s;
  const warn = agenda.collisions
    .map((c) => {
      const names = c.slugs.map((s) => agenda.months.flatMap((m) => m.items).find((it) => it.slug === s && it.timed)?.name ?? s);
      return `<p class="planner-warn small" role="note">${c.count} deadlines within ${COLLISION_DAYS} days (${esc(fmtDay(c.startMs))} – ${esc(fmtDay(c.endMs))}): ${names.map((n) => esc(nameOf(n))).join(', ')}.</p>`;
    })
    .join('');
  const months = agenda.months
    .map(
      (m) => `
      <div class="planner-month" data-month="${esc(m.key)}">
        <h3 class="planner-month-head">${esc(m.label)}</h3>
        <ul class="planner-list">
          ${m.items
            .map((it) => {
              const c = conf(it.conference);
              const when = `<span class="mono planner-when"><span class="planner-day">${esc(fmtDay(it.ms))}</span> <span class="muted">${esc(fmtWeekday(it.ms))}</span>${it.timed ? `<span class="planner-time muted">${esc(fmtTime(it.ms))}</span>` : ''}</span>`;
              const what = it.slug
                ? `<a href="${esc(base)}/workshop/${esc(it.slug)}/">${esc(it.name)}</a>`
                : `<span>${esc(c.name)} ${esc(it.year)} · ${esc(it.name)}</span>`;
              const cd = it.timed ? `<span class="countdown" data-deadline-ms="${it.ms}"${it.kind === 'abstract' ? ' data-stage="abstract"' : ''}>—</span>` : '<span class="countdown is-tba"></span>';
              return `<li class="planner-item" data-kind="${esc(it.kind)}"${it.slug ? ` data-planner-slug="${esc(it.slug)}"` : ''}>
            ${when}
            <span class="planner-kind muted">${esc(KIND_LABEL[it.kind] ?? it.kind)}</span>
            <span class="planner-what"><span class="badge" style="--conf:${esc(c.color)}">${esc(c.name)}</span> ${what}</span>
            ${cd}
          </li>`;
            })
            .join('')}
        </ul>
      </div>`,
    )
    .join('');
  return warn + months;
}

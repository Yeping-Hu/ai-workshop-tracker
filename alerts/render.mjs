/**
 * Email rendering — digests, urgent alerts, and the two transactional
 * templates. Pure functions returning `{subject, html, text}`; pinned by
 * scripts/alerts_render_test.mjs.
 *
 * Constraints baked in here, all from docs/plans/email-alerts.md §6.4:
 *
 *   - **No images, no tracking pixels, no click redirects.** Every link is the
 *     real destination. We accept not knowing open rates.
 *   - **Every message has a plaintext part**, and every bulk message carries an
 *     unsubscribe link in the body as well as in the headers.
 *   - **Dark-mode safe**: no pure-white backgrounds, colors that survive a
 *     client inverting them, system font stack, single column, inline styles
 *     (the only thing every mail client agrees on).
 *   - **An empty digest renders `null`** so the caller skips the send. A weekly
 *     "nothing happened" email is how a useful list becomes a muted one.
 *
 * Tokens never reach the renderer. The Action that calls it has no HMAC secret
 * (decision D3), so per-recipient links are emitted as the placeholders below
 * and substituted by the Worker's /admin/send, which mints the tokens. Render
 * with explicit `manageUrl`/`unsubUrl` only in tests and previews.
 */

import { SECTION_CAP, SITE_ORIGIN } from './config.mjs';

export const MANAGE_PLACEHOLDER = '{{MANAGE_URL}}';
export const UNSUB_PLACEHOLDER = '{{UNSUB_URL}}';

/** Required on every message — the site's own accuracy caveat, verbatim. */
export const FOOTER_CAVEAT =
  'Data observed by aiworkshoptracker.com — dates are when we recorded a value, ' +
  'not necessarily when organizers changed it. Always confirm on the official workshop page.';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/* ------------------------------------------------------------------ helpers */

const wsUrl = (slug) => `${SITE_ORIGIN}/workshop/${slug}/`;

/** "12 Sep 2026, 23:59 UTC" — unambiguous in every locale, no JS in the email. */
export function fmtUtc(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

/**
 * A deadline as a subscriber should read it: their own time first, with the
 * canonical UTC value alongside.
 *
 *   with a zone   16 Sep 2026, 16:59 PDT (23:59 UTC)
 *   without one   16 Sep 2026, 23:59 UTC
 *
 * Email cannot run JavaScript, so the conversion has to happen here, at send
 * time, from a zone stored on the subscriber. The IANA name is stored rather
 * than an offset precisely so this call resolves the right offset for *this*
 * deadline's date — a deadline on the far side of a DST boundary would
 * otherwise be an hour out.
 *
 * Degrades to UTC on anything unexpected. An unrecognised zone must not throw
 * here: this runs inside the loop that renders every subscriber's mail, and one
 * bad row would take down the whole send.
 */
export function fmtWhen(iso, tz) {
  const utc = fmtUtc(iso);
  if (!tz || !utc) return utc;
  try {
    const d = new Date(iso);
    // en-US, deliberately: it yields "Sep" (matching fmtUtc's own month names)
    // and a real zone abbreviation like "PDT" where en-GB gives "GMT-7".
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    }).formatToParts(d);
    const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
    const local = `${get('day')} ${get('month')} ${get('year')}, ${get('hour')}:${get('minute')} ${get('timeZoneName')}`;
    // Same wall clock in both zones (someone in UTC) — one reading is enough.
    const utcTime = utc.split(', ')[1];
    if (local.endsWith(utcTime)) return utc;
    return `${local} (${utcTime})`;
  } catch {
    return utc;
  }
}

/** Hours until `iso`, rounded down — the urgent subject's "in {h}h". */
export function hoursUntil(iso, nowMs) {
  return Math.max(0, Math.floor((Date.parse(iso) - nowMs) / 3_600_000));
}

/** Conference display label ("NeurIPS"), falling back to the raw id. */
function confLabel(ids, id) {
  return ids?.conferences?.find((c) => c.id === id)?.label ?? id;
}

/**
 * How a workshop is named.
 *
 * Every workshop in the dataset has an acronym, so the old
 * `acronym || name` meant the full name was never shown anywhere in any email —
 * and "LM4Sci" alone tells a reader nothing. Bodies now carry the full name
 * with the acronym beside it; subjects keep the acronym, which is short enough
 * never to be truncated in an inbox list.
 *
 *   full:  LLM for Scientific Discovery: Reasoning… (LM4Sci · NeurIPS 2026)
 *   short: LM4Sci (NeurIPS 2026)
 */
function wsTitle(w, ids, { full = false } = {}) {
  const conf = confLabel(ids, w.conference);
  const acr = w.acronym || '';
  if (!full) return `${acr || w.name} (${conf} ${w.year})`;
  const name = w.name || acr;
  const tail = acr && acr !== name ? `${acr} · ${conf} ${w.year}` : `${conf} ${w.year}`;
  return `${name} (${tail})`;
}

/**
 * Homepage link with facets prefilled. The site's URL params carry **display
 * labels**, not ids (`?conference=NeurIPS&topic=Agents`), so ids are mapped
 * back through the vocabulary before they go into a link.
 */
export function facetUrl(sub, ids) {
  const p = new URLSearchParams();
  const confs = (sub.conferences ?? []).map((id) => confLabel(ids, id));
  const tops = (sub.topics ?? []).map((id) => ids?.topics?.find((t) => t.id === id)?.label ?? id);
  if (confs.length) p.set('conference', confs.join(','));
  if (tops.length) p.set('topic', tops.join(','));
  const qs = p.toString();
  return qs ? `${SITE_ORIGIN}/?${qs}` : `${SITE_ORIGIN}/`;
}

/* -------------------------------------------------------------- chrome/shell */

/**
 * CAN-SPAM requires a physical postal address on bulk mail. Left empty until
 * the maintainer picks one (a PO box or registered-agent address — a home
 * address is not recommended); see docs/plans/email-alerts.md §9 item 6. The footer
 * omits the line while it is empty, so nothing renders as "undefined".
 */
export const POSTAL_ADDRESS = '';

const SHELL_STYLE =
  'margin:0;padding:24px 12px;background:#f4f5f7;color:#16181c;' +
  "font:16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
const CARD_STYLE =
  'max-width:640px;margin:0 auto;background:#fbfbfc;border:1px solid #dfe2e6;border-radius:10px;padding:24px;';
const LINK = 'color:#0f766e;text-decoration:underline;';
const MUTED = 'color:#585c63;';

function shell({ title, bodyHtml, manageUrl, unsubUrl, showManage = true }) {
  const footerLinks = showManage
    ? `<a href="${esc(manageUrl)}" style="${LINK}">Manage preferences</a> · ` +
      `<a href="${esc(unsubUrl)}" style="${LINK}">Unsubscribe</a><br />`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>${esc(title)}</title></head>
<body style="${SHELL_STYLE}">
<div style="${CARD_STYLE}">
<p style="margin:0 0 20px;font-size:13px;letter-spacing:0.04em;text-transform:uppercase;${MUTED}">
<a href="${SITE_ORIGIN}/" style="${LINK}">AI Workshop Tracker</a></p>
${bodyHtml}
<hr style="border:0;border-top:1px solid #dfe2e6;margin:28px 0 16px;" />
<p style="margin:0;font-size:12.5px;${MUTED}">
${esc(FOOTER_CAVEAT)}<br /><br />
${footerLinks}
${POSTAL_ADDRESS ? `${esc(POSTAL_ADDRESS)}<br />` : ''}
Sent because you subscribed at <a href="${SITE_ORIGIN}/" style="${LINK}">aiworkshoptracker.com</a>.
</p>
</div>
</body></html>`;
}

function textFooter({ manageUrl, unsubUrl, showManage = true }) {
  const lines = ['', '—', FOOTER_CAVEAT, ''];
  if (showManage) {
    lines.push(`Manage preferences: ${manageUrl}`, `Unsubscribe: ${unsubUrl}`);
  }
  if (POSTAL_ADDRESS) lines.push(POSTAL_ADDRESS);
  lines.push('Sent because you subscribed at aiworkshoptracker.com');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ sections */

/**
 * One digest section. Renders at most SECTION_CAP items and, when there are
 * more, an "and N more →" link into the site with the subscriber's own facets
 * prefilled.
 */
function section({ heading, items, moreUrl }) {
  if (!items.length) return { html: '', text: '' };
  const shown = items.slice(0, SECTION_CAP);
  const extra = items.length - shown.length;

  const li = shown
    .map((it) => `<li style="margin:0 0 10px;">${it.html}</li>`)
    .join('\n');
  const more = extra
    ? `<p style="margin:10px 0 0;font-size:14px;"><a href="${esc(moreUrl)}" style="${LINK}">and ${extra} more →</a></p>`
    : '';

  const html =
    `<h2 style="margin:26px 0 10px;font-size:17px;line-height:1.3;">${esc(heading)}</h2>` +
    `<ul style="margin:0;padding-left:20px;">\n${li}\n</ul>${more}`;

  const text =
    `\n${heading}\n${'-'.repeat(heading.length)}\n` +
    shown.map((it) => `* ${it.text}`).join('\n') +
    (extra ? `\nand ${extra} more: ${moreUrl}` : '') +
    '\n';

  return { html, text };
}

/** "→ Extended 5 days · NAME (CONF year) — now <date> UTC" */
function changeItem(ev, w, ids, tz) {
  const title = wsTitle(w, ids, { full: true });
  const link = wsUrl(w.slug);
  const when = ev.new_utc ? fmtWhen(ev.new_utc, tz) : '';
  let lead;
  if (ev.kind === 'extended') lead = `→ Extended ${ev.days} day${ev.days === 1 ? '' : 's'}`;
  else if (ev.kind === 'earlier') lead = `△ Moved ${ev.days} day${ev.days === 1 ? '' : 's'} earlier`;
  else lead = '→ Deadline just announced';
  return {
    html:
      `<strong>${esc(lead)}</strong> · <a href="${link}" style="${LINK}">${esc(title)}</a>` +
      (when ? ` — now ${esc(when)}` : ''),
    text: `${lead} · ${title}${when ? ` — now ${when}` : ''}\n  ${link}`,
  };
}

function announcedItem(w, ids, tz) {
  const title = wsTitle(w, ids, { full: true });
  const link = wsUrl(w.slug);
  const when = w.deadline_utc ? ` — deadline ${fmtWhen(w.deadline_utc, tz)}` : ' — deadline not yet announced';
  return {
    html: `<a href="${link}" style="${LINK}">${esc(title)}</a><span style="${MUTED}">${esc(when)}</span>`,
    text: `${title}${when}\n  ${link}`,
  };
}

function closingItem(w, ids, savedSet, tz) {
  const title = wsTitle(w, ids, { full: true });
  const link = wsUrl(w.slug);
  const star = savedSet.has(w.slug) ? '★ ' : '';
  const stage = w.next_stage_is_abstract ? ' (abstract)' : '';
  const when = fmtWhen(w.next_stage_utc || w.deadline_utc, tz);
  return {
    html: `${star}<a href="${link}" style="${LINK}">${esc(title)}</a><span style="${MUTED}"> — ${esc(when)}${esc(stage)}</span>`,
    text: `${star}${title} — ${when}${stage}\n  ${link}`,
  };
}

/* -------------------------------------------------------------------- digest */

/**
 * Build one subscriber's weekly digest.
 *
 * @param sub        normalized subscriber (alerts/match.mjs)
 * @param events     this week's events, already filtered to this subscriber
 * @param workshops  live projection map (slug -> projection)
 * @param nowMs      run timestamp
 * @param ids        alerts/ids.json vocabulary
 * @returns {subject, html, text} — or **null** when every section is empty,
 *          which the caller must treat as "skip this subscriber".
 */
export function renderDigest({
  sub,
  tz = sub?.tz ?? null,
  events,
  workshops,
  nowMs,
  ids,
  manageUrl = MANAGE_PLACEHOLDER,
  unsubUrl = UNSUB_PLACEHOLDER,
}) {
  const saved = new Set(sub.starred_ws ?? []);
  const more = facetUrl(sub, ids);

  // 1. Deadline changes this week.
  const changeKinds = new Set(['extended', 'earlier', 'deadline_announced']);
  const changes = events
    .filter((e) => changeKinds.has(e.kind) && workshops[e.slug])
    .map((e) => changeItem(e, workshops[e.slug], ids, tz));

  // 2. Newly announced — but not ones that are already Past by the time the
  //    digest goes out (a back-filled 2024 edition is not news).
  const announced = events
    .filter((e) => e.kind === 'announced' && workshops[e.slug] && workshops[e.slug].status !== 'past')
    .map((e) => announcedItem(workshops[e.slug], ids, tz));

  // 3. Closing in the next 7 days, from the live projection (not events).
  const weekMs = 7 * 86_400_000;
  const closing = Object.values(workshops)
    .map((w) => {
      const iso = w.next_stage_utc || w.deadline_utc;
      const ms = iso ? Date.parse(iso) : NaN;
      return Number.isFinite(ms) ? { w, ms } : null;
    })
    .filter((x) => x && x.ms >= nowMs && x.ms < nowMs + weekMs)
    .sort((a, b) => a.ms - b.ms)
    .map(({ w }) => closingItem(w, ids, saved, tz));

  // 4. Your saved workshops — next deadlines. Ignores the filters (top 5).
  const savedNext = [...saved]
    .map((slug) => workshops[slug])
    .filter(Boolean)
    .map((w) => {
      const iso = w.next_stage_utc || w.deadline_utc;
      const ms = iso ? Date.parse(iso) : NaN;
      return Number.isFinite(ms) && ms >= nowMs ? { w, ms } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.ms - b.ms)
    .slice(0, 5)
    .map(({ w }) => closingItem(w, ids, saved, tz));

  if (!changes.length && !announced.length && !closing.length && !savedNext.length) return null;

  const secs = [
    section({ heading: 'Deadline changes this week', items: changes, moreUrl: more }),
    section({ heading: 'Newly announced', items: announced, moreUrl: more }),
    section({ heading: 'Closing in the next 7 days', items: closing, moreUrl: more }),
    section({ heading: 'Your saved workshops — next deadlines', items: savedNext, moreUrl: `${SITE_ORIGIN}/saved/` }),
  ];

  // Subject drops zero-count clauses rather than saying "0 changes".
  const clauses = [];
  if (changes.length) clauses.push(`${changes.length} deadline change${changes.length === 1 ? '' : 's'}`);
  if (announced.length) clauses.push(`${announced.length} new workshop${announced.length === 1 ? '' : 's'}`);
  if (!clauses.length && closing.length) {
    clauses.push(`${closing.length} deadline${closing.length === 1 ? '' : 's'} closing this week`);
  }
  if (!clauses.length) clauses.push('your saved workshops');
  const subject = `${clauses.join(', ')} in your areas — AI Workshop Tracker`;

  const bodyHtml =
    `<h1 style="margin:0 0 6px;font-size:21px;line-height:1.25;">This week in AI workshops</h1>` +
    `<p style="margin:0;font-size:14px;${MUTED}">Your selection, for the week ending ${esc(fmtUtc(new Date(nowMs).toISOString()).split(',')[0])}.</p>` +
    secs.map((s) => s.html).join('');

  const text =
    `This week in AI workshops\n` +
    `Your selection, for the week ending ${fmtUtc(new Date(nowMs).toISOString()).split(',')[0]}.\n` +
    secs.map((s) => s.text).join('') +
    textFooter({ manageUrl, unsubUrl });

  return { subject, html: shell({ title: subject, bodyHtml, manageUrl, unsubUrl }), text };
}

/* ------------------------------------------------- saved-workshop changes */

/**
 * Same-day mail for the `starred_changes` cadence: a deadline moved on
 * something this subscriber saved.
 *
 * Deliberately narrow. It reports only what changed today on their own saved
 * list — no "closing soon", no new workshops, nothing from the facets. Someone
 * chose this cadence to stop receiving a weekly summary, so padding it out
 * would defeat the point. Returns null when nothing matched, like every other
 * template here.
 *
 * `events` must already be filtered to this subscriber's starred slugs.
 */
export function renderStarredChanges({
  sub,
  tz = sub?.tz ?? null,
  events,
  workshops,
  ids,
  manageUrl = MANAGE_PLACEHOLDER,
  unsubUrl = UNSUB_PLACEHOLDER,
}) {
  const items = events
    .filter((e) => workshops[e.slug])
    .map((e) => changeItem(e, workshops[e.slug], ids, tz));
  if (!items.length) return null;

  const one = items.length === 1;
  const first = workshops[events[0].slug];
  const subject = one
    ? `Deadline update: ${first.acronym || first.name} — AI Workshop Tracker`
    : `${items.length} deadline updates on your saved workshops — AI Workshop Tracker`;

  const sec = section({ heading: one ? 'A workshop you saved changed' : 'Workshops you saved changed', items, moreUrl: `${SITE_ORIGIN}/saved/` });

  const bodyHtml =
    `<h1 style="margin:0 0 6px;font-size:21px;line-height:1.25;">${one ? 'A deadline you follow moved' : 'Deadlines you follow moved'}</h1>` +
    `<p style="margin:0;font-size:14px;${MUTED}">You saved ${one ? 'this workshop' : 'these workshops'} on aiworkshoptracker.com.</p>` +
    sec.html;

  const text =
    `${one ? 'A deadline you follow moved' : 'Deadlines you follow moved'}\n` +
    sec.text +
    textFooter({ manageUrl, unsubUrl });

  return { subject, html: shell({ title: subject, bodyHtml, manageUrl, unsubUrl }), text };
}

/* -------------------------------------------------------------------- urgent */

/**
 * One combined urgent alert covering every imminent saved workshop — one
 * message, never one per workshop. `items` are live projections with a
 * `next_ms`.
 */
export function renderUrgent({
  sub,
  tz = sub?.tz ?? null,
  items,
  nowMs,
  ids,
  manageUrl = MANAGE_PLACEHOLDER,
  unsubUrl = UNSUB_PLACEHOLDER,
}) {
  if (!items.length) return null;
  const sorted = [...items].sort(
    (a, b) => Date.parse(a.next_stage_utc || a.deadline_utc) - Date.parse(b.next_stage_utc || b.deadline_utc),
  );
  const first = sorted[0];
  const firstIso = first.next_stage_utc || first.deadline_utc;
  const h = hoursUntil(firstIso, nowMs);
  const extra = sorted.length > 1 ? ` (+${sorted.length - 1} more)` : '';
  // The acronym, not the full name: subjects are read in a crowded list and
  // a 66-character median name would be truncated away. The body carries it.
  const subject = `⏰ ${h}h left: ${wsTitle(first, ids)}${extra}`;

  const blocks = sorted
    .map((w) => {
      const iso = w.next_stage_utc || w.deadline_utc;
      const stage = w.next_stage_is_abstract ? ' (abstract registration)' : '';
      return {
        html:
          `<div style="margin:0 0 16px;padding:12px 14px;border:1px solid #dfe2e6;border-radius:8px;">` +
          `<a href="${wsUrl(w.slug)}" style="${LINK}font-weight:600;">${esc(wsTitle(w, ids, { full: true }))}</a><br />` +
          `<span style="${MUTED}">${esc(fmtWhen(iso, tz))}${esc(stage)} · in ${hoursUntil(iso, nowMs)}h</span>` +
          (w.website ? `<br /><a href="${esc(w.website)}" style="${LINK}font-size:14px;">Official page</a>` : '') +
          `</div>`,
        text:
          `${wsTitle(w, ids, { full: true })}\n  ${fmtWhen(iso, tz)}${stage} · in ${hoursUntil(iso, nowMs)}h\n  ${wsUrl(w.slug)}` +
          (w.website ? `\n  ${w.website}` : ''),
      };
    });

  const bodyHtml =
    `<h1 style="margin:0 0 6px;font-size:21px;line-height:1.25;">Deadline approaching</h1>` +
    `<p style="margin:0 0 18px;font-size:14px;${MUTED}">You saved ${sorted.length === 1 ? 'this workshop' : 'these workshops'} on aiworkshoptracker.com.</p>` +
    blocks.map((b) => b.html).join('');

  const text =
    `Deadline approaching\n\n` +
    blocks.map((b) => b.text).join('\n\n') +
    '\n' +
    textFooter({ manageUrl, unsubUrl });

  return { subject, html: shell({ title: subject, bodyHtml, manageUrl, unsubUrl }), text };
}

/* ------------------------------------------------------------- transactional */

/**
 * Double opt-in. Transactional, so it carries no unsubscribe link (there is
 * nothing to unsubscribe from until it is clicked) — `showManage:false`.
 */
export function renderConfirm({ confirmUrl }) {
  const subject = 'Confirm your subscription — AI Workshop Tracker';
  const bodyHtml =
    `<h1 style="margin:0 0 12px;font-size:21px;">Confirm your subscription</h1>` +
    `<p style="margin:0 0 18px;">Click below to start receiving the weekly workshop digest. ` +
    `The link expires in 48 hours.</p>` +
    `<p style="margin:0 0 18px;"><a href="${esc(confirmUrl)}" style="display:inline-block;padding:11px 18px;` +
    `background:#0f766e;color:#ffffff;border-radius:7px;text-decoration:none;font-weight:600;">Confirm subscription</a></p>` +
    `<p style="margin:0;font-size:13px;${MUTED}">If you didn't request this, ignore this email — nothing will be sent ` +
    `and the address is deleted automatically once the link expires.</p>` +
    `<p style="margin:14px 0 0;font-size:12.5px;word-break:break-all;${MUTED}">${esc(confirmUrl)}</p>`;
  const text =
    `Confirm your subscription\n\n` +
    `Click to start receiving the weekly AI Workshop Tracker digest (link expires in 48 hours):\n${confirmUrl}\n\n` +
    `If you didn't request this, ignore this email.\n` +
    textFooter({ manageUrl: '', unsubUrl: '', showManage: false });
  return { subject, html: shell({ title: subject, bodyHtml, showManage: false }), text };
}

/** Passwordless sign-in for the manage page. Also transactional. */
export function renderMagic({ magicUrl }) {
  const subject = 'Your sign-in link — AI Workshop Tracker';
  const bodyHtml =
    `<h1 style="margin:0 0 12px;font-size:21px;">Your sign-in link</h1>` +
    `<p style="margin:0 0 18px;">Opens your saved workshops on this device, and links it so the ` +
    `list stays in step. This link expires in 15 minutes and can be used once.</p>` +
    `<p style="margin:0 0 18px;"><a href="${esc(magicUrl)}" style="display:inline-block;padding:11px 18px;` +
    `background:#0f766e;color:#ffffff;border-radius:7px;text-decoration:none;font-weight:600;">Open my saved list</a></p>` +
    `<p style="margin:0;font-size:13px;${MUTED}">If you didn't request this, ignore it — no change has been made.</p>` +
    `<p style="margin:14px 0 0;font-size:12.5px;word-break:break-all;${MUTED}">${esc(magicUrl)}</p>`;
  const text =
    `Your sign-in link\n\n${magicUrl}\n\n` +
    `Expires in 15 minutes, usable once. If you didn't request this, ignore it.\n` +
    textFooter({ manageUrl: '', unsubUrl: '', showManage: false });
  return { subject, html: shell({ title: subject, bodyHtml, showManage: false }), text };
}

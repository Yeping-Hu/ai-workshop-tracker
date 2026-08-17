/**
 * The maintainer's dashboard, rendered server-side as one self-contained page.
 *
 * Self-contained is not a style choice. The page sits behind Cloudflare Access
 * and shows aggregate subscriber data, so it must not fetch a chart library, a
 * font or an icon from anywhere — every external request is a third party being
 * told, by referer and by timing, that this page exists and when it is read.
 * So: no <script>, no <link>, no images. Bars and sparklines are SVG and CSS.
 *
 * There is no client-side JavaScript at all. Nothing here needs it, and its
 * absence means the page cannot leak on a device with a compromised extension
 * any more than the HTML it already sent.
 *
 * Palette and fonts are lifted from site/src/styles/global.css so this looks
 * like the project rather than like a different product. It follows the
 * viewer's system theme; there is no toggle, because a toggle needs either
 * script or storage and this page should have neither.
 */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const n = (v) => Number(v ?? 0).toLocaleString('en-US');

/**
 * A labelled bar per row.
 *
 * The name sits *above* its bar rather than beside it. Side-by-side needs a
 * fixed label column, and the things being labelled here are workshop paths —
 * `/workshop/neurips-2026-mlforsys` — which truncated to "/works…" in every
 * row, so the list showed eight bars and no way to tell them apart. Stacking
 * gives the name the full card width and lets it wrap.
 */
function bars(rows, { label = 'name', value = 'n', empty = 'nothing yet' } = {}) {
  const list = (rows ?? []).filter((r) => r);
  if (!list.length) return `<p class="empty">${esc(empty)}</p>`;
  const max = Math.max(...list.map((r) => Number(r[value]) || 0), 1);
  return `<ul class="bars">${list
    .map((r) => {
      const v = Number(r[value]) || 0;
      const pct = Math.max((v / max) * 100, v > 0 ? 2 : 0);
      return `<li>
        <div class="bar-top"><span class="bar-name">${esc(r[label])}</span><span class="bar-val">${n(v)}</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
      </li>`;
    })
    .join('')}</ul>`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "2026-08-16" -> "Aug 16", by string surgery rather than Date parsing.
 * `new Date('2026-08-16')` is UTC midnight, which in the Americas renders as
 * the 15th — a chart silently one day out is worse than no chart.
 */
const shortDay = (iso) => {
  const [, m, d] = String(iso ?? '').split('-');
  const name = MONTHS[Number(m) - 1];
  return name ? `${name} ${Number(d)}` : String(iso ?? '');
};

/**
 * A daily chart with dated axis labels and a hover readout per day.
 *
 * **The hover is CSS, not JavaScript.** Each day gets a full-height transparent
 * rect; `:hover` on that group reveals a crosshair, a dot and a label. This
 * page deliberately ships no script — see the note at the top of the file —
 * and a tooltip is not worth giving that up for.
 *
 * The viewBox scales uniformly rather than with `preserveAspectRatio="none"`.
 * The old sparkline stretched to fit, which is fine for a bare line and
 * impossible once there is text: non-uniform scaling distorts glyphs. So the
 * geometry is in a fixed 1000-unit space and the whole thing scales as a unit.
 */
function sparkline(series, { unit = '' } = {}) {
  const pts = (series ?? []).map((d) => ({ day: String(d.day ?? ''), n: Number(d.n) || 0 }));
  if (pts.length < 2) return `<p class="empty">not enough days yet</p>`;

  // PT reserves a band above the plot for the hover readout. It has to clear
  // the largest font the readout ever uses — on a narrow screen that is ~42
  // user units — or the text renders above y=0 and the SVG clips it away.
  const W = 1000, H = 220, PL = 12, PR = 12, PT = 46, PB = 34;
  const plotW = W - PL - PR;
  const plotH = H - PT - PB;
  const last = pts.length - 1;
  const max = Math.max(...pts.map((p) => p.n), 1);
  const x = (i) => PL + (i / last) * plotW;
  const y = (v) => PT + plotH - (v / max) * plotH;
  const step = plotW / last;
  const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.n).toFixed(1)}`).join(' ');
  const total = pts.reduce((a, b) => a + b.n, 0);

  // Four dates: both ends plus two inside. Every label would collide at 30 days.
  const ticks = [...new Set([0, Math.round(last / 3), Math.round((2 * last) / 3), last])]
    .map((i) => {
      const anchor = i === 0 ? 'start' : i === last ? 'end' : 'middle';
      return `<text class="ax" x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="${anchor}">${esc(shortDay(pts[i].day))}</text>`;
    })
    .join('');

  // The readout is anchored away from whichever edge it is near, so the first
  // and last days do not render their label off the side of the chart.
  const cols = pts
    .map((p, i) => {
      const cx = x(i);
      const near = i <= 1 ? 'start' : i >= last - 1 ? 'end' : 'middle';
      const lx = near === 'start' ? cx - 4 : near === 'end' ? cx + 4 : cx;
      return `<g class="col">
      <rect x="${(cx - step / 2).toFixed(1)}" y="0" width="${step.toFixed(1)}" height="${H}" fill="transparent"></rect>
      <line class="cross" x1="${cx.toFixed(1)}" y1="${PT}" x2="${cx.toFixed(1)}" y2="${(PT + plotH).toFixed(1)}"></line>
      <circle class="dot" cx="${cx.toFixed(1)}" cy="${y(p.n).toFixed(1)}" r="6"></circle>
      <text class="tip" x="${lx.toFixed(1)}" y="34" text-anchor="${near}">${esc(shortDay(p.day))} · ${n(p.n)}</text>
    </g>`;
    })
    .join('');

  return `
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
         aria-label="${n(total)}${unit ? ` ${esc(unit)}` : ''} over ${pts.length} days, peak ${n(max)} in a day">
      <polygon points="${PL},${(PT + plotH).toFixed(1)} ${line} ${(PL + plotW).toFixed(1)},${(PT + plotH).toFixed(1)}"
               fill="var(--accent-soft)"></polygon>
      <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"></polyline>
      ${ticks}${cols}
    </svg>`;
}

function trafficSection(t) {
  if (!t || t.error) {
    const why =
      t?.error === 'not_configured'
        ? 'GoatCounter is not connected yet — set GOATCOUNTER_TOKEN and GOATCOUNTER_SITE.'
        : 'GoatCounter did not answer. The subscriber figures above are unaffected.';
    return `<section class="card span-all">
        <h2>Traffic</h2>
        <p class="empty">${esc(why)}</p>
      </section>`;
  }
  return `
    <section class="card span-all">
      <h2>Traffic <span class="sub">last 30 days</span></h2>
      <div class="big">${n(t.total)} <span class="big-unit">pageviews</span></div>
      ${sparkline(t.by_day, { unit: 'pageviews' })}
    </section>
    <section class="card">
      <h2>Top pages</h2>
      ${bars(t.pages, { label: 'path', empty: 'no pageviews recorded yet' })}
    </section>
    <section class="card">
      <h2>Where visitors are</h2>
      ${bars(t.locations, { empty: 'no locations recorded yet' })}
    </section>
    <section class="card">
      <h2>Referrers</h2>
      ${bars(t.referrers, { empty: 'no referrers recorded yet' })}
    </section>`;
}

export function renderDashboard(stats) {
  const t = stats.totals ?? {};
  const c = stats.cadence ?? {};
  const attention = (t.pending ?? 0) > 0 || (t.suppressed ?? 0) > 0;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Alerts dashboard · AI Workshop Tracker</title>
<style>
  :root {
    --paper:#f8f9f7; --surface:#ffffff; --ink:#161a16; --muted:#5a6258; --line:#e2e5df;
    --accent:#1e5c45; --accent-soft:#e5f0ea; --urgent:#b3261e; --warn:#9a6700;
    --shadow:0 1px 2px rgb(22 26 22 / .06), 0 4px 14px rgb(22 26 22 / .05);
    --font-display:'Iowan Old Style','Palatino Linotype',Palatino,Georgia,'Times New Roman',serif;
    --font-body:system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
    --font-mono:ui-monospace,'SF Mono','Cascadia Mono',Menlo,Consolas,monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper:#121511; --surface:#1a1e19; --ink:#eceee8; --muted:#9aa294; --line:#2a2f28;
      --accent:#6fbf9b; --accent-soft:#1e3329; --urgent:#f2766b; --warn:#e2b93b; --shadow:none;
    }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--font-body);
       font-size:16px;line-height:1.5;-webkit-text-size-adjust:100%}
  .wrap{max-width:64rem;margin:0 auto;padding:2rem 1.1rem 4rem}
  header{margin-bottom:1.6rem}
  .eyebrow{font-family:var(--font-mono);font-size:.72rem;letter-spacing:.12em;text-transform:uppercase;
           color:var(--accent);margin:0 0 .3rem}
  h1{font-family:var(--font-display);font-size:1.9rem;font-weight:600;margin:0;letter-spacing:-.01em}
  .stamp{color:var(--muted);font-size:.82rem;margin:.35rem 0 0}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:1rem}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:10px;
        padding:1.1rem 1.2rem;box-shadow:var(--shadow);min-width:0}
  .span-all{grid-column:1/-1}
  h2{font-family:var(--font-display);font-size:1.02rem;font-weight:600;margin:0 0 .85rem;
     display:flex;align-items:baseline;gap:.5rem}
  .sub{font-family:var(--font-body);font-size:.75rem;font-weight:400;color:var(--muted)}
  .big{font-size:2.6rem;font-weight:600;letter-spacing:-.03em;line-height:1.05;
       font-variant-numeric:tabular-nums}
  .big-unit{font-size:.85rem;font-weight:400;color:var(--muted);letter-spacing:0}
  .hero{border-color:var(--accent);background:linear-gradient(180deg,var(--accent-soft),var(--surface) 60%)}
  dl{margin:0;display:grid;grid-template-columns:1fr auto;gap:.42rem .8rem}
  dt{color:var(--muted);font-size:.88rem;min-width:0}
  dd{margin:0;text-align:right;font-variant-numeric:tabular-nums;font-weight:600}
  dd.zero{font-weight:400;color:var(--muted)}
  dd.flag{color:var(--warn)}
  /* Name above its bar, so a long workshop path is readable in full. */
  .bars{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.7rem}
  .bar-top{display:flex;justify-content:space-between;align-items:baseline;gap:.7rem;margin-bottom:.25rem}
  .bar-name{font-size:.85rem;color:var(--muted);min-width:0;overflow-wrap:anywhere;line-height:1.35}
  .bar-val{font-size:.85rem;font-variant-numeric:tabular-nums;font-weight:600;flex:none}
  .bar-track{background:var(--accent-soft);border-radius:99px;height:.5rem;overflow:hidden}
  .bar-fill{background:var(--accent);height:100%;border-radius:99px}

  /* Charts. The hover readout is pure CSS — this page ships no JavaScript. */
  .chart{width:100%;height:auto;display:block;margin-top:.4rem}
  /* Text inside the SVG scales with the card, so one size cannot serve both:
     the chart is ~985px wide on a desktop and ~330px on a phone, and a value
     that reads well at one is nearly 3x wrong at the other. Hence the two
     sets — these are user units, not rendered pixels. */
  .chart .ax{font-size:15px;fill:var(--muted);font-family:var(--font-body)}
  .chart .cross{stroke:var(--accent);stroke-width:2;stroke-dasharray:5 5;opacity:0}
  .chart .dot{fill:var(--accent);stroke:var(--surface);stroke-width:3;opacity:0}
  .chart .tip{font-size:20px;font-weight:600;fill:var(--ink);font-family:var(--font-body);opacity:0}
  @media (max-width:44rem){
    .chart .ax{font-size:34px}
    .chart .tip{font-size:42px}
    .chart .cross{stroke-width:4}
    .chart .dot{stroke-width:6}
  }
  .chart .col:hover .cross,.chart .col:hover .dot,.chart .col:hover .tip{opacity:1}
  @media (hover:none){
    /* No pointer to hover with: show the endpoint so the chart still has an
       anchor, rather than leaving a readout nobody can reach. */
    .chart .col:last-of-type .dot{opacity:1}
  }
  .empty{color:var(--muted);font-size:.88rem;margin:.2rem 0 0}
  footer{margin-top:2rem;color:var(--muted);font-size:.78rem;line-height:1.65}
  code{font-family:var(--font-mono);font-size:.85em}
  @media (max-width:30rem){ .wrap{padding-top:1.3rem} .big{font-size:2.1rem} }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <p class="eyebrow">AI Workshop Tracker</p>
    <h1>Alerts dashboard</h1>
    <p class="stamp">Generated ${esc(stats.generated_at)} · last ${n(stats.days)} days</p>
  </header>

  <div class="grid">
    <section class="card hero">
      <h2>Mailable <span class="sub">receive anything at all</span></h2>
      <div class="big">${n(t.mailable)}</div>
    </section>

    <section class="card">
      <h2>The list</h2>
      <dl>
        <dt>Confirmed</dt><dd>${n(t.confirmed)}</dd>
        <dt>Awaiting confirmation</dt><dd class="${t.pending ? 'flag' : 'zero'}">${n(t.pending)}</dd>
        <dt>Suppressed</dt><dd class="${t.suppressed ? 'flag' : 'zero'}">${n(t.suppressed)}</dd>
        <dt>Paused</dt><dd class="${t.paused ? '' : 'zero'}">${n(t.paused)}</dd>
        <dt>Total rows</dt><dd>${n(t.total)}</dd>
      </dl>
    </section>

    <section class="card">
      <h2>What they chose</h2>
      <dl>
        <dt>Weekly digest</dt><dd class="${c.weekly ? '' : 'zero'}">${n(c.weekly)}</dd>
        <dt>72h deadline alert</dt><dd class="${c.urgent ? '' : 'zero'}">${n(c.urgent)}</dd>
        <dt>Deadline changed</dt><dd class="${c.changes ? '' : 'zero'}">${n(c.changes)}</dd>
        <dt>Saved workshops only</dt><dd class="${t.saved_only ? '' : 'zero'}">${n(t.saved_only)}</dd>
      </dl>
    </section>

    <section class="card span-all">
      <h2>Signups <span class="sub">${n(stats.recent_signups)} in the last ${n(stats.days)} days</span></h2>
      ${sparkline(stats.by_day, { unit: 'signups' })}
    </section>

    <section class="card">
      <h2>Where subscribers are</h2>
      ${bars(stats.regions, { label: 'region', empty: 'no confirmed subscribers yet' })}
      <p class="empty">From the timezone the browser reported at signup. No IP lookup.</p>
    </section>

    ${trafficSection(stats.traffic)}
  </div>

  <footer>
    Aggregates only — no address is read by anything on this page, and the queries
    behind it cannot return one. For individual records use
    <code>node scripts/alerts_stats.mjs</code> or query D1 directly.<br>
    ${attention ? 'Pending or suppressed rows are highlighted above. ' : ''}Traffic is cached for 15 minutes.
  </footer>
</div>
</body>
</html>`;
}

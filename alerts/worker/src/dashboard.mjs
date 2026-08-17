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

/** A horizontal bar row: label, proportional bar, count. */
function bars(rows, { label = 'name', value = 'n', empty = 'nothing yet' } = {}) {
  const list = (rows ?? []).filter((r) => r);
  if (!list.length) return `<p class="empty">${esc(empty)}</p>`;
  const max = Math.max(...list.map((r) => Number(r[value]) || 0), 1);
  return `<div class="bars">${list
    .map((r) => {
      const v = Number(r[value]) || 0;
      const pct = Math.max((v / max) * 100, v > 0 ? 2 : 0);
      return `<div class="bar-label" title="${esc(r[label])}">${esc(r[label])}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
        <div class="bar-val">${n(v)}</div>`;
    })
    .join('')}</div>`;
}

/**
 * A sparkline over daily counts.
 *
 * Drawn as a filled area plus a line, with the last point marked — an endpoint
 * dot is what turns "a shape" into "and here is where you are now".
 */
function sparkline(series, { height = 56 } = {}) {
  const pts = (series ?? []).map((d) => Number(d.n) || 0);
  if (pts.length < 2) return `<p class="empty">not enough days yet</p>`;
  const max = Math.max(...pts, 1);
  const W = 100;
  const H = height;
  const step = W / (pts.length - 1);
  const y = (v) => H - 4 - (v / max) * (H - 10);
  const line = pts.map((v, i) => `${(i * step).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
  const lastX = ((pts.length - 1) * step).toFixed(2);
  const lastY = y(pts[pts.length - 1]).toFixed(2);
  const total = pts.reduce((a, b) => a + b, 0);
  return `
    <svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
         aria-label="${n(total)} over the last ${pts.length} days, peak ${n(max)} in a day">
      <polygon points="0,${H} ${line} ${lastX},${H}" fill="var(--accent-soft)"></polygon>
      <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="1.5"
                vector-effect="non-scaling-stroke" stroke-linejoin="round"></polyline>
      <circle cx="${lastX}" cy="${lastY}" r="2" fill="var(--accent)" vector-effect="non-scaling-stroke"></circle>
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
      ${sparkline(t.by_day, { height: 64 })}
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
  .bars{display:grid;grid-template-columns:minmax(0,1fr) 3.2fr auto;gap:.4rem .6rem;align-items:center}
  .bar-label{font-size:.85rem;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bar-track{background:var(--accent-soft);border-radius:99px;height:.55rem;overflow:hidden}
  .bar-fill{background:var(--accent);height:100%;border-radius:99px}
  .bar-val{font-size:.85rem;font-variant-numeric:tabular-nums;font-weight:600}
  .spark{width:100%;height:4rem;display:block;margin-top:.5rem;overflow:visible}
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
      ${sparkline(stats.by_day)}
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

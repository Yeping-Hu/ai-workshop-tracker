/**
 * Where workshops are going: topic share per year, across every conference.
 *
 * Researchers ask "is my area growing?" and the corpus can answer it in one
 * picture. Two decisions shape the numbers:
 *
 *   - **Share, not count.** Coverage grew every year (164 → 260 → 514 editions
 *     for 2024–2026 at the time of writing), so raw counts would show every
 *     topic "tripling". Share of that year's editions cancels the coverage
 *     effect; the table beside the chart shows both so nothing is hidden.
 *   - **Topics are multi-label** (one to five per workshop), so a workshop
 *     counts once per topic and rows do not sum to the year's total. Said in
 *     the page's footnote rather than normalised away.
 *
 * `other` is excluded (it is the importer's "could not tell", not a field) and
 * so are `not_running` editions. Rows are the top N topics by latest-year
 * count, ties broken by label, so the chart stays legible at eight rows while
 * the table can carry the rest.
 *
 * `barLayout()` returns plain geometry for a horizontal grouped bar chart —
 * one row per topic, one bar per year — so the page can emit inline SVG at
 * build with no client script. Single hue at three opacities: the site's
 * palette is one accent plus one urgency colour, and a legend of eight hues
 * would fight it.
 *
 * Pinned by scripts/trends_test.mjs.
 */

/**
 * @param {Array} workshops resolved entries (loadWorkshops())
 * @param {Array<{id: string, label: string}>} topics data/topics.yml
 * @param {{ topN?: number, exclude?: string[] }} opts
 * @returns {{ years: number[], totals: Record<number, number>,
 *             rows: Array<{ id: string, label: string, counts: Record<number, number>, shares: Record<number, number> }>,
 *             rest: { label: string, counts: Record<number, number>, ids: string[] } }}
 */
export function topicTrends(workshops, topics, { topN = 8, exclude = ['other'] } = {}) {
  const list = (Array.isArray(workshops) ? workshops : []).filter(
    (w) => w && w.status !== 'not_running' && Number.isInteger(w.year),
  );
  const labelOf = new Map((topics ?? []).map((t) => [t.id, t.label]));
  const skip = new Set(exclude);

  const years = [...new Set(list.map((w) => w.year))].sort((a, b) => a - b);
  const totals = Object.fromEntries(years.map((y) => [y, 0]));
  const counts = new Map(); // topic id -> {year: n}
  for (const w of list) {
    totals[w.year]++;
    for (const id of new Set(w.topics ?? [])) {
      if (skip.has(id) || !labelOf.has(id)) continue;
      if (!counts.has(id)) counts.set(id, Object.fromEntries(years.map((y) => [y, 0])));
      counts.get(id)[w.year]++;
    }
  }

  const latest = years[years.length - 1];
  const ranked = [...counts.entries()].sort(
    (a, b) => (b[1][latest] ?? 0) - (a[1][latest] ?? 0) || labelOf.get(a[0]).localeCompare(labelOf.get(b[0])),
  );
  const rows = ranked.slice(0, topN).map(([id, c]) => ({
    id,
    label: labelOf.get(id),
    counts: c,
    shares: Object.fromEntries(years.map((y) => [y, totals[y] ? c[y] / totals[y] : 0])),
  }));
  const restIds = ranked.slice(topN).map(([id]) => id);
  const rest = {
    label: 'All other topics',
    ids: restIds,
    counts: Object.fromEntries(years.map((y) => [y, restIds.reduce((n, id) => n + counts.get(id)[y], 0)])),
  };
  return { years, totals, rows, rest };
}

/**
 * Geometry for a horizontal grouped bar chart. Values are shares in [0, 1];
 * the widest bar spans the plot. Opacity steps from faint (oldest year) to
 * full (latest), so the eye reads "then → now" without a legend.
 */
export function barLayout(trends, { width = 480, labelWidth = 150, rowGap = 10, barH = 9, barGap = 2, valueWidth = 44, padTop = 6 } = {}) {
  const years = trends.years;
  const rows = trends.rows;
  const plotX = labelWidth;
  const plotW = Math.max(1, width - labelWidth - valueWidth);
  const max = Math.max(0, ...rows.flatMap((r) => years.map((y) => r.shares[y] ?? 0)));
  const groupH = years.length * barH + Math.max(0, years.length - 1) * barGap;
  const rowH = groupH + rowGap;
  const opacity = (i) => (years.length === 1 ? 1 : 0.3 + (0.7 * i) / (years.length - 1));
  const out = rows.map((r, ri) => {
    const y0 = padTop + ri * rowH;
    return {
      id: r.id,
      label: r.label,
      y: y0,
      labelY: y0 + groupH / 2,
      bars: years.map((year, yi) => {
        const share = r.shares[year] ?? 0;
        const w = max > 0 ? (share / max) * plotW : 0;
        return {
          year,
          share,
          count: r.counts[year] ?? 0,
          x: plotX,
          y: y0 + yi * (barH + barGap),
          width: Math.round(w * 100) / 100,
          height: barH,
          opacity: Math.round(opacity(yi) * 100) / 100,
          valueX: plotX + w + 4,
          pct: Math.round(share * 100),
        };
      }),
    };
  });
  return {
    width,
    height: padTop + rows.length * rowH,
    plotX,
    plotW,
    barH,
    rowH,
    years: years.map((year, yi) => ({ year, opacity: Math.round(opacity(yi) * 100) / 100 })),
    rows: out,
  };
}

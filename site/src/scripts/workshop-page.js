/**
 * Workshop-page behaviour that is not part of the shared row (ws-row.js):
 * usage events for the extension-insight line, and — as they land — the
 * time-zone explainer and "Surprise me". One module so the page loads one
 * script; each feature is a few lines guarded on its element existing, so a
 * page without the feature does nothing.
 *
 * Events go through favorites.js's track() — the single helper, so the
 * vocabulary stays in one place (docs/ARCHITECTURE.md, pinned by
 * scripts/analytics_events_test.mjs). Importing it here is deduplicated by the
 * bundler; the module guards its own one-time init.
 */
import { track } from './favorites.js';
import { pickIndex } from '../../../lib/surprise.mjs';

// Extension insight (lib/extensions.mjs): the line is server-rendered; all
// this records is that a page carrying one was opened, and which rule spoke.
const insight = document.querySelector('.ext-insight');
if (insight) track('insight/extension', insight.dataset.insight || '');

// Time-zone explainer: the clocks are ticked by board.js; all this records is
// that someone opened it, once per page, so the dashboard can say whether the
// 11:59 UTC confusion is real.
const tzHelp = document.querySelector('.tz-help');
if (tzHelp) {
  let opened = false;
  tzHelp.addEventListener('toggle', () => {
    if (tzHelp.open && !opened) {
      opened = true;
      track('delight/aoe-open', tzHelp.dataset.slug || '');
    }
  });
}

// "Surprise me" (lib/surprise.mjs): the pool is the titles already on this
// page, or the previous edition's list embedded at build. Never the same
// paper twice in a row; one event per page, on the first click.
const surpriseBtn = document.querySelector('[data-surprise]');
if (surpriseBtn) {
  const out = surpriseBtn.closest('.surprise')?.querySelector('.surprise-out');
  let pool = [];
  let label = '';
  if (surpriseBtn.dataset.surprise === 'this') {
    pool = [...document.querySelectorAll('.paper-list .p-title')].map((h) => [h.textContent.trim(), `#${h.id}`]);
  } else {
    try {
      const j = JSON.parse(document.getElementById('awt-surprise')?.textContent || '{}');
      pool = Array.isArray(j.papers) ? j.papers : [];
      label = j.label || '';
    } catch { pool = []; }
  }
  let last = -1;
  let tracked = false;
  surpriseBtn.addEventListener('click', () => {
    if (!pool.length || !out) return;
    const i = pickIndex(pool.length, last);
    last = i;
    const [title, href] = pool[i];
    out.replaceChildren();
    const a = document.createElement('a');
    a.href = href;
    a.textContent = title;
    out.append(a);
    if (label) out.append(` — from ${label}`);
    out.hidden = false;
    if (!tracked) {
      tracked = true;
      track('delight/surprise', document.querySelector('.tz-help')?.dataset.slug || location.pathname);
    }
  });
}

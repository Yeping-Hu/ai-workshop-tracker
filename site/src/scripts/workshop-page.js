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

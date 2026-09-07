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

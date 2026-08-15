/**
 * Shared behaviour for the `<details class="dd">` pickers — the facet bar on the
 * homepage, and the conference/topic pickers in the alerts signup and manage
 * forms.
 *
 * A bare `<details>` only closes when you click its own summary again, which
 * leaves a panel hanging over the page while you interact with something else.
 * Three rules fix that: only one open at a time, a click anywhere outside closes
 * them, and Escape closes them with focus returned to the summary.
 *
 * WHY THE SUMMARY CLICK, NOT THE `toggle` EVENT. `details` fires `toggle`
 * asynchronously, after the browser has already painted the newly-open panel —
 * closing siblings from there left two panels visible for a frame. Acting on the
 * summary's own click happens before that paint.
 *
 * This lives in one file because it previously lived in one page. Copying it
 * into the alerts forms would have made a third copy of shared logic, which is
 * exactly how the upload half of the star merge went missing.
 *
 * Loaded by Base.astro and self-initialising, so any page that renders a
 * `details.dd` gets the behaviour with no per-page wiring. The pages that need
 * it use `is:inline` scripts (they take `define:vars`), which cannot import a
 * module — the same reason favorites.js hangs its entry points off `window`.
 */

/**
 * @param root      element containing the dropdowns (defaults to the document)
 * @param selector  which dropdowns to wire; pass a narrower one to scope a page
 */
export function wireDropdowns(root = document, selector = 'details.dd') {
  const scope = root || document;
  const dds = [...scope.querySelectorAll(selector)];
  if (!dds.length) return () => {};

  const closeAll = (except = null) => {
    for (const d of dds) if (d !== except) d.open = false;
  };

  for (const d of dds) {
    const summary = d.querySelector('summary');
    if (!summary) continue;
    summary.addEventListener('click', () => closeAll(d));
  }

  // Capture nothing special: a click inside one of *these* dropdowns is exempt,
  // anything else — including another dropdown group on the page — closes them.
  const onClick = (e) => {
    if (!dds.some((d) => d.contains(e.target))) closeAll();
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    const open = dds.find((d) => d.open);
    if (!open) return;
    open.open = false;
    open.querySelector('summary')?.focus();
  };

  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);

  // Returned so a caller that re-renders can detach; the page-level callers
  // never need it, since the listeners live as long as the document.
  return () => {
    document.removeEventListener('click', onClick);
    document.removeEventListener('keydown', onKey);
  };
}

// Guarded the same way favorites.js is, so a future double-include cannot
// attach two sets of listeners and close a panel the instant it opens.
if (!window.__awtDropdownsInit) {
  window.__awtDropdownsInit = true;
  // Exposed for anything that injects pickers after first paint.
  window.awtWireDropdowns = wireDropdowns;
  wireDropdowns();
}

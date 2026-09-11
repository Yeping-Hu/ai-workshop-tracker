/**
 * The /tools/ card icons: one SVG per tool at site/src/assets/tools/<slug>.svg,
 * inlined into the index at build time (index.astro reads them with a glob).
 *
 * Inlined rather than served as <img>, because an <img> cannot take the page's
 * colour: the files are drawn in the light theme's accent green, and a fixed
 * #1e5c45 on the dark theme's tile is barely visible. Inline SVG paints with
 * currentColor, so the tile's `color` rule decides, and the dark toggle wins
 * on the index as it does everywhere else.
 *
 * The transform is a rule, not per-icon editing, so a regenerated set drops in
 * unchanged: the files stay exactly as exported. The icons are two-tone, the
 * accent and a paler green. The darkest fill in a file becomes currentColor and
 * every other fill becomes currentColor at 40% opacity, which is the paler tone
 * on the light tile and its counterpart on the dark one. The <title> goes,
 * because the card's own heading says the name and the tile is decorative;
 * width and height go, because CSS sizes the tile.
 *
 * Plain JavaScript on purpose: scripts/tools_registry_test.mjs runs this over
 * every file under node and checks that no fixed colour survives.
 */

/** The paler tone, as a share of the accent. */
export const SECONDARY_OPACITY = 0.4;

/** Relative luminance of a #rgb / #rrggbb hex, 0 (black) to 1 (white). */
function luminance(hex) {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Inline form of one icon file: themed by currentColor, decorative, unsized. */
export function inlineIcon(svg) {
  let s = String(svg ?? '');
  if (!/<svg[\s>]/.test(s)) throw new Error('inlineIcon: not an SVG document');
  s = s.replace(/<title>[\s\S]*?<\/title>/g, '');
  s = s.replace(/<svg\b([^>]*)>/, (_, attrs) => `<svg${attrs.replace(/\s(?:width|height)="[^"]*"/g, '')} aria-hidden="true" focusable="false">`);
  const fills = [...new Set([...s.matchAll(/fill="(#[0-9a-fA-F]{3,8})"/g)].map((m) => m[1].toLowerCase()))];
  if (fills.length) {
    const accent = fills.reduce((a, b) => (luminance(b) < luminance(a) ? b : a));
    s = s.replace(/fill="(#[0-9a-fA-F]{3,8})"/g, (_, hex) =>
      hex.toLowerCase() === accent ? 'fill="currentColor"' : `fill="currentColor" fill-opacity="${SECONDARY_OPACITY}"`);
  }
  return s.trim();
}

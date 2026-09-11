/**
 * Copies the third-party browser bundles the site serves as plain <script>
 * files out of node_modules into public/vendor/, before every `astro dev` and
 * `astro build` (the pre-scripts in package.json).
 *
 * Why a copy rather than an import: MathJax's tex-svg bundle is a 1 MB
 * classic script that configures itself from `window.MathJax` and registers a
 * global; only the two LaTeX image tools need it, and a classic script tag on
 * those pages keeps it out of every other page's JavaScript. public/vendor/ is
 * gitignored, so the repo carries no hand-placed third-party artefact and the
 * version is whatever package.json says.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// The bundle autoloads the less common TeX packages (bm, cancel, color,
// mathtools, ...) from input/tex/extensions/ next to itself, so that
// directory travels with it.
const FILES = [
  ['node_modules/mathjax/es5/tex-svg.js', 'public/vendor/mathjax/tex-svg.js'],
  ['node_modules/mathjax/es5/input/tex/extensions', 'public/vendor/mathjax/input/tex/extensions'],
];

for (const [from, to] of FILES) {
  const src = path.join(here, from);
  const dst = path.join(here, to);
  if (!fs.existsSync(src)) {
    console.error(`vendor.mjs: ${from} is missing; run \`npm ci --prefix site\` first.`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
}
console.log(`vendor.mjs: copied ${FILES.length} file(s) into public/vendor/`);

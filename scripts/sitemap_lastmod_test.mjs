#!/usr/bin/env node
/**
 * The sitemap's <lastmod> is a claim made to a crawler, so it has to be wrong in
 * neither direction. Run: node scripts/sitemap_lastmod_test.mjs
 *
 * Two failure modes, and a test is the only thing that tells them apart, because
 * both produce a sitemap that looks fine:
 *
 *  - Too eager: stamping every URL with the build time. The site rebuilds daily,
 *    so that claims ~900 pages changed every night. A crawler that keeps
 *    refetching pages it finds unchanged learns to discount the field entirely,
 *    and then it is worth nothing when a page really does change.
 *  - Too blind: deriving the date only from fields recorded inside the YAML
 *    (`added`, `deadline_history[].recorded`). That cannot see a name being
 *    corrected, a website being filled in, or a paper list being refetched, so a
 *    genuinely changed page keeps advertising a months-old date.
 *
 * lastDataChange() reads git instead. This test pins the properties that matter
 * rather than specific dates, which change with every commit.
 *
 * The corpus-level assertions run against the built sitemap when one exists
 * (`npm run build --prefix site`), and are skipped with a note otherwise, so
 * this is safe to run on a tree that has never been built.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lastDataChange, loadWorkshops } from '../lib/workshops.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (label, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : `  ${detail}`}`);
};

// --- the derivation --------------------------------------------------------
const map = lastDataChange();
const workshops = loadWorkshops();
const dated = [...map.values()].filter(Boolean);

check('every workshop gets a date', map.size === workshops.length && dated.length === workshops.length,
  `${dated.length} dated of ${workshops.length}`);
check('every date is a valid YYYY-MM-DD', dated.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
  dated.find((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d)) ?? '');
check('no date is in the future', dated.every((d) => d <= new Date().toISOString().slice(0, 10)),
  dated.filter((d) => d > new Date().toISOString().slice(0, 10)).slice(0, 3).join(', '));

// The point of reading git: dates must SPREAD. One value for everything is the
// build-stamp failure mode, whatever produced it.
const distinct = new Set(dated).size;
check('dates spread across many days, not one build stamp', distinct >= 5, `${distinct} distinct date(s)`);
const commonest = Math.max(...Object.values(dated.reduce((a, d) => ((a[d] = (a[d] ?? 0) + 1), a), {})));
check('no single date covers the whole corpus', commonest < dated.length,
  `${commonest}/${dated.length} share one date`);

// The date must be at least as recent as anything recorded inside the YAML —
// git sees the commit that wrote those fields, so it can never be older.
let older = 0;
for (const w of workshops) {
  const inYaml = [w.added, ...(w.deadline_history ?? []).map((h) => h.recorded)]
    .filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .pop();
  if (inYaml && map.get(w.slug) && map.get(w.slug) < inYaml) older++;
}
check('git date is never older than the dates inside the YAML', older === 0, `${older} entrie(s) older`);

// --- the built sitemap, when there is one ----------------------------------
const smPath = path.join(ROOT, 'site', 'dist', 'sitemap-0.xml');
if (!fs.existsSync(smPath)) {
  console.log('… site/dist/sitemap-0.xml not built — skipping the rendered-output checks');
} else {
  const xml = fs.readFileSync(smPath, 'utf8');
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const mods = [...xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]);
  check('every URL in the sitemap carries a lastmod', locs.length > 0 && locs.length === mods.length,
    `${locs.length} urls, ${mods.length} lastmod`);
  const smDistinct = new Set(mods.map((d) => d.slice(0, 10))).size;
  check('the built sitemap also spreads its dates', smDistinct >= 5, `${smDistinct} distinct`);

  // Spot-check that a workshop URL carries ITS date, not the build date.
  const sample = workshops.find((w) => map.get(w.slug) && map.get(w.slug) !== new Date().toISOString().slice(0, 10));
  if (sample) {
    const re = new RegExp(`<loc>[^<]*/workshop/${sample.slug}/?</loc><lastmod>([^<]+)</lastmod>`);
    const got = re.exec(xml)?.[1]?.slice(0, 10);
    check(`a workshop URL carries its own date (${sample.slug})`, got === map.get(sample.slug),
      `sitemap ${got} vs derivation ${map.get(sample.slug)}`);
  }
}

console.log(failed ? `\n${failed} check(s) failed` : '\nSitemap lastmod is honest in both directions');
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
/**
 * The rules every /tools/ page lives by, checked against the registry
 * (site/src/lib/tools.mjs) and the pages directory:
 *
 *   - the keyword is in the <title>, the meta description and the H1;
 *   - title and description fit what a search result shows;
 *   - the copy carries no em dashes (the SEO brief's one typographic rule);
 *   - each page has a how-to, a why, and a FAQ of real questions;
 *   - every registry entry has a page file and every page file an entry;
 *   - slugs, titles and descriptions are unique; related links resolve.
 *
 * Why a test rather than a checklist: seventeen pages were written in one
 * sitting, and the eighteenth will be written by someone who has not read
 * the brief.
 *
 * Run: node scripts/tools_registry_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS, GROUPS, toolBySlug, toolsByGroup } from '../site/src/lib/tools.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = path.join(ROOT, 'site', 'src', 'pages', 'tools');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ''}`); }
}

const has = (hay, needle) => String(hay).toLowerCase().includes(String(needle).toLowerCase());
const copyOf = (t) => [t.title, t.description, t.h1, t.lede, ...t.howTo, ...t.why, ...t.faqs.flatMap((f) => [f.q, f.a])].join('\n');

console.log(`— ${TOOLS.length} tools —`);
check('at least the researched set is present', TOOLS.length >= 17, String(TOOLS.length));

for (const t of TOOLS) {
  const label = t.slug;
  check(`${label}: slug is kebab-case`, /^[a-z0-9]+(-[a-z0-9]+)*$/.test(t.slug));
  check(`${label}: group is known`, Object.hasOwn(GROUPS, t.group), t.group);
  check(`${label}: keyword in title`, has(t.title, t.keyword), `${t.keyword} / ${t.title}`);
  check(`${label}: keyword in description`, has(t.description, t.keyword), `${t.keyword} / ${t.description}`);
  check(`${label}: keyword in H1`, has(t.h1, t.keyword), `${t.keyword} / ${t.h1}`);
  check(`${label}: title fits a result (<= 75 chars)`, t.title.length <= 75, `${t.title.length}: ${t.title}`);
  check(`${label}: description fits a snippet (90 to 170 chars)`, t.description.length >= 90 && t.description.length <= 170, `${t.description.length}: ${t.description}`);
  check(`${label}: no em dashes in copy`, !copyOf(t).includes('—'));
  check(`${label}: how-to has 2 to 5 steps`, t.howTo.length >= 2 && t.howTo.length <= 5);
  check(`${label}: why has 1 to 3 paragraphs`, t.why.length >= 1 && t.why.length <= 3);
  check(`${label}: FAQ has 3 to 6 questions ending in "?"`, t.faqs.length >= 3 && t.faqs.length <= 6 && t.faqs.every((f) => f.q.trim().endsWith('?') && f.a.trim().length > 40), t.faqs.map((f) => f.q).join(' | '));
  check(`${label}: related links resolve and exclude itself`, t.related.length >= 2 && t.related.every((s) => s !== t.slug && toolBySlug(s)));
  check(`${label}: page file exists`, fs.existsSync(path.join(PAGES, `${t.slug}.astro`)));
  const page = fs.existsSync(path.join(PAGES, `${t.slug}.astro`)) ? fs.readFileSync(path.join(PAGES, `${t.slug}.astro`), 'utf8') : '';
  check(`${label}: page uses ToolPage with its own slug`, page.includes(`<ToolPage slug="${t.slug}">`));
}

console.log('— cross-checks —');
const slugs = TOOLS.map((t) => t.slug);
check('slugs unique', new Set(slugs).size === slugs.length);
check('titles unique', new Set(TOOLS.map((t) => t.title)).size === TOOLS.length);
check('descriptions unique', new Set(TOOLS.map((t) => t.description)).size === TOOLS.length);
check('H1s unique', new Set(TOOLS.map((t) => t.h1)).size === TOOLS.length);
const pageFiles = fs.readdirSync(PAGES).filter((f) => f.endsWith('.astro') && f !== 'index.astro').map((f) => f.replace(/\.astro$/, ''));
const orphans = pageFiles.filter((f) => !toolBySlug(f));
check('every page file has a registry entry', orphans.length === 0, orphans.join(', '));
check('the index page exists', fs.existsSync(path.join(PAGES, 'index.astro')));
check('every group has at least one tool', toolsByGroup().every((g) => g.tools.length > 0));
check('the index lists every tool (it iterates the registry)', fs.readFileSync(path.join(PAGES, 'index.astro'), 'utf8').includes('toolsByGroup()'));
check('the Tools nav entry exists in Base.astro', fs.readFileSync(path.join(ROOT, 'site/src/components/Base.astro'), 'utf8').includes("{ label: 'Tools', path: '/tools/' }"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

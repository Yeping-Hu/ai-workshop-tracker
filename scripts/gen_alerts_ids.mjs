#!/usr/bin/env node
/**
 * Generate alerts/ids.json — the conference and topic vocabulary, frozen at
 * build time for the Worker.
 *
 * Why a generated file rather than reading the YAML: the Worker cannot see
 * data/*.yml at runtime (it is not deployed with the repo), but it must still
 * reject a `conferences`/`topics` payload containing ids that don't exist,
 * or a bot could stuff arbitrary strings into every subscriber row. Bundling
 * the vocabulary gives the Worker an allowlist with no runtime dependency.
 *
 * Labels ride along because the digest needs them twice: to name a conference
 * in an email, and to build "and N more →" links — the site's URL facets carry
 * **display labels**, not ids (see the FACETS handling in index.astro).
 *
 * Run:   node scripts/gen_alerts_ids.mjs
 * Check: node scripts/gen_alerts_ids.mjs --check   (CI — fails on drift)
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConferences, loadTopics, REPO_ROOT } from '../lib/workshops.mjs';

const OUT = path.join(REPO_ROOT, 'alerts', 'ids.json');

const payload = {
  _generated_by: 'scripts/gen_alerts_ids.mjs — do not edit by hand',
  conferences: loadConferences().map((c) => ({ id: c.id, label: c.name, full_name: c.full_name ?? null })),
  topics: loadTopics().map((t) => ({ id: t.id, label: t.label })),
};

const json = JSON.stringify(payload, null, 2) + '\n';

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current === json) {
    console.log(`✓ alerts/ids.json matches data/ (${payload.conferences.length} conferences, ${payload.topics.length} topics)`);
    process.exit(0);
  }
  console.log('✗ alerts/ids.json is out of sync with data/conferences.yml + data/topics.yml');
  console.log('  Run: node scripts/gen_alerts_ids.mjs');
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, json);
console.log(`Wrote alerts/ids.json — ${payload.conferences.length} conferences, ${payload.topics.length} topics.`);

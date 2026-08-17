#!/usr/bin/env node
/**
 * Keeps the "Topics" checkbox list in the issue forms in sync with the
 * controlled vocabulary in data/topics.yml. GitHub issue templates are static
 * YAML and can't read topics.yml at render time, so the option list is written
 * into both templates between marker comments. Run this whenever you add or
 * remove a topic; the topic_options_sync_test guard fails CI if a template
 * drifts out of sync.
 *
 *   node scripts/gen_topic_options.mjs           # rewrite both templates
 *
 * Exports the pieces the sync test reuses so the "expected" output is computed
 * the same way it's written.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTopics } from '../lib/workshops.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDENT = '        '; // 8 spaces: the option list lives under `      options:`
export const MARKER_START = 'topic-options:start';
export const MARKER_END = 'topic-options:end';

export const TEMPLATES = [
  path.join(ROOT, '.github', 'ISSUE_TEMPLATE', 'add-workshop.yml'),
  path.join(ROOT, '.github', 'ISSUE_TEMPLATE', 'edit-workshop.yml'),
];

/**
 * The exact lines that belong between the markers: one `- label: <id>` per
 * topic.
 *
 * `label:` because the field is a `checkboxes`, whose options are mappings; a
 * `dropdown`'s were bare scalars. The forms switched on 2026-08-17 — a GitHub
 * multi-select dropdown closes after every pick, so choosing five topics meant
 * reopening the list five times.
 */
export function topicOptionLines() {
  return loadTopics().map((t) => `${INDENT}- label: ${t.id}`);
}

/** Lines strictly between the start and end markers, or null if missing. */
export function extractBetweenMarkers(content) {
  const lines = content.split('\n');
  const start = lines.findIndex((l) => l.includes(MARKER_START));
  const end = lines.findIndex((l) => l.includes(MARKER_END));
  if (start === -1 || end === -1 || end <= start) return null;
  return lines.slice(start + 1, end);
}

/** Return `content` with the between-markers region replaced by the topic list. */
export function applyToContent(content) {
  const lines = content.split('\n');
  const start = lines.findIndex((l) => l.includes(MARKER_START));
  const end = lines.findIndex((l) => l.includes(MARKER_END));
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Could not find ${MARKER_START}/${MARKER_END} markers.`);
  }
  const next = [...lines.slice(0, start + 1), ...topicOptionLines(), ...lines.slice(end)];
  return next.join('\n');
}

function main() {
  for (const file of TEMPLATES) {
    const before = fs.readFileSync(file, 'utf8');
    const after = applyToContent(before);
    if (after !== before) {
      fs.writeFileSync(file, after);
      console.log(`Updated topic options in ${path.relative(ROOT, file)}`);
    } else {
      console.log(`Already in sync: ${path.relative(ROOT, file)}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

#!/usr/bin/env node
/**
 * Verifies the issue-to-PR bot normalizes a contributor's deadline to UTC at
 * submission time: they may pick any civil timezone, and the bot converts to
 * the equivalent UTC instant (DST-aware) while preserving the original
 * wall-clock + zone in deadline_notes. UTC and AoE are left as-is.
 *
 * Drives the real bot via its ISSUE_BODY env contract, in a temp workdir.
 * Run: node scripts/issue_tz_test.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOT = path.join(ROOT, 'scripts', 'issue_to_yaml.mjs');

function body({ tz, deadline = '2026-08-22 17:00' }) {
  return `### Workshop name

TZ Conv Test

### Conference

icml

### Year

2026

### Workshop website

https://example.com/ws

### Topics

other

### Submission deadline

${deadline}

### Timezone

${tz}

### Submission portal

openreview`;
}

// Run the bot with a given issue body; return the parsed YAML of the file it
// created (then clean the file up).
function run(issueBody) {
  const created = execFileSync('node', [BOT], {
    env: { ...process.env, ISSUE_BODY: issueBody },
    encoding: 'utf8',
  }).trim().split('\n').pop();
  const abs = path.isAbsolute(created) ? created : path.join(ROOT, created);
  const text = fs.readFileSync(abs, 'utf8');
  fs.unlinkSync(abs);
  const dl = text.match(/^submission_deadline:\s*(.+)$/m)?.[1].trim();
  const tz = text.match(/^timezone:\s*(.+)$/m)?.[1].trim();
  const notes = text.match(/^deadline_notes:\s*(.+)$/m)?.[1].trim() ?? null;
  return { dl, tz, notes };
}

let failed = 0;
function check(label, cond, detail = '') {
  if (!cond) failed++;
  console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : `  ${detail}`}`);
}

// 1. Summer LA (PDT = UTC-7): Aug 22 17:00 -> Aug 23 00:00 UTC, with note.
let r = run(body({ tz: 'America/Los_Angeles' }));
check('LA summer -> UTC instant', r.dl === '2026-08-23 00:00' && r.tz === 'UTC', JSON.stringify(r));
check('LA summer -> provenance note kept', /America\/Los_Angeles/.test(r.notes || ''), JSON.stringify(r));

// 2. Winter LA (PST = UTC-8): Feb 1 17:00 -> Feb 2 01:00 UTC (DST-aware).
r = run(body({ tz: 'America/Los_Angeles', deadline: '2026-02-01 17:00' }));
check('LA winter -> UTC instant (DST-aware)', r.dl === '2026-02-02 01:00' && r.tz === 'UTC', JSON.stringify(r));

// 3. UTC input -> unchanged, no spurious note.
r = run(body({ tz: 'UTC' }));
check('UTC stays UTC, no note', r.dl === '2026-08-22 17:00' && r.tz === 'UTC' && r.notes === null, JSON.stringify(r));

// 4. AoE input -> converted to UTC too (consistent with the importer).
//    17:00 AoE (UTC-12) = 05:00 UTC the next day.
r = run(body({ tz: 'AoE' }));
check('AoE -> UTC instant', r.dl === '2026-08-23 05:00' && r.tz === 'UTC', JSON.stringify(r));
check('AoE -> provenance note kept', /AoE/.test(r.notes || ''), JSON.stringify(r));

console.log(failed === 0 ? '\nContributor timezones convert to UTC correctly.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

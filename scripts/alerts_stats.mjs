#!/usr/bin/env node
/**
 * How many people are subscribed, and what they asked for.
 *
 * Counts only. No address is ever selected, printed, or returned — the whole
 * point is that this can be run casually, pasted into an issue, or left in a
 * terminal without leaking anyone's email. Everything here is an aggregate.
 *
 * Reads the database directly through wrangler rather than the Worker's
 * /admin/* API, because /admin/subscribers deliberately returns only *mailable*
 * rows — it exists to feed the digest — so it cannot see people awaiting
 * confirmation, paused, or suppressed, which is most of what you want when
 * asking "is this working?".
 *
 * Requires: wrangler logged in to the account holding the D1 database.
 *
 * Run:  node scripts/alerts_stats.mjs
 *       node scripts/alerts_stats.mjs --days 30   (signups in the last N days)
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SQL, foldCadence, foldRegions } from '../alerts/stats.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_DIR = path.join(ROOT, 'alerts', 'worker');
const DB = 'aiwt-alerts';

const argDays = process.argv.indexOf('--days');
const DAYS = argDays > -1 ? Number(process.argv[argDays + 1]) || 30 : 30;

/** Run one read-only statement and return its rows. */
function query(sql) {
  let out;
  try {
    out = execFileSync(
      'npx',
      ['--yes', 'wrangler@4', 'd1', 'execute', DB, '--remote', '--json', '--command', sql],
      { cwd: WORKER_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    const msg = String(err.stderr || err.message);
    if (/not authenticated|login/i.test(msg)) {
      console.error('✗ wrangler is not logged in. Run: npx wrangler login');
    } else {
      console.error(`✗ query failed: ${msg.split('\n').slice(-4).join('\n')}`);
    }
    process.exit(1);
  }
  // wrangler prints a banner before the JSON payload.
  const match = out.match(/\[[\s\S]*\]/);
  if (!match) return [];
  const parsed = JSON.parse(match[0]);
  return parsed[0]?.results ?? [];
}

// The queries live in alerts/stats.mjs because the Worker's /admin/stats runs
// the same ones for the dashboard. Two definitions would eventually disagree
// about how many people are subscribed, with no way to tell which was right.
const [totals] = query(SQL.totals());
const mailable = query(SQL.mailable())[0]?.n ?? 0;
const recent = query(SQL.signupsSince(DAYS))[0]?.n ?? 0;
// Newest first: a terminal reader scans down from today. The shared query is
// ascending because a chart reads left-to-right through time.
const byDay = query(SQL.signupsByDay(DAYS)).slice().reverse().slice(0, 14);
const flags = foldCadence(query(SQL.cadences()));
const regions = foldRegions(query(SQL.timezones()));

const pad = (label, value) => `  ${String(label).padEnd(22)}${value}`;

console.log('AI Workshop Tracker — alert subscribers\n');
console.log(pad('total rows', totals.total));
console.log(pad('confirmed', totals.confirmed));
console.log(pad('awaiting confirmation', `${totals.pending}   (deleted automatically after 48h)`));
console.log(pad('suppressed', `${totals.suppressed}   (hard bounce or complaint)`));
console.log(pad('paused', totals.paused));
console.log('');
console.log(pad('MAILABLE', `${mailable}   <- who actually receives anything`));
console.log('');
console.log('What they asked for (of the confirmed):');
console.log(pad('weekly digest', flags.weekly));
console.log(pad('72h deadline alert', flags.urgent));
console.log(pad('deadline changed', flags.changes));
console.log(pad('saved-workshops only', totals.saved_only));
console.log('');
console.log('Where they are (the timezone their browser reported — no IP lookup):');
for (const r of regions) console.log(pad(r.region, r.n));
if (!regions.length) console.log(pad('(none yet)', ''));
console.log('');
console.log(`Signups in the last ${DAYS} days: ${recent}`);
if (byDay.length) {
  const max = Math.max(...byDay.map((d) => d.n));
  for (const d of byDay) console.log(`  ${d.day}  ${'█'.repeat(Math.round((d.n / max) * 24)) || '▏'} ${d.n}`);
} else {
  console.log('  (none)');
}
console.log('\nNo email address is read or printed by this script.');

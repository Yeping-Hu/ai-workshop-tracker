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

const [totals] = query(`
  SELECT
    COUNT(*)                                                    AS total,
    SUM(CASE WHEN confirmed_at IS NOT NULL THEN 1 ELSE 0 END)   AS confirmed,
    SUM(CASE WHEN confirmed_at IS NULL THEN 1 ELSE 0 END)       AS pending,
    SUM(CASE WHEN suppressed_at IS NOT NULL THEN 1 ELSE 0 END)  AS suppressed,
    SUM(CASE WHEN cadence = 'off' THEN 1 ELSE 0 END)            AS paused,
    SUM(CASE WHEN scope = 'starred' THEN 1 ELSE 0 END)          AS saved_only
  FROM subscribers`);

const mailable = query(`
  SELECT COUNT(*) AS n FROM subscribers
  WHERE confirmed_at IS NOT NULL AND suppressed_at IS NULL AND cadence != 'off'`)[0]?.n ?? 0;

const recent = query(`
  SELECT COUNT(*) AS n FROM subscribers
  WHERE created >= datetime('now', '-${DAYS} days')`)[0]?.n ?? 0;

const byDay = query(`
  SELECT substr(created, 1, 10) AS day, COUNT(*) AS n
  FROM subscribers
  WHERE created >= datetime('now', '-${DAYS} days')
  GROUP BY day ORDER BY day DESC LIMIT 14`);

// `cadence` holds a canonical CSV or a legacy keyword; count the flags rather
// than the raw strings, or 'weekly,urgent' and 'weekly_urgent' look different.
const notify = query(`SELECT cadence, COUNT(*) AS n FROM subscribers
  WHERE confirmed_at IS NOT NULL AND suppressed_at IS NULL GROUP BY cadence`);
const flags = { weekly: 0, urgent: 0, changes: 0 };
const LEGACY = {
  weekly: ['weekly'],
  weekly_urgent: ['weekly', 'urgent'],
  starred_changes: ['urgent', 'changes'],
  off: [],
};
for (const row of notify) {
  const kinds = LEGACY[row.cadence] ?? String(row.cadence).split(',').map((s) => s.trim());
  for (const k of kinds) if (k in flags) flags[k] += row.n;
}

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
console.log(`Signups in the last ${DAYS} days: ${recent}`);
if (byDay.length) {
  const max = Math.max(...byDay.map((d) => d.n));
  for (const d of byDay) console.log(`  ${d.day}  ${'█'.repeat(Math.round((d.n / max) * 24)) || '▏'} ${d.n}`);
} else {
  console.log('  (none)');
}
console.log('\nNo email address is read or printed by this script.');

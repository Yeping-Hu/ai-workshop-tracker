#!/usr/bin/env node
/**
 * The paper matcher's daily tally (alerts/usage.mjs) — what the dashboard's
 * "Paper matcher" card is counted from.
 *
 * Three things are pinned here. That a row is a day, a counter and a number
 * and can be nothing else, because /match promises the paper is discarded.
 * That counting cannot fail a search. And that the SQL does what the comments
 * say — the statements are run against a real SQLite (node:sqlite, the same
 * engine D1 is), since the read query finds the day and the counter by
 * character offset into the key and an off-by-one there would render as a
 * dashboard of zeros rather than as an error.
 *
 * Run: node scripts/alerts_usage_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  USAGE_PREFIX, USAGE_COUNTERS, usageKey, parseUsageKey, usageWrites, bumpUsage, foldUsage,
  pruneBefore, BUMP_SQL, PRUNE_SQL,
} from '../alerts/usage.mjs';
import { SQL } from '../alerts/stats.mjs';
import { MATCH_USAGE_RETENTION_DAYS } from '../alerts/config.mjs';
import { JEV_USD_PER_MTOK } from '../lib/jev.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ------------------------------------------------------------------- keys */
{
  check('a key is prefix, day, counter', usageKey('2026-09-19', 'answered') === 'matchuse:2026-09-19:answered');
  check('...and parses back', eq(parseUsageKey('matchuse:2026-09-19:input_tokens'), { day: '2026-09-19', counter: 'input_tokens' }));
  for (const bad of ['snapshot', 'goatcounter', 'matchuse:', 'matchuse:2026-09-19', 'matchuse:2026-09-19:', 'matchuse:2026-09-19:emails',
    'matchuse:2026-9-19:answered', 'matchuse:2026-09-19-answered', null, undefined]) {
    check(`${JSON.stringify(bad)} is not a tally key`, parseUsageKey(bad) === null);
  }
  // Keys sort by day, which is what lets a range on the primary key stand in
  // for a date column — for the read and for the prune.
  const keys = ['2026-10-01', '2025-12-31', '2026-09-19'].map((d) => usageKey(d, 'answered')).sort();
  check('keys sort chronologically', eq(keys.map((k) => parseUsageKey(k).day), ['2025-12-31', '2026-09-19', '2026-10-01']));
}

/* ------------------------------------------- only known counters, only >0 */
{
  const w = usageWrites('2026-09-19', { answered: 1, jev_requests: 5, input_tokens: 5230 });
  check('one write per positive counter', eq(w, [
    { k: 'matchuse:2026-09-19:answered', by: 1 },
    { k: 'matchuse:2026-09-19:jev_requests', by: 5 },
    { k: 'matchuse:2026-09-19:input_tokens', by: 5230 },
  ]), JSON.stringify(w));

  // The promise behind the page's "nothing is stored": a caller cannot mint a
  // row that carries anything but a known counter name.
  const smuggled = usageWrites('2026-09-19', { answered: 1, title: 'My unpublished paper', ip: '203.0.113.7', 'a@b.co': 1 });
  check('an unknown counter name is dropped, not written', eq(smuggled.map((x) => x.k), ['matchuse:2026-09-19:answered']), JSON.stringify(smuggled));
  check('zeros, negatives and junk write nothing',
    eq(usageWrites('2026-09-19', { answered: 0, failed: -3, turned_away: 'x', jev_requests: NaN, input_tokens: null }), []));
  check('a fraction is floored', eq(usageWrites('2026-09-19', { input_tokens: 12.9 }), [{ k: 'matchuse:2026-09-19:input_tokens', by: 12 }]));
  for (const day of ['', null, '19/09/2026', "2026-09-19'; DROP TABLE kv; --", '2026-09-19T10:00:00Z']) {
    check(`a day of ${JSON.stringify(day)} writes nothing`, eq(usageWrites(day, { answered: 1 }), []));
  }
  check('no counter name could be mistaken for a person',
    USAGE_COUNTERS.every((c) => /^[a-z_]+$/.test(c)) && !USAGE_COUNTERS.some((c) => /email|ip|addr|title|abstract|paper|topic/.test(c)),
    USAGE_COUNTERS.join(', '));
}

/* ------------------------------------------- counting never fails a search */
{
  const calls = [];
  const okDb = {
    prepare: (sql) => ({ bind: (...args) => ({ sql, args }) }),
    batch: async (stmts) => { calls.push(stmts); },
  };
  const wrote = await bumpUsage(okDb, '2026-09-19', { answered: 1, input_tokens: 40 });
  check('a search is one batch, one statement per counter',
    wrote.ok && calls.length === 1 && calls[0].length === 2 && calls[0].every((s) => s.sql === BUMP_SQL),
    JSON.stringify(calls));
  check('each statement binds its key and the amount', eq(calls[0][1].args, ['matchuse:2026-09-19:input_tokens', 40, 40]), JSON.stringify(calls[0][1].args));

  calls.length = 0;
  check('nothing to count is no database call at all', (await bumpUsage(okDb, '2026-09-19', {})).ok && calls.length === 0);

  const down = { prepare: () => { throw new Error('D1_ERROR: no such table: kv'); }, batch: async () => {} };
  const rejecting = { prepare: okDb.prepare, batch: async () => { throw new Error('D1 is overloaded'); } };
  for (const [label, db] of [['a throwing prepare', down], ['a rejected batch', rejecting], ['no database at all', undefined]]) {
    let threw = false;
    let res;
    try { res = await bumpUsage(db, '2026-09-19', { answered: 1 }); } catch { threw = true; }
    check(`${label} resolves { ok: false } instead of throwing`, !threw && res?.ok === false && typeof res.error === 'string', JSON.stringify(res));
  }
}

/* ------------------------------------------------------------ the folding */
{
  const rows = [
    { day: '2026-09-17', counter: 'answered', n: 3 },
    { day: '2026-09-17', counter: 'jev_requests', n: 14 },
    { day: '2026-09-17', counter: 'input_tokens', n: 40000 },
    { day: '2026-09-19', counter: 'answered', n: 2 },
    { day: '2026-09-19', counter: 'failed', n: 1 },
    { day: '2026-09-19', counter: 'turned_away', n: 4 },
    { day: '2026-09-19', counter: 'input_tokens', n: 10000 },
  ];
  const f = foldUsage(rows, 5, '2026-09-19');
  check('a search is one that was answered or failed; a turned-away request is not',
    f.searches === 6 && f.answered === 5 && f.failed === 1 && f.turned_away === 4, JSON.stringify(f));
  check('the series is gap-filled, oldest first, ending today',
    eq(f.by_day, [{ day: '2026-09-15', n: 0 }, { day: '2026-09-16', n: 0 }, { day: '2026-09-17', n: 3 }, { day: '2026-09-18', n: 0 }, { day: '2026-09-19', n: 3 }]),
    JSON.stringify(f.by_day));
  check('the headline equals the chart under it', f.searches === f.by_day.reduce((a, d) => a + d.n, 0));
  check('the spend is the billed tokens at the recorded price',
    Math.abs(f.usd - (50000 / 1e6) * JEV_USD_PER_MTOK) < 1e-12, String(f.usd));

  // The query reaches one day further back than the chart draws.
  const edge = foldUsage([{ day: '2026-09-14', counter: 'answered', n: 9 }, ...rows], 5, '2026-09-19');
  check('a row outside the window counts toward nothing', edge.searches === 6 && edge.answered === 5, JSON.stringify(edge));

  const junk = foldUsage([{ day: '2026-09-19', counter: 'emails', n: 5 }, { day: '2026-09-19', counter: 'answered', n: 'x' }, null, {}], 5, '2026-09-19');
  check('an unknown counter or a junk count is ignored', junk.searches === 0 && !('emails' in junk), JSON.stringify(junk));
  const none = foldUsage([], 30, '2026-09-19');
  check('no rows is thirty quiet days, not an error', none.searches === 0 && none.usd === 0 && none.by_day.length === 30);
  check('undefined rows do not throw', foldUsage(undefined, 30, '2026-09-19').by_day.length === 30);
}

/* -------------------------------------------------------------- the prune */
{
  check('the cutoff is a key, a retention before today', pruneBefore('2026-09-19', 400) === 'matchuse:2025-08-15', pruneBefore('2026-09-19', 400));
  check('a nonsense date prunes nothing', pruneBefore('soon', 400) === USAGE_PREFIX);
  check('a year of dashboard window is always answerable', MATCH_USAGE_RETENTION_DAYS > 366, String(MATCH_USAGE_RETENTION_DAYS));
}

/* -------------------------------------- the statements, on a real SQLite -- */
{
  let sqlite = null;
  try {
    sqlite = await import('node:sqlite');
  } catch {
    // node:sqlite arrived in Node 22.5; every workflow here runs 22. An older
    // local Node still runs everything above.
    console.log('- node:sqlite is not available in this Node; the SQL checks were skipped');
  }
  if (sqlite) {
    const db = new sqlite.DatabaseSync(':memory:');
    db.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    // What `kv` already holds in production; none of it may be read or pruned.
    db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run('snapshot', '{"workshops":[]}');
    db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run('goatcounter', '{"fetched_at":"x"}');

    const bump = (day, counts) => {
      for (const w of usageWrites(day, counts)) db.prepare(BUMP_SQL).run(w.k, w.by, w.by);
    };
    const isoDaysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    const today = isoDaysAgo(0);

    bump(today, { answered: 1, jev_requests: 5, input_tokens: 5230 });
    bump(today, { answered: 1, jev_requests: 4, input_tokens: 4100 });
    bump(today, { failed: 1 });
    bump(isoDaysAgo(3), { answered: 7, turned_away: 2 });
    bump(isoDaysAgo(500), { answered: 99 });

    const stored = db.prepare('SELECT v, typeof(v) AS t FROM kv WHERE k = ?').get(usageKey(today, 'input_tokens'));
    check('a second search adds to the day rather than replacing it', stored.v === '9330', JSON.stringify(stored));
    check('...and the value stays text, like every other row in kv', stored.t === 'text', stored.t);

    const rows = db.prepare(SQL.matchUsage(30)).all().map((r) => ({ ...r }));
    check('the read finds the day and the counter in the key',
      rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.day) && USAGE_COUNTERS.includes(r.counter)), JSON.stringify(rows));
    check('...reads only tally rows', rows.length === 6 && !rows.some((r) => /snapshot|goatcounter/.test(JSON.stringify(r))), JSON.stringify(rows));
    check('...and nothing older than the window', !rows.some((r) => r.n === 99));
    const f = foldUsage(rows, 30, today);
    check('end to end: bumps in, dashboard figures out',
      f.searches === 10 && f.answered === 9 && f.failed === 1 && f.turned_away === 2 && f.jev_requests === 9 && f.input_tokens === 9330,
      JSON.stringify({ ...f, by_day: undefined }));

    const pruned = db.prepare(PRUNE_SQL).run(pruneBefore(today, MATCH_USAGE_RETENTION_DAYS));
    const left = db.prepare('SELECT k FROM kv ORDER BY k').all().map((r) => r.k);
    check('the prune deletes the day past retention and only that', Number(pruned.changes) === 1 && !left.some((k) => k.includes(isoDaysAgo(500))), JSON.stringify(left));
    check('...and never the snapshot or the traffic cache', left.includes('snapshot') && left.includes('goatcounter'));
    check('a nonsense date prunes nothing', Number(db.prepare(PRUNE_SQL).run(pruneBefore('soon', 400)).changes) === 0);

    for (const evil of ["1; DROP TABLE kv", '1 OR 1=1', 'abc', -5, 1e9, null]) {
      const sql = SQL.matchUsage(evil);
      check(`matchUsage(${JSON.stringify(evil)}) stays a plain integer`, /-\d+ days/.test(sql) && !/DROP|OR 1=1|abc/i.test(sql), sql.slice(0, 120));
    }
  }
}

/* --------------------------------------------------- the Worker's wiring -- */
{
  const worker = fs.readFileSync(path.join(ROOT, 'alerts', 'worker', 'src', 'index.mjs'), 'utf8');
  const handler = worker.slice(worker.indexOf('async function handleMatch'), worker.indexOf('/* ---------------------------------------------------------------- Turnstile */'));
  check('found the /match handler', handler.length > 500);

  // A request that never solved a challenge writes nothing: otherwise anyone
  // with curl holds a D1 write per request against the free plan's allowance.
  const firstTally = handler.indexOf('await tally(');
  check('nothing is tallied before Turnstile has passed',
    firstTally > -1 && handler.indexOf('verifyTurnstile') > -1 && handler.indexOf('verifyTurnstile') < firstTally);
  check('the tally goes through bumpUsage, which cannot throw', /bumpUsage\(env\.DB, today\(\), counts\)/.test(handler));
  check('the handler passes the tally numbers and nothing else',
    [...handler.matchAll(/await tally\(([^)]*)\)/g)].every((m) => !/body|input|title|abstract|ip\b|request/.test(m[1])),
    'a tally argument mentions the request');
  check('Jev spend is counted per request, not read off the isolate-wide total',
    /spent\.jev_requests \+= 1/.test(handler) && !/jevUsage\(\)/.test(handler.replace(/\/\/.*$/gm, '')));
  check('both outcomes of a search are tallied', /\[result\.ok \? 'answered' : 'failed'\]: 1/.test(handler));

  const maint = worker.slice(worker.indexOf("path === '/admin/maintenance'"), worker.indexOf('/* ------------------------------------------------------------------- stats */'));
  check('the daily maintenance call prunes the tally', /PRUNE_SQL/.test(maint) && /MATCH_USAGE_RETENTION_DAYS/.test(maint));
}

console.log(failed === 0 ? '\nMatcher tally OK.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

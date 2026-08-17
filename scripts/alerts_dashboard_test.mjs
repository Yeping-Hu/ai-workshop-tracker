#!/usr/bin/env node
/**
 * The dashboard's guarantees.
 *
 * One of these is not like the others. Most check that a function computes the
 * right thing; the "no query returns an address" check is the load-bearing one,
 * because it is the reason a page showing subscriber data can be hosted at all.
 * Cloudflare Access is the lock on the door, but that lock is configured in a
 * dashboard nobody here can see. This check is the reason a misconfiguration
 * would leak numbers rather than people, and it is asserted rather than trusted
 * precisely because it would otherwise be invisible until it mattered.
 *
 * Run: node scripts/alerts_dashboard_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SQL, foldCadence, foldRegions, regionOf, fillDays, UNKNOWN_REGION } from '../alerts/stats.mjs';
import { renderDashboard } from '../alerts/worker/src/dashboard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ------------------------------------- aggregates only, structurally ------ */
{
  const all = Object.entries(SQL).map(([name, fn]) => [name, fn(30)]);

  // The whole design rests on this. A SELECT here that can return an address
  // turns "worst case, counts leak" into "worst case, the list leaks".
  const leaky = all.filter(([, sql]) => /\bemail\b/i.test(sql));
  check('no shared stats query mentions `email`',
    leaky.length === 0, leaky.map(([n]) => n).join(', '));

  // Anything not aggregated is a per-person row by another name.
  const raw = all.filter(([, sql]) => !/COUNT\(|SUM\(/i.test(sql));
  check('every shared stats query aggregates',
    raw.length === 0, raw.map(([n]) => n).join(', '));

  // The Worker must reach the database for stats only through those queries.
  const worker = fs.readFileSync(path.join(ROOT, 'alerts', 'worker', 'src', 'index.mjs'), 'utf8');
  const collect = worker.slice(worker.indexOf('async function collectStats'), worker.indexOf('async function goatcounter'));
  check('collectStats runs only the shared queries',
    !/SELECT/i.test(collect), 'an inline SELECT here bypasses the guarantee above');
  check('the dashboard renderer never sees an address',
    !/\bemail\b/i.test(fs.readFileSync(path.join(ROOT, 'alerts', 'worker', 'src', 'dashboard.mjs'), 'utf8')));
}

/* ------------------------------------------------- days are never injected */
{
  // Days reach SQL by interpolation, and the value comes from a URL parameter.
  for (const evil of ["1; DROP TABLE subscribers", '1 OR 1=1', 'abc', -5, 1e9, null]) {
    const sql = SQL.signupsByDay(evil);
    check(`signupsByDay(${JSON.stringify(evil)}) stays a plain integer`,
      /-\d+ days/.test(sql) && !/DROP|OR 1=1|abc/i.test(sql), sql.slice(0, 90));
  }
}

/* ------------------------------------------------------ region bucketing -- */
{
  check('America/Los_Angeles -> Americas', regionOf('America/Los_Angeles') === 'Americas');
  check('Asia/Tehran -> Asia', regionOf('Asia/Tehran') === 'Asia');
  check('Europe/Berlin -> Europe', regionOf('Europe/Berlin') === 'Europe');
  check('Australia/Sydney -> Oceania', regionOf('Australia/Sydney') === 'Oceania');
  check('Africa/Lagos -> Africa', regionOf('Africa/Lagos') === 'Africa');
  check('legacy US/Eastern -> Americas', regionOf('US/Eastern') === 'Americas');
  check('UTC -> Other', regionOf('UTC') === 'Other');

  // NULL tz is a real state — the browser did not report one — not a bug.
  for (const v of [null, undefined, '', '   ']) {
    check(`${JSON.stringify(v)} -> ${UNKNOWN_REGION}`, regionOf(v) === UNKNOWN_REGION);
  }
  // A zone added to the database after this was written must not throw: the
  // dashboard failing because someone travelled somewhere new would be absurd.
  check('an unheard-of zone does not throw', regionOf('Mars/Olympus_Mons') === 'Other');

  const folded = foldRegions([
    { tz: 'America/Los_Angeles', n: 4 }, { tz: 'America/New_York', n: 2 },
    { tz: 'Asia/Tehran', n: 1 }, { tz: null, n: 3 },
  ]);
  check('regions merge and sort by size',
    eq(folded, [{ region: 'Americas', n: 6 }, { region: 'Asia', n: 1 }, { region: UNKNOWN_REGION, n: 3 }]),
    JSON.stringify(folded));
  check('Unknown sorts last however large it is',
    folded[folded.length - 1].region === UNKNOWN_REGION);
}

/* ------------------------------------------------------- cadence folding -- */
{
  const f = foldCadence([
    { cadence: 'weekly', n: 3 },
    { cadence: 'weekly,urgent,changes', n: 2 },
    { cadence: 'weekly_urgent', n: 1 },   // legacy
    { cadence: 'starred_changes', n: 1 }, // legacy: urgent + changes, no digest
    { cadence: 'off', n: 5 },
  ]);
  check('CSV and legacy cadences fold to the same flags',
    eq(f, { weekly: 6, urgent: 4, changes: 3 }), JSON.stringify(f));
  check('paused subscribers count toward nothing', foldCadence([{ cadence: 'off', n: 9 }]).weekly === 0);
  check('an unrecognised cadence is ignored, not counted',
    eq(foldCadence([{ cadence: 'sideways', n: 4 }]), { weekly: 0, urgent: 0, changes: 0 }));
}

/* ------------------------------------------------------------- day filling */
{
  const filled = fillDays([{ day: '2026-08-16', n: 4 }, { day: '2026-08-17', n: 2 }], 5, '2026-08-17');
  check('quiet days are filled with zero, not skipped', filled.length === 5, String(filled.length));
  check('the series ends on today', filled[filled.length - 1].day === '2026-08-17');
  check('the series runs oldest to newest', filled[0].day === '2026-08-13');
  check('known days keep their counts', filled[filled.length - 1].n === 2 && filled[3].n === 4);
}

/* ------------------------------------------------- the page itself --------- */
{
  const stats = {
    generated_at: '2026-08-17T18:00:00.000Z', days: 30,
    totals: { total: 6, confirmed: 5, pending: 1, suppressed: 0, paused: 0, saved_only: 0, with_tz: 6, mailable: 5 },
    recent_signups: 6,
    by_day: [{ day: '2026-08-16', n: 4 }, { day: '2026-08-17', n: 2 }],
    cadence: { weekly: 5, urgent: 2, changes: 2 },
    regions: [{ region: 'Americas', n: 4 }, { region: 'Asia', n: 1 }],
    traffic: { total: 1234, by_day: [{ day: '2026-08-16', n: 40 }, { day: '2026-08-17', n: 60 }],
               pages: [{ path: '/', n: 900 }], referrers: [{ name: 'google', n: 30 }],
               locations: [{ name: 'United States', n: 500 }] },
  };
  const html = renderDashboard(stats);

  check('renders a complete document', html.startsWith('<!doctype html>') && html.trim().endsWith('</html>'));
  check('shows the mailable figure', html.includes('>5</div>'));
  check('is marked noindex', /name="robots" content="noindex/.test(html));

  // Self-contained: behind Access, every outbound request would tell a third
  // party that this page exists and when it is being read.
  check('loads nothing from anywhere', !/<script|<link|src=|@import|https?:\/\//i.test(
    html.replace(/<!doctype[^>]*>/i, '')), 'an external request would leak that this page was opened');

  check('adapts to a dark viewer', html.includes('prefers-color-scheme: dark'));

  // A dashboard that renders nothing because a third party is down is worse
  // than one that shows the numbers it does have.
  for (const [label, traffic] of [['an error', { error: 'unavailable' }],
                                  ['no configuration', { error: 'not_configured' }],
                                  ['nothing at all', null]]) {
    const degraded = renderDashboard({ ...stats, traffic });
    check(`traffic ${label} still renders the subscriber figures`,
      degraded.includes('Mailable') && degraded.includes('Where subscribers are'));
  }
  check('a missing token says so specifically',
    renderDashboard({ ...stats, traffic: { error: 'not_configured' } }).includes('GOATCOUNTER_TOKEN'));

  // Escaping: GoatCounter returns page paths and referrer names from the open
  // internet, so they are untrusted strings on a privileged page.
  const xss = renderDashboard({
    ...stats,
    traffic: { ...stats.traffic, pages: [{ path: '/<img src=x onerror=alert(1)>', n: 1 }] },
  });
  check('untrusted page paths are escaped', !xss.includes('<img src=x') && xss.includes('&lt;img'));

  // An empty database is the state on day one and must not throw.
  const empty = renderDashboard({
    generated_at: '2026-08-17T18:00:00.000Z', days: 30,
    totals: { total: 0, confirmed: 0, pending: 0, suppressed: 0, paused: 0, saved_only: 0, with_tz: 0, mailable: 0 },
    recent_signups: 0, by_day: [], cadence: { weekly: 0, urgent: 0, changes: 0 }, regions: [], traffic: null,
  });
  check('an empty database renders', empty.includes('<h1>Alerts dashboard</h1>'));
  check('...and says so rather than drawing an empty chart', empty.includes('not enough days yet'));
}

/* ------------------------------------------- the route is guarded ---------- */
{
  const worker = fs.readFileSync(path.join(ROOT, 'alerts', 'worker', 'src', 'index.mjs'), 'utf8');
  const route = worker.slice(worker.indexOf("path === '/dashboard'"), worker.indexOf("path === '/dashboard'") + 700);
  check('/dashboard verifies the Access JWT before rendering',
    /verifyAccessJwt/.test(route) && route.indexOf('verifyAccessJwt') < route.indexOf('renderDashboard'),
    'Access protects a hostname; this protects the route');
  check('...and refuses when it fails', /403/.test(route));
  check('the page is never cached by a proxy', /no-store/.test(route));

  const access = fs.readFileSync(path.join(ROOT, 'alerts', 'worker', 'src', 'access.mjs'), 'utf8');
  check('the algorithm is pinned to RS256', /alg !== 'RS256'/.test(access),
    'accepting the token\'s own alg is the classic JWT hole');
  check('the audience is checked', /ACCESS_AUD/.test(access) && /includes\(aud\)/.test(access),
    'a signature alone only proves Cloudflare issued it, not that it was for us');
  check('expiry is checked', /claims\.exp/.test(access));
  check('missing configuration fails closed', /if \(!team \|\| !aud\) return null/.test(access));
}

console.log(failed === 0 ? '\nDashboard guarantees OK.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

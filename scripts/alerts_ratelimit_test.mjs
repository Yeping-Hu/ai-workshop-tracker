#!/usr/bin/env node
/**
 * Tests for alerts/ratelimit.mjs — the expiring-counter arithmetic behind the
 * abuse limits *and* behind magic-link single use.
 *
 * The single-use case is the one that needed pinning. A `magic` token is
 * accepted exactly once by writing a limit-1 bucket keyed on the token's hash.
 * The alternative (rotating the subscriber's nonce) would have revoked every
 * other device they had already linked, which is why this mechanism was chosen
 * instead. Its cost is a row that must expire — otherwise the table grows by one
 * row per sign-in forever, and the "no data we don't need" promise erodes
 * quietly.
 *
 * So three things are pinned here:
 *   1. limit-1 buckets really are single-use;
 *   2. the used-token row's window is finite and outlives the token slightly
 *      (clock skew must not let a token survive its own row);
 *   3. an expired row is treated as absent on read, so a bucket cannot wedge
 *      shut between maintenance sweeps — and the maintenance sweep really does
 *      delete expired rows.
 *
 * Pure logic — no network, no D1. Run: node scripts/alerts_ratelimit_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  consume,
  isExpiredBucket,
  magicUsedBucket,
  MAGIC_USED_WINDOW_S,
  MAGIC_USED_MARGIN_S,
} from '../alerts/ratelimit.mjs';
import { MAGIC_TTL_S, RL_SUBSCRIBE_PER_IP_HOUR, RL_MAGIC_PER_EMAIL_HOUR } from '../alerts/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}

const NOW = 1_780_000_000;

/**
 * Drive `consume` against a tiny in-memory store, the way the Worker drives it
 * against `rl`. Returns whether the hit was allowed.
 */
function hit(store, bucket, { limit, windowS, nowS }) {
  const verdict = consume(store.get(bucket) ?? null, { limit, windowS, nowS });
  if (verdict.action !== 'deny') store.set(bucket, verdict.next);
  return verdict.allowed;
}

/* ------------------------------------------------ magic tokens are single-use */
{
  const store = new Map();
  const bucket = magicUsedBucket('a'.repeat(40));
  const opts = { limit: 1, windowS: MAGIC_USED_WINDOW_S, nowS: NOW };

  check('the first use of a magic token is accepted', hit(store, bucket, opts));
  check('the second use of the same token is refused', !hit(store, bucket, opts));
  check('and it stays refused however often it is retried',
    ![2, 3, 4].some((i) => hit(store, bucket, { ...opts, nowS: NOW + i })));

  // A different token is a different bucket — one exchange must not lock out
  // another sign-in link.
  check('a different magic token is unaffected', hit(store, magicUsedBucket('b'.repeat(40)), opts));
  check('bucket keys are namespaced', bucket.startsWith('magicused:'), bucket);
}

/* ----------------------------------- the used-token row expires (and is swept) */
{
  check('the used-token window is finite', Number.isFinite(MAGIC_USED_WINDOW_S) && MAGIC_USED_WINDOW_S > 0);
  check('the used-token window outlives the token itself',
    MAGIC_USED_WINDOW_S > MAGIC_TTL_S, `${MAGIC_USED_WINDOW_S} vs ${MAGIC_TTL_S}`);
  check('the margin is small (the row protects nothing once the token expires)',
    MAGIC_USED_MARGIN_S <= 300, String(MAGIC_USED_MARGIN_S));

  const row = { count: 1, reset: NOW + MAGIC_USED_WINDOW_S };
  check('the row is live while the token could still be presented',
    !isExpiredBucket(row, NOW + MAGIC_TTL_S));
  check('the row is expired once its window closes',
    isExpiredBucket(row, NOW + MAGIC_USED_WINDOW_S));
  check('an absent row counts as expired', isExpiredBucket(null, NOW));

  // Expiry is enforced on read as well as by the sweep, so a bucket can never
  // wedge shut because maintenance has not run.
  const store = new Map([['magicused:x', row]]);
  check('an expired bucket is treated as absent on the next read',
    hit(store, 'magicused:x', { limit: 1, windowS: MAGIC_USED_WINDOW_S, nowS: NOW + MAGIC_USED_WINDOW_S + 1 }));
}

/* ---------------------------- /admin/maintenance really reclaims expired rows */
// Source-level, in the spirit of scripts/imports_test.mjs: the arithmetic above
// is only half the guarantee — something has to run the DELETE.
{
  const worker = fs.readFileSync(path.join(ROOT, 'alerts', 'worker', 'src', 'index.mjs'), 'utf8');
  const maint = worker.slice(worker.indexOf("path === '/admin/maintenance'"));
  check('/admin/maintenance exists', maint.length > 0);
  check('...and deletes rate-limit rows whose window has closed',
    /DELETE FROM rl WHERE reset <= \?/.test(maint));
  check('...comparing against the current time',
    /\.bind\(Math\.floor\(Date\.now\(\) \/ 1000\)\)/.test(maint));
  // The used-token rows live in the same table, so that one sweep covers them.
  // (Who *calls* maintenance is a scheduling concern — scripts/alerts_run.mjs
  // does, on every non-dry run — and is deliberately not asserted here so this
  // suite stays runnable without the pipeline present.)
  check('used magic tokens are stored in the swept table',
    /rateLimit\(env, key, 1, MAGIC_USED_WINDOW_S\)/.test(worker));
}

/* ------------------------------------------------------ ordinary rate limiting */
{
  const store = new Map();
  const opts = { limit: RL_SUBSCRIBE_PER_IP_HOUR, windowS: 3600, nowS: NOW };
  let allowed = 0;
  for (let i = 0; i < RL_SUBSCRIBE_PER_IP_HOUR + 3; i++) if (hit(store, 'sub:hash:1', opts)) allowed++;
  check(`exactly ${RL_SUBSCRIBE_PER_IP_HOUR} signups per IP-hour are allowed`,
    allowed === RL_SUBSCRIBE_PER_IP_HOUR, String(allowed));

  // The window is fixed from the first hit, not extended by later attempts —
  // otherwise a persistent bot keeps its own bucket alive indefinitely.
  const row = store.get('sub:hash:1');
  check('the window is not extended by refused attempts', row.reset === NOW + 3600, String(row.reset - NOW));
  check('the counter resets once the window closes',
    hit(store, 'sub:hash:1', { ...opts, nowS: NOW + 3601 }));

  const magicStore = new Map();
  let magicAllowed = 0;
  for (let i = 0; i < RL_MAGIC_PER_EMAIL_HOUR + 2; i++) {
    if (hit(magicStore, 'magic:test@example.com:1', { limit: RL_MAGIC_PER_EMAIL_HOUR, windowS: 3600, nowS: NOW })) {
      magicAllowed++;
    }
  }
  check(`exactly ${RL_MAGIC_PER_EMAIL_HOUR} sign-in links per address-hour`,
    magicAllowed === RL_MAGIC_PER_EMAIL_HOUR, String(magicAllowed));
}

/* ------------------------------------------------------------- verdict shapes */
{
  const fresh = consume(null, { limit: 3, windowS: 60, nowS: NOW });
  check('an absent row inserts a fresh window', fresh.action === 'insert' && fresh.next.count === 1);
  const bump = consume({ count: 1, reset: NOW + 60 }, { limit: 3, windowS: 60, nowS: NOW });
  check('a live row under the limit bumps', bump.action === 'bump' && bump.next.count === 2);
  check('a bump keeps the original reset', bump.next.reset === NOW + 60);
  const deny = consume({ count: 3, reset: NOW + 60 }, { limit: 3, windowS: 60, nowS: NOW });
  check('a live row at the limit denies and writes nothing', deny.action === 'deny' && deny.next === null);
}

console.log(failed === 0 ? '\nRate-limit / single-use logic OK.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

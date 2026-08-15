/**
 * Rate-limit / single-use bucket arithmetic, split out from the Worker so the
 * rules are testable under Node instead of only observable against live D1.
 *
 * One table (`rl`) backs three different jobs, because they are the same shape:
 * a counter that expires.
 *
 *   sub:<hash(ip)>:<hour>     per-IP signup limit
 *   magic:<email>:<hour>      per-address sign-in-link limit
 *   newsubs:<date>            global daily brake on new addresses
 *   magicused:<hash(token)>   a magic token's one and only use
 *
 * The last one is why `reset` matters beyond throttling: a magic token is
 * accepted once by recording a limit-1 bucket, and that row must expire, or the
 * table grows forever. Its window is the token's own TTL plus a small margin —
 * once the token is expired it is rejected on the signature alone, so the row
 * has nothing left to protect and the daily maintenance sweep reclaims it.
 *
 * Nonce rotation was the alternative for single use, and would have unlinked
 * every *other* device the subscriber had already linked. This is the cheaper
 * and less destructive mechanism.
 */

import { MAGIC_TTL_S } from './config.mjs';

/** Margin over the token TTL, so clock skew can't let a token outlive its row. */
export const MAGIC_USED_MARGIN_S = 60;

/** Bucket key for a magic token's single use. `hash` is a truncated SHA-256. */
export const magicUsedBucket = (hash) => `magicused:${hash}`;

/** The window a `magicused:` row lives for. */
export const MAGIC_USED_WINDOW_S = MAGIC_TTL_S + MAGIC_USED_MARGIN_S;

/**
 * Decide what a bucket hit means, given the stored row (or null).
 *
 * @param row      `{count, reset}` from the `rl` table, or null when absent
 * @param limit    hits allowed within the window (1 = single use)
 * @param windowS  seconds the window lasts
 * @param nowS     current epoch seconds
 * @returns `{ allowed, action, next }` where `action` is:
 *            'insert' — no live row: write `next` ({count:1, reset})
 *            'bump'   — live row under the limit: increment it
 *            'deny'   — live row at the limit: reject, write nothing
 *
 * An **expired** row is treated as absent, so a bucket can never wedge shut
 * because a sweep hasn't run yet — expiry is enforced on read as well as by the
 * periodic delete.
 */
export function consume(row, { limit, windowS, nowS }) {
  if (!row || row.reset <= nowS) {
    return { allowed: true, action: 'insert', next: { count: 1, reset: nowS + windowS } };
  }
  if (row.count >= limit) return { allowed: false, action: 'deny', next: null };
  return { allowed: true, action: 'bump', next: { count: row.count + 1, reset: row.reset } };
}

/** Rows the maintenance sweep reclaims: everything whose window has closed. */
export const isExpiredBucket = (row, nowS) => !row || row.reset <= nowS;

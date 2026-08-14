/**
 * Shared constants for the email-alerts satellite.
 *
 * Imported by the Cloudflare Worker (alerts/worker/) and by the GitHub Action
 * entrypoint (scripts/alerts_run.mjs) so the two halves of the system can never
 * disagree about a threshold. Plain ESM with no dependencies — it has to load
 * in a Worker, in Node, and in the test files.
 */

/** Hard cap on stored subscribers, enforced at /subscribe. Beyond it, new
 *  signups get a friendly "the list is full" message rather than an error. */
export const MAX_SUBSCRIBERS = 5000;

/** A starred workshop whose next stage lands inside this window triggers the
 *  opt-in urgent alert. */
export const URGENT_WINDOW_MS = 72 * 3600_000;

/** Mirrors MIN_CHANGE_MS in lib/workshops.mjs: a sub-hour delta is a timezone
 *  re-read or a typo fix, not a deadline move. Kept identical so a digest can
 *  never report a change the site itself suppresses. */
export const MIN_CHANGE_MS = 3_600_000;

/** Weekly digests go out on Monday (UTC), after the daily diff has run. */
export const WEEKLY_DOW = 1;

/** Max items rendered per digest section before an "and N more →" link. */
export const SECTION_CAP = 15;

/** Abort the diff if the live dataset is smaller than this fraction of the
 *  snapshot — a garbled or partial fetch must not fabricate hundreds of
 *  events. Same paranoia as the importer's later-only rule. */
export const SNAPSHOT_SHRINK_GUARD = 0.7;

/** Double-opt-in confirmation links expire after 48 h. */
export const CONFIRM_TTL_S = 48 * 3600;

/** Sign-in (magic) links expire after 15 minutes. */
export const MAGIC_TTL_S = 15 * 60;

/** Rate limits. IPs are stored only as salted hashes, and only transiently. */
export const RL_SUBSCRIBE_PER_IP_HOUR = 5;
export const RL_MAGIC_PER_EMAIL_HOUR = 3;
/** Global brake against signup floods (a bot that rotates IPs). */
export const RL_NEW_SUBS_PER_DAY = 200;

/** Resend's batch endpoint accepts 100; we stay well under and chunk at 50. */
export const SEND_CHUNK = 50;

/** Events older than this are pruned by the daily maintenance call. The weekly
 *  digest only ever looks back 7 days; the rest is history for a future
 *  /changelog page (see §12 of docs/plans/email-alerts.md). */
export const EVENT_RETENTION_DAYS = 90;

/** Public site origin — the canonical base for every link in an email. */
export const SITE_ORIGIN = 'https://aiworkshoptracker.com';

/** localStorage keys the site uses to remember a linked device. Defined here so
 *  the Worker's redirect targets and the site's scripts agree. */
export const LS_TOKEN_KEY = 'awt-alerts-token';
export const LS_EMAIL_KEY = 'awt-alerts-email';

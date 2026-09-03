/**
 * aiwt-alerts — the entire backend for email alerts.
 *
 * One Worker, one D1 database, no other infrastructure (decision D1). It is a
 * strictly optional satellite: it *reads* the site's public
 * /api/workshops.json and never writes to the repo. Delete it and the static
 * site is unchanged.
 *
 * Three groups of endpoints:
 *
 *   browser  /subscribe /confirm /magic-link /me /update /sync /unsubscribe
 *            CORS-locked to SITE_ORIGIN, Turnstile-gated where they can send
 *            mail, and deliberately **neutral** in their responses — no
 *            endpoint ever reveals whether an address is on the list.
 *   webhook  /webhooks/resend — bounces and complaints suppress or delete.
 *   admin    /admin/* — bearer ADMIN_TOKEN, called only by the GitHub Action.
 *
 * Why the Action talks to D1 only through /admin/*: the Resend key and the
 * HMAC secret then live in exactly one place. The Action renders emails with
 * placeholder links, and /admin/send mints each recipient's tokens as it
 * hands the message to the provider — so a subscriber token never transits a
 * workflow run or a log.
 */

import ids from '../../ids.json';
import {
  MAX_SUBSCRIBERS,
  CONFIRM_TTL_S,
  MAGIC_TTL_S,
  RL_SUBSCRIBE_PER_IP_HOUR,
  RL_MAGIC_PER_EMAIL_HOUR,
  RL_NEW_SUBS_PER_DAY,
  SEND_CHUNK,
  EVENT_RETENTION_DAYS,
} from '../../config.mjs';
import {
  mintToken,
  verifyToken,
  normalizeEmail,
  isPlausibleEmail,
  randomNonce,
  sha256Hex,
  constantTimeEqual,
} from '../../tokens.mjs';
import { renderConfirm, renderMagic } from '../../render.mjs';
import { NOTIFY_KINDS, parseNotify, serializeNotify } from '../../match.mjs';
import { personalize, recipientState } from '../../send.mjs';
import { consume, magicUsedBucket, MAGIC_USED_WINDOW_S } from '../../ratelimit.mjs';
import { SQL as STATS_SQL, foldCadence, foldRegions, fillDays } from '../../stats.mjs';
import { sendEmail, sendBatch } from './mail.mjs';
import { verifyAccessJwt } from './access.mjs';
import { renderDashboard } from './dashboard.mjs';

const CONF_IDS = new Set(ids.conferences.map((c) => c.id));
const TOPIC_IDS = new Set(ids.topics.map((t) => t.id));
// Legacy single-value cadences, still accepted from an older cached page.
const CADENCES = new Set(['weekly', 'weekly_urgent', 'starred_changes', 'off']);
// What a subscription covers, independent of how often it sends.
const SCOPES = new Set(['all', 'starred']);

/**
 * An IANA timezone name, or null.
 *
 * Validated against the runtime's own zone list where available, because this
 * string is handed to Intl.DateTimeFormat at send time and a junk value would
 * otherwise surface as a rendering failure inside the digest loop.
 */
function cleanTz(value) {
  if (typeof value !== 'string' || !value || value.length > 64) return null;
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(value)) return null;
  try {
    // Throws on an unknown zone; cheaper and more current than a shipped list.
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------------- CORS */

function allowedOrigins(env) {
  const list = [env.SITE_ORIGIN];
  // The Astro dev server, so the signup form can be exercised locally.
  if (env.DEV) list.push('http://localhost:4321', 'http://127.0.0.1:4321');
  return list;
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin || !allowedOrigins(env).includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (body, { status = 200, request, env, extra = {} } = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(request ? corsHeaders(request, env) : {}),
      ...extra,
    },
  });

/** Errors are generic on purpose: never leak whether an address exists. */
const fail = (request, env, status, code) => json({ ok: false, error: code }, { status, request, env });

/* ------------------------------------------------------------- rate limiting */

/**
 * Increment a bucket and report whether the caller is still under the limit.
 * Buckets expire by wall clock (`reset`), and the daily maintenance call sweeps
 * the dead rows — so nothing accumulates and no IP is retained beyond an hour.
 */
async function rateLimit(env, bucket, limit, windowS) {
  const nowS = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare('SELECT count, reset FROM rl WHERE bucket = ?').bind(bucket).first();
  const verdict = consume(row, { limit, windowS, nowS });

  if (verdict.action === 'insert') {
    await env.DB.prepare(
      'INSERT INTO rl (bucket, count, reset) VALUES (?, 1, ?) ' +
        'ON CONFLICT(bucket) DO UPDATE SET count = 1, reset = excluded.reset',
    )
      .bind(bucket, verdict.next.reset)
      .run();
  } else if (verdict.action === 'bump') {
    await env.DB.prepare('UPDATE rl SET count = count + 1 WHERE bucket = ?').bind(bucket).run();
  }
  return verdict.allowed;
}

/** IPs are only ever stored hashed, salted with the HMAC secret, for an hour. */
async function ipBucket(request, env, prefix) {
  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  const hash = (await sha256Hex(`${ip}|${env.HMAC_SECRET}`)).slice(0, 32);
  return `${prefix}:${hash}:${Math.floor(Date.now() / 3_600_000)}`;
}

/* ---------------------------------------------------------------- Turnstile */

/**
 * Verify the Turnstile token server-side. Fails **closed**: a Worker deployed
 * without TURNSTILE_SECRET refuses signups rather than becoming an open relay
 * for confirmation emails to arbitrary addresses.
 */
async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return false;
  if (!token) return false;
  try {
    const form = new FormData();
    form.append('secret', env.TURNSTILE_SECRET);
    form.append('response', token);
    if (ip) form.append('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });
    const body = await res.json();
    return !!body.success;
  } catch {
    return false;
  }
}

/**
 * The stored `cadence` value for a request body.
 *
 * Accepts the new `notify: ['weekly','urgent']` array and, for a page cached
 * before this shipped, a legacy `cadence` string. Returns null when the caller
 * asked for nothing, which /subscribe rejects and /update treats as pause.
 */
function readNotify(body, fallback = null) {
  if (Array.isArray(body?.notify)) {
    const on = Object.fromEntries(NOTIFY_KINDS.map((k) => [k, body.notify.includes(k)]));
    const value = serializeNotify(on);
    return value === 'off' ? null : value;
  }
  if (typeof body?.cadence === 'string' && CADENCES.has(body.cadence)) {
    return body.cadence === 'off' ? null : body.cadence;
  }
  return fallback;
}

/* -------------------------------------------------------------------- utils */

const nowIso = () => new Date().toISOString();
const today = () => nowIso().slice(0, 10);

/** Keep only ids that exist in the shipped vocabulary; dedupe; cap the length. */
function cleanIds(list, allowed) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((v) => typeof v === 'string' && allowed.has(v)))].slice(0, 100);
}

/** Slugs arrive from the browser, so they are shape-checked, not trusted. */
function cleanSlugs(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((s) => typeof s === 'string' && /^[a-z0-9][a-z0-9-]{2,120}$/.test(s)))].slice(0, 500);
}

/** Paper snapshots mirror favorites.js's localStorage shape, field for field. */
function cleanPapers(list) {
  if (!Array.isArray(list)) return [];
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const out = [];
  const seen = new Set();
  for (const p of list.slice(0, 1000)) {
    if (!p || typeof p !== 'object') continue;
    const id = str(p.id, 120);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const snap = { id, title: str(p.title, 500), ws: str(p.ws, 120), wsName: str(p.wsName, 300) };
    if (typeof p.pdf === 'string') snap.pdf = p.pdf.slice(0, 500);
    out.push(snap);
  }
  return out;
}

async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

const getSubscriber = (env, email) =>
  env.DB.prepare('SELECT * FROM subscribers WHERE email = ?').bind(email).first();

/**
 * Resolve a bearer token to a live subscriber row. Returns null for every
 * failure mode — expired, wrong purpose, revoked nonce, deleted row — because
 * the caller's response is identical in all of them.
 */
async function authSubscriber(request, env, purpose) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return null;

  let payload;
  try {
    payload = await verifyToken(token, env.HMAC_SECRET, { purpose });
  } catch {
    return null;
  }
  const row = await getSubscriber(env, payload.e);
  if (!row || row.nonce !== payload.n) return null;
  return { row, payload, token };
}

/** Delete a subscriber and everything keyed to them. The GDPR erasure path. */
async function deleteSubscriber(env, email) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM subscribers WHERE email = ?').bind(email),
    env.DB.prepare('DELETE FROM urgent_log WHERE email = ?').bind(email),
  ]);
}

const redirect = (url) => new Response(null, { status: 302, headers: { Location: url, 'Cache-Control': 'no-store' } });

/**
 * Report a transactional send that failed.
 *
 * These endpoints answer neutrally whatever happens — they must, or they would
 * reveal who is subscribed — which means a provider outage, a rejected API key
 * or a bounce all look exactly like success from the outside. Without this line
 * the only symptom is a person saying "I never got the email", and nothing to
 * check. The provider's reason is logged; the recipient never is.
 */
async function logSend(kind, promise) {
  const result = await promise;
  if (!result?.ok) console.error(`send failed [${kind}]: ${result?.error ?? 'unknown'}`);
  return result;
}

/* ------------------------------------------------------- browser: /subscribe */

async function handleSubscribe(request, env) {
  const body = await readJson(request);
  if (!body) return fail(request, env, 400, 'bad_request');

  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (!(await verifyTurnstile(env, body.turnstile_token, ip))) {
    return fail(request, env, 403, 'captcha_failed');
  }

  const email = normalizeEmail(body.email);
  if (!isPlausibleEmail(email)) return fail(request, env, 400, 'invalid_email');

  if (!(await rateLimit(env, await ipBucket(request, env, 'sub'), RL_SUBSCRIBE_PER_IP_HOUR, 3600))) {
    return fail(request, env, 429, 'rate_limited');
  }

  const conferences = cleanIds(body.conferences, CONF_IDS);
  const topics = cleanIds(body.topics, TOPIC_IDS);
  const starred_ws = cleanSlugs(body.starred_ws);
  const starred_papers = cleanPapers(body.starred_papers);
  const cadence = readNotify(body, 'weekly');
  // Subscribing to nothing is a mistake, not a preference — confirming by
  // email and then never hearing anything is worse than a clear error.
  if (!cadence) return fail(request, env, 400, 'no_notifications');
  const scope = SCOPES.has(body.scope) ? body.scope : 'all';
  const tz = cleanTz(body.tz);

  const existing = await getSubscriber(env, email);
  const ts = nowIso();

  // Every path from here answers with exactly this sentence. Any variation is
  // an account-enumeration oracle: a prober who could tell "already subscribed"
  // from "not subscribed" learns whether an address is on the list.
  const NEUTRAL = json(
    { ok: true, message: 'Check your inbox to confirm your subscription.' },
    { request, env },
  );

  // Already confirmed. Two deliberate refusals here, both departing from
  // plan §4.4's "update prefs only":
  //
  //   1. **No unauthenticated write.** /subscribe carries no token, so honoring
  //      it would let anyone who knows an address silently reset that person's
  //      conferences, topics and cadence. Preference changes require a manage
  //      token; that is what /update is for.
  //   2. **No distinguishable response**, per the enumeration rule above.
  //
  // The legitimate case — someone re-submitting the form to change what they
  // get — is served by mailing a sign-in link instead, throttled on the same
  // per-address bucket as /magic-link so this cannot become a mail amplifier.
  if (existing && existing.confirmed_at) {
    if (!existing.suppressed_at &&
        (await rateLimit(env, `magic:${email}:${Math.floor(Date.now() / 3_600_000)}`, RL_MAGIC_PER_EMAIL_HOUR, 3600))) {
      const token = await mintToken(
        { email, nonce: existing.nonce, purpose: 'magic', ttlSeconds: MAGIC_TTL_S },
        env.HMAC_SECRET,
      );
      const magicUrl = `${env.SITE_ORIGIN}/saved/#t=${encodeURIComponent(token)}`;
      const mail = renderMagic({ magicUrl });
      await logSend('resubscribe-signin', sendEmail(env, { to: email, subject: mail.subject, html: mail.html, text: mail.text }));
    }
    return NEUTRAL;
  }

  if (!existing) {
    // Global daily brake, checked only on genuinely new addresses so a flood of
    // repeat signups can't lock out real ones.
    if (!(await rateLimit(env, `newsubs:${today()}`, RL_NEW_SUBS_PER_DAY, 86_400))) {
      return fail(request, env, 429, 'rate_limited');
    }
    const { total } = (await env.DB.prepare('SELECT COUNT(*) AS total FROM subscribers').first()) ?? { total: 0 };
    if (total >= MAX_SUBSCRIBERS) {
      return json(
        { ok: false, error: 'list_full', message: "The alert list is full right now — please try again in a while." },
        { status: 200, request, env },
      );
    }
    await env.DB.prepare(
      'INSERT INTO subscribers (email, nonce, conferences, topics, starred_ws, starred_papers, scope, tz, cadence, created, updated) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        email,
        randomNonce(),
        JSON.stringify(conferences),
        JSON.stringify(topics),
        JSON.stringify(starred_ws),
        JSON.stringify(starred_papers),
        scope,
        tz,
        cadence,
        ts,
        ts,
      )
      .run();
  } else {
    // Unconfirmed row: refresh the preferences and re-send the confirmation,
    // rate-limited exactly like a magic link.
    //
    // This one stays NEUTRAL, unlike /magic-link, and the difference matters.
    // Reaching here already means a row exists in an unconfirmed state — a
    // genuinely new address takes the insert path above — so reporting "too
    // many attempts" would answer a question the caller has no business asking.
    // /magic-link can report it because there the limit is applied to any
    // plausible address *before* any row is looked up.
    if (!(await rateLimit(env, `confirm:${email}:${Math.floor(Date.now() / 3_600_000)}`, RL_MAGIC_PER_EMAIL_HOUR, 3600))) {
      return NEUTRAL;
    }
    await env.DB.prepare(
      'UPDATE subscribers SET conferences = ?, topics = ?, starred_ws = ?, starred_papers = ?, scope = ?, tz = COALESCE(?, tz), cadence = ?, updated = ? WHERE email = ?',
    )
      .bind(
        JSON.stringify(conferences),
        JSON.stringify(topics),
        JSON.stringify(starred_ws),
        JSON.stringify(starred_papers),
        scope,
        tz,
        cadence,
        ts,
        email,
      )
      .run();
  }

  const row = await getSubscriber(env, email);
  const token = await mintToken(
    { email, nonce: row.nonce, purpose: 'confirm', ttlSeconds: CONFIRM_TTL_S },
    env.HMAC_SECRET,
  );
  const confirmUrl = `${new URL(request.url).origin}/confirm?token=${encodeURIComponent(token)}`;
  const mail = renderConfirm({ confirmUrl });
  await logSend('confirm', sendEmail(env, { to: email, subject: mail.subject, html: mail.html, text: mail.text }));

  // Neutral either way: a send failure must not tell a prober anything, and the
  // subscriber can simply sign up again.
  return NEUTRAL;
}

/* --------------------------------------------------------- browser: /confirm */

async function handleConfirm(request, env) {
  const token = new URL(request.url).searchParams.get('token') || '';
  let payload;
  try {
    payload = await verifyToken(token, env.HMAC_SECRET, { purpose: 'confirm' });
  } catch {
    return redirect(`${env.SITE_ORIGIN}/alerts/error/?e=link`);
  }
  const row = await getSubscriber(env, payload.e);
  if (!row || row.nonce !== payload.n) return redirect(`${env.SITE_ORIGIN}/alerts/error/?e=link`);

  if (!row.confirmed_at) {
    await env.DB.prepare('UPDATE subscribers SET confirmed_at = ?, updated = ? WHERE email = ?')
      .bind(nowIso(), nowIso(), payload.e)
      .run();
  }

  // The manage token rides in the URL **fragment**: fragments are never sent to
  // a server, so it stays out of access logs, referrers and analytics. The
  // static page reads it and stores it — that is what links this device.
  const manage = await mintToken({ email: payload.e, nonce: row.nonce, purpose: 'manage' }, env.HMAC_SECRET);
  return redirect(
    `${env.SITE_ORIGIN}/alerts/confirmed/#t=${encodeURIComponent(manage)}&e=${encodeURIComponent(payload.e)}`,
  );
}

/* ------------------------------------------------------ browser: /magic-link */

async function handleMagicLink(request, env) {
  const body = await readJson(request);
  if (!body) return fail(request, env, 400, 'bad_request');

  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (!(await verifyTurnstile(env, body.turnstile_token, ip))) {
    return fail(request, env, 403, 'captcha_failed');
  }

  const email = normalizeEmail(body.email);
  // Neutral about *existence*: an unknown address and a real one answer
  // identically, so this endpoint cannot enumerate subscribers.
  const neutral = json(
    { ok: true, message: 'If that address is subscribed, a sign-in link is on its way.' },
    { request, env },
  );
  if (!isPlausibleEmail(email)) return neutral;

  // Being throttled is NOT neutral, and pretending otherwise was a bug: the
  // caller was told a link was on its way when nothing had been sent, and the
  // natural response — click again — burned more budget for the same reassuring
  // lie. Safe to report, because the limit is applied to any plausible address
  // before the row is ever looked up, so this says nothing about who is
  // subscribed.
  if (!(await rateLimit(env, `magic:${email}:${Math.floor(Date.now() / 3_600_000)}`, RL_MAGIC_PER_EMAIL_HOUR, 3600))) {
    return json(
      {
        ok: false,
        error: 'rate_limited',
        message: 'Too many sign-in links requested for that address. Please try again in a few minutes.',
      },
      { status: 429, request, env },
    );
  }

  const row = await getSubscriber(env, email);
  if (row && row.confirmed_at && !row.suppressed_at) {
    const token = await mintToken(
      { email, nonce: row.nonce, purpose: 'magic', ttlSeconds: MAGIC_TTL_S },
      env.HMAC_SECRET,
    );
    // Sign-in links land on the saved list, not the preferences form: someone
    // signing in on a new device wants their list, and the page's sync line
    // links onward to manage. Any page can adopt a `#t=` token now that
    // scripts/alerts-session.js is loaded site-wide.
    const magicUrl = `${env.SITE_ORIGIN}/saved/#t=${encodeURIComponent(token)}`;
    const mail = renderMagic({ magicUrl });
    await logSend('magic-link', sendEmail(env, { to: email, subject: mail.subject, html: mail.html, text: mail.text }));
  }
  return neutral;
}

/* -------------------------------------------------------------- browser: /me */

/**
 * A `magic` token is accepted here exactly once and exchanged for a `manage`
 * token. Single use is enforced with a short-lived row in `rl` keyed by the
 * token's hash — deliberately not by rotating the nonce, which would also
 * unlink every other device the subscriber has already linked.
 */
async function handleMe(request, env) {
  const auth = await authSubscriber(request, env, ['manage', 'magic']);
  if (!auth) return fail(request, env, 401, 'unauthorized');
  const { row, payload, token } = auth;

  if (payload.p === 'magic') {
    // Limit 1 = single use. The row expires with the token itself and is
    // reclaimed by /admin/maintenance's sweep of expired `rl` rows.
    const key = magicUsedBucket((await sha256Hex(token)).slice(0, 40));
    const fresh = await rateLimit(env, key, 1, MAGIC_USED_WINDOW_S);
    if (!fresh) return fail(request, env, 401, 'unauthorized');
  }

  const manage =
    payload.p === 'magic'
      ? await mintToken({ email: row.email, nonce: row.nonce, purpose: 'manage' }, env.HMAC_SECRET)
      : null;
  const unsub = await mintToken({ email: row.email, nonce: row.nonce, purpose: 'unsub' }, env.HMAC_SECRET);

  return json(
    {
      ok: true,
      email: row.email,
      conferences: JSON.parse(row.conferences || '[]'),
      topics: JSON.parse(row.topics || '[]'),
      starred_ws: JSON.parse(row.starred_ws || '[]'),
      starred_papers: JSON.parse(row.starred_papers || '[]'),
      scope: row.scope || 'all',
      tz: row.tz || null,
      cadence: row.cadence,
      notify: parseNotify(row.cadence),
      confirmed: !!row.confirmed_at,
      // Present only on the magic exchange; the page swaps it into localStorage.
      ...(manage ? { manage_token: manage } : {}),
      unsubscribe_url: `${new URL(request.url).origin}/unsubscribe?token=${encodeURIComponent(unsub)}`,
    },
    { request, env },
  );
}

/* ---------------------------------------------------------- browser: /update */

async function handleUpdate(request, env) {
  const auth = await authSubscriber(request, env, 'manage');
  if (!auth) return fail(request, env, 401, 'unauthorized');
  const body = await readJson(request);
  if (!body) return fail(request, env, 400, 'bad_request');

  // A **partial** update: every field is optional, and an absent one is left
  // alone rather than reset. The preferences form sends all of them; the
  // background timezone refresh sends only `tz`, and must not have to echo the
  // rest back correctly — a field added later that it forgot to echo would
  // otherwise be silently wiped on every page load.
  const conferences = Array.isArray(body.conferences)
    ? JSON.stringify(cleanIds(body.conferences, CONF_IDS))
    : null;
  const topics = Array.isArray(body.topics) ? JSON.stringify(cleanIds(body.topics, TOPIC_IDS)) : null;
  const scope = SCOPES.has(body.scope) ? body.scope : null;
  const tz = cleanTz(body.tz);
  // Unchecking everything is exactly what pausing means — but only when the
  // caller actually sent a selection.
  const sentNotify = Array.isArray(body.notify) || typeof body.cadence === 'string';
  const cadence = sentNotify ? (readNotify(body, auth.row.cadence) ?? 'off') : null;

  await env.DB.prepare(
    'UPDATE subscribers SET conferences = COALESCE(?, conferences), topics = COALESCE(?, topics), ' +
      'scope = COALESCE(?, scope), tz = COALESCE(?, tz), cadence = COALESCE(?, cadence), updated = ? WHERE email = ?',
  )
    .bind(conferences, topics, scope, tz, cadence, nowIso(), auth.row.email)
    .run();
  // Report the row as it now stands, not just what this call changed.
  const row = await getSubscriber(env, auth.row.email);
  return json(
    {
      ok: true,
      conferences: JSON.parse(row.conferences || '[]'),
      topics: JSON.parse(row.topics || '[]'),
      scope: row.scope || 'all',
      tz: row.tz || null,
      cadence: row.cadence,
      notify: parseNotify(row.cadence),
    },
    { request, env },
  );
}

/* ------------------------------------------------------------ browser: /sync */

/**
 * Starred items added or removed.
 *
 * Accepts a single item (`slug` / `paper` / `id`) or a batch (`slugs` /
 * `papers`). The batch form exists because this endpoint reads the row,
 * modifies it and writes it back: firing N concurrent single-item calls would
 * have them all read the same starting row and the last write would win,
 * silently dropping the rest. Anything reconciling more than one item at a time
 * — notably the re-link merge in favorites.js — must send one request.
 *
 * Idempotent by construction: adding an existing slug and removing an absent
 * one are both no-ops, which is what lets callers fire and forget.
 */
async function handleSync(request, env) {
  const auth = await authSubscriber(request, env, 'manage');
  if (!auth) return fail(request, env, 401, 'unauthorized');
  const body = await readJson(request);
  if (!body) return fail(request, env, 400, 'bad_request');

  const { op, kind } = body;
  if (!['add', 'remove'].includes(op) || !['ws', 'paper'].includes(kind)) {
    return fail(request, env, 400, 'bad_request');
  }

  const col = kind === 'ws' ? 'starred_ws' : 'starred_papers';
  const current = JSON.parse(auth.row[col] || '[]');
  let next;

  if (kind === 'ws') {
    // Single or batch, validated by the same allowlist either way.
    const slugs = cleanSlugs(Array.isArray(body.slugs) ? body.slugs : [body.slug]);
    if (!slugs.length) return fail(request, env, 400, 'bad_request');
    if (op === 'add') {
      next = [...new Set([...current, ...slugs])];
    } else {
      const drop = new Set(slugs);
      next = current.filter((s) => !drop.has(s));
    }
  } else {
    const papers = cleanPapers(Array.isArray(body.papers) ? body.papers : [body.paper]);
    // Removal only needs ids; adding needs whole snapshots, since there is no
    // papers API to re-fetch a title from later (see favorites.js).
    const ids = papers.length
      ? papers.map((p) => p.id)
      : [Array.isArray(body.ids) ? body.ids : body.id].flat().filter((v) => typeof v === 'string').map((v) => v.slice(0, 120));
    if (!ids.length) return fail(request, env, 400, 'bad_request');
    if (op === 'add') {
      if (!papers.length) return fail(request, env, 400, 'bad_request');
      const incoming = new Set(papers.map((p) => p.id));
      next = [...current.filter((p) => p?.id && !incoming.has(p.id)), ...papers].slice(-1000);
    } else {
      const drop = new Set(ids);
      next = current.filter((p) => p?.id && !drop.has(p.id));
    }
  }

  await env.DB.prepare(`UPDATE subscribers SET ${col} = ?, updated = ? WHERE email = ?`)
    .bind(JSON.stringify(next), nowIso(), auth.row.email)
    .run();
  return json({ ok: true, count: next.length }, { request, env });
}

/* ----------------------------------------------------- browser: /unsubscribe */

/**
 * Unsubscribing **deletes the row** (decision D8) — the most privacy-friendly
 * reading of "unsubscribe", and the GDPR erasure path. Local stars survive on
 * the device; nothing about the site changes.
 *
 * POST is the RFC 8058 one-click target that mail clients call directly: no
 * body parsing, no confirmation page, plain-text 200.
 */
async function handleUnsubscribe(request, env) {
  const token = new URL(request.url).searchParams.get('token') || '';
  const post = request.method === 'POST';

  let payload = null;
  try {
    payload = await verifyToken(token, env.HMAC_SECRET, { purpose: ['unsub', 'manage'] });
  } catch {
    /* fall through to the neutral response below */
  }

  if (payload) {
    const row = await getSubscriber(env, payload.e);
    if (row && row.nonce === payload.n) await deleteSubscriber(env, payload.e);
  }

  // A one-click POST always reports success: mail clients show an error banner
  // otherwise, and an already-deleted row means the goal is met either way.
  if (post) {
    return new Response('Unsubscribed.\n', {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  return redirect(`${env.SITE_ORIGIN}/alerts/unsubscribed/`);
}

/* --------------------------------------------------------- webhook: /resend */

/**
 * Verify Resend's Svix-style webhook signature: HMAC-SHA256 over
 * `<id>.<timestamp>.<body>` with the base64 secret that follows `whsec_`.
 * The header can carry several space-separated `v1,<sig>` values during a
 * secret rotation, so any match counts.
 */
async function verifyResendSignature(env, request, raw) {
  const secret = env.RESEND_WEBHOOK_SECRET;
  if (!secret) return false;
  const id = request.headers.get('svix-id');
  const ts = request.headers.get('svix-timestamp');
  const sigHeader = request.headers.get('svix-signature');
  if (!id || !ts || !sigHeader) return false;

  // Reject replays of an old capture (5-minute tolerance, Svix's own default).
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(ts));
  if (!Number.isFinite(age) || age > 300) return false;

  const keyBytes = Uint8Array.from(atob(secret.replace(/^whsec_/, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${raw}`)));
  let expected = '';
  for (const b of mac) expected += String.fromCharCode(b);
  const expectedB64 = btoa(expected);

  // The header can carry several space-separated `v1,<sig>` values during a
  // secret rotation, so any match counts. Compared in constant time, like every
  // other signature check here.
  return sigHeader
    .split(' ')
    .map((part) => part.split(',')[1])
    .some((sig) => sig && constantTimeEqual(sig, expectedB64));
}

async function handleResendWebhook(request, env) {
  // Server-to-server only. A browser request carries an Origin header; the
  // signature check below already makes forgery infeasible, but refusing
  // browser origins outright keeps the rule uniform with /admin/* and removes
  // the endpoint from anything a page could reach at all.
  if (request.headers.get('Origin')) return new Response('forbidden', { status: 403 });

  const raw = await request.text();
  if (!(await verifyResendSignature(env, request, raw))) {
    return new Response('bad signature', { status: 401 });
  }

  let evt;
  try {
    evt = JSON.parse(raw);
  } catch {
    return new Response('ok', { status: 200 });
  }

  const type = evt?.type;
  const to = [].concat(evt?.data?.to ?? []).map(normalizeEmail).filter(Boolean);

  for (const email of to) {
    if (type === 'email.complained') {
      // A spam complaint is the strongest possible "stop" — delete, don't
      // suppress. Keeping the address on file after one would be indefensible.
      //
      // Log that it happened, because this deletion is the one nobody asks for.
      // Every other route to a missing row is someone acting deliberately — the
      // manage page's delete button, an unsubscribe link — and leaves the
      // person unsurprised. A complaint-driven delete does not: it can be
      // raised by an enterprise gateway on the recipient's behalf when it
      // quarantines a message, so an address the subscriber still wants can
      // vanish, and a whole domain can drain with nothing to point at. Every
      // endpoint here answers neutrally by design and will not admit an address
      // exists, so without this line there is no trail at all. The address
      // itself never reaches the log — only the domain.
      const [, domain = '?'] = email.split('@');
      console.log(`alerts webhook: complaint, deleting subscriber at @${domain}`);
      await deleteSubscriber(env, email);
    } else if (type === 'email.bounced' && (evt?.data?.bounce?.type ?? 'hard').toLowerCase() === 'hard') {
      await env.DB.prepare('UPDATE subscribers SET suppressed_at = ?, updated = ? WHERE email = ?')
        .bind(nowIso(), nowIso(), email)
        .run();
    }
  }

  // Always 200 for anything else: a webhook that 4xx's on unknown event types
  // gets retried forever and eventually disabled by the provider.
  return new Response('ok', { status: 200 });
}

/* ------------------------------------------------------------------- admin */

function adminOk(request, env) {
  // Admin endpoints are for the Action only. A browser request carries an
  // Origin header; refusing those means a stolen token still can't be used
  // from a page a subscriber was tricked into loading.
  if (request.headers.get('Origin')) return false;
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  // Constant-time: this is the one comparison standing between a guessed token
  // and the entire subscriber list.
  return !!env.ADMIN_TOKEN && !!token && constantTimeEqual(token, env.ADMIN_TOKEN);
}

async function handleAdmin(request, env, path) {
  const url = new URL(request.url);
  const method = request.method;

  /* ---- subscribers ------------------------------------------------------ */
  if (path === '/admin/subscribers' && method === 'GET') {
    const { results } = await env.DB.prepare(
      "SELECT email, nonce, conferences, topics, starred_ws, starred_papers, scope, tz, cadence, confirmed_at, suppressed_at " +
        "FROM subscribers WHERE confirmed_at IS NOT NULL AND suppressed_at IS NULL AND cadence != 'off'",
    ).all();
    return json({ ok: true, subscribers: results ?? [] });
  }

  /* ---- stats ------------------------------------------------------------ */
  //
  // What the dashboard runs on. Distinct from /admin/subscribers above in the
  // way that matters: that one returns addresses because the digest cannot be
  // sent without them, while nothing reachable from here selects one. The
  // queries live in alerts/stats.mjs so this and scripts/alerts_stats.mjs
  // cannot drift into disagreeing about how many people are subscribed, and a
  // test asserts none of them mentions `email`.
  if (path === '/admin/stats' && method === 'GET') {
    return json({ ok: true, stats: await collectStats(env, url.searchParams.get('days')) });
  }

  /* ---- snapshot --------------------------------------------------------- */
  if (path === '/admin/kv/snapshot') {
    if (method === 'GET') {
      const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'snapshot'").first();
      return json({ ok: true, snapshot: row ? JSON.parse(row.v) : null });
    }
    if (method === 'PUT') {
      const body = await readJson(request);
      if (!body?.snapshot) return json({ ok: false, error: 'bad_request' }, { status: 400 });
      await env.DB.prepare(
        "INSERT INTO kv (k, v) VALUES ('snapshot', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      )
        .bind(JSON.stringify(body.snapshot))
        .run();
      return json({ ok: true });
    }
  }

  /* ---- events ----------------------------------------------------------- */
  if (path === '/admin/events' && method === 'POST') {
    const body = await readJson(request);
    const items = Array.isArray(body?.items) ? body.items : null;
    if (!items) return json({ ok: false, error: 'bad_request' }, { status: 400 });
    const observed = typeof body.observed === 'string' ? body.observed : today();

    const stmt = env.DB.prepare(
      'INSERT INTO events (observed, slug, kind, old_utc, new_utc, days) VALUES (?, ?, ?, ?, ?, ?)',
    );
    // D1 batches are limited; chunk so a busy day can't exceed the statement cap.
    for (let i = 0; i < items.length; i += 50) {
      const chunk = items
        .slice(i, i + 50)
        .map((e) => stmt.bind(e.observed || observed, e.slug, e.kind, e.old_utc ?? null, e.new_utc ?? null, e.days ?? null));
      if (chunk.length) await env.DB.batch(chunk);
    }
    return json({ ok: true, inserted: items.length });
  }

  if (path === '/admin/events' && method === 'GET') {
    const since = url.searchParams.get('since') || '1970-01-01';
    const { results } = await env.DB.prepare(
      'SELECT observed, slug, kind, old_utc, new_utc, days FROM events WHERE observed >= ? ORDER BY id',
    )
      .bind(since.slice(0, 10))
      .all();
    return json({ ok: true, events: results ?? [] });
  }

  /* ---- urgent dedupe ---------------------------------------------------- */
  if (path === '/admin/urgent-filter' && method === 'POST') {
    const body = await readJson(request);
    const items = Array.isArray(body?.items) ? body.items : [];
    const out = [];
    for (const it of items) {
      const hit = await env.DB.prepare(
        'SELECT 1 AS x FROM urgent_log WHERE email = ? AND slug = ? AND deadline_utc = ?',
      )
        .bind(normalizeEmail(it.email), it.slug, it.deadline_utc)
        .first();
      if (!hit) out.push(it);
    }
    return json({ ok: true, items: out });
  }

  if (path === '/admin/urgent-log' && method === 'POST') {
    const body = await readJson(request);
    const items = Array.isArray(body?.items) ? body.items : [];
    const stmt = env.DB.prepare(
      'INSERT OR IGNORE INTO urgent_log (email, slug, deadline_utc, sent) VALUES (?, ?, ?, ?)',
    );
    for (let i = 0; i < items.length; i += 50) {
      const chunk = items
        .slice(i, i + 50)
        .map((it) => stmt.bind(normalizeEmail(it.email), it.slug, it.deadline_utc, nowIso()));
      if (chunk.length) await env.DB.batch(chunk);
    }
    return json({ ok: true, logged: items.length });
  }

  /* ---- send ------------------------------------------------------------- */
  if (path === '/admin/send' && method === 'POST') {
    const body = await readJson(request);
    const messages = Array.isArray(body?.messages) ? body.messages : null;
    if (!messages) return json({ ok: false, error: 'bad_request' }, { status: 400 });
    if (messages.length > SEND_CHUNK) return json({ ok: false, error: 'too_many' }, { status: 400 });

    const origin = url.origin;
    const prepared = [];
    const results = new Array(messages.length).fill(null);

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const email = normalizeEmail(m.to);
      const row = await getSubscriber(env, email);

      // Rendering happens minutes before sending, so honor an unsubscribe that
      // landed in between — the whole reason tokens are minted here and not in
      // the Action, which has no row to check.
      const state = recipientState(row);
      if (state !== 'ok') {
        results[i] = { ok: false, error: state };
        continue;
      }

      const unsubToken = await mintToken({ email, nonce: row.nonce, purpose: 'unsub' }, env.HMAC_SECRET);
      const manageToken = await mintToken({ email, nonce: row.nonce, purpose: 'manage' }, env.HMAC_SECRET);
      const unsubUrl = `${origin}/unsubscribe?token=${encodeURIComponent(unsubToken)}`;
      const manageUrl = `${env.SITE_ORIGIN}/alerts/manage/#t=${encodeURIComponent(manageToken)}`;

      // Substitute, then refuse anything still carrying a template placeholder
      // or missing its unsubscribe link. Refusing is reported per-message; it is
      // never a silent drop, and never a send.
      const built = personalize({ to: email, subject: m.subject, html: m.html, text: m.text }, { unsubUrl, manageUrl });
      if (!built.ok) {
        console.error(`admin/send refused a message: ${built.error}`);
        results[i] = { ok: false, error: built.error };
        continue;
      }

      prepared.push({ index: i, message: built.message });
    }

    const sent = await sendBatch(env, prepared.map((p) => p.message));
    prepared.forEach((p, k) => {
      results[p.index] = sent[k] ?? { ok: false, error: 'no_result' };
    });
    return json({ ok: true, results });
  }

  /* ---- maintenance ------------------------------------------------------ */
  if (path === '/admin/maintenance' && method === 'POST') {
    const cutoff = new Date(Date.now() - EVENT_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
    const rl = await env.DB.prepare('DELETE FROM rl WHERE reset <= ?').bind(Math.floor(Date.now() / 1000)).run();
    const ev = await env.DB.prepare('DELETE FROM events WHERE observed < ?').bind(cutoff).run();
    // Unconfirmed rows past the confirmation TTL are abandoned signups. Holding
    // an unconfirmed address indefinitely is exactly what double opt-in exists
    // to avoid, so they are deleted rather than kept.
    const stale = new Date(Date.now() - CONFIRM_TTL_S * 1000).toISOString();
    const un = await env.DB.prepare('DELETE FROM subscribers WHERE confirmed_at IS NULL AND created < ?')
      .bind(stale)
      .run();
    // urgent_log dedupes the 72h alert on (email, slug, deadline value). A row
    // older than the event retention concerns a deadline long passed, and
    // nothing else ever deletes it — the table only grew, one row per alert.
    const ur = await env.DB.prepare('DELETE FROM urgent_log WHERE sent < ?').bind(cutoff).run();
    return json({
      ok: true,
      rate_limit_rows: rl.meta?.changes ?? 0,
      events_pruned: ev.meta?.changes ?? 0,
      unconfirmed_pruned: un.meta?.changes ?? 0,
      urgent_log_pruned: ur.meta?.changes ?? 0,
    });
  }

  return json({ ok: false, error: 'not_found' }, { status: 404 });
}

/* ------------------------------------------------------------------- stats */

/**
 * Everything the dashboard shows, as aggregates.
 *
 * Shared by `/admin/stats` and `/dashboard` — the page renders server-side, so
 * it calls this directly rather than fetching its own endpoint.
 *
 * Traffic is fetched last and separately: GoatCounter is a third party, and a
 * dashboard that renders nothing because someone else's API is slow is worse
 * than one that shows the subscriber numbers with a note where the chart goes.
 */
async function collectStats(env, daysParam) {
  const days = Math.min(Math.max(Math.floor(Number(daysParam) || 30), 1), 365);
  const rows = async (sql) => (await env.DB.prepare(sql).all()).results ?? [];

  const [totals] = await rows(STATS_SQL.totals());
  const [mailableRow] = await rows(STATS_SQL.mailable());
  const [recentRow] = await rows(STATS_SQL.signupsSince(days));

  return {
    generated_at: nowIso(),
    days,
    totals: {
      total: totals?.total ?? 0,
      confirmed: totals?.confirmed ?? 0,
      pending: totals?.pending ?? 0,
      suppressed: totals?.suppressed ?? 0,
      paused: totals?.paused ?? 0,
      saved_only: totals?.saved_only ?? 0,
      with_tz: totals?.with_tz ?? 0,
      mailable: mailableRow?.n ?? 0,
    },
    recent_signups: recentRow?.n ?? 0,
    by_day: fillDays(await rows(STATS_SQL.signupsByDay(days)), days, today()),
    cadence: foldCadence(await rows(STATS_SQL.cadences())),
    regions: foldRegions(await rows(STATS_SQL.timezones())),
    traffic: await goatcounter(env),
  };
}

/**
 * Site traffic from GoatCounter.
 *
 * Server-side because the API token must never reach the page: anyone who ever
 * loaded the dashboard would otherwise be holding a credential to the analytics
 * account. Cached in `kv` for 15 minutes so refreshing costs nothing.
 *
 * Returns `{ error }` rather than throwing. Every caller renders the rest of
 * the page regardless — see the note on collectStats.
 */
async function goatcounter(env) {
  const token = env.GOATCOUNTER_TOKEN;
  const site = env.GOATCOUNTER_SITE;
  if (!token || !site) return { error: 'not_configured' };

  const CACHE_KEY = 'goatcounter';
  const CACHE_MS = 15 * 60 * 1000;
  try {
    const cached = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind(CACHE_KEY).first();
    if (cached) {
      const parsed = JSON.parse(cached.v);
      if (Date.now() - Date.parse(parsed.fetched_at) < CACHE_MS) return parsed.data;
    }
  } catch {
    /* a bad cache row must not take the dashboard down — refetch instead */
  }

  const end = today();
  const start = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  const call = async (p) => {
    const res = await fetch(`https://${site}.goatcounter.com/api/v0/${p}&start=${start}&end=${end}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`goatcounter ${p} -> ${res.status}`);
    return res.json();
  };

  let data;
  try {
    const [totals, pages, refs, locs] = await Promise.all([
      // Site-wide, and the only endpoint that is. `stats/hits` is *per path*:
      // its top-level `total` counts just the paths it returned, so with
      // limit=100 it reported 1358 against a real 1637, and its `stats` array
      // is one page's series rather than the site's.
      call('stats/total?'),
      call('stats/hits?limit=8'),
      call('stats/toprefs?limit=6'),
      call('stats/locations?limit=8'),
    ]);
    data = {
      by_day: (totals?.stats ?? []).map((s) => ({ day: s.day, n: s.daily ?? 0 })),
      total: totals?.total ?? 0,
      pages: (pages?.hits ?? []).map((h) => ({ path: h.path, n: h.count ?? 0 })),
      // An empty referrer name is traffic that arrived with no referer header —
      // a bookmark, a typed URL, a link from an app. "" would render as a blank
      // row, which reads as a bug rather than as the largest real category.
      referrers: (refs?.stats ?? []).map((s) => ({ name: s.name || 'direct / none', n: s.count ?? 0 })),
      locations: (locs?.stats ?? []).map((s) => ({ name: s.name, n: s.count ?? 0 })),
    };
  } catch (err) {
    // The message can carry a URL but never the token, which travels in a header.
    console.log(`dashboard: goatcounter unavailable (${err?.message ?? 'unknown'})`);
    return { error: 'unavailable' };
  }

  try {
    await env.DB.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .bind(CACHE_KEY, JSON.stringify({ fetched_at: nowIso(), data }))
      .run();
  } catch {
    /* caching is an optimisation; failing to cache is not failing */
  }
  return data;
}

/* ------------------------------------------------------------------ router */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });

    try {
      if (path.startsWith('/admin/')) {
        if (!adminOk(request, env)) return json({ ok: false, error: 'unauthorized' }, { status: 401 });
        return await handleAdmin(request, env, path);
      }

      // The maintainer's dashboard. Cloudflare Access authenticates this at the
      // edge, so an unauthenticated request should never arrive here at all —
      // and it is checked again anyway, because Access protects a *hostname*
      // while this check protects the *route*. See src/access.mjs.
      if (path === '/dashboard' && method === 'GET') {
        if (!(await verifyAccessJwt(request, env))) {
          return new Response('forbidden\n', {
            status: 403,
            headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
          });
        }
        return new Response(renderDashboard(await collectStats(env, url.searchParams.get('days'))), {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            // Aggregated subscriber data: never cached by a proxy, never stored.
            'Cache-Control': 'no-store, private',
            'Referrer-Policy': 'no-referrer',
            'X-Robots-Tag': 'noindex, nofollow',
          },
        });
      }

      if (path === '/webhooks/resend' && method === 'POST') return await handleResendWebhook(request, env);

      if (path === '/subscribe' && method === 'POST') return await handleSubscribe(request, env);
      if (path === '/confirm' && method === 'GET') return await handleConfirm(request, env);
      if (path === '/magic-link' && method === 'POST') return await handleMagicLink(request, env);
      if (path === '/me' && method === 'GET') return await handleMe(request, env);
      if (path === '/update' && method === 'POST') return await handleUpdate(request, env);
      if (path === '/sync' && method === 'POST') return await handleSync(request, env);
      if (path === '/unsubscribe' && (method === 'GET' || method === 'POST')) {
        return await handleUnsubscribe(request, env);
      }

      // Cheap liveness probe for the Action, and a sane response at the root.
      if (path === '/' || path === '/health') {
        return json({ ok: true, service: 'aiwt-alerts' }, { request, env });
      }

      return json({ ok: false, error: 'not_found' }, { status: 404, request, env });
    } catch (err) {
      // Error text can quote a query, and a query can carry an address, so the
      // response says nothing. The stack still reaches `wrangler tail`.
      console.error('alerts worker error', err?.stack || err?.message);
      return json({ ok: false, error: 'server_error' }, { status: 500, request, env });
    }
  },
};

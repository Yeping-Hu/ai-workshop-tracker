/**
 * Device-local favorites — star workshops & papers, no account needed.
 *
 * Everything lives in this browser's localStorage; nothing is sent to a
 * server. Two keys:
 *   awt-fav-workshops  ["<slug>", ...]            (slugs only — the saved
 *                       page re-fetches live data from /api/workshops.json,
 *                       so deadlines/status are never stale)
 *   awt-fav-papers     [{id,title,ws,wsName,pdf?}] (tiny snapshot — there
 *                       is no global papers JSON to re-fetch ~20k papers
 *                       from, and titles don't change). The saved page links
 *                       titles to /workshop/<ws>/#p-<id>; `pdf` is the exact
 *                       pdf_url when saved from a workshop page, absent when
 *                       saved from search results (derived at render time,
 *                       checked against /api/papers-without-pdf.json).
 *                       Pre-June-2026 snapshots carried a `url` field
 *                       instead; the saved page still renders those.
 *
 * Loaded on every page via Base.astro. Star buttons are plain <button>s
 * carrying data-star-ws="<slug>" or data-star-paper="<id>" (+ snapshot data
 * attributes); this module hydrates their state and handles clicks through
 * one delegated listener.
 *
 * OPTIONAL CROSS-DEVICE SYNC. If the visitor subscribed to email alerts and
 * linked this device, `awt-alerts-token` holds a signed token and the account
 * keeps a copy of the list. Everything above stays true regardless: the local
 * write happens first and is authoritative, a failed sync is never surfaced,
 * and someone who never subscribes runs the identical code path with
 * `alertsApi()` returning null.
 *
 * Two more keys exist only while linked:
 *   awt-fav-pending  the outbox — what this device has done that the account
 *                    may not know about yet. Star/unstar records intent here
 *                    and the reconcile drains it. Intent must be *recorded*,
 *                    not inferred from a diff: "I have it and the server
 *                    doesn't" cannot distinguish a star made offline from an
 *                    item another device deleted, which is how removals used
 *                    to get resurrected.
 *   awt-fav-synced   the account this device last reconciled with, so linking
 *                    a different account adopts its list instead of merging
 *                    the previous one into it.
 */

import {
  reconcileStars,
  notePending,
  normalizePending,
  emptyPending,
  capPending,
} from './star-merge.js';

const WS_KEY = 'awt-fav-workshops';
const P_KEY = 'awt-fav-papers';
const TOKEN_KEY = 'awt-alerts-token';
const PENDING_KEY = 'awt-fav-pending';
const SYNCED_KEY = 'awt-fav-synced';

function read(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return []; // storage blocked (some private modes) or corrupt — behave as empty
  }
}
function write(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
    return true;
  } catch {
    return false;
  }
}

export const favWorkshops = () => read(WS_KEY);
export const favPapers = () => read(P_KEY);

/* ---------------- optional alerts sync (no-op when not subscribed) --------- */

/** Worker base URL, published by Base.astro; absent when the feature is off. */
const alertsApi = () => document.querySelector('meta[name="alerts-api"]')?.content || null;
const alertsToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};

/* ---- the outbox: what this device has done that the account may not know --- */

const readPending = () => {
  try {
    return normalizePending(JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'));
  } catch {
    return emptyPending();
  }
};
const writePending = (p) => {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(capPending(p)));
  } catch {
    /* storage blocked: the immediate send below is then the only chance */
  }
};

/** Record a local star/unstar, then try to push it. */
function recordAndSync(entry) {
  writePending(notePending(readPending(), entry));
  flush();
}

/**
 * Send one /sync request.
 *
 * Deliberately fire-and-forget with a single retry: the local write already
 * succeeded, so blocking the UI on the network would make an optional feature
 * feel load-bearing. Nothing is retired from the outbox on success — see
 * reconcile() for why a 200 is not proof.
 */
function syncOp(op, kind, payload) {
  const api = alertsApi();
  const token = alertsToken();
  if (!api || !token) return Promise.resolve();
  const body = JSON.stringify({ op, kind, ...payload });
  const send = () =>
    fetch(`${api}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body,
      keepalive: true, // survives a click that navigates away
    });
  return send().catch(() => send().catch(() => {}));
}

/**
 * Drain the outbox, one request at a time.
 *
 * Serialized on purpose. /sync reads the subscriber row, edits it and writes it
 * back as separate statements, so two requests in flight together can each
 * return 200 while one silently overwrites the other — which is exactly what
 * starring several workshops in quick succession used to do.
 */
let flushChain = Promise.resolve();
function flush() {
  const api = alertsApi();
  const token = alertsToken();
  if (!api || !token) return flushChain;
  flushChain = flushChain
    .then(async () => {
      const p = readPending();
      const ops = [];
      if (p.addWs.length) ops.push(['add', 'ws', { slugs: p.addWs }]);
      if (p.removeWs.length) ops.push(['remove', 'ws', { slugs: p.removeWs }]);
      if (p.addPapers.length) ops.push(['add', 'paper', { papers: p.addPapers }]);
      if (p.removePapers.length) ops.push(['remove', 'paper', { ids: p.removePapers }]);
      for (const [op, kind, payload] of ops) await syncOp(op, kind, payload);
    })
    .catch(() => {});
  return flushChain;
}

/**
 * Reconcile this device's saved list with the account's.
 *
 *     local = (server ∪ pending.add) − pending.remove
 *
 * The rule and its reasoning live in star-merge.js, where they are unit-tested;
 * this function is the I/O around it. Two behaviours are worth knowing here:
 *
 * Pending is retired by **observation**, never by a 200 — an entry leaves the
 * outbox only once the server is seen holding the intended state. A write lost
 * to concurrency and a response lost to a dropped connection look identical
 * from the client, and both are then simply retried on the next load. /sync is
 * idempotent, so retrying is free.
 *
 * A 401 means the subscription is gone or the token was revoked, so the device
 * is unlinked rather than left claiming to be synced forever. The saved list
 * itself is untouched — it is the visitor's, and it predates the account.
 */
async function reconcile() {
  const api = alertsApi();
  const token = alertsToken();
  if (!api || !token) return;
  try {
    const res = await fetch(`${api}/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) {
      try {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem('awt-alerts-email');
      } catch {}
      return;
    }
    if (!res.ok) return;
    const me = await res.json();

    let syncedWith = null;
    try {
      syncedWith = localStorage.getItem(SYNCED_KEY);
    } catch {}
    const mode = !syncedWith ? 'first-link' : syncedWith === me.email ? 'normal' : 'account-switch';

    const { ws, papers, pending, uploads, changedLocal } = reconcileStars({
      localWs: favWorkshops(),
      serverWs: me.starred_ws || [],
      localPapers: favPapers(),
      serverPapers: me.starred_papers || [],
      pending: readPending(),
      mode,
    });

    writePending(pending);
    try {
      if (me.email) localStorage.setItem(SYNCED_KEY, me.email);
    } catch {}

    // Keep the account's timezone current. Alerts bake a local time in at send,
    // because email cannot run JS — so a stored zone would otherwise go stale
    // the moment someone moves. The browser always knows the live one, and this
    // already runs on every page load, so one call on the rare day it differs
    // keeps it right for nothing.
    let browserTz = null;
    try {
      browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch {}
    if (browserTz && browserTz !== me.tz) {
      fetch(`${api}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        // /update is a partial update: sending only `tz` leaves every
        // preference untouched.
        body: JSON.stringify({ tz: browserTz }),
        keepalive: true,
      }).catch(() => {});
    }

    if (changedLocal) {
      write(WS_KEY, ws);
      write(P_KEY, papers);
      hydrate();
      document.dispatchEvent(new CustomEvent('awt:favs-changed', { detail: { type: 'sync' } }));
    }

    // Sequential, for the same reason flush() is: parallel writes to one row
    // clobber each other.
    for (const u of uploads) await syncOp(u.op, u.kind, u.payload);
  } catch {
    /* offline or blocked — the local list is authoritative anyway */
  }
}

/** Anonymous usage signal (GoatCounter custom event) — fires only on ADD,
 *  so the dashboard shows whether the feature earns a real backend later. */
function track(path, title) {
  try {
    window.goatcounter?.count?.({ path, title, event: true });
  } catch {}
}

function setBtn(btn, on) {
  btn.textContent = on ? '★' : '☆';
  btn.classList.toggle('is-on', on);
  btn.setAttribute('aria-pressed', String(on));
  btn.title = on ? 'Remove from saved' : 'Save for later (stays in this browser)';
}

/** Paint every star button on the page to match storage. */
export function hydrate(root = document) {
  const ws = new Set(favWorkshops());
  const ps = new Set(favPapers().map((p) => p.id));
  for (const b of root.querySelectorAll('[data-star-ws]')) setBtn(b, ws.has(b.dataset.starWs));
  for (const b of root.querySelectorAll('[data-star-paper]')) setBtn(b, ps.has(b.dataset.starPaper));
  updateBadge();
}

function updateBadge() {
  const el = document.getElementById('navSavedCount');
  if (!el) return;
  const n = favWorkshops().length + favPapers().length;
  el.textContent = n ? String(n) : '';
  el.hidden = n === 0;
}

function announce(type, id, on) {
  updateBadge();
  document.dispatchEvent(new CustomEvent('awt:favs-changed', { detail: { type, id, on } }));
}

function toggleWorkshop(btn) {
  const slug = btn.dataset.starWs;
  let list = favWorkshops();
  const on = !list.includes(slug);
  list = on ? [...list, slug] : list.filter((s) => s !== slug);
  if (!write(WS_KEY, list)) return storageFailed(btn);
  // A workshop can have several stars on one page (row + detail header).
  for (const b of document.querySelectorAll(`[data-star-ws="${CSS.escape(slug)}"]`)) setBtn(b, on);
  if (on) track('fav/star-workshop', slug);
  recordAndSync({ op: on ? 'add' : 'remove', kind: 'ws', slug });
  announce('workshop', slug, on);
}

function togglePaper(btn) {
  const id = btn.dataset.starPaper;
  let list = favPapers();
  const on = !list.some((p) => p.id === id);
  let snap = null;
  if (on) {
    snap = {
      id,
      title: btn.dataset.title || 'Untitled paper',
      ws: btn.dataset.ws || '',
      wsName: btn.dataset.wsname || '',
    };
    // Workshop pages know the true pdf_url (may be '' = paper has no PDF);
    // search results omit the attribute and the saved page derives it.
    if (btn.dataset.pdf !== undefined) snap.pdf = btn.dataset.pdf;
    list = [...list, snap];
  } else {
    list = list.filter((p) => p.id !== id);
  }
  if (!write(P_KEY, list)) return storageFailed(btn);
  for (const b of document.querySelectorAll(`[data-star-paper="${CSS.escape(id)}"]`)) setBtn(b, on);
  if (on) track('fav/star-paper', id);
  // Papers sync as the same snapshot shape localStorage holds — there is no
  // papers API to re-fetch ~20k titles from, so the snapshot IS the record.
  recordAndSync(on ? { op: 'add', kind: 'paper', paper: snap } : { op: 'remove', kind: 'paper', id });
  announce('paper', id, on);
}

function storageFailed(btn) {
  btn.title = "Couldn't save — this browser is blocking site storage (private mode?)";
  btn.classList.add('star-err');
  setTimeout(() => btn.classList.remove('star-err'), 1200);
}

// Module side effects can only run once per page even if this file is both
// loaded by Base.astro and imported by a page script — but guard anyway so a
// future double-include can't double-toggle every click.
if (!window.__awtFavsInit) {
  window.__awtFavsInit = true;
  // Dynamically rendered content (search results) calls this after injecting
  // star buttons so they pick up saved state.
  window.awtFavsHydrate = hydrate;
  // The /alerts/ pages call this immediately after storing a token, so linking
  // a device reconciles at once instead of waiting for the next page load.
  // Exposed rather than reimplemented: a second copy of the merge is how the
  // upload half went missing on the confirm page in the first place.
  window.awtFavsSync = reconcile;

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-star-ws],[data-star-paper]');
    if (!btn) return;
    e.preventDefault();
    if (btn.dataset.starWs != null) toggleWorkshop(btn);
    else togglePaper(btn);
  });

  // Another tab changed the list — repaint stars and badge here too.
  window.addEventListener('storage', (e) => {
    if (e.key === WS_KEY || e.key === P_KEY) {
      hydrate();
      document.dispatchEvent(new CustomEvent('awt:favs-changed', { detail: { type: 'sync' } }));
    }
  });

  // A star followed immediately by a click-through can outrun its own request.
  // `keepalive` lets an already-issued fetch finish after the page goes away;
  // this covers the gap before one was issued at all. pagehide rather than
  // unload, so it also fires when the page enters the back/forward cache.
  window.addEventListener('pagehide', () => {
    const p = readPending();
    if (p.addWs.length || p.removeWs.length || p.addPapers.length || p.removePapers.length) flush();
  });

  hydrate();

  // Reconcile with the account once per page load, after the local list has
  // already painted. Returns immediately for anyone who never linked a device.
  reconcile();
}

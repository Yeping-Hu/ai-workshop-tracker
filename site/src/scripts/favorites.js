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
 * linked this device, `awt-alerts-token` holds a signed token and every local
 * write is mirrored to the alerts Worker, fire-and-forget. Everything above
 * stays true regardless: the local write happens first and is authoritative,
 * a failed sync is never surfaced, and someone who never subscribes runs the
 * identical code path with `alertsApi()` returning null.
 */

import { mergeStars } from './star-merge.js';

const WS_KEY = 'awt-fav-workshops';
const P_KEY = 'awt-fav-papers';
const TOKEN_KEY = 'awt-alerts-token';

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

/**
 * Mirror one starring operation to the server. Deliberately fire-and-forget
 * with a single retry: the local write already succeeded, so a failure here
 * costs one device's copy of one star, and blocking the UI on it (or surfacing
 * an error) would make an optional feature feel load-bearing.
 */
function syncOp(op, kind, payload) {
  const api = alertsApi();
  const token = alertsToken();
  if (!api || !token) return;
  const body = JSON.stringify({ op, kind, ...payload });
  const send = () =>
    fetch(`${api}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body,
      keepalive: true, // survives a click that navigates away
    });
  // Returns a promise that always resolves. Star toggles ignore it — the local
  // write already succeeded and blocking the UI on the network would make an
  // optional feature feel load-bearing. The reconcile awaits it, so a caller
  // that then re-reads the server sees the upload rather than racing it.
  return send().catch(() => send().catch(() => {}));
}

/**
 * Reconcile this device's saved list with the server's, in both directions.
 *
 * Pulling alone is not enough. Anything starred while this device was unlinked
 * — before subscribing, or after "unlink this device" — never reached the
 * server, because syncOp() returns early without a token. Those items would
 * otherwise sit on one device forever while the manage page reported a smaller
 * number, with no way to reconcile short of unstarring and re-starring each.
 * So local-only items are uploaded here.
 *
 * The rule itself lives in star-merge.js and is unit-tested; this function is
 * only the I/O around it. Removals still propagate solely as explicit `remove`
 * operations — see that file for why union-without-tombstones is the deliberate
 * v1 choice.
 */
async function hydrateFromServer() {
  const api = alertsApi();
  const token = alertsToken();
  if (!api || !token) return;
  try {
    const res = await fetch(`${api}/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return; // includes 401: a revoked token just stops syncing
    const me = await res.json();

    const { ws, papers, uploadWs, uploadPapers, changedLocal } = mergeStars({
      localWs: favWorkshops(),
      serverWs: me.starred_ws || [],
      localPapers: favPapers(),
      serverPapers: me.starred_papers || [],
    });

    if (changedLocal) {
      write(WS_KEY, ws);
      write(P_KEY, papers);
      hydrate();
      document.dispatchEvent(new CustomEvent('awt:favs-changed', { detail: { type: 'sync' } }));
    }

    // Push what the server has never seen. One request per kind rather than one
    // per item: /sync reads the row, modifies it and writes it back, so
    // concurrent single-item calls would race and silently drop all but the
    // last. Awaited so a caller can trust the server afterwards.
    const uploads = [];
    if (uploadWs.length) uploads.push(syncOp('add', 'ws', { slugs: uploadWs }));
    if (uploadPapers.length) uploads.push(syncOp('add', 'paper', { papers: uploadPapers }));
    if (uploads.length) await Promise.all(uploads);
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
  syncOp(on ? 'add' : 'remove', 'ws', { slug });
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
  syncOp(on ? 'add' : 'remove', 'paper', on ? { paper: snap } : { id });
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
  window.awtFavsSync = hydrateFromServer;

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

  hydrate();

  // Pull the server's copy in once per page load, after the local list has
  // already painted. Returns immediately for anyone who never linked a device.
  hydrateFromServer();
}

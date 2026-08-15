/**
 * Reconciling this device's saved list with the account's copy.
 *
 * Split out of favorites.js so the rule is testable under `node` — it is pure,
 * touches no DOM and no storage (see scripts/alerts_starmerge_test.mjs).
 *
 * THE RULE. The server holds the truth; this device holds the truth *plus*
 * whatever it has done since it last reached the server:
 *
 *     local = (server ∪ pending.add) − pending.remove
 *
 * The earlier version inferred intent from a set difference instead — anything
 * this device had that the server lacked was uploaded. That cannot distinguish
 * "I starred this while offline" from "another device deleted this", so with
 * two devices every removal was resurrected: the second device re-uploaded the
 * item the first had just deleted. Intent has to be recorded, not deduced.
 *
 * PENDING IS RETIRED BY OBSERVATION, NOT BY A 200. An entry leaves the outbox
 * when the server is seen to hold the intended state, never because a POST
 * returned OK. /sync reads the row, edits it and writes it back as separate
 * statements, so two concurrent calls can each return 200 while one silently
 * overwrites the other; a dropped response has the same shape. Retiring on
 * observation makes both self-correcting — the next reconcile just retries, and
 * /sync is idempotent, so retrying costs nothing.
 *
 * MODES:
 *   'first-link'     this device has never synced: seed every local item as a
 *                    pending add so nothing it already had is lost.
 *   'normal'         steady state.
 *   'account-switch' a different account than last time: adopt its list
 *                    wholesale and drop pending, which belongs to the old one.
 *
 * Removals now propagate, so the old "a removal can be resurrected by another
 * device" limitation is gone. What remains is ordinary last-write-wins: two
 * devices editing the same item while one is offline resolve in sync order.
 */

const strings = (list) => (Array.isArray(list) ? list.filter((s) => typeof s === 'string') : []);
const withIds = (list) => (Array.isArray(list) ? list.filter((p) => p && typeof p.id === 'string' && p.id) : []);

/** Same members, ignoring order — length alone misses an equal-sized swap. */
function sameMembers(a, b) {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

export function emptyPending() {
  return { addWs: [], removeWs: [], addPapers: [], removePapers: [] };
}

/** Tolerate a missing or corrupt outbox the way read() tolerates bad JSON. */
export function normalizePending(p) {
  const e = emptyPending();
  if (!p || typeof p !== 'object') return e;
  return {
    addWs: strings(p.addWs),
    removeWs: strings(p.removeWs),
    addPapers: withIds(p.addPapers),
    removePapers: strings(p.removePapers),
  };
}

/**
 * @param mode  'first-link' | 'normal' | 'account-switch'
 * @returns {
 *   ws, papers,        // what to store locally
 *   pending,           // the outbox after retiring anything the server confirms
 *   uploads,           // [{op, kind, payload}] to send, in order
 *   changedLocal,      // whether the local lists actually differ now
 * }
 */
export function reconcileStars({
  localWs = [],
  serverWs = [],
  localPapers = [],
  serverPapers = [],
  pending,
  mode = 'normal',
}) {
  const localWsList = [...new Set(strings(localWs))];
  const serverWsList = [...new Set(strings(serverWs))];
  const localPaperList = withIds(localPapers);
  const serverPaperList = withIds(serverPapers);

  // A different account: its list is simply what this device now shows, and the
  // previous account's unsynced intent must not leak into it.
  if (mode === 'account-switch') {
    return {
      ws: serverWsList,
      papers: serverPaperList,
      pending: emptyPending(),
      uploads: [],
      changedLocal:
        !sameMembers(serverWsList, localWsList) ||
        !sameMembers(serverPaperList.map((p) => p.id), localPaperList.map((p) => p.id)),
    };
  }

  let pend = normalizePending(pending);

  // Never synced: everything here is intent the account has not seen yet.
  if (mode === 'first-link') {
    const serverWsSet = new Set(serverWsList);
    const serverIds = new Set(serverPaperList.map((p) => p.id));
    pend = {
      addWs: [...new Set([...pend.addWs, ...localWsList.filter((s) => !serverWsSet.has(s))])],
      removeWs: pend.removeWs,
      addPapers: [...pend.addPapers, ...localPaperList.filter((p) => !serverIds.has(p.id))].filter(
        (p, i, arr) => arr.findIndex((q) => q.id === p.id) === i,
      ),
      removePapers: pend.removePapers,
    };
  }

  const serverWsSet = new Set(serverWsList);
  const serverIds = new Set(serverPaperList.map((p) => p.id));

  // Retire intent the server has already satisfied. This is what makes a lost
  // write or a lost response harmless: anything not yet reflected stays pending
  // and is retried below.
  const addWs = pend.addWs.filter((s) => !serverWsSet.has(s));
  const removeWs = pend.removeWs.filter((s) => serverWsSet.has(s));
  const addPapers = pend.addPapers.filter((p) => !serverIds.has(p.id));
  const removePapers = pend.removePapers.filter((id) => serverIds.has(id));

  // local = (server ∪ add) − remove
  const removeWsSet = new Set(removeWs);
  const ws = [...serverWsList, ...addWs].filter(
    (s, i, arr) => arr.indexOf(s) === i && !removeWsSet.has(s),
  );

  const removePaperSet = new Set(removePapers);
  const byId = new Map();
  for (const p of serverPaperList) if (!removePaperSet.has(p.id)) byId.set(p.id, p);
  for (const p of addPapers) if (!removePaperSet.has(p.id)) byId.set(p.id, p);
  // A local snapshot wins over the server's for the same id: it may carry the
  // exact `pdf` url, which there is no papers API to re-derive later.
  for (const p of localPaperList) {
    if (removePaperSet.has(p.id)) continue;
    if (byId.has(p.id)) byId.set(p.id, p);
  }
  const papers = [...byId.values()];

  // Sent one at a time by the caller — /sync is read-modify-write, so parallel
  // calls would clobber each other exactly as concurrent toggles do.
  const uploads = [];
  if (addWs.length) uploads.push({ op: 'add', kind: 'ws', payload: { slugs: addWs } });
  if (removeWs.length) uploads.push({ op: 'remove', kind: 'ws', payload: { slugs: removeWs } });
  if (addPapers.length) uploads.push({ op: 'add', kind: 'paper', payload: { papers: addPapers } });
  if (removePapers.length) uploads.push({ op: 'remove', kind: 'paper', payload: { ids: removePapers } });

  const changedLocal =
    !sameMembers(ws, localWsList) ||
    !sameMembers(papers.map((p) => p.id), localPaperList.map((p) => p.id));

  return { ws, papers, pending: { addWs, removeWs, addPapers, removePapers }, uploads, changedLocal };
}

/** Record a local star/unstar in the outbox. The two lists stay exclusive. */
export function notePending(pending, { op, kind, slug, paper, id }) {
  const p = normalizePending(pending);
  if (kind === 'ws') {
    const s = slug;
    if (typeof s !== 'string' || !s) return p;
    p.addWs = p.addWs.filter((x) => x !== s);
    p.removeWs = p.removeWs.filter((x) => x !== s);
    if (op === 'add') p.addWs.push(s);
    else p.removeWs.push(s);
  } else {
    const pid = op === 'add' ? paper?.id : id ?? paper?.id;
    if (typeof pid !== 'string' || !pid) return p;
    p.addPapers = p.addPapers.filter((x) => x.id !== pid);
    p.removePapers = p.removePapers.filter((x) => x !== pid);
    if (op === 'add') {
      if (!paper) return p;
      p.addPapers.push(paper);
    } else {
      p.removePapers.push(pid);
    }
  }
  return p;
}

/**
 * Keep the outbox bounded. A device that can never reach the server would
 * otherwise grow it without limit; both bounds are far above any real list.
 */
export function capPending(pending, max = 500) {
  const p = normalizePending(pending);
  return {
    addWs: p.addWs.slice(-max),
    removeWs: p.removeWs.slice(-max),
    addPapers: p.addPapers.slice(-max),
    removePapers: p.removePapers.slice(-max),
  };
}

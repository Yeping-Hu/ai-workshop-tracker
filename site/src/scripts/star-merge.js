/**
 * Reconciling this device's saved list with the server's copy.
 *
 * Split out of favorites.js so the rule is testable under `node` — it is pure,
 * touches no DOM and no storage (see scripts/alerts_starmerge_test.mjs).
 *
 * The merge is a **union in both directions**:
 *
 *   - items the server has and this device doesn't are added locally;
 *   - items this device has and the server doesn't are uploaded.
 *
 * The second half is not decoration. Stars written while a device is unlinked
 * — before subscribing, after "unlink this device", or simply while logged out
 * — never reached the server, because the sync path returns early without a
 * token. A merge that only pulled would leave those stranded on one device
 * forever, with the manage page reporting a lower count than the saved page
 * and no way to reconcile short of unstarring and re-starring each one.
 *
 * Removals still propagate only as explicit `remove` operations, so the known
 * limitation is unchanged and deliberate: a removal made on device A while
 * offline can be resurrected by device B's next merge. Union-without-tombstones
 * was chosen for v1 because the failure it can produce (a star comes back) is
 * far cheaper than the one tombstones get wrong (a race quietly empties the
 * list). Uploading local-only items does not alter that trade — it makes the
 * union actually hold across devices, which is what it always claimed to do.
 */

/**
 * @param localWs       string[] slugs on this device
 * @param serverWs      string[] slugs the server holds
 * @param localPapers   [{id,…}] paper snapshots on this device
 * @param serverPapers  [{id,…}] paper snapshots the server holds
 * @returns {
 *   ws, papers,               // the merged lists to write locally
 *   uploadWs, uploadPapers,   // local-only items the server has not seen
 *   changedLocal              // whether the local lists actually differ now
 * }
 */
export function mergeStars({ localWs = [], serverWs = [], localPapers = [], serverPapers = [] }) {
  const localWsList = localWs.filter((s) => typeof s === 'string');
  const serverWsSet = new Set(serverWs.filter((s) => typeof s === 'string'));

  // Local order first, so a device's own list keeps the order its owner built.
  const ws = [...new Set([...localWsList, ...serverWsSet])];
  const uploadWs = localWsList.filter((s) => !serverWsSet.has(s));

  const byId = new Map();
  for (const p of localPapers) if (p && p.id) byId.set(p.id, p);
  const serverIds = new Set();
  for (const p of serverPapers) {
    if (!p || !p.id) continue;
    serverIds.add(p.id);
    // A local snapshot wins: it may carry a `pdf` field the server's copy lacks.
    if (!byId.has(p.id)) byId.set(p.id, p);
  }
  const papers = [...byId.values()];
  const uploadPapers = papers.filter((p) => !serverIds.has(p.id));

  const changedLocal = ws.length !== localWsList.length || papers.length !== localPapers.length;

  return { ws, papers, uploadWs, uploadPapers, changedLocal };
}

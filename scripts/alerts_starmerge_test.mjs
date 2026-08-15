#!/usr/bin/env node
/**
 * Tests for site/src/scripts/star-merge.js — reconciling a device's saved list
 * with the account's.
 *
 * Every case here comes from a real failure or a near miss, because each looked
 * like correct code:
 *
 *   - Unsave a workshop while signed in, refresh, and it came back. With two
 *     devices this was deterministic, not a race: the merge inferred intent
 *     from a set difference, so the *other* device saw the deleted item as
 *     "local-only, must upload" and put it straight back.
 *   - Unsave while unlinked, sign back in, and it came back — the same
 *     inference, with no token to record the removal.
 *   - A write lost to concurrency returns HTTP 200 like any other, so an outbox
 *     cleared on the response would drop intent that never landed.
 *   - An equal-sized swap (server removed one, added another) left the list the
 *     same length, and a length-based change check skipped the repaint.
 *
 * The invariant under test is convergence: after a reconcile and its uploads,
 * both sides hold the same set, and running it again does nothing.
 *
 * Pure logic — no DOM, no storage, no network.
 * Run: node scripts/alerts_starmerge_test.mjs
 */
import {
  reconcileStars,
  notePending,
  normalizePending,
  emptyPending,
  capPending,
} from '../site/src/scripts/star-merge.js';

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}
const eqSet = (a, b) => a.length === b.length && new Set([...a, ...b]).size === new Set(a).size;
const paper = (id, over = {}) => ({ id, title: `Paper ${id}`, ws: 'neurips-2026-x', wsName: 'X', ...over });
const ids = (list) => list.map((p) => p.id);

/** Apply a reconcile's uploads to a server state, the way /sync would. */
function applyUploads(server, uploads) {
  let ws = [...server.ws];
  let papers = [...server.papers];
  for (const u of uploads) {
    if (u.kind === 'ws' && u.op === 'add') ws = [...new Set([...ws, ...u.payload.slugs])];
    else if (u.kind === 'ws' && u.op === 'remove') ws = ws.filter((s) => !u.payload.slugs.includes(s));
    else if (u.kind === 'paper' && u.op === 'add') {
      const incoming = new Set(u.payload.papers.map((p) => p.id));
      papers = [...papers.filter((p) => !incoming.has(p.id)), ...u.payload.papers];
    } else if (u.kind === 'paper' && u.op === 'remove') {
      papers = papers.filter((p) => !u.payload.ids.includes(p.id));
    }
  }
  return { ws, papers };
}

/* ============ report 1: a removal must not be resurrected by another device */
{
  // The phone still holds X locally. It has no pending op for X — it never
  // touched it; the computer did. Under the old rule the phone re-uploaded X.
  const r = reconcileStars({
    localWs: ['a', 'b', 'X'],
    serverWs: ['a', 'b'], // the computer already removed X
    pending: emptyPending(),
    mode: 'normal',
  });
  check('report 1 — the other device drops the removed item', eqSet(r.ws, ['a', 'b']), JSON.stringify(r.ws));
  check('report 1 — and does NOT re-upload it', r.uploads.length === 0, JSON.stringify(r.uploads));
  check('report 1 — the local list is rewritten', r.changedLocal === true);
}

/* ================= report 2: unstar while unlinked, then sign back in */
{
  // No token while unlinked, so nothing was uploaded — but intent was recorded.
  const pending = notePending(emptyPending(), { op: 'remove', kind: 'ws', slug: 'X' });
  const r = reconcileStars({
    localWs: ['a', 'b'], // X already gone locally
    serverWs: ['a', 'b', 'X'], // the account still has it
    pending,
    mode: 'normal',
  });
  check('report 2 — the removal survives the sign-in', !r.ws.includes('X'), JSON.stringify(r.ws));
  check('report 2 — and is uploaded',
    r.uploads.some((u) => u.op === 'remove' && u.kind === 'ws' && u.payload.slugs.includes('X')));

  // Once the server applies it, the outbox empties and a second pass is inert.
  const server = applyUploads({ ws: ['a', 'b', 'X'], papers: [] }, r.uploads);
  const second = reconcileStars({ localWs: r.ws, serverWs: server.ws, pending: r.pending, mode: 'normal' });
  check('report 2 — the outbox retires once the server agrees', second.pending.removeWs.length === 0);
  check('report 2 — the second pass uploads nothing', second.uploads.length === 0);
  check('report 2 — and changes nothing', second.changedLocal === false);
}

/* ============ stars made while unlinked still reach the account (no regression) */
{
  const pending = notePending(emptyPending(), { op: 'add', kind: 'ws', slug: 'new' });
  const r = reconcileStars({ localWs: ['a', 'new'], serverWs: ['a'], pending, mode: 'normal' });
  check('a star made while unlinked survives', r.ws.includes('new'));
  check('...and is uploaded',
    r.uploads.some((u) => u.op === 'add' && u.payload.slugs?.includes('new')));
}

/* ================================= a lost write must not silently drop intent */
{
  // /sync read-modify-writes, so a concurrent call can clobber this one and
  // still return 200. Simulate: upload happens, server state unchanged.
  const pending = notePending(emptyPending(), { op: 'add', kind: 'ws', slug: 'lost' });
  const first = reconcileStars({ localWs: ['a', 'lost'], serverWs: ['a'], pending, mode: 'normal' });
  check('the item is queued for upload', first.uploads.length === 1);

  // The POST "succeeded" but the row never changed.
  const second = reconcileStars({
    localWs: first.ws,
    serverWs: ['a'], // unchanged — the write was lost
    pending: first.pending,
    mode: 'normal',
  });
  check('a lost write leaves the item pending', second.pending.addWs.includes('lost'));
  check('...and it is retried', second.uploads.some((u) => u.payload.slugs?.includes('lost')));
  check('...and the item stays visible locally meanwhile', second.ws.includes('lost'));

  // Third pass, this time the server takes it.
  const server = applyUploads({ ws: ['a'], papers: [] }, second.uploads);
  const third = reconcileStars({ localWs: second.ws, serverWs: server.ws, pending: second.pending, mode: 'normal' });
  check('once it lands, the outbox retires it', third.pending.addWs.length === 0);
  check('...and nothing more is sent', third.uploads.length === 0);
}

/* ======================================= first link: nothing already here is lost */
{
  const cases = [
    ['subset', ['a', 'b'], ['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd'], []],
    ['partial overlap', ['a', 'b', 'p1', 'p2'], ['a', 'b', 's1'], ['a', 'b', 'p1', 'p2', 's1'], ['p1', 'p2']],
    ['no overlap', ['p1', 'p2'], ['s1', 's2'], ['p1', 'p2', 's1', 's2'], ['p1', 'p2']],
  ];
  for (const [label, local, server, expectWs, expectUp] of cases) {
    const r = reconcileStars({ localWs: local, serverWs: server, pending: emptyPending(), mode: 'first-link' });
    check(`first link, ${label} — the union is kept`, eqSet(r.ws, expectWs), JSON.stringify(r.ws));
    const up = r.uploads.filter((u) => u.op === 'add').flatMap((u) => u.payload.slugs || []);
    check(`first link, ${label} — only device-only items upload`, eqSet(up, expectUp), JSON.stringify(up));

    // Converges after the upload.
    const after = applyUploads({ ws: server, papers: [] }, r.uploads);
    const again = reconcileStars({ localWs: r.ws, serverWs: after.ws, pending: r.pending, mode: 'normal' });
    check(`first link, ${label} — a second sign-in is a no-op`,
      again.uploads.length === 0 && again.changedLocal === false);
  }
}

/* ============================================ switching to a different account */
{
  const pending = notePending(emptyPending(), { op: 'add', kind: 'ws', slug: 'from-account-a' });
  const r = reconcileStars({
    localWs: ['from-account-a', 'also-a'],
    serverWs: ['belongs-to-b'],
    pending,
    mode: 'account-switch',
  });
  check('account switch — the new account\'s list is adopted', eqSet(r.ws, ['belongs-to-b']), JSON.stringify(r.ws));
  check('account switch — the old account\'s stars are NOT uploaded', r.uploads.length === 0);
  check('account switch — the old outbox is discarded', r.pending.addWs.length === 0);
  check('account switch — local is rewritten', r.changedLocal === true);
}

/* ================================= an equal-sized swap must still repaint */
{
  const r = reconcileStars({ localWs: ['a', 'gone'], serverWs: ['a', 'added'], pending: emptyPending(), mode: 'normal' });
  check('a same-length swap is detected as a change', r.changedLocal === true, JSON.stringify(r.ws));
  check('...and produces the server list', eqSet(r.ws, ['a', 'added']));

  const same = reconcileStars({ localWs: ['a', 'b'], serverWs: ['b', 'a'], pending: emptyPending(), mode: 'normal' });
  check('a reordered but identical list is not a change', same.changedLocal === false);
}

/* ------------------------------------------------------------------- papers */
{
  const localPapers = [paper('p1', { pdf: 'https://example.com/p1.pdf' }), paper('p-local')];
  const serverPapers = [paper('p1'), paper('p-server')];
  const pending = notePending(emptyPending(), { op: 'add', kind: 'paper', paper: paper('p-local') });

  const r = reconcileStars({ localPapers, serverPapers, pending, mode: 'normal' });
  check('papers reconcile by id', eqSet(ids(r.papers), ['p1', 'p-local', 'p-server']), JSON.stringify(ids(r.papers)));
  check('a local snapshot keeps its pdf url',
    r.papers.find((p) => p.id === 'p1').pdf === 'https://example.com/p1.pdf');
  check('the pending paper uploads',
    r.uploads.some((u) => u.kind === 'paper' && u.op === 'add' && ids(u.payload.papers).includes('p-local')));

  // Removing a paper propagates the same way workshops do.
  const rem = notePending(emptyPending(), { op: 'remove', kind: 'paper', id: 'p1' });
  const r2 = reconcileStars({ localPapers: [], serverPapers: [paper('p1')], pending: rem, mode: 'normal' });
  check('a removed paper stays removed', ids(r2.papers).length === 0);
  check('...and the removal uploads by id',
    r2.uploads.some((u) => u.kind === 'paper' && u.op === 'remove' && u.payload.ids.includes('p1')));

  // A paper deleted on another device disappears here, with no pending op.
  const r3 = reconcileStars({ localPapers: [paper('x')], serverPapers: [], pending: emptyPending(), mode: 'normal' });
  check('report 1 applies to papers too', r3.papers.length === 0 && r3.uploads.length === 0);
}

/* -------------------------------------------------------------- the outbox */
{
  let p = notePending(emptyPending(), { op: 'add', kind: 'ws', slug: 'x' });
  check('an add is recorded', eqSet(p.addWs, ['x']));
  p = notePending(p, { op: 'remove', kind: 'ws', slug: 'x' });
  check('unstarring the same item replaces the add', p.addWs.length === 0 && eqSet(p.removeWs, ['x']));
  p = notePending(p, { op: 'add', kind: 'ws', slug: 'x' });
  check('re-starring replaces the remove', eqSet(p.addWs, ['x']) && p.removeWs.length === 0);
  p = notePending(p, { op: 'add', kind: 'ws', slug: 'x' });
  check('recording the same op twice does not duplicate', p.addWs.length === 1);

  check('a corrupt outbox degrades to empty', normalizePending('{not json').addWs.length === 0);
  check('a missing outbox degrades to empty', normalizePending(undefined).removeWs.length === 0);
  check('junk entries are dropped',
    normalizePending({ addWs: ['ok', null, 7], addPapers: [null, { noId: 1 }] }).addWs.length === 1);

  const big = { addWs: Array.from({ length: 900 }, (_, i) => `s${i}`), removeWs: [], addPapers: [], removePapers: [] };
  check('the outbox is capped', capPending(big, 500).addWs.length === 500);
  check('the cap keeps the most recent', capPending(big, 500).addWs.at(-1) === 's899');
}

/* --------------------------------------------------------------- robustness */
{
  const empty = reconcileStars({ pending: emptyPending(), mode: 'normal' });
  check('all-empty input is safe', empty.ws.length === 0 && empty.papers.length === 0 && empty.changedLocal === false);

  const junk = reconcileStars({
    localWs: ['ok', null, 42],
    serverWs: [undefined, 'srv'],
    pending: emptyPending(),
    mode: 'normal',
  });
  check('non-string slugs are dropped', eqSet(junk.ws, ['srv']), JSON.stringify(junk.ws));

  const dup = reconcileStars({ localWs: ['a', 'a'], serverWs: ['a', 'a'], pending: emptyPending(), mode: 'normal' });
  check('duplicates collapse', dup.ws.length === 1);
}

console.log(failed === 0 ? '\nStar reconcile OK.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

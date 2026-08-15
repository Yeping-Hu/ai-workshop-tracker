#!/usr/bin/env node
/**
 * Tests for site/src/scripts/star-merge.js — reconciling a device's saved list
 * with the server's.
 *
 * Written after a real divergence. The sequence: unlink a device, star two more
 * workshops while unlinked, then sign back in. The stars made while unlinked
 * never reached the server, because the sync path returns early without a
 * token — and the merge only ever pulled, so they stayed on that one device
 * permanently. The manage page reported 20 while the saved page showed 22, and
 * a second device showed 20. Nothing errored; the two lists simply never
 * converged again.
 *
 * So the property under test is **convergence**: after a merge, whatever this
 * device knows and whatever the server knows are both accounted for, and the
 * caller is told exactly which items the server has not seen so it can upload
 * them. Merging twice must change nothing the second time.
 *
 * Pure logic — no DOM, no storage, no network.
 * Run: node scripts/alerts_starmerge_test.mjs
 */
import { mergeStars } from '../site/src/scripts/star-merge.js';

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}
const eqSet = (a, b) => a.length === b.length && new Set(a).size === new Set([...a, ...b]).size;

const paper = (id, over = {}) => ({ id, title: `Paper ${id}`, ws: 'neurips-2026-x', wsName: 'X', ...over });

/* --------------------------------- the exact bug: starred while unlinked */
{
  // Server holds the 20 from before unlinking; this device has those plus two
  // starred while unlinked.
  const serverWs = Array.from({ length: 20 }, (_, i) => `ws-${i}`);
  const localWs = [...serverWs, 'ws-new-a', 'ws-new-b'];

  const r = mergeStars({ localWs, serverWs });
  check('the merged list keeps all 22', r.ws.length === 22, String(r.ws.length));
  check('the two unsynced stars are flagged for upload',
    eqSet(r.uploadWs, ['ws-new-a', 'ws-new-b']), JSON.stringify(r.uploadWs));
  check('nothing already on the server is re-uploaded', r.uploadWs.length === 2);
  check('the local list is unchanged, so no needless rewrite', r.changedLocal === false);

  // After the upload lands, a second merge must be a complete no-op.
  const after = mergeStars({ localWs: r.ws, serverWs: r.ws });
  check('once uploaded, merging again uploads nothing', after.uploadWs.length === 0);
  check('...and changes nothing locally', after.changedLocal === false);
}

/* ------------------------------------------- the other direction: a new device */
{
  const r = mergeStars({ localWs: [], serverWs: ['a', 'b', 'c'] });
  check('a fresh device pulls the whole server list', eqSet(r.ws, ['a', 'b', 'c']));
  check('and has nothing to upload', r.uploadWs.length === 0);
  check('and reports that local changed, so it gets written', r.changedLocal === true);
}

/* ------------------------------------------------------- both sides diverged */
{
  const r = mergeStars({ localWs: ['a', 'b', 'local-only'], serverWs: ['a', 'b', 'server-only'] });
  check('the union covers both sides', eqSet(r.ws, ['a', 'b', 'local-only', 'server-only']));
  check('only the local-only item is uploaded', eqSet(r.uploadWs, ['local-only']), JSON.stringify(r.uploadWs));
  check('local changed (it gained the server-only item)', r.changedLocal === true);

  // Convergence: apply the merge on both sides and re-run.
  const settled = mergeStars({ localWs: r.ws, serverWs: r.ws });
  check('the second pass is stable', settled.uploadWs.length === 0 && settled.changedLocal === false);
}

/* ------------------------------------------------------------------- papers */
{
  const localPapers = [paper('p1', { pdf: 'https://example.com/p1.pdf' }), paper('p-local')];
  const serverPapers = [paper('p1'), paper('p-server')];
  const r = mergeStars({ localPapers, serverPapers });

  check('papers merge by id', r.papers.length === 3, String(r.papers.length));
  check('the local-only paper is uploaded', eqSet(r.uploadPapers.map((p) => p.id), ['p-local']));
  // The local snapshot may carry a pdf url the server's copy lacks, and there
  // is no papers API to re-derive it from — so local wins on conflict.
  check('a local snapshot wins over the server copy for the same id',
    r.papers.find((p) => p.id === 'p1').pdf === 'https://example.com/p1.pdf');
  check('the server-only paper is pulled in', !!r.papers.find((p) => p.id === 'p-server'));
  check('papers changed locally', r.changedLocal === true);
}

/* ------------------------------------------------------ order and robustness */
{
  const r = mergeStars({ localWs: ['z', 'y'], serverWs: ['a'] });
  check('the device keeps its own ordering first', r.ws[0] === 'z' && r.ws[1] === 'y', JSON.stringify(r.ws));

  const empty = mergeStars({});
  check('all-empty input is safe', empty.ws.length === 0 && empty.papers.length === 0 && empty.changedLocal === false);

  const junk = mergeStars({
    localWs: ['ok', null, 42],
    serverWs: [undefined, 'srv'],
    localPapers: [null, { noId: true }, paper('good')],
    serverPapers: [{ id: null }],
  });
  check('non-string slugs are dropped', eqSet(junk.ws, ['ok', 'srv']), JSON.stringify(junk.ws));
  check('papers without an id are dropped', junk.papers.length === 1 && junk.papers[0].id === 'good');

  // Duplicates on either side must not inflate the list or the upload.
  const dup = mergeStars({ localWs: ['a', 'a', 'b'], serverWs: ['a'] });
  check('duplicates collapse', eqSet(dup.ws, ['a', 'b']));
  check('a duplicate is not uploaded twice', eqSet(dup.uploadWs, ['b']), JSON.stringify(dup.uploadWs));
}

console.log(failed === 0 ? '\nStar merge OK.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

/**
 * The DOI finder: a title or reference line -> candidate records from
 * Crossref and DataCite, each with its DOI, a copy button and a Cite link
 * into the BibTeX generator. A pasted DOI (or arXiv id) is resolved directly
 * instead of searched.
 */
import { classify } from '../../../../lib/identifiers.mjs';
import { formatName } from '../../../../lib/citations.mjs';
import { searchCrossref, searchDatacite, refFromInput } from './refs.js';
import { $, setStatus, copyText, used, escapeHtml } from './ui.js';

const base = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');
const form = $('#toolForm');
if (form) {
  const input = $('#toolInput');
  const status = $('#toolStatus');
  const go = $('#toolGo');
  const out = $('#toolOut');
  const list = $('#toolList');

  const authorsLine = (ref) => {
    const names = (ref.authors || []).filter((n) => n.literal !== 'others').map((n) => formatName(n, 'given-family'));
    if (!names.length) return '';
    return names.length > 4 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
  };
  const venue = (ref) => ref.journal || ref.booktitle || ref.publisher || '';

  // A record with a venue (a journal, proceedings, book or preprint server)
  // is what a searcher wants; a bare deposit with a title and a publisher is
  // usually a reference-list entry some member registered as a work, and a
  // famous title has dozens of those. So: venued records first in registry
  // order, then arXiv preprints, then the orphans; and one row per title and
  // first author, with the rest counted, not listed.
  const hasVenue = (r) => !!(r.ref.journal || r.ref.booktitle || r.ref.eprint || ['book', 'phdthesis', 'techreport'].includes(r.ref.type));
  const tier = (r) => (r.ref.eprint ? 1 : hasVenue(r) ? 0 : 2);
  const dupKey = (r) => `${String(r.ref.title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}|${((r.ref.authors || [])[0] || {}).family || ''}`.toLowerCase();
  function rank(all) {
    const seenDoi = new Set();
    const byKey = new Map();
    for (const r of all) {
      const doi = (r.ref.doi || '').toLowerCase();
      if (!doi || seenDoi.has(doi)) continue;
      seenDoi.add(doi);
      const k = dupKey(r);
      const prev = byKey.get(k);
      if (!prev) byKey.set(k, { ...r, dupes: 0 });
      else if (tier(r) < tier(prev)) byKey.set(k, { ...r, dupes: prev.dupes + 1 });
      else prev.dupes++;
    }
    return [...byKey.values()].sort((a, b) => tier(a) - tier(b));
  }

  function row({ ref, source, dupes = 0 }) {
    const doi = ref.doi || '';
    const cite = `${base}/tools/bibtex-citation-generator/?q=${encodeURIComponent(doi)}`;
    const kind = ref.eprint ? 'preprint' : ref.journal || ref.booktitle ? '' : 'no venue on record';
    const extra = dupes ? `${dupes} more registration${dupes === 1 ? '' : 's'} of this title` : '';
    return `<li>
      <div class="cite-title">${escapeHtml(ref.title)}</div>
      <div class="cite-meta">${[escapeHtml(authorsLine(ref)), escapeHtml(venue(ref)), escapeHtml(ref.year || ''), escapeHtml(source), escapeHtml(kind), escapeHtml(extra)].filter(Boolean).map((s) => `<span>${s}</span>`).join('')}</div>
      <div class="cite-meta"><code>${escapeHtml(doi)}</code></div>
      <div class="cite-actions">
        <button class="btn secondary small" type="button" data-copy="${escapeHtml(doi)}">Copy DOI</button>
        <a class="btn secondary small" href="https://doi.org/${encodeURIComponent(doi).replace(/%2F/gi, '/')}" rel="noopener">Open</a>
        <a class="btn small" href="${cite}">Cite</a>
      </div>
    </li>`;
  }

  async function run() {
    const q = input.value.trim();
    if (!q) { setStatus(status, 'Paste a title or a reference first.', 'error'); return; }
    go.disabled = true;
    setStatus(status, 'Searching Crossref and DataCite…');
    list.innerHTML = '';
    out.hidden = true;
    try {
      const id = classify(q);
      let rows;
      if (id.kind === 'doi' || id.kind === 'arxiv') {
        rows = [{ ref: await refFromInput(q), source: id.kind === 'arxiv' ? 'arXiv (DataCite)' : 'DOI registry' }];
      } else {
        const [cr, dc] = await Promise.allSettled([searchCrossref(q), searchDatacite(q)]);
        if (cr.status === 'rejected' && dc.status === 'rejected') throw cr.reason;
        rows = rank([...(cr.status === 'fulfilled' ? cr.value : []), ...(dc.status === 'fulfilled' ? dc.value : [])]);
      }
      list.innerHTML = rows.map(row).join('');
      out.hidden = rows.length === 0;
      if (rows.length) used('doi-finder');
      setStatus(status, rows.length ? `${rows.length} match${rows.length === 1 ? '' : 'es'}. Check the authors and year before copying.` : 'No matching record. Try fewer words, or the exact title.', rows.length ? 'ok' : 'error');
    } catch (e) {
      setStatus(status, e.message || String(e), 'error');
    } finally {
      go.disabled = false;
    }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); run(); });
  list.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-copy]');
    if (!b) return;
    const ok = await copyText(b.dataset.copy);
    const label = b.textContent;
    b.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => { b.textContent = label; }, 1400);
  });
  const q = new URLSearchParams(location.search).get('q');
  if (q) { input.value = q; run(); }
}

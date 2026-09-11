/**
 * An exported file (RIS or NBIB text) -> BibTeX. The form's data-format says
 * which reader to use; the NBIB page also accepts PubMed ids, one per line,
 * which go through the shared lookup instead.
 */
import { parseRis } from '../../../../lib/ris.mjs';
import { parseNbib } from '../../../../lib/nbib.mjs';
import { toBibtex } from '../../../../lib/citations.mjs';
import { refsFromText } from './refs.js';
import { $, setStatus, bindCopy, download, readFile, used } from './ui.js';

const form = $('#toolForm');
if (form) {
  const slug = form.dataset.slug;
  const format = form.dataset.format;
  const input = $('#toolInput');
  const file = $('#toolFile');
  const status = $('#toolStatus');
  const go = $('#toolGo');
  const out = $('#toolOut');
  const bib = $('#toolBib');
  let lastBib = '';

  const looksLikeRecords = (t) => (format === 'ris' ? /^TY  - /m.test(t) : /^(PMID|TI|FAU)\s*- /m.test(t));

  async function run() {
    let text = input.value.trim();
    if (!text) {
      const picked = await readFile(file);
      if (picked) { text = picked.trim(); input.value = text; }
    }
    if (!text) { setStatus(status, `Paste ${format.toUpperCase()} text or pick a file first.`, 'error'); return; }
    go.disabled = true;
    setStatus(status, 'Converting…');
    try {
      let refs, errors;
      if (looksLikeRecords(text)) {
        ({ refs, errors } = format === 'ris' ? parseRis(text) : parseNbib(text));
      } else if (format === 'nbib') {
        ({ refs, errors } = await refsFromText(text, { allow: ['pmid'] }));
      } else {
        refs = []; errors = ['This does not look like RIS: no "TY  - " line found.'];
      }
      lastBib = refs.map((r) => toBibtex(r)).join('\n\n');
      bib.textContent = lastBib;
      out.hidden = refs.length === 0;
      if (refs.length) used(slug);
      const n = refs.length;
      if (errors.length) setStatus(status, `${n} record${n === 1 ? '' : 's'} converted. ${errors.join(' · ')}`, n ? 'ok' : 'error');
      else setStatus(status, `${n} record${n === 1 ? '' : 's'} converted.`, 'ok');
    } catch (e) {
      setStatus(status, e.message || String(e), 'error');
    } finally {
      go.disabled = false;
    }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); run(); });
  file?.addEventListener('change', async () => {
    const picked = await readFile(file);
    if (picked) { input.value = picked; run(); }
  });
  bindCopy($('#copyBib'), () => lastBib);
  $('#dlBib')?.addEventListener('click', () => {
    if (lastBib) download('references.bib', lastBib + '\n', 'application/x-bibtex;charset=utf-8');
  });
}

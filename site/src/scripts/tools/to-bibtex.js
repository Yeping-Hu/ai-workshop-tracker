/**
 * Identifier(s) -> BibTeX, for the generator page and its per-format pages
 * (DOI, ISBN, URL). One script, configured by the form's data attributes:
 *   data-slug    the tool, for the usage event
 *   data-kinds   comma-separated identifier kinds the page accepts
 *   data-styles  "1" to also show the entry in the four reference styles
 * `?q=` in the URL prefills the box and runs at once: the DOI finder's Cite
 * button lands here that way.
 */
import { refsFromText } from './refs.js';
import { toBibtex, formatApa, formatMla, formatIeee, formatAcm } from '../../../../lib/citations.mjs';
import { $, setStatus, bindCopy, download, used, escapeHtml, fileStem } from './ui.js';

const form = $('#toolForm');
if (form) {
  const slug = form.dataset.slug;
  const allow = form.dataset.kinds ? form.dataset.kinds.split(',') : null;
  const input = $('#toolInput');
  const status = $('#toolStatus');
  const go = $('#toolGo');
  const out = $('#toolOut');
  const bib = $('#toolBib');
  const styles = $('#toolStyles');
  const urlTitle = $('#urlTitle');
  const urlAuthor = $('#urlAuthor');
  let lastBib = '';
  let lastRefs = [];

  async function run() {
    const text = input.value.trim();
    if (!text) { setStatus(status, 'Paste an identifier first.', 'error'); return; }
    go.disabled = true;
    setStatus(status, 'Looking up…');
    try {
      const { refs, errors } = await refsFromText(text, {
        allow,
        urlExtras: { title: urlTitle ? urlTitle.value : '', author: urlAuthor ? urlAuthor.value : '' },
      });
      lastRefs = refs;
      lastBib = refs.map((r) => toBibtex(r)).join('\n\n');
      bib.textContent = lastBib;
      out.hidden = refs.length === 0;
      if (styles) {
        if (refs.length >= 1 && refs.length <= 5 && form.dataset.styles === '1') {
          styles.hidden = false;
          const dl = $('dl', styles);
          dl.innerHTML = refs.map((r) => [['APA', formatApa(r)], ['MLA', formatMla(r)], ['IEEE', formatIeee(r)], ['ACM', formatAcm(r)]]
            .map(([name, f]) => `<dt>${name}</dt><dd class="cite-text">${f.html}</dd>`).join('')).join('');
        } else {
          styles.hidden = true;
        }
      }
      if (refs.length) used(slug);
      const n = refs.length;
      if (errors.length && n) setStatus(status, `${n} entr${n === 1 ? 'y' : 'ies'} generated; ${errors.length} line${errors.length === 1 ? '' : 's'} failed: ${errors.join(' · ')}`, 'error');
      else if (errors.length) setStatus(status, errors.join(' · '), 'error');
      else setStatus(status, `${n} entr${n === 1 ? 'y' : 'ies'} generated.`, 'ok');
    } catch (e) {
      setStatus(status, e.message || String(e), 'error');
    } finally {
      go.disabled = false;
    }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); run(); });
  input.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); } });
  bindCopy($('#copyBib'), () => lastBib);
  $('#dlBib')?.addEventListener('click', () => {
    if (!lastBib) return;
    const stem = lastRefs.length === 1 ? fileStem(lastRefs[0].key || toBibtex(lastRefs[0]).match(/\{([^,]+),/)?.[1]) : 'references';
    download(`${stem}.bib`, lastBib + '\n', 'application/x-bibtex;charset=utf-8');
  });

  const q = new URLSearchParams(location.search).get('q');
  if (q) { input.value = q; run(); }
  // Keep the HTML escape helper referenced for pages that render titles.
  void escapeHtml;
}

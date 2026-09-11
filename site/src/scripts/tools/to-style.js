/**
 * BibTeX (or identifiers) -> one reference style. The form's data-style picks
 * APA, MLA, IEEE or ACM; the input box takes BibTeX entries, an RIS or NBIB
 * export, or identifiers one per line, exactly like the generator. APA, MLA
 * and ACM lists are alphabetised by first author; IEEE keeps paste order and
 * numbers it, because an IEEE list is ordered by first citation.
 */
import { formatApa, formatMla, formatIeee, formatAcm } from '../../../../lib/citations.mjs';
import { refsFromText } from './refs.js';
import { $, setStatus, bindCopy, used } from './ui.js';

const STYLES = {
  apa: { name: 'APA', fmt: (r) => formatApa(r), sorted: true },
  mla: { name: 'MLA', fmt: (r) => formatMla(r), sorted: true },
  ieee: { name: 'IEEE', fmt: (r, i) => formatIeee(r, i + 1), sorted: false },
  acm: { name: 'ACM', fmt: (r) => formatAcm(r), sorted: true },
};

const form = $('#toolForm');
if (form) {
  const slug = form.dataset.slug;
  const style = STYLES[form.dataset.style] || STYLES.apa;
  const input = $('#toolInput');
  const status = $('#toolStatus');
  const go = $('#toolGo');
  const out = $('#toolOut');
  const list = $('#toolList');
  let items = [];

  const sortKey = (r) => {
    const a = r.authors && r.authors[0];
    return ((a && (a.family || a.literal)) || r.title || '').toLowerCase();
  };

  async function run() {
    const text = input.value.trim();
    if (!text) { setStatus(status, 'Paste BibTeX or an identifier first.', 'error'); return; }
    go.disabled = true;
    setStatus(status, 'Formatting…');
    try {
      const { refs, errors } = await refsFromText(text);
      const ordered = style.sorted ? [...refs].sort((a, b) => sortKey(a).localeCompare(sortKey(b))) : refs;
      items = ordered.map((r, i) => style.fmt(r, i));
      list.innerHTML = items.map((f) => `<li class="cite-text">${f.html}</li>`).join('');
      out.hidden = items.length === 0;
      if (items.length) used(slug);
      const n = items.length;
      if (errors.length) setStatus(status, `${n} reference${n === 1 ? '' : 's'} in ${style.name}. ${errors.join(' · ')}`, n ? 'ok' : 'error');
      else setStatus(status, `${n} reference${n === 1 ? '' : 's'} in ${style.name}.`, 'ok');
    } catch (e) {
      setStatus(status, e.message || String(e), 'error');
    } finally {
      go.disabled = false;
    }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); run(); });
  input.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); } });
  bindCopy($('#copyFormatted'), () => (items.length ? { html: items.map((f) => `<p>${f.html}</p>`).join(''), text: items.map((f) => f.text).join('\n\n') } : null), { html: true });
  bindCopy($('#copyPlain'), () => (items.length ? items.map((f) => f.text).join('\n\n') : ''));

  const q = new URLSearchParams(location.search).get('q');
  if (q) { input.value = q; run(); }
}

/** LaTeX word count page: TeXcount-style totals and a per-section table. */
import { countLatex } from '../../../../lib/texcount.mjs';
import { $, setStatus, readFile, used, escapeHtml } from './ui.js';

const form = $('#toolForm');
if (form) {
  const input = $('#toolInput');
  const file = $('#toolFile');
  const status = $('#toolStatus');
  const out = $('#toolOut');
  const stats = $('#toolStats');
  const table = $('#toolSections tbody');
  const notes = $('#toolNotes');
  let timer = null;

  const tile = (n, label, main = false) => `<div class="tool-stat${main ? ' is-main' : ''}"><b>${n.toLocaleString('en-US')}</b><span>${label}</span></div>`;

  function run() {
    const src = input.value;
    if (!src.trim()) { out.hidden = true; setStatus(status, ''); return; }
    const c = countLatex(src, { includeAppendix: $('#optAppendix').checked });
    stats.innerHTML = [
      tile(c.text, 'words in text', true),
      tile(c.headers, 'words in headers'),
      tile(c.captions, 'words in captions'),
      tile(c.footnotes, 'words in footnotes'),
      tile(c.total, 'words, all four'),
      tile(c.headerCount, 'headers'),
      tile(c.floats, 'floats (figures, tables)'),
      tile(c.mathInline, 'inline math'),
      tile(c.mathDisplay, 'displayed equations'),
    ].join('');
    table.innerHTML = c.sections.length
      ? c.sections.map((s) => `<tr><td>${'&nbsp;&nbsp;'.repeat(Math.max(0, s.level - 2))}${escapeHtml(s.title)}</td><td class="num">${s.words.toLocaleString('en-US')}</td></tr>`).join('')
      : `<tr><td>Whole text</td><td class="num">${c.text.toLocaleString('en-US')}</td></tr>`;
    notes.textContent = c.notes.join(' ');
    out.hidden = false;
    setStatus(status, `${c.text.toLocaleString('en-US')} words in the text.`, 'ok');
    used('latex-word-count');
  }

  const schedule = () => { clearTimeout(timer); timer = setTimeout(run, 250); };
  input.addEventListener('input', schedule);
  $('#optAppendix').addEventListener('change', run);
  form.addEventListener('submit', (e) => { e.preventDefault(); run(); });
  file?.addEventListener('change', async () => {
    const text = await readFile(file);
    if (text != null) { input.value = text; run(); }
  });
}

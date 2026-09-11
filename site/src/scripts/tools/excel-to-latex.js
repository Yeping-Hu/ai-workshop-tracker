/** Spreadsheet cells or CSV -> LaTeX table page: converts as you type. */
import { csvToLatex } from '../../../../lib/csv2tex.mjs';
import { $, setStatus, bindCopy, download, used } from './ui.js';

const form = $('#toolForm');
if (form) {
  const input = $('#toolInput');
  const status = $('#toolStatus');
  const out = $('#toolOut');
  const result = $('#toolResult');
  let last = '';
  let timer = null;

  function run() {
    const text = input.value;
    if (!text.trim()) { out.hidden = true; setStatus(status, ''); return; }
    const r = csvToLatex(text, {
      delimiter: $('#optDelim').value,
      header: $('#optHeader').checked,
      boldHeader: $('#optBold').checked,
      booktabs: $('#optBooktabs').checked,
      align: $('#optAlign').value,
      float: $('#optFloat').checked,
      caption: $('#optCaption').value,
      label: $('#optLabel').value,
    });
    last = r.latex;
    result.textContent = r.latex;
    out.hidden = !r.latex;
    const delim = r.delimiter === '\t' ? 'tab' : r.delimiter === ',' ? 'comma' : r.delimiter === ';' ? 'semicolon' : r.delimiter;
    setStatus(status, `${r.rows} row${r.rows === 1 ? '' : 's'}, ${r.cols} column${r.cols === 1 ? '' : 's'} (${delim}-separated).${r.packages.includes('booktabs') ? ' Add \\usepackage{booktabs}.' : ''}`, 'ok');
    used('excel-to-latex');
  }

  const schedule = () => { clearTimeout(timer); timer = setTimeout(run, 200); };
  input.addEventListener('input', schedule);
  for (const id of ['optDelim', 'optHeader', 'optBold', 'optBooktabs', 'optAlign', 'optFloat']) $(`#${id}`).addEventListener('change', run);
  for (const id of ['optCaption', 'optLabel']) $(`#${id}`).addEventListener('input', schedule);
  form.addEventListener('submit', (e) => { e.preventDefault(); run(); });
  bindCopy($('#copyOut'), () => last);
  $('#dlOut')?.addEventListener('click', () => { if (last) download('table.tex', last + '\n', 'application/x-tex;charset=utf-8'); });
}

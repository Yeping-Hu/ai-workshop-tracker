/** Markdown -> LaTeX page: converts as you type and on the button. */
import { markdownToLatex } from '../../../../lib/md2tex.mjs';
import { $, setStatus, bindCopy, download, used } from './ui.js';

const form = $('#toolForm');
if (form) {
  const input = $('#toolInput');
  const status = $('#toolStatus');
  const out = $('#toolOut');
  const result = $('#toolResult');
  const packages = $('#toolPackages');
  let last = '';
  let timer = null;

  function run() {
    const md = input.value;
    if (!md.trim()) { out.hidden = true; setStatus(status, ''); return; }
    const r = markdownToLatex(md, {
      wrap: $('#optWrap').checked,
      headingBase: $('#optHeading').value,
      booktabs: $('#optBooktabs').checked,
      listings: $('#optListings').checked,
    });
    last = r.latex;
    result.textContent = r.latex;
    out.hidden = false;
    packages.textContent = r.packages.length ? `Needs: ${r.packages.map((p) => `\\usepackage{${p}}`).join(' ')}` : 'No extra packages needed.';
    setStatus(status, r.warnings.length ? r.warnings.join(' ') : 'Converted.', r.warnings.length ? 'error' : 'ok');
    used('markdown-to-latex');
  }

  const schedule = () => { clearTimeout(timer); timer = setTimeout(run, 200); };
  input.addEventListener('input', schedule);
  for (const id of ['optWrap', 'optHeading', 'optBooktabs', 'optListings']) $(`#${id}`).addEventListener('change', run);
  form.addEventListener('submit', (e) => { e.preventDefault(); run(); });
  bindCopy($('#copyOut'), () => last);
  $('#dlOut')?.addEventListener('click', () => { if (last) download('document.tex', last + '\n', 'application/x-tex;charset=utf-8'); });
}

/**
 * CSV / TSV / pasted spreadsheet cells -> a LaTeX table.
 *
 * Excel, Google Sheets and Numbers all put tab-separated text on the
 * clipboard, so a paste from any of them is TSV; a .csv file is comma (or,
 * in much of Europe, semicolon) separated. The delimiter is detected from
 * the first line unless the caller fixes it. Cells are escaped for LaTeX,
 * with `$...$` left as math, and a column whose every body cell is a number
 * is right-aligned, which is what a results table wants without anyone
 * having to say so.
 */
import { escapeLatexKeepMath, escapeLatex } from './tex.mjs';

/** Split delimited text into rows of cells (RFC 4180 quoting). */
export function parseDelimited(text, delimiter = 'auto') {
  const src = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const delim = delimiter === 'auto' ? detectDelimiter(src) : delimiter === 'tab' ? '\t' : delimiter;
  const rows = [];
  let row = [], cell = '', inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') { inQuotes = true; continue; }
    if (ch === delim) { row.push(cell); cell = ''; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  // Drop trailing empty rows and trim every cell.
  const out = rows.map((r) => r.map((c) => c.trim()));
  while (out.length && out[out.length - 1].every((c) => c === '')) out.pop();
  return { rows: out, delimiter: delim };
}

/** Tab if the first line has one; else whichever of , ; | appears most. */
export function detectDelimiter(src) {
  const first = src.split('\n').find((l) => l.trim()) ?? '';
  if (first.includes('\t')) return '\t';
  const counts = [',', ';', '|'].map((d) => [d, (first.match(new RegExp(`\\${d}`, 'g')) || []).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

const NUMERIC = /^[+-]?(\d{1,3}(,\d{3})*|\d+)?(\.\d+)?%?$|^[+-]?\d+(\.\d+)?[eE][+-]?\d+$/;

/** 'l' or 'r' per column: right when every non-empty body cell is a number. */
export function inferAlignment(rows, header = true) {
  const body = header ? rows.slice(1) : rows;
  const cols = Math.max(0, ...rows.map((r) => r.length));
  const out = [];
  for (let c = 0; c < cols; c++) {
    const cells = body.map((r) => (r[c] ?? '').trim()).filter((v) => v !== '');
    out.push(cells.length && cells.every((v) => NUMERIC.test(v.replace(/[$]/g, ''))) ? 'r' : 'l');
  }
  return out;
}

/**
 * Rows -> LaTeX. Options:
 *   header      first row is a header (default true)
 *   booktabs    \toprule/\midrule/\bottomrule instead of \hline (default true)
 *   align       'auto' | 'l' | 'c' | 'r' | an explicit spec like 'lcr'
 *   boldHeader  wrap header cells in \textbf (default false)
 *   float       wrap in \begin{table}[position] with \centering (default true)
 *   caption, label, position ('htbp'), escape (default true; false passes cells through)
 */
export function tableToLatex(rows, opts = {}) {
  const o = { header: true, booktabs: true, align: 'auto', boldHeader: false, float: true, caption: '', label: '', position: 'htbp', escape: true, ...opts };
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const spec = o.align === 'auto' ? inferAlignment(rows, o.header).join('') : /^[lcr]$/.test(o.align) ? o.align.repeat(cols) : String(o.align).padEnd(cols, 'l').slice(0, cols);
  const cell = (v) => (o.escape ? escapeLatexKeepMath(v) : String(v ?? ''));
  const line = (r, bold) => Array.from({ length: cols }, (_, i) => {
    const v = cell(r[i] ?? '');
    return bold && v ? `\\textbf{${v}}` : v;
  }).join(' & ') + ' \\\\';
  const ind = o.float ? '    ' : '  ';
  const lines = [];
  if (o.booktabs) lines.push(`${ind}\\toprule`);
  else lines.push(`${ind}\\hline`);
  if (o.header && rows.length) {
    lines.push(`${ind}${line(rows[0], o.boldHeader)}`);
    lines.push(`${ind}${o.booktabs ? '\\midrule' : '\\hline'}`);
  }
  for (const r of o.header ? rows.slice(1) : rows) lines.push(`${ind}${line(r, false)}`);
  lines.push(`${ind}${o.booktabs ? '\\bottomrule' : '\\hline'}`);
  const tab = `${o.float ? '  ' : ''}\\begin{tabular}{${spec}}\n${lines.join('\n')}\n${o.float ? '  ' : ''}\\end{tabular}`;
  if (!o.float) return tab;
  const parts = [`\\begin{table}[${o.position}]`, '  \\centering'];
  if (o.caption) parts.push(`  \\caption{${escapeLatex(o.caption)}}`);
  if (o.label) parts.push(`  \\label{${o.label}}`);
  parts.push(tab, '\\end{table}');
  return parts.join('\n');
}

/** Text in, LaTeX out, with what was detected along the way. */
export function csvToLatex(text, opts = {}) {
  const { rows, delimiter } = parseDelimited(text, opts.delimiter ?? 'auto');
  if (!rows.length) return { latex: '', rows: 0, cols: 0, delimiter, packages: [] };
  const latex = tableToLatex(rows, opts);
  const packages = opts.booktabs === false ? [] : ['booktabs'];
  return { latex, rows: rows.length, cols: Math.max(...rows.map((r) => r.length)), delimiter, packages };
}

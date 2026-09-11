/**
 * Markdown -> LaTeX, for the notes-to-manuscript step.
 *
 * Covers what people actually write in a README, an Obsidian note or a
 * ChatGPT answer: ATX and setext headings, paragraphs, bold and italic,
 * inline code, fenced code, ordered and unordered lists (nested), block
 * quotes, links, images, tables, footnotes, horizontal rules and math
 * (`$...$`, `$$...$$`, and raw LaTeX environments, all passed through
 * untouched). Everything else is escaped so the output compiles.
 *
 * Deliberately not pandoc: pandoc is a 100 MB binary and cannot run in a
 * browser page; this is a few hundred lines that handle the common shape and
 * say what they could not handle in `warnings`.
 */
import { escapeLatex } from './tex.mjs';

const HEADINGS = {
  section: ['section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph', 'subparagraph'],
  chapter: ['chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'],
};

/**
 * Options:
 *   wrap         emit a complete document with a preamble (default false)
 *   headingBase  'section' (article) or 'chapter' (report/book)
 *   booktabs     tables with \toprule/\midrule/\bottomrule (default true)
 *   listings     fenced code as lstlisting instead of verbatim (default false)
 * Returns { latex, packages, warnings }.
 */
export function markdownToLatex(md, opts = {}) {
  const o = { wrap: false, headingBase: 'section', booktabs: true, listings: false, ...opts };
  const state = { packages: new Set(), warnings: new Set(), footnotes: new Map(), o };
  const src = String(md ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  // Footnote definitions can sit anywhere; collect them first.
  const lines = [];
  for (const line of src.split('\n')) {
    const fn = /^\[\^([^\]]+)\]:\s*(.*)$/.exec(line);
    if (fn) { state.footnotes.set(fn[1], fn[2]); continue; }
    lines.push(line);
  }
  const body = blocks(lines, state).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  const packages = [...state.packages];
  const latex = o.wrap ? wrapDocument(body, packages, o) : body;
  return { latex, packages, warnings: [...state.warnings] };
}

function wrapDocument(body, packages, o) {
  const cls = o.headingBase === 'chapter' ? 'report' : 'article';
  const uses = ['\\usepackage[utf8]{inputenc}', '\\usepackage[T1]{fontenc}', ...packages.map((p) => `\\usepackage{${p}}`)];
  return `\\documentclass{${cls}}\n${uses.join('\n')}\n\n\\begin{document}\n\n${body}\n\n\\end{document}\n`;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const ENV_OPEN = /^\s*\\begin\{([A-Za-z*]+)\}/;

function blocks(lines, state) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    // Fenced code.
    const fence = FENCE.exec(line);
    if (fence) {
      const [, , marker, lang] = fence;
      const code = [];
      i++;
      while (i < lines.length && !(lines[i].trim().startsWith(marker[0].repeat(3)) && lines[i].trim().replace(/[`~]/g, '') === '')) code.push(lines[i++]);
      i++; // closing fence
      out.push(codeBlock(code.join('\n'), lang, state));
      continue;
    }

    // Raw LaTeX environment: pass through to its \end.
    const env = ENV_OPEN.exec(line);
    if (env) {
      const name = env[1];
      const raw = [line];
      i++;
      while (i < lines.length && !lines[i].includes(`\\end{${name}}`)) raw.push(lines[i++]);
      if (i < lines.length) raw.push(lines[i++]);
      if (/^(equation|align|gather|multline|eqnarray|flalign|alignat)\*?$/.test(name)) state.packages.add('amsmath');
      out.push(raw.join('\n'));
      continue;
    }

    // Display math on its own lines.
    if (/^\s*\$\$\s*$/.test(line)) {
      const math = [];
      i++;
      while (i < lines.length && !/^\s*\$\$\s*$/.test(lines[i])) math.push(lines[i++]);
      i++;
      state.packages.add('amsmath');
      out.push(`\\[\n${math.join('\n')}\n\\]`);
      continue;
    }
    if (/^\s*\$\$.*\$\$\s*$/.test(line)) {
      state.packages.add('amsmath');
      out.push(`\\[ ${line.trim().slice(2, -2).trim()} \\]`);
      i++;
      continue;
    }

    // Headings.
    const h = HEADING.exec(line);
    if (h) { out.push(heading(h[1].length, h[2], state)); i++; continue; }
    if (i + 1 < lines.length && /^\s*=+\s*$/.test(lines[i + 1]) && line.trim()) { out.push(heading(1, line.trim(), state)); i += 2; continue; }
    if (i + 1 < lines.length && /^\s*-+\s*$/.test(lines[i + 1]) && line.trim() && !LIST_ITEM.test(line) && !HR.test(line)) { out.push(heading(2, line.trim(), state)); i += 2; continue; }

    // Horizontal rule.
    if (HR.test(line)) { out.push('\\noindent\\rule{\\linewidth}{0.4pt}'); i++; continue; }

    // Table: a row followed by a separator row.
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const rows = [line];
      i += 2;
      const sep = lines[i - 1];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(lines[i++]);
      out.push(table(rows, sep, state));
      continue;
    }

    // Block quote.
    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(QUOTE.exec(lines[i++])[1]);
      out.push(`\\begin{quote}\n${blocks(inner, state).join('\n\n')}\n\\end{quote}`);
      continue;
    }

    // List.
    if (LIST_ITEM.test(line)) {
      const chunk = [];
      while (i < lines.length && (LIST_ITEM.test(lines[i]) || (lines[i].trim() && /^\s+/.test(lines[i])) || (!lines[i].trim() && i + 1 < lines.length && (LIST_ITEM.test(lines[i + 1]) || /^\s{2,}\S/.test(lines[i + 1]))))) chunk.push(lines[i++]);
      out.push(list(chunk, state));
      continue;
    }

    // Paragraph: until a blank line or the start of another block.
    const para = [];
    while (i < lines.length && lines[i].trim() && !HEADING.test(lines[i]) && !FENCE.test(lines[i]) && !LIST_ITEM.test(lines[i]) && !QUOTE.test(lines[i]) && !HR.test(lines[i]) && !ENV_OPEN.test(lines[i]) && !/^\s*\$\$/.test(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]))) {
      para.push(lines[i++]);
    }
    if (!para.length) { i++; continue; }
    // A paragraph that is only an image becomes a figure.
    const img = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/.exec(para.join(' '));
    if (img) { out.push(figure(img[2], img[1], state)); continue; }
    out.push(paragraph(para, state));
  }
  return out;
}

function heading(level, text, state) {
  const names = HEADINGS[state.o.headingBase] || HEADINGS.section;
  const cmd = names[Math.min(level, names.length) - 1];
  return `\\${cmd}{${inline(text, state)}}`;
}

function paragraph(lines, state) {
  // Two trailing spaces (or a backslash) force a line break in Markdown.
  return lines.map((l, idx) => {
    const hard = /( {2,}|\\)$/.test(l) && idx < lines.length - 1;
    return inline(l.replace(/( {2,}|\\)$/, '').trim(), state) + (hard ? ' \\\\' : '');
  }).join('\n');
}

function codeBlock(code, lang, state) {
  if (state.o.listings) {
    state.packages.add('listings');
    const opt = lang ? `[language=${lstLanguage(lang)}]` : '';
    return `\\begin{lstlisting}${opt}\n${code}\n\\end{lstlisting}`;
  }
  return `\\begin{verbatim}\n${code}\n\\end{verbatim}`;
}

function lstLanguage(lang) {
  const map = { js: 'JavaScript', javascript: 'JavaScript', ts: 'JavaScript', py: 'Python', python: 'Python', c: 'C', cpp: 'C++', 'c++': 'C++', java: 'Java', sh: 'bash', bash: 'bash', shell: 'bash', r: 'R', matlab: 'Matlab', sql: 'SQL', html: 'HTML', xml: 'XML', tex: '[LaTeX]TeX', latex: '[LaTeX]TeX' };
  return map[lang.toLowerCase()] || lang;
}

function figure(src, alt, state) {
  state.packages.add('graphicx');
  const caption = alt ? `\n  \\caption{${inline(alt, state)}}` : '';
  return `\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=\\linewidth]{${src}}${caption}\n\\end{figure}`;
}

function table(rows, sep, state) {
  const split = (r) => {
    const cells = r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
    return cells;
  };
  const header = split(rows[0]);
  const aligns = split(sep).map((s) => (s.startsWith(':') && s.endsWith(':') ? 'c' : s.endsWith(':') ? 'r' : 'l'));
  const cols = Math.max(header.length, aligns.length);
  const spec = Array.from({ length: cols }, (_, i) => aligns[i] || 'l').join('');
  const rule = state.o.booktabs ? ['\\toprule', '\\midrule', '\\bottomrule'] : ['\\hline', '\\hline', '\\hline'];
  if (state.o.booktabs) state.packages.add('booktabs');
  const line = (cells) => Array.from({ length: cols }, (_, i) => inline(cells[i] ?? '', state)).join(' & ') + ' \\\\';
  const lines = [`\\begin{tabular}{${spec}}`, `  ${rule[0]}`, `  ${line(header)}`, `  ${rule[1]}`];
  for (const r of rows.slice(1)) lines.push(`  ${line(split(r))}`);
  lines.push(`  ${rule[2]}`, '\\end{tabular}');
  return lines.join('\n');
}

function list(lines, state) {
  // Flatten to items with their indentation; a continuation line joins the
  // item before it.
  const items = [];
  for (const line of lines) {
    const m = LIST_ITEM.exec(line);
    if (m) items.push({ indent: m[1].length, ordered: /^\d/.test(m[2]), text: m[3] });
    else if (items.length && line.trim()) items[items.length - 1].text += ' ' + line.trim();
  }
  let pos = 0;
  // Consecutive items at one indentation form a list; a deeper item becomes
  // the child list of the item before it; a change between bullets and
  // numbers at the same depth starts a new list.
  const build = (indent) => {
    const envs = [];
    let cur = null;
    while (pos < items.length && items[pos].indent >= indent) {
      const it = items[pos];
      if (it.indent > indent) {
        const sub = build(it.indent);
        if (cur && cur.items.length) cur.items[cur.items.length - 1].children.push(...sub);
        else envs.push(...sub);
        continue;
      }
      if (!cur || cur.ordered !== it.ordered) { cur = { ordered: it.ordered, items: [] }; envs.push(cur); }
      cur.items.push({ text: it.text, children: [] });
      pos++;
    }
    return envs;
  };
  const top = build(items.length ? items[0].indent : 0);
  const emit = (env, depth) => {
    const name = env.ordered ? 'enumerate' : 'itemize';
    const pad = '  '.repeat(depth);
    const body = env.items.map((it) => {
      const task = /^\[( |x|X)\]\s+/.exec(it.text);
      const text = task ? it.text.slice(task[0].length) : it.text;
      const mark = task ? (task[1] === ' ' ? '$\\square$ ' : '$\\boxtimes$ ') : '';
      if (task) state.packages.add('amssymb');
      const subs = it.children.map((c) => '\n' + emit(c, depth + 1)).join('');
      return `${pad}  \\item ${mark}${inline(text, state)}${subs}`;
    }).join('\n');
    return `${pad}\\begin{${name}}\n${body}\n${pad}\\end{${name}}`;
  };
  return top.map((e) => emit(e, 0)).join('\n');
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

/** Markdown inline text -> LaTeX. Code and math are protected, then markup
 *  is converted with placeholders so the remaining text can be escaped once. */
export function inline(text, state) {
  const hold = [];
  const keep = (latex) => { hold.push(latex); return `\u0000${hold.length - 1}\u0000`; };
  let s = String(text ?? '');
  // Inline code, then math: neither is markdown inside.
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (m, ticks, code) => keep(`\\texttt{${escapeLatex(code.trim())}}`));
  s = s.replace(/\$\$([^$]+)\$\$/g, (m, math) => { state.packages.add('amsmath'); return keep(`\\[ ${math.trim()} \\]`); });
  s = s.replace(/\$([^$\n]+)\$/g, (m, math) => keep(`$${math}$`));
  s = s.replace(/\\\(([^)]*?)\\\)/g, (m) => keep(m));
  // Images and links.
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt, src) => { state.packages.add('graphicx'); return keep(`\\includegraphics{${src}}`); });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, label, url) => { state.packages.add('hyperref'); return keep(`\\href{${url}}{${inline(label, state)}}`); });
  s = s.replace(/<(https?:\/\/[^>\s]+)>/g, (m, url) => { state.packages.add('hyperref'); return keep(`\\url{${url}}`); });
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s)<>]+)/g, (m, pre, url) => { state.packages.add('hyperref'); return pre + keep(`\\url{${url}}`); });
  // Footnotes.
  s = s.replace(/\[\^([^\]]+)\]/g, (m, id) => {
    const def = state.footnotes.get(id);
    if (def == null) { state.warnings.add(`Footnote [^${id}] has no definition.`); return keep(''); }
    return keep(`\\footnote{${inline(def, state)}}`);
  });
  // Emphasis: bold, then italic, then strikethrough.
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, (m, _, inner) => keep(`\\textbf{${inline(inner, state)}}`));
  s = s.replace(/(\*|_)(?=\S)([^*_\n]*?\S)\1(?![\w*_])/g, (m, _, inner) => keep(`\\emph{${inline(inner, state)}}`));
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, (m, inner) => { state.packages.add('ulem'); return keep(`\\sout{${inline(inner, state)}}`); });
  // Escape what is left, then put the protected pieces back.
  s = escapeLatex(s);
  // Typographic quotes the LaTeX way, on the prose only: code and math are
  // still placeholders here, so a quote inside \texttt{} is left alone.
  s = s.replace(/"([^"]*)"/g, "``$1''");
  s = s.replace(/\u0000(\d+)\u0000/g, (m, n) => hold[Number(n)]);
  return s;
}

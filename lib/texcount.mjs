/**
 * Word counts for a LaTeX source, in the categories TeXcount reports.
 *
 * A page limit is usually a word limit in disguise ("8 pages" is a page
 * limit, "250-word abstract" and "no more than 4,000 words" are what
 * journals and grant calls write), and the number people want is the one
 * TeXcount and Overleaf's built-in counter give: words in running text,
 * with headers, captions and footnotes counted separately, math and floats
 * counted as items, and comments, commands, citations, references, the
 * preamble and the bibliography left out.
 *
 * This is a pragmatic reimplementation of that, in the browser, from the
 * source alone. It does not expand macros or read \input files, and it says
 * so on the page. Everything here is pure string work, so
 * scripts/texcount_test.mjs pins each rule on small fixtures.
 */
import { matchBrace } from './tex.mjs';

const HEADER_CMDS = ['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'];
const FLOAT_ENVS = ['figure', 'figure*', 'table', 'table*', 'wrapfigure', 'wraptable', 'algorithm', 'algorithm*', 'algorithmic', 'subfigure', 'listing', 'lstlisting', 'minted', 'verbatim', 'tikzpicture', 'pgfpicture', 'tabular', 'tabular*', 'tabularx', 'longtable', 'sidewaystable', 'sidewaysfigure', 'framed', 'tcolorbox'];
const DISPLAY_ENVS = ['equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*', 'eqnarray', 'eqnarray*', 'displaymath', 'flalign', 'flalign*', 'alignat', 'alignat*', 'math'];
// Commands whose arguments are not prose: the whole thing goes.
const DROP_WITH_ARG = ['cite', 'citep', 'citet', 'citealp', 'citealt', 'citeauthor', 'citeyear', 'citeyearpar', 'parencite', 'textcite', 'autocite', 'footcite', 'nocite', 'ref', 'eqref', 'pageref', 'autoref', 'cref', 'Cref', 'nameref', 'label', 'includegraphics', 'input', 'include', 'url', 'bibliographystyle', 'bibliography', 'usepackage', 'documentclass', 'newcommand', 'renewcommand', 'providecommand', 'newenvironment', 'setlength', 'addtolength', 'vspace', 'vspace*', 'hspace', 'hspace*', 'pagestyle', 'thispagestyle', 'graphicspath', 'hypersetup', 'author', 'date', 'affiliation', 'affil', 'email', 'thanks', 'address', 'institute', 'orcid', 'keywords', 'acmConference', 'acmYear', 'copyrightyear', 'ccsdesc', 'newtheorem', 'theoremstyle', 'DeclareMathOperator', 'setcounter', 'addtocounter', 'numberwithin', 'lstset', 'definecolor', 'color', 'textcolor', 'pdfbookmark', 'phantomsection', 'acknowledgments', 'acks'];
// Commands with a text argument that is prose in its own right.
const UNWRAP = ['textbf', 'textit', 'emph', 'texttt', 'textsc', 'textsf', 'textrm', 'textmd', 'textup', 'textnormal', 'underline', 'uline', 'mbox', 'hbox', 'text', 'textsuperscript', 'textsubscript', 'sout', 'st', 'hl', 'highlight', 'MakeUppercase', 'MakeLowercase', 'lowercase', 'uppercase', 'centerline', 'small', 'footnotesize', 'scriptsize', 'large', 'Large', 'LARGE', 'huge', 'Huge', 'normalsize', 'title', 'abstract', 'gls', 'Gls', 'glspl', 'ac', 'acp', 'acs', 'acl', 'acf', 'href2'];

/**
 * Options: includeAppendix (default true), includeBibliography (always
 * false; the bibliography is never prose), includeAbstract (default true).
 */
export function countLatex(source, opts = {}) {
  const o = { includeAppendix: true, ...opts };
  const notes = [];
  let s = String(source ?? '').replace(/\r\n?/g, '\n');
  s = stripComments(s);

  // Only the document body is prose.
  const bd = s.indexOf('\\begin{document}');
  if (bd >= 0) {
    const ed = s.indexOf('\\end{document}', bd);
    s = s.slice(bd + '\\begin{document}'.length, ed >= 0 ? ed : undefined);
  }
  if (/\\(input|include)\{/.test(s)) notes.push('\\input and \\include files are not read; paste their contents to count them.');
  if (!o.includeAppendix) {
    const ap = s.search(/\\appendix\b/);
    if (ap >= 0) s = s.slice(0, ap);
  }
  // The bibliography is references, not prose.
  s = removeEnv(s, 'thebibliography');
  s = s.replace(/\\printbibliography(\[[^\]]*\])?/g, '');

  const counts = { text: 0, headers: 0, captions: 0, footnotes: 0, headerCount: 0, floats: 0, mathInline: 0, mathDisplay: 0 };
  const sections = [];

  // Display math first (its envs may sit inside floats or footnotes, but never contain them).
  for (const env of DISPLAY_ENVS) {
    s = replaceEnv(s, env, () => { counts.mathDisplay++; return ' '; });
  }
  s = s.replace(/\\\[[\s\S]*?\\\]/g, () => { counts.mathDisplay++; return ' '; });
  s = s.replace(/\$\$[\s\S]*?\$\$/g, () => { counts.mathDisplay++; return ' '; });

  // Floats: keep their captions as "other text", drop the rest.
  for (const env of FLOAT_ENVS) {
    s = replaceEnv(s, env, (inner) => {
      if (!['tabular', 'tabular*', 'tabularx', 'longtable', 'verbatim', 'lstlisting', 'minted', 'listing', 'tikzpicture', 'pgfpicture', 'algorithmic', 'framed', 'tcolorbox', 'subfigure'].includes(env)) counts.floats++;
      for (const cap of extractArgs(inner, ['caption', 'caption*'])) counts.captions += words(clean(cap));
      return ' ';
    });
  }
  // Captions outside a float environment (e.g. in a minipage).
  s = takeArgs(s, ['caption', 'caption*'], (cap) => { counts.captions += words(clean(cap)); });
  // Footnotes.
  s = takeArgs(s, ['footnote', 'footnotetext', 'marginpar'], (fn) => { counts.footnotes += words(clean(fn)); });

  // Headers: count them, and mark section boundaries for the per-section table.
  const MARK = '\u0007';
  s = takeArgs(s, [...HEADER_CMDS, ...HEADER_CMDS.map((h) => `${h}*`), 'title'], (arg, cmd) => {
    const title = clean(arg);
    counts.headers += words(title);
    if (cmd !== 'title') counts.headerCount++;
    sections.push({ level: HEADER_CMDS.indexOf(cmd.replace('*', '')), title, words: 0 });
  }, () => `${MARK}${sections.length - 1}${MARK}`);

  // Inline math.
  s = s.replace(/\\\([\s\S]*?\\\)/g, () => { counts.mathInline++; return ' '; });
  s = s.replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (m, pre) => { counts.mathInline++; return pre + ' '; });

  // Per-section text counts.
  const parts = s.split(new RegExp(`${MARK}(\\d+)${MARK}`));
  // parts: [preamble text, idx, text, idx, text, ...]
  const pre = words(clean(parts[0]));
  counts.text += pre;
  if (pre && sections.length) sections.unshift({ level: -1, title: '(before the first heading)', words: pre });
  for (let i = 1; i < parts.length; i += 2) {
    const idx = Number(parts[i]);
    const n = words(clean(parts[i + 1] ?? ''));
    const sec = sections.find((x, k) => k === idx + (sections[0]?.level === -1 ? 1 : 0));
    if (sec) sec.words = n;
    counts.text += n;
  }
  counts.total = counts.text + counts.headers + counts.captions + counts.footnotes;
  return { ...counts, sections, notes };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `%` comments (not `\%`), comment environments, and \iffalse ... \fi. */
export function stripComments(s) {
  s = s.replace(/\\begin\{comment\}[\s\S]*?\\end\{comment\}/g, ' ');
  s = s.replace(/\\iffalse[\s\S]*?\\fi/g, ' ');
  return s.replace(/(^|[^\\])%.*$/gm, '$1');
}

function envRegex(env) {
  const e = env.replace(/\*/g, '\\*');
  return new RegExp(`\\\\begin\\{${e}\\}(\\[[^\\]]*\\])?`, 'g');
}

/** Replace every `\begin{env}...\end{env}` (innermost-safe by scanning) with fn(inner). */
function replaceEnv(s, env, fn) {
  const open = envRegex(env);
  const closeTag = `\\end{${env}}`;
  let out = '';
  let last = 0;
  let m;
  while ((m = open.exec(s))) {
    const start = m.index;
    // Find the matching \end, allowing nesting of the same env.
    let depth = 1, pos = m.index + m[0].length;
    const openTag = `\\begin{${env}}`;
    while (depth > 0) {
      const nextOpen = s.indexOf(openTag, pos);
      const nextClose = s.indexOf(closeTag, pos);
      if (nextClose < 0) { pos = s.length; break; }
      if (nextOpen >= 0 && nextOpen < nextClose) { depth++; pos = nextOpen + openTag.length; }
      else { depth--; pos = nextClose + (depth === 0 ? 0 : closeTag.length); }
    }
    const innerEnd = pos;
    const end = pos >= s.length ? s.length : pos + closeTag.length;
    out += s.slice(last, start) + fn(s.slice(m.index + m[0].length, innerEnd));
    last = end;
    open.lastIndex = end;
  }
  return out + s.slice(last);
}

function removeEnv(s, env) {
  return replaceEnv(s, env, () => ' ');
}

/** Every argument of the named commands, without altering the source. */
function extractArgs(s, cmds) {
  const found = [];
  takeArgs(s, cmds, (arg) => found.push(arg));
  return found;
}

/**
 * For each `\cmd[opt]{arg}` (cmd in `cmds`, nested braces respected), call
 * `onArg(arg, cmd)` and replace the command with `replacement(arg, cmd)`
 * (default: nothing).
 */
function takeArgs(s, cmds, onArg, replacement = () => ' ') {
  const names = cmds.map((c) => c.replace(/\*/g, '\\*')).sort((a, b) => b.length - a.length).join('|');
  const re = new RegExp(`\\\\(${names})(?![A-Za-z])\\s*(\\[[^\\]]*\\])?\\s*\\{`, 'g');
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    const braceOpen = m.index + m[0].length - 1;
    const close = matchBrace(s, braceOpen);
    if (close < 0) break;
    const arg = s.slice(braceOpen + 1, close);
    onArg(arg, m[1]);
    out += s.slice(last, m.index) + replacement(arg, m[1]);
    last = close + 1;
    re.lastIndex = last;
  }
  return out + s.slice(last);
}

/** Strip the markup a prose fragment still carries, leaving words. */
export function clean(s) {
  let t = String(s ?? '');
  // \href{url}{text} keeps its text.
  t = takeArgs(t, ['href'], () => {}, (arg) => '');
  t = t.replace(/\\href\{[^}]*\}\{/g, '{');
  // Commands whose argument is not prose.
  t = takeArgs(t, DROP_WITH_ARG, () => {}, () => ' ');
  // Repeated so nested wrappers like \textbf{\emph{x}} unwrap fully.
  for (let i = 0; i < 4; i++) t = takeArgs(t, UNWRAP, () => {}, (arg) => ` ${arg} `);
  t = t.replace(/\\begin\{[^}]*\}(\[[^\]]*\])?(\{[^}]*\})?/g, ' ').replace(/\\end\{[^}]*\}/g, ' ');
  t = t.replace(/\\item(\[[^\]]*\])?/g, ' ');
  t = t.replace(/\\[A-Za-z@]+\*?(\[[^\]]*\])?/g, ' ');
  t = t.replace(/\\[^A-Za-z]/g, ' ');
  t = t.replace(/[{}]/g, ' ').replace(/~/g, ' ').replace(/---?/g, ' ');
  return t;
}

/** Tokens with at least one letter or digit. */
export function words(s) {
  const toks = String(s ?? '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  return toks.length;
}

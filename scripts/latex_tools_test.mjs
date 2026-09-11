#!/usr/bin/env node
/**
 * Pins the three LaTeX-side tools: the shared escaping rule, the CSV / TSV
 * table converter, the Markdown converter and the word counter. Each check
 * is a rule a tool page states in its FAQ, so the page and the code cannot
 * drift apart quietly.
 *
 * Run: node scripts/latex_tools_test.mjs
 */
import { escapeLatex, escapeLatexKeepMath, matchBrace } from '../lib/tex.mjs';
import { parseDelimited, detectDelimiter, inferAlignment, tableToLatex, csvToLatex } from '../lib/csv2tex.mjs';
import { markdownToLatex } from '../lib/md2tex.mjs';
import { countLatex, stripComments, words } from '../lib/texcount.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ''}`); }
}
const eq = (name, got, want) => check(name, got === want, `got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);

console.log('— escaping —');
eq('every special character', escapeLatex('a & b % c $ d # e _ f { g } h ~ i ^ j \\ k < l > m | n'), 'a \\& b \\% c \\$ d \\# e \\_ f \\{ g \\} h \\textasciitilde{} i \\textasciicircum{} j \\textbackslash{} k \\textless{} l \\textgreater{} m \\textbar{} n');
eq('math spans pass through', escapeLatexKeepMath('50% of $\\alpha_1$ & more'), '50\\% of $\\alpha_1$ \\& more');
eq('matchBrace walks nested braces', matchBrace('\\caption{A {B} C} tail', 8), 16);
eq('matchBrace ignores escaped braces', matchBrace('{a \\} b}', 0), 7);
eq('matchBrace reports an unclosed brace', matchBrace('{abc', 0), -1);

console.log('— CSV / TSV —');
eq('tab wins when present', detectDelimiter('a\tb,c\n1\t2,3'), '\t');
eq('semicolon when it is the majority', detectDelimiter('a;b;c\n1;2;3'), ';');
eq('comma by default', detectDelimiter('abc\n123'), ',');
const parsed = parseDelimited('Model,Acc,"Note, with comma"\nBERT,92.1,"say ""hi"""\n\n');
eq('quoted fields and doubled quotes', JSON.stringify(parsed.rows), JSON.stringify([['Model', 'Acc', 'Note, with comma'], ['BERT', '92.1', 'say "hi"']]));
eq('numeric columns right-align, text left', inferAlignment([['Model', 'Acc', 'N'], ['BERT', '92.1', '1,000'], ['GPT', '-3.5%', '2e3']]).join(''), 'lrr');
eq('an empty column is left-aligned', inferAlignment([['a', 'b'], ['1', ''], ['2', '']]).join(''), 'rl');
const csv = 'Model,Params (M),Acc,Note\nBERT-base,110,92.1,"has, comma"\nGPT-2,1500,95.0,$\\alpha$ & beta';
const out = csvToLatex(csv, { caption: 'Results & stuff', label: 'tab:res', boldHeader: true });
eq('rows and columns reported', `${out.rows}x${out.cols}|${out.delimiter}`, '3x4|,');
check('table float with centering, caption and label', out.latex.startsWith('\\begin{table}[htbp]\n  \\centering\n  \\caption{Results \\& stuff}\n  \\label{tab:res}\n  \\begin{tabular}{lrrl}'), out.latex);
check('booktabs rules', out.latex.includes('\\toprule') && out.latex.includes('\\midrule') && out.latex.includes('\\bottomrule'));
check('bold header cells', out.latex.includes('\\textbf{Model} & \\textbf{Params (M)}'));
check('cells escaped, math kept', out.latex.includes('GPT-2 & 1500 & 95.0 & $\\alpha$ \\& beta \\\\'), out.latex);
check('booktabs package reported', out.packages.includes('booktabs'));
const plain = csvToLatex('a\tb\n1\t2', { float: false, booktabs: false });
eq('no float, hline rules', plain.latex, '\\begin{tabular}{rr}\n  \\hline\n  a & b \\\\\n  \\hline\n  1 & 2 \\\\\n  \\hline\n\\end{tabular}');
eq('explicit alignment spec', tableToLatex([['a', 'b'], ['1', '2']], { float: false, align: 'c' }).split('\n')[0], '\\begin{tabular}{cc}');
eq('empty input', csvToLatex('').latex, '');

console.log('— Markdown to LaTeX —');
const md = `# Title with 100% & more

Intro with **bold**, *italic*, \`code_x "q"\`, a [link](https://example.com/a_b), math $E=mc^2$ and a note[^1].
Second line.

## Methods

- item one
- item two with _emph_
  - nested item
  - another nested
- item three

1. first
2. second

- [ ] todo
- [x] done

> A quote with a #hashtag

| Model | Acc (%) | Notes |
|:------|--------:|:-----:|
| BERT | 92.1 | base_model |

$$
\\int_0^1 x^2 dx
$$

\\begin{align}
a &= b
\\end{align}

\`\`\`python
print("hi")
\`\`\`

![A figure caption](fig/plot.png)

---

He said "hello" and <https://example.org>.

[^1]: The note text.
`;
const r = markdownToLatex(md, { wrap: true });
const L = r.latex;
check('document wrapper with the packages that were used', L.startsWith('\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage[T1]{fontenc}\n') && L.includes('\\begin{document}') && L.trim().endsWith('\\end{document}'), L.slice(0, 200));
check('packages: hyperref, booktabs, amsmath, graphicx, amssymb', ['hyperref', 'booktabs', 'amsmath', 'graphicx', 'amssymb'].every((p) => r.packages.includes(p)), r.packages.join(','));
check('heading escaped', L.includes('\\section{Title with 100\\% \\& more}'));
check('subsection', L.includes('\\subsection{Methods}'));
check('inline markup', L.includes('Intro with \\textbf{bold}, \\emph{italic}, \\texttt{code\\_x "q"}, a \\href{https://example.com/a_b}{link}, math $E=mc^2$ and a note\\footnote{The note text.}.'), L);
check('nested list', L.includes('\\begin{itemize}\n  \\item item one\n  \\item item two with \\emph{emph}\n  \\begin{itemize}\n    \\item nested item\n    \\item another nested\n  \\end{itemize}\n  \\item item three\n\\end{itemize}'), L);
check('ordered list is its own environment', L.includes('\\begin{enumerate}\n  \\item first\n  \\item second\n\\end{enumerate}'), L);
check('task list', L.includes('\\item $\\square$ todo') && L.includes('\\item $\\boxtimes$ done'));
check('block quote', L.includes('\\begin{quote}\nA quote with a \\#hashtag\n\\end{quote}'));
check('table with alignment from the separator row', L.includes('\\begin{tabular}{lrc}\n  \\toprule\n  Model & Acc (\\%) & Notes \\\\\n  \\midrule\n  BERT & 92.1 & base\\_model \\\\\n  \\bottomrule\n\\end{tabular}'), L);
check('display math', L.includes('\\[\n\\int_0^1 x^2 dx\n\\]'));
check('raw LaTeX environment passes through', L.includes('\\begin{align}\na &= b\n\\end{align}'));
check('fenced code becomes verbatim', L.includes('\\begin{verbatim}\nprint("hi")\n\\end{verbatim}'));
check('lone image becomes a figure', L.includes('\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=\\linewidth]{fig/plot.png}\n  \\caption{A figure caption}\n\\end{figure}'));
check('horizontal rule', L.includes('\\noindent\\rule{\\linewidth}{0.4pt}'));
check('quotes and autolink', L.includes("He said ``hello'' and \\url{https://example.org}."), L);
eq('no warnings', r.warnings.length, 0);
eq('chapter base shifts headings', markdownToLatex('# A\n\n## B', { headingBase: 'chapter' }).latex, '\\chapter{A}\n\n\\section{B}');
eq('setext headings', markdownToLatex('Title\n=====\n\nSub\n---').latex, '\\section{Title}\n\n\\subsection{Sub}');
check('listings option', markdownToLatex('```py\nx = 1\n```', { listings: true }).latex === '\\begin{lstlisting}[language=Python]\nx = 1\n\\end{lstlisting}');
check('undefined footnote is a warning, not a crash', markdownToLatex('a[^9]').warnings[0].includes('[^9]'));
eq('hard line break', markdownToLatex('line one  \nline two').latex, 'line one \\\\\nline two');
eq('fragment by default', markdownToLatex('plain').latex, 'plain');

console.log('— word count —');
const tex = `\\documentclass{article}
\\usepackage{amsmath} % a comment
\\title{A Study of Five Words}
\\begin{document}
\\maketitle
\\begin{abstract}
Abstract has four words.
\\end{abstract}
\\section{Introduction}
We cite \\cite{a,b} and refer to Figure~\\ref{fig:1}. This is \\textbf{bold text} with $x^2$ inline math and 50\\% done.
\\begin{equation}
E = mc^2
\\end{equation}
\\begin{figure}
\\includegraphics{x.png}
\\caption{Caption with \\emph{five} words here}
\\end{figure}
Second paragraph\\footnote{Footnote three words.} ends here. % trailing comment
\\subsection{Sub Section}
Three more words. See \\href{https://x.org}{the site} and \\input{more}.
\\begin{thebibliography}{9}
\\bibitem{a} Not counted words here.
\\end{thebibliography}
\\end{document}`;
const c = countLatex(tex);
eq('running text', c.text, 31);
eq('header words', c.headers, 3);
eq('caption words', c.captions, 5);
eq('footnote words', c.footnotes, 3);
eq('headers counted', c.headerCount, 2);
eq('floats counted', c.floats, 1);
eq('inline and display math counted, not as words', `${c.mathInline}/${c.mathDisplay}`, '1/1');
eq('total', c.total, 42);
eq('per-section table', c.sections.map((s) => `${s.title}:${s.words}`).join(','), '(before the first heading):4,Introduction:20,Sub Section:7');
check('\\input is flagged, not read', c.notes.some((n) => n.includes('\\input')));
eq('comments go, escaped percent stays', words(stripComments('50\\% done % not this\n%nor this')), 2);
eq('appendix can be excluded', countLatex('\\section{A}\nOne two.\n\\appendix\n\\section{B}\nThree four five.', { includeAppendix: false }).text, 2);
eq('appendix included by default', countLatex('\\section{A}\nOne two.\n\\appendix\n\\section{B}\nThree four five.').text, 5);
eq('no document environment counts everything', countLatex('Just \\textit{four} plain words.').text, 4);
eq('nested braces in a caption', countLatex('\\begin{figure}\\caption{One {two {three}} four}\\end{figure}').captions, 4);
eq('display math in dollars', countLatex('a $$x$$ b \\[ y \\] c').mathDisplay, 2);
eq('citations and refs are not words', countLatex('See \\citep{x} and \\cref{y} now').text, 3);
eq('itemize items count, markup does not', countLatex('\\begin{itemize}\\item one \\item two three\\end{itemize}').text, 3);
eq('Unicode words count', words('naïve café 東京 2024'), 4);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

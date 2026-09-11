/**
 * The one LaTeX text-escaping rule the /tools/ converters share.
 *
 * Markdown to LaTeX and the CSV table converter both have to turn plain text
 * into something LaTeX will typeset verbatim; if each had its own escape
 * table one would eventually forget `^` or `~`. Math segments ($...$) are
 * left untouched by `escapeLatexKeepMath`, because a pasted table cell like
 * `$\alpha$` is meant as math, not as three characters to escape.
 */

// A control character no caller uses for its own placeholders (md2tex uses
// U+0000, texcount U+0007).
const BS = '\u0006';
const ESCAPES = [
  // The backslash goes first, through a placeholder: its replacement carries
  // braces, and the brace rule below must not see them.
  [/\\/g, BS],
  [/([&%$#_{}])/g, '\\$1'],
  [/~/g, '\\textasciitilde{}'],
  [/\^/g, '\\textasciicircum{}'],
  [/</g, '\\textless{}'],
  [/>/g, '\\textgreater{}'],
  [/\|/g, '\\textbar{}'],
];

/** Escape every character LaTeX would read as markup. */
export function escapeLatex(text) {
  let s = String(text ?? '');
  for (const [re, rep] of ESCAPES) s = s.replace(re, rep);
  return s.split(BS).join('\\textbackslash{}');
}

/** Escape text but pass `$...$` spans through as math. */
export function escapeLatexKeepMath(text) {
  return String(text ?? '')
    .split(/(\$[^$]+\$)/)
    .map((part, i) => (i % 2 ? part : escapeLatex(part)))
    .join('');
}

/**
 * Index of the `}` that closes the `{` at `open`, or -1. Backslash-escaped
 * braces (`\{`) do not count. Shared by the converters and the word counter,
 * which all have to walk nested arguments like \caption{A {B} C}.
 */
export function matchBrace(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * One reference model, and every citation format the /tools/ pages emit from it.
 *
 * Every citation tool on the site (DOI finder, the BibTeX converters, the
 * APA / MLA / IEEE / ACM pages) reads its input into the same plain object
 * (`Ref`, below) and writes output from it. The parsers in bibtex_parse.mjs,
 * ris.mjs, nbib.mjs and csl.mjs produce a Ref; this module turns a Ref into
 * BibTeX or a formatted reference. One model, one set of formatters, so a
 * DOI, an RIS record and a pasted BibTeX entry cannot render the same paper
 * three different ways.
 *
 * Zero dependencies and no DOM: the same code runs in the browser (bundled by
 * the site) and under node (scripts/citations_test.mjs pins its behaviour).
 *
 * The formatters follow the published style guides for the entry types
 * researchers actually cite (journal articles, conference papers, books,
 * chapters, theses, reports, preprints and web pages). They are deliberately
 * not a CSL engine: a full CSL processor is a large dependency, and these four
 * styles cover the pages the keyword research asked for.
 *
 * A Ref:
 *   {
 *     type: 'article' | 'inproceedings' | 'incollection' | 'book' | 'phdthesis' |
 *           'mastersthesis' | 'techreport' | 'unpublished' | 'misc',
 *     key, title, authors: [{ family, given, suffix, literal }], editors,
 *     year, month (1-12, as a number, or null), journal, booktitle, volume,
 *     number, pages, publisher, address, institution, school, edition, series,
 *     doi, url, isbn, issn, eprint, archivePrefix, primaryClass, note,
 *     howpublished, accessed ("YYYY-MM-DD")
 *   }
 * Text fields hold plain Unicode text (no LaTeX); `latexToText` and
 * `textToLatex` convert at the edges.
 */

// ---------------------------------------------------------------------------
// LaTeX <-> Unicode
// ---------------------------------------------------------------------------

const ACCENTS = {
  "'": { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', y: 'ý', A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú', Y: 'Ý', c: 'ć', n: 'ń', s: 'ś', z: 'ź', C: 'Ć', N: 'Ń', S: 'Ś', Z: 'Ź', l: 'ĺ', r: 'ŕ', L: 'Ĺ', R: 'Ŕ' },
  '`': { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù', A: 'À', E: 'È', I: 'Ì', O: 'Ò', U: 'Ù' },
  '^': { a: 'â', e: 'ê', i: 'î', o: 'ô', u: 'û', A: 'Â', E: 'Ê', I: 'Î', O: 'Ô', U: 'Û', c: 'ĉ', g: 'ĝ', h: 'ĥ', j: 'ĵ', s: 'ŝ', w: 'ŵ', y: 'ŷ' },
  '"': { a: 'ä', e: 'ë', i: 'ï', o: 'ö', u: 'ü', y: 'ÿ', A: 'Ä', E: 'Ë', I: 'Ï', O: 'Ö', U: 'Ü' },
  '~': { a: 'ã', n: 'ñ', o: 'õ', A: 'Ã', N: 'Ñ', O: 'Õ', i: 'ĩ', u: 'ũ' },
  c: { c: 'ç', C: 'Ç', s: 'ş', S: 'Ş', t: 'ţ', T: 'Ţ', e: 'ȩ' },
  v: { c: 'č', C: 'Č', s: 'š', S: 'Š', z: 'ž', Z: 'Ž', r: 'ř', R: 'Ř', e: 'ě', E: 'Ě', n: 'ň', N: 'Ň', d: 'ď', D: 'Ď', t: 'ť', T: 'Ť', a: 'ǎ', i: 'ǐ', o: 'ǒ', u: 'ǔ' },
  u: { a: 'ă', A: 'Ă', g: 'ğ', G: 'Ğ', e: 'ĕ', i: 'ĭ', o: 'ŏ', u: 'ŭ' },
  H: { o: 'ő', O: 'Ő', u: 'ű', U: 'Ű' },
  '=': { a: 'ā', e: 'ē', i: 'ī', o: 'ō', u: 'ū', A: 'Ā', E: 'Ē', I: 'Ī', O: 'Ō', U: 'Ū' },
  '.': { z: 'ż', Z: 'Ż', e: 'ė', E: 'Ė', c: 'ċ', g: 'ġ', I: 'İ' },
  r: { a: 'å', A: 'Å', u: 'ů', U: 'Ů' },
  k: { a: 'ą', A: 'Ą', e: 'ę', E: 'Ę', i: 'į', u: 'ų' },
};
const LIGATURES = {
  ss: 'ß', o: 'ø', O: 'Ø', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', l: 'ł', L: 'Ł',
  i: 'ı', j: 'ȷ', dh: 'ð', DH: 'Ð', th: 'þ', TH: 'Þ', ng: 'ŋ', NG: 'Ŋ',
};
const TEXT_COMMANDS = 'textbf|textit|emph|texttt|textsc|textsf|textrm|textmd|textup|textnormal|underline|mbox|text|hbox|textsuperscript|textsubscript';

/** LaTeX-flavoured field text (as found in .bib files) to plain Unicode. */
export function latexToText(input) {
  if (input == null) return '';
  let s = String(input);
  // Dotless i/j only matter under an accent; plain i is what the accent tables expect.
  s = s.replace(/\{\\([ij])\}/g, '$1').replace(/\\([ij])(?![A-Za-z])/g, '$1');
  // \'{e}, \'e, {\'e}, \"{o}, \c{c}, \v c ...
  const accent = (cmd, letter) => (ACCENTS[cmd] && ACCENTS[cmd][letter]) || null;
  s = s.replace(/\{?\\(['`^"~=.])\{?([A-Za-z])\}?\}?/g, (m, cmd, ch) => accent(cmd, ch) ?? m);
  s = s.replace(/\{?\\([cvuHrk])(?:\{([A-Za-z])\}| ([A-Za-z]))\}?/g, (m, cmd, a, b) => accent(cmd, a ?? b) ?? m);
  // \ss, \o, {\ae} ...
  s = s.replace(/\{?\\(ss|ae|AE|oe|OE|aa|AA|dh|DH|th|TH|ng|NG|[oOlLij])(?:\{\})?(?![A-Za-z])\}?/g, (m, lig) => LIGATURES[lig] ?? m);
  // \textbf{x} -> x, innermost first so nested wrappers unwrap too.
  const cmdRe = new RegExp(`\\\\(?:${TEXT_COMMANDS})\\{([^{}]*)\\}`, 'g');
  for (let i = 0; i < 5 && cmdRe.test(s); i++) s = s.replace(cmdRe, '$1');
  s = s.replace(/\\(?:relax|,|;|!|@)/g, ' ');
  s = s.replace(/\\([&%$#_{}])/g, '$1');
  s = s.replace(/\\ /g, ' ').replace(/~/g, ' ');
  s = s.replace(/---/g, '\u2014').replace(/--/g, '\u2013');
  s = s.replace(/``|''/g, '"').replace(/`/g, "'");
  // Any remaining command name we do not know: drop the backslash-word, keep its argument.
  s = s.replace(/\\[A-Za-z]+\*?\s*\{([^{}]*)\}/g, '$1').replace(/\\[A-Za-z]+\*?/g, '');
  // Protective braces around words or whole titles.
  s = s.replace(/[{}]/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

/** Plain text to a BibTeX field value: escape the characters BibTeX reads as
 *  markup, but leave math and Unicode alone (biber and inputenc both read it). */
export function textToLatex(input) {
  if (input == null) return '';
  const s = String(input);
  // Do not touch the inside of $...$.
  return s
    .split(/(\$[^$]*\$)/)
    .map((part, i) => (i % 2 ? part : part.replace(/\\/g, '\\textbackslash{}').replace(/([&%#_])/g, '\\$1')))
    .join('');
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * "Vaswani, Ashish and Noam Shazeer and {OpenAI} and others" -> name objects.
 * Handles "Family, Given", "Given Family", "von" particles, "Family, Jr., Given"
 * and a braced whole name (an organisation) which is kept literally.
 */
export function parseNames(input) {
  if (input == null) return [];
  const text = String(input).replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const parts = splitOnAnd(text);
  const out = [];
  for (let raw of parts) {
    raw = raw.trim();
    if (!raw) continue;
    if (/^others$/i.test(raw)) { out.push({ family: '', given: '', suffix: '', literal: 'others' }); continue; }
    if (/^\{.*\}$/.test(raw) && !raw.slice(1, -1).includes(',')) {
      out.push({ family: '', given: '', suffix: '', literal: latexToText(raw) });
      continue;
    }
    out.push(parseOneName(latexToText(raw)));
  }
  return out;
}

function splitOnAnd(text) {
  // " and " outside braces separates names.
  const names = [];
  let depth = 0, cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (depth === 0 && /^ and /i.test(text.slice(i, i + 5))) {
      names.push(cur); cur = ''; i += 4; continue;
    }
    cur += ch;
  }
  names.push(cur);
  return names;
}

const PARTICLES = new Set(['van', 'von', 'de', 'der', 'den', 'del', 'della', 'di', 'da', 'du', 'la', 'le', 'ter', 'ten', 'af', 'zu', 'dos', 'das', 'do']);
const SUFFIXES = new Set(['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv', 'v']);

export function parseOneName(raw) {
  const s = String(raw).replace(/\s+/g, ' ').trim();
  if (!s) return { family: '', given: '', suffix: '', literal: '' };
  if (s.includes(',')) {
    const parts = s.split(',').map((p) => p.trim());
    if (parts.length >= 3 && SUFFIXES.has(parts[1].toLowerCase())) {
      return { family: parts[0], given: parts.slice(2).join(' '), suffix: parts[1], literal: '' };
    }
    const given = parts.slice(1).join(' ').trim();
    // "Smith, Jr." with no given name is a suffix, not a given name.
    if (parts.length === 2 && SUFFIXES.has(given.toLowerCase())) return { family: parts[0], given: '', suffix: given, literal: '' };
    return { family: parts[0], given, suffix: '', literal: '' };
  }
  const tokens = s.split(' ');
  if (tokens.length === 1) return { family: tokens[0], given: '', suffix: '', literal: '' };
  let suffix = '';
  if (SUFFIXES.has(tokens[tokens.length - 1].toLowerCase()) && tokens.length > 2) suffix = tokens.pop();
  // Family = last token plus any lowercase particles directly before it.
  let i = tokens.length - 1;
  while (i > 0 && PARTICLES.has(tokens[i - 1].toLowerCase())) i--;
  if (i === 0) i = tokens.length - 1;
  return { family: tokens.slice(i).join(' '), given: tokens.slice(0, i).join(' '), suffix, literal: '' };
}

/** "Ashish" -> "A."; "Jean-Pierre" -> "J.-P."; "A.B." -> "A. B."; "J K" -> "J. K." */
export function initials(given) {
  if (!given) return '';
  const cleaned = String(given).replace(/\./g, '. ').replace(/\s+/g, ' ').trim();
  return cleaned
    .split(' ')
    .filter(Boolean)
    .map((part) => part.split('-').map((p) => (p ? p[0].toUpperCase() + '.' : '')).join('-'))
    .join(' ');
}

function isLiteral(n) { return !!n.literal; }
function isOthers(n) { return n.literal === 'others'; }

/** One name in a given shape. */
export function formatName(n, shape) {
  if (isLiteral(n)) return n.literal;
  const suf = n.suffix ? `, ${n.suffix}` : '';
  switch (shape) {
    case 'family-initials': // APA, MLA co-authors of sorts: "Vaswani, A."
      return n.given ? `${n.family}, ${initials(n.given)}${suf}` : `${n.family}${suf}`;
    case 'initials-family': // IEEE: "A. Vaswani"
      return n.given ? `${initials(n.given)} ${n.family}${suf}` : `${n.family}${suf}`;
    case 'family-given': // MLA first author: "Vaswani, Ashish"
      return n.given ? `${n.family}, ${n.given}${suf}` : `${n.family}${suf}`;
    case 'given-family': // MLA second author, ACM: "Ashish Vaswani"
      return n.given ? `${n.given} ${n.family}${suf}` : `${n.family}${suf}`;
    default:
      return n.given ? `${n.given} ${n.family}${suf}` : `${n.family}${suf}`;
  }
}

/** BibTeX author field: "Family, Given and Family, Given". */
export function namesToBibtex(names) {
  return (names || [])
    .map((n) => (isOthers(n) ? 'others' : isLiteral(n) ? `{${n.literal}}` : n.given ? `${n.family}, ${n.suffix ? n.suffix + ', ' : ''}${n.given}` : n.family))
    .join(' and ');
}

// ---------------------------------------------------------------------------
// BibTeX output
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(['a', 'an', 'the', 'on', 'of', 'in', 'for', 'to', 'and', 'or', 'with', 'from', 'by', 'at', 'is', 'are', 'towards', 'toward', 'via', 'using', 'into', 'as', 'its', 'do', 'does', 'can', 'how', 'what', 'why', 'when', 'about', 'over', 'under', 'not', 'no']);

const asciiWord = (s) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();

/** "vaswani2017attention": first author's family name, year, first real title word. */
export function bibtexKey(ref) {
  const first = (ref.authors || []).find((n) => !isOthers(n));
  const fam = first ? asciiWord(isLiteral(first) ? first.literal.split(' ')[0] : first.family.split(' ').pop()) : '';
  const year = ref.year ? String(ref.year).replace(/[^0-9]/g, '') : '';
  const word = String(ref.title || '').split(/\s+/).map(asciiWord).find((w) => w && !STOPWORDS.has(w) && /[a-z]/.test(w)) || '';
  const key = `${fam}${year}${word}`;
  return key || 'ref';
}

/**
 * Wrap words BibTeX styles would otherwise lowercase: anything with a capital
 * after its first letter (BERT, GPUs, LaTeX). Plain capitalised words are left
 * alone: whether "Language Models" is a proper noun is the author's call, and
 * bracing every capitalised word is the noisy output people complain about.
 */
export function protectCapitals(title) {
  const words = String(title || '').split(' ');
  return words
    .map((w, i) => {
      if (!w || w.startsWith('{') || w.includes('$')) return w;
      const core = w.replace(/^[("'\[]+|[)"':,.;?!\]]+$/g, '');
      if (!core) return w;
      // BERT, LoRA, GPUs, LaTeX, 3D: a capital anywhere after the first letter.
      const innerCap = /^.+[A-Z]/.test(core);
      if (innerCap) return w.replace(core, `{${core}}`);
      return w;
    })
    .join(' ');
}

const FIELD_ORDER = ['author', 'editor', 'title', 'journal', 'booktitle', 'volume', 'number', 'pages', 'year', 'month', 'publisher', 'address', 'institution', 'school', 'edition', 'series', 'howpublished', 'note', 'eprint', 'archivePrefix', 'primaryClass', 'doi', 'url', 'isbn', 'issn'];
const MONTH_MACRO = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A Ref as one BibTeX entry. */
export function toBibtex(ref, { protectTitle = true, key } = {}) {
  const f = {};
  if (ref.authors?.length) f.author = namesToBibtex(ref.authors);
  if (ref.editors?.length) f.editor = namesToBibtex(ref.editors);
  if (ref.title) f.title = textToLatex(protectTitle ? protectCapitals(ref.title) : ref.title);
  for (const k of ['journal', 'booktitle', 'volume', 'number', 'pages', 'year', 'publisher', 'address', 'institution', 'school', 'edition', 'series', 'howpublished', 'note', 'eprint', 'archivePrefix', 'primaryClass', 'doi', 'url', 'isbn', 'issn']) {
    if (ref[k] == null || ref[k] === '') continue;
    // A journal article names its journal; the publisher Crossref attaches
    // ("Springer Science and Business Media LLC") is noise in a bibliography.
    if (k === 'publisher' && ref.type === 'article' && ref.journal) continue;
    if (k === 'pages') f[k] = String(ref[k]).replace(/\u2013|\u2014|-/g, '--');
    else if (['doi', 'url', 'eprint', 'archivePrefix', 'primaryClass'].includes(k)) f[k] = String(ref[k]);
    // `howpublished = {\url{...}}` is the one field that legitimately carries a command.
    else if (k === 'howpublished' && /^\\url\{[^}]*\}$/.test(String(ref[k]))) f[k] = String(ref[k]);
    else f[k] = textToLatex(ref[k]);
  }
  if (ref.month) {
    const m = Number(ref.month);
    f.month = m >= 1 && m <= 12 ? MONTH_MACRO[m - 1] : textToLatex(ref.month);
  }
  const type = BIBTEX_TYPES.has(ref.type) ? ref.type : 'misc';
  const lines = FIELD_ORDER.filter((k) => f[k] != null).map((k) => {
    const v = f[k];
    // Month macros are bare identifiers; everything else is braced.
    const val = k === 'month' && MONTH_MACRO.includes(v) ? v : `{${v}}`;
    return `  ${k.padEnd(12)} = ${val}`;
  });
  return `@${type}{${key || ref.key || bibtexKey(ref)},\n${lines.join(',\n')}\n}`;
}
const BIBTEX_TYPES = new Set(['article', 'inproceedings', 'incollection', 'book', 'phdthesis', 'mastersthesis', 'techreport', 'unpublished', 'misc']);

// ---------------------------------------------------------------------------
// Formatted references (APA 7, MLA 9, IEEE, ACM)
// ---------------------------------------------------------------------------

// Italics travel through the builders as control characters, then become
// <i> in the HTML rendering and vanish from the plain-text one.
const I0 = '\u0001', I1 = '\u0002';
const it = (s) => (s ? `${I0}${s}${I1}` : '');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Close a builder string into { html, text }. */
export function render(str) {
  const text = str.replace(/[\u0001\u0002]/g, '').replace(/\s+/g, ' ').replace(/ ([,.;:])/g, '$1').trim();
  const html = esc(str).replace(/\u0001/g, '<i>').replace(/\u0002/g, '</i>').replace(/\s+/g, ' ').replace(/ ([,.;:])/g, '$1').trim();
  return { html, text };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_IEEE = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'];
const monthName = (m, table = MONTHS) => { const n = Number(m); return n >= 1 && n <= 12 ? table[n - 1] : ''; };
const endsWithPunct = (s) => /[.!?]["']?$/.test(s.trim());
const period = (s) => (s && !endsWithPunct(s) ? `${s}.` : s);
const pagesDash = (p) => (p ? String(p).replace(/\s*(--|-|\u2014)\s*/g, '\u2013') : '');
const doiUrl = (doi) => (doi ? `https://doi.org/${String(doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')}` : '');
const arxivId = (ref) => (ref.archivePrefix && /arxiv/i.test(ref.archivePrefix) && ref.eprint ? ref.eprint : (ref.doi && /^10\.48550\/arxiv\./i.test(ref.doi) ? ref.doi.replace(/^10\.48550\/arxiv\./i, '') : ''));
const realNames = (ref) => (ref.authors || []).filter((n) => !isOthers(n));
const hasOthers = (ref) => (ref.authors || []).some(isOthers);
const link = (ref) => doiUrl(ref.doi) || ref.url || '';

function joinList(items, { and = 'and', oxford = true, amp = false } = {}) {
  const a = items.filter(Boolean);
  const word = amp ? '&' : and;
  if (a.length <= 1) return a.join('');
  if (a.length === 2) return `${a[0]}${amp ? ',' : ''} ${word} ${a[1]}`;
  return `${a.slice(0, -1).join(', ')}${oxford ? ',' : ''} ${word} ${a[a.length - 1]}`;
}

// ----- APA 7 -----

function apaAuthors(ref) {
  const names = realNames(ref).map((n) => formatName(n, 'family-initials'));
  if (!names.length) return '';
  if (names.length === 1) return hasOthers(ref) ? `${names[0]}, et al.` : names[0];
  if (names.length === 2) return `${names[0]}, & ${names[1]}`;
  // The ellipsis character rather than spaced periods, which the renderer
  // would otherwise pull together.
  if (names.length > 20) return `${names.slice(0, 19).join(', ')}, … ${names[names.length - 1]}`;
  return `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}`;
}

export function formatApa(ref) {
  const who = apaAuthors(ref);
  const year = `(${ref.year || 'n.d.'}).`;
  const eprint = arxivId(ref);
  const url = link(ref);
  // The title's own shape depends on the type: plain for a part of a larger
  // work (article, chapter), italic for a standalone work (book, thesis).
  let title, rest;
  switch (ref.type) {
    case 'article': {
      const vol = ref.volume ? it(ref.volume) : '';
      const iss = ref.number ? `(${ref.number})` : '';
      const where = [it(ref.journal), vol + iss].filter(Boolean).join(', ');
      title = period(ref.title);
      rest = where ? `${[where, pagesDash(ref.pages)].filter(Boolean).join(', ')}.` : '';
      break;
    }
    case 'inproceedings':
    case 'incollection': {
      const eds = (ref.editors || []).map((n) => formatName(n, 'initials-family'));
      const edStr = eds.length ? `${joinList(eds, { amp: true })} (${eds.length > 1 ? 'Eds.' : 'Ed.'}), ` : '';
      const pp = ref.pages ? ` (pp. ${pagesDash(ref.pages)})` : '';
      title = period(ref.title);
      rest = `In ${edStr}${it(ref.booktitle || ref.journal || '')}${pp}.${ref.publisher ? ` ${period(ref.publisher)}` : ''}`;
      break;
    }
    case 'book': {
      const ed = ref.edition ? ` (${ordinalEdition(ref.edition)} ed.)` : '';
      title = `${it(ref.title)}${ed}.`;
      rest = ref.publisher ? period(ref.publisher) : '';
      break;
    }
    case 'phdthesis':
    case 'mastersthesis': {
      const kind = ref.type === 'phdthesis' ? 'Doctoral dissertation' : "Master's thesis";
      title = `${it(ref.title)} [${kind}${ref.school ? `, ${ref.school}` : ''}].`;
      rest = '';
      break;
    }
    case 'techreport': {
      const no = ref.number ? ` (Report No. ${ref.number})` : '';
      title = `${it(ref.title)}${no}.`;
      rest = ref.institution ? period(ref.institution) : '';
      break;
    }
    default: {
      if (eprint) { title = `${it(ref.title)} (arXiv:${eprint}).`; rest = 'arXiv.'; }
      else { title = `${it(ref.title)}.`; rest = ref.publisher || ref.howpublished ? period(ref.publisher || ref.howpublished) : ''; }
    }
  }
  const tail = url && !(ref.type === 'book' && !ref.doi) ? ` ${url}` : '';
  // No author: the title moves into the author position, ahead of the year.
  const head = who ? `${who} ${year} ${title}` : `${title} ${year}`;
  return render(`${head} ${rest}${tail}`);
}

/** "2" or "2nd" or "Second" -> "2nd"; anything unparseable is returned as given. */
function ordinalEdition(ed) {
  const words = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
  const n = words[String(ed).trim().toLowerCase()] || Number(String(ed).replace(/[^0-9]/g, ''));
  if (!n) return ed;
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

// ----- MLA 9 -----

function mlaAuthors(ref) {
  const names = realNames(ref);
  if (!names.length) return '';
  const first = formatName(names[0], 'family-given');
  if (names.length === 1) return hasOthers(ref) ? `${first}, et al.` : period(first);
  if (names.length === 2 && !hasOthers(ref)) return period(`${first}, and ${formatName(names[1], 'given-family')}`);
  return `${first}, et al.`;
}

export function formatMla(ref) {
  const who = mlaAuthors(ref);
  const eprint = arxivId(ref);
  const url = link(ref);
  const title = `"${period(ref.title)}"`;
  let body;
  switch (ref.type) {
    case 'article': {
      const bits = [it(ref.journal), ref.volume ? `vol. ${ref.volume}` : '', ref.number ? `no. ${ref.number}` : '', ref.year, ref.pages ? `pp. ${pagesDash(ref.pages)}` : ''].filter(Boolean);
      body = `${title} ${bits.join(', ')}.`;
      break;
    }
    case 'inproceedings':
    case 'incollection': {
      const eds = (ref.editors || []).map((n) => formatName(n, 'given-family'));
      const bits = [it(ref.booktitle || ''), eds.length ? `edited by ${joinList(eds)}` : '', ref.publisher, ref.year, ref.pages ? `pp. ${pagesDash(ref.pages)}` : ''].filter(Boolean);
      body = `${title} ${bits.join(', ')}.`;
      break;
    }
    case 'book': {
      const bits = [ref.edition ? `${ordinalEdition(ref.edition)} ed.` : '', ref.publisher, ref.year].filter(Boolean);
      body = `${it(ref.title)}. ${bits.join(', ')}.`;
      break;
    }
    case 'phdthesis':
    case 'mastersthesis': {
      const kind = ref.type === 'phdthesis' ? 'PhD dissertation' : "Master's thesis";
      body = `${it(ref.title)}. ${[ref.year, ref.school, kind].filter(Boolean).join('. ')}.`;
      break;
    }
    case 'techreport': {
      body = `${it(ref.title)}. ${[ref.institution, ref.year].filter(Boolean).join(', ')}.`;
      break;
    }
    default: {
      const site = eprint ? it('arXiv') : ref.publisher || ref.howpublished ? it(ref.publisher || ref.howpublished) : '';
      const bits = [site, eprint ? `arXiv:${eprint}` : '', ref.year].filter(Boolean);
      body = `${title} ${bits.join(', ')}${bits.length ? '.' : ''}`;
    }
  }
  const tail = url ? ` ${url}.` : '';
  return render(`${who ? who + ' ' : ''}${body}${tail}`);
}

// ----- IEEE -----

function ieeeAuthors(ref) {
  const names = realNames(ref).map((n) => formatName(n, 'initials-family'));
  if (!names.length) return '';
  if (names.length > 6 || hasOthers(ref)) return `${names[0]} et al.`;
  return joinList(names, { oxford: names.length > 2 });
}

export function formatIeee(ref, n) {
  const who = ieeeAuthors(ref);
  const eprint = arxivId(ref);
  const mon = monthName(ref.month, MONTHS_IEEE);
  const when = [mon, ref.year].filter(Boolean).join(' ');
  const title = `"${ref.title.replace(/[.!?]$/, '')},"`;
  let body;
  switch (ref.type) {
    case 'article': {
      const bits = [it(ref.journal), ref.volume ? `vol. ${ref.volume}` : '', ref.number ? `no. ${ref.number}` : '', ref.pages ? `pp. ${pagesDash(ref.pages)}` : '', when].filter(Boolean);
      body = `${title} ${bits.join(', ')}${ref.doi ? `, doi: ${ref.doi}` : ''}.`;
      break;
    }
    case 'inproceedings':
    case 'incollection': {
      const bits = [`in ${it(ref.booktitle || '')}`, ref.address, when, ref.pages ? `pp. ${pagesDash(ref.pages)}` : ''].filter(Boolean);
      body = `${title} ${bits.join(', ')}${ref.doi ? `, doi: ${ref.doi}` : ''}.`;
      break;
    }
    case 'book': {
      const ed = ref.edition ? `, ${ordinalEdition(ref.edition)} ed` : '';
      const place = [ref.address, ref.publisher].filter(Boolean).join(': ');
      body = `${it(ref.title)}${ed}. ${[place, ref.year].filter(Boolean).join(', ')}.`;
      break;
    }
    case 'phdthesis':
    case 'mastersthesis': {
      const kind = ref.type === 'phdthesis' ? 'Ph.D. dissertation' : 'M.S. thesis';
      body = `${title} ${[kind, ref.school, ref.address, ref.year].filter(Boolean).join(', ')}.`;
      break;
    }
    case 'techreport': {
      body = `${title} ${[ref.institution, ref.address, ref.number ? `Tech. Rep. ${ref.number}` : 'Tech. Rep.', when].filter(Boolean).join(', ')}.`;
      break;
    }
    default: {
      if (eprint) body = `${title} ${[`arXiv:${eprint}`, when].filter(Boolean).join(', ')}.`;
      else body = `${title} ${[ref.howpublished || ref.publisher, when].filter(Boolean).join(', ')}.${ref.url ? ` [Online]. Available: ${ref.url}` : ''}`;
    }
  }
  const num = n != null ? `[${n}] ` : '';
  return render(`${num}${who ? who + ', ' : ''}${body}`);
}

// ----- ACM Reference Format -----

function acmAuthors(ref) {
  const names = realNames(ref).map((n) => formatName(n, 'given-family'));
  if (!names.length) return '';
  return period(hasOthers(ref) ? `${names[0]} et al.` : joinList(names));
}

export function formatAcm(ref) {
  const who = acmAuthors(ref);
  const eprint = arxivId(ref);
  const year = ref.year ? `${ref.year}.` : '';
  const mon = monthName(ref.month);
  const url = link(ref);
  let body;
  switch (ref.type) {
    case 'article': {
      const when = ref.year ? ` (${[mon, ref.year].filter(Boolean).join(' ')})` : '';
      const vi = [ref.volume, ref.number].filter(Boolean).join(', ');
      body = `${period(ref.title)} ${it(ref.journal)}${vi ? ` ${vi}` : ''}${when}${ref.pages ? `, ${pagesDash(ref.pages)}` : ''}.`;
      break;
    }
    case 'inproceedings':
    case 'incollection': {
      const bits = [ref.publisher, ref.address, ref.pages ? pagesDash(ref.pages) : ''].filter(Boolean);
      body = `${period(ref.title)} In ${it(ref.booktitle || '')}${bits.length ? `. ${bits.join(', ')}` : ''}.`;
      break;
    }
    case 'book': {
      body = `${it(ref.title)}${ref.edition ? ` (${ordinalEdition(ref.edition)} ed.)` : ''}. ${[ref.publisher, ref.address].filter(Boolean).join(', ')}.`;
      break;
    }
    case 'phdthesis':
    case 'mastersthesis': {
      body = `${it(ref.title)}. ${ref.type === 'phdthesis' ? 'Ph.D. Dissertation' : "Master's thesis"}. ${[ref.school, ref.address].filter(Boolean).join(', ')}.`;
      break;
    }
    case 'techreport': {
      body = `${it(ref.title)}. Technical Report${ref.number ? ` ${ref.number}` : ''}. ${[ref.institution, ref.address].filter(Boolean).join(', ')}.`;
      break;
    }
    default: {
      if (eprint) body = `${period(ref.title)} arXiv:${eprint}.`;
      else body = `${period(ref.title)}${ref.howpublished || ref.publisher ? ` ${ref.howpublished || ref.publisher}.` : ''}${!ref.doi && ref.url ? ` Retrieved from ${ref.url}` : ''}`;
    }
  }
  const tail = doiUrl(ref.doi) ? ` ${doiUrl(ref.doi)}` : (ref.type === 'article' || ref.type === 'inproceedings') && url ? ` ${url}` : '';
  return render(`${who ? who + ' ' : ''}${year} ${body}${tail}`.replace(/^ /, ''));
}

/** Every style at once, for pages that show a "cite as" block. */
export function formatAll(ref) {
  return { apa: formatApa(ref), mla: formatMla(ref), ieee: formatIeee(ref), acm: formatAcm(ref), bibtex: toBibtex(ref) };
}

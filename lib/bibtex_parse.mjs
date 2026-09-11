/**
 * BibTeX text -> Ref objects (see citations.mjs for the model).
 *
 * A hand-written reader rather than a dependency: the tools need to accept
 * whatever people paste from Google Scholar, arXiv, ACM DL and Zotero, which
 * means braces and quotes as delimiters, `#` concatenation, @string macros,
 * @comment blocks, month macros, and the odd unbalanced brace. Values are
 * converted to plain Unicode on the way in (latexToText) so the formatters
 * never see LaTeX.
 */
import { latexToText, parseNames } from './citations.mjs';

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const TYPE_MAP = {
  article: 'article',
  inproceedings: 'inproceedings',
  conference: 'inproceedings',
  proceedings: 'inproceedings',
  incollection: 'incollection',
  inbook: 'incollection',
  book: 'book',
  booklet: 'book',
  manual: 'book',
  phdthesis: 'phdthesis',
  mastersthesis: 'mastersthesis',
  thesis: 'phdthesis',
  techreport: 'techreport',
  report: 'techreport',
  unpublished: 'unpublished',
  misc: 'misc',
  online: 'misc',
  electronic: 'misc',
  www: 'misc',
  software: 'misc',
  dataset: 'misc',
};

/**
 * Parse every entry in `text`. Returns { refs, macros, errors }: entries that
 * could not be read are skipped and named in `errors` rather than failing the
 * whole paste, because a .bib file with one broken entry is the normal case.
 */
export function parseBibtex(text) {
  const src = String(text ?? '');
  const refs = [];
  const errors = [];
  const macros = { ...Object.fromEntries(Object.entries(MONTHS).map(([k, v]) => [k, String(v)])) };
  let i = 0;
  while ((i = src.indexOf('@', i)) !== -1) {
    const m = /^@\s*([A-Za-z]+)\s*([{(])/.exec(src.slice(i));
    if (!m) { i++; continue; }
    const type = m[1].toLowerCase();
    const open = m[2];
    const close = open === '{' ? '}' : ')';
    const bodyStart = i + m[0].length;
    const bodyEnd = matchClose(src, bodyStart - 1, open, close);
    if (bodyEnd < 0) { errors.push(`Unbalanced braces in an @${type} entry`); break; }
    const body = src.slice(bodyStart, bodyEnd);
    i = bodyEnd + 1;
    if (type === 'comment') continue;
    if (type === 'preamble') continue;
    if (type === 'string') {
      const eq = body.indexOf('=');
      if (eq > 0) macros[body.slice(0, eq).trim().toLowerCase()] = readValue(body.slice(eq + 1).trim(), macros);
      continue;
    }
    try {
      refs.push(entryToRef(type, body, macros));
    } catch (e) {
      errors.push(`Could not read an @${type} entry: ${e.message}`);
    }
  }
  return { refs, macros, errors };
}

/** Index of the delimiter closing the one at `openIdx`, or -1. Quotes are not
 *  nesting delimiters in BibTeX, so only braces are tracked. */
function matchClose(src, openIdx, open, close) {
  let depth = 0;
  for (let j = openIdx; j < src.length; j++) {
    const ch = src[j];
    if (ch === '\\') { j++; continue; }
    if (ch === open || (open === '(' && ch === '{')) depth++;
    else if (ch === close || (open === '(' && ch === '}')) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

function entryToRef(type, body, macros) {
  const comma = body.indexOf(',');
  const key = (comma < 0 ? body : body.slice(0, comma)).trim();
  const fields = comma < 0 ? {} : readFields(body.slice(comma + 1), macros);
  const ref = {
    type: TYPE_MAP[type] || 'misc',
    key: key || null,
    title: latexToText(fields.title),
    authors: parseNames(fields.author),
    editors: parseNames(fields.editor),
    year: pickYear(fields.year, fields.date),
    month: pickMonth(fields.month, fields.date),
    journal: latexToText(fields.journal || fields.journaltitle),
    booktitle: latexToText(fields.booktitle),
    volume: latexToText(fields.volume),
    number: latexToText(fields.number || fields.issue),
    pages: latexToText(fields.pages),
    publisher: latexToText(fields.publisher || fields.organization),
    address: latexToText(fields.address || fields.location),
    institution: latexToText(fields.institution),
    school: latexToText(fields.school),
    edition: latexToText(fields.edition),
    series: latexToText(fields.series),
    doi: cleanDoi(fields.doi),
    url: (fields.url || '').trim() || null,
    isbn: latexToText(fields.isbn) || null,
    issn: latexToText(fields.issn) || null,
    eprint: (fields.eprint || '').trim() || null,
    archivePrefix: (fields.archiveprefix || fields.eprinttype || '').trim() || null,
    primaryClass: (fields.primaryclass || '').trim() || null,
    note: latexToText(fields.note) || null,
    howpublished: latexToText(fields.howpublished) || null,
    accessed: (fields.urldate || '').trim() || null,
  };
  // "eprint = {2106.09685}" with no prefix is an arXiv id in practice.
  if (ref.eprint && !ref.archivePrefix && /^\d{4}\.\d{4,5}(v\d+)?$/.test(ref.eprint)) ref.archivePrefix = 'arXiv';
  // A DOI-shaped URL is a DOI.
  if (!ref.doi && ref.url) {
    const m = /doi\.org\/(10\.\d{4,9}\/[^\s]+)/i.exec(ref.url);
    if (m) ref.doi = decodeURIComponent(m[1]);
  }
  // A thesis entry of type "phdthesis" that says "Master" in its type field.
  if (ref.type === 'phdthesis' && /master/i.test(fields.type || '')) ref.type = 'mastersthesis';
  return ref;
}

/** "name = value, name = value" -> { name: value } with macros and # resolved. */
function readFields(s, macros) {
  const out = {};
  let i = 0;
  while (i < s.length) {
    const m = /^\s*,?\s*([A-Za-z][\w\-:.]*)\s*=\s*/.exec(s.slice(i));
    if (!m) break;
    const name = m[1].toLowerCase();
    i += m[0].length;
    const { value, end } = readValueAt(s, i, macros);
    out[name] = value;
    i = end;
    // Skip to the next comma at depth 0.
    while (i < s.length && s[i] !== ',') i++;
    if (i < s.length) i++;
  }
  return out;
}

function readValue(s, macros) {
  return readValueAt(s, 0, macros).value;
}

/** One value starting at `i`: braced, quoted, bare number, or macro, joined by `#`. */
function readValueAt(s, i, macros) {
  let value = '';
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    const ch = s[i];
    if (ch === '{') {
      const end = matchClose(s, i, '{', '}');
      if (end < 0) throw new Error('unbalanced braces in a field value');
      value += s.slice(i + 1, end);
      i = end + 1;
    } else if (ch === '"') {
      let j = i + 1, depth = 0;
      for (; j < s.length; j++) {
        if (s[j] === '\\') { j++; continue; }
        if (s[j] === '{') depth++;
        else if (s[j] === '}') depth--;
        else if (s[j] === '"' && depth === 0) break;
      }
      value += s.slice(i + 1, j);
      i = j + 1;
    } else {
      const m = /^[^,#\s}]+/.exec(s.slice(i));
      if (!m) break;
      const tok = m[0];
      value += /^\d+$/.test(tok) ? tok : macros[tok.toLowerCase()] ?? tok;
      i += tok.length;
    }
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] === '#') { i++; continue; }
    break;
  }
  return { value: value.replace(/\s+/g, ' ').trim(), end: i };
}

function pickYear(year, date) {
  const y = /(\d{4})/.exec(String(year ?? '')) || /(\d{4})/.exec(String(date ?? ''));
  return y ? y[1] : null;
}

function pickMonth(month, date) {
  if (month != null && String(month).trim()) {
    const m = String(month).trim().toLowerCase();
    if (/^\d{1,2}$/.test(m)) return Number(m) >= 1 && Number(m) <= 12 ? Number(m) : null;
    const key = m.slice(0, 3);
    if (MONTHS[key]) return MONTHS[key];
    return null;
  }
  const d = /^\d{4}-(\d{2})/.exec(String(date ?? '').trim());
  return d ? Number(d[1]) : null;
}

export function cleanDoi(doi) {
  if (!doi) return null;
  const s = String(doi).trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
  return s || null;
}

/**
 * RIS (Research Information Systems) text -> Ref objects.
 *
 * RIS is what EndNote, Zotero, Mendeley, Web of Science, Scopus and most
 * publisher "export citation" buttons produce: one tag per line, `TY` opens a
 * record and `ER` closes it. The tag set below is the one those exporters
 * actually write; unknown tags are ignored rather than rejected, so a record
 * from an exporter with extensions still converts.
 */
import { parseOneName } from './citations.mjs';

const TYPES = {
  JOUR: 'article', EJOUR: 'article', MGZN: 'article', NEWS: 'article', JFULL: 'article',
  CONF: 'inproceedings', CPAPER: 'inproceedings',
  BOOK: 'book', EBOOK: 'book', EDBOOK: 'book',
  CHAP: 'incollection', ECHAP: 'incollection',
  THES: 'phdthesis',
  RPRT: 'techreport',
  UNPB: 'unpublished',
  ELEC: 'misc', WEB: 'misc', GEN: 'misc', DATA: 'misc', COMP: 'misc', PAT: 'misc', PREPRINT: 'misc',
};

const LINE = /^([A-Z][A-Z0-9])\s{1,2}-\s?(.*)$/;

export function parseRis(text) {
  const refs = [];
  const errors = [];
  let cur = null;
  let lastTag = null;
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/^﻿/, '');
    const m = LINE.exec(line);
    if (!m) {
      // A continuation of a long value (some exporters wrap TI/AB).
      if (cur && lastTag && line.trim() && !/^\s*$/.test(line)) push(cur, lastTag, line.trim(), true);
      continue;
    }
    const [, tag, value] = m;
    if (tag === 'TY') { cur = { TY: value.trim(), tags: [] }; lastTag = null; continue; }
    if (tag === 'ER') {
      if (cur) refs.push(recordToRef(cur));
      cur = null; lastTag = null;
      continue;
    }
    if (!cur) continue;
    push(cur, tag, value.trim(), false);
    lastTag = tag;
  }
  if (cur) { refs.push(recordToRef(cur)); errors.push('The last record had no ER line; it was read anyway.'); }
  return { refs, errors };
}

function push(rec, tag, value, continuation) {
  if (continuation && rec.tags.length) {
    const last = rec.tags[rec.tags.length - 1];
    if (last.tag === tag) { last.value += ' ' + value; return; }
  }
  rec.tags.push({ tag, value });
}

function all(rec, ...tags) {
  return rec.tags.filter((t) => tags.includes(t.tag)).map((t) => t.value).filter(Boolean);
}
function first(rec, ...tags) {
  return all(rec, ...tags)[0] ?? '';
}

function recordToRef(rec) {
  const type = TYPES[rec.TY] || 'misc';
  const authors = all(rec, 'AU', 'A1').map((n) => parseOneName(n));
  const editors = all(rec, 'A2', 'ED').map((n) => parseOneName(n));
  const dateStr = first(rec, 'PY', 'Y1', 'DA');
  const dm = /^(\d{4})(?:[\/-](\d{1,2}))?/.exec(dateStr);
  const sp = first(rec, 'SP');
  const ep = first(rec, 'EP');
  const pages = sp && ep ? `${sp}–${ep}` : sp && /[-–]/.test(sp) ? sp.replace(/-/, '–') : sp || null;
  const container = first(rec, 'T2', 'JF', 'JO', 'JA', 'J2', 'BT');
  const isJournal = type === 'article';
  const doi = first(rec, 'DO') || doiFromUrl(first(rec, 'UR'));
  const sn = first(rec, 'SN');
  const ref = {
    type,
    key: null,
    title: first(rec, 'TI', 'T1', 'CT') || (type === 'book' ? first(rec, 'BT') : ''),
    authors,
    editors,
    year: dm ? dm[1] : null,
    month: dm && dm[2] ? Number(dm[2]) : null,
    journal: isJournal ? container : '',
    booktitle: !isJournal && type !== 'book' ? container : '',
    volume: first(rec, 'VL'),
    number: first(rec, 'IS'),
    pages,
    publisher: first(rec, 'PB'),
    address: first(rec, 'CY', 'PP'),
    institution: type === 'techreport' ? first(rec, 'PB') : '',
    school: type === 'phdthesis' ? first(rec, 'PB') : '',
    edition: first(rec, 'ET'),
    series: first(rec, 'T3'),
    doi: doi ? doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') : null,
    url: first(rec, 'UR') || null,
    isbn: type === 'book' || type === 'incollection' ? sn || null : null,
    issn: isJournal ? sn || null : null,
    eprint: null,
    archivePrefix: null,
    primaryClass: null,
    note: first(rec, 'N1') || null,
    howpublished: null,
    accessed: null,
  };
  if (type === 'techreport') ref.publisher = '';
  if (type === 'phdthesis') { ref.publisher = ''; if (/master/i.test(first(rec, 'M3'))) ref.type = 'mastersthesis'; }
  if (ref.type === 'misc' && rec.TY === 'PREPRINT' && /arxiv/i.test(ref.url || '')) {
    const m = /(\d{4}\.\d{4,5})(v\d+)?/.exec(ref.url);
    if (m) { ref.eprint = m[1]; ref.archivePrefix = 'arXiv'; }
  }
  return ref;
}

function doiFromUrl(url) {
  const m = /doi\.org\/(10\.\d{4,9}\/[^\s]+)/i.exec(url || '');
  return m ? decodeURIComponent(m[1]) : '';
}

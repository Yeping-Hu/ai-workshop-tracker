/**
 * PubMed NBIB / MEDLINE text -> Ref objects.
 *
 * This is the format PubMed's "Cite" and "Send to > Citation manager" buttons
 * produce: `TAG - value` lines, continuation lines indented by six spaces,
 * one blank line between records. Full author names live in FAU; AU carries
 * the "Smith J" abbreviation and is used only when FAU is absent (older
 * records). The DOI is in AID or LID with a "[doi]" suffix.
 */
import { parseOneName } from './citations.mjs';

const LINE = /^([A-Z]{2,4})\s*-\s?(.*)$/;

export function parseNbib(text) {
  const refs = [];
  const records = [];
  let cur = null;
  let last = null;
  for (const raw of String(text ?? '').replace(/^﻿/, '').split(/\r?\n/)) {
    if (!raw.trim()) { if (cur) { records.push(cur); cur = null; last = null; } continue; }
    if (/^\s{4,}\S/.test(raw) && last) { last.value += ' ' + raw.trim(); continue; }
    const m = LINE.exec(raw);
    if (!m) continue;
    if (!cur) cur = [];
    last = { tag: m[1], value: m[2].trim() };
    cur.push(last);
  }
  if (cur) records.push(cur);
  for (const rec of records) {
    if (rec.some((t) => t.tag === 'TI' || t.tag === 'PMID')) refs.push(recordToRef(rec));
  }
  return { refs, errors: [] };
}

function all(rec, tag) { return rec.filter((t) => t.tag === tag).map((t) => t.value); }
function first(rec, tag) { return all(rec, tag)[0] ?? ''; }

function recordToRef(rec) {
  const fau = all(rec, 'FAU');
  const au = all(rec, 'AU');
  const authors = fau.length ? fau.map((n) => parseOneName(n)) : au.map(abbrevName);
  const dp = first(rec, 'DP'); // "2019 Jun 12", "2020", "2021 Jan-Feb"
  const dm = /^(\d{4})(?:\s+([A-Za-z]{3}))?/.exec(dp);
  const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const doi = [...all(rec, 'AID'), ...all(rec, 'LID')].map((v) => /^(\S+)\s*\[doi\]/.exec(v)?.[1]).find(Boolean) || null;
  const pmid = first(rec, 'PMID');
  const pg = first(rec, 'PG');
  const ref = {
    type: 'article',
    key: null,
    title: first(rec, 'TI').replace(/\.$/, ''),
    authors,
    editors: [],
    year: dm ? dm[1] : null,
    month: dm && dm[2] ? months[dm[2].toLowerCase()] ?? null : null,
    journal: first(rec, 'JT') || first(rec, 'TA'),
    booktitle: '',
    volume: first(rec, 'VI'),
    number: first(rec, 'IP'),
    pages: pg ? expandPages(pg) : null,
    publisher: '',
    address: '',
    institution: '',
    school: '',
    edition: '',
    series: '',
    doi,
    url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : null,
    isbn: null,
    issn: first(rec, 'IS').replace(/\s*\(.*$/, '') || null,
    eprint: null,
    archivePrefix: null,
    primaryClass: null,
    note: pmid ? `PMID: ${pmid}` : null,
    howpublished: null,
    accessed: null,
  };
  return ref;
}

/** "Smith J" / "Smith JA" -> { family: "Smith", given: "J. A." } */
function abbrevName(s) {
  const m = /^(.*?)\s+([A-Z]{1,3})(?:\s+(Jr|Sr|2nd|3rd|II|III|IV))?$/.exec(s.trim());
  if (!m) return parseOneName(s);
  return { family: m[1], given: m[2].split('').map((c) => `${c}.`).join(' '), suffix: m[3] || '', literal: '' };
}

/** PubMed writes "1234-40" for 1234-1240; expand the short form so every
 *  style prints a full range. */
export function expandPages(pg) {
  const m = /^(\d+)-(\d+)$/.exec(pg.trim());
  if (!m) return pg.replace(/-/, '–');
  const [, a, b] = m;
  const end = b.length < a.length ? a.slice(0, a.length - b.length) + b : b;
  return `${a}–${end}`;
}

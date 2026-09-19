#!/usr/bin/env node
/**
 * The matcher's prefill helper (lib/paper_meta.mjs): which pastes name an arXiv
 * paper, where its record lives, and what is read out of it.
 * Run: node scripts/paper_meta_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { arxivIdFrom, paperDoiUrl, paperFromCsl } from '../lib/paper_meta.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}

for (const [input, want] of [
  ['2106.09685', '2106.09685'],
  ['2106.09685v2', '2106.09685'],
  ['arXiv:2106.09685', '2106.09685'],
  ['https://arxiv.org/abs/2106.09685', '2106.09685'],
  ['https://arxiv.org/pdf/2106.09685v1.pdf', '2106.09685'],
  ['10.48550/arXiv.2106.09685', '2106.09685'],
  ['cs/0301001', 'cs/0301001'],
]) {
  check(`"${input}" names arXiv ${want}`, arxivIdFrom(input) === want, String(arxivIdFrom(input)));
}
for (const input of ['10.1145/3292500.3330701', 'Attention is all you need', '', null, 'https://openreview.net/forum?id=abc']) {
  check(`"${input}" is not an arXiv id`, arxivIdFrom(input) === null);
}
check('the record is fetched from doi.org under the DataCite DOI', paperDoiUrl('2106.09685') === 'https://doi.org/10.48550/arXiv.2106.09685');

const csl = { type: 'article', title: 'LoRA: Low-Rank  Adaptation of\nLarge Language Models', abstract: 'An important paradigm of natural language processing consists of\n  large-scale pre-training on general domain data and adaptation to particular tasks.' };
const got = paperFromCsl(csl);
check('title and abstract come out with whitespace folded',
  got.title === 'LoRA: Low-Rank Adaptation of Large Language Models' && got.abstract.startsWith('An important paradigm') && !/\n|  /.test(got.abstract));
check('a record with no abstract still gives the title', paperFromCsl({ title: 'Only a title' }).abstract === '' && paperFromCsl({ title: ['Array title'] }).title === 'Array title');
check('a record with no title is null', paperFromCsl({ abstract: 'x' }) === null && paperFromCsl(null) === null);

const js = fs.readFileSync(path.join(ROOT, 'site', 'src', 'scripts', 'find.js'), 'utf8');
check('the page script fills the form through this module', /paper_meta\.mjs/.test(js) && /arxivIdFrom\(/.test(js) && /paperFromCsl\(/.test(js));
const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'validate.yml'), 'utf8');
check('CI runs this test', /paper_meta_test\.mjs/.test(ci), 'the workflow lists tests by hand');

console.log(failed === 0 ? '\nPaper metadata OK.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

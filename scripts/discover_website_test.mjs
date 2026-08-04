#!/usr/bin/env node
/**
 * Regression tests for websiteFromContent — the single validated reader of an
 * OpenReview group's `website` field, shared by venue creation, the refresh of
 * an existing entry, and the sub-track descent. Pure logic, no network.
 * Run: node scripts/discover_website_test.mjs
 *
 * The refresh path reads this for a reason worth keeping tested: organizers
 * often fill the website in days AFTER the venue group appears (i.e. after our
 * import created the entry), so the refresh must read the venue's own field or
 * the website is never picked up without a human edit.
 */
import { websiteFromContent } from './discover_openreview.mjs';

let failed = 0;
function check(label, got, expect) {
  const ok = got === expect;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(expect)})`}`);
}

// api2 wraps content values as {value: ...}; api1 / child groups can be bare.
check('wrapped {value}', websiteFromContent({ website: { value: 'https://africainai.mailab.io/' } }), 'https://africainai.mailab.io/');
check('bare string', websiteFromContent({ website: 'https://example.org/ws' }), 'https://example.org/ws');
check('http accepted', websiteFromContent({ website: 'http://example.org' }), 'http://example.org');
check('surrounding whitespace trimmed', websiteFromContent({ website: '  https://example.org  ' }), 'https://example.org');

// Anything that isn't an absolute http(s) URL is rejected rather than stored:
// organizers do type bare hostnames, emails and placeholders into this field.
check('bare hostname rejected', websiteFromContent({ website: 'example.org' }), null);
check('email rejected', websiteFromContent({ website: 'info@mailab.io' }), null);
check('protocol-relative rejected', websiteFromContent({ website: '//example.org' }), null);
check('empty string -> null', websiteFromContent({ website: '' }), null);
check('blank {value} -> null', websiteFromContent({ website: { value: '   ' } }), null);
check('missing field -> null', websiteFromContent({ title: 'A workshop' }), null);
check('empty content -> null', websiteFromContent({}), null);
check('null/undefined content -> null', websiteFromContent(null), null);

// Several links crammed into the one field (real case: NeurIPS 2026 IAB
// competition paper track). Take the first well-formed URL rather than storing
// a value that renders as a single broken href.
check('semicolon-separated -> first', websiteFromContent({ website: 'http://glee-competition.com; https://iab-agents.github.io/' }), 'http://glee-competition.com');
check('semicolon, no space -> first', websiteFromContent({ website: 'https://a.example;https://b.example' }), 'https://a.example');
check('space-separated -> first', websiteFromContent({ website: 'https://a.example https://b.example' }), 'https://a.example');
check('comma-separated -> first, comma stripped', websiteFromContent({ website: 'https://a.example, https://b.example' }), 'https://a.example');
check('leading prose -> the URL', websiteFromContent({ website: 'TBA https://a.example' }), 'https://a.example');
check('prose only -> null', websiteFromContent({ website: 'to be announced' }), null);
check('comma inside a single URL preserved', websiteFromContent({ website: 'https://example.org/a,b?x=1,2' }), 'https://example.org/a,b?x=1,2');
check('scheme with no host -> null', websiteFromContent({ website: 'https://' }), null);

// Length cap (the schema stores a bounded string).
{
  const long = 'https://example.org/' + 'a'.repeat(600);
  check('capped at 500 chars', websiteFromContent({ website: long }).length, 500);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll websiteFromContent checks passed.');
process.exit(failed ? 1 : 0);

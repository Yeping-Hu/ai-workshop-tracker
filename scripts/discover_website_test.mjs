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
import { websiteFromContent, normalizeWebsite } from './discover_openreview.mjs';

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
// A bare hostname used to be rejected. It is now accepted and given a scheme:
// organizers frequently type the host alone, and rejecting it left six current
// workshops with no link while OpenReview had one all along (see #46). The
// strictness the old rule protected is preserved below — this field also carries
// "N/A", "-" and prose, and prefixing those would publish a broken link.
check('bare hostname accepted, scheme added', websiteFromContent({ website: 'example.org' }), 'https://example.org');
check('host with a path accepted', websiteFromContent({ website: 'sim2realgap.github.io/ws-iros2026/' }), 'https://sim2realgap.github.io/ws-iros2026/');
check('www host accepted', websiteFromContent({ website: 'www.sdad.cc' }), 'https://www.sdad.cc');
check('a real URL still wins over a bare host', websiteFromContent({ website: 'example.org https://real.example' }), 'https://real.example');
check('"N/A" rejected', websiteFromContent({ website: 'N/A' }), null);
check('"-" rejected', websiteFromContent({ website: '-' }), null);
check('single label rejected (no TLD)', websiteFromContent({ website: 'localhost' }), null);
check('numeric TLD rejected', websiteFromContent({ website: '3.5' }), null);
check('leading/trailing hyphen label rejected', websiteFromContent({ website: '-bad.example' }), null);
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

// A website deliberately removed must not be filled straight back in. The
// importer compares OpenReview's value against `review_ack.website` using this
// normaliser, so the suppression is value-specific: a DIFFERENT url still fills.
{
  const declined = 'https://icml-fm-wild.github.io/';
  const blocks = (or) => normalizeWebsite(declined) === normalizeWebsite(or);
  check('declined url is not re-added', blocks('https://icml-fm-wild.github.io/'), true);
  check('declined url, trailing slash differs', blocks('https://icml-fm-wild.github.io'), true);
  check('a different url is still filled', blocks('https://a-new-site.example/'), false);
}


console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll websiteFromContent checks passed.');
process.exit(failed ? 1 : 0);

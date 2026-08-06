#!/usr/bin/env node
/**
 * Unit tests for site/src/lib/markdown.ts formatting logic.
 * Run: node scripts/markdown_test.mjs
 */
import { formatWorkshop, formatConferenceYear, formatSingleWorkshopInfo, isAutoTopicsNote } from '../site/src/lib/markdown.ts';

let failed = 0;
function check(label, got, expect) {
  const ok = typeof expect === 'boolean' ? got === expect : (got.includes ? got.includes(expect) : got === expect);
  if (!ok) {
    failed++;
    console.error(`✗ ${label}\n  Got: ${JSON.stringify(got)}\n  Expected to match: ${JSON.stringify(expect)}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

// 1. Test auto topics note filtering
check('isAutoTopicsNote identifies exact auto-suggested note',
  isAutoTopicsNote('Topics were auto-suggested and may be imprecise — edits welcome.'), true);
check('isAutoTopicsNote identifies historical auto note',
  isAutoTopicsNote('Auto-imported from the OpenReview venue record on 2026-06-20 — please verify and enrich (topics are keyword-guessed).'), true);
check('isAutoTopicsNote identifies SEED DATA note',
  isAutoTopicsNote('SEED DATA: unverified entry'), true);
check('isAutoTopicsNote allows legitimate custom description',
  isAutoTopicsNote('This workshop focuses on efficient LLM reasoning.'), false);

// 2. Test formatWorkshop with abstract deadline, bold key-values, and filtered notes
const sampleWs = {
  name: 'Efficient Reasoning Workshop',
  statusLabel: 'Open call',
  abstractDeadlineWallClock: 'Aug 20, 2026 23:59 UTC',
  abstractDeadlinePassed: false,
  deadlineWallClock: 'Aug 29, 2026 23:59 UTC',
  notificationDateLabel: 'Sep 20, 2026',
  workshopDateLabel: 'Oct 25, 2026',
  topics: ['llms', 'efficiency'],
  website: 'https://example.com/ws',
  openreview_venue_id: 'NeurIPS.cc/2026/Workshop/ER',
  notes: 'Topics were auto-suggested and may be imprecise — edits welcome.',
  deadlineChange: {
    kind: 'extended',
    days: 5,
    fromWallClock: 'Aug 24, 2026 23:59 UTC',
  },
};

const output = formatWorkshop(sampleWs, 'NeurIPS');

check('formatWorkshop includes H2 header', output, '## Efficient Reasoning Workshop');
check('formatWorkshop formats bold Status label', output, '- **Status:** Open call');
check('formatWorkshop includes abstract deadline', output, '- **Abstract Deadline:** Aug 20, 2026 23:59 UTC');
check('formatWorkshop formats bold Submission Deadline', output, '- **Submission Deadline:** Aug 29, 2026 23:59 UTC');
check('formatWorkshop formats bold Website link', output, '- **Website:** [https://example.com/ws](https://example.com/ws)');
check('formatWorkshop formats bold OpenReview link', output, '- **OpenReview:** [https://openreview.net/group?id=NeurIPS.cc/2026/Workshop/ER](https://openreview.net/group?id=NeurIPS.cc/2026/Workshop/ER)');
check('formatWorkshop formats Deadline History', output, '**Deadline History:** Extended by 5 days (previously Aug 24, 2026 23:59 UTC)');
check('formatWorkshop excludes auto-suggested maintenance notes from Description', output.includes('Description'), false);

// 3. Test custom notes inclusion
const wsWithCustomNotes = {
  ...sampleWs,
  notes: 'We welcome papers on efficient attention mechanisms.',
};
const outputCustom = formatWorkshop(wsWithCustomNotes, 'NeurIPS');
check('formatWorkshop includes valid custom description', outputCustom, '**Description:**\nWe welcome papers on efficient attention mechanisms.');

// 4. Test formatConferenceYear
const confObj = { name: 'NeurIPS', full_name: 'Neural Information Processing Systems' };
const confOutput = formatConferenceYear(confObj, 2026, [sampleWs]);
check('formatConferenceYear contains conference header', confOutput, '# Neural Information Processing Systems 2026 Workshops');
check('formatConferenceYear contains Total Workshops count', confOutput, 'Total Workshops: 1');

// 5. Test formatSingleWorkshopInfo
const singleOutput = formatSingleWorkshopInfo(sampleWs, confObj);
check('formatSingleWorkshopInfo contains single workshop header', singleOutput, '# Efficient Reasoning Workshop');
check('formatSingleWorkshopInfo contains Conference field', singleOutput, 'Conference: Neural Information Processing Systems');

if (failed > 0) {
  console.error(`\nTest suite failed with ${failed} failure(s).`);
  process.exit(1);
} else {
  console.log('\nAll markdown tests passed successfully!');
}

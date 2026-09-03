/**
 * Reading values back out of a GitHub issue-form body.
 *
 * Shared by scripts/issue_to_yaml.mjs and scripts/issue_edit_to_yaml.mjs, which
 * had the same one-liner each. Two copies of a parser is how the saved-list
 * merge bug happened — the fix went to one of them — so the moment this needed
 * to understand a second format it became one function.
 */

const dedupe = (list) => [...new Set(list.filter(Boolean))];

/**
 * The "### Label\n\nvalue" sections of an issue-form body, keyed by the
 * lower-cased label. GitHub renders an empty field as `_No response_` (or
 * `None` for some dropdowns); both read as empty. The add and edit scripts
 * carried this loop separately, seven identical lines each.
 */
export function parseSections(body) {
  const sections = {};
  const re = /^###\s+(.+?)\s*\r?\n([\s\S]*?)(?=^###\s+|\s*$(?![\s\S]))/gm;
  let m;
  while ((m = re.exec(String(body ?? ''))) !== null) {
    let value = m[2].trim();
    if (value === '_No response_' || value === 'None') value = '';
    sections[m[1].trim().toLowerCase()] = value;
  }
  return sections;
}

/**
 * The topic ids a submitter chose.
 *
 * Understands **both** shapes on purpose:
 *
 *   `checkboxes`  (current)   `- [x] agents` / `- [ ] causality`
 *   `dropdown`    (until 2026-08-17)   `agents, causality`
 *
 * The forms moved to `checkboxes` because a GitHub multi-select dropdown closes
 * itself after every single pick, so choosing five topics meant reopening the
 * list five times. Checkboxes stay open and toggle freely.
 *
 * The old shape is still accepted because issues opened before the switch are
 * converted by whatever version of this script is on main when the workflow
 * runs — an issue filed the day before, or reopened months later, must not turn
 * into a workshop entry with no topics.
 *
 * A `checkboxes` field renders *every* option, ticked or not, so an unticked
 * box is data too: it means "not chosen", and dropping those is the whole job.
 */
export function parseTopics(raw) {
  const text = String(raw ?? '');

  // Any checkbox line at all means this came from the checkboxes field, and the
  // unticked ones must be discarded rather than read as selections.
  if (/^\s*[-*]\s*\[[ xX]\]/m.test(text)) {
    return dedupe(
      text
        .split('\n')
        .map((line) => line.match(/^\s*[-*]\s*\[[xX]\]\s*(.+?)\s*$/))
        .filter(Boolean)
        .map((m) => m[1].trim().toLowerCase()),
    );
  }

  return dedupe(text.split(/[,\n]/).map((t) => t.trim().toLowerCase()));
}

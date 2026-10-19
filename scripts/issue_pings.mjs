/**
 * The "New since the last run" comments on the data-health issues, and hiding
 * them once they have done their job.
 *
 * Three workflows each keep one self-maintaining issue and rewrite its body on
 * every run: deadline-review.yml ("deadlines to review"), official-list-check.yml
 * ("workshops not on the official list") and sync-editions.yml ("conference
 * editions to review"). Editing a body notifies nobody, so each also comments
 * when an item first appears. That ping is the part that reaches anyone, but it
 * outlives its news: items get synced, acknowledged or fixed, while the issue
 * stays open as long as anything else is listed, so pings pile up. By
 * 2026-10-17 "deadlines to review" had collected nineteen, one of them 946 lines
 * long. Deleting them did not help: GitHub records the deletion of someone
 * else's comment as a timeline line of its own, so twenty deletions by the
 * maintainer became twenty "deleted a comment" lines.
 *
 * So each run now hides (minimises, reason "resolved") every earlier ping none
 * of whose items is still in the body. A hidden comment collapses to one line
 * anyone can expand and nothing is deleted; a ping that still names an open
 * item stays as it is. Hiding is housekeeping, so it never fails a run: if
 * GitHub refuses, the run warns and carries on, and the issue is exactly what
 * it would have been before this existed.
 *
 * What counts as an item differs per issue, and the definitions live here
 * because the same one decides both "new since the last run" and "resolved".
 * Two copies would eventually disagree, hiding a ping whose item is still
 * listed, or announcing an item twice.
 */

/** How every ping starts; anything else the bot writes is never touched. */
export const PING_HEAD = 'New since the last run — ';

/** deadline-review: the entry files on review rows. A review row is a
 *  checkbox; a "Could not be checked this run" row describes the run rather
 *  than the data and carries no box. `[x]` is a box somebody ticked. */
export function deadlineReviewItems(text) {
  return new Set(
    [...String(text || '').matchAll(/^- \[[ xX]\] `(data\/workshops\/[\w.-]+\.yml)`/gm)].map((m) => m[1]),
  );
}

/** official-list-check: entry files anywhere in the body, plus candidate list
 *  URLs, since a newly published accepted list is the most time-sensitive
 *  thing that job finds. */
export function officialListItems(text) {
  const s = String(text || '');
  return new Set([
    ...(s.match(/data\/workshops\/[\w.-]+\.yml/g) || []),
    ...(s.match(/workshop_list_url: "[^"]+"/g) || []),
  ]);
}

/** sync-editions: the stable keys its report carries in a trailing comment. */
export function editionsReviewItems(text) {
  const m = String(text || '').match(/<!-- editions-review-keys: ([^>]*) -->/);
  return new Set((m ? m[1] : '').split(',').map((k) => k.trim()).filter(Boolean));
}

/** The items a ping announced, one per "- `item`" line, or null for any
 *  comment that is not a ping. */
export function pingItems(body) {
  const s = String(body || '');
  if (!s.startsWith(PING_HEAD)) return null;
  return [...s.matchAll(/^- `(.+)`\s*$/gm)].map((m) => m[1]);
}

/** GraphQL reports the workflow's bot as `github-actions`, REST as
 *  `github-actions[bot]`. Nobody else's comment is ever hidden. */
const BOT_LOGINS = new Set(['github-actions', 'github-actions[bot]']);

/**
 * Which comments to hide: pings the bot posted, not hidden yet, none of whose
 * items is still open. A ping that names no item at all (a format this module
 * does not know) is left alone rather than guessed at. Pure.
 *
 * @param comments {id, body, isMinimized, author: {login}}[]
 * @param open     the issue's items now (one of the *Items functions above)
 */
export function resolvedPings(comments, open) {
  return (comments ?? []).filter((c) => {
    if (c.isMinimized || !BOT_LOGINS.has(c.author?.login)) return false;
    const items = pingItems(c.body);
    return !!items && items.length > 0 && items.every((item) => !open.has(item));
  });
}

const LIST_COMMENTS = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      comments(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id body isMinimized author { login } }
      }
    }
  }
}`;

const HIDE_AS_RESOLVED = `mutation($id: ID!) {
  minimizeComment(input: { subjectId: $id, classifier: RESOLVED }) { minimizedComment { isMinimized } }
}`;

/**
 * Hide every resolved ping on one issue. Never throws. A listing that fails,
 * or a hide GitHub refuses, is one warning and the end of this run's
 * housekeeping: a refusal is the token's answer for every comment, so asking
 * again per comment would only repeat it. Returns how many were hidden.
 *
 * @param github  an Octokit client with `.graphql` (actions/github-script's)
 * @param open    the issue's items now
 */
export async function hideResolvedPings({
  github, owner, repo, issueNumber, open,
  log = (m) => console.log(m),
  warn = (m) => console.log(`::warning::${m}`),
}) {
  const comments = [];
  try {
    let after = null;
    do {
      const r = await github.graphql(LIST_COMMENTS, { owner, repo, number: issueNumber, after });
      const page = r.repository.issue.comments;
      comments.push(...page.nodes);
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
  } catch (e) {
    warn(`Could not list the comments on #${issueNumber}, so no resolved ping was hidden: ${e.message}`);
    return 0;
  }
  let hidden = 0;
  for (const c of resolvedPings(comments, open)) {
    try {
      await github.graphql(HIDE_AS_RESOLVED, { id: c.id });
      hidden++;
    } catch (e) {
      warn(`GitHub refused to hide a resolved ping on #${issueNumber} (${e.message}); it stays visible, and the next run tries again.`);
      break;
    }
  }
  if (hidden) log(`Hid ${hidden} resolved ping${hidden === 1 ? '' : 's'} on #${issueNumber}.`);
  return hidden;
}

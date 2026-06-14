/** Site-wide constants. Override the repo URL with PUBLIC_REPO_URL in CI/.env. */
export const SITE_NAME = 'AI Workshop Tracker';
export const SITE_TAGLINE =
  'Workshop deadlines and accepted papers across major AI/ML/Robotics conferences.';
export const REPO_URL =
  import.meta.env.PUBLIC_REPO_URL || 'https://github.com/Yeping-Hu/ai-workshop-tracker';

/**
 * Calendar feeds & .ics links are paused until workshop dates are verified —
 * flip to true to re-enable. While false, feed URLs still resolve but contain
 * zero events, so existing subscribers' calendars clear out on their next
 * refresh instead of keeping possibly-wrong dates.
 */
export const CALENDAR_ENABLED = false;

/**
 * Footer "support this project" link. Points at GitHub Sponsors by default —
 * activate at github.com/sponsors, or swap for a Ko-fi / Buy Me a Coffee URL.
 * Set to '' to hide the link entirely.
 */
export const SUPPORT_URL = ''; // hidden for launch — restore: 'https://github.com/sponsors/Yeping-Hu'

/** Prefix an absolute path with the configured base (for GitHub project pages). */
const base = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');
export const href = (p: string) => `${base}${p.startsWith('/') ? p : '/' + p}`;

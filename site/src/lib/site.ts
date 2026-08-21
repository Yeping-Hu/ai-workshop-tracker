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
 * Support link — a Ko-fi tip jar. Gates **both** support surfaces: the footer
 * "♥ Support" link and the "Support this project" section on /about/. Set to ''
 * to take the ask off the site entirely, leaving no trace in the build.
 */
export const SUPPORT_URL = 'https://ko-fi.com/aiworkshoptracker';

/**
 * Base URL of the alerts Worker (e.g. https://api.aiworkshoptracker.com).
 * Empty string disables **every** alerts UI element: the signup component
 * renders nothing, the /alerts/ pages say the feature is off, and no alerts
 * script runs. Forks and PR preview builds therefore work with the feature
 * entirely absent, and deleting the alerts system leaves the site unchanged.
 */
export const ALERTS_API = (import.meta.env.PUBLIC_ALERTS_API || '').replace(/\/+$/, '');

/** Cloudflare Turnstile site key (public half). Signup needs both this and
 *  ALERTS_API; without it the form cannot pass the Worker's captcha check. */
export const TURNSTILE_SITE_KEY = import.meta.env.PUBLIC_TURNSTILE_SITE_KEY || '';

/**
 * The address alerts are sent from, shown before signup so people know what to
 * look for and can tell it from a lookalike. Must match MAIL_FROM in
 * alerts/worker/wrangler.toml. Stated in both places rather than derived: the
 * site is a static build with no view of the Worker's vars, and this is display
 * copy, so a drift misleads a reader rather than breaking a send.
 */
export const ALERTS_FROM = 'alerts@mail.aiworkshoptracker.com';

/** Prefix an absolute path with the configured base (for GitHub project pages). */
const base = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');
export const href = (p: string) => `${base}${p.startsWith('/') ? p : '/' + p}`;

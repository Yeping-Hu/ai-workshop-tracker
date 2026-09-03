/**
 * Date & timezone utilities shared by the site build, validation, and scripts.
 * Zero dependencies: IANA timezones are resolved with the built-in Intl API.
 *
 * Conventions:
 *  - "AoE" (Anywhere on Earth) is a fixed UTC-12:00 offset (the standard
 *    convention for ML conference deadlines).
 *  - A deadline written as "YYYY-MM-DD" (no time) means 23:59 in its timezone.
 */

export const DAY_MS = 86_400_000;

const DEADLINE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Does this year/month/day name a real calendar date? `Date.UTC` silently rolls
 * an impossible one forward ("2026-02-30" becomes March 2nd), so a value that
 * merely matches the shape can display as one date and resolve to another —
 * the board would count down to a different day than the one it prints. Every
 * parser below runs this probe, so a rolled-over date is rejected the same way
 * everywhere instead of only on the issue-form path.
 */
export function isRealDate(year, month, day) {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/** Parse "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" into parts, or null if invalid. */
export function parseDeadlineString(str) {
  if (typeof str !== 'string') return null;
  const m = str.trim().match(DEADLINE_RE);
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m;
  const parts = {
    year: +y,
    month: +mo,
    day: +d,
    hour: hh === undefined ? 23 : +hh,
    minute: mm === undefined ? 59 : +mm,
    hasTime: hh !== undefined,
  };
  if (!isRealDate(parts.year, parts.month, parts.day)) return null;
  if (parts.hour > 23 || parts.minute > 59) return null;
  return parts;
}

/** Parse a plain "YYYY-MM-DD" date string to a UTC-midnight ms timestamp, or null. */
export function parseDateUtcMs(str) {
  if (typeof str !== 'string') return null;
  const m = str.trim().match(DATE_RE);
  if (!m) return null;
  if (!isRealDate(+m[1], +m[2], +m[3])) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return Number.isFinite(ms) ? ms : null;
}

/** Is `zone` a valid timezone for this project? ("AoE", "UTC", or IANA name) */
export function isValidTimezone(zone) {
  if (zone === 'AoE' || zone === 'UTC') return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Offset (in minutes east of UTC) of an IANA zone at a given instant. */
function tzOffsetMinutes(utcMs, zone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(utcMs).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  return (asUtc - utcMs) / 60_000;
}

/**
 * Convert a wall-clock time in a given zone to a UTC ms timestamp.
 * zone: "AoE" | "UTC" | IANA name.
 */
export function zonedToUtcMs({ year, month, day, hour, minute }, zone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  if (zone === 'AoE') return naive + 12 * 3_600_000; // AoE = UTC-12
  if (zone === 'UTC') return naive;
  // IANA zone: iterate (handles DST transitions in 1-2 steps).
  let ts = naive;
  for (let i = 0; i < 3; i++) {
    const offset = tzOffsetMinutes(ts, zone);
    const next = naive - offset * 60_000;
    if (next === ts) break;
    ts = next;
  }
  return ts;
}

/**
 * Resolve a workshop's submission deadline to a UTC ms timestamp.
 * Returns null when there is no (valid) deadline.
 */
export function resolveDeadlineUtcMs(submissionDeadline, timezone = 'AoE') {
  const parts = parseDeadlineString(submissionDeadline);
  if (!parts) return null;
  if (!isValidTimezone(timezone)) return null;
  return zonedToUtcMs(parts, timezone);
}

/**
 * Compute a workshop's lifecycle status.
 *   not_running     -> we have OBSERVED that this edition is not taking place
 *   upcoming        -> deadline (if any) is in the future
 *   deadline_passed -> deadline passed but the workshop hasn't happened yet
 *   past            -> the workshop day is over (or the edition's year is over)
 *
 * Every input but `notRunning` is a date: the status is still derived, and
 * `notRunning` is derived in turn from a stored observation (`not_running` in
 * the YAML) exactly as `deadline_passed` is derived from a stored deadline.
 */
export function computeStatus(
  { deadlineUtcMs, workshopDateUtcMs, year, notRunning = false },
  nowMs = Date.now(),
) {
  // Checked FIRST, before the open-deadline guard below, because that guard is
  // precisely what this has to beat. OpenReview creates a venue group during a
  // conference's PROPOSAL phase, so a rejected proposal keeps a live group whose
  // Submission invitation ticks down like any other: its deadline is genuinely
  // in the future, and the guard would call it an Open call.
  if (notRunning) return 'not_running';

  const currentYear = new Date(nowMs).getUTCFullYear();
  // The workshop day ends, at the latest, 36h after UTC midnight of its date
  // (covers every timezone plus an evening session).
  const workshopEndMs = workshopDateUtcMs != null ? workshopDateUtcMs + 36 * 3_600_000 : null;

  // An open submission deadline (still in the future) means the workshop is
  // actively accepting submissions — an Open call, never "past". This must win
  // over the event-date estimate: when a workshop has no explicit workshop_date,
  // its date is INFERRED (from the conference edition's end date, or the
  // conference's typical month), and that estimate must not mark the workshop
  // past while its real deadline is still days away. Without this guard, a
  // challenge/competition whose deadline runs past the main conference (e.g. a
  // CVPR Codabench competition due after the conference ends) flips to "past"
  // the moment the conference ends, despite an open deadline.
  if (deadlineUtcMs != null && nowMs <= deadlineUtcMs) return 'upcoming';

  if (workshopEndMs != null && nowMs > workshopEndMs) return 'past';
  if (workshopEndMs == null && year < currentYear) return 'past';
  if (deadlineUtcMs != null && nowMs > deadlineUtcMs) return 'deadline_passed';
  return 'upcoming';
}

/** Human label for a timezone value. */
export function timezoneLabel(zone) {
  if (zone === 'AoE') return 'AoE (UTC−12)';
  return zone;
}

/** "2026-08-22 23:59" + "AoE" -> "Aug 22, 2026, 23:59 AoE (UTC−12)" */
export function formatDeadlineWallClock(submissionDeadline, timezone = 'AoE') {
  const p = parseDeadlineString(submissionDeadline);
  if (!p) return null;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hh = String(p.hour).padStart(2, '0');
  const mm = String(p.minute).padStart(2, '0');
  return `${months[p.month - 1]} ${p.day}, ${p.year}, ${hh}:${mm} ${timezoneLabel(timezone)}`;
}

/** "2026-12-06" -> "Dec 6, 2026" */
export function formatDateYmd(str) {
  const ms = parseDateUtcMs(str);
  if (ms == null) return str ?? '';
  const d = new Date(ms);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/**
 * Assemble a "YYYY-MM-DD HH:MM" deadline string from the separate dropdown
 * fields used by the issue forms (year/month/day/hour/minute). Selecting from
 * dropdowns instead of typing a free-text date makes the format impossible to
 * get wrong. Returns '' when nothing was picked (deadline left unchanged), or
 * throws an Error with a contributor-readable message on a partial or
 * impossible date. Time defaults to 23:59 when the date is given but no time is
 * (matching the "date only = end of day" convention); a half-given time fills
 * the missing half with 00.
 */
export function assembleDeadline({ year, month, day, hour, minute } = {}) {
  const v = (x) => String(x ?? '').trim();
  const [y, mo, d, hh0, mm0] = [v(year), v(month), v(day), v(hour), v(minute)];
  const anyDate = y || mo || d;
  const anyTime = hh0 || mm0;
  if (!anyDate && !anyTime) return ''; // nothing entered → keep current
  if (!(y && mo && d)) {
    throw new Error('Pick the deadline year, month, and day together (or leave all the deadline fields blank to keep the current deadline).');
  }
  let hh, mm;
  if (!hh0 && !mm0) { hh = '23'; mm = '59'; }
  else { hh = hh0 || '00'; mm = mm0 || '00'; }
  const pad = (s, n) => s.padStart(n, '0');
  const Y = pad(y, 4), MO = pad(mo, 2), D = pad(d, 2), HH = pad(hh, 2), MM = pad(mm, 2);
  // Reject impossible dates (e.g. Feb 30): independent day/month dropdowns can
  // express a non-existent date, and JS would silently roll it over.
  if (!isRealDate(Number(Y), Number(MO), Number(D))) {
    throw new Error(`${Y}-${MO}-${D} isn't a real date — check the day for the month you picked.`);
  }
  return `${Y}-${MO}-${D} ${HH}:${MM}`;
}

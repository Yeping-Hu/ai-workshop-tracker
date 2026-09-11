/**
 * The AoE page: three live clocks (AoE, UTC, local), a converter in both
 * directions, and the tracker's open workshop deadlines in the visitor's
 * own time. AoE is a fixed UTC-12 (lib/dates.mjs owns that fact); every
 * other zone goes through Intl, which knows the daylight-saving rules.
 *
 * Every instant on the page is spelled one way, "Fri 11 Sep 2026 12:00", by
 * one formatter over lib/dates.mjs's utcMsToWallClock. The local column used
 * to come from Intl's en-GB formatter, which wrote "Sept" and a comma beside
 * this file's own "Sep" for the AoE column, so the two columns of one row
 * disagreed about how to write a date. A cell is emitted as two pieces, the
 * date and the time, because the tables let a cell break between them on a
 * phone and nowhere else (tools.css, `.when`).
 */
import { zonedToUtcMs, utcMsToWallClock } from '../../../../lib/dates.mjs';
import { $, setStatus, used, escapeHtml } from './ui.js';

const HOUR = 3_600_000;
const ZONES = [
  ['Los Angeles', 'America/Los_Angeles'],
  ['New York', 'America/New_York'],
  ['London', 'Europe/London'],
  ['Berlin, Paris', 'Europe/Berlin'],
  ['India', 'Asia/Kolkata'],
  ['Beijing, Singapore', 'Asia/Shanghai'],
  ['Tokyo, Seoul', 'Asia/Tokyo'],
  ['Sydney', 'Australia/Sydney'],
];

const localZone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
const pad = (n) => String(n).padStart(2, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The wall clock of an instant in a zone ('AoE', 'UTC' or an IANA name), as
 * the pieces the page prints: `date` ("Fri 11 Sep 2026"), `time` ("12:00")
 * and the numbers behind them. A zone this browser's Intl does not know
 * falls back to UTC rather than to nothing.
 */
function wallClock(ms, zone) {
  const wc = utcMsToWallClock(ms, zone) ?? utcMsToWallClock(ms, 'UTC');
  const [y, mo, d, h, mi] = wc.split(/[- :]/).map(Number);
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return { y, mo, d, h, mi, dow, date: `${DAYS[dow]} ${d} ${MONTHS[mo - 1]} ${y}`, time: `${pad(h)}:${pad(mi)}` };
}
const whenText = (w, suffix = '') => `${w.date} ${w.time}${suffix}`;
/** A table cell's instant: two pieces that never break inside themselves. */
const whenCell = (w, suffix = '') => `<span>${escapeHtml(w.date)}</span> <span>${escapeHtml(w.time + suffix)}</span>`;
function zoneAbbrev(zone, ms) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date(ms));
    return parts.find((p) => p.type === 'timeZoneName')?.value || zone;
  } catch { return zone; }
}

// ----- clocks -----
const clocks = $('#aoeClocks');
if (clocks) {
  const aoeT = $('#aoeClockTime'), aoeD = $('#aoeClockDate');
  const utcT = $('#utcClockTime'), utcD = $('#utcClockDate');
  const locT = $('#localClockTime'), locD = $('#localClockDate'), locL = $('#localClockLabel');
  const tick = () => {
    const now = Date.now();
    const sec = pad(Math.floor(now / 1000) % 60); // every zone offset is whole minutes, so the seconds are UTC's
    const a = wallClock(now, 'AoE');
    aoeT.textContent = `${a.time}:${sec}`;
    aoeD.textContent = `${a.date} · UTC−12`;
    const u = wallClock(now, 'UTC');
    utcT.textContent = `${u.time}:${sec}`;
    utcD.textContent = u.date;
    const l = wallClock(now, localZone);
    locT.textContent = `${l.time}:${sec}`;
    locD.textContent = `${l.date} · ${zoneAbbrev(localZone, now)}`;
    locL.textContent = `Your time (${localZone.replace(/_/g, ' ')})`;
  };
  tick();
  setInterval(tick, 1000);
}

// ----- converter -----
const form = $('#aoeForm');
if (form) {
  const date = $('#aoeDate');
  const time = $('#aoeTime');
  const dir = $('#aoeDir');
  const status = $('#aoeStatus');
  const out = $('#aoeOut');
  const body = $('#aoeTable tbody');
  const headline = $('#aoeHeadline');
  const today = new Date();
  date.value = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  time.value = '23:59';

  function run() {
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.value);
    const tm = /^(\d{1,2}):(\d{2})$/.exec(time.value);
    if (!dm || !tm) { setStatus(status, 'Pick a date and a time.', 'error'); return; }
    const parts = { year: +dm[1], month: +dm[2], day: +dm[3], hour: +tm[1], minute: +tm[2] };
    const fromAoe = dir.value === 'aoe';
    let ms;
    try {
      ms = fromAoe ? zonedToUtcMs(parts, 'AoE') : zonedToUtcMs(parts, localZone);
    } catch {
      setStatus(status, 'That time could not be converted.', 'error');
      return;
    }
    const rows = [
      ['AoE (UTC−12)', wallClock(ms, 'AoE'), true],
      ['UTC', wallClock(ms, 'UTC'), false],
      [`Your time (${localZone.replace(/_/g, ' ')})`, wallClock(ms, localZone), true],
      ...ZONES.map(([label, zone]) => [label, wallClock(ms, zone), false]),
    ];
    body.innerHTML = rows.map(([label, when, strong]) => `<tr${strong ? ' class="is-strong"' : ''}><td>${escapeHtml(label)}</td><td class="num when">${whenCell(when)}</td></tr>`).join('');
    headline.textContent = fromAoe
      ? `${pad(parts.hour)}:${pad(parts.minute)} AoE on ${date.value} is ${whenText(wallClock(ms, localZone))} where you are.`
      : `${pad(parts.hour)}:${pad(parts.minute)} your time on ${date.value} is ${whenText(wallClock(ms, 'AoE'))} AoE.`;
    out.hidden = false;
    setStatus(status, '');
    used('aoe-time');
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); run(); });
  for (const el of [date, time, dir]) el.addEventListener('change', run);
  run();
}

// ----- open calls from the tracker -----
const callsData = $('#aoeCallsData');
const callsBody = $('#aoeCalls tbody');
if (callsData && callsBody) {
  let calls = [];
  try { calls = JSON.parse(callsData.textContent || '[]'); } catch { calls = []; }
  const base = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');
  const render = () => {
    const now = Date.now();
    callsBody.innerHTML = calls.map((c) => {
      const left = c.ms - now;
      const days = Math.floor(left / (24 * HOUR));
      const hours = Math.floor((left % (24 * HOUR)) / HOUR);
      const count = left <= 0 ? 'closed' : days > 0 ? `${days}d ${hours}h` : `${hours}h ${Math.floor((left % HOUR) / 60000)}m`;
      return `<tr><td><a href="${base}/workshop/${escapeHtml(c.slug)}/">${escapeHtml(c.name)}</a> <span class="muted small">${escapeHtml(c.conf)}</span></td><td class="num when">${whenCell(wallClock(c.ms, 'AoE'), ' AoE')}</td><td class="num when">${whenCell(wallClock(c.ms, localZone))}</td><td class="num nowrap">${count}</td></tr>`;
    }).join('') || '<tr><td colspan="4">No open calls right now.</td></tr>';
  };
  render();
  setInterval(render, 60000);
}

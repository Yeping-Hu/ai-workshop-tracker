/**
 * The AoE page: three live clocks (AoE, UTC, local), a converter in both
 * directions, and the tracker's open workshop deadlines in the visitor's
 * own time. AoE is a fixed UTC-12 (lib/dates.mjs owns that fact); every
 * other zone goes through Intl, which knows the daylight-saving rules.
 */
import { zonedToUtcMs } from '../../../../lib/dates.mjs';
import { $, setStatus, used, escapeHtml } from './ui.js';

const HOUR = 3_600_000;
const AOE_OFFSET_MS = 12 * HOUR;
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

/** Wall clock of an instant in AoE, from the UTC instant. */
function aoeParts(ms) {
  const d = new Date(ms - AOE_OFFSET_MS);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), dow: d.getUTCDay() };
}
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtZone(ms, zone) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms)).replace(',', '');
  } catch {
    return new Date(ms).toISOString();
  }
}
function fmtAoe(ms) {
  const p = aoeParts(ms);
  return `${DAYS[p.dow]} ${p.d} ${MONTHS[p.mo - 1]} ${p.y} ${pad(p.h)}:${pad(p.mi)}`;
}
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
    const a = aoeParts(now);
    aoeT.textContent = `${pad(a.h)}:${pad(a.mi)}:${pad(a.s)}`;
    aoeD.textContent = `${DAYS[a.dow]} ${a.d} ${MONTHS[a.mo - 1]} ${a.y} · UTC−12`;
    const u = new Date(now);
    utcT.textContent = `${pad(u.getUTCHours())}:${pad(u.getUTCMinutes())}:${pad(u.getUTCSeconds())}`;
    utcD.textContent = `${DAYS[u.getUTCDay()]} ${u.getUTCDate()} ${MONTHS[u.getUTCMonth()]} ${u.getUTCFullYear()}`;
    const l = new Date(now);
    locT.textContent = `${pad(l.getHours())}:${pad(l.getMinutes())}:${pad(l.getSeconds())}`;
    locD.textContent = `${DAYS[l.getDay()]} ${l.getDate()} ${MONTHS[l.getMonth()]} ${l.getFullYear()} · ${zoneAbbrev(localZone, now)}`;
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
      ['AoE (UTC−12)', fmtAoe(ms), true],
      ['UTC', fmtZone(ms, 'UTC'), false],
      [`Your time (${localZone.replace(/_/g, ' ')})`, fmtZone(ms, localZone), true],
      ...ZONES.map(([label, zone]) => [label, fmtZone(ms, zone), false]),
    ];
    body.innerHTML = rows.map(([label, when, strong]) => `<tr${strong ? ' class="is-strong"' : ''}><td>${escapeHtml(label)}</td><td class="num">${escapeHtml(when)}</td></tr>`).join('');
    headline.textContent = fromAoe
      ? `${pad(parts.hour)}:${pad(parts.minute)} AoE on ${date.value} is ${fmtZone(ms, localZone)} where you are.`
      : `${pad(parts.hour)}:${pad(parts.minute)} your time on ${date.value} is ${fmtAoe(ms)} AoE.`;
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
      return `<tr><td><a href="${base}/workshop/${escapeHtml(c.slug)}/">${escapeHtml(c.name)}</a> <span class="muted small">${escapeHtml(c.conf)}</span></td><td class="num">${escapeHtml(fmtAoe(c.ms))} AoE</td><td class="num">${escapeHtml(fmtZone(c.ms, localZone))}</td><td class="num">${count}</td></tr>`;
    }).join('') || '<tr><td colspan="4">No open calls right now.</td></tr>';
  };
  render();
  setInterval(render, 60000);
}

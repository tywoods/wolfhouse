'use strict';

/**
 * Sunset Schedule — Day Cockpit band UI (P1 isolated module).
 *
 * Framework-free render of the control bar + ON NOW hero + day ribbon + prep rail.
 * Not mounted into buildUiHtml yet (P2). Does not fetch, mutate bookings, or own nav state.
 *
 * Pure derivation (from design reference cockpit.js — keep verbatim):
 *   scheduleCockpitFmtDur / scheduleCockpitClassify / scheduleCockpitPct
 *
 * Data: reshape existing schedule VM via scheduleBuildDayCockpitData — no new queries.
 *
 * Optional globals when live (P2): none required for isolated render(data).
 */

/* ── Exact palette from design handoff (cockpit.css). Do not silently substitute. ──
 *
 * TOKEN MAPPING REPORT (portal/sched tokens vs exact ck values):
 * | ck token / value              | nearest portal/sched token     | exact? |
 * |-------------------------------|--------------------------------|--------|
 * | --ck-surface #f7f5ef          | --surface #F5F1EA / --sched-surface-warm #FAF7F2 | NO |
 * | --ck-surface-2 #f2efe5        | --sched-surface-soft #F0EBE3   | NO     |
 * | --ck-chip #efece2             | --sand #E0D8CC / --surface-soft #EDE8E0 | NO |
 * | --ck-ink #3a3226              | --sched-text #2A2418           | NO     |
 * | --ck-ink-2 #6f6757            | --sched-text-2 #5C4F3F         | NO     |
 * | --ck-ink-3 #8d856f            | --sched-text-3 #8A7968         | NO (close) |
 * | --ck-ink-4 #a1997f            | --text-3 #959F99               | NO     |
 * | --ck-olive #6b7a5e            | --sched-primary / --primary #4E5853 | NO (different green) |
 * | --ck-olive-dark #5c6a50       | --sched-primary-hover #3F4843  | NO     |
 * | --ck-dark #302c22             | —                              | n/a    |
 * | --ck-now-bg #22301f           | —                              | n/a    |
 * | --ck-now-ink #eef2e9          | —                              | n/a    |
 * | --ck-now-ink-2 #9fb392        | —                              | n/a    |
 * | --ck-now-accent #a8c48f       | —                              | n/a    |
 * | --ck-alert #a8563a            | --sched-unpaid #B4534A         | NO     |
 * | --ck-alert-bg #f6e6df         | unpaid chip rgba fills         | NO     |
 * | --ck-done-bg #cfd6c4          | —                              | n/a    |
 * | --ck-done-border #b3bfa5      | —                              | n/a    |
 * | legend Luna #7b8fb5           | --sched-rail-luna #8499B0      | NO     |
 * | legend Staff #6b8f5e          | --sched-rail-staff #7DA896     | NO     |
 * | page bg #eae7dd (context)     | --cream / --sunset-bg #EDE8E0  | NO     |
 *
 * P1 keeps EXACT --ck-* hex values on .cockpit. Map only where values match byte-for-byte
 * (none of the core cockpit surfaces do). Font inherits Instrument Sans via font-family:inherit.
 */

var SCHEDULE_DAY_COCKPIT_CSS = [
  '/* Luna front desk — day cockpit (light tokens exact from design; dark via [data-theme=dark]) */',
  '.cockpit{',
  '  --ck-surface:#f7f5ef;',
  '  --ck-surface-2:#f2efe5;',
  '  --ck-chip:#efece2;',
  '  --ck-line:rgba(60,45,20,.11);',
  '  --ck-line-soft:rgba(60,45,20,.09);',
  '  --ck-line-mid:rgba(60,45,20,.1);',
  '  --ck-line-strong:rgba(60,45,20,.12);',
  '  --ck-line-ghost:rgba(60,45,20,.14);',
  '  --ck-track:rgba(60,45,20,.06);',
  '  --ck-dash:rgba(60,45,20,.28);',
  '  --ck-ink:#3a3226;',
  '  --ck-ink-2:#6f6757;',
  '  --ck-ink-3:#8d856f;',
  '  --ck-ink-4:#a1997f;',
  '  --ck-olive:#6b7a5e;',
  '  --ck-olive-dark:#5c6a50;',
  '  --ck-dark:#302c22;',
  '  --ck-on-dark:#f4f1e8;',
  '  --ck-now-bg:#22301f;',
  '  --ck-now-ink:#eef2e9;',
  '  --ck-now-ink-2:#9fb392;',
  '  --ck-now-accent:#a8c48f;',
  '  --ck-alert:#a8563a;',
  '  --ck-alert-bg:#f6e6df;',
  '  --ck-done-bg:#cfd6c4;',
  '  --ck-done-border:#b3bfa5;',
  '  --ck-done-ink:#4a5340;',
  '  --ck-ghost-ink:#5c5548;',
  '  background:var(--ck-surface);',
  '  border:1px solid var(--ck-line);',
  '  border-radius:14px;',
  '  overflow:hidden;',
  '  color:var(--ck-ink);',
  '  font-family:inherit;',
  '}',
  /* Dark mode — match portal schedule cards, no light island */
  '[data-theme="dark"] .cockpit{',
  '  --ck-surface:#252526;',
  '  --ck-surface-2:#2d2d2d;',
  '  --ck-chip:#3a3a3a;',
  '  --ck-line:rgba(255,255,255,.10);',
  '  --ck-line-soft:rgba(255,255,255,.08);',
  '  --ck-line-mid:rgba(255,255,255,.10);',
  '  --ck-line-strong:rgba(255,255,255,.12);',
  '  --ck-line-ghost:rgba(255,255,255,.14);',
  '  --ck-track:rgba(255,255,255,.06);',
  '  --ck-dash:rgba(255,255,255,.22);',
  '  --ck-ink:#e4dfd4;',
  '  --ck-ink-2:#b0a898;',
  '  --ck-ink-3:#8a8478;',
  '  --ck-ink-4:#6e6a60;',
  '  --ck-olive:#6a9a72;',
  '  --ck-olive-dark:#5a8a62;',
  '  --ck-dark:#1a1a1a;',
  '  --ck-on-dark:#f0ebe3;',
  '  --ck-now-bg:#1a281c;',
  '  --ck-now-ink:#eef2e9;',
  '  --ck-now-ink-2:#9fb392;',
  '  --ck-now-accent:#a8c48f;',
  '  --ck-alert:#d4785a;',
  '  --ck-alert-bg:rgba(168,86,58,.22);',
  '  --ck-done-bg:#3a4238;',
  '  --ck-done-border:#4a5348;',
  '  --ck-done-ink:#c5d0b8;',
  '  --ck-ghost-ink:#b0a898;',
  '}',
  '.ck-bar{display:flex;align-items:center;gap:12px;padding:12px 18px;border-bottom:1px solid var(--ck-line-soft);flex-wrap:wrap;}',
  '.ck-seg{display:flex;background:var(--ck-chip);border:1px solid var(--ck-line-mid);border-radius:99px;padding:3px;}',
  '.ck-seg button{appearance:none;border:0;background:none;cursor:pointer;font:inherit;padding:6px 15px;border-radius:99px;font-size:12.5px;color:var(--ck-ink-2);}',
  '.ck-seg button:hover{color:var(--ck-ink);}',
  '.ck-seg button[aria-pressed="true"]{background:var(--ck-olive);color:#fff;font-weight:600;}',
  '.ck-seg--range button[aria-pressed="true"]{background:var(--ck-dark);color:var(--ck-on-dark);}',
  '@media (max-width:768px){.ck-seg--layout{display:none!important;}}',
  '.ck-date{display:flex;flex-direction:column;gap:1px;}',
  '.ck-date b{font-size:16px;font-weight:700;letter-spacing:-.01em;line-height:1.1;}',
  '.ck-date span{font-size:11px;color:var(--ck-ink-3);}',
  '.ck-legend{display:flex;gap:11px;margin-left:6px;font-size:11.5px;color:var(--ck-ink-2);}',
  '.ck-legend span{display:flex;align-items:center;gap:5px;}',
  '.ck-dot{width:7px;height:7px;border-radius:99px;}',
  '.ck-dot--luna{background:#7b8fb5;}',
  '.ck-dot--staff{background:#6b8f5e;}',
  '.ck-bar__right{margin-left:auto;display:flex;align-items:center;gap:7px;}',
  '.ck-icon-btn{appearance:none;font:inherit;cursor:pointer;background:var(--ck-chip);border:1px solid var(--ck-line-strong);border-radius:99px;width:32px;height:32px;display:grid;place-items:center;font-size:13px;color:var(--ck-ink-2);}',
  '.ck-icon-btn:hover{border-color:var(--ck-ink);color:var(--ck-ink);}',
  '.ck-cta{appearance:none;font:inherit;cursor:pointer;border:0;background:var(--ck-olive);color:#fff;border-radius:99px;padding:9px 20px;font-size:13px;font-weight:600;}',
  '.ck-cta:hover{background:var(--ck-olive-dark);}',
  '.ck-cta--ghost{background:var(--ck-chip);color:var(--ck-ghost-ink);border:1px solid var(--ck-line-ghost);font-weight:500;padding:7px 15px;font-size:12px;}',
  '.ck-cta--ghost:hover{border-color:var(--ck-ink);background:var(--ck-chip);}',
  '.ck-cta--sm{padding:7px 15px;font-size:12px;}',
  '.ck-body{display:grid;grid-template-columns:1fr 270px;}',
  '@media (max-width:1080px){.ck-body{grid-template-columns:1fr;}}',
  '.ck-main{padding:16px 18px;display:flex;flex-direction:column;gap:12px;border-right:1px solid var(--ck-line-soft);}',
  '.ck-now{background:var(--ck-now-bg);color:var(--ck-now-ink);border-radius:12px;padding:17px 20px;display:flex;align-items:center;gap:20px;flex-wrap:wrap;}',
  '.ck-eyebrow{display:flex;align-items:center;gap:8px;font-size:10px;font-weight:700;letter-spacing:.16em;color:var(--ck-now-accent);}',
  '.ck-pulse{width:7px;height:7px;border-radius:99px;background:var(--ck-now-accent);box-shadow:0 0 9px rgba(168,196,143,.9);}',
  '.ck-now h2{margin:5px 0 0;font-size:25px;font-weight:600;letter-spacing:-.01em;line-height:1.15;}',
  '.ck-now__sub{font-size:12.5px;color:var(--ck-now-ink-2);margin-top:4px;}',
  '.ck-chips{display:flex;gap:6px;margin-top:11px;flex-wrap:wrap;}',
  '.ck-chip{font-size:11.5px;font-weight:600;background:rgba(255,255,255,.12);border-radius:99px;padding:4px 11px;}',
  '.ck-chip--muted{background:rgba(255,255,255,.07);color:var(--ck-now-ink-2);}',
  '.ck-seats{margin-left:auto;display:flex;align-items:center;gap:11px;}',
  '.ck-ring{width:56px;height:56px;border-radius:99px;display:grid;place-items:center;background:conic-gradient(var(--ck-now-accent) 0 var(--ck-ring-deg,0deg),rgba(255,255,255,.14) var(--ck-ring-deg,0deg) 360deg);}',
  '.ck-ring i{width:43px;height:43px;border-radius:99px;background:var(--ck-now-bg);display:grid;place-items:center;font-style:normal;font-size:13.5px;font-weight:700;}',
  '.ck-ring i span{font-size:9px;color:var(--ck-now-ink-2);}',
  '.ck-ring.is-booked-only{background:rgba(255,255,255,.14);}',
  '.ck-seats__label{font-size:11px;color:var(--ck-now-ink-2);line-height:1.35;}',
  '.ck-now--idle{background:var(--ck-surface-2);color:var(--ck-ink);border:1px solid var(--ck-line);}',
  '.ck-now--idle .ck-eyebrow{color:var(--ck-ink-3);}',
  '.ck-now--idle .ck-pulse{background:none;border:1.5px solid var(--ck-ink-3);box-shadow:none;}',
  '.ck-now--idle .ck-now__sub{color:var(--ck-ink-3);}',
  '.ck-now--idle .ck-chip{background:var(--ck-chip);color:var(--ck-ink-2);}',
  '.ck-ribbon{position:relative;min-height:58px;margin:0 4px;}',
  '.ck-ribbon__track{position:absolute;left:0;right:0;top:20px;bottom:14px;background:var(--ck-track);border-radius:8px;pointer-events:none;}',
  '.ck-block{position:absolute;border-radius:8px;border:0;display:flex;align-items:center;justify-content:center;gap:6px;font:inherit;font-size:11px;font-weight:600;cursor:pointer;padding:0 6px;white-space:nowrap;overflow:hidden;z-index:2;pointer-events:auto;}',
  '.ck-block--live{background:var(--ck-now-bg);color:var(--ck-now-ink);font-weight:700;}',
  '.ck-block--done{background:var(--ck-done-bg);border:1px solid var(--ck-done-border);color:var(--ck-done-ink);font-weight:700;}',
  '.ck-block--empty{background:var(--ck-surface);border:1.5px dashed var(--ck-dash);color:var(--ck-ink-3);}',
  '.ck-block--empty:hover{border-color:var(--ck-olive);color:var(--ck-olive);}',
  '.ck-needle{position:absolute;top:0;bottom:8px;width:2px;background:var(--ck-alert);border-radius:99px;pointer-events:none;z-index:3;}',
  '.ck-needle b{position:absolute;top:-2px;left:1px;transform:translateX(-50%);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9.5px;font-weight:700;color:#fff;background:var(--ck-alert);border-radius:4px;padding:1px 6px;pointer-events:none;}',
  '.ck-hours{position:absolute;left:0;right:0;bottom:-2px;display:flex;justify-content:space-between;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9.5px;color:var(--ck-ink-4);pointer-events:none;}',
  '.ck-prep{padding:16px 20px;display:flex;flex-direction:column;justify-content:center;gap:10px;background:var(--ck-surface-2);}',
  '.ck-prep h3{margin:0;font-size:10px;font-weight:700;letter-spacing:.12em;color:var(--ck-ink-3);}',
  '.ck-prep__row{display:flex;justify-content:space-between;align-items:baseline;font-size:12.5px;color:var(--ck-ink-2);}',
  '.ck-prep__row strong{font-size:16px;color:var(--ck-ink);}',
  '.ck-prep__row em{font-style:normal;font-size:11px;color:var(--ck-ink-4);white-space:nowrap;}',
  '.ck-prep__row > span:last-child{white-space:nowrap;}',
  '.ck-prep__rule{height:1px;background:var(--ck-line-mid);margin:2px 0;}',
  '.ck-prep__row--alert{align-items:center;}',
  '.ck-prep__row--alert span:first-child{color:var(--ck-alert);font-weight:600;}',
  '.ck-badge{background:var(--ck-alert-bg);color:var(--ck-alert);border-radius:99px;padding:2px 10px;font-size:12px;font-weight:700;}',
  '.ck-prep__row--quiet{color:var(--ck-ink-3);align-items:center;}',
  '.ck-prep__row--quiet span:last-child{font-size:12px;}',
].join('\n');

function scheduleCockpitPad(n) {
  return String(n).padStart(2, '0');
}

/** Horario chrome/hero copy — portalT when present, EN fallback otherwise. */
function scheduleCockpitIsPageLoading() {
  try {
    if (typeof SunsetScheduleRuntime !== 'undefined'
      && SunsetScheduleRuntime.nav
      && typeof SunsetScheduleRuntime.nav.isPageLoading === 'function') {
      return SunsetScheduleRuntime.nav.isPageLoading() === true;
    }
  } catch (_e) { /* keep */ }
  return false;
}
function scheduleCockpitT(key, fallback, vars) {
  var raw = fallback;
  try {
    var fn = null;
    if (typeof portalT === 'function') fn = portalT;
    else if (typeof globalThis !== 'undefined' && typeof globalThis.portalT === 'function') fn = globalThis.portalT;
    if (fn) {
      var v = fn(key);
      if (v && v !== key) raw = v;
    }
  } catch (_e) { /* keep fallback */ }
  raw = String(raw == null ? '' : raw);
  if (vars) {
    Object.keys(vars).forEach(function (k) {
      raw = raw.split('{' + k + '}').join(String(vars[k]));
    });
  }
  return raw;
}

function scheduleCockpitShortDateLabel(dateIso) {
  var iso = String(dateIso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  var dt = new Date(iso + 'T00:00:00');
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function scheduleCockpitPrepTitle(isToday, dateIso) {
  if (isToday) return scheduleCockpitT('schedule.cockpit.prepTitle', "TODAY'S PREP");
  var dateLabel = scheduleCockpitShortDateLabel(dateIso);
  var other = scheduleCockpitT('schedule.cockpit.prepTitleOther', 'PREP FOR {date}', { date: dateLabel });
  if (other && other !== 'schedule.cockpit.prepTitleOther') return other;
  return dateLabel ? ('PREP · ' + dateLabel) : 'PREP';
}

/** Horario-only display fix: course name must be Medio Día. */
function scheduleCockpitDisplayName(name) {
  return String(name == null ? '' : name).replace(/Medio Dia/g, 'Medio D\u00eda');
}

function scheduleCockpitToMin(hhmm) {
  var parts = String(hhmm || '').split(':').map(Number);
  return parts[0] * 60 + (parts[1] || 0);
}

/** Verbatim from design reference cockpit.js `fmtDur`. */

/**
 * Count-based relative day label vs today (calendar days, date-only).
 * Returns { key, n, textKey, text } for i18n; d===0 is today (caller keeps rich hero).
 */
function scheduleCockpitRelativeDayLabel(dateIso, todayDate) {
  var iso = String(dateIso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return { key: 'unknown', n: 0, text: '' };
  }
  var today = todayDate instanceof Date ? todayDate : new Date();
  var t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  var parts = iso.split('-');
  var d0 = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  var ms = d0.getTime() - t0.getTime();
  var d = Math.round(ms / 86400000);
  if (d === 0) return { key: 'today', n: 0, textKey: 'schedule.cockpit.rel.today', text: 'Today' };

  function monthsApart(a, b) {
    return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  }
  function yearsApart(a, b) {
    return b.getFullYear() - a.getFullYear();
  }

  var abs = Math.abs(d);
  var past = d < 0;
  var key, n = abs, textKey, text;

  if (abs === 1) {
    key = past ? 'yesterday' : 'tomorrow';
    textKey = past ? 'schedule.cockpit.rel.yesterday' : 'schedule.cockpit.rel.tomorrow';
    text = past ? 'Yesterday' : 'Tomorrow';
  } else if (abs >= 2 && abs <= 6) {
    key = past ? 'daysAgo' : 'inDays';
    n = abs;
    textKey = past ? 'schedule.cockpit.rel.daysAgo' : 'schedule.cockpit.rel.inDays';
    text = past ? (n + ' days ago') : ('In ' + n + ' days');
  } else if (abs >= 7 && abs <= 13) {
    key = past ? 'lastWeek' : 'nextWeek';
    n = 1;
    textKey = past ? 'schedule.cockpit.rel.lastWeek' : 'schedule.cockpit.rel.nextWeek';
    text = past ? 'Last week' : 'Next week';
  } else if (abs >= 14 && abs <= 20) {
    key = past ? 'weeksAgo' : 'inWeeks';
    n = 2;
    textKey = past ? 'schedule.cockpit.rel.weeksAgo' : 'schedule.cockpit.rel.inWeeks';
    text = past ? '2 weeks ago' : 'In 2 weeks';
  } else if (abs >= 21 && abs <= 27) {
    key = past ? 'weeksAgo' : 'inWeeks';
    n = 3;
    textKey = past ? 'schedule.cockpit.rel.weeksAgo' : 'schedule.cockpit.rel.inWeeks';
    text = past ? '3 weeks ago' : 'In 3 weeks';
  } else {
    // months / years via calendar unit
    var mDiff = monthsApart(t0, d0); // signed
    var aM = Math.abs(mDiff);
    if (aM < 12) {
      if (aM <= 1) {
        key = past ? 'lastMonth' : 'nextMonth';
        n = 1;
        textKey = past ? 'schedule.cockpit.rel.lastMonth' : 'schedule.cockpit.rel.nextMonth';
        text = past ? 'Last month' : 'Next month';
      } else {
        key = past ? 'monthsAgo' : 'inMonths';
        n = aM;
        textKey = past ? 'schedule.cockpit.rel.monthsAgo' : 'schedule.cockpit.rel.inMonths';
        text = past ? (n + ' months ago') : ('In ' + n + ' months');
      }
    } else {
      var yDiff = yearsApart(t0, d0);
      // prefer calendar-month when under 12; else years from full year span, min 1
      var aY = Math.max(1, Math.abs(yDiff) || Math.floor(aM / 12));
      if (aY === 1) {
        key = past ? 'lastYear' : 'nextYear';
        n = 1;
        textKey = past ? 'schedule.cockpit.rel.lastYear' : 'schedule.cockpit.rel.nextYear';
        text = past ? 'Last year' : 'Next year';
      } else {
        key = past ? 'yearsAgo' : 'inYears';
        n = aY;
        textKey = past ? 'schedule.cockpit.rel.yearsAgo' : 'schedule.cockpit.rel.inYears';
        text = past ? (n + ' years ago') : ('In ' + n + ' years');
      }
    }
  }
  return { key: key, n: n, textKey: textKey, text: text, deltaDays: d };
}

function scheduleCockpitRelativeDayLabelText(dateIso, todayDate) {
  var info = scheduleCockpitRelativeDayLabel(dateIso, todayDate);
  if (!info || !info.textKey) return info && info.text ? info.text : '';
  var raw = '';
  try {
    if (typeof portalT === 'function') raw = portalT(info.textKey);
  } catch (_e) { raw = ''; }
  if (!raw || raw === info.textKey) raw = info.text || '';
  if (info.n != null && /\{n\}/.test(raw)) raw = raw.split('{n}').join(String(info.n));
  return raw;
}

function scheduleCockpitFmtDur(mins) {
  if (mins < 60) return mins + ' min';
  var h = Math.floor(mins / 60), m = mins % 60;
  return m ? h + ' h ' + m + ' m' : h + ' h';
}

/**
 * Verbatim ribbon % math from design reference cockpit.js `pct`.
 * Pure form: same formula with explicit winStartHour + spanMin.
 */
function scheduleCockpitPct(min, winStartHour, spanMin) {
  return ((min - winStartHour * 60) / spanMin) * 100;
}

/** Pack overlapping ribbon sessions into vertical lanes so one block cannot steal another. */
function scheduleCockpitAssignLanes(list) {
  var items = (list || []).slice().sort(function (a, b) {
    var ds = (a.s == null ? 0 : a.s) - (b.s == null ? 0 : b.s);
    if (ds) return ds;
    return ((b.e == null ? 0 : b.e) - (b.s == null ? 0 : b.s)) - ((a.e == null ? 0 : a.e) - (a.s == null ? 0 : a.s));
  });
  var laneEnds = [];
  items.forEach(function (s) {
    var start = s.s == null ? 0 : s.s;
    var end = s.e == null ? start : s.e;
    if (end <= start) end = start + 1;
    var lane = 0;
    while (lane < laneEnds.length && laneEnds[lane] > start) lane += 1;
    s.lane = lane;
    laneEnds[lane] = end;
  });
  return { list: items, laneCount: Math.max(1, laneEnds.length) };
}

/** Verbatim from design reference cockpit.js `classify`. */
function scheduleCockpitClassify(data, now) {
  var list = (data.sessions || []).filter(function (s) { return !s.cancelled; })
    .map(function (s) {
      return Object.assign({}, s, { s: scheduleCockpitToMin(s.start), e: scheduleCockpitToMin(s.end) });
    })
    .sort(function (a, b) { return a.s - b.s; });
  var live = now == null ? null : list.find(function (x) { return now >= x.s && now < x.e; }) || null;
  var next = now == null ? list[0] || null : list.find(function (x) { return x.s > now; }) || null;
  return { list: list, live: live, next: next };
}

function scheduleCockpitNowMinutes(data) {
  data = data || {};
  var range = data.range || scheduleCockpitRangeFromNavMode(data.navMode || data.mode);
  // README freeze rules take precedence over any now override:
  // Non-today dates and Week / Next 30 days → no needle, no countdown, no live hero.
  // 1) Week / Next 30 — always frozen (no forceNow bypass).
  if (range === 'week' || range === 'next30') return null;
  // 2) Day range: freeze when the shown date is not today (override cannot unfreeze).
  var d = new Date();
  var shown = data.date ? new Date(data.date + 'T00:00:00') : d;
  var sameDay = d.toDateString() === shown.toDateString();
  if (!sameDay) return null;
  // 3) Today + day range only: honor explicit now, else wall clock.
  if (typeof data.now === 'number') return data.now;
  return d.getHours() * 60 + d.getMinutes();
}

/** True when 60s needle/countdown tick should run (today + day range only). */
function scheduleDayCockpitShouldTick(data) {
  data = data || {};
  // Fixture paint-once: explicit now freezes the interval (re-render still uses override).
  if (typeof data.now === 'number') return false;
  // Align with nowMinutes freeze gates (week/next30/non-today → no tick).
  var probe = Object.assign({}, data);
  delete probe.now;
  return scheduleCockpitNowMinutes(probe) != null;
}

function scheduleCockpitEl(doc, tag, cls, text) {
  var n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function scheduleCockpitHasCapacity(cap) {
  var n = cap == null || cap === '' ? NaN : Number(cap);
  return isFinite(n) && n > 0;
}

function scheduleCockpitCapacityLabel(booked, capacity) {
  if (scheduleCockpitHasCapacity(capacity)) return String(booked) + '/' + String(capacity);
  return String(booked);
}

/**
 * Port of design reference render() into schedule browser-module idiom.
 * Capacity missing/0 → seats ring degrades to booked-only (no divide-by-zero).
 * note chip skipped for v1 when absent.
 */
function scheduleRenderDayCockpit(mount, data) {
  if (!mount) return;
  var doc = mount.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc) return;
  data = data || {};
  var el = function (tag, cls, text) { return scheduleCockpitEl(doc, tag, cls, text); };

  var now = scheduleCockpitNowMinutes(data);
  var classified = scheduleCockpitClassify(data, now);
  var list = classified.list;
  var live = classified.live;
  var next = classified.next;
  var on = data.on || {};
  var firstStart = list.length ? Math.min.apply(null, list.map(function (x) { return x.s; })) : 480;
  var lastEnd = list.length ? Math.max.apply(null, list.map(function (x) { return x.e; })) : 1200;
  var wanted = data.window || [Math.floor(firstStart / 60) - 2, Math.ceil(lastEnd / 60) + 2];
  // never let a block fall outside the track, whatever window was asked for
  var win = [
    Math.max(0, Math.min(wanted[0], Math.floor(firstStart / 60))),
    Math.min(24, Math.max(wanted[1], Math.ceil(lastEnd / 60))),
  ];
  var spanMin = (win[1] - win[0]) * 60;
  var pct = function (min) { return scheduleCockpitPct(min, win[0], spanMin); };

  // Keep host class — margin/spacing selectors live on .ps-day-cockpit-host.
  mount.className = 'cockpit ps-day-cockpit-host';
  mount.innerHTML = '';

  /* ----- control bar ----- */
  var bar = el('div', 'ck-bar');
  var nav = el('div', 'ck-seg');
  var dt = data.date ? new Date(data.date + 'T00:00:00') : new Date();
  var isToday = new Date().toDateString() === dt.toDateString();
  [
    [scheduleCockpitT('schedule.nav.prev', 'Previous'), on.prev, false],
    [scheduleCockpitT('schedule.nav.today', 'Today'), on.today, isToday],
    [scheduleCockpitT('schedule.nav.next', 'Next'), on.next, false],
  ].forEach(function (row) {
    var label = row[0], fn = row[1], active = row[2];
    var b = el('button', null, label);
    b.type = 'button';
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
    if (fn) b.addEventListener('click', fn);
    nav.appendChild(b);
  });
  bar.appendChild(nav);

  var dateWrap = el('div', 'ck-date');
  // Date only — no "Today ·" prefix (redundant with Previous/Today/Next seg).
  // Non-today keeps a short weekday so staff know which day they're on.
  // Always prefer live nav mode for Monthly vs Daily — stale src.range must not pin the header.
  var liveNavMode = null;
  try {
    if (typeof scheduleCurrentViewMode === 'function') liveNavMode = scheduleCurrentViewMode();
  } catch (_navMode) { liveNavMode = null; }
  var dateLabel;
  var rangeKey = scheduleCockpitRangeFromNavMode(
    liveNavMode || data.navMode || data.mode || data.range
  );
  if (rangeKey === 'next30') {
    var monthIso = data.date || data.rangeStartIso || '';
    try {
      if (typeof scheduleGetNavigationSnapshot === 'function') {
        var navSnap = scheduleGetNavigationSnapshot();
        if (navSnap && (navSnap.rangeStartIso || navSnap.focusDateIso)) {
          monthIso = navSnap.rangeStartIso || navSnap.focusDateIso;
        }
      }
    } catch (_hdr) { /* keep data.date */ }
    var monthDt = monthIso ? new Date(String(monthIso).slice(0, 10) + 'T00:00:00') : dt;
    dateLabel = monthDt.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  } else {
    dateLabel = dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }
  dateWrap.appendChild(el('b', null, dateLabel));
  var guests = list.reduce(function (n, s) { return n + (s.booked || 0); }, 0);
  var sessWord = list.length === 1
    ? scheduleCockpitT('schedule.cockpit.sessionOne', 'session')
    : scheduleCockpitT('schedule.cockpit.sessionMany', 'sessions');
  var guestWord = guests === 1
    ? scheduleCockpitT('schedule.cockpit.guestOne', 'guest')
    : scheduleCockpitT('schedule.cockpit.guestMany', 'guests');
  dateWrap.appendChild(el('span', null,
    scheduleCockpitT('schedule.cockpit.forVenue',
      'Schedule for {venue} · {sessions} · {guests}',
      {
        venue: data.venue || '—',
        sessions: list.length + ' ' + sessWord,
        guests: guests + ' ' + guestWord,
      })));
  bar.appendChild(dateWrap);

  var legend = el('div', 'ck-legend');
  legend.innerHTML = '<span><i class="ck-dot ck-dot--luna"></i>' +
    scheduleCockpitT('schedule.cockpit.luna', 'Luna') + '</span><span><i class="ck-dot ck-dot--staff"></i>' +
    scheduleCockpitT('schedule.cockpit.staff', 'Staff') + '</span>';
  bar.appendChild(legend);

  var right = el('div', 'ck-bar__right');
  var ranges = el('div', 'ck-seg ck-seg--range');
  // Daily / Monthly only — weekly view retired. Keys stay today|next30 for nav.setView.
  // rangeKey already resolved from live nav above — keep pills in sync with header/grid.
  if (rangeKey === 'week') rangeKey = 'today'; // legacy week → Daily
  [['today', scheduleCockpitT('schedule.cockpit.range.daily', 'Daily')],
   ['next30', scheduleCockpitT('schedule.cockpit.range.monthly', 'Monthly')]].forEach(function (row) {
    var key = row[0], label = row[1];
    var b = el('button', null, label);
    b.type = 'button';
    var pressed = rangeKey === key;
    b.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    if (on.range) b.addEventListener('click', function () { on.range(key); });
    ranges.appendChild(b);
  });
  right.appendChild(ranges);
  // Timeline | Cards — same chrome as Daily/Monthly; place may move later.
  var layouts = el('div', 'ck-seg ck-seg--layout');
  var layoutKey = data.layout === 'cards' ? 'cards' : 'timeline';
  [['timeline', scheduleCockpitT('schedule.cockpit.layout.timeline', 'Timeline')],
   ['cards', scheduleCockpitT('schedule.cockpit.layout.cards', 'Cards')]].forEach(function (row) {
    var key = row[0], label = row[1];
    var b = el('button', null, label);
    b.type = 'button';
    b.setAttribute('aria-pressed', layoutKey === key ? 'true' : 'false');
    if (on.layout) b.addEventListener('click', function () { on.layout(key); });
    layouts.appendChild(b);
  });
  right.appendChild(layouts);
  var refresh = el('button', 'ck-icon-btn', '\u21bb');
  refresh.type = 'button';
  refresh.setAttribute('aria-label', scheduleCockpitT('schedule.cockpit.refresh', 'Refresh'));
  if (on.refresh) refresh.addEventListener('click', on.refresh);
  right.appendChild(refresh);
  var create = el('button', 'ck-cta', scheduleCockpitT('schedule.createBooking', 'Create booking'));
  create.type = 'button';
  if (on.create) create.addEventListener('click', function () { on.create(null); });
  right.appendChild(create);
  bar.appendChild(right);
  mount.appendChild(bar);

  /* ----- body ----- */
  var body = el('div', 'ck-body');
  var main = el('div', 'ck-main');

  /* NOW hero */
  var hero = el('div', 'ck-now');
  var heroL = el('div');
  var eyebrow = el('div', 'ck-eyebrow');
  eyebrow.appendChild(el('i', 'ck-pulse'));
  if (live) {
    eyebrow.appendChild(el('span', null, scheduleCockpitT('schedule.cockpit.hero.onNow', 'ON NOW · ENDS {time}', { time: live.end })));
    heroL.appendChild(eyebrow);
    heroL.appendChild(el('h2', null, scheduleCockpitDisplayName(live.name)));
    heroL.appendChild(el('div', 'ck-now__sub',
      live.start + ' \u2013 ' + live.end + ' \u00b7 ' +
      scheduleCockpitT('schedule.cockpit.hero.endsIn', 'ends in {dur}', { dur: scheduleCockpitFmtDur(live.e - now) })));
    var chips = el('div', 'ck-chips');
    // Session-scoped exact add-ons only (never day-wide prep or decomposed boards/wetsuits).
    scheduleCockpitAppendExactPrepChips(chips, live.prepItems, 'out');
    // note chip: optional/new — SKIP for v1
    heroL.appendChild(chips);
    hero.appendChild(heroL);

    var seats = el('div', 'ck-seats');
    var ring = el('div', 'ck-ring');
    var hasCap = scheduleCockpitHasCapacity(live.capacity);
    if (hasCap) {
      ring.style.setProperty('--ck-ring-deg', Math.round((live.booked / live.capacity) * 360) + 'deg');
    } else {
      ring.className = 'ck-ring is-booked-only';
      ring.style.setProperty('--ck-ring-deg', '0deg');
    }
    var inner = el('i');
    inner.appendChild(doc.createTextNode(String(live.booked || 0)));
    if (hasCap) inner.appendChild(el('span', null, '/' + live.capacity));
    ring.appendChild(inner);
    seats.appendChild(ring);
    var lbl = el('div', 'ck-seats__label');
    lbl.innerHTML = scheduleCockpitT('schedule.cockpit.hero.seatsBooked', 'seats<br>booked');
    seats.appendChild(lbl);
    hero.appendChild(seats);
  } else {
    hero.classList.add('ck-now--idle');
    if (!isToday) {
      // Non-today: relative label + light day summary (no live "First up" / countdown / prep chips).
      var relLabel = scheduleCockpitRelativeDayLabelText(data.date, new Date());
      eyebrow.appendChild(el('span', null, String(relLabel || '').toUpperCase()));
      heroL.appendChild(eyebrow);
      heroL.appendChild(el('h2', null,
        list.length + ' ' + sessWord + ' \u00b7 ' + guests + ' ' + guestWord));
      if (next) {
        heroL.appendChild(el('div', 'ck-now__sub',
          (next.name ? scheduleCockpitDisplayName(next.name) + ' \u00b7 ' : '') + next.start + ' \u2013 ' + next.end));
      } else if (!list.length) {
        heroL.appendChild(el('div', 'ck-now__sub', scheduleCockpitT('schedule.cockpit.hero.noSessions', 'No sessions scheduled')));
      }
      hero.appendChild(heroL);
    } else {
      var loadingHero = !!(data.loading) && !list.length;
      var done = !loadingHero && now != null && list.length && now >= Math.max.apply(null, list.map(function (x) { return x.e; }));
      var eyebrowText = loadingHero
        ? scheduleCockpitT('daySchedule.loading', 'Loading…')
        : (done
          ? scheduleCockpitT('schedule.cockpit.hero.dayComplete', 'DAY COMPLETE')
          : scheduleCockpitT('schedule.cockpit.hero.nothingInWater', 'NOTHING IN THE WATER'));
      var titleText = loadingHero
        ? scheduleCockpitT('daySchedule.loading', 'Loading…')
        : (done
          ? scheduleCockpitT('schedule.cockpit.hero.sessionsRun', '{sessions} run · {guests}', {
            sessions: list.length + ' ' + sessWord,
            guests: guests + ' ' + guestWord,
          })
          : (next
            ? scheduleCockpitT('schedule.cockpit.hero.firstUp', 'First up: {name}', { name: scheduleCockpitDisplayName(next.name) })
            : scheduleCockpitT('schedule.cockpit.hero.noSessions', 'No sessions scheduled')));
      var subText = '';
      if (!loadingHero) {
        if (done) subText = scheduleCockpitT('schedule.cockpit.hero.closedOut', 'Gear back in, day closed out.');
        else if (next) {
          subText = next.start + ' \u2013 ' + next.end;
          if (now != null) {
            subText += ' \u00b7 ' + scheduleCockpitT('schedule.cockpit.hero.startsIn', 'starts in {dur}', { dur: scheduleCockpitFmtDur(next.s - now) });
          }
        } else {
          subText = scheduleCockpitT('schedule.cockpit.hero.addSession', 'Add a session to get going.');
        }
      }
      eyebrow.appendChild(el('span', null, eyebrowText));
      heroL.appendChild(eyebrow);
      heroL.appendChild(el('h2', null, titleText));
      heroL.appendChild(el('div', 'ck-now__sub', subText));
      if (!done && !loadingHero) {
        var chipsIdle = el('div', 'ck-chips');
        if (next) {
          scheduleCockpitAppendExactPrepChips(chipsIdle, next.prepItems, 'prep');
        } else {
          chipsIdle.appendChild(el('span', 'ck-chip ck-chip--muted',
            scheduleCockpitT('schedule.cockpit.hero.noGear', 'no gear needed')));
        }
        heroL.appendChild(chipsIdle);
      }
      hero.appendChild(heroL);
    }
  }
  main.appendChild(hero);

  /* ribbon — overlapping sessions stack into lanes so Mañana stays clickable */
  var packed = scheduleCockpitAssignLanes(list);
  list = packed.list;
  var laneH = 28;
  var laneGap = 4;
  var topPad = 20;
  var botPad = 14;
  var ribbonH = topPad + botPad + packed.laneCount * laneH + Math.max(0, packed.laneCount - 1) * laneGap;
  var ribbon = el('div', 'ck-ribbon');
  ribbon.style.height = ribbonH + 'px';
  ribbon.appendChild(el('div', 'ck-ribbon__track'));
  list.forEach(function (s) {
    var state = now != null && now >= s.e ? 'done' : live && s.id === live.id ? 'live' : s.booked ? 'done' : 'empty';
    var blockCls = 'ck-block ck-block--' + (state === 'done' && !(now != null && now >= s.e) ? 'done' : state);
    var b = el('button', blockCls);
    b.type = 'button';
    var lane = s.lane || 0;
    b.style.left = pct(s.s) + '%';
    b.style.width = (((s.e - s.s) / spanMin) * 100) + '%';
    b.style.top = (topPad + lane * (laneH + laneGap)) + 'px';
    b.style.height = laneH + 'px';
    b.style.zIndex = String(2 + lane);
    b.textContent = scheduleCockpitDisplayName(String(s.name || '')).replace(/^Curso /, '') + ' · ' +
      scheduleCockpitCapacityLabel(s.booked || 0, s.capacity) +
      (now != null && now >= s.e ? ' ✓' : '');
    b.title = scheduleCockpitDisplayName(s.name) + ' ' + s.start + '–' + s.end;
    b.setAttribute('data-ps-session-id', String(s.id || ''));
    b.addEventListener('click', function () {
      if (s.booked) { if (on.session) on.session(s.id); }
      else if (on.create) on.create(s.id);
    });
    ribbon.appendChild(b);
  });
  if (now != null && now >= win[0] * 60 && now <= win[1] * 60) {
    var needle = el('div', 'ck-needle');
    needle.style.left = pct(now) + '%';
    needle.appendChild(el('b', null, scheduleCockpitPad(Math.floor(now / 60)) + ':' + scheduleCockpitPad(now % 60)));
    ribbon.appendChild(needle);
  }
  var hours = el('div', 'ck-hours');
  for (var h = win[0]; h <= win[1]; h += 2) hours.appendChild(el('span', null, scheduleCockpitPad(h)));
  ribbon.appendChild(hours);
  main.appendChild(ribbon);
  body.appendChild(main);

  /* prep rail — exact offering labels/qty (course add-ons first, then top others) */
  var p = data.prep || {};
  var prep = el('div', 'ck-prep');
  prep.appendChild(el('h3', null, scheduleCockpitPrepTitle(isToday, data.date)));
  var prepItems = Array.isArray(p.items) ? p.items : [];
  if (prepItems.length) {
    prepItems.forEach(function (item) {
      var prow = el('div', 'ck-prep__row');
      prow.appendChild(el('span', null, String(item.label || item.offering_key || 'Item')));
      var val = el('span');
      val.appendChild(el('strong', null, String(item.quantity != null ? item.quantity : 0)));
      prow.appendChild(val);
      prep.appendChild(prow);
    });
  } else {
    // Empty day — keep rail height honest without inventing component stock.
    var empty = el('div', 'ck-prep__row ck-prep__row--quiet');
    empty.appendChild(el('span', null, scheduleCockpitT('schedule.cockpit.noEquipment', 'No equipment booked')));
    empty.appendChild(el('span', null, '0'));
    prep.appendChild(empty);
  }
  prep.appendChild(el('div', 'ck-prep__rule'));
  var unpaid = el('div', 'ck-prep__row ck-prep__row--alert');
  unpaid.appendChild(el('span', null, scheduleCockpitT('schedule.cockpit.unpaidPending', 'Unpaid / pending')));
  unpaid.appendChild(el('span', 'ck-badge', String(p.unpaid != null ? p.unpaid : 0)));
  if (on.unpaid) {
    unpaid.style.cursor = 'pointer';
    unpaid.addEventListener('click', on.unpaid);
  }
  prep.appendChild(unpaid);
  var reply = el('div', 'ck-prep__row ck-prep__row--quiet');
  reply.appendChild(el('span', null, scheduleCockpitT('schedule.cockpit.needReply', 'Need reply')));
  reply.appendChild(el('span', null, (p.needReply != null ? p.needReply : 0) === 0
    ? scheduleCockpitT('schedule.cockpit.inboxClear', '0 · inbox clear')
    : String(p.needReply)));
  if (on.inbox) {
    reply.style.cursor = 'pointer';
    reply.addEventListener('click', on.inbox);
  }
  prep.appendChild(reply);
  body.appendChild(prep);

  mount.appendChild(body);
}

/**
 * Clear the 60s needle/countdown timer on a cockpit mount (no data-loader side effects).
 */
function scheduleStopDayCockpitClock(mount) {
  if (!mount) return;
  if (mount.__ckTimer != null) {
    try {
      if (typeof clearInterval === 'function') clearInterval(mount.__ckTimer);
    } catch (_e) { /* ignore */ }
    mount.__ckTimer = null;
  }
}

/**
 * 60s tick: re-paint needle + countdowns only.
 * MUST NOT call requestPageLoad / data-loader / network refresh.
 */
function scheduleDayCockpitClockTick(mount) {
  if (!mount) return;
  var src;
  if (mount.__ckSrc && typeof mount.__ckSrc === 'object') {
    src = Object.assign({}, mount.__ckSrc);
    // Refresh nav identity lightly; keep last sessions/prep snapshot for the tick.
    if (typeof scheduleActiveDayIso === 'function') {
      try { src.date = scheduleActiveDayIso() || src.date; } catch (_e) { /* keep */ }
    }
    if (typeof scheduleCurrentViewMode === 'function') {
      try { src.navMode = scheduleCurrentViewMode() || src.navMode; } catch (_e2) { /* keep */ }
    }
    // Recompute range from live nav — never keep a stale Monthly/Daily pin on the header.
    src.range = scheduleCockpitRangeFromNavMode(src.navMode || src.mode || src.range);
    src.on = typeof scheduleDayCockpitDefaultHandlers === 'function'
      ? scheduleDayCockpitDefaultHandlers()
      : (src.on || {});
  } else if (typeof scheduleCollectDayCockpitSource === 'function') {
    src = scheduleCollectDayCockpitSource();
  } else {
    return;
  }
  delete src.now;
  var data = scheduleBuildDayCockpitData(src);
  // If range/nav left the live day, stop ticking (no leaked interval after re-nav).
  if (!scheduleDayCockpitShouldTick(data)) {
    scheduleStopDayCockpitClock(mount);
    scheduleRenderDayCockpit(mount, data);
    return;
  }
  scheduleRenderDayCockpit(mount, data);
}

/**
 * Live mount helper (60s tick). Returns { update(next), destroy() } like renderCockpit.
 * destroy()/re-mount clearInterval — no leaked timers.
 */
function scheduleMountDayCockpit(mount, data) {
  if (!mount) return { update: function () {}, destroy: function () {} };
  scheduleStopDayCockpitClock(mount);
  data = data || {};
  mount.__ckSrc = Object.assign({}, data);
  delete mount.__ckSrc.now;
  scheduleRenderDayCockpit(mount, data);
  if (scheduleDayCockpitShouldTick(data) && typeof setInterval === 'function') {
    mount.__ckTimer = setInterval(function () {
      scheduleDayCockpitClockTick(mount);
    }, 60000);
  }
  return {
    update: function (next) { return scheduleMountDayCockpit(mount, next || data); },
    destroy: function () { scheduleStopDayCockpitClock(mount); },
  };
}

function scheduleCockpitMinToHhmm(min) {
  if (min == null || !isFinite(Number(min))) return '';
  var n = Math.max(0, Math.round(Number(min)));
  return scheduleCockpitPad(Math.floor(n / 60)) + ':' + scheduleCockpitPad(n % 60);
}

/**
 * Map nav mode → cockpit range pill key.
 * SunsetScheduleRuntime.nav modes: 'day' | 'week' | 'next30'
 * UI only exposes Daily (today) + Monthly (next30). Legacy week collapses to Daily.
 */
function scheduleCockpitRangeFromNavMode(mode) {
  var m = String(mode || 'day').toLowerCase();
  if (m === 'next30' || m === 'month' || m === 'monthly') return 'next30';
  // week retired from UI — treat as day/Daily for pills (clock freeze still honors explicit range:'week')
  if (m === 'week') return 'today';
  return 'today';
}

/**
 * Map one day-ops / scheduleBuildDaySessions session → cockpit session contract.
 *
 * Source fields (browser session VM):
 *   id        ← scheduleDaySessionFocusId (slot_key / course_id) — never first booking in slot
 *   name      ← label
 *   start/end ← HH:MM from start/end minutes (or existing HH:MM strings)
 *   booked    ← surfers (ops bucket.booked / group qty aggregate)
 *   boards    ← boardsNeeded (ops group gear / scheduleGroupBoardsNeeded)
 *   wetsuits  ← wetsuitsNeeded
 *   prepItems ← session.prepItems from scheduleBuildDaySessions, else derived
 *               from session.groups' trusted active CE records
 *   capacity  ← session.capacity already on day-session VM
 *               (scheduleBuildDaySessions sets course.capacity from pack.group_size /
 *               courses cache — read directly; no ops helper)
 *   cancelled ← _isCancelled / schedule_ghost
 *
 * note skipped for v1.
 */
function scheduleMapDaySessionToCockpit(session) {
  session = session || {};
  var start = session.start;
  var end = session.end;
  if (typeof start === 'number') start = scheduleCockpitMinToHhmm(start);
  if (typeof end === 'number') end = scheduleCockpitMinToHhmm(end);
  if (!start && session.timeLabel) {
    var m = String(session.timeLabel).match(/(\d{1,2}:\d{2})\s*[–\-]\s*(\d{1,2}:\d{2})/);
    if (m) { start = m[1]; end = m[2]; }
  }
  var capRaw = session.capacity;
  var capacity = scheduleCockpitHasCapacity(capRaw) ? Number(capRaw) : null;
  var booked = session.booked != null ? Number(session.booked)
    : (session.surfers != null ? Number(session.surfers) : 0);
  if (!isFinite(booked) || booked < 0) booked = 0;
  // Exact prep items: prefer explicit session field, else build from session groups.
  var prepItems = Array.isArray(session.prepItems)
    ? scheduleCockpitNormalizePrepItems(session.prepItems)
    : scheduleCockpitNormalizePrepItems(scheduleBuildSessionPrepItems(session.groups));
  return {
    id: (typeof scheduleDaySessionFocusId === 'function'
      ? scheduleDaySessionFocusId(session)
      : (session.id != null ? session.id
        : (session.slot_key != null && session.slot_key !== '' ? session.slot_key
          : (session.course_id != null ? session.course_id : String(session.label || ''))))),
    name: session.name || session.label || 'Session',
    start: start || '00:00',
    end: end || start || '00:00',
    booked: booked,
    capacity: capacity,
    boards: Number(session.boards != null ? session.boards : (session.boardsNeeded || 0)) || 0,
    wetsuits: Number(session.wetsuits != null ? session.wetsuits : (session.wetsuitsNeeded || 0)) || 0,
    prepItems: prepItems,
    cancelled: !!(session.cancelled || session._isCancelled || session.schedule_ghost),
  };
}

/**
 * Reshape existing schedule view-model pieces into the cockpit data contract.
 *
 * Expected src (all optional; missing fields degrade safely):
 * {
 *   venue,                 // school / location label (Schedule for: …)
 *   date,                  // active day ISO — SunsetScheduleRuntime.nav.activeDayIso()
 *   range | navMode,       // 'today'|'week'|'next30' or nav mode day|week|next30
 *   now,                   // optional minutes override for fixtures
 *   window,                // optional ribbon hours
 *   sessions,              // scheduleBuildDaySessions(...) results OR already-cockpit-shaped
 *   prep: {
 *     boards:   { total, lesson, rental }  // ops boardsTotal/Lesson/Rental OR equip.boards
 *     wetsuits: { total, lesson, rental }
 *     unpaid,                              // forecast unpaidCount / scheduleUnpaidPendingCount
 *     needReply,                           // forecast needReplyCount / need-reply totals
 *   },
 *   // alternate prep flat keys from ops aggregateDayOps / scheduleOpsAggregateDay:
 *   boardsTotal, boardsLesson, boardsRental, wetsuitsTotal, wetsuitsLesson, wetsuitsRental,
 *   unpaidCount, needReplyCount,
 *   on: { prev, today, next, range, refresh, create, session, unpaid, inbox }
 * }
 *
 * Handler wiring intent (P2 mounts these; P1 only shapes the `on` bag):
 *   on.prev/today/next  → SunsetScheduleRuntime.nav.navigatePrev/Today/Next
 *   on.range(kind)      → nav.setView(kind==='today'?'day':kind)
 *   on.refresh          → #ps-refresh-schedule → runtime.nav.requestPageLoad
 *   on.create(id|null)  → openScheduleCreateModal / data-ps-add-slot
 *   on.session(id)      → scheduleCockpitFocusSession(id) by data-ps-session-id (not time-slot peer)
 */
function scheduleBuildDayCockpitData(src) {
  src = src || {};
  var prepIn = src.prep || {};
  var boards = prepIn.boards || {
    total: src.boardsTotal != null ? src.boardsTotal : 0,
    lesson: src.boardsLesson != null ? src.boardsLesson : 0,
    rental: src.boardsRental != null ? src.boardsRental : 0,
  };
  var wetsuits = prepIn.wetsuits || {
    total: src.wetsuitsTotal != null ? src.wetsuitsTotal : 0,
    lesson: src.wetsuitsLesson != null ? src.wetsuitsLesson : 0,
    rental: src.wetsuitsRental != null ? src.wetsuitsRental : 0,
  };
  // Accept equip.boards shape from scheduleDayEquipmentTotals
  if (prepIn.boards && prepIn.boards.total == null && src.equip && src.equip.boards) {
    boards = src.equip.boards;
  }
  if (prepIn.wetsuits && prepIn.wetsuits.total == null && src.equip && src.equip.wetsuits) {
    wetsuits = src.equip.wetsuits;
  }
  if (src.equip && src.equip.boards && !prepIn.boards && src.boardsTotal == null) {
    boards = src.equip.boards;
  }
  if (src.equip && src.equip.wetsuits && !prepIn.wetsuits && src.wetsuitsTotal == null) {
    wetsuits = src.equip.wetsuits;
  }

  var unpaid = prepIn.unpaid != null ? prepIn.unpaid
    : (src.unpaidCount != null ? src.unpaidCount : 0);
  var needReply = prepIn.needReply != null ? prepIn.needReply
    : (src.needReplyCount != null ? src.needReplyCount : 0);

  // Exact prep items: prefer src.prep.items; else derive from day rows when present.
  var prepItems = Array.isArray(prepIn.items) ? prepIn.items.slice() : null;
  if (!prepItems && Array.isArray(src.prepItems)) prepItems = src.prepItems.slice();
  if (!prepItems && Array.isArray(src.rows)) {
    prepItems = scheduleBuildDayPrepItems(src.rows, src.date || src.activeDayIso || '');
  }
  if (!prepItems) prepItems = [];

  var sessions = (src.sessions || []).map(function (s) {
    // Already cockpit-shaped (has HH:MM start string + name)?
    if (s && typeof s.start === 'string' && s.start.indexOf(':') !== -1 && (s.name || s.booked != null) && s.surfers == null && s.boardsNeeded == null) {
      return scheduleMapDaySessionToCockpit(Object.assign({}, s, { name: s.name || s.label }));
    }
    return scheduleMapDaySessionToCockpit(s);
  }).filter(function (s) { return !s.cancelled; });
  // Ensure every mapped session has an array prepItems (hero is session-scoped).
  sessions.forEach(function (s) {
    if (!Array.isArray(s.prepItems)) s.prepItems = [];
  });

  var range = scheduleCockpitRangeFromNavMode(src.navMode || src.mode || src.range);

  var layout = src.layout === 'cards' || src.layout === 'timeline'
    ? src.layout
    : (typeof scheduleGetDayOpsLayoutMode === 'function' ? scheduleGetDayOpsLayoutMode() : 'timeline');
  var out = {
    venue: src.venue != null ? src.venue : 'Sunset',
    date: src.date || src.activeDayIso || '',
    range: range,
    loading: !!src.loading,
    layout: layout === 'cards' ? 'cards' : 'timeline',
    sessions: sessions,
    prep: {
      items: prepItems.map(function (it) {
        return {
          offering_key: String((it && it.offering_key) || ''),
          label: String((it && it.label) || (it && it.offering_key) || 'Item'),
          quantity: Number(it && it.quantity) || 0,
          kind: (it && it.kind) === 'course_addon' ? 'course_addon' : 'rental',
        };
      }),
      // Legacy keys retained for older consumers / tests (not primary rail truth).
      boards: {
        total: Number(boards.total) || 0,
        lesson: Number(boards.lesson) || 0,
        rental: Number(boards.rental) || 0,
      },
      wetsuits: {
        total: Number(wetsuits.total) || 0,
        lesson: Number(wetsuits.lesson) || 0,
        rental: Number(wetsuits.rental) || 0,
      },
      unpaid: Number(unpaid) || 0,
      needReply: Number(needReply) || 0,
    },
    on: src.on || {},
  };
  if (typeof src.now === 'number') out.now = src.now;
  if (src.window) out.window = src.window;
  return out;
}

function scheduleGetDayCockpitCss() {
  return SCHEDULE_DAY_COCKPIT_CSS;
}

/** Inject exact cockpit CSS once (values live with the module; P2 mount). */
function scheduleEnsureDayCockpitCss() {
  if (typeof document === 'undefined' || !document.head) return;
  if (document.getElementById('ps-day-cockpit-css')) return;
  var style = document.createElement('style');
  style.id = 'ps-day-cockpit-css';
  style.type = 'text/css';
  style.appendChild(document.createTextNode(
    '.ps-day-cockpit-host,#ps-day-cockpit{margin:0 0 16px;min-width:0;display:block;}' +
    SCHEDULE_DAY_COCKPIT_CSS
  ));
  document.head.appendChild(style);
}

/**
 * Wire cockpit actions to EXISTING schedule handlers (no new nav/create logic).
 * prev/today/next → runtime.nav / scheduleNavigate*
 * range → setScheduleView (day|week|next30)
 * refresh → scheduleRequestPageLoad (#ps-refresh-schedule handler)
 * create → openScheduleCreateModal (same as empty-slot / Create booking)
 * session → scroll to ops group or open create for empty course slot
 */
function scheduleDayCockpitDefaultHandlers() {
  return {
    prev: function () {
      if (typeof scheduleNavigatePrev === 'function') return scheduleNavigatePrev();
      if (typeof SunsetScheduleRuntime !== 'undefined' && SunsetScheduleRuntime.nav) {
        return SunsetScheduleRuntime.nav.navigatePrev();
      }
    },
    today: function () {
      if (typeof scheduleNavigateToday === 'function') return scheduleNavigateToday();
      if (typeof SunsetScheduleRuntime !== 'undefined' && SunsetScheduleRuntime.nav) {
        return SunsetScheduleRuntime.nav.navigateToday();
      }
    },
    next: function () {
      if (typeof scheduleNavigateNext === 'function') return scheduleNavigateNext();
      if (typeof SunsetScheduleRuntime !== 'undefined' && SunsetScheduleRuntime.nav) {
        return SunsetScheduleRuntime.nav.navigateNext();
      }
    },
    range: function (kind) {
      // Daily → day, Monthly → next30. Week retired.
      var mode = 'day';
      if (kind === 'next30' || kind === 'month' || kind === 'monthly') mode = 'next30';
      else if (kind === 'week') mode = 'day'; // no week UI
      if (typeof setScheduleView === 'function') return setScheduleView(mode);
      if (typeof SunsetScheduleRuntime !== 'undefined' && SunsetScheduleRuntime.nav) {
        return SunsetScheduleRuntime.nav.setView(mode);
      }
    },
    layout: function (kind) {
      var mode = kind === 'cards' ? 'cards' : 'timeline';
      if (typeof scheduleSetDayOpsLayoutMode === 'function') return scheduleSetDayOpsLayoutMode(mode);
    },
    refresh: function () {
      if (typeof scheduleRequestPageLoad === 'function') return scheduleRequestPageLoad();
      if (typeof SunsetScheduleRuntime !== 'undefined' && SunsetScheduleRuntime.nav) {
        return SunsetScheduleRuntime.nav.requestPageLoad();
      }
    },
    create: function (sessionId) {
      if (typeof openScheduleCreateModal !== 'function') return;
      if (sessionId == null || sessionId === '') {
        return openScheduleCreateModal(null);
      }
      var dateIso = typeof scheduleActiveDayIso === 'function' ? scheduleActiveDayIso() : '';
      return openScheduleCreateModal({
        activity: 'group',
        course_id: String(sessionId),
        date_from: dateIso,
        date_to: dateIso,
      });
    },
    session: function (sessionId) {
      scheduleCockpitFocusSession(sessionId);
    },
    unpaid: function () {
      /* destination may not exist yet — non-interactive when absent (README) */
    },
    inbox: function () {
      if (typeof switchToTabOnly === 'function') switchToTabOnly('conversations');
      else if (typeof switchToTab === 'function') switchToTab('conversations');
    },
  };
}

/** Scroll to / open a day-ops session by its focus id — never by time-slot or fuzzy id. */
function scheduleCockpitFocusSession(sessionId) {
  var id = sessionId == null ? '' : String(sessionId);
  if (!id) return;
  var board = typeof el === 'function' ? el('ps-ops-board') : (typeof document !== 'undefined' ? document.getElementById('ps-ops-board') : null);
  if (!board) return;

  function attrEscape(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  var section = null;
  try {
    // Exact session binding (private slot_keys contain ':' and must not use panel-id substring match).
    section = board.querySelector('[data-ps-session-id="' + attrEscape(id) + '"]');
  } catch (_e) { section = null; }

  if (!section) {
    // Empty configured course slots may only expose add-course / add-slot hooks.
    var addBtn = null;
    try {
      addBtn = board.querySelector('[data-ps-add-course="' + attrEscape(id) + '"]') ||
        board.querySelector('[data-ps-add-slot="' + attrEscape(id) + '"]');
    } catch (_e2) { addBtn = null; }
    if (addBtn && typeof addBtn.click === 'function') {
      addBtn.click();
      return;
    }
    if (board.scrollIntoView) {
      try { board.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_e3) { /* ignore */ }
    }
    return;
  }

  // Prefer this session's own first booking — never the first booking in an overlapping time slot.
  var bookingNode = null;
  try {
    bookingNode = section.querySelector('[data-ps-booking-id]');
  } catch (_e4) { bookingNode = null; }
  if (bookingNode && typeof bookingNode.click === 'function') {
    bookingNode.click();
    return;
  }

  var emptyAdd = null;
  try {
    emptyAdd = section.querySelector('[data-ps-add-course], [data-ps-add-slot]');
  } catch (_e5) { emptyAdd = null; }
  if (emptyAdd && typeof emptyAdd.click === 'function') {
    emptyAdd.click();
    return;
  }

  if (section.scrollIntoView) {
    try { section.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_e6) { section.scrollIntoView(true); }
  }
}

/**
 * Same active-row predicate as scheduleBuildDaySessions / scheduleRowIsActive.
 * Prefer the shared helper when present (staff-query-api); keep an identical
 * offline fallback so cockpit prep never double-counts cancelled ghosts.
 */
function scheduleCockpitRowIsActive(r) {
  if (typeof scheduleRowIsActive === 'function') return scheduleRowIsActive(r);
  if (!r) return false;
  if (r._isCancelled || r.schedule_ghost) return false;
  var bs = String(r.booking_status || r.status || '').toLowerCase();
  if (bs === 'cancelled' || bs === 'canceled') return false;
  var ss = String(r.service_status || '').toLowerCase();
  if (ss === 'cancelled') return false;
  return true;
}

function scheduleCockpitFilterActiveRows(rows) {
  return (rows || []).filter(scheduleCockpitRowIsActive);
}

function scheduleCockpitParseMeta(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_e) { return {}; }
}

function scheduleCockpitRowQty(row) {
  var n = row && row.quantity != null ? Number(row.quantity) : 1;
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

function scheduleCockpitHumanizeOfferingKey(key) {
  return String(key || '')
    .replace(/_rental$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, function (c) { return c.toUpperCase(); })
    .trim();
}

/**
 * Append hero chips for session-scoped exact prep items.
 * mode 'prep' → "4 Surfboard + Wetsuit to prep"
 * mode 'out'  → "✓ 4 Surfboard + Wetsuit out"
 * Empty → muted "no gear needed" (never legacy "0 boards · 0 wetsuits").
 * Multiple items: one chip each, caller supplies deterministic order.
 *
 * Uses chipsEl.ownerDocument — never the portal el(id) helper.
 */
function scheduleCockpitAppendExactPrepChips(chipsEl, prepItems, mode) {
  if (!chipsEl) return;
  var doc = chipsEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc) return;
  var items = Array.isArray(prepItems) ? prepItems : [];
  var rendered = 0;
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it) continue;
    var qty = Number(it.quantity);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    var label = String(it.label || it.offering_key || 'Item').trim() || 'Item';
    var text = mode === 'out'
      ? ('\u2713 ' + qty + ' ' + label + ' out')
      : (qty + ' ' + label + ' to prep');
    chipsEl.appendChild(scheduleCockpitEl(doc, 'span', 'ck-chip', text));
    rendered += 1;
  }
  if (!rendered) {
    chipsEl.appendChild(scheduleCockpitEl(doc, 'span', 'ck-chip ck-chip--muted', 'no gear needed'));
  }
}

/**
 * Session-scoped exact course add-on prep items from a course session's own
 * display groups / booking records. Preserves Admin offering key + label.
 * Excludes cancelled/inactive rows, standalone rentals, and other sessions.
 *
 * @param {Array} groups  session.groups from scheduleBuildDaySessions
 * @returns {Array<{offering_key:string,label:string,quantity:number,kind:'course_addon'}>}
 */
function scheduleBuildSessionPrepItems(groups) {
  var byKey = Object.create(null);
  (groups || []).forEach(function (g) {
    if (!g || g._isCancelled || g.schedule_ghost) return;
    var records = Array.isArray(g.records) ? g.records : [];
    records.forEach(function (row) {
      if (!scheduleCockpitRowIsActive(row)) return;
      var meta = scheduleCockpitParseMeta(row.metadata || row._meta);
      // Course-owned equipment only — never standalone/generic rentals.
      if (meta.course_equipment !== true) return;
      if (meta.rental_offering === true || meta.generic_rental === true) return;
      var key = String(meta.offering_key || meta.offering_id || '').trim();
      // P0e: current Admin catalog_label first, then persisted, then humanize.
      var label = String(
        meta.catalog_label || meta.offering_label || meta.label || meta.display_name || '',
      ).trim();
      if (key && label && label.toLowerCase() === key.toLowerCase()) label = '';
      if (!key) key = 'course_equipment';
      if (!label) label = scheduleCockpitHumanizeOfferingKey(key) || 'Equipment';
      var qty = scheduleCockpitRowQty(row);
      if (!byKey[key]) {
        byKey[key] = {
          offering_key: key,
          label: label,
          quantity: 0,
          kind: 'course_addon',
        };
      }
      byKey[key].quantity += qty;
      if (label && (!byKey[key].label || byKey[key].label === key)) {
        byKey[key].label = label;
      }
    });
  });
  var out = Object.keys(byKey).map(function (k) { return byKey[k]; });
  out.sort(function (a, b) {
    var byLabel = String(a.label).localeCompare(String(b.label));
    return byLabel || String(a.offering_key).localeCompare(String(b.offering_key));
  });
  return out;
}

/**
 * Normalize prep item rows for session / rail contracts.
 */
function scheduleCockpitNormalizePrepItems(list) {
  return (Array.isArray(list) ? list : []).map(function (it) {
    return {
      offering_key: String((it && it.offering_key) || ''),
      label: String((it && it.label) || (it && it.offering_key) || 'Item'),
      quantity: Number(it && it.quantity) || 0,
      kind: (it && it.kind) === 'rental' ? 'rental' : 'course_addon',
    };
  }).filter(function (it) { return it.quantity > 0; });
}

/**
 * Data-driven Today's Prep projection for a selected day.
 *
 * 1) Exact course add-on offerings first (metadata.course_equipment=true) —
 *    identity/label/quantity as booked; never decompose combo names into
 *    hardcoded Surfboards/Wetsuits components.
 * 2) When the same offering_key also has standalone rental demand, aggregate
 *    that quantity into the add-on-first row (physical prep must not understate).
 *    Prefer the trusted course-add-on booked label; do not list that key again
 *    among "other rentals".
 * 3) Then up to two OTHER exact rented offering types for that day, ranked by
 *    quantity desc then stable label/key. Active bookings only; respects date.
 *
 * @returns {Array<{offering_key:string,label:string,quantity:number,kind:'course_addon'|'rental'}>}
 */
function scheduleBuildDayPrepItems(rows, dateIso) {
  var iso = String(dateIso || '').slice(0, 10);
  var dayRows = scheduleCockpitFilterActiveRows(rows || []).filter(function (r) {
    return String(r.service_date || r.date || '').slice(0, 10) === iso;
  });

  var ceByKey = Object.create(null);
  var rentalByKey = Object.create(null);

  dayRows.forEach(function (row) {
    var meta = scheduleCockpitParseMeta(row.metadata || row._meta);
    var qty = scheduleCockpitRowQty(row);
    var key = String(meta.offering_key || meta.offering_id || '').trim();
    // P0e: current Admin catalog_label first, then persisted snapshot.
    var label = String(
      meta.catalog_label || meta.offering_label || meta.label || meta.display_name || '',
    ).trim();
    if (key && label && label.toLowerCase() === key.toLowerCase()) label = '';

    // Course-owned equipment — exact catalog offering (not component inference).
    if (meta.course_equipment === true
      && meta.rental_offering !== true
      && meta.generic_rental !== true) {
      if (!key) key = 'course_equipment';
      if (!label) label = scheduleCockpitHumanizeOfferingKey(key) || 'Equipment';
      if (!ceByKey[key]) {
        ceByKey[key] = {
          offering_key: key,
          label: label,
          quantity: 0,
          kind: 'course_addon',
        };
      }
      ceByKey[key].quantity += qty;
      // Prefer a real label if a later row carries one (CE booked labels win).
      if (label && (!ceByKey[key].label || ceByKey[key].label === key)) {
        ceByKey[key].label = label;
      }
      return;
    }

    // Standalone / generic rentals — exact offering identity.
    var isRental = meta.rental_offering === true
      || meta.generic_rental === true
      || String(meta.component || '').toLowerCase() === 'addon_service'
      || String(row.service_type || '').toLowerCase() === 'surfboard'
      || String(row.service_type || '').toLowerCase() === 'wetsuit'
      || (String(row.service_type || '').toLowerCase() === 'addon_service' && !!key);
    if (!isRental || !key) return;
    if (!label) label = scheduleCockpitHumanizeOfferingKey(key) || key;
    if (!rentalByKey[key]) {
      rentalByKey[key] = {
        offering_key: key,
        label: label,
        quantity: 0,
        kind: 'rental',
      };
    }
    rentalByKey[key].quantity += qty;
    if (label && (!rentalByKey[key].label || rentalByKey[key].label === key)) {
      rentalByKey[key].label = label;
    }
  });

  // Same exact offering key as course add-on + standalone rental: fold standalone
  // demand into the add-on-first row so physical prep is not understated.
  Object.keys(rentalByKey).forEach(function (k) {
    if (!ceByKey[k]) return;
    ceByKey[k].quantity += Number(rentalByKey[k].quantity) || 0;
    // Keep trusted course-add-on booked label; only fill if CE label was empty/key.
    if ((!ceByKey[k].label || ceByKey[k].label === k) && rentalByKey[k].label) {
      ceByKey[k].label = rentalByKey[k].label;
    }
  });

  var ceItems = Object.keys(ceByKey).map(function (k) { return ceByKey[k]; });
  ceItems.sort(function (a, b) {
    var byLabel = String(a.label).localeCompare(String(b.label));
    return byLabel || String(a.offering_key).localeCompare(String(b.offering_key));
  });

  var otherItems = Object.keys(rentalByKey)
    .filter(function (k) { return !ceByKey[k]; })
    .map(function (k) { return rentalByKey[k]; });
  otherItems.sort(function (a, b) {
    var dq = (Number(b.quantity) || 0) - (Number(a.quantity) || 0);
    if (dq) return dq;
    var byLabel = String(a.label).localeCompare(String(b.label));
    return byLabel || String(a.offering_key).localeCompare(String(b.offering_key));
  });
  // Rail constraint: up to two other rental types after all CE exact rows.
  otherItems = otherItems.slice(0, 2);

  return ceItems.concat(otherItems);
}

/**
 * Assemble cockpit src from the live schedule VM (no new queries).
 * sessions ← scheduleBuildDaySessions (includes capacity from course.capacity)
 * prep ← exact offering items + unpaid/need-reply on ACTIVE rows only
 * venue/date/range ← getSunsetLocationLabel + nav
 */
function scheduleCollectDayCockpitSource() {
  var activeIso = typeof scheduleActiveDayIso === 'function' ? scheduleActiveDayIso() : '';
  var navMode = typeof scheduleCurrentViewMode === 'function' ? scheduleCurrentViewMode() : 'day';
  var rangeStartIso = activeIso;
  try {
    if (typeof scheduleGetNavigationSnapshot === 'function') {
      var snap = scheduleGetNavigationSnapshot();
      if (snap && (snap.rangeStartIso || snap.focusDateIso)) {
        rangeStartIso = snap.rangeStartIso || snap.focusDateIso || rangeStartIso;
        if (scheduleCockpitRangeFromNavMode(navMode) === 'next30') {
          activeIso = rangeStartIso;
        }
      }
    }
  } catch (_snap) { /* keep activeIso */ }
  var venue = 'Sunset';
  try {
    if (typeof getSunsetLocationLabel === 'function') venue = getSunsetLocationLabel() || venue;
  } catch (_e) { /* keep default */ }

  var rows = [];
  try {
    if (typeof scheduleGetRowsSnapshot === 'function') rows = scheduleGetRowsSnapshot() || [];
  } catch (_e2) { rows = []; }

  // Active-only for prep/unpaid — same filter as scheduleBuildDaySessions.
  // Helpers themselves only date-filter; they do not drop cancelled/ghosts.
  var activeRows = scheduleCockpitFilterActiveRows(rows);

  var dayRows = activeRows.filter(function (r) {
    return String(r.service_date || r.date || '').slice(0, 10) === activeIso;
  });

  var sessions = [];
  if (typeof scheduleBuildDaySessions === 'function') {
    try {
      // buildDaySessions re-filters; passing active day rows is fine (behavior-identical).
      sessions = scheduleBuildDaySessions(dayRows, activeIso, typeof scheduleLessonTimesCache !== 'undefined' ? scheduleLessonTimesCache : null) || [];
    } catch (_e3) { sessions = []; }
  }

  // Legacy equip totals retained for any remaining summary consumers; prep rail
  // uses exact offering items (course add-ons + top other rentals).
  var equip = { boards: { total: 0, lesson: 0, rental: 0 }, wetsuits: { total: 0, lesson: 0, rental: 0 } };
  if (typeof scheduleDayEquipmentTotals === 'function') {
    try { equip = scheduleDayEquipmentTotals(activeRows, activeIso) || equip; } catch (_e4) { /* keep empty */ }
  }

  var prepItems = scheduleBuildDayPrepItems(activeRows, activeIso);

  var unpaidCount = 0;
  if (typeof scheduleUnpaidPendingCount === 'function') {
    try { unpaidCount = scheduleUnpaidPendingCount(activeRows, activeIso) || 0; } catch (_e5) { unpaidCount = 0; }
  }

  var needReplyCount = 0;
  try {
    var convs = typeof scheduleConversationsCache !== 'undefined' ? scheduleConversationsCache : [];
    var emailCount = typeof scheduleNeedReplyEmailCount === 'function' ? scheduleNeedReplyEmailCount(convs) : 0;
    var waCount = typeof scheduleNeedReplyWhatsAppCount === 'function' ? scheduleNeedReplyWhatsAppCount(convs) : 0;
    needReplyCount = (Number(emailCount) || 0) + (Number(waCount) || 0);
  } catch (_e6) { needReplyCount = 0; }

  return {
    venue: venue,
    date: activeIso,
    rangeStartIso: rangeStartIso,
    navMode: navMode,
    range: scheduleCockpitRangeFromNavMode(navMode),
    layout: typeof scheduleGetDayOpsLayoutMode === 'function' ? scheduleGetDayOpsLayoutMode() : 'timeline',
    sessions: sessions,
    equip: equip,
    prep: {
      items: prepItems,
      unpaid: unpaidCount,
      needReply: needReplyCount,
    },
    unpaidCount: unpaidCount,
    needReplyCount: needReplyCount,
    loading: scheduleCockpitIsPageLoading(),
    on: scheduleDayCockpitDefaultHandlers(),
  };
}

/**
 * Mount paint — fills #ps-day-cockpit from the live VM.
 * Starts a 60s local re-render for needle/countdowns when the shown day is live
 * (today + day range). Never triggers data-loader/refresh. Re-paint clears prior timer.
 */
function schedulePaintDayCockpit(srcOverride) {
  var mount = null;
  if (typeof el === 'function') mount = el('ps-day-cockpit');
  if (!mount && typeof document !== 'undefined') mount = document.getElementById('ps-day-cockpit');
  if (!mount) return null;

  scheduleEnsureDayCockpitCss();
  if (typeof scheduleEnsureDayOpsLayoutMediaWatch === 'function') {
    try { scheduleEnsureDayOpsLayoutMediaWatch(); } catch (_eWatch) { /* ignore */ }
  }
  // Teardown any previous interval before re-nav / data re-paint (no leaks).
  scheduleStopDayCockpitClock(mount);

  var src = srcOverride || scheduleCollectDayCockpitSource();
  if (!src.on) src.on = scheduleDayCockpitDefaultHandlers();

  // Snapshot for ticks (without frozen now so the wall clock can advance).
  mount.__ckSrc = Object.assign({}, src);
  delete mount.__ckSrc.now;

  var data = scheduleBuildDayCockpitData(src);
  scheduleRenderDayCockpit(mount, data);

  if (scheduleDayCockpitShouldTick(data) && typeof setInterval === 'function') {
    mount.__ckTimer = setInterval(function () {
      scheduleDayCockpitClockTick(mount);
    }, 60000);
  }

  return data;
}

function scheduleDestroyDayCockpit(mount) {
  if (!mount) {
    if (typeof el === 'function') mount = el('ps-day-cockpit');
    if (!mount && typeof document !== 'undefined') mount = document.getElementById('ps-day-cockpit');
  }
  scheduleStopDayCockpitClock(mount);
  if (mount) mount.__ckSrc = null;
}

// Node offline fixture / require path (browser inject ignores module.exports)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SCHEDULE_DAY_COCKPIT_CSS: SCHEDULE_DAY_COCKPIT_CSS,
    scheduleGetDayCockpitCss: scheduleGetDayCockpitCss,
    scheduleCockpitT: scheduleCockpitT,
    scheduleCockpitDisplayName: scheduleCockpitDisplayName,
    scheduleCockpitFmtDur: scheduleCockpitFmtDur,
    scheduleCockpitRelativeDayLabel: scheduleCockpitRelativeDayLabel,
    scheduleCockpitRelativeDayLabelText: scheduleCockpitRelativeDayLabelText,
    scheduleCockpitPct: scheduleCockpitPct,
    scheduleCockpitClassify: scheduleCockpitClassify,
    scheduleCockpitNowMinutes: scheduleCockpitNowMinutes,
    scheduleDayCockpitShouldTick: scheduleDayCockpitShouldTick,
    scheduleCockpitHasCapacity: scheduleCockpitHasCapacity,
    scheduleRenderDayCockpit: scheduleRenderDayCockpit,
    scheduleMountDayCockpit: scheduleMountDayCockpit,
    scheduleStopDayCockpitClock: scheduleStopDayCockpitClock,
    scheduleDayCockpitClockTick: scheduleDayCockpitClockTick,
    scheduleDestroyDayCockpit: scheduleDestroyDayCockpit,
    scheduleMapDaySessionToCockpit: scheduleMapDaySessionToCockpit,
    scheduleBuildDayCockpitData: scheduleBuildDayCockpitData,
    scheduleCockpitRangeFromNavMode: scheduleCockpitRangeFromNavMode,
    scheduleCockpitMinToHhmm: scheduleCockpitMinToHhmm,
    scheduleEnsureDayCockpitCss: scheduleEnsureDayCockpitCss,
    scheduleDayCockpitDefaultHandlers: scheduleDayCockpitDefaultHandlers,
    scheduleCockpitFocusSession: scheduleCockpitFocusSession,
    scheduleCockpitRowIsActive: scheduleCockpitRowIsActive,
    scheduleCockpitFilterActiveRows: scheduleCockpitFilterActiveRows,
    scheduleBuildDayPrepItems: scheduleBuildDayPrepItems,
    scheduleBuildSessionPrepItems: scheduleBuildSessionPrepItems,
    scheduleCockpitAppendExactPrepChips: scheduleCockpitAppendExactPrepChips,
    scheduleCockpitNormalizePrepItems: scheduleCockpitNormalizePrepItems,
    scheduleCollectDayCockpitSource: scheduleCollectDayCockpitSource,
    schedulePaintDayCockpit: schedulePaintDayCockpit,
  };
}

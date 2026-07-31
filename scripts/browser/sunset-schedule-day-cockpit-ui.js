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
  '/* Luna front desk — day cockpit (P1 isolated; values exact from design handoff) */',
  '.cockpit{',
  '  --ck-surface:#f7f5ef;',
  '  --ck-surface-2:#f2efe5;',
  '  --ck-chip:#efece2;',
  '  --ck-line:rgba(60,45,20,.11);',
  '  --ck-ink:#3a3226;',
  '  --ck-ink-2:#6f6757;',
  '  --ck-ink-3:#8d856f;',
  '  --ck-ink-4:#a1997f;',
  '  --ck-olive:#6b7a5e;',
  '  --ck-olive-dark:#5c6a50;',
  '  --ck-dark:#302c22;',
  '  --ck-now-bg:#22301f;',
  '  --ck-now-ink:#eef2e9;',
  '  --ck-now-ink-2:#9fb392;',
  '  --ck-now-accent:#a8c48f;',
  '  --ck-alert:#a8563a;',
  '  --ck-alert-bg:#f6e6df;',
  '  --ck-done-bg:#cfd6c4;',
  '  --ck-done-border:#b3bfa5;',
  '  background:var(--ck-surface);',
  '  border:1px solid var(--ck-line);',
  '  border-radius:14px;',
  '  overflow:hidden;',
  '  color:var(--ck-ink);',
  '  font-family:inherit;',
  '}',
  '.ck-bar{display:flex;align-items:center;gap:12px;padding:12px 18px;border-bottom:1px solid rgba(60,45,20,.09);flex-wrap:wrap;}',
  '.ck-seg{display:flex;background:var(--ck-chip);border:1px solid rgba(60,45,20,.1);border-radius:99px;padding:3px;}',
  '.ck-seg button{appearance:none;border:0;background:none;cursor:pointer;font:inherit;padding:6px 15px;border-radius:99px;font-size:12.5px;color:var(--ck-ink-2);}',
  '.ck-seg button:hover{color:var(--ck-ink);}',
  '.ck-seg button[aria-pressed="true"]{background:var(--ck-olive);color:#fff;font-weight:600;}',
  '.ck-seg--range button[aria-pressed="true"]{background:var(--ck-dark);color:#f4f1e8;}',
  '.ck-date{display:flex;flex-direction:column;gap:1px;}',
  '.ck-date b{font-size:16px;font-weight:700;letter-spacing:-.01em;line-height:1.1;}',
  '.ck-date span{font-size:11px;color:var(--ck-ink-3);}',
  '.ck-legend{display:flex;gap:11px;margin-left:6px;font-size:11.5px;color:var(--ck-ink-2);}',
  '.ck-legend span{display:flex;align-items:center;gap:5px;}',
  '.ck-dot{width:7px;height:7px;border-radius:99px;}',
  '.ck-dot--luna{background:#7b8fb5;}',
  '.ck-dot--staff{background:#6b8f5e;}',
  '.ck-bar__right{margin-left:auto;display:flex;align-items:center;gap:7px;}',
  '.ck-icon-btn{appearance:none;font:inherit;cursor:pointer;background:var(--ck-chip);border:1px solid rgba(60,45,20,.12);border-radius:99px;width:32px;height:32px;display:grid;place-items:center;font-size:13px;color:var(--ck-ink-2);}',
  '.ck-icon-btn:hover{border-color:var(--ck-ink);color:var(--ck-ink);}',
  '.ck-cta{appearance:none;font:inherit;cursor:pointer;border:0;background:var(--ck-olive);color:#fff;border-radius:99px;padding:9px 20px;font-size:13px;font-weight:600;}',
  '.ck-cta:hover{background:var(--ck-olive-dark);}',
  '.ck-cta--ghost{background:var(--ck-chip);color:#5c5548;border:1px solid rgba(60,45,20,.14);font-weight:500;padding:7px 15px;font-size:12px;}',
  '.ck-cta--ghost:hover{border-color:var(--ck-ink);background:var(--ck-chip);}',
  '.ck-cta--sm{padding:7px 15px;font-size:12px;}',
  '.ck-body{display:grid;grid-template-columns:1fr 270px;}',
  '@media (max-width:1080px){.ck-body{grid-template-columns:1fr;}}',
  '.ck-main{padding:16px 18px;display:flex;flex-direction:column;gap:12px;border-right:1px solid rgba(60,45,20,.09);}',
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
  '.ck-ribbon-head{display:flex;align-items:baseline;gap:9px;margin-bottom:10px;flex-wrap:wrap;}',
  '.ck-ribbon-head b{font-size:12.5px;}',
  '.ck-ribbon-head span{font-size:11.5px;color:var(--ck-ink-3);}',
  '.ck-ribbon-head .ck-next{margin-left:auto;}',
  '.ck-ribbon{position:relative;height:58px;margin:0 4px;}',
  '.ck-ribbon__track{position:absolute;inset:20px 0 14px;background:rgba(60,45,20,.06);border-radius:8px;}',
  '.ck-block{position:absolute;top:20px;bottom:14px;border-radius:8px;border:0;display:flex;align-items:center;justify-content:center;gap:6px;font:inherit;font-size:11px;font-weight:600;cursor:pointer;padding:0 6px;white-space:nowrap;overflow:hidden;}',
  '.ck-block--live{background:var(--ck-now-bg);color:var(--ck-now-ink);font-weight:700;}',
  '.ck-block--done{background:var(--ck-done-bg);border:1px solid var(--ck-done-border);color:#4a5340;font-weight:700;}',
  '.ck-block--empty{background:var(--ck-surface);border:1.5px dashed rgba(60,45,20,.28);color:var(--ck-ink-3);}',
  '.ck-block--empty:hover{border-color:var(--ck-olive);color:var(--ck-olive);}',
  '.ck-needle{position:absolute;top:0;bottom:8px;width:2px;background:var(--ck-alert);border-radius:99px;}',
  '.ck-needle b{position:absolute;top:-2px;left:1px;transform:translateX(-50%);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9.5px;font-weight:700;color:#fff;background:var(--ck-alert);border-radius:4px;padding:1px 6px;}',
  '.ck-hours{position:absolute;left:0;right:0;bottom:-2px;display:flex;justify-content:space-between;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9.5px;color:var(--ck-ink-4);}',
  '.ck-prep{padding:16px 20px;display:flex;flex-direction:column;justify-content:center;gap:10px;background:var(--ck-surface-2);}',
  '.ck-prep h3{margin:0;font-size:10px;font-weight:700;letter-spacing:.12em;color:var(--ck-ink-3);}',
  '.ck-prep__row{display:flex;justify-content:space-between;align-items:baseline;font-size:12.5px;color:var(--ck-ink-2);}',
  '.ck-prep__row strong{font-size:16px;color:var(--ck-ink);}',
  '.ck-prep__row em{font-style:normal;font-size:11px;color:var(--ck-ink-4);white-space:nowrap;}',
  '.ck-prep__row > span:last-child{white-space:nowrap;}',
  '.ck-prep__rule{height:1px;background:rgba(60,45,20,.1);margin:2px 0;}',
  '.ck-prep__row--alert{align-items:center;}',
  '.ck-prep__row--alert span:first-child{color:var(--ck-alert);font-weight:600;}',
  '.ck-badge{background:var(--ck-alert-bg);color:var(--ck-alert);border-radius:99px;padding:2px 10px;font-size:12px;font-weight:700;}',
  '.ck-prep__row--quiet{color:var(--ck-ink-3);align-items:center;}',
  '.ck-prep__row--quiet span:last-child{font-size:12px;}',
].join('\n');

function scheduleCockpitPad(n) {
  return String(n).padStart(2, '0');
}

function scheduleCockpitToMin(hhmm) {
  var parts = String(hhmm || '').split(':').map(Number);
  return parts[0] * 60 + (parts[1] || 0);
}

/** Verbatim from design reference cockpit.js `fmtDur`. */
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
  // README: Non-today dates and Week / Next 30 days → no needle, no countdown.
  // Hero shows the first session (classify with now=null → next=list[0]).
  if (range === 'week' || range === 'next30') {
    // forceNow only for rare replay tests that opt in; normal week/next30 freezes the clock.
    if (data.forceNow === true && typeof data.now === 'number') return data.now;
    return null;
  }
  if (typeof data.now === 'number') return data.now; // explicit override (tests, demos, replay)
  // Only treat the clock as "live" when the shown day is actually today.
  var d = new Date();
  var shown = data.date ? new Date(data.date + 'T00:00:00') : d;
  var sameDay = d.toDateString() === shown.toDateString();
  return sameDay ? d.getHours() * 60 + d.getMinutes() : null;
}

/** True when 60s needle/countdown tick should run (today + day range, not fixture-frozen). */
function scheduleDayCockpitShouldTick(data) {
  data = data || {};
  if (typeof data.now === 'number' && data.forceNow !== true) {
    // Fixture/demo freeze: paint once, no wall-clock interval.
    return false;
  }
  var range = data.range || scheduleCockpitRangeFromNavMode(data.navMode || data.mode) || 'today';
  if (range !== 'today') return false;
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

  mount.className = 'cockpit';
  mount.innerHTML = '';

  /* ----- control bar ----- */
  var bar = el('div', 'ck-bar');
  var nav = el('div', 'ck-seg');
  var dt = data.date ? new Date(data.date + 'T00:00:00') : new Date();
  var isToday = new Date().toDateString() === dt.toDateString();
  [
    ['Previous', on.prev, false],
    ['Today', on.today, isToday],
    ['Next', on.next, false],
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
  dateWrap.appendChild(el('b', null,
    (isToday ? 'Today' : dt.toLocaleDateString(undefined, { weekday: 'short' })) + ' · ' +
    dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })));
  var guests = list.reduce(function (n, s) { return n + (s.booked || 0); }, 0);
  dateWrap.appendChild(el('span', null,
    'Schedule for ' + (data.venue || '—') + ' · ' + list.length + ' session' + (list.length === 1 ? '' : 's') +
    ' · ' + guests + ' guest' + (guests === 1 ? '' : 's')));
  bar.appendChild(dateWrap);

  var legend = el('div', 'ck-legend');
  legend.innerHTML = '<span><i class="ck-dot ck-dot--luna"></i>Luna</span><span><i class="ck-dot ck-dot--staff"></i>Staff</span>';
  bar.appendChild(legend);

  var right = el('div', 'ck-bar__right');
  var ranges = el('div', 'ck-seg ck-seg--range');
  [['today', 'Today'], ['week', 'Week'], ['next30', 'Next 30 days']].forEach(function (row) {
    var key = row[0], label = row[1];
    var b = el('button', null, label);
    b.type = 'button';
    var pressed = (data.range || 'today') === key;
    b.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    if (on.range) b.addEventListener('click', function () { on.range(key); });
    ranges.appendChild(b);
  });
  right.appendChild(ranges);
  var refresh = el('button', 'ck-icon-btn', '\u21bb');
  refresh.type = 'button';
  refresh.setAttribute('aria-label', 'Refresh');
  if (on.refresh) refresh.addEventListener('click', on.refresh);
  right.appendChild(refresh);
  var create = el('button', 'ck-cta', 'Create booking');
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
    eyebrow.appendChild(el('span', null, 'ON NOW \u00b7 ENDS ' + live.end));
    heroL.appendChild(eyebrow);
    heroL.appendChild(el('h2', null, live.name));
    heroL.appendChild(el('div', 'ck-now__sub',
      live.start + ' \u2013 ' + live.end + ' \u00b7 ends in ' + scheduleCockpitFmtDur(live.e - now)));
    var chips = el('div', 'ck-chips');
    if (live.boards) chips.appendChild(el('span', 'ck-chip', '\u2713 ' + live.boards + ' board' + (live.boards === 1 ? '' : 's') + ' out'));
    if (live.wetsuits) chips.appendChild(el('span', 'ck-chip', '\u2713 ' + live.wetsuits + ' wetsuit' + (live.wetsuits === 1 ? '' : 's') + ' out'));
    if (!live.boards && !live.wetsuits) chips.appendChild(el('span', 'ck-chip ck-chip--muted', 'no gear needed'));
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
    lbl.innerHTML = 'seats<br>booked';
    seats.appendChild(lbl);
    hero.appendChild(seats);
  } else {
    hero.classList.add('ck-now--idle');
    var done = now != null && list.length && now >= Math.max.apply(null, list.map(function (x) { return x.e; }));
    eyebrow.appendChild(el('span', null, done ? 'DAY COMPLETE' : 'NOTHING IN THE WATER'));
    heroL.appendChild(eyebrow);
    heroL.appendChild(el('h2', null, done
      ? list.length + ' session' + (list.length === 1 ? '' : 's') + ' run \u00b7 ' + guests + ' guest' + (guests === 1 ? '' : 's')
      : next ? 'First up: ' + next.name : 'No sessions scheduled'));
    heroL.appendChild(el('div', 'ck-now__sub', done
      ? 'Gear back in, day closed out.'
      : next
        ? next.start + ' \u2013 ' + next.end + (now != null ? ' \u00b7 starts in ' + scheduleCockpitFmtDur(next.s - now) : '')
        : 'Add a session to get going.'));
    var chipsIdle = el('div', 'ck-chips');
    var boardsTotal = (data.prep && data.prep.boards && data.prep.boards.total != null) ? data.prep.boards.total : 0;
    var wetsTotal = (data.prep && data.prep.wetsuits && data.prep.wetsuits.total != null) ? data.prep.wetsuits.total : 0;
    chipsIdle.appendChild(el('span', 'ck-chip',
      boardsTotal + ' boards \u00b7 ' + wetsTotal + ' wetsuits ' + (done ? 'used' : 'to prep')));
    heroL.appendChild(chipsIdle);
    hero.appendChild(heroL);
  }
  main.appendChild(hero);

  /* ribbon */
  var rWrap = el('div');
  var head = el('div', 'ck-ribbon-head');
  head.appendChild(el('b', null, 'The day'));
  head.appendChild(el('span', null, list.map(function (s) {
    var shortName = String(s.name || '').replace(/^Curso /, '');
    if (now != null && now >= s.e) return shortName + ' done';
    if (live && s.id === live.id) return shortName + ' in the water';
    return s.booked
      ? shortName + ' ' + scheduleCockpitCapacityLabel(s.booked, s.capacity)
      : shortName + ' empty';
  }).join(' \u00b7 ')));
  if (next) {
    var nx = el('span', 'ck-next');
    nx.innerHTML = 'next: <strong>' + String(next.name) + ' ' + String(next.start) + '</strong>' +
      (now != null ? ' \u00b7 in ' + scheduleCockpitFmtDur(next.s - now) : '');
    head.appendChild(nx);
  }
  rWrap.appendChild(head);

  var ribbon = el('div', 'ck-ribbon');
  ribbon.appendChild(el('div', 'ck-ribbon__track'));
  list.forEach(function (s) {
    var state = now != null && now >= s.e ? 'done' : live && s.id === live.id ? 'live' : s.booked ? 'done' : 'empty';
    var blockCls = 'ck-block ck-block--' + (state === 'done' && !(now != null && now >= s.e) ? 'done' : state);
    var b = el('button', blockCls);
    b.type = 'button';
    b.style.left = pct(s.s) + '%';
    b.style.width = (((s.e - s.s) / spanMin) * 100) + '%';
    b.textContent = String(s.name || '').replace(/^Curso /, '') + ' \u00b7 ' +
      scheduleCockpitCapacityLabel(s.booked || 0, s.capacity) +
      (now != null && now >= s.e ? ' \u2713' : '');
    b.title = s.name + ' ' + s.start + '\u2013' + s.end;
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
  rWrap.appendChild(ribbon);
  main.appendChild(rWrap);
  body.appendChild(main);

  /* prep rail */
  var p = data.prep || {};
  var prep = el('div', 'ck-prep');
  prep.appendChild(el('h3', null, "TODAY'S PREP"));
  [
    ['Surfboards', p.boards],
    ['Wetsuits', p.wetsuits],
  ].forEach(function (row) {
    var label = row[0], v = row[1];
    var prow = el('div', 'ck-prep__row');
    prow.appendChild(el('span', null, label));
    var val = el('span');
    val.appendChild(el('strong', null, String(v && v.total != null ? v.total : 0)));
    val.appendChild(doc.createTextNode(' '));
    val.appendChild(el('em', null,
      String(v && v.lesson != null ? v.lesson : 0) + ' lesson \u00b7 ' +
      String(v && v.rental != null ? v.rental : 0) + ' rental'));
    prow.appendChild(val);
    prep.appendChild(prow);
  });
  prep.appendChild(el('div', 'ck-prep__rule'));
  var unpaid = el('div', 'ck-prep__row ck-prep__row--alert');
  unpaid.appendChild(el('span', null, 'Unpaid / pending'));
  unpaid.appendChild(el('span', 'ck-badge', String(p.unpaid != null ? p.unpaid : 0)));
  if (on.unpaid) {
    unpaid.style.cursor = 'pointer';
    unpaid.addEventListener('click', on.unpaid);
  }
  prep.appendChild(unpaid);
  var reply = el('div', 'ck-prep__row ck-prep__row--quiet');
  reply.appendChild(el('span', null, 'Need reply'));
  reply.appendChild(el('span', null, (p.needReply != null ? p.needReply : 0) === 0
    ? '0 \u00b7 inbox clear'
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
 */
function scheduleCockpitRangeFromNavMode(mode) {
  var m = String(mode || 'day').toLowerCase();
  if (m === 'week') return 'week';
  if (m === 'next30' || m === 'month') return 'next30';
  return 'today';
}

/**
 * Map one day-ops / scheduleBuildDaySessions session → cockpit session contract.
 *
 * Source fields (browser session VM):
 *   id        ← slot_key || course_id || label
 *   name      ← label
 *   start/end ← HH:MM from start/end minutes (or existing HH:MM strings)
 *   booked    ← surfers (ops bucket.booked / group qty aggregate)
 *   boards    ← boardsNeeded (ops group gear / scheduleGroupBoardsNeeded)
 *   wetsuits  ← wetsuitsNeeded
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
  return {
    id: session.id != null ? session.id
      : (session.slot_key != null && session.slot_key !== '' ? session.slot_key
        : (session.course_id != null ? session.course_id : String(session.label || ''))),
    name: session.name || session.label || 'Session',
    start: start || '00:00',
    end: end || start || '00:00',
    booked: booked,
    capacity: capacity,
    boards: Number(session.boards != null ? session.boards : (session.boardsNeeded || 0)) || 0,
    wetsuits: Number(session.wetsuits != null ? session.wetsuits : (session.wetsuitsNeeded || 0)) || 0,
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
 *   on.session(id)      → open session/booking drawer for that slot
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

  var sessions = (src.sessions || []).map(function (s) {
    // Already cockpit-shaped (has HH:MM start string + name)?
    if (s && typeof s.start === 'string' && s.start.indexOf(':') !== -1 && (s.name || s.booked != null) && s.surfers == null && s.boardsNeeded == null) {
      return scheduleMapDaySessionToCockpit(Object.assign({}, s, { name: s.name || s.label }));
    }
    return scheduleMapDaySessionToCockpit(s);
  }).filter(function (s) { return !s.cancelled; });

  var range = src.range || scheduleCockpitRangeFromNavMode(src.navMode || src.mode);

  var out = {
    venue: src.venue != null ? src.venue : 'Sunset',
    date: src.date || src.activeDayIso || '',
    range: range,
    sessions: sessions,
    prep: {
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
    '.ps-day-cockpit-host{margin:0 0 14px;min-width:0;}' +
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
      var mode = 'day';
      if (kind === 'week') mode = 'week';
      else if (kind === 'next30') mode = 'next30';
      if (typeof setScheduleView === 'function') return setScheduleView(mode);
      if (typeof SunsetScheduleRuntime !== 'undefined' && SunsetScheduleRuntime.nav) {
        return SunsetScheduleRuntime.nav.setView(mode);
      }
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

/** Scroll to a day-ops session group, or open create when the slot is empty. */
function scheduleCockpitFocusSession(sessionId) {
  var id = sessionId == null ? '' : String(sessionId);
  if (!id) return;
  var board = typeof el === 'function' ? el('ps-ops-board') : (typeof document !== 'undefined' ? document.getElementById('ps-ops-board') : null);
  if (board) {
    var addBtn = null;
    try {
      addBtn = board.querySelector('[data-ps-add-course="' + id.replace(/"/g, '') + '"]') ||
        board.querySelector('[data-ps-add-slot="' + id.replace(/"/g, '') + '"]');
    } catch (_e) { addBtn = null; }
    if (addBtn && typeof addBtn.click === 'function') {
      addBtn.click();
      return;
    }
    var nodes = board.querySelectorAll('[id*="ps-ops-guests-"]');
    for (var i = 0; i < nodes.length; i++) {
      var nid = String(nodes[i].id || '');
      if (nid.indexOf(id) !== -1) {
        var section = nodes[i].closest ? nodes[i].closest('section') : nodes[i];
        if (section && section.scrollIntoView) {
          try { section.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_e2) { section.scrollIntoView(true); }
          return;
        }
      }
    }
    if (board.scrollIntoView) {
      try { board.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_e3) { /* ignore */ }
    }
  }
}

/**
 * Assemble cockpit src from the live schedule VM (no new queries).
 * sessions ← scheduleBuildDaySessions (includes capacity from course.capacity)
 * prep ← scheduleDayEquipmentTotals + unpaid/need-reply counters
 * venue/date/range ← getSunsetLocationLabel + nav
 */
function scheduleCollectDayCockpitSource() {
  var activeIso = typeof scheduleActiveDayIso === 'function' ? scheduleActiveDayIso() : '';
  var navMode = typeof scheduleCurrentViewMode === 'function' ? scheduleCurrentViewMode() : 'day';
  var venue = 'Sunset';
  try {
    if (typeof getSunsetLocationLabel === 'function') venue = getSunsetLocationLabel() || venue;
  } catch (_e) { /* keep default */ }

  var rows = [];
  try {
    if (typeof scheduleGetRowsSnapshot === 'function') rows = scheduleGetRowsSnapshot() || [];
  } catch (_e2) { rows = []; }

  var dayRows = (rows || []).filter(function (r) {
    return String(r.service_date || r.date || '').slice(0, 10) === activeIso;
  });

  var sessions = [];
  if (typeof scheduleBuildDaySessions === 'function') {
    try {
      sessions = scheduleBuildDaySessions(dayRows, activeIso, typeof scheduleLessonTimesCache !== 'undefined' ? scheduleLessonTimesCache : null) || [];
    } catch (_e3) { sessions = []; }
  }

  var equip = { boards: { total: 0, lesson: 0, rental: 0 }, wetsuits: { total: 0, lesson: 0, rental: 0 } };
  if (typeof scheduleDayEquipmentTotals === 'function') {
    try { equip = scheduleDayEquipmentTotals(rows, activeIso) || equip; } catch (_e4) { /* keep empty */ }
  }

  var unpaidCount = 0;
  if (typeof scheduleUnpaidPendingCount === 'function') {
    try { unpaidCount = scheduleUnpaidPendingCount(rows, activeIso) || 0; } catch (_e5) { unpaidCount = 0; }
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
    navMode: navMode,
    sessions: sessions,
    equip: equip,
    unpaidCount: unpaidCount,
    needReplyCount: needReplyCount,
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
    scheduleCockpitFmtDur: scheduleCockpitFmtDur,
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
    scheduleCollectDayCockpitSource: scheduleCollectDayCockpitSource,
    schedulePaintDayCockpit: schedulePaintDayCockpit,
  };
}

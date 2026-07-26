'use strict';

/**
 * verify:sunset-private-create-default-times-quickfix
 *
 * Private Create session times: default 10:00–12:00 on selected local service date.
 * Never wall-clock/current time. Blank/new only — preserve user-edited + Edit drawer.
 *
 * Covers:
 *  0) Owners + fixed defaults (no clock)
 *  1) Real activity → Private When visibility, then 10:00–12:00 at different clocks
 *  2) Date change before edit keeps 10:00–12:00 on new date
 *  3) Explicit user times preserved on re-sync / activity toggle
 *  4) Edit-drawer path does not apply Create blank defaults
 *  5) 120-minute duration (10→12)
 *  6) 320px layout + runtime inject source parity
 *
 * Visibility rule (production): When section hidden for non-private; visible only Private.
 *
 * Static + vm sandbox only — no DB/Azure/network.
 *
 * Run: node scripts/verify-sunset-private-create-default-times-quickfix.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const portalSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js'), 'utf8');
const editSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-edit-ui.js'), 'utf8');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) {
    console.log('  PASS  ' + label);
    pass += 1;
  } else {
    console.error('  FAIL  ' + label + (detail ? ' — ' + detail : ''));
    fail += 1;
  }
}

function extractFn(src, name) {
  const n = 'function ' + name + '(';
  const start = src.indexOf(n);
  if (start < 0) return null;
  const brace = src.indexOf('{', start);
  let d = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') d += 1;
    else if (src[i] === '}') {
      d -= 1;
      if (d === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

function listen(node) {
  node._ls = node._ls || {};
  node.addEventListener = function (ev, fn) {
    (this._ls[ev] = this._ls[ev] || []).push(fn);
  };
  node.dispatchEvent = function (ev) {
    (this._ls[ev && ev.type] || []).forEach((fn) => fn.call(this, ev));
  };
  return node;
}

function cl(...init) {
  const set = new Set(init);
  return {
    contains: (c) => set.has(c),
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    toggle(c, f) {
      if (f === true) set.add(c);
      else if (f === false) set.delete(c);
      else if (set.has(c)) set.delete(c);
      else set.add(c);
      return set.has(c);
    },
  };
}

const CORE = [
  'schedulePrivateLessonDefaultStartHm',
  'schedulePrivateLessonApplyBlankTimeDefaults',
  'schedulePrivateLessonDefaultEnd',
  'scheduleReadPrivateLessonSessionsFromDom',
  'scheduleWirePrivateLessonSessionRow',
  'schedulePrivateLessonSessionsRefreshDependents',
  'scheduleSyncPrivateLessonSessions',
  'scheduleUpdatePrivateLessonDateRangeFromSessions',
  'scheduleAddPrivateLessonSession',
  'scheduleRemovePrivateLessonSession',
  'scheduleOnCreateComponentChange',
  'schedulePopulateCreateComponentFields',
  'schedulePortalMadridTodayIso',
  'schedulePortalCanonicalDateIso',
  'scheduleEnumerateDates',
];

function build(opts) {
  opts = opts || {};
  const nodes = {};
  function input(id, v) {
    nodes[id] = listen({
      id,
      value: v == null ? '' : String(v),
      checked: false,
      style: { display: '' },
      dataset: {},
      classList: cl(),
      defaultValue: v == null ? '' : String(v),
      options: [],
      selectedIndex: -1,
      textContent: '',
      innerHTML: '',
      hidden: false,
      setAttribute() {},
    });
  }
  function box(id, d) {
    nodes[id] = listen({
      id,
      style: { display: d == null ? '' : d },
      dataset: {},
      classList: cl(),
      innerHTML: '',
      textContent: '',
      hidden: false,
      setAttribute() {},
      querySelectorAll() { return []; },
      querySelector() { return null; },
    });
  }
  function radio(id, name, checked) {
    const node = listen({
      id,
      type: 'radio',
      name,
      dataset: {},
      style: {},
      _checked: !!checked,
      classList: cl(),
      setAttribute() {},
    });
    Object.defineProperty(node, 'checked', {
      configurable: true,
      enumerable: true,
      get() { return this._checked; },
      set(v) {
        this._checked = !!v;
        if (v) {
          Object.keys(nodes).forEach((k) => {
            const n = nodes[k];
            if (n && n.name === name && n !== this) n._checked = false;
          });
        }
      },
    });
    nodes[id] = node;
  }
  radio('ps-create-comp-course', 'ps-create-main-activity', false);
  radio('ps-create-comp-private-lesson', 'ps-create-main-activity', false);
  radio('ps-create-comp-no-lesson', 'ps-create-main-activity', true);
  [
    'ps-create-course-fields', 'ps-create-course-tier-wrap', 'ps-create-course-qty-wrap',
    'ps-create-private-lesson-fields', 'ps-create-private-lesson-qty-wrap',
    'ps-create-addon-fullday-field', 'ps-create-fullday-card', 'ps-create-fullday-rows',
    'ps-create-fullday-summary', 'ps-create-fullday-price-hint', 'ps-create-activity-empty-hint',
    'ps-create-rentals', 'ps-create-msg', 'ps-create-quote-preview', 'ps-create-add-session',
  ].forEach((id) => box(id, id.includes('hint') || id === 'ps-create-rentals' ? '' : 'none'));
  // Production toggles When via document.querySelector('#ps-create-modal [data-create-section="when"]').
  const whenSection = listen({
    id: 'ps-create-when-section',
    dataset: { createSection: 'when' },
    style: { display: 'none' },
    hidden: true,
    classList: cl('is-when-hidden'),
    setAttribute(k, v) { if (k === 'hidden') this.hidden = v !== 'false' && v != null; },
    removeAttribute(k) { if (k === 'hidden') this.hidden = false; },
  });
  nodes['ps-create-private-when'] = listen({
    id: 'ps-create-private-when',
    classList: cl('portal-schedule-create-private-when'),
    style: { display: 'none' },
    dataset: {},
    setAttribute() {},
  });
  nodes['ps-create-date-range'] = listen({
    id: 'ps-create-date-range',
    style: { display: '' },
    dataset: {},
    classList: cl(),
    setAttribute() {},
  });
  input('ps-create-date-from', opts.dateFrom || '2026-07-20');
  input('ps-create-date-to', opts.dateTo || opts.dateFrom || '2026-07-20');
  input('ps-create-surfers', '1');
  input('ps-create-private-lesson-qty', '1');
  input('ps-create-private-lesson-surfers', '1');
  input('ps-create-course-qty', '1');
  input('ps-create-guest', '');
  input('ps-create-phone', '');
  input('ps-create-notes', '');
  input('ps-create-payment', 'unpaid');
  input('ps-create-course-select', '');
  input('ps-create-course-tier', '');
  input('ps-create-comp-fullday', '');
  nodes['ps-create-comp-fullday'].type = 'checkbox';
  nodes['ps-create-comp-fullday'].checked = false;

  function parseRows(html, wrap) {
    const rows = [];
    String(html).split('portal-schedule-private-session-row').slice(1).forEach((chunk) => {
      const dateAttr = (chunk.match(/data-session-date="([^"]*)"/) || [])[1] || '';
      const startVal = (chunk.match(/ps-pl-session-start"[^>]*value="([^"]*)"/) || [])[1] || '';
      const endVal = (chunk.match(/ps-pl-session-end"[^>]*value="([^"]*)"/) || [])[1] || '';
      const startEl = listen({
        classList: cl('ps-pl-session-start'),
        className: 'ps-pl-session-start',
        type: 'time',
        value: startVal,
        dataset: {},
        defaultValue: startVal,
      });
      const endEl = listen({
        classList: cl('ps-pl-session-end'),
        className: 'ps-pl-session-end',
        type: 'time',
        value: endVal,
        dataset: {},
        defaultValue: endVal,
      });
      const row = listen({
        classList: cl('portal-schedule-private-session-row'),
        dataset: { wired: '' },
        _start: startEl,
        _end: endEl,
        parentNode: wrap,
        getAttribute(k) { return k === 'data-session-date' ? dateAttr : null; },
        querySelector(sel) {
          if (sel === '.ps-pl-session-start') return startEl;
          if (sel === '.ps-pl-session-end') return endEl;
          return null;
        },
      });
      rows.push(row);
    });
    return rows;
  }

  const wrap = listen({
    id: 'ps-create-private-lesson-sessions',
    dataset: {},
    style: {},
    classList: cl(),
    _rows: [],
    get innerHTML() { return this._html || ''; },
    set innerHTML(html) {
      this._html = String(html || '');
      this._rows = parseRows(this._html, this);
    },
    querySelectorAll(sel) {
      if (sel === '.portal-schedule-private-session-row') return this._rows.slice();
      if (sel === '.ps-pl-session-start') return this._rows.map((r) => r._start);
      if (sel === '.ps-pl-session-end') return this._rows.map((r) => r._end);
      return [];
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    setAttribute() {},
    removeAttribute() {},
  });
  nodes['ps-create-private-lesson-sessions'] = wrap;

  // Fake "now" — defaults must ignore this clock.
  const fakeNow = opts.now || new Date('2026-07-20T22:47:33.123Z');
  const RealDate = Date;
  function FakeDate(...args) {
    if (args.length === 0) return new RealDate(fakeNow.getTime());
    if (args.length === 1) return new RealDate(args[0]);
    return new RealDate(...args);
  }
  FakeDate.now = () => fakeNow.getTime();
  FakeDate.UTC = RealDate.UTC;
  FakeDate.parse = RealDate.parse;

  const sb = {
    window: { applyStaffPortalI18n() {} },
    console,
    el(id) { return nodes[id] || null; },
    portalT(k) { return k; },
    escHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
    scheduleTodayIso() { return opts.today || '2026-07-20'; },
    scheduleParseIso(iso) {
      const x = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
      return x ? new RealDate(RealDate.UTC(+x[1], +x[2] - 1, +x[3])) : null;
    },
    scheduleAddDays(d, n) {
      const x = new RealDate(d.getTime());
      x.setUTCDate(x.getUTCDate() + n);
      return x;
    },
    scheduleIsoDate(d) {
      return d.getUTCFullYear() + '-'
        + String(d.getUTCMonth() + 1).padStart(2, '0') + '-'
        + String(d.getUTCDate()).padStart(2, '0');
    },
    scheduleSlotMinutesFromToken(hm) {
      const x = /^(\d{1,2}):(\d{2})$/.exec(String(hm || ''));
      return x ? (+x[1]) * 60 + (+x[2]) : null;
    },
    scheduleMinutesLabel(mins) {
      return String(Math.floor(mins / 60)).padStart(2, '0') + ':'
        + String(mins % 60).padStart(2, '0');
    },
    schedulePrivateLessonDurationCache: 120,
    scheduleFetchLessonTimesConfig() {
      return {
        then(fn) {
          if (fn) fn();
          return { then(fn2) { if (fn2) fn2(); return this; } };
        },
      };
    },
    schedulePopulateCreateCourseFields() {},
    scheduleSyncCreateSurferMirrors() {},
    scheduleRenderCreateRentals() {},
    scheduleRefreshCreateFullDayAddon() {},
    scheduleUpdateCreateTotalPreview() {},
    scheduleReadCreateRentalSelectionFromDom() { return []; },
    scheduleRefreshCreateEmptyGuidance() {},
    schedulePortalInvalidateCreateQuoteIntent() {},
    getClient() { return 'sunset'; },
    document: {
      querySelector(sel) {
        if (sel === '#ps-create-modal [data-create-section="when"]') return whenSection;
        return null;
      },
    },
    Intl: {
      DateTimeFormat() {
        return { format() { return opts.today || '2026-07-20'; } };
      },
    },
    Promise,
    JSON,
    Object,
    Array,
    Number,
    String,
    Math,
    parseInt,
    Date: FakeDate,
    _nodes: nodes,
    _privateWhen: nodes['ps-create-private-when'],
    _whenSection: whenSection,
  };

  const code = CORE.map((n) => extractFn(portalSrc, n) || extractFn(apiSrc, n)).filter(Boolean);
  assert('core fns extractable', code.length === CORE.length, String(code.length) + '/' + CORE.length);
  vm.createContext(sb);
  vm.runInContext(code.join('\n'), sb);
  return sb;
}

function rows(sb) {
  return sb.scheduleReadPrivateLessonSessionsFromDom();
}

function setTimes(sb, i, p) {
  const r = sb.el('ps-create-private-lesson-sessions')
    .querySelectorAll('.portal-schedule-private-session-row')[i];
  if (!r) return;
  if (p.start != null) r._start.value = p.start;
  if (p.end != null) r._end.value = p.end;
}

function setRange(sb, from, to) {
  sb.el('ps-create-date-from').value = from;
  sb.el('ps-create-date-to').value = to;
  sb.scheduleSyncPrivateLessonSessions();
}

function pickPrivate(sb) {
  sb.el('ps-create-comp-private-lesson').checked = true;
  sb.scheduleOnCreateComponentChange('ps-create-comp-private-lesson');
}

function whenVisible(sb) {
  const w = sb._whenSection;
  return !!(w && w.hidden === false && w.style.display !== 'none' && !w.classList.contains('is-when-hidden')
    && sb._privateWhen && sb._privateWhen.style.display !== 'none');
}

function whenHidden(sb) {
  const w = sb._whenSection;
  return !!(w && (w.hidden === true || w.style.display === 'none' || w.classList.contains('is-when-hidden'))
    && sb._privateWhen && sb._privateWhen.style.display === 'none');
}

console.log('\nverify:sunset-private-create-default-times-quickfix\n');

// ── Static owners ───────────────────────────────────────────────────────────
console.log('[0] Owners + fixed defaults (no clock)');
assert('default start helper is fixed 10:00',
  /function schedulePrivateLessonDefaultStartHm[\s\S]*return '10:00'/.test(portalSrc)
  && !/getHours|toTimeString|toLocaleTime|Date\.now|new Date\(\)/.test(
    extractFn(portalSrc, 'schedulePrivateLessonDefaultStartHm') || '',
  ));
assert('blank-default helper present',
  /function schedulePrivateLessonApplyBlankTimeDefaults/.test(portalSrc));
assert('sync calls blank-default helper',
  /schedulePrivateLessonApplyBlankTimeDefaults/.test(
    extractFn(portalSrc, 'scheduleSyncPrivateLessonSessions') || '',
  ));
assert('default end uses duration cache (120)',
  /schedulePrivateLessonDurationCache \|\| 120/.test(
    extractFn(portalSrc, 'schedulePrivateLessonDefaultEnd') || '',
  ));
assert('pure helper: blank → 10/12', (() => {
  const ctx = {
    schedulePrivateLessonDurationCache: 120,
    scheduleSlotMinutesFromToken(hm) {
      const x = /^(\d{1,2}):(\d{2})$/.exec(String(hm || ''));
      return x ? (+x[1]) * 60 + (+x[2]) : null;
    },
    scheduleMinutesLabel(mins) {
      return String(Math.floor(mins / 60)).padStart(2, '0') + ':'
        + String(mins % 60).padStart(2, '0');
    },
  };
  vm.createContext(ctx);
  vm.runInContext([
    extractFn(portalSrc, 'schedulePrivateLessonDefaultStartHm'),
    extractFn(portalSrc, 'schedulePrivateLessonDefaultEnd'),
    extractFn(portalSrc, 'schedulePrivateLessonApplyBlankTimeDefaults'),
  ].join('\n'), ctx);
  const a = ctx.schedulePrivateLessonApplyBlankTimeDefaults('', '');
  const b = ctx.schedulePrivateLessonApplyBlankTimeDefaults(null, null);
  const c = ctx.schedulePrivateLessonApplyBlankTimeDefaults('14:00', '16:30');
  const d = ctx.schedulePrivateLessonApplyBlankTimeDefaults('11:00', '');
  return a.start === '10:00' && a.end === '12:00'
    && b.start === '10:00' && b.end === '12:00'
    && c.start === '14:00' && c.end === '16:30'
    && d.start === '11:00' && d.end === '13:00';
})());

// ── 1) Real visibility transition, then defaults at different clocks ────────
console.log('\n[1] Activity→Private When transition, then 10:00–12:00 (no clock leak)');
{
  // Baseline: non-private keeps When hidden (do not assert session fields yet).
  const base = build({ dateFrom: '2026-08-05', dateTo: '2026-08-05' });
  base.schedulePopulateCreateComponentFields();
  assert('No lesson: When hidden', whenHidden(base));
  base.el('ps-create-comp-course').checked = true;
  base.scheduleOnCreateComponentChange('ps-create-comp-course');
  assert('Group: When hidden (only Private shows When)', whenHidden(base)
    && base.el('ps-create-private-lesson-fields').style.display === 'none');
}
[
  '2026-07-20T00:05:00.000Z',
  '2026-07-20T11:59:00.000Z',
  '2026-07-20T15:33:00.000Z',
  '2026-07-20T22:47:33.123Z',
  '2026-12-31T23:59:59.999Z',
].forEach((iso, idx) => {
  const sb = build({
    now: new Date(iso),
    today: '2026-07-20',
    dateFrom: '2026-08-05',
    dateTo: '2026-08-05',
  });
  // Start non-private → When hidden, then Private → When visible, then field asserts.
  sb.schedulePopulateCreateComponentFields();
  assert('clock case ' + idx + ' pre-Private When hidden', whenHidden(sb));
  pickPrivate(sb);
  assert('clock case ' + idx + ' When visible before fields', whenVisible(sb)
    && sb.el('ps-create-private-lesson-fields').style.display === 'none');
  const r = rows(sb);
  assert('clock case ' + idx + ' defaults 10–12 on service date',
    r.length === 1
    && r[0].date === '2026-08-05'
    && r[0].start === '10:00'
    && r[0].end === '12:00',
    JSON.stringify(r[0] || null) + ' @ ' + iso);
});

// ── 2) Date change before edit keeps defaults ───────────────────────────────
console.log('\n[2] Date change before edit → new date keeps 10:00–12:00');
{
  const sb = build({
    now: new Date('2026-07-20T18:22:00.000Z'),
    dateFrom: '2026-08-10',
    dateTo: '2026-08-10',
  });
  pickPrivate(sb);
  assert('When visible after Private pick', whenVisible(sb));
  assert('initial date defaults', rows(sb)[0].date === '2026-08-10'
    && rows(sb)[0].start === '10:00' && rows(sb)[0].end === '12:00');
  setRange(sb, '2026-08-15', '2026-08-15');
  assert('shifted date keeps 10–12', rows(sb).length === 1
    && rows(sb)[0].date === '2026-08-15'
    && rows(sb)[0].start === '10:00'
    && rows(sb)[0].end === '12:00');
  setRange(sb, '2026-08-15', '2026-08-17');
  assert('grow range: each new day defaults 10–12',
    rows(sb).length === 3
    && rows(sb).every((r) => r.start === '10:00' && r.end === '12:00')
    && rows(sb).map((r) => r.date).join(',') === '2026-08-15,2026-08-16,2026-08-17');
}

// ── 3) Explicit times preserved ─────────────────────────────────────────────
console.log('\n[3] Explicit user times preserved on re-render / toggle');
{
  const sb = build({ dateFrom: '2026-08-01', dateTo: '2026-08-02' });
  pickPrivate(sb);
  assert('When visible before manual edit', whenVisible(sb));
  setTimes(sb, 0, { start: '09:15', end: '10:45' });
  setTimes(sb, 1, { start: '16:00', end: '17:30' });
  sb.scheduleSyncPrivateLessonSessions(); // re-render same range
  const after = rows(sb);
  assert('re-sync preserves explicit', after.length === 2
    && after[0].date === '2026-08-01' && after[0].start === '09:15' && after[0].end === '10:45'
    && after[1].date === '2026-08-02' && after[1].start === '16:00' && after[1].end === '17:30');
  sb.el('ps-create-comp-course').checked = true;
  sb.scheduleOnCreateComponentChange('ps-create-comp-course');
  assert('Group hides When after leaving Private', whenHidden(sb));
  pickPrivate(sb);
  assert('When visible again after re-Private', whenVisible(sb));
  const back = rows(sb);
  assert('Private→Group→Private preserves explicit', back.length === 2
    && back[0].start === '09:15' && back[0].end === '10:45'
    && back[1].start === '16:00' && back[1].end === '17:30');
  // Overlap shift: keep edited day, default only brand-new day
  setRange(sb, '2026-08-02', '2026-08-03');
  const shift = rows(sb);
  assert('shift preserves overlap + defaults new day', shift.length === 2
    && shift[0].date === '2026-08-02' && shift[0].start === '16:00' && shift[0].end === '17:30'
    && shift[1].date === '2026-08-03' && shift[1].start === '10:00' && shift[1].end === '12:00');
}

// ── 4) Edit drawer does not apply Create blank defaults ─────────────────────
console.log('\n[4] Edit existing booking times untouched');
assert('Edit render does not call Create sync',
  !/scheduleSyncPrivateLessonSessions/.test(editSrc)
  && !/schedulePrivateLessonApplyBlankTimeDefaults/.test(editSrc)
  && !/schedulePrivateLessonDefaultStartHm/.test(editSrc));
assert('Edit writes existing sess.start/end only',
  /value="' \+ escHtml\(sess\.start \|\| ''\)/.test(editSrc)
  && /value="' \+ escHtml\(sess\.end \|\| ''\)/.test(editSrc));
// Empty existing edit sessions stay empty (no forced 10:00)
{
  const renderFn = extractFn(editSrc, 'scheduleDrawerRenderPrivateSessions') || '';
  const syncFn = extractFn(editSrc, 'scheduleDrawerSyncPrivateSessions') || '';
  assert('Edit empty session stays blank (no Create default inject)',
    renderFn.includes("sess.start || ''")
    && renderFn.includes("sess.end || ''")
    && !/10:00|schedulePrivateLessonDefaultStartHm|ApplyBlankTimeDefaults/.test(renderFn)
    && !/10:00|schedulePrivateLessonDefaultStartHm|ApplyBlankTimeDefaults/.test(syncFn)
    && /start: prev\.start != null \? String\(prev\.start\) : ''/.test(syncFn));
}

// ── 5) 120-minute duration ──────────────────────────────────────────────────
console.log('\n[5] Duration 120 minutes (10:00 → 12:00)');
{
  const sb = build({ dateFrom: '2026-09-01', dateTo: '2026-09-01' });
  pickPrivate(sb);
  const r = rows(sb)[0];
  const startM = 10 * 60;
  const endM = 12 * 60;
  assert('120-minute window', r.start === '10:00' && r.end === '12:00'
    && (endM - startM) === 120);
  // auto-end from start change still uses duration cache
  const startEl = sb.el('ps-create-private-lesson-sessions').querySelectorAll('.ps-pl-session-start')[0];
  startEl.value = '14:00';
  startEl.dispatchEvent({ type: 'change', target: startEl });
  assert('start change auto-end +120', rows(sb)[0].start === '14:00' && rows(sb)[0].end === '16:00');
}

// ── 6) 320px + runtime source parity ────────────────────────────────────────
console.log('\n[6] 320px layout + runtime inject source parity');
assert('portal inject marker in staff-query-api',
  apiSrc.includes('/* INJECT:sunset-schedule-portal-module */'));
assert('buildUiHtml injects portal module',
  /injectSunsetSchedulePortalModule\(html\)/.test(apiSrc));
assert('Create sync owner only in portal module (not duplicated in api)',
  !/function scheduleSyncPrivateLessonSessions/.test(apiSrc)
  && /function scheduleSyncPrivateLessonSessions/.test(portalSrc)
  && !/function schedulePrivateLessonDefaultStartHm/.test(apiSrc)
  && /function schedulePrivateLessonDefaultStartHm/.test(portalSrc));
assert('private session grid mobile collapse present',
  /\.portal-schedule-private-session-grid\{[^}]*grid-template-columns:\s*repeat\(3/.test(apiSrc)
  && /@media\(max-width:\s*640px\)\{\.portal-schedule-private-session-grid\{grid-template-columns:\s*1fr\}/.test(apiSrc));
assert('create drawer width works at 320px viewport',
  /width:\s*min\(440px,\s*94vw\)/.test(apiSrc)
  || /width:\s*min\(440px,94vw\)/.test(apiSrc));
assert('tenant local date helpers (no UTC date from clock for service day)',
  /function schedulePortalCanonicalDateIso/.test(portalSrc)
  && /function schedulePortalMadridTodayIso/.test(portalSrc)
  && /Europe\/Madrid/.test(extractFn(portalSrc, 'schedulePortalMadridTodayIso') || ''));
// Date tokens are calendar ISO strings, times are wall HH:MM — no Date() for defaults.
assert('sync path does not stamp times from new Date()',
  !/new Date\(/.test(
    (extractFn(portalSrc, 'scheduleSyncPrivateLessonSessions') || '')
      .replace(/scheduleEnumerateDates[\s\S]*/, ''),
  )
  && !/getHours|toTimeString|toLocaleTimeString/.test(
    extractFn(portalSrc, 'scheduleSyncPrivateLessonSessions') || '',
  ));

console.log('\n' + '─'.repeat(48));
console.log('Results: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) {
  console.error('verify:sunset-private-create-default-times-quickfix — FAILED');
  process.exit(1);
}
console.log('verify:sunset-private-create-default-times-quickfix — ALL CHECKS PASSED');
process.exit(0);

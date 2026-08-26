'use strict';

/**
 * verify:sunset-create-date-picker-past-block
 *
 * Staff-create date picker must disable past days and block Apply.
 * Staff-edit drawer calendar is out of scope (separate owner file).
 *
 * Run: node scripts/verify-sunset-create-date-picker-past-block.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const API = path.join(__dirname, 'staff-query-api.js');
const EDIT = path.join(__dirname, 'browser', 'sunset-schedule-drawer-edit-ui.js');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

function extractFn(src, name) {
  const needle = `function ${name}(`;
  const start = src.indexOf(needle);
  if (start < 0) return null;
  const braceStart = src.indexOf('{', start);
  if (braceStart < 0) return null;
  let depth = 0;
  for (let i = braceStart; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

const apiSrc = fs.readFileSync(API, 'utf8');
const editSrc = fs.readFileSync(EDIT, 'utf8');

console.log('\nverify:sunset-create-date-picker-past-block\n');

console.log('[1] Create picker owners present; edit drawer not wired to is-past guard');
assert('create helpers exported in staff-query-api',
  /function scheduleCreateDateRangeMinIso\s*\(/.test(apiSrc)
  && /function scheduleCreateDateRangeIsPastIso\s*\(/.test(apiSrc)
  && /function scheduleCreateDateRangeDraftHasPast\s*\(/.test(apiSrc)
  && /function scheduleCreateDateRangeDraftReady\s*\(/.test(apiSrc));
assert('create calendar marks is-past + disabled',
  /is-past/.test(extractFn(apiSrc, 'scheduleRenderCreateDateRangeCalendar') || '')
  && /disabled aria-disabled="true"/.test(extractFn(apiSrc, 'scheduleRenderCreateDateRangeCalendar') || ''));
assert('create Apply rejects past draft',
  /scheduleCreateDateRangeDraftHasPast\(draft\)/.test(extractFn(apiSrc, 'scheduleApplyCreateDateRangeDraft') || ''));
assert('create selectDay ignores past iso',
  /scheduleCreateDateRangeIsPastIso\(iso\)/.test(extractFn(apiSrc, 'scheduleCreateDateRangeSelectDay') || ''));
assert('edit drawer calendar does not add is-past class',
  !/is-past/.test(extractFn(editSrc, 'scheduleRenderDrawerDateRangeCalendar') || ''));

const TODAY = '2026-08-25';
const PAST = '2026-08-05';

function makeSandbox() {
  const nodes = {};
  function N(id, extra) {
    nodes[id] = Object.assign({
      id,
      value: '',
      checked: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      hidden: true,
      style: { display: 'none' },
      dataset: {},
      classList: { add() {}, remove() {}, contains() { return false; } },
      setAttribute() {},
      getAttribute() { return null; },
      removeAttribute() {},
      addEventListener() {},
      dispatchEvent() { return true; },
      querySelector(sel) {
        if (sel === '[data-date="' + PAST + '"]') return nodes._pastBtn || null;
        if (sel === '[data-date="' + TODAY + '"]') return nodes._todayBtn || null;
        return null;
      },
      contains() { return true; },
    }, extra || {});
    return nodes[id];
  }

  N('ps-create-date-from', { value: TODAY });
  N('ps-create-date-to', { value: TODAY });
  N('ps-create-date-range-display', { textContent: '' });
  N('ps-create-date-range-apply', { disabled: true });
  N('ps-create-date-range-past-warn', { textContent: '', hidden: true, style: { display: 'none' } });
  N('ps-create-date-range-grid', {
    innerHTML: '',
    _dateRangeCells: [],
    querySelector(sel) {
      if (sel.indexOf('data-date') >= 0) return null;
      return null;
    },
  });
  N('ps-create-date-range-month-label', { textContent: '' });
  nodes._pastBtn = {
    disabled: true,
    classList: { contains(c) { return c === 'is-past'; } },
    getAttribute(k) { return k === 'data-date' ? PAST : null; },
    closest() { return this; },
  };
  nodes._todayBtn = {
    disabled: false,
    classList: { contains() { return false; } },
    getAttribute(k) { return k === 'data-date' ? TODAY : null; },
    closest() { return this; },
  };

  const ctx = {
    console,
    el: (id) => nodes[id] || null,
    escHtml: (s) => String(s == null ? '' : s),
    portalT: (k) => ({
      'schedule.create.dateRange.pastDate': 'No puedes reservar fechas pasadas.',
      'schedule.create.dateRange.placeholder': 'Select dates',
    }[k] || k),
    scheduleTodayIso: () => TODAY,
    scheduleParseIso: (iso) => new Date(String(iso).slice(0, 10) + 'T12:00:00'),
    scheduleIsoDate: (d) => d.toISOString().slice(0, 10),
    scheduleCreateDateRangeDraft: { start: null, end: null },
    scheduleCreateDateRangeViewYm: '2026-08',
    scheduleCreateDateRangeFocusIso: null,
  };

  vm.createContext(ctx);
  const names = [
    'scheduleCreateDateRangeIsValidIso',
    'scheduleCreateDateRangeMinIso',
    'scheduleCreateDateRangeIsPastIso',
    'scheduleCreateDateRangeDraftHasPast',
    'scheduleCreateDateRangeDraftReady',
    'scheduleCreateDateRangePastMessage',
    'scheduleCreateDateRangeSyncPastWarning',
    'scheduleCreateDateRangeSelectDay',
    'scheduleCreateDateRangeFormatShort',
    'scheduleCreateDateRangeDisplayText',
    'scheduleSyncCreateDateRangeUi',
    'scheduleApplyCreateDateRangeDraft',
  ];
  let code = '';
  for (const name of names) {
    const fn = extractFn(apiSrc, name);
    if (!fn) throw new Error('missing ' + name);
    code += fn + '\n';
  }
  code += names.map((n) => `this.${n} = ${n};`).join('\n');
  code += `\nfunction scheduleCreateDateRangeClosePopover(){}\n`;
  vm.runInContext(code, ctx);
  return { ctx, nodes };
}

console.log('\n[2] Pure helpers');
{
  const { ctx } = makeSandbox();
  assert('past iso detected', ctx.scheduleCreateDateRangeIsPastIso(PAST) === true);
  assert('today iso allowed', ctx.scheduleCreateDateRangeIsPastIso(TODAY) === false);
  assert('selectDay ignores past click',
    ctx.scheduleCreateDateRangeSelectDay({ start: TODAY, end: null }, PAST).start === TODAY);
  assert('draft ready rejects past start',
    ctx.scheduleCreateDateRangeDraftReady({ start: PAST, end: null }) === false);
  assert('draft ready accepts today',
    ctx.scheduleCreateDateRangeDraftReady({ start: TODAY, end: null }) === true);
}

console.log('\n[3] Apply + sync block past ranges');
{
  const { ctx, nodes } = makeSandbox();
  ctx.scheduleCreateDateRangeDraft = { start: PAST, end: null };
  ctx.scheduleSyncCreateDateRangeUi();
  assert('Apply disabled for past draft', nodes['ps-create-date-range-apply'].disabled === true);
  assert('past warning painted',
    nodes['ps-create-date-range-past-warn'].textContent.indexOf('fechas pasadas') >= 0
    && nodes['ps-create-date-range-past-warn'].hidden === false);
  const applied = ctx.scheduleApplyCreateDateRangeDraft();
  assert('Apply returns false for past draft', applied === false);
  assert('canonical from/to unchanged after blocked Apply',
    nodes['ps-create-date-from'].value === TODAY
    && nodes['ps-create-date-to'].value === TODAY);

  ctx.scheduleCreateDateRangeDraft = { start: TODAY, end: TODAY };
  ctx.scheduleSyncCreateDateRangeUi();
  assert('Apply enabled for today draft', nodes['ps-create-date-range-apply'].disabled === false);
  const ok = ctx.scheduleApplyCreateDateRangeDraft();
  assert('Apply commits today draft', ok === true
    && nodes['ps-create-date-from'].value === TODAY
    && nodes['ps-create-date-to'].value === TODAY);
}

console.log(`\n── verify:sunset-create-date-picker-past-block ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
process.exit(fail ? 1 : 0);

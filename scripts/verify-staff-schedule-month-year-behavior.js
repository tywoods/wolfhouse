'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readStaffPortalUiSource } = require('./lib/staff-portal-ui-source');
const src = readStaffPortalUiSource();

function extractFunction(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return '';
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

const names = [
  'escHtml', 'staffDisplayBookingCode', 'bcSetDateField', 'bcReadDateField', 'bcReadCalendarRangeIso',
  'bcUpdateCalendarTitle', 'bcSetRange', 'bcMonthWindow', 'bcShiftMonth', 'bcParseNavYear',
  'bcSelectedNavYear', 'bcLocalTodayIso', 'bcShowNavYearError', 'bcClearNavYearError',
  'bcFillMonthNavOptions', 'bcSyncMonthNav', 'bcApplyMonthWindow', 'bcCommittedNavYear',
  'bcCommitNavYear', 'bcNavStep', 'bcNavToday', 'bcInitMonthNav', 'renderBookingBlock',
  'bcOpenBookingDrawerOverview', 'bcOpenSideBooking', 'bcSideDrawerLive', 'loadBedCalendar',
  'bcBlockTooltip', 'bcBlockLabel', 'bcCalendarBlockDisplayLabel', 'pickCalendarGuestDisplayName',
  'bcCalendarBlockInnerHtml', 'bcColorClass', 'bcGroupPaintBits', 'bcPayStripeClass',
  'bcCalendarPaymentTooltipHint', 'showBlockDetail',
];

const nodes = {};
function makeEl(id) {
  if (nodes[id]) return nodes[id];
  const el = {
    id,
    value: '',
    dataset: {},
    type: id === 'bc-start' || id === 'bc-end' ? 'date' : 'text',
    className: '',
    style: { display: '' },
    disabled: false,
    textContent: '',
    innerHTML: '',
    options: [],
    hidden: false,
    title: '',
    listeners: {},
    classList: {
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      _s: new Set(),
    },
    addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); },
    removeAttribute() {},
    setAttribute(k, v) { this.dataset[k] = v; },
    getAttribute(k) { return this.dataset[k] || null; },
    appendChild(child) { this.options.push(child); return child; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    focus() {},
    blur() {},
  };
  nodes[id] = el;
  return el;
}

const requests = [];
const context = {
  console,
  Date,
  Number,
  String,
  RegExp,
  parseInt,
  isNaN,
  encodeURIComponent,
  decodeURIComponent,
  Promise,
  setTimeout,
  clearTimeout,
  document: {
    documentElement: { lang: 'en', getAttribute() { return 'wolfhouse'; } },
    getElementById: makeEl,
    querySelectorAll() { return []; },
    createElement() { return makeEl('opt-' + Math.random()); },
  },
  window: { innerWidth: 1100, bcRangePopState: { view: '2027-01-31' } },
  fetch(url) {
    requests.push(String(url));
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ success: true, rooms: [{ room_code: 'R1', beds: [{ bed_code: 'B1' }] }], days: [{ date: '2027-06-01' }], blocks: [] }),
    });
  },
  t(key) { return key === 'calendar.nav.invalidYear' ? 'Enter a 4-digit year.' : key; },
  BC_ISO_DATE_RE: /^\d{4}-\d{2}-\d{2}$/,
  BC_YEAR_PREFIX_RE: /^\d{4}/,
  BC_DISPLAY_DATE_RE: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
  bcLoadEpoch: 0,
  bcNavYearEditing: false,
  BC_SEASON_CHIP_MONTHS: {
    'apr-may': [4, 5], 'may-jun': [5, 6], 'jun-jul': [6, 7], 'jul-aug': [7, 8],
    'aug-sept': [8, 9], 'sep-oct': [9, 10], 'oct-nov': [10, 11],
  },
};
const missing = [];
context.el = makeEl;
const handler = {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (typeof prop !== 'string') return undefined;
    missing.push(prop);
    const stub = function stubFn() { return ''; };
    target[prop] = stub;
    return stub;
  },
  set(target, prop, value) {
    target[prop] = value;
    return true;
  },
  has() { return true; },
};
const sandbox = new Proxy(context, handler);
vm.createContext(sandbox);
function generatedFunction(name) {
  return eval('`' + extractFunction(name) + '`');
}
const generatedYear = generatedFunction('bcParseNavYear') + '\n' + generatedFunction('bcSelectedNavYear');
assert.equal(generatedYear.includes('/^d{4}'), false, 'generated page must not eat the year digit class');
assert.match(generatedYear, /\\d\{4\}/, 'generated year check still matches digits');
const yearApi = new Function(generatedYear + '\nreturn { bcParseNavYear, bcSelectedNavYear };')();
assert.equal(yearApi.bcParseNavYear('2027'), 2027);
assert.equal(yearApi.bcParseNavYear('2028'), 2028);
assert.equal(yearApi.bcParseNavYear('20ab'), null);
assert.equal(yearApi.bcParseNavYear('202'), null);
let code = names.map(extractFunction).filter(Boolean).join('\n');
code = code.replace(extractFunction('bcParseNavYear'), generatedFunction('bcParseNavYear'));
code = code.replace(extractFunction('bcSelectedNavYear'), generatedFunction('bcSelectedNavYear'));
vm.runInContext(code + '\nthis.__api = { bcCommitNavYear, bcApplyMonthWindow, bcNavStep, bcInitMonthNav, renderBookingBlock, bcOpenBookingDrawerOverview, bcMonthWindow, bcSelectedNavYear };', sandbox);

makeEl('bc-start').value = '2026-10-01';
makeEl('bc-end').value = '2026-10-31';
makeEl('bc-nav-year').value = '2027';
makeEl('bc-nav-month').value = '6';
sandbox.__api.bcCommitNavYear();
assert.ok(requests.some((url) => url.includes('start=2027-06-01') && url.includes('end=2027-07-01')), requests.join('\n'));

const before = requests.length;
makeEl('bc-nav-year').value = '20ab';
const committed = sandbox.__api.bcCommitNavYear();
assert.equal(committed, false);
assert.equal(requests.length, before);
assert.equal(makeEl('bc-start').value, '2027-06-01');
assert.match(makeEl('bc-state').textContent, /4-digit year/);

makeEl('bc-nav-year').value = '2027';
makeEl('bc-start').value = '2027-06-01';
const year = sandbox.__api.bcSelectedNavYear();
const oct = sandbox.__api.bcMonthWindow(year, 10);
const nov = sandbox.__api.bcMonthWindow(year, 11);
assert.equal(oct.start, '2027-10-01');
assert.equal(nov.end, '2027-12-01');

const blk = {
  booking_code: 'WH-LAST-2027',
  guest_name: 'June Guest',
  start_date: '2027-06-30',
  end_date: '2027-07-01',
  status: 'confirmed',
  color_type: 'staff',
  span_days: 1,
};
let html = '';
try {
  html = sandbox.__api.renderBookingBlock(blk, 0, 1, null);
} catch (err) {
  console.error('render failed', err);
  console.error('missing sample', missing.slice(0, 40));
  process.exit(1);
}
assert.match(html, /data-booking-code="WH-LAST-2027"/, html);
assert.match(html, /WH-LAST-2027/, html);
sandbox.window.innerWidth = 400;
sandbox.__api.bcOpenBookingDrawerOverview(blk);
assert.match(makeEl('bc-detail').innerHTML, /WH-LAST-2027/, 'click path opens the existing drawer');
assert.match(src, /bcOpenBookingDrawerOverview\(blocks\[idx\]\)/, 'grid click still uses the existing drawer opener');
console.log('PASS behavior harness');
console.log('requests', requests);
console.log('html snippet', html.slice(0, 400));

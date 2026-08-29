'use strict';

/**
 * Reservas leftover: text search must intersect the active date-range filter.
 * QA symptom: with a date range applied, typing search made the count rise
 * (e.g. 17 → 21) because empty remounted date inputs cleared the range.
 * Hardening: restore-before-wire, self-heal wiped inputs, display/open follow state.
 *
 * Owners: scripts/browser/sunset-admin-bookings-ui.js,
 *         scripts/lib/sunset-bookings-admin.js (filterBookingRows).
 * Stay off Inbox, email-settings, inbox-thread, Skipper inbound.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const bookingsUiPath = path.join(ROOT, 'scripts/browser/sunset-admin-bookings-ui.js');
const bookingsUiSrc = fs.readFileSync(bookingsUiPath, 'utf8');
const {
  filterBookingRows,
  parseListQuery,
} = require(path.join(ROOT, 'scripts/lib/sunset-bookings-admin.js'));

function row(code, guest, start) {
  return {
    booking_code: code,
    guest_name: guest,
    phone: '',
    service_dates: [start],
    service_date_start: start,
    hidden: false,
    status: 'confirmed',
  };
}

// ── 1) Pure filter: search ∩ date range; count must not rise vs date-only ──
const rows = [];
for (let i = 0; i < 17; i += 1) {
  rows.push(row('IN' + i, 'Guest' + i, '2026-08-10'));
}
for (let i = 0; i < 21; i += 1) {
  rows.push(row('OUT' + i, 'TestUser' + i, '2026-01-01'));
}
const dateOnly = filterBookingRows(rows, {
  date_from: '2026-08-01',
  date_to: '2026-08-31',
});
const searchNoDate = filterBookingRows(rows, { q: 'test' });
const both = filterBookingRows(rows, {
  q: 'test',
  date_from: '2026-08-01',
  date_to: '2026-08-31',
});
assert.strictEqual(dateOnly.length, 17, 'date-only fixture count');
assert.strictEqual(searchNoDate.length, 21, 'search-without-dates finds out-of-range rows');
assert.ok(
  both.length <= dateOnly.length,
  'search ∩ dates must not raise count above date-only (QA 17→21 regression)'
);
assert.strictEqual(both.length, 0, 'no in-range rows match "test" in fixture');

const garyIn = filterBookingRows([
  row('IN', 'Gary', '2026-08-11'),
  row('OUT', 'Gary', '2026-06-01'),
], { q: 'gary', date_from: '2026-08-01', date_to: '2026-08-31' });
assert.strictEqual(garyIn.length, 1);
assert.strictEqual(garyIn[0].booking_code, 'IN');

const parsed = parseListQuery({
  q: 'gary',
  date_from: '2026-08-01',
  date_to: '2026-08-31',
});
assert.strictEqual(parsed.q, 'gary');
assert.strictEqual(parsed.date_from, '2026-08-01');
assert.strictEqual(parsed.date_to, '2026-08-31');

// ── 2) UI source contract ──
assert.ok(bookingsUiSrc.includes('function adminBookingsReadFiltersFromDom'),
  'readFiltersFromDom is a named owner');
assert.ok(bookingsUiSrc.includes('data-range-cleared'),
  'explicit Clear is distinct from empty remounted inputs');
assert.ok(
  bookingsUiSrc.includes('// Shell markup resets hidden date inputs'),
  'shell remount documents that markup wipes hidden date inputs'
);
assert.ok(
  bookingsUiSrc.includes('adminBookingsRestoreFiltersToDom();'),
  'shell remount restores filters to DOM'
);
// Restore must run before wire + load/skipLoad (lodging may sit between restore and skipLoad).
const restoreAt = bookingsUiSrc.indexOf('adminBookingsRestoreFiltersToDom();');
const wireAt = bookingsUiSrc.indexOf('wireAdminBookingsPanel();', restoreAt);
const skipLoadAt = bookingsUiSrc.indexOf('opts.skipLoad', restoreAt);
const loadAt = bookingsUiSrc.indexOf('loadAdminBookings();', restoreAt);
assert.ok(restoreAt >= 0 && wireAt > restoreAt, 'restore runs before wire after remount');
assert.ok(
  skipLoadAt > restoreAt && loadAt > restoreAt,
  'restore runs before skipLoad/load paths'
);
assert.ok(
  /df\.value = f\.date_from|Keep active range \+ heal/.test(bookingsUiSrc),
  'readFilters self-heals wiped date inputs from state'
);
assert.ok(bookingsUiSrc.includes('adminBookingsReadFiltersFromDom()'),
  'live filters / export call the named reader');
assert.ok(!bookingsUiSrc.includes('inbox-thread.js'));
assert.ok(!bookingsUiSrc.includes('staff-email-oauth'));

// ── 3) Behavioral: remount wipes DOM; search must keep dates in the query ──
const nodes = new Map();
function makeEl(id, attrs) {
  attrs = attrs || {};
  const node = {
    id,
    value: attrs.value || '',
    textContent: '',
    attributes: Object.assign({}, attrs.attributes || {}),
    dataset: {},
    style: {},
    hidden: !!attrs.hidden,
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    removeAttribute(k) { delete this.attributes[k]; },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
  };
  nodes.set(id, node);
  return node;
}

const body = makeEl('admin-bookings-body');
Object.defineProperty(body, 'innerHTML', {
  set() {
    [
      'admin-bookings-q',
      'admin-bookings-date-from',
      'admin-bookings-date-to',
      'admin-bookings-status',
      'admin-bookings-type',
      'admin-bookings-date-range-display',
      'admin-bookings-date-range-popover',
      'admin-bookings-date-range-trigger',
      'admin-bookings-date-range-grid',
      'admin-bookings-date-range-month-label',
      'admin-bookings-date-range-prev',
      'admin-bookings-date-range-next',
      'admin-bookings-date-range-clear',
      'admin-bookings-date-range-cancel',
      'admin-bookings-export',
      'admin-bookings-table-wrap',
      'admin-bookings-summary',
      'admin-bookings-msg',
      'admin-bookings-date-range',
    ].forEach((id) => makeEl(id));
    // Template always mounts empty date inputs (the remount bug).
    nodes.get('admin-bookings-date-from').value = '';
    nodes.get('admin-bookings-date-to').value = '';
    nodes.get('admin-bookings-date-range-popover').hidden = true;
  },
  get() { return ''; },
});
body.innerHTML = 'init';

const queries = [];
const sandbox = {
  console,
  window: {},
  document: { addEventListener() {}, removeEventListener() {} },
  staffPortalSession: { role: 'admin' },
  portalT: (k) => k,
  escHtml: (s) => String(s || ''),
  getClient: () => 'sunset',
  getSunsetLocation: () => 'sunset-somo',
  el: (id) => nodes.get(id) || null,
  fetch: (url) => {
    queries.push(String(url));
    return Promise.resolve({
      status: 200,
      json: async () => ({
        success: true,
        rows: [],
        summary: { bookings_count: 0 },
        total_count: 0,
        filters: {},
      }),
    });
  },
  URLSearchParams,
  AbortController,
  setTimeout,
  clearTimeout,
};
sandbox.window = sandbox;

vm.createContext(sandbox);
vm.runInContext(
  bookingsUiSrc
  + '\nthis.adminBookingsState = adminBookingsState;'
  + '\nthis.adminBookingsBuildQuery = adminBookingsBuildQuery;'
  + '\nthis.adminBookingsReadFiltersFromDom = adminBookingsReadFiltersFromDom;'
  + '\nthis.adminBookingsRestoreFiltersToDom = adminBookingsRestoreFiltersToDom;'
  + '\nthis.renderAdminBookingsShell = renderAdminBookingsShell;',
  sandbox
);

sandbox.adminBookingsState.filters.date_from = '2026-08-01';
sandbox.adminBookingsState.filters.date_to = '2026-08-31';
sandbox.adminBookingsState.filters.q = '';
nodes.get('admin-bookings-date-from').value = '2026-08-01';
nodes.get('admin-bookings-date-to').value = '2026-08-31';

queries.length = 0;
delete body.dataset.bookingsWired;
sandbox.renderAdminBookingsShell();
assert.strictEqual(
  nodes.get('admin-bookings-date-from').value,
  '2026-08-01',
  'shell remount restores date_from into hidden input'
);
assert.strictEqual(
  nodes.get('admin-bookings-date-to').value,
  '2026-08-31',
  'shell remount restores date_to into hidden input'
);
assert.ok(
  (queries[0] || '').includes('date_from=2026-08-01')
  && (queries[0] || '').includes('date_to=2026-08-31'),
  'post-remount load keeps date range in query: ' + (queries[0] || '')
);

// Simulate wiped DOM without restore (legacy failure mode) + search read.
nodes.get('admin-bookings-date-from').value = '';
nodes.get('admin-bookings-date-to').value = '';
nodes.get('admin-bookings-q').value = 'gary';
sandbox.adminBookingsReadFiltersFromDom();
const qAfterSearch = sandbox.adminBookingsBuildQuery();
assert.ok(qAfterSearch.includes('q=gary'), 'search q present: ' + qAfterSearch);
assert.ok(
  qAfterSearch.includes('date_from=2026-08-01') && qAfterSearch.includes('date_to=2026-08-31'),
  'search keeps active date range even when hidden inputs are empty: ' + qAfterSearch
);
assert.strictEqual(sandbox.adminBookingsState.filters.date_from, '2026-08-01');
assert.strictEqual(sandbox.adminBookingsState.filters.date_to, '2026-08-31');
assert.strictEqual(
  nodes.get('admin-bookings-date-from').value,
  '2026-08-01',
  'search read self-heals wiped date_from into DOM'
);
assert.strictEqual(
  nodes.get('admin-bookings-date-to').value,
  '2026-08-31',
  'search read self-heals wiped date_to into DOM'
);
assert.ok(
  /2026-08/.test(String(nodes.get('admin-bookings-date-range-display').textContent || '')),
  'date-range chip stays in sync with healed filters: ' +
    nodes.get('admin-bookings-date-range-display').textContent
);

// Explicit Clear must widen (drop dates).
nodes.get('admin-bookings-date-from').value = '';
nodes.get('admin-bookings-date-to').value = '';
nodes.get('admin-bookings-date-from').setAttribute('data-range-cleared', '1');
nodes.get('admin-bookings-date-to').setAttribute('data-range-cleared', '1');
nodes.get('admin-bookings-q').value = 'gary';
sandbox.adminBookingsReadFiltersFromDom();
const qCleared = sandbox.adminBookingsBuildQuery();
assert.ok(qCleared.includes('q=gary'), qCleared);
assert.ok(!qCleared.includes('date_from='), 'Clear drops date_from: ' + qCleared);
assert.ok(!qCleared.includes('date_to='), 'Clear drops date_to: ' + qCleared);
assert.strictEqual(nodes.get('admin-bookings-date-from').value, '', 'Clear leaves date_from empty');
assert.strictEqual(nodes.get('admin-bookings-date-to').value, '', 'Clear leaves date_to empty');

console.log('PASS Reservas search ∩ date-range (filter + remount/search UI)');

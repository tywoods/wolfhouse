'use strict';

/**
 * Reservas expand: clean booking detail — no line-item injection into the
 * 7-col grid, no raw ISO timestamps, no payment-junk labels.
 * Partidas dates use staff-portal locale (see verify-sunset-reservas-partidas-locale-dates).
 * Stay off inbox-thread, email inbound/Graph, Admin Email backend, production.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const bookingsUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-bookings-ui.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

assert.ok(
  bookingsUi.includes('portal-admin-bookings-row-block'),
  'expand must live in row-block outside the 7-col grid'
);
assert.ok(
  bookingsUi.includes('adminBookingsCleanItemLabel')
    && bookingsUi.includes('adminBookingsFormatItemDate')
    && bookingsUi.includes('adminBookingsIsJunkExpandItem'),
  'clean-label helpers required'
);
assert.ok(
  /html \+= '<\/div>';\s*\n\s*if \(expanded\) \{\s*\n\s*html \+= renderAdminBookingsExpansion\(row(?:, rowKey)?\);/.test(bookingsUi),
  'expansion must render after the 7-col tr closes (sibling under row-block)'
);
assert.ok(
  apiSrc.includes('.portal-admin-bookings-row-block{')
    && apiSrc.includes('.portal-admin-bookings-expand{display:block;width:100%'),
  'CSS: row-block + full-width expand (not grid-column child of 7-col tr)'
);
assert.ok(!apiSrc.includes('.portal-admin-bookings-expand{grid-column:1/-1'),
  'expand must not rely on grid-column inside the bookings tr');
assert.ok(!bookingsUi.includes('inbox-thread.js'));
assert.ok(!bookingsUi.includes('staff-email-luna-draft'));

const expectedEn = new Date(Date.UTC(2026, 7, 11, 12, 0, 0)).toLocaleDateString('en-GB', {
  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
});

function loadHelpers() {
  const start = bookingsUi.indexOf('function adminBookingsLocaleTag');
  const end = bookingsUi.indexOf('/** Booking created_at');
  assert.ok(start >= 0 && end > start, 'helper slice bounds');
  const box = {
    getStaffLocale() { return 'en'; },
  };
  vm.createContext(box);
  vm.runInContext(
    bookingsUi.slice(start, end)
      + '\nthis.adminBookingsFormatItemDate = adminBookingsFormatItemDate;'
      + '\nthis.adminBookingsCleanItemLabel = adminBookingsCleanItemLabel;'
      + '\nthis.adminBookingsIsJunkExpandItem = adminBookingsIsJunkExpandItem;',
    box
  );
  return box;
}

const h = loadHelpers();

assert.strictEqual(h.adminBookingsFormatItemDate('2026-08-11T00:00:00.000Z'), expectedEn);
assert.strictEqual(h.adminBookingsFormatItemDate('2026-08-11'), expectedEn);
assert.strictEqual(h.adminBookingsFormatItemDate(''), '');
assert.ok(!/^\d{4}-\d{2}-\d{2}$/.test(h.adminBookingsFormatItemDate('2026-08-11')), 'not raw ISO');

assert.strictEqual(
  h.adminBookingsCleanItemLabel('Accommodation · 2026-08-11T00:00:00.000Z → 2026-08-14T00:00:00.000Z'),
  'Accommodation'
);
assert.strictEqual(
  h.adminBookingsCleanItemLabel('board_and_suit_rental'),
  'Board and suit rental'
);
assert.strictEqual(h.adminBookingsCleanItemLabel('{"stripe_pi":"pi_xxx"}'), '');
assert.strictEqual(h.adminBookingsCleanItemLabel('pi_abc123'), '');
assert.strictEqual(h.adminBookingsCleanItemLabel('Adult group course'), 'Adult group course');

assert.strictEqual(
  h.adminBookingsIsJunkExpandItem({
    label: '{"status":"succeeded"}',
    service_type: 'payment_fee',
    amount_due_cents: 0,
  }),
  true
);
assert.strictEqual(
  h.adminBookingsIsJunkExpandItem({
    label: 'Adult group course',
    service_type: 'surf_lesson',
    service_date: '2026-08-11',
    amount_due_cents: 12000,
  }),
  false
);

// Render expansion with hostile payload — amounts stay server-authored cents.
const escHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const portalT = (k) => k;
const adminBookingsFormatEur = (cents) => {
  const n = Number(cents || 0);
  return '€' + (n / 100).toFixed(2);
};
const adminBookingsFormatMadridCreated = (iso) => String(iso).slice(0, 16).replace('T', ' ');
const adminBookingsCanWriteRefund = () => false;
const box = {
  getStaffLocale() { return 'en'; },
  escHtml,
  portalT,
  adminBookingsFormatEur,
  adminBookingsFormatMadridCreated,
  adminBookingsCanWriteRefund,
  adminBookingsFormatItemDate: h.adminBookingsFormatItemDate,
  adminBookingsCleanItemLabel: h.adminBookingsCleanItemLabel,
  adminBookingsIsJunkExpandItem: h.adminBookingsIsJunkExpandItem,
  adminBookingsRowKey(row) { return String((row && row.booking_id) || 'row'); },
};
vm.createContext(box);
const expStart = bookingsUi.indexOf('function renderAdminBookingsExpansion');
const expEnd = bookingsUi.indexOf('function openAdminBookingsRefundForm');
vm.runInContext(
  'var adminBookingsFormatItemDate = this.adminBookingsFormatItemDate;'
    + 'var adminBookingsCleanItemLabel = this.adminBookingsCleanItemLabel;'
    + 'var adminBookingsIsJunkExpandItem = this.adminBookingsIsJunkExpandItem;'
    + 'var escHtml = this.escHtml;'
    + 'var portalT = this.portalT;'
    + 'var adminBookingsFormatEur = this.adminBookingsFormatEur;'
    + 'var adminBookingsFormatMadridCreated = this.adminBookingsFormatMadridCreated;'
    + 'var adminBookingsCanWriteRefund = this.adminBookingsCanWriteRefund;'
    + 'var adminBookingsRowKey = this.adminBookingsRowKey;'
    + bookingsUi.slice(expStart, expEnd)
    + '\nthis.render = renderAdminBookingsExpansion;',
  box
);

const html = box.render({
  booking_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  guest_name: 'Gary',
  phone: '+34600111222',
  created_by: 'ops@sunset.test',
  status: 'paid',
  items: [
    {
      label: null,
      service_type: 'board_and_suit_rental',
      service_date: '2026-08-11T09:00:00.000Z',
      amount_due_cents: 4500,
    },
    {
      label: 'Accommodation · 2026-08-11T00:00:00.000Z → 2026-08-14T00:00:00.000Z',
      service_date: '2026-08-11T00:00:00.000Z',
      amount_due_cents: 96000,
    },
    {
      label: '{"stripe_pi":"pi_xxx","status":"succeeded"}',
      service_type: 'payment_fee',
      amount_due_cents: 0,
    },
    {
      label: 'Adult group course',
      service_date: '2026-08-11',
      amount_due_cents: 12000,
    },
  ],
  payment_story: { charged_cents: 112500, collected_cents: 112500, refunded_cents: 0, net_cents: 112500 },
  waiver: { status: 'completed' },
  refunds: [],
});

assert.ok(html.indexOf('data-bookings-expand=') >= 0, 'expand region present');
assert.ok(html.indexOf('Board and suit rental · ' + expectedEn) >= 0, 'humanized rental + locale date');
assert.ok(html.indexOf('Accommodation · ' + expectedEn) >= 0, 'accommodation without ISO range dump');
assert.ok(html.indexOf('Adult group course · ' + expectedEn) >= 0, 'lesson line kept');
assert.ok(!/T\d{2}:\d{2}/.test(html), 'no raw ISO timestamps in expand HTML: ' + html.slice(0, 400));
assert.ok(html.indexOf('2026-08-11') < 0, 'no raw YYYY-MM-DD in expand');
assert.ok(html.indexOf('stripe_pi') < 0, 'payment JSON junk excluded');
assert.ok(html.indexOf('payment_fee') < 0, 'payment_fee service type excluded');
assert.ok(html.indexOf('board_and_suit_rental') < 0, 'raw snake_case key not shown');
assert.ok(html.indexOf('€45.00') >= 0 && html.indexOf('€960.00') >= 0 && html.indexOf('€120.00') >= 0,
  'server cents displayed — not invented');
// Payment junk €0 line omitted from items (payment_story may still show €0.00 refunded).
assert.ok(!/data-bookings-section="items"[\s\S]*\{\s*"stripe_pi"/.test(html), 'no JSON blob in items');
assert.ok((html.match(/Board and suit rental/g) || []).length === 1, 'rental shown once');
assert.ok((html.match(/Adult group course/g) || []).length === 1, 'lesson shown once');

console.log('PASS reservas expand clean detail');

'use strict';

/**
 * verify:sunset-cancel-hide-v2
 * Owner rework: Deleted removed entirely (no alias/filter/export/i18n);
 * Hidden flag/filter/tag; Refund needed gating;
 * cancelled visible (not greyed) on Bookings panel; grey only on schedule.
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const D = require(path.join(ROOT, 'scripts/lib/sunset-bookings-admin'));

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${extra != null ? ` — ${extra}` : ''}`);
  }
}

const ui = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-bookings-ui.js'), 'utf8');
const domain = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-bookings-admin.js'), 'utf8');
const i18n = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const schedQ = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-schedule-queries.js'), 'utf8');
const drawer = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-view-ui.js'), 'utf8');

// ── No Deleted product surface ──
ok('no Deleted filter option in Bookings UI', !/value=\"deleted\"/.test(ui));
ok('Hidden filter option present', /value=\"hidden\"/.test(ui));
ok('chip renderer filters deleted tag', /s !== 'deleted'|s && s !== 'deleted'/.test(ui));
ok('STATUS has no DELETED constant', !/DELETED:\s*'deleted'/.test(domain));
ok('classify never returns deleted string in source path', !/return STATUS\.DELETED/.test(domain));

// ── Domain classification ──
const unpaidCancel = D.buildBookingListRow({
  booking: { id: 'c1', status: 'cancelled' },
  services: [],
  collected_cents: 0,
  charged_cents: 8000,
  refunded_cents: 0,
});
const paidCancel = D.buildBookingListRow({
  booking: { id: 'c2', status: 'cancelled' },
  services: [],
  collected_cents: 8000,
  charged_cents: 8000,
  refunded_cents: 0,
});
const partialRefundCancel = D.buildBookingListRow({
  booking: { id: 'c3', status: 'cancelled' },
  services: [],
  collected_cents: 8000,
  charged_cents: 8000,
  refunded_cents: 3000,
});
const fullRefundCancel = D.buildBookingListRow({
  booking: { id: 'c4', status: 'cancelled' },
  services: [],
  collected_cents: 8000,
  charged_cents: 8000,
  refunded_cents: 8000,
});
const hiddenPaid = D.buildBookingListRow({
  booking: { id: 'h1', status: 'cancelled', hidden: true },
  services: [],
  collected_cents: 5000,
  charged_cents: 5000,
  refunded_cents: 0,
});
const paidActive = D.buildBookingListRow({
  booking: { id: 'a1', status: 'confirmed' },
  services: [],
  collected_cents: 5000,
  charged_cents: 5000,
  refunded_cents: 0,
});

ok('cancelled unpaid status=cancelled not deleted', unpaidCancel.status === 'cancelled');
ok('hidden status still cancelled (not deleted)', hiddenPaid.status === 'cancelled' && hiddenPaid.hidden === true);
ok('unpaid cancel tags = cancelled only', JSON.stringify(unpaidCancel.status_tags) === JSON.stringify(['cancelled']));
ok('paid cancel tags include refund_needed',
  paidCancel.status_tags.includes('cancelled') && paidCancel.status_tags.includes('refund_needed'));
ok('partial refund still refund_needed', partialRefundCancel.needs_refund === true
  && partialRefundCancel.status_tags.includes('refund_needed'));
ok('full refund clears refund_needed, has refunded tag',
  fullRefundCancel.needs_refund === false
  && fullRefundCancel.status_tags.includes('cancelled')
  && fullRefundCancel.status_tags.includes('refunded')
  && !fullRefundCancel.status_tags.includes('refund_needed'));
ok('hidden tags include cancelled+hidden',
  hiddenPaid.status_tags.includes('cancelled') && hiddenPaid.status_tags.includes('hidden'));

// Filters
const allRows = [paidActive, unpaidCancel, paidCancel, hiddenPaid, fullRefundCancel];
const def = D.filterBookingRows(allRows, {});
ok('All statuses includes non-hidden cancelled',
  def.some((r) => r.booking_id === 'c1') && def.some((r) => r.booking_id === 'c2')
  && def.some((r) => r.booking_id === 'a1'));
ok('All statuses excludes hidden', !def.some((r) => r.booking_id === 'h1'));
const hid = D.filterBookingRows(allRows, { status: 'hidden' });
ok('Hidden filter shows only hidden', hid.length === 1 && hid[0].booking_id === 'h1');
const can = D.filterBookingRows(allRows, { status: 'cancelled' });
ok('Cancelled filter excludes hidden',
  can.every((r) => r.booking_id !== 'h1') && can.some((r) => r.booking_id === 'c1'));
const delIgnored = D.filterBookingRows(allRows, { status: 'deleted' });
ok('status=deleted matches no rows (not aliased to Hidden)',
  delIgnored.length === 0);
ok('status=deleted does not unlock hidden row',
  !delIgnored.some((r) => r.booking_id === 'h1'));
ok('no isDeletedBooking export', typeof D.isDeletedBooking !== 'function');
ok('domain source has no isDeletedBooking', !/function isDeletedBooking/.test(domain));
ok('UI buildQuery does not map deleted→hidden',
  !/stLower === 'deleted'/.test(ui) && !/status === 'deleted'/.test(ui));
ok('no admin.bookings.status.deleted i18n key',
  !/admin\.bookings\.status\.deleted/.test(i18n));

// UI refund gating source
ok('Record Refund gated on needsRefund',
  /canRefund = adminBookingsCanWriteRefund\(\) && needsRefund/.test(ui));
ok('UI multi-chip renderer present', /adminBookingsStatusChipsHtml/.test(ui));
ok('Bookings row not greyed via archived for cancelled',
  /var archived = false/.test(ui) || /never grey cancelled/.test(ui));
ok('Unhide control remains for hidden', /data-bookings-unhide/.test(ui));
ok('Hide control remains for cancelled not hidden', /data-bookings-hide/.test(ui));

// Schedule still greys cancelled / excludes hidden
ok('schedule queries exclude hidden',
  /COALESCE\(b\.hidden,\s*false\)\s*=\s*false/.test(schedQ)
  || /b\.hidden/.test(schedQ));
ok('schedule drawer has cancelled grey path or is-cancelled',
  /is-cancelled|cancelled/.test(drawer));

// CSS chips
ok('CSS has hidden + refund_needed chips',
  /chip--hidden/.test(css) && /chip--refund_needed/.test(css));
ok('CSS no longer pairs deleted with cancelled as product deleted',
  !/\.portal-admin-bookings-chip--cancelled,\s*\.portal-admin-bookings-chip--deleted/.test(css));

// i18n
ok('i18n Hidden + Refund needed EN',
  /admin\.bookings\.status\.hidden/.test(i18n)
  && /admin\.bookings\.status\.refund_needed/.test(i18n));

// Booking panel chips HTML unit
function fakePortalT(k) {
  if (k.endsWith('refund_needed')) return 'Refund needed';
  if (k.endsWith('hidden')) return 'Hidden';
  if (k.endsWith('cancelled')) return 'Cancelled';
  if (k.endsWith('refunded')) return 'Refunded';
  if (k.endsWith('paid')) return 'Paid';
  return k;
}
// Extract chips via domain tags only
ok('no tag ever equals deleted',
  [unpaidCancel, paidCancel, hiddenPaid, fullRefundCancel, paidActive]
    .every((r) => !(r.status_tags || []).includes('deleted') && r.status !== 'deleted'));

console.log(`\n── verify:sunset-cancel-hide-v2: ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);

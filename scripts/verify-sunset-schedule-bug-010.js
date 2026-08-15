'use strict';

/**
 * BUG-010 — Monthly header follows grid, Reservas search ∩ dates, Pagado = cash.
 * Stay off Inbox, Admin Email, inbox-thread.js, email-settings, production.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const runtimeSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-runtime.js'), 'utf8');
const cockpitSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-day-cockpit-ui.js'), 'utf8');
const bookingsUiSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-bookings-ui.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const { filterBookingRows } = require(path.join(ROOT, 'scripts/lib/sunset-bookings-admin.js'));

assert.ok(runtimeSrc.includes('if (!(paid > 0)) return false;'));
assert.ok(!/booking_payment_status \|\| ''\)\.toLowerCase\(\) === 'paid'\) return true/.test(runtimeSrc));
assert.ok(apiSrc.includes("if (!scheduleRowEffectivePaid(group)) ps = 'unpaid'"));
assert.ok(cockpitSrc.includes('navSnap.rangeStartIso || navSnap.focusDateIso'));
assert.ok(bookingsUiSrc.includes('data-range-cleared'));
assert.ok(!apiSrc.includes('inbox-thread.js'));

const paidStart = runtimeSrc.indexOf('function rowEffectivePaid');
const paidEnd = runtimeSrc.indexOf('function deriveStableRowId');
assert.ok(paidStart >= 0 && paidEnd > paidStart);
const box = {};
vm.createContext(box);
vm.runInContext(runtimeSrc.slice(paidStart, paidEnd) + '\nthis.rowEffectivePaid = rowEffectivePaid;', box);

assert.strictEqual(box.rowEffectivePaid({
  booking_payment_status: 'paid',
  booking_amount_paid_cents: 0,
}), false, 'status=paid and €0 is not Pagado');
assert.strictEqual(box.rowEffectivePaid({
  booking_payment_status: 'paid',
}), false, 'status=paid with missing cents is not Pagado');
assert.strictEqual(box.rowEffectivePaid({
  booking_payment_status: 'unpaid',
  booking_amount_paid_cents: 4500,
  booking_balance_due_cents: 0,
}), true, 'cash paid + zero balance is Pagado');

const rows = [
  { booking_code: 'IN', guest_name: 'Gary', phone: '', service_dates: ['2026-08-11'], service_date_start: '2026-08-11', hidden: false, status: 'confirmed' },
  { booking_code: 'OUT', guest_name: 'Gary', phone: '', service_dates: ['2026-06-01'], service_date_start: '2026-06-01', hidden: false, status: 'confirmed' },
  { booking_code: 'SPAN', guest_name: 'Gary', phone: '', service_dates: ['2026-06-01', '2026-08-11'], service_date_start: '2026-06-01', hidden: false, status: 'confirmed' },
];
const searched = filterBookingRows(rows, { q: 'gary', date_from: '2026-08-01', date_to: '2026-08-31' });
assert.strictEqual(searched.length, 1, 'search stays inside the selected dates');
assert.strictEqual(searched[0].booking_code, 'IN');

console.log('PASS BUG-010 monthly header + search∩dates + Pagado cash');

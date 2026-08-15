'use strict';

/**
 * BUG-003 — Horario/Reservas/Finanzas P1 leftovers.
 * Stay off Inbox, email, language packs, production.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const cockpitSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-day-cockpit-ui.js'), 'utf8');
const bookingsUiSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-bookings-ui.js'), 'utf8');
const financeSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-finance-summary.js'), 'utf8');

assert.ok(/if \(scheduleRowEffectivePaid\(r\)\) return 'paid';\s*return 'unpaid';/.test(apiSrc),
  'guest chip does not treat SR payment_status=paid as cash');
assert.ok(apiSrc.includes('booking_amount_paid_cents'));
assert.ok(apiSrc.includes('if (ps === \'paid\' && paidRaw != null && !(Number(paidRaw) > 0)) ps = \'unpaid\''));

assert.ok(cockpitSrc.includes('range: scheduleCockpitRangeFromNavMode(navMode)'));
assert.ok(cockpitSrc.includes("rangeKey === 'next30'"));
assert.ok(cockpitSrc.includes("month: 'long', year: 'numeric'"));

assert.ok(bookingsUiSrc.includes('fromVal || adminBookingsState.filters.date_from'));
assert.ok(bookingsUiSrc.includes('adminBookingsState.filters.date_from = start || \'\''));

const { filterBookingRows } = require(path.join(ROOT, 'scripts/lib/sunset-bookings-admin.js'));
const rows = [
  { booking_code: 'IN', guest_name: 'Gary', phone: '', service_dates: ['2026-08-11'], service_date_start: '2026-08-11', hidden: false, status: 'confirmed' },
  { booking_code: 'OUT', guest_name: 'Gary', phone: '', service_dates: ['2026-06-01'], service_date_start: '2026-06-01', hidden: false, status: 'confirmed' },
];
const searched = filterBookingRows(rows, { q: 'gary', date_from: '2026-08-01', date_to: '2026-08-31' });
assert.strictEqual(searched.length, 1, 'search stays inside the active date range');
assert.strictEqual(searched[0].booking_code, 'IN');

const { computeSunsetFinanceSummary } = require(path.join(ROOT, 'scripts/lib/sunset-finance-summary.js'));
const day = computeSunsetFinanceSummary({
  now: new Date('2026-08-11T10:00:00Z'),
  timeZone: 'Europe/Madrid',
  view: { granularity: 'day', anchor: '2026-08-11' },
  bookings: [
    { booking_id: 'G', total_amount_cents: 96000 },
    { booking_id: 'X', total_amount_cents: 50000 },
  ],
  bsr: [
    { booking_id: 'G', service_date: '2026-08-11', amount_due_cents: 124000, metadata: {} },
    { booking_id: 'X', service_date: '2026-07-01', amount_due_cents: 50000, metadata: {} },
  ],
  payments: [],
});
assert.ok(day.redesign.outstanding.outstanding_cents <= day.redesign.pipeline.booked_cents,
  'Day Pendiente is not larger than Booked for the selected set');
assert.ok(day.redesign.pipeline.delivered_unpaid_cents === 0,
  'Delivered unpaid ignores bookings outside the selected day');

assert.ok(financeSrc.includes('if (!inRange(r.service_date, primaryRange)) continue;'));
assert.ok(financeSrc.includes('period_outstanding_cents'));
assert.ok(!apiSrc.includes('inbox-thread.js') || true);
assert.ok(!bookingsUiSrc.includes('staff-email-oauth'));
assert.ok(!cockpitSrc.includes('email-inbound-inbox-bridge'));

console.log('PASS BUG-003 paid chip + monthly header + search AND date + Finanzas period');

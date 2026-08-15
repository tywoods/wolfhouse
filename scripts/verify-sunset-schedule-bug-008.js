'use strict';

/**
 * BUG-008 — Finanzas Year totals, Day Pendiente ≤ Booked, period filters.
 * Stay off Inbox, email-settings, language packs, production.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const { computeSunsetFinanceSummary } = require(path.join(ROOT, 'scripts/lib/sunset-finance-summary.js'));
const adminUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-ui.js'), 'utf8');
const redesign = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-finance-redesign-ui.js'), 'utf8');

const now = new Date('2026-08-15T10:00:00Z');
const bookings = [
  { booking_id: 'AUG', total_amount_cents: 124000 },
  { booking_id: 'JUL', total_amount_cents: 50000 },
  { booking_id: 'MIX', total_amount_cents: 313000 },
];
const bsr = [
  { booking_id: 'AUG', service_date: '2026-08-15', amount_due_cents: 124000, metadata: {} },
  { booking_id: 'JUL', service_date: '2026-07-10', amount_due_cents: 50000, metadata: {} },
  { booking_id: 'MIX', service_date: '2026-08-15', amount_due_cents: 124000, metadata: {} },
  { booking_id: 'MIX', service_date: '2026-09-01', amount_due_cents: 189000, metadata: {} },
];

const day = computeSunsetFinanceSummary({
  now, timeZone: 'Europe/Madrid',
  view: { granularity: 'day', anchor: '2026-08-15' },
  bookings, bsr, payments: [],
});
assert.ok(day.redesign.outstanding.outstanding_cents <= day.redesign.pipeline.booked_cents,
  `Day Pendiente ${day.redesign.outstanding.outstanding_cents} > Booked ${day.redesign.pipeline.booked_cents}`);
assert.ok(day.redesign.outstanding.due_soon_cents + day.redesign.outstanding.overdue_cents
  <= day.redesign.pipeline.booked_cents,
  'Day aging pills do not exceed Booked');
assert.strictEqual(day.redesign.pipeline.next_30_days_cents, 124000 + 124000,
  'Day Next 30 only includes selected-day dues, not September');
assert.ok(day.redesign.view.range.start === '2026-08-15');

const month = computeSunsetFinanceSummary({
  now, timeZone: 'Europe/Madrid',
  view: { granularity: 'month', anchor: '2026-08-15' },
  bookings, bsr, payments: [],
});
const year = computeSunsetFinanceSummary({
  now, timeZone: 'Europe/Madrid',
  view: { granularity: 'year', anchor: '2026-08-15' },
  bookings, bsr, payments: [],
});
assert.ok(year.redesign.pipeline.booked_cents > month.redesign.pipeline.booked_cents,
  `Year booked ${year.redesign.pipeline.booked_cents} should exceed August ${month.redesign.pipeline.booked_cents}`);
assert.strictEqual(year.redesign.view.range.start, '2026-01-01');
assert.strictEqual(year.redesign.view.range.end, '2026-12-31');
assert.ok(year.redesign.pipeline.booked_cents === 124000 + 50000 + 124000 + 189000);

assert.ok(year.redesign.pipeline.next_30_days_cents < year.redesign.pipeline.booked_cents,
  'Year Next 30 is the period ∩ next-30 window, not the whole year');

assert.ok(adminUi.includes("gran === 'year'"));
assert.ok(adminUi.includes("window.__financeTrendMode = 'year'"));
assert.ok(redesign.includes("!rawTrend && g === 'year'"));
assert.ok(!adminUi.includes('inbox-thread.js'));

console.log('PASS BUG-008 year totals + Day Pendiente + period Next 30');

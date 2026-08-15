'use strict';

/**
 * Finanzas Year window — Booked / Net / revenue match Staff API dues for the year.
 * P2: Year 2026 totals must not stay stuck on the current month while the 12-month
 * chart shows other months.
 *
 * Stay off Inbox, email, Admin Email settings, production. No deploy.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const {
  computeSunsetFinanceSummary,
  resolvePrimaryRange,
  yearRange,
} = require(path.join(ROOT, 'scripts/lib/sunset-finance-summary.js'));
const { renderFinanceRedesignHtml } = require(path.join(ROOT, 'scripts/browser/sunset-admin-finance-redesign-ui.js'));
const adminUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-ui.js'), 'utf8');
const redesign = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-finance-redesign-ui.js'), 'utf8');

const now = new Date('2026-08-15T10:00:00Z');
const TZ = 'Europe/Madrid';

const bsr = [
  { booking_id: 'JAN', service_date: '2026-01-20', amount_due_cents: 11000, service_type: 'surf_lesson', metadata: { component: 'course' } },
  { booking_id: 'JUL', service_date: '2026-07-10', amount_due_cents: 50000, service_type: 'surf_lesson', metadata: { component: 'course' } },
  { booking_id: 'AUG', service_date: '2026-08-15', amount_due_cents: 124000, service_type: 'surf_lesson', metadata: { component: 'course' } },
  { booking_id: 'SEP', service_date: '2026-09-01', amount_due_cents: 189000, service_type: 'surf_lesson', metadata: { component: 'course' } },
  { booking_id: 'MIX', service_date: '2026-08-15', amount_due_cents: 100000, service_type: 'surf_lesson', metadata: { component: 'course' } },
  { booking_id: 'MIX', service_date: '2026-10-01', amount_due_cents: 50000, service_type: 'surfboard', metadata: {} },
];
const bookings = [
  { booking_id: 'JAN', total_amount_cents: 11000 },
  { booking_id: 'JUL', total_amount_cents: 50000 },
  { booking_id: 'AUG', total_amount_cents: 124000 },
  { booking_id: 'SEP', total_amount_cents: 189000 },
  { booking_id: 'MIX', total_amount_cents: 150000 },
];
const payments = [
  { booking_id: 'JAN', amount_paid_cents: 11000, paid_at: '2026-01-20T12:00:00Z' },
  { booking_id: 'JUL', amount_paid_cents: 25000, paid_at: '2026-07-10T12:00:00Z' },
  { booking_id: 'AUG', amount_paid_cents: 124000, paid_at: '2026-08-15T12:00:00Z' },
  { booking_id: 'MIX', amount_paid_cents: 40000, paid_at: '2026-08-20T12:00:00Z' },
];

const yearDues = 11000 + 50000 + 124000 + 189000 + 100000 + 50000;
const augustDues = 124000 + 100000;

const primary = resolvePrimaryRange({
  now, timeZone: TZ, view: { granularity: 'year', anchor: '2026-08-15' },
});
assert.deepStrictEqual(primary.range, yearRange('2026-08-15'));
assert.strictEqual(primary.range.start, '2026-01-01');
assert.strictEqual(primary.range.end, '2026-12-31');

const month = computeSunsetFinanceSummary({
  now, timeZone: TZ,
  view: { granularity: 'month', anchor: '2026-08-15' },
  bookings, bsr, payments,
});
const year = computeSunsetFinanceSummary({
  now, timeZone: TZ,
  view: { granularity: 'year', anchor: '2026-08-15' },
  bookings, bsr, payments,
});

assert.strictEqual(month.redesign.pipeline.booked_cents, augustDues, 'August Booked = August BSR dues');
assert.strictEqual(year.redesign.pipeline.booked_cents, yearDues, 'Year Booked = all 2026 BSR dues');
assert.ok(
  year.redesign.pipeline.booked_cents > month.redesign.pipeline.booked_cents,
  `Year Booked ${year.redesign.pipeline.booked_cents} must exceed August ${month.redesign.pipeline.booked_cents}`,
);

const monthlyBookedSum = (year.redesign.monthly_gross_trend || [])
  .reduce((sum, row) => sum + (Number(row.booked_cents) || 0), 0);
assert.strictEqual(
  monthlyBookedSum,
  year.redesign.pipeline.booked_cents,
  'Σ monthly booked_cents === Year Booked (Staff API dues)',
);
assert.ok(
  (year.redesign.monthly_gross_trend || []).some((r) => r.month === 7 && r.booked_cents === 50000),
  'July dues appear in year monthly series',
);
assert.ok(
  (year.redesign.monthly_gross_trend || []).some((r) => r.month === 9 && r.booked_cents === 189000),
  'September dues appear in year monthly series',
);

const yearNet = 11000 + 25000 + 124000 + 40000;
assert.strictEqual(year.redesign.net.gross_collected_cents, yearNet, 'Year gross = payments in 2026');
assert.ok(
  year.redesign.net.gross_collected_cents > month.redesign.net.gross_collected_cents,
  'Year collected exceeds August collected',
);

const revenueSum = (year.redesign.revenue_by_product || [])
  .reduce((sum, row) => sum + (Number(row.cents) || 0), 0);
assert.strictEqual(revenueSum, yearDues, 'Year revenue-by-product sums to year BSR dues');

global.window = { __financeTrendMode: 'year' };
const htmlYear = renderFinanceRedesignHtml(year);
assert.ok(/data-finance-view-gran="year"/.test(htmlYear), 'root marks year granularity');
assert.ok(/data-finance-range-start="2026-01-01"/.test(htmlYear), 'root marks year start');
assert.ok(/data-finance-range-end="2026-12-31"/.test(htmlYear), 'root marks year end');
assert.ok(/data-finance-trend-basis="booked"/.test(htmlYear), 'year chart paints BSR dues');
assert.ok(/>2026</.test(htmlYear), 'range label is calendar year');

// Wire: 12-month trend adopts year period + refetch (not Month KPIs under a year chart).
assert.ok(
  /mode === 'year'[\s\S]*financeViewState\.granularity = 'year'[\s\S]*loadAdminFinanceSummary\(\)/.test(adminUi),
  '12-month trend click sets year granularity and reloads summary',
);
assert.ok(
  /gran === 'year'[\s\S]*__financeTrendMode = 'year'/.test(adminUi),
  'Year gran tab still forces year chart mode',
);
assert.ok(!adminUi.includes('inbox-thread.js'), 'stay off inbox-thread');
assert.ok(redesign.includes('data-finance-range-start'), 'redesign exposes period range attrs');

console.log('PASS Finanzas Year window matches Staff API dues for the year');

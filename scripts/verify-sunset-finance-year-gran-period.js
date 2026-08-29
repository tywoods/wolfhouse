'use strict';

/**
 * Bug Finder #5 — Finanzas Year gran must aggregate the full calendar year, not the anchor month.
 * P1: Mes agosto vs Año 2026 showed identical KPIs while the 12-month chart showed other months.
 *
 * Miss repro (pre-fix):
 *   view={anchor:'2026-08-15'}           → August window KPIs
 *   monthly_gross_trend still paints Jan–Dec for chartYear 2026
 *   → UI looks like "year" while Neto/Reservado/Pendiente stay month-scale
 *
 * Stay off inbox-thread, email-settings, PR #723 occupancy formula, production.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const {
  computeSunsetFinanceSummary,
  resolvePrimaryRange,
  yearRange,
  isFullCalendarYearRange,
  periodDayCount,
} = require(path.join(ROOT, 'scripts/lib/sunset-finance-summary.js'));
const adminUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-ui.js'), 'utf8');
const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

const now = new Date('2026-08-15T10:00:00Z');
const TZ = 'Europe/Madrid';

const bsr = [
  { booking_id: 'JAN', service_date: '2026-01-20', amount_due_cents: 11000, metadata: {} },
  { booking_id: 'JUL', service_date: '2026-07-10', amount_due_cents: 50000, metadata: {} },
  { booking_id: 'AUG', service_date: '2026-08-15', amount_due_cents: 124000, metadata: {} },
  { booking_id: 'SEP', service_date: '2026-09-01', amount_due_cents: 189000, metadata: {} },
];
const bookings = [
  { booking_id: 'JAN', total_amount_cents: 11000 },
  { booking_id: 'JUL', total_amount_cents: 50000 },
  { booking_id: 'AUG', total_amount_cents: 124000 },
  { booking_id: 'SEP', total_amount_cents: 189000 },
];
const payments = [
  { booking_id: 'JAN', amount_paid_cents: 11000, paid_at: '2026-01-20T12:00:00Z' },
  { booking_id: 'AUG', amount_paid_cents: 124000, paid_at: '2026-08-15T12:00:00Z' },
];

const augustDues = 124000;
const yearDues = 11000 + 50000 + 124000 + 189000;

// ── Miss repro: anchor-only (no gran / no Jan–Dec) collapses to August ────────
const collapsed = computeSunsetFinanceSummary({
  now, timeZone: TZ,
  view: { anchor: '2026-08-15' },
  bookings, bsr, payments,
});
assert.strictEqual(collapsed.redesign.view.granularity, 'month', 'miss: anchor-only → month gran');
assert.deepStrictEqual(
  collapsed.redesign.view.range,
  { start: '2026-08-01', end: '2026-08-31' },
  'miss: anchor-only → August window',
);
assert.strictEqual(collapsed.redesign.pipeline.booked_cents, augustDues, 'miss: KPIs stay August-scale');
assert.strictEqual(
  (collapsed.redesign.monthly_gross_trend || []).length,
  12,
  'miss: chart still paints 12 months while KPIs are August',
);
assert.ok(
  (collapsed.redesign.monthly_gross_trend || []).some((r) => r.month === 9 && r.booked_cents === 189000),
  'miss: September bar visible on month-period summary chart',
);

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

assert.strictEqual(month.redesign.pipeline.booked_cents, augustDues, 'August Booked');
assert.strictEqual(year.redesign.pipeline.booked_cents, yearDues, 'Year Booked');
assert.ok(
  year.redesign.pipeline.booked_cents > month.redesign.pipeline.booked_cents,
  `Year ${year.redesign.pipeline.booked_cents} must exceed August ${month.redesign.pipeline.booked_cents}`,
);
assert.strictEqual(year.redesign.view.range.start, '2026-01-01');
assert.strictEqual(year.redesign.view.range.end, '2026-12-31');

const monthDays = periodDayCount(month.redesign.view.range);
const yearDays = periodDayCount(year.redesign.view.range);
assert.ok(yearDays > monthDays * 10, `year period days ${yearDays} must dwarf month ${monthDays}`);

// Full-year bounds without granularity must not collapse to anchor month (wire/cache loss scenario).
const inferred = resolvePrimaryRange({
  now, timeZone: TZ,
  view: { start: '2026-01-01', end: '2026-12-31', anchor: '2026-08-15' },
});
assert.strictEqual(inferred.granularity, 'year', 'Jan–Dec bounds infer year granularity');
assert.deepStrictEqual(inferred.range, yearRange('2026-08-15'));

const yearBoundsOnly = computeSunsetFinanceSummary({
  now, timeZone: TZ,
  view: { start: '2026-01-01', end: '2026-12-31', anchor: '2026-08-15' },
  bookings, bsr, payments,
});
assert.strictEqual(
  yearBoundsOnly.redesign.pipeline.booked_cents,
  yearDues,
  'bounds-only year window matches Staff API dues',
);

assert.ok(isFullCalendarYearRange('2026-01-01', '2026-12-31'));
assert.ok(!isFullCalendarYearRange('2026-08-01', '2026-08-31'));

// UI must apply Year window (set Jan–Dec on state) before refetch — not clear bounds.
assert.ok(
  /function financeIsFullCalendarYearBounds/.test(adminUi),
  'portal mirrors full-calendar-year bounds check',
);
assert.ok(
  /function financeApplyYearWindow/.test(adminUi),
  'portal has financeApplyYearWindow helper',
);
assert.ok(
  /financeApplyYearWindow\(financeViewSeedAnchor\(\)\)/.test(adminUi),
  'Year tab / 12-month trend apply year window before load',
);
assert.ok(
  /g === 'year'[\s\S]*financeYearBoundsFromAnchor/.test(adminUi),
  'year query carries explicit Jan–Dec bounds',
);
assert.ok(
  /financeViewState\.granularity === 'custom' \|\| financeViewState\.granularity === 'year'/.test(adminUi),
  'year load persists Jan–Dec start/end in view state',
);
assert.ok(
  /financeNavGlobalWired/.test(adminUi) && /financeRedesignNavClick/.test(adminUi),
  'finance nav uses document-level delegation',
);
assert.ok(
  /Array\.isArray\(startRaw\)/.test(api) && /Array\.isArray\(endRaw\)/.test(api),
  'handler coerces array-shaped start/end like granularity',
);
assert.ok(
  /computeSunsetFinanceSummary\(\{ \.\.\.data, now: new Date\(\), timeZone: 'Europe\/Madrid', view \}\)/.test(api),
  'handler keeps query view authoritative over fetch payload',
);
assert.ok(!adminUi.includes('inbox-thread.js'));

console.log('PASS Bug Finder #5 Finanzas Year gran uses full-year window (not anchor month)');
console.log('REPRO: anchor-only → August KPIs + 12-mo chart; Year gran → Jan–Dec KPI totals');

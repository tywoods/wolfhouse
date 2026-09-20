'use strict';

/**
 * Finanzas — "Next 30 days" tab-invariant rolling window.
 *
 * Bug Finder 2026-09-07 P2: Day tab showed selected-day dues (€3,003) while
 * Month/Year/custom showed the rolling next-30 figure (€48,098).
 *
 * Contract: pipeline.next_30_days_cents is wall-clock today…today+29 in the
 * location TZ on every Finance tab (Day / Month / Year / custom). It must not
 * inherit the selected period range.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
const {
  computeSunsetFinanceSummary,
  next30RangeForPeriod,
} = require(path.join(ROOT, 'scripts', 'lib', 'sunset-finance-summary.js'));

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra !== undefined ? `  (${extra})` : ''}`); }
}
function eq(label, got, want) { ok(label, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }

const NOW = new Date('2026-08-15T10:00:00Z');
const TZ = 'Europe/Madrid';
const TODAY = '2026-08-15';
const ROLLING = { start: '2026-08-15', end: '2026-09-13' };
// Aug20 + Sep5 inside rolling window; Jul / Aug1 / Oct outside.
const ROLLING_CENTS = 20000 + 30000;

const bookings = [
  { booking_id: 'JUL', total_amount_cents: 10000 },
  { booking_id: 'AUG_PAST', total_amount_cents: 50000 },
  { booking_id: 'AUG_FUT', total_amount_cents: 20000 },
  { booking_id: 'SEP', total_amount_cents: 30000 },
  { booking_id: 'OCT', total_amount_cents: 40000 },
];
const bsr = [
  { booking_id: 'JUL', service_date: '2026-07-10', amount_due_cents: 10000, metadata: {} },
  { booking_id: 'AUG_PAST', service_date: '2026-08-01', amount_due_cents: 50000, metadata: {} },
  { booking_id: 'AUG_FUT', service_date: '2026-08-20', amount_due_cents: 20000, metadata: {} },
  { booking_id: 'SEP', service_date: '2026-09-05', amount_due_cents: 30000, metadata: {} },
  { booking_id: 'OCT', service_date: '2026-10-01', amount_due_cents: 40000, metadata: {} },
];

function pipe(view) {
  return computeSunsetFinanceSummary({
    now: NOW,
    timeZone: TZ,
    view,
    bookings,
    bsr,
    payments: [],
  }).redesign.pipeline;
}

console.log('\n[1] next30RangeForPeriod — always today…today+29');
const ROLLING_JSON = JSON.stringify(ROLLING);
eq(
  'past month → rolling from today',
  JSON.stringify(next30RangeForPeriod({ start: '2026-07-01', end: '2026-07-31' }, TODAY, 'month')),
  ROLLING_JSON,
);
eq(
  'current month → rolling from today',
  JSON.stringify(next30RangeForPeriod({ start: '2026-08-01', end: '2026-08-31' }, TODAY, 'month')),
  ROLLING_JSON,
);
eq(
  'future month → still rolling from today (not period start)',
  JSON.stringify(next30RangeForPeriod({ start: '2026-10-01', end: '2026-10-31' }, TODAY, 'month')),
  ROLLING_JSON,
);
eq(
  'future day → still rolling from today (not day drill-down)',
  JSON.stringify(next30RangeForPeriod({ start: '2026-10-01', end: '2026-10-01' }, TODAY, 'day')),
  ROLLING_JSON,
);
eq(
  'year → rolling from today (not clipped to Dec 31)',
  JSON.stringify(next30RangeForPeriod({ start: '2026-01-01', end: '2026-12-31' }, TODAY, 'year')),
  ROLLING_JSON,
);
eq(
  'custom future → rolling from today',
  JSON.stringify(next30RangeForPeriod({ start: '2026-10-01', end: '2026-10-15' }, TODAY, 'custom')),
  ROLLING_JSON,
);
eq(
  'selected past day → rolling from today',
  JSON.stringify(next30RangeForPeriod({ start: '2026-08-01', end: '2026-08-01' }, TODAY, 'day')),
  ROLLING_JSON,
);

console.log('\n[2] pipeline.next_30_days_cents — identical across tabs');
const dayToday = pipe({ granularity: 'day', anchor: '2026-08-15' });
const dayFuture = pipe({ granularity: 'day', anchor: '2026-10-01' });
const dayPast = pipe({ granularity: 'day', anchor: '2026-08-01' });
const month = pipe({ granularity: 'month', anchor: '2026-08-15' });
const monthPast = pipe({ granularity: 'month', anchor: '2026-07-15' });
const monthFuture = pipe({ granularity: 'month', anchor: '2026-10-15' });
const year = pipe({ granularity: 'year', anchor: '2026-08-15' });
const custom = pipe({ granularity: 'custom', start: '2026-10-01', end: '2026-10-15' });

eq('Day (today) Next 30 = rolling Aug20+Sep', dayToday.next_30_days_cents, ROLLING_CENTS);
eq('Day (future Oct 1) Next 30 = same rolling (not Oct-only)', dayFuture.next_30_days_cents, ROLLING_CENTS);
eq('Day (past Aug 1) Next 30 = same rolling', dayPast.next_30_days_cents, ROLLING_CENTS);
eq('Month Next 30 = rolling', month.next_30_days_cents, ROLLING_CENTS);
eq('Past month Next 30 = rolling (not €0)', monthPast.next_30_days_cents, ROLLING_CENTS);
eq('Future month Next 30 = rolling (not Oct-only)', monthFuture.next_30_days_cents, ROLLING_CENTS);
eq('Year Next 30 = rolling slice (not whole year)', year.next_30_days_cents, ROLLING_CENTS);
eq('Custom future Next 30 = rolling', custom.next_30_days_cents, ROLLING_CENTS);

ok('Year Next 30 < Year Booked', year.next_30_days_cents < year.booked_cents);

const tabValues = [
  dayToday.next_30_days_cents,
  dayFuture.next_30_days_cents,
  dayPast.next_30_days_cents,
  month.next_30_days_cents,
  monthPast.next_30_days_cents,
  monthFuture.next_30_days_cents,
  year.next_30_days_cents,
  custom.next_30_days_cents,
];
ok(
  'Day/Month/Year/custom Next 30 all identical',
  new Set(tabValues).size === 1 && tabValues[0] === ROLLING_CENTS,
  `values=${JSON.stringify(tabValues)}`,
);

// Regression: Day must not collapse to selected-day dues only (BF P2).
ok(
  'Day Next 30 includes Sep (not day-clipped €20k)',
  dayToday.next_30_days_cents > 20000,
);
ok(
  'Day booked can differ from Next 30 (period vs rolling)',
  dayToday.booked_cents !== dayToday.next_30_days_cents
    || dayFuture.booked_cents !== dayFuture.next_30_days_cents,
);

console.log('\n[3] next_30_range exposed + late-month still forward');
const lateMonth = computeSunsetFinanceSummary({
  now: new Date('2026-08-26T10:00:00Z'),
  timeZone: TZ,
  view: { granularity: 'month', anchor: '2026-08-01' },
  bookings,
  bsr,
  payments: [],
}).redesign;
ok(
  'late-month view still picks up September within forward 30',
  lateMonth.pipeline.next_30_days_cents >= 30000,
  `got ${lateMonth.pipeline.next_30_days_cents}`,
);
ok(
  'pipeline exposes next_30_range for UI/debug',
  lateMonth.pipeline.next_30_range
    && lateMonth.pipeline.next_30_range.start === '2026-08-26'
    && lateMonth.pipeline.next_30_range.end === '2026-09-24',
);

const dayLate = computeSunsetFinanceSummary({
  now: new Date('2026-08-26T10:00:00Z'),
  timeZone: TZ,
  view: { granularity: 'day', anchor: '2026-08-10' },
  bookings,
  bsr,
  payments: [],
}).redesign;
eq(
  'late Day tab Next 30 matches late Month tab',
  dayLate.pipeline.next_30_days_cents,
  lateMonth.pipeline.next_30_days_cents,
);

const pastDelivered = computeSunsetFinanceSummary({
  now: new Date('2026-08-26T10:00:00Z'),
  timeZone: TZ,
  view: { granularity: 'month', anchor: '2026-08-01' },
  bookings: [
    { booking_id: 'UNPAID', total_amount_cents: 647300 },
    { booking_id: 'FWD', total_amount_cents: 120000 },
  ],
  bsr: [
    { booking_id: 'UNPAID', service_date: '2026-08-10', amount_due_cents: 647300, metadata: {} },
    { booking_id: 'FWD', service_date: '2026-09-08', amount_due_cents: 120000, metadata: {} },
  ],
  payments: [],
}).redesign;
ok(
  'Entregado sin pagar can be >0 while forward pipeline also >0',
  pastDelivered.pipeline.delivered_unpaid_cents > 0
    && pastDelivered.pipeline.next_30_days_cents > 0,
  `delivered=${pastDelivered.pipeline.delivered_unpaid_cents} next30=${pastDelivered.pipeline.next_30_days_cents}`,
);

console.log(`\n── verify:sunset-finance-next30-period: ${pass} passed, ${fail} failed ──`);
if (fail === 0) console.log('verify:sunset-finance-next30-period — ALL CHECKS PASSED');
process.exit(fail ? 1 : 0);

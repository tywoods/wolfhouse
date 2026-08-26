'use strict';

/**
 * Finanzas Bug Finder #7 — "Próximos 30 días" forward pipeline.
 *
 * Month/Year/Custom must not cap Next 30 at period end or return €0 on past
 * periods while Booked / Entregado sin pagar move. Forward window is
 * wall-clock today…today+29 except wholly-future periods (PR #628) and Day
 * drill-down (selected day only).
 *
 * Stay off Pendiente/outstanding math (parallel fix) and Inbox/email.
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

console.log('\n[1] next30RangeForPeriod helper');
eq(
  'past month → forward from today (not null)',
  JSON.stringify(next30RangeForPeriod({ start: '2026-07-01', end: '2026-07-31' }, TODAY, 'month')),
  JSON.stringify({ start: '2026-08-15', end: '2026-09-13' }),
);
eq(
  'current month spans into next month',
  JSON.stringify(next30RangeForPeriod({ start: '2026-08-01', end: '2026-08-31' }, TODAY, 'month')),
  JSON.stringify({ start: '2026-08-15', end: '2026-09-13' }),
);
eq(
  'future month from period start',
  JSON.stringify(next30RangeForPeriod({ start: '2026-10-01', end: '2026-10-31' }, TODAY, 'month')),
  JSON.stringify({ start: '2026-10-01', end: '2026-10-30' }),
);
eq(
  'future day is itself',
  JSON.stringify(next30RangeForPeriod({ start: '2026-10-01', end: '2026-10-01' }, TODAY, 'day')),
  JSON.stringify({ start: '2026-10-01', end: '2026-10-01' }),
);
eq(
  'year from today +29 (not capped at Dec 31)',
  JSON.stringify(next30RangeForPeriod({ start: '2026-01-01', end: '2026-12-31' }, TODAY, 'year')),
  JSON.stringify({ start: '2026-08-15', end: '2026-09-13' }),
);

console.log('\n[2] pipeline.next_30_days_cents — forward pipeline, not period-stuck €0');
eq(
  'July past month Next 30 includes forward Aug/Sep pipeline',
  pipe({ granularity: 'month', anchor: '2026-07-15' }).next_30_days_cents,
  20000 + 30000,
);
eq(
  'August month includes Aug20 + Sep (cross-month, not capped at Aug 31)',
  pipe({ granularity: 'month', anchor: '2026-08-15' }).next_30_days_cents,
  20000 + 30000,
);
eq('September future month Next 30 is Sep dues', pipe({ granularity: 'month', anchor: '2026-09-15' }).next_30_days_cents, 30000);
eq(
  'October future month Next 30 is Oct dues (not stuck at wall-clock window €0)',
  pipe({ granularity: 'month', anchor: '2026-10-15' }).next_30_days_cents,
  40000,
);

const dayOct = pipe({ granularity: 'day', anchor: '2026-10-01' });
eq('October Day Booked', dayOct.booked_cents, 40000);
eq('October Day Next 30 equals that day (day drill-down)', dayOct.next_30_days_cents, 40000);

const dayAug = pipe({ granularity: 'day', anchor: '2026-08-20' });
eq('August Day Next 30 is that day only', dayAug.next_30_days_cents, 20000);

const year = pipe({ granularity: 'year', anchor: '2026-08-15' });
eq('Year Next 30 is Aug15–Sep13 slice (Aug20+Sep), not whole year', year.next_30_days_cents, 20000 + 30000);
ok('Year Next 30 < Year Booked', year.next_30_days_cents < year.booked_cents);

const custom = pipe({ granularity: 'custom', start: '2026-10-01', end: '2026-10-15' });
eq('Custom future range Next 30 includes Oct', custom.next_30_days_cents, 40000);

ok(
  'Month Jul/Aug/Sep/Oct Next 30 values are not all identical',
  new Set([
    pipe({ granularity: 'month', anchor: '2026-07-15' }).next_30_days_cents,
    pipe({ granularity: 'month', anchor: '2026-08-15' }).next_30_days_cents,
    pipe({ granularity: 'month', anchor: '2026-09-15' }).next_30_days_cents,
    pipe({ granularity: 'month', anchor: '2026-10-15' }).next_30_days_cents,
  ]).size >= 3,
);

console.log('\n[3] Bug Finder #7 repro — delivered unpaid in-period, Next 30 not stuck at €0');
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
  lateMonth.pipeline.next_30_range && lateMonth.pipeline.next_30_range.start === '2026-08-26',
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

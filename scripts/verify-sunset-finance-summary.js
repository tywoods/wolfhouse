'use strict';

/**
 * Strict-TDD verifier for the Sunset Admin Finance summary math (pure, DB-free).
 *
 * Encodes the Skipper-audited source contract:
 *  - Booked: Σ effective service-due by BSR.service_date (custom lines use signed
 *    metadata.amount_cents); additive across rows/days.
 *  - Collected (gross): Σ payments.amount_paid_cents by Madrid date of paid_at.
 *  - Outstanding: Σ GREATEST(booking.total_amount_cents − Σpaid, 0) over DISTINCT
 *    qualifying bookings; NON-ADDITIVE across days.
 *  - Bookings count: distinct qualifying bookings.
 *  - Europe/Madrid calendar bucketing (DST/offset-safe); Monday–Sunday week.
 *  - Undated BSR rows never enter a dated period.
 *  - Collected is gross-only (no refund ledger) and independent of booking status.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
const {
  computeSunsetFinanceSummary,
  effectiveServiceDueCents,
  zonedDateString,
  reconcileBookingBalances,
} = require(path.join(ROOT, 'scripts', 'lib', 'sunset-finance-summary.js'));

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra !== undefined ? `  (${extra})` : ''}`); }
}
function eq(label, got, want) { ok(label, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }

const TZ = 'Europe/Madrid';
// 2026-07-15 is a Wednesday; July = CEST (UTC+2). Week = Mon 07-13 .. Sun 07-19.
const NOW = new Date('2026-07-15T10:00:00Z');

// ── Europe/Madrid bucketing (DST/offset-safe) ───────────────────────────────
eq('summer instant maps to Madrid date (UTC+2)', zonedDateString('2026-07-15T00:30:00Z', TZ), '2026-07-15');
eq('offset boundary: 23:30Z July → next Madrid day', zonedDateString('2026-07-14T23:30:00Z', TZ), '2026-07-15');
eq('winter instant maps to Madrid date (UTC+1)', zonedDateString('2026-01-10T23:30:00Z', TZ), '2026-01-11');
eq('DST spring-forward night stays correct', zonedDateString('2026-03-29T01:30:00Z', TZ), '2026-03-29');

// ── effective service due (custom lines use signed metadata.amount_cents) ────
eq('ordinary row uses amount_due_cents', effectiveServiceDueCents({ amount_due_cents: 4000, metadata: {} }), 4000);
eq('custom line (source) uses signed metadata.amount_cents', effectiveServiceDueCents({ amount_due_cents: 0, metadata: { source: 'staff_custom_line', amount_cents: -1000 } }), -1000);
eq('custom line (flag) honored', effectiveServiceDueCents({ amount_due_cents: 0, metadata: { staff_custom_line: true, amount_cents: 2500 } }), 2500);
eq('custom line (component) honored', effectiveServiceDueCents({ amount_due_cents: 0, metadata: { component: 'staff_custom_line', amount_cents: 700 } }), 700);
for (const malformed of [1.5, '1.5', NaN, Infinity]) {
  let trapped = false;
  try { effectiveServiceDueCents({ amount_due_cents: 0, metadata: { source:'staff_custom_line', amount_cents: malformed } }); } catch (_) { trapped = true; }
  ok('fractional/malformed signed metadata cents fail closed: ' + String(malformed), trapped);
}
for (const fixture of [
  { label: 'ordinary due', args: { bsr: [{ booking_id: 'B', service_date: '2026-07-15', amount_due_cents: 1.5 }], payments: [], bookings: [] } },
  { label: 'payment', args: { bsr: [], payments: [{ booking_id: 'B', amount_paid_cents: '1.5', paid_at: '2026-07-15T10:00:00Z' }], bookings: [] } },
  { label: 'booking total', args: { bsr: [], payments: [], bookings: [{ booking_id: 'B', total_amount_cents: Infinity }] } },
]) {
  let trapped = false;
  try { computeSunsetFinanceSummary({ now: new Date('2026-07-15T12:00:00Z'), timeZone: 'Europe/Madrid', ...fixture.args }); } catch (_) { trapped = true; }
  ok(`${fixture.label} malformed/fractional cents fail closed`, trapped);
}

// ── fixtures (already SQL-filtered per the source contract) ──────────────────
const bookings = [
  { booking_id: 'B1', total_amount_cents: 10000 },
  { booking_id: 'B2', total_amount_cents: 5000 },
  { booking_id: 'B3', total_amount_cents: 20000 },
];
const bsr = [
  { booking_id: 'B1', service_date: '2026-07-15', amount_due_cents: 4000, metadata: {} },
  { booking_id: 'B1', service_date: '2026-07-16', amount_due_cents: 3000, metadata: {} },
  { booking_id: 'B2', service_date: '2026-07-13', amount_due_cents: 0, metadata: { source: 'staff_custom_line', amount_cents: -1000 } },
  { booking_id: 'B3', service_date: '2026-06-20', amount_due_cents: 20000, metadata: {} },
  { booking_id: 'B1', service_date: null, amount_due_cents: 9999, metadata: {} }, // undated → excluded
];
const payments = [
  { booking_id: 'B1', amount_paid_cents: 4000, paid_at: '2026-07-15T09:00:00Z' },
  { booking_id: 'B2', amount_paid_cents: 2000, paid_at: '2026-07-14T23:30:00Z' }, // → Madrid 07-15
  { booking_id: 'B3', amount_paid_cents: 20000, paid_at: '2026-06-25T10:00:00Z' }, // June
];

const s = computeSunsetFinanceSummary({ now: NOW, timeZone: TZ, bsr, payments, bookings });

// ── Booked (additive by service_date; custom line signed; undated excluded) ──
eq('Booked today', s.periods.today.booked_cents, 4000);
eq('Booked week (4000+3000-1000)', s.periods.week.booked_cents, 6000);
eq('Booked month excludes June + undated', s.periods.month.booked_cents, 6000);

// ── Collected (gross) by paid_at Madrid date ────────────────────────────────
eq('Collected today (4000 + boundary 2000)', s.periods.today.collected_gross_cents, 6000);
eq('Collected month excludes June payment', s.periods.month.collected_gross_cents, 6000);

// ── Outstanding (distinct bookings; GREATEST(total-paid,0)) ──────────────────
eq('Outstanding today = B1 balance', s.periods.today.outstanding_cents, 6000);
eq('Outstanding week = B1+B2', s.periods.week.outstanding_cents, 9000);
eq('Outstanding month = B1+B2 (B3 zeroed/June)', s.periods.month.outstanding_cents, 9000);

// ── Bookings count = distinct qualifying bookings ───────────────────────────
eq('count today = 1 (B1)', s.periods.today.bookings_count, 1);
eq('count week = 2 (B1,B2)', s.periods.week.bookings_count, 2);

// ── Daily trend + non-additivity ────────────────────────────────────────────
ok('daily_trend covers all of July (31 days)', Array.isArray(s.daily_trend) && s.daily_trend.length === 31, s.daily_trend && s.daily_trend.length);
const byDate = Object.fromEntries(s.daily_trend.map((d) => [d.date, d]));
eq('trend 07-15 booked', byDate['2026-07-15'].booked_cents, 4000);
eq('trend 07-16 outstanding = B1 balance again', byDate['2026-07-16'].outstanding_cents, 6000);
const sumDailyOutstanding = s.daily_trend.reduce((a, d) => a + d.outstanding_cents, 0);
ok('Outstanding is NON-additive (Σdaily ≠ month)', sumDailyOutstanding === 15000 && s.periods.month.outstanding_cents === 9000, `Σdaily=${sumDailyOutstanding} month=${s.periods.month.outstanding_cents}`);

// ── Empty input → honest zeros, not nulls ───────────────────────────────────
const empty = computeSunsetFinanceSummary({ now: NOW, timeZone: TZ, bsr: [], payments: [], bookings: [] });
ok('empty period all zeros', empty.periods.today.booked_cents === 0 && empty.periods.today.collected_gross_cents === 0 && empty.periods.today.outstanding_cents === 0 && empty.periods.today.bookings_count === 0);

// ── Contract limitation surfaced (gross-only) ───────────────────────────────
ok('surfaces net-collected-unavailable limitation', s.limitations && s.limitations.net_collected_available === false && typeof s.limitations.note === 'string');
eq('currency is EUR', s.currency, 'EUR');
eq('timeZone echoed', s.time_zone, TZ);

// ── Reconciliation data-quality (computed balance vs persisted balance_due_cents) ──
const recOk = reconcileBookingBalances({
  bookings: [{ booking_id: 'B1', total_amount_cents: 10000, balance_due_cents: 6000 }],
  payments: [{ booking_id: 'B1', amount_paid_cents: 4000 }],
});
ok('reconcile: matching persisted balance → not material', recOk.material === false && recOk.discrepancies.length === 0 && recOk.checked === 1);
const recBad = reconcileBookingBalances({
  bookings: [{ booking_id: 'B1', total_amount_cents: 10000, balance_due_cents: 9999 }],
  payments: [{ booking_id: 'B1', amount_paid_cents: 4000 }],
});
ok('reconcile: drift flagged as material with delta', recBad.material === true && recBad.discrepancies[0].delta_cents === -3999);
ok('reconcile: computed clamps at 0 (never negative)', reconcileBookingBalances({ bookings: [{ booking_id: 'B2', total_amount_cents: 1000, balance_due_cents: 0 }], payments: [{ booking_id: 'B2', amount_paid_cents: 5000 }] }).material === false);
ok('reconcile: null persisted balance is skipped', reconcileBookingBalances({ bookings: [{ booking_id: 'B3', total_amount_cents: 1000, balance_due_cents: null }], payments: [] }).discrepancies.length === 0);
ok('reconcile: tolerance suppresses immaterial drift', reconcileBookingBalances({ bookings: [{ booking_id: 'B4', total_amount_cents: 1000, balance_due_cents: 999 }], payments: [], toleranceCents: 5 }).material === false);

console.log(`\n── verify:sunset-finance-summary: ${pass} passed, ${fail} failed ──`);
if (fail === 0) console.log('verify:sunset-finance-summary — ALL CHECKS PASSED');
process.exit(fail ? 1 : 0);

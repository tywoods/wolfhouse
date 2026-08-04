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
  FinanceDataQualityError,
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
// Soft-fail: malformed per-row amounts contribute 0 (do not throw the summary).
for (const malformed of [1.5, '1.5', NaN, Infinity]) {
  eq('fractional/malformed signed metadata cents soft-zero: ' + String(malformed),
    effectiveServiceDueCents({
      booking_id: 'B-SOFT',
      amount_due_cents: 0,
      metadata: { source: 'staff_custom_line', amount_cents: malformed },
    }), 0);
}
for (const fixture of [
  { label: 'ordinary due', args: { bsr: [{ booking_id: 'B', service_date: '2026-07-15', amount_due_cents: 1.5 }], payments: [], bookings: [] } },
  { label: 'payment', args: { bsr: [], payments: [{ booking_id: 'B', payment_id: 'pay-1', amount_paid_cents: '1.5', paid_at: '2026-07-15T10:00:00Z' }], bookings: [] } },
  { label: 'booking total', args: { bsr: [], payments: [], bookings: [{ booking_id: 'B', total_amount_cents: Infinity }] } },
]) {
  let summary = null;
  let trapped = false;
  try {
    summary = computeSunsetFinanceSummary({ now: new Date('2026-07-15T12:00:00Z'), timeZone: 'Europe/Madrid', ...fixture.args });
  } catch (_) { trapped = true; }
  ok(`${fixture.label} malformed/fractional cents soft-fail (no throw)`, !trapped && summary && summary.periods);
  ok(`${fixture.label} reports data_quality.malformed`, summary && summary.data_quality && summary.data_quality.malformed_count >= 1);
}
for (const absent of [null, undefined, '', '   ']) {
  eq(`absent/empty ordinary cents soft-zero: ${JSON.stringify(absent)}`,
    effectiveServiceDueCents({ booking_id: 'B', amount_due_cents: absent, metadata: {} }), 0);
}
for (const accepted of [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, '9007199254740991', '-9007199254740991', '0']) {
  eq(`safe canonical cents accepted: ${accepted}`, effectiveServiceDueCents({ amount_due_cents: accepted, metadata: {} }), Number(accepted));
}
for (const rejected of [true, false, 'true', Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1,
  '9007199254740992', '-9007199254740992', '01', '-0', '+1', ' 1', '1 ', '1.0', '1e3']) {
  eq(`unsafe/noncanonical cents soft-zero: ${JSON.stringify(rejected)}`,
    effectiveServiceDueCents({ booking_id: 'B', amount_due_cents: rejected, metadata: {} }), 0);
}
// Hard mode still fails closed for callers that opt in.
{
  let err;
  try { effectiveServiceDueCents({ amount_due_cents: 1.5, metadata: {} }, { hard: true }); } catch (e) { err = e; }
  ok('hard mode still throws typed data-quality error', err instanceof FinanceDataQualityError);
}
// Soft-fail keeps good rows while zeroing bad ones + sanitised IDs only.
{
  const logs = [];
  const origWarn = console.warn;
  console.warn = (...a) => { logs.push(a.map(String).join(' ')); };
  let soft;
  try {
    soft = computeSunsetFinanceSummary({
      now: NOW,
      timeZone: TZ,
      bsr: [
        { booking_id: 'GOOD', service_record_id: 'sr-good', service_date: '2026-07-15', amount_due_cents: 4000, metadata: {} },
        { booking_id: 'BAD', service_record_id: 'sr-bad', service_date: '2026-07-15', amount_due_cents: null, metadata: {} },
        { booking_id: 'BAD2', service_record_id: 'sr-nan', service_date: '2026-07-15', amount_due_cents: NaN, metadata: {} },
      ],
      payments: [
        { booking_id: 'GOOD', payment_id: 'pay-good', amount_paid_cents: 1000, paid_at: '2026-07-15T10:00:00Z' },
        { booking_id: 'BAD', payment_id: 'pay-bad', amount_paid_cents: 'not-int', paid_at: '2026-07-15T10:00:00Z' },
      ],
      bookings: [
        { booking_id: 'GOOD', total_amount_cents: 4000 },
        { booking_id: 'BAD', total_amount_cents: 999 },
        { booking_id: 'BAD2', total_amount_cents: 1.5 },
      ],
      refund_records: [
        { booking_id: 'GOOD', refund_id: 'ref-bad', amount_cents: 1.25, effective_date: '2026-07-15' },
      ],
    });
  } finally {
    console.warn = origWarn;
  }
  eq('soft-fail keeps good BSR booked cents', soft.periods.today.booked_cents, 4000);
  eq('soft-fail keeps good payment collected', soft.periods.today.collected_gross_cents, 1000);
  ok('soft-fail data_quality has malformed rows', soft.data_quality.malformed_count >= 3);
  const malformedJson = JSON.stringify(soft.data_quality.malformed);
  ok('soft-fail logs include service_record_id', /sr-bad|sr-nan/.test(malformedJson));
  ok('soft-fail logs include payment_id', /pay-bad/.test(malformedJson));
  ok('soft-fail logs include refund_id', /ref-bad/.test(malformedJson));
  // Amount *values* must not appear; field source names may include "amount_cents".
  ok('soft-fail diagnostics leak no raw amount values',
    !malformedJson.includes('4000') && !malformedJson.includes('999') && !malformedJson.includes('1.25'));
  ok('soft-fail malformed records are ID-only shape', soft.data_quality.malformed.every((m) => {
    const keys = Object.keys(m);
    return m.source && m.reason && !keys.includes('amount') && !keys.includes('amount_cents')
      && !keys.includes('amount_paid_cents') && !keys.includes('value');
  }));
  ok('console soft-fail log is structured', logs.some((l) => /malformed_monetary_row/.test(l) && /sr-bad|pay-bad|ref-bad/.test(l)));
}
const overflowFixtures = [
  { label: 'BSR fallback addition overflow', bookings:[{booking_id:'O',total_amount_cents:null}], bsr:[{booking_id:'O',service_date:'2026-07-15',amount_due_cents:Number.MAX_SAFE_INTEGER,metadata:{}},{booking_id:'O',service_date:'2026-07-15',amount_due_cents:1,metadata:{}}], payments:[] },
  { label: 'paid-map addition overflow', bookings:[{booking_id:'O',total_amount_cents:Number.MAX_SAFE_INTEGER}], bsr:[{booking_id:'O',service_date:'2026-07-15',amount_due_cents:1,metadata:{}}], payments:[{booking_id:'O',amount_paid_cents:Number.MAX_SAFE_INTEGER,paid_at:'2026-07-15T10:00:00Z'},{booking_id:'O',amount_paid_cents:1,paid_at:'2026-07-15T10:00:00Z'}] },
  { label: 'booked aggregate addition overflow', bookings:[], bsr:[{booking_id:'A',service_date:'2026-07-15',amount_due_cents:Number.MAX_SAFE_INTEGER,metadata:{}},{booking_id:'B',service_date:'2026-07-15',amount_due_cents:1,metadata:{}}], payments:[] },
  { label: 'collected aggregate addition overflow', bookings:[], bsr:[], payments:[{booking_id:'A',amount_paid_cents:Number.MAX_SAFE_INTEGER,paid_at:'2026-07-15T10:00:00Z'},{booking_id:'B',amount_paid_cents:1,paid_at:'2026-07-15T10:00:00Z'}] },
  { label: 'outstanding aggregate addition overflow', bookings:[{booking_id:'A',total_amount_cents:Number.MAX_SAFE_INTEGER},{booking_id:'B',total_amount_cents:1}], bsr:[{booking_id:'A',service_date:'2026-07-15',amount_due_cents:1,metadata:{}},{booking_id:'B',service_date:'2026-07-15',amount_due_cents:1,metadata:{}}], payments:[] },
];
for (const fixture of overflowFixtures) {
  let err;
  try { computeSunsetFinanceSummary({ now:NOW, timeZone:TZ, ...fixture }); } catch (e) { err=e; }
  ok(`${fixture.label} throws typed data-quality error`, err instanceof FinanceDataQualityError);
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

const legacy = computeSunsetFinanceSummary({
  now: NOW,
  timeZone: TZ,
  bookings: [{ booking_id: 'LEGACY', total_amount_cents: null, balance_due_cents: null }],
  bsr: [
    { booking_id: 'LEGACY', service_date: '2026-07-15', amount_due_cents: 4000, metadata: {} },
    { booking_id: 'LEGACY', service_date: '2026-07-16', amount_due_cents: 3000, metadata: {} },
    { booking_id: 'LEGACY', service_date: '2026-07-16', amount_due_cents: 0, metadata: { source: 'staff_custom_line', amount_cents: -1000 } },
  ],
  payments: [{ booking_id: 'LEGACY', amount_paid_cents: 1500, paid_at: '2026-07-15T09:00:00Z' }],
});
eq('legacy null total falls back to every effective commercial BSR row exactly once', legacy.periods.today.outstanding_cents, 4500);
eq('fallback remains full-booking total in a period containing multiple rows', legacy.periods.week.outstanding_cents, 4500);

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
ok('reconcile: material drift soft-flags booking_id',
  Array.isArray(recBad.flagged_booking_ids) && recBad.flagged_booking_ids.includes('B1')
  && recBad.diagnostics.balance_drift.some((d) => d.booking_id === 'B1'));
ok('reconcile: computed clamps at 0 (never negative)', reconcileBookingBalances({ bookings: [{ booking_id: 'B2', total_amount_cents: 1000, balance_due_cents: 0 }], payments: [{ booking_id: 'B2', amount_paid_cents: 5000 }] }).material === false);
ok('reconcile: null persisted balance is skipped', reconcileBookingBalances({ bookings: [{ booking_id: 'B3', total_amount_cents: 1000, balance_due_cents: null }], payments: [] }).discrepancies.length === 0);
const legacyRec = reconcileBookingBalances({
  bookings: [{ booking_id: 'B5', total_amount_cents: null, balance_due_cents: 4500 }],
  bsr: [
    { booking_id: 'B5', service_date: '2026-07-15', amount_due_cents: 4000, metadata: {} },
    { booking_id: 'B5', service_date: '2026-07-16', amount_due_cents: 3000, metadata: {} },
    { booking_id: 'B5', service_date: '2026-07-16', amount_due_cents: 0, metadata: { staff_custom_line: true, amount_cents: -1000 } },
  ],
  payments: [{ booking_id: 'B5', amount_paid_cents: 1500 }],
});
ok('reconcile: present persisted balance uses legacy full-BSR fallback and still matches exactly', legacyRec.material === false && legacyRec.discrepancies.length === 0);
ok('reconcile: one-cent mismatch with fallback still material-flagged (soft)', reconcileBookingBalances({
  bookings: [{ booking_id: 'B6', total_amount_cents: null, balance_due_cents: 4499 }],
  bsr: [
    { booking_id: 'B6', service_date: '2026-07-15', amount_due_cents: 4000, metadata: {} },
    { booking_id: 'B6', service_date: '2026-07-16', amount_due_cents: 2000, metadata: {} },
  ],
  payments: [{ booking_id: 'B6', amount_paid_cents: 1500 }],
}).material === true);
ok('reconcile: tolerance suppresses immaterial drift', reconcileBookingBalances({ bookings: [{ booking_id: 'B4', total_amount_cents: 1000, balance_due_cents: 999 }], payments: [], toleranceCents: 5 }).material === false);

// ── RED→GREEN: material balance drift must soft-fail; summary still returns ──
// Live class (not the root cause of this ship — owner money decision unresolved):
// total 3500, balance_due 2000, no captured payment → expected owed 3500, delta 1500.
{
  const DRIFT_ID = 'c713c1d7-7f11-4087-bb95-f78c0eaec65e';
  const driftLogs = [];
  const origWarn = console.warn;
  console.warn = (...a) => { driftLogs.push(a.map(String).join(' ')); };
  let rec;
  let summary;
  let threw = false;
  try {
    rec = reconcileBookingBalances({
      bookings: [
        { booking_id: 'GOOD', total_amount_cents: 4000, balance_due_cents: 3000 },
        { booking_id: DRIFT_ID, total_amount_cents: 3500, balance_due_cents: 2000 },
      ],
      bsr: [
        { booking_id: 'GOOD', service_date: '2026-07-15', amount_due_cents: 4000, metadata: {} },
        { booking_id: DRIFT_ID, service_date: '2026-07-15', amount_due_cents: 3500, metadata: {} },
      ],
      payments: [
        { booking_id: 'GOOD', amount_paid_cents: 1000 },
      ],
    });
    summary = computeSunsetFinanceSummary({
      now: NOW,
      timeZone: TZ,
      bsr: [
        { booking_id: 'GOOD', service_date: '2026-07-15', amount_due_cents: 4000, metadata: {} },
        { booking_id: DRIFT_ID, service_date: '2026-07-15', amount_due_cents: 3500, metadata: {} },
      ],
      payments: [
        { booking_id: 'GOOD', amount_paid_cents: 1000, paid_at: '2026-07-15T10:00:00Z' },
      ],
      bookings: [
        { booking_id: 'GOOD', total_amount_cents: 4000, balance_due_cents: 3000 },
        { booking_id: DRIFT_ID, total_amount_cents: 3500, balance_due_cents: 2000 },
      ],
      data_quality: {
        balance_drift: rec.diagnostics.balance_drift.slice(),
        balance_drift_count: rec.diagnostics.balance_drift.length,
        flagged_booking_ids: rec.flagged_booking_ids.slice(),
        malformed: [],
        malformed_count: 0,
      },
    });
  } catch (_e) {
    threw = true;
  } finally {
    console.warn = origWarn;
  }
  ok('RED→GREEN drift: reconcile does not throw', !threw && rec && summary);
  ok('RED→GREEN drift: material true with delta 1500',
    rec.material === true
    && rec.discrepancies.some((d) => d.booking_id === DRIFT_ID && d.computed_cents === 3500
      && d.persisted_cents === 2000 && d.delta_cents === 1500));
  ok('RED→GREEN drift: only offending id flagged',
    rec.flagged_booking_ids.length === 1 && rec.flagged_booking_ids[0] === DRIFT_ID);
  ok('RED→GREEN drift: structured log has booking_id + recon fields',
    driftLogs.some((l) => /material_balance_drift/.test(l)
      && l.includes(DRIFT_ID)
      && /"computed_cents":3500/.test(l)
      && /"persisted_cents":2000/.test(l)
      && /"delta_cents":1500/.test(l)),
    driftLogs.join(' | '));
  ok('RED→GREEN drift: summary periods still return', !!(summary.periods && summary.periods.today));
  ok('RED→GREEN drift: unaffected booking still aggregates (booked 7500, collected 1000)',
    summary.periods.today.booked_cents === 7500
    && summary.periods.today.collected_gross_cents === 1000,
    `booked=${summary.periods.today.booked_cents} collected=${summary.periods.today.collected_gross_cents}`);
  ok('RED→GREEN drift: outstanding uses total−paid not stale balance (6500)',
    summary.periods.today.outstanding_cents === 6500,
    summary.periods.today.outstanding_cents);
  ok('RED→GREEN drift: summary.data_quality surfaces offending id',
    summary.data_quality.balance_drift_count >= 1
    && summary.data_quality.balance_drift.some((d) => d.booking_id === DRIFT_ID));
  ok('RED→GREEN drift: overflow path still hard-fails (FinanceDataQualityError reserved)', (() => {
    let err;
    try {
      computeSunsetFinanceSummary({
        now: NOW,
        timeZone: TZ,
        bsr: [
          { booking_id: 'O', service_date: '2026-07-15', amount_due_cents: Number.MAX_SAFE_INTEGER, metadata: {} },
          { booking_id: 'O', service_date: '2026-07-15', amount_due_cents: 1, metadata: {} },
        ],
        payments: [],
        bookings: [{ booking_id: 'O', total_amount_cents: null }],
      });
    } catch (e) { err = e; }
    return err instanceof FinanceDataQualityError;
  })());
}

// RED→GREEN: legacy null total + malformed BSR + persisted balance → recon unavailable, never false drift
{
  const logs = [];
  const origWarn = console.warn;
  console.warn = (...a) => { logs.push(a.map(String).join(' ')); };
  let rec;
  try {
    rec = reconcileBookingBalances({
      bookings: [
        { booking_id: 'GOOD', total_amount_cents: 4000, balance_due_cents: 3000 },
        { booking_id: 'LEGACY-MAL', total_amount_cents: null, balance_due_cents: 4500 },
      ],
      bsr: [
        { booking_id: 'GOOD', service_date: '2026-07-15', amount_due_cents: 4000, metadata: {} },
        { booking_id: 'LEGACY-MAL', service_record_id: 'sr-ok', service_date: '2026-07-15', amount_due_cents: 4000, metadata: {} },
        { booking_id: 'LEGACY-MAL', service_record_id: 'sr-bad', service_date: '2026-07-16', amount_due_cents: 'bogus', metadata: {} },
        {
          booking_id: 'LEGACY-MAL',
          service_record_id: 'sr-custom',
          service_date: '2026-07-16',
          amount_due_cents: 0,
          metadata: { staff_custom_line: true, amount_cents: -1000 },
        },
      ],
      payments: [
        { booking_id: 'GOOD', amount_paid_cents: 1000 },
        { booking_id: 'LEGACY-MAL', amount_paid_cents: 1500 },
      ],
    });
  } finally {
    console.warn = origWarn;
  }
  ok('RED→GREEN incomplete legacy: no material_balance_drift invented',
    rec
    && rec.material === false
    && !(rec.discrepancies || []).some((d) => d.booking_id === 'LEGACY-MAL')
    && !(rec.flagged_booking_ids || []).includes('LEGACY-MAL')
    && !(rec.diagnostics.balance_drift || []).some((d) => d.booking_id === 'LEGACY-MAL'));
  ok('RED→GREEN incomplete legacy: malformed BSR soft-logged',
    (rec.diagnostics.malformed || []).some((m) => m.booking_id === 'LEGACY-MAL' && m.service_record_id === 'sr-bad')
    && logs.some((l) => /malformed_monetary_row/.test(l) && /sr-bad/.test(l)));
  ok('RED→GREEN incomplete legacy: reconciliation_unavailable flagged',
    Array.isArray(rec.reconciliation_unavailable)
    && rec.reconciliation_unavailable.some((r) => (
      r.booking_id === 'LEGACY-MAL' && /incomplete|malformed|unavailable/i.test(String(r.reason || ''))
    )),
    JSON.stringify(rec && rec.reconciliation_unavailable));
  ok('RED→GREEN incomplete legacy: healthy peer still checked, not flagged',
    rec.checked >= 1
    && !(rec.flagged_booking_ids || []).includes('GOOD')
    && !(rec.reconciliation_unavailable || []).some((r) => r.booking_id === 'GOOD'));
}

console.log(`\n── verify:sunset-finance-summary: ${pass} passed, ${fail} failed ──`);
if (fail === 0) console.log('verify:sunset-finance-summary — ALL CHECKS PASSED');
process.exit(fail ? 1 : 0);

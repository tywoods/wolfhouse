'use strict';

/**
 * Bug Finder P1 (2026-09-07): Finance Year Net / Outstanding ≠ Bookings KPIs.
 *
 * Root causes proven here (do not invent staging amounts):
 *  1) Bookings collected SQL omitted finance_exclusion / schedule_booking_deleted
 *     while Finance excluded them → Net gap (e.g. €15 deleted-booking payment).
 *  2) Bookings Outstanding summed cancelled/expired/hold dues while Finance
 *     operational scope excludes those statuses.
 *
 * Fix: shared sunset-staff-money-scope + Bookings SQL/summary parity + UI notes.
 *
 * Run: node scripts/verify-sunset-finance-bookings-kpi-parity.js
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const {
  PAYMENT_COLLECTED_SCOPE_SQL,
  BOOKING_STATUS_EXCLUSIONS_SQL,
  isExcludedBookingStatus,
} = require('./lib/sunset-staff-money-scope');
const {
  computeBookingsSummary,
  buildBookingListRow,
} = require('./lib/sunset-bookings-admin');
const { computeSunsetFinanceSummary } = require('./lib/sunset-finance-summary');
const { PAYMENTS_SQL, PAYMENTS_FOR_BOOKINGS_SQL } = (function loadSqlOwners() {
  const financeData = require('./lib/sunset-finance-data');
  const bookingsData = require('./lib/sunset-bookings-admin-data');
  return {
    PAYMENTS_SQL: financeData.PAYMENTS_SQL,
    PAYMENTS_FOR_BOOKINGS_SQL: bookingsData.PAYMENTS_FOR_BOOKINGS_SQL,
  };
}());

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${extra != null ? ` (${extra})` : ''}`);
  }
}
function eq(label, got, want) {
  ok(label, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

console.log('\nverify:sunset-finance-bookings-kpi-parity\n');

// ── Shared scope contract ────────────────────────────────────────────────────
ok('shared payment scope mentions finance_exclusion',
  /finance_exclusion IS NULL/.test(PAYMENT_COLLECTED_SCOPE_SQL));
ok('shared payment scope mentions schedule_booking_deleted',
  /schedule_booking_deleted/.test(PAYMENT_COLLECTED_SCOPE_SQL));
ok('shared payment scope mentions test_booking_cancelled',
  /test_booking_cancelled/.test(PAYMENT_COLLECTED_SCOPE_SQL));
ok('Finance PAYMENTS_SQL embeds shared collected scope',
  PAYMENTS_SQL.includes('finance_exclusion IS NULL')
  && PAYMENTS_SQL.includes('schedule_booking_deleted'));
ok('Bookings PAYMENTS_FOR_BOOKINGS_SQL embeds shared collected scope',
  PAYMENTS_FOR_BOOKINGS_SQL.includes('finance_exclusion IS NULL')
  && PAYMENTS_FOR_BOOKINGS_SQL.includes('schedule_booking_deleted'));
ok('Finance booking exclusions match shared list',
  require('./lib/sunset-finance-data').BSR_SQL.includes(BOOKING_STATUS_EXCLUSIONS_SQL)
  || fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-finance-data.js'), 'utf8')
    .includes('BOOKING_STATUS_EXCLUSIONS_SQL'));

eq('cancelled is excluded status', isExcludedBookingStatus('cancelled'), true);
eq('hold is excluded status', isExcludedBookingStatus('hold'), true);
eq('paid is not excluded', isExcludedBookingStatus('paid'), false);

// ── Net: €15 finance_exclusion payment must not inflate Bookings collected ──
// Bug Finder class: Year Net Finance €12,090 vs Bookings €12,105 → €15 gap.
const EXCLUDED_PAYMENT_CENTS = 1500; // €15
const LIVE_PAYMENT_CENTS = 1209000; // €12,090

const operational = buildBookingListRow({
  booking: {
    booking_id: 'op-1',
    booking_code: 'SUNSET-OP',
    status: 'confirmed',
    total_amount_cents: LIVE_PAYMENT_CENTS,
  },
  services: [{
    service_date: '2026-06-01',
    service_type: 'surf_lesson',
    amount_due_cents: LIVE_PAYMENT_CENTS,
    status: 'active',
  }],
  // SQL layer already dropped finance_exclusion rows — collected is live only.
  collected_cents: LIVE_PAYMENT_CENTS,
  refunded_cents: 0,
});

const deletedPaid = buildBookingListRow({
  booking: {
    booking_id: 'del-1',
    booking_code: 'SUNSET-DEL',
    status: 'cancelled',
    total_amount_cents: EXCLUDED_PAYMENT_CENTS,
    hidden: true,
  },
  services: [{
    service_date: '2026-03-01',
    service_type: 'yoga',
    amount_due_cents: EXCLUDED_PAYMENT_CENTS,
    status: 'cancelled',
  }],
  // After fix: finance_exclusion payment not in collected.
  collected_cents: 0,
  refunded_cents: 0,
});

const bookingsSummary = computeBookingsSummary([operational, deletedPaid]);
eq('Bookings net ignores finance_exclusion €15', bookingsSummary.net_cents, LIVE_PAYMENT_CENTS);
eq('Bookings outstanding ignores cancelled/hidden deleted row', bookingsSummary.outstanding_cents, 0);

const finance = computeSunsetFinanceSummary({
  bookings: [
    { booking_id: 'op-1', total_amount_cents: LIVE_PAYMENT_CENTS, balance_due_cents: 0 },
  ],
  bsr: [{
    booking_id: 'op-1',
    service_date: '2026-06-01',
    service_type: 'surf_lesson',
    amount_due_cents: LIVE_PAYMENT_CENTS,
    metadata: {},
  }],
  payments: [{
    booking_id: 'op-1',
    amount_paid_cents: LIVE_PAYMENT_CENTS,
    paid_at: '2026-06-01T12:00:00Z',
  }],
  // finance_exclusion payment never reaches Finance inputs (SQL filter).
  refund_records: [],
  now: new Date('2026-09-07T12:00:00Z'),
  timeZone: 'Europe/Madrid',
  view: { granularity: 'year', anchor: '2026-09-07' },
});

eq('Finance Year net matches Bookings net after exclusion',
  finance.redesign.net.net_collected_cents, bookingsSummary.net_cents);
eq('Finance Year gross is €12,090 class',
  finance.redesign.net.gross_collected_cents, LIVE_PAYMENT_CENTS);

// ── Outstanding: cancelled unpaid must not inflate Bookings KPI ──────────────
const unpaidLive = buildBookingListRow({
  booking: {
    booking_id: 'due-1',
    booking_code: 'SUNSET-DUE',
    status: 'payment_pending',
    total_amount_cents: 5561100,
  },
  services: [{
    service_date: '2026-07-15',
    service_type: 'surf_lesson',
    amount_due_cents: 5561100,
    status: 'active',
  }],
  collected_cents: 0,
  refunded_cents: 0,
});
const cancelledUnpaid = buildBookingListRow({
  booking: {
    booking_id: 'cx-1',
    booking_code: 'SUNSET-CX',
    status: 'cancelled',
    total_amount_cents: 22450, // €224.50 — Bug Finder Outstanding gap class
  },
  services: [{
    service_date: '2026-08-01',
    service_type: 'board_rental',
    amount_due_cents: 22450,
    status: 'cancelled',
  }],
  collected_cents: 0,
  refunded_cents: 0,
});
eq('cancelled row outstanding zeroed at build', cancelledUnpaid.outstanding_cents, 0);
eq('hold row outstanding zeroed',
  buildBookingListRow({
    booking: { booking_id: 'h1', status: 'hold', total_amount_cents: 5000 },
    services: [{ service_date: '2026-08-02', amount_due_cents: 5000, status: 'active' }],
    collected_cents: 0,
  }).outstanding_cents,
  0);

const outSummary = computeBookingsSummary([unpaidLive, cancelledUnpaid]);
eq('Bookings outstanding excludes cancelled unpaid €224.50',
  outSummary.outstanding_cents, 5561100);

const financeOut = computeSunsetFinanceSummary({
  bookings: [
    { booking_id: 'due-1', total_amount_cents: 5561100, balance_due_cents: 5561100 },
  ],
  bsr: [{
    booking_id: 'due-1',
    service_date: '2026-07-15',
    service_type: 'surf_lesson',
    amount_due_cents: 5561100,
    metadata: {},
  }],
  payments: [],
  refund_records: [],
  now: new Date('2026-09-07T12:00:00Z'),
  timeZone: 'Europe/Madrid',
  view: { granularity: 'year', anchor: '2026-09-07' },
});
eq('Finance Year outstanding matches Bookings after cancelled exclusion',
  financeOut.redesign.outstanding.outstanding_cents, outSummary.outstanding_cents);

// Summary safety: even if a row still carries outstanding + cancelled status.
eq('summary skips cancelled outstanding even if row field stale',
  computeBookingsSummary([{
    status: 'cancelled',
    collected_cents: 0,
    refunded_cents: 0,
    outstanding_cents: 9999,
  }]).outstanding_cents,
  0);

// ── UI notes present (explicit exclusions) ───────────────────────────────────
const bookingsUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-bookings-ui.js'), 'utf8');
const financeUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-finance-redesign-ui.js'), 'utf8');
const i18n = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
const i18nEs = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n-es-sunset.js'), 'utf8');
ok('Bookings UI shows KPI scope note',
  /data-bookings-kpi-scope/.test(bookingsUi) && /summaryScopeNote/.test(bookingsUi));
ok('Finance UI shows KPI scope note',
  /data-finance-kpi-scope/.test(financeUi) && /kpiScopeNote/.test(financeUi));
ok('EN + ES scope note keys present',
  /admin\.bookings\.summaryScopeNote/.test(i18n)
  && /admin\.finance\.kpiScopeNote/.test(i18n)
  && /admin\.bookings\.summaryScopeNote/.test(i18nEs)
  && /admin\.finance\.kpiScopeNote/.test(i18nEs));

console.log(`\nverify:sunset-finance-bookings-kpi-parity  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

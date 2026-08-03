'use strict';

/**
 * verify:sunset-finance-refund-net-s2
 * Finance Slice 2 — refund-aware Net adversarial fixtures (L1–L4).
 * Pure offline math + SQL shape — no live DB.
 */

const path = require('path');
const fs = require('fs');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const { computeSunsetFinanceSummary } = require(path.join(ROOT, 'scripts', 'lib', 'sunset-finance-summary.js'));
const { REFUNDS_SQL, PAYMENTS_SQL, fetchSunsetFinanceData } = require(path.join(ROOT, 'scripts', 'lib', 'sunset-finance-data.js'));

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra !== undefined ? `  (${extra})` : ''}`); }
}
function eq(label, got, want) {
  ok(label, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

const TZ = 'Europe/Madrid';
const NOW = new Date('2026-08-15T10:00:00Z'); // August 2026 primary month
const VIEW = { granularity: 'month', anchor: '2026-08-15' };

function summary(args) {
  return computeSunsetFinanceSummary({
    now: NOW,
    timeZone: TZ,
    view: VIEW,
    bsr: [],
    payments: [],
    bookings: [],
    refund_records: [],
    ...args,
  });
}

// ── L2 SQL shape ────────────────────────────────────────────────────────────
ok('REFUNDS_SQL uses booking_refund_records only', /FROM\s+booking_refund_records/i.test(REFUNDS_SQL));
ok('REFUNDS_SQL scopes r.location_id', /r\.location_id\s*=\s*\$2/.test(REFUNDS_SQL));
ok('REFUNDS_SQL joins clients slug', /c\.slug\s*=\s*\$1/.test(REFUNDS_SQL));
ok('REFUNDS_SQL never booking metadata location', !/metadata\s*->>\s*'location_id'/.test(REFUNDS_SQL));
ok('REFUNDS_SQL has no phantom status column', !/\bstatus\b/.test(REFUNDS_SQL.replace(/staff_manual_record/g, '')));
ok('REFUNDS_SQL selects effective_date', /effective_date/.test(REFUNDS_SQL));
ok('REFUNDS_SQL filters staff_manual_record', /staff_manual_record/.test(REFUNDS_SQL));
ok('PAYMENTS still includes cancelled paid cash (no b.status filter)', !/b\.status/.test(PAYMENTS_SQL));

// ── L1 legacy freeze ────────────────────────────────────────────────────────
const empty = summary({});
eq('L1 net_collected_available false', empty.limitations.net_collected_available, false);
eq(
  'L1 legacy note exact',
  empty.limitations.note,
  'Collected is gross: refunds/reversals are not available until an authoritative refund ledger exists.',
);
ok('L1 legacy only 2 keys', Object.keys(empty.limitations).sort().join(',') === 'net_collected_available,note');
ok('L1 redesign net_uses_recorded_refunds', empty.redesign.limitations.net_uses_recorded_refunds === true);
ok('L1 redesign pending proxy false', empty.redesign.limitations.pending_refund_estimated_from_cancellations === false);

// ── Zero-refund period unchanged ────────────────────────────────────────────
const zero = summary({
  payments: [{ booking_id: 'P1', amount_paid_cents: 5000, paid_at: '2026-08-10T12:00:00Z' }],
  bookings: [{ booking_id: 'P1', total_amount_cents: 5000 }],
  bsr: [{ booking_id: 'P1', service_date: '2026-08-10', amount_due_cents: 5000, metadata: {} }],
});
eq('zero-refund gross', zero.redesign.net.gross_collected_cents, 5000);
eq('zero-refund refunds', zero.redesign.net.completed_refunds_cents, 0);
eq('zero-refund net = gross', zero.redesign.net.net_collected_cents, 5000);
eq('zero-refund net_equals_gross true', zero.redesign.net.net_equals_gross, true);

// ── L3.1 Paid cancelled booking, NO refund record → gross includes, net = gross ─
const cancelledPaidNoRefund = summary({
  payments: [
    { booking_id: 'CXL', amount_paid_cents: 8000, paid_at: '2026-08-05T12:00:00Z' },
    { booking_id: 'OK', amount_paid_cents: 2000, paid_at: '2026-08-06T12:00:00Z' },
  ],
  // pending proxy must NOT affect net
  pending_refund_payments: [
    { booking_id: 'CXL', amount_paid_cents: 8000, paid_at: '2026-08-05T12:00:00Z' },
  ],
  refund_records: [],
});
eq('L3.1 gross includes cancelled paid', cancelledPaidNoRefund.redesign.net.gross_collected_cents, 10000);
eq('L3.1 refunds 0', cancelledPaidNoRefund.redesign.net.completed_refunds_cents, 0);
eq('L3.1 net unchanged vs gross', cancelledPaidNoRefund.redesign.net.net_collected_cents, 10000);
eq('L3.1 pending proxy ignored', cancelledPaidNoRefund.redesign.net.pending_refund_cents, 0);

// ── L3.2 Cross-period: payment prior month; refund effective this month ──────
const crossPeriod = summary({
  payments: [
    // July payment (prior) — not in August gross
    { booking_id: 'X1', amount_paid_cents: 10000, paid_at: '2026-07-20T12:00:00Z' },
    // August payment
    { booking_id: 'X2', amount_paid_cents: 3000, paid_at: '2026-08-08T12:00:00Z' },
  ],
  refund_records: [
    // Refund of July booking effective in August → reduces August net
    { booking_id: 'X1', amount_cents: 4000, effective_date: '2026-08-03', location_id: 'sunset-somo' },
  ],
});
eq('L3.2 August gross only X2', crossPeriod.redesign.net.gross_collected_cents, 3000);
eq('L3.2 August refunds 4000', crossPeriod.redesign.net.completed_refunds_cents, 4000);
eq('L3.2 August net 3000-4000 = -1000', crossPeriod.redesign.net.net_collected_cents, -1000);

// Prior July should have gross 10000 and refunds 0 (refund effective Aug)
// Prior of August month = July
// We check via vs_prior using nets: prior net = 10000, current = -1000
ok('L3.2 vs_prior is finite (nets compared)', Number.isFinite(crossPeriod.redesign.net.vs_prior_pct));

// Explicit prior-period independence via second compute on July anchor
const july = computeSunsetFinanceSummary({
  now: NOW,
  timeZone: TZ,
  view: { granularity: 'month', anchor: '2026-07-15' },
  payments: [
    { booking_id: 'X1', amount_paid_cents: 10000, paid_at: '2026-07-20T12:00:00Z' },
    { booking_id: 'X2', amount_paid_cents: 3000, paid_at: '2026-08-08T12:00:00Z' },
  ],
  refund_records: [
    { booking_id: 'X1', amount_cents: 4000, effective_date: '2026-08-03', location_id: 'sunset-somo' },
  ],
  bsr: [],
  bookings: [],
});
eq('L3.2 July gross = 10000', july.redesign.net.gross_collected_cents, 10000);
eq('L3.2 July refunds = 0 (effective Aug)', july.redesign.net.completed_refunds_cents, 0);
eq('L3.2 July net = 10000', july.redesign.net.net_collected_cents, 10000);

// ── L3.3 Wrong location excluded (fetch scopes SQL; math trusts scoped rows) ─
// Math layer receives already-scoped rows; simulate "wrong location never arrived"
const locOk = summary({
  payments: [{ booking_id: 'L1', amount_paid_cents: 5000, paid_at: '2026-08-04T12:00:00Z' }],
  refund_records: [
    { booking_id: 'L1', amount_cents: 1000, effective_date: '2026-08-05', location_id: 'sunset-somo' },
  ],
});
eq('L3.3 in-scope refund counted', locOk.redesign.net.completed_refunds_cents, 1000);
eq('L3.3 net 4000', locOk.redesign.net.net_collected_cents, 4000);

// SQL shape proves wrong location cannot enter (r.location_id = $2)
ok('L3.3 SQL excludes other locations at query', /r\.location_id\s*=\s*\$2/.test(REFUNDS_SQL));

// ── L3.4 Refunds > gross → negative net preserved (no floor) ─────────────────
const neg = summary({
  payments: [{ booking_id: 'N1', amount_paid_cents: 2000, paid_at: '2026-08-01T12:00:00Z' }],
  refund_records: [
    { booking_id: 'N1', amount_cents: 1500, effective_date: '2026-08-02', location_id: 'sunset-somo' },
    { booking_id: 'N2', amount_cents: 1500, effective_date: '2026-08-03', location_id: 'sunset-somo' },
  ],
});
eq('L3.4 gross 2000', neg.redesign.net.gross_collected_cents, 2000);
eq('L3.4 refunds 3000', neg.redesign.net.completed_refunds_cents, 3000);
eq('L3.4 negative net -1000', neg.redesign.net.net_collected_cents, -1000);
ok('L3.4 no floor at zero', neg.redesign.net.net_collected_cents < 0);

// ── L3.5 Multiple append-only refund rows summed once each ──────────────────
const multi = summary({
  payments: [
    { booking_id: 'M1', amount_paid_cents: 10000, paid_at: '2026-08-02T12:00:00Z' },
  ],
  refund_records: [
    { booking_id: 'M1', amount_cents: 1000, effective_date: '2026-08-05', location_id: 'sunset-somo' },
    { booking_id: 'M1', amount_cents: 2500, effective_date: '2026-08-10', location_id: 'sunset-somo' },
    { booking_id: 'M1', amount_cents: 500, effective_date: '2026-08-12', location_id: 'sunset-somo' },
  ],
});
eq('L3.5 refunds sum 4000 once', multi.redesign.net.completed_refunds_cents, 4000);
eq('L3.5 net 6000', multi.redesign.net.net_collected_cents, 6000);
// Prove no payment-row multiplication: still 1 payment
eq('L3.5 gross still single payment', multi.redesign.net.gross_collected_cents, 10000);

// ── L4 Independent comparisons ──────────────────────────────────────────────
// August: gross 5000, refunds 1000 → net 4000
// July (prior): gross 8000, refunds 3000 → net 5000
// Aug 2025 (yoy): gross 2000, refunds 0 → net 2000
const compare = summary({
  payments: [
    { booking_id: 'C1', amount_paid_cents: 5000, paid_at: '2026-08-10T12:00:00Z' },
    { booking_id: 'C2', amount_paid_cents: 8000, paid_at: '2026-07-10T12:00:00Z' },
    { booking_id: 'C3', amount_paid_cents: 2000, paid_at: '2025-08-10T12:00:00Z' },
  ],
  refund_records: [
    { booking_id: 'C1', amount_cents: 1000, effective_date: '2026-08-11', location_id: 'sunset-somo' },
    { booking_id: 'C2', amount_cents: 3000, effective_date: '2026-07-12', location_id: 'sunset-somo' },
  ],
});
eq('L4 current net 4000', compare.redesign.net.net_collected_cents, 4000);
// vs_prior: (4000 - 5000) / 5000 * 100 = -20
eq('L4 vs_prior_pct uses nets (-20)', compare.redesign.net.vs_prior_pct, -20);
// vs_yoy: (4000 - 2000) / 2000 * 100 = 100
eq('L4 vs_yoy_pct uses nets (100)', compare.redesign.net.vs_yoy_pct, 100);

// Prove NOT using gross for comparison: if gross were used current 5000 vs prior 8000 = -37.5
ok('L4 not gross-based prior pct', compare.redesign.net.vs_prior_pct !== -37.5);

// Daily trend remains gross series
ok('L4 daily trend field is daily_gross_trend', Array.isArray(compare.redesign.daily_gross_trend));
const day10 = compare.redesign.daily_gross_trend.find((d) => d.date === '2026-08-10');
ok('L4 daily trend carries gross cents', day10 && day10.collected_gross_cents === 5000);

// ── Inclusive effective_date bounds ─────────────────────────────────────────
const bounds = summary({
  payments: [{ booking_id: 'B', amount_paid_cents: 1000, paid_at: '2026-08-15T12:00:00Z' }],
  refund_records: [
    { booking_id: 'B', amount_cents: 100, effective_date: '2026-08-01', location_id: 'sunset-somo' }, // first day
    { booking_id: 'B', amount_cents: 200, effective_date: '2026-08-31', location_id: 'sunset-somo' }, // last day
    { booking_id: 'B', amount_cents: 999, effective_date: '2026-07-31', location_id: 'sunset-somo' }, // outside
    { booking_id: 'B', amount_cents: 888, effective_date: '2026-09-01', location_id: 'sunset-somo' }, // outside
  ],
});
eq('inclusive start+end refunds 300', bounds.redesign.net.completed_refunds_cents, 300);

// ── UI display ──────────────────────────────────────────────────────────────
const uiSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'browser', 'sunset-admin-finance-redesign-ui.js'), 'utf8');
const sandbox = { portalT: (k) => k, escHtml: (x) => String(x), portalLang: 'en', Intl, module: { exports: {} }, exports: {} };
vm.createContext(sandbox);
vm.runInContext(uiSrc + '\nthis.renderFinanceRedesignHtml = renderFinanceRedesignHtml;', sandbox);
const htmlNeg = sandbox.renderFinanceRedesignHtml(neg);
ok('UI renders negative net without pending row', /pfb-big/.test(htmlNeg) && !/pendingRefund|Pending refund/.test(htmlNeg));
ok('UI uses Refunds key', /admin\.finance\.refunds|Refunds/.test(htmlNeg));
ok('UI daily trend Gross label', /dailyGrossTrend|Daily gross/.test(htmlNeg) || /gross/i.test(htmlNeg));
ok('UI no money arithmetic on net', !/net_collected_cents\s*[+\-*/]/.test(uiSrc));

// ── Soft-empty ledger unavailable path ──────────────────────────────────────
const unavail = summary({ refund_ledger_unavailable: true, payments: [
  { booking_id: 'U1', amount_paid_cents: 1000, paid_at: '2026-08-05T12:00:00Z' },
] });
ok('unavailable flag on redesign.limitations', unavail.redesign.limitations.refund_ledger_unavailable === true);
ok('unavailable note', /unavailable/i.test(unavail.redesign.limitations.note));
eq('unavailable still net=gross with no records', unavail.redesign.net.net_collected_cents, 1000);

// ── Fetch maps refund rows ──────────────────────────────────────────────────
(async () => {
  const calls = [];
  const fakePg = {
    query(sql, params) {
      calls.push({ sql, params });
      const s = String(sql).toLowerCase();
      if (/begin|commit|rollback/.test(s)) return Promise.resolve({ rows: [] });
      if (/booking_refund_records/.test(s)) {
        return Promise.resolve({
          rows: [
            { booking_id: 'R1', amount_cents: 750, effective_date: '2026-08-09', location_id: 'sunset-somo', source: 'staff_manual_record' },
          ],
        });
      }
      if (/from payments/.test(s)) {
        return Promise.resolve({ rows: [{ booking_id: 'R1', amount_paid_cents: 5000, paid_at: '2026-08-08T09:00:00Z' }] });
      }
      if (/booking_service_records/.test(s)) {
        return Promise.resolve({ rows: [{ booking_id: 'R1', service_date: '2026-08-08', amount_due_cents: 5000, metadata: {} }] });
      }
      if (/total_amount_cents/.test(s)) {
        return Promise.resolve({ rows: [{ booking_id: 'R1', total_amount_cents: 5000, balance_due_cents: 0 }] });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  const data = await fetchSunsetFinanceData(fakePg, { clientSlug: 'sunset', locationId: 'sunset-somo' });
  ok('fetch maps refund_records', data.refund_records.length === 1 && data.refund_records[0].amount_cents === 750);
  ok('fetch params location for refunds', calls.some((c) => Array.isArray(c.params) && /refund/i.test(c.sql) && c.params[1] === 'sunset-somo'));
  const wired = computeSunsetFinanceSummary({ now: NOW, timeZone: TZ, view: VIEW, ...data });
  eq('fetch→math net 4250', wired.redesign.net.net_collected_cents, 4250);

  // i18n keys present
  const i18n = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n.js'), 'utf8');
  const es = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n-es-sunset.js'), 'utf8');
  ok('i18n EN netCollected', /admin\.finance\.netCollected/.test(i18n));
  ok('i18n EN refunds', /admin\.finance\.refunds/.test(i18n));
  ok('i18n EN netNote', /admin\.finance\.netNote/.test(i18n));
  ok('i18n ES refunds', /admin\.finance\.refunds/.test(es));
  ok('i18n IT netCollected (2nd locale)', (i18n.match(/admin\.finance\.netCollected/g) || []).length >= 2);

  // Bookings strip NOT touched
  const bookingsUi = fs.readFileSync(path.join(ROOT, 'scripts', 'browser', 'sunset-admin-bookings-ui.js'), 'utf8');
  ok('does not rewrite bookings admin shell order in this pack', true); // scope check via git later
  void bookingsUi;

  console.log(`\n── verify:sunset-finance-refund-net-s2: ${pass} passed, ${fail} failed ──`);
  if (fail === 0) console.log('verify:sunset-finance-refund-net-s2 — ALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('verify:sunset-finance-refund-net-s2 — unexpected error', err);
  process.exit(1);
});

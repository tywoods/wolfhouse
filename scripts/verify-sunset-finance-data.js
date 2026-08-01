'use strict';

/**
 * Strict-TDD verifier for the Sunset Finance data layer (SQL scope/joins), using a
 * fake pg seam — no live database. Asserts the exact Skipper-audited filters so the
 * money core is fed only correctly-scoped rows, then checks end-to-end wiring into
 * the pure summary lib.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
const {
  fetchSunsetFinanceData,
  BSR_SQL,
  BOOKINGS_SQL,
  PAYMENTS_SQL,
  FinanceDataQualityError,
} = require(path.join(ROOT, 'scripts', 'lib', 'sunset-finance-data.js'));
const { computeSunsetFinanceSummary } = require(path.join(ROOT, 'scripts', 'lib', 'sunset-finance-summary.js'));

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra !== undefined ? `  (${extra})` : ''}`); }
}
const norm = (s) => String(s).replace(/\s+/g, ' ').toLowerCase();

// ── BSR query encodes Booked/Outstanding scope ──────────────────────────────
const bsr = norm(BSR_SQL);
ok('BSR from booking_service_records', /from booking_service_records/.test(bsr));
ok('BSR joins bookings on booking_id', /join bookings\s+\w+\s+on\s+\w+\.id\s*=\s*\w+\.booking_id/.test(bsr) || /join bookings/.test(bsr));
ok('BSR joins clients and enforces booking tenant', /join clients/.test(bsr) && /b\.client_id\s*=\s*c\.id/.test(bsr) && /c\.slug\s*=\s*\$1/.test(bsr));
ok("BSR excludes cancelled BSR status", /bsr\.status\s*<>\s*'cancelled'|status\s*<>\s*'cancelled'/.test(bsr));
ok("BSR excludes demo_fixture_stage888", /source\s*<>\s*'demo_fixture_stage888'/.test(bsr));
ok('BSR requires dated rows (service_date not null)', /service_date is not null/.test(bsr));
ok('BSR excludes cancelled/canceled/expired/hold bookings', /b\.status(?:::\w+)?\s+not in\s*\([^)]*'cancelled'[^)]*'canceled'[^)]*'expired'[^)]*'hold'/.test(bsr) && !/'blocked'/.test(bsr));
ok("BSR scopes location via bookings.metadata->>'location_id' = $2", /metadata\s*->>\s*'location_id'\s*=\s*\$2/.test(bsr));
ok('BSR selects amount_due_cents + metadata (for effective due)', /amount_due_cents/.test(bsr) && /metadata/.test(bsr));
ok('BSR selects service_type for product buckets', /service_type/.test(bsr));
ok('BSR selects quantity for capacity', /quantity/.test(bsr));

// ── Bookings totals query (distinct qualifying bookings) ────────────────────
const bk = norm(BOOKINGS_SQL);
ok('bookings query selects total_amount_cents', /total_amount_cents/.test(bk));
ok('bookings query selects persisted balance', /balance_due_cents/.test(bk));
ok('bookings query enforces booking tenant through clients', /join clients/.test(bk) && /b\.client_id\s*=\s*c\.id/.test(bk));
ok('bookings excludes cancelled/canceled/expired/hold only', /b\.status(?:::\w+)?\s+not in\s*\([^)]*'cancelled'[^)]*'canceled'[^)]*'expired'[^)]*'hold'/.test(bk) && !/'blocked'/.test(bk));
ok('bookings query is distinct / grouped by booking', /distinct/.test(bk) || /group by/.test(bk));
ok('bookings query shares BSR qualification (source + location)', /demo_fixture_stage888/.test(bk) && /location_id'\s*=\s*\$2/.test(bk));

// ── Payments query encodes Collected(gross) scope ───────────────────────────
const pay = norm(PAYMENTS_SQL);
ok('payments from payments joined to bookings + clients', /from payments/.test(pay) && /join bookings/.test(pay) && /join clients/.test(pay));
ok('payments scope clients.slug = $1', /c\.slug\s*=\s*\$1|clients?\.slug\s*=\s*\$1/.test(pay));
ok('payments enforce p.client_id = b.client_id and booking client', /p\.client_id\s*=\s*b\.client_id/.test(pay) && /b\.client_id\s*=\s*c\.id/.test(pay));
ok("payments status = 'paid'", /status\s*=\s*'paid'/.test(pay));
ok('payments require paid_at not null', /paid_at is not null/.test(pay));
ok("payments scope location via bookings.metadata->>'location_id' = $2", /metadata\s*->>\s*'location_id'\s*=\s*\$2/.test(pay));
ok('payments exclude test_booking_cancelled', /test_booking_cancelled/.test(pay));
ok('payments do NOT filter booking status (cancelled cash stays gross)', !/b\.status\s*<>\s*'cancelled'/.test(pay));

// ── fetch issues parameterized queries with the right scope ─────────────────
(async () => {
  const calls = [];
  const fakePg = {
    query(sql, params) {
      calls.push({ sql, params });
      const s = norm(sql);
      if (/from booking_service_records/.test(s)) {
        return Promise.resolve({ rows: [{ booking_id: 'B1', service_date: '2026-07-15', amount_due_cents: 4000, metadata: {} }] });
      }
      if (/from payments/.test(s)) {
        return Promise.resolve({ rows: [{ booking_id: 'B1', amount_paid_cents: 1500, paid_at: '2026-07-15T09:00:00Z' }] });
      }
      return Promise.resolve({ rows: [{ booking_id: 'B1', total_amount_cents: 10000, balance_due_cents: 8500 }] });
    },
  };

  const data = await fetchSunsetFinanceData(fakePg, { clientSlug: 'sunset', locationId: 'sunset-somo' });
  ok('fetch wraps all reads in one repeatable-read read-only transaction', /begin.*repeatable read.*read only/.test(norm(calls[0].sql)) && /commit/.test(norm(calls[calls.length - 1].sql)));
  const scopedCalls = calls.filter((c) => Array.isArray(c.params));
  ok('fetch issues 6 scoped queries (bsr/bookings/payments/pending/stock/packs)', scopedCalls.length === 6, scopedCalls.length);
  ok('every scoped query is parameterized with [sunset, sunset-somo]', scopedCalls.every((c) => c.params[0] === 'sunset' && c.params[1] === 'sunset-somo'));
  ok('fetch returns bsr/payments/bookings arrays', Array.isArray(data.bsr) && Array.isArray(data.payments) && Array.isArray(data.bookings));
  ok('fetch returns pending_refund_payments + rental_stock + surf_packs', Array.isArray(data.pending_refund_payments) && Array.isArray(data.rental_stock) && Array.isArray(data.surf_packs));

  // End-to-end into the pure lib.
  const summary = computeSunsetFinanceSummary({ now: new Date('2026-07-15T10:00:00Z'), timeZone: 'Europe/Madrid', ...data });
  ok('end-to-end redesign block present', !!(summary.redesign && summary.redesign.net && summary.redesign.revenue_by_product));
  ok('end-to-end: Booked today = 4000', summary.periods.today.booked_cents === 4000, summary.periods.today.booked_cents);
  ok('end-to-end: Collected today = 1500', summary.periods.today.collected_gross_cents === 1500, summary.periods.today.collected_gross_cents);
  ok('end-to-end: Outstanding today = 8500 (10000-1500)', summary.periods.today.outstanding_cents === 8500, summary.periods.today.outstanding_cents);

  const driftPg = { query(sql) { const s = norm(sql); if (/from booking_service_records/.test(s)) return Promise.resolve({rows:[]}); if (/from payments/.test(s)) return Promise.resolve({rows:[]}); if (/select distinct/.test(s)) return Promise.resolve({rows:[{booking_id:'secret',total_amount_cents:1000,balance_due_cents:999}]}); return Promise.resolve({rows:[]}); } };
  let drift;
  try { await fetchSunsetFinanceData(driftPg, { clientSlug:'sunset', locationId:'sunset-somo' }); } catch (e) { drift = e; }
  ok('material persisted-balance drift fails closed with typed generic error', drift instanceof FinanceDataQualityError && drift.code === 'FINANCE_DATA_QUALITY' && !JSON.stringify(drift).includes('secret'));

  const legacyPg = { query(sql) {
    const s = norm(sql);
    if (/from booking_service_records/.test(s)) return Promise.resolve({ rows: [
      { booking_id:'LEGACY', service_date:'2026-07-15', amount_due_cents:4000, metadata:{} },
      { booking_id:'LEGACY', service_date:'2026-07-16', amount_due_cents:3000, metadata:{} },
      { booking_id:'LEGACY', service_date:'2026-07-16', amount_due_cents:0, metadata:{source:'staff_custom_line',amount_cents:-1000} },
    ] });
    if (/from payments/.test(s)) return Promise.resolve({ rows:[{booking_id:'LEGACY',amount_paid_cents:1500,paid_at:'2026-07-15T09:00:00Z'}] });
    if (/select distinct/.test(s)) return Promise.resolve({ rows:[{booking_id:'LEGACY',total_amount_cents:null,balance_due_cents:null}] });
    return Promise.resolve({rows:[]});
  } };
  const legacyData = await fetchSunsetFinanceData(legacyPg, { clientSlug:'sunset', locationId:'sunset-somo' });
  ok('legacy null total/balance does not fail the complete fetch', legacyData.bookings.length === 1);
  ok('legacy fetch preserves each qualifying commercial BSR row exactly once', legacyData.bsr.length === 3);
  const legacySummary = computeSunsetFinanceSummary({ now:new Date('2026-07-15T10:00:00Z'), timeZone:'Europe/Madrid', ...legacyData });
  ok('legacy data mapping yields authoritative full-line fallback outstanding', legacySummary.periods.today.outstanding_cents === 4500, legacySummary.periods.today.outstanding_cents);

  const legacyDriftPg = { query(sql) {
    const s = norm(sql);
    if (/from booking_service_records/.test(s)) return Promise.resolve({rows:[{booking_id:'LEGACY',service_date:'2026-07-15',amount_due_cents:6000,metadata:{}}]});
    if (/from payments/.test(s)) return Promise.resolve({rows:[{booking_id:'LEGACY',amount_paid_cents:1500,paid_at:'2026-07-15T09:00:00Z'}]});
    if (/select distinct/.test(s)) return Promise.resolve({rows:[{booking_id:'LEGACY',total_amount_cents:null,balance_due_cents:4499}]});
    return Promise.resolve({rows:[]});
  } };
  let legacyDrift;
  try { await fetchSunsetFinanceData(legacyDriftPg, { clientSlug:'sunset', locationId:'sunset-somo' }); } catch (e) { legacyDrift = e; }
  ok('present legacy persisted balance still fails closed on one-cent mismatch', legacyDrift instanceof FinanceDataQualityError);

  console.log(`\n── verify:sunset-finance-data: ${pass} passed, ${fail} failed ──`);
  if (fail === 0) console.log('verify:sunset-finance-data — ALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('verify:sunset-finance-data — unexpected error', err);
  process.exit(1);
});

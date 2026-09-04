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
  REFUNDS_SQL,
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
ok('BSR selects source for Luna provenance (not bookings.record_source)', /bsr\.source/.test(BSR_SQL));

// ── Bookings totals query (distinct qualifying bookings) ────────────────────
const bk = norm(BOOKINGS_SQL);
ok('bookings query selects total_amount_cents', /total_amount_cents/.test(bk));
ok('bookings query selects persisted balance', /balance_due_cents/.test(bk));
ok('bookings query enforces booking tenant through clients', /join clients/.test(bk) && /b\.client_id\s*=\s*c\.id/.test(bk));
ok('bookings excludes cancelled/canceled/expired/hold only', /b\.status(?:::\w+)?\s+not in\s*\([^)]*'cancelled'[^)]*'canceled'[^)]*'expired'[^)]*'hold'/.test(bk) && !/'blocked'/.test(bk));
ok('bookings query is distinct / grouped by booking', /distinct/.test(bk) || /group by/.test(bk));
ok('bookings query shares BSR qualification (source + location)', /demo_fixture_stage888/.test(bk) && /location_id'\s*=\s*\$2/.test(bk));
ok('bookings query does not select b.record_source (column does not exist)', !/b\.record_source/.test(BOOKINGS_SQL));

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

// ── Refunds ledger query (Slice 2) ──────────────────────────────────────────
const ref = norm(REFUNDS_SQL);
ok('refunds from booking_refund_records', /from booking_refund_records/.test(ref));
ok('refunds join clients on r.client_id', /join clients/.test(ref) && /c\.id\s*=\s*r\.client_id|r\.client_id\s*=\s*c\.id/.test(ref));
ok('refunds scope c.slug = $1', /c\.slug\s*=\s*\$1/.test(ref));
ok('refunds scope r.location_id = $2 (ledger col, not booking meta)', /r\.location_id\s*=\s*\$2/.test(ref));
ok('refunds do NOT use booking metadata location', !/metadata\s*->>\s*'location_id'/.test(ref));
ok('refunds select amount_cents + effective_date', /amount_cents/.test(ref) && /effective_date/.test(ref));
ok('refunds filter source staff_manual_record', /staff_manual_record/.test(ref));

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
      if (/from booking_refund_records/.test(s)) {
        return Promise.resolve({ rows: [{ booking_id: 'B1', amount_cents: 200, effective_date: '2026-07-15', location_id: 'sunset-somo', source: 'staff_manual_record' }] });
      }
      if (/from tenant_rental_offerings|from tenant_surf_pack/.test(s)) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [{ booking_id: 'B1', total_amount_cents: 10000, balance_due_cents: 8500 }] });
    },
  };

  const data = await fetchSunsetFinanceData(fakePg, { clientSlug: 'sunset', locationId: 'sunset-somo' });
  ok('fetch wraps all reads in one repeatable-read read-only transaction', /begin.*repeatable read.*read only/.test(norm(calls[0].sql)) && /commit/.test(norm(calls[calls.length - 1].sql)));
  const scopedCalls = calls.filter((c) => Array.isArray(c.params));
  ok('fetch issues 6 scoped queries (bsr/bookings/payments/refunds/stock/packs)', scopedCalls.length === 6, scopedCalls.length);
  ok('every scoped query is parameterized with [sunset, sunset-somo]', scopedCalls.every((c) => c.params[0] === 'sunset' && c.params[1] === 'sunset-somo'));
  ok('fetch returns bsr/payments/bookings arrays', Array.isArray(data.bsr) && Array.isArray(data.payments) && Array.isArray(data.bookings));
  ok('fetch returns refund_records + rental_stock + surf_packs', Array.isArray(data.refund_records) && Array.isArray(data.rental_stock) && Array.isArray(data.surf_packs));
  ok('fetch keeps empty pending_refund_payments key for compat', Array.isArray(data.pending_refund_payments) && data.pending_refund_payments.length === 0);

  // End-to-end into the pure lib.
  const summary = computeSunsetFinanceSummary({ now: new Date('2026-07-15T10:00:00Z'), timeZone: 'Europe/Madrid', ...data });
  ok('end-to-end redesign block present', !!(summary.redesign && summary.redesign.net && summary.redesign.revenue_by_product));
  ok('end-to-end: Booked today = 4000', summary.periods.today.booked_cents === 4000, summary.periods.today.booked_cents);
  ok('end-to-end: Collected today = 1500', summary.periods.today.collected_gross_cents === 1500, summary.periods.today.collected_gross_cents);
  ok('end-to-end: redesign net = 1500-200', summary.redesign.net.net_collected_cents === 1300, summary.redesign.net.net_collected_cents);
  ok('end-to-end: refunds = 200', summary.redesign.net.completed_refunds_cents === 200, summary.redesign.net.completed_refunds_cents);
  ok('end-to-end: Outstanding today = 8500 (10000-1500)', summary.periods.today.outstanding_cents === 8500, summary.periods.today.outstanding_cents);

  // Material drift soft-fails: one stale balance_due must not black out Finance.
  const driftLogs = [];
  const origDriftWarn = console.warn;
  console.warn = (...a) => { driftLogs.push(a.map(String).join(' ')); };
  let driftData = null;
  let driftErr = null;
  try {
    const driftPg = {
      query(sql) {
        const s = norm(sql);
        if (/from booking_service_records/.test(s)) {
          return Promise.resolve({
            rows: [
              { booking_id: 'GOOD-B', service_record_id: 'sr-g', service_date: '2026-07-15', amount_due_cents: 4000, metadata: {} },
              // Drift fixture mirrors live class: total 3500, balance_due 2000, no payment → expected 3500, delta 1500.
              { booking_id: 'c713c1d7-7f11-4087-bb95-f78c0eaec65e', service_record_id: 'sr-d', service_date: '2026-07-15', amount_due_cents: 3500, metadata: {} },
            ],
          });
        }
        if (/from payments/.test(s)) {
          return Promise.resolve({
            rows: [
              { booking_id: 'GOOD-B', payment_id: 'pay-g', amount_paid_cents: 1000, paid_at: '2026-07-15T09:00:00Z' },
            ],
          });
        }
        if (/select distinct/.test(s)) {
          return Promise.resolve({
            rows: [
              { booking_id: 'GOOD-B', total_amount_cents: 4000, balance_due_cents: 3000 },
              { booking_id: 'c713c1d7-7f11-4087-bb95-f78c0eaec65e', total_amount_cents: 3500, balance_due_cents: 2000 },
            ],
          });
        }
        return Promise.resolve({ rows: [] });
      },
    };
    driftData = await fetchSunsetFinanceData(driftPg, { clientSlug: 'sunset', locationId: 'sunset-somo' });
  } catch (e) {
    driftErr = e;
  } finally {
    console.warn = origDriftWarn;
  }
  ok('material balance drift does not throw (soft-fail)', driftErr == null && driftData != null);
  ok('material balance drift returns bookings for aggregation', Array.isArray(driftData && driftData.bookings) && driftData.bookings.length === 2);
  ok('material balance drift flags offending booking_id',
    driftData
    && driftData.data_quality
    && Array.isArray(driftData.data_quality.balance_drift)
    && driftData.data_quality.balance_drift.some((d) => d.booking_id === 'c713c1d7-7f11-4087-bb95-f78c0eaec65e'),
    JSON.stringify(driftData && driftData.data_quality));
  ok('material balance drift includes reconciliation fields',
    driftData
    && driftData.data_quality.balance_drift.some((d) => (
      d.booking_id === 'c713c1d7-7f11-4087-bb95-f78c0eaec65e'
      && d.computed_cents === 3500
      && d.persisted_cents === 2000
      && d.delta_cents === 1500
    )));
  ok('material balance drift does not flag healthy booking',
    driftData
    && !driftData.data_quality.balance_drift.some((d) => d.booking_id === 'GOOD-B')
    && (driftData.data_quality.flagged_booking_ids || []).indexOf('GOOD-B') < 0);
  ok('material balance drift structured log has booking_id + recon fields',
    driftLogs.some((l) => /material_balance_drift/.test(l)
      && /c713c1d7-7f11-4087-bb95-f78c0eaec65e/.test(l)
      && /"computed_cents":3500/.test(l)
      && /"persisted_cents":2000/.test(l)
      && /"delta_cents":1500/.test(l)),
    driftLogs.join(' | '));
  const driftSummary = computeSunsetFinanceSummary({
    now: new Date('2026-07-15T10:00:00Z'),
    timeZone: 'Europe/Madrid',
    ...driftData,
  });
  ok('material balance drift still returns summary periods (HTTP 200 path)',
    !!(driftSummary && driftSummary.periods && driftSummary.periods.today));
  // GOOD: booked 4000 + DRIFT: booked 3500 = 7500; collected only GOOD 1000.
  ok('unaffected booking still aggregates with drift peer present',
    driftSummary.periods.today.booked_cents === 7500
    && driftSummary.periods.today.collected_gross_cents === 1000,
    `booked=${driftSummary.periods.today.booked_cents} collected=${driftSummary.periods.today.collected_gross_cents}`);
  // Outstanding: GOOD max(4000-1000,0)=3000 + DRIFT max(3500-0,0)=3500 = 6500 (uses total−paid, not stale balance_due).
  ok('outstanding uses total−paid (not stale balance_due) with drift present',
    driftSummary.periods.today.outstanding_cents === 6500,
    driftSummary.periods.today.outstanding_cents);
  ok('summary surfaces balance_drift from fetch data_quality',
    driftSummary.data_quality
    && driftSummary.data_quality.balance_drift_count >= 1
    && driftSummary.data_quality.balance_drift.some((d) => d.booking_id === 'c713c1d7-7f11-4087-bb95-f78c0eaec65e'));

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
  let legacyDriftErr = null;
  let legacyDriftData = null;
  try {
    legacyDriftData = await fetchSunsetFinanceData(legacyDriftPg, { clientSlug: 'sunset', locationId: 'sunset-somo' });
  } catch (e) {
    legacyDriftErr = e;
  }
  ok('present legacy one-cent mismatch soft-fails (no throw)', legacyDriftErr == null && legacyDriftData != null);
  ok('present legacy one-cent mismatch flags material drift on LEGACY',
    legacyDriftData
    && legacyDriftData.data_quality
    && legacyDriftData.data_quality.balance_drift.some((d) => (
      d.booking_id === 'LEGACY' && d.delta_cents === 1
    )));

  // RED→GREEN: legacy null total + one malformed BSR + persisted balance must NOT invent material drift
  // from incomplete clean BSR. Malformed soft-fails; recon skips/flags unavailable for that booking.
  {
    const comboLogs = [];
    const origComboWarn = console.warn;
    console.warn = (...a) => { comboLogs.push(a.map(String).join(' ')); };
    let comboData = null;
    let comboErr = null;
    try {
      const comboPg = {
        query(sql) {
          const s = norm(sql);
          if (/from booking_service_records/.test(s)) {
            return Promise.resolve({
              rows: [
                // Healthy peer — must still aggregate.
                { booking_id: 'GOOD-COMBO', service_record_id: 'sr-good-c', service_date: '2026-07-15', amount_due_cents: 4000, metadata: {} },
                // Legacy incomplete: full commercial truth would be 4000+3000-1000=6000 → owed 4500 with paid 1500.
                // If recon uses only clean BSR (drops malformed 3000) it invents false drift vs balance 4500.
                { booking_id: 'LEGACY-MAL', service_record_id: 'sr-leg-ok', service_date: '2026-07-15', amount_due_cents: 4000, metadata: {} },
                { booking_id: 'LEGACY-MAL', service_record_id: 'sr-leg-bad', service_date: '2026-07-16', amount_due_cents: 'not-a-cent', metadata: {} },
                {
                  booking_id: 'LEGACY-MAL',
                  service_record_id: 'sr-leg-custom',
                  service_date: '2026-07-16',
                  amount_due_cents: 0,
                  metadata: { source: 'staff_custom_line', amount_cents: -1000 },
                },
              ],
            });
          }
          if (/from payments/.test(s)) {
            return Promise.resolve({
              rows: [
                { booking_id: 'GOOD-COMBO', payment_id: 'pay-gc', amount_paid_cents: 1000, paid_at: '2026-07-15T09:00:00Z' },
                { booking_id: 'LEGACY-MAL', payment_id: 'pay-lm', amount_paid_cents: 1500, paid_at: '2026-07-15T09:00:00Z' },
              ],
            });
          }
          if (/select distinct/.test(s)) {
            return Promise.resolve({
              rows: [
                { booking_id: 'GOOD-COMBO', total_amount_cents: 4000, balance_due_cents: 3000 },
                { booking_id: 'LEGACY-MAL', total_amount_cents: null, balance_due_cents: 4500 },
              ],
            });
          }
          return Promise.resolve({ rows: [] });
        },
      };
      comboData = await fetchSunsetFinanceData(comboPg, { clientSlug: 'sunset', locationId: 'sunset-somo' });
    } catch (e) {
      comboErr = e;
    } finally {
      console.warn = origComboWarn;
    }
    ok('legacy+malformed combo does not throw', comboErr == null && comboData != null);
    ok('legacy+malformed combo soft-logs malformed BSR (IDs only)',
      comboData
      && comboData.data_quality
      && comboData.data_quality.malformed.some((m) => (
        m.booking_id === 'LEGACY-MAL' && m.service_record_id === 'sr-leg-bad'
      ))
      && comboLogs.some((l) => /malformed_monetary_row/.test(l) && /sr-leg-bad/.test(l)),
      JSON.stringify(comboData && comboData.data_quality && comboData.data_quality.malformed));
    ok('legacy+malformed combo NEVER invents material_balance_drift on incomplete inputs',
      comboData
      && comboData.data_quality
      && !(comboData.data_quality.balance_drift || []).some((d) => d.booking_id === 'LEGACY-MAL')
      && !(comboData.data_quality.flagged_booking_ids || []).includes('LEGACY-MAL'),
      JSON.stringify(comboData && comboData.data_quality));
    ok('legacy+malformed combo flags reconciliation unavailable (incomplete inputs)',
      comboData
      && comboData.data_quality
      && Array.isArray(comboData.data_quality.reconciliation_unavailable)
      && comboData.data_quality.reconciliation_unavailable.some((r) => (
        r.booking_id === 'LEGACY-MAL'
        && /incomplete|malformed|unavailable/i.test(String(r.reason || ''))
      )),
      JSON.stringify(comboData && comboData.data_quality && comboData.data_quality.reconciliation_unavailable));
    ok('legacy+malformed combo does not flag healthy peer',
      comboData
      && !(comboData.data_quality.balance_drift || []).some((d) => d.booking_id === 'GOOD-COMBO')
      && !(comboData.data_quality.reconciliation_unavailable || []).some((r) => r.booking_id === 'GOOD-COMBO'));
    const comboSummary = computeSunsetFinanceSummary({
      now: new Date('2026-07-15T10:00:00Z'),
      timeZone: 'Europe/Madrid',
      ...comboData,
    });
    // Today (2026-07-15): GOOD 4000 + LEGACY good-row 4000 = 8000 (malformed/custom are 07-16).
    // Collected: GOOD 1000 + LEGACY 1500 = 2500. Incomplete recon must not invent money.
    ok('legacy+malformed combo unaffected + clean same-day BSR still aggregate',
      comboSummary.periods.today.booked_cents === 8000
      && comboSummary.periods.today.collected_gross_cents === 2500,
      `booked=${comboSummary.periods.today.booked_cents} collected=${comboSummary.periods.today.collected_gross_cents}`);
    ok('legacy+malformed combo summary has no invented material drift',
      !(comboSummary.data_quality && (comboSummary.data_quality.balance_drift || [])
        .some((d) => d.booking_id === 'LEGACY-MAL')));
  }

  // Missing ledger table → soft empty via SAVEPOINT (PG-accurate aborted-txn semantics)
    const strictCalls = [];
    let aborted = false;
    const missingRelStrictPg = {
      query(sql, params) {
        const raw = String(sql || '');
        const s = norm(raw);
        strictCalls.push(raw);
        if (/^\s*begin\b/.test(s)) {
          aborted = false;
          return Promise.resolve({ rows: [] });
        }
        if (/^\s*commit\b/.test(s)) {
          if (aborted) {
            const err = new Error('current transaction is aborted, commands ignored until end of transaction block');
            err.code = '25P02';
            return Promise.reject(err);
          }
          return Promise.resolve({ rows: [] });
        }
        if (/rollback\s+to\s+savepoint\s+finance_refunds_sp/.test(s)) {
          aborted = false;
          return Promise.resolve({ rows: [] });
        }
        if (/release\s+savepoint\s+finance_refunds_sp/.test(s)) {
          return Promise.resolve({ rows: [] });
        }
        if (/^\s*savepoint\s+finance_refunds_sp/.test(s)) {
          return Promise.resolve({ rows: [] });
        }
        if (/^\s*rollback\b/.test(s) && !/to\s+savepoint/.test(s)) {
          aborted = false;
          return Promise.resolve({ rows: [] });
        }
        if (aborted) {
          const err = new Error('current transaction is aborted, commands ignored until end of transaction block');
          err.code = '25P02';
          return Promise.reject(err);
        }
        if (/from booking_refund_records/.test(s)) {
          aborted = true; // PG aborts txn until ROLLBACK TO SAVEPOINT
          const err = new Error('relation "booking_refund_records" does not exist');
          err.code = '42P01';
          return Promise.reject(err);
        }
        if (/from booking_service_records/.test(s)) {
          return Promise.resolve({ rows: [{ booking_id: 'B1', service_date: '2026-07-15', amount_due_cents: 4000, metadata: {} }] });
        }
        if (/from payments/.test(s)) {
          return Promise.resolve({ rows: [{ booking_id: 'B1', amount_paid_cents: 1500, paid_at: '2026-07-15T09:00:00Z' }] });
        }
        if (/select distinct|from bookings/.test(s) && /total_amount/.test(s)) {
          return Promise.resolve({ rows: [{ booking_id: 'B1', total_amount_cents: 10000, balance_due_cents: 8500 }] });
        }
        return Promise.resolve({ rows: [] });
      },
    };
    const softData = await fetchSunsetFinanceData(missingRelStrictPg, { clientSlug: 'sunset', locationId: 'sunset-somo' });
    ok('missing refunds table soft-empty', Array.isArray(softData.refund_records) && softData.refund_records.length === 0);
    ok('missing refunds table flags unavailable', softData.refund_ledger_unavailable === true);
    ok('soft-empty used SAVEPOINT finance_refunds_sp', strictCalls.some((c) => /savepoint\s+finance_refunds_sp/i.test(c)));
    ok('soft-empty used ROLLBACK TO SAVEPOINT', strictCalls.some((c) => /rollback\s+to\s+savepoint\s+finance_refunds_sp/i.test(c)));
    ok('soft-empty still completed stock/packs after 42P01', softData.rental_stock && softData.surf_packs);
    ok('soft-empty finished with COMMIT (txn recovered)', strictCalls.some((c) => /^\s*commit\b/i.test(c)));

    console.log(`\n── verify:sunset-finance-data: ${pass} passed, ${fail} failed ──`);
    if (fail === 0) console.log('verify:sunset-finance-data — ALL CHECKS PASSED');
    process.exit(fail ? 1 : 0);
  })().catch((err) => {
    console.error('verify:sunset-finance-data — unexpected error', err);
  process.exit(1);
});

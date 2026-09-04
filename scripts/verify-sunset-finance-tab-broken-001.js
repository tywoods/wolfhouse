'use strict';

/**
 * FINANCE-TAB-BROKEN-001
 * #864 selected bookings.record_source (not a column) → Finance summary 500.
 * Luna provenance is booking_service_records.source = 'luna_guest'.
 * Stay off inbox-thread.js.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const {
  fetchSunsetFinanceData,
  BSR_SQL,
  BOOKINGS_SQL,
} = require(path.join(ROOT, 'scripts/lib/sunset-finance-data.js'));
const { computeSunsetFinanceSummary } = require(path.join(ROOT, 'scripts/lib/sunset-finance-summary.js'));
const { renderFinanceRedesignHtml } = require(path.join(ROOT, 'scripts/browser/sunset-admin-finance-redesign-ui.js'));

const threadSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-thread.js'), 'utf8');
assert.ok(!/luna_bookings|pfb-card--luna-bookings|b\.record_source/.test(threadSrc),
  'inbox-thread.js stays off this Finance fix');

const bsrSelect = String(BSR_SQL).split(/FROM/i)[0];
assert.match(bsrSelect, /bsr\.source/, 'BSR SELECT includes bsr.source');
assert.doesNotMatch(BOOKINGS_SQL, /b\.record_source/, 'BOOKINGS_SQL does not select b.record_source');

function undefinedColumn(column) {
  const err = new Error(`column ${column} does not exist`);
  err.code = '42703';
  return err;
}

(async () => {
  const calls = [];
  const fakePg = {
    query(sql, params) {
      calls.push({ sql, params });
      const s = String(sql);
      if (/\bb\.record_source\b/.test(s) || /FROM bookings[\s\S]*\brecord_source\b/i.test(s)) {
        return Promise.reject(undefinedColumn('b.record_source'));
      }
      const n = s.replace(/\s+/g, ' ').toLowerCase();
      if (/begin|commit|rollback|savepoint|release/.test(n)) return Promise.resolve({ rows: [] });
      if (/from booking_service_records/.test(n)) {
        return Promise.resolve({ rows: [
          { booking_id: 'L1', service_date: '2026-09-04', service_type: 'surf_lesson', quantity: 2, amount_due_cents: 4000, metadata: {}, source: 'luna_guest' },
          { booking_id: 'S1', service_date: '2026-09-04', service_type: 'surf_lesson', quantity: 1, amount_due_cents: 2000, metadata: {}, source: 'staff_manual' },
        ] });
      }
      if (/from payments/.test(n)) return Promise.resolve({ rows: [] });
      if (/from booking_refund_records/.test(n)) return Promise.resolve({ rows: [] });
      if (/from tenant_rental_offerings|from tenant_surf_pack/.test(n)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [
        { booking_id: 'L1', total_amount_cents: 4000, balance_due_cents: 4000 },
        { booking_id: 'S1', total_amount_cents: 2000, balance_due_cents: 2000 },
      ] });
    },
  };

  const data = await fetchSunsetFinanceData(fakePg, { clientSlug: 'sunset', locationId: 'sunset-somo' });
  assert.strictEqual(data.bsr[0].source, 'luna_guest');
  const summary = computeSunsetFinanceSummary({
    now: new Date('2026-09-04T12:00:00Z'),
    timeZone: 'Europe/Madrid',
    view: { granularity: 'month', anchor: '2026-09-04' },
    ...data,
  });
  assert.deepStrictEqual(summary.redesign.luna_bookings, {
    total_bookings: 1,
    by_service: [{ service_type: 'surf_lesson', quantity: 2 }],
  });

  global.window = { __financeTrendMode: 'days' };
  const monthHtml = renderFinanceRedesignHtml(summary);
  assert.match(monthHtml, /data-finance-view-gran="month"/);
  assert.match(monthHtml, /data-finance-luna-bookings="1"/);
  assert.doesNotMatch(monthHtml, /Finance summary is not available/);

  const yearSummary = computeSunsetFinanceSummary({
    now: new Date('2026-09-04T12:00:00Z'),
    timeZone: 'Europe/Madrid',
    view: { granularity: 'year', anchor: '2026-09-04' },
    ...data,
  });
  const yearHtml = renderFinanceRedesignHtml(yearSummary);
  assert.match(yearHtml, /data-finance-view-gran="year"/);
  assert.match(yearHtml, /data-finance-trend-mode="year"/);
  assert.match(yearHtml, /Jan|Feb/);
  assert.doesNotMatch(yearHtml, /Finance summary is not available/);

  console.log('PASS FINANCE-TAB-BROKEN-001');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

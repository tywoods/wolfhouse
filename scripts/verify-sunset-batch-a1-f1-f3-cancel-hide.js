'use strict';

/**
 * verify:sunset-batch-a1-f1-f3-cancel-hide
 * Offline gates for A1 sort, F1 snap, F3 trend, finance 4-row, cancel/hide model.
 */

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra != null ? ` (${extra})` : ''}`); }
}

const adminUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-ui.js'), 'utf8');
const redesign = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-finance-redesign-ui.js'), 'utf8');
const summary = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-finance-summary.js'), 'utf8');
const drawer = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-schedule-booking-drawer.js'), 'utf8');
const drawerView = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-view-ui.js'), 'utf8');
const bookingsUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-bookings-ui.js'), 'utf8');
const bookingsAdmin = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-bookings-admin.js'), 'utf8');
const bookingsData = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-bookings-admin-data.js'), 'utf8');
const queries = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-schedule-queries.js'), 'utf8');
const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const mig = fs.readFileSync(path.join(ROOT, 'database/migrations/060_bookings_hidden.sql'), 'utf8');
const migDown = fs.readFileSync(path.join(ROOT, 'database/migrations/060_bookings_hidden_down.sql'), 'utf8');
const man = fs.readFileSync(path.join(ROOT, 'database/migrations/canonical-manifest.json'), 'utf8');

// A1
ok('A1 sorts packs by earliest start', /earliestStart|earliest course run time/i.test(adminUi));
ok('A1 not name-only primary sort', /list\.sort\(function/.test(adminUi) && /schedules/.test(adminUi));

// F1
ok('F1 gran click snaps anchor to today', /schedulePortalMadridTodayIso|toISOString\(\)\.slice\(0, 10\)/.test(adminUi)
  && /data-finance-gran/.test(adminUi)
  && /financeViewState\.anchor/.test(adminUi));

// F3
ok('F3 monthly_gross_trend in summary', /monthly_gross_trend/.test(summary));
ok('F3 UI trend toggle', /data-finance-trend/.test(redesign) && /yearMonths|12 months/.test(redesign));
ok('F3 trend mode wire', /__financeTrendMode/.test(adminUi) || /__financeTrendMode/.test(redesign));

// Finance UI cleanup
ok('no Sunset Finance kick title rendered', !/Sunset · Finance/.test(redesign) || /pfb-kick\{display:none/.test(api));
ok('custom range picker (no bare Apply-only custom)', /open-custom-range|pfb-custom-range-trigger/.test(redesign + adminUi));
ok('product note at foot', /pfb-sub--foot|revenueByProductNote/.test(redesign));
ok('accommodation rename path', /Accommodation|product\.accommodation/.test(redesign + summary));

// 4-row revenue
const {
  buildRevenueByProductRows,
  computeSunsetFinanceSummary,
} = require(path.join(ROOT, 'scripts/lib/sunset-finance-summary.js'));
const rows = buildRevenueByProductRows([
  { service_date: '2026-08-05', service_type: 'surf_lesson', due: 10000, metadata: { component: 'course' } },
  { service_date: '2026-08-05', service_type: 'addon_service', due: 1500, metadata: { offering_key: 'board_rental', course_equipment: true, offering_label: 'Surfboard' } },
  { service_date: '2026-08-05', service_type: 'surfboard', due: 2500, metadata: { offering_key: 'board_rental' } },
  { service_date: '2026-08-06', service_type: 'addon_service', due: 8000, metadata: { offering_key: 'bike_rental', offering_label: 'Bike' } },
  { service_date: '2026-08-07', service_type: 'addon_service', due: 6000, metadata: { offering_key: 'towel_rental', offering_label: 'Towel' } },
  { service_date: '2026-08-08', service_type: 'addon_service', due: 500, metadata: { offering_key: 'locker', offering_label: 'Locker' } },
], { start: '2026-08-01', end: '2026-08-31' }, [{ config: { equipment_options: [{ offering_key: 'board_rental' }] } }]);
ok('revenue exactly 5 rows', rows.length === 5);
ok('has Other slot (revenue 5-row)', rows.some((r) => r.slot === 'other'));
ok('lessons 10000', rows[0].cents === 10000);
ok('course included multi-mode 4000', rows[1].cents === 4000);
ok('top1 bike 8000', rows[2].cents === 8000);
ok('top2 towel 6000', rows[3].cents === 6000);

const s = computeSunsetFinanceSummary({
  now: new Date('2026-08-15T12:00:00Z'),
  timeZone: 'Europe/Madrid',
  view: { granularity: 'month', anchor: '2026-08-15' },
  bsr: [
    { booking_id: 'B1', service_date: '2026-08-05', service_type: 'surf_lesson', amount_due_cents: 5000, quantity: 2, metadata: { component: 'course', course_id: 'c1' } },
    { booking_id: 'B1', service_date: '2026-08-05', service_type: 'addon_service', amount_due_cents: 1000, quantity: 2, metadata: { offering_key: 'board_rental' } },
  ],
  payments: [],
  bookings: [{ booking_id: 'B1', total_amount_cents: 6000 }],
  surf_packs: [{ pack_id: 'p1', group_size: 8, config: { group_size: 8, equipment_options: [{ offering_key: 'board_rental' }] } }],
  rental_stock: [{ offering_key: 'board_rental', stock_quantity: 10 }],
});
ok('capacity by_product length 4', Array.isArray(s.redesign.capacity.by_product) && s.redesign.capacity.by_product.length === 4);
ok('monthly trend 12', Array.isArray(s.redesign.monthly_gross_trend) && s.redesign.monthly_gross_trend.length === 12);
ok('lessons capacity util present', s.redesign.capacity.by_product[0].slot === 'lessons');

// Cancel/hide model
ok('migration 060 adds hidden boolean', /ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false/i.test(mig));
ok('migration down drops hidden', /DROP COLUMN IF EXISTS hidden/i.test(migDown));
ok('manifest lists 060', /060_bookings_hidden/.test(man));
ok('archive sets hidden=true', /hidden = true/.test(drawer));
ok('unhide function exported', /unhideSunsetScheduleBooking/.test(drawer));
ok('hide alias present', /hideSunsetScheduleBooking/.test(drawer));
ok('refund gated cancelled', /booking_not_cancelled/.test(bookingsData) && /Record a refund only after/.test(bookingsData));
ok('isHiddenBooking domain', /function isHiddenBooking/.test(bookingsAdmin));
ok('ghost queries exclude hidden', /b\.hidden/.test(queries));
ok('drawer cancelled offers Hide not Restore', /hideBooking|Hide booking/.test(drawerView) && !/ps-drawer-restore-booking/.test(drawerView.match(/if \(cancelled\) \{[\s\S]{0,400}\}/)[0] || ''));
ok('bookings hide/unhide controls', /data-bookings-hide/.test(bookingsUi) && /data-bookings-unhide/.test(bookingsUi));
ok('bookings refund needs cancel UI', /refundNeedsCancel|Cancel the booking before recording/.test(bookingsUi));
ok('API unhide route', /\/staff\/schedule\/bookings\/unhide/.test(api));
ok('API hide route', /\/staff\/schedule\/bookings\/hide/.test(api));
ok('no hard DELETE bookings SQL in archive', !/DELETE FROM bookings\b/i.test(drawer));

// compact bars CSS
ok('compact bar CSS', /pfb-bars--compact/.test(api));

console.log(`\n── verify:sunset-batch-a1-f1-f3-cancel-hide: ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);

'use strict';

/** FINANCE-TAB-LIVE-FIX-007 — emitted-browser/source contract, offline only. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const { readStaffPortalUiSource } = require('./lib/staff-portal-ui-source');
const { computeSunsetFinanceSummary } = require('./lib/sunset-finance-summary');
let pass = 0; let fail = 0;
function check(label, condition, detail) {
  if (condition) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const rendererPath = path.join(ROOT, 'scripts/browser/sunset-admin-finance-redesign-ui.js');
const rendererSource = fs.readFileSync(rendererPath, 'utf8');
const emittedSource = readStaffPortalUiSource();
const translations = {
  'admin.finance.gran.day': 'Day', 'admin.finance.gran.week': 'Week',
  'admin.finance.gran.month': 'Month', 'admin.finance.gran.year': 'Year',
  'admin.finance.gran.custom': 'Custom', 'admin.finance.today': 'Today',
  'admin.finance.unavailable': 'Unavailable', 'admin.finance.lunaBookings': 'Luna-created',
  'admin.finance.originUnknown': 'bookings with unknown origin',
  'admin.finance.provisionalOccupancy': 'Provisional — based on current sellable beds; historical availability incomplete',
  'admin.finance.currentSeries': 'Current period', 'admin.finance.priorYearSeries': 'Same period last year',
  'admin.finance.eurAxis': 'EUR scale', 'admin.finance.shareUnknown': 'share unknown',
  'admin.finance.dueDatesNotRecorded': 'Due dates not recorded',
};
const sandbox = { portalT: (key) => translations[key] || key, escHtml: String, portalLang: 'en', Intl, module: { exports: {} }, exports: {} };
vm.createContext(sandbox);
vm.runInContext(rendererSource, sandbox);
const base = {
  redesign: {
    view: { granularity: 'week', range: { start: '2026-10-05', end: '2026-10-11' } },
    net: { status: 'unavailable', net_collected_cents: null, gross_collected_cents: 1429500, completed_refunds_cents: null, unavailable_reason: 'refund_source_unreadable' },
    pipeline: { booked_cents: 3080800, bookings_count: 164, avg_booking_cents: 18785, next_30_days_cents: 0, delivered_unpaid_cents: 0, vs_prior_pct: null, vs_yoy_pct: 569.4 },
    outstanding: { outstanding_cents: 1483300, bookings_count: 12, due_date_unknown_cents: 1483300 },
    revenue_by_product: [
      { key: 'accommodation', label: 'Accommodation', cents: 1200000, pct: null, status: 'partial' },
      { key: 'unclassified', label: 'Unclassified adjustment / data incomplete', cents: 1880800, pct: null, status: 'partial' },
    ],
    capacity: { metric: 'bed_occupancy', status: 'partial', occupied_bed_nights: 717, sellable_bed_nights: 1736, pct: null, observed_pct: 41.3, exception_count: 0 },
    luna_bookings: { total_bookings: 0, known_luna_count: 0, staff_count: 100, unknown_origin_count: 64, status: 'partial', by_service: [] },
    daily_gross_trend: [{ date: '2026-10-05', collected_gross_cents: 10000, ly_collected_gross_cents: 5000 }],
    monthly_gross_trend: [], limitations: { note: 'Refund source unreadable.' },
  },
};
const html = sandbox.renderFinanceRedesignHtml(base);
check('known cents stay visible when share is null', /€12,000/.test(html) && /share unknown/.test(html), html);
check('unclassified residual is an ordinary visible row', /Unclassified adjustment/.test(html) && /€18,808/.test(html));
check('unavailable Net is neutral dash with reason; Gross stays readable', /pfb-big pfb-big--neutral[^>]*>—/.test(html) && /refund_source_unreadable/.test(html) && /€14,295/.test(html));
check('partial occupancy uses separate observed ratio', /41\.3%/.test(html) && /717[^<]*of[^<]*1,736|717[^<]*\/[^<]*1,736/.test(html) && /Provisional/.test(html));
check('Luna is compact booking context rather than standalone card', /pfb-booking-context/.test(html) && !/pfb-card--luna-bookings/.test(html));
check('all five granularities share one segmented tablist', ['day','week','month','year','custom'].every(k => html.includes(`data-finance-gran="${k}"`)) && /pfb-gran-btn[^>]*data-finance-gran="custom"/.test(html));
check('Today is adjacent action outside granularity tablist', /data-finance-nav="today"/.test(html));
check('comparison values always carry references', !/pfb-card-bot[^]*?<div class="pfb-deltas">\s*<span class="pfb-delta/.test(html) && /vs last year|admin\.finance\.vsYoy/.test(html));
check('balance unknown due date is explanation, not duplicate amount pill', /Due dates not recorded/.test(html) && !/pfb-pill/.test(html));
check('trend has EUR scale and accessible two-series legend', /pfb-trend-axis/.test(html) && /pfb-trend-legend/.test(html) && /Current period/.test(html) && /Same period last year/.test(html));
check('actual assembled Staff source contains renderer', emittedSource.includes('function renderFinanceRedesignHtml'));

const summary = computeSunsetFinanceSummary({
  now: new Date('2026-10-07T10:00:00Z'), timeZone: 'Europe/Madrid', productMode: 'lodging_packages',
  view: { granularity: 'month', anchor: '2026-10-07' }, bsr: [], bookings: [], payments: [], refund_records: [],
  bed_occupancy: { status: 'partial', occupied_bed_nights: 717, sellable_bed_nights: 1736, exception_count: 0 },
});
check('summary retains authoritative pct null for partial occupancy', summary.redesign.capacity.status === 'partial' && summary.redesign.capacity.pct === null);
check('summary emits separately named provisional observed_pct', summary.redesign.capacity.observed_pct === 41.3, JSON.stringify(summary.redesign.capacity));
const missing = computeSunsetFinanceSummary({
  now: new Date('2026-10-07T10:00:00Z'), timeZone: 'Europe/Madrid', productMode: 'lodging_packages',
  view: { granularity: 'month', anchor: '2026-10-07' }, bsr: [], bookings: [], payments: [], refund_records: [], occupancy_data_unavailable: true,
});
check('missing occupancy source has no numeric observed ratio', missing.redesign.capacity.observed_pct == null && missing.redesign.capacity.pct == null);

const en = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
const es = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n-es-sunset.js'), 'utf8');
for (const key of ['gran.week','lunaBookings','provisionalOccupancy','shareUnknown','dueDatesNotRecorded','currentSeries','priorYearSeries','eurAxis']) {
  check(`EN locale owns admin.finance.${key}`, en.includes(`'admin.finance.${key}'`));
  check(`ES locale owns admin.finance.${key}`, es.includes(`'admin.finance.${key}'`));
}
check('renderer remains scoped owner and does not alter shared Staff CSS', !rendererSource.includes('staff-query-api.js'));
console.log(`\nverify-wolfhouse-finance-live-fix-ui: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

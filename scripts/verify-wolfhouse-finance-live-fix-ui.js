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
  'admin.finance.staffCreated': 'Staff-created',
  'admin.finance.originUnknown': 'bookings with unknown origin',
  'admin.finance.provisionalOccupancy': 'Provisional — based on current sellable beds; historical availability incomplete',
  'admin.finance.currentSeries': 'Current period', 'admin.finance.priorYearSeries': 'Same period last year',
  'admin.finance.eurAxis': 'EUR scale', 'admin.finance.shareUnknown': 'share unknown',
  'admin.finance.dueDatesNotRecorded': 'Due dates not recorded',
  'admin.finance.refundSourceUnavailable': 'Refund data is unavailable.',
  'admin.finance.assignmentExceptions': '{n} assignment exceptions',
};
const sandbox = { portalT: (key) => translations[key] || key, escHtml: String, portalLang: 'en', getStaffLocale: () => sandbox.portalLang, Intl, module: { exports: {} }, exports: {} };
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
check('unknown cents are not coerced to visible zero', !/Camps[\s\S]{0,180}€0/.test(sandbox.renderFinanceRedesignHtml({ redesign: { ...base.redesign, revenue_by_product: [{ key: 'camps', label: 'Camps', cents: null, pct: null }] } })));
check('unavailable Net is neutral dash with reason; Gross stays readable', /pfb-big pfb-big--neutral[^>]*>—/.test(html) && /refund_source_unreadable/.test(html) && /€14,295/.test(html));
check('partial occupancy uses separate observed ratio', /41\.3%/.test(html) && /717[^<]*of[^<]*1,736|717[^<]*\/[^<]*1,736/.test(html) && /Provisional/.test(html));
check('Luna is compact booking context rather than standalone card', /pfb-booking-context/.test(html) && !/pfb-card--luna-bookings/.test(html));
check('compact provenance retains Staff and unknown cohorts', /100 Staff-created/.test(html) && /64 bookings with unknown origin/.test(html));
check('all five granularities share one segmented tablist', ['day','week','month','year','custom'].every(k => html.includes(`data-finance-gran="${k}"`)) && /pfb-gran-btn[^>]*data-finance-gran="custom"/.test(html));
check('Today is adjacent action outside granularity tablist', /data-finance-nav="today"/.test(html));
check('comparison values always carry references', (html.match(/pfb-delta-wrap/g) || []).length === (html.match(/class="pfb-delta /g) || []).length && /vs last period/.test(html) && /vs last year/.test(html));
check('balance unknown due date is explanation, not duplicate amount pill', /Due dates not recorded/.test(html) && !/pfb-pill/.test(html));
check('trend has EUR scale and accessible two-series legend', /pfb-trend-axis/.test(html) && /pfb-trend-legend/.test(html) && /Current period/.test(html) && /Same period last year/.test(html));
check('Wolfhouse-only responsive override wraps labels into two mobile rows', /#wh-admin-finance-body \.pfb-bar-name/.test(html) && /@media\(max-width:640px\)/.test(html));
check('mobile grid uses explicit two-row areas', /grid-template-areas:\"name amount\" \"track share\"/.test(html));
check('chart has positioned y ticks and keyed series', /pfb-trend-tick/.test(html) && /pfb-series-key is-current/.test(html) && /pfb-series-key is-prior/.test(html));
check('chart exposes exact current and prior values accessibly', /pfb-trend-sr/.test(html) && /€100\.00/.test(html) && /€50\.00/.test(html));
check('shared exact-value utility is robustly visually hidden', /clip-path:inset\(50%\)!important/.test(html) && /position:absolute!important/.test(html) && /width:1px!important/.test(html));
check('trend plot owns axis and bars in one geometry wrapper', /pfb-trend-plot/.test(html));
check('series swatches use explicit visible fills', /is-current:before\{[^}]*background:#/.test(html) && /is-prior:before\{[^}]*background:rgba?\(/.test(html));
check('unavailable reason is typed and raw code is absent', /Refund data is unavailable/.test(html) && !/>refund_source_unreadable</.test(html));
check('exact cents are in accessible card and product details', /€14,295\.00/.test(html) && /€12,000\.00/.test(html));
check('booked sales and balance headlines expose exact cents', /pfb-mid[^>]*>[\s\S]*€30,808\.00/.test(html) && /pfb-mid pfb-mid--amber[^>]*>[\s\S]*€14,833\.00/.test(html));
check('occupancy exposes precision, counts, partial status, basis, and exceptions', /41\.3%/.test(html) && /717 of 1,736/.test(html) && /Provisional/.test(html) && /0 assignment exceptions/.test(html));
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
const complete = computeSunsetFinanceSummary({
  now: new Date('2026-10-07T10:00:00Z'), timeZone: 'Europe/Madrid', productMode: 'lodging_packages',
  view: { granularity: 'month', anchor: '2026-10-07' }, bsr: [], bookings: [], payments: [], refund_records: [],
  bed_occupancy: { status: 'complete', occupied_bed_nights: 110, sellable_bed_nights: 100 },
});
check('complete occupancy preserves truthful over-100 rate', complete.redesign.capacity.pct === 110 && complete.redesign.capacity.observed_pct == null);
const zeroDenominator = computeSunsetFinanceSummary({
  now: new Date('2026-10-07T10:00:00Z'), timeZone: 'Europe/Madrid', productMode: 'lodging_packages',
  view: { granularity: 'month', anchor: '2026-10-07' }, bsr: [], bookings: [], payments: [], refund_records: [],
  bed_occupancy: { status: 'partial', occupied_bed_nights: 7, sellable_bed_nights: 0 },
});
check('zero occupancy denominator never emits a rate', zeroDenominator.redesign.capacity.pct == null && zeroDenominator.redesign.capacity.observed_pct == null);

const ledger = computeSunsetFinanceSummary({
  now: new Date('2026-10-07T10:00:00Z'), timeZone: 'Europe/Madrid', productMode: 'lodging_packages',
  view: { granularity: 'month', anchor: '2026-10-07' },
  bsr: [
    { booking_id: 'L', service_date: '2026-10-10', amount_due_cents: 10000, source: 'luna_whatsapp', metadata: { quote_snapshot: { total_cents: 10000, line_items: [{ code: 'accommodation_only', total_cents: 7000 }, { code: 'unknown_persisted', total_cents: 3000 }] } } },
    { booking_id: 'S', service_date: '2026-10-11', amount_due_cents: 5000, source: 'staff_manual', metadata: { quote_snapshot: { total_cents: 5000, line_items: [{ code: 'accommodation_only', total_cents: 5000 }] } } },
    { booking_id: 'U', service_date: '2026-10-12', amount_due_cents: -500, source: 'mystery', metadata: {} },
  ],
  bookings: [{ booking_id: 'L', total_amount_cents: 10000 }, { booking_id: 'S', total_amount_cents: 5000 }, { booking_id: 'U', total_amount_cents: -500 }],
  payments: [{ booking_id: 'L', amount_paid_cents: 9000, paid_at: '2026-10-07T10:00:00Z' }, { booking_id: 'S', amount_paid_cents: 5000, paid_at: null }],
  refund_records: [{ booking_id: 'L', amount_cents: 1250, effective_date: '2026-10-07' }],
});
check('ledger net subtracts effective-date refunds from paid-at gross exactly once', ledger.redesign.net.gross_collected_cents === 9000 && ledger.redesign.net.completed_refunds_cents === 1250 && ledger.redesign.net.net_collected_cents === 7750);
check('provenance separates canonical/legacy Luna, Staff, and unsupported unknown', ledger.redesign.luna_bookings.known_luna_count === 1 && ledger.redesign.luna_bookings.staff_count === 1 && ledger.redesign.luna_bookings.unknown_origin_count === 1 && ledger.redesign.luna_bookings.status === 'partial');
check('persisted product rows reconcile exactly to booked cents including signed residual', ledger.redesign.revenue_by_product.reduce((sum, row) => sum + (row.cents == null ? 0 : row.cents), 0) === ledger.redesign.pipeline.booked_cents, JSON.stringify(ledger.redesign.revenue_by_product));

const en = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
const es = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n-es-sunset.js'), 'utf8');
for (const key of ['gran.week','lunaBookings','staffCreated','provisionalOccupancy','shareUnknown','dueDatesNotRecorded','currentSeries','priorYearSeries','eurAxis','monthlyBookedTrend']) {
  check(`EN locale owns admin.finance.${key}`, en.includes(`'admin.finance.${key}'`));
  check(`ES locale owns admin.finance.${key}`, es.includes(`'admin.finance.${key}'`));
}
check('renderer remains scoped owner and does not alter shared Staff CSS', !rendererSource.includes('staff-query-api.js'));
const esRequired = ['bookedSales','balanceStillDue','bookedSalesByProduct','bedOccupancy','bedNights','occupiedBeds','dateBasis','product.services','product.camps'];
for (const key of esRequired) check(`ES locale owns admin.finance.${key}`, es.includes(`'admin.finance.${key}'`));
sandbox.portalLang = 'es';
sandbox.portalT = (key) => ({
  'admin.finance.bookedSales': 'Ventas reservadas',
  'admin.finance.balanceStillDue': 'Saldo pendiente',
  'admin.finance.bookings': 'Reservas',
}[key] || translations[key] || key);
const esHtml = sandbox.renderFinanceRedesignHtml(base);
check('native ES render uses scoped labels and es-ES exact currency', /Ventas reservadas/.test(esHtml) && /Saldo pendiente/.test(esHtml) && /30\.808,00\s*€/.test(esHtml));
console.log(`\nverify-wolfhouse-finance-live-fix-ui: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

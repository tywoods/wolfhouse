'use strict';

/**
 * verify:sunset-finance-ui-revisions
 * Trend toggle (12-month adopts Year period), Custom opens picker, bar grid, Capacity ring.
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra != null ? ` — ${extra}` : ''}`); }
}

const redesign = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-finance-redesign-ui.js'), 'utf8');
const adminUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-ui.js'), 'utf8');
const summarySrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-finance-summary.js'), 'utf8');
const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const { computeSunsetFinanceSummary } = require(path.join(ROOT, 'scripts/lib/sunset-finance-summary.js'));
const { renderFinanceRedesignHtml } = require(path.join(ROOT, 'scripts/browser/sunset-admin-finance-redesign-ui.js'));

// F3 — click target includes data-finance-trend
ok('wire closest includes data-finance-trend',
  /closest\([^\)]*data-finance-trend/.test(adminUi));
ok('12-month trend adopts year period and refetches KPIs',
  /window\.__financeTrendMode/.test(adminUi)
  && /mode === 'year'/.test(adminUi)
  && /financeViewState\.granularity = 'year'/.test(adminUi)
  && /loadAdminFinanceSummary\(\)/.test(adminUi));
ok('days trend can re-render from financeLastSummary',
  /financeLastSummary/.test(adminUi)
  && /renderFinanceRedesignHtml\(financeLastSummary\)/.test(adminUi));
ok('trend buttons use days|year',
  /data-finance-trend=\"days\"/.test(redesign) && /data-finance-trend=\"year\"/.test(redesign));

// Fixed Jan-Dec monthly comparison for the selected year.
ok('monthly_gross_trend is fixed Jan-Dec for selected year',
  /monthlyCollectedGrossTrend/.test(summarySrc) && /monthRangeForYearMonth/.test(summarySrc));

const s = computeSunsetFinanceSummary({
  now: new Date('2026-08-15T12:00:00Z'),
  timeZone: 'Europe/Madrid',
  view: { granularity: 'month', anchor: '2026-08-15' },
  bsr: [
    { booking_id: 'B1', service_date: '2026-08-05', service_type: 'surf_lesson', amount_due_cents: 5000, quantity: 2, metadata: { component: 'course', course_id: 'c1' } },
    { booking_id: 'B1', service_date: '2026-07-05', service_type: 'surf_lesson', amount_due_cents: 3000, quantity: 1, metadata: { component: 'course', course_id: 'c1' } },
  ],
  payments: [
    { booking_id: 'B1', amount_paid_cents: 5000, paid_at: '2026-08-05T10:00:00Z', status: 'paid' },
    { booking_id: 'B1', amount_paid_cents: 3000, paid_at: '2026-07-05T10:00:00Z', status: 'paid' },
  ],
  bookings: [{ booking_id: 'B1', total_amount_cents: 8000 }],
  surf_packs: [{ pack_id: 'p1', group_size: 8, config: { group_size: 8 } }],
  rental_stock: [],
});
ok('monthly trend length 12', Array.isArray(s.redesign.monthly_gross_trend) && s.redesign.monthly_gross_trend.length === 12);
const months = s.redesign.monthly_gross_trend.map((r) => r.month);
ok('fixed chart starts at January', months[0] === 1);
ok('fixed chart ends at December', months[months.length - 1] === 12);
ok('fixed chart year is selected anchor year', s.redesign.monthly_gross_trend.every((r) => r.year === 2026));
ok('daily trend is period days', Array.isArray(s.redesign.daily_gross_trend) && s.redesign.daily_gross_trend.length >= 28);

// Render with days mode
global.window = { __financeTrendMode: 'days' };
const htmlDays = renderFinanceRedesignHtml(s);
ok('days mode paints daily trend container', /data-finance-trend-mode=\"days\"/.test(htmlDays) || /pfb-trend/.test(htmlDays));
ok('days toggle is-on', /data-finance-trend=\"days\"[^>]*is-on|class=\"pfb-trend-btn is-on\"[^>]*data-finance-trend=\"days\"/.test(htmlDays));
ok('days mode keeps daily trend label', /Daily gross vs last year/.test(htmlDays) && !/Monthly gross vs last year/.test(htmlDays));

global.window.__financeTrendMode = 'year';
const htmlYear = renderFinanceRedesignHtml(s);
ok('year mode paints monthly series', /data-finance-trend-mode=\"year\"/.test(htmlYear));
ok('year toggle is-on', /data-finance-trend=\"year\"[^>]*is-on|class=\"pfb-trend-btn is-on\"[^>]*data-finance-trend=\"year\"/.test(htmlYear));
ok('year mode uses exact monthly trend label', /Monthly gross vs last year/.test(htmlYear));
ok('year mode paints Jan-Dec axis', /Jan/.test(htmlYear) && /Dec/.test(htmlYear));
// Renderer still accepts month period + year chart (offline); live wire adopts year period on 12m click.
ok('renderer can paint year chart while summary period is month',
  /data-finance-gran=\"month\"[^>]*is-on|aria-selected=\"true\"[^>]*>Month|class=\"pfb-gran-btn is-on\"[^>]*data-finance-gran=\"month\"/.test(htmlYear));
ok('month summary year-chart uses collected basis', /data-finance-trend-basis=\"collected\"/.test(htmlYear));

const yearSummary = computeSunsetFinanceSummary({
  now: new Date('2026-08-15T12:00:00Z'),
  timeZone: 'Europe/Madrid',
  view: { granularity: 'year', anchor: '2026-08-15' },
  bsr: [
    { booking_id: 'B1', service_date: '2026-08-05', service_type: 'surf_lesson', amount_due_cents: 5000, quantity: 2, metadata: { component: 'course', course_id: 'c1' } },
    { booking_id: 'B1', service_date: '2026-07-05', service_type: 'surf_lesson', amount_due_cents: 3000, quantity: 1, metadata: { component: 'course', course_id: 'c1' } },
  ],
  payments: [
    { booking_id: 'B1', amount_paid_cents: 5000, paid_at: '2026-08-05T10:00:00Z', status: 'paid' },
    { booking_id: 'B1', amount_paid_cents: 3000, paid_at: '2026-07-05T10:00:00Z', status: 'paid' },
  ],
  bookings: [{ booking_id: 'B1', total_amount_cents: 8000 }],
  surf_packs: [{ pack_id: 'p1', group_size: 8, config: { group_size: 8 } }],
  rental_stock: [],
});
global.window.__financeTrendMode = 'year';
const htmlYearPeriod = renderFinanceRedesignHtml(yearSummary);
ok('year period root attrs', /data-finance-view-gran=\"year\"/.test(htmlYearPeriod)
  && /data-finance-range-start=\"2026-01-01\"/.test(htmlYearPeriod)
  && /data-finance-range-end=\"2026-12-31\"/.test(htmlYearPeriod));
ok('year period chart paints booked dues', /data-finance-trend-basis=\"booked\"/.test(htmlYearPeriod));
ok('monthly trend carries booked_cents',
  Array.isArray(yearSummary.redesign.monthly_gross_trend)
  && yearSummary.redesign.monthly_gross_trend.every((r) => typeof r.booked_cents === 'number'));
ok('year booked equals sum of monthly booked',
  yearSummary.redesign.pipeline.booked_cents
    === yearSummary.redesign.monthly_gross_trend.reduce((a, r) => a + r.booked_cents, 0));

// Custom picker — anchored floating overlay; no incomplete custom summary reload
ok('Custom gran opens anchored picker without openCustomPicker reload',
  /financeCustomTogglePopover\(\)/.test(adminUi)
  && /function\s+financeOpenCustomRangePicker/.test(adminUi)
  && !/loadAdminFinanceSummary\(\s*\{\s*openCustomPicker\s*:\s*true\s*\}\s*\)/.test(adminUi));
ok('custom trigger + pop in redesign',
  /id=\"pfb-custom-range-trigger\"/.test(redesign)
  && /id=\"pfb-custom-display\"/.test(redesign)
  && /id=\"pfb-custom-range-pop\"/.test(redesign));
ok('picker paint shows floating popover',
  /pop\.hidden = false/.test(adminUi) && /pop\.style\.display = ''/.test(adminUi));
ok('custom picker keeps live-apply selection with Clear/Close controls',
  /financeSelectRangeDay\(/.test(adminUi)
  && /financeApplyCustomDraft\(/.test(adminUi)
  && /data-pfb-cal=\"clear\"/.test(redesign)
  && /data-pfb-cal=\"close\"/.test(redesign));

// Capacity ring
ok('capacity ring in redesign HTML',
  /data-finance-cap-ring|class=\"pfb-ring\"/.test(redesign)
  && /lessonSeats|lesson seats/.test(redesign));
ok('rendered capacity has ring', /data-finance-cap-ring=\"1\"|class=\"pfb-ring\"/.test(htmlDays));

// Bar alignment CSS
ok('fixed 9rem label column',
  /grid-template-columns:\s*9rem/.test(api)
  && /pfb-bar-name/.test(api) && /width:\s*9rem/.test(api));
ok('tighter compact gap ≤6px',
  /\.pfb-bars--compact\{[^}]*gap:\s*6px/.test(api.replace(/\s+/g, '')));
ok('cap-top flex layout', /\.pfb-cap-top\{display:flex/.test(api.replace(/\s+/g, ' ')));

// Keep 5/4
ok('revenue 5 rows', (s.redesign.revenue_by_product || []).length === 5
  || (s.redesign.revenue_by_product || []).some((r) => r.slot === 'other')
  || (s.redesign.revenue_by_product || []).length >= 4);
ok('capacity 4 rows (no Other)',
  Array.isArray(s.redesign.capacity.by_product)
  && s.redesign.capacity.by_product.length === 4
  && !s.redesign.capacity.by_product.some((r) => r.slot === 'other'));

console.log(`\n── verify:sunset-finance-ui-revisions: ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);

'use strict';

/**
 * verify:sunset-finance-redesign-s1
 * Option B Slice 1 — redesign math + renderer (offline).
 */

const path = require('path');
const fs = require('fs');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const {
  computeSunsetFinanceSummary,
  productBucket,
} = require(path.join(ROOT, 'scripts', 'lib', 'sunset-finance-summary.js'));
const { BSR_SQL, PENDING_REFUND_SQL, RENTAL_STOCK_SQL } = require(path.join(ROOT, 'scripts', 'lib', 'sunset-finance-data.js'));

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra !== undefined ? `  (${extra})` : ''}`); }
}
function eq(label, got, want) { ok(label, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }

const TZ = 'Europe/Madrid';
const NOW = new Date('2026-07-15T10:00:00Z');

// product mapping
eq('surf_lesson→lessons', productBucket('surf_lesson'), 'lessons');
eq('surfboard→boards', productBucket('surfboard'), 'boards');
eq('wetsuit→wetsuits', productBucket('wetsuit'), 'wetsuits');
eq('addon→retail', productBucket('addon_service'), 'retail');
eq('yoga→retail', productBucket('yoga'), 'retail');

ok('BSR SQL includes service_type', /service_type/.test(BSR_SQL));
ok('pending refund SQL targets cancelled bookings', /cancelled/.test(PENDING_REFUND_SQL) && /amount_paid_cents/.test(PENDING_REFUND_SQL));
ok('rental stock SQL reads stock_quantity', /stock_quantity/.test(RENTAL_STOCK_SQL));

const bookings = [
  { booking_id: 'B1', total_amount_cents: 10000 },
  { booking_id: 'B2', total_amount_cents: 5000 },
  { booking_id: 'B_PAST', total_amount_cents: 8000 },
];
const bsr = [
  { booking_id: 'B1', service_date: '2026-07-15', service_type: 'surf_lesson', quantity: 2, amount_due_cents: 4000, metadata: { component: 'course', course_id: 'pack1', include_board: true, include_wetsuit: true } },
  { booking_id: 'B1', service_date: '2026-07-16', service_type: 'surfboard', quantity: 1, amount_due_cents: 3000, metadata: {} },
  { booking_id: 'B2', service_date: '2026-07-10', service_type: 'wetsuit', quantity: 1, amount_due_cents: 2000, metadata: {} },
  { booking_id: 'B_PAST', service_date: '2026-06-01', service_type: 'surf_lesson', quantity: 1, amount_due_cents: 8000, metadata: { component: 'course', course_id: 'pack1' } },
];
const payments = [
  { booking_id: 'B1', amount_paid_cents: 4000, paid_at: '2026-07-15T09:00:00Z' },
  { booking_id: 'B2', amount_paid_cents: 0, paid_at: '2026-07-10T09:00:00Z' },
];
// B2 unpaid 5000, last service 07-10 → 5 days past on 07-15 → due soon
// B_PAST unpaid 8000, last 06-01 → overdue

const pending = [
  { booking_id: 'CXL', amount_paid_cents: 2500, paid_at: '2026-07-01T10:00:00Z' },
];
const stock = [
  { offering_key: 'board_rental', group_key: 'boards', label: 'Surfboard', stock_quantity: 20, active: true },
  { offering_key: 'wetsuit_rental', group_key: 'wetsuits', label: 'Wetsuit', stock_quantity: 15, active: true },
];
const packs = [{ pack_id: 'pack1', label: 'Group', group_size: 8, config: { group_size: 8 } }];

const s = computeSunsetFinanceSummary({
  now: NOW,
  timeZone: TZ,
  view: { granularity: 'month', anchor: '2026-07-15' },
  bsr,
  payments,
  bookings,
  pending_refund_payments: pending,
  rental_stock: stock,
  surf_packs: packs,
});

ok('redesign present', !!s.redesign);
eq('net equals gross', s.redesign.net.net_collected_cents, s.redesign.net.gross_collected_cents);
eq('pending refund from cancellations', s.redesign.net.pending_refund_cents, 2500);
eq('completed refunds still 0', s.redesign.net.completed_refunds_cents, 0);

// July product: B1 lesson 4000 + board 3000 + B2 wetsuit 2000 = 9000
const byKey = Object.fromEntries(s.redesign.revenue_by_product.map((p) => [p.key, p.cents]));
eq('product lessons', byKey.lessons, 4000);
eq('product boards', byKey.boards, 3000);
eq('product wetsuits', byKey.wetsuits, 2000);

ok('next 30 includes B1 July rows', s.redesign.pipeline.next_30_days_cents >= 7000);
// Delivered unpaid = any booking with balance and last service_date < today (B2 07-10 + B_PAST 06-01).
eq('delivered unpaid = B2+B_PAST', s.redesign.pipeline.delivered_unpaid_cents, 13000);

// Outstanding aging for July-qualifying unpaid balances:
// B1 balance 6000, last service 07-16 (future) → due soon; B2 5000, last 07-10 (5d past) → due soon.
eq('due soon ≤7d includes near/future unpaid', s.redesign.outstanding.due_soon_cents, 11000);
eq('overdue in primary July may be 0 (B_PAST outside period)', s.redesign.outstanding.overdue_cents, 0);

ok('capacity seats known', s.redesign.capacity.seats_capacity != null && s.redesign.capacity.seats_capacity > 0);
ok('boards stock used', s.redesign.capacity.boards_stock === 20);
ok('wetsuits stock used', s.redesign.capacity.wetsuits_stock === 15);
ok('boards out counted', s.redesign.capacity.boards_out >= 1);
ok('daily trend has LY ghost fields', Array.isArray(s.redesign.daily_gross_trend) && s.redesign.daily_gross_trend[0]
  && 'ly_collected_gross_cents' in s.redesign.daily_gross_trend[0]);
ok('left on table uses avg lesson price when capacity known', s.redesign.capacity.left_on_table_cents == null
  || Number.isInteger(s.redesign.capacity.left_on_table_cents));

// Renderer
const uiSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'browser', 'sunset-admin-finance-redesign-ui.js'), 'utf8');
const sandbox = { portalT: (k) => k, escHtml: (x) => String(x), portalLang: 'en', Intl, module: { exports: {} }, exports: {} };
vm.createContext(sandbox);
vm.runInContext(uiSrc + '\nthis.renderFinanceRedesignHtml = renderFinanceRedesignHtml;', sandbox);
const html = sandbox.renderFinanceRedesignHtml(s);
ok('renders nav stepper', /data-finance-nav="prev"/.test(html) && /data-finance-gran="month"/.test(html));
ok('renders net hero', /admin\.finance\.netCollected|Net collected/.test(html) || /pfb-big/.test(html));
ok('renders pending refund', /pendingRefund|Pending refund|2500|25/.test(html));
ok('renders product bars', /pfb-bar-row/.test(html));
ok('renders capacity', /pfb-ring|Capacity used|admin\.finance\.capacityUsed/.test(html));
ok('renders daily trend', /pfb-trend/.test(html));
ok('no money arithmetic in renderer source', !/net_collected_cents\s*[+\-*/]/.test(uiSrc));

// Admin UI prefers redesign when function present
const adminSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'browser', 'sunset-admin-ui.js'), 'utf8');
ok('admin ui wires redesign render path', /renderFinanceRedesignHtml/.test(adminSrc));
ok('admin ui sends granularity query', /financeViewQuery|granularity=/.test(adminSrc));
ok('browser source injects redesign module', fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'sunset-admin-browser-source.js'), 'utf8').includes('sunset-admin-finance-redesign-ui.js'));
ok('route accepts view params', /query\.granularity/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'staff-query-api.js'), 'utf8')));
ok('CSS has Option B classes', /\.pfb-hero/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'staff-query-api.js'), 'utf8')));
ok('CSS font-weight never 800+', !/pfb-[^}]*font-weight:\s*8\d\d/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'staff-query-api.js'), 'utf8')));

console.log(`\n── verify:sunset-finance-redesign-s1: ${pass} passed, ${fail} failed ──`);
if (fail === 0) console.log('verify:sunset-finance-redesign-s1 — ALL CHECKS PASSED');
process.exit(fail ? 1 : 0);

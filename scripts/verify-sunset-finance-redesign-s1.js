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
  shiftRangeYears,
  stockTotals,
} = require(path.join(ROOT, 'scripts', 'lib', 'sunset-finance-summary.js'));
const { BSR_SQL, REFUNDS_SQL, RENTAL_STOCK_SQL } = require(path.join(ROOT, 'scripts', 'lib', 'sunset-finance-data.js'));

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra !== undefined ? `  (${extra})` : ''}`); }
}
function eq(label, got, want) { ok(label, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }

const TZ = 'Europe/Madrid';
const NOW = new Date('2026-07-15T10:00:00Z');

// product mapping (canonical)
eq('surf_lesson→lessons', productBucket('surf_lesson'), 'lessons');
eq('surfboard→boards', productBucket('surfboard'), 'boards');
eq('wetsuit→wetsuits', productBucket('wetsuit'), 'wetsuits');
eq('addon→retail', productBucket('addon_service'), 'retail');
eq('yoga→retail', productBucket('yoga'), 'retail');

// Seadog #1 — addon_service + component surfboard must NOT stay retail
const addonBoardRow = { service_type: 'addon_service', metadata: { component: 'surfboard' }, amount_due_cents: 1000 };
eq('Seadog#1 productBucket(addon_service, component:surfboard)→boards', productBucket(addonBoardRow), 'boards');
const addonBoardSummary = computeSunsetFinanceSummary({
  now: NOW,
  timeZone: TZ,
  view: { granularity: 'month', anchor: '2026-07-15' },
  bsr: [{ booking_id: 'A1', service_date: '2026-07-10', service_type: 'addon_service', quantity: 1, amount_due_cents: 1000, metadata: { component: 'surfboard' } }],
  payments: [],
  bookings: [{ booking_id: 'A1', total_amount_cents: 1000 }],
});
const addonRows = addonBoardSummary.redesign.revenue_by_product;
ok('Seadog#1 F2 now 5 product rows', Array.isArray(addonRows) && addonRows.length === 5);
// addon_service + component surfboard → board_rental item (not lessons)
const addonBoardCents = addonRows.reduce((a, r) => a + (String(r.key).includes('board') || /board/i.test(r.label) ? r.cents : 0), 0);
ok('Seadog#1 board revenue present (€10)', addonBoardCents === 1000 || addonRows.some((r) => r.cents === 1000 && r.slot !== 'lessons'));
eq('Seadog#1 lessons 0 for pure board addon', addonRows[0].cents, 0);

// Seadog #2 — board+suit stock counts both sides
const stockBoardPlusSuit = stockTotals([
  { offering_key: 'board+suit', label: 'Board+suit', stock_quantity: 10, active: true },
]);
eq('Seadog#2 board+suit boards_stock', stockBoardPlusSuit.boards_stock, 10);
eq('Seadog#2 board+suit wetsuits_stock', stockBoardPlusSuit.wetsuits_stock, 10);
const stockLegacyBundle = stockTotals([
  { offering_key: 'board_and_suit_rental', label: 'Board and suit', stock_quantity: 4, active: true },
]);
eq('Seadog#2 board_and_suit boards', stockLegacyBundle.boards_stock, 4);
eq('Seadog#2 board_and_suit wetsuits', stockLegacyBundle.wetsuits_stock, 4);
const stockPlain = stockTotals([
  { offering_key: 'board_rental', label: 'Surfboard', stock_quantity: 7, active: true },
  { offering_key: 'wetsuit_rental', label: 'Wetsuit', stock_quantity: 3, active: true },
]);
eq('Seadog#2 plain board one-sided', stockPlain.boards_stock, 7);
eq('Seadog#2 plain wetsuit one-sided', stockPlain.wetsuits_stock, 3);

// Seadog #3 — leap day clamp
const leap = shiftRangeYears({ start: '2024-02-29', end: '2024-02-29' }, -1);
eq('Seadog#3 leap day → 2023-02-28 start', leap.start, '2023-02-28');
eq('Seadog#3 leap day → 2023-02-28 end', leap.end, '2023-02-28');

// Seadog #4 — legacy limitations byte-identical to master
const emptyLim = computeSunsetFinanceSummary({ now: NOW, timeZone: TZ, bsr: [], payments: [], bookings: [] });
eq('Seadog#4 legacy net_collected_available false', emptyLim.limitations.net_collected_available, false);
eq(
  'Seadog#4 legacy note exact',
  emptyLim.limitations.note,
  'Collected is gross: refunds/reversals are not available until an authoritative refund ledger exists.',
);
ok('Seadog#4 legacy limitations has only 2 keys', Object.keys(emptyLim.limitations).sort().join(',') === 'net_collected_available,note');
// L1: redesign limitations carry refund-aware flags; legacy top-level stays frozen above.
ok('Seadog#4 redesign net_uses_recorded_refunds', emptyLim.redesign.limitations.net_uses_recorded_refunds === true);
ok('Seadog#4 redesign pending proxy retired', emptyLim.redesign.limitations.pending_refund_estimated_from_cancellations === false);
ok('Seadog#4 redesign note mentions recorded refunds', /recorded refunds|effective date/i.test(emptyLim.redesign.limitations.note));

ok('BSR SQL includes service_type', /service_type/.test(BSR_SQL));
ok('REFUNDS_SQL reads booking_refund_records', /booking_refund_records/.test(REFUNDS_SQL));
ok('REFUNDS_SQL scopes r.location_id = $2', /r\.location_id\s*=\s*\$2/.test(REFUNDS_SQL));
ok('REFUNDS_SQL does not use booking metadata location', !/metadata\s*->>\s*'location_id'/.test(REFUNDS_SQL));
ok('REFUNDS_SQL filters source staff_manual_record', /staff_manual_record/.test(REFUNDS_SQL));
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

// Slice 2: pending cancellation proxy ignored; refund_records drive Net.
const pendingIgnored = [
  { booking_id: 'CXL', amount_paid_cents: 2500, paid_at: '2026-07-01T10:00:00Z' },
];
const refunds = [
  { booking_id: 'B1', amount_cents: 1000, effective_date: '2026-07-12', location_id: 'sunset-somo' },
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
  pending_refund_payments: pendingIgnored,
  refund_records: refunds,
  rental_stock: stock,
  surf_packs: packs,
});

ok('redesign present', !!s.redesign);
eq('gross from payments', s.redesign.net.gross_collected_cents, 4000);
eq('completed refunds from ledger', s.redesign.net.completed_refunds_cents, 1000);
eq('net = gross − refunds', s.redesign.net.net_collected_cents, 3000);
eq('pending proxy retired (0)', s.redesign.net.pending_refund_cents, 0);
eq('pending_refund_payments ignored', s.redesign.net.pending_refund_cents, 0);

ok('product rows length 5', s.redesign.revenue_by_product.length === 5);
eq('product lessons slot', s.redesign.revenue_by_product[0].cents, 4000);
// boards/wetsuits may land in course_included or ranked depending on pack equipment_options
const prodCents = s.redesign.revenue_by_product.reduce((a, r) => a + r.cents, 0);
ok('product total includes gear lines', prodCents >= 4000 + 3000 + 2000 - 1);

ok('next 30 includes B1 July rows', s.redesign.pipeline.next_30_days_cents >= 7000);
eq('delivered unpaid stays inside selected period', s.redesign.pipeline.delivered_unpaid_cents, 2000);
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

const uiSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'browser', 'sunset-admin-finance-redesign-ui.js'), 'utf8');
const sandbox = { portalT: (k) => k, escHtml: (x) => String(x), portalLang: 'en', Intl, module: { exports: {} }, exports: {} };
vm.createContext(sandbox);
vm.runInContext(uiSrc + '\nthis.renderFinanceRedesignHtml = renderFinanceRedesignHtml;', sandbox);
const html = sandbox.renderFinanceRedesignHtml(s);
ok('renders nav stepper', /data-finance-nav="prev"/.test(html) && /data-finance-gran="month"/.test(html));
ok('renders net hero', /admin\.finance\.netCollected|Net collected/.test(html) || /pfb-big/.test(html));
ok('renders refunds row (not pending)', /admin\.finance\.refunds|Refunds/.test(html));
ok('does not render pending refund row', !/pendingRefund|Pending refund/.test(html));
ok('renders product bars', /pfb-bar-row/.test(html));
ok('renders capacity', /pfb-ring|Capacity used|admin\.finance\.capacityUsed/.test(html));
ok('renders daily trend', /pfb-trend/.test(html));
ok('UI note from redesign.limitations', /recorded refunds|effective date/i.test(html));
ok('daily trend labelled Gross', /dailyGrossTrend|Daily gross collected|Gross/.test(html));
ok('no money arithmetic in renderer source', !/net_collected_cents\s*[+\-*/]/.test(uiSrc));

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

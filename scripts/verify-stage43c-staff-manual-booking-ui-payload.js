/**
 * Stage 43c — Staff Portal manual booking UI → create API payload proof.
 *
 * Static + runtime checks that runManualBookingCreate / buildAddOns produce a
 * payload compatible with POST /staff/manual-bookings/create (quote-driven, safe).
 *
 * Usage:
 *   npm run verify:stage43c-staff-manual-booking-ui-payload
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const API_FILE = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage43c-staff-manual-booking-ui-payload';

let passed = 0;
let failed = 0;

function ok(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passed++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failed++; }
function check(id, cond, msg) { if (cond) ok(id, msg); else fail(id, msg); }

function sliceUiFn(src, name, untilRe) {
  const start = src.indexOf(`function ${name}`);
  if (start < 0) return '';
  const tail = src.slice(start + 12);
  const relEnd = untilRe ? tail.search(untilRe) : -1;
  if (relEnd > 0) return src.slice(start, start + 12 + relEnd);
  return src.slice(start, start + 12000);
}

function staffStripeLinkLeak(text) {
  return /\bStripe(?:\s+(?:link|payment|deposit|full(?:-payment)?\s+link))|\bStripe links are\b/i.test(String(text || ''));
}

function runBuildAddOns(mockQty) {
  const src = fs.readFileSync(API_FILE, 'utf8');
  const aoQtyFn = sliceUiFn(src, 'aoQtyInput', /\nfunction buildAddOns/);
  const buildFn = sliceUiFn(src, 'buildAddOns', /\n\/\* ── Quote button/);
  const sandbox = {
    el(id) { return { value: String(mockQty[id] != null ? mockQty[id] : '0') }; },
    parseInt,
    result: null,
  };
  vm.runInNewContext(`${aoQtyFn}\n${buildFn}\nresult = buildAddOns();`, sandbox, { timeout: 1000 });
  return sandbox.result;
}

console.log(`\nverify-stage43c-staff-manual-booking-ui-payload.js  (Stage 43c)\n`);

const src = fs.readFileSync(API_FILE, 'utf8');
const handlerStart = src.indexOf('async function handleManualBookingCreate');
const handlerEnd = src.indexOf('\n// ───', handlerStart + 50);
const handler = handlerStart > 0 ? src.slice(handlerStart, handlerEnd > 0 ? handlerEnd : handlerStart + 18000) : '';

const createFn = sliceUiFn(src, 'runManualBookingCreate', /\nfunction renderCreateResult/);
const buildAddonsFn = sliceUiFn(src, 'buildAddOns', /\n\/\* ── Quote button/);
const createBtnFn = sliceUiFn(src, 'bcUpdateCreateButton', /\nfunction bcUpdateManualBookingPaidFields/);
const paidFieldsFn = sliceUiFn(src, 'bcUpdateManualBookingPaidFields', /\n\/\* ── Manual booking create/);
const renderCreateFn = sliceUiFn(src, 'renderCreateResult', /\n\/\* ── Stripe payment link creation/);
const selPanel = src.match(/id="bc-sel-panel"[\s\S]*?id="bc-create-result"/)?.[0] || '';
const paymentPanel = src.match(/Section: Payment[\s\S]*?Section: Notes/)?.[0] || '';

check('A1', createFn.length > 400 && buildAddonsFn.length > 200,
  'runManualBookingCreate + buildAddOns found in Staff Portal UI script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A2', pkg.scripts && pkg.scripts[SCRIPT] === `node scripts/${path.basename(__filename)}`,
  'package.json registers verify:stage43c-staff-manual-booking-ui-payload');

check('B1', /BC_MANUAL_BOOKING/.test(createBtnFn) && /BC_MANUAL_BOOKING/.test(createFn),
  'UI gated by BC_MANUAL_BOOKING (MANUAL_BOOKING_ENABLED)');
check('B2', /bcLastQuote/.test(createFn),
  'create requires prior quote (bcLastQuote) — server quote engine is source of truth');
check('B3', /bcFetchManualBookingAvailability/.test(createFn),
  'create path checks availability before POST');
check('B4', /fetch\s*\(\s*['"]\/staff\/manual-bookings\/create['"]/.test(createFn),
  'create posts to /staff/manual-bookings/create');
check('B5', /JSON\.stringify\(payload\)/.test(createFn),
  'create body is JSON.stringify(payload)');

const payloadBlock = createFn.match(/var payload = \{[\s\S]*?\};/)?.[0] || '';
check('C1', payloadBlock.length > 100, 'payload object literal found in runManualBookingCreate');

const requiredPayloadKeys = [
  'client_slug', 'check_in', 'check_out', 'selected_bed_codes',
  'guest_count', 'guest_name', 'package_code', 'room_type',
  'payment_choice', 'add_ons', 'confirm',
];
for (const key of requiredPayloadKeys) {
  check(`C2.${key}`, new RegExp(`${key}\\s*:`).test(payloadBlock),
    `payload includes ${key}`);
}

check('C3', /add_ons:\s*buildAddOns\(\)/.test(payloadBlock),
  'add_ons built via buildAddOns() not hardcoded');
check('C4', /confirm:\s*true/.test(payloadBlock),
  'payload sets confirm:true');
check('C5', /selected_bed_codes:\s*bcSelectedBeds/.test(payloadBlock),
  'selected_bed_codes from calendar selection');

check('D1', !/deposit_amount_cents|total_amount_cents/.test(payloadBlock),
  'payload does not send quote totals (deposit_amount_cents/total_amount_cents)');
check('D2', /body\.add_ons|add_ons:/.test(handler) && /calculateWolfhouseQuote/.test(handler),
  'handler reads add_ons and runs calculateWolfhouseQuote server-side');
check('D3', !/body\.deposit_amount_cents|body\.total_amount_cents/.test(handler),
  'handler does not trust client quote totals from body');

check('E1', /wetsuit_soft_top_combo/.test(buildAddonsFn) && /wetsuit_hard_board_combo/.test(buildAddonsFn),
  'buildAddOns includes combo codes');
check('E2', /wetsuit_rental/.test(buildAddonsFn) && /soft_top_rental/.test(buildAddonsFn)
  && /hard_board_rental/.test(buildAddonsFn),
  'buildAddOns includes individual rental codes');
check('E3', /surf_lesson_single/.test(buildAddonsFn) && /yoga_class/.test(buildAddonsFn)
  && /meals/.test(buildAddonsFn),
  'buildAddOns includes lesson/yoga/meals codes');

try {
  const addOns = runBuildAddOns({
    'bk-ao-ws-combo-days': 2,
    'bk-ao-softtop-days': 1,
    'bk-ao-surf-lessons': 2,
    'bk-ao-yoga': 1,
    'bk-ao-meals': 3,
  });
  check('E4', Array.isArray(addOns) && addOns.length >= 5,
    'runtime buildAddOns returns selected add-on rows');
  check('E5', addOns.some((a) => a.code === 'wetsuit_soft_top_combo' && a.days === 2),
    'runtime combo uses days field');
  check('E6', addOns.some((a) => a.code === 'surf_lesson_single' && a.quantity === 2),
    'runtime lessons use quantity field');
  check('E7', addOns.some((a) => a.code === 'meals' && a.quantity === 3),
    'runtime meals use quantity field');
  check('E8', !addOns.some((a) => a.total_cents != null || a.amount_cents != null),
    'runtime add_ons carry codes/qty only — no client-invented amounts');

  const { buildManualBookingServiceRecordRows } = require('./lib/manual-booking-service-records');
  const { calculateWolfhouseQuote } = require('./lib/wolfhouse-quote-calculator');
  const quote = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-06-15',
    check_out: '2026-06-22',
    guest_count: 2,
    package_code: 'malibu',
    room_type: 'shared',
    payment_choice: 'deposit',
    add_ons: addOns,
  });
  const svcRows = buildManualBookingServiceRecordRows({
    addOns,
    quote,
    clientSlug: 'wolfhouse-somo',
    bookingId: '00000000-0000-4000-8000-000000000043',
    bookingCode: 'MB-43C-UI',
    guestName: 'UI Payload Test',
    checkIn: '2026-06-15',
    guestCount: 2,
  });
  check('E9', svcRows.length > 0,
    'UI-shaped add_ons map to booking_service_records via shared lib');
} catch (e) {
  fail('E4', `runtime buildAddOns smoke failed: ${e.message}`);
}

check('F1', !staffStripeLinkLeak(paymentPanel),
  'manual booking payment panel avoids Stripe link staff-facing copy');
check('F2', /secure payment link|payment link/i.test(paymentPanel + paidFieldsFn + renderCreateFn),
  'manual booking UI uses payment link / secure payment link wording');
check('F3', !staffStripeLinkLeak(renderCreateFn) || /Payment link \(copy to send manually\)/.test(renderCreateFn),
  'create result panel uses payment link label (not Stripe link)');

check('G1', /paid_amount_cents/.test(createFn) && /paid_amount_type/.test(createFn),
  'optional paid_amount_cents only for staff-recorded cash/bank custom amounts');
check('G2', /no_stripe|payment_link_skipped|no_whatsapp|no_n8n/.test(handler),
  'API handler documents safe no-side-effect flags on create');

check('H1', /source:\s*source/.test(payloadBlock)
  && /body\.source\s*\|\|\s*body\.booking_source/.test(handler),
  'UI sends source; handler accepts source || booking_source');

console.log(`\n── Result: ${failed === 0 ? 'PASS' : 'FAIL'} ──`);
console.log(`${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);

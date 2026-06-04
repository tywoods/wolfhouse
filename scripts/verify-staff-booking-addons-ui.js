/**
 * Phase 10.6a / 10.6a.1 — Static verifier for staff add-ons UI + API.
 *
 * Usage:
 *   npm run verify:staff-booking-addons-ui
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');
const MIG_DIR  = path.join(__dirname, '..', 'database', 'migrations');

let passes = 0;
let failures = 0;

function ok(msg)   { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, msgPass, msgFail) { if (cond) ok(msgPass); else fail(msgFail || msgPass); }

console.log('\nverify-staff-booking-addons-ui.js  (Phase 10.6a / 10.6a.2)\n');

check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) process.exit(1);

const src = fs.readFileSync(API_FILE, 'utf8');

try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'ignore' });
  ok('staff-query-api.js passes node --check');
} catch (_) {
  fail('staff-query-api.js passes node --check');
}

const addHandlerMatch = src.match(
  /async function handleBookingAddService[\s\S]*?async function handleBookingRemoveService/
);
const addHandlerBlock = addHandlerMatch ? addHandlerMatch[0] : '';

const removeHandlerMatch = src.match(
  /async function handleBookingRemoveService[\s\S]*?async function handleQuotePreview/
);
const removeHandlerBlock = removeHandlerMatch ? removeHandlerMatch[0] : '';

const addUiBlock =
  (src.match(/function bcInitAddServiceShell[\s\S]*?function bcInitBookingCancelShell/)?.[0] || '') +
  (src.match(/function bcRunAddServiceSave[\s\S]*?function bcInitAddServiceShell/)?.[0] || '') +
  (src.match(/function bcRunRemoveServiceSave[\s\S]*?function bcRunAddServiceSave/)?.[0] || '') +
  (src.match(/function bcPopulateRemoveSelect[\s\S]*?function bcOpenAddServiceForm/)?.[0] || '') +
  (src.match(/function bcOpenAddServiceForm[\s\S]*?function bcRenderAddServiceResult/)?.[0] || '');

const addPanelBlock = src.match(
  /function bcRenderAddServicePanelHtml[\s\S]*?function bcNewAddServiceIdempotencyKey/
)?.[0] || '';

const drawerFn = src.match(/function renderBookingContextDrawer[\s\S]*?return html;\r?\n\}/)?.[0] || '';

const drawerAddPlacement = drawerFn.match(
  /bcRenderAddServicePanelHtml[\s\S]*?(?:bcRenderRunningInvoiceHtml|id="bc-move-bed")/
)?.[0] || '';

const invHelpers = src.match(
  /\/\* Phase 10\.4d — running invoice helpers[\s\S]*?function bcRenderRunningInvoiceHtml/
)?.[0] || '';

const pricingBlock = src.match(
  /function staffAddonResolvePricing[\s\S]*?async function handleBookingAddService/
)?.[0] || '';

const clientLabelBlock = src.match(
  /function staffAddonUiTypeLabel\(uiType\)[\s\S]*?function bcRunningInvoiceSvcTypeLabel/
)?.[0] || '';

console.log('\nA. Runtime — staffAddonUiTypeLabel in drawer JS');

check(/function staffAddonUiTypeLabel\(uiType\)/.test(clientLabelBlock),
  'staffAddonUiTypeLabel defined in embedded drawer JS');
check(/function bcRunningInvoiceSvcTypeLabel[\s\S]*?staffAddonUiTypeLabel/.test(invHelpers),
  'running invoice labels call staffAddonUiTypeLabel (no undefined at runtime)');

console.log('\nB. Layout — Add-ons above Move bed and Payment');

check(drawerAddPlacement.length > 0,
  'Add-ons panel renders before Move bed / Payment in drawer');
check(/bcRenderAddServicePanelHtml[\s\S]*?id="bc-move-bed"/.test(drawerFn),
  'drawer order: add-ons panel then Move bed');
check(/bcRenderAddServicePanelHtml[\s\S]*?bcRenderRunningInvoiceHtml/.test(drawerFn),
  'drawer order: add-ons panel then running invoice');
check(!/id="bc-move-bed"[\s\S]*?bcRenderAddServicePanelHtml/.test(drawerFn),
  'Move bed is not above add-ons panel');
check(!/bcRenderRunningInvoiceHtml[\s\S]*?bcRenderAddServicePanelHtml/.test(drawerFn),
  'running invoice is not above add-ons panel');

console.log('\nC. UI — compact Add-ons header (Add + Remove near title)');

check(/id="bc-add-ons-panel"/.test(addPanelBlock), 'Add-ons panel id bc-add-ons-panel');
check(/bc-add-ons-title/.test(addPanelBlock) && />Add-ons</.test(addPanelBlock),
  'Add-ons section title present');
check(/bc-add-ons-actions/.test(addPanelBlock), 'add-ons action buttons grouped near title');
check(!/justify-content:\s*space-between/.test(
  src.match(/\.ctx-add-ons-panel \.bc-add-ons-header[\s\S]*?\}/)?.[0] || ''
),
  'add-ons header does not push buttons to far drawer edge');
check(/id="bc-add-ons-btn"/.test(addPanelBlock) && />Add</.test(addPanelBlock),
  'Add button present');
check(/id="bc-add-ons-remove-btn"/.test(addPanelBlock) && />Remove</.test(addPanelBlock),
  'Remove button present in header actions');
check(/bc-add-ons-header[\s\S]*?bc-add-ons-title[\s\S]*?bc-add-ons-actions[\s\S]*?bc-add-ons-btn/.test(addPanelBlock),
  'Add button grouped with title (compact header)');
check(/id="bc-add-ons-form-wrap"/.test(addPanelBlock), 'inline add-ons form wrap exists');
check(/id="bc-add-ons-remove-wrap"/.test(addPanelBlock), 'inline remove form wrap exists');
check(/id="bc-add-ons-remove-select"/.test(addPanelBlock), 'remove add-on select exists');
check(/Confirm remove/.test(addPanelBlock), 'Confirm remove button in remove form');
check(/id="bc-add-ons-type"/.test(addPanelBlock), 'add-on type dropdown exists');
check(/value="wetsuit"/.test(addPanelBlock) && /value="soft_board"/.test(addPanelBlock) &&
  /value="hard_board"/.test(addPanelBlock) && /value="surf_lesson"/.test(addPanelBlock) &&
  /value="yoga"/.test(addPanelBlock) && /value="meals"/.test(addPanelBlock),
  'dropdown includes wetsuit, soft_board, hard_board, surf_lesson, yoga, meals');
check(/id="bc-add-ons-qty"/.test(addPanelBlock), 'quantity input exists');
check(/id="bc-add-ons-date"/.test(addPanelBlock), 'add-on date input exists');
check(/id="bc-add-ons-note"/.test(addPanelBlock), 'optional note input exists');

console.log('\nD. Staff-facing copy — no service wording in panel UI');

check(!/Add service|Save service|Service type|Service date/i.test(addPanelBlock),
  'add-ons panel HTML avoids staff-facing "service" wording');
check(!/\\u20ac\d|€\d|\(\\u20ac|\(\u20ac/.test(addPanelBlock),
  'dropdown option labels do not embed prices');
check(/function bcInitAddServiceShell/.test(src), 'bcInitAddServiceShell wires drawer controls');
check(/bcInitAddServiceShell\(res\.data\)/.test(src), 'drawer load initializes add-ons shell');

console.log('\nD2. Remove UI — existing service_records only');

check(/function bcPopulateRemoveSelect/.test(addUiBlock),
  'bcPopulateRemoveSelect builds remove options from context');
check(/bcRunningInvoiceSvcLineText\(sr\)/.test(addUiBlock),
  'remove list labels reuse running invoice line text');
check(/function bcUpdateRemoveButton/.test(addUiBlock),
  'bcUpdateRemoveButton toggles Remove visibility');
check(/bcUpdateRemoveButton\(svcRows/.test(addUiBlock),
  'Remove button state depends on service_records length');
check(!/value="wetsuit"/.test(
  (addPanelBlock.match(/id="bc-add-ons-remove-select"[\s\S]*?<\/select>/)?.[0] || '')
),
  'remove select is not a static add-on type dropdown');
check(/data\.service_records/.test(addUiBlock),
  'remove flow reads service_records from drawer context');
check(/bcOpenRemoveServiceForm/.test(addUiBlock) && /bcCloseRemoveServiceForm/.test(addUiBlock),
  'remove form open/close helpers exist');

console.log('\nE. API — POST /staff/bookings/add-service (endpoint name unchanged)');

check(/async function handleBookingAddService/.test(src), 'handleBookingAddService handler exists');
check(/pathname === '\/staff\/bookings\/add-service'/.test(src), 'route POST /staff/bookings/add-service registered');
check(/requireAuth\(req, res, 'operator'\)/.test(
  src.slice(src.indexOf("pathname === '/staff/bookings/add-service'"), src.indexOf("pathname === '/staff/bookings/add-service'") + 420)
), 'add-service route requires operator auth');
check(/service_type/.test(addHandlerBlock) && /idempotency_key/.test(addHandlerBlock),
  'request accepts service_type and idempotency_key');
check(/staffAddonResolvePricing/.test(addHandlerBlock),
  'handler uses staffAddonResolvePricing for amount_due_cents');
check(/'meals'/.test(addHandlerBlock) || /meals/.test(pricingBlock),
  'meals supported in pricing or validation');

console.log('\nF. Pricing — config/helper (not dropdown labels)');

check(/staffAddonLoadPricingConfig|wolfhouse-somo\.pricing\.json/.test(pricingBlock),
  'pricing loads wolfhouse config file');
check(/wetsuit_rental/.test(pricingBlock) && /soft_top_rental/.test(pricingBlock) &&
  /hard_board_rental/.test(pricingBlock),
  'pricing uses wolfhouse config rental codes');
check(/surf_lesson_single/.test(pricingBlock) && /surf_lesson_multi/.test(pricingBlock),
  'surf lesson single vs multi pricing');
check(/yoga_class/.test(pricingBlock), 'yoga class pricing');
check(/uiServiceType === 'meals'/.test(pricingBlock),
  'meals branch in staffAddonResolvePricing');
check(/Meals pricing is not configured/.test(pricingBlock),
  'meals returns clear error when config price missing (no invented price)');
check(!/>Wetsuit \(\\u20ac/.test(addPanelBlock) && !/>Wetsuit \(€/.test(addPanelBlock),
  'dropdown labels are not the price source');

console.log('\nG. booking_service_records INSERT only');

check(/INSERT INTO booking_service_records/.test(addHandlerBlock),
  'INSERT into booking_service_records');
check(/'requested'/.test(addHandlerBlock), "status uses 'requested' convention");
check(/'not_requested'/.test(addHandlerBlock), "payment_status uses 'not_requested' (unpaid)");
check(/'staff_manual'/.test(addHandlerBlock), "source is 'staff_manual'");
check(!/INSERT INTO payments|UPDATE payments|amount_paid_cents\s*=/.test(addHandlerBlock),
  'no payments paid-truth mutation in add-service handler');
check(!/UPDATE booking_beds|DELETE FROM booking_beds|INSERT INTO booking_beds/i.test(addHandlerBlock),
  'no booking_beds mutation in add-service handler');
check(!/api\.stripe\.com|createStripe|payment_link/i.test(addHandlerBlock + addUiBlock),
  'no Stripe link creation in add-ons slice');

console.log('\nH. Running invoice consumes service_records + board labels');

check(/bcRunningInvoiceSvcLineText/.test(invHelpers),
  'running invoice line builder exists');
check(/bcRunningInvoiceSvcTypeLabel/.test(invHelpers),
  'running invoice type label helper exists');
check(/board_variant === 'soft'/.test(invHelpers) && /board_variant === 'hard'/.test(invHelpers),
  'Soft/Hard board labels from board_variant still work');
check(/loadBlockDetail\(code\)/.test(addUiBlock), 'successful add reloads drawer context');
check(/\/staff\/bookings\/add-service/.test(addUiBlock), 'UI posts to /staff/bookings/add-service');
check(/bcCloseAddServiceForm/.test(addUiBlock), 'form closes after success');

console.log('\nH2. API — POST /staff/bookings/remove-service');

check(/async function handleBookingRemoveService/.test(src), 'handleBookingRemoveService handler exists');
check(/pathname === '\/staff\/bookings\/remove-service'/.test(src),
  'route POST /staff/bookings/remove-service registered');
check(/requireAuth\(req, res, 'operator'\)/.test(
  src.slice(src.indexOf("pathname === '/staff/bookings/remove-service'"),
    src.indexOf("pathname === '/staff/bookings/remove-service'") + 420)
), 'remove-service route requires operator auth');
check(/booking_service_record_id/.test(removeHandlerBlock),
  'remove request accepts booking_service_record_id');
check(/DELETE FROM booking_service_records/.test(removeHandlerBlock),
  'remove deletes one booking_service_records row');
check(/row\.booking_id !== bookingRow\.booking_id|record_not_on_booking|not_owned/.test(removeHandlerBlock),
  'remove verifies record belongs to booking');
check(/idempotent:\s*true,\s*removed:\s*false|removed:\s*false[\s\S]*idempotent:\s*true/.test(removeHandlerBlock),
  'idempotent response when row already missing');
check(!/INSERT INTO payments|UPDATE payments|amount_paid_cents\s*=/.test(removeHandlerBlock),
  'no payments paid-truth mutation in remove-service handler');
check(!/UPDATE booking_beds|DELETE FROM booking_beds|INSERT INTO booking_beds/i.test(removeHandlerBlock),
  'no booking_beds mutation in remove-service handler');
const removeUiSlice = src.match(/function bcRunRemoveServiceSave[\s\S]*?function bcRunAddServiceSave/)?.[0] || '';
check(!/api\.stripe\.com|createStripe|payment_link|createRefund/i.test(removeHandlerBlock + removeUiSlice),
  'no Stripe/refund creation in remove-service slice');
check(/\/staff\/bookings\/remove-service/.test(removeUiSlice),
  'UI posts to /staff/bookings/remove-service');
check(/loadBlockDetail\(code\)/.test(removeUiSlice),
  'successful remove reloads drawer context');
check(/bcCloseRemoveServiceForm/.test(addUiBlock),
  'remove form closes after success');

console.log('\nI. Calendar / safety');

check(/bookingStatusIsCancelled/.test(src.match(/function buildCalendarBlocks[\s\S]*?async function handleBedCalendar/)?.[0] || ''),
  'cancelled bookings still filtered from calendar blocks');
check(!/graph\.facebook\.com/i.test(addHandlerBlock + removeHandlerBlock + addUiBlock),
  'no WhatsApp in add-ons slice');
check(!/n8n\.cloud|activate.*workflow/i.test(addHandlerBlock + removeHandlerBlock + addUiBlock),
  'no n8n activation in add-ons slice');
check(!/UPDATE booking_service_records/i.test(addHandlerBlock),
  'add-service handler does not UPDATE existing service rows (INSERT only)');
check(!/UPDATE booking_service_records/i.test(removeHandlerBlock),
  'remove-service uses DELETE not UPDATE on service rows');

console.log('\nJ. No docs / migration / deploy in slice');

if (fs.existsSync(MIG_DIR)) {
  const migHit = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).some((f) => {
    const body = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
    return /handleBookingAddService|handleBookingRemoveService|staff\/bookings\/(add|remove)-service/i.test(body);
  });
  check(!migHit, 'no new migration for add-service in this slice');
} else {
  ok('migrations directory not present (skip)');
}

try {
  const docOut = execSync('git diff --name-only HEAD -- docs/', {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  }).trim();
  check(!docOut, 'no docs changes in working tree');
} catch (_) {
  ok('no docs changes in working tree (skip git diff)');
}

check(!/deploy-staff|az containerapp update/i.test(addHandlerBlock + addUiBlock),
  'no deploy scripts in add-ons slice');

console.log('\nK. package.json script');

if (fs.existsSync(PKG_FILE)) {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  check(
    pkg.scripts && pkg.scripts['verify:staff-booking-addons-ui'] ===
      'node scripts/verify-staff-booking-addons-ui.js',
    'package.json has verify:staff-booking-addons-ui script'
  );
} else {
  fail('package.json exists');
}

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);

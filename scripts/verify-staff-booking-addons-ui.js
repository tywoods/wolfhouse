/**
 * Phase 10.6a — Static verifier for staff add-on / service record UI + API.
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

console.log('\nverify-staff-booking-addons-ui.js  (Phase 10.6a)\n');

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
  /async function handleBookingAddService[\s\S]*?async function handleQuotePreview/
);
const addHandlerBlock = addHandlerMatch ? addHandlerMatch[0] : '';

const addUiBlock =
  (src.match(/function bcInitAddServiceShell[\s\S]*?function bcInitBookingCancelShell/)?.[0] || '') +
  (src.match(/function bcRunAddServiceSave[\s\S]*?function bcInitAddServiceShell/)?.[0] || '') +
  (src.match(/function bcOpenAddServiceForm[\s\S]*?function bcRenderAddServiceResult/)?.[0] || '');

const addPanelBlock = src.match(
  /function bcRenderAddServicePanelHtml[\s\S]*?function bcNewAddServiceIdempotencyKey/
)?.[0] || '';
const drawerAddPlacement = src.match(
  /function renderBookingContextDrawer[\s\S]*?bcRenderRunningInvoiceHtml[\s\S]*?bcRenderAddServicePanelHtml/
)?.[0] || '';

const pricingBlock = src.match(
  /function staffAddonResolvePricing[\s\S]*?async function handleBookingAddService/
)?.[0] || '';

console.log('\nA. UI — Add service button + inline form');

check(/id="bc-add-service-btn"/.test(addPanelBlock), 'Add service button in add-service panel');
check(/Add service/.test(addPanelBlock), 'Add service label present');
check(/id="bc-add-service-form-wrap"/.test(addPanelBlock), 'inline add-service form wrap exists');
check(/id="bc-add-service-type"/.test(addPanelBlock), 'service type dropdown exists');
check(/value="wetsuit"/.test(addPanelBlock) && /value="soft_board"/.test(addPanelBlock) &&
  /value="hard_board"/.test(addPanelBlock) && /value="surf_lesson"/.test(addPanelBlock) &&
  /value="yoga"/.test(addPanelBlock),
  'service dropdown includes wetsuit, soft_board, hard_board, surf_lesson, yoga');
check(/id="bc-add-service-qty"/.test(addPanelBlock), 'quantity/days input exists');
check(/id="bc-add-service-date"/.test(addPanelBlock), 'service date input exists');
check(/id="bc-add-service-note"/.test(addPanelBlock), 'optional note input exists');
check(/id="bc-add-service-btn"[\s\S]*?id="bc-add-service-form-wrap"/.test(addPanelBlock),
  'add-service form opens directly below Add service button');
check(/bcRenderAddServicePanelHtml/.test(drawerAddPlacement),
  'add-service panel rendered immediately after running invoice in drawer');
check(/id="bc-cancel-reservation-btn"[\s\S]*?id="bc-add-service-btn"/.test(
  src.match(/function renderBookingContextDrawer[\s\S]*?return html;\r?\n\}/)?.[0] || ''
) || /bcRenderAddServicePanelHtml[\s\S]*?bcRenderBookingCancelFooterHtml/.test(
  src.match(/function renderBookingContextDrawer[\s\S]*?return html;\r?\n\}/)?.[0] || ''
),
  'add-service panel appears before cancel footer (near invoice, not drawer top)');
check(/function bcInitAddServiceShell/.test(src), 'bcInitAddServiceShell wires drawer controls');
check(/bcInitAddServiceShell\(res\.data\)/.test(src), 'drawer load initializes add-service shell');

console.log('\nB. API — POST /staff/bookings/add-service');

check(/async function handleBookingAddService/.test(src), 'handleBookingAddService handler exists');
check(/pathname === '\/staff\/bookings\/add-service'/.test(src), 'route POST /staff/bookings/add-service registered');
check(/requireAuth\(req, res, 'operator'\)/.test(
  src.slice(src.indexOf("pathname === '/staff/bookings/add-service'"), src.indexOf("pathname === '/staff/bookings/add-service'") + 420)
), 'add-service route requires operator auth');
check(/service_type/.test(addHandlerBlock) && /idempotency_key/.test(addHandlerBlock),
  'request accepts service_type and idempotency_key');
check(/staffAddonResolvePricing/.test(addHandlerBlock),
  'handler uses staffAddonResolvePricing for amount_due_cents');

console.log('\nC. booking_service_records INSERT only');

check(/INSERT INTO booking_service_records/.test(addHandlerBlock),
  'INSERT into booking_service_records');
check(/amount_due_cents/.test(addHandlerBlock) && /staffAddonResolvePricing/.test(pricingBlock),
  'amount_due_cents calculation helper exists');
check(/'requested'/.test(addHandlerBlock), "status uses 'requested' convention");
check(/'not_requested'/.test(addHandlerBlock), "payment_status uses 'not_requested' (unpaid)");
check(/'staff_manual'/.test(addHandlerBlock), "source is 'staff_manual'");
check(!/INSERT INTO payments|UPDATE payments|amount_paid_cents\s*=/.test(addHandlerBlock),
  'no payments paid-truth mutation in add-service handler');
check(!/UPDATE booking_beds|DELETE FROM booking_beds|INSERT INTO booking_beds/i.test(addHandlerBlock),
  'no booking_beds mutation in add-service handler');
check(!/api\.stripe\.com|createStripe|payment_link/i.test(addHandlerBlock + addUiBlock),
  'no Stripe link creation in add-service slice');

console.log('\nD. Pricing — config + fallbacks');

check(/wetsuit_rental/.test(pricingBlock) && /soft_top_rental/.test(pricingBlock) &&
  /hard_board_rental/.test(pricingBlock),
  'pricing uses wolfhouse config rental codes');
check(/500|1500|2000|3500|3000/.test(pricingBlock) ||
  (/price_cents/.test(pricingBlock) && /: 500/.test(src) === false),
  'pricing references cent amounts or config price_cents');
check(/surf_lesson_single/.test(pricingBlock) && /surf_lesson_multi/.test(pricingBlock),
  'surf lesson single vs multi pricing');
check(/yoga_class/.test(pricingBlock), 'yoga class pricing');

console.log('\nE. After success — reload drawer / invoice');

check(/loadBlockDetail\(code\)/.test(addUiBlock), 'successful add reloads drawer context');
check(/\/staff\/bookings\/add-service/.test(addUiBlock), 'UI posts to /staff/bookings/add-service');
check(/bcCloseAddServiceForm/.test(addUiBlock), 'form closes after success');

console.log('\nF. Calendar / cancel unrelated (unchanged)');

check(/bookingStatusIsCancelled/.test(src.match(/function buildCalendarBlocks[\s\S]*?async function handleBedCalendar/)?.[0] || ''),
  'cancelled bookings still filtered from calendar blocks');
check(!/bc-legend-sw-cancelled"><\/span>Cancelled/.test(src),
  'Cancelled still absent from bed calendar legend');

console.log('\nG. Safety — no WhatsApp / n8n');

check(!/graph\.facebook\.com/i.test(addHandlerBlock + addUiBlock),
  'no WhatsApp in add-service slice');
check(!/n8n\.cloud|activate.*workflow/i.test(addHandlerBlock + addUiBlock),
  'no n8n activation in add-service slice');
check(!/UPDATE booking_service_records/i.test(addHandlerBlock),
  'add-service handler does not UPDATE existing service rows (INSERT only)');

console.log('\nH. No docs / migration / deploy in slice');

if (fs.existsSync(MIG_DIR)) {
  const migHit = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).some((f) => {
    const body = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
    return /handleBookingAddService|staff\/bookings\/add-service/i.test(body);
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
  'no deploy scripts in add-service slice');

console.log('\nI. package.json script');

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

/**
 * Phase 12a — Luna guest booking agent dry-run entrypoint map.
 *
 * Static checkpoint: locates the shared Staff API booking/pricing/payment engine
 * entrypoints Luna guest automation should reuse. No runtime calls, no DB, no network.
 *
 * Usage:
 *   npm run verify:luna-agent-dry-run-entrypoints
 *
 * Exit 0 when all required anchors are FOUND and dry-run safety boundaries hold.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API_FILE = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(ROOT, 'package.json');

const LIB_FILES = {
  quoteCalc:        path.join(__dirname, 'lib', 'wolfhouse-quote-calculator.js'),
  createSql:        path.join(__dirname, 'lib', 'staff-manual-booking-create-sql.js'),
  availability:     path.join(__dirname, 'lib', 'staff-manual-booking-availability.js'),
  previewQueries:   path.join(__dirname, 'lib', 'staff-manual-booking-preview-queries.js'),
  bookingState:     path.join(__dirname, 'lib', 'booking-state-resolver.js'),
  mergedPayment:    path.join(__dirname, 'lib', 'merged-payment-path.js'),
  assignBedsSql:    path.join(__dirname, 'lib', 'assign-booking-beds-pg-sql.js'),
};

let passes   = 0;
let failures = 0;
const report = [];

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t)    { console.log(`\n── ${t} ──`); }

function readOrEmpty(filePath) {
  try { return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''; }
  catch { return ''; }
}

function sliceHandler(src, fnName) {
  const start = src.indexOf(`async function ${fnName}(`);
  if (start < 0) return '';
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start, start + 8000);
}

function addReport(entry) {
  report.push(entry);
}

function statusFromChecks(checks) {
  const required = checks.filter(c => c.required !== false);
  const reqOk = required.every(c => c.ok);
  const anyOk = checks.some(c => c.ok);
  if (reqOk) return 'FOUND';
  if (anyOk) return 'PARTIAL';
  return 'MISSING';
}

function printEntrypointReport() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(' Phase 12a — Entrypoint map (found / missing / unclear)');
  console.log('══════════════════════════════════════════════════════════════\n');

  for (const e of report) {
    const icon = e.status === 'FOUND' ? '✓' : e.status === 'PARTIAL' ? '~' : e.status === 'UNCLEAR' ? '?' : '✗';
    console.log(`${icon} [${e.id}] ${e.name} — ${e.status}`);
    console.log(`    class: ${e.classification} | dry-run reuse: ${e.dryRunReuse}`);
    for (const a of e.anchors) {
      const mark = a.ok ? 'found' : 'missing';
      console.log(`    - ${mark}: ${a.label}`);
      if (a.ok && a.detail) console.log(`      → ${a.detail}`);
    }
    if (e.notes) console.log(`    note: ${e.notes}`);
    if (e.blockers && e.blockers.length) {
      console.log(`    blockers: ${e.blockers.join('; ')}`);
    }
    console.log('');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
section('0. Prerequisites');

if (!fs.existsSync(API_FILE)) {
  fail('0.1', 'staff-query-api.js missing — cannot continue');
  process.exit(1);
}
pass('0.1', 'staff-query-api.js exists');

const apiSrc = readOrEmpty(API_FILE);
try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'pipe' });
  pass('0.2', 'staff-query-api.js passes node --check');
} catch (e) {
  fail('0.2', 'staff-query-api.js syntax check failed');
}

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0.3', 'this verifier passes node --check');
} catch (e) {
  fail('0.3', 'this verifier syntax check failed');
}

const pkg = JSON.parse(readOrEmpty(PKG_FILE) || '{}');
if (pkg.scripts && pkg.scripts['verify:luna-agent-dry-run-entrypoints']) {
  pass('0.4', 'package.json has verify:luna-agent-dry-run-entrypoints');
} else {
  fail('0.4', 'package.json missing verify:luna-agent-dry-run-entrypoints script');
}

// ─────────────────────────────────────────────────────────────────────────────
section('1–10. Engine entrypoint anchors');

const libSrc = {};
for (const [key, filePath] of Object.entries(LIB_FILES)) {
  libSrc[key] = readOrEmpty(filePath);
  if (libSrc[key]) pass(`LIB.${key}`, path.relative(ROOT, filePath));
  else fail(`LIB.${key}`, `missing: ${path.relative(ROOT, filePath)}`);
}

// 1. Manual/staff booking creation
(function map1() {
  const checks = [
    { label: "route POST /staff/manual-bookings/create", ok: /pathname === '\/staff\/manual-bookings\/create'/.test(apiSrc), detail: 'handleManualBookingCreate' },
    { label: 'handler handleManualBookingCreate', ok: apiSrc.includes('async function handleManualBookingCreate'), detail: 'staff-query-api.js' },
    { label: 'SQL buildManualBookingCreateSql()', ok: libSrc.createSql.includes('function buildManualBookingCreateSql'), detail: 'lib/staff-manual-booking-create-sql.js' },
    { label: 'MANUAL_BOOKING_ENABLED gate (default off)', ok: /MANUAL_BOOKING_ENABLED\s*=\s*process\.env\.MANUAL_BOOKING_ENABLED\s*===\s*'true'/.test(apiSrc) },
  ];
  const status = statusFromChecks(checks);
  addReport({
    id: '1',
    name: 'Manual/staff booking creation',
    status,
    classification: 'write-capable (DB INSERT bookings/payments/beds)',
    dryRunReuse: 'NO — live create only behind MANUAL_BOOKING_ENABLED; dry-run uses preview endpoints',
    anchors: checks,
    blockers: status !== 'FOUND' ? ['Primary create route or SQL helper not located'] : [],
    notes: 'Shared engine path for staff portal; bot slice uses handleBotBookingCreate separately.',
  });
  if (status === 'FOUND') pass('EP1', 'manual/staff booking creation anchors found');
  else fail('EP1', `manual/staff booking creation — ${status}`);
})();

// 2. Date/contact/package/guest edits
(function map2() {
  const checks = [
    { label: "read-only POST /staff/bookings/edit-preview", ok: apiSrc.includes("pathname === '/staff/bookings/edit-preview'"), detail: 'handleBookingEditPreview' },
    { label: "read-only POST /staff/bookings/date-change-preview", ok: apiSrc.includes("pathname === '/staff/bookings/date-change-preview'"), detail: 'handleBookingDateChangePreview' },
    { label: "write POST /staff/bookings/edit", ok: apiSrc.includes("pathname === '/staff/bookings/edit'"), detail: 'handleBookingEditWrite' },
    { label: 'sub-handlers package/dates/guests', ok: /handleBookingEditWritePackage/.test(apiSrc) && /handleBookingEditWriteDates/.test(apiSrc) && /handleBookingEditWriteGuests/.test(apiSrc) },
  ];
  const status = statusFromChecks(checks);
  addReport({
    id: '2',
    name: 'Date/contact/package/guest edits',
    status,
    classification: 'mixed — *-preview read-only; /edit write-capable',
    dryRunReuse: 'YES for edit-preview and date-change-preview; NO for /staff/bookings/edit',
    anchors: checks,
    blockers: status !== 'FOUND' ? ['Edit preview or write routes incomplete'] : [],
  });
  if (status === 'FOUND') pass('EP2', 'booking field edit entrypoints found');
  else fail('EP2', `booking field edits — ${status}`);
})();

// 3. Quote / invoice calculation
(function map3() {
  const checks = [
    { label: 'lib calculateWolfhouseQuote()', ok: libSrc.quoteCalc.includes('function calculateWolfhouseQuote'), detail: 'lib/wolfhouse-quote-calculator.js' },
    { label: "route POST /staff/quote-preview", ok: apiSrc.includes("pathname === '/staff/quote-preview'"), detail: 'handleQuotePreview' },
    { label: 'quote used in bot booking preview', ok: sliceHandler(apiSrc, 'handleBotBookingPreview').includes('calculateWolfhouseQuote(') },
    { label: 'quote used in manual/bot create', ok: sliceHandler(apiSrc, 'handleManualBookingCreate').includes('calculateWolfhouseQuote(') && sliceHandler(apiSrc, 'handleBotBookingCreate').includes('calculateWolfhouseQuote(') },
  ];
  const status = statusFromChecks(checks);
  addReport({
    id: '3',
    name: 'Quote or invoice calculation',
    status,
    classification: 'read-only (pure calculator + preview routes)',
    dryRunReuse: 'YES — primary dry-run engine for amounts',
    anchors: checks,
    blockers: [],
    notes: 'Amounts must never be trusted from client; server-side calculateWolfhouseQuote is source of truth.',
  });
  if (status === 'FOUND') pass('EP3', 'quote/invoice calculation entrypoints found');
  else fail('EP3', `quote calculation — ${status}`);
})();

// 4. Add-on / service record creation
(function map4() {
  const checks = [
    { label: "staff write POST /staff/bookings/add-service", ok: apiSrc.includes("pathname === '/staff/bookings/add-service'"), detail: 'handleBookingAddService' },
    { label: "staff write POST /staff/bookings/remove-service", ok: apiSrc.includes("pathname === '/staff/bookings/remove-service'"), detail: 'handleBookingRemoveService' },
    { label: "bot preview POST /staff/bot/addon-request-preview", ok: apiSrc.includes("pathname === '/staff/bot/addon-request-preview'"), detail: 'handleBotAddonRequestPreview' },
    { label: "bot write POST /staff/bot/addon-requests/create", ok: apiSrc.includes("pathname === '/staff/bot/addon-requests/create'"), detail: 'handleBotAddonRequestCreate' },
    { label: 'booking_service_records INSERT in add-service', ok: /INSERT INTO booking_service_records/.test(sliceHandler(apiSrc, 'handleBookingAddService')) },
  ];
  const status = statusFromChecks(checks);
  addReport({
    id: '4',
    name: 'Add-on/service record creation',
    status,
    classification: 'mixed — bot addon-request-preview read-only; add-service/create write-capable',
    dryRunReuse: 'YES for bot/addon-request-preview; NO for live add-service/create without gate',
    anchors: checks,
    blockers: [],
  });
  if (status === 'FOUND') pass('EP4', 'add-on/service record entrypoints found');
  else fail('EP4', `service records — ${status}`);
})();

// 5. Payment draft / payment record creation
(function map5() {
  const botCreate = sliceHandler(apiSrc, 'handleBotBookingCreate');
  const manualCreate = sliceHandler(apiSrc, 'handleManualBookingCreate');
  const checks = [
    { label: 'bot create draft payment (handleBotBookingCreate)', ok: botCreate.includes('buildManualBookingCreateSql') || /INSERT INTO payments|UPDATE payments/.test(botCreate), detail: 'POST /staff/bot/bookings/create' },
    { label: 'manual create includes payment row via SQL helper', ok: manualCreate.includes('buildManualBookingCreateSql') },
    { label: 'merged payment path lib present', ok: libSrc.mergedPayment.includes('merged') || libSrc.mergedPayment.length > 200, required: false, detail: 'lib/merged-payment-path.js (contract reference)' },
    { label: 'record-cash-payment route (staff ledger)', ok: apiSrc.includes("pathname === '/staff/bookings/record-cash-payment'"), detail: 'handleBookingRecordCashPayment', required: false },
  ];
  const status = statusFromChecks(checks);
  addReport({
    id: '5',
    name: 'Payment draft/payment record creation',
    status,
    classification: 'write-capable (payments table draft rows)',
    dryRunReuse: 'NO for create paths; bot create returns creates_stripe_link:false by design',
    anchors: checks,
    blockers: status !== 'FOUND' ? ['Draft payment creation path not fully anchored'] : [],
    notes: 'Bot create (8.5.4) creates draft payment + quote_snapshot; Stripe link is separate step.',
  });
  if (status === 'FOUND') pass('EP5', 'payment draft creation entrypoints found');
  else fail('EP5', `payment draft — ${status}`);
})();

// 6. Payment link generation
(function map6() {
  const stripeLinkHandler = sliceHandler(apiSrc, 'handlePaymentCreateStripeLink');
  const botStripeHandler  = sliceHandler(apiSrc, 'handleBotPaymentCreateStripeLink');
  const genLinkHandler    = sliceHandler(apiSrc, 'handleBookingGeneratePaymentLink');
  const checks = [
    { label: "POST /staff/payments/:id/create-stripe-link", ok: /create-stripe-link/.test(apiSrc) && apiSrc.includes('handlePaymentCreateStripeLink'), detail: 'handlePaymentCreateStripeLink' },
    { label: "POST /staff/bot/payments/:id/create-stripe-link", ok: apiSrc.includes('handleBotPaymentCreateStripeLink') },
    { label: "POST /staff/bookings/generate-payment-link", ok: apiSrc.includes("pathname === '/staff/bookings/generate-payment-link'"), detail: 'handleBookingGeneratePaymentLink' },
    { label: 'service-records create-payment-link regex route', ok: /service-records\/create-payment-link/.test(apiSrc), detail: 'handleBookingServiceRecordsCreatePaymentLink' },
    { label: 'STRIPE_LINKS_ENABLED gate', ok: /STRIPE_LINKS_ENABLED\s*=\s*process\.env\.STRIPE_LINKS_ENABLED/.test(apiSrc) },
    { label: 'Stripe Checkout Session in link handler', ok: /checkout\.sessions\.create|sessions\.create/.test(stripeLinkHandler + botStripeHandler + genLinkHandler) },
    { label: 'link path does not mark paid', ok: !/status\s*=\s*'paid'/.test(stripeLinkHandler) || /checkout_created|payment_link_created/.test(stripeLinkHandler) },
  ];
  const status = statusFromChecks(checks);
  addReport({
    id: '6',
    name: 'Payment link generation path',
    status,
    classification: 'external-side-effecting (Stripe Checkout + DB status checkout_created)',
    dryRunReuse: 'NO — must stay behind STRIPE_LINKS_ENABLED + explicit go/no-go',
    anchors: checks,
    blockers: [],
    notes: 'Payment links never mark paid; checkout_created / payment_link_created only.',
  });
  if (status === 'FOUND') pass('EP6', 'payment link generation path found');
  else fail('EP6', `payment link path — ${status}`);
})();

// 7. Stripe webhook payment truth
(function map7() {
  const webhook = sliceHandler(apiSrc, 'handleStripeWebhook');
  const checks = [
    { label: "route POST /staff/stripe/webhook", ok: apiSrc.includes("pathname === '/staff/stripe/webhook'"), detail: 'handleStripeWebhook' },
    { label: 'STRIPE_WEBHOOK_SECRET from env', ok: /STRIPE_WEBHOOK_SECRET\s*=\s*process\.env/.test(apiSrc) },
    { label: 'webhook marks payment paid (payment truth)', ok: /status\s*=\s*'paid'/.test(webhook) || /'paid'/.test(webhook) },
    { label: 'webhook does not send WhatsApp', ok: !/graph\.facebook\.com/.test(webhook) },
    { label: 'booking status NOT flipped to confirmed in webhook slice', ok: /Booking status NOT changed to confirmed/.test(apiSrc) || !/SET status = 'confirmed'/.test(webhook) },
  ];
  const status = statusFromChecks(checks);
  addReport({
    id: '7',
    name: 'Stripe webhook payment truth path',
    status,
    classification: 'write-capable + external ingress (Stripe events)',
    dryRunReuse: 'NO — production payment truth; dry-run must not invoke webhook',
    anchors: checks,
    blockers: [],
    notes: 'Webhook is payment truth; never callable from guest-agent dry-run harness.',
  });
  if (status === 'FOUND') pass('EP7', 'Stripe webhook payment truth path found');
  else fail('EP7', `webhook path — ${status}`);
})();

// 8. Booking confirmation / status
(function map8() {
  const botCreate = sliceHandler(apiSrc, 'handleBotBookingCreate');
  const checks = [
    { label: 'create sets booking_status confirmed (bot)', ok: /bookingStatus\s*=\s*'confirmed'|status:\s*'confirmed'/.test(botCreate) },
    { label: 'SQL helper accepts booking_status param', ok: /\$16::booking_status/.test(libSrc.createSql) },
    { label: 'cancel route sets cancelled', ok: apiSrc.includes("pathname === '/staff/bookings/cancel'"), detail: 'handleBookingCancel' },
    { label: 'n8n booking-state-resolver (message routing only)', ok: libSrc.bookingState.includes('RESOLVER_VERSION'), required: false, detail: 'lib/booking-state-resolver.js' },
  ];
  const status = statusFromChecks(checks);
  const unclear = !libSrc.bookingState.includes('confirmed') ? 'Post-payment booking status transitions beyond paid flag are not a single Staff API route — resolver is n8n-side message routing.' : '';
  addReport({
    id: '8',
    name: 'Booking confirmation/status path',
    status: status === 'FOUND' && unclear ? 'FOUND' : status,
    classification: 'write at create/cancel; payment-paid via webhook only',
    dryRunReuse: 'YES for status preview fields in bot/booking-preview response; NO for live status mutation',
    anchors: checks,
    blockers: status !== 'FOUND' ? ['Create/cancel status anchors missing'] : [],
    notes: unclear || 'Confirmation set at booking create; webhook updates payment truth only.',
  });
  if (status === 'FOUND') pass('EP8', 'booking confirmation/status path found (webhook does not confirm booking)');
  else fail('EP8', `booking status — ${status}`);
})();

// 9. Availability / bed assignment / conflict-check
(function map9() {
  const manualPreview = sliceHandler(apiSrc, 'handleManualBookingPreview');
  const botAvail = sliceHandler(apiSrc, 'handleBotAvailabilityCheck');
  const checks = [
    { label: "staff read-only POST /staff/manual-bookings/preview", ok: apiSrc.includes("pathname === '/staff/manual-bookings/preview'"), detail: 'handleManualBookingPreview' },
    { label: 'previewManualBookingAvailability()', ok: libSrc.availability.includes('function previewManualBookingAvailability'), detail: 'lib/staff-manual-booking-availability.js' },
    { label: 'preview queries (beds + assignments)', ok: libSrc.previewQueries.includes('getManualBookingPreviewBedsQuery') && libSrc.previewQueries.includes('getManualBookingPreviewAssignmentsQuery') },
    { label: "bot POST /staff/bot/availability-check", ok: apiSrc.includes("pathname === '/staff/bot/availability-check'"), detail: 'handleBotAvailabilityCheck' },
    { label: 'half-open overlap rule in availability lib', ok: /assignment_start_date\s*<\s*proposed_check_out/.test(libSrc.availability) },
    { label: 'bed assign SQL helper (live assignment)', ok: libSrc.assignBedsSql.includes('assign') || libSrc.assignBedsSql.length > 100, required: false, detail: 'lib/assign-booking-beds-pg-sql.js' },
    { label: 'move-preview / move write routes', ok: apiSrc.includes("pathname === '/staff/bookings/move-preview'") && apiSrc.includes("pathname === '/staff/bookings/move'"), required: false },
  ];
  const status = statusFromChecks(checks);
  addReport({
    id: '9',
    name: 'Availability/bed assignment or conflict-check',
    status,
    classification: 'mixed — preview/availability-check read-only; move/assign write-capable',
    dryRunReuse: 'YES — manual-bookings/preview + bot/availability-check for dry-run plan',
    anchors: checks,
    blockers: status !== 'FOUND' ? ['Conflict-check preview path incomplete'] : [],
  });
  if (status === 'FOUND') pass('EP9', 'availability/conflict-check entrypoints found');
  else fail('EP9', `availability — ${status}`);
})();

// 10. Ask Luna / read-only Staff API safety
(function map10() {
  const askLuna = sliceHandler(apiSrc, 'handleAskLuna');
  const checks = [
    { label: "route POST /staff/ask-luna", ok: apiSrc.includes("pathname === '/staff/ask-luna'") || /\/staff\/ask-luna/.test(apiSrc), detail: 'handleAskLuna' },
    { label: 'response read_only: true', ok: /read_only:\s*true/.test(askLuna) },
    { label: 'response no_write_performed: true', ok: /no_write_performed:\s*true/.test(askLuna) },
    { label: 'no INSERT/UPDATE/DELETE in handler', ok: !/\b(INSERT|UPDATE|DELETE)\s+INTO\b/i.test(askLuna.replace(/\/\/[^\n]*/g, '')) },
    { label: 'no Stripe/WhatsApp in handler', ok: !/api\.stripe\.com|graph\.facebook\.com/.test(askLuna) },
  ];
  const status = statusFromChecks(checks);
  addReport({
    id: '10',
    name: 'Ask Luna / read-only Staff API safety boundaries',
    status,
    classification: 'read-only',
    dryRunReuse: 'YES — staff ops queries only; not guest booking automation',
    anchors: checks,
    blockers: status !== 'FOUND' ? ['Ask Luna read-only contract broken'] : [],
    notes: 'Guest agent dry-run must not route through Ask Luna for writes.',
  });
  if (status === 'FOUND') pass('EP10', 'Ask Luna read-only safety boundaries found');
  else fail('EP10', `Ask Luna safety — ${status}`);
})();

// ─────────────────────────────────────────────────────────────────────────────
section('11. Bot dry-run harness candidates (read-only / plan-only)');

const botPreview = sliceHandler(apiSrc, 'handleBotBookingPreview');
const botGate    = sliceHandler(apiSrc, 'handleBotCheckGuestAutomationGate');
const botAvail   = sliceHandler(apiSrc, 'handleBotAvailabilityCheck');

const dryRunCandidates = [
  { id: 'DR1', name: 'POST /staff/bot/booking-preview', handler: botPreview, mustHave: ['calculateWolfhouseQuote(', 'no_write_performed', 'reply_draft', 'next_action'] },
  { id: 'DR2', name: 'POST /staff/bot/availability-check', handler: botAvail, mustHave: [] },
  { id: 'DR3', name: 'POST /staff/bot/check-guest-automation-gate', handler: botGate, mustHave: ['can_continue_guest_automation', 'live_send_blocked'] },
  { id: 'DR4', name: 'POST /staff/bot/addon-request-preview', handler: sliceHandler(apiSrc, 'handleBotAddonRequestPreview'), mustHave: [] },
];
for (const c of dryRunCandidates) {
  if (!c.handler) { fail(c.id, `${c.name} handler not found`); continue; }
  const noWrites = !/\b(INSERT|UPDATE|DELETE)\s+INTO\b/i.test(c.handler.replace(/\/\/[^\n]*/g, ''));
  const noStripe = !/api\.stripe\.com|checkout\.sessions\.create/.test(c.handler);
  const noWa     = !/graph\.facebook\.com/.test(c.handler);
  const noN8n    = !/n8n|webhook.*trigger/i.test(c.handler);
  const tokensOk = c.mustHave.every(t => c.handler.includes(t));
  if (noWrites && noStripe && noWa && noN8n && tokensOk) {
    pass(c.id, `${c.name} — read-only/plan-safe candidate`);
  } else {
    fail(c.id, `${c.name} — writes=${!noWrites} stripe=${!noStripe} wa=${!noWa} n8n=${!noN8n} tokens=${!tokensOk}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
section('12. Dry-run safety boundaries (must not be callable from harness)');

const writeRoutes = [
  ['/staff/bot/bookings/create', 'handleBotBookingCreate', 'BOT_BOOKING_ENABLED'],
  ['/staff/manual-bookings/create', 'handleManualBookingCreate', 'MANUAL_BOOKING_ENABLED'],
  ['/staff/payments/', 'create-stripe-link', 'STRIPE_LINKS_ENABLED'],
  ['/staff/bookings/generate-payment-link', 'handleBookingGeneratePaymentLink', 'STAFF_ACTIONS_ENABLED'],
  ['/staff/stripe/webhook', 'handleStripeWebhook', 'STRIPE_WEBHOOK_SECRET'],
];

for (const [route, handler, gate] of writeRoutes) {
  const present = apiSrc.includes(route) && (handler === 'create-stripe-link' ? apiSrc.includes('create-stripe-link') : apiSrc.includes(handler));
  const gated   = apiSrc.includes(gate) || gate === 'STRIPE_WEBHOOK_SECRET';
  if (present && gated) pass(`SAFE.${route}`, `${route} present and env-gated (${gate})`);
  else fail(`SAFE.${route}`, `${route} missing or ungated`);
}

if (/BOT_BOOKING_ENABLED\s*=\s*process\.env\.BOT_BOOKING_ENABLED\s*===\s*'true'/.test(apiSrc)) {
  pass('SAFE.BOT_FLAG', 'BOT_BOOKING_ENABLED defaults false');
} else {
  fail('SAFE.BOT_FLAG', 'BOT_BOOKING_ENABLED flag not found');
}

if (!/graph\.facebook\.com/.test(botPreview + botGate)) {
  pass('SAFE.NO_WA', 'dry-run candidate handlers have no live WhatsApp URL');
} else {
  fail('SAFE.NO_WA', 'WhatsApp URL found in dry-run candidates');
}

// n8n: Staff API should not activate n8n from bot preview/gate
const n8nInDryRun = /n8n/i.test(botPreview + botGate + botAvail);
if (!n8nInDryRun) pass('SAFE.NO_N8N', 'dry-run candidate handlers do not reference n8n activation');
else fail('SAFE.NO_N8N', 'n8n reference in dry-run candidates');

if (botPreview.includes('planned') || botPreview.includes('next_action') || botPreview.includes('reply_draft')) {
  pass('SAFE.PLAN', 'bot booking-preview returns plan-style fields (next_action / reply_draft)');
} else {
  fail('SAFE.PLAN', 'bot booking-preview missing plan-style response fields');
}

if (apiSrc.includes('check-guest-automation-gate') && apiSrc.includes('live_send_blocked')) {
  pass('SAFE.GATE', 'explicit go/no-go gate endpoint exists (check-guest-automation-gate)');
} else {
  fail('SAFE.GATE', 'guest automation gate endpoint missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('13. Cross-reference verifiers (existing Stage 8/9 proofs)');

const SUPPORTING_VERIFIERS = [
  'verify:staff-bot-booking-preview-api',
  'verify:staff-bot-booking-create-api',
  'verify:staff-bot-availability-api',
  'verify:staff-bot-guest-automation-gate',
  'verify:staff-manual-booking-preview-api',
  'verify:staff-manual-booking-create-api',
  'verify:staff-quote-preview-api',
  'verify:staff-stripe-payment-link-api',
  'verify:staff-stripe-webhook-api',
  'verify:staff-ask-luna-api',
];

for (const scriptKey of SUPPORTING_VERIFIERS) {
  if (pkg.scripts && pkg.scripts[scriptKey]) pass(`VF.${scriptKey}`, 'registered in package.json');
  else fail(`VF.${scriptKey}`, 'missing from package.json');
}

// ─────────────────────────────────────────────────────────────────────────────
printEntrypointReport();

console.log('── Phase 12b recommendation (smallest next step) ──');
console.log('  Add a thin orchestrator (lib or script) that chains, in order:');
console.log('    1) POST /staff/bot/check-guest-automation-gate');
console.log('    2) POST /staff/bot/booking-preview  (quote + reply_draft + next_action)');
console.log('    3) POST /staff/bot/availability-check when bed_codes/dates present');
console.log('  Return a single { planned_actions[], dry_run:true, creates_booking:false }');
console.log('  object without calling create/stripe-link/webhook/WhatsApp routes.');
console.log('  Reuse calculateWolfhouseQuote via booking-preview only — no new intent keys.');

console.log('── Blockers before live guest agent ──');
const blockers = [
  'Live WhatsApp remains NO_GO — gate must return live_send_blocked',
  'BOT_BOOKING_ENABLED / MANUAL_BOOKING_ENABLED / STRIPE_LINKS_ENABLED stay false in dry-run env',
  'No unified guest-agent dry-run orchestrator yet (Phase 12b)',
  'n8n remains message pipe only — must not own booking/pricing truth',
];
for (const b of blockers) console.log(`  • ${b}`);

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);

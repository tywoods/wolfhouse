/**
 * Stage 27w — Luna Guest Simulator verifier (Staff Portal + API).
 *
 * Usage:
 *   npm run verify:stage27w-luna-guest-simulator
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const DOC = path.join(ROOT, 'docs', 'STAGE-27W-LUNA-GUEST-SIMULATOR.md');
const SCRIPT = 'verify:stage27w-luna-guest-simulator';
const REL = 'scripts/verify-stage27w-luna-guest-simulator.js';

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage27w-luna-guest-simulator.js  (Stage 27w)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

if (!fs.existsSync(API)) {
  fail('init', 'staff-query-api.js missing');
  process.exit(1);
}

const src = fs.readFileSync(API, 'utf8');

const holdRouteIdx = src.indexOf("if (pathname === '/staff/bot/guest-simulator-create-hold-draft')");
const stripeRouteIdx = src.indexOf("if (pathname === '/staff/bot/guest-simulator-create-stripe-test-link')");
const holdRouteBlock = holdRouteIdx > -1 ? src.slice(holdRouteIdx, holdRouteIdx + 900) : '';
const stripeRouteBlock = stripeRouteIdx > -1 ? src.slice(stripeRouteIdx, stripeRouteIdx + 900) : '';

const holdHandlerStart = src.indexOf('async function handleBotGuestSimulatorCreateHoldDraft(');
const holdHandlerEnd = holdHandlerStart > -1
  ? src.indexOf('\n// Route: POST /staff/bot/guest-simulator-create-stripe-test-link', holdHandlerStart)
  : -1;
const holdHandler = holdHandlerStart > -1 && holdHandlerEnd > holdHandlerStart
  ? src.slice(holdHandlerStart, holdHandlerEnd)
  : '';

const stripeHandlerStart = src.indexOf('async function handleBotGuestSimulatorCreateStripeTestLink(');
const stripeHandlerEnd = stripeHandlerStart > -1
  ? src.indexOf('\n// Phase 13c — in-memory req', stripeHandlerStart)
  : -1;
const stripeHandler = stripeHandlerStart > -1 && stripeHandlerEnd > stripeHandlerStart
  ? src.slice(stripeHandlerStart, stripeHandlerEnd)
  : '';

const holdHandlerCode = holdHandler.replace(/\/\/[^\n]*/g, '');
const stripeHandlerCode = stripeHandler.replace(/\/\/[^\n]*/g, '');

section('A. Staff Portal UI');

if (src.includes('Luna Guest Simulator')) pass('A1', 'UI contains Luna Guest Simulator');
else fail('A1', 'Luna Guest Simulator title missing');

if (src.includes('tab-luna-guest-simulator')) pass('A2', 'simulator tab panel exists');
else fail('A2', 'tab panel missing');

if (src.includes('lgs-btn-review') && src.includes('guest-automation-review-dry-run')) {
  pass('A3', 'UI calls guest-automation-review-dry-run');
} else {
  fail('A3', 'review endpoint call missing in UI');
}

if (src.includes('lgs-btn-hold') && src.includes('Create Test Hold + Draft Payment')) {
  pass('A4', 'Create Test Hold + Draft Payment button');
} else {
  fail('A4', 'hold button missing');
}

if (src.includes('lgs-btn-stripe') && src.includes('Create Stripe TEST Link')) {
  pass('A5', 'Create Stripe TEST Link button');
} else {
  fail('A5', 'Stripe button missing');
}

if (src.includes('stripe_checkout_url') && src.includes('lgs-stripe-url')) {
  pass('A6', 'UI displays stripe_checkout_url');
} else {
  fail('A6', 'stripe URL display missing');
}

if (src.includes('lgs-btn-use-context') && src.includes('Use review result as guest_context')
    && /extracted_fields:\s*r\.result/.test(src) && /result:\s*r\.result/.test(src)) {
  pass('A7', 'multi-turn guest_context helper preserves extracted_fields');
} else {
  fail('A7', 'guest_context merge fields missing in simulator');
}

if (/No WhatsApp sent/i.test(src) && /Stripe TEST/i.test(src)) {
  pass('A8', 'safety labels in UI');
} else {
  fail('A8', 'safety labels missing');
}

if (src.includes('hold_payment_draft_plan.plan_status') && src.includes('ready_for_hold_payment_draft')) {
  pass('A9', 'hold button gated on plan + payment choice');
} else {
  fail('A9', 'hold enable gates missing');
}

section('B. Hold/draft API route');

if (holdRouteIdx > -1) pass('B1', 'hold/draft route registered');
else fail('B1', 'hold route missing');

if (holdRouteBlock.includes('requireBotAuth')) pass('B2', 'hold route uses requireBotAuth');
else fail('B2', 'hold requireBotAuth missing');

if (holdHandler.includes('runGuestHoldPaymentDraftWriteDryRunApproved(')) {
  pass('B3', 'hold handler calls 27n write helper');
} else {
  fail('B3', '27n helper not called');
}

if (holdHandler.includes('confirm_write: true') && holdHandler.includes('confirm_simulator_write')) {
  pass('B4', 'confirm_write + confirm_simulator_write gates');
} else {
  fail('B4', 'confirm gates missing on hold handler');
}

if (holdHandler.includes('guestSimulatorProductionBlocked')) pass('B5', 'non-production gate');
else fail('B5', 'production block missing');

section('C. Stripe TEST API route');

if (stripeRouteIdx > -1) pass('C1', 'Stripe route registered');
else fail('C1', 'Stripe route missing');

if (stripeRouteBlock.includes('requireBotAuth')) pass('C2', 'Stripe route uses requireBotAuth');
else fail('C2', 'Stripe requireBotAuth missing');

if (stripeHandler.includes('runGuestStripeTestLinkCreateApproved(')) {
  pass('C3', 'Stripe handler calls 27o helper');
} else {
  fail('C3', '27o helper not called');
}

if (stripeHandler.includes('confirm_stripe_test_link: true') && stripeHandler.includes('confirm_simulator_stripe')) {
  pass('C4', 'confirm_stripe_test_link + confirm_simulator_stripe');
} else {
  fail('C4', 'Stripe confirm gates missing');
}

section('D. Safety — handlers');

const forbidden = [
  ['D1', 'handleBotGuestReplySend', holdHandler + stripeHandler],
  ['D2', 'runGuestConfirmationSendGoNoGo', holdHandler + stripeHandler],
  ['D3', 'sendWhatsApp', holdHandler + stripeHandler],
  ['D4', 'processMetaWhatsApp', holdHandler + stripeHandler],
];
for (const [id, sym, hay] of forbidden) {
  if (!hay.includes(sym)) pass(id, `handlers do not call ${sym}`);
  else fail(id, `forbidden ${sym} in handlers`);
}

if (!/api\.stripe\.com|graph\.facebook|n8n/i.test(holdHandler + stripeHandler)) {
  pass('D5', 'no direct Stripe/Meta/n8n fetch in handlers');
} else {
  fail('D5', 'forbidden fetch in handlers');
}

if (holdHandler.includes('sends_whatsapp: false') || holdHandler.includes('...writeOut')) {
  pass('D6', 'hold response preserves write safety flags');
} else {
  fail('D6', 'hold safety flags');
}

section('E. No public webhook');

if (!src.includes("'/webhook/guest-simulator")) pass('E1', 'no public guest-simulator webhook');
else fail('E1', 'public webhook detected');

if (!src.includes("'/guest-simulator-create-hold-draft'") || src.includes("'/staff/bot/guest-simulator-create-hold-draft'")) {
  pass('E2', 'routes under /staff/bot/ only');
} else {
  fail('E2', 'non-staff route path');
}

section('F. Docs and npm script');

if (fs.existsSync(DOC)) pass('F1', 'STAGE-27W doc exists');
else fail('F1', 'doc missing');

if (fs.existsSync(DOC)) {
  const doc = fs.readFileSync(DOC, 'utf8');
  if (doc.includes('npm run staff:api')) pass('F2', 'doc local usage');
  if (/No WhatsApp|no WhatsApp/i.test(doc)) pass('F3', 'doc no WhatsApp');
  if (/Stripe TEST/i.test(doc)) pass('F4', 'doc Stripe TEST only');
}

try {
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('F5', 'staff-query-api.js passes node --check');
} catch {
  fail('F5', 'staff-query-api.js syntax error');
}

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT] === `node ${REL}`) pass('F6', `${SCRIPT} registered`);
else fail('F6', `${SCRIPT} missing`);

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);

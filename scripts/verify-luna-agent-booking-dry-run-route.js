/**
 * Phase 12c — Verifier for POST /staff/bot/booking-dry-run.
 *
 * Usage:
 *   npm run verify:luna-agent-booking-dry-run-route
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API  = path.join(__dirname, 'staff-query-api.js');
const LIB  = path.join(__dirname, 'lib', 'luna-guest-booking-dry-run.js');
const PROOF = path.join(__dirname, 'proof-luna-booking-dry-run-route.js');
const PKG  = path.join(ROOT, 'package.json');

let passes   = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t)    { console.log(`\n── ${t} ──`); }

if (!fs.existsSync(API)) {
  fail('0', 'staff-query-api.js missing');
  process.exit(1);
}

const src = fs.readFileSync(API, 'utf8');

const routeIdx   = src.indexOf("'/staff/bot/booking-dry-run'");
const routeBlock = routeIdx > -1 ? src.slice(routeIdx, routeIdx + 650) : '';

const handlerStart = src.indexOf('async function handleBotBookingDryRun(');
const handlerEnd   = handlerStart > -1
  ? src.indexOf('\n// ─────────────────────────────────────────────────────────────────────────────', handlerStart + 200)
  : -1;
const handler = handlerStart > -1
  ? src.slice(handlerStart, handlerEnd > handlerStart ? handlerEnd : handlerStart + 6000)
  : '';

const handlerCode = handler.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ─────────────────────────────────────────────────────────────────────────────
section('A. Route and handler');

if (routeIdx > -1) pass('A1', "route POST /staff/bot/booking-dry-run registered");
else fail('A1', 'route not registered');

if (routeBlock.includes("method !== 'POST'")) pass('A2', 'POST-only guard');
else fail('A2', 'POST-only guard missing');

if (handlerStart > -1) pass('A3', 'handleBotBookingDryRun defined');
else fail('A3', 'handleBotBookingDryRun missing');

if (routeBlock.includes('handleBotBookingDryRun')) pass('A4', 'router dispatches handleBotBookingDryRun');
else fail('A4', 'router does not call handler');

if (src.includes('bot/booking-dry-run') && src.includes('12c')) pass('A5', 'startup log mentions booking-dry-run');
else fail('A5', 'startup log missing booking-dry-run');

try {
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('A6', 'staff-query-api.js passes node --check');
} catch (e) {
  fail('A6', 'staff-query-api.js syntax error');
}

// ─────────────────────────────────────────────────────────────────────────────
section('B. Auth (bot preview pattern)');

if (routeBlock.includes('requireBotAuth')) pass('B1', 'route uses requireBotAuth');
else fail('B1', 'requireBotAuth not used');

if (src.includes('async function requireBotAuth(')) pass('B2', 'requireBotAuth defined');
else fail('B2', 'requireBotAuth missing');

if (!routeBlock.includes('requireAuth(req, res, \'operator\')')) {
  pass('B3', 'route does not use operator requireAuth (uses bot auth)');
} else {
  fail('B3', 'route uses session operator auth instead of bot auth');
}

// ─────────────────────────────────────────────────────────────────────────────
section('C. Orchestrator reuse');

if (/require\(['"]\.\/lib\/luna-guest-booking-dry-run['"]\)/.test(src)) {
  pass('C1', 'imports luna-guest-booking-dry-run');
} else {
  fail('C1', 'luna-guest-booking-dry-run not imported');
}

if (handler.includes('runLunaGuestBookingDryRun(')) pass('C2', 'handler calls runLunaGuestBookingDryRun');
else fail('C2', 'runLunaGuestBookingDryRun not called in handler');

if (handler.includes('withPgClient') && handler.includes('{ pg }')) {
  pass('C3', 'passes read-only pg via withPgClient');
} else {
  fail('C3', 'withPgClient({ pg }) pattern missing');
}

if (fs.existsSync(LIB)) pass('C4', 'orchestrator lib file exists');
else fail('C4', 'orchestrator lib missing');

// ─────────────────────────────────────────────────────────────────────────────
section('D. Dry-run safety flags in response');

const flagChecks = [
  ['D1', 'dry_run', /dry_run/],
  ['D2', 'preview_only', /preview_only/],
  ['D3', 'no_write_performed', /no_write_performed/],
  ['D4', 'creates_booking', /creates_booking/],
  ['D5', 'creates_payment', /creates_payment/],
  ['D6', 'creates_stripe_link', /creates_stripe_link/],
  ['D7', 'sends_whatsapp', /sends_whatsapp/],
  ['D8', 'calls_n8n', /calls_n8n/],
];

for (const [id, label, pattern] of flagChecks) {
  if (pattern.test(handler) || handler.includes('DRY_RUN_SAFETY_FLAGS')) {
    pass(id, `handler covers ${label} (orchestrator merge)`);
  } else {
    fail(id, `${label} not referenced in handler`);
  }
}

if (handler.includes('dry-run forbids')) pass('D9', 'forbidden live path → safe 400 branch');
else fail('D9', 'forbidden context error handling missing');

// ─────────────────────────────────────────────────────────────────────────────
section('E. No live side effects in handler');

if (!/\bINSERT\s+INTO\b/i.test(handlerCode)) pass('E1', 'handler has no INSERT SQL');
else fail('E1', 'INSERT in handler');

if (!/\bUPDATE\s+\w/i.test(handlerCode)) pass('E2', 'handler has no UPDATE SQL');
else fail('E2', 'UPDATE in handler');

if (!/\bDELETE\s+FROM\b/i.test(handlerCode)) pass('E3', 'handler has no DELETE SQL');
else fail('E3', 'DELETE in handler');

const livePatterns = [
  ['E4', 'handleBotBookingCreate', 'bot booking create'],
  ['E5', 'handleManualBookingCreate', 'manual booking create'],
  ['E6', 'handleBookingGeneratePaymentLink', 'generate payment link'],
  ['E7', 'handlePaymentCreateStripeLink', 'Stripe link create'],
  ['E8', 'handleStripeWebhook', 'Stripe webhook'],
  ['E9', 'handleBotAddonRequestCreate', 'addon create write path'],
];

for (const [id, sym, label] of livePatterns) {
  if (!handler.includes(sym)) pass(id, `handler does not call ${label}`);
  else fail(id, `handler calls ${label}`);
}

if (!/api\.stripe\.com|checkout\.sessions\.create|graph\.facebook\.com/i.test(handler)) {
  pass('E10', 'no Stripe/WhatsApp URLs in handler');
} else {
  fail('E10', 'Stripe/WhatsApp URL in handler');
}

if (!/require\s*\(\s*['"]n8n['"]/i.test(handlerCode)) pass('E11', 'no n8n require in handler');
else fail('E11', 'n8n require in handler');

// ─────────────────────────────────────────────────────────────────────────────
section('F. Proof script (Phase 12h)');

if (fs.existsSync(PROOF)) pass('F1', 'proof-luna-booking-dry-run-route.js exists');
else fail('F1', 'proof script missing');

let proofSrc = '';
if (fs.existsSync(PROOF)) {
  try {
    proofSrc = fs.readFileSync(PROOF, 'utf8');
    execSync(`node --check "${PROOF}"`, { stdio: 'pipe' });
    pass('F2', 'proof script passes node --check');
  } catch (e) {
    fail('F2', 'proof script syntax error');
  }
}

if (proofSrc.includes('/staff/bot/booking-dry-run')) {
  pass('F3', 'proof script targets /staff/bot/booking-dry-run');
} else {
  fail('F3', 'proof script missing booking-dry-run route');
}

const proofAsserts = [
  'dry_run',
  'preview_only',
  'no_write_performed',
  'creates_booking',
  'creates_payment',
  'creates_stripe_link',
  'sends_whatsapp',
  'calls_n8n',
  'planned_actions',
  'reply_draft',
  'next_action',
];
const missingAssert = proofAsserts.filter((f) => !proofSrc.includes(f));
if (!missingAssert.length) pass('F4', 'proof script asserts all safety/plan fields');
else fail('F4', 'proof script missing assertions: ' + missingAssert.join(', '));

const forbiddenProof = [
  ['/staff/bot/bookings/create', 'booking create'],
  ['generate-payment-link', 'payment link'],
  ['create-stripe-link', 'stripe link'],
  ['api.stripe.com', 'Stripe API'],
  ['graph.facebook.com', 'WhatsApp'],
  ['n8n.cloud', 'n8n cloud'],
];
for (const [frag, label] of forbiddenProof) {
  if (!proofSrc.includes(frag)) pass('F5.' + label, 'proof does not call ' + label);
  else fail('F5.' + label, 'forbidden ' + label + ' in proof script');
}

if (!/writeFileSync|createWriteStream|appendFileSync/i.test(proofSrc)) {
  pass('F6', 'proof script does not write files');
} else {
  fail('F6', 'proof script writes files');
}

if (!/console\.(log|error)\s*\([^)]*\bTOKEN\b|console\.(log|error)\s*\([^)]*LUNA_BOT_INTERNAL_TOKEN|console\.(log|error)\s*\([^)]*apiKey/i.test(proofSrc)) {
  pass('F7', 'proof script does not log token secrets');
} else {
  fail('F7', 'proof may log secrets');
}

if (proofSrc.includes('LUNA_BOT_INTERNAL_TOKEN') && proofSrc.includes('X-Luna-Bot-Token')) {
  pass('F8', 'proof uses LUNA_BOT_INTERNAL_TOKEN + X-Luna-Bot-Token header');
} else {
  fail('F8', 'proof auth env/header wiring unclear');
}

// ─────────────────────────────────────────────────────────────────────────────
section('G. package.json scripts');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
if (pkg.scripts && pkg.scripts['verify:luna-agent-booking-dry-run-route']) {
  pass('G1', 'verify:luna-agent-booking-dry-run-route registered');
} else {
  fail('G1', 'verify npm script missing');
}

if (pkg.scripts && pkg.scripts['proof:luna-booking-dry-run-route']) {
  pass('G2', 'proof:luna-booking-dry-run-route registered');
} else {
  fail('G2', 'proof npm script missing');
}

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);

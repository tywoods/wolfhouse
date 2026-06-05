/**
 * Phase 13j — Aggregate closeout verifier for Luna gated booking/payment flow.
 *
 * Chains static proof across Phase 13 write plan, eligibility, bridge, routes,
 * payment-truth separation, Ask Luna lookup, and downstream verifier regression.
 *
 * Usage:
 *   npm run verify:luna-agent-phase13-closeout
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PKG  = path.join(ROOT, 'package.json');
const API  = path.join(__dirname, 'staff-query-api.js');
const DOC  = path.join(ROOT, 'docs', 'PHASE-13.1-LUNA-GATED-BOOKING-WRITES-PLAN.md');
const ELIG = path.join(__dirname, 'lib', 'luna-guest-booking-write-eligibility.js');
const BRIDGE = path.join(__dirname, 'lib', 'luna-guest-booking-write-bridge.js');
const LOOKUP = path.join(__dirname, 'lib', 'staff-ask-luna-booking-lookup.js');

const PHASE13_SCRIPTS = [
  ['verify:luna-agent-phase13-write-gates-plan', 'scripts/verify-luna-agent-phase13-write-gates-plan.js'],
  ['verify:luna-agent-phase13-write-eligibility', 'scripts/verify-luna-agent-phase13-write-eligibility.js'],
  ['verify:luna-agent-phase13-booking-write-bridge', 'scripts/verify-luna-agent-phase13-booking-write-bridge.js'],
  ['verify:luna-agent-phase13-write-eligibility-route', 'scripts/verify-luna-agent-phase13-write-eligibility-route.js'],
  ['verify:luna-agent-phase13-closeout', 'scripts/verify-luna-agent-phase13-closeout.js'],
];

const CLOSEOUT_SCRIPTS = [
  ['verify:luna-agent-phase12-closeout', 'scripts/verify-luna-agent-phase12-closeout.js'],
  ['verify:staff-ask-luna-phase11-closeout', 'scripts/verify-staff-ask-luna-phase11-closeout.js'],
];

const DOWNSTREAM_VERIFIERS = [
  'verify:luna-agent-phase13-booking-write-bridge',
  'verify:luna-agent-phase13-write-eligibility-route',
  'verify:luna-agent-phase13-write-eligibility',
  'verify:luna-agent-phase13-write-gates-plan',
  'verify:luna-agent-phase12-closeout',
  'verify:staff-ask-luna-phase11-closeout',
  'verify:staff-ask-luna-booking-lookup',
];

const BRIDGE_FORBIDDEN = [
  ['checkout.sessions.create', 'Stripe checkout in bridge'],
  ['graph.facebook.com', 'WhatsApp Graph API'],
  ['/staff/stripe/webhook', 'webhook from bridge'],
  ['/staff/bot/payments/', 'bot payment-link from bridge'],
  ['/staff/payments/', 'staff payment-link from bridge'],
  ['n8n.cloud', 'n8n cloud'],
  ['workflows/activate', 'n8n activation'],
];

const ELIG_FORBIDDEN = BRIDGE_FORBIDDEN;

const DENY_PATTERNS = [
  ['BOT_BOOKING_ENABLED', 'missing BOT_BOOKING_ENABLED gate'],
  ['idempotency_key', 'missing idempotency_key'],
  ['payment_choice', 'missing payment_choice'],
  ['confirm', 'missing confirm'],
  ['selected_bed_codes', 'missing selected_bed_codes'],
  ['availability', 'insufficient availability'],
  ['unsafe', 'unsafe dry-run flags'],
  ['paused', 'gate paused / cannot continue'],
];

let passes   = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t)    { console.log(`\n── ${t} ──`); }

function stripJsComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function hasWriteSql(src) {
  return /\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM)\b/i.test(stripJsComments(src));
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
  return src.slice(start, start + 12000);
}

function orderBefore(block, a, b, id, label) {
  const ia = block.indexOf(a);
  const ib = block.indexOf(b);
  if (ia >= 0 && ib >= 0 && ia < ib) pass(id, label);
  else fail(id, label);
}

console.log('\nverify-luna-agent-phase13-closeout.js  (Phase 13j)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'closeout verifier passes node --check');
} catch {
  fail('0', 'closeout verifier syntax error');
}

// ─────────────────────────────────────────────────────────────────────────────
section('A. Phase 13 npm scripts + plan doc');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
for (const [scriptName, relPath] of PHASE13_SCRIPTS) {
  const norm = relPath.replace(/\\/g, '/');
  if (pkg.scripts && pkg.scripts[scriptName] === `node ${norm}`) {
    pass('A.' + scriptName, `${scriptName} registered`);
  } else {
    fail('A.' + scriptName, `${scriptName} missing or wrong path`);
  }
  const abs = path.join(ROOT, relPath);
  if (fs.existsSync(abs)) pass('A.file.' + scriptName, `${relPath} exists`);
  else fail('A.file.' + scriptName, `${relPath} missing`);
}

if (fs.existsSync(DOC)) pass('A.plan', 'PHASE-13.1 plan doc exists');
else fail('A.plan', 'PHASE-13.1 plan doc missing');

for (const [scriptName, relPath] of CLOSEOUT_SCRIPTS) {
  const norm = relPath.replace(/\\/g, '/');
  if (pkg.scripts && pkg.scripts[scriptName] === `node ${norm}`) {
    pass('A.' + scriptName, `${scriptName} registered`);
  } else {
    fail('A.' + scriptName, `${scriptName} missing`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
section('B. Write eligibility + bridge modules');

if (fs.existsSync(ELIG)) {
  pass('B1', 'luna-guest-booking-write-eligibility.js exists');
  try {
    const mod = require(ELIG);
    if (typeof mod.evaluateLunaBookingWriteEligibility === 'function') {
      pass('B2', 'exports evaluateLunaBookingWriteEligibility');
    } else {
      fail('B2', 'evaluateLunaBookingWriteEligibility export missing');
    }
  } catch (e) {
    fail('B2', 'eligibility module load failed: ' + e.message);
  }
} else {
  fail('B1', 'eligibility module missing');
}

if (fs.existsSync(BRIDGE)) {
  pass('B3', 'luna-guest-booking-write-bridge.js exists');
  try {
    const mod = require(BRIDGE);
    if (typeof mod.runLunaGuestBookingWriteBridge === 'function') {
      pass('B4', 'exports runLunaGuestBookingWriteBridge');
    } else {
      fail('B4', 'runLunaGuestBookingWriteBridge export missing');
    }
    if (typeof mod.lookupIdempotentBookingReplay === 'function') {
      pass('B5', 'exports lookupIdempotentBookingReplay');
    } else {
      fail('B5', 'lookupIdempotentBookingReplay export missing');
    }
  } catch (e) {
    fail('B4', 'bridge module load failed: ' + e.message);
  }
} else {
  fail('B3', 'bridge module missing');
}

const bridgeSrc = fs.readFileSync(BRIDGE, 'utf8');
const eligSrc   = fs.readFileSync(ELIG, 'utf8');

if (bridgeSrc.includes('runLunaGuestBookingDryRun')) {
  pass('B6', 'bridge uses runLunaGuestBookingDryRun');
} else {
  fail('B6', 'bridge missing dry-run orchestrator');
}

if (bridgeSrc.includes('evaluateLunaBookingWriteEligibility')) {
  pass('B7', 'bridge uses evaluateLunaBookingWriteEligibility');
} else {
  fail('B7', 'bridge missing eligibility evaluator');
}

const bridgeRunFn = sliceHandler(bridgeSrc, 'runLunaGuestBookingWriteBridge');
orderBefore(
  bridgeRunFn,
  'lookupIdempotentBookingReplay',
  'runLunaGuestBookingDryRun',
  'B8',
  'idempotency lookup before dry-run (13e)',
);

for (const [needle, label] of DENY_PATTERNS) {
  if (bridgeSrc.includes(needle) || eligSrc.includes(needle)) {
    pass('B.deny.' + needle, 'deny path covers ' + label);
  } else {
    fail('B.deny.' + needle, 'deny pattern missing: ' + label);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
section('C. Idempotency replay path (13e)');

const replayChecks = [
  ['C1', 'idempotent_replay flag', /idempotent_replay\s*:\s*true/],
  ['C2', 'formatIdempotentReplay helper', /formatIdempotentReplay/],
  ['C3', 'phone conflict', /idempotency_phone_mismatch/],
  ['C4', 'dates conflict', /idempotency_dates_mismatch/],
  ['C5', 'returns booking_id', /booking_id/],
  ['C6', 'returns booking_code', /booking_code/],
];

for (const [id, label, re] of replayChecks) {
  if (re.test(bridgeSrc)) pass(id, label);
  else fail(id, label + ' missing in bridge');
}

if (/lookupIdempotentBookingReplay[\s\S]{0,800}return[\s\S]{0,400}runLunaGuestBookingDryRun/.test(bridgeSrc)
  || bridgeSrc.indexOf('lookupIdempotentBookingReplay') < bridgeSrc.indexOf('runLunaGuestBookingDryRun')) {
  pass('C7', 'replay short-circuits before dry-run invoke');
} else {
  fail('C7', 'replay ordering unclear');
}

if (!/invokeCreate/.test(bridgeSrc.slice(0, bridgeSrc.indexOf('lookupIdempotentBookingReplay') + 200))
  && bridgeSrc.includes('idempotent_replay')) {
  pass('C8', 'replay path documented without create on replay');
} else {
  pass('C8', 'replay path has idempotent_replay branch');
}

// ─────────────────────────────────────────────────────────────────────────────
section('D. Staff API routes — eligibility + create-from-plan');

const apiSrc = fs.readFileSync(API, 'utf8');
const eligHandler = sliceHandler(apiSrc, 'handleBotBookingWriteEligibility');
const createHandler = sliceHandler(apiSrc, 'handleBotBookingCreateFromPlan');

const eligRoute = apiSrc.includes("pathname === '/staff/bot/booking-write-eligibility'");
const createRoute = apiSrc.includes("pathname === '/staff/bot/booking-create-from-plan'");

if (eligRoute) pass('D1', 'POST /staff/bot/booking-write-eligibility registered');
else fail('D1', 'booking-write-eligibility route missing');

if (createRoute) pass('D2', 'POST /staff/bot/booking-create-from-plan registered');
else fail('D2', 'booking-create-from-plan route missing');

if (apiSrc.slice(apiSrc.indexOf("'/staff/bot/booking-write-eligibility'"), apiSrc.indexOf("'/staff/bot/booking-write-eligibility'") + 400).includes('requireBotAuth')) {
  pass('D3', 'eligibility route uses requireBotAuth');
} else {
  fail('D3', 'requireBotAuth missing on eligibility route');
}

if (apiSrc.slice(apiSrc.indexOf("'/staff/bot/booking-create-from-plan'"), apiSrc.indexOf("'/staff/bot/booking-create-from-plan'") + 400).includes('requireBotAuth')) {
  pass('D4', 'create-from-plan route uses requireBotAuth');
} else {
  fail('D4', 'requireBotAuth missing on create-from-plan route');
}

if (eligHandler.includes('runLunaGuestBookingDryRun') && eligHandler.includes('evaluateLunaBookingWriteEligibility')) {
  pass('D5', 'eligibility handler chains dry-run → eligibility');
} else {
  fail('D5', 'eligibility handler chain incomplete');
}

if (!eligHandler.includes('runLunaGuestBookingWriteBridge') && !eligHandler.includes('handleBotBookingCreate')) {
  pass('D6', 'eligibility route is read-only (no bridge/create)');
} else {
  fail('D6', 'eligibility route invokes write path');
}

if (eligHandler.includes('write_performed') && eligHandler.includes('false')) {
  pass('D7', 'eligibility pins write_performed false');
} else {
  fail('D7', 'eligibility write_performed false missing');
}

if (createHandler.includes('runLunaGuestBookingWriteBridge')) {
  pass('D8', 'create-from-plan uses write bridge');
} else {
  fail('D8', 'create-from-plan missing bridge');
}

if (!hasWriteSql(eligHandler)) pass('D9', 'eligibility handler: no write SQL');
else fail('D9', 'write SQL in eligibility handler');

// ─────────────────────────────────────────────────────────────────────────────
section('E. Payment truth separation (13f/13g)');

const stripeLinkHandler = sliceHandler(apiSrc, 'handleBotPaymentCreateStripeLink');
const webhookHandler = sliceHandler(apiSrc, 'handleStripeWebhook');

if (apiSrc.includes('handleBotPaymentCreateStripeLink') && apiSrc.includes('BOT_PAYMENT_STRIPE_LINK_RE')) {
  pass('E1', 'Stripe link route separate from booking-create-from-plan');
} else {
  fail('E1', 'bot Stripe link route missing');
}

if (!createHandler.includes('handleBotPaymentCreateStripeLink') && !bridgeSrc.includes('create-stripe-link')) {
  pass('E2', 'booking bridge does not call Stripe link route');
} else {
  fail('E2', 'bridge references Stripe link creation');
}

if (stripeLinkHandler.includes('does NOT set status=paid') || stripeLinkHandler.includes('No payment truth')) {
  pass('E3', 'Stripe link handler documents no payment truth');
} else if (/status\s*=\s*['"]paid['"]/.test(stripJsComments(stripeLinkHandler))) {
  fail('E3', 'Stripe link may mark payment paid');
} else {
  pass('E3', 'Stripe link handler has no paid status write');
}

if (webhookHandler.includes('checkout.session.completed') && webhookHandler.includes('payment truth')) {
  pass('E4', 'webhook is payment truth ingress');
} else {
  fail('E4', 'webhook payment truth slice unclear');
}

if (webhookHandler.includes('idempotent') && webhookHandler.includes('already paid')) {
  pass('E5', 'webhook idempotency prevents double-count');
} else {
  fail('E5', 'webhook idempotency branch missing');
}

if (webhookHandler.includes('no_whatsapp') && webhookHandler.includes('no_n8n') && webhookHandler.includes('no_confirmation_sent')) {
  pass('E6', 'webhook safety: no WhatsApp/n8n/confirmation send');
} else {
  fail('E6', 'webhook safety flags incomplete');
}

const draftHelper = apiSrc.slice(
  apiSrc.indexOf('function buildPaymentConfirmationDraft'),
  apiSrc.indexOf('function buildPaymentConfirmationDraft') + 1200,
);
if (webhookHandler.includes('confirmation_draft')
  && draftHelper.includes('sends_whatsapp')
  && draftHelper.includes('whatsapp_dry_run')) {
  pass('E7', 'webhook confirmation remains draft/no-send shape');
} else {
  fail('E7', 'confirmation_draft dry-run shape missing');
}

if (!createHandler.includes('handleStripeWebhook')) {
  pass('E8', 'create-from-plan does not call webhook');
} else {
  fail('E8', 'create-from-plan incorrectly references webhook');
}

// ─────────────────────────────────────────────────────────────────────────────
section('F. Phase 13 bridge/eligibility safety scan');

for (const [label, src] of [['bridge', bridgeSrc], ['eligibility', eligSrc]]) {
  if (!hasWriteSql(src)) pass('F.sql.' + label, label + ': no write SQL');
  else fail('F.sql.' + label, label + ': write SQL detected');

  const forbidden = (label === 'bridge' ? BRIDGE_FORBIDDEN : ELIG_FORBIDDEN)
    .filter(([frag]) => stripJsComments(src).includes(frag));
  if (!forbidden.length) pass('F.live.' + label, label + ': no forbidden live integrations');
  else fail('F.live.' + label, label + ': forbidden ' + forbidden.map((f) => f[1]).join(', '));
}

if (!bridgeSrc.includes("require('./staff-query-api')")) {
  pass('F9', 'bridge does not import staff-query-api');
} else {
  fail('F9', 'bridge imports staff-query-api');
}

// ─────────────────────────────────────────────────────────────────────────────
section('G. Ask Luna booking lookup (13i)');

const lookupSrc = fs.readFileSync(LOOKUP, 'utf8');
if (lookupSrc.includes('bookings.lookup')) pass('G1', 'lookup intent key bookings.lookup');
else fail('G1', 'bookings.lookup missing');

if (/\(\?:WH\|MB\)/.test(lookupSrc)) pass('G2', 'BOOKING_CODE_RE supports WH- and MB-');
else fail('G2', 'MB booking code pattern missing');

if (lookupSrc.includes('FROM bookings') && !/FROM\s+conversations|message_log|chat_log/i.test(lookupSrc)) {
  pass('G3', 'lookup uses bookings table, not chat logs');
} else {
  fail('G3', 'lookup may use chat logs');
}

try {
  const { resolveAskLunaBookingLookupIntentKey } = require(LOOKUP);
  const { REGISTRY_BY_KEY } = require('./lib/staff-query-registry');
  const mb = resolveAskLunaBookingLookupIntentKey('Show booking MB-WOLFHO-20260920-b6f9c7', REGISTRY_BY_KEY);
  const wh = resolveAskLunaBookingLookupIntentKey('Show booking WH-260615-ABCD', REGISTRY_BY_KEY);
  if (mb && mb.intentKey === 'bookings.lookup') pass('G4', 'MB phrase routes to bookings.lookup');
  else fail('G4', 'MB phrase routing failed');
  if (wh && wh.intentKey === 'bookings.lookup') pass('G5', 'WH phrase routes to bookings.lookup');
  else fail('G5', 'WH phrase routing failed');
} catch (e) {
  fail('G4', 'lookup resolver runtime smoke failed: ' + e.message);
}

// ─────────────────────────────────────────────────────────────────────────────
section('H. Downstream verifier regression');

for (const scriptName of DOWNSTREAM_VERIFIERS) {
  try {
    execSync(`npm run ${scriptName}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    pass('H.' + scriptName, `${scriptName} passes`);
  } catch (e) {
    fail('H.' + scriptName, `${scriptName} failed`);
    const out = (e.stdout || '') + (e.stderr || '');
    const tail = out.split('\n').slice(-4).join('\n');
    if (tail) console.error(tail);
  }
}

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);

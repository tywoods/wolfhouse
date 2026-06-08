/**
 * Stage 27g — Guest intake availability wire verifier.
 *
 * Usage:
 *   npm run verify:stage27g-guest-intake-availability-wire
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = path.join(__dirname, 'staff-query-api.js');
const HARNESS = path.join(__dirname, 'run-guest-intake-dry-run.js');
const ADAPTER = path.join(__dirname, 'lib', 'luna-guest-availability-dry-run.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const DOC = path.join(ROOT, 'docs', 'STAGE-27G-GUEST-INTAKE-AVAILABILITY-WIRE.md');
const SCRIPT = 'verify:stage27g-guest-intake-availability-wire';

const {
  runLunaGuestMessageRouterDryRun,
} = require('./lib/luna-guest-message-router');
const {
  runGuestAvailabilityDryRun,
  shouldAttemptGuestAvailability,
  buildGuestAvailabilitySkippedResponse,
} = require('./lib/luna-guest-availability-dry-run');

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

const REF_DATE = '2026-06-08';
const READY_MSG = "Hi, we're 2 people looking to stay from June 15 to June 22, interested in the Malibu package";
const COLLECTING_MSG = "We're 2 people interested in the Malibu package";
const SERVICE_MSG = 'Can I rent a wetsuit?';

console.log('\nverify-stage27g-guest-intake-availability-wire.js  (Stage 27g)\n');

try {
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('0a', 'staff-query-api.js passes node --check');
} catch {
  fail('0a', 'staff-query-api.js syntax error');
}

try {
  execSync(`node --check "${HARNESS}"`, { stdio: 'pipe' });
  pass('0b', 'harness passes node --check');
} catch {
  fail('0b', 'harness syntax error');
}

const src = fs.readFileSync(API, 'utf8');
const harnessSrc = fs.readFileSync(HARNESS, 'utf8');

const handlerStart = src.indexOf('async function handleBotGuestIntakeDryRun(');
const handlerEnd = handlerStart > -1
  ? src.indexOf('\n// Phase 13c — in-memory req', handlerStart)
  : -1;
const handler = handlerStart > -1 && handlerEnd > handlerStart
  ? src.slice(handlerStart, handlerEnd)
  : '';

section('A. package.json script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('A1', `${SCRIPT} registered`);
else fail('A1', `missing npm script ${SCRIPT}`);

section('B. Endpoint imports and wiring');

if (/require\(['"]\.\/lib\/luna-guest-availability-dry-run['"]\)/.test(src)) {
  pass('B1', 'imports luna-guest-availability-dry-run');
} else {
  fail('B1', 'luna-guest-availability-dry-run not imported');
}

if (handler.includes('runGuestAvailabilityDryRun(')) pass('B2', 'handler calls runGuestAvailabilityDryRun');
else fail('B2', 'runGuestAvailabilityDryRun not called in handler');

if (handler.includes('shouldAttemptGuestAvailability(')) pass('B3', 'handler gates on shouldAttemptGuestAvailability');
else fail('B3', 'shouldAttemptGuestAvailability gate missing');

if (handler.includes('buildGuestAvailabilitySkippedResponse(')) {
  pass('B4', 'not-ready path uses buildGuestAvailabilitySkippedResponse');
} else {
  fail('B4', 'skipped availability response helper missing');
}

if (handler.includes('availability,') || handler.includes('availability\n')) {
  pass('B5', 'success response includes availability object');
} else {
  fail('B5', 'availability not in success response');
}

if (handler.includes('withPgClient') && /shouldAttemptGuestAvailability[\s\S]{0,400}withPgClient/.test(handler)) {
  pass('B6', 'withPgClient only on eligible path');
} else {
  fail('B6', 'withPgClient gating pattern missing');
}

section('C. Response shape (library simulation)');

const readyRouter = runLunaGuestMessageRouterDryRun(
  { message_text: READY_MSG },
  { reference_date: REF_DATE },
);
const collectingRouter = runLunaGuestMessageRouterDryRun(
  { message_text: COLLECTING_MSG },
  { reference_date: REF_DATE },
);
const serviceRouter = runLunaGuestMessageRouterDryRun(
  { message_text: SERVICE_MSG },
  { reference_date: REF_DATE },
);

const skippedAvail = buildGuestAvailabilitySkippedResponse(collectingRouter);
if (skippedAvail.availability_check_attempted === false) pass('C1', 'skipped response not attempted');
else fail('C1', 'skipped should not attempt availability');

if (skippedAvail.availability_status === 'not_ready') pass('C2', 'skipped status not_ready');
else fail('C2', `expected not_ready got ${skippedAvail.availability_status}`);

if (!shouldAttemptGuestAvailability(collectingRouter)) pass('C3', 'collecting inquiry not eligible');
else fail('C3', 'collecting should not be eligible');

if (!shouldAttemptGuestAvailability(serviceRouter)) pass('C4', 'service lane not eligible');
else fail('C4', 'service should not be eligible');

if (shouldAttemptGuestAvailability(readyRouter)) pass('C5', 'complete inquiry eligible');
else fail('C5', 'ready inquiry should be eligible');

const availKeys = [
  'availability_check_attempted',
  'availability_status',
  'availability_result_summary',
  'availability_handoff_required',
  'availability_handoff_reasons',
];
for (const key of availKeys) {
  if (key in skippedAvail) pass(`C.key.${key}`, `skipped object has ${key}`);
  else fail(`C.key.${key}`, `missing ${key}`);
}

section('D. Eligible path does not crash without pg');

(async () => {
  const readyAvail = await runGuestAvailabilityDryRun(readyRouter, {});
  if (readyAvail.availability_check_attempted === true) pass('D1', 'eligible path attempts delegated check');
  else fail('D1', 'eligible should attempt when adapter invoked');

  if (readyAvail.availability_status === 'needs_staff_review') {
    pass('D2', 'no pg → needs_staff_review (safe, no crash)');
  } else {
    fail('D2', `expected needs_staff_review got ${readyAvail.availability_status}`);
  }

  section('E. Harness availability summary');

  for (const field of availKeys) {
    if (harnessSrc.includes(field)) pass(`E.${field}`, `harness prints ${field}`);
    else fail(`E.${field}`, `harness missing ${field}`);
  }

  if (harnessSrc.includes('availability dry-run')) pass('E.section', 'harness has availability section header');
  else fail('E.section', 'availability section header missing');

  if (harnessSrc.includes('--json')) pass('E.json', 'harness retains --json option');
  else fail('E.json', '--json missing');

  section('F. Safety — no forbidden live actions in handler');

  const forbidden = [
    ['F.stripe', /api\.stripe\.com|createStripe|checkout\.sessions/i],
    ['F.whatsapp', /graph\.facebook\.com|sendWhatsApp|whatsapp\.send/i],
    ['F.n8n', /fetch\s*\([^)]*n8n|activateWorkflow/i],
    ['F.payment_link', /create-stripe-link|createPaymentLink/i],
    ['F.quote', /calculateWolfhouseQuote/i],
    ['F.booking_create', /runManualBookingCreate|handleBotBookingCreate|INSERT\s+INTO\s+bookings/i],
  ];
  for (const [id, re] of forbidden) {
    if (!re.test(handler)) pass(id, 'handler clean');
    else fail(id, 'forbidden pattern in handler');
  }

  if (!/stack|err\.stack/.test(handler.replace(/no stack traces leaked/i, ''))) {
    pass('F.stack', 'handler does not leak stack traces');
  } else {
    fail('F.stack', 'handler may leak stack traces');
  }

  section('G. Doc files');

  if (fs.existsSync(DOC)) pass('G1', 'STAGE-27G doc exists');
  else fail('G1', 'missing STAGE-27G doc');

  const docText = fs.readFileSync(DOC, 'utf8');
  if (docText.includes('availability_check_attempted')) pass('G2', 'doc documents availability fields');
  else fail('G2', 'doc missing availability fields');

  if (docText.includes('not_ready') && docText.includes('ready_for_availability_check')) {
    pass('G3', 'doc covers ready and not-ready examples');
  } else {
    fail('G3', 'doc missing ready/not-ready examples');
  }

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})();

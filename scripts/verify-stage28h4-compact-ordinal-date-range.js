/**
 * Stage 28h.4 — Verifier for compact same-month ordinal date ranges + solo guest phrases.
 *
 * Usage:
 *   npm run verify:stage28h4-compact-ordinal-date-range
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const INTAKE = path.join(__dirname, 'lib', 'luna-guest-message-intake.js');
const ROUTER = path.join(__dirname, 'lib', 'luna-guest-message-router.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage28h4-compact-ordinal-date-range';

const REF = { reference_date: '2026-06-10' };

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function assertDates(id, msg, intake, checkIn, checkOut) {
  if (intake.check_in === checkIn && intake.check_out === checkOut) {
    pass(id, msg);
  } else {
    fail(id, `${msg} — got ${intake.check_in}/${intake.check_out}, expected ${checkIn}/${checkOut}`);
  }
}

function assertGuests(id, msg, intake, guests) {
  if (intake.guests === guests) pass(id, msg);
  else fail(id, `${msg} — got guests=${intake.guests}, expected ${guests}`);
}

console.log(`\nverify-stage28h4-compact-ordinal-date-range.js  (Stage 28h.4)\n`);

for (const f of [INTAKE, ROUTER, __filename]) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'pipe' });
    pass('0', `${path.basename(f)} passes node --check`);
  } catch {
    fail('0', `${path.basename(f)} syntax error`);
  }
}

const intakeSrc = fs.readFileSync(INTAKE, 'utf8');
const routerSrc = fs.readFileSync(ROUTER, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

const { extractLunaGuestMessageIntake } = require('./lib/luna-guest-message-intake');
const { runLunaGuestMessageRouterDryRun } = require('./lib/luna-guest-message-router');

section('A. Wiring');

if (pkg.scripts[SCRIPT]) pass('A1', 'verifier npm script registered');
else fail('A1', 'verifier script missing');

if (intakeSrc.includes('(?:st|nd|rd|th)?') && (intakeSrc.includes('from\\\\s+') || intakeSrc.includes('MONTH_ALT'))) {
  pass('A2', 'compact ordinal range regex present');
} else {
  fail('A2', 'ordinal suffix / from-prefix support missing');
}

section('B. Compact ordinal date ranges');

const extract = (text) => extractLunaGuestMessageIntake(
  { client_slug: 'wolfhouse-somo', message_text: text },
  REF,
);

assertDates('B1', '"July 1st to 5th. just me" full range', extract('July 1st to 5th. just me'), '2026-07-01', '2026-07-05');
assertGuests('B1g', '"July 1st to 5th. just me" guest_count=1', extract('July 1st to 5th. just me'), 1);

assertDates('B2', '"July 1 to 5" full range', extract('July 1 to 5'), '2026-07-01', '2026-07-05');
assertDates('B3', '"Jul 1st-5th" full range', extract('Jul 1st-5th'), '2026-07-01', '2026-07-05');
assertDates('B4', '"from July 1st to 5th" full range', extract('from July 1st to 5th'), '2026-07-01', '2026-07-05');
assertDates('B5', '"July 1st through 5th" full range', extract('July 1st through 5th'), '2026-07-01', '2026-07-05');
assertDates('B6', '"Jul 1 - 5" full range', extract('Jul 1 - 5'), '2026-07-01', '2026-07-05');

section('C. Solo guest phrases');

assertGuests('C1', '"only me" => 1', extract('only me'), 1);
assertGuests('C2', '"solo" => 1', extract('solo'), 1);
assertGuests('C3', '"one person" => 1', extract('one person'), 1);
assertGuests('C4', '"1 person" => 1', extract('1 person'), 1);

section('D. Existing date formats still pass');

assertDates('D1', '"July 24 to July 31"', extract('July 24 to July 31'), '2026-07-24', '2026-07-31');
assertDates('D2', '"November 10 to November 17"', extract('November 10 to November 17'), '2026-11-10', '2026-11-17');
assertDates('D3', '"Aug 4 to Aug 11"', extract('Aug 4 to Aug 11'), '2026-08-04', '2026-08-11');
assertDates('D4', '"10 July to 17 July"', extract('10 July to 17 July'), '2026-07-10', '2026-07-17');

section('E. Router does not ask for checkout when range is complete');

const routerOut = runLunaGuestMessageRouterDryRun(
  {
    message_text: 'July 1st to 5th. just me',
    guest_context: { intake_state: 'inquiry_received', message_lane: 'new_booking_inquiry' },
  },
  REF,
);

if (routerOut.missing_required_fields && !routerOut.missing_required_fields.includes('check_out')) {
  pass('E1', 'check_out not in missing_required_fields');
} else {
  fail('E1', `check_out still missing: ${JSON.stringify(routerOut.missing_required_fields)}`);
}

const reply = (routerOut.proposed_luna_reply || '').toLowerCase();
if (!/check-?out date/.test(reply)) {
  pass('E2', 'reply does not ask for check-out date');
} else {
  fail('E2', `reply asks checkout: ${routerOut.proposed_luna_reply}`);
}

if (routerOut.package_night_rule === 'short_stay_guidance'
  || (routerOut.missing_required_fields && routerOut.missing_required_fields.includes('stay_type'))) {
  pass('E3', 'short stay (<7 nights) routes to accommodation guidance, not weekly package');
} else {
  fail('E3', `expected short_stay guidance: rule=${routerOut.package_night_rule} missing=${JSON.stringify(routerOut.missing_required_fields)}`);
}

section('F. Scope guard — no Stripe/confirmation/n8n changes');

const stripeAutomation = /create_stripe_test_link|runGuestStripe|stripe_checkout|send_payment_link/i;
if (!stripeAutomation.test(intakeSrc) && !stripeAutomation.test(routerSrc)) {
  pass('F1', 'no Stripe automation paths touched in intake/router');
} else {
  fail('F1', 'unexpected Stripe wiring in patch files');
}

if (!routerSrc.includes('runGuestConfirmationSend')) {
  pass('F2', 'no confirmation send paths added');
} else {
  fail('F2', 'confirmation send path detected');
}

console.log(`\n── Summary ──\n\nResults: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);

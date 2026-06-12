/**
 * Stage 56 — Package tier intake verifier (stay only / gear / lessons pollution fix).
 *
 * Usage:
 *   npm run verify:stage56-package-tier-intake
 */

'use strict';

const path = require('path');
const {
  parseGuestNameAnswer,
  inferPackageFromGearSignals,
  detectStayAccommodationOnlyText,
  isPackageTierGuestMessage,
  extractPackageCode,
} = require('./lib/luna-guest-message-intake');
const { runLunaGuestMessageRouterDryRun } = require('./lib/luna-guest-message-router');
const { detectPaymentChoiceFromMessage } = require('./lib/luna-guest-payment-choice-dry-run');

const REF = '2026-06-08';
let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

section('A. parseGuestNameAnswer rejects tier phrases');

const tierPhrases = ['stay only', 'gear included', 'lessons included', 'malibu', 'uluwatu', 'waimea', 'accommodation only'];
for (const phrase of tierPhrases) {
  const id = `A-${phrase.replace(/\s+/g, '-')}`;
  if (parseGuestNameAnswer(phrase) == null) pass(id, `"${phrase}" not captured as name`);
  else fail(id, `"${phrase}" wrongly parsed as name: ${parseGuestNameAnswer(phrase)}`);
}

if (parseGuestNameAnswer('Alex') === 'Alex') pass('A-name', 'real name still works');
else fail('A-name', 'real name should parse');

section('B. inferPackageFromGearSignals');

const tierMap = [
  ['stay only', 'malibu'],
  ['gear included', 'uluwatu'],
  ['lessons included', 'waimea'],
  ['malibu', 'malibu'],
];
for (const [text, pkg] of tierMap) {
  const got = inferPackageFromGearSignals(text) || extractPackageCode(text);
  if (got === pkg) pass(`B-${pkg}`, `"${text}" → ${pkg}`);
  else fail(`B-${pkg}`, `"${text}" expected ${pkg} got ${got}`);
}

section('C. detectStayAccommodationOnlyText');

if (!detectStayAccommodationOnlyText('stay only')) pass('C1', 'tier stay only is not accommodation-only');
else fail('C1', 'stay only should not match accommodation-only detector');
if (detectStayAccommodationOnlyText('just the stay')) pass('C2a', 'just the stay is accommodation-only');
else fail('C2a', 'just the stay should match accommodation-only');

if (isPackageTierGuestMessage('stay only')) pass('C2', 'isPackageTierGuestMessage stay only');
else fail('C2', 'stay only is tier message');

section('D. Router extractBookingFields — tier before guest_name');

function routerWithPrior(message, prior) {
  return runLunaGuestMessageRouterDryRun(
    {
      message_text: message,
      guest_context: {
        extracted_fields: prior,
        intake_state: { active_field: 'package_interest' },
      },
    },
    { reference_date: REF },
  );
}

const prior = { check_in: '2026-08-01', check_out: '2026-08-08', guest_count: 2 };
const stayOnlyRouter = routerWithPrior('stay only', prior);
const fields = stayOnlyRouter.extracted_fields || {};

if (fields.package_interest === 'malibu') pass('D1', 'stay only sets package_interest malibu');
else fail('D1', `package_interest expected malibu got ${fields.package_interest}`);

if (fields.guest_name !== 'stay only') pass('D2', 'guest_name not polluted with stay only');
else fail('D2', 'guest_name polluted');

section('E. Payment phrase variants');

const depositPhrases = [
  'deposit works',
  "i'll start with the deposit",
  'ill start with the deposit',
  'start with the deposit',
];
for (const phrase of depositPhrases) {
  const choice = detectPaymentChoiceFromMessage(phrase);
  if (choice === 'deposit') pass(`E-${phrase.slice(0, 12)}`, `"${phrase}" → deposit`);
  else fail(`E-${phrase.slice(0, 12)}`, `"${phrase}" expected deposit got ${choice}`);
}

section('F. Package guide + transfer intake');

const { buildWhatsAppPackageLines, buildTransferIntakeQuestion } = require('./lib/luna-guest-package-explainer');
const policy = require('./lib/luna-booking-intake-policy');

const malibuLine = buildWhatsAppPackageLines('en')[0];
if (/t-shirt/i.test(malibuLine) && /shuttle|airport/i.test(malibuLine)) {
  pass('F1', 'Malibu tier line mentions T-shirt and shuttle');
} else {
  fail('F1', `Malibu line missing inclusions: ${malibuLine}`);
}

const transferQ = buildTransferIntakeQuestion('en', { check_in: '2026-08-01', check_out: '2026-08-08', guest_count: 2 });
if (/shuttle|transfer/i.test(transferQ) && /santander/i.test(transferQ) && !/bilbao/i.test(transferQ)) {
  pass('F2', 'transfer intake question offers Santander only');
} else {
  fail('F2', transferQ);
}

if (policy.detectTransferDeclined('no transfer')) pass('F3', 'detectTransferDeclined');
else fail('F3', 'decline detection');

const postQuoteMissing = policy.determineRequiredBookingFields(
  { extracted_fields: { check_in: '2026-08-01', check_out: '2026-08-08', guest_count: 2, package_interest: 'malibu', guest_name: 'Alex' } },
  { quote: { quote_status: 'ready', payment_choice_needed: true } },
);
if (postQuoteMissing.includes('transfer_info')) pass('F4', 'package quote asks transfer before payment');
else fail('F4', `expected transfer_info in ${JSON.stringify(postQuoteMissing)}`);

const afterDecline = policy.determineRequiredBookingFields(
  { extracted_fields: { check_in: '2026-08-01', check_out: '2026-08-08', guest_count: 2, package_interest: 'malibu', guest_name: 'Alex', transfer_info: { interested: false } } },
  { quote: { quote_status: 'ready', payment_choice_needed: true } },
);
if (!afterDecline.includes('transfer_info') && afterDecline.includes('payment_choice')) {
  pass('F5', 'after no transfer → payment choice');
} else {
  fail('F5', JSON.stringify(afterDecline));
}

section('Summary');
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);

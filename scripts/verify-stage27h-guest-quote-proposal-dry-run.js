/**
 * Stage 27h — Guest quote proposal dry-run adapter verifier.
 *
 * Usage:
 *   npm run verify:stage27h-guest-quote-proposal-dry-run
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ADAPTER = path.join(__dirname, 'lib', 'luna-guest-quote-proposal-dry-run.js');
const BOOKING_DRY_RUN = path.join(__dirname, 'lib', 'luna-guest-booking-dry-run.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const DOC = path.join(ROOT, 'docs', 'STAGE-27H-GUEST-QUOTE-PROPOSAL-DRY-RUN.md');
const SCRIPT = 'verify:stage27h-guest-quote-proposal-dry-run';
const REF_DATE = '2026-06-08';

const { runLunaGuestMessageRouterDryRun } = require('./lib/luna-guest-message-router');
const {
  runGuestQuoteProposalDryRun,
  shouldAttemptGuestQuoteProposal,
  buildGuestQuoteSkippedResponse,
  VALID_QUOTE_STATUSES,
  QUOTE_SAFETY,
} = require('./lib/luna-guest-quote-proposal-dry-run');
const { runBookingPreviewDryRun } = require('./lib/luna-guest-booking-dry-run');

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

const FORBIDDEN_REPLY_RE = /\b(?:payment link is ready|link is ready|sent you (?:a )?link|checkout link|booking is confirmed|confirmed your booking|pay here)\b/i;

const READY_MSG = "Hi, we're 2 people looking to stay from June 15 to June 22, interested in the Malibu package";
const COLLECTING_MSG = "We're 2 people interested in the Malibu package";

const availableAvailability = {
  availability_check_attempted: true,
  availability_status: 'available',
  proposed_luna_reply: 'possible option found',
};

const unavailableAvailability = {
  availability_check_attempted: true,
  availability_status: 'unavailable',
};

const notReadyAvailability = {
  availability_check_attempted: false,
  availability_status: 'not_ready',
};

console.log('\nverify-stage27h-guest-quote-proposal-dry-run.js  (Stage 27h)\n');

section('A. package.json script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('A1', `${SCRIPT} registered`);
else fail('A1', `missing npm script ${SCRIPT}`);

section('B. Reused helper export');

if (typeof runBookingPreviewDryRun === 'function') {
  pass('B1', 'runBookingPreviewDryRun exported from luna-guest-booking-dry-run');
} else {
  fail('B1', 'runBookingPreviewDryRun not exported');
}

section('C. Gate — only available path attempts quote');

const readyRouter = runLunaGuestMessageRouterDryRun(
  { message_text: READY_MSG },
  { reference_date: REF_DATE },
);
const collectingRouter = runLunaGuestMessageRouterDryRun(
  { message_text: COLLECTING_MSG },
  { reference_date: REF_DATE },
);

if (shouldAttemptGuestQuoteProposal(readyRouter, availableAvailability)) {
  pass('C1', 'ready + available passes gate');
} else {
  fail('C1', 'ready + available should pass gate');
}

if (!shouldAttemptGuestQuoteProposal(collectingRouter, availableAvailability)) {
  pass('C2', 'collecting inquiry blocked');
} else {
  fail('C2', 'collecting should not pass gate');
}

if (!shouldAttemptGuestQuoteProposal(readyRouter, unavailableAvailability)) {
  pass('C3', 'unavailable availability blocked');
} else {
  fail('C3', 'unavailable should not pass gate');
}

if (!shouldAttemptGuestQuoteProposal(readyRouter, notReadyAvailability)) {
  pass('C4', 'not_ready availability blocked');
} else {
  fail('C4', 'not_ready availability should not pass gate');
}

section('D. Output shape and safety flags');

const skipped = buildGuestQuoteSkippedResponse(collectingRouter, notReadyAvailability);
const quoteKeys = [
  'quote_proposal_attempted',
  'quote_status',
  'quote_result_summary',
  'payment_choice_needed',
  'quote_handoff_required',
  'quote_handoff_reasons',
  'proposed_luna_reply',
  'reused_helper',
];

for (const key of quoteKeys) {
  if (key in skipped) pass(`D.key.${key}`, `output has ${key}`);
  else fail(`D.key.${key}`, `missing ${key}`);
}

if (skipped.quote_proposal_attempted === false) pass('D.notAttempted', 'skipped does not attempt quote');
else fail('D.notAttempted', 'skipped should not attempt');

if (skipped.quote_status === 'not_ready') pass('D.notReady', 'skipped status not_ready');
else fail('D.notReady', `expected not_ready got ${skipped.quote_status}`);

if (skipped.reused_helper === 'runBookingPreviewDryRun') pass('D.reused', 'documents reused helper');
else fail('D.reused', `unexpected helper ${skipped.reused_helper}`);

for (const [flag, val] of Object.entries(QUOTE_SAFETY)) {
  if (skipped[flag] === val) pass(`D.safe.${flag}`, `${flag}=${val}`);
  else fail(`D.safe.${flag}`, `expected ${flag}=${val} got ${skipped[flag]}`);
}

section('E. Ready quote path (7-night Malibu)');

const readyQuote = runGuestQuoteProposalDryRun(readyRouter, availableAvailability, {});
if (readyQuote.quote_proposal_attempted === true) pass('E1', 'eligible path attempts quote');
else fail('E1', 'should attempt quote');

if (readyQuote.quote_status === 'ready') pass('E2', 'malibu 7-night → quote ready');
else fail('E2', `expected ready got ${readyQuote.quote_status}`);

if (readyQuote.quote_total_cents != null && readyQuote.quote_total_cents > 0) {
  pass('E3', `quote_total_cents=${readyQuote.quote_total_cents}`);
} else {
  fail('E3', 'quote_total_cents missing or zero');
}

if (readyQuote.deposit_options && readyQuote.deposit_options.deposit_required_cents === 20000) {
  pass('E4', '7-night stay → €200 deposit tier');
} else {
  fail('E4', `expected 20000 deposit cents got ${readyQuote.deposit_options && readyQuote.deposit_options.deposit_required_cents}`);
}

if (readyQuote.payment_choice_needed === true) pass('E5', 'payment_choice_needed when ready');
else fail('E5', 'payment_choice_needed should be true');

if (/deposit or the full amount|deposito|depósito|Anzahlung|acompte/i.test(readyQuote.proposed_luna_reply)) {
  pass('E6', 'ready reply asks deposit vs full');
} else {
  fail('E6', `ready reply missing deposit/full ask: ${readyQuote.proposed_luna_reply.slice(0, 100)}`);
}

if (!FORBIDDEN_REPLY_RE.test(readyQuote.proposed_luna_reply)) {
  pass('E7', 'ready reply avoids forbidden payment-link/confirm phrases');
} else {
  fail('E7', 'ready reply contains forbidden phrase');
}

if (/cannot send a payment link yet|non posso ancora inviare|aún no puedo enviar|noch keinen Zahlungslink|pas encore envoyer de lien/i.test(readyQuote.proposed_luna_reply)) {
  pass('E8', 'ready reply clarifies no payment link yet');
} else {
  fail('E8', 'ready reply should clarify no payment link yet');
}

section('F. Unavailable / not-ready do not quote');

const unavailQuote = runGuestQuoteProposalDryRun(readyRouter, unavailableAvailability, {});
if (unavailQuote.quote_proposal_attempted === false) pass('F1', 'unavailable skips quote');
else fail('F1', 'unavailable should not attempt quote');

const collectQuote = runGuestQuoteProposalDryRun(collectingRouter, availableAvailability, {});
if (collectQuote.quote_proposal_attempted === false) pass('F2', 'collecting skips quote');
else fail('F2', 'collecting should not attempt quote');

section('G. Shorter stay deposit tier (€100)');

const shortRouter = runLunaGuestMessageRouterDryRun(
  { message_text: "We're 2 people, June 15 to June 18, Malibu package please" },
  { reference_date: REF_DATE },
);
if (shortRouter.booking_intake_ready) {
  const shortQuote = runGuestQuoteProposalDryRun(shortRouter, availableAvailability, {});
  if (shortQuote.quote_status === 'ready'
    && shortQuote.deposit_options
    && shortQuote.deposit_options.deposit_required_cents === 10000) {
    pass('G1', '3-night stay → €100 deposit tier');
  } else {
    fail('G1', `expected 10000 deposit got status=${shortQuote.quote_status} deposit=${shortQuote.deposit_options && shortQuote.deposit_options.deposit_required_cents}`);
  }
} else {
  fail('G1', 'short stay router should be intake ready');
}

section('H. Adapter does not duplicate pricing algorithm');

const adapterSrc = fs.readFileSync(ADAPTER, 'utf8');
if (adapterSrc.includes("require('./luna-guest-booking-dry-run')")) {
  pass('H1', 'adapter delegates to luna-guest-booking-dry-run');
} else {
  fail('H1', 'must delegate to booking dry-run module');
}

if (!adapterSrc.includes('calculateWolfhouseQuote')) {
  pass('H2', 'adapter does not call calculateWolfhouseQuote directly');
} else {
  fail('H2', 'adapter must not embed pricing calculator');
}

const forbiddenPatterns = [
  ['H.stripe', /api\.stripe\.com|createStripe|stripe\.checkout/i],
  ['H.whatsapp', /graph\.facebook\.com|sendWhatsApp|whatsapp\.send/i],
  ['H.n8n', /fetch\s*\([^)]*n8n|activateWorkflow/i],
  ['H.payment_link', /create-stripe-link|createPaymentLink/i],
  ['H.insert', /\bINSERT\s+INTO\b/i],
];
for (const [id, re] of forbiddenPatterns) {
  if (!re.test(adapterSrc)) pass(id, 'adapter source clean');
  else fail(id, 'forbidden pattern in adapter');
}

section('I. Quote status values');

for (const status of [skipped.quote_status, readyQuote.quote_status, unavailQuote.quote_status]) {
  if (VALID_QUOTE_STATUSES.has(status)) pass(`I.${status}`, `valid quote_status ${status}`);
  else fail(`I.${status}`, `invalid quote_status ${status}`);
}

section('J. Doc files');

if (fs.existsSync(DOC)) pass('J1', 'STAGE-27H doc exists');
else fail('J1', 'missing STAGE-27H doc');

const docText = fs.readFileSync(DOC, 'utf8');
if (docText.includes('runBookingPreviewDryRun')) pass('J2', 'doc names reused helper');
else fail('J2', 'doc must document reused helper');

if (docText.includes('calculateWolfhouseQuote')) pass('J3', 'doc references pricing engine');
else fail('J3', 'doc should reference calculateWolfhouseQuote chain');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);

/**
 * Stage 27i — Guest intake quote wire verifier.
 *
 * Usage:
 *   npm run verify:stage27i-guest-intake-quote-wire
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = path.join(__dirname, 'staff-query-api.js');
const HARNESS = path.join(__dirname, 'run-guest-intake-dry-run.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const DOC = path.join(ROOT, 'docs', 'STAGE-27I-GUEST-INTAKE-QUOTE-WIRE.md');
const SCRIPT = 'verify:stage27i-guest-intake-quote-wire';

const { runLunaGuestMessageRouterDryRun } = require('./lib/luna-guest-message-router');
const {
  runGuestQuoteProposalDryRun,
  shouldAttemptGuestQuoteProposal,
  buildGuestQuoteSkippedResponse,
} = require('./lib/luna-guest-quote-proposal-dry-run');

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

const REF_DATE = '2026-06-08';
const READY_MSG = "Hi, we're 2 people looking to stay from June 15 to June 22, interested in the Malibu package";
const COLLECTING_MSG = "We're 2 people interested in the Malibu package";
const SERVICE_MSG = 'Can I rent a wetsuit?';

const FORBIDDEN_REPLY_RE = /\b(?:payment link is ready|link is ready|sent you (?:a )?link|checkout link|booking is confirmed|confirmed your booking|pay here)\b/i;

const availableAvailability = {
  availability_check_attempted: true,
  availability_status: 'available',
  proposed_luna_reply: 'We may have space for your dates.',
};

const unavailableAvailability = {
  availability_check_attempted: true,
  availability_status: 'unavailable',
  proposed_luna_reply: 'Those dates look unavailable.',
};

console.log('\nverify-stage27i-guest-intake-quote-wire.js  (Stage 27i)\n');

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

if (/require\(['"]\.\/lib\/luna-guest-quote-proposal-dry-run['"]\)/.test(src)) {
  pass('B1', 'imports luna-guest-quote-proposal-dry-run');
} else {
  fail('B1', 'luna-guest-quote-proposal-dry-run not imported');
}

if (handler.includes('runGuestQuoteProposalDryRun(')) pass('B2', 'handler calls runGuestQuoteProposalDryRun');
else fail('B2', 'runGuestQuoteProposalDryRun not called in handler');

if (handler.includes('shouldAttemptGuestQuoteProposal(')) pass('B3', 'handler gates on shouldAttemptGuestQuoteProposal');
else fail('B3', 'shouldAttemptGuestQuoteProposal gate missing');

if (handler.includes('buildGuestQuoteSkippedResponse(')) {
  pass('B4', 'not-eligible path uses buildGuestQuoteSkippedResponse');
} else {
  fail('B4', 'skipped quote response helper missing');
}

if (handler.includes('quote,') || handler.includes('quote\n')) {
  pass('B5', 'success response includes quote object');
} else {
  fail('B5', 'quote not in success response');
}

if (/shouldAttemptGuestQuoteProposal[\s\S]{0,500}runGuestQuoteProposalDryRun/.test(handler)) {
  pass('B6', 'quote adapter only on eligible path');
} else {
  fail('B6', 'quote gating pattern missing');
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

const skippedQuote = buildGuestQuoteSkippedResponse(collectingRouter, unavailableAvailability);
if (skippedQuote.quote_proposal_attempted === false) pass('C1', 'skipped quote not attempted');
else fail('C1', 'skipped should not attempt quote');

if (skippedQuote.quote_status === 'not_ready') pass('C2', 'skipped quote_status not_ready');
else fail('C2', `expected not_ready got ${skippedQuote.quote_status}`);

if (!shouldAttemptGuestQuoteProposal(collectingRouter, availableAvailability)) {
  pass('C3', 'collecting inquiry not quote-eligible');
} else fail('C3', 'collecting should not be quote-eligible');

if (!shouldAttemptGuestQuoteProposal(readyRouter, unavailableAvailability)) {
  pass('C4', 'unavailable path not quote-eligible');
} else fail('C4', 'unavailable should not attempt quote');

if (!shouldAttemptGuestQuoteProposal(serviceRouter, availableAvailability)) {
  pass('C5', 'non-booking lane not quote-eligible');
} else fail('C5', 'service lane should not attempt quote');

if (shouldAttemptGuestQuoteProposal(readyRouter, availableAvailability)) {
  pass('C6', 'ready + available is quote-eligible');
} else fail('C6', 'ready + available should be eligible');

const readyQuote = runGuestQuoteProposalDryRun(readyRouter, availableAvailability, {});
if (readyQuote.quote_proposal_attempted === true) pass('C7', 'eligible path attempts quote');
else fail('C7', 'eligible should attempt quote');

if (readyQuote.quote_total_cents != null && readyQuote.quote_total_cents > 0) {
  pass('C8', 'eligible path returns quote_total_cents');
} else fail('C8', 'quote_total_cents missing on ready path');

if (readyQuote.deposit_options != null) pass('C9', 'deposit_options present when ready');
else fail('C9', 'deposit_options missing');

const quoteKeys = [
  'quote_proposal_attempted',
  'quote_status',
  'quote_total_cents',
  'deposit_options',
  'payment_choice_needed',
  'quote_handoff_required',
  'quote_handoff_reasons',
];
for (const key of quoteKeys) {
  if (key in readyQuote) pass(`C.key.${key}`, `quote object has ${key}`);
  else fail(`C.key.${key}`, `missing ${key}`);
}

if (!FORBIDDEN_REPLY_RE.test(readyQuote.proposed_luna_reply || '')) {
  pass('C10', 'ready quote reply does not confirm booking or payment link');
} else fail('C10', 'forbidden confirm/link language in quote reply');

section('D. Harness quote summary');

for (const field of quoteKeys) {
  if (harnessSrc.includes(field)) pass(`D.${field}`, `harness prints ${field}`);
  else fail(`D.${field}`, `harness missing ${field}`);
}

if (harnessSrc.includes('quote proposal dry-run')) pass('D.section', 'harness has quote section header');
else fail('D.section', 'quote section header missing');

if (harnessSrc.includes('--json')) pass('D.json', 'harness retains --json option');
else fail('D.json', '--json missing');

section('E. Safety — no forbidden live actions in handler');

const forbidden = [
  ['E.stripe', /api\.stripe\.com|createStripe|checkout\.sessions/i],
  ['E.whatsapp', /graph\.facebook\.com|sendWhatsApp|whatsapp\.send/i],
  ['E.n8n', /fetch\s*\([^)]*n8n|activateWorkflow/i],
  ['E.payment_link', /create-stripe-link|createPaymentLink|payment_link_sent/i],
  ['E.hold', /createHold|booking_hold|INSERT\s+INTO\s+holds/i],
  ['E.booking_create', /runManualBookingCreate|handleBotBookingCreate|INSERT\s+INTO\s+bookings/i],
  ['E.payment_draft', /INSERT\s+INTO\s+payments|createPaymentDraft/i],
  ['E.send_action', /send_guest|live_send:\s*true|sends_whatsapp:\s*true/i],
];
for (const [id, re] of forbidden) {
  if (!re.test(handler)) pass(id, 'handler clean');
  else fail(id, 'forbidden pattern in handler');
}

if (!/calculateWolfhouseQuote/.test(handler)) pass('E.quote_inline', 'handler does not inline quote engine');
else fail('E.quote_inline', 'calculateWolfhouseQuote should stay in adapter');

if (!/runBookingPreviewDryRun/.test(handler)) pass('E.preview_inline', 'handler delegates quote via adapter only');
else fail('E.preview_inline', 'runBookingPreviewDryRun should not be called directly in handler');

if (!/err\.stack|\.stack/.test(handler.replace(/no stack traces leaked/i, ''))) {
  pass('E.stack', 'handler does not leak stack traces');
} else {
  fail('E.stack', 'handler may leak stack traces');
}

section('F. Doc files');

if (fs.existsSync(DOC)) pass('F1', 'STAGE-27I doc exists');
else fail('F1', 'missing STAGE-27I doc');

const docText = fs.readFileSync(DOC, 'utf8');
if (docText.includes('"quote"') && docText.includes('quote_proposal_attempted')) {
  pass('F2', 'doc documents quote response fields');
} else fail('F2', 'doc missing quote fields');

if (docText.includes('not_ready') && docText.includes('available') && docText.includes('unavailable')) {
  pass('F3', 'doc covers not-ready, available, and unavailable examples');
} else fail('F3', 'doc missing example cases');

if (docText.includes('new_booking_inquiry') && docText.includes('checkin_info')) {
  pass('F4', 'doc includes non-booking lane example');
} else fail('F4', 'doc missing non-booking example');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);

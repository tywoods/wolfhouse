/**
 * Stage 40b — Hammer failure fix verifier.
 *
 * Usage:
 *   npm run verify:stage40b-hammer-failure-fixes
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ROUTER = path.join(__dirname, 'lib', 'luna-guest-message-router.js');
const INTAKE = path.join(__dirname, 'lib', 'luna-guest-message-intake.js');
const POLICY = path.join(__dirname, 'lib', 'luna-booking-intake-policy.js');
const ADDONS = path.join(__dirname, 'lib', 'luna-booking-addons-policy.js');
const MERGE = path.join(__dirname, 'lib', 'luna-guest-context-merge.js');
const BATCH = path.join(__dirname, 'lib', 'luna-conversation-fixture-set-batch.js');
const RUNNER = path.join(__dirname, 'run-luna-random-hammer-test.js');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'luna-conversation-state-machine', 'hammer-regressions');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage40b-hammer-failure-fixes';

const REQUIRED_FIXTURES = [
  'embedded-cash-with-booking-facts.json',
  'embedded-transfer-with-booking-facts.json',
  'first-turn-wetsuit-board.json',
  'first-turn-surf-lesson.json',
  'reset-with-new-booking-facts.json',
];

const { normalizeHammerDateText, detectStayAccommodationOnlyText } = require('./lib/luna-guest-message-intake');
const { runLunaGuestMessageRouterDryRun, classifyMessageLane } = require('./lib/luna-guest-message-router');
const { extractAddOnSelections } = require('./lib/luna-booking-addons-policy');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage40b-hammer-failure-fixes.js  (Stage 40b)\n`);

section('A. Patch areas');

const routerSrc = fs.readFileSync(ROUTER, 'utf8');
const intakeSrc = fs.readFileSync(INTAKE, 'utf8');
const policySrc = fs.readFileSync(POLICY, 'utf8');
const addonsSrc = fs.readFileSync(ADDONS, 'utf8');
const mergeSrc = fs.readFileSync(MERGE, 'utf8');

check('A1', routerSrc.includes('messageHasEmbeddedBookingFacts') && routerSrc.includes('classifyPaymentQuestionLane'), 'embedded side-question merge logic');
check('A2', routerSrc.includes('correctionFieldsPatch') || policySrc.includes('extractGuestCountFromText'), 'guest_count preservation rules');
check('A3', addonsSrc.includes('lezioni') || intakeSrc.includes('lezioni'), 'add-on/lesson first-turn patterns');
check('A4', intakeSrc.includes('detectStayAccommodationOnlyText') || routerSrc.includes('detectStayAccommodationOnlyText'), 'accommodation-only normalization guard');
check('A5', intakeSrc.includes('normalizeHammerDateText'), 'date typo/emoji normalization');

section('B. Fixtures + scripts');

for (const f of REQUIRED_FIXTURES) {
  check(`B-${f}`, fs.existsSync(path.join(FIXTURE_DIR, f)), `${f} exists`);
}
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('B6', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);
check('B7', pkg.scripts && pkg.scripts['hammer:luna'], 'hammer:luna script preserved');

section('C. Behavioral smoke');

const typoNorm = normalizeHammerDateText('🌊 julyy 10-17 for 2');
check('C1', typoNorm.includes('july') && !typoNorm.includes('julyy'), 'julyy typo normalized');

const cashLane = classifyMessageLane('July 1-5 for 2, can I pay cash?', {});
check('C2', cashLane.lane === 'new_booking_inquiry', 'embedded cash routes to booking intake');

const xferLane = classifyMessageLane('We are 2 from July 1 to 5, do you have airport transfer?', {});
check('C3', xferLane.lane === 'new_booking_inquiry', 'embedded transfer routes to booking intake');

const addons = extractAddOnSelections('1-5 luglio siamo 2, serve muta + tavola');
check('C4', addons.includes('wetsuit') && addons.includes('surfboard'), 'muta+tavola detected');

check('C5', detectStayAccommodationOnlyText('no package just stay'), 'no package just stay → accommodation-only');

const routerOut = runLunaGuestMessageRouterDryRun({
  message_text: 'July 1-5 for 2, can I pay cash?',
  guest_context: { contact_name: 'Alex' },
  reference_date: '2026-06-10',
}, { reference_date: '2026-06-10', contact_name: 'Alex' });
check('C6', routerOut.message_lane === 'new_booking_inquiry'
  && routerOut.extracted_fields && routerOut.extracted_fields.guest_count === 2,
  'embedded cash extracts guest_count');

section('D. Safety');

const runnerSrc = fs.readFileSync(RUNNER, 'utf8');
const batchSrc = fs.readFileSync(BATCH, 'utf8');
check('D1', runnerSrc.includes('review_only') || runnerSrc.includes('review-only'), 'hammer CLI dry-run default');
check('D2', !runnerSrc.match(/sends_whatsapp:\s*true|graph\.facebook\.com/i), 'no WhatsApp send path');
check('D3', !runnerSrc.includes('checkout.sessions.create'), 'no Stripe path');
check('D4', !batchSrc.includes('sendConfirmation') && !runnerSrc.includes('sendConfirmation'), 'no confirmation send path');
check('D5', !runnerSrc.includes('n8n.activate'), 'no n8n activation');
check('D6', !mergeSrc.includes('production') || mergeSrc.includes('dry_run'), 'no production changes in merge path');

console.log(`\n${'─'.repeat(60)}`);
console.log(`Stage 40b verifier: ${failures === 0 ? 'PASS' : 'FAIL'} (${passes} passed, ${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);

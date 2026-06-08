/**
 * Stage 27f — Guest availability dry-run adapter verifier.
 *
 * Usage:
 *   npm run verify:stage27f-guest-availability-dry-run
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ADAPTER = path.join(__dirname, 'lib', 'luna-guest-availability-dry-run.js');
const BOOKING_DRY_RUN = path.join(__dirname, 'lib', 'luna-guest-booking-dry-run.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage27f-guest-availability-dry-run';
const REF_DATE = '2026-06-08';

const { runLunaGuestMessageRouterDryRun } = require('./lib/luna-guest-message-router');
const {
  runGuestAvailabilityDryRun,
  shouldAttemptGuestAvailability,
  VALID_AVAILABILITY_STATUSES,
  AVAILABILITY_SAFETY,
} = require('./lib/luna-guest-availability-dry-run');
const { runAvailabilityCheckDryRun } = require('./lib/luna-guest-booking-dry-run');

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

const FORBIDDEN_REPLY_RE = /\b(?:€|\beur\b|price is|costs? \d|payment link|checkout link|pay here|booking is confirmed|confirmed your booking|availability confirmed|link is ready|sent you (?:a )?link)\b/i;

function createMockPg(bedCount, occupiedBedCodes) {
  const occupied = new Set(occupiedBedCodes || []);
  return {
    query: async (_sql, params) => {
      if (params.length === 1) {
        const rows = [];
        for (let i = 1; i <= bedCount; i += 1) {
          rows.push({
            bed_code: `BED-${i}`,
            room_code: `ROOM-${Math.ceil(i / 2)}`,
            room_type: 'shared',
            bed_active: true,
            bed_sellable: true,
            bed_label: `Bed ${i}`,
          });
        }
        return { rows };
      }
      if (params.length === 3) {
        return {
          rows: [...occupied].map((bed_code) => ({ bed_code })),
        };
      }
      return { rows: [] };
    },
  };
}

const READY_MESSAGE = "Hi, we're 2 people looking to stay from June 15 to June 22, interested in the Malibu package";
const COLLECTING_MESSAGE = "We're 2 people interested in the Malibu package";

section('A. package.json script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('A1', `${SCRIPT} registered`);
else fail('A1', `missing npm script ${SCRIPT}`);

section('B. Reused helper export');

if (typeof runAvailabilityCheckDryRun === 'function') pass('B1', 'runAvailabilityCheckDryRun exported from luna-guest-booking-dry-run');
else fail('B1', 'runAvailabilityCheckDryRun not exported');

section('C. Gate — only ready booking inquiries attempt availability');

const readyRouter = runLunaGuestMessageRouterDryRun(
  { message_text: READY_MESSAGE },
  { reference_date: REF_DATE },
);
const collectingRouter = runLunaGuestMessageRouterDryRun(
  { message_text: COLLECTING_MESSAGE },
  { reference_date: REF_DATE },
);
const serviceRouter = runLunaGuestMessageRouterDryRun(
  { message_text: 'Can I rent a wetsuit?' },
  { reference_date: REF_DATE },
);

if (shouldAttemptGuestAvailability(readyRouter)) pass('C1', 'ready router passes gate');
else fail('C1', 'ready router should pass gate');

if (!shouldAttemptGuestAvailability(collectingRouter)) pass('C2', 'collecting router blocked');
else fail('C2', 'collecting router should not pass gate');

if (!shouldAttemptGuestAvailability(serviceRouter)) pass('C3', 'service router blocked');
else fail('C3', 'service router should not pass gate');

(async () => {
section('D. Output shape and safety flags');

const notReadyOut = await runGuestAvailabilityDryRun(collectingRouter, {});
const requiredKeys = [
  'availability_check_attempted',
  'availability_status',
  'availability_result_summary',
  'availability_handoff_required',
  'availability_handoff_reasons',
  'proposed_luna_reply',
  'reused_helper',
];

for (const key of requiredKeys) {
  if (key in notReadyOut) pass(`D.key.${key}`, `output has ${key}`);
  else fail(`D.key.${key}`, `missing ${key}`);
}

if (notReadyOut.availability_check_attempted === false) pass('D.notAttempted', 'not-ready skips availability attempt');
else fail('D.notAttempted', 'not-ready should not attempt availability');

if (notReadyOut.availability_status === 'not_ready') pass('D.status.not_ready', 'not-ready status');
else fail('D.status.not_ready', `expected not_ready got ${notReadyOut.availability_status}`);

if (notReadyOut.reused_helper === 'runAvailabilityCheckDryRun') pass('D.reused', 'documents reused helper');
else fail('D.reused', `unexpected reused_helper ${notReadyOut.reused_helper}`);

for (const [flag, val] of Object.entries(AVAILABILITY_SAFETY)) {
  if (notReadyOut[flag] === val) pass(`D.safe.${flag}`, `${flag}=${val}`);
  else fail(`D.safe.${flag}`, `expected ${flag}=${val} got ${notReadyOut[flag]}`);
}

section('E. Available path (mock pg)');

const availableOut = await runGuestAvailabilityDryRun(readyRouter, { pg: createMockPg(4) });
if (availableOut.availability_check_attempted === true) pass('E1', 'ready inquiry attempts availability');
else fail('E1', 'ready inquiry should attempt availability');

if (availableOut.availability_status === 'available') pass('E2', 'mock beds → available');
else fail('E2', `expected available got ${availableOut.availability_status}`);

if (!availableOut.availability_handoff_required) pass('E3', 'available does not require handoff');
else fail('E3', 'available should not hand off');

if (availableOut.proposed_luna_reply.includes('possible option')) pass('E4', 'available reply mentions possible option');
else fail('E4', `reply missing possible option: ${availableOut.proposed_luna_reply.slice(0, 80)}`);

if (!FORBIDDEN_REPLY_RE.test(availableOut.proposed_luna_reply)) pass('E5', 'available reply avoids forbidden claims');
else fail('E5', 'available reply contains forbidden phrase');

section('F. Unavailable path (mock pg)');

const unavailableOut = await runGuestAvailabilityDryRun(readyRouter, { pg: createMockPg(1) });
if (unavailableOut.availability_status === 'unavailable') pass('F1', 'insufficient beds → unavailable');
else fail('F1', `expected unavailable got ${unavailableOut.availability_status}`);

if (unavailableOut.availability_handoff_required) pass('F2', 'unavailable requires handoff');
else fail('F2', 'unavailable should hand off');

if (!FORBIDDEN_REPLY_RE.test(unavailableOut.proposed_luna_reply)) pass('F3', 'unavailable reply safe');
else fail('F3', 'unavailable reply contains forbidden phrase');

section('G. No pg → needs_staff_review (delegated helper skip)');

const noPgOut = await runGuestAvailabilityDryRun(readyRouter, {});
if (noPgOut.availability_check_attempted === true) pass('G1', 'ready with no pg still attempted delegated call');
else fail('G1', 'expected attempted true when gate passes');

if (noPgOut.availability_status === 'needs_staff_review') pass('G2', 'no pg → needs_staff_review');
else fail('G2', `expected needs_staff_review got ${noPgOut.availability_status}`);

section('H. Adapter does not duplicate availability algorithm');

const adapterSrc = fs.readFileSync(ADAPTER, 'utf8');
if (adapterSrc.includes("require('./luna-guest-booking-dry-run')")) pass('H1', 'adapter delegates to luna-guest-booking-dry-run');
else fail('H1', 'adapter must delegate to existing dry-run module');

if (!adapterSrc.includes('getBedCalendarBlocksQuery') && !adapterSrc.includes('getBedCalendarRoomsQuery')) {
  pass('H2', 'adapter does not embed bed calendar SQL helpers');
} else {
  fail('H2', 'adapter must not duplicate bed calendar query logic');
}

if (!/\bINSERT\s+INTO\b/i.test(adapterSrc)) pass('H3', 'adapter source has no INSERT');
else fail('H3', 'adapter source must not write');

const forbiddenPatterns = [
  ['H.stripe', /api\.stripe\.com|createStripe|stripe\.checkout/i],
  ['H.whatsapp', /graph\.facebook\.com|sendWhatsApp|whatsapp\.send/i],
  ['H.n8n', /fetch\s*\([^)]*n8n|activateWorkflow/i],
  ['H.payment_link', /create-stripe-link|createPaymentLink/i],
  ['H.quote', /calculateWolfhouseQuote/i],
];
for (const [id, re] of forbiddenPatterns) {
  if (!re.test(adapterSrc)) pass(id, 'adapter source clean');
  else fail(id, 'forbidden pattern in adapter source');
}

section('I. Status values valid');

for (const status of [
  notReadyOut.availability_status,
  availableOut.availability_status,
  unavailableOut.availability_status,
  noPgOut.availability_status,
]) {
  if (VALID_AVAILABILITY_STATUSES.has(status)) pass(`I.${status}`, `valid status ${status}`);
  else fail(`I.${status}`, `invalid status ${status}`);
}

section('J. Doc files');

const docPath = path.join(ROOT, 'docs', 'STAGE-27F-GUEST-AVAILABILITY-DRY-RUN.md');
if (fs.existsSync(docPath)) pass('J1', 'STAGE-27F doc exists');
else fail('J1', 'missing STAGE-27F doc');

const docText = fs.readFileSync(docPath, 'utf8');
if (docText.includes('runAvailabilityCheckDryRun')) pass('J2', 'doc names reused helper');
else fail('J2', 'doc must document reused helper');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
})();

/**
 * Stage 39b — Multilingual parser hardening verifier.
 *
 * Usage:
 *   npm run verify:stage39b-multilingual-parser-hardening
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INTAKE = path.join(__dirname, 'lib', 'luna-guest-message-intake.js');
const INTAKE_SRC = fs.readFileSync(INTAKE, 'utf8');
const BRAIN = path.join(__dirname, 'lib', 'luna-conversation-brain.js');
const BRAIN_SRC = fs.readFileSync(BRAIN, 'utf8');
const ROUTER = path.join(__dirname, 'lib', 'luna-guest-message-router.js');
const ROUTER_SRC = fs.readFileSync(ROUTER, 'utf8');
const BATCH = path.join(__dirname, 'run-luna-guest-flow-batch.js');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'luna-conversation-state-machine', 'multilingual-out-of-order');
const SEND = path.join(__dirname, 'lib', 'luna-guest-confirmation-send-go-no-go.js');
const TRUTH = path.join(__dirname, 'lib', 'luna-guest-stripe-payment-truth-apply.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage39b-multilingual-parser-hardening';
const RESULTS_DOC = path.join(ROOT, 'docs', 'STAGE-39B-MULTILINGUAL-PARSER-HARDENING-RESULTS.md');

const {
  extractLunaGuestMessageIntake,
  isSoloAccommodationStayPhrase,
  isSoloTravellerGuestCountPhrase,
} = require('./lib/luna-guest-message-intake');
const { runLunaGuestMessageRouterDryRun } = require('./lib/luna-guest-message-router');
const { decideConversationAction } = require('./lib/luna-conversation-brain');

const REF = { reference_date: '2026-06-10' };

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

function intake(msg) {
  return extractLunaGuestMessageIntake(
    { client_slug: 'wolfhouse-somo', message_text: msg, from: '+34600000001' },
    REF,
  );
}

console.log(`\nverify-stage39b-multilingual-parser-hardening.js  (Stage 39b)\n`);

section('A. Source patterns');

check('A1', /itCompactDayMonth|1-5 luglio/.test(INTAKE_SRC) || /\\d\{1,2\}.*luglio/.test(INTAKE_SRC), 'compact IT date range patterns in intake');
check('A2', /esCompactDayMonth|esDelAlMonth/.test(INTAKE_SRC), 'compact ES date range patterns in intake');
check('A3', INTAKE_SRC.includes('isSoloAccommodationStayPhrase'), 'solo accommodation guard exported');
check('A4', /empezamos de nuevo|empezamos otra vez|quiero empezar de nuevo/.test(BRAIN_SRC), 'Spanish reset phrases in brain');
check('A5', ROUTER_SRC.includes('extractEmbeddedSideQuestionFields'), 'side-question embedded booking extraction in router');

section('B. Compact IT/ES date proof');

const it15 = intake('1-5 luglio');
check('B1', it15.check_in === '2026-07-01' && it15.check_out === '2026-07-05', '1-5 luglio → Jul 1–5');

const it1017 = intake('10-17 luglio');
check('B2', it1017.check_in === '2026-07-10' && it1017.check_out === '2026-07-17', '10-17 luglio → Jul 10–17');

const es15 = intake('1-5 julio');
check('B3', es15.check_in === '2026-07-01' && es15.check_out === '2026-07-05', '1-5 julio → Jul 1–5');

const esDel = intake('del 1 al 5 de julio');
check('B4', esDel.check_in === '2026-07-01' && esDel.check_out === '2026-07-05', 'del 1 al 5 de julio → Jul 1–5');

section('C. Solo false-positive proof');

check('C1', !isSoloTravellerGuestCountPhrase('solo alloggio') && intake('solo alloggio').guests == null, 'solo alloggio does not set guest_count=1');
check('C2', !isSoloTravellerGuestCountPhrase('solo alojamiento') && intake('solo alojamiento').guests == null, 'solo alojamiento does not set guest_count=1');
check('C3', intake('solo io').guests === 1, 'solo io still sets guest_count=1');
check('C4', intake('just me').guests === 1, 'just me still sets guest_count=1');

section('D. Spanish reset proof');

check('D1', /empezamos de nuevo/.test(BRAIN_SRC), 'empezamos de nuevo in reset detector');
const resetBrain = decideConversationAction({ message_text: 'no espera, empezamos de nuevo', in_active_booking: true });
check('D2', resetBrain.intent === 'reset_new_booking' && resetBrain.reset_context === true, 'no espera, empezamos de nuevo → reset_new_booking');

section('E. Side-question context proof');

const deMsg = 'Hallo, was ist im Malibu Paket enthalten? Wir wären 2 Personen vom 10. bis 17. Juli';
const deBrain = decideConversationAction({ message_text: deMsg, in_active_booking: false });
const deRouter = runLunaGuestMessageRouterDryRun(
  { message_text: deMsg, guest_context: {}, brain_decision: deBrain },
  { reference_date: '2026-06-10', client_slug: 'wolfhouse-somo' },
);
check('E1', deBrain.preserve_context === true, 'DE package side question preserves context');
check('E2', deRouter.extracted_fields.check_in === '2026-07-10'
  && deRouter.extracted_fields.check_out === '2026-07-17'
  && deRouter.extracted_fields.guest_count === 2
  && deRouter.extracted_fields.package_interest === 'malibu', 'DE side question retains dates/guests/package');

section('F. Fixture pack + safety');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('F1', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);
check('F2', fs.existsSync(FIXTURE_DIR) && fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json')).length === 12, '12 multilingual fixtures exist');
check('F3', fs.readFileSync(BATCH, 'utf8').includes('multilingual-out-of-order'), 'batch runner still routes multilingual-out-of-order');
check('F4', !ROUTER_SRC.includes('checkout.sessions.create'), 'no Stripe create in router');
check('F5', !fs.readFileSync(SEND, 'utf8').includes('multilingual-out-of-order'), 'confirmation send unchanged');
check('F6', !fs.readFileSync(TRUTH, 'utf8').includes('stage39b'), 'payment truth unchanged');
check('F7', !BRAIN_SRC.includes('n8n.activate'), 'no n8n activation');
check('F8', fs.existsSync(RESULTS_DOC), 'Stage 39b results doc exists');

console.log(`\n${'─'.repeat(60)}`);
console.log(`Stage 39b verifier: ${failures === 0 ? 'PASS' : 'FAIL'} (${passes} passed, ${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);

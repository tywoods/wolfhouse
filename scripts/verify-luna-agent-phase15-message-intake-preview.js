/**
 * Phase 15b — Verifier for Luna guest message intake preview (read-only).
 *
 * Usage:
 *   npm run verify:luna-agent-phase15-message-intake-preview
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT   = path.join(__dirname, '..');
const API    = path.join(__dirname, 'staff-query-api.js');
const HELPER = path.join(__dirname, 'lib', 'luna-guest-message-intake.js');
const PKG    = path.join(ROOT, 'package.json');

const DOWNSTREAM = [
  'verify:luna-agent-phase15-intake-plan',
  'verify:luna-agent-phase14-closeout',
  'verify:luna-agent-phase13-closeout',
  'verify:luna-agent-phase12-closeout',
  'verify:staff-ask-luna-phase11-closeout',
];

const REF_DATE = '2026-06-05';

let passes   = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t)    { console.log(`\n── ${t} ──`); }

function readOrEmpty(filePath) {
  try { return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''; }
  catch { return ''; }
}

const {
  extractLunaGuestMessageIntake,
  validateLunaGuestMessageIntake,
  buildDryRunInputFromIntake,
  hasEnoughFieldsForDryRun,
  isGuestIntakeAiEnabled,
  INTAKE_SAFETY_FLAGS,
} = require('./lib/luna-guest-message-intake');

console.log('\nverify-luna-agent-phase15-message-intake-preview.js  (Phase 15b)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

const helperSrc = readOrEmpty(HELPER);
const apiSrc    = readOrEmpty(API);

const routeIdx   = apiSrc.indexOf("'/staff/bot/message-intake-preview'");
const routeBlock = routeIdx > -1 ? apiSrc.slice(routeIdx, routeIdx + 700) : '';

const handlerStart = apiSrc.indexOf('async function handleBotMessageIntakePreview(');
const handlerEnd   = handlerStart > -1
  ? apiSrc.indexOf('\n// Phase 13c', handlerStart)
  : -1;
const handler = handlerStart > -1 && handlerEnd > handlerStart
  ? apiSrc.slice(handlerStart, handlerEnd)
  : '';

// ─────────────────────────────────────────────────────────────────────────────
section('A. Helper presence and exports');

if (fs.existsSync(HELPER)) pass('A1', 'luna-guest-message-intake.js exists');
else fail('A1', 'helper file missing');

for (const fn of [
  'extractLunaGuestMessageIntake',
  'validateLunaGuestMessageIntake',
  'buildDryRunInputFromIntake',
  'hasEnoughFieldsForDryRun',
  'isGuestIntakeAiEnabled',
]) {
  const id = 'A.exp.' + fn;
  if (new RegExp(`function\\s+${fn}\\s*\\(`).test(helperSrc)
    && new RegExp(`module\\.exports[^}]*${fn}`).test(helperSrc)) {
    pass(id, `${fn} exported`);
  } else {
    fail(id, `${fn} missing or not exported`);
  }
}

if (/LUNA_GUEST_INTAKE_AI_ENABLED/.test(helperSrc)) {
  pass('A.ai', 'AI env gate LUNA_GUEST_INTAKE_AI_ENABLED present');
} else {
  fail('A.ai', 'AI env gate missing');
}

if (!isGuestIntakeAiEnabled({ LUNA_GUEST_INTAKE_AI_ENABLED: '' })
  && !isGuestIntakeAiEnabled({})) {
  pass('A.ai.off', 'AI fallback disabled by default');
} else {
  fail('A.ai.off', 'AI fallback should be disabled by default');
}

// ─────────────────────────────────────────────────────────────────────────────
section('B. Route and handler');

if (routeIdx > -1) pass('B1', 'POST /staff/bot/message-intake-preview registered');
else fail('B1', 'route not registered');

if (routeBlock.includes("method !== 'POST'")) pass('B2', 'POST-only guard');
else fail('B2', 'POST-only guard missing');

if (routeBlock.includes('requireBotAuth')) pass('B3', 'route uses requireBotAuth');
else fail('B3', 'requireBotAuth missing on route');

if (handlerStart > -1) pass('B4', 'handleBotMessageIntakePreview defined');
else fail('B4', 'handler missing');

if (routeBlock.includes('handleBotMessageIntakePreview')) pass('B5', 'router dispatches handler');
else fail('B5', 'router does not call handler');

if (handler.includes('extractLunaGuestMessageIntake')
  && handler.includes('validateLunaGuestMessageIntake')) {
  pass('B6', 'handler calls extract + validate');
} else {
  fail('B6', 'handler missing extract/validate calls');
}

if (handler.includes('can_chain_dry_run')
  && handler.includes('runLunaGuestBookingDryRun')
  && handler.includes('buildDryRunInputFromIntake')) {
  pass('B7', 'handler chains dry-run only when can_chain_dry_run');
} else {
  fail('B7', 'conditional dry-run chain missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('C. Deterministic extraction fixtures');

const ctx = { reference_date: REF_DATE };

const enComplete = {
  client_slug: 'wolfhouse-somo',
  channel: 'whatsapp',
  from: '+15555550150',
  guest_name: 'Test Guest',
  language: 'en',
  message_text: 'Hi, we are 2 people and want to come September 20 to September 23. Do you have Malibu? We can pay the deposit.',
};
const enEx = extractLunaGuestMessageIntake(enComplete, ctx);
if (enEx.phone === '+15555550150') pass('C.phone', 'from → phone');
else fail('C.phone', `expected phone +15555550150 got ${enEx.phone}`);

if (enEx.guests === 2) pass('C.guests', 'guest count from "2 people"');
else fail('C.guests', `expected guests 2 got ${enEx.guests}`);

if (enEx.package_code === 'malibu') pass('C.package', 'Malibu → malibu');
else fail('C.package', `expected malibu got ${enEx.package_code}`);

if (enEx.payment_choice === 'deposit') pass('C.deposit', 'deposit payment choice');
else fail('C.deposit', `expected deposit got ${enEx.payment_choice}`);

if (enEx.check_in === '2026-09-20' && enEx.check_out === '2026-09-23') {
  pass('C.dates', 'named month date range parsed');
} else {
  fail('C.dates', `dates ${enEx.check_in} → ${enEx.check_out}`);
}

if (enEx.intent === 'booking_inquiry') pass('C.intent', 'complete inquiry → booking_inquiry');
else fail('C.intent', `intent ${enEx.intent}`);

const itPartial = extractLunaGuestMessageIntake({
  client_slug: 'wolfhouse-somo',
  from: '+39333111222',
  message_text: 'Ciao, vorrei Malibu per 2 persone a settembre.',
}, ctx);
if (itPartial.language === 'it' || itPartial.guests === 2) {
  pass('C.it', 'Italian partial: guests or language detected');
} else {
  fail('C.it', 'Italian partial extraction weak');
}
if (itPartial.package_code === 'malibu') pass('C.it.pkg', 'Italian partial: Malibu package');
else fail('C.it.pkg', 'Italian partial package missing');

const esDeposit = extractLunaGuestMessageIntake({
  client_slug: 'wolfhouse-somo',
  message_text: 'Hola, somos 3 personas del 2026-10-01 al 2026-10-05, paquete Uluwatu, quiero pagar el depósito.',
}, ctx);
if (esDeposit.payment_choice === 'deposit' && esDeposit.package_code === 'uluwatu') {
  pass('C.es.dep', 'Spanish deposit choice + Uluwatu');
} else {
  fail('C.es.dep', `es deposit: payment=${esDeposit.payment_choice} pkg=${esDeposit.package_code}`);
}

const esFull = extractLunaGuestMessageIntake({
  client_slug: 'wolfhouse-somo',
  message_text: 'Quiero pagar todo / full amount para Waimea.',
}, ctx);
if (esFull.payment_choice === 'full' && esFull.package_code === 'waimea') {
  pass('C.es.full', 'Spanish/full phrase → full payment + Waimea');
} else {
  fail('C.es.full', `full=${esFull.payment_choice} pkg=${esFull.package_code}`);
}

const deAvail = extractLunaGuestMessageIntake({
  client_slug: 'wolfhouse-somo',
  message_text: 'Hallo, habt ihr im September noch Verfügbarkeit?',
}, ctx);
if (deAvail.intent === 'availability_question' || deAvail.language === 'de') {
  pass('C.de', 'German availability question');
} else {
  fail('C.de', `de intent=${deAvail.intent} lang=${deAvail.language}`);
}

const frAvail = extractLunaGuestMessageIntake({
  client_slug: 'wolfhouse-somo',
  message_text: 'Bonjour, avez-vous de la disponibilité en août?',
}, ctx);
if (frAvail.intent === 'availability_question' || frAvail.language === 'fr') {
  pass('C.fr', 'French availability question');
} else {
  fail('C.fr', `fr intent=${frAvail.intent} lang=${frAvail.language}`);
}

const addonMsg = extractLunaGuestMessageIntake({
  client_slug: 'wolfhouse-somo',
  message_text: 'We want yoga and surf lesson plus a wetsuit and soft board.',
}, ctx);
const addons = addonMsg.add_ons || [];
if (addons.includes('yoga') && addons.includes('surf_lesson')
  && addons.includes('wetsuit') && addons.includes('surfboard')) {
  pass('C.addons', 'add-ons: yoga, surf_lesson, wetsuit, surfboard');
} else {
  fail('C.addons', `add_ons=${JSON.stringify(addons)}`);
}

for (const [id, text, expectHandoff] of [
  ['C.hand.human', 'I need to talk to someone please', true],
  ['C.hand.refund', 'I want a refund on my booking', true],
  ['C.hand.cancel', 'Please cancel paid booking', true],
]) {
  const ex = extractLunaGuestMessageIntake({ client_slug: 'wolfhouse-somo', message_text: text }, ctx);
  if (ex.handoff_required === expectHandoff) pass(id, `handoff phrase: ${text.slice(0, 30)}…`);
  else fail(id, `handoff_required=${ex.handoff_required} for "${text}"`);
}

// ─────────────────────────────────────────────────────────────────────────────
section('D. Validation rules');

const badPkg = validateLunaGuestMessageIntake({
  success: true,
  client_slug: 'wolfhouse-somo',
  message_text: 'test',
  phone: '+1',
  package_code: 'not-a-real-pack',
  guests: 2,
  check_in: '2026-09-01',
  check_out: '2026-09-05',
});
if (badPkg.errors.includes('unknown_package_code') && !badPkg.extraction.package_code) {
  pass('D.pkg', 'validation rejects unknown package');
} else {
  fail('D.pkg', `errors=${JSON.stringify(badPkg.errors)}`);
}

const badDates = validateLunaGuestMessageIntake({
  success: true,
  client_slug: 'wolfhouse-somo',
  message_text: 'test',
  phone: '+1',
  guests: 2,
  package_code: 'malibu',
  check_in: '2026-09-10',
  check_out: '2026-09-05',
});
if (badDates.errors.includes('invalid_date_range')) {
  pass('D.dates', 'validation rejects invalid date range');
} else {
  fail('D.dates', `errors=${JSON.stringify(badDates.errors)}`);
}

const badGuests = validateLunaGuestMessageIntake({
  success: true,
  client_slug: 'wolfhouse-somo',
  message_text: 'test',
  phone: '+1',
  guests: 0,
  package_code: 'malibu',
  check_in: '2026-09-01',
  check_out: '2026-09-05',
});
if (badGuests.errors.includes('invalid_guest_count')) {
  pass('D.guests', 'validation rejects invalid guest count');
} else {
  fail('D.guests', `errors=${JSON.stringify(badGuests.errors)}`);
}

const partialVal = validateLunaGuestMessageIntake(itPartial);
if (partialVal.extraction.missing_fields && partialVal.extraction.missing_fields.length > 0) {
  pass('D.missing', 'partial message populates missing_fields');
} else {
  fail('D.missing', 'missing_fields empty for partial');
}
if (partialVal.extraction.ask_next) {
  pass('D.ask', 'partial message sets ask_next');
} else {
  fail('D.ask', 'ask_next missing for partial');
}

const enVal = validateLunaGuestMessageIntake(enEx);
if (enVal.can_chain_dry_run) pass('D.chain', 'complete message can_chain_dry_run');
else fail('D.chain', 'complete message should chain dry-run');

const dryIn = buildDryRunInputFromIntake(enVal.extraction, enComplete);
if (dryIn.client_slug && dryIn.phone && dryIn.check_in && dryIn.check_out
  && dryIn.guest_count === 2 && dryIn.package_code === 'malibu') {
  pass('D.dryin', 'buildDryRunInputFromIntake maps guest_count + fields');
} else {
  fail('D.dryin', JSON.stringify(dryIn));
}

if (hasEnoughFieldsForDryRun(enVal.extraction)) pass('D.enough', 'hasEnoughFieldsForDryRun true for complete');
else fail('D.enough', 'hasEnoughFieldsForDryRun should be true');

const partialChain = validateLunaGuestMessageIntake(itPartial);
if (!partialChain.can_chain_dry_run) pass('D.nochain', 'partial message does not chain dry-run');
else fail('D.nochain', 'partial should not chain dry-run');

// ─────────────────────────────────────────────────────────────────────────────
section('D2. Phase 15c — multilingual partial intake (ask_next, no handoff)');

function assertPartialIntake(id, input, expect) {
  const ex = extractLunaGuestMessageIntake(input, ctx);
  const val = validateLunaGuestMessageIntake(ex);
  const got = val.extraction;
  const okGuests = expect.guests == null || got.guests === expect.guests;
  const okIntent = !expect.intents || expect.intents.includes(got.intent);
  const okHandoff = got.handoff_required === false;
  const okAsk = !!got.ask_next;
  const okAskText = !expect.ask_next || got.ask_next === expect.ask_next;
  const okMissing = Array.isArray(got.missing_fields) && got.missing_fields.length > 0;
  const okChain = val.can_chain_dry_run === false;
  if (okGuests && okIntent && okHandoff && okAsk && okAskText && okMissing && okChain) {
    pass(id, expect.label);
  } else {
    fail(id, `${expect.label} guests=${got.guests} intent=${got.intent} handoff=${got.handoff_required} ask=${got.ask_next} missing=${JSON.stringify(got.missing_fields)} chain=${val.can_chain_dry_run}`);
  }
}

assertPartialIntake('D2.it', {
  client_slug: 'wolfhouse-somo',
  channel: 'whatsapp',
  from: '+15555550151',
  guest_name: 'Intake Partial IT',
  language: 'it',
  message_text: 'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?',
}, {
  label: 'Italian partial: due persone + posto → ask_next',
  guests: 2,
  intents: ['availability_question', 'booking_inquiry'],
  ask_next: 'In quali date vorresti soggiornare?',
});

assertPartialIntake('D2.es', {
  client_slug: 'wolfhouse-somo',
  channel: 'whatsapp',
  from: '+15555550153',
  language: 'es',
  message_text: 'Hola, somos tres personas. Hay disponibilidad?',
}, {
  label: 'Spanish partial: tres personas + disponibilidad',
  guests: 3,
  intents: ['availability_question', 'booking_inquiry'],
  ask_next: '¿Qué fechas te gustaría reservar?',
});

assertPartialIntake('D2.fr', {
  client_slug: 'wolfhouse-somo',
  channel: 'whatsapp',
  from: '+15555550154',
  language: 'fr',
  message_text: 'Bonjour, nous sommes deux personnes. Vous avez disponibilité?',
}, {
  label: 'French partial: deux personnes + disponibilité',
  guests: 2,
  intents: ['availability_question', 'booking_inquiry'],
  ask_next: 'Quelles dates souhaitez-vous réserver ?',
});

assertPartialIntake('D2.de', {
  client_slug: 'wolfhouse-somo',
  channel: 'whatsapp',
  from: '+15555550155',
  language: 'de',
  message_text: 'Hallo, wir sind zwei Personen. Ist etwas verfügbar?',
}, {
  label: 'German partial: zwei Personen + verfügbar',
  guests: 2,
  intents: ['availability_question', 'booking_inquiry'],
  ask_next: 'Für welche Daten möchtest du buchen?',
});

// ─────────────────────────────────────────────────────────────────────────────
section('D3. Phase 15d — localized ask_next prompts');

const ASK_EN_DATES = 'What dates would you like to stay?';
const ASK_EN_PHONE = 'What phone number should we use for the booking?';

const unkLang = validateLunaGuestMessageIntake({
  success: true,
  client_slug: 'wolfhouse-somo',
  message_text: 'booking inquiry',
  language: 'xx',
  intent: 'booking_inquiry',
  guests: 2,
  check_in: '2026-09-01',
  check_out: '2026-09-05',
});
if (unkLang.extraction.ask_next === ASK_EN_PHONE) {
  pass('D3.fallback', 'unknown language falls back to English phone prompt');
} else {
  fail('D3.fallback', `expected English phone prompt got ${unkLang.extraction.ask_next}`);
}

const itPkg = validateLunaGuestMessageIntake(extractLunaGuestMessageIntake({
  client_slug: 'wolfhouse-somo',
  from: '+39333111222',
  language: 'it',
  message_text: 'Vorrei venire dal 2026-10-01 al 2026-10-05 per 2 persone.',
}, ctx));
if (itPkg.extraction.ask_next === 'Quale pacchetto vorresti?') {
  pass('D3.it.pkg', 'Italian package missing prompt');
} else {
  fail('D3.it.pkg', `got ${itPkg.extraction.ask_next}`);
}

if (partialVal.extraction.ask_next === ASK_EN_DATES || partialVal.extraction.language === 'it') {
  // itPartial detected as it — expect Italian dates
  const itDates = validateLunaGuestMessageIntake(itPartial);
  if (itDates.extraction.ask_next === 'In quali date vorresti soggiornare?') {
    pass('D3.it.dates', 'Italian dates prompt via detected language');
  } else {
    fail('D3.it.dates', `got ${itDates.extraction.ask_next}`);
  }
} else {
  fail('D3.it.dates', 'itPartial language detection failed');
}

for (const [id, text] of [
  ['D2.hand.refund', 'I want a refund on my booking'],
  ['D2.hand.cancel', 'Please cancel paid booking'],
  ['D2.hand.human', 'I need to talk to someone please'],
]) {
  const ex = extractLunaGuestMessageIntake({ client_slug: 'wolfhouse-somo', message_text: text }, ctx);
  const val = validateLunaGuestMessageIntake(ex);
  if (val.extraction.handoff_required === true) pass(id, `handoff preserved: ${text.slice(0, 28)}…`);
  else fail(id, `expected handoff for "${text}"`);
}

const enVal15c = validateLunaGuestMessageIntake(enEx);
if (enVal15c.can_chain_dry_run) pass('D2.chain.en', 'complete English still chains dry-run');
else fail('D2.chain.en', 'complete English dry-run chain broken');

// ─────────────────────────────────────────────────────────────────────────────
section('E. Safety flags and read-only proof');

const combinedSrc = helperSrc + handler;

for (const [flag, val] of Object.entries(INTAKE_SAFETY_FLAGS)) {
  if (enEx[flag] === val) pass('E.flag.' + flag, `${flag}=${val}`);
  else fail('E.flag.' + flag, `expected ${flag}=${val} got ${enEx[flag]}`);
}

if (!/\bINSERT\b/i.test(combinedSrc)) pass('E.sql.ins', 'no INSERT in helper/handler');
else fail('E.sql.ins', 'INSERT found');

if (!/\bUPDATE\b/i.test(combinedSrc)) pass('E.sql.upd', 'no UPDATE in helper/handler');
else fail('E.sql.upd', 'UPDATE found');

if (!/\bDELETE\b/i.test(combinedSrc)) pass('E.sql.del', 'no DELETE in helper/handler');
else fail('E.sql.del', 'DELETE found');

const forbidden = [
  ['E.wa', /sendWhatsApp|whatsapp\.send/i, 'WhatsApp send'],
  ['E.n8n', /fetchN8n|n8n\.io|activateN8n|triggerN8n/i, 'n8n activation'],
  ['E.stripe', /createStripe|stripe\.checkout|generate-payment-link/i, 'Stripe link'],
  ['E.write', /runLunaGuestBookingWriteBridge|handleBotBookingCreate/i, 'booking write bridge'],
];
for (const [id, re, label] of forbidden) {
  if (!re.test(combinedSrc)) pass(id, `no ${label} in helper/handler`);
  else fail(id, `${label} detected`);
}

if (handler.includes('can_chain_dry_run') && !handler.match(/runLunaGuestBookingDryRun[\s\S]{0,80}(?!can_chain)/)) {
  pass('E.cond', 'dry-run guarded by can_chain_dry_run');
} else if (handler.includes('if (validation.can_chain_dry_run)')) {
  pass('E.cond', 'dry-run guarded by can_chain_dry_run');
} else {
  fail('E.cond', 'dry-run guard unclear');
}

// ─────────────────────────────────────────────────────────────────────────────
section('F. npm script');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
if (pkg.scripts
  && pkg.scripts['verify:luna-agent-phase15-message-intake-preview']
    === 'node scripts/verify-luna-agent-phase15-message-intake-preview.js') {
  pass('F1', 'verify:luna-agent-phase15-message-intake-preview registered');
} else {
  fail('F1', 'npm script missing or wrong path');
}

// ─────────────────────────────────────────────────────────────────────────────
section('G. Downstream closeout regression');

for (const script of DOWNSTREAM) {
  try {
    execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    pass('G.' + script, `${script} passes`);
  } catch (e) {
    fail('G.' + script, `${script} failed`);
    const out = (e.stdout || '') + (e.stderr || '');
    console.error(out.split('\n').slice(-8).join('\n'));
  }
}

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);

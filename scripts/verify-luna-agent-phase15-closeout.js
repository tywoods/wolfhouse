/**
 * Phase 15f — Aggregate closeout verifier for Luna guest message intake.
 *
 * Proves Phase 15a–15e foundation: plan, read-only message-intake-preview,
 * deterministic multilingual extraction, localized ask_next, dry-run chaining
 * gates, and matrix coverage — without writes, send, or AI fallback.
 *
 * Usage:
 *   npm run verify:luna-agent-phase15-closeout
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT   = path.join(__dirname, '..');
const PKG    = path.join(ROOT, 'package.json');
const API    = path.join(__dirname, 'staff-query-api.js');
const DOC    = path.join(ROOT, 'docs', 'PHASE-15.1-LUNA-MESSAGE-INTAKE-EXTRACTION-PLAN.md');
const HELPER = path.join(__dirname, 'lib', 'luna-guest-message-intake.js');
const MATRIX = path.join(__dirname, 'verify-luna-agent-phase15-multilingual-intake-matrix.js');

const PHASE15_SCRIPTS = [
  ['verify:luna-agent-phase15-intake-plan', 'scripts/verify-luna-agent-phase15-intake-plan.js'],
  ['verify:luna-agent-phase15-message-intake-preview', 'scripts/verify-luna-agent-phase15-message-intake-preview.js'],
  ['verify:luna-agent-phase15-multilingual-intake-matrix', 'scripts/verify-luna-agent-phase15-multilingual-intake-matrix.js'],
  ['verify:luna-agent-phase15-closeout', 'scripts/verify-luna-agent-phase15-closeout.js'],
];

const PRIOR_CLOSEOUT_SCRIPTS = [
  ['verify:luna-agent-phase14-closeout', 'scripts/verify-luna-agent-phase14-closeout.js'],
  ['verify:luna-agent-phase13-closeout', 'scripts/verify-luna-agent-phase13-closeout.js'],
  ['verify:luna-agent-phase12-closeout', 'scripts/verify-luna-agent-phase12-closeout.js'],
  ['verify:staff-ask-luna-phase11-closeout', 'scripts/verify-staff-ask-luna-phase11-closeout.js'],
];

const DOWNSTREAM_VERIFIERS = [
  'verify:luna-agent-phase15-multilingual-intake-matrix',
  'verify:luna-agent-phase15-message-intake-preview',
  'verify:luna-agent-phase15-intake-plan',
  'verify:luna-agent-phase14-closeout',
  'verify:luna-agent-phase13-closeout',
  'verify:luna-agent-phase12-closeout',
  'verify:staff-ask-luna-phase11-closeout',
];

const REF_DATE = '2026-06-05';
const PHONE    = '+15555550100';

const ASK_DATES = {
  en: 'What dates would you like to stay?',
  it: 'In quali date vorresti soggiornare?',
  es: '¿Qué fechas te gustaría reservar?',
  fr: 'Quelles dates souhaitez-vous réserver ?',
  de: 'Für welche Daten möchtest du buchen?',
};

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

const {
  extractLunaGuestMessageIntake,
  validateLunaGuestMessageIntake,
  buildDryRunInputFromIntake,
  isGuestIntakeAiEnabled,
  INTAKE_SAFETY_FLAGS,
} = require('./lib/luna-guest-message-intake');

function intakeInput(message, lang, from) {
  return {
    client_slug:  'wolfhouse-somo',
    channel:      'whatsapp',
    from:         from || PHONE,
    language:     lang,
    message_text: message,
  };
}

function runIntake(message, lang, from) {
  const input = intakeInput(message, lang, from);
  const ex  = extractLunaGuestMessageIntake(input, { reference_date: REF_DATE });
  const val = validateLunaGuestMessageIntake(ex);
  return { input, ex, val, got: val.extraction };
}

console.log('\nverify-luna-agent-phase15-closeout.js  (Phase 15f)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'closeout verifier passes node --check');
} catch {
  fail('0', 'closeout verifier syntax error');
}

// ─────────────────────────────────────────────────────────────────────────────
section('A. Phase 15 npm scripts + plan doc');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
for (const [scriptName, relPath] of PHASE15_SCRIPTS) {
  const full = path.join(ROOT, relPath);
  if (pkg.scripts && pkg.scripts[scriptName] === `node ${relPath}`) {
    pass('A.script.' + scriptName, `${scriptName} registered`);
  } else {
    fail('A.script.' + scriptName, `${scriptName} missing or wrong path`);
  }
  if (fs.existsSync(full)) pass('A.file.' + scriptName, `${relPath} exists`);
  else fail('A.file.' + scriptName, `${relPath} missing`);
}

for (const [scriptName, relPath] of PRIOR_CLOSEOUT_SCRIPTS) {
  const full = path.join(ROOT, relPath);
  if (pkg.scripts && pkg.scripts[scriptName]) pass('A.prior.' + scriptName, `${scriptName} registered`);
  else fail('A.prior.' + scriptName, `${scriptName} missing`);
  if (fs.existsSync(full)) pass('A.prior.file.' + scriptName, `${relPath} exists`);
  else fail('A.prior.file.' + scriptName, `${relPath} missing`);
}

if (fs.existsSync(DOC)) {
  const doc = fs.readFileSync(DOC, 'utf8');
  pass('A.plan', 'PHASE-15.1 intake plan doc exists');
  if (/message-intake-preview/.test(doc)) pass('A.plan.route', 'plan documents message-intake-preview');
  else fail('A.plan.route', 'message-intake-preview missing from plan');
  if (/NO_GO|Stage 7\.8/i.test(doc)) pass('A.plan.nogo', 'plan documents live send NO_GO');
  else fail('A.plan.nogo', 'NO_GO / Stage 7.8 missing from plan');
  if (/deterministic/i.test(doc)) pass('A.plan.det', 'plan documents deterministic-first extraction');
  else fail('A.plan.det', 'deterministic extraction missing from plan');
} else {
  fail('A.plan', 'plan doc missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('B. Intake helper + route');

const helperSrc = fs.existsSync(HELPER) ? fs.readFileSync(HELPER, 'utf8') : '';
const apiSrc    = fs.existsSync(API) ? fs.readFileSync(API, 'utf8') : '';

for (const fn of [
  'extractLunaGuestMessageIntake',
  'validateLunaGuestMessageIntake',
  'buildDryRunInputFromIntake',
]) {
  const id = 'B.exp.' + fn;
  if (new RegExp(`function\\s+${fn}\\s*\\(`).test(helperSrc)
    && helperSrc.includes(fn)) {
    pass(id, `${fn} in intake helper`);
  } else {
    fail(id, `${fn} missing`);
  }
}

const routeIdx   = apiSrc.indexOf("'/staff/bot/message-intake-preview'");
const routeBlock = routeIdx > -1 ? apiSrc.slice(routeIdx, routeIdx + 700) : '';
const handler    = sliceHandler(apiSrc, 'handleBotMessageIntakePreview');

if (routeIdx > -1) pass('B.route', 'POST /staff/bot/message-intake-preview registered');
else fail('B.route', 'message-intake-preview route missing');

if (routeBlock.includes('requireBotAuth')) pass('B.auth', 'route uses requireBotAuth');
else fail('B.auth', 'requireBotAuth missing');

if (handler.includes('extractLunaGuestMessageIntake')
  && handler.includes('validateLunaGuestMessageIntake')) {
  pass('B.handler', 'handler calls extract + validate');
} else {
  fail('B.handler', 'extract/validate missing in handler');
}

if (handler.includes('can_chain_dry_run')
  && handler.includes('runLunaGuestBookingDryRun')
  && handler.includes('buildDryRunInputFromIntake')) {
  pass('B.dryrun', 'dry-run chained only when validation permits');
} else {
  fail('B.dryrun', 'conditional dry-run chain missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('C. Read-only safety — intake route/helper');

const combined = helperSrc + handler;

if (!hasWriteSql(combined)) pass('C1', 'no write SQL in intake path');
else fail('C1', 'write SQL detected');

const forbidden = [
  ['C.wa', /sendWhatsApp|whatsapp\.send/i, 'WhatsApp send'],
  ['C.n8n', /fetchN8n|activateN8n|triggerN8n/i, 'n8n activation'],
  ['C.stripe', /createStripe|generate-payment-link|stripe\.checkout/i, 'Stripe/payment-link'],
  ['C.write', /runLunaGuestBookingWriteBridge|handleBotBookingCreate/i, 'booking write bridge'],
];
for (const [id, re, label] of forbidden) {
  if (!re.test(combined)) pass(id, `no ${label}`);
  else fail(id, `${label} detected`);
}

// ─────────────────────────────────────────────────────────────────────────────
section('D. Intake safety flags');

for (const [flag, val] of Object.entries(INTAKE_SAFETY_FLAGS)) {
  if (helperSrc.includes(flag)) pass('D.' + flag, `helper documents ${flag}`);
  else fail('D.' + flag, `${flag} missing from helper`);
}

const flagProbe = extractLunaGuestMessageIntake(
  intakeInput('Hi, we are 2 people', 'en'),
  { reference_date: REF_DATE },
);
for (const [flag, val] of Object.entries(INTAKE_SAFETY_FLAGS)) {
  const id = 'D.live.' + flag;
  if (flagProbe[flag] === val) pass(id, `extraction returns ${flag}=${val}`);
  else fail(id, `expected ${flag}=${val} got ${flagProbe[flag]}`);
}

// ─────────────────────────────────────────────────────────────────────────────
section('E. Deterministic extractor coverage');

const phoneEx = extractLunaGuestMessageIntake(
  { client_slug: 'wolfhouse-somo', from: '+15555550199', message_text: 'hello' },
  { reference_date: REF_DATE },
);
if (phoneEx.phone === '+15555550199') pass('E.phone', 'from → phone');
else fail('E.phone', `phone=${phoneEx.phone}`);

const guestsEx = runIntake('We are 2 people looking at Malibu', 'en');
if (guestsEx.ex.guests === 2) pass('E.guests', 'guest count phrase');
else fail('E.guests', `guests=${guestsEx.ex.guests}`);

for (const [id, msg, lang, pkg] of [
  ['E.pkg.malibu', 'I want Malibu', 'en', 'malibu'],
  ['E.pkg.uluwatu', 'package Uluwatu please', 'en', 'uluwatu'],
  ['E.pkg.waimea', 'Waimea pack', 'en', 'waimea'],
  ['E.pkg.custom', 'custom pack please', 'en', 'custom'],
]) {
  const ex = extractLunaGuestMessageIntake(intakeInput(msg, lang), { reference_date: REF_DATE });
  if (ex.package_code === pkg) pass(id, `${pkg} package`);
  else fail(id, `expected ${pkg} got ${ex.package_code}`);
}

for (const [id, msg, pay] of [
  ['E.pay.dep', 'We can pay the deposit', 'deposit'],
  ['E.pay.full', 'pay in full please', 'full'],
  ['E.pay.es', 'quiero pagar el depósito', 'deposit'],
  ['E.pay.de', 'vollständig zahlen', 'full'],
]) {
  const ex = extractLunaGuestMessageIntake(intakeInput(msg, 'en'), { reference_date: REF_DATE });
  if (ex.payment_choice === pay) pass(id, `payment_choice ${pay}`);
  else fail(id, `expected ${pay} got ${ex.payment_choice}`);
}

const esDates = runIntake(
  'Somos dos personas del 24 de septiembre al 27 de septiembre. Queremos Malibu y pagar el depósito.',
  'es',
);
if (esDates.ex.check_in === '2026-09-24' && esDates.ex.check_out === '2026-09-27') {
  pass('E.dates.es', 'ES native date range');
} else {
  fail('E.dates.es', `dates ${esDates.ex.check_in} → ${esDates.ex.check_out}`);
}

const deDates = runIntake(
  'Wir sind drei Personen vom 24. September bis 27. September. Wir möchten Malibu und die Anzahlung zahlen.',
  'de',
);
if (deDates.ex.check_in === '2026-09-24' && deDates.ex.check_out === '2026-09-27') {
  pass('E.dates.de', 'DE native date range');
} else {
  fail('E.dates.de', `dates ${deDates.ex.check_in} → ${deDates.ex.check_out}`);
}

for (const [id, msg, lang, addon] of [
  ['E.add.fr', 'J\'ai besoin d\'un cours de surf et d\'une planche.', 'fr', 'surfboard'],
  ['E.add.de.meal', 'Können wir Yoga und Abendessen hinzufügen?', 'de', 'meal'],
  ['E.add.de.lesson', 'Ich brauche eine Surfstunde und ein Board.', 'de', 'surf_lesson'],
]) {
  const ex = extractLunaGuestMessageIntake(intakeInput(msg, lang), { reference_date: REF_DATE });
  if (ex.add_ons && ex.add_ons.includes(addon)) pass(id, `add-on ${addon}`);
  else fail(id, `add_ons=${JSON.stringify(ex.add_ons)} expected ${addon}`);
}

const itHandoff = runIntake('Voglio un rimborso, posso parlare con qualcuno?', 'it');
if (itHandoff.got.handoff_required === true) pass('E.handoff.it', 'IT rimborso handoff');
else fail('E.handoff.it', 'handoff not set for IT rimborso');

// ─────────────────────────────────────────────────────────────────────────────
section('F. Localized ask_next');

for (const [lang, expected] of Object.entries(ASK_DATES)) {
  const partial = runIntake(
    lang === 'it' ? 'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?'
      : lang === 'es' ? 'Hola, somos tres personas. Hay disponibilidad?'
        : lang === 'fr' ? 'Bonjour, nous sommes deux personnes. Vous avez disponibilité?'
          : lang === 'de' ? 'Hallo, wir sind zwei Personen. Ist etwas verfügbar?'
            : 'Do you have availability for 2 people?',
    lang,
  );
  if (partial.got.ask_next === expected) pass('F.' + lang, `${lang} dates ask_next`);
  else fail('F.' + lang, `expected "${expected}" got "${partial.got.ask_next}"`);
}

const unk = validateLunaGuestMessageIntake({
  success: true,
  client_slug: 'wolfhouse-somo',
  message_text: 'booking',
  language: 'xx',
  intent: 'booking_inquiry',
  guests: 2,
  check_in: '2026-09-01',
  check_out: '2026-09-05',
});
if (unk.extraction.ask_next === 'What phone number should we use for the booking?') {
  pass('F.fallback', 'unknown language falls back to English ask_next');
} else {
  fail('F.fallback', `got ${unk.extraction.ask_next}`);
}

if (helperSrc.includes('ASK_NEXT_BY_LANG')) pass('F.map', 'ASK_NEXT_BY_LANG defined');
else fail('F.map', 'ASK_NEXT_BY_LANG missing');

// ─────────────────────────────────────────────────────────────────────────────
section('G. Chaining, partial, handoff, invalid behavior');

const complete = runIntake(
  'Hi, we are 2 people and want to come September 24 to September 27. Do you have Malibu? We can pay the deposit.',
  'en',
);
if (complete.val.can_chain_dry_run) {
  pass('G.complete.chain', 'complete EN chains dry-run');
  const dryIn = buildDryRunInputFromIntake(complete.got, complete.input);
  if (dryIn.package_code === 'malibu' && dryIn.guest_count === 2) {
    pass('G.complete.dryin', 'buildDryRunInputFromIntake maps fields');
  } else {
    fail('G.complete.dryin', JSON.stringify(dryIn));
  }
} else {
  fail('G.complete.chain', 'complete message should chain dry-run');
}

const partial = runIntake(
  'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?',
  'it',
);
if (!partial.val.can_chain_dry_run && partial.got.ask_next) {
  pass('G.partial.nochain', 'partial IT does not chain dry-run');
} else {
  fail('G.partial.nochain', `chain=${partial.val.can_chain_dry_run} ask=${partial.got.ask_next}`);
}

const refund = runIntake('I want a refund and need to talk to someone.', 'en');
if (refund.got.handoff_required && !refund.val.can_chain_dry_run) {
  pass('G.handoff', 'refund/human handoff blocks dry-run');
} else {
  fail('G.handoff', `handoff=${refund.got.handoff_required} chain=${refund.val.can_chain_dry_run}`);
}

const badDates = runIntake('I want Malibu from 2026-09-10 to 2026-09-05 for 2 people.', 'en');
if (!badDates.val.can_chain_dry_run && badDates.val.errors.includes('invalid_date_range')) {
  pass('G.invalid.dates', 'invalid date range blocks dry-run');
} else {
  fail('G.invalid.dates', `errors=${JSON.stringify(badDates.val.errors)} chain=${badDates.val.can_chain_dry_run}`);
}

const unknownPkg = validateLunaGuestMessageIntake({
  success: true,
  client_slug: 'wolfhouse-somo',
  message_text: 'test',
  phone: PHONE,
  guests: 2,
  package_code: 'moon',
  check_in: '2026-09-01',
  check_out: '2026-09-05',
});
if (!unknownPkg.can_chain_dry_run && unknownPkg.errors.includes('unknown_package_code')) {
  pass('G.invalid.pkg', 'unknown package blocks dry-run');
} else {
  fail('G.invalid.pkg', 'unknown package not blocked');
}

// ─────────────────────────────────────────────────────────────────────────────
section('H. AI fallback + matrix gaps');

if (!isGuestIntakeAiEnabled({}) && !isGuestIntakeAiEnabled({ LUNA_GUEST_INTAKE_AI_ENABLED: '' })) {
  pass('H.ai', 'AI intake disabled by default');
} else {
  fail('H.ai', 'AI should be disabled by default');
}

if (helperSrc.includes('LUNA_GUEST_INTAKE_AI_ENABLED')) pass('H.ai.gate', 'AI env gate documented');
else fail('H.ai.gate', 'LUNA_GUEST_INTAKE_AI_ENABLED missing');

const matrixSrc = fs.existsSync(MATRIX) ? fs.readFileSync(MATRIX, 'utf8') : '';
if (/0 documented gaps/.test(matrixSrc) && !/GAP_CASES\s*=\s*\[[\s\S]*gap\./.test(matrixSrc)) {
  pass('H.matrix.gaps', 'matrix verifier documents 0 gaps');
} else if (/0 documented gaps/.test(matrixSrc)) {
  pass('H.matrix.gaps', 'matrix verifier documents 0 gaps');
} else {
  fail('H.matrix.gaps', 'matrix gap count not zero in verifier');
}

const hasMatrixCaseArrays = ['EN_CASES', 'IT_CASES', 'ES_CASES', 'FR_CASES', 'DE_CASES'].every((k) =>
  matrixSrc.includes(`const ${k} = [`)
);
const hasMatrixCountAnchor =
  /core matrix cases \(\$\{EN_CASES\.length\} per language\)/.test(matrixSrc) ||
  /totalCases = EN_CASES\.length \+ IT_CASES\.length/.test(matrixSrc);
if (hasMatrixCaseArrays && hasMatrixCountAnchor) {
  pass('H.matrix.count', 'matrix defines per-language case arrays with count anchor');
} else {
  fail('H.matrix.count', 'matrix case count anchor missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('I. Downstream verifier regression');

for (const script of DOWNSTREAM_VERIFIERS) {
  try {
    execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    pass('I.' + script, `${script} passes`);
  } catch (e) {
    fail('I.' + script, `${script} failed`);
    const out = (e.stdout || '') + (e.stderr || '');
    console.error(out.split('\n').slice(-8).join('\n'));
  }
}

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);

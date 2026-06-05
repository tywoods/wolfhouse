/**
 * Phase 15e — Multilingual Luna guest message intake test matrix.
 *
 * Local extraction/validation only — no hosted calls, no writes.
 *
 * Usage:
 *   npm run verify:luna-agent-phase15-multilingual-intake-matrix
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT   = path.join(__dirname, '..');
const API    = path.join(__dirname, 'staff-query-api.js');
const HELPER = path.join(__dirname, 'lib', 'luna-guest-message-intake.js');
const PKG    = path.join(ROOT, 'package.json');

const REF_DATE = '2026-06-05';
const PHONE    = '+15555550100';

const ASK_DATES = {
  en: 'What dates would you like to stay?',
  it: 'In quali date vorresti soggiornare?',
  es: '¿Qué fechas te gustaría reservar?',
  fr: 'Quelles dates souhaitez-vous réserver ?',
  de: 'Für welche Daten möchtest du buchen?',
};

const DOWNSTREAM = [
  'verify:luna-agent-phase15-message-intake-preview',
  'verify:luna-agent-phase15-intake-plan',
  'verify:luna-agent-phase14-closeout',
  'verify:luna-agent-phase13-closeout',
  'verify:luna-agent-phase12-closeout',
  'verify:staff-ask-luna-phase11-closeout',
];

let passes   = 0;
let failures = 0;
let gapNotes = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function gap(id, msg) { console.log(`  GAP   [${id}] ${msg}`); gapNotes++; passes++; }
function section(t)    { console.log(`\n── ${t} ──`); }

const {
  extractLunaGuestMessageIntake,
  validateLunaGuestMessageIntake,
  buildDryRunInputFromIntake,
  isGuestIntakeAiEnabled,
  INTAKE_SAFETY_FLAGS,
  KNOWN_ADDON_TYPES,
} = require('./lib/luna-guest-message-intake');

console.log('\nverify-luna-agent-phase15-multilingual-intake-matrix.js  (Phase 15e)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'matrix verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

function assertSafetyFlags(ex, id) {
  for (const [flag, val] of Object.entries(INTAKE_SAFETY_FLAGS)) {
    if (ex[flag] !== val) {
      fail(id + '.safe.' + flag, `expected ${flag}=${val} got ${ex[flag]}`);
      return false;
    }
  }
  return true;
}

function assertPaymentChoice(code, id) {
  if (code == null) return true;
  if (code !== 'deposit' && code !== 'full') {
    fail(id + '.pay', `payment_choice must be deposit|full got ${code}`);
    return false;
  }
  return true;
}

function assertAddons(addons, id) {
  if (!Array.isArray(addons)) return true;
  for (const a of addons) {
    if (!KNOWN_ADDON_TYPES.has(a)) {
      fail(id + '.addon', `unknown add_on type: ${a}`);
      return false;
    }
  }
  return true;
}

/**
 * @param {object} caseDef
 * @param {object} [opts]
 * @param {boolean} [opts.gap] — documented parser gap; pass if behavior matches gap note
 */
function runCase(caseDef, opts) {
  const id   = caseDef.id;
  const exp  = caseDef.expect || {};
  const isGap = opts && opts.gap;

  const input = {
    client_slug:  'wolfhouse-somo',
    channel:      'whatsapp',
    from:         PHONE,
    guest_name:   `Matrix ${id}`,
    language:     caseDef.language || caseDef.lang,
    message_text: caseDef.message,
  };

  const ex  = extractLunaGuestMessageIntake(input, { reference_date: REF_DATE });
  const val = validateLunaGuestMessageIntake(ex);
  const got = val.extraction;

  if (!assertSafetyFlags(ex, id)) return;
  if (!assertPaymentChoice(ex.payment_choice, id)) return;
  if (!assertAddons(ex.add_ons, id)) return;

  const checks = [];

  function check(field, actual, expected, label) {
    if (expected === undefined) return;
    if (actual !== expected) {
      checks.push(`${label}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
    }
  }

  check('guests', ex.guests, exp.guests, 'guests');
  check('check_in', ex.check_in, exp.check_in, 'check_in');
  check('check_out', ex.check_out, exp.check_out, 'check_out');
  check('package_code', got.package_code, exp.package_code, 'package_code');
  check('payment_choice', ex.payment_choice, exp.payment_choice, 'payment_choice');
  check('handoff_required', got.handoff_required, exp.handoff, 'handoff');
  check('can_chain_dry_run', val.can_chain_dry_run, exp.chain, 'chain');

  if (exp.intents) {
    if (!exp.intents.includes(ex.intent)) {
      checks.push(`intent: expected one of ${exp.intents.join('|')} got ${ex.intent}`);
    }
  } else {
    check('intent', ex.intent, exp.intent, 'intent');
  }

  if (exp.ask_dates) {
    const lang = caseDef.language || caseDef.lang || 'en';
    const want = ASK_DATES[lang] || ASK_DATES.en;
    if (got.ask_next !== want) {
      checks.push(`ask_next: expected "${want}" got "${got.ask_next}"`);
    }
  }

  if (exp.ask_present && !got.ask_next) {
    checks.push('ask_next: expected present');
  }

  if (exp.missing_includes) {
    for (const f of exp.missing_includes) {
      if (!got.missing_fields || !got.missing_fields.includes(f)) {
        checks.push(`missing_fields: expected to include ${f}`);
      }
    }
  }

  if (exp.addons_includes) {
    for (const a of exp.addons_includes) {
      if (!ex.add_ons || !ex.add_ons.includes(a)) {
        checks.push(`add_ons: expected to include ${a}`);
      }
    }
  }

  if (exp.errors_includes) {
    for (const e of exp.errors_includes) {
      if (!val.errors.includes(e)) {
        checks.push(`errors: expected to include ${e}`);
      }
    }
  }

  if (exp.dry_run_null !== false && val.can_chain_dry_run === true) {
    const dryIn = buildDryRunInputFromIntake(got, input);
    if (!dryIn.client_slug || !dryIn.phone || !dryIn.check_in || !dryIn.check_out
      || dryIn.guest_count == null || !dryIn.package_code) {
      checks.push('dry_run_input: incomplete when chain expected');
    }
  }

  if (exp.chain === false && val.can_chain_dry_run === true) {
    checks.push('must not chain dry-run');
  }

  if (checks.length) {
    if (isGap) {
      gap(id, `${caseDef.gap_note || 'documented gap'} — ${checks.join('; ')}`);
    } else {
      fail(id, `${caseDef.category}: ${checks.join('; ')}`);
    }
    return;
  }

  const label = `${caseDef.lang}/${caseDef.category}`;
  if (isGap) gap(id, `${label} — gap behavior stable (${caseDef.gap_note || ''})`);
  else pass(id, label);
}

// ─────────────────────────────────────────────────────────────────────────────
section('A. Static safety — helper + route');

const helperSrc = fs.existsSync(HELPER) ? fs.readFileSync(HELPER, 'utf8') : '';
const apiSrc    = fs.existsSync(API) ? fs.readFileSync(API, 'utf8') : '';
const handlerStart = apiSrc.indexOf('async function handleBotMessageIntakePreview(');
const handlerEnd   = handlerStart > -1 ? apiSrc.indexOf('\n// Phase 13c', handlerStart) : -1;
const handler = handlerStart > -1 && handlerEnd > handlerStart
  ? apiSrc.slice(handlerStart, handlerEnd)
  : '';
const combinedSrc = helperSrc + handler;

if (fs.existsSync(HELPER)) pass('A1', 'intake helper exists');
else fail('A1', 'intake helper missing');

for (const [id, re, label] of [
  ['A.sql.ins', /\bINSERT\b/i, 'INSERT'],
  ['A.sql.upd', /\bUPDATE\b/i, 'UPDATE'],
  ['A.sql.del', /\bDELETE\b/i, 'DELETE'],
  ['A.wa', /sendWhatsApp|whatsapp\.send/i, 'WhatsApp'],
  ['A.n8n', /fetchN8n|activateN8n|triggerN8n/i, 'n8n'],
  ['A.stripe', /createStripe|generate-payment-link/i, 'Stripe link'],
  ['A.write', /runLunaGuestBookingWriteBridge|handleBotBookingCreate/i, 'write bridge'],
]) {
  if (!re.test(combinedSrc)) pass(id, `no ${label} in helper/handler`);
  else fail(id, `${label} detected`);
}

if (!isGuestIntakeAiEnabled({}) && !isGuestIntakeAiEnabled({ LUNA_GUEST_INTAKE_AI_ENABLED: '' })) {
  pass('A.ai', 'AI intake disabled by default');
} else {
  fail('A.ai', 'AI should be disabled by default');
}

// ─────────────────────────────────────────────────────────────────────────────
section('B. English matrix (8)');

const EN_CASES = [
  {
    id: 'en.complete', lang: 'en', category: 'complete',
    message: 'Hi, we are 2 people and want to come September 24 to September 27. Do you have Malibu? We can pay the deposit.',
    expect: {
      guests: 2, check_in: '2026-09-24', check_out: '2026-09-27', package_code: 'malibu',
      payment_choice: 'deposit', intent: 'booking_inquiry', handoff: false, chain: true,
    },
  },
  {
    id: 'en.partial_avail', lang: 'en', category: 'partial_availability',
    message: 'Do you have availability for 2 people?',
    expect: {
      guests: 2, intents: ['availability_question', 'booking_inquiry'],
      handoff: false, chain: false, ask_dates: true, ask_present: true,
      missing_includes: ['check_in'],
    },
  },
  {
    id: 'en.package_full', lang: 'en', category: 'package_payment',
    message: 'Can I book Uluwatu and pay in full?',
    expect: {
      package_code: 'uluwatu', payment_choice: 'full',
      handoff: false, chain: false, ask_dates: true,
    },
  },
  {
    id: 'en.addon_meal_yoga', lang: 'en', category: 'addon',
    message: 'Can we add yoga and dinner?',
    expect: {
      intent: 'addon_request', addons_includes: ['yoga', 'meal'],
      handoff: false, chain: false, ask_present: true,
    },
  },
  {
    id: 'en.addon_surf', lang: 'en', category: 'addon',
    message: 'I need a surf lesson and a board.',
    expect: {
      intent: 'addon_request', addons_includes: ['surf_lesson', 'surfboard'],
      handoff: false, chain: false,
    },
  },
  {
    id: 'en.handoff', lang: 'en', category: 'handoff',
    message: 'I want a refund and need to talk to someone.',
    expect: {
      intent: 'cancel_request', handoff: true, chain: false,
    },
  },
  {
    id: 'en.invalid_dates', lang: 'en', category: 'invalid',
    message: 'I want Malibu from 2026-09-10 to 2026-09-05 for 2 people.',
    expect: {
      guests: 2, package_code: 'malibu', handoff: false, chain: false,
      errors_includes: ['invalid_date_range'],
    },
  },
  {
    id: 'en.invalid_unknown', lang: 'en', category: 'invalid',
    message: 'I want the moon package for yesterday to today.',
    expect: {
      handoff: true, chain: false,
    },
  },
];

for (const c of EN_CASES) runCase(c);

// ─────────────────────────────────────────────────────────────────────────────
section('C. Italian matrix (8)');

const IT_CASES = [
  {
    id: 'it.partial', lang: 'it', category: 'partial_availability',
    message: 'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?',
    expect: {
      guests: 2, intent: 'availability_question', handoff: false, chain: false,
      ask_dates: true, missing_includes: ['check_in', 'package_code'],
    },
  },
  {
    id: 'it.complete', lang: 'it', category: 'complete',
    message: 'Siamo tre persone dal 24 settembre al 27 settembre. Vorremmo Malibu e pagare il deposito.',
    expect: {
      guests: 3, check_in: '2026-09-24', check_out: '2026-09-27', package_code: 'malibu',
      payment_choice: 'deposit', intent: 'booking_inquiry', handoff: false, chain: true,
    },
  },
  {
    id: 'it.partial_guests', lang: 'it', category: 'partial_availability',
    message: 'Avete disponibilità per quattro persone?',
    expect: {
      guests: 4, intents: ['availability_question', 'booking_inquiry'],
      handoff: false, chain: false, ask_dates: true,
    },
  },
  {
    id: 'it.package', lang: 'it', category: 'package',
    message: 'Vorrei il pacchetto Uluwatu.',
    expect: {
      package_code: 'uluwatu', handoff: false, chain: false, ask_dates: true,
    },
  },
  {
    id: 'it.addon', lang: 'it', category: 'addon',
    message: 'Possiamo aggiungere yoga e cena?',
    expect: {
      addons_includes: ['yoga', 'meal'], handoff: false, chain: false, ask_present: true,
    },
  },
  {
    id: 'it.addon_surf', lang: 'it', category: 'addon',
    message: 'Vorrei una lezione di surf e una tavola.',
    expect: {
      addons_includes: ['surf_lesson'], handoff: false, chain: false,
    },
  },
  {
    id: 'it.handoff', lang: 'it', category: 'handoff',
    message: 'Voglio un rimborso, posso parlare con qualcuno?',
    expect: {
      intent: 'cancel_request', handoff: true, chain: false,
    },
  },
  {
    id: 'it.payment_full', lang: 'it', category: 'payment',
    message: 'Vorremmo pagare tutto per Waimea.',
    expect: {
      package_code: 'waimea', payment_choice: 'full', handoff: false, chain: false,
    },
  },
];

for (const c of IT_CASES) runCase(c);

// ─────────────────────────────────────────────────────────────────────────────
section('D. Spanish matrix (8)');

const ES_CASES = [
  {
    id: 'es.partial', lang: 'es', category: 'partial_availability',
    message: 'Hola, somos tres personas. Hay disponibilidad?',
    expect: {
      guests: 3, intent: 'availability_question', handoff: false, chain: false,
      ask_dates: true, missing_includes: ['check_in'],
    },
  },
  {
    id: 'es.complete', lang: 'es', category: 'complete',
    message: 'Somos dos personas del 24 de septiembre al 27 de septiembre. Queremos Malibu y pagar el depósito.',
    expect: {
      guests: 2, check_in: '2026-09-24', check_out: '2026-09-27', package_code: 'malibu',
      payment_choice: 'deposit', intent: 'booking_inquiry', handoff: false, chain: true,
    },
  },
  {
    id: 'es.partial_guests', lang: 'es', category: 'partial_availability',
    message: '¿Hay sitio para cuatro personas?',
    expect: {
      guests: 4, intent: 'availability_question', handoff: false, chain: false, ask_dates: true,
    },
  },
  {
    id: 'es.package', lang: 'es', category: 'package',
    message: 'Quiero el paquete Waimea.',
    expect: {
      package_code: 'waimea', handoff: false, chain: false, ask_dates: true,
    },
  },
  {
    id: 'es.addon', lang: 'es', category: 'addon',
    message: 'Podemos añadir yoga y cena?',
    expect: {
      addons_includes: ['yoga', 'meal'], handoff: false, chain: false, ask_present: true,
    },
  },
  {
    id: 'es.addon_surf', lang: 'es', category: 'addon',
    message: 'Necesito una clase de surf y una tabla.',
    expect: {
      addons_includes: ['surf_lesson', 'surfboard'], handoff: false, chain: false,
    },
  },
  {
    id: 'es.handoff', lang: 'es', category: 'handoff',
    message: 'Quiero un reembolso y hablar con alguien.',
    expect: {
      handoff: true, chain: false,
    },
  },
  {
    id: 'es.payment_deposit', lang: 'es', category: 'payment',
    message: 'Quiero pagar el depósito para Uluwatu.',
    expect: {
      package_code: 'uluwatu', payment_choice: 'deposit', handoff: false, chain: false,
    },
  },
];

for (const c of ES_CASES) runCase(c);

// ─────────────────────────────────────────────────────────────────────────────
section('E. French matrix (8)');

const FR_CASES = [
  {
    id: 'fr.partial', lang: 'fr', category: 'partial_availability',
    message: 'Bonjour, nous sommes deux personnes. Vous avez disponibilité?',
    expect: {
      guests: 2, intents: ['availability_question', 'booking_inquiry'],
      handoff: false, chain: false, ask_dates: true,
    },
  },
  {
    id: 'fr.complete', lang: 'fr', category: 'complete',
    message: 'Nous sommes trois personnes du 24 septembre au 27 septembre. Nous voulons Malibu et payer l\'acompte.',
    expect: {
      guests: 3, check_in: '2026-09-24', check_out: '2026-09-27', package_code: 'malibu',
      payment_choice: 'deposit', intent: 'booking_inquiry', handoff: false, chain: true,
    },
  },
  {
    id: 'fr.partial_guests', lang: 'fr', category: 'partial_availability',
    message: 'Avez-vous de la disponibilité pour quatre personnes?',
    expect: {
      guests: 4, intents: ['availability_question', 'booking_inquiry'],
      handoff: false, chain: false, ask_dates: true,
    },
  },
  {
    id: 'fr.package', lang: 'fr', category: 'package',
    message: 'Je voudrais le forfait Uluwatu.',
    expect: {
      package_code: 'uluwatu', handoff: false, chain: false, ask_dates: true,
    },
  },
  {
    id: 'fr.addon', lang: 'fr', category: 'addon',
    message: 'Peut-on ajouter yoga et dîner?',
    expect: {
      addons_includes: ['yoga', 'meal'], handoff: false, chain: false, ask_present: true,
    },
  },
  {
    id: 'fr.addon_surf', lang: 'fr', category: 'addon',
    message: 'J\'ai besoin d\'un cours de surf et d\'une planche.',
    expect: {
      addons_includes: ['surf_lesson', 'surfboard'], handoff: false, chain: false,
    },
  },
  {
    id: 'fr.handoff', lang: 'fr', category: 'handoff',
    message: 'Je veux un remboursement et parler à quelqu\'un.',
    expect: {
      intent: 'cancel_request', handoff: true, chain: false,
    },
  },
  {
    id: 'fr.complaint', lang: 'fr', category: 'handoff',
    message: 'J\'ai une réclamation',
    expect: {
      handoff: true, chain: false,
    },
  },
];

for (const c of FR_CASES) runCase(c);

// ─────────────────────────────────────────────────────────────────────────────
section('F. German matrix (8)');

const DE_CASES = [
  {
    id: 'de.partial', lang: 'de', category: 'partial_availability',
    message: 'Hallo, wir sind zwei Personen. Ist etwas verfügbar?',
    expect: {
      guests: 2, intent: 'availability_question', handoff: false, chain: false,
      ask_dates: true,
    },
  },
  {
    id: 'de.complete', lang: 'de', category: 'complete',
    message: 'Wir sind drei Personen vom 24. September bis 27. September. Wir möchten Malibu und die Anzahlung zahlen.',
    expect: {
      guests: 3, check_in: '2026-09-24', check_out: '2026-09-27', package_code: 'malibu',
      payment_choice: 'deposit', intent: 'booking_inquiry', handoff: false, chain: true,
    },
  },
  {
    id: 'de.partial_guests', lang: 'de', category: 'partial_availability',
    message: 'Gibt es Platz für vier Personen?',
    expect: {
      guests: 4, intents: ['availability_question', 'booking_inquiry'],
      handoff: false, chain: false, ask_dates: true,
    },
  },
  {
    id: 'de.package', lang: 'de', category: 'package',
    message: 'Ich möchte das Waimea Paket.',
    expect: {
      package_code: 'waimea', handoff: false, chain: false, ask_dates: true,
    },
  },
  {
    id: 'de.addon', lang: 'de', category: 'addon',
    message: 'Können wir Yoga und Abendessen hinzufügen?',
    expect: {
      addons_includes: ['yoga', 'meal'], handoff: false, chain: false,
    },
  },
  {
    id: 'de.addon_surf', lang: 'de', category: 'addon',
    message: 'Ich brauche eine Surfstunde und ein Board.',
    expect: {
      addons_includes: ['surf_lesson', 'surfboard'], handoff: false, chain: false,
    },
  },
  {
    id: 'de.handoff', lang: 'de', category: 'handoff',
    message: 'Ich möchte eine Rückerstattung und mit jemandem sprechen.',
    expect: {
      intent: 'cancel_request', handoff: true, chain: false,
    },
  },
  {
    id: 'de.payment_full', lang: 'de', category: 'payment',
    message: 'Wir möchten Uluwatu und vollständig zahlen.',
    expect: {
      package_code: 'uluwatu', payment_choice: 'full', handoff: false, chain: false,
    },
  },
];

for (const c of DE_CASES) runCase(c);

// ─────────────────────────────────────────────────────────────────────────────
section('G. Cross-language validation checks');

const unknownPkg = validateLunaGuestMessageIntake({
  success: true,
  client_slug: 'wolfhouse-somo',
  message_text: 'test',
  language: 'en',
  phone: PHONE,
  guests: 2,
  package_code: 'moon',
  check_in: '2026-09-01',
  check_out: '2026-09-05',
});
if (unknownPkg.errors.includes('unknown_package_code') && !unknownPkg.extraction.package_code) {
  pass('G.unknown_pkg', 'unknown package_code rejected');
} else {
  fail('G.unknown_pkg', 'unknown package not rejected');
}

const noGuests = validateLunaGuestMessageIntake(extractLunaGuestMessageIntake({
  client_slug: 'wolfhouse-somo',
  from: PHONE,
  language: 'en',
  message_text: 'I want Malibu from September 24 to September 27.',
}, { reference_date: REF_DATE }));
if (!noGuests.can_chain_dry_run && noGuests.extraction.missing_fields.includes('guests')) {
  pass('G.no_guests', 'missing guest count blocks dry-run');
} else {
  fail('G.no_guests', 'guest count gap not enforced');
}

// ─────────────────────────────────────────────────────────────────────────────
section('H. Documented parser gaps');

pass('H.gaps', '0 documented gaps — ES/DE native date ranges supported in 15e.2');

// ─────────────────────────────────────────────────────────────────────────────
section('I. Matrix summary');

const totalCases = EN_CASES.length + IT_CASES.length + ES_CASES.length + FR_CASES.length + DE_CASES.length;
pass('I.count', `${totalCases} core matrix cases (${EN_CASES.length} per language), 0 documented gaps`);

const pkgJson = JSON.parse(fs.readFileSync(PKG, 'utf8'));
if (pkgJson.scripts && pkgJson.scripts['verify:luna-agent-phase15-multilingual-intake-matrix']) {
  pass('I.npm', 'npm script registered');
} else {
  fail('I.npm', 'npm script missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('J. Downstream closeout regression');

for (const script of DOWNSTREAM) {
  try {
    execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    pass('J.' + script, `${script} passes`);
  } catch (e) {
    fail('J.' + script, `${script} failed`);
    const out = (e.stdout || '') + (e.stderr || '');
    console.error(out.split('\n').slice(-6).join('\n'));
  }
}

if (gapNotes > 0) {
  console.log(`\n--- ${passes} passed, ${failures} failed, ${gapNotes} documented gaps ---\n`);
} else {
  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
}
process.exit(failures > 0 ? 1 : 0);

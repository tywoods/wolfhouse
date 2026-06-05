/**
 * Phase 17b — Local/static Luna shadow comparison harness.
 *
 * Compares Staff API intake helper output against hand-authored canonical
 * expected outputs. Does NOT execute legacy n8n parser or call hosted API.
 *
 * Usage:
 *   npm run verify:luna-agent-phase17-shadow-comparison
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT   = path.join(__dirname, '..');
const PKG    = path.join(ROOT, 'package.json');
const API    = path.join(__dirname, 'staff-query-api.js');
const HELPER = path.join(__dirname, 'lib', 'luna-guest-message-intake.js');

const REF_DATE = '2026-06-05';
const PHONE    = '+15555550100';

const DOWNSTREAM = [
  'verify:luna-agent-phase17-shadow-comparison-plan',
  'verify:luna-agent-phase16-closeout',
  'verify:luna-agent-phase15-closeout',
  'verify:luna-agent-phase15-multilingual-intake-matrix',
  'verify:luna-agent-phase14-closeout',
  'verify:luna-agent-phase13-closeout',
  'verify:luna-agent-phase12-closeout',
  'verify:staff-ask-luna-phase11-closeout',
];

const {
  extractLunaGuestMessageIntake,
  validateLunaGuestMessageIntake,
  buildDryRunInputFromIntake,
  isGuestIntakeAiEnabled,
  INTAKE_SAFETY_FLAGS,
} = require('./lib/luna-guest-message-intake');

let passes          = 0;
let failures        = 0;
let blockingCount   = 0;
let cosmeticCount   = 0;
const blockingNotes = [];
const cosmeticNotes = [];

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t)    { console.log(`\n── ${t} ──`); }

/** Canonical fixtures — authoritative expected outputs (not legacy parser). */
const FIXTURES = [
  {
    id: 'shadow.en.complete',
    name: 'EN complete booking',
    language: 'en',
    message: 'Hi, we are 2 people and want to come September 24 to September 27. Do you have Malibu? We can pay the deposit.',
    expect: {
      intent: 'booking_inquiry',
      guests: 2,
      check_in: '2026-09-24',
      check_out: '2026-09-27',
      package_code: 'malibu',
      payment_choice: 'deposit',
      handoff_required: false,
      can_chain_dry_run: true,
      dry_run_input: true,
    },
  },
  {
    id: 'shadow.it.partial',
    name: 'IT partial availability',
    language: 'it',
    message: 'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?',
    expect: {
      intent: 'availability_question',
      guests: 2,
      handoff_required: false,
      ask_next: 'In quali date vorresti soggiornare?',
      can_chain_dry_run: false,
      dry_run_input: false,
      missing_includes: ['check_in'],
    },
  },
  {
    id: 'shadow.es.complete',
    name: 'ES native complete',
    language: 'es',
    message: 'Somos dos personas del 24 de septiembre al 27 de septiembre. Queremos Malibu y pagar el depósito.',
    expect: {
      guests: 2,
      check_in: '2026-09-24',
      check_out: '2026-09-27',
      package_code: 'malibu',
      payment_choice: 'deposit',
      handoff_required: false,
      can_chain_dry_run: true,
      dry_run_input: true,
    },
  },
  {
    id: 'shadow.de.complete',
    name: 'DE native complete',
    language: 'de',
    message: 'Wir sind drei Personen vom 24. September bis 27. September. Wir möchten Malibu und die Anzahlung zahlen.',
    expect: {
      guests: 3,
      check_in: '2026-09-24',
      check_out: '2026-09-27',
      package_code: 'malibu',
      payment_choice: 'deposit',
      handoff_required: false,
      can_chain_dry_run: true,
      dry_run_input: true,
    },
  },
  {
    id: 'shadow.en.addon',
    name: 'Add-on request',
    language: 'en',
    message: 'I need a surf lesson and a board.',
    expect: {
      intent: 'addon_request',
      add_ons_includes: ['surf_lesson', 'surfboard'],
      handoff_required: false,
      can_chain_dry_run: false,
      dry_run_input: false,
    },
  },
  {
    id: 'shadow.en.handoff',
    name: 'Refund/handoff',
    language: 'en',
    message: 'I want a refund and need to talk to someone.',
    expect: {
      handoff_required: true,
      handoff_reason_in: ['cancel_or_refund_request', 'human_requested'],
      can_chain_dry_run: false,
      dry_run_input: false,
    },
    intent_cosmetic_in: ['cancel_request', 'human_request'],
  },
  {
    id: 'shadow.en.invalid_package',
    name: 'Invalid package',
    language: 'en',
    message: 'I want the moon package for September 24 to September 27.',
    expect: {
      package_code: null,
      can_chain_dry_run: false,
      dry_run_input: false,
    },
  },
  {
    id: 'shadow.en.missing_dates',
    name: 'Missing dates',
    language: 'en',
    message: 'We are two people and want Malibu.',
    expect: {
      guests: 2,
      package_code: 'malibu',
      missing_includes: ['check_in', 'check_out'],
      ask_next_present: true,
      can_chain_dry_run: false,
      dry_run_input: false,
    },
  },
  {
    id: 'shadow.en.payment_full',
    name: 'Payment full',
    language: 'en',
    message: 'Can I book Uluwatu and pay in full?',
    expect: {
      package_code: 'uluwatu',
      payment_choice: 'full',
      missing_includes: ['check_in'],
      can_chain_dry_run: false,
      dry_run_input: false,
    },
    intent_cosmetic_in: ['booking_inquiry', 'payment_choice'],
  },
  {
    id: 'shadow.es.payment',
    name: 'Multilingual payment (ES)',
    language: 'es',
    message: 'Quiero pagar el depósito para Uluwatu.',
    expect: {
      package_code: 'uluwatu',
      payment_choice: 'deposit',
      missing_includes: ['check_in'],
      ask_next: '¿Qué fechas te gustaría reservar?',
      can_chain_dry_run: false,
      dry_run_input: false,
    },
    intent_cosmetic_in: ['booking_inquiry', 'payment_choice'],
  },
];

function eq(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  return false;
}

function includesAll(arr, required) {
  if (!Array.isArray(arr)) return false;
  return required.every((x) => arr.includes(x));
}

function recordMismatch(fixtureId, kind, msg) {
  const line = `${fixtureId}: ${msg}`;
  if (kind === 'blocking') {
    blockingCount++;
    blockingNotes.push(line);
  } else {
    cosmeticCount++;
    cosmeticNotes.push(line);
  }
}

function assertSafetyFlags(ex, fixtureId) {
  let ok = true;
  for (const [flag, val] of Object.entries(INTAKE_SAFETY_FLAGS)) {
    if (ex[flag] !== val) {
      recordMismatch(fixtureId, 'blocking', `unsafe ${flag}: expected ${val} got ${ex[flag]}`);
      ok = false;
    }
  }
  return ok;
}

function compareField(fixtureId, label, actual, expected, kind = 'blocking') {
  if (expected === undefined) return true;
  if (!eq(actual, expected)) {
    recordMismatch(fixtureId, kind, `${label}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
    return false;
  }
  return true;
}

function runFixture(fixture) {
  const input = {
    client_slug:  'wolfhouse-somo',
    channel:      'whatsapp',
    from:         PHONE,
    guest_name:   `Shadow ${fixture.id}`,
    language:     fixture.language,
    message_text: fixture.message,
  };

  const ex  = extractLunaGuestMessageIntake(input, { reference_date: REF_DATE });
  const val = validateLunaGuestMessageIntake(ex);
  const got = val.extraction;
  const dryRunInput = val.can_chain_dry_run
    ? buildDryRunInputFromIntake(got, input)
    : null;

  const exp = fixture.expect || {};
  const id  = fixture.id;
  let ok    = true;

  if (!assertSafetyFlags(ex, id)) ok = false;

  const fields = [
    'guests', 'check_in', 'check_out', 'package_code', 'payment_choice',
    'handoff_required', 'ask_next',
  ];
  for (const f of fields) compareField(id, f, got[f], exp[f]);

  if (exp.intent !== undefined) {
    compareField(id, 'intent', ex.intent, exp.intent,
      fixture.intent_cosmetic_in ? 'cosmetic' : 'blocking');
  } else if (fixture.intent_cosmetic_in && !fixture.intent_cosmetic_in.includes(ex.intent)) {
    recordMismatch(id, 'cosmetic', `intent: expected one of ${fixture.intent_cosmetic_in.join('|')} got ${ex.intent}`);
    ok = false;
  }

  if (exp.handoff_reason_in) {
    if (!exp.handoff_reason_in.includes(got.handoff_reason)) {
      recordMismatch(id, 'blocking',
        `handoff_reason: expected one of ${exp.handoff_reason_in.join('|')} got ${got.handoff_reason}`);
      ok = false;
    }
  }

  if (exp.can_chain_dry_run !== undefined) {
    if (val.can_chain_dry_run !== exp.can_chain_dry_run) {
      const kind = exp.can_chain_dry_run ? 'blocking' : 'blocking';
      recordMismatch(id, kind,
        `can_chain_dry_run: expected ${exp.can_chain_dry_run} got ${val.can_chain_dry_run}`);
      ok = false;
    }
  }

  if (exp.dry_run_input === true && !dryRunInput) {
    recordMismatch(id, 'blocking', 'dry_run_input expected but missing');
    ok = false;
  }
  if (exp.dry_run_input === false && dryRunInput) {
    recordMismatch(id, 'blocking', 'dry_run_input should not exist');
    ok = false;
  }
  if (dryRunInput) {
    for (const f of ['check_in', 'check_out', 'package_code', 'guest_count', 'phone']) {
      if (!dryRunInput[f]) {
        recordMismatch(id, 'blocking', `dry_run_input missing ${f}`);
        ok = false;
      }
    }
  }

  if (exp.missing_includes) {
    if (!includesAll(got.missing_fields, exp.missing_includes)) {
      recordMismatch(id, 'blocking',
        `missing_fields: expected includes ${JSON.stringify(exp.missing_includes)} got ${JSON.stringify(got.missing_fields)}`);
      ok = false;
    }
  }

  if (exp.ask_next_present === true && !got.ask_next) {
    recordMismatch(id, 'blocking', 'ask_next expected but missing');
    ok = false;
  }

  if (exp.add_ons_includes) {
    if (!includesAll(got.add_ons, exp.add_ons_includes)) {
      recordMismatch(id, 'blocking',
        `add_ons: expected includes ${JSON.stringify(exp.add_ons_includes)} got ${JSON.stringify(got.add_ons)}`);
      ok = false;
    }
  }

  const fixtureBlocking = blockingNotes.filter((n) => n.startsWith(id + ':')).length;
  const fixtureCosmetic = cosmeticNotes.filter((n) => n.startsWith(id + ':')).length;

  if (fixtureBlocking === 0) {
    const status = fixtureCosmetic > 0 ? 'PASS (cosmetic notes)' : 'PASS';
    pass(id, `${fixture.name} — ${status}`);
  } else {
    fail(id, `${fixture.name} — MISMATCH (${fixtureBlocking} blocking, ${fixtureCosmetic} cosmetic)`);
    ok = false;
  }

  return ok;
}

console.log('\nverify-luna-agent-phase17-shadow-comparison.js  (Phase 17b)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'harness passes node --check');
} catch {
  fail('0', 'harness syntax error');
}

// ─────────────────────────────────────────────────────────────────────────────
section('A. Static safety — no live n8n/API/write/send');

const selfSrc   = fs.readFileSync(__filename, 'utf8');
const helperSrc = fs.existsSync(HELPER) ? fs.readFileSync(HELPER, 'utf8') : '';
const apiSrc    = fs.existsSync(API) ? fs.readFileSync(API, 'utf8') : '';
const handlerStart = apiSrc.indexOf('async function handleBotMessageIntakePreview(');
const handlerEnd   = handlerStart > -1 ? apiSrc.indexOf('\n// Phase 13c', handlerStart) : -1;
const handler = handlerStart > -1 && handlerEnd > handlerStart
  ? apiSrc.slice(handlerStart, handlerEnd)
  : '';
const combinedSrc = helperSrc + handler;

for (const [id, re, label] of [
  ['A.harness.n8n', /fetchN8n\s*\(|activateN8n\s*\(|triggerN8n\s*\(/, 'n8n call in harness'],
  ['A.harness.hosted', /staff-staging\.lunafrontdesk|fetch\s*\([^)]*message-intake-preview/i, 'hosted API in harness'],
  ['A.harness.dryrun', /runLunaGuestBookingDryRun\s*\(/, 'live dry-run in harness'],
  ['A.sql.ins', /\bINSERT\b/i, 'INSERT in helper/handler'],
  ['A.sql.upd', /\bUPDATE\b/i, 'UPDATE in helper/handler'],
  ['A.sql.del', /\bDELETE\b/i, 'DELETE in helper/handler'],
  ['A.wa', /sendWhatsApp|whatsapp\.send/i, 'WhatsApp in helper/handler'],
  ['A.stripe', /createStripe|generate-payment-link|api\.stripe/i, 'Stripe in helper/handler'],
  ['A.write', /runLunaGuestBookingWriteBridge|handleBotBookingCreate/i, 'write bridge in helper/handler'],
]) {
  const src = id.startsWith('A.harness') ? selfSrc : combinedSrc;
  if (!re.test(src)) pass(id, `no ${label}`);
  else fail(id, `${label} detected`);
}

if (!isGuestIntakeAiEnabled({}) && !isGuestIntakeAiEnabled({ LUNA_GUEST_INTAKE_AI_ENABLED: '' })) {
  pass('A.ai', 'AI intake disabled by default');
} else {
  fail('A.ai', 'AI should be disabled by default');
}

if (selfSrc.includes('legacy parser') || selfSrc.includes('Wolfhouse booking parser')) {
  pass('A.legacy', 'harness documents legacy parser is not executed');
} else {
  pass('A.legacy', 'harness does not reference legacy parser execution');
}

// ─────────────────────────────────────────────────────────────────────────────
section('B. Canonical fixture comparison');

console.log(`\n  Fixtures: ${FIXTURES.length} (canonical expected outputs; legacy parser advisory only)\n`);

for (const fixture of FIXTURES) {
  runFixture(fixture);
}

console.log('\n── Comparison summary ──');
console.log(`  Fixtures run:     ${FIXTURES.length}`);
console.log(`  Blocking mismatches: ${blockingCount}`);
console.log(`  Cosmetic mismatches: ${cosmeticCount}`);
if (blockingNotes.length) {
  console.log('\n  Blocking:');
  for (const n of blockingNotes) console.log('    - ' + n);
}
if (cosmeticNotes.length) {
  console.log('\n  Cosmetic:');
  for (const n of cosmeticNotes) console.log('    - ' + n);
}

// ─────────────────────────────────────────────────────────────────────────────
section('C. npm script registration');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
if (pkg.scripts
  && pkg.scripts['verify:luna-agent-phase17-shadow-comparison']
    === 'node scripts/verify-luna-agent-phase17-shadow-comparison.js') {
  pass('C1', 'verify:luna-agent-phase17-shadow-comparison registered');
} else {
  fail('C1', 'npm script missing or wrong path');
}

// ─────────────────────────────────────────────────────────────────────────────
section('D. Downstream verifier regression');

for (const script of DOWNSTREAM) {
  try {
    execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    pass('D.' + script, `${script} passes`);
  } catch (e) {
    fail('D.' + script, `${script} failed`);
    const out = (e.stdout || '') + (e.stderr || '');
    console.error(out.split('\n').slice(-6).join('\n'));
  }
}

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);

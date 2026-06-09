/**
 * Stage 27b — Guest message router dry-run verifier.
 *
 * Usage:
 *   npm run verify:stage27b-guest-message-router
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ROUTER = path.join(__dirname, 'lib', 'luna-guest-message-router.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage27b-guest-message-router';
const REL = 'scripts/verify-stage27b-guest-message-router.js';
const REF_DATE = '2026-06-08';

const {
  runLunaGuestMessageRouterDryRun,
  VALID_LANES,
  VALID_INTAKE_STATES,
  ROUTER_SAFETY,
} = require('./lib/luna-guest-message-router');

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

const FORBIDDEN_REPLY_RE = /\b(?:€|\beur\b|price is|costs? \d|payment link|checkout link|pay here|booking is confirmed|confirmed your booking|we have (?:a )?room|beds? available|availability confirmed|rooms? available|link is ready|sent you (?:a )?link)\b/i;

const REQUIRED_OUTPUT_KEYS = [
  'message_lane',
  'intake_state',
  'detected_language',
  'confidence',
  'extracted_fields',
  'missing_required_fields',
  'safe_handoff_required',
  'handoff_reasons',
  'proposed_luna_reply',
  'allowed_next_actions',
];

const FIXTURES = [
  {
    id: 'F01',
    label: 'English new booking inquiry',
    message: "Hi, we're 2 people looking to stay from June 15 to June 22, interested in the Malibu package",
    expect: {
      lane: 'new_booking_inquiry',
      lang: 'en',
      handoff: false,
      extractKeys: ['guest_count', 'package_interest'],
      guest_count: 2,
      package_interest: 'malibu',
      replyContains: ['Luna from Wolfhouse'],
      replyNotForbidden: true,
    },
  },
  {
    id: 'F02',
    label: 'Italian new booking inquiry',
    message: 'Ciao, siamo due persone e vorremmo venire dal 15 al 22 giugno',
    expect: {
      lane: 'new_booking_inquiry',
      lang: 'it',
      handoff: false,
      extractKeys: ['guest_count'],
      guest_count: 2,
      replyContains: ['Luna di Wolfhouse'],
      replyNotForbidden: true,
    },
  },
  {
    id: 'F03',
    label: 'Spanish transfer question',
    message: 'Hola, necesito transfer desde el aeropuerto de Santander',
    expect: {
      lane: 'transfer_request',
      lang: 'es',
      handoff: false,
      noBookingExtract: true,
      replyContains: ['Luna de Wolfhouse'],
      replyNotForbidden: true,
    },
  },
  {
    id: 'F04',
    label: 'German board/wetsuit service request',
    message: 'Hallo, kann ich ein Surfbrett und einen Wetsuit mieten?',
    expect: {
      lane: 'add_service_request',
      lang: 'de',
      handoff: false,
      noBookingExtract: true,
      replyContains: ['Luna von Wolfhouse'],
      replyNotForbidden: true,
    },
  },
  {
    id: 'F05',
    label: 'French unclear date inquiry',
    message: "Bonjour, nous aimerions venir en août peut-être une semaine",
    expect: {
      lane: 'new_booking_inquiry',
      lang: 'fr',
      handoff: true,
      handoffReason: 'unclear_availability',
      replyContains: ['Luna de Wolfhouse'],
      replyNotForbidden: true,
    },
  },
  {
    id: 'F06',
    label: 'Cancellation/refund request',
    message: 'I need to cancel my booking and get a refund',
    expect: {
      lane: 'cancel_or_change_request',
      handoff: true,
      noBookingExtract: true,
      replyNotForbidden: true,
    },
  },
  {
    id: 'F07',
    label: 'Bilbao transfer without package',
    message: "Can I get a transfer from Bilbao airport? I'm not booking a package",
    expect: {
      lane: 'staff_handoff_required',
      handoff: true,
      handoffReason: 'bilbao_no_package_request',
      noBookingExtract: true,
      replyNotForbidden: true,
    },
  },
  {
    id: 'F08',
    label: 'Room availability question',
    message: 'Do you have a room available for next week?',
    expect: {
      lane: 'new_booking_inquiry',
      handoff: true,
      handoffReason: 'unclear_availability',
      replyNotForbidden: true,
    },
  },
  {
    id: 'F09',
    label: 'Price before details',
    message: 'How much does it cost?',
    expect: {
      lane: 'new_booking_inquiry',
      handoff: true,
      handoffReason: 'uncertain_package_or_pricing',
      replyNotForbidden: true,
    },
  },
  {
    id: 'F10',
    label: 'Guest asks to pay now',
    message: "I'd like to pay now please",
    expect: {
      lane: 'payment_question',
      handoff: true,
      handoffReason: 'payment_state_mismatch',
      noBookingExtract: true,
      replyNotForbidden: true,
    },
  },
  {
    id: 'F11',
    label: 'Check-in time / house info',
    message: 'What time is check-in?',
    expect: {
      lane: 'checkin_house_info_question',
      handoff: false,
      noBookingExtract: true,
      replyNotForbidden: true,
    },
  },
  {
    id: 'F12',
    label: 'Remaining balance question',
    message: 'How much balance do I still owe on my booking?',
    expect: {
      lane: 'payment_question',
      handoff: false,
      noBookingExtract: true,
      replyContains: ['booking'],
      replyNotForbidden: true,
    },
  },
  {
    id: 'F13',
    label: 'Random/general question',
    message: 'Do you allow pets at Wolfhouse?',
    expect: {
      lane: 'general_question',
      handoff: true,
      handoffReason: 'outside_policy_question',
      noBookingExtract: true,
      replyNotForbidden: true,
    },
  },
  {
    id: 'F14',
    label: 'Stage 27test-m — just me Malibu July 10-17',
    message: 'just me for Malibu July 10-17',
    expect: {
      lane: 'new_booking_inquiry',
      handoff: false,
      guest_count: 1,
      package_interest: 'malibu',
      booking_intake_ready: true,
      replyNotForbidden: true,
    },
  },
  {
    id: 'F15',
    label: 'Stage 27test-m — solo slash dates Uluwatu',
    message: 'solo traveller Uluwatu 10/7 to 17/7',
    expect: {
      lane: 'new_booking_inquiry',
      handoff: false,
      guest_count: 1,
      package_interest: 'uluwatu',
      booking_intake_ready: true,
      replyNotForbidden: true,
    },
  },
  {
    id: 'F16',
    label: 'Stage 27test-m — partner slash dates Waimea',
    message: 'me and my partner Waimea 10/07-17/07',
    expect: {
      lane: 'new_booking_inquiry',
      handoff: false,
      guest_count: 2,
      package_interest: 'waimea',
      booking_intake_ready: true,
      replyNotForbidden: true,
    },
  },
  {
    id: 'F17',
    label: 'Stage 27test-m — couple compact dates Malibu',
    message: 'couple Malibu jul 10 thru jul 17',
    expect: {
      lane: 'new_booking_inquiry',
      handoff: false,
      guest_count: 2,
      package_interest: 'malibu',
      booking_intake_ready: true,
      replyNotForbidden: true,
    },
  },
  {
    id: 'F18',
    label: 'Stage 27test-m — single date only asks checkout',
    message: 'July 10',
    expect: {
      lane: 'new_booking_inquiry',
      handoff: false,
      booking_intake_ready: false,
      readiness_missing: ['check_out'],
      replyContains: ['check-out'],
      replyNotForbidden: true,
    },
  },
  {
    id: 'F19',
    label: 'Stage 27test-n — compare Uluwatu and Waimea',
    message: 'Difference between Uluwatu and Waimea?',
    expect: {
      lane: 'general_question',
      handoff: false,
      noBookingExtract: true,
      replyContains: ['€349', '€499', 'Uluwatu', 'Waimea'],
      replyNotForbidden: true,
    },
  },
  {
    id: 'F20',
    label: 'Stage 27test-n — explain Malibu vs Uluwatu',
    message: 'Explain Malibu vs Uluwatu please',
    expect: {
      lane: 'general_question',
      handoff: false,
      noBookingExtract: true,
      replyContains: ['€249', '€349', 'Malibu', 'Uluwatu'],
      replyNotForbidden: true,
    },
  },
  {
    id: 'F21',
    label: 'Stage 27test-n — qué incluye Malibu',
    message: '¿Qué incluye Malibu?',
    expect: {
      lane: 'general_question',
      handoff: false,
      noBookingExtract: true,
      replyContains: ['€249', 'Malibu'],
      replyNotForbidden: true,
    },
  },
  {
    id: 'F22',
    label: 'Stage 27test-n — Waimea package details',
    message: 'Waimea package details',
    expect: {
      lane: 'general_question',
      handoff: false,
      noBookingExtract: true,
      replyContains: ['€499', 'Waimea', 'lessons'],
      replyNotForbidden: true,
    },
  },
  {
    id: 'F23',
    label: 'Stage 27test-n — experienced gear only',
    message: 'I am experienced — gear only option?',
    expect: {
      lane: 'general_question',
      handoff: false,
      noBookingExtract: true,
      replyContains: ['Uluwatu'],
      replyNotForbidden: true,
    },
  },
  {
    id: 'F24',
    label: 'Stage 27test-n — quale pacchetto consigli',
    message: 'Quale pacchetto consigli?',
    expect: {
      lane: 'general_question',
      lang: 'it',
      handoff: false,
      noBookingExtract: true,
      replyContains: ['€249', 'Waimea'],
      replyNotForbidden: true,
    },
  },
  {
    id: 'F25',
    label: 'Stage 27test-o — pay cash on arrival',
    message: 'Can I pay cash when I arrive?',
    expect: {
      lane: 'payment_question',
      handoff: false,
      noBookingExtract: true,
      replyContains: ['cash', 'bank transfer', 'Stripe'],
      replyNotForbidden: true,
    },
  },
  {
    id: 'F26',
    label: 'Stage 27test-o — bank transfer',
    message: 'Can I pay by bank transfer?',
    expect: {
      lane: 'payment_question',
      handoff: false,
      noBookingExtract: true,
      replyContains: ['bank transfer'],
      replyNotForbidden: true,
    },
  },
  {
    id: 'F27',
    label: 'Stage 27test-o — send payment link',
    message: 'Send me the payment link',
    expect: {
      lane: 'payment_question',
      handoff: true,
      handoffReason: 'payment_state_mismatch',
      noBookingExtract: true,
      replyContains: ['stay details', 'quote'],
      replyNotForbidden: true,
    },
  },
  {
    id: 'F28',
    label: 'Stage 27test-o — already paid claim',
    message: 'I already paid',
    expect: {
      lane: 'payment_question',
      handoff: false,
      noBookingExtract: true,
      replyContains: ["can't confirm payment"],
      replyNotForbidden: true,
    },
  },
  {
    id: 'F29',
    label: 'Stage 27test-o — payment failed',
    message: 'Payment failed',
    expect: {
      lane: 'payment_question',
      handoff: false,
      noBookingExtract: true,
      replyNotForbidden: true,
    },
  },
  {
    id: 'F30',
    label: 'Stage 27test-o — how much owe',
    message: 'How much do I owe?',
    expect: {
      lane: 'payment_question',
      handoff: false,
      noBookingExtract: true,
      replyContains: ['booking code'],
      replyNotForbidden: true,
    },
  },
  {
    id: 'F31',
    label: 'Stage 27test-o — remaining balance',
    message: 'What is the remaining balance?',
    expect: {
      lane: 'payment_question',
      handoff: false,
      noBookingExtract: true,
      replyContains: ['booking'],
      replyNotForbidden: true,
    },
  },
];

console.log('\nverify-stage27b-guest-message-router.js  (Stage 27b)\n');

try {
  execSync(`node --check "${ROUTER}"`, { stdio: 'pipe' });
  pass('0a', 'router module passes node --check');
} catch {
  fail('0a', 'router module syntax error');
}

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0b', 'verifier passes node --check');
} catch {
  fail('0b', 'verifier syntax error');
}

section('A. Module presence');

if (fs.existsSync(ROUTER)) pass('A1', 'luna-guest-message-router.js exists');
else fail('A1', 'router module missing');

if (typeof runLunaGuestMessageRouterDryRun === 'function') pass('A2', 'runLunaGuestMessageRouterDryRun exported');
else fail('A2', 'runLunaGuestMessageRouterDryRun missing');

section('B. npm script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT] === `node ${REL}`) pass('B1', `${SCRIPT} registered`);
else fail('B1', `${SCRIPT} missing or wrong path`);

section('C. Output shape and safety flags');

const sample = runLunaGuestMessageRouterDryRun(
  { message_text: 'Hello, we want to book for 2 people in June' },
  { reference_date: REF_DATE },
);

if (sample.success) pass('C1', 'sample run success');
else fail('C1', 'sample run failed');

for (const key of REQUIRED_OUTPUT_KEYS) {
  if (key in sample) pass(`C.key.${key}`, `output has ${key}`);
  else fail(`C.key.${key}`, `missing ${key}`);
}

for (const [flag, val] of Object.entries(ROUTER_SAFETY)) {
  if (sample[flag] === val) pass(`C.safe.${flag}`, `${flag}=${val}`);
  else fail(`C.safe.${flag}`, `expected ${flag}=${val} got ${sample[flag]}`);
}

if (Array.isArray(sample.allowed_next_actions) && sample.allowed_next_actions.length) {
  pass('C.actions', 'allowed_next_actions non-empty array');
} else {
  fail('C.actions', 'allowed_next_actions missing or empty');
}

section('D. Lane values and intake states');

if (VALID_LANES.has(sample.message_lane)) pass('D1', 'sample message_lane is valid');
else fail('D1', `invalid message_lane: ${sample.message_lane}`);

if (VALID_INTAKE_STATES.has(sample.intake_state)) pass('D2', 'sample intake_state is first-slice valid');
else fail('D2', `intake_state outside 27b slice: ${sample.intake_state}`);

section('E. Fixture matrix');

for (const fx of FIXTURES) {
  const out = runLunaGuestMessageRouterDryRun(
    { message_text: fx.message },
    { reference_date: REF_DATE },
  );
  const id = fx.id;
  const exp = fx.expect;

  if (!out.success) {
    fail(`${id}.run`, `${fx.label}: run failed`);
    continue;
  }

  if (out.message_lane === exp.lane) pass(`${id}.lane`, `${fx.label}: lane=${exp.lane}`);
  else fail(`${id}.lane`, `${fx.label}: expected lane ${exp.lane} got ${out.message_lane}`);

  if (exp.lang && out.detected_language === exp.lang) {
    pass(`${id}.lang`, `${fx.label}: language=${exp.lang}`);
  } else if (exp.lang) {
    fail(`${id}.lang`, `${fx.label}: expected lang ${exp.lang} got ${out.detected_language}`);
  }

  if (out.safe_handoff_required === exp.handoff) {
    pass(`${id}.handoff`, `${fx.label}: handoff=${exp.handoff}`);
  } else {
    fail(`${id}.handoff`, `${fx.label}: expected handoff ${exp.handoff} got ${out.safe_handoff_required}`);
  }

  if (exp.handoffReason) {
    if (out.handoff_reasons.includes(exp.handoffReason)) {
      pass(`${id}.reason`, `${fx.label}: handoff reason ${exp.handoffReason}`);
    } else {
      fail(`${id}.reason`, `${fx.label}: missing reason ${exp.handoffReason} in ${JSON.stringify(out.handoff_reasons)}`);
    }
  }

  if (exp.noBookingExtract) {
    const empty = !out.extracted_fields || Object.keys(out.extracted_fields).length === 0
      || Object.values(out.extracted_fields).every((v) => v == null || (Array.isArray(v) && !v.length));
    if (empty) pass(`${id}.noextract`, `${fx.label}: no booking extraction`);
    else fail(`${id}.noextract`, `${fx.label}: unexpected extracted_fields ${JSON.stringify(out.extracted_fields)}`);
  }

  if (exp.lane === 'new_booking_inquiry' && !exp.noBookingExtract) {
    if (out.extracted_fields && typeof out.extracted_fields === 'object') {
      pass(`${id}.extract.obj`, `${fx.label}: extracted_fields object present`);
    } else {
      fail(`${id}.extract.obj`, `${fx.label}: missing extracted_fields`);
    }
    for (const k of exp.extractKeys || []) {
      if (out.extracted_fields[k] != null) pass(`${id}.extract.${k}`, `${fx.label}: extracted ${k}`);
      else fail(`${id}.extract.${k}`, `${fx.label}: missing extracted ${k}`);
    }
    if (exp.guest_count != null && out.extracted_fields.guest_count === exp.guest_count) {
      pass(`${id}.guests`, `${fx.label}: guest_count=${exp.guest_count}`);
    } else if (exp.guest_count != null) {
      fail(`${id}.guests`, `${fx.label}: expected guest_count ${exp.guest_count} got ${out.extracted_fields.guest_count}`);
    }
    if (exp.package_interest && out.extracted_fields.package_interest === exp.package_interest) {
      pass(`${id}.pkg`, `${fx.label}: package_interest=${exp.package_interest}`);
    } else if (exp.package_interest) {
      fail(`${id}.pkg`, `${fx.label}: expected package ${exp.package_interest} got ${out.extracted_fields.package_interest}`);
    }
    if (exp.booking_intake_ready != null && out.booking_intake_ready === exp.booking_intake_ready) {
      pass(`${id}.ready`, `${fx.label}: booking_intake_ready=${exp.booking_intake_ready}`);
    } else if (exp.booking_intake_ready != null) {
      fail(`${id}.ready`, `${fx.label}: expected booking_intake_ready ${exp.booking_intake_ready} got ${out.booking_intake_ready}`);
    }
    if (exp.readiness_missing) {
      for (const field of exp.readiness_missing) {
        if ((out.readiness_missing_fields || []).includes(field)) {
          pass(`${id}.missing.${field}`, `${fx.label}: readiness missing ${field}`);
        } else {
          fail(`${id}.missing.${field}`, `${fx.label}: expected readiness_missing_fields to include ${field}, got ${JSON.stringify(out.readiness_missing_fields)}`);
        }
      }
    }
  }

  if (exp.replyContains) {
    for (const frag of exp.replyContains) {
      if (out.proposed_luna_reply.includes(frag)) pass(`${id}.reply.${frag.slice(0, 12)}`, `${fx.label}: reply contains "${frag}"`);
      else fail(`${id}.reply.${frag.slice(0, 12)}`, `${fx.label}: reply missing "${frag}" in: ${out.proposed_luna_reply.slice(0, 80)}`);
    }
  }

  if (exp.replyNotForbidden && FORBIDDEN_REPLY_RE.test(out.proposed_luna_reply)) {
    fail(`${id}.forbidden`, `${fx.label}: reply contains forbidden availability/price/payment/confirm phrase`);
  } else if (exp.replyNotForbidden) {
    pass(`${id}.forbidden`, `${fx.label}: reply avoids forbidden claims`);
  }

  for (const [flag, val] of Object.entries(ROUTER_SAFETY)) {
    if (out[flag] !== val) {
      fail(`${id}.safe.${flag}`, `${fx.label}: ${flag}=${out[flag]} expected ${val}`);
    }
  }
}

section('F. Booking extraction only on new_booking_inquiry');

const transferOut = runLunaGuestMessageRouterDryRun(
  { message_text: 'Hola, necesito transfer desde el aeropuerto de Santander' },
  { reference_date: REF_DATE },
);
if (transferOut.message_lane === 'transfer_request'
  && Object.keys(transferOut.extracted_fields || {}).length === 0) {
  pass('F1', 'transfer lane has empty extracted_fields');
} else {
  fail('F1', 'transfer lane should not extract booking fields');
}

const bookingOut = runLunaGuestMessageRouterDryRun(
  { message_text: 'We are 3 people wanting Malibu package June 10 to June 17' },
  { reference_date: REF_DATE },
);
if (bookingOut.message_lane === 'new_booking_inquiry'
  && bookingOut.extracted_fields.guest_count === 3
  && bookingOut.extracted_fields.package_interest === 'malibu') {
  pass('F2', 'booking lane extracts guest_count and package');
} else {
  fail('F2', 'booking lane extraction incomplete');
}

section('G. Router source forbids live actions');

const routerSrc = fs.readFileSync(ROUTER, 'utf8');
const forbiddenInRouter = [
  ['G.stripe', /api\.stripe\.com|createStripe|stripe\.checkout/i],
  ['G.whatsapp', /graph\.facebook\.com|sendWhatsApp|whatsapp\.send/i],
  ['G.n8n', /fetch\s*\([^)]*n8n|activateWorkflow/i],
  ['G.insert', /\bINSERT\s+INTO\b/i],
  ['G.payment_link', /create-stripe-link|createPaymentLink/i],
];
for (const [id, re] of forbiddenInRouter) {
  if (!re.test(routerSrc)) pass(id, 'router source clean');
  else fail(id, 'forbidden pattern in router source');
}

section('H. Multilingual reply samples');

for (const [id, msg, needle] of [
  ['H.it', 'Ciao, siamo due persone e vorremmo venire a giugno', 'Luna di Wolfhouse'],
  ['H.es', 'Hola, quiero reservar para dos personas', 'Luna de Wolfhouse'],
  ['H.de', 'Hallo, wir möchten buchen', 'Luna von Wolfhouse'],
  ['H.fr', 'Bonjour, nous voulons réserver', 'Luna de Wolfhouse'],
]) {
  const o = runLunaGuestMessageRouterDryRun({ message_text: msg }, { reference_date: REF_DATE });
  if (o.proposed_luna_reply.includes(needle)) pass(id, `reply includes localized intro (${needle})`);
  else fail(id, `expected "${needle}" in reply: ${o.proposed_luna_reply.slice(0, 60)}`);
}

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);

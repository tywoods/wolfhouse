/**
 * Stage 27e — Booking intake readiness gate verifier.
 *
 * Usage:
 *   npm run verify:stage27e-booking-intake-readiness
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ROUTER = path.join(__dirname, 'lib', 'luna-guest-message-router.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage27e-booking-intake-readiness';
const REF_DATE = '2026-06-08';

const {
  runLunaGuestMessageRouterDryRun,
  computeBookingIntakeReadiness,
  VALID_READINESS_STATES,
  ROUTER_SAFETY,
} = require('./lib/luna-guest-message-router');

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

const FORBIDDEN_REPLY_RE = /\b(?:€|\beur\b|price is|costs? \d|payment link|checkout link|pay here|booking is confirmed|confirmed your booking|we have (?:a )?room|beds? available|availability confirmed|rooms? available|link is ready|sent you (?:a )?link)\b/i;

const FORBIDDEN_ACTIONS = new Set([
  'check_availability',
  'quote_price',
  'create_hold',
  'create_booking',
  'create_payment_draft',
  'create_stripe_link',
  'send_whatsapp',
  'send_payment_link',
]);

const READINESS_KEYS = [
  'booking_intake_ready',
  'readiness_state',
  'readiness_missing_fields',
  'readiness_reasons',
];

const FIXTURES = [
  {
    id: 'R01',
    label: 'Complete booking inquiry → ready',
    message: "Hi, we're 2 people looking to stay from June 15 to June 22, interested in the Malibu package",
    expect: {
      lane: 'new_booking_inquiry',
      ready: true,
      readiness_state: 'ready_for_availability_check',
      intake_state: 'ready_for_availability_check',
      missing: [],
      replyContains: ['best option', 'not confirming availability'],
      replyNotForbidden: true,
      actionIncludes: 'ready_for_availability_check_deferred',
    },
  },
  {
    id: 'R02',
    label: 'Missing dates → collecting',
    message: "We're 2 people interested in the Malibu package",
    expect: {
      lane: 'new_booking_inquiry',
      ready: false,
      readiness_state: 'collecting_required_details',
      missingIncludes: ['check_in', 'check_out'],
      replyContains: ['check-in and check-out'],
      replyNotForbidden: true,
    },
  },
  {
    id: 'R03',
    label: 'Missing guest count → collecting',
    message: 'We want the Malibu package from June 15 to June 22',
    expect: {
      lane: 'new_booking_inquiry',
      ready: false,
      readiness_state: 'collecting_required_details',
      missingIncludes: ['guest_count'],
      replyContains: ['How many guests'],
      replyNotForbidden: true,
    },
  },
  {
    id: 'R04',
    label: 'Missing package intent → collecting',
    message: "We're 2 people looking to stay from June 15 to June 22",
    expect: {
      lane: 'new_booking_inquiry',
      ready: false,
      readiness_state: 'collecting_required_details',
      missingIncludes: ['package_interest'],
      replyContains: ['packages'],
      replyNotForbidden: true,
    },
  },
  {
    id: 'R05',
    label: 'Accommodation-only with dates + guests → ready',
    message: 'We need accommodation only for 2 guests from June 15 to June 22',
    expect: {
      lane: 'new_booking_inquiry',
      ready: true,
      readiness_state: 'ready_for_availability_check',
      package_interest: 'accommodation_only',
      replyContains: ['best option'],
      replyNotForbidden: true,
    },
  },
  {
    id: 'R06',
    label: 'No-package explicit with dates + guests → ready',
    message: '2 people, June 15 to June 22, no package — custom stay only',
    expect: {
      lane: 'new_booking_inquiry',
      ready: true,
      readiness_state: 'ready_for_availability_check',
      package_interest: 'no_package',
      replyNotForbidden: true,
    },
  },
  {
    id: 'R07',
    label: 'Price request before full details → not ready / handoff',
    message: 'How much does it cost?',
    expect: {
      lane: 'new_booking_inquiry',
      ready: false,
      readiness_state: 'staff_handoff_required',
      handoff: true,
      reasonIncludes: 'uncertain_package_or_pricing',
      readinessReasonIncludes: 'price_before_required_details',
      replyNotForbidden: true,
    },
  },
  {
    id: 'R08',
    label: 'Availability question before full details → not ready / handoff',
    message: 'Do you have a room available?',
    expect: {
      lane: 'new_booking_inquiry',
      ready: false,
      readiness_state: 'staff_handoff_required',
      handoff: true,
      reasonIncludes: 'unclear_availability',
      readinessReasonIncludes: 'availability_before_required_details',
      replyNotForbidden: true,
    },
  },
  {
    id: 'R09',
    label: 'Non-booking service request → not booking ready',
    message: 'Hi, can I rent a wetsuit for tomorrow?',
    expect: {
      lane: 'add_service_request',
      ready: false,
      readiness_state: 'collecting_required_details',
      readinessReasonIncludes: 'not_booking_inquiry_lane',
      replyNotForbidden: true,
    },
  },
  {
    id: 'R10',
    label: 'Cancellation/refund → handoff',
    message: 'I already paid — please cancel and refund my booking',
    expect: {
      lane: 'cancel_or_change_request',
      ready: false,
      readiness_state: 'staff_handoff_required',
      handoff: true,
      replyNotForbidden: true,
    },
  },
];

section('A. package.json script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) {
  pass('A1', `${SCRIPT} registered`);
} else {
  fail('A1', `missing npm script ${SCRIPT}`);
}

section('B. Output shape — readiness fields');

const sample = runLunaGuestMessageRouterDryRun(
  { message_text: FIXTURES[0].message },
  { reference_date: REF_DATE },
);

if (sample.success) pass('B1', 'sample run success');
else fail('B1', 'sample run failed');

for (const key of READINESS_KEYS) {
  if (key in sample) pass(`B.key.${key}`, `output has ${key}`);
  else fail(`B.key.${key}`, `missing ${key}`);
}

if (typeof sample.booking_intake_ready === 'boolean') {
  pass('B.type.ready', 'booking_intake_ready is boolean');
} else {
  fail('B.type.ready', `booking_intake_ready not boolean: ${typeof sample.booking_intake_ready}`);
}

if (VALID_READINESS_STATES.has(sample.readiness_state)) {
  pass('B.type.state', `readiness_state valid: ${sample.readiness_state}`);
} else {
  fail('B.type.state', `invalid readiness_state: ${sample.readiness_state}`);
}

if (Array.isArray(sample.readiness_missing_fields)) {
  pass('B.type.missing', 'readiness_missing_fields is array');
} else {
  fail('B.type.missing', 'readiness_missing_fields not array');
}

if (Array.isArray(sample.readiness_reasons)) {
  pass('B.type.reasons', 'readiness_reasons is array');
} else {
  fail('B.type.reasons', 'readiness_reasons not array');
}

section('C. Safety flags unchanged');

for (const [flag, val] of Object.entries(ROUTER_SAFETY)) {
  if (sample[flag] === val) pass(`C.safe.${flag}`, `${flag}=${val}`);
  else fail(`C.safe.${flag}`, `expected ${flag}=${val} got ${sample[flag]}`);
}

section('D. Readiness fixture matrix');

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

  if (out.booking_intake_ready === exp.ready) {
    pass(`${id}.ready`, `${fx.label}: booking_intake_ready=${exp.ready}`);
  } else {
    fail(`${id}.ready`, `${fx.label}: expected ready=${exp.ready} got ${out.booking_intake_ready}`);
  }

  if (out.readiness_state === exp.readiness_state) {
    pass(`${id}.state`, `${fx.label}: readiness_state=${exp.readiness_state}`);
  } else {
    fail(`${id}.state`, `${fx.label}: expected readiness_state ${exp.readiness_state} got ${out.readiness_state}`);
  }

  if (exp.intake_state && out.intake_state === exp.intake_state) {
    pass(`${id}.intake`, `${fx.label}: intake_state=${exp.intake_state}`);
  } else if (exp.intake_state) {
    fail(`${id}.intake`, `${fx.label}: expected intake_state ${exp.intake_state} got ${out.intake_state}`);
  }

  if (exp.handoff != null && out.safe_handoff_required === exp.handoff) {
    pass(`${id}.handoff`, `${fx.label}: handoff=${exp.handoff}`);
  } else if (exp.handoff != null) {
    fail(`${id}.handoff`, `${fx.label}: expected handoff ${exp.handoff} got ${out.safe_handoff_required}`);
  }

  if (exp.reasonIncludes && out.handoff_reasons.includes(exp.reasonIncludes)) {
    pass(`${id}.reason`, `${fx.label}: handoff reason ${exp.reasonIncludes}`);
  } else if (exp.reasonIncludes) {
    fail(`${id}.reason`, `${fx.label}: missing handoff reason ${exp.reasonIncludes}`);
  }

  if (exp.readinessReasonIncludes && out.readiness_reasons.includes(exp.readinessReasonIncludes)) {
    pass(`${id}.rreason`, `${fx.label}: readiness reason ${exp.readinessReasonIncludes}`);
  } else if (exp.readinessReasonIncludes) {
    fail(`${id}.rreason`, `${fx.label}: missing readiness reason ${exp.readinessReasonIncludes}`);
  }

  if (exp.missing) {
    const same = JSON.stringify(out.readiness_missing_fields) === JSON.stringify(exp.missing);
    if (same) pass(`${id}.missing`, `${fx.label}: readiness_missing_fields empty as expected`);
    else fail(`${id}.missing`, `${fx.label}: expected missing ${JSON.stringify(exp.missing)} got ${JSON.stringify(out.readiness_missing_fields)}`);
  }

  if (exp.missingIncludes) {
    for (const field of exp.missingIncludes) {
      if (out.readiness_missing_fields.includes(field)) {
        pass(`${id}.missing.${field}`, `${fx.label}: missing includes ${field}`);
      } else {
        fail(`${id}.missing.${field}`, `${fx.label}: expected missing ${field} in ${JSON.stringify(out.readiness_missing_fields)}`);
      }
    }
  }

  if (exp.package_interest && out.extracted_fields.package_interest === exp.package_interest) {
    pass(`${id}.pkg`, `${fx.label}: package_interest=${exp.package_interest}`);
  } else if (exp.package_interest) {
    fail(`${id}.pkg`, `${fx.label}: expected package ${exp.package_interest} got ${out.extracted_fields.package_interest}`);
  }

  if (exp.replyContains) {
    for (const frag of exp.replyContains) {
      if (out.proposed_luna_reply.toLowerCase().includes(frag.toLowerCase())) {
        pass(`${id}.reply.${frag.slice(0, 12)}`, `${fx.label}: reply contains "${frag}"`);
      } else {
        fail(`${id}.reply.${frag.slice(0, 12)}`, `${fx.label}: reply missing "${frag}"`);
      }
    }
  }

  if (exp.replyNotForbidden && FORBIDDEN_REPLY_RE.test(out.proposed_luna_reply)) {
    fail(`${id}.forbidden`, `${fx.label}: reply contains forbidden availability/price/payment/confirm phrase`);
  } else if (exp.replyNotForbidden) {
    pass(`${id}.forbidden`, `${fx.label}: reply avoids forbidden claims`);
  }

  if (exp.actionIncludes) {
    if ((out.allowed_next_actions || []).includes(exp.actionIncludes)) {
      pass(`${id}.action`, `${fx.label}: allowed_next_actions includes ${exp.actionIncludes}`);
    } else {
      fail(`${id}.action`, `${fx.label}: missing action ${exp.actionIncludes} in ${JSON.stringify(out.allowed_next_actions)}`);
    }
  }

  for (const action of out.allowed_next_actions || []) {
    if (FORBIDDEN_ACTIONS.has(action)) {
      fail(`${id}.forbiddenAction.${action}`, `${fx.label}: forbidden action ${action}`);
    }
  }
}

section('E. Ready only when all required fields present');

const completeFields = {
  check_in: '2026-06-15',
  check_out: '2026-06-22',
  guest_count: 2,
  package_interest: 'malibu',
};
const readyGate = computeBookingIntakeReadiness('new_booking_inquiry', completeFields, false, []);
if (readyGate.booking_intake_ready && readyGate.readiness_state === 'ready_for_availability_check') {
  pass('E1', 'complete fields → ready_for_availability_check');
} else {
  fail('E1', `expected ready got ${JSON.stringify(readyGate)}`);
}

for (const [label, partial] of [
  ['E2.no_dates', { ...completeFields, check_in: null, check_out: null }],
  ['E3.no_guests', { ...completeFields, guest_count: null }],
  ['E4.no_package', { ...completeFields, package_interest: null }],
]) {
  const g = computeBookingIntakeReadiness('new_booking_inquiry', partial, false, []);
  if (!g.booking_intake_ready && g.readiness_state === 'collecting_required_details') {
    pass(label, 'incomplete fields → not ready');
  } else {
    fail(label, `expected not ready got ${JSON.stringify(g)}`);
  }
}

const noPkgReady = computeBookingIntakeReadiness(
  'new_booking_inquiry',
  { ...completeFields, package_interest: 'no_package' },
  false,
  [],
);
if (noPkgReady.booking_intake_ready) pass('E5', 'no_package counts as package intent');
else fail('E5', 'no_package should satisfy package requirement');

section('F. Non-booking lane readiness');

const svc = runLunaGuestMessageRouterDryRun(
  { message_text: 'Can I add a surf lesson?' },
  { reference_date: REF_DATE },
);
if (svc.booking_intake_ready === false && svc.readiness_reasons.includes('not_booking_inquiry_lane')) {
  pass('F1', 'service lane not booking ready');
} else {
  fail('F1', 'service lane should not be booking ready');
}

section('G. Router source forbids live actions');

const routerSrc = fs.readFileSync(ROUTER, 'utf8');
const forbiddenInRouter = [
  ['G.stripe', /api\.stripe\.com|createStripe|stripe\.checkout/i],
  ['G.whatsapp', /graph\.facebook\.com|sendWhatsApp|whatsapp\.send/i],
  ['G.n8n', /fetch\s*\([^)]*n8n|activateWorkflow/i],
  ['G.insert', /\bINSERT\s+INTO\b/i],
  ['G.payment_link', /create-stripe-link|createPaymentLink/i],
  ['G.availability', /checkAvailability|fetchAvailability|availabilityApi/i],
];
for (const [id, re] of forbiddenInRouter) {
  if (!re.test(routerSrc)) pass(id, 'router source clean');
  else fail(id, 'forbidden pattern in router source');
}

section('H. Doc files');

const doc27e = path.join(ROOT, 'docs', 'STAGE-27E-BOOKING-INTAKE-READINESS.md');
if (fs.existsSync(doc27e)) pass('H1', 'STAGE-27E doc exists');
else fail('H1', 'missing STAGE-27E doc');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);

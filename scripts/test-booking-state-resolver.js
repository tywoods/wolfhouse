/**
 * Phase 2f — unit tests for Booking State Resolver (no n8n required).
 * Run: node scripts/test-booking-state-resolver.js
 */
const { resolveBookingRoute } = require('./lib/booking-state-resolver');

const fixtures = [
  {
    id: '2f-payment-link-intent-with-contact-and-hold',
    input: {
      router_route: 'payment_or_confirm_intent',
      router_reason: 'guest asks for payment link',
      router_confidence: 0.92,
      language: 'en',
      guest_message:
        'Thanks. My full name is Phase 3c Payment Test and my email is phase3c.payment.test+1493@example.com. Please send me the payment link for my booking.',
      pending_action: 'none',
      conversation_stage: 'booking_flow',
      active_booking: {
        active_booking_found: true,
        active_booking_status: 'Hold',
        active_booking_id: 'WH-260528-1493',
      },
    },
    expect: {
      resolved_route: 'payment_details_provided',
      decision_code: 'R2F_PAYMENT_DETAILS_PRIORITY_ON_CONTACT_AND_LINK',
      should_search_hold: true,
    },
  },
  {
    id: '2f-handoff-payment-link-contact-hold-lookup',
    input: {
      router_route: 'human_handoff',
      router_reason: 'repeated payment link requests',
      router_confidence: 0.92,
      language: 'en',
      guest_message:
        'Thanks. My full name is Phase 3c Payment Test and my email is phase3c.payment.test+1493@example.com. Please send me the payment link for my booking.',
      pending_action: 'none',
      conversation_stage: 'booking_flow',
      active_booking: { active_booking_found: false },
      conversation: {},
    },
    expect: {
      resolved_route: 'payment_details_provided',
      decision_code: 'R2F_PAYMENT_DETAILS_PRIORITY_ON_CONTACT_AND_LINK_FROM_HANDOFF',
      should_search_hold: true,
    },
  },
  {
    id: '2f-handoff-payment-claim-no-override',
    input: {
      router_route: 'human_handoff',
      router_reason: 'payment issue escalation',
      router_confidence: 0.9,
      language: 'en',
      guest_message: 'I paid already, did you receive payment? My email is phase3c.payment.test+1493@example.com',
      pending_action: 'none',
      conversation_stage: 'payment_pending',
      active_booking: { active_booking_found: false },
      conversation: {},
    },
    expect: {
      resolved_route: 'human_handoff',
      decision_code: 'R2F_ROUTER_ACCEPTED',
      should_search_hold: false,
    },
  },
  {
    id: '2f-james-july-booking-flow',
    input: {
      router_route: 'booking_flow',
      router_reason: 'new booking request',
      router_confidence: 0.92,
      language: 'en',
      guest_message:
        'Hi, we are 2 people looking for a shared room from July 1 to July 3. My name is James and my email is james@example.com',
      pending_action: 'none',
      active_booking: { active_booking_found: false },
    },
    expect: {
      resolved_route: 'booking_flow',
      decision_code: 'R2F_BOOKING_FLOW',
      apply_after_hold: true,
      has_booking_core: true,
    },
  },
  {
    id: '2f-full-first-message-no-hold',
    input: {
      router_route: 'payment_details_provided',
      router_reason: 'guest gave name and email',
      router_confidence: 0.9,
      language: 'en',
      guest_message:
        'Hi, we are 2 people, shared room, June 1-3, my name is Jamy, email is jamy@example.com.',
      pending_action: 'none',
      active_booking: { active_booking_found: false },
    },
    expect: {
      resolved_route: 'booking_flow',
      decision_code: 'R2F_FULL_BOOKING_NO_HOLD',
      should_search_hold: false,
      apply_after_hold: true,
    },
  },
  {
    id: '2f-c2-contact-hold-hint-pick-missed',
    input: {
      router_route: 'payment_details_provided',
      router_reason: 'guest contact details',
      router_confidence: 0.95,
      language: 'en',
      guest_message: 'Jamy Garcia jamy@example.com',
      pending_action: 'none',
      conversation_stage: 'payment_pending',
      conversation: { 'Current Hold ID': 'WH-recC2HOLD' },
      active_booking: { active_booking_found: false },
    },
    expect: {
      resolved_route: 'payment_details_provided',
      decision_code: 'R2F_PAYMENT_DETAILS_ON_HOLD_LOOKUP',
      should_search_hold: true,
    },
  },
  {
    id: '2f-c2-contact-payment-pending-stage',
    input: {
      router_route: 'payment_details_provided',
      router_reason: 'guest contact details',
      router_confidence: 0.95,
      language: 'en',
      guest_message: 'Jamy Garcia jamy@example.com',
      pending_action: 'none',
      conversation_stage: 'payment_pending',
      active_booking: { active_booking_found: false },
    },
    expect: {
      resolved_route: 'payment_details_provided',
      decision_code: 'R2F_PAYMENT_DETAILS_ON_HOLD_LOOKUP',
      should_search_hold: true,
    },
  },
  {
    id: '2f-contact-no-hold-cold',
    input: {
      router_route: 'payment_details_provided',
      router_reason: 'guest contact details',
      router_confidence: 0.9,
      language: 'en',
      guest_message: 'Jamy Garcia jamy@example.com',
      pending_action: 'none',
      conversation_stage: '',
      active_booking: { active_booking_found: false },
    },
    expect: {
      resolved_route: 'booking_flow',
      decision_code: 'R2F_CONTACT_NO_HOLD',
      should_search_hold: false,
    },
  },
  {
    id: '2f-details-only-with-hold',
    input: {
      router_route: 'payment_details_provided',
      router_reason: 'guest contact details',
      router_confidence: 0.95,
      language: 'en',
      guest_message: 'Jamy Garcia jamy@example.com',
      pending_action: 'none',
      active_booking: {
        active_booking_found: true,
        active_booking_status: 'Hold',
        active_booking_id: 'WH-recTEST',
      },
    },
    expect: {
      resolved_route: 'payment_details_provided',
      decision_code: 'R2F_PAYMENT_DETAILS_ON_HOLD',
      should_search_hold: true,
    },
  },
  {
    id: '2f-payment-claim',
    input: {
      router_route: 'payment_completed_claim',
      router_reason: 'guest says paid',
      router_confidence: 0.9,
      language: 'en',
      guest_message: 'I paid already',
      pending_action: 'none',
      active_booking: { active_booking_found: false },
    },
    expect: {
      resolved_route: 'payment_completed_claim',
      decision_code: 'R2F_PAYMENT_CLAIM',
      should_search_hold: false,
    },
  },
  {
    id: '2f-general-question',
    input: {
      router_route: 'general_question',
      router_reason: 'surfboards',
      router_confidence: 0.9,
      language: 'en',
      guest_message: 'Do you rent surfboards?',
      pending_action: 'none',
      active_booking: { active_booking_found: false },
    },
    expect: {
      resolved_route: 'general_question',
      decision_code: 'R2F_GENERAL_QUESTION',
      should_search_hold: false,
    },
  },
  {
    id: '2f-modify-with-active-booking',
    input: {
      router_route: 'existing_booking_modify',
      router_reason: 'change dates',
      router_confidence: 0.9,
      language: 'en',
      guest_message: 'Can we change to June 5-7?',
      pending_action: 'none',
      active_booking: {
        active_booking_found: true,
        active_booking_status: 'Confirmed',
        active_booking_id: 'WH-recEXIST',
      },
    },
    expect: {
      resolved_route: 'existing_booking_modify',
      decision_code: 'R2F_EXISTING_BOOKING_ROUTE',
      should_search_hold: false,
    },
  },
  {
    id: '2f-rooming-without-hold',
    input: {
      router_route: 'rooming_details_provided',
      router_reason: 'two girls',
      router_confidence: 0.85,
      language: 'en',
      guest_message: 'We are 2 girls, June 1-3',
      pending_action: 'none',
      active_booking: { active_booking_found: false },
    },
    expect: {
      resolved_route: 'booking_flow',
      decision_code: 'R2F_ROOMING_TO_BOOKING_CORE',
      should_search_hold: false,
    },
  },
];

let failed = 0;

for (const fx of fixtures) {
  const out = resolveBookingRoute(fx.input);
  const errors = [];

  if (out.resolved_route !== fx.expect.resolved_route) {
    errors.push(`resolved_route: got ${out.resolved_route}, want ${fx.expect.resolved_route}`);
  }
  if (
    fx.expect.decision_code !== undefined &&
    out.logging.decision_code !== fx.expect.decision_code
  ) {
    errors.push(`decision_code: got ${out.logging.decision_code}, want ${fx.expect.decision_code}`);
  }
  if (
    fx.expect.should_search_hold !== undefined &&
    out.hold_lookup.should_search_hold !== fx.expect.should_search_hold
  ) {
    errors.push(
      `should_search_hold: got ${out.hold_lookup.should_search_hold}, want ${fx.expect.should_search_hold}`
    );
  }
  if (
    fx.expect.apply_after_hold !== undefined &&
    out.staged_contact.apply_after_hold !== fx.expect.apply_after_hold
  ) {
    errors.push(
      `apply_after_hold: got ${out.staged_contact.apply_after_hold}, want ${fx.expect.apply_after_hold}`
    );
  }
  if (
    fx.expect.has_booking_core !== undefined &&
    out.message_signals.has_booking_core !== fx.expect.has_booking_core
  ) {
    errors.push(
      `has_booking_core: got ${out.message_signals.has_booking_core}, want ${fx.expect.has_booking_core}`
    );
  }
  if (errors.length) {
    failed += 1;
    console.log(`FAIL ${fx.id}`);
    for (const e of errors) console.log(`  - ${e}`);
    console.log('  output:', JSON.stringify(out, null, 2));
  } else {
    console.log(`OK   ${fx.id} → ${out.resolved_route} (${out.logging.decision_code})`);
  }
}

if (failed > 0) {
  console.log(`\n${failed} fixture(s) failed`);
  process.exit(1);
}

console.log(`\nAll ${fixtures.length} resolver fixtures passed.`);

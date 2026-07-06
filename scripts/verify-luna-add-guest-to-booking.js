'use strict';

/**
 * verify:luna-add-guest-to-booking — Slice 1 (UNPAID add-guest lane).
 *
 * Covers: tool registered & GPT-plannable; deterministic plan includes add_guest when
 * bookingId + intent present; readiness blocks paid (booking_paid_requires_staff) and
 * no-availability; readiness ready on unpaid+available; backing-module requote math
 * (2→3 guests => +€135 => €435 on the sample €300 booking); handoff policy does NOT
 * escalate unpaid add-guest but DOES for paid; composer copy includes new total + link.
 *
 * No live sends, no real DB — a fake pg client stubs the queries.
 */

let passes = 0;
let failures = 0;
function ok(name, cond) {
  if (cond) { console.log(`  PASS  ${name}`); passes++; }
  else { console.error(`  FAIL  ${name}`); failures++; }
}

console.log('\nverify-luna-add-guest-to-booking.js\n');

// ── modules under test ─────────────────────────────────────────────────────
const toolPlan = require('./lib/luna-guest-agent-tool-plan');
const executor = require('./lib/luna-guest-agent-write-tool-executor');
const addGuestAttach = require('./lib/luna-guest-addguest-attach');
const handoffPolicy = require('./lib/luna-guest-handoff-policy');
const { classifyMessageLane, detectAddGuestRequest } = require('./lib/luna-guest-message-router');
const { buildWritePlannerSystemPrompt } = require('./lib/luna-guest-gpt-write-tool-planner');
const { composeLunaGuestReply } = require('./lib/luna-guest-reply-composer');

const ENABLED_ENV = { OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true' };

// ── 1. tool registered + plannable ─────────────────────────────────────────
ok('tool registered in GUEST_AGENT_TOOLS',
  !!toolPlan.GUEST_AGENT_TOOLS.add_guest_to_booking);
ok('tool is a gated write tool',
  toolPlan.GUEST_AGENT_TOOLS.add_guest_to_booking
  && toolPlan.GUEST_AGENT_TOOLS.add_guest_to_booking.read_or_write === 'write'
  && toolPlan.GUEST_AGENT_TOOLS.add_guest_to_booking.safety_gate_required === true);
ok('tool is GPT-plannable',
  toolPlan.isGuestAgentGptPlannableWriteTool('add_guest_to_booking'));
ok('add_guest_to_booking ordered before create_payment_link in plannable ids', (() => {
  const ids = toolPlan.GUEST_AGENT_GPT_PLANNABLE_WRITE_TOOL_IDS;
  return ids.indexOf('add_guest_to_booking') >= 0
    && ids.indexOf('add_guest_to_booking') < ids.indexOf('create_payment_link');
})());
ok('planGuestAgentToolSteps enumerates add_guest_to_booking for add_guest_request intent', (() => {
  const steps = toolPlan.planGuestAgentToolSteps({ intent: 'add_guest_request', payload: {} });
  const ids = steps.map((s) => s.tool_id);
  return ids.includes('add_guest_to_booking')
    && ids.indexOf('add_guest_to_booking') < ids.indexOf('create_payment_link');
})());

// ── 2. intent detection + extraction ───────────────────────────────────────
ok('detectAddGuestRequest parses name + count', (() => {
  const r = detectAddGuestRequest('Sorry, please add 1 more person. Tom');
  return r && r.requested === true && r.count === 1 && r.names.includes('Tom');
})());
ok('detectAddGuestRequest returns null for a plain service request',
  detectAddGuestRequest('Can I add a surf lesson?') == null);
ok('hasAddGuestIntent reads array field',
  executor.hasAddGuestIntent({ add_guest_request: ['Tom'] }) === true);
ok('hasAddGuestIntent false when absent',
  executor.hasAddGuestIntent({}) === false);
ok('resolveAddGuestNames pulls names from array',
  executor.resolveAddGuestNames({ add_guest_request: ['Tom', 'Jo'] }).join(',') === 'Tom,Jo');

// ── 3. deterministic write plan ────────────────────────────────────────────
const bookingCtxUnpaid = {
  booking_id: 'bk-unpaid-1',
  payment_status: 'pending',
  env: ENABLED_ENV,
};
const chainWithFields = {
  result: { extracted_fields: { add_guest_request: ['Tom'], check_in: '2026-09-16', check_out: '2026-09-19' } },
};
ok('deterministic plan includes add_guest_to_booking when bookingId + intent (unpaid)', (() => {
  const plan = executor.buildDeterministicWriteToolPlan(chainWithFields, bookingCtxUnpaid);
  const ids = plan.map((t) => t.tool_id);
  return ids.includes('add_guest_to_booking')
    && ids.indexOf('add_guest_to_booking') < ids.indexOf('create_payment_link');
})());
ok('deterministic plan add_guest reason is guest_requested_add_person_on_existing_booking', (() => {
  const plan = executor.buildDeterministicWriteToolPlan(chainWithFields, bookingCtxUnpaid);
  const step = plan.find((t) => t.tool_id === 'add_guest_to_booking');
  return step && step.reason === 'guest_requested_add_person_on_existing_booking';
})());
ok('deterministic plan omits add_guest_to_booking for a PAID booking', (() => {
  const plan = executor.buildDeterministicWriteToolPlan(chainWithFields, {
    booking_id: 'bk-paid-1', payment_status: 'deposit_paid', env: ENABLED_ENV,
  });
  return !plan.map((t) => t.tool_id).includes('add_guest_to_booking');
})());

// ── 4. readiness gating ────────────────────────────────────────────────────
ok('readiness READY on unpaid + intent + writes enabled + pg', (() => {
  const r = executor.evaluateWriteToolReadiness('add_guest_to_booking', chainWithFields, {
    ...bookingCtxUnpaid, pg: {}, env: ENABLED_ENV,
  });
  return r.ready === true && r.block_reasons.length === 0;
})());
ok('readiness BLOCKS paid booking with booking_paid_requires_staff', (() => {
  const r = executor.evaluateWriteToolReadiness('add_guest_to_booking', chainWithFields, {
    booking_id: 'bk-paid-1', payment_status: 'deposit_paid', pg: {}, env: ENABLED_ENV,
  });
  return r.ready === false && r.block_reasons.includes('booking_paid_requires_staff');
})());
ok('readiness BLOCKS when writes disabled', (() => {
  const r = executor.evaluateWriteToolReadiness('add_guest_to_booking', chainWithFields, {
    ...bookingCtxUnpaid, pg: {}, env: {},
  });
  return r.ready === false && r.block_reasons.includes('booking_writes_disabled');
})());
ok('readiness BLOCKS when no booking id', (() => {
  const r = executor.evaluateWriteToolReadiness('add_guest_to_booking',
    { result: { extracted_fields: { add_guest_request: ['Tom'] } } },
    { pg: {}, env: ENABLED_ENV });
  return r.ready === false && r.block_reasons.includes('booking_id_missing');
})());
ok('readiness BLOCKS when no add-guest intent', (() => {
  const r = executor.evaluateWriteToolReadiness('add_guest_to_booking',
    { result: { extracted_fields: {} } }, { ...bookingCtxUnpaid, pg: {}, env: ENABLED_ENV });
  return r.ready === false && r.block_reasons.includes('no_add_guest_intent');
})());

// ── 5. backing-module requote math (2 -> 3 guests) ─────────────────────────
ok('computeAccommodationDelta 2->3 guests on 16-19 Sep => +€135', (() => {
  const d = addGuestAttach.computeAccommodationDelta({
    clientSlug: 'wolfhouse-somo', checkIn: '2026-09-16', checkOut: '2026-09-19',
    packageCode: 'no_package', roomType: 'shared',
  }, 2, 1);
  return d.ok === true && d.delta_cents === 13500;
})());

// Fake pg that serves the sample UNPAID booking (€300 total, 2 guests) and records writes.
function makeFakePg(paymentStatus, opts) {
  const o = opts || {};
  const state = { updates: [], insertedGuests: [], paymentDraftUpdates: [] };
  const pg = {
    state,
    async query(sql, params) {
      const s = String(sql);
      if (/FROM clients WHERE slug/i.test(s)) {
        return { rows: [{ id: 'client-uuid-1' }] };
      }
      if (/FROM bookings b/i.test(s) && /SELECT/i.test(s) && !/UPDATE/i.test(s)) {
        return {
          rows: [{
            booking_id: 'bk-1', booking_code: 'WH-SAMPLE', client_id: 'client-uuid-1',
            guest_count: 2, guest_name: 'John, Jane',
            total_amount_cents: 30000, amount_paid_cents: 0, balance_due_cents: 30000,
            payment_status: paymentStatus,
            check_in: '2026-09-16', check_out: '2026-09-19',
            package_code: 'no_package', metadata: {},
          }],
        };
      }
      if (/UPDATE bookings/i.test(s)) { state.updates.push(params); return { rows: [], rowCount: 1 }; }
      if (/UPDATE payments/i.test(s)) {
        state.paymentDraftUpdates.push(params);
        // params: [clientSlug, bookingId, newTotalCents]
        return { rows: [{ payment_draft_id: 'pay-draft-1', amount_due_cents: params[2] }], rowCount: 1 };
      }
      if (/INSERT INTO booking_guests/i.test(s)) {
        state.insertedGuests.push(params);
        return { rows: [{ booking_guest_id: `bg-${state.insertedGuests.length}`, guest_number: params[2], guest_name: params[3], payment_status: 'not_requested' }] };
      }
      // Availability dry-run bed lookups — return enough beds unless opts.noBeds.
      if (/booking_holds|beds|inventory|availability|room|bed/i.test(s)) {
        return { rows: o.noBeds ? [] : [{ bed_code: 'B1' }, { bed_code: 'B2' }, { bed_code: 'B3' }, { bed_code: 'B4' }] };
      }
      return { rows: [] };
    },
  };
  return pg;
}

(async () => {
  // Stub availability so the requote-math checks are deterministic regardless of the
  // availability engine's fake-pg behavior. Injected via opts.availabilityChecker.
  const availAvailable = async () => ({ available: true, status: 'available', detail: {} });
  const availUnavailable = async () => ({ available: false, status: 'unavailable', detail: {} });

  // 5b. Backing module end-to-end on UNPAID booking => €435 total, guest row inserted.
  {
    const pg = makeFakePg('pending');
    const out = await addGuestAttach.addGuestToBooking(pg, {
      clientSlug: 'wolfhouse-somo', bookingId: 'bk-1', newGuestNames: ['Tom'], env: ENABLED_ENV,
      availabilityChecker: availAvailable,
    });
    ok('backing module UNPAID add => status ok', out.status === 'ok');
    ok('backing module new total = €435 (30000 + 13500)', out.new_total_amount_cents === 43500);
    ok('backing module guest_count 2 -> 3', out.new_guest_count === 3);
    ok('backing module appended guest name', out.guest_name === 'John, Jane, Tom');
    ok('backing module inserted 1 booking_guests row', pg.state.insertedGuests.length === 1);
    ok('backing module updated the booking once', pg.state.updates.length === 1);
    ok('backing module balance_due reflects new total', out.new_balance_due_cents === 43500);
    ok('backing module refreshed pay-in-full draft to €435', pg.state.paymentDraftUpdates.length === 1 && Number(pg.state.paymentDraftUpdates[0][2]) === 43500);
    ok('backing module returns refreshed payment_draft_id for re-send', out.payment_draft_id === 'pay-draft-1');
    ok('backing module refreshed draft amount = new total', out.payment_draft_amount_due_cents === 43500);
  }

  // 5c. Backing module PAID booking => handoff_paid, no mutation.
  {
    const pg = makeFakePg('deposit_paid');
    const out = await addGuestAttach.addGuestToBooking(pg, {
      clientSlug: 'wolfhouse-somo', bookingId: 'bk-1', newGuestNames: ['Tom'], env: ENABLED_ENV,
      availabilityChecker: availAvailable,
    });
    ok('backing module PAID => status handoff_paid', out.status === 'handoff_paid');
    ok('backing module PAID => reason booking_paid_requires_staff', out.reason === 'booking_paid_requires_staff');
    ok('backing module PAID => no writes performed',
      pg.state.updates.length === 0 && pg.state.insertedGuests.length === 0);
  }

  // 5d. Backing module NO availability => no_availability, no mutation.
  {
    const pg = makeFakePg('pending');
    const out = await addGuestAttach.addGuestToBooking(pg, {
      clientSlug: 'wolfhouse-somo', bookingId: 'bk-1', newGuestNames: ['Tom'], env: ENABLED_ENV,
      availabilityChecker: availUnavailable,
    });
    ok('backing module no-availability => status no_availability', out.status === 'no_availability');
    ok('backing module no-availability => reason no_availability_for_added_guest',
      out.reason === 'no_availability_for_added_guest');
    ok('backing module no-availability => no writes performed',
      pg.state.updates.length === 0 && pg.state.insertedGuests.length === 0);
  }

  // ── 6. handoff policy ─────────────────────────────────────────────────────
  const unpaidCtx = { booking_code: 'WH-SAMPLE', payment_status: 'pending' };
  const paidCtx = { booking_code: 'WH-SAMPLE', payment_status: 'deposit_paid' };
  const addMsg = 'Sorry, please add 1 more person. Tom';

  const unpaidLane = classifyMessageLane(addMsg, unpaidCtx);
  ok('unpaid add-guest routes to add_service_request (handled)',
    unpaidLane.lane === 'add_service_request');
  ok('handoff policy does NOT escalate unpaid add-guest',
    handoffPolicy.shouldRequireStaffHandoff({
      message_lane: unpaidLane.lane, handoff_reasons: unpaidLane.reasons,
      message_text: addMsg, guest_context: unpaidCtx,
    }) === false);

  const paidLane = classifyMessageLane(addMsg, paidCtx);
  ok('paid add-guest routes to staff_handoff_required',
    paidLane.lane === 'staff_handoff_required');
  ok('handoff policy DOES escalate paid add-guest',
    handoffPolicy.shouldRequireStaffHandoff({
      message_lane: paidLane.lane, handoff_reasons: paidLane.reasons,
      message_text: addMsg, guest_context: paidCtx,
    }) === true);

  // ── 7. GPT planner prompt mentions add_guest_to_booking + ordering ─────────
  const prompt = buildWritePlannerSystemPrompt();
  ok('planner prompt lists add_guest_to_booking as allowed', /add_guest_to_booking/.test(prompt));
  ok('planner prompt orders add_guest_to_booking before create_payment_link',
    /add_guest_to_booking before create_payment_link/.test(prompt));
  ok('planner prompt notes PAID booking add-guest is a handoff',
    /PAID|deposit_paid/.test(prompt) && /add_guest_to_booking/.test(prompt));

  // ── 8. composer copy ──────────────────────────────────────────────────────
  const composed = composeLunaGuestReply({
    mode: 'live_staging',
    message_text: addMsg,
    payload: {
      result: {
        detected_language: 'en',
        message_lane: 'add_service_request',
        extracted_fields: { guest_count: 3, check_in: '2026-09-16', check_out: '2026-09-19' },
      },
    },
    live_outcomes: {
      addGuestWrite: { status: 'ok', result: { status: 'ok', added_guest_names: ['Tom'], new_total_amount_cents: 43500 } },
      stripeLink: { stripe_checkout_url: 'https://checkout.stripe.com/test_abc' },
    },
  });
  ok('composer resolves add_guest_to_booking_ack state',
    composed.composer_state === 'add_guest_to_booking_ack');
  ok('composer copy acknowledges the added person', /Tom/.test(composed.reply));
  ok('composer copy states the new total €435.00', /€435\.00/.test(composed.reply));
  ok('composer copy includes the refreshed pay-in-full link',
    /checkout\.stripe\.com\/test_abc/.test(composed.reply) && /pay in full/i.test(composed.reply));
  ok('composer copy uses no internal jargon',
    !/payment choice|quote_status|dry run|idempotency/i.test(composed.reply));

  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})();

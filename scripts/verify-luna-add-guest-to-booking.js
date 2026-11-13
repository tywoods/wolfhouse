'use strict';

/**
 * verify:luna-add-guest-to-booking — Slice 1 (UNPAID add-guest lane).
 *
 * Covers: tool registered & GPT-plannable; deterministic plan includes add_guest when
 * bookingId + intent present; readiness blocks paid (booking_paid_requires_staff) and
 * no-availability; readiness ready on unpaid+available; backing-module requote math
 * (2→3 guests on 16–19 Sep => +€149.50 => €449.50 on the sample €300 booking); handoff policy does NOT
 * escalate unpaid add-guest but DOES for paid; composer copy includes new total + link.
 *
 * No live sends. Fake pg stubs the planner/readiness cases. The save proof uses
 * PGlite: a real INSERT plus a separate SELECT of booking_guests.
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
const { resolveSeasonForDate, loadPricingConfig } = require('./lib/wolfhouse-pricing-resolve');

// Authoritative Malibu summer weekly is 29900¢. Default stay is 6 nights.
// 16–19 Sep is 3 nights: round(29900 * 3 / 6) = 14950¢ per added guest.
const SEP_ADDED_GUEST_CENTS = 14950;
const SAMPLE_BOOKING_CENTS = 30000;
const SAMPLE_NEW_TOTAL_CENTS = SAMPLE_BOOKING_CENTS + SEP_ADDED_GUEST_CENTS;

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
ok('raw JSON seasons have month_numbers only, so resolveSeasonForDate misses 2026-09-16', (() => {
  const pricing = loadPricingConfig();
  const september = (pricing.seasons || []).find((s) => (s.month_numbers || []).includes(9));
  return september && !Array.isArray(september.ranges)
    && resolveSeasonForDate(pricing.seasons, '2026-09-16') == null;
})());
ok('computeAccommodationDelta 2->3 guests on 16-19 Sep prices month_numbers => +€149.50', (() => {
  const d = addGuestAttach.computeAccommodationDelta({
    clientSlug: 'wolfhouse-somo', checkIn: '2026-09-16', checkOut: '2026-09-19',
    packageCode: 'no_package', roomType: 'shared',
  }, 2, 1);
  return d.ok === true
    && d.old_accommodation_cents === 29900
    && d.new_accommodation_cents === 44850
    && d.delta_cents === SEP_ADDED_GUEST_CENTS;
})());
ok('computeAccommodationDelta prices an explicit season range with no month_numbers', (() => {
  const pricing = loadPricingConfig();
  const d = addGuestAttach.computeAccommodationDelta({
    clientSlug: 'wolfhouse-somo', checkIn: '2026-09-16', checkOut: '2026-09-19',
    packageCode: 'no_package', roomType: 'shared',
    pricingConfig: {
      ...pricing,
      seasons: [{
        code: 'summer',
        priority: 0,
        bookable: true,
        ranges: [{ start_month: 9, start_day: 1, end_month: 9, end_day: 30 }],
      }],
    },
  }, 2, 1);
  return d.ok === true && d.delta_cents === SEP_ADDED_GUEST_CENTS;
})());
ok('month_numbers still cover a date when the same season also has a non-covering range', (() => {
  const pricing = loadPricingConfig();
  const d = addGuestAttach.computeAccommodationDelta({
    clientSlug: 'wolfhouse-somo', checkIn: '2026-09-16', checkOut: '2026-09-19',
    packageCode: 'no_package', roomType: 'shared',
    pricingConfig: {
      ...pricing,
      seasons: [{
        code: 'summer',
        priority: 0,
        bookable: true,
        month_numbers: [9],
        ranges: [{ start_month: 1, start_day: 1, end_month: 1, end_day: 31 }],
      }],
    },
  }, 2, 1);
  return d.ok === true && d.delta_cents === SEP_ADDED_GUEST_CENTS;
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
    ok('backing module new total = €449.50 (30000 + 14950)', out.new_total_amount_cents === SAMPLE_NEW_TOTAL_CENTS);
    ok('backing module guest_count 2 -> 3', out.new_guest_count === 3);
    ok('backing module appended guest name', out.guest_name === 'John, Jane, Tom');
    ok('backing module inserted 1 booking_guests row', pg.state.insertedGuests.length === 1);
    ok('backing module updated the booking once', pg.state.updates.length === 1);
    ok('backing module balance_due reflects new total', out.new_balance_due_cents === SAMPLE_NEW_TOTAL_CENTS);
    ok('backing module price is not flagged when the season resolves', out.price_needs_staff_review === false);
    ok('backing module refreshed pay-in-full draft to €449.50', pg.state.paymentDraftUpdates.length === 1 && Number(pg.state.paymentDraftUpdates[0][2]) === SAMPLE_NEW_TOTAL_CENTS);
    ok('backing module returns refreshed payment_draft_id for re-send', out.payment_draft_id === 'pay-draft-1');
    ok('backing module refreshed draft amount = new total', out.payment_draft_amount_due_cents === SAMPLE_NEW_TOTAL_CENTS);
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

  // ── 9. Real SQL (PGlite): unpaid insert + read-back, unresolvable price still saves ──
  let sqlDb = null;
  try {
    const { PGlite } = require('@electric-sql/pglite');
    sqlDb = new PGlite();
    const clientId = '00000000-0000-4000-8000-000000000001';
    const pricedBookingId = '00000000-0000-4000-8000-000000000021';
    const unpricedBookingId = '00000000-0000-4000-8000-000000000022';
    const draftId = '00000000-0000-4000-8000-000000000031';
    await sqlDb.exec(`
      CREATE TABLE clients (
        id uuid PRIMARY KEY,
        slug text NOT NULL UNIQUE
      );
      CREATE TABLE bookings (
        id uuid PRIMARY KEY,
        client_id uuid NOT NULL REFERENCES clients(id),
        booking_code text NOT NULL,
        guest_name text,
        guest_count integer NOT NULL,
        payment_status text NOT NULL,
        check_in date NOT NULL,
        check_out date NOT NULL,
        package_code text,
        total_amount_cents integer,
        amount_paid_cents integer,
        balance_due_cents integer,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE TABLE payments (
        id uuid PRIMARY KEY,
        booking_id uuid NOT NULL REFERENCES bookings(id),
        payment_kind text,
        status text,
        amount_due_cents integer,
        amount_paid_cents integer
      );
      CREATE TABLE booking_guests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id uuid NOT NULL REFERENCES clients(id),
        booking_id uuid NOT NULL REFERENCES bookings(id),
        guest_number integer NOT NULL CHECK (guest_number >= 1),
        guest_name text NOT NULL,
        assigned_room_code text,
        assigned_bed_code text,
        deposit_amount_cents integer NOT NULL DEFAULT 0,
        amount_paid_cents integer NOT NULL DEFAULT 0,
        payment_status text NOT NULL DEFAULT 'not_requested',
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        UNIQUE (booking_id, guest_number)
      );
    `);
    await sqlDb.query(
      `INSERT INTO clients (id, slug) VALUES ($1::uuid, 'wolfhouse-somo')`,
      [clientId],
    );
    await sqlDb.query(
      `INSERT INTO bookings (
         id, client_id, booking_code, guest_name, guest_count, payment_status,
         check_in, check_out, package_code, total_amount_cents, amount_paid_cents,
         balance_due_cents
       ) VALUES
       ($1::uuid, $3::uuid, 'WH-UNPAID', 'John, Jane', 2, 'pending',
        '2026-09-16', '2026-09-19', 'no_package', $4, 0, $4),
       ($2::uuid, $3::uuid, 'WH-UNPRICED', 'John, Jane', 2, 'pending',
        '2026-09-16', '2026-09-19', 'no_package', $4, 0, $4)`,
      [pricedBookingId, unpricedBookingId, clientId, SAMPLE_BOOKING_CENTS],
    );
    await sqlDb.query(
      `INSERT INTO payments (id, booking_id, payment_kind, status, amount_due_cents, amount_paid_cents)
       VALUES ($1::uuid, $2::uuid, 'full_amount', 'draft', $3, 0)`,
      [draftId, pricedBookingId, SAMPLE_BOOKING_CENTS],
    );
    const availAvailable = async () => ({ available: true, status: 'available', detail: {} });
    const priced = await addGuestAttach.addGuestToBooking(sqlDb, {
      clientSlug: 'wolfhouse-somo',
      bookingId: pricedBookingId,
      newGuestNames: ['Tom'],
      env: ENABLED_ENV,
      availabilityChecker: availAvailable,
    });
    const pricedGuest = await sqlDb.query(
      `SELECT guest_number, guest_name, payment_status::text AS payment_status
         FROM booking_guests WHERE booking_id = $1::uuid`,
      [pricedBookingId],
    );
    const pricedBooking = await sqlDb.query(
      `SELECT guest_count, guest_name, total_amount_cents, balance_due_cents, metadata
         FROM bookings WHERE id = $1::uuid`,
      [pricedBookingId],
    );
    const pricedDraft = await sqlDb.query(
      `SELECT amount_due_cents FROM payments WHERE id = $1::uuid`,
      [draftId],
    );
    const pricedMeta = pricedBooking.rows[0] && pricedBooking.rows[0].metadata;
    const pricedMetaObj = typeof pricedMeta === 'string' ? JSON.parse(pricedMeta) : (pricedMeta || {});
    ok('PGlite unpaid add status ok and price not flagged',
      priced.status === 'ok' && priced.price_needs_staff_review === false);
    ok('PGlite unpaid SELECT reads the inserted booking_guests row',
      pricedGuest.rows.length === 1
      && pricedGuest.rows[0].guest_name === 'Tom'
      && Number(pricedGuest.rows[0].guest_number) === 3
      && pricedGuest.rows[0].payment_status === 'not_requested');
    ok('PGlite unpaid booking row updated to 3 guests and the priced total',
      Number(pricedBooking.rows[0].guest_count) === 3
      && pricedBooking.rows[0].guest_name === 'John, Jane, Tom'
      && Number(pricedBooking.rows[0].total_amount_cents) === SAMPLE_NEW_TOTAL_CENTS
      && Number(pricedBooking.rows[0].balance_due_cents) === SAMPLE_NEW_TOTAL_CENTS
      && pricedMetaObj.add_guest_price_needs_staff_review !== true);
    ok('PGlite unpaid draft amount read back as the new total',
      Number(pricedDraft.rows[0].amount_due_cents) === SAMPLE_NEW_TOTAL_CENTS);

    const pricing = loadPricingConfig();
    const unpriced = await addGuestAttach.addGuestToBooking(sqlDb, {
      clientSlug: 'wolfhouse-somo',
      bookingId: unpricedBookingId,
      newGuestNames: ['Tom'],
      env: ENABLED_ENV,
      availabilityChecker: availAvailable,
      pricingConfig: {
        ...pricing,
        seasons: [{ code: 'january_only', month_numbers: [1], priority: 0, bookable: true }],
      },
    });
    const unpricedGuest = await sqlDb.query(
      `SELECT guest_name, guest_number, metadata FROM booking_guests WHERE booking_id = $1::uuid`,
      [unpricedBookingId],
    );
    const unpricedBooking = await sqlDb.query(
      `SELECT guest_count, guest_name, total_amount_cents, balance_due_cents, metadata
         FROM bookings WHERE id = $1::uuid`,
      [unpricedBookingId],
    );
    const guestMeta = unpricedGuest.rows[0] && unpricedGuest.rows[0].metadata;
    const bookingMeta = unpricedBooking.rows[0] && unpricedBooking.rows[0].metadata;
    const asMeta = (meta) => (typeof meta === 'string' ? JSON.parse(meta) : (meta || {}));
    ok('PGlite unpriced September still saves instead of requote_failed',
      unpriced.status === 'ok'
      && unpriced.price_needs_staff_review === true
      && /no authoritative Pricing season covers 2026-09-16/.test(String(unpriced.price_review_reason))
      && unpriced.accommodation_delta_cents == null);
    ok('PGlite unpriced SELECT reads Tom on booking_guests',
      unpricedGuest.rows.length === 1
      && unpricedGuest.rows[0].guest_name === 'Tom'
      && Number(unpricedGuest.rows[0].guest_number) === 3);
    ok('PGlite unpriced booking keeps the old total and flags staff review',
      Number(unpricedBooking.rows[0].guest_count) === 3
      && unpricedBooking.rows[0].guest_name === 'John, Jane, Tom'
      && Number(unpricedBooking.rows[0].total_amount_cents) === SAMPLE_BOOKING_CENTS
      && Number(unpricedBooking.rows[0].balance_due_cents) === SAMPLE_BOOKING_CENTS
      && asMeta(bookingMeta).add_guest_price_needs_staff_review === true
      && asMeta(guestMeta).add_guest_price_needs_staff_review === true);
  } catch (err) {
    ok(`PGlite unpaid add-guest SQL proof (${err && err.message ? err.message : err})`, false);
  } finally {
    if (sqlDb) await sqlDb.close();
  }

  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})();

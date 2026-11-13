'use strict';

/**
 * verify:luna-add-guest-paid — Slice 2 (PAID add-guest top-up lane).
 *
 * Gated behind LUNA_GUEST_ADD_GUEST_PAID_ENABLED. Covers:
 *   - flag OFF + paid → readiness blocks booking_paid_requires_staff, router hands off,
 *     backing returns handoff_paid (Slice 1 preserved).
 *   - flag ON + paid + available → backing status ok, paid_topup:true,
 *     topup_amount_cents = 14950 (€149.50) for the 2→3 guest €300→€449.50 sample with €300 paid;
 *     booking updated once; guest row inserted; NO full_amount draft refresh.
 *   - create_balance_payment_link registered & plannable; deterministic paid plan is
 *     add_guest_to_booking then create_balance_payment_link (NOT create_payment_link);
 *     unpaid still uses create_payment_link.
 *   - balance link charges the delta (€135), not €435 or €300.
 *   - handoff policy: flag ON paid add-guest does NOT escalate; flag OFF paid DOES.
 *   - composer paid top-up copy: added person, €135 top-up, a link, no jargon, and does
 *     not claim the whole booking is unpaid.
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

console.log('\nverify-luna-add-guest-paid.js\n');

const toolPlan = require('./lib/luna-guest-agent-tool-plan');
const executor = require('./lib/luna-guest-agent-write-tool-executor');
const addGuestAttach = require('./lib/luna-guest-addguest-attach');
const handoffPolicy = require('./lib/luna-guest-handoff-policy');
const balanceLink = require('./lib/luna-guest-balance-payment-link-create');
const { classifyMessageLane } = require('./lib/luna-guest-message-router');
const { buildWritePlannerSystemPrompt } = require('./lib/luna-guest-gpt-write-tool-planner');
const { composeLunaGuestReply } = require('./lib/luna-guest-reply-composer');
const { loadPricingConfig } = require('./lib/wolfhouse-pricing-resolve');

// Same authoritative September share as the unpaid verifier: round(29900 * 3 / 6).
const SEP_ADDED_GUEST_CENTS = 14950;
const SAMPLE_BOOKING_CENTS = 30000;
const SAMPLE_NEW_TOTAL_CENTS = SAMPLE_BOOKING_CENTS + SEP_ADDED_GUEST_CENTS;

const WRITES_ON = { OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true' };
const PAID_ON = { OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true', LUNA_GUEST_ADD_GUEST_PAID_ENABLED: 'true' };

const chainWithFields = {
  result: { extracted_fields: { add_guest_request: ['Tom'], check_in: '2026-09-16', check_out: '2026-09-19' } },
};

// ── 1. flag helper ─────────────────────────────────────────────────────────
ok('isAddGuestPaidEnabled true when flag=true',
  addGuestAttach.isAddGuestPaidEnabled({ LUNA_GUEST_ADD_GUEST_PAID_ENABLED: 'true' }) === true);
ok('isAddGuestPaidEnabled false by default (flag off)',
  addGuestAttach.isAddGuestPaidEnabled({}) === false);

// ── 2. create_balance_payment_link registered & plannable ──────────────────
ok('create_balance_payment_link registered in GUEST_AGENT_TOOLS',
  !!toolPlan.GUEST_AGENT_TOOLS.create_balance_payment_link);
ok('create_balance_payment_link is a gated write tool',
  toolPlan.GUEST_AGENT_TOOLS.create_balance_payment_link
  && toolPlan.GUEST_AGENT_TOOLS.create_balance_payment_link.read_or_write === 'write'
  && toolPlan.GUEST_AGENT_TOOLS.create_balance_payment_link.safety_gate_required === true);
ok('create_balance_payment_link is GPT-plannable',
  toolPlan.isGuestAgentGptPlannableWriteTool('create_balance_payment_link'));
ok('add_guest_to_booking ordered before create_balance_payment_link in plannable ids', (() => {
  const ids = toolPlan.GUEST_AGENT_GPT_PLANNABLE_WRITE_TOOL_IDS;
  return ids.indexOf('add_guest_to_booking') >= 0
    && ids.indexOf('add_guest_to_booking') < ids.indexOf('create_balance_payment_link');
})());

// ── 3. deterministic plan (paid vs unpaid) ─────────────────────────────────
ok('deterministic PAID+flagOn plan: add_guest then create_balance_payment_link (not create_payment_link)', (() => {
  const plan = executor.buildDeterministicWriteToolPlan(chainWithFields, {
    booking_id: 'bk-paid-1', payment_status: 'deposit_paid', env: PAID_ON,
  });
  const ids = plan.map((t) => t.tool_id);
  return ids.includes('add_guest_to_booking')
    && ids.includes('create_balance_payment_link')
    && !ids.includes('create_payment_link')
    && ids.indexOf('add_guest_to_booking') < ids.indexOf('create_balance_payment_link');
})());
ok('deterministic PAID+flagOff plan: omits add_guest_to_booking (Slice 1 handoff)', (() => {
  const plan = executor.buildDeterministicWriteToolPlan(chainWithFields, {
    booking_id: 'bk-paid-1', payment_status: 'deposit_paid', env: WRITES_ON,
  });
  return !plan.map((t) => t.tool_id).includes('add_guest_to_booking');
})());
ok('deterministic UNPAID plan still uses create_payment_link (not balance link)', (() => {
  const plan = executor.buildDeterministicWriteToolPlan(chainWithFields, {
    booking_id: 'bk-unpaid-1', payment_status: 'pending', env: PAID_ON,
  });
  const ids = plan.map((t) => t.tool_id);
  return ids.includes('add_guest_to_booking')
    && ids.includes('create_payment_link')
    && !ids.includes('create_balance_payment_link');
})());

// ── 4. readiness gating (flag on vs off, paid) ─────────────────────────────
ok('readiness BLOCKS paid add-guest with flag OFF (booking_paid_requires_staff)', (() => {
  const r = executor.evaluateWriteToolReadiness('add_guest_to_booking', chainWithFields, {
    booking_id: 'bk-paid-1', payment_status: 'deposit_paid', pg: {}, env: WRITES_ON,
  });
  return r.ready === false && r.block_reasons.includes('booking_paid_requires_staff');
})());
ok('readiness READY on paid add-guest with flag ON', (() => {
  const r = executor.evaluateWriteToolReadiness('add_guest_to_booking', chainWithFields, {
    booking_id: 'bk-paid-1', payment_status: 'deposit_paid', pg: {}, env: PAID_ON,
  });
  return r.ready === true && r.block_reasons.length === 0;
})());
ok('create_balance_payment_link readiness BLOCKS without booking id', (() => {
  const r = executor.evaluateWriteToolReadiness('create_balance_payment_link',
    { result: { extracted_fields: {} } }, { pg: {}, env: PAID_ON });
  return r.ready === false && r.block_reasons.includes('booking_id_missing');
})());

// ── 5. backing module: fake pg (mirrors Slice-1 verifier style) ────────────
function makeFakePg(paymentStatus, opts) {
  const o = opts || {};
  const state = { updates: [], insertedGuests: [], paymentDraftUpdates: [] };
  const pg = {
    state,
    async query(sql, params) {
      const s = String(sql);
      if (/FROM clients WHERE slug/i.test(s)) return { rows: [{ id: 'client-uuid-1' }] };
      if (/FROM bookings b/i.test(s) && /SELECT/i.test(s) && !/UPDATE/i.test(s)) {
        return {
          rows: [{
            booking_id: 'bk-1', booking_code: 'WH-SAMPLE', client_id: 'client-uuid-1',
            guest_count: 2, guest_name: 'John, Jane',
            total_amount_cents: 30000, amount_paid_cents: 30000, balance_due_cents: 0,
            payment_status: paymentStatus,
            check_in: '2026-09-16', check_out: '2026-09-19',
            package_code: 'no_package', metadata: {},
          }],
        };
      }
      if (/UPDATE bookings/i.test(s)) { state.updates.push(params); return { rows: [], rowCount: 1 }; }
      if (/UPDATE payments/i.test(s)) {
        state.paymentDraftUpdates.push(params);
        return { rows: [{ payment_draft_id: 'pay-draft-1', amount_due_cents: params[2] }], rowCount: 1 };
      }
      if (/INSERT INTO booking_guests/i.test(s)) {
        state.insertedGuests.push(params);
        return { rows: [{ booking_guest_id: `bg-${state.insertedGuests.length}`, guest_number: params[2], guest_name: params[3], payment_status: 'not_requested' }] };
      }
      if (/booking_holds|beds|inventory|availability|room|bed/i.test(s)) {
        return { rows: o.noBeds ? [] : [{ bed_code: 'B1' }, { bed_code: 'B2' }, { bed_code: 'B3' }, { bed_code: 'B4' }] };
      }
      return { rows: [] };
    },
  };
  return pg;
}

(async () => {
  const availAvailable = async () => ({ available: true, status: 'available', detail: {} });

  // 5a. flag ON + paid + available → status ok, paid_topup, €135 top-up, no draft refresh.
  {
    const pg = makeFakePg('deposit_paid');
    const out = await addGuestAttach.addGuestToBooking(pg, {
      clientSlug: 'wolfhouse-somo', bookingId: 'bk-1', newGuestNames: ['Tom'], env: PAID_ON,
      availabilityChecker: availAvailable,
    });
    ok('flagON paid add => status ok', out.status === 'ok');
    ok('flagON paid add => paid_topup true', out.paid_topup === true);
    ok('flagON paid add => topup_amount_cents = 14950 (€149.50)', out.topup_amount_cents === SEP_ADDED_GUEST_CENTS);
    ok('flagON paid add => new total = €449.50 (30000 + 14950)', out.new_total_amount_cents === SAMPLE_NEW_TOTAL_CENTS);
    ok('flagON paid add => new balance_due = €149.50 (delta only)', out.new_balance_due_cents === SEP_ADDED_GUEST_CENTS);
    ok('flagON paid add => price is not flagged when the season resolves', out.price_needs_staff_review === false);
    ok('flagON paid add => amount already paid preserved (€300)', out.amount_paid_cents === 30000);
    ok('flagON paid add => guest_count 2 -> 3', out.new_guest_count === 3);
    ok('flagON paid add => appended guest name', out.guest_name === 'John, Jane, Tom');
    ok('flagON paid add => inserted 1 booking_guests row', pg.state.insertedGuests.length === 1);
    ok('flagON paid add => booking updated once', pg.state.updates.length === 1);
    ok('flagON paid add => NO full_amount draft refresh (paymentDraftUpdates empty)',
      pg.state.paymentDraftUpdates.length === 0);
    ok('flagON paid add => no payment_draft_id threaded', out.payment_draft_id === null);
  }

  // 5b. flag OFF + paid → handoff_paid, no mutation (Slice 1 preserved).
  {
    const pg = makeFakePg('deposit_paid');
    const out = await addGuestAttach.addGuestToBooking(pg, {
      clientSlug: 'wolfhouse-somo', bookingId: 'bk-1', newGuestNames: ['Tom'], env: WRITES_ON,
      availabilityChecker: availAvailable,
    });
    ok('flagOFF paid add => status handoff_paid', out.status === 'handoff_paid');
    ok('flagOFF paid add => reason booking_paid_requires_staff', out.reason === 'booking_paid_requires_staff');
    ok('flagOFF paid add => no writes performed',
      pg.state.updates.length === 0 && pg.state.insertedGuests.length === 0);
  }

  // ── 6. balance link charges the delta (€135), not €435 or €300 ────────────
  ok('computeBookingBalanceDueCents on €435 booking w/ €300 paid => €135 delta', (() => {
    const amount = balanceLink.computeBookingBalanceDueCents(
      { total_amount_cents: 43500 },
      [],
      [{ payment_status: 'paid', amount_paid_cents: 30000 }],
    );
    return amount === 13500;
  })());
  {
    // Full balance-link creator against a fake pg (bookings + service records + payments),
    // stubbing the Stripe SDK. Asserts the created line item amount is the €135 delta.
    let capturedAmount = null;
    const fakePg = {
      async query(sql, params) {
        const s = String(sql);
        if (/FROM bookings b/i.test(s) && /JOIN clients/i.test(s)) {
          return { rows: [{
            booking_id: 'bk-1', booking_code: 'WH-SAMPLE', guest_name: 'John, Jane',
            check_in: '2026-09-16', check_out: '2026-09-19',
            booking_status: 'confirmed', payment_status: 'deposit_paid',
            total_amount_cents: 43500, amount_paid_cents: 30000, balance_due_cents: 13500,
            client_id: 'client-uuid-1', client_slug: 'wolfhouse-somo',
          }] };
        }
        if (/FROM booking_service_records/i.test(s)) return { rows: [] };
        if (/FROM payments/i.test(s) && /SELECT/i.test(s)) {
          return { rows: [{ payment_id: 'p-1', payment_status: 'paid', payment_kind: 'deposit', amount_due_cents: 30000, amount_paid_cents: 30000, checkout_url: null, metadata: {} }] };
        }
        if (/INSERT INTO payments/i.test(s)) {
          capturedAmount = Number(params[2]);
          return { rows: [{ payment_id: 'p-new' }] };
        }
        if (/UPDATE payments/i.test(s)) return { rows: [], rowCount: 1 };
        return { rows: [] };
      },
    };
    const fakeStripeSession = { id: 'cs_test_1', url: 'https://checkout.stripe.com/test_delta', expires_at: null, livemode: false };
    const RealModule = require('module');
    const origLoad = RealModule._load;
    RealModule._load = function patched(request, parent, isMain) {
      if (request === 'stripe') {
        return () => ({ checkout: { sessions: { create: async (args) => { capturedAmount = capturedAmount || (args.line_items && args.line_items[0].price_data.unit_amount); return fakeStripeSession; } } } });
      }
      return origLoad.apply(this, arguments);
    };
    const balEnv = {
      STAFF_ACTIONS_ENABLED: 'true',
      STRIPE_LINKS_ENABLED: 'true',
      STRIPE_SECRET_KEY: 'sk_test_fake',
      LUNA_TEST_RESET_ENABLED: 'true',
      STRIPE_CHECKOUT_SUCCESS_URL: 'https://example.test/ok',
      STRIPE_CHECKOUT_CANCEL_URL: 'https://example.test/cancel',
    };
    let out;
    try {
      out = await balanceLink.runGuestBalancePaymentLinkCreateApproved(
        { booking_id: '11111111-1111-4111-8111-111111111121', client_slug: 'wolfhouse-somo' },
        { confirm_balance_payment_link: true, env: balEnv, pg: fakePg, host_header: 'localhost' },
      );
    } finally {
      RealModule._load = origLoad;
    }
    ok('balance link creator computes the €135 delta (not €435 or €300)',
      out && Number(out.amount_due_cents) === 13500 && capturedAmount === 13500);
    ok('balance link creator does NOT charge the full new total (€435)', capturedAmount !== 43500);
    ok('balance link creator does NOT charge the already-paid amount (€300)', capturedAmount !== 30000);
  }

  // ── 7. router + handoff policy (flag on vs off) ───────────────────────────
  const addMsg = 'Sorry, please add 1 more person. Tom';
  const paidCtxFlagOn = { booking_code: 'WH-SAMPLE', payment_status: 'deposit_paid', env: PAID_ON };
  const paidCtxFlagOff = { booking_code: 'WH-SAMPLE', payment_status: 'deposit_paid', env: WRITES_ON };

  const laneOn = classifyMessageLane(addMsg, paidCtxFlagOn);
  ok('flagON paid add-guest routes to add_service_request (handled, no handoff)',
    laneOn.lane === 'add_service_request');
  ok('handoff policy does NOT escalate flagON paid add-guest',
    handoffPolicy.shouldRequireStaffHandoff({
      message_lane: laneOn.lane, handoff_reasons: laneOn.reasons,
      message_text: addMsg, guest_context: paidCtxFlagOn,
    }) === false);

  const laneOff = classifyMessageLane(addMsg, paidCtxFlagOff);
  ok('flagOFF paid add-guest routes to staff_handoff_required',
    laneOff.lane === 'staff_handoff_required');
  ok('handoff policy DOES escalate flagOFF paid add-guest',
    handoffPolicy.shouldRequireStaffHandoff({
      message_lane: laneOff.lane, handoff_reasons: laneOff.reasons,
      message_text: addMsg, guest_context: paidCtxFlagOff,
    }) === true);

  // ── 8. GPT planner prompt mentions the paid top-up ordering ───────────────
  const prompt = buildWritePlannerSystemPrompt();
  ok('planner prompt lists create_balance_payment_link', /create_balance_payment_link/.test(prompt));
  ok('planner prompt orders add_guest_to_booking before create_balance_payment_link',
    /add_guest_to_booking before create_payment_link and before create_balance_payment_link/.test(prompt));
  ok('planner prompt ties paid add-guest to add_guest_paid_enabled',
    /add_guest_paid_enabled/.test(prompt));

  // ── 9. composer paid top-up copy ──────────────────────────────────────────
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
      addGuestWrite: {
        status: 'ok',
        result: { status: 'ok', paid_topup: true, added_guest_names: ['Tom'], topup_amount_cents: 13500, new_total_amount_cents: 43500 },
      },
      balanceStripeLink: { stripe_checkout_url: 'https://checkout.stripe.com/test_delta' },
    },
  });
  ok('composer resolves add_guest_to_booking_ack state (paid top-up)',
    composed.composer_state === 'add_guest_to_booking_ack');
  ok('composer paid copy acknowledges the added person', /Tom/.test(composed.reply));
  ok('composer paid copy states the €135 top-up', /€135\.00/.test(composed.reply));
  ok('composer paid copy includes a link', /checkout\.stripe\.com\/test_delta/.test(composed.reply));
  ok('composer paid copy makes clear existing payment stands',
    /existing payment|stays as it is|share to add/i.test(composed.reply));
  ok('composer paid copy does NOT claim whole booking is unpaid / pay-in-full',
    !/pay in full/i.test(composed.reply) && !/new total/i.test(composed.reply));
  ok('composer paid copy uses no internal jargon',
    !/payment choice|quote_status|dry run|idempotency|paid_topup|top-?up_amount_cents/i.test(composed.reply));

  // ── 9b. deposit_paid: the amount due (€335) exceeds the new guest's share (€135), so the
  // copy must state the person's true share AND the total to settle — never call €335 "just
  // their share". Guards against misleading a paying guest.
  const composedDeposit = composeLunaGuestReply({
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
      addGuestWrite: {
        status: 'ok',
        result: {
          status: 'ok', paid_topup: true, added_guest_names: ['Tom'],
          topup_amount_cents: 33500, accommodation_delta_cents: 13500, new_total_amount_cents: 43500,
        },
      },
      balanceStripeLink: { stripe_checkout_url: 'https://checkout.stripe.com/test_deposit' },
    },
  });
  ok('composer deposit_paid states the new guest true share €135', /€135\.00/.test(composedDeposit.reply));
  ok('composer deposit_paid states the total due to settle €335', /€335\.00/.test(composedDeposit.reply));
  ok('composer deposit_paid does NOT mislabel €335 as just their share',
    !/just their share/i.test(composedDeposit.reply));
  ok('composer deposit_paid includes the settle link', /checkout\.stripe\.com\/test_deposit/.test(composedDeposit.reply));

  // ── 10. Real SQL (PGlite): paid insert + read-back, unresolvable price still saves ──
  let sqlDb = null;
  try {
    const { PGlite } = require('@electric-sql/pglite');
    sqlDb = new PGlite();
    const clientId = '00000000-0000-4000-8000-000000000001';
    const pricedBookingId = '00000000-0000-4000-8000-000000000041';
    const unpricedBookingId = '00000000-0000-4000-8000-000000000042';
    const paidDraftId = '00000000-0000-4000-8000-000000000051';
    const unpricedDraftId = '00000000-0000-4000-8000-000000000052';
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
       ($1::uuid, $3::uuid, 'WH-PAID', 'John, Jane', 2, 'deposit_paid',
        '2026-09-16', '2026-09-19', 'no_package', $4, $4, 0),
       ($2::uuid, $3::uuid, 'WH-PAID-UNPRICED', 'John, Jane', 2, 'deposit_paid',
        '2026-09-16', '2026-09-19', 'no_package', $4, $4, 0)`,
      [pricedBookingId, unpricedBookingId, clientId, SAMPLE_BOOKING_CENTS],
    );
    await sqlDb.query(
      `INSERT INTO payments (id, booking_id, payment_kind, status, amount_due_cents, amount_paid_cents)
       VALUES
       ($1::uuid, $3::uuid, 'full_amount', 'paid', $5, $5),
       ($2::uuid, $4::uuid, 'full_amount', 'paid', $5, $5)`,
      [paidDraftId, unpricedDraftId, pricedBookingId, unpricedBookingId, SAMPLE_BOOKING_CENTS],
    );
    const availAvailable = async () => ({ available: true, status: 'available', detail: {} });
    const priced = await addGuestAttach.addGuestToBooking(sqlDb, {
      clientSlug: 'wolfhouse-somo',
      bookingId: pricedBookingId,
      newGuestNames: ['Tom'],
      env: PAID_ON,
      availabilityChecker: availAvailable,
    });
    const pricedGuest = await sqlDb.query(
      `SELECT guest_number, guest_name, payment_status::text AS payment_status
         FROM booking_guests WHERE booking_id = $1::uuid`,
      [pricedBookingId],
    );
    const pricedBooking = await sqlDb.query(
      `SELECT guest_count, guest_name, total_amount_cents, balance_due_cents, amount_paid_cents, metadata
         FROM bookings WHERE id = $1::uuid`,
      [pricedBookingId],
    );
    const pricedDraft = await sqlDb.query(
      `SELECT amount_due_cents, amount_paid_cents, status FROM payments WHERE id = $1::uuid`,
      [paidDraftId],
    );
    ok('PGlite paid add status ok, paid_topup, price not flagged',
      priced.status === 'ok'
      && priced.paid_topup === true
      && priced.price_needs_staff_review === false
      && priced.topup_amount_cents === SEP_ADDED_GUEST_CENTS);
    ok('PGlite paid SELECT reads the inserted booking_guests row',
      pricedGuest.rows.length === 1
      && pricedGuest.rows[0].guest_name === 'Tom'
      && Number(pricedGuest.rows[0].guest_number) === 3
      && pricedGuest.rows[0].payment_status === 'not_requested');
    ok('PGlite paid booking row charges only the new guest share',
      Number(pricedBooking.rows[0].guest_count) === 3
      && pricedBooking.rows[0].guest_name === 'John, Jane, Tom'
      && Number(pricedBooking.rows[0].total_amount_cents) === SAMPLE_NEW_TOTAL_CENTS
      && Number(pricedBooking.rows[0].balance_due_cents) === SEP_ADDED_GUEST_CENTS
      && Number(pricedBooking.rows[0].amount_paid_cents) === SAMPLE_BOOKING_CENTS);
    ok('PGlite paid path does not refresh the already-paid draft',
      Number(pricedDraft.rows[0].amount_due_cents) === SAMPLE_BOOKING_CENTS
      && Number(pricedDraft.rows[0].amount_paid_cents) === SAMPLE_BOOKING_CENTS
      && String(pricedDraft.rows[0].status) === 'paid');

    const pricing = loadPricingConfig();
    const unpriced = await addGuestAttach.addGuestToBooking(sqlDb, {
      clientSlug: 'wolfhouse-somo',
      bookingId: unpricedBookingId,
      newGuestNames: ['Tom'],
      env: PAID_ON,
      availabilityChecker: availAvailable,
      pricingConfig: {
        ...pricing,
        seasons: [{
          code: 'january_only',
          priority: 0,
          bookable: true,
          ranges: [{ start_month: 1, start_day: 1, end_month: 1, end_day: 31 }],
        }],
      },
    });
    const unpricedGuest = await sqlDb.query(
      `SELECT guest_name, guest_number, metadata FROM booking_guests WHERE booking_id = $1::uuid`,
      [unpricedBookingId],
    );
    const unpricedBooking = await sqlDb.query(
      `SELECT guest_count, total_amount_cents, balance_due_cents, metadata
         FROM bookings WHERE id = $1::uuid`,
      [unpricedBookingId],
    );
    const unpricedDraft = await sqlDb.query(
      `SELECT amount_due_cents FROM payments WHERE id = $1::uuid`,
      [unpricedDraftId],
    );
    const asMeta = (meta) => (typeof meta === 'string' ? JSON.parse(meta) : (meta || {}));
    const guestMeta = unpricedGuest.rows[0] && unpricedGuest.rows[0].metadata;
    const bookingMeta = unpricedBooking.rows[0] && unpricedBooking.rows[0].metadata;
    ok('PGlite paid unpriced September still saves instead of requote_failed',
      unpriced.status === 'ok'
      && unpriced.paid_topup === true
      && unpriced.price_needs_staff_review === true
      && unpriced.topup_amount_cents == null
      && /no authoritative Pricing season covers 2026-09-16/.test(String(unpriced.price_review_reason)));
    ok('PGlite paid unpriced SELECT reads Tom on booking_guests',
      unpricedGuest.rows.length === 1
      && unpricedGuest.rows[0].guest_name === 'Tom'
      && Number(unpricedGuest.rows[0].guest_number) === 3);
    ok('PGlite paid unpriced booking keeps money and flags staff review',
      Number(unpricedBooking.rows[0].guest_count) === 3
      && Number(unpricedBooking.rows[0].total_amount_cents) === SAMPLE_BOOKING_CENTS
      && Number(unpricedBooking.rows[0].balance_due_cents) === 0
      && asMeta(bookingMeta).add_guest_price_needs_staff_review === true
      && asMeta(guestMeta).add_guest_price_needs_staff_review === true
      && Number(unpricedDraft.rows[0].amount_due_cents) === SAMPLE_BOOKING_CENTS);
  } catch (err) {
    ok(`PGlite paid add-guest SQL proof (${err && err.message ? err.message : err})`, false);
  } finally {
    if (sqlDb) await sqlDb.close();
  }

  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})();

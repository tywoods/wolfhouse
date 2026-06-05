/**
 * Phase 13c / 13e — Luna guest booking write bridge (dry-run → eligibility → gated create).
 *
 * Reuses runLunaGuestBookingDryRun + evaluateLunaBookingWriteEligibility.
 * Delegates to existing POST /staff/bot/bookings/create body shape via context.invokeCreate.
 * Default-deny: no invoke unless write_ready and all gates pass.
 *
 * @module luna-guest-booking-write-bridge
 */

'use strict';

const { runLunaGuestBookingDryRun } = require('./luna-guest-booking-dry-run');
const {
  evaluateLunaBookingWriteEligibility,
  WRITE_ROUTE,
} = require('./luna-guest-booking-write-eligibility');

const BRIDGE_ROUTE = 'POST /staff/bot/booking-create-from-plan';

const BRIDGE_SAFETY_FLAGS = Object.freeze({
  creates_stripe_link: false,
  sends_whatsapp:      false,
  calls_n8n:           false,
});

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

/**
 * Map dry-run plan + input to handleBotBookingCreate request body (Stage 8.5.4).
 *
 * @param {object} dryRunPlan
 * @param {object} input
 * @returns {object}
 */
function buildBotBookingCreatePayload(dryRunPlan, input) {
  const plan = dryRunPlan || {};
  const src  = input || {};
  const avail = plan.availability || {};

  const phone = trimStr(plan.guest_phone) || trimStr(plan.phone)
    || trimStr(src.guest_phone) || trimStr(src.phone) || trimStr(src.from);

  const paymentChoice = trimStr(src.payment_choice).toLowerCase();

  return {
    client_slug:        trimStr(plan.client_slug) || trimStr(src.client_slug) || 'wolfhouse-somo',
    check_in:           trimStr(avail.check_in) || trimStr(src.check_in),
    check_out:          trimStr(avail.check_out) || trimStr(src.check_out),
    guest_name:         trimStr(src.guest_name),
    phone,
    email:              src.email != null ? trimStr(src.email) || null : null,
    language:           trimStr(plan.language) || trimStr(src.language) || 'en',
    guest_count:        avail.guest_count != null ? Number(avail.guest_count) : Number(src.guest_count),
    package_code:       trimStr(src.package_code).toLowerCase(),
    room_type:          trimStr(avail.room_type) || trimStr(src.room_type) || 'shared',
    add_ons:            Array.isArray(src.add_ons) ? src.add_ons : [],
    payment_choice:     paymentChoice,
    confirm:            true,
    idempotency_key:    trimStr(src.idempotency_key),
    selected_bed_codes: Array.isArray(avail.selected_bed_codes)
      ? avail.selected_bed_codes.slice()
      : [],
    source:             trimStr(src.source) || 'luna_dry_run_write',
    reason:             trimStr(src.reason) || 'Luna gated write via booking-create-from-plan',
    notes:              src.notes != null ? trimStr(src.notes) || null : null,
    conversation_id:    src.conversation_id != null ? trimStr(src.conversation_id) || null : null,
  };
}

function formatBridgeDenied(dryRun, eligibility) {
  return Object.assign({}, BRIDGE_SAFETY_FLAGS, {
    success:             false,
    write_performed:     false,
    dry_run:             dryRun,
    eligibility,
    blocked_reasons:     eligibility.blocked_reasons || [],
    required_approvals:  eligibility.required_approvals || [],
    safe_next_step:      eligibility.safe_next_step || 'keep_dry_run',
    would_call:          [],
    creates_booking:     false,
    creates_payment:     false,
    bridge_route:        BRIDGE_ROUTE,
    target_create_route: WRITE_ROUTE,
  });
}

function resolveBridgePhone(input) {
  const src = input || {};
  return trimStr(src.guest_phone) || trimStr(src.phone) || trimStr(src.from);
}

/**
 * Read-only lookup: bookings.metadata->>'idempotency_key' per client (Stage 8.3f interim).
 *
 * @param {object} input
 * @param {object} pg
 * @returns {Promise<object|null>}
 */
async function lookupIdempotentBookingReplay(input, pg) {
  if (!pg || typeof pg.query !== 'function') return null;

  const key = trimStr((input || {}).idempotency_key);
  if (!key) return null;

  const clientSlug = trimStr((input || {}).client_slug) || 'wolfhouse-somo';
  const phone = resolveBridgePhone(input);
  const checkIn = trimStr((input || {}).check_in);
  const checkOut = trimStr((input || {}).check_out);

  const bookingRes = await pg.query(
    `SELECT b.id::text AS booking_id,
            b.booking_code,
            b.guest_name,
            b.phone,
            b.check_in::text AS check_in,
            b.check_out::text AS check_out,
            b.guest_count,
            b.status::text AS status,
            c.slug AS client_slug
     FROM bookings b
     INNER JOIN clients c ON c.id = b.client_id
     WHERE c.slug = $1
       AND b.metadata->>'idempotency_key' = $2
       AND b.status::text NOT IN ('cancelled', 'expired')
     ORDER BY b.created_at DESC
     LIMIT 1`,
    [clientSlug, key],
  );

  if (!bookingRes.rows || bookingRes.rows.length === 0) return null;

  const booking = bookingRes.rows[0];
  const conflicts = [];

  if (phone && booking.phone && phone !== booking.phone) {
    conflicts.push('idempotency_phone_mismatch');
  }
  if (checkIn && booking.check_in && checkIn !== booking.check_in) {
    conflicts.push('idempotency_dates_mismatch');
  }
  if (checkOut && booking.check_out && checkOut !== booking.check_out) {
    conflicts.push('idempotency_dates_mismatch');
  }

  const payRes = await pg.query(
    `SELECT p.id::text AS payment_id,
            p.status::text,
            p.payment_kind::text,
            p.amount_due_cents,
            p.checkout_url,
            p.stripe_checkout_session_id
     FROM payments p
     WHERE p.booking_id = $1::uuid
     ORDER BY p.created_at ASC`,
    [booking.booking_id],
  );

  return {
    booking,
    payments: payRes.rows || [],
    conflicts,
  };
}

function formatIdempotencyConflict(replay) {
  const b = replay.booking || {};
  return Object.assign({}, BRIDGE_SAFETY_FLAGS, {
    success:               false,
    write_performed:       false,
    idempotent_replay:     false,
    blocked_reasons:       replay.conflicts && replay.conflicts.length
      ? replay.conflicts.slice()
      : ['idempotency_context_conflict'],
    required_approvals:    [],
    would_call:            [],
    safe_next_step:        'handoff_to_staff',
    existing_booking_id:   b.booking_id || null,
    existing_booking_code: b.booking_code || null,
    creates_booking:       false,
    creates_payment:       false,
    bridge_route:          BRIDGE_ROUTE,
    target_create_route:   WRITE_ROUTE,
  });
}

function formatIdempotentReplay(replay) {
  const b = replay.booking || {};
  const pay = (replay.payments && replay.payments[0]) || null;

  return Object.assign({}, BRIDGE_SAFETY_FLAGS, {
    success:               true,
    write_performed:       false,
    idempotent_replay:     true,
    duplicate:             true,
    idempotent:            true,
    booking_id:            b.booking_id || null,
    booking_code:          b.booking_code || null,
    payment_id:            pay ? pay.payment_id : null,
    payment_summary:       pay ? {
      payment_id:       pay.payment_id,
      status:           pay.status,
      payment_kind:     pay.payment_kind,
      amount_due_cents: pay.amount_due_cents,
      has_checkout_url: !!(pay.checkout_url || pay.stripe_checkout_session_id),
    } : null,
    blocked_reasons:       [],
    required_approvals:    [],
    would_call:            [],
    safe_next_step:        'booking_already_created',
    creates_booking:       false,
    creates_payment:       false,
    bridge_route:          BRIDGE_ROUTE,
    target_create_route:   WRITE_ROUTE,
  });
}

/**
 * Run Luna guest booking write bridge (default-deny).
 *
 * @param {object} input - guest booking fields + confirm + idempotency_key
 * @param {object} [context] - { pg, env, invokeCreate }
 * @returns {Promise<object>}
 */
async function runLunaGuestBookingWriteBridge(input, context) {
  const ctx = context || {};
  const env = ctx.env || process.env;
  const pg  = ctx.pg != null ? ctx.pg : null;
  const src = input || {};

  // Phase 13e — idempotency-first replay before dry-run availability.
  if (trimStr(src.idempotency_key) && pg) {
    const replay = await lookupIdempotentBookingReplay(src, pg);
    if (replay) {
      if (replay.conflicts.length > 0) return formatIdempotencyConflict(replay);
      return formatIdempotentReplay(replay);
    }
  }

  const dryRun = await runLunaGuestBookingDryRun(src, { pg });
  const eligibility = evaluateLunaBookingWriteEligibility(dryRun, input || {}, env);

  if (eligibility.write_ready !== true) {
    return formatBridgeDenied(dryRun, eligibility);
  }

  // Belt-and-suspenders before any invoke (default-deny).
  if (env.BOT_BOOKING_ENABLED !== 'true') {
    return formatBridgeDenied(dryRun, Object.assign({}, eligibility, {
      write_ready: false,
      required_approvals: [...new Set([...(eligibility.required_approvals || []), 'BOT_BOOKING_ENABLED'])],
    }));
  }
  if ((input || {}).confirm !== true) {
    return formatBridgeDenied(dryRun, Object.assign({}, eligibility, {
      write_ready: false,
      required_approvals: [...new Set([...(eligibility.required_approvals || []), 'confirm_true'])],
    }));
  }
  if (!trimStr((input || {}).idempotency_key)) {
    return formatBridgeDenied(dryRun, Object.assign({}, eligibility, {
      write_ready: false,
      required_approvals: [...new Set([...(eligibility.required_approvals || []), 'idempotency_key'])],
    }));
  }

  const createPayload = buildBotBookingCreatePayload(dryRun, input);

  if (typeof ctx.invokeCreate !== 'function') {
    return Object.assign({}, BRIDGE_SAFETY_FLAGS, {
      success:             false,
      write_performed:     false,
      write_ready:         true,
      dry_run:             dryRun,
      eligibility,
      create_payload:      createPayload,
      blocked_reasons:     ['invoke_create_not_configured'],
      required_approvals:  [],
      safe_next_step:      'booking_create_gated',
      would_call:          [WRITE_ROUTE],
      creates_booking:     false,
      creates_payment:     false,
      bridge_route:        BRIDGE_ROUTE,
      target_create_route: WRITE_ROUTE,
    });
  }

  const createOutcome = await ctx.invokeCreate(createPayload, {
    dryRun,
    eligibility,
    input: input || {},
  });

  const writePerformed = !!(createOutcome && createOutcome.write_performed === true);

  return Object.assign({}, BRIDGE_SAFETY_FLAGS, {
    success:             writePerformed,
    write_performed:     writePerformed,
    dry_run:             dryRun,
    eligibility,
    create_payload:      createPayload,
    create_outcome:      createOutcome || null,
    blocked_reasons:     writePerformed ? [] : (createOutcome && createOutcome.blocked_reasons) || [],
    required_approvals:  [],
    safe_next_step:      writePerformed ? 'booking_created' : 'booking_create_gated',
    would_call:          [WRITE_ROUTE],
    creates_booking:     false,
    creates_payment:     false,
    bridge_route:        BRIDGE_ROUTE,
    target_create_route: WRITE_ROUTE,
  });
}

module.exports = {
  runLunaGuestBookingWriteBridge,
  buildBotBookingCreatePayload,
  lookupIdempotentBookingReplay,
  BRIDGE_ROUTE,
  BOT_CREATE_ROUTE: WRITE_ROUTE,
  BRIDGE_SAFETY_FLAGS,
};

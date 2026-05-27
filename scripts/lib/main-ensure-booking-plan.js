/**
 * Phase 3c.c.4 — Ensure Booking promote plan (read-only).
 */
const { selectBookingCodeGuard, resolveClientId } = require('./main-booking-hold-pg-sql');
const {
  BLOCKED_STATUSES,
  PROMOTE_TARGET,
  parseEnsureInput,
} = require('./main-ensure-booking-pg-sql');

function classifyEnsureAction(codeGuard) {
  if (!codeGuard.exists) {
    return {
      action: 'would_insert',
      would_promote: false,
      would_create: true,
      note: 'No row; execute would INSERT payment_pending / waiting_payment',
    };
  }

  const ex = codeGuard.existing;
  if (BLOCKED_STATUSES.includes(ex.status)) {
    return {
      action: 'would_block',
      would_promote: false,
      would_create: false,
      note: `Status ${ex.status} is blocked for promote`,
    };
  }

  if (ex.status === 'hold') {
    return {
      action: 'would_promote',
      would_promote: true,
      would_create: false,
      note: 'Would UPDATE hold → payment_pending / waiting_payment',
    };
  }

  if (ex.status === 'payment_pending') {
    return {
      action: 'would_refresh',
      would_promote: false,
      would_create: false,
      idempotent: true,
      note: 'Would refresh fields only; already payment_pending',
    };
  }

  return {
    action: 'would_review',
    would_promote: false,
    would_create: false,
    note: `Status ${ex.status} — manual review before promote`,
  };
}

/**
 * @param {import('pg').Client} client
 * @param {ReturnType<typeof parseEnsureInput>} input
 */
async function buildEnsureBookingPlan(client, input) {
  if (!input.booking_code) {
    return { error: 'missing_booking_code', parsed_input: input };
  }
  if (!input.check_in || !input.check_out) {
    return { error: 'missing_dates', parsed_input: input };
  }

  const clientRes = await resolveClientId(client, input.client_slug);
  if (clientRes.error) {
    return { error: clientRes.error, parsed_input: input };
  }

  const codeGuard = await selectBookingCodeGuard(client, clientRes.client_id, input.booking_code);
  if (codeGuard.error) {
    return { error: codeGuard.error, parsed_input: input };
  }

  const planned = classifyEnsureAction(codeGuard);
  const actionable = [];
  const warnings = [];

  if (planned.action === 'would_block') {
    actionable.push('blocked_status');
    warnings.push(planned.note);
  }

  const plan_allowed = planned.action !== 'would_block';

  return {
    parsed_input: input,
    target_status: PROMOTE_TARGET,
    booking_code_guard: { ...codeGuard, planned_action: planned },
    would_ensure_booking: plan_allowed
      ? {
          booking_code: input.booking_code,
          guest_name: input.guest_name,
          phone: input.phone,
          email: input.email,
          check_in: input.check_in,
          check_out: input.check_out,
          guest_count: input.guest_count,
          package_code: input.package_code,
          requested_room_type: input.requested_room_type,
          room_preference: input.room_preference,
          guest_gender_group_type: input.guest_gender_group_type,
          airtable_record_id_if_null: input.airtable_record_id,
        }
      : null,
    plan_allowed,
    warnings,
    actionable,
    read_only: true,
    no_mutations: true,
    payments_untouched: { policy: 'No payments or payment_events' },
    booking_beds_untouched: { policy: 'No booking_beds' },
    send_confirmation_untouched: { policy: 'Never set send_confirmation in promote' },
  };
}

module.exports = {
  buildEnsureBookingPlan,
  parseEnsureInput,
  classifyEnsureAction,
};

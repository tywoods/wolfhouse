/**
 * Phase 3c.c.1 — Main hold upsert plan (read-only).
 */
const { parseSessionInput, runMainAvailabilityReport } = require('./main-availability-pg-sql');
const {
  parseHoldInput,
  proposeHoldExpiresAt,
  proposeStatuses,
  resolveClientId,
  selectActiveHoldGuard,
  selectBookingCodeGuard,
  classifyBookingCodeAction,
  FUTURE_SQL,
} = require('./main-booking-hold-pg-sql');

function buildWouldUpsertBooking(holdInput, statusProposal, holdExpiresAt) {
  return {
    client_slug: holdInput.client_slug,
    booking_code: holdInput.booking_code,
    phone: holdInput.phone,
    guest_name: holdInput.guest_name,
    email: holdInput.email,
    check_in: holdInput.check_in,
    check_out: holdInput.check_out,
    guest_count: holdInput.guest_count,
    requested_room_type: holdInput.room_type,
    room_preference: holdInput.room_preference,
    guest_gender_group_type: holdInput.guest_gender_group_type,
    primary_room_code: holdInput.primary_room_code,
    package_code: holdInput.package_code,
    booking_source: 'whatsapp',
    hold_expires_at: holdExpiresAt,
    send_confirmation: false,
    metadata_notes: holdInput.notes,
    has_guest_details: holdInput.has_guest_details,
  };
}

function buildDownstreamContract(holdInput, codeGuard, statusProposal) {
  return {
    booking_code: holdInput.booking_code,
    booking_code_used_by: [
      'Create Booking Hold (Airtable Booking ID field)',
      'Postgres - Ensure Booking In Postgres ($1 booking_code)',
      'Code - Prepare Stripe Payment Context.fields[Booking ID]',
      'Conversation Current Hold ID (string, 3c.d)',
    ],
    booking_id_uuid: codeGuard.existing?.booking_id || null,
    booking_id_note:
      'UUID exists only if row already in PG; execute phase would RETURNING id on INSERT',
    ensure_booking_promote:
      statusProposal.proposed_status === 'payment_pending'
        ? 'Ensure Booking would UPDATE or INSERT payment_pending / waiting_payment'
        : 'Ensure Booking runs later on Stripe path after AT mirror',
    stripe_create_payment_session:
      'Requires booking_id UUID from PG — unchanged Phase 2b contract',
    future_sql: FUTURE_SQL,
  };
}

/**
 * @param {import('pg').Client} client
 * @param {ReturnType<typeof parseHoldInput>} holdInput
 */
async function buildMainHoldPlan(client, holdInput) {
  if (!holdInput.booking_code) {
    return { error: 'missing_booking_code', parsed_input: holdInput };
  }
  if (!holdInput.check_in || !holdInput.check_out) {
    return { error: 'missing_dates', parsed_input: holdInput };
  }
  if (holdInput.check_out <= holdInput.check_in) {
    return {
      error: 'invalid_date_range',
      parsed_input: holdInput,
      check_in: holdInput.check_in,
      check_out: holdInput.check_out,
    };
  }

  const clientRes = await resolveClientId(client, holdInput.client_slug);
  if (clientRes.error) {
    return { error: clientRes.error, parsed_input: holdInput, client_slug: holdInput.client_slug };
  }
  const { client_id: clientId } = clientRes;

  const availabilityInput = parseSessionInput({
    client_slug: holdInput.client_slug,
    check_in: holdInput.check_in,
    check_out: holdInput.check_out,
    guest_count: holdInput.guest_count,
    room_type: holdInput.room_type,
    room_preference: holdInput.room_preference,
    guest_gender_group_type: holdInput.guest_gender_group_type,
  });

  const availability = await runMainAvailabilityReport(client, availabilityInput);
  if (availability.error) {
    return { error: availability.error, parsed_input: holdInput, availability_summary: availability };
  }

  const availabilitySummary = {
    availability_found: availability.availability_found,
    candidate_rooms_count: availability.candidate_rooms?.length ?? 0,
    available_beds_count: availability.available_beds?.length ?? 0,
    blocked_beds_count: availability.blocked_beds?.length ?? 0,
    overlap_conflicts_count: availability.overlap_conflicts?.length ?? 0,
    recommended_room_or_beds: availability.recommended_room_or_beds,
    primary_room_code_from_report:
      availability.recommended_room_or_beds?.room_code || null,
  };

  if (!holdInput.primary_room_code && availabilitySummary.primary_room_code_from_report) {
    holdInput.primary_room_code = availabilitySummary.primary_room_code_from_report;
  }

  const activeHoldGuard = await selectActiveHoldGuard(client, clientId, holdInput);
  const codeGuardRaw = await selectBookingCodeGuard(client, clientId, holdInput.booking_code);
  if (codeGuardRaw.error) {
    return {
      error: codeGuardRaw.error,
      parsed_input: holdInput,
      availability_summary: availabilitySummary,
      active_hold_guard: activeHoldGuard,
    };
  }

  const statusProposal = proposeStatuses(holdInput);
  const holdExpiresAt = proposeHoldExpiresAt();
  const codeAction = classifyBookingCodeAction(codeGuardRaw, holdInput, statusProposal);

  const bookingCodeGuard = {
    ...codeGuardRaw,
    planned_action: codeAction,
  };

  const wouldUpsertBooking = buildWouldUpsertBooking(holdInput, statusProposal, holdExpiresAt);

  const warnings = [...(availability.warnings || [])];
  const actionable = [];

  if (!availability.availability_found) {
    actionable.push('no_availability');
    warnings.push('availability_found=false: hold plan blocked');
  }
  if (activeHoldGuard.would_block_new_hold) {
    actionable.push('active_hold_exists');
    warnings.push(
      `active_hold_guard: ${activeHoldGuard.other_active_holds.length} other hold(s) for phone`
    );
  }
  if (codeAction.action === 'would_conflict') {
    actionable.push('booking_code_conflict');
    warnings.push(`booking_code_guard: ${codeAction.note}`);
  }

  const canProceed =
    availability.availability_found &&
    !activeHoldGuard.would_block_new_hold &&
    codeAction.action !== 'would_conflict';

  return {
    parsed_input: holdInput,
    availability_summary: availabilitySummary,
    active_hold_guard: activeHoldGuard,
    booking_code_guard: bookingCodeGuard,
    would_upsert_booking: canProceed ? wouldUpsertBooking : null,
    proposed_status: statusProposal.proposed_status,
    proposed_payment_status: statusProposal.proposed_payment_status,
    proposed_assignment_status: statusProposal.proposed_assignment_status,
    proposed_availability_check_status: statusProposal.proposed_availability_check_status,
    proposed_hold_expires_at: holdExpiresAt,
    status_reason: statusProposal.status_reason,
    airtable_record_id_plan: {
      initial: null,
      after_airtable_mirror:
        'UPDATE bookings SET airtable_record_id = rec… after Create Booking Hold (3c.e)',
      current_in_pg: codeGuardRaw.existing?.airtable_record_id || null,
    },
    downstream_contract: buildDownstreamContract(holdInput, codeGuardRaw, statusProposal),
    plan_allowed: canProceed,
    warnings,
    actionable,
    read_only: true,
    no_mutations: true,
    payments_untouched: {
      policy: 'No read or write on payments or payment_events in 3c.c.1',
    },
    booking_beds_untouched: {
      policy: 'No booking_beds writes on hold create',
    },
  };
}

module.exports = {
  buildMainHoldPlan,
  parseHoldInput,
};

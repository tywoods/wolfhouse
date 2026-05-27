/**
 * Phase 3b.5a — Operator Room Release impact plan (read-only, SELECT-only).
 * Mirrors hosted split logic from Wolfhouse - Operator Room Release.json.
 */
const fs = require('fs');
const { assignmentNaturalKey, toIsoDateString } = require('./bed-drift-keys');

const INPUT_SURFACE_RECOMMENDATION = {
  mvp: 'n8n_form_direct_payload',
  summary:
    'Use n8n Form or CLI flags posting operator, room_code, release_start, release_end to webhook/this report. Do not require Airtable Operator Room Release Request rows.',
  deprecated: 'airtable_record_id_lookup',
  airtable_record_id_status: 'deferred — not implemented in 3b.5a; use direct payload fields',
};

const ROOM_MATCH_RULE = {
  id: 'pg_room_match_v1',
  description:
    'Match operator whole-room bookings by room_code using primary_room_code first, then room_to_block_id→rooms.room_code, then any booking_beds.room_code on the candidate booking.',
  prefer: 'bookings.primary_room_code = room_code (from CSV Room ID via db:sync)',
  fallbacks: ['rooms.room_code via bookings.room_to_block_id', 'booking_beds.room_code on same booking'],
  not_used_alone: 'airtable_linked_room_to_block_id (often unset in PG after db:sync)',
};

const OPERATOR_MATCH_RULE = {
  id: 'operator_name_trimmed_exact',
  description: 'Trim whitespace on input and PG operator_name; compare with SQL trim() equality (case-sensitive).',
  case_normalization_risk:
    'Hosted Airtable uses strict === ; PG/AT spelling or casing differences will yield match_count=0 until normalized in a later phase.',
};

function normalizeRoomCode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase();
}

function normalizeOperatorName(raw) {
  return String(raw || '').trim();
}

function datesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function makeProvisionalBookingCode(suffix) {
  const today = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  const random = Math.floor(1000 + Math.random() * 9000);
  return `WH-${today}-${suffix}-${random}`;
}

function parseOperatorRoomReleaseInput(argv) {
  const input = {
    clientSlug: 'wolfhouse-somo',
    operator: null,
    roomCode: null,
    releaseStart: null,
    releaseEnd: null,
    requestCode: null,
    notes: null,
    releaseRecordId: null,
    jsonFile: null,
    parsedFrom: 'cli_flags',
    explicitFields: new Set(),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      input.showHelp = true;
      continue;
    }
    const set = (key, val) => {
      input[key] = val;
      input.explicitFields.add(key);
    };
    if (arg.startsWith('--operator=')) set('operator', normalizeOperatorName(arg.slice(11)));
    else if (arg === '--operator' && argv[i + 1]) set('operator', normalizeOperatorName(argv[++i]));
    else if (arg.startsWith('--room-code=')) set('roomCode', normalizeRoomCode(arg.slice(12)));
    else if (arg === '--room-code' && argv[i + 1]) set('roomCode', normalizeRoomCode(argv[++i]));
    else if (arg.startsWith('--release-start=')) set('releaseStart', toIsoDateString(arg.slice(16)));
    else if (arg === '--release-start' && argv[i + 1]) set('releaseStart', toIsoDateString(argv[++i]));
    else if (arg.startsWith('--release-end=')) set('releaseEnd', toIsoDateString(arg.slice(14)));
    else if (arg === '--release-end' && argv[i + 1]) set('releaseEnd', toIsoDateString(argv[++i]));
    else if (arg.startsWith('--client=')) set('clientSlug', arg.slice(9).trim());
    else if (arg.startsWith('--request-code=')) set('requestCode', arg.slice(15).trim());
    else if (arg.startsWith('--notes=')) set('notes', arg.slice(8).trim());
    else if (arg.startsWith('--release-record-id=')) {
      set('releaseRecordId', arg.slice(20).trim());
      input.parsedFrom = 'cli_with_deprecated_at_id';
    } else if (arg.startsWith('--json-file=')) {
      set('jsonFile', arg.slice(12).trim());
      input.parsedFrom = 'json_file';
    } else if (arg === '--json-file' && argv[i + 1]) {
      set('jsonFile', argv[++i].trim());
      input.parsedFrom = 'json_file';
    }
  }

  if (input.jsonFile) {
    const raw = JSON.parse(fs.readFileSync(input.jsonFile, 'utf8'));
    const body = raw.body || raw;
    if (body.operator != null) input.operator = normalizeOperatorName(body.operator);
    if (body.room_code != null) input.roomCode = normalizeRoomCode(body.room_code);
    if (body['Room to Release'] != null) input.roomCode = normalizeRoomCode(body['Room to Release']);
    if (body.release_start != null) input.releaseStart = toIsoDateString(body.release_start);
    if (body['Release Start Date'] != null) input.releaseStart = toIsoDateString(body['Release Start Date']);
    if (body.release_end != null) input.releaseEnd = toIsoDateString(body.release_end);
    if (body['Release End Date'] != null) input.releaseEnd = toIsoDateString(body['Release End Date']);
    if (body.client_slug != null) input.clientSlug = String(body.client_slug).trim();
    if (body.request_code != null) input.requestCode = String(body.request_code).trim();
    if (body.notes != null) input.notes = String(body.notes).trim();
    if (body.record_id != null) input.releaseRecordId = String(body.record_id).trim();
  }

  return input;
}

function validateInput(input) {
  const missing = [];
  if (!input.operator) missing.push('operator');
  if (!input.roomCode) missing.push('room_code');
  if (!input.releaseStart) missing.push('release_start');
  if (!input.releaseEnd) missing.push('release_end');

  const invalidDateRange =
    input.releaseStart &&
    input.releaseEnd &&
    input.releaseStart >= input.releaseEnd;

  return { missing, invalidDateRange };
}

function computeSplit(originalCheckIn, originalCheckOut, releaseStart, releaseEnd) {
  const shouldCreateA = originalCheckIn < releaseStart;
  const shouldCreateB = releaseEnd < originalCheckOut;
  const splitNote = `Operator released room from ${releaseStart} to ${releaseEnd}. Original block split.`;

  const blockA = shouldCreateA
    ? {
        provisional_booking_code: makeProvisionalBookingCode('A'),
        check_in: originalCheckIn,
        check_out: releaseStart,
        booking_source: 'operator',
        block_type: 'whole_room',
        assignment_status: 'unassigned',
        status: 'confirmed',
        payment_status: 'not_requested',
        beds_assigned_in_release_workflow: false,
      }
    : null;

  const blockB = shouldCreateB
    ? {
        provisional_booking_code: makeProvisionalBookingCode('B'),
        check_in: releaseEnd,
        check_out: originalCheckOut,
        booking_source: 'operator',
        block_type: 'whole_room',
        assignment_status: 'unassigned',
        status: 'confirmed',
        payment_status: 'not_requested',
        beds_assigned_in_release_workflow: false,
      }
    : null;

  return {
    should_create_a: shouldCreateA,
    should_create_b: shouldCreateB,
    block_a: blockA,
    block_b: blockB,
    split_note: splitNote,
    release_fully_covers_block: !shouldCreateA && !shouldCreateB,
  };
}

async function findOperatorBookingCandidates(client, clientId, input) {
  const operator = normalizeOperatorName(input.operator);
  const roomCode = normalizeRoomCode(input.roomCode);
  const releaseStart = input.releaseStart;
  const releaseEnd = input.releaseEnd;

  const { rows } = await client.query(
    `SELECT DISTINCT ON (b.id)
       b.id,
       b.booking_code,
       b.airtable_record_id,
       b.guest_name,
       b.operator_name,
       b.primary_room_code,
       b.room_to_block_id,
       r.room_code AS room_to_block_room_code,
       b.status::text AS status,
       b.payment_status::text AS payment_status,
       b.assignment_status::text AS assignment_status,
       b.availability_check_status::text AS availability_check_status,
       b.check_in::text AS check_in,
       b.check_out::text AS check_out,
       b.guest_count,
       b.booking_source::text AS booking_source,
       b.block_type::text AS block_type,
       b.staff_notes,
       CASE
         WHEN upper(trim(coalesce(b.primary_room_code, ''))) = $3 THEN 'primary_room_code'
         WHEN upper(trim(coalesce(r.room_code, ''))) = $3 THEN 'room_to_block_id'
         WHEN EXISTS (
           SELECT 1 FROM booking_beds bb
           WHERE bb.booking_id = b.id AND bb.client_id = b.client_id
             AND upper(trim(bb.room_code)) = $3
         ) THEN 'booking_beds.room_code'
         ELSE 'unknown'
       END AS room_match_reason
     FROM bookings b
     LEFT JOIN rooms r ON r.id = b.room_to_block_id AND r.client_id = b.client_id
     WHERE b.client_id = $1
       AND b.booking_source = 'operator'
       AND b.block_type = 'whole_room'
       AND b.status NOT IN ('cancelled', 'expired')
       AND trim(coalesce(b.operator_name, '')) = $2
       AND (
         upper(trim(coalesce(b.primary_room_code, ''))) = $3
         OR upper(trim(coalesce(r.room_code, ''))) = $3
         OR EXISTS (
           SELECT 1 FROM booking_beds bb
           WHERE bb.booking_id = b.id AND bb.client_id = b.client_id
             AND upper(trim(bb.room_code)) = $3
         )
       )
       AND b.check_in < $5::date
       AND $4::date < b.check_out
     ORDER BY b.id, b.check_in`,
    [clientId, operator, roomCode, releaseStart, releaseEnd]
  );

  return rows.map((row) => ({
    booking_id: row.id,
    booking_code: row.booking_code,
    airtable_record_id: row.airtable_record_id,
    operator_name: row.operator_name,
    primary_room_code: row.primary_room_code,
    room_to_block_room_code: row.room_to_block_room_code,
    room_match_reason: row.room_match_reason,
    check_in: toIsoDateString(row.check_in),
    check_out: toIsoDateString(row.check_out),
    status: row.status,
    assignment_status: row.assignment_status,
    guest_name: row.guest_name,
    booking_source: row.booking_source,
    block_type: row.block_type,
  }));
}

async function loadBookingBeds(client, clientId, bookingId, bookingCode) {
  const { rows } = await client.query(
    `SELECT
       bb.id AS booking_bed_id,
       bb.bed_code,
       bb.room_code,
       bb.assignment_start_date::text AS assignment_start_date,
       bb.assignment_end_date::text AS assignment_end_date,
       bb.assignment_type
     FROM booking_beds bb
     WHERE bb.client_id = $1 AND bb.booking_id = $2
     ORDER BY bb.bed_code, bb.assignment_start_date`,
    [clientId, bookingId]
  );

  return rows.map((row) => {
    const bedCode = String(row.bed_code || '').trim().toUpperCase();
    const startIso = toIsoDateString(row.assignment_start_date);
    const endIso = toIsoDateString(row.assignment_end_date);
    return {
      booking_bed_id: row.booking_bed_id,
      bed_code: bedCode,
      room_code: row.room_code,
      assignment_start_date: startIso,
      assignment_end_date: endIso,
      natural_key: assignmentNaturalKey(bookingCode, bedCode, startIso, endIso),
      assignment_type: row.assignment_type,
      would_remove_in_pg_3b5b: true,
      hosted_airtable_effect: 'Status Cancelled on Booking Beds row (not DELETE)',
    };
  });
}

async function loadOverlapConflicts(client, clientId, roomCode, releaseStart, releaseEnd, excludeBookingId) {
  const { rows } = await client.query(
    `SELECT
       bb.id::text AS booking_bed_id,
       bb.bed_code,
       bb.room_code,
       bb.assignment_start_date::text AS assignment_start_date,
       bb.assignment_end_date::text AS assignment_end_date,
       b.booking_code,
       b.booking_source::text AS booking_source,
       b.status::text AS booking_status
     FROM booking_beds bb
     INNER JOIN bookings b ON b.id = bb.booking_id AND b.client_id = bb.client_id
     WHERE bb.client_id = $1
       AND upper(trim(bb.room_code)) = $2
       AND bb.booking_id <> $3
       AND bb.assignment_start_date < $5::date
       AND bb.assignment_end_date > $4::date
       AND b.status NOT IN ('cancelled', 'expired')
     ORDER BY b.booking_code, bb.bed_code`,
    [clientId, roomCode, excludeBookingId, releaseStart, releaseEnd]
  );

  return rows.map((o) => ({
    bed_code: o.bed_code,
    room_code: o.room_code,
    release_window: { start: releaseStart, end: releaseEnd },
    conflicting_booking_code: o.booking_code,
    conflicting_booking_source: o.booking_source,
    conflicting_booking_status: o.booking_status,
    conflicting_dates: {
      start: toIsoDateString(o.assignment_start_date),
      end: toIsoDateString(o.assignment_end_date),
    },
  }));
}

async function loadPaymentsReadOnly(client, clientId, bookingId) {
  const { rows: payments } = await client.query(
    `SELECT id::text AS id, status::text AS status, payment_kind::text AS payment_kind,
            amount_due_cents, amount_paid_cents, created_at::text AS created_at
     FROM payments WHERE client_id = $1 AND booking_id = $2 ORDER BY created_at`,
    [clientId, bookingId]
  );
  const { rows: peCount } = await client.query(
    `SELECT COUNT(*)::int AS c
     FROM payment_events pe
     INNER JOIN payments p ON p.id = pe.payment_id
     WHERE p.client_id = $1 AND p.booking_id = $2`,
    [clientId, bookingId]
  );
  return { payments, payment_events_count: peCount[0]?.c ?? 0 };
}

async function loadOperatorRoomReleaseImpactPlan(client, input) {
  const warnings = [];
  const actionable = [];
  const hostedParityNotes = [
    'Hosted workflow uses Airtable Get Release Request by record_id — deprecated for MVP; direct payload preferred.',
    'Hosted export has no IF found_match gate before Cancel Original Operator Booking — local 3b.5c must add gate.',
    'Hosted cancels Booking Beds via Status=Cancelled; 3b.5b PG mirror likely DELETE booking_beds (decision deferred to 3b.5b).',
    'New Block A/B bookings are Unassigned with no beds; Assign automation may run downstream.',
  ];

  if (input.releaseRecordId) {
    warnings.push(
      `release_record_id=${input.releaseRecordId} provided but Airtable lookup is deferred in 3b.5a; use direct payload fields`
    );
  }

  const validation = validateInput(input);
  if (validation.missing.length) {
    return {
      error: 'missing_required_fields',
      validation,
      warnings,
      actionable: ['missing_required_fields'],
    };
  }
  if (validation.invalidDateRange) {
    return {
      error: 'invalid_date_range',
      validation: { ...validation, message: 'release_end must be after release_start' },
      warnings,
      actionable: ['invalid_date_range'],
    };
  }

  const { rows: clientRows } = await client.query(`SELECT id FROM clients WHERE slug = $1`, [
    input.clientSlug,
  ]);
  if (!clientRows.length) {
    return { error: 'client_not_found', client_slug: input.clientSlug, warnings, actionable: [] };
  }
  const clientId = clientRows[0].id;

  const { rows: roomRows } = await client.query(
    `SELECT id, room_code FROM rooms WHERE client_id = $1 AND upper(trim(room_code)) = $2 LIMIT 1`,
    [clientId, input.roomCode]
  );
  if (!roomRows.length) {
    return {
      error: 'room_not_found',
      room_code: input.roomCode,
      client_slug: input.clientSlug,
      warnings,
      actionable: ['room_not_found'],
    };
  }

  const candidates = await findOperatorBookingCandidates(client, clientId, input);
  const matchCount = candidates.length;
  const foundMatch = matchCount === 1;

  let errorNotes = null;
  if (matchCount === 0) errorNotes = 'No matching operator room block found.';
  if (matchCount > 1) errorNotes = 'Multiple matching operator room blocks found.';

  const matchPhase = {
    found_match: foundMatch,
    match_count: matchCount,
    candidates,
    error_notes: errorNotes,
    room_match_rule: ROOM_MATCH_RULE,
    operator_match_rule: OPERATOR_MATCH_RULE,
  };

  if (matchCount === 0) actionable.push('no_matching_operator_booking');
  if (matchCount > 1) actionable.push('ambiguous_operator_booking_match');

  let cancelPhase = null;
  let splitPhase = null;
  let createBlocksPhase = null;
  let overlapConflicts = [];
  let paymentsUntouched = {
    policy: 'No INSERT/UPDATE/DELETE on payments or payment_events in 3b.5a or proposed 3b.5b release path',
    payments_count: 0,
    payment_events_count: 0,
    payments: [],
  };

  if (foundMatch) {
    const matched = candidates[0];
    const { rows: fullBooking } = await client.query(
      `SELECT
         id, booking_code, airtable_record_id, guest_name, operator_name,
         primary_room_code, status::text AS status, payment_status::text AS payment_status,
         assignment_status::text AS assignment_status,
         availability_check_status::text AS availability_check_status,
         check_in::text AS check_in, check_out::text AS check_out,
         guest_count, booking_source::text AS booking_source, block_type::text AS block_type,
         staff_notes
       FROM bookings WHERE id = $1`,
      [matched.booking_id]
    );
    const booking = fullBooking[0];
    const originalCheckIn = toIsoDateString(booking.check_in);
    const originalCheckOut = toIsoDateString(booking.check_out);

    if (
      !datesOverlap(originalCheckIn, originalCheckOut, input.releaseStart, input.releaseEnd)
    ) {
      actionable.push('release_window_does_not_overlap_original_block');
      warnings.push('Release dates do not overlap original booking check_in/check_out');
    }

    const beds = await loadBookingBeds(
      client,
      clientId,
      matched.booking_id,
      booking.booking_code
    );
    if (!beds.length) {
      warnings.push('original_booking_has_no_booking_beds_in_pg');
    }

    cancelPhase = {
      original_booking_preview: {
        booking_id: booking.id,
        booking_code: booking.booking_code,
        airtable_record_id: booking.airtable_record_id,
        operator_name: booking.operator_name,
        primary_room_code: booking.primary_room_code,
        check_in: originalCheckIn,
        check_out: originalCheckOut,
        status: booking.status,
        assignment_status: booking.assignment_status,
        room_match_reason: matched.room_match_reason,
      },
      booking_beds_affected: beds,
      booking_fields_would_change_if_executed: {
        status: { from: booking.status, to: 'cancelled' },
        assignment_status: { from: booking.assignment_status, to: 'needs_review' },
        staff_notes: {
          from: booking.staff_notes,
          append: true,
          note: 'Operator release split note would be appended',
        },
        payment_status: { from: booking.payment_status, to: booking.payment_status, unchanged: true },
      },
      pg_3b5b_bed_effect: 'DELETE all booking_beds for original booking (proposed; differs from hosted AT Status Cancelled)',
    };

    splitPhase = computeSplit(
      originalCheckIn,
      originalCheckOut,
      input.releaseStart,
      input.releaseEnd
    );
    splitPhase.original_booking_code = booking.booking_code;
    splitPhase.original_dates = { check_in: originalCheckIn, check_out: originalCheckOut };
    splitPhase.release_window = { start: input.releaseStart, end: input.releaseEnd };

    const newBlocks = [];
    if (splitPhase.block_a) {
      newBlocks.push({
        ...splitPhase.block_a,
        operator_name: input.operator,
        room_code: input.roomCode,
        guest_name: input.operator,
      });
    }
    if (splitPhase.block_b) {
      newBlocks.push({
        ...splitPhase.block_b,
        operator_name: input.operator,
        room_code: input.roomCode,
        guest_name: input.operator,
      });
    }

    createBlocksPhase = {
      new_booking_count: newBlocks.length,
      new_booking_previews: newBlocks,
      beds_assigned_in_release_workflow: false,
      assign_webhook_note:
        'Bed assignment expected via separate Assign Beds workflow/automation after blocks are created',
    };

    overlapConflicts = await loadOverlapConflicts(
      client,
      clientId,
      input.roomCode,
      input.releaseStart,
      input.releaseEnd,
      matched.booking_id
    );
    if (overlapConflicts.length) actionable.push('postgres_overlap_conflicts_in_release_window');

    const pay = await loadPaymentsReadOnly(client, clientId, matched.booking_id);
    paymentsUntouched = {
      policy:
        'No INSERT/UPDATE/DELETE on payments or payment_events; new operator blocks would use payment_status not_requested only on bookings row',
      payments_count: pay.payments.length,
      payment_events_count: pay.payment_events_count,
      payments: pay.payments,
      new_blocks_touch_payments_table: false,
    };
  }

  return {
    client_id: clientId,
    room: { room_code: roomRows[0].room_code, room_id: roomRows[0].id },
    validation,
    match_phase: matchPhase,
    cancel_phase: cancelPhase,
    split_phase: splitPhase,
    create_blocks_phase: createBlocksPhase,
    overlap_conflicts: overlapConflicts,
    payments_untouched: paymentsUntouched,
    warnings,
    actionable,
    hosted_parity_notes: hostedParityNotes,
    operator_room_release_request_preview: {
      would_upsert_in_3b5b: true,
      operator_name: input.operator,
      room_code: input.roomCode,
      release_start_date: input.releaseStart,
      release_end_date: input.releaseEnd,
      request_code: input.requestCode,
      notes: input.notes,
      status_if_match_ok: 'completed',
      status_if_no_match: 'failed',
      airtable_record_id: input.releaseRecordId || null,
    },
  };
}

module.exports = {
  INPUT_SURFACE_RECOMMENDATION,
  ROOM_MATCH_RULE,
  OPERATOR_MATCH_RULE,
  parseOperatorRoomReleaseInput,
  validateInput,
  loadOperatorRoomReleaseImpactPlan,
  computeSplit,
  normalizeRoomCode,
  normalizeOperatorName,
};

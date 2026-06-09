'use strict';

/**
 * Stage 27demo-d.1 — Open demo booking bed assignment (calendar visibility).
 * Reuses assign-booking-beds-plan + assign execute pattern from 3b.2b.
 */

const { loadAssignPlan, roomCodeFromBedCode } = require('./assign-booking-beds-plan');
const { runAvailabilityCheckDryRun } = require('./luna-guest-booking-dry-run');
const { isStagingResetEnvironment } = require('./luna-test-reset-phone');

const ASSIGN_NOTES = 'Assigned via open demo WhatsApp booking write (27demo-d.1)';
const ASSIGNMENT_TYPE = 'Auto Assigned';

const ASSIGN_SAFETY = Object.freeze({
  stripe_link_created: false,
  payment_link_sent: false,
  sends_whatsapp: false,
  live_send_blocked: true,
});

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

async function loadBookingRow(pg, clientSlug, bookingRef) {
  const code = trimStr(bookingRef.booking_code);
  const id = trimStr(bookingRef.booking_id);
  if (!code && !id) return null;
  const { rows } = await pg.query(
    `SELECT b.id::text AS booking_id,
            b.booking_code,
            b.guest_name,
            b.check_in::text AS check_in,
            b.check_out::text AS check_out,
            b.guest_count,
            b.status::text AS status,
            b.assignment_status::text AS assignment_status,
            c.slug AS client_slug
       FROM bookings b
       INNER JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1
        AND ($2::text IS NOT NULL AND b.booking_code = $2
             OR $3::text IS NOT NULL AND b.id::text = $3)
      LIMIT 1`,
    [clientSlug, code || null, id || null],
  );
  return rows[0] || null;
}

async function loadExistingAssignment(pg, clientSlug, bookingId) {
  const { rows } = await pg.query(
    `SELECT bb.id::text AS booking_bed_id,
            bb.bed_id::text AS assigned_bed_id,
            bb.bed_code AS assigned_bed_label,
            bb.room_code AS assigned_room_label
       FROM booking_beds bb
       INNER JOIN clients c ON c.id = bb.client_id
      WHERE c.slug = $1 AND bb.booking_id = $2::uuid
      ORDER BY bb.bed_code ASC`,
    [clientSlug, bookingId],
  );
  return rows;
}

async function resolveDemoBedCodes(pg, review, bookingRow) {
  const avail = (review && review.availability) || {};
  let codes = Array.isArray(avail.selected_bed_codes)
    ? avail.selected_bed_codes.map((c) => trimStr(c).toUpperCase()).filter(Boolean)
    : [];
  if (codes.length) {
    return { bed_codes: codes, source: 'review_availability' };
  }

  const ext = (review && review.result && review.result.extracted_fields) || {};
  const guestCount = Number(bookingRow.guest_count || ext.guest_count || 2) || 2;
  const availCheck = await runAvailabilityCheckDryRun({
    client_slug: bookingRow.client_slug || 'wolfhouse-somo',
    check_in: bookingRow.check_in || ext.check_in,
    check_out: bookingRow.check_out || ext.check_out,
    guest_count: guestCount,
    room_type: ext.room_type || 'shared',
  }, pg);

  codes = Array.isArray(availCheck.selected_bed_codes)
    ? availCheck.selected_bed_codes.map((c) => trimStr(c).toUpperCase()).filter(Boolean)
    : [];

  return {
    bed_codes: codes,
    source: 'availability_rerun',
    availability_status: availCheck.availability_status || null,
    blockers: availCheck.blockers || [],
  };
}

function formatAssignmentResponse(base) {
  return {
    ...ASSIGN_SAFETY,
    assignment_write_attempted: true,
    calendar_visible_expected: base.assignment_write_status === 'created'
      || base.assignment_write_status === 'reused_existing',
    ...base,
  };
}

/**
 * Assign demo-safe beds for an open-demo hold booking (staging only).
 *
 * @param {object} pg
 * @param {object} context - { client_slug, booking_id, booking_code, review, env, host_header }
 */
async function runOpenDemoBookingBedAssignApproved(pg, context) {
  const ctx = context || {};
  const env = ctx.env || process.env;
  const clientSlug = trimStr(ctx.client_slug) || 'wolfhouse-somo';

  if (!isStagingResetEnvironment(env, ctx.host_header || '')) {
    return formatAssignmentResponse({
      assignment_write_status: 'blocked',
      assignment_block_reasons: ['production_or_unknown_environment_blocked'],
    });
  }

  const bookingRow = await loadBookingRow(pg, clientSlug, ctx);
  if (!bookingRow) {
    return formatAssignmentResponse({
      assignment_write_status: 'error',
      assignment_block_reasons: ['booking_not_found'],
    });
  }

  if (!bookingRow.check_in || !bookingRow.check_out) {
    return formatAssignmentResponse({
      assignment_write_status: 'blocked',
      assignment_block_reasons: ['missing_check_in_or_check_out'],
      booking_id: bookingRow.booking_id,
      booking_code: bookingRow.booking_code,
    });
  }

  const existing = await loadExistingAssignment(pg, clientSlug, bookingRow.booking_id);
  if (existing.length > 0) {
    const first = existing[0];
    return formatAssignmentResponse({
      assignment_write_status: 'reused_existing',
      assignment_block_reasons: [],
      booking_id: bookingRow.booking_id,
      booking_code: bookingRow.booking_code,
      assigned_bed_id: first.assigned_bed_id,
      assigned_bed_label: first.assigned_bed_label,
      assigned_room_label: first.assigned_room_label,
      assigned_room_id: first.assigned_room_label,
      booking_bed_ids: existing.map((r) => r.booking_bed_id),
      reused_assignment_path: 'existing_booking_beds',
    });
  }

  const bedResolve = await resolveDemoBedCodes(pg, ctx.review, bookingRow);
  const bedCodes = bedResolve.bed_codes || [];
  if (!bedCodes.length) {
    return formatAssignmentResponse({
      assignment_write_status: 'skipped_no_safe_bed',
      assignment_status: 'needs_staff_assignment',
      assignment_block_reasons: bedResolve.blockers && bedResolve.blockers.length
        ? bedResolve.blockers.slice()
        : ['no_safe_demo_bed_available'],
      bed_code_source: bedResolve.source,
      booking_id: bookingRow.booking_id,
      booking_code: bookingRow.booking_code,
    });
  }

  const plan = await loadAssignPlan(pg, {
    clientSlug,
    bookingCode: bookingRow.booking_code,
    bedCodes,
    checkIn: bookingRow.check_in,
    checkOut: bookingRow.check_out,
  });

  if (plan.error) {
    return formatAssignmentResponse({
      assignment_write_status: 'error',
      assignment_block_reasons: [plan.error],
      booking_id: bookingRow.booking_id,
      booking_code: bookingRow.booking_code,
    });
  }

  if (plan.unknownBedCodes && plan.unknownBedCodes.length) {
    return formatAssignmentResponse({
      assignment_write_status: 'skipped_no_safe_bed',
      assignment_status: 'needs_staff_assignment',
      assignment_block_reasons: ['unknown_bed_codes'],
      unknown_bed_codes: plan.unknownBedCodes,
      booking_id: bookingRow.booking_id,
      booking_code: bookingRow.booking_code,
    });
  }

  if (plan.hasOverlaps || !plan.assignmentAfter) {
    return formatAssignmentResponse({
      assignment_write_status: 'skipped_no_safe_bed',
      assignment_status: 'needs_staff_assignment',
      assignment_block_reasons: ['bed_date_conflict'],
      overlap_conflicts: plan.overlapConflicts || [],
      booking_id: bookingRow.booking_id,
      booking_code: bookingRow.booking_code,
    });
  }

  if (!plan.wouldInsert.length) {
    if (plan.wouldSkip.length) {
      const skip = plan.wouldSkip[0];
      return formatAssignmentResponse({
        assignment_write_status: 'reused_existing',
        assignment_block_reasons: [],
        booking_id: bookingRow.booking_id,
        booking_code: bookingRow.booking_code,
        assigned_bed_label: skip.bed_code,
        assigned_room_label: skip.room_code || roomCodeFromBedCode(skip.bed_code),
        assigned_room_id: skip.room_code || roomCodeFromBedCode(skip.bed_code),
        reused_assignment_path: 'assign_plan_would_skip',
      });
    }
    return formatAssignmentResponse({
      assignment_write_status: 'skipped_no_safe_bed',
      assignment_status: 'needs_staff_assignment',
      assignment_block_reasons: ['no_beds_to_insert'],
      booking_id: bookingRow.booking_id,
      booking_code: bookingRow.booking_code,
    });
  }

  if (['cancelled', 'expired'].includes(plan.booking.status)) {
    return formatAssignmentResponse({
      assignment_write_status: 'blocked',
      assignment_block_reasons: ['booking_not_assignable'],
      booking_id: bookingRow.booking_id,
      booking_code: bookingRow.booking_code,
    });
  }

  try {
    await pg.query('BEGIN');
    const paymentsBefore = (await pg.query(
      'SELECT COUNT(*)::int AS c FROM payments WHERE client_id = $1 AND booking_id = $2::uuid',
      [plan.clientId, plan.bookingId],
    )).rows[0].c;
    const paymentStatusBefore = plan.booking.payment_status;

    const insertedIds = [];
    for (const row of plan.wouldInsert) {
      const insertRes = await pg.query(
        `INSERT INTO booking_beds (
           client_id, booking_id, bed_id, bed_code, room_code,
           assignment_start_date, assignment_end_date,
           assignment_type, assignment_notes, guest_name, airtable_record_id
         ) VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6::date, $7::date, $8, $9, $10, NULL)
         RETURNING id::text AS booking_bed_id, bed_id::text AS bed_id, bed_code, room_code`,
        [
          plan.clientId,
          plan.bookingId,
          row.bed_id,
          row.bed_code,
          row.room_code,
          row.assignment_start_date,
          row.assignment_end_date,
          ASSIGNMENT_TYPE,
          ASSIGN_NOTES,
          plan.booking.guest_name,
        ],
      );
      insertedIds.push(insertRes.rows[0]);
    }

    await pg.query(
      `UPDATE bookings
          SET assignment_status = $3::assignment_status,
              availability_check_status = $4::availability_check_status
        WHERE id = $1::uuid AND client_id = $2`,
      [
        plan.bookingId,
        plan.clientId,
        plan.assignmentAfter.assignment_status,
        plan.assignmentAfter.availability_check_status,
      ],
    );

    const paymentsAfter = (await pg.query(
      'SELECT COUNT(*)::int AS c FROM payments WHERE client_id = $1 AND booking_id = $2::uuid',
      [plan.clientId, plan.bookingId],
    )).rows[0].c;
    const paymentStatusAfter = (await pg.query(
      'SELECT payment_status::text AS payment_status FROM bookings WHERE id = $1::uuid',
      [plan.bookingId],
    )).rows[0].payment_status;

    if (paymentsBefore !== paymentsAfter || paymentStatusAfter !== paymentStatusBefore) {
      throw new Error('payment_rows_changed_during_assignment');
    }

    await pg.query('COMMIT');

    const primary = insertedIds[0] || {};
    return formatAssignmentResponse({
      assignment_write_status: 'created',
      assignment_block_reasons: [],
      reused_assignment_path: 'loadAssignPlan_execute',
      bed_code_source: bedResolve.source,
      booking_id: bookingRow.booking_id,
      booking_code: bookingRow.booking_code,
      assigned_bed_id: primary.bed_id || null,
      assigned_bed_label: primary.bed_code || null,
      assigned_room_label: primary.room_code || roomCodeFromBedCode(primary.bed_code),
      assigned_room_id: primary.room_code || roomCodeFromBedCode(primary.bed_code),
      booking_bed_ids: insertedIds.map((r) => r.booking_bed_id),
      beds_assigned_count: insertedIds.length,
    });
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch (_) { /* ignore */ }
    return formatAssignmentResponse({
      assignment_write_status: 'error',
      assignment_block_reasons: [err.message || 'assignment_failed'],
      booking_id: bookingRow.booking_id,
      booking_code: bookingRow.booking_code,
    });
  }
}

module.exports = {
  runOpenDemoBookingBedAssignApproved,
  resolveDemoBedCodes,
  ASSIGN_SAFETY,
};

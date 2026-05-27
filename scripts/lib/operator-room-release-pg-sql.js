/**
 * Phase 3b.5b — Postgres mutations for Operator Room Release (local only).
 * No payments/payment_events writes. No Airtable/Sheets.
 */
const { toIsoDateString } = require('./bed-drift-keys');

const EXECUTE_NOTES = 'Mirrored via operator-room-release-postgres.js (local 3b.5b)';

async function countPayments(client, clientId, bookingId) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS c FROM payments WHERE client_id = $1 AND booking_id = $2`,
    [clientId, bookingId]
  );
  return rows[0].c;
}

async function countPaymentEvents(client, clientId, bookingId) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS c
     FROM payment_events pe
     INNER JOIN payments p ON p.id = pe.payment_id
     WHERE p.client_id = $1 AND p.booking_id = $2`,
    [clientId, bookingId]
  );
  return rows[0].c;
}

async function assertPaymentsUnchanged(client, clientId, bookingId, paymentsBefore, paymentStatusBefore) {
  const paymentsAfter = await countPayments(client, clientId, bookingId);
  if (paymentsAfter !== paymentsBefore) {
    throw new Error('payments row count changed unexpectedly');
  }
  const { rows } = await client.query(
    `SELECT payment_status::text AS payment_status FROM bookings WHERE id = $1 AND client_id = $2`,
    [bookingId, clientId]
  );
  if (rows[0].payment_status !== paymentStatusBefore) {
    throw new Error('payment_status changed unexpectedly');
  }
}

async function findCompletedRequestByCode(client, clientId, requestCode) {
  if (!requestCode) return null;
  const { rows } = await client.query(
    `SELECT
       id,
       request_code,
       status::text AS status,
       original_booking_id,
       new_booking_a_id,
       new_booking_b_id,
       error_notes
     FROM operator_room_release_requests
     WHERE client_id = $1 AND request_code = $2 AND status = 'completed'
     ORDER BY updated_at DESC
     LIMIT 1`,
    [clientId, requestCode]
  );
  return rows[0] || null;
}

async function loadBookingSummary(client, clientId, bookingId) {
  const { rows } = await client.query(
    `SELECT id, booking_code, check_in::text AS check_in, check_out::text AS check_out, status::text AS status
     FROM bookings WHERE id = $1 AND client_id = $2`,
    [bookingId, clientId]
  );
  return rows[0] || null;
}

async function loadBookingByCode(client, clientId, bookingCode) {
  const { rows } = await client.query(
    `SELECT
       id,
       booking_code,
       check_in::text AS check_in,
       check_out::text AS check_out,
       status::text AS status
     FROM bookings
     WHERE client_id = $1 AND booking_code = $2`,
    [clientId, bookingCode]
  );
  return rows[0] || null;
}

function appendStaffNotes(existing, note) {
  const base = String(existing || '').trim();
  const addition = String(note || '').trim();
  if (!addition) return base || null;
  if (!base) return addition;
  if (base.includes(addition)) return base;
  return `${base}\n${addition}`;
}

function blockBookingCodes(originalBookingCode) {
  return {
    a: `${originalBookingCode}-A`,
    b: `${originalBookingCode}-B`,
  };
}

async function validateDeterministicBlockCodes(client, clientId, originalBookingCode, splitPhase) {
  const codes = blockBookingCodes(originalBookingCode);
  const errors = [];

  async function checkBlock(suffix, code, preview) {
    if (!preview) return null;
    const existing = await loadBookingByCode(client, clientId, code);
    if (!existing) return null;
    const expectedIn = toIsoDateString(preview.check_in);
    const expectedOut = toIsoDateString(preview.check_out);
    const actualIn = toIsoDateString(existing.check_in);
    const actualOut = toIsoDateString(existing.check_out);
    if (actualIn !== expectedIn || actualOut !== expectedOut) {
      errors.push({
        block: suffix,
        booking_code: code,
        expected: { check_in: expectedIn, check_out: expectedOut },
        actual: { check_in: actualIn, check_out: actualOut, status: existing.status },
      });
    }
    return existing;
  }

  const existingA = await checkBlock('A', codes.a, splitPhase.block_a);
  const existingB = await checkBlock('B', codes.b, splitPhase.block_b);

  if (errors.length) {
    return { error: 'block_booking_code_conflict', conflicts: errors };
  }

  return { codes, existing_a: existingA, existing_b: existingB };
}

async function insertBlockBooking(client, clientId, bookingCode, blockPreview, operatorName, roomCode, roomId, splitNote) {
  const metadata = JSON.stringify({
    operator_release_block: bookingCode.endsWith('-A') ? 'A' : 'B',
    operator_release_parent: bookingCode.replace(/-[AB]$/, ''),
    source: 'operator-room-release-3b5b',
  });

  const staffNotes = `${splitNote}\n${EXECUTE_NOTES}`;

  const { rows } = await client.query(
    `INSERT INTO bookings (
       client_id,
       booking_code,
       guest_name,
       operator_name,
       booking_source,
       block_type,
       status,
       payment_status,
       assignment_status,
       availability_check_status,
       check_in,
       check_out,
       guest_count,
       primary_room_code,
       room_to_block_id,
       staff_notes,
       deposit_required_cents,
       deposit_paid_cents,
       balance_due_cents,
       total_amount_cents,
       amount_paid_cents,
       metadata
     ) VALUES (
       $1, $2, $3, $4, 'operator', 'whole_room', 'confirmed', 'not_requested',
       'unassigned', 'unknown', $5::date, $6::date, 1, $7, $8, $9,
       0, 0, 0, 0, 0, $10::jsonb
     )
     RETURNING id, booking_code, check_in::text AS check_in, check_out::text AS check_out`,
    [
      clientId,
      bookingCode,
      operatorName,
      operatorName,
      blockPreview.check_in,
      blockPreview.check_out,
      roomCode,
      roomId,
      staffNotes,
      metadata,
    ]
  );
  return rows[0];
}

async function upsertReleaseRequestProcessing(client, clientId, input, roomId) {
  if (input.requestCode) {
    const { rows: existing } = await client.query(
      `SELECT id, status::text AS status FROM operator_room_release_requests
       WHERE client_id = $1 AND request_code = $2
       ORDER BY updated_at DESC LIMIT 1`,
      [clientId, input.requestCode]
    );
    if (existing.length && existing[0].status === 'processing') {
      return { error: 'request_stuck_processing', request_id: existing[0].id };
    }
    if (existing.length && existing[0].status !== 'completed') {
      const { rows } = await client.query(
        `UPDATE operator_room_release_requests
         SET status = 'processing',
             operator_name = $3,
             room_id = $4,
             room_code = $5,
             release_start_date = $6::date,
             release_end_date = $7::date,
             notes = COALESCE($8, notes),
             error_notes = NULL,
             updated_at = NOW()
         WHERE id = $1 AND client_id = $2
         RETURNING id`,
        [
          existing[0].id,
          clientId,
          input.operator,
          roomId,
          input.roomCode,
          input.releaseStart,
          input.releaseEnd,
          input.notes || null,
        ]
      );
      return { request_id: rows[0].id, created: false };
    }
  }

  const { rows } = await client.query(
    `INSERT INTO operator_room_release_requests (
       client_id,
       operator_name,
       room_id,
       room_code,
       release_start_date,
       release_end_date,
       request_code,
       notes,
       status,
       airtable_record_id
     ) VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8, 'processing', $9)
     RETURNING id`,
    [
      clientId,
      input.operator,
      roomId,
      input.roomCode,
      input.releaseStart,
      input.releaseEnd,
      input.requestCode || null,
      input.notes || null,
      input.releaseRecordId || null,
    ]
  );
  return { request_id: rows[0].id, created: true };
}

/**
 * Execute operator room release in a single transaction (caller must not be in txn yet).
 */
async function executeOperatorRoomRelease(client, plan, input) {
  const clientId = plan.client_id;
  const cancel = plan.cancel_phase;
  const split = plan.split_phase;
  const original = cancel.original_booking_preview;
  const originalBookingId = original.booking_id;
  const originalBookingCode = original.booking_code;

  const completed = await findCompletedRequestByCode(client, clientId, input.requestCode);
  if (completed) {
    const orig = await loadBookingSummary(client, clientId, completed.original_booking_id);
    const blockA = completed.new_booking_a_id
      ? await loadBookingSummary(client, clientId, completed.new_booking_a_id)
      : null;
    const blockB = completed.new_booking_b_id
      ? await loadBookingSummary(client, clientId, completed.new_booking_b_id)
      : null;
    return {
      idempotent: true,
      request_id: completed.id,
      request_code: completed.request_code,
      original_booking: orig,
      block_a: blockA,
      block_b: blockB,
    };
  }

  const { rows: origRows } = await client.query(
    `SELECT
       id,
       booking_code,
       status::text AS status,
       payment_status::text AS payment_status,
       staff_notes,
       assignment_status::text AS assignment_status
     FROM bookings
     WHERE id = $1 AND client_id = $2
     FOR UPDATE`,
    [originalBookingId, clientId]
  );
  if (!origRows.length) {
    return { error: 'original_booking_not_found' };
  }
  const origBooking = origRows[0];

  if (origBooking.status === 'cancelled' || origBooking.status === 'expired') {
    return {
      error: 'already_cancelled_ambiguous',
      booking_code: origBooking.booking_code,
      status: origBooking.status,
    };
  }

  const paymentsBefore = await countPayments(client, clientId, originalBookingId);
  const eventsBefore = await countPaymentEvents(client, clientId, originalBookingId);
  if (paymentsBefore > 0 || eventsBefore > 0) {
    return {
      error: 'payments_exist',
      payments_count: paymentsBefore,
      payment_events_count: eventsBefore,
    };
  }

  const blockValidation = await validateDeterministicBlockCodes(
    client,
    clientId,
    originalBookingCode,
    split
  );
  if (blockValidation.error) return blockValidation;

  const { codes } = blockValidation;
  const splitNote = split.split_note;

  await client.query('BEGIN');
  try {
    const req = await upsertReleaseRequestProcessing(client, clientId, input, plan.room.room_id);
    if (req.error) {
      throw Object.assign(new Error(req.error), { code: req.error, details: req });
    }

    const deleteBeds = await client.query(
      `DELETE FROM booking_beds WHERE client_id = $1 AND booking_id = $2`,
      [clientId, originalBookingId]
    );

    const newStaffNotes = appendStaffNotes(origBooking.staff_notes, splitNote);
    const updateOrig = await client.query(
      `UPDATE bookings
       SET status = 'cancelled',
           assignment_status = 'needs_review',
           availability_check_status = 'needs_review',
           staff_notes = $3,
           updated_at = NOW()
       WHERE id = $1 AND client_id = $2`,
      [originalBookingId, clientId, newStaffNotes]
    );

    let blockAId = blockValidation.existing_a?.id || null;
    let blockBId = blockValidation.existing_b?.id || null;
    let blockACode = null;
    let blockBCode = null;

    if (split.should_create_a && !blockAId) {
      const row = await insertBlockBooking(
        client,
        clientId,
        codes.a,
        split.block_a,
        input.operator,
        input.roomCode,
        plan.room.room_id,
        splitNote
      );
      blockAId = row.id;
      blockACode = row.booking_code;
    } else if (blockAId) {
      blockACode = codes.a;
    }

    if (split.should_create_b && !blockBId) {
      const row = await insertBlockBooking(
        client,
        clientId,
        codes.b,
        split.block_b,
        input.operator,
        input.roomCode,
        plan.room.room_id,
        splitNote
      );
      blockBId = row.id;
      blockBCode = row.booking_code;
    } else if (blockBId) {
      blockBCode = codes.b;
    }

    await client.query(
      `UPDATE operator_room_release_requests
       SET status = 'completed',
           original_booking_id = $3,
           new_booking_a_id = $4,
           new_booking_b_id = $5,
           error_notes = NULL,
           updated_at = NOW()
       WHERE id = $1 AND client_id = $2`,
      [req.request_id, clientId, originalBookingId, blockAId, blockBId]
    );

    await assertPaymentsUnchanged(
      client,
      clientId,
      originalBookingId,
      paymentsBefore,
      origBooking.payment_status
    );

    await client.query('COMMIT');

    return {
      idempotent: false,
      request_id: req.request_id,
      request_code: input.requestCode || null,
      original_booking_id: originalBookingId,
      original_booking_code: originalBookingCode,
      deleted_beds: deleteBeds.rowCount,
      booking_rows_updated: updateOrig.rowCount,
      block_a: blockAId ? { id: blockAId, booking_code: blockACode || codes.a } : null,
      block_b: blockBId ? { id: blockBId, booking_code: blockBCode || codes.b } : null,
      payments_count: paymentsBefore,
      payment_events_count: eventsBefore,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    if (input.requestCode) {
      await client.query(
        `UPDATE operator_room_release_requests
         SET status = 'failed',
             error_notes = $3,
             updated_at = NOW()
         WHERE client_id = $1 AND request_code = $2 AND status = 'processing'`,
        [clientId, input.requestCode, String(err.message || err).slice(0, 500)]
      ).catch(() => {});
    }
    throw err;
  }
}

module.exports = {
  EXECUTE_NOTES,
  countPayments,
  countPaymentEvents,
  findCompletedRequestByCode,
  loadBookingSummary,
  loadBookingByCode,
  blockBookingCodes,
  validateDeterministicBlockCodes,
  executeOperatorRoomRelease,
};

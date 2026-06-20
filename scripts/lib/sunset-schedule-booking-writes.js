'use strict';

/**
 * Sunset Schedule — manual booking writes (bookings + booking_service_records).
 * Sunset client only; no payment-link or messaging side effects.
 */

const crypto = require('crypto');

const SUNSET_CLIENT_SLUG = 'sunset';
const METADATA_SOURCE_TAG = 'staff_manual_schedule';
const DB_SOURCE = 'staff_manual';

const UI_SERVICE_TYPES = new Set(['lesson', 'board_rental', 'wetsuit_rental']);
const UI_PAYMENT_STATUSES = new Set(['unpaid', 'paid', 'pending']);

const UI_TO_DB_SERVICE_TYPE = {
  lesson: 'surf_lesson',
  board_rental: 'surfboard',
  wetsuit_rental: 'wetsuit',
};

const DB_TO_UI_SERVICE_TYPE = {
  surf_lesson: 'lesson',
  surfboard: 'board_rental',
  wetsuit: 'wetsuit_rental',
};

const UI_TO_SR_PAYMENT = {
  unpaid: 'pending',
  paid: 'paid',
  pending: 'pending',
};

const UI_TO_BOOKING_PAYMENT = {
  unpaid: 'waiting_payment',
  paid: 'paid',
  pending: 'waiting_payment',
};

function isIsoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());
}

function isTimeHm(s) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || '').trim());
}

function validateScheduleBookingBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const guest_name = String(b.guest_name || '').trim();
  if (!guest_name || guest_name.length > 200) {
    return { ok: false, error: 'guest_name is required (max 200 chars)' };
  }
  const booking_type = String(b.booking_type || '').trim();
  if (!UI_SERVICE_TYPES.has(booking_type)) {
    return { ok: false, error: 'booking_type must be lesson, board_rental, or wetsuit_rental' };
  }
  const service_date = String(b.service_date || '').trim();
  if (!isIsoDate(service_date)) {
    return { ok: false, error: 'service_date must be YYYY-MM-DD' };
  }
  const time_local = String(b.time_local || b.slot_time || '').trim();
  if (time_local && !isTimeHm(time_local)) {
    return { ok: false, error: 'time_local must be HH:MM' };
  }
  const quantityRaw = b.quantity != null ? b.quantity : b.count;
  const quantity = parseInt(String(quantityRaw == null ? 1 : quantityRaw), 10);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    return { ok: false, error: 'quantity must be 1–99' };
  }
  const payment_status = String(b.payment_status || 'unpaid').trim().toLowerCase();
  if (!UI_PAYMENT_STATUSES.has(payment_status)) {
    return { ok: false, error: 'payment_status must be unpaid, paid, or pending' };
  }
  const notes = b.notes != null ? String(b.notes).trim().slice(0, 2000) : '';
  const needs_reply = b.needs_reply === true || b.needs_reply === 'true' || b.needs_reply === 1;
  const idempotency_key = b.idempotency_key != null ? String(b.idempotency_key).trim().slice(0, 120) : '';

  return {
    ok: true,
    value: {
      guest_name,
      booking_type,
      service_date,
      time_local: time_local || null,
      quantity,
      payment_status,
      notes,
      needs_reply,
      idempotency_key: idempotency_key || null,
    },
  };
}

function generateSunsetManualBookingCode() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `SUNSET-MAN-${stamp}-${suffix}`;
}

function bookingStatusFromPayment(paymentStatus) {
  return paymentStatus === 'paid' ? 'confirmed' : 'payment_pending';
}

function scheduleRowFromDb(row) {
  const dbType = String(row.service_type || '').toLowerCase();
  const uiType = row.staff_ui_service_type || DB_TO_UI_SERVICE_TYPE[dbType] || dbType;
  const isLesson = dbType === 'surf_lesson' || uiType === 'lesson';
  let payment = String(row.payment_status || '').toLowerCase();
  if (payment === 'pending' || payment === 'not_requested') payment = 'unpaid';

  return {
    _scheduleId: String(row.service_record_id || row.id || ''),
    _isDbManual: row.record_source === DB_SOURCE && (row.metadata_source === METADATA_SOURCE_TAG || row.staff_manual_schedule === true || (row.metadata_source == null && row.staff_ui_service_type)),
    _isDemo: false,
    guest_name: row.guest_name || null,
    service_type: uiType,
    service_date: row.service_date,
    slot_time: row.slot_time || null,
    quantity: row.quantity != null ? Number(row.quantity) : 1,
    payment_status: payment,
    booking_code: row.booking_code || null,
    notes: row.notes || null,
    _needsReply: row.needs_reply === true || row.needs_reply === 't',
    _scheduleType: isLesson ? 'lesson' : 'rental',
    service_record_id: row.service_record_id || row.id || null,
    booking_id: row.booking_id || null,
  };
}

async function findIdempotentBooking(pg, clientSlug, idempotencyKey) {
  if (!idempotencyKey) return null;
  const res = await pg.query(
    `SELECT sr.id::text AS service_record_id,
            sr.booking_id::text AS booking_id,
            sr.booking_code,
            sr.guest_name,
            sr.service_type::text AS service_type,
            sr.service_date::text AS service_date,
            sr.quantity,
            sr.payment_status::text AS payment_status,
            sr.source AS record_source,
            sr.metadata->>'slot_time' AS slot_time,
            sr.metadata->>'notes' AS notes,
            COALESCE((sr.metadata->>'needs_reply')::boolean, false) AS needs_reply,
            sr.metadata->>'staff_ui_service_type' AS staff_ui_service_type,
            sr.metadata->>'source' AS metadata_source
       FROM booking_service_records sr
      WHERE sr.client_slug = $1
        AND sr.metadata->>'idempotency_key' = $2
      LIMIT 1`,
    [clientSlug, idempotencyKey],
  );
  return res.rows[0] || null;
}

async function createSunsetScheduleBooking(pg, opts) {
  const clientSlug = String(opts.clientSlug || '').trim();
  if (clientSlug !== SUNSET_CLIENT_SLUG) {
    return { ok: false, status: 403, body: { success: false, error: 'unsupported_client', client_slug: clientSlug } };
  }

  const validated = validateScheduleBookingBody(opts.body);
  if (!validated.ok) {
    return { ok: false, status: 400, body: { success: false, error: validated.error } };
  }
  const input = validated.value;

  if (input.idempotency_key) {
    const existing = await findIdempotentBooking(pg, clientSlug, input.idempotency_key);
    if (existing) {
      return {
        ok: true,
        status: 200,
        body: {
          success: true,
          idempotent: true,
          booking: scheduleRowFromDb(existing),
        },
      };
    }
  }

  const clientRes = await pg.query('SELECT id FROM clients WHERE slug = $1 LIMIT 1', [clientSlug]);
  if (clientRes.rows.length === 0) {
    return { ok: false, status: 500, body: { success: false, error: 'sunset client not found' } };
  }
  const clientId = clientRes.rows[0].id;

  const dbServiceType = UI_TO_DB_SERVICE_TYPE[input.booking_type];
  const srPayment = UI_TO_SR_PAYMENT[input.payment_status];
  const bookingPayment = UI_TO_BOOKING_PAYMENT[input.payment_status];
  const bookingStatus = bookingStatusFromPayment(input.payment_status);
  const bookingCode = generateSunsetManualBookingCode();
  const metadata = {
    source: METADATA_SOURCE_TAG,
    staff_manual_schedule: true,
    staff_ui_service_type: input.booking_type,
    slot_time: input.time_local,
    notes: input.notes || null,
    needs_reply: input.needs_reply,
    created_by_staff: opts.actor && opts.actor.email ? opts.actor.email : null,
    idempotency_key: input.idempotency_key,
  };

  await pg.query('BEGIN');
  try {
    const bookingIns = await pg.query(
      `INSERT INTO bookings (
         client_id, booking_code, guest_name, status, payment_status,
         check_in, check_out, guest_count, metadata
       ) VALUES (
         $1::uuid, $2, $3, $4::booking_status, $5::payment_status,
         $6::date, ($6::date + INTERVAL '1 day')::date, $7, $8::jsonb
       )
       RETURNING id::text AS id, booking_code`,
      [
        clientId,
        bookingCode,
        input.guest_name,
        bookingStatus,
        bookingPayment,
        input.service_date,
        input.quantity,
        JSON.stringify({ source: METADATA_SOURCE_TAG, staff_manual_schedule: true }),
      ],
    );
    const bookingId = bookingIns.rows[0].id;

    const svcIns = await pg.query(
      `INSERT INTO booking_service_records (
         client_slug, booking_id, booking_code, guest_name, service_type, service_date,
         quantity, status, amount_due_cents, amount_paid_cents, payment_status, source, metadata
       ) VALUES (
         $1, $2::uuid, $3, $4, $5, $6::date,
         $7, 'confirmed', 0, 0, $8, $9, $10::jsonb
       )
       RETURNING id::text AS service_record_id,
                 booking_id::text AS booking_id,
                 booking_code,
                 guest_name,
                 service_type::text AS service_type,
                 service_date::text AS service_date,
                 quantity,
                 payment_status::text AS payment_status,
                 source AS record_source,
                 metadata->>'slot_time' AS slot_time,
                 metadata->>'notes' AS notes,
                 COALESCE((metadata->>'needs_reply')::boolean, false) AS needs_reply,
                 metadata->>'staff_ui_service_type' AS staff_ui_service_type,
                 metadata->>'source' AS metadata_source`,
      [
        clientSlug,
        bookingId,
        bookingCode,
        input.guest_name,
        dbServiceType,
        input.service_date,
        input.quantity,
        srPayment,
        DB_SOURCE,
        JSON.stringify(metadata),
      ],
    );

    await pg.query('COMMIT');
    return {
      ok: true,
      status: 201,
      body: {
        success: true,
        booking: scheduleRowFromDb(svcIns.rows[0]),
      },
    };
  } catch (err) {
    await pg.query('ROLLBACK');
    throw err;
  }
}

module.exports = {
  SUNSET_CLIENT_SLUG,
  METADATA_SOURCE_TAG,
  DB_SOURCE,
  UI_SERVICE_TYPES,
  validateScheduleBookingBody,
  generateSunsetManualBookingCode,
  scheduleRowFromDb,
  createSunsetScheduleBooking,
};

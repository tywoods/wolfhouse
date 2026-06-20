'use strict';

/**
 * Sunset Schedule — manual booking writes (bookings + booking_service_records).
 * Supports component combos and multi-date via one booking header + many service records.
 */

const crypto = require('crypto');

const SUNSET_CLIENT_SLUG = 'sunset';
const METADATA_SOURCE_TAG = 'staff_manual_schedule';
const DB_SOURCE = 'staff_manual';
const DEFAULT_LESSON_CATEGORY = 'Adult (Over 12)';

const UI_COMPONENT_KEYS = new Set(['lesson', 'surfboard', 'wetsuit']);
const LEGACY_UI_SERVICE_TYPES = new Set(['lesson', 'board_rental', 'wetsuit_rental']);
const UI_PAYMENT_STATUSES = new Set(['unpaid', 'paid', 'pending']);

const UI_TO_DB_SERVICE_TYPE = {
  lesson: 'surf_lesson',
  surfboard: 'surfboard',
  wetsuit: 'wetsuit',
  board_rental: 'surfboard',
  wetsuit_rental: 'wetsuit',
};

const DB_TO_UI_SERVICE_TYPE = {
  surf_lesson: 'lesson',
  surfboard: 'surfboard',
  wetsuit: 'wetsuit',
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

function parseQuantity(raw, fallback) {
  const quantity = parseInt(String(raw == null ? fallback : raw), 10);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) return null;
  return quantity;
}

function normalizeComponents(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.components && typeof b.components === 'object') {
    const out = {};
    for (const key of UI_COMPONENT_KEYS) {
      const part = b.components[key];
      if (!part) continue;
      const qty = parseQuantity(part.quantity != null ? part.quantity : part.count, 1);
      if (!qty) return { ok: false, error: `components.${key}.quantity must be 1–99` };
      const entry = { quantity: qty };
      if (key === 'lesson') {
        const slot = String(part.slot_time || part.time_local || b.time_local || b.slot_time || '').trim();
        if (slot && !isTimeHm(slot)) return { ok: false, error: 'lesson slot_time must be HH:MM' };
        entry.slot_time = slot || null;
        entry.category = String(part.category || b.lesson_category || DEFAULT_LESSON_CATEGORY).trim() || DEFAULT_LESSON_CATEGORY;
      }
      out[key] = entry;
    }
    if (!Object.keys(out).length) return { ok: false, error: 'components must include at least one of lesson, surfboard, wetsuit' };
    return { ok: true, value: out };
  }

  const booking_type = String(b.booking_type || '').trim();
  if (!LEGACY_UI_SERVICE_TYPES.has(booking_type)) {
    return { ok: false, error: 'booking_type or components is required' };
  }
  const qty = parseQuantity(b.quantity != null ? b.quantity : b.count, 1);
  if (!qty) return { ok: false, error: 'quantity must be 1–99' };
  const legacyKey = booking_type === 'lesson' ? 'lesson' : (booking_type === 'board_rental' ? 'surfboard' : 'wetsuit');
  const out = { [legacyKey]: { quantity: qty } };
  if (legacyKey === 'lesson') {
    const slot = String(b.time_local || b.slot_time || '').trim();
    if (slot && !isTimeHm(slot)) return { ok: false, error: 'time_local must be HH:MM' };
    out.lesson.slot_time = slot || null;
    out.lesson.category = DEFAULT_LESSON_CATEGORY;
  }
  return { ok: true, value: out };
}

function normalizeServiceDates(body) {
  const b = body && typeof body === 'object' ? body : {};
  const dates = [];
  if (Array.isArray(b.service_dates)) {
    b.service_dates.forEach((d) => {
      const iso = String(d || '').trim();
      if (iso) dates.push(iso);
    });
  } else if (b.date_from && b.date_to) {
    const from = String(b.date_from).trim();
    const to = String(b.date_to).trim();
    if (!isIsoDate(from) || !isIsoDate(to)) return { ok: false, error: 'date_from/date_to must be YYYY-MM-DD' };
    const start = new Date(from + 'T12:00:00');
    const end = new Date(to + 'T12:00:00');
    if (end < start) return { ok: false, error: 'date_to must be on or after date_from' };
    for (let cur = new Date(start); cur <= end; cur.setDate(cur.getDate() + 1)) {
      dates.push(cur.toISOString().slice(0, 10));
    }
  } else {
    const single = String(b.service_date || '').trim();
    if (!isIsoDate(single)) return { ok: false, error: 'service_date or service_dates is required' };
    dates.push(single);
  }
  const unique = [...new Set(dates)];
  if (!unique.length) return { ok: false, error: 'at least one service date is required' };
  if (unique.length > 31) return { ok: false, error: 'too many service dates (max 31)' };
  for (const iso of unique) {
    if (!isIsoDate(iso)) return { ok: false, error: 'service_dates must be YYYY-MM-DD' };
  }
  return { ok: true, value: unique };
}

function validateScheduleBookingBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const guest_name = String(b.guest_name || '').trim();
  if (!guest_name || guest_name.length > 200) {
    return { ok: false, error: 'guest_name is required (max 200 chars)' };
  }
  const components = normalizeComponents(b);
  if (!components.ok) return components;
  const serviceDates = normalizeServiceDates(b);
  if (!serviceDates.ok) return serviceDates;
  const payment_status = String(b.payment_status || 'unpaid').trim().toLowerCase();
  if (!UI_PAYMENT_STATUSES.has(payment_status)) {
    return { ok: false, error: 'payment_status must be unpaid or paid' };
  }
  const notes = b.notes != null ? String(b.notes).trim().slice(0, 2000) : '';
  const needs_reply = b.needs_reply === true || b.needs_reply === 'true' || b.needs_reply === 1;
  const idempotency_key = b.idempotency_key != null ? String(b.idempotency_key).trim().slice(0, 120) : '';
  const phoneRaw = b.phone_number != null ? b.phone_number : (b.guest_phone != null ? b.guest_phone : b.phone);
  const guest_phone = phoneRaw != null ? String(phoneRaw).trim().slice(0, 40) : '';

  return {
    ok: true,
    value: {
      guest_name,
      guest_phone: guest_phone || null,
      components: components.value,
      service_dates: serviceDates.value,
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

function componentList(components) {
  return Object.keys(components || {});
}

function scheduleRowFromDb(row) {
  const dbType = String(row.service_type || '').toLowerCase();
  const uiType = row.staff_ui_service_type || DB_TO_UI_SERVICE_TYPE[dbType] || dbType;
  const isLesson = dbType === 'surf_lesson' || uiType === 'lesson';
  let payment = String(row.payment_status || '').toLowerCase();
  if (payment === 'pending' || payment === 'not_requested') payment = 'unpaid';
  const metaComponents = row.metadata_components ? String(row.metadata_components).split(',').filter(Boolean) : null;

  return {
    _scheduleId: String(row.service_record_id || row.id || ''),
    _isDbManual: row.record_source === DB_SOURCE && (row.metadata_source === METADATA_SOURCE_TAG || row.staff_manual_schedule === true || (row.metadata_source == null && row.staff_ui_service_type)),
    _isDemo: false,
    _isLuna: row.record_source === 'luna_guest' || row.record_source === 'stripe',
    record_source: row.record_source || null,
    guest_name: row.guest_name || null,
    phone: row.phone || null,
    service_type: uiType,
    service_date: row.service_date,
    slot_time: row.slot_time || null,
    quantity: row.quantity != null ? Number(row.quantity) : 1,
    payment_status: payment,
    booking_code: row.booking_code || null,
    booking_id: row.booking_id || null,
    notes: row.notes || null,
    lesson_category: row.lesson_category || null,
    components: metaComponents,
    bundle_id: row.bundle_id || null,
    _needsReply: row.needs_reply === true || row.needs_reply === 't',
    _scheduleType: isLesson ? 'lesson' : 'rental',
    service_record_id: row.service_record_id || row.id || null,
  };
}

async function findIdempotentBooking(pg, clientSlug, idempotencyKey) {
  if (!idempotencyKey) return null;
  const res = await pg.query(
    `SELECT sr.id::text AS service_record_id,
            sr.booking_id::text AS booking_id,
            sr.booking_code,
            sr.guest_name,
            b.phone AS phone,
            sr.service_type::text AS service_type,
            sr.service_date::text AS service_date,
            sr.quantity,
            sr.payment_status::text AS payment_status,
            sr.source AS record_source,
            sr.metadata->>'slot_time' AS slot_time,
            sr.metadata->>'notes' AS notes,
            COALESCE((sr.metadata->>'needs_reply')::boolean, false) AS needs_reply,
            sr.metadata->>'staff_ui_service_type' AS staff_ui_service_type,
            sr.metadata->>'source' AS metadata_source,
            sr.metadata->>'lesson_category' AS lesson_category,
            sr.metadata->>'bundle_id' AS bundle_id,
            sr.metadata->>'components' AS metadata_components
       FROM booking_service_records sr
      INNER JOIN bookings b ON b.id = sr.booking_id
      WHERE sr.client_slug = $1
        AND sr.metadata->>'idempotency_key' = $2
      ORDER BY sr.service_date, sr.id
      LIMIT 50`,
    [clientSlug, idempotencyKey],
  );
  return res.rows.length ? res.rows : null;
}

async function insertServiceRecord(pg, params) {
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
               metadata->>'source' AS metadata_source,
               metadata->>'lesson_category' AS lesson_category,
               metadata->>'bundle_id' AS bundle_id,
               metadata->>'components' AS metadata_components`,
    params,
  );
  return svcIns.rows[0];
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
    const existingRows = await findIdempotentBooking(pg, clientSlug, input.idempotency_key);
    if (existingRows && existingRows.length) {
      return {
        ok: true,
        status: 200,
        body: {
          success: true,
          idempotent: true,
          booking_code: existingRows[0].booking_code,
          booking_id: existingRows[0].booking_id,
          records: existingRows.map(scheduleRowFromDb),
          booking: scheduleRowFromDb(existingRows[0]),
        },
      };
    }
  }

  const clientRes = await pg.query('SELECT id FROM clients WHERE slug = $1 LIMIT 1', [clientSlug]);
  if (clientRes.rows.length === 0) {
    return { ok: false, status: 500, body: { success: false, error: 'sunset client not found' } };
  }
  const clientId = clientRes.rows[0].id;

  const srPayment = UI_TO_SR_PAYMENT[input.payment_status];
  const bookingPayment = UI_TO_BOOKING_PAYMENT[input.payment_status];
  const bookingStatus = bookingStatusFromPayment(input.payment_status);
  const bookingCode = generateSunsetManualBookingCode();
  const bundleId = crypto.randomBytes(8).toString('hex');
  const componentKeys = componentList(input.components);
  const guestCount = input.components.lesson ? input.components.lesson.quantity : Math.max(...componentKeys.map((k) => input.components[k].quantity));

  await pg.query('BEGIN');
  try {
    const firstDate = input.service_dates[0];
    const bookingIns = await pg.query(
      `INSERT INTO bookings (
         client_id, booking_code, guest_name, phone, status, payment_status,
         check_in, check_out, guest_count, metadata
       ) VALUES (
         $1::uuid, $2, $3, NULLIF($4, ''), $5::booking_status, $6::payment_status,
         $7::date, ($7::date + INTERVAL '1 day')::date, $8, $9::jsonb
       )
       RETURNING id::text AS id, booking_code`,
      [
        clientId,
        bookingCode,
        input.guest_name,
        input.guest_phone || '',
        bookingStatus,
        bookingPayment,
        firstDate,
        guestCount,
        JSON.stringify({
          source: METADATA_SOURCE_TAG,
          staff_manual_schedule: true,
          bundle_id: bundleId,
          components: componentKeys,
          guest_phone: input.guest_phone || null,
        }),
      ],
    );
    const bookingId = bookingIns.rows[0].id;
    const createdRows = [];

    for (const serviceDate of input.service_dates) {
      for (const componentKey of componentKeys) {
        const part = input.components[componentKey];
        const dbServiceType = UI_TO_DB_SERVICE_TYPE[componentKey];
        const metadata = {
          source: METADATA_SOURCE_TAG,
          staff_manual_schedule: true,
          staff_ui_service_type: componentKey === 'lesson' ? 'lesson' : (componentKey === 'surfboard' ? 'board_rental' : 'wetsuit_rental'),
          component: componentKey,
          components: componentKeys,
          bundle_id: bundleId,
          slot_time: componentKey === 'lesson' ? part.slot_time : null,
          lesson_category: componentKey === 'lesson' ? part.category : null,
          notes: input.notes || null,
          needs_reply: input.needs_reply,
          created_by_staff: opts.actor && opts.actor.email ? opts.actor.email : null,
          idempotency_key: input.idempotency_key,
        };
        const row = await insertServiceRecord(pg, [
          clientSlug,
          bookingId,
          bookingCode,
          input.guest_name,
          dbServiceType,
          serviceDate,
          part.quantity,
          srPayment,
          DB_SOURCE,
          JSON.stringify(metadata),
        ]);
        createdRows.push(row);
      }
    }

    await pg.query('COMMIT');
    return {
      ok: true,
      status: 201,
      body: {
        success: true,
        booking_code: bookingCode,
        booking_id: bookingId,
        records: createdRows.map(scheduleRowFromDb),
        booking: scheduleRowFromDb(createdRows[0]),
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
  DEFAULT_LESSON_CATEGORY,
  UI_COMPONENT_KEYS,
  LEGACY_UI_SERVICE_TYPES,
  validateScheduleBookingBody,
  generateSunsetManualBookingCode,
  scheduleRowFromDb,
  createSunsetScheduleBooking,
};

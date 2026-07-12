'use strict';

/**
 * Sunset Schedule — booking drawer context, payment summary, and updates.
 * Sunset client only. Totals computed live from Admin config unless amount_due_cents stored.
 */

const crypto = require('crypto');
const {
  normalizeSunsetLocationId,
  resolveRecordLocationId,
  attachLocationToMetadata,
} = require('./sunset-school-locations');

const { resolveTenantBusinessConfigAsync, resolveTenantBusinessConfig } = require('./tenant-business-config');
const {
  SUNSET_CLIENT_SLUG,
  METADATA_SOURCE_TAG,
  DB_SOURCE,
  UI_TO_DB_SERVICE_TYPE,
  DB_TO_UI_SERVICE_TYPE,
  UI_TO_SR_PAYMENT,
  UI_TO_BOOKING_PAYMENT,
  validateScheduleBookingBody,
  bookingStatusFromPayment,
  componentList,
  insertServiceRecord,
} = require('./sunset-schedule-booking-writes');

const { serviceRecordUnitPriceCents } = require('./sunset-stripe-payment-links');

const { loadPrivateLessonFromDb, defaultPrivateLessonApi } = require('./sunset-admin-private-lesson-rules');

function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || '').trim());
}

function parseMeta(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function normalizeUiPayment(ps) {
  const p = String(ps || '').toLowerCase();
  if (p === 'paid' || p === 'complete' || p === 'completed') return 'paid';
  return 'unpaid';
}

// Safe allowlist of paid-method labels stored in booking metadata (does not affect payment math).
const PAYMENT_METHOD_VALUES = new Set(['bank_transfer', 'in_store', 'link']);
function normalizePaymentMethod(m) {
  const v = String(m || '').toLowerCase().trim();
  return PAYMENT_METHOD_VALUES.has(v) ? v : null;
}

function staffUiServiceType(componentKey) {
  if (componentKey === 'lesson') return 'lesson';
  if (componentKey === 'course') return 'course';
  if (componentKey === 'private_lesson') return 'private_lesson';
  if (componentKey === 'surfboard') return 'board_rental';
  return 'wetsuit_rental';
}

function resolveGuestCount(components) {
  if (components.private_lesson) return components.private_lesson.surfer_count;
  if (components.lesson) return components.lesson.quantity;
  if (components.course) return components.course.quantity;
  const keys = componentList(components);
  return Math.max(...keys.map((k) => components[k].quantity));
}

function bookingHeaderDates(input) {
  const dates = input.service_dates.slice();
  if (input.components.private_lesson) {
    input.components.private_lesson.sessions.forEach((s) => dates.push(s.date));
  }
  const sorted = [...new Set(dates)].sort();
  return { firstDate: sorted[0], lastDate: sorted[sorted.length - 1] };
}
function formatSunsetDrawerDailyItemLabel(dbType, qty, sr) {
  const meta = parseMeta(sr && sr.metadata);
  const component = String(meta.component || sr?.metadata_component || '').toLowerCase();
  const q = Number(qty) || 1;
  const sep = ' · ';
  if (component === 'course') {
    const name = meta.course_label || sr?.course_label;
    if (name) return `${name}${sep}${q}`;
    const map = DB_TO_UI_SERVICE_TYPE || {};
    return `${map[dbType] || dbType || 'Course'}${sep}${q}`;
  }
  if (component === 'private_lesson') {
    const name = meta.private_lesson_label || 'Private Course';
    return `${name}${sep}${q}`;
  }
  if (dbType === 'surfboard') return `Surfboard${sep}${q}`;
  if (dbType === 'wetsuit') return `Wetsuit${sep}${q}`;
  const map = DB_TO_UI_SERVICE_TYPE || {};
  const ui = map[dbType] || dbType;
  if (ui === 'lesson' || dbType === 'surf_lesson') {
    const name = meta.course_label || sr?.course_label || 'Group Course';
    return `${name}${sep}${q}`;
  }
  return `${ui || 'Item'}${sep}${q}`;
}

function lineItemLabel(dbType, qty, dateIso, slotTime, sr) {
  return formatSunsetDrawerDailyItemLabel(dbType, qty, sr);
}

async function loadSunsetBookingBundle(pg, clientSlug, bookingId, bookingCode) {
  const bookingRes = await pg.query(
    `SELECT b.id::text AS booking_id, b.booking_code, b.guest_name, b.phone,
            b.status::text AS status, b.payment_status::text AS payment_status,
            b.check_in::text AS check_in, b.check_out::text AS check_out,
            b.guest_count, b.total_amount_cents, b.amount_paid_cents, b.balance_due_cents,
            b.metadata
       FROM bookings b
       INNER JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1
        AND ${bookingId ? 'b.id = $2::uuid' : 'b.booking_code = $2'}
      LIMIT 1`,
    [clientSlug, bookingId || bookingCode],
  );
  const booking = bookingRes.rows[0];
  if (!booking) return null;
  const svcRes = await pg.query(
    `SELECT id::text AS service_record_id, service_type::text AS service_type,
            service_date::text AS service_date, quantity,
            amount_due_cents, amount_paid_cents, payment_status::text AS payment_status,
            metadata->>'slot_time' AS slot_time, metadata->>'notes' AS notes,
            metadata->>'staff_ui_service_type' AS staff_ui_service_type,
            metadata->>'component' AS metadata_component,
            metadata->>'components' AS metadata_components,
            metadata->>'location_id' AS location_id,
            metadata->>'source' AS metadata_source,
            metadata->>'staff_manual_schedule' AS staff_manual_schedule,
            metadata->>'course_id' AS course_id,
            metadata->>'course_label' AS course_label,
            service_time_local,
            service_time_local_end,
            metadata
       FROM booking_service_records
      WHERE client_slug = $1 AND booking_id = $2::uuid
      ORDER BY service_date, id`,
    [clientSlug, booking.booking_id],
  );
  const payRes = await pg.query(
    `SELECT id::text AS payment_id, status::text AS payment_status,
            amount_due_cents, amount_paid_cents, checkout_url, created_at
       FROM payments
      WHERE booking_id = $1::uuid AND checkout_url IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    [booking.booking_id],
  );
  const paidSumRes = await pg.query(
    `SELECT COALESCE(SUM(amount_paid_cents), 0)::int AS paid_total
       FROM payments
      WHERE booking_id = $1::uuid
        AND status = 'paid'::payment_record_status`,
    [booking.booking_id],
  );
  const payments_paid_cents = Number(paidSumRes.rows[0]?.paid_total || 0);
  return {
    booking,
    services: svcRes.rows,
    payment_link: payRes.rows[0] || null,
    payments_paid_cents,
  };
}

function aggregateComponentsFromServices(services) {
  const components = {};
  let slotTime = null;
  const dates = new Set();
  const privateSessions = [];
  (services || []).forEach((sr) => {
    dates.add(String(sr.service_date || '').slice(0, 10));
    const meta = parseMeta(sr.metadata);
    const component = String(meta.component || sr.metadata_component || '').toLowerCase();
    const ui = sr.staff_ui_service_type || DB_TO_UI_SERVICE_TYPE[String(sr.service_type || '').toLowerCase()] || component;
    if (component === 'private_lesson' || ui === 'private_lesson') {
      privateSessions.push({
        date: String(sr.service_date || '').slice(0, 10),
        start: sr.service_time_local || sr.slot_time || meta.slot_time || '10:00',
        end: sr.service_time_local_end || '',
      });
      if (!components.private_lesson) {
        components.private_lesson = {
          enabled: true,
          quantity: 0,
          surfer_count: Number(sr.quantity) || 1,
          sessions: [],
        };
      }
      components.private_lesson.quantity += 1;
      components.private_lesson.surfer_count = Number(sr.quantity) || components.private_lesson.surfer_count;
      return;
    }
    let key = ui === 'board_rental' ? 'surfboard'
      : (ui === 'wetsuit_rental' ? 'wetsuit' : (ui === 'course' || component === 'course' ? 'course' : ui));
    if (key === 'lesson' && (meta.course_id || sr.course_id)) key = 'course';
    if (!components[key]) {
      components[key] = {
        quantity: Number(sr.quantity) || 1,
        slot_time: sr.slot_time || null,
      };
    }
    if (key === 'course') {
      components[key].course_id = meta.course_id || sr.course_id || components[key].course_id || null;
      components[key].course_label = meta.course_label || sr.course_label || components[key].course_label || null;
    }
    if (key === 'lesson') slotTime = sr.slot_time || slotTime;
  });
  if (components.private_lesson) {
    components.private_lesson.sessions = privateSessions.sort((a, b) => a.date.localeCompare(b.date));
    components.private_lesson.quantity = components.private_lesson.sessions.length || components.private_lesson.quantity;
  }
  const sortedDates = [...dates].filter(Boolean).sort();
  return {
    components,
    date_from: sortedDates[0] || null,
    date_to: sortedDates[sortedDates.length - 1] || sortedDates[0] || null,
    slot_time: slotTime,
  };
}

function deriveDrawerPaymentUiStatus(booking, subtotalCents, paidCents) {
  const paid = Number(paidCents) || 0;
  const subtotal = Number(subtotalCents) || 0;
  if (paid > 0 && (subtotal === 0 || paid >= subtotal)) return 'paid';
  const raw = String(booking && booking.payment_status || '').toLowerCase();
  if (raw === 'paid' || raw === 'complete' || raw === 'completed') return 'paid';
  return 'unpaid';
}

function buildPaymentSummary(prices, booking, services, adminSource, paymentsPaidCents) {
  const lineItems = [];
  let subtotalCents = 0;
  (services || []).forEach((sr) => {
    let lineCents = Number(sr.amount_due_cents) || 0;
    const liveUnit = serviceRecordUnitPriceCents(prices, sr);
    const usedLive = lineCents <= 0 && liveUnit != null;
    if (usedLive) lineCents = liveUnit;
    subtotalCents += lineCents;
    lineItems.push({
      service_record_id: sr.service_record_id,
      service_type: sr.service_type,
      service_date: sr.service_date,
      quantity: Number(sr.quantity) || 1,
      unit_cents: liveUnit != null && Number(sr.quantity) ? Math.round(lineCents / (Number(sr.quantity) || 1)) : null,
      line_cents: lineCents,
      label: lineItemLabel(sr.service_type, sr.quantity, sr.service_date, sr.slot_time, sr),
      priced_live: usedLive,
    });
  });
  const storedPaid = Number(booking.amount_paid_cents);
  const ledgerPaid = Number(paymentsPaidCents);
  const paidCents = Math.max(
    Number.isFinite(storedPaid) ? storedPaid : 0,
    Number.isFinite(ledgerPaid) ? ledgerPaid : 0,
  );
  const uiStatus = deriveDrawerPaymentUiStatus(booking, subtotalCents, paidCents);
  const balanceDue = Math.max(subtotalCents - paidCents, 0);
  const meta = parseMeta(booking.metadata);
  return {
    line_items: lineItems,
    subtotal_cents: subtotalCents,
    total_cents: subtotalCents,
    paid_cents: paidCents,
    balance_due_cents: uiStatus === 'paid' ? 0 : balanceDue,
    payment_status: uiStatus,
    price_source: adminSource || meta.sunset_price_source || 'config',
    live_pricing: lineItems.some((li) => li.priced_live),
    pricing_note: 'Totals use current Admin prices when line amounts are not stored.',
  };
}

function resolveBundleLocationId(bundle) {
  const meta = parseMeta(bundle && bundle.booking && bundle.booking.metadata);
  let recordLocationId = normalizeSunsetLocationId(meta.location_id || null);
  (bundle && bundle.services || []).some((sr) => {
    const srLoc = sr && sr.location_id;
    if (srLoc) {
      recordLocationId = normalizeSunsetLocationId(srLoc);
      return true;
    }
    return false;
  });
  return recordLocationId;
}

function serviceRecordIsStaffManual(sr) {
  if (!sr) return false;
  if (sr.metadata_source === METADATA_SOURCE_TAG) return true;
  const flag = sr.staff_manual_schedule;
  return flag === true || flag === 'true' || flag === 't';
}

function bundleIsStaffManualSchedule(bundle) {
  const meta = parseMeta(bundle && bundle.booking && bundle.booking.metadata);
  if (meta.source === METADATA_SOURCE_TAG || meta.staff_manual_schedule) return true;
  return (bundle && bundle.services || []).some(serviceRecordIsStaffManual);
}

async function getSunsetScheduleBookingDrawerContext(pg, opts) {
  const clientSlug = String(opts.clientSlug || '').trim();
  if (clientSlug !== SUNSET_CLIENT_SLUG) {
    return { ok: false, status: 403, body: { success: false, error: 'unsupported_client' } };
  }
  const bookingId = String(opts.bookingId || '').trim();
  const bookingCode = String(opts.bookingCode || '').trim();
  if (!bookingId && !bookingCode) {
    return { ok: false, status: 400, body: { success: false, error: 'booking_id or booking_code is required' } };
  }
  if (bookingId && !isUuid(bookingId)) {
    return { ok: false, status: 400, body: { success: false, error: 'invalid booking_id' } };
  }

  const bundle = await loadSunsetBookingBundle(pg, clientSlug, bookingId, bookingCode);
  if (!bundle) {
    return { ok: false, status: 404, body: { success: false, error: 'booking not found' } };
  }
  const meta = parseMeta(bundle.booking.metadata);
  const activeLocationId = normalizeSunsetLocationId(opts.locationId);
  const recordLocationId = resolveBundleLocationId(bundle);
  if (recordLocationId !== activeLocationId) {
    return { ok: false, status: 404, body: { success: false, error: 'booking_not_in_active_school' } };
  }
  if (!bundleIsStaffManualSchedule(bundle)) {
    return { ok: false, status: 403, body: { success: false, error: 'drawer_edits_limited_to_staff_manual_schedule' } };
  }

  let adminCfg;
  try {
    adminCfg = await resolveTenantBusinessConfigAsync(clientSlug, { locationId: activeLocationId });
  } catch (err) {
    console.error('[schedule drawer] config load failed:', err && err.message);
    adminCfg = resolveTenantBusinessConfig(clientSlug, activeLocationId);
  }
  const prices = adminCfg.ok ? (adminCfg.prices || []) : [];
  const agg = aggregateComponentsFromServices(bundle.services);
  const payment = buildPaymentSummary(
    prices,
    bundle.booking,
    bundle.services,
    adminCfg.source,
    bundle.payments_paid_cents,
  );
  const link = bundle.payment_link;
  const linkStale = !!meta.sunset_stripe_link_stale
    || (link && link.amount_due_cents != null && Number(link.amount_due_cents) !== payment.balance_due_cents);

  return {
    ok: true,
    status: 200,
    body: {
      success: true,
      booking_id: bundle.booking.booking_id,
      booking_code: bundle.booking.booking_code,
      guest_name: bundle.booking.guest_name,
      phone: bundle.booking.phone || meta.guest_phone || null,
      notes: bundle.services[0] && bundle.services[0].notes ? bundle.services[0].notes : null,
      payment_status: payment.payment_status,
      payment_method: payment.payment_status === 'paid' ? (normalizePaymentMethod(meta.sunset_payment_method) || null) : null,
      date_from: agg.date_from,
      date_to: agg.date_to,
      components: agg.components,
      slot_time: agg.slot_time,
      payment,
      stripe_link: link ? {
        payment_id: link.payment_id,
        payment_status: link.payment_status,
        amount_due_cents: Number(link.amount_due_cents),
        checkout_url: link.checkout_url,
        stale: linkStale,
      } : null,
      stripe_link_stale: linkStale,
      editable: true,
      location_id: recordLocationId,
    },
  };
}

async function updateSunsetScheduleBooking(pg, opts) {
  const clientSlug = String(opts.clientSlug || '').trim();
  if (clientSlug !== SUNSET_CLIENT_SLUG) {
    return { ok: false, status: 403, body: { success: false, error: 'unsupported_client' } };
  }
  const bookingId = String(opts.bookingId || opts.body?.booking_id || '').trim();
  if (!bookingId || !isUuid(bookingId)) {
    return { ok: false, status: 400, body: { success: false, error: 'booking_id is required' } };
  }

  const bundle = await loadSunsetBookingBundle(pg, clientSlug, bookingId, null);
  if (!bundle) {
    return { ok: false, status: 404, body: { success: false, error: 'booking not found' } };
  }
  const meta = parseMeta(bundle.booking.metadata);
  const activeLocationId = normalizeSunsetLocationId(opts.locationId);
  const recordLocationId = resolveBundleLocationId(bundle);
  if (recordLocationId !== activeLocationId) {
    return { ok: false, status: 404, body: { success: false, error: 'booking_not_in_active_school' } };
  }
  if (!bundleIsStaffManualSchedule(bundle)) {
    return { ok: false, status: 403, body: { success: false, error: 'updates_limited_to_staff_manual_schedule' } };
  }

  const validated = validateScheduleBookingBody({
    ...opts.body,
    guest_name: opts.body?.guest_name ?? bundle.booking.guest_name,
  });
  if (!validated.ok) {
    return { ok: false, status: 400, body: { success: false, error: validated.error } };
  }
  const input = validated.value;
  const phoneRaw = opts.body?.guest_phone ?? opts.body?.phone_number ?? opts.body?.phone;
  const guest_phone = phoneRaw != null ? String(phoneRaw).trim().slice(0, 40) : (bundle.booking.phone || '');

  const srPayment = UI_TO_SR_PAYMENT[input.payment_status];
  const bookingPayment = UI_TO_BOOKING_PAYMENT[input.payment_status];
  const bookingStatus = bookingStatusFromPayment(input.payment_status);
  // Paid-method label (bank_transfer | in_store | link) stored in metadata; null when unpaid.
  const paymentMethod = input.payment_status === 'paid'
    ? normalizePaymentMethod(opts.body && opts.body.payment_method)
    : null;
  const componentKeys = componentList(input.components);
  const guestCount = resolveGuestCount(input.components);
  const bundleId = meta.bundle_id || crypto.randomBytes(8).toString('hex');
  const { firstDate, lastDate } = bookingHeaderDates(input);

  let privateLessonConfig = defaultPrivateLessonApi();
  if (input.components.private_lesson) {
    const plLoad = await loadPrivateLessonFromDb(pg, { clientSlug, locationId: recordLocationId });
    privateLessonConfig = plLoad.api || privateLessonConfig;
  }

  await pg.query('BEGIN');
  try {
    await pg.query(
      `UPDATE bookings
          SET guest_name = $1,
              phone = NULLIF($2, ''),
              status = $3::booking_status,
              payment_status = $4::payment_status,
              check_in = $5::date,
              check_out = ($6::date + INTERVAL '1 day')::date,
              guest_count = $7,
              metadata = COALESCE(metadata, '{}'::jsonb) || $8::jsonb
        WHERE id = $9::uuid`,
      [
        input.guest_name,
        guest_phone,
        bookingStatus,
        bookingPayment,
        firstDate,
        lastDate,
        guestCount,
        JSON.stringify(attachLocationToMetadata({
          guest_phone: guest_phone || null,
          bundle_id: bundleId,
          components: componentKeys,
          sunset_payment_method: paymentMethod,
          sunset_stripe_link_stale: true,
          sunset_updated_at: new Date().toISOString(),
        }, recordLocationId)),
        bookingId,
      ],
    );

    await pg.query(
      `DELETE FROM booking_service_records
        WHERE client_slug = $1 AND booking_id = $2::uuid AND source = $3`,
      [clientSlug, bookingId, DB_SOURCE],
    );

    const createdRows = [];

    if (input.components.private_lesson) {
      const pl = input.components.private_lesson;
      const plLabel = pl.label || privateLessonConfig.label || 'Private Course';
      for (const session of pl.sessions) {
        const srMeta = attachLocationToMetadata({
          source: METADATA_SOURCE_TAG,
          staff_manual_schedule: true,
          staff_ui_service_type: 'private_lesson',
          component: 'private_lesson',
          components: componentKeys,
          bundle_id: bundleId,
          slot_time: session.start,
          private_lesson_label: plLabel,
          private_lesson_session_index: session.index,
          private_lesson_session_count: pl.quantity,
          price_basis: privateLessonConfig.price_basis || 'per_session',
          unit_amount_cents: privateLessonConfig.amount_cents || 0,
          default_duration_minutes: privateLessonConfig.default_duration_minutes || 120,
          notes: input.notes || null,
          needs_reply: input.needs_reply,
          updated_by_staff: opts.actor && opts.actor.email ? opts.actor.email : null,
        }, recordLocationId);
        const row = await insertServiceRecord(pg, [
          clientSlug,
          bookingId,
          bundle.booking.booking_code,
          input.guest_name,
          UI_TO_DB_SERVICE_TYPE.private_lesson,
          session.date,
          pl.surfer_count,
          srPayment,
          DB_SOURCE,
          JSON.stringify(srMeta),
        ], {
          service_time_local: session.start,
          service_time_local_end: session.end,
        });
        createdRows.push(row);
      }
    }

    for (const serviceDate of input.service_dates) {
      for (const componentKey of componentKeys) {
        if (componentKey === 'private_lesson') continue;
        const part = input.components[componentKey];
        const dbServiceType = UI_TO_DB_SERVICE_TYPE[componentKey];
        const srMeta = attachLocationToMetadata({
          source: METADATA_SOURCE_TAG,
          staff_manual_schedule: true,
          staff_ui_service_type: staffUiServiceType(componentKey),
          component: componentKey,
          components: componentKeys,
          bundle_id: bundleId,
          slot_time: componentKey === 'lesson' ? part.slot_time : null,
          lesson_category: componentKey === 'lesson' ? part.category : null,
          course_id: componentKey === 'course' ? part.course_id : null,
          course_label: componentKey === 'course' ? part.course_label : null,
          notes: input.notes || null,
          needs_reply: input.needs_reply,
          updated_by_staff: opts.actor && opts.actor.email ? opts.actor.email : null,
        }, recordLocationId);
        const row = await insertServiceRecord(pg, [
          clientSlug,
          bookingId,
          bundle.booking.booking_code,
          input.guest_name,
          dbServiceType,
          serviceDate,
          part.quantity,
          srPayment,
          DB_SOURCE,
          JSON.stringify(srMeta),
        ]);
        createdRows.push(row);
      }
    }

    if (input.payment_status === 'paid') {
      await pg.query(
        `UPDATE bookings SET amount_paid_cents = COALESCE(total_amount_cents, 0), balance_due_cents = 0 WHERE id = $1::uuid`,
        [bookingId],
      );
    }

    await pg.query('COMMIT');
    const ctx = await getSunsetScheduleBookingDrawerContext(pg, { clientSlug, bookingId });
    return {
      ok: true,
      status: 200,
      body: {
        success: true,
        booking_id: bookingId,
        booking_code: bundle.booking.booking_code,
        records: createdRows,
        context: ctx.ok ? ctx.body : null,
        stripe_link_stale: true,
      },
    };
  } catch (err) {
    await pg.query('ROLLBACK');
    throw err;
  }
}

// Soft-delete a staff-created schedule booking: mark the booking + its service records cancelled
// so they drop off the schedule (the day query filters out cancelled bookings/records).
async function cancelSunsetScheduleBooking(pg, opts) {
  const clientSlug = String(opts.clientSlug || '').trim();
  if (clientSlug !== SUNSET_CLIENT_SLUG) {
    return { ok: false, status: 403, body: { success: false, error: 'unsupported_client' } };
  }
  const bookingId = String(opts.bookingId || opts.body?.booking_id || '').trim();
  if (!bookingId || !isUuid(bookingId)) {
    return { ok: false, status: 400, body: { success: false, error: 'booking_id is required' } };
  }
  const bundle = await loadSunsetBookingBundle(pg, clientSlug, bookingId, null);
  if (!bundle) {
    return { ok: false, status: 404, body: { success: false, error: 'booking not found' } };
  }
  const activeLocationId = normalizeSunsetLocationId(opts.locationId);
  if (resolveBundleLocationId(bundle) !== activeLocationId) {
    return { ok: false, status: 404, body: { success: false, error: 'booking_not_in_active_school' } };
  }
  if (!bundleIsStaffManualSchedule(bundle)) {
    return { ok: false, status: 403, body: { success: false, error: 'delete_limited_to_staff_manual_schedule' } };
  }
  await pg.query('BEGIN');
  try {
    await pg.query(
      `UPDATE booking_service_records SET status = 'cancelled'
        WHERE client_slug = $1 AND booking_id = $2::uuid AND status <> 'cancelled'`,
      [clientSlug, bookingId],
    );
    await pg.query(
      `UPDATE bookings
          SET status = 'cancelled'::booking_status,
              metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
        WHERE id = $2::uuid`,
      [JSON.stringify({ cancelled_by_staff: true, cancelled_at: new Date().toISOString() }), bookingId],
    );
    await pg.query('COMMIT');
    return {
      ok: true,
      status: 200,
      body: { success: true, deleted: true, booking_id: bookingId, booking_code: bundle.booking.booking_code },
    };
  } catch (err) {
    await pg.query('ROLLBACK');
    throw err;
  }
}

module.exports = {
  getSunsetScheduleBookingDrawerContext,
  updateSunsetScheduleBooking,
  cancelSunsetScheduleBooking,
  buildPaymentSummary,
  deriveDrawerPaymentUiStatus,
  aggregateComponentsFromServices,
  normalizePaymentMethod,
  formatSunsetDrawerDailyItemLabel,
};

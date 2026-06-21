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

const { resolveTenantBusinessConfigAsync } = require('./tenant-business-config');
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

function lineItemLabel(dbType, qty, dateIso, slotTime) {
  const ui = DB_TO_UI_SERVICE_TYPE[dbType] || dbType;
  const q = Number(qty) || 1;
  const d = String(dateIso || '').slice(0, 10);
  if (ui === 'lesson' || dbType === 'surf_lesson') {
    return `Lesson · ${q} surfer${q !== 1 ? 's' : ''} · ${slotTime || '—'} · ${d}`;
  }
  if (dbType === 'surfboard') return `Surfboard · ${q} · ${d}`;
  if (dbType === 'wetsuit') return `Wetsuit · ${q} · ${d}`;
  return `${ui} · ${q} · ${d}`;
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
            metadata->>'components' AS metadata_components
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
  return { booking, services: svcRes.rows, payment_link: payRes.rows[0] || null };
}

function aggregateComponentsFromServices(services) {
  const components = {};
  let slotTime = null;
  const dates = new Set();
  (services || []).forEach((sr) => {
    dates.add(String(sr.service_date || '').slice(0, 10));
    const dbType = String(sr.service_type || '').toLowerCase();
    const ui = sr.staff_ui_service_type || DB_TO_UI_SERVICE_TYPE[dbType] || dbType;
    const key = ui === 'board_rental' ? 'surfboard' : (ui === 'wetsuit_rental' ? 'wetsuit' : ui);
    if (!components[key]) {
      components[key] = {
        quantity: Number(sr.quantity) || 1,
        slot_time: sr.slot_time || null,
      };
    }
    if (key === 'lesson') slotTime = sr.slot_time || slotTime;
  });
  const sortedDates = [...dates].filter(Boolean).sort();
  return {
    components,
    date_from: sortedDates[0] || null,
    date_to: sortedDates[sortedDates.length - 1] || sortedDates[0] || null,
    slot_time: slotTime,
  };
}

function buildPaymentSummary(prices, booking, services, adminSource) {
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
      label: lineItemLabel(sr.service_type, sr.quantity, sr.service_date, sr.slot_time),
      priced_live: usedLive,
    });
  });
  const storedPaid = Number(booking.amount_paid_cents);
  const paidCents = Number.isFinite(storedPaid) ? storedPaid : 0;
  const uiStatus = normalizeUiPayment(booking.payment_status);
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
  const recordLocationId = resolveRecordLocationId(
    parseMeta((bundle.services[0] && bundle.services[0].metadata) || {}),
    meta,
  );
  if (recordLocationId !== activeLocationId) {
    return { ok: false, status: 404, body: { success: false, error: 'booking_not_in_active_school' } };
  }
  if (meta.source !== METADATA_SOURCE_TAG && !meta.staff_manual_schedule) {
    return { ok: false, status: 403, body: { success: false, error: 'drawer_edits_limited_to_staff_manual_schedule' } };
  }

  const adminCfg = await resolveTenantBusinessConfigAsync(clientSlug, { pgClient: pg });
  const prices = adminCfg.ok ? (adminCfg.prices || []) : [];
  const agg = aggregateComponentsFromServices(bundle.services);
  const payment = buildPaymentSummary(prices, bundle.booking, bundle.services, adminCfg.source);
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
  const recordLocationId = resolveRecordLocationId(
    parseMeta((bundle.services[0] && bundle.services[0].metadata) || {}),
    meta,
  );
  if (recordLocationId !== activeLocationId) {
    return { ok: false, status: 404, body: { success: false, error: 'booking_not_in_active_school' } };
  }
  if (meta.source !== METADATA_SOURCE_TAG && !meta.staff_manual_schedule) {
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
  const componentKeys = componentList(input.components);
  const guestCount = input.components.lesson
    ? input.components.lesson.quantity
    : Math.max(...componentKeys.map((k) => input.components[k].quantity));
  const bundleId = meta.bundle_id || crypto.randomBytes(8).toString('hex');
  const firstDate = input.service_dates[0];
  const lastDate = input.service_dates[input.service_dates.length - 1];

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
    for (const serviceDate of input.service_dates) {
      for (const componentKey of componentKeys) {
        const part = input.components[componentKey];
        const dbServiceType = UI_TO_DB_SERVICE_TYPE[componentKey];
        const srMeta = attachLocationToMetadata({
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

module.exports = {
  getSunsetScheduleBookingDrawerContext,
  updateSunsetScheduleBooking,
  buildPaymentSummary,
  aggregateComponentsFromServices,
};

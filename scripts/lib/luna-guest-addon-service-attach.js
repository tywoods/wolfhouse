'use strict';

/**
 * Stage 38a — Attach priced guest add-ons to booking_service_records after hold write.
 * Reuses manual-booking row builder; idempotent per booking + service_type + attach origin.
 */

const { normalizeAddOnsForQuote } = require('./luna-booking-addons-policy');
const { computeStayNights } = require('./wolfhouse-package-night-rules');
const { buildManualBookingServiceRecordRows } = require('./manual-booking-service-records');
const { ADDON_ATTACH_ORIGIN, ruleForCode } = require('./luna-guest-addon-service-confirmation-policy');
const { attachPendingManualGuestServices } = require('./luna-guest-pending-service-attach');
const { syncGuestAddonServicePaymentLedger } = require('./luna-guest-addon-service-payment-ledger');

const SERVICE_RECORD_DB_SOURCE = 'luna_guest';

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function readPricingCents(clientSlug, addonCode) {
  try {
    const path = require('path');
    const fs = require('fs');
    const file = path.join(__dirname, '..', '..', 'config', 'clients', `${clientSlug || 'wolfhouse-somo'}.pricing.json`);
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const item = cfg && cfg.add_ons && cfg.add_ons[addonCode];
    if (item && item.pricing_status === 'confirmed' && item.price_cents != null) {
      return Number(item.price_cents);
    }
  } catch (_) { /* optional */ }
  return null;
}

function mapGuestAttachRow(row) {
  const rule = ruleForCode(row.service_type) || ruleForCode(row.service_type === 'meal' ? 'meals' : row.service_type);
  const meta = {
    ...(row.metadata || {}),
    attach_origin: ADDON_ATTACH_ORIGIN,
    paid_now_optional: true,
    settle_at_checkout: true,
    stage: '38a_guest_addon_attach',
    needs_scheduling: rule ? rule.needs_scheduling : false,
    confirmation_mode: rule ? rule.confirmation_mode : 'booked',
  };
  const amountDue = Number(row.amount_due_cents || 0);
  return {
    ...row,
    source: SERVICE_RECORD_DB_SOURCE,
    status: rule && rule.record_status ? rule.record_status : row.status,
    payment_status: amountDue > 0 ? 'pending' : 'not_requested',
    metadata: meta,
  };
}

async function attachPricedGuestAddonServices(pg, opts) {
  const o = opts || {};
  const clientSlug = trimStr(o.clientSlug) || 'wolfhouse-somo';
  const bookingId = trimStr(o.bookingId);
  const bookingCode = trimStr(o.bookingCode);
  const guestName = trimStr(o.guestName) || 'Guest';
  const fields = o.extractedFields || o.fields || {};
  const quote = o.quote || {};

  if (!pg || !bookingId) return { attached_priced_services: [] };

  const nights = computeStayNights(fields.check_in, fields.check_out);
  const addOns = normalizeAddOnsForQuote(fields.service_interest, nights);
  if (!addOns.length) return { attached_priced_services: [] };

  const planned = buildManualBookingServiceRecordRows({
    addOns,
    quote: { line_items: quote.line_items || quote.quote_line_items || [] },
    clientSlug,
    bookingId,
    bookingCode,
    guestName,
    checkIn: fields.check_in,
    guestCount: fields.guest_count,
  }).map(mapGuestAttachRow);

  const attached = [];
  for (const row of planned) {
    const existing = await pg.query(
      `SELECT id::text AS id
         FROM booking_service_records
        WHERE booking_id = $1::uuid
          AND service_type = $2
          AND source = $3
          AND metadata->>'attach_origin' = $4
        LIMIT 1`,
      [bookingId, row.service_type, SERVICE_RECORD_DB_SOURCE, ADDON_ATTACH_ORIGIN],
    );
    if (existing.rows.length) continue;

    await pg.query(
      `INSERT INTO booking_service_records (
         client_slug, booking_id, booking_code, guest_name,
         service_type, service_date, quantity, status,
         amount_due_cents, amount_paid_cents, payment_status,
         source, notes, metadata
       ) VALUES (
         $1, $2::uuid, $3, $4,
         $5, $6, $7, $8,
         $9, 0, $10,
         $11, NULL, $12::jsonb
       )`,
      [
        row.client_slug || clientSlug,
        bookingId,
        row.booking_code || bookingCode,
        row.guest_name || guestName,
        row.service_type,
        row.service_date,
        row.quantity,
        row.status,
        row.amount_due_cents,
        row.payment_status,
        row.source,
        JSON.stringify(row.metadata),
      ],
    );
    attached.push(row.service_type);
  }

  return { attached_priced_services: attached };
}

/**
 * Attach pending manual (yoga/meals) + priced guest add-ons after hold write.
 */
async function attachAllGuestAddonServices(pg, opts) {
  const o = opts || {};
  const clientSlug = trimStr(o.clientSlug) || 'wolfhouse-somo';
  const fields = o.extractedFields || o.fields || {};

  const pending = await attachPendingManualGuestServices(pg, {
    clientSlug,
    bookingId: o.bookingId,
    bookingCode: o.bookingCode,
    guestName: o.guestName,
    extractedFields: fields,
    resultContext: o.resultContext,
    requestChannel: o.requestChannel,
  });

  const priced = await attachPricedGuestAddonServices(pg, {
    ...o,
    extractedFields: fields,
  });

  const yogaMealsUpdated = await enrichPendingManualServiceAmounts(pg, {
    bookingId: o.bookingId,
    clientSlug,
    attachedManual: pending.attached_manual_services || [],
  });

  const ledger = await syncGuestAddonServicePaymentLedger(pg, {
    clientSlug,
    clientId: o.clientId,
    bookingId: o.bookingId,
    bookingCode: o.bookingCode,
    writeSource: o.writeSource,
    // Current Admin rental catalog authority for guest-copy ledger lines.
    locationId: o.locationId || o.location_id || null,
    catalogLabelMap: o.catalogLabelMap || o.catalog_label_map || o.rental_label_map || null,
  });

  return {
    ...pending,
    ...priced,
    enriched_pending_amounts: yogaMealsUpdated,
    service_payment_ledger: ledger,
    attached_all_services: [
      ...(pending.attached_manual_services || []),
      ...(priced.attached_priced_services || []),
    ],
  };
}

async function enrichPendingManualServiceAmounts(pg, opts) {
  const o = opts || {};
  if (!pg || !o.bookingId || !(o.attachedManual || []).length) return [];

  const updated = [];
  for (const svc of o.attachedManual) {
    const serviceType = svc === 'meals' ? 'meal' : svc;
    const addonCode = serviceType === 'meal' ? 'meals' : 'yoga_class';
    const cents = readPricingCents(o.clientSlug, addonCode);
    if (cents == null) continue;

    const res = await pg.query(
      `UPDATE booking_service_records
          SET amount_due_cents = $1,
              payment_status = 'pending',
              metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
        WHERE booking_id = $3::uuid
          AND service_type = $4
          AND source = 'luna_guest'
          AND metadata->>'pending_origin' = 'luna_guest_pending'
          AND amount_due_cents = 0
      RETURNING id::text`,
      [
        cents,
        JSON.stringify({ settle_at_checkout: true, paid_now_optional: true, stage: '38a_pending_manual_amount' }),
        o.bookingId,
        serviceType,
      ],
    );
    if (res.rows.length) updated.push(serviceType);
  }
  return updated;
}

const SUNSET_FULL_DAY_ADDON_KEY = 'full_day_equipment_extension';

function isIsoDate(s) {
  return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(s || '').trim());
}

// Attach the Sunset "Material el resto del día" add-on to an existing booking (per person, per date).
// Fail-closed (ok:false) on: non-Sunset tenant, cross-tenant booking, disabled add-on, ineligible
// booking/date, invalid quantity, missing price. Price is strictly taken from the tool quote — never
// invented here. Writes one addon_service row per date; quantity=people; amount_due_cents snapshotted.
// Idempotent per booking + date (skips a date that already has an add-on row).
async function attachSunsetFullDayEquipmentAddon(pg, opts) {
  const o = opts || {};
  const clientSlug = trimStr(o.clientSlug);
  if (clientSlug !== 'sunset') return { ok: false, reason: 'invalid_tenant', received_tenant: clientSlug || null };
  const bookingId = trimStr(o.bookingId);
  if (!pg || !bookingId) return { ok: false, reason: 'missing_booking' };

  const quote = o.quote || {};
  const unitCents = Number(quote.unit_amount_cents);
  if (!Number.isInteger(unitCents) || unitCents <= 0) return { ok: false, reason: 'missing_price' };
  const quantity = Number(quote.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) return { ok: false, reason: 'invalid_quantity' };
  const dates = Array.isArray(quote.dates) ? quote.dates.filter(isIsoDate) : [];
  if (!dates.length) return { ok: false, reason: 'no_eligible_dates' };

  // Confirm the booking belongs to this tenant (cross-tenant guard) and gather its eligible dates.
  const bookingRes = await pg.query(
    `SELECT b.id::text AS booking_id, b.booking_code, b.guest_name, b.metadata,
            c.slug AS client_slug
       FROM bookings b INNER JOIN clients c ON c.id = b.client_id
      WHERE b.id = $1::uuid LIMIT 1`,
    [bookingId],
  );
  const booking = bookingRes.rows[0];
  if (!booking) return { ok: false, reason: 'booking_not_found' };
  if (String(booking.client_slug) !== 'sunset') return { ok: false, reason: 'cross_tenant_booking' };

  // Eligible dates = service dates of the booking's non-add-on records.
  const eligibleRes = await pg.query(
    `SELECT DISTINCT service_date::text AS service_date
       FROM booking_service_records
      WHERE booking_id = $1::uuid AND service_type <> 'addon_service' AND status <> 'cancelled'`,
    [bookingId],
  );
  const eligible = new Set(eligibleRes.rows.map((r) => String(r.service_date).slice(0, 10)));
  for (const iso of dates) {
    if (!eligible.has(iso)) return { ok: false, reason: 'ineligible_date', date: iso };
  }

  const bookingCode = booking.booking_code || trimStr(o.bookingCode);
  const guestName = booking.guest_name || trimStr(o.guestName) || 'Guest';
  const bookingMeta = (booking.metadata && typeof booking.metadata === 'object')
    ? booking.metadata
    : (() => { try { return JSON.parse(booking.metadata || '{}'); } catch (_) { return {}; } })();
  const locationId = bookingMeta.location_id || o.locationId || null;

  const attached = [];
  for (const serviceDate of dates.slice().sort()) {
    const existing = await pg.query(
      `SELECT id FROM booking_service_records
        WHERE booking_id = $1::uuid AND service_type = 'addon_service' AND service_date = $2::date
          AND metadata->>'service_key' = $3 LIMIT 1`,
      [bookingId, serviceDate, SUNSET_FULL_DAY_ADDON_KEY],
    );
    if (existing.rows.length) continue;
    const amountDue = unitCents * quantity;
    const metadata = {
      source: 'luna_guest',
      attach_origin: ADDON_ATTACH_ORIGIN,
      staff_ui_service_type: SUNSET_FULL_DAY_ADDON_KEY,
      component: SUNSET_FULL_DAY_ADDON_KEY,
      service_key: SUNSET_FULL_DAY_ADDON_KEY,
      billing_unit: 'person_per_day',
      unit_amount_cents: unitCents,
      location_id: locationId,
      settle_at_checkout: true,
      paid_now_optional: true,
    };
    await pg.query(
      `INSERT INTO booking_service_records (
         client_slug, booking_id, booking_code, guest_name, service_type, service_date,
         quantity, status, amount_due_cents, amount_paid_cents, payment_status, source, metadata
       ) VALUES (
         $1, $2::uuid, $3, $4, 'addon_service', $5::date,
         $6, 'confirmed', $7, 0, 'pending', 'luna_guest', $8::jsonb
       )`,
      [clientSlug, bookingId, bookingCode, guestName, serviceDate, quantity, amountDue, JSON.stringify(metadata)],
    );
    attached.push({ service_date: serviceDate, quantity, amount_due_cents: amountDue });
  }

  return {
    ok: true,
    booking_id: bookingId,
    addon_key: SUNSET_FULL_DAY_ADDON_KEY,
    attached_dates: attached,
    unit_amount_cents: unitCents,
    currency: quote.currency || 'EUR',
  };
}

module.exports = {
  ADDON_ATTACH_ORIGIN,
  attachPricedGuestAddonServices,
  attachAllGuestAddonServices,
  attachSunsetFullDayEquipmentAddon,
  enrichPendingManualServiceAmounts,
  mapGuestAttachRow,
};

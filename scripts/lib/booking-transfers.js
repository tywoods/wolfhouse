/**
 * Phase 26b — Booking airport transfer helpers (multi-client).
 *
 * No payment provider integration, no payment writes, no WhatsApp. Pricing metadata only.
 *
 * @module booking-transfers
 */

'use strict';

const {
  getClientTransferConfig,
  getClientAirportOption,
  normalizeAirportCode,
  getTransferRuleForAirport,
} = require('./client-transfer-config');

const VALID_DIRECTIONS = new Set(['arrival', 'departure']);
const VALID_STATUSES = new Set(['requested', 'confirmed', 'cancelled', 'not_needed']);
const VALID_SOURCES = new Set(['staff', 'luna', 'owner', 'import', 'flight_lookup']);

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function toDateOnly(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const s = trimStr(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * @param {string} direction
 * @returns {'arrival'|'departure'}
 */
function normalizeTransferDirection(direction) {
  const d = trimStr(direction).toLowerCase();
  if (!VALID_DIRECTIONS.has(d)) {
    throw new Error(`direction must be arrival or departure (got: ${direction || '(empty)'})`);
  }
  return d;
}

/**
 * @param {string} status
 * @returns {'requested'|'confirmed'|'cancelled'|'not_needed'}
 */
function normalizeTransferStatus(status) {
  const s = trimStr(status).toLowerCase() || 'requested';
  if (!VALID_STATUSES.has(s)) {
    throw new Error(`status must be requested, confirmed, cancelled, or not_needed (got: ${status})`);
  }
  return s;
}

/**
 * @param {string|null|undefined} flightNumber
 * @returns {string|null}
 */
function normalizeFlightNumber(flightNumber) {
  const s = trimStr(flightNumber);
  return s ? s.toUpperCase().replace(/\s+/g, '') : null;
}

/**
 * @param {{ direction: string, booking: object }} opts
 * @returns {string|null}
 */
function defaultTransferLookupDate({ direction, booking }) {
  const dir = normalizeTransferDirection(direction);
  const b = booking || {};
  if (dir === 'arrival') return toDateOnly(b.check_in);
  return toDateOnly(b.check_out);
}

/**
 * @param {object} booking
 * @returns {boolean}
 */
function isPackageBooking(booking) {
  const code = trimStr(booking && booking.package_code).toLowerCase();
  return Boolean(code && code !== 'manual_override');
}

/**
 * @param {object} booking
 * @param {object} [transfer]
 * @returns {number}
 */
function resolveGuestCount(booking, transfer) {
  const override = transfer && transfer.guest_count;
  if (override != null && Number.isFinite(Number(override)) && Number(override) > 0) {
    return Math.floor(Number(override));
  }
  const fromBooking = booking && booking.guest_count;
  if (fromBooking != null && Number.isFinite(Number(fromBooking)) && Number(fromBooking) > 0) {
    return Math.floor(Number(fromBooking));
  }
  return 1;
}

/**
 * Calculate transfer pricing metadata — no payment records created.
 *
 * @param {{ client_slug: string, booking: object, transfer: object }} opts
 * @returns {object}
 */
function priceBookingTransfer({ client_slug, booking, transfer }) {
  const clientSlug = trimStr(client_slug);
  const cfg = getClientTransferConfig(clientSlug);
  const airportInput = transfer && transfer.airport_code;
  const airportCode = normalizeAirportCode(clientSlug, airportInput);
  const guestCount = resolveGuestCount(booking, transfer);
  const packageBooking = isPackageBooking(booking);

  const unavailable = (errorCode, pricingNote) => ({
    available: false,
    error_code: errorCode,
    included_in_package: false,
    price_cents: null,
    currency: cfg.currency,
    pricing_note: pricingNote,
    guest_count: guestCount,
    airport_code: airportCode,
  });

  if (!airportCode) {
    return unavailable(
      'airport_not_supported',
      airportInput ? `Airport "${airportInput}" is not supported for this client.` : 'Airport is required.',
    );
  }

  const rule = getTransferRuleForAirport(clientSlug, airportCode);
  const airport = getClientAirportOption(clientSlug, airportCode);
  if (!rule || !airport) {
    return unavailable('airport_not_supported', `Airport ${airportCode} is not configured for transfers.`);
  }

  if (rule.requires_package && !packageBooking) {
    return unavailable(
      'bilbao_package_required',
      rule.unavailable_no_package_message
        || 'Transfer requires a package booking.',
    );
  }

  if (rule.min_guest_count != null && guestCount < rule.min_guest_count) {
    return unavailable(
      'bilbao_min_group',
      rule.unavailable_below_min_group_message
        || `Minimum group size is ${rule.min_guest_count} guests.`,
    );
  }

  if (packageBooking && rule.included_when_package) {
    return {
      available: true,
      error_code: null,
      included_in_package: true,
      price_cents: 0,
      currency: cfg.currency,
      pricing_note: `${airport.label} transfer included in package.`,
      guest_count: guestCount,
      airport_code: airportCode,
      airport_label: airport.label,
    };
  }

  let priceCents = 0;
  let pricingNote = '';

  if (rule.per_person_extra_cents != null) {
    priceCents = rule.per_person_extra_cents * guestCount;
    pricingNote = `${airport.label} transfer: €${(rule.per_person_extra_cents / 100).toFixed(0)}/person × ${guestCount} = €${(priceCents / 100).toFixed(0)} extra.`;
  } else if (rule.flat_price_cents != null) {
    priceCents = rule.flat_price_cents;
    pricingNote = `${airport.label} transfer: €${(priceCents / 100).toFixed(0)} flat.`;
  }

  return {
    available: true,
    error_code: null,
    included_in_package: false,
    price_cents: priceCents,
    currency: cfg.currency,
    pricing_note: pricingNote,
    guest_count: guestCount,
    airport_code: airportCode,
    airport_label: airport.label,
  };
}

/**
 * @param {{ client_slug: string, booking: object, transferInput: object, source?: string }} opts
 * @returns {object}
 */
function buildBookingTransferUpsertPayload({ client_slug, booking, transferInput, source = 'staff' }) {
  const clientSlug = trimStr(client_slug);
  const input = transferInput || {};
  const direction = normalizeTransferDirection(input.direction);
  const status = normalizeTransferStatus(input.status);
  const src = trimStr(source).toLowerCase() || 'staff';
  if (!VALID_SOURCES.has(src)) {
    throw new Error(`source must be staff, luna, owner, import, or flight_lookup (got: ${source})`);
  }

  const airportCode = input.airport_code != null
    ? normalizeAirportCode(clientSlug, input.airport_code)
    : null;
  const airport = airportCode ? getClientAirportOption(clientSlug, airportCode) : null;
  const lookupDate = input.lookup_date != null
    ? toDateOnly(input.lookup_date)
    : defaultTransferLookupDate({ direction, booking });
  const guestCount = input.guest_count != null
    ? resolveGuestCount(booking, { guest_count: input.guest_count })
    : resolveGuestCount(booking, input);

  const pricing = priceBookingTransfer({
    client_slug: clientSlug,
    booking,
    transfer: { airport_code: airportCode || input.airport_code, guest_count: guestCount },
  });

  return {
    client_slug: clientSlug,
    direction,
    status,
    airport_code: airportCode,
    airport_label: airport ? airport.label : (input.airport_label ? trimStr(input.airport_label) : null),
    flight_number: normalizeFlightNumber(input.flight_number),
    lookup_date: lookupDate,
    scheduled_at: input.scheduled_at != null ? input.scheduled_at : null,
    pickup_location: input.pickup_location != null ? trimStr(input.pickup_location) || null : null,
    dropoff_location: input.dropoff_location != null ? trimStr(input.dropoff_location) || null : null,
    guest_count: guestCount,
    price_cents: pricing.available ? pricing.price_cents : null,
    currency: pricing.currency,
    included_in_package: pricing.available ? pricing.included_in_package : null,
    pricing_note: pricing.available ? pricing.pricing_note : (pricing.pricing_note || null),
    notes: input.notes != null ? trimStr(input.notes) || null : null,
    source: src,
    flight_lookup_provider: input.flight_lookup_provider != null ? trimStr(input.flight_lookup_provider) || null : null,
    flight_lookup_status: input.flight_lookup_status != null ? trimStr(input.flight_lookup_status) || null : null,
    flight_lookup_summary: input.flight_lookup_summary != null ? input.flight_lookup_summary : null,
    pricing_available: pricing.available,
    pricing_error_code: pricing.error_code || null,
  };
}

function mapTransferRow(row) {
  if (!row) return null;
  return { ...row };
}

/**
 * @param {import('pg').Client} pg
 * @param {{ client_slug: string, booking_id: string, direction: string, transfer?: object, booking?: object, source?: string }} opts
 * @returns {Promise<object>}
 */
async function upsertBookingTransfer(pg, opts = {}) {
  const clientSlug = trimStr(opts.client_slug);
  const bookingId = trimStr(opts.booking_id);
  const direction = normalizeTransferDirection(opts.direction);
  const booking = opts.booking || {};
  const transferInput = { direction, ...(opts.transfer || {}) };

  if (!clientSlug || !bookingId) {
    throw new Error('client_slug and booking_id are required');
  }

  const payload = buildBookingTransferUpsertPayload({
    client_slug: clientSlug,
    booking,
    transferInput,
    source: opts.source || 'staff',
  });

  const res = await pg.query(
    `INSERT INTO booking_transfers (
       client_slug, booking_id, direction, status,
       airport_code, airport_label, flight_number, lookup_date, scheduled_at,
       pickup_location, dropoff_location, guest_count,
       price_cents, currency, included_in_package, pricing_note, notes,
       source, flight_lookup_provider, flight_lookup_status, flight_lookup_summary
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8, $9,
       $10, $11, $12,
       $13, $14, $15, $16, $17,
       $18, $19, $20, $21
     )
     ON CONFLICT (booking_id, direction)
     DO UPDATE SET
       status = EXCLUDED.status,
       airport_code = EXCLUDED.airport_code,
       airport_label = EXCLUDED.airport_label,
       flight_number = EXCLUDED.flight_number,
       lookup_date = EXCLUDED.lookup_date,
       scheduled_at = EXCLUDED.scheduled_at,
       pickup_location = EXCLUDED.pickup_location,
       dropoff_location = EXCLUDED.dropoff_location,
       guest_count = EXCLUDED.guest_count,
       price_cents = EXCLUDED.price_cents,
       currency = EXCLUDED.currency,
       included_in_package = EXCLUDED.included_in_package,
       pricing_note = EXCLUDED.pricing_note,
       notes = EXCLUDED.notes,
       source = EXCLUDED.source,
       flight_lookup_provider = EXCLUDED.flight_lookup_provider,
       flight_lookup_status = EXCLUDED.flight_lookup_status,
       flight_lookup_summary = EXCLUDED.flight_lookup_summary,
       updated_at = NOW()
     WHERE booking_transfers.client_slug = EXCLUDED.client_slug
     RETURNING *`,
    [
      clientSlug,
      bookingId,
      payload.direction,
      payload.status,
      payload.airport_code,
      payload.airport_label,
      payload.flight_number,
      payload.lookup_date,
      payload.scheduled_at,
      payload.pickup_location,
      payload.dropoff_location,
      payload.guest_count,
      payload.price_cents,
      payload.currency,
      payload.included_in_package,
      payload.pricing_note,
      payload.notes,
      payload.source,
      payload.flight_lookup_provider,
      payload.flight_lookup_status,
      payload.flight_lookup_summary,
    ],
  );

  if (!res.rows[0]) {
    throw new Error('upsert failed: booking_id/direction conflict under different client_slug');
  }

  return mapTransferRow(res.rows[0]);
}

/**
 * @param {import('pg').Client} pg
 * @param {{ client_slug: string, booking_id: string }} opts
 * @returns {Promise<object[]>}
 */
async function listBookingTransfersForBooking(pg, opts = {}) {
  const clientSlug = trimStr(opts.client_slug);
  const bookingId = trimStr(opts.booking_id);
  if (!clientSlug || !bookingId) return [];

  const res = await pg.query(
    `SELECT *
       FROM booking_transfers
      WHERE client_slug = $1
        AND booking_id = $2
      ORDER BY CASE direction WHEN 'arrival' THEN 0 ELSE 1 END, created_at ASC`,
    [clientSlug, bookingId],
  );

  return res.rows.map(mapTransferRow);
}

/**
 * @param {import('pg').Client} pg
 * @param {{ client_slug: string, start_date: string, end_date: string }} opts
 * @returns {Promise<object[]>}
 */
async function listBookingTransfersForCalendarRange(pg, opts = {}) {
  const clientSlug = trimStr(opts.client_slug);
  const startDate = toDateOnly(opts.start_date);
  const endDate = toDateOnly(opts.end_date);
  if (!clientSlug || !startDate || !endDate) return [];

  const res = await pg.query(
    `SELECT *
       FROM booking_transfers
      WHERE client_slug = $1
        AND status IN ('requested', 'confirmed')
        AND (
          (lookup_date IS NOT NULL AND lookup_date BETWEEN $2::date AND $3::date)
          OR (scheduled_at IS NOT NULL AND scheduled_at::date BETWEEN $2::date AND $3::date)
        )
      ORDER BY COALESCE(scheduled_at, lookup_date::timestamptz) ASC NULLS LAST`,
    [clientSlug, startDate, endDate],
  );

  return res.rows.map(mapTransferRow);
}

module.exports = {
  VALID_DIRECTIONS,
  VALID_STATUSES,
  VALID_SOURCES,
  normalizeTransferDirection,
  normalizeTransferStatus,
  normalizeFlightNumber,
  defaultTransferLookupDate,
  isPackageBooking,
  priceBookingTransfer,
  buildBookingTransferUpsertPayload,
  upsertBookingTransfer,
  listBookingTransfersForBooking,
  listBookingTransfersForCalendarRange,
};

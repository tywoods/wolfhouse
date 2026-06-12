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

/**
 * Preserve SQL DATE semantics when pg returns UTC-shifted JS Date values.
 *
 * @param {string|Date|null|undefined} value
 * @param {{ timezone?: string }} [opts]
 * @returns {string|null} YYYY-MM-DD
 */
function normalizeBookingDateOnly(value, { timezone = 'Europe/Madrid' } = {}) {
  if (value == null || value === '') return null;

  const formatInTimezone = (instant) => new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatInTimezone(value);
  }

  const s = trimStr(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return formatInTimezone(d);
}

function toDateOnly(value, timezone = 'Europe/Madrid') {
  return normalizeBookingDateOnly(value, { timezone });
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
 * @param {{ direction: string, booking: object, timezone?: string }} opts
 * @returns {string|null}
 */
function defaultTransferLookupDate({ direction, booking, timezone }) {
  const dir = normalizeTransferDirection(direction);
  const b = booking || {};
  const tz = timezone || b.timezone || 'Europe/Madrid';
  if (dir === 'arrival') return normalizeBookingDateOnly(b.check_in, { timezone: tz });
  return normalizeBookingDateOnly(b.check_out, { timezone: tz });
}

/**
 * Staff/Luna default pickup times — matches Transfers tab buildDefaults().
 *
 * @param {{ direction: string, booking: object, timezone?: string, client_slug?: string }} opts
 * @returns {string|null} local datetime string YYYY-MM-DDTHH:mm
 */
function defaultTransferScheduledAtLocal({ direction, booking, timezone, client_slug }) {
  const dir = normalizeTransferDirection(direction);
  const tz = timezone || (client_slug && getClientTransferConfig(client_slug).timezone)
    || 'Europe/Madrid';
  const dateOnly = defaultTransferLookupDate({ direction, booking, timezone: tz });
  if (!dateOnly) return null;
  const hour = dir === 'arrival' ? '09:00' : '12:00';
  return `${dateOnly}T${hour}`;
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

const MANUAL_TRANSFER_OVERRIDE_NOTE = 'Manual transfer override';

/**
 * Block under-min-group saves unless staff Exception Override includes an amount.
 *
 * @param {{ client_slug: string, booking: object, transferInput: object, pricing: object, manualOverride: object|null }} opts
 */
function assertTransferGroupOverrideAllowed(opts = {}) {
  const clientSlug = trimStr(opts.client_slug);
  const input = opts.transferInput || {};
  const booking = opts.booking || {};
  const pricing = opts.pricing || {};
  const manualOverride = opts.manualOverride || null;
  const airportCode = normalizeAirportCode(clientSlug, input.airport_code);
  if (!airportCode) return;

  const rule = getTransferRuleForAirport(clientSlug, airportCode);
  if (!rule || rule.min_guest_count == null) return;

  const guestCount = resolveGuestCount(booking, input);
  if (guestCount >= rule.min_guest_count) return;

  if (manualOverride && manualOverride.price_cents != null) return;

  const baseMsg = rule.unavailable_below_min_group_message
    || 'Bilbao transfer is normally available for groups of 4 or more. Use Exception Override to save a manual exception.';
  const err = new Error(
    input.manual_override_enabled === true
      ? 'Transfer Charge amount is required for Exception Override.'
      : baseMsg,
  );
  err.code = 'bilbao_min_group_override_required';
  throw err;
}

/**
 * Apply staff exception override when manual_override_euros is provided.
 *
 * @param {{ client_slug: string, transferInput: object }} opts
 * @returns {object|null}
 */
function resolveManualTransferOverride({ client_slug, transferInput }) {
  const input = transferInput || {};
  const cfg = getClientTransferConfig(client_slug);
  const wrapOpen = input.manual_override_enabled === true;
  const raw = input.manual_override_euros != null
    ? input.manual_override_euros
    : input.exception_override_euros;
  if (raw == null || raw === '') {
    if (!wrapOpen) return null;
    return null;
  }
  const euros = Number(raw);
  if (!Number.isFinite(euros) || euros < 0) {
    const err = new Error('manual_override_euros must be a number >= 0');
    err.code = 'invalid_override_amount';
    throw err;
  }
  const cents = Math.round(euros * 100);
  return {
    available: true,
    error_code: null,
    included_in_package: false,
    price_cents: cents,
    currency: cfg.currency,
    pricing_note: MANUAL_TRANSFER_OVERRIDE_NOTE,
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
    ? normalizeBookingDateOnly(input.lookup_date)
    : defaultTransferLookupDate({ direction, booking });
  const guestCount = input.guest_count != null
    ? resolveGuestCount(booking, { guest_count: input.guest_count })
    : resolveGuestCount(booking, input);

  let pricing = priceBookingTransfer({
    client_slug: clientSlug,
    booking,
    transfer: { airport_code: airportCode || input.airport_code, guest_count: guestCount },
  });

  const manualOverride = resolveManualTransferOverride({ client_slug: clientSlug, transferInput: input });
  if (manualOverride) pricing = { ...pricing, ...manualOverride };

  if (status !== 'not_needed') {
    assertTransferGroupOverrideAllowed({
      client_slug: clientSlug,
      booking,
      transferInput: input,
      pricing,
      manualOverride,
    });
  }

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
 * Delete one booking_transfers row for booking + direction. No payment writes.
 *
 * @param {import('pg').Client} pg
 * @param {{ client_slug: string, booking_id: string, direction: string }} opts
 * @returns {Promise<{ deleted: boolean, direction: string|null }>}
 */
async function deleteBookingTransfer(pg, opts = {}) {
  const clientSlug = trimStr(opts.client_slug);
  const bookingId = trimStr(opts.booking_id);
  const direction = normalizeTransferDirection(opts.direction);

  if (!clientSlug || !bookingId) {
    throw new Error('client_slug and booking_id are required');
  }

  const res = await pg.query(
    `DELETE FROM booking_transfers
      WHERE client_slug = $1
        AND booking_id = $2
        AND direction = $3
      RETURNING direction`,
    [clientSlug, bookingId, direction],
  );

  return {
    deleted: res.rowCount > 0,
    direction: res.rows[0] ? res.rows[0].direction : direction,
  };
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

/** Statuses that show the calendar Transfer pebble (not cancelled / not_needed). */
const ACTIVE_TRANSFER_PEBBLE_STATUSES = new Set(['requested', 'confirmed']);

function emptyTransferSummary() {
  return {
    has_transfer: false,
    transfer_count: 0,
    directions: [],
    statuses: [],
    airports: [],
  };
}

/**
 * Build pebble summary from transfer rows (requested/confirmed only).
 *
 * @param {object[]} rows
 * @returns {{ has_transfer: boolean, transfer_count: number, directions: string[], statuses: string[], airports: string[] }}
 */
function buildTransferSummaryFromRows(rows) {
  const active = (rows || []).filter((r) =>
    ACTIVE_TRANSFER_PEBBLE_STATUSES.has(String(r.status || '').toLowerCase()),
  );
  if (active.length === 0) return emptyTransferSummary();
  const directions = [...new Set(active.map((r) => r.direction).filter(Boolean))].sort();
  const statuses = [...new Set(active.map((r) => r.status).filter(Boolean))];
  const airports = [...new Set(active.map((r) => r.airport_code).filter(Boolean))];
  return {
    has_transfer: true,
    transfer_count: active.length,
    directions,
    statuses,
    airports,
  };
}

/**
 * Group calendar-range transfer rows into per-booking summaries.
 *
 * @param {object[]} transferRows
 * @returns {Record<string, object>}
 */
function buildTransferSummariesByBookingId(transferRows) {
  const grouped = {};
  for (const row of transferRows || []) {
    const bid = trimStr(row.booking_id);
    if (!bid) continue;
    if (!grouped[bid]) grouped[bid] = [];
    grouped[bid].push(row);
  }
  const out = {};
  for (const [bid, rows] of Object.entries(grouped)) {
    out[bid] = buildTransferSummaryFromRows(rows);
  }
  return out;
}

module.exports = {
  VALID_DIRECTIONS,
  VALID_STATUSES,
  VALID_SOURCES,
  normalizeBookingDateOnly,
  normalizeTransferDirection,
  normalizeTransferStatus,
  normalizeFlightNumber,
  defaultTransferLookupDate,
  defaultTransferScheduledAtLocal,
  isPackageBooking,
  priceBookingTransfer,
  resolveManualTransferOverride,
  assertTransferGroupOverrideAllowed,
  MANUAL_TRANSFER_OVERRIDE_NOTE,
  buildBookingTransferUpsertPayload,
  upsertBookingTransfer,
  deleteBookingTransfer,
  listBookingTransfersForBooking,
  listBookingTransfersForCalendarRange,
  ACTIVE_TRANSFER_PEBBLE_STATUSES,
  emptyTransferSummary,
  buildTransferSummaryFromRows,
  buildTransferSummariesByBookingId,
};

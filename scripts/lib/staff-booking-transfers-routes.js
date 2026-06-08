/**
 * Phase 26c — Staff API routes for booking airport transfers.
 *
 * GET/POST /staff/bookings/:booking_id/transfers — no payment writes.
 * DELETE /staff/bookings/:booking_id/transfers/:direction — remove one direction.
 *
 * @module staff-booking-transfers-routes
 */

'use strict';

const { withPgClient } = require('./pg-connect');
const { getClientTransferConfig, getClientAirports, getClientAirportOption } = require('./client-transfer-config');
const {
  normalizeBookingDateOnly,
  normalizeTransferDirection,
  defaultTransferLookupDate,
  priceBookingTransfer,
  upsertBookingTransfer,
  deleteBookingTransfer,
  listBookingTransfersForBooking,
} = require('./booking-transfers');
const {
  lookupAviationstackFlight,
  normalizeFlightNumberForLookup,
  PROVIDER: AVIATIONSTACK_PROVIDER,
} = require('./aviationstack-flight-lookup');

const BOOKING_TRANSFERS_RE = /^\/staff\/bookings\/([0-9a-f-]{36})\/transfers$/i;
const BOOKING_TRANSFER_DIRECTION_RE =
  /^\/staff\/bookings\/([0-9a-f-]{36})\/transfers\/(arrival|departure)$/i;
const BOOKING_TRANSFER_LOOKUP_RE = /^\/staff\/bookings\/([0-9a-f-]{36})\/transfers\/lookup-flight$/i;

const BOOKING_BY_ID_SQL = `
SELECT b.id::text AS booking_id,
       b.booking_code,
       b.guest_count,
       b.package_code,
       b.check_in,
       b.check_out,
       b.status::text AS status,
       b.payment_status::text AS payment_status
  FROM bookings b
 INNER JOIN clients c ON c.id = b.client_id
 WHERE c.slug = $1
   AND b.id = $2::uuid
 LIMIT 1
`;

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function isMissingBookingTransfersTable(err) {
  if (!err) return false;
  if (err.code === '42P01') return true;
  const msg = String(err.message || '');
  return /booking_transfers/.test(msg) && /does not exist|undefined table/i.test(msg);
}

function clientTimezone(clientSlug) {
  return getClientTransferConfig(clientSlug).timezone || 'Europe/Madrid';
}

/**
 * @param {Date|string|null|undefined} value
 * @param {string} timezone
 * @returns {string}
 */
function formatTimestamptzAsDatetimeLocal(value, timezone) {
  if (value == null || value === '') return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(d)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/**
 * @param {string|null|undefined} localValue datetime-local without timezone
 * @param {string} timezone
 * @returns {string|null} ISO timestamptz
 */
function parseDatetimeLocalInTimezone(localValue, timezone) {
  const s = trimStr(localValue);
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const hh = Number(m[4]);
  const mm = Number(m[5]);
  const startMs = Date.UTC(y, mo - 1, d, 0, 0, 0) - 3 * 3600000;
  for (let ms = startMs; ms < startMs + 36 * 3600000; ms += 60000) {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(new Date(ms))
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number(part.value)]),
    );
    if (p.year === y && p.month === mo && p.day === d && p.hour === hh && p.minute === mm) {
      return new Date(ms).toISOString();
    }
  }
  return null;
}

function bookingForPricing(row) {
  return {
    package_code: row.package_code,
    guest_count: row.guest_count,
    check_in: row.check_in,
    check_out: row.check_out,
  };
}

function formatAirportsForApi(clientSlug) {
  return getClientAirports(clientSlug).map((a) => ({
    code: a.code,
    label: a.label,
    iata: a.iata,
  }));
}

function formatTransferPricing(clientSlug, booking, transferRow) {
  return priceBookingTransfer({
    client_slug: clientSlug,
    booking,
    transfer: {
      airport_code: transferRow && transferRow.airport_code,
      guest_count: transferRow && transferRow.guest_count,
    },
  });
}

function sanitizeFlightLookupSummaryForStorage(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null;
  const allowed = [
    'flight_iata', 'airline_name', 'flight_status', 'direction',
    'airport_iata', 'airport_name', 'scheduled', 'terminal', 'gate',
  ];
  const out = {};
  for (const k of allowed) {
    if (summary[k] != null && summary[k] !== '') {
      out[k] = String(summary[k]).slice(0, 500);
    }
  }
  return Object.keys(out).length ? out : null;
}

function buildFlightLookupSummary(bestMatch, direction) {
  if (!bestMatch) return null;
  const dir = normalizeTransferDirection(direction);
  if (dir === 'arrival') {
    return sanitizeFlightLookupSummaryForStorage({
      flight_iata: bestMatch.flight_iata,
      airline_name: bestMatch.airline_name,
      flight_status: bestMatch.flight_status,
      direction: dir,
      airport_iata: bestMatch.arrival_iata,
      airport_name: bestMatch.arrival_airport,
      scheduled: bestMatch.arrival_estimated || bestMatch.arrival_scheduled,
      terminal: bestMatch.arrival_terminal,
      gate: bestMatch.arrival_gate,
    });
  }
  return sanitizeFlightLookupSummaryForStorage({
    flight_iata: bestMatch.flight_iata,
    airline_name: bestMatch.airline_name,
    flight_status: bestMatch.flight_status,
    direction: dir,
    airport_iata: bestMatch.departure_iata,
    airport_name: bestMatch.departure_airport,
    scheduled: bestMatch.departure_estimated || bestMatch.departure_scheduled,
  });
}

function resolveAirportFromLookup(clientSlug, bestMatch, direction, requestedAirport) {
  const dir = normalizeTransferDirection(direction);
  const airports = getClientAirports(clientSlug);
  const codes = new Set(airports.map((a) => a.code));
  const lookupIata = dir === 'arrival'
    ? trimStr(bestMatch && bestMatch.arrival_iata).toUpperCase()
    : trimStr(bestMatch && bestMatch.departure_iata).toUpperCase();
  const req = trimStr(requestedAirport).toUpperCase();
  if (lookupIata && codes.has(lookupIata)) {
    const opt = getClientAirportOption(clientSlug, lookupIata);
    return { code: lookupIata, label: opt ? opt.label : null };
  }
  if (req && codes.has(req)) {
    const opt = getClientAirportOption(clientSlug, req);
    return { code: req, label: opt ? opt.label : null };
  }
  return { code: lookupIata || req || null, label: null };
}

/**
 * @param {{ clientSlug: string, direction: string, lookupResult: object, timezone: string, requestedAirport?: string|null }} opts
 */
function buildSuggestedTransferPatch(opts = {}) {
  const { clientSlug, direction, lookupResult, timezone, requestedAirport } = opts;
  const best = lookupResult && lookupResult.best_match;
  if (!best) return null;
  const dir = normalizeTransferDirection(direction);
  const airport = resolveAirportFromLookup(clientSlug, best, dir, requestedAirport);
  const scheduledRaw = dir === 'arrival'
    ? (best.arrival_estimated || best.arrival_scheduled)
    : (best.departure_estimated || best.departure_scheduled);
  let scheduledAt = null;
  if (scheduledRaw) {
    const d = new Date(scheduledRaw);
    if (!Number.isNaN(d.getTime())) scheduledAt = d.toISOString();
  }
  return {
    airport_code: airport.code,
    airport_label: airport.label,
    flight_number: lookupResult.flight_number,
    lookup_date: lookupResult.flight_date,
    scheduled_at: scheduledAt,
    scheduled_at_local: scheduledAt ? formatTimestamptzAsDatetimeLocal(scheduledAt, timezone) : null,
    flight_lookup_provider: AVIATIONSTACK_PROVIDER,
    flight_lookup_status: best.flight_status || 'found',
    flight_lookup_summary: buildFlightLookupSummary(best, dir),
  };
}

function formatTransferForApi(row, booking, clientSlug, timezone) {
  if (!row) return null;
  const bookingObj = bookingForPricing(booking);
  const pricing = formatTransferPricing(clientSlug, bookingObj, row);
  let flightLookupSummary = row.flight_lookup_summary;
  if (flightLookupSummary && typeof flightLookupSummary === 'string') {
    try { flightLookupSummary = JSON.parse(flightLookupSummary); } catch { flightLookupSummary = null; }
  }
  flightLookupSummary = sanitizeFlightLookupSummaryForStorage(flightLookupSummary);
  return {
    id: row.id,
    client_slug: row.client_slug,
    booking_id: row.booking_id,
    direction: row.direction,
    status: row.status,
    airport_code: row.airport_code,
    airport_label: row.airport_label,
    flight_number: row.flight_number,
    lookup_date: normalizeBookingDateOnly(row.lookup_date, { timezone }),
    scheduled_at: row.scheduled_at ? new Date(row.scheduled_at).toISOString() : null,
    scheduled_at_local: formatTimestamptzAsDatetimeLocal(row.scheduled_at, timezone),
    pickup_location: row.pickup_location,
    dropoff_location: row.dropoff_location,
    guest_count: row.guest_count,
    price_cents: row.price_cents,
    currency: row.currency,
    included_in_package: row.included_in_package,
    pricing_note: row.pricing_note,
    notes: row.notes,
    source: row.source,
    flight_lookup_provider: row.flight_lookup_provider || null,
    flight_lookup_status: row.flight_lookup_status || null,
    flight_lookup_summary: flightLookupSummary,
    pricing,
  };
}

function addDaysToDateOnly(dateStr, deltaDays) {
  const s = trimStr(dateStr);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

const FLIGHT_NOT_FOUND_MESSAGE = "Couldn't find that flight. Enter the flight details manually.";

function logSafeFlightLookupFailure(info) {
  console.warn('[flight-lookup]', JSON.stringify({
    provider: AVIATIONSTACK_PROVIDER,
    error: info.error || null,
    http_status: info.http_status != null ? info.http_status : null,
    flight_number: info.flight_number || null,
    lookup_dates_tried: info.lookup_dates_tried || [],
  }));
}

/**
 * @param {string} error
 * @param {{ flight_number?: string, direction?: string, airport_code?: string|null, lookup_dates_tried?: string[] }} ctx
 * @returns {string}
 */
function lookupFailureMessage(error, ctx = {}) {
  const fn = trimStr(ctx.flight_number) || 'flight';
  const dates = (ctx.lookup_dates_tried || []).filter(Boolean);
  const datePhrase = dates.length > 1
    ? dates.join(' or ')
    : (dates[0] || '');
  const airportCode = trimStr(ctx.airport_code).toUpperCase();
  const airportLabel = airportCode === 'SDR' ? 'Santander' : (airportCode || 'selected airport');

  switch (trimStr(error)) {
    case 'flight_not_found':
      if (datePhrase) {
        return `No matching flight found for ${fn} on ${datePhrase}. Enter details manually.`;
      }
      return FLIGHT_NOT_FOUND_MESSAGE;
    case 'airport_mismatch':
      return `Flight found, but airport did not match ${airportLabel}. Enter manually or change airport.`;
    case 'aviationstack_auth_error':
    case 'aviationstack_quota_or_plan_error':
      return 'Aviationstack auth/quota issue. Check API key or plan.';
    case 'aviationstack_rate_limited':
      return 'Aviationstack rate limit reached. Try again shortly.';
    case 'aviationstack_bad_request':
      return 'Flight lookup request was rejected. Check flight number and try again.';
    case 'aviationstack_not_configured':
      return 'Flight lookup is not configured.';
    default:
      return 'Flight lookup failed. Enter the flight details manually.';
  }
}

function buildLookupDiagnostic(ctx = {}) {
  return {
    provider: AVIATIONSTACK_PROVIDER,
    http_status: ctx.http_status != null ? ctx.http_status : null,
    lookup_dates_tried: ctx.lookup_dates_tried || [],
    flight_number: ctx.flight_number || null,
    direction: ctx.direction || null,
    airport_code: ctx.airport_code || null,
    provider_error_code: ctx.provider_error_code || null,
    provider_error_type: ctx.provider_error_type || null,
  };
}

/**
 * Try booking default lookup date, then one day earlier on flight_not_found.
 *
 * @param {{ flight_number: string, direction: string, airport_code?: string|null, lookupDate: string, env?: NodeJS.ProcessEnv }} opts
 * @returns {Promise<{ lookup: object, lookup_date_used: string|null, lookup_dates_tried: string[] }>}
 */
async function lookupAviationstackFlightWithDateRetry(opts = {}) {
  const lookupDate = trimStr(opts.lookupDate);
  const baseArgs = {
    flight_number: opts.flight_number,
    direction: opts.direction,
    airport_code: opts.airport_code,
    env: opts.env || process.env,
    fetchImpl: opts.fetchImpl,
  };
  const datesTried = [lookupDate];
  let lookup = await lookupAviationstackFlight({ ...baseArgs, flight_date: lookupDate });
  if (lookup.success || lookup.error !== 'flight_not_found') {
    return { lookup, lookup_date_used: lookupDate, lookup_dates_tried: datesTried };
  }
  const prevDate = addDaysToDateOnly(lookupDate, -1);
  if (!prevDate || prevDate === lookupDate) {
    return { lookup, lookup_date_used: lookupDate, lookup_dates_tried: datesTried };
  }
  datesTried.push(prevDate);
  const retry = await lookupAviationstackFlight({ ...baseArgs, flight_date: prevDate });
  return { lookup: retry, lookup_date_used: prevDate, lookup_dates_tried: datesTried };
}

function inferTransferStatusFromInput(transferInput, existingStatus) {
  const hasContent = !!(
    trimStr(transferInput.flight_number)
    || trimStr(transferInput.scheduled_at)
    || trimStr(transferInput.airport_code)
    || trimStr(transferInput.notes)
  );
  const existing = trimStr(existingStatus).toLowerCase();
  if (existing === 'confirmed' || existing === 'cancelled') return existing;
  if (!hasContent) return 'not_needed';
  return 'requested';
}

function buildDefaults(booking, timezone) {
  const bookingObj = bookingForPricing(booking);
  return {
    arrival_lookup_date: defaultTransferLookupDate({
      direction: 'arrival',
      booking: bookingObj,
      timezone,
    }),
    departure_lookup_date: defaultTransferLookupDate({
      direction: 'departure',
      booking: bookingObj,
      timezone,
    }),
    guest_count: Math.max(1, Number(booking.guest_count) || 1),
    check_in: normalizeBookingDateOnly(booking.check_in, { timezone }),
    check_out: normalizeBookingDateOnly(booking.check_out, { timezone }),
    default_airport_code: 'SDR',
  };
}

async function loadBooking(pg, clientSlug, bookingId) {
  const res = await pg.query(BOOKING_BY_ID_SQL, [clientSlug, bookingId]);
  return res.rows[0] || null;
}

async function handleGetBookingTransfers(bookingId, query, res) {
  const clientSlug = trimStr(query.client_slug || query.client);
  if (!clientSlug) {
    return res.status(400).json({ success: false, error: 'client_slug is required' });
  }
  const timezone = clientTimezone(clientSlug);

  try {
    const result = await withPgClient(async (pg) => {
      const booking = await loadBooking(pg, clientSlug, bookingId);
      if (!booking) return { notFound: true };

      let rows = [];
      let transfersAvailable = true;
      try {
        rows = await listBookingTransfersForBooking(pg, { client_slug: clientSlug, booking_id: bookingId });
      } catch (err) {
        if (!isMissingBookingTransfersTable(err)) throw err;
        transfersAvailable = false;
      }

      const defaults = buildDefaults(booking, timezone);
      const transfers = rows.map((row) => formatTransferForApi(row, booking, clientSlug, timezone));
      return {
        notFound: false,
        payload: {
          success: true,
          client_slug: clientSlug,
          booking_id: bookingId,
          booking_code: booking.booking_code,
          timezone,
          transfers_available: transfersAvailable,
          airports: formatAirportsForApi(clientSlug),
          transfers,
          defaults,
        },
      };
    });

    if (result.notFound) {
      return res.status(404).json({ success: false, error: 'booking not found' });
    }
    return res.status(200).json(result.payload);
  } catch (err) {
    return res.status(500).json({ success: false, error: 'query failed', detail: err.message });
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

async function handlePostBookingTransfer(bookingId, req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return res.status(400).json({ success: false, error: 'invalid JSON body' });
  }

  const clientSlug = trimStr(body.client_slug);
  if (!clientSlug) {
    return res.status(400).json({ success: false, error: 'client_slug is required' });
  }

  let direction;
  try {
    direction = normalizeTransferDirection(body.direction);
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }

  const timezone = clientTimezone(clientSlug);
  const scheduledAt = body.scheduled_at != null && trimStr(body.scheduled_at).includes('T')
    && !/[zZ]|[+-]\d{2}:\d{2}$/.test(trimStr(body.scheduled_at))
    ? parseDatetimeLocalInTimezone(body.scheduled_at, timezone)
    : (body.scheduled_at ? trimStr(body.scheduled_at) || null : null);

  try {
    const result = await withPgClient(async (pg) => {
      const booking = await loadBooking(pg, clientSlug, bookingId);
      if (!booking) return { notFound: true };

      let existingStatus = null;
      try {
        const rows = await listBookingTransfersForBooking(pg, {
          client_slug: clientSlug,
          booking_id: bookingId,
        });
        const row = rows.find((r) => r.direction === direction);
        existingStatus = row ? row.status : null;
      } catch (err) {
        if (!isMissingBookingTransfersTable(err)) throw err;
      }

      const resolvedStatus = body.status != null && trimStr(body.status)
        ? trimStr(body.status)
        : inferTransferStatusFromInput(body, existingStatus);

      const transferInput = {
        direction,
        status: resolvedStatus,
        airport_code: body.airport_code || buildDefaults(booking, timezone).default_airport_code,
        airport_label: body.airport_label,
        flight_number: body.flight_number,
        lookup_date: body.lookup_date || defaultTransferLookupDate({
          direction,
          booking: bookingForPricing(booking),
          timezone,
        }),
        scheduled_at: scheduledAt,
        pickup_location: null,
        dropoff_location: null,
        guest_count: body.guest_count != null ? body.guest_count : Math.max(1, Number(booking.guest_count) || 1),
        notes: body.notes,
        flight_lookup_provider: body.flight_lookup_provider,
        flight_lookup_status: body.flight_lookup_status,
        flight_lookup_summary: sanitizeFlightLookupSummaryForStorage(body.flight_lookup_summary),
      };

      const saved = await upsertBookingTransfer(pg, {
        client_slug: clientSlug,
        booking_id: bookingId,
        direction,
        booking: bookingForPricing(booking),
        transfer: transferInput,
        source: trimStr(body.source) || 'staff',
      });

      const pricing = formatTransferPricing(clientSlug, bookingForPricing(booking), saved);
      return {
        notFound: false,
        payload: {
          success: true,
          client_slug: clientSlug,
          booking_id: bookingId,
          transfer: formatTransferForApi(saved, booking, clientSlug, timezone),
          pricing,
          no_payment_write: true,
        },
      };
    });

    if (result.notFound) {
      return res.status(404).json({ success: false, error: 'booking not found' });
    }
    return res.status(200).json(result.payload);
  } catch (err) {
    if (isMissingBookingTransfersTable(err)) {
      return res.status(503).json({
        success: false,
        error: 'booking_transfers table not available — apply migration 017',
      });
    }
    return res.status(500).json({ success: false, error: 'save failed', detail: err.message });
  }
}

async function handlePostBookingTransferLookupFlight(bookingId, req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return res.status(400).json({ success: false, error: 'invalid JSON body' });
  }

  const clientSlug = trimStr(body.client_slug);
  if (!clientSlug) {
    return res.status(400).json({ success: false, error: 'client_slug is required' });
  }

  let direction;
  try {
    direction = normalizeTransferDirection(body.direction);
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }

  const flightNumber = normalizeFlightNumberForLookup(body.flight_number);
  if (!flightNumber) {
    return res.status(400).json({ success: false, error: 'missing_flight_number' });
  }

  const timezone = clientTimezone(clientSlug);
  let bookingRow;
  try {
    bookingRow = await withPgClient(async (pg) => loadBooking(pg, clientSlug, bookingId));
  } catch (err) {
    return res.status(500).json({ success: false, error: 'query failed', detail: err.message });
  }
  if (!bookingRow) {
    return res.status(404).json({ success: false, error: 'booking not found' });
  }

  const lookupDate = body.lookup_date != null
    ? normalizeBookingDateOnly(body.lookup_date, { timezone })
    : defaultTransferLookupDate({
      direction,
      booking: bookingForPricing(bookingRow),
      timezone,
    });

  if (!lookupDate) {
    return res.status(400).json({ success: false, error: 'missing_lookup_date', no_transfer_write: true });
  }

  const { lookup, lookup_date_used: lookupDateUsed, lookup_dates_tried: lookupDatesTried } =
    await lookupAviationstackFlightWithDateRetry({
      flight_number: flightNumber,
      direction,
      airport_code: body.airport_code,
      lookupDate,
      env: process.env,
    });

  if (!lookup.success) {
    const errCode = lookup.error || 'flight_lookup_failed';
    const status = errCode === 'aviationstack_not_configured' ? 503 : 404;
    const msgCtx = {
      flight_number: flightNumber,
      direction,
      airport_code: body.airport_code,
      lookup_dates_tried: lookupDatesTried || [lookupDate],
      http_status: lookup.http_status,
      provider_error_code: lookup.provider_error_code,
      provider_error_type: lookup.provider_error_type,
    };
    const payload = {
      success: false,
      error: errCode,
      message: lookupFailureMessage(errCode, msgCtx),
      diagnostic: buildLookupDiagnostic(msgCtx),
      no_transfer_write: true,
      no_payment_write: true,
    };
    logSafeFlightLookupFailure({
      error: errCode,
      http_status: lookup.http_status,
      flight_number: flightNumber,
      lookup_dates_tried: lookupDatesTried || [lookupDate],
    });
    return res.status(status).json(payload);
  }

  lookup.flight_date = lookupDateUsed || lookup.flight_date;

  const suggested_transfer_patch = buildSuggestedTransferPatch({
    clientSlug,
    direction,
    lookupResult: lookup,
    timezone,
    requestedAirport: body.airport_code,
  });

  return res.status(200).json({
    success: true,
    lookup,
    suggested_transfer_patch,
    no_transfer_write: true,
    no_payment_write: true,
  });
}

async function handleDeleteBookingTransfer(bookingId, direction, query, res) {
  const clientSlug = trimStr(query.client_slug || query.client);
  if (!clientSlug) {
    return res.status(400).json({ success: false, error: 'client_slug is required' });
  }

  let normalizedDirection;
  try {
    normalizedDirection = normalizeTransferDirection(direction);
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }

  try {
    const result = await withPgClient(async (pg) => {
      const booking = await loadBooking(pg, clientSlug, bookingId);
      if (!booking) return { notFound: true };

      const del = await deleteBookingTransfer(pg, {
        client_slug: clientSlug,
        booking_id: bookingId,
        direction: normalizedDirection,
      });

      return {
        notFound: false,
        payload: {
          success: true,
          client_slug: clientSlug,
          booking_id: bookingId,
          direction: del.direction,
          deleted: del.deleted,
          no_payment_write: true,
        },
      };
    });

    if (result.notFound) {
      return res.status(404).json({ success: false, error: 'booking not found' });
    }
    return res.status(200).json(result.payload);
  } catch (err) {
    if (isMissingBookingTransfersTable(err)) {
      return res.status(503).json({
        success: false,
        error: 'booking_transfers table not available — apply migration 017',
      });
    }
    return res.status(500).json({ success: false, error: 'delete failed', detail: err.message });
  }
}

/**
 * Express-style adapter for staff-query-api http.ServerResponse.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @param {object} query
 * @returns {Promise<boolean>} true if route handled
 */
async function dispatchBookingTransferDirectionRoute(req, res, pathname, query) {
  const match = BOOKING_TRANSFER_DIRECTION_RE.exec(pathname);
  if (!match) return false;

  const bookingId = match[1];
  const direction = match[2];
  const jsonRes = {
    status(code) {
      res.statusCode = code;
      return jsonRes;
    },
    json(obj) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(obj));
      return jsonRes;
    },
  };

  if (req.method === 'DELETE') {
    await handleDeleteBookingTransfer(bookingId, direction, query, jsonRes);
    return true;
  }

  res.writeHead(405, { Allow: 'DELETE' });
  res.end(JSON.stringify({ success: false, error: 'Method not allowed' }));
  return true;
}

/**
 * Express-style adapter for staff-query-api http.ServerResponse.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @param {object} query
 * @returns {Promise<boolean>} true if route handled
 */
async function dispatchBookingTransferLookupRoute(req, res, pathname) {
  const match = BOOKING_TRANSFER_LOOKUP_RE.exec(pathname);
  if (!match) return false;

  const bookingId = match[1];
  const jsonRes = {
    status(code) {
      res.statusCode = code;
      return jsonRes;
    },
    json(obj) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(obj));
      return jsonRes;
    },
  };

  if (req.method === 'POST') {
    await handlePostBookingTransferLookupFlight(bookingId, req, jsonRes);
    return true;
  }

  res.writeHead(405, { Allow: 'POST' });
  res.end(JSON.stringify({ success: false, error: 'Method not allowed' }));
  return true;
}

async function dispatchBookingTransfersRoute(req, res, pathname, query) {
  const match = BOOKING_TRANSFERS_RE.exec(pathname);
  if (!match) return false;

  const bookingId = match[1];
  const jsonRes = {
    status(code) {
      res.statusCode = code;
      return jsonRes;
    },
    json(obj) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(obj));
      return jsonRes;
    },
  };

  if (req.method === 'GET') {
    await handleGetBookingTransfers(bookingId, query, jsonRes);
    return true;
  }
  if (req.method === 'POST') {
    await handlePostBookingTransfer(bookingId, req, jsonRes);
    return true;
  }

  res.writeHead(405, { Allow: 'GET, POST' });
  res.end(JSON.stringify({ success: false, error: 'Method not allowed' }));
  return true;
}

module.exports = {
  BOOKING_TRANSFERS_RE,
  BOOKING_TRANSFER_DIRECTION_RE,
  BOOKING_TRANSFER_LOOKUP_RE,
  dispatchBookingTransfersRoute,
  dispatchBookingTransferDirectionRoute,
  dispatchBookingTransferLookupRoute,
  handleGetBookingTransfers,
  handlePostBookingTransfer,
  handleDeleteBookingTransfer,
  handlePostBookingTransferLookupFlight,
  buildSuggestedTransferPatch,
  sanitizeFlightLookupSummaryForStorage,
  lookupAviationstackFlightWithDateRetry,
  addDaysToDateOnly,
  inferTransferStatusFromInput,
  FLIGHT_NOT_FOUND_MESSAGE,
  lookupFailureMessage,
  buildLookupDiagnostic,
  logSafeFlightLookupFailure,
  formatTimestamptzAsDatetimeLocal,
  parseDatetimeLocalInTimezone,
  normalizeBookingDateOnly,
};

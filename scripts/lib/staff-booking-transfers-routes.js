/**
 * Phase 26c — Staff API routes for booking airport transfers.
 *
 * GET/POST /staff/bookings/:booking_id/transfers — no payment writes.
 *
 * @module staff-booking-transfers-routes
 */

'use strict';

const { withPgClient } = require('./pg-connect');
const { getClientTransferConfig, getClientAirports } = require('./client-transfer-config');
const {
  normalizeBookingDateOnly,
  normalizeTransferDirection,
  defaultTransferLookupDate,
  priceBookingTransfer,
  upsertBookingTransfer,
  listBookingTransfersForBooking,
} = require('./booking-transfers');

const BOOKING_TRANSFERS_RE = /^\/staff\/bookings\/([0-9a-f-]{36})\/transfers$/i;

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

function formatTransferForApi(row, booking, clientSlug, timezone) {
  if (!row) return null;
  const bookingObj = bookingForPricing(booking);
  const pricing = formatTransferPricing(clientSlug, bookingObj, row);
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
    pricing,
  };
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

  const transferInput = {
    direction,
    status: body.status,
    airport_code: body.airport_code,
    flight_number: body.flight_number,
    lookup_date: body.lookup_date,
    scheduled_at: scheduledAt,
    pickup_location: body.pickup_location,
    dropoff_location: body.dropoff_location,
    guest_count: body.guest_count,
    notes: body.notes,
  };

  try {
    const result = await withPgClient(async (pg) => {
      const booking = await loadBooking(pg, clientSlug, bookingId);
      if (!booking) return { notFound: true };

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

/**
 * Express-style adapter for staff-query-api http.ServerResponse.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @param {object} query
 * @returns {Promise<boolean>} true if route handled
 */
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
  dispatchBookingTransfersRoute,
  handleGetBookingTransfers,
  handlePostBookingTransfer,
  formatTimestamptzAsDatetimeLocal,
  parseDatetimeLocalInTimezone,
  normalizeBookingDateOnly,
};

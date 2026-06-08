/**
 * Phase 26g — Staff API route for booking services schedule (read-only).
 *
 * GET /staff/bookings/:booking_id/services — no payment writes.
 *
 * @module staff-booking-services-routes
 */

'use strict';

const { withPgClient } = require('./pg-connect');
const { getClientTransferConfig } = require('./client-transfer-config');
const { getBookingServiceRecordsQuery } = require('./staff-booking-detail-queries');
const { buildBookingServicesSchedule } = require('./staff-booking-services-schedule');

const BOOKING_SERVICES_RE = /^\/staff\/bookings\/([0-9a-f-]{36})\/services$/i;

const BOOKING_BY_ID_SQL = `
SELECT b.id::text AS booking_id,
       b.booking_code,
       b.package_code,
       b.check_in,
       b.check_out,
       b.status::text AS status
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

function clientTimezone(clientSlug) {
  return getClientTransferConfig(clientSlug).timezone || 'Europe/Madrid';
}

function isMissingBookingServiceRecordsTable(err) {
  if (!err) return false;
  if (err.code === '42P01') return true;
  const msg = String(err.message || '');
  return /booking_service_records/.test(msg) && /does not exist|undefined table/i.test(msg);
}

function bookingServicesRecordsSql() {
  const base = getBookingServiceRecordsQuery();
  if (/sr\.metadata/.test(base)) return base;
  return base.replace('sr.notes', 'sr.notes,\n  sr.metadata');
}

async function loadServiceRecords(pg, clientSlug, bookingCode) {
  try {
    const r = await pg.query(bookingServicesRecordsSql(), [clientSlug, bookingCode]);
    return { rows: r.rows, available: true };
  } catch (err) {
    if (isMissingBookingServiceRecordsTable(err)) {
      return { rows: [], available: false };
    }
    throw err;
  }
}

async function handleGetBookingServices(bookingId, query, res) {
  const clientSlug = trimStr(query.client_slug || query.client);
  if (!clientSlug) {
    return res.status(400).json({ success: false, error: 'client_slug is required' });
  }

  const timezone = clientTimezone(clientSlug);

  try {
    const result = await withPgClient(async (pg) => {
      const bkRes = await pg.query(BOOKING_BY_ID_SQL, [clientSlug, bookingId]);
      const booking = bkRes.rows[0];
      if (!booking) return { notFound: true };

      const svc = await loadServiceRecords(pg, clientSlug, booking.booking_code);
      const schedule = buildBookingServicesSchedule({
        booking,
        serviceRecords: svc.rows,
        timezone,
      });

      return {
        notFound: false,
        payload: {
          success: true,
          client_slug: clientSlug,
          booking_id: bookingId,
          booking_code: booking.booking_code,
          services_available: svc.available,
          ...schedule,
          no_payment_write: true,
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

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @param {object} query
 * @returns {Promise<boolean>}
 */
async function dispatchBookingServicesRoute(req, res, pathname, query) {
  const match = BOOKING_SERVICES_RE.exec(pathname);
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
    await handleGetBookingServices(bookingId, query, jsonRes);
    return true;
  }

  res.writeHead(405, { Allow: 'GET' });
  res.end(JSON.stringify({ success: false, error: 'Method not allowed' }));
  return true;
}

module.exports = {
  BOOKING_SERVICES_RE,
  dispatchBookingServicesRoute,
  handleGetBookingServices,
  buildBookingServicesSchedule,
  loadServiceRecords,
};

/**
 * Phase 26g/26h — Staff API routes for booking services schedule.
 *
 * GET  /staff/bookings/:booking_id/services — read schedule (no payment writes).
 * PATCH /staff/bookings/:booking_id/services/:service_record_id/date — service_date only.
 *
 * @module staff-booking-services-routes
 */

'use strict';

const { withPgClient } = require('./pg-connect');
const { getClientTransferConfig } = require('./client-transfer-config');
const { getBookingServiceRecordsQuery } = require('./staff-booking-detail-queries');
const {
  buildBookingServicesSchedule,
  formatServiceRecordForSchedule,
  isServiceDateInStay,
  splitMultiQuantityServiceRecords,
} = require('./staff-booking-services-schedule');
const { rebalanceBookingWetsuitBoardCombo } = require('./guest-addon-combo-rebalance-db');

const BOOKING_SERVICES_RE = /^\/staff\/bookings\/([0-9a-f-]{36})\/services$/i;
const BOOKING_SERVICE_DATE_RE =
  /^\/staff\/bookings\/([0-9a-f-]{36})\/services\/([0-9a-f-]{36})\/date$/i;

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

const SERVICE_RECORD_BY_ID_SQL = `
SELECT sr.id::text AS service_record_id,
       sr.booking_id::text AS booking_id,
       sr.service_type,
       sr.service_date::text AS service_date,
       sr.quantity,
       sr.status,
       sr.payment_status,
       sr.amount_due_cents,
       sr.notes,
       sr.metadata
  FROM booking_service_records sr
 WHERE sr.id = $1::uuid
   AND sr.client_slug = $2
   AND sr.booking_id = $3::uuid
 LIMIT 1
`;

const UPDATE_SERVICE_DATE_SQL = `
UPDATE booking_service_records
   SET service_date = $1,
       updated_at = NOW()
 WHERE id = $2::uuid
   AND client_slug = $3
   AND booking_id = $4::uuid
 RETURNING id::text AS service_record_id,
           service_type,
           service_date::text AS service_date,
           quantity,
           status,
           payment_status,
           amount_due_cents,
           notes,
           metadata
`;

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
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

      await splitMultiQuantityServiceRecords(pg, clientSlug, bookingId);
      await rebalanceBookingWetsuitBoardCombo(pg, clientSlug, bookingId);
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

async function handlePatchBookingServiceDate(bookingId, serviceRecordId, req, res) {
  let body = {};
  try {
    const raw = await readRequestBody(req);
    body = JSON.parse(raw || '{}');
  } catch {
    return res.status(400).json({ success: false, error: 'invalid or missing JSON body' });
  }

  const clientSlug = trimStr(body.client_slug || body.client);
  if (!clientSlug) {
    return res.status(400).json({ success: false, error: 'client_slug is required' });
  }

  const clearing = body.service_date === null;
  if (!clearing && (body.service_date === undefined || body.service_date === '')) {
    return res.status(400).json({ success: false, error: 'service_date is required or null' });
  }

  let serviceDate = null;
  if (!clearing) {
    serviceDate = trimStr(body.service_date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) {
      return res.status(400).json({ success: false, error: 'service_date must be YYYY-MM-DD or null' });
    }
  }

  const timezone = clientTimezone(clientSlug);

  try {
    const result = await withPgClient(async (pg) => {
      const bkRes = await pg.query(BOOKING_BY_ID_SQL, [clientSlug, bookingId]);
      const booking = bkRes.rows[0];
      if (!booking) return { notFound: true };

      if (!clearing && !isServiceDateInStay(serviceDate, booking.check_in, booking.check_out, timezone)) {
        return {
          invalidDate: true,
          message: 'service_date must fall within stay nights (check-in through day before checkout)',
        };
      }

      const existing = await pg.query(SERVICE_RECORD_BY_ID_SQL, [
        serviceRecordId,
        clientSlug,
        bookingId,
      ]);
      if (!existing.rows[0]) return { recordNotFound: true };

      const upd = await pg.query(UPDATE_SERVICE_DATE_SQL, [
        clearing ? null : serviceDate,
        serviceRecordId,
        clientSlug,
        bookingId,
      ]);
      const updatedRow = upd.rows[0];
      if (!updatedRow) return { updateFailed: true };

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
          service_record: formatServiceRecordForSchedule(updatedRow, { timezone }),
          ...schedule,
          no_payment_write: true,
        },
      };
    });

    if (result.notFound) {
      return res.status(404).json({ success: false, error: 'booking not found' });
    }
    if (result.recordNotFound) {
      return res.status(404).json({ success: false, error: 'service record not found' });
    }
    if (result.invalidDate) {
      return res.status(400).json({ success: false, error: result.message });
    }
    if (result.updateFailed) {
      return res.status(500).json({ success: false, error: 'update failed' });
    }
    return res.status(200).json(result.payload);
  } catch (err) {
    return res.status(500).json({ success: false, error: 'update failed', detail: err.message });
  }
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @returns {Promise<boolean>}
 */
async function dispatchBookingServiceDateRoute(req, res, pathname) {
  const match = BOOKING_SERVICE_DATE_RE.exec(pathname);
  if (!match) return false;

  const bookingId = match[1];
  const serviceRecordId = match[2];
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

  if (req.method === 'PATCH') {
    await handlePatchBookingServiceDate(bookingId, serviceRecordId, req, jsonRes);
    return true;
  }

  res.writeHead(405, { Allow: 'PATCH' });
  res.end(JSON.stringify({ success: false, error: 'Method not allowed' }));
  return true;
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
  BOOKING_SERVICE_DATE_RE,
  dispatchBookingServicesRoute,
  dispatchBookingServiceDateRoute,
  handleGetBookingServices,
  handlePatchBookingServiceDate,
  buildBookingServicesSchedule,
  loadServiceRecords,
  isServiceDateInStay,
};

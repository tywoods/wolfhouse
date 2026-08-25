'use strict';

/**
 * Sunset Admin Bookings tab (N1) — DB read model + manual refund write.
 * Tenant + location fail closed. No Stripe refunds.
 *
 * @module sunset-bookings-admin-data
 */

const {
  SUNSET_CLIENT_SLUG,
  isSunsetLocationId,
  normalizeSunsetLocationId,
} = require('./sunset-school-locations');
const {
  BookingsAdminError,
  buildBookingListRow,
  computeBookingsSummary,
  filterBookingRows,
  parseListQuery,
  parseMeta,
  validateRefundWriteInput,
  refundIdempotencyPayloadMatches,
  assertRefundWithinCollected,
  rowsToCsv,
  clampNonNegative,
  checkedAdd,
  sortBookingRows,
  buildListBookingsOrderBySql,
  EXPORT_HARD_CAP,
  LIST_MAX_LIMIT,
} = require('./sunset-bookings-admin');

const DEFAULT_LOCATION = 'sunset-somo';

const LODGING_BOOKINGS_CLIENT_SLUG = 'wolfhouse-somo';

function isLodgingBookingsClient(slug) {
  return String(slug || '').trim() === LODGING_BOOKINGS_CLIENT_SLUG;
}

/**
 * Resolve and validate list/write scope. Unknown/conflicting location fails closed.
 * Lodging (wolfhouse-somo) is client-scoped — no Sunset school location.
 * @returns {{ ok:true, clientSlug:string, locationId:string|null, lodging?:boolean } | { ok:false, status:number, error:string }}
 */
function resolveBookingsAdminScope(query, opts) {
  const q = query || {};
  const rawClient = q.client != null ? q.client : q.client_slug;
  const clientSlug = typeof rawClient === 'string' ? rawClient.trim() : '';
  if (!clientSlug) return { ok: false, status: 400, error: 'invalid request' };
  if (opts && opts.sqlInjectRe && opts.sqlInjectRe.test(clientSlug)) {
    return { ok: false, status: 400, error: 'invalid request' };
  }
  if (isLodgingBookingsClient(clientSlug)) {
    const rawLoc = typeof q.location === 'string' ? q.location.trim()
      : (typeof q.location_id === 'string' ? q.location_id.trim() : '');
    if (rawLoc && isSunsetLocationId(rawLoc)) {
      return { ok: false, status: 403, error: 'bookings unavailable' };
    }
    return { ok: true, clientSlug, locationId: null, lodging: true };
  }
  if (clientSlug !== SUNSET_CLIENT_SLUG) {
    return { ok: false, status: 403, error: 'bookings unavailable' };
  }

  const rawLoc = typeof q.location === 'string' ? q.location.trim()
    : (typeof q.location_id === 'string' ? q.location_id.trim() : '');
  if (!rawLoc) return { ok: false, status: 403, error: 'bookings unavailable' };
  if (!isSunsetLocationId(rawLoc)) {
    return { ok: false, status: 403, error: 'bookings unavailable' };
  }
  const locationId = normalizeSunsetLocationId(rawLoc);

  // Explicit conflict: body location must match query location when both supplied.
  if (opts && opts.bodyLocation != null && String(opts.bodyLocation).trim()) {
    const bodyLoc = String(opts.bodyLocation).trim();
    if (!isSunsetLocationId(bodyLoc)
      || normalizeSunsetLocationId(bodyLoc) !== locationId) {
      return { ok: false, status: 403, error: 'location conflict' };
    }
  }

  return { ok: true, clientSlug, locationId };
}

// Location scope: booking metadata, with service-record metadata fallback.
// Matches schedule drawer resolve pattern via COALESCE.
const LOCATION_SQL = `COALESCE(b.metadata->>'location_id', (
  SELECT bsr.metadata->>'location_id'
    FROM booking_service_records bsr
   WHERE bsr.booking_id = b.id AND bsr.client_slug = c.slug
     AND bsr.metadata->>'location_id' IS NOT NULL
   ORDER BY bsr.created_at ASC NULLS LAST
   LIMIT 1
), '${DEFAULT_LOCATION}')`;

const LIST_BOOKINGS_SQL_BASE = `
SELECT
  b.id::text AS booking_id,
  b.booking_code,
  b.guest_name,
  b.phone,
  b.email,
  b.status::text AS status,
  b.payment_status::text AS payment_status,
  b.booking_source::text AS booking_source,
  b.operator_name,
  b.check_in::text AS check_in,
  b.check_out::text AS check_out,
  b.package_code,
  b.total_amount_cents,
  b.amount_paid_cents,
  b.balance_due_cents,
  b.metadata,
  b.hidden,
  b.created_at,
  c.id AS client_id,
  c.slug AS client_slug,
  ${LOCATION_SQL} AS location_id
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND ${LOCATION_SQL} = $2
`;

const LIST_BOOKINGS_SQL_LODGING_BASE = `
SELECT
  b.id::text AS booking_id,
  b.booking_code,
  b.guest_name,
  b.phone,
  b.email,
  b.status::text AS status,
  b.payment_status::text AS payment_status,
  b.booking_source::text AS booking_source,
  b.operator_name,
  b.check_in::text AS check_in,
  b.check_out::text AS check_out,
  b.package_code,
  b.total_amount_cents,
  b.amount_paid_cents,
  b.balance_due_cents,
  b.metadata,
  b.hidden,
  b.created_at,
  c.id AS client_id,
  c.slug AS client_slug,
  NULL::text AS location_id
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
`;

const LIST_BOOKINGS_SQL = `${LIST_BOOKINGS_SQL_BASE}
ORDER BY b.created_at DESC NULLS LAST, b.booking_code ASC
`;

function buildListBookingsSql(sort, dir, lodging) {
  const orderBy = buildListBookingsOrderBySql(sort, dir);
  return `${lodging ? LIST_BOOKINGS_SQL_LODGING_BASE : LIST_BOOKINGS_SQL_BASE}
${orderBy}
`;
}
const SERVICES_FOR_BOOKINGS_SQL = `
SELECT
  bsr.id::text AS service_record_id,
  bsr.booking_id::text AS booking_id,
  bsr.service_type::text AS service_type,
  bsr.service_date::text AS service_date,
  bsr.quantity,
  bsr.amount_due_cents,
  bsr.amount_paid_cents,
  bsr.status::text AS status,
  bsr.payment_status::text AS payment_status,
  bsr.metadata
FROM booking_service_records bsr
INNER JOIN bookings b ON b.id = bsr.booking_id
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND bsr.client_slug = c.slug
  AND b.id = ANY($2::uuid[])
ORDER BY bsr.service_date NULLS LAST, bsr.id
`;

const PAYMENTS_FOR_BOOKINGS_SQL = `
SELECT
  p.booking_id::text AS booking_id,
  COALESCE(SUM(p.amount_paid_cents), 0)::bigint AS collected_cents
FROM payments p
INNER JOIN bookings b ON b.id = p.booking_id AND p.client_id = b.client_id
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND b.id = ANY($2::uuid[])
  AND p.status = 'paid'::payment_record_status
  AND p.paid_at IS NOT NULL
  AND COALESCE((p.metadata->>'test_booking_cancelled')::boolean, false) = false
GROUP BY p.booking_id
`;

const REFUNDS_FOR_BOOKINGS_SQL = `
SELECT
  r.id::text AS refund_id,
  r.booking_id::text AS booking_id,
  r.amount_cents,
  r.effective_date::text AS effective_date,
  r.reason,
  r.staff_user_id,
  r.staff_email,
  r.staff_role,
  r.idempotency_key,
  r.source,
  r.created_at,
  r.location_id
FROM booking_refund_records r
INNER JOIN bookings b ON b.id = r.booking_id AND r.client_id = b.client_id
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND b.id = ANY($2::uuid[])
ORDER BY r.created_at ASC, r.id ASC
`;

const WAIVER_FOR_BOOKINGS_SQL = `
SELECT DISTINCT ON (w.booking_id)
  w.booking_id::text AS booking_id,
  w.status::text AS waiver_status,
  w.request_mode,
  w.public_id,
  (SELECT COUNT(*)::int FROM waiver_form_submissions s WHERE s.request_id = w.id) AS completed_count,
  w.target_count
FROM waiver_form_requests w
INNER JOIN bookings b ON b.id = w.booking_id
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND b.id = ANY($2::uuid[])
ORDER BY w.booking_id, w.created_at DESC NULLS LAST
`;

function rows(result) {
  return result && Array.isArray(result.rows) ? result.rows : [];
}

function groupByBookingId(list) {
  const map = new Map();
  for (const item of list || []) {
    const id = String(item.booking_id || '');
    if (!id) continue;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(item);
  }
  return map;
}

function sumRefunds(refundRows) {
  let sum = 0;
  for (const r of refundRows || []) {
    sum = checkedAdd(sum, r.amount_cents != null ? Number(r.amount_cents) : 0);
  }
  return sum;
}

async function fetchScopedBookingRows(pg, clientSlug, locationId, sortOpts) {
  const lodging = !locationId;
  const listSql = buildListBookingsSql(
    sortOpts && sortOpts.sort,
    sortOpts && sortOpts.dir,
    lodging,
  );
  const bookingRes = await pg.query(listSql, lodging ? [clientSlug] : [clientSlug, locationId]);
  const bookingRows = rows(bookingRes);
  if (!bookingRows.length) return [];

  const ids = bookingRows.map((b) => b.booking_id);
  const [svcRes, payRes, refundRes, waiverRes] = await Promise.all([
    pg.query(SERVICES_FOR_BOOKINGS_SQL, [clientSlug, ids]),
    pg.query(PAYMENTS_FOR_BOOKINGS_SQL, [clientSlug, ids]),
    pg.query(REFUNDS_FOR_BOOKINGS_SQL, [clientSlug, ids]).catch((err) => {
      // Table may be absent on older DBs before migration apply — fail soft to empty.
      if (err && (err.code === '42P01' || /booking_refund_records/i.test(String(err.message || '')))) {
        return { rows: [] };
      }
      throw err;
    }),
    pg.query(WAIVER_FOR_BOOKINGS_SQL, [clientSlug, ids]).catch((err) => {
      if (err && (err.code === '42P01' || /waiver_form/i.test(String(err.message || '')))) {
        return { rows: [] };
      }
      throw err;
    }),
  ]);

  const servicesBy = groupByBookingId(rows(svcRes));
  const payBy = new Map(rows(payRes).map((r) => [String(r.booking_id), Number(r.collected_cents || 0)]));
  const refundsBy = groupByBookingId(rows(refundRes));
  const waiverBy = new Map(rows(waiverRes).map((r) => [String(r.booking_id), r]));

  // Authoritative rental catalog labels for item display names (exact offering_key).
  let catalogLabelMap = null;
  try {
    const { listRentalOfferings } = require('./tenant-rental-offerings');
    const { buildRentalCatalogLabelMap } = require('./rental-offering-label');
    const offerings = await listRentalOfferings(pg, {
      clientSlug,
      locationId,
      includeInactive: true, // historical readers may need retired offering labels
    });
    catalogLabelMap = buildRentalCatalogLabelMap(offerings, {
      clientSlug,
      locationId,
      includeInactive: true,
    });
  } catch (_e) {
    catalogLabelMap = null;
  }

  return bookingRows.map((b) => {
    const services = servicesBy.get(String(b.booking_id)) || [];
    const refunds = (refundsBy.get(String(b.booking_id)) || []).map((r) => ({
      refund_id: r.refund_id,
      amount_cents: Number(r.amount_cents || 0),
      effective_date: r.effective_date,
      reason: r.reason,
      staff_user_id: r.staff_user_id || null,
      staff_email: r.staff_email || null,
      staff_role: r.staff_role || null,
      idempotency_key: r.idempotency_key,
      source: r.source || 'staff_manual_record',
      created_at: r.created_at,
      manual_record: true,
    }));
    const collected = payBy.has(String(b.booking_id))
      ? payBy.get(String(b.booking_id))
      : clampNonNegative(b.amount_paid_cents || 0);
    const refunded = sumRefunds(refunds);
    const waiverRow = waiverBy.get(String(b.booking_id));
    return buildBookingListRow({
      booking: b,
      services,
      collected_cents: collected,
      refunded_cents: refunded,
      refunds,
      location_id: b.location_id || locationId,
      catalog_label_map: catalogLabelMap,
      waiver: waiverRow
        ? {
          status: waiverRow.waiver_status || null,
          request_mode: waiverRow.request_mode || null,
          public_id: waiverRow.public_id || null,
          completed_count: waiverRow.completed_count != null ? Number(waiverRow.completed_count) : null,
          target_count: waiverRow.target_count != null ? Number(waiverRow.target_count) : null,
        }
        : null,
    });
  });
}

/**
 * List bookings for Admin Bookings panel. Summary is filter-global;
 * `rows` is the requested page slice.
 */
async function listSunsetBookingsAdmin(pg, scope, query) {
  const clientSlug = String((scope && scope.clientSlug) || '').trim();
  const locationId = String((scope && scope.locationId) || '').trim();
  const lodging = !!(scope && scope.lodging);
  if (!lodging && (clientSlug !== SUNSET_CLIENT_SLUG || !isSunsetLocationId(locationId))) {
    throw new BookingsAdminError('bookings_unavailable', 'bookings unavailable', 403);
  }

  const filters = parseListQuery(query, { mode: 'list' });
  // Force location match to scope (query location filter may not broaden).
  filters.location_id = lodging ? null : locationId;

  await pg.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  let allRows;
  try {
    allRows = await fetchScopedBookingRows(pg, clientSlug, locationId, {
      sort: filters.sort,
      dir: filters.dir,
    });
    await pg.query('COMMIT');
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch (_e) { /* ignore */ }
    throw err;
  }

  const filtered = filterBookingRows(allRows, filters);
  // Server-side sort of the full filtered set (not just the visible page).
  const sorted = sortBookingRows(filtered, filters.sort, filters.dir);
  const summary = computeBookingsSummary(sorted);
  const page = sorted.slice(filters.offset, filters.offset + filters.limit);

  return {
    success: true,
    client: clientSlug,
    location_id: locationId,
    filters: {
      q: filters.q || null,
      date_from: filters.date_from,
      date_to: filters.date_to,
      status: filters.status,
      type: filters.type,
      include_archived: filters.include_archived,
      limit: filters.limit,
      offset: filters.offset,
      sort: filters.sort || null,
      dir: filters.sort ? filters.dir : null,
    },
    summary,
    total_count: sorted.length,
    rows: page,
  };
}

/**
 * Dedicated export path: applies the same active filters as the list, but does
 * NOT use the interactive page-size cap (LIST_MAX_LIMIT=200). Exports all matching
 * rows up to EXPORT_HARD_CAP with a truthful truncated contract if exceeded.
 * Summary is always filter-global (full match set).
 */
async function exportSunsetBookingsAdminCsv(pg, scope, query) {
  const clientSlug = String((scope && scope.clientSlug) || '').trim();
  const locationId = String((scope && scope.locationId) || '').trim();
  const lodging = !!(scope && scope.lodging);
  if (!lodging && (clientSlug !== SUNSET_CLIENT_SLUG || !isSunsetLocationId(locationId))) {
    throw new BookingsAdminError('bookings_unavailable', 'bookings unavailable', 403);
  }

  const filters = parseListQuery(query, { mode: 'export' });
  filters.location_id = lodging ? null : locationId;
  filters.offset = 0;

  await pg.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  let allRows;
  try {
    allRows = await fetchScopedBookingRows(pg, clientSlug, locationId, {
      sort: filters.sort,
      dir: filters.dir,
    });
    await pg.query('COMMIT');
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch (_e) { /* ignore */ }
    throw err;
  }

  const filtered = filterBookingRows(allRows, filters);
  const sorted = sortBookingRows(filtered, filters.sort, filters.dir);
  const summary = computeBookingsSummary(sorted);
  const totalMatching = sorted.length;
  const truncated = totalMatching > EXPORT_HARD_CAP;
  const exportRows = truncated ? sorted.slice(0, EXPORT_HARD_CAP) : sorted;
  let csv = rowsToCsv(exportRows);
  if (truncated) {
    // Truthful non-formula comment header for operators (not a data row).
    csv = `# truncated=true; exported=${exportRows.length}; matched=${totalMatching}; hard_cap=${EXPORT_HARD_CAP}\n${csv}`;
  }

  return {
    success: true,
    client: clientSlug,
    location_id: locationId,
    filters: {
      q: filters.q || null,
      date_from: filters.date_from,
      date_to: filters.date_to,
      status: filters.status,
      type: filters.type,
      include_archived: filters.include_archived,
      limit: null,
      offset: 0,
      mode: 'export',
      hard_cap: EXPORT_HARD_CAP,
      sort: filters.sort || null,
      dir: filters.sort ? filters.dir : null,
    },
    summary,
    csv,
    row_count: exportRows.length,
    total_matching: totalMatching,
    truncated,
  };
}

async function loadCollectedGrossForBooking(pg, clientSlug, bookingId) {
  const r = await pg.query(
    `SELECT COALESCE(SUM(p.amount_paid_cents), 0)::bigint AS collected_cents
       FROM payments p
       INNER JOIN bookings b ON b.id = p.booking_id AND p.client_id = b.client_id
       INNER JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1
        AND p.booking_id = $2::uuid
        AND p.status = 'paid'::payment_record_status
        AND p.paid_at IS NOT NULL
        AND COALESCE((p.metadata->>'test_booking_cancelled')::boolean, false) = false`,
    [clientSlug, bookingId],
  );
  return Number(rows(r)[0] && rows(r)[0].collected_cents || 0);
}

async function loadRefundedSumForBooking(pg, clientId, bookingId) {
  const r = await pg.query(
    `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS refunded_cents
       FROM booking_refund_records
      WHERE client_id = $1::uuid AND booking_id = $2::uuid`,
    [clientId, bookingId],
  );
  return Number(rows(r)[0] && rows(r)[0].refunded_cents || 0);
}

/**
 * Record a manual refund. Transaction + booking FOR UPDATE to prevent concurrent over-refund.
 * Idempotent on (client_id, idempotency_key).
 */
async function recordSunsetBookingRefund(pg, opts) {
  const clientSlug = String((opts && opts.clientSlug) || '').trim();
  const locationId = String((opts && opts.locationId) || '').trim();
  const bookingId = String((opts && opts.bookingId) || '').trim();
  const body = (opts && opts.body) || {};
  const actor = (opts && opts.actor) || {};

  if (clientSlug !== SUNSET_CLIENT_SLUG) {
    return { ok: false, status: 403, body: { success: false, error: 'bookings unavailable' } };
  }
  if (!isSunsetLocationId(locationId)) {
    return { ok: false, status: 403, body: { success: false, error: 'bookings unavailable' } };
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bookingId)) {
    return { ok: false, status: 400, body: { success: false, error: 'booking_id is required' } };
  }

  const validated = validateRefundWriteInput(body);
  if (!validated.ok) {
    return { ok: false, status: 400, body: { success: false, error: validated.error } };
  }

  let began = false;
  try {
    await pg.query('BEGIN');
    began = true;

    // Lock booking row for tenant; reject wrong tenant/location.
    let bookingRes;
    try {
      bookingRes = await pg.query(
        `SELECT b.id::text AS booking_id, b.booking_code, b.guest_name, b.phone, b.email,
                b.status::text AS status, b.payment_status::text AS payment_status,
                b.booking_source::text AS booking_source, b.operator_name,
                b.check_in::text AS check_in, b.check_out::text AS check_out,
                b.total_amount_cents, b.amount_paid_cents, b.balance_due_cents,
                b.metadata, b.hidden, b.created_at, c.id AS client_id, c.slug AS client_slug,
                ${LOCATION_SQL} AS location_id
           FROM bookings b
           INNER JOIN clients c ON c.id = b.client_id
          WHERE c.slug = $1 AND b.id = $2::uuid
          FOR UPDATE OF b`,
        [clientSlug, bookingId],
      );
    } catch (lockErr) {
      await pg.query('ROLLBACK'); began = false;
      const msg = String(lockErr && lockErr.message || lockErr || '');
      if (/could not obtain lock|lock_not_available|55P03/i.test(msg)) {
        return {
          ok: false,
          status: 409,
          body: { success: false, error: 'booking_busy', message: 'Booking is being updated; retry shortly.' },
        };
      }
      throw lockErr;
    }

    const booking = rows(bookingRes)[0];
    if (!booking) {
      await pg.query('ROLLBACK'); began = false;
      return { ok: false, status: 404, body: { success: false, error: 'booking not found' } };
    }
    if (normalizeSunsetLocationId(booking.location_id) !== normalizeSunsetLocationId(locationId)) {
      await pg.query('ROLLBACK'); began = false;
      return { ok: false, status: 404, body: { success: false, error: 'booking_not_in_active_school' } };
    }

    // ESSENTIAL: manual refund only on cancelled bookings.
    const st = String(booking.status || '').toLowerCase();
    if (st !== 'cancelled' && st !== 'canceled') {
      await pg.query('ROLLBACK'); began = false;
      return {
        ok: false,
        status: 409,
        body: {
          success: false,
          error: 'booking_not_cancelled',
          message: 'Record a refund only after the booking is cancelled.',
        },
      };
    }


    // Idempotent retry: only when existing record matches full semantic payload.
    const existingIdem = await pg.query(
      `SELECT id::text AS refund_id, booking_id::text AS booking_id, location_id,
              amount_cents, effective_date::text AS effective_date,
              reason, staff_user_id, staff_email, staff_role, idempotency_key, source, created_at
         FROM booking_refund_records
        WHERE client_id = $1::uuid AND idempotency_key = $2
        LIMIT 1
        FOR UPDATE`,
      [booking.client_id, validated.idempotency_key],
    );
    if (rows(existingIdem)[0]) {
      const existing = rows(existingIdem)[0];
      const payloadOk = refundIdempotencyPayloadMatches(existing, {
        amount_cents: validated.amount_cents,
        effective_date: validated.effective_date,
        reason: validated.reason,
        booking_id: bookingId,
        location_id: locationId,
      });
      if (!payloadOk) {
        await pg.query('ROLLBACK'); began = false;
        return {
          ok: false,
          status: 409,
          body: {
            success: false,
            error: 'refund_idempotency_conflict',
            message: 'Idempotency key already used with a different refund payload.',
          },
        };
      }
      // Re-read authoritative row after commit path for response consistency.
      await pg.query('COMMIT'); began = false;
      const list = await listSunsetBookingsAdmin(pg, { clientSlug, locationId }, {
        q: booking.booking_code,
        include_archived: true,
        limit: 1,
        offset: 0,
      });
      const row = (list.rows || []).find((r) => r.booking_id === bookingId) || list.rows[0] || null;
      return {
        ok: true,
        status: 200,
        body: {
          success: true,
          idempotent: true,
          refund: {
            refund_id: existing.refund_id,
            amount_cents: Number(existing.amount_cents),
            effective_date: existing.effective_date,
            reason: existing.reason,
            staff_user_id: existing.staff_user_id,
            staff_email: existing.staff_email,
            staff_role: existing.staff_role,
            idempotency_key: existing.idempotency_key,
            source: existing.source || 'staff_manual_record',
            created_at: existing.created_at,
            manual_record: true,
          },
          row,
          summary: list.summary,
          message: 'Manual refund record already exists for this idempotency key (no Stripe refund).',
        },
      };
    }

    const collected = await loadCollectedGrossForBooking(pg, clientSlug, bookingId);
    const existingRefunded = await loadRefundedSumForBooking(pg, booking.client_id, bookingId);
    try {
      assertRefundWithinCollected(collected, existingRefunded, validated.amount_cents);
    } catch (moneyErr) {
      await pg.query('ROLLBACK'); began = false;
      if (moneyErr instanceof BookingsAdminError) {
        return {
          ok: false,
          status: moneyErr.status || 409,
          body: { success: false, error: moneyErr.code, message: moneyErr.message },
        };
      }
      throw moneyErr;
    }

    const insert = await pg.query(
      `INSERT INTO booking_refund_records (
         client_id, booking_id, location_id, amount_cents, currency,
         effective_date, reason, staff_user_id, staff_email, staff_role,
         idempotency_key, source, metadata
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, 'EUR',
         $5::date, $6, $7, $8, $9,
         $10, 'staff_manual_record', $11::jsonb
       )
       RETURNING id::text AS refund_id, amount_cents, effective_date::text AS effective_date,
                 reason, staff_user_id, staff_email, staff_role, idempotency_key, source, created_at`,
      [
        booking.client_id,
        bookingId,
        locationId,
        validated.amount_cents,
        validated.effective_date,
        validated.reason,
        actor.staff_user_id || null,
        actor.email || actor.staff_email || null,
        actor.role || actor.staff_role || null,
        validated.idempotency_key,
        JSON.stringify({
          provenance: 'admin_bookings_n1',
          manual_record: true,
          stripe_refund: false,
          recorded_at: new Date().toISOString(),
        }),
      ],
    );

    const refund = rows(insert)[0];
    await pg.query('COMMIT');
    began = false;

    const list = await listSunsetBookingsAdmin(pg, { clientSlug, locationId }, {
      q: booking.booking_code,
      include_archived: true,
      limit: 5,
      offset: 0,
    });
    const row = (list.rows || []).find((r) => r.booking_id === bookingId) || null;

    return {
      ok: true,
      status: 201,
      body: {
        success: true,
        idempotent: false,
        refund: {
          refund_id: refund.refund_id,
          amount_cents: Number(refund.amount_cents),
          effective_date: refund.effective_date,
          reason: refund.reason,
          staff_user_id: refund.staff_user_id,
          staff_email: refund.staff_email,
          staff_role: refund.staff_role,
          idempotency_key: refund.idempotency_key,
          source: refund.source || 'staff_manual_record',
          created_at: refund.created_at,
          manual_record: true,
        },
        row,
        summary: list.summary,
        message: 'Manual refund record saved. This does not return money through Stripe.',
      },
    };
  } catch (err) {
    if (began) {
      try { await pg.query('ROLLBACK'); } catch (_e) { /* ignore */ }
    }
    // Unique violation on idempotency race: re-enter for payload-matched idempotent
    // success or payload-mismatch conflict (never invent success for a different payload).
    if (err && err.code === '23505') {
      try {
        return await recordSunsetBookingRefund(pg, opts);
      } catch (_e2) {
        return {
          ok: false,
          status: 409,
          body: { success: false, error: 'refund_idempotency_conflict' },
        };
      }
    }
    console.error('[bookings.admin.refund] write failed:', err && err.code, err && err.message);
    return {
      ok: false,
      status: 500,
      body: { success: false, error: 'write failed' },
    };
  }
}

module.exports = {
  resolveBookingsAdminScope,
  listSunsetBookingsAdmin,
  exportSunsetBookingsAdminCsv,
  recordSunsetBookingRefund,
  fetchScopedBookingRows,
  LIST_BOOKINGS_SQL,
  LIST_BOOKINGS_SQL_BASE,
  buildListBookingsSql,
  SERVICES_FOR_BOOKINGS_SQL,
  PAYMENTS_FOR_BOOKINGS_SQL,
  REFUNDS_FOR_BOOKINGS_SQL,
  LOCATION_SQL,
  loadCollectedGrossForBooking,
  loadRefundedSumForBooking,
  EXPORT_HARD_CAP,
  LIST_MAX_LIMIT,
};

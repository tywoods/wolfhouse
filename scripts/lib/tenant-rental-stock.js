'use strict';

/**
 * Canonical rental stock calculator + row-lock contract.
 *
 * Foundation for location-scoped physical stock on tenant_rental_offerings
 * (migration 055). Every Admin-created offering is independent by exact
 * offering_key — including a user-created "Surfboard + Wetsuit" item. There is
 * no hidden bundle/component deduction model.
 *
 * Pure math is injectable (no DB). Data-access helpers build the SQL later
 * Create/Edit/Restore transactions will call. Concurrency is proven at the
 * module boundary via createInMemoryStockTxnGate (no live DB required).
 *
 * Contracts:
 *   - stock_quantity integer 0..999; null/undefined = unconfigured → fail closed
 *   - remaining(date) = stock − active reserved quantity that day
 *   - multi-day availability = min remaining across the inclusive date range
 *   - cancelled / archived / hold / expired reservations do not consume stock
 *   - multi-day occupancy from metadata.rental_service_dates / covered_dates
 *   - edit checks may exclude the booking being replaced
 *   - lock candidate rows FOR UPDATE (exact location + NULL fallback), then
 *     resolve one canonical row per key (exact before NULL); missing → fail closed
 *   - shared (NULL location) stock loads reservations client-wide
 *
 * Refs: .hermes/plans/2026-07-31_173018-rental-equipment-stock.md slice 2.
 */

const STOCK_MIN = 0;
const STOCK_MAX = 999;
const ERROR_STOCK_NOT_CONFIGURED = 'rental_stock_not_configured';
const ERROR_STOCK_UNAVAILABLE = 'rental_stock_unavailable';
const ERROR_INVALID_STOCK = 'invalid_stock_quantity';
const ERROR_INVALID_REQUEST = 'invalid_stock_request';

const INACTIVE_BOOKING_STATUSES = new Set(['cancelled', 'canceled', 'expired']);

function isValidStockQuantity(value) {
  return Number.isInteger(value) && value >= STOCK_MIN && value <= STOCK_MAX;
}

/**
 * Validate a stock_quantity input for catalog create/update.
 * null/undefined → unconfigured (ok, value null).
 * Integer 0..999 → ok.
 * Anything else → reject.
 */
function validateStockQuantity(raw) {
  if (raw === null || raw === undefined) {
    return { ok: true, value: null };
  }
  if (!isValidStockQuantity(raw)) {
    return {
      ok: false,
      error: ERROR_INVALID_STOCK,
      message: `stock_quantity must be an integer ${STOCK_MIN}..${STOCK_MAX} or null`,
    };
  }
  return { ok: true, value: raw };
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Inclusive YYYY-MM-DD range. Inverted or invalid → empty array (fail closed).
 */
function inclusiveIsoDates(dateFrom, dateTo) {
  const from = String(dateFrom || '').slice(0, 10);
  const to = String(dateTo || '').slice(0, 10);
  if (!isIsoDate(from) || !isIsoDate(to) || from > to) return [];
  const out = [];
  // UTC noon avoids DST edge when stepping calendar days.
  let cur = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur = new Date(cur.getTime() + 24 * 60 * 60 * 1000);
  }
  return out;
}

function truthyArchivedFlag(value) {
  return value === true || value === 'true';
}

/**
 * Active reservation truth aligned with sunset-schedule-queries gear filters
 * plus schedule_archived exclusion (stock must not count archived demand).
 */
function isActiveReservation(row) {
  if (!row || typeof row !== 'object') return false;
  const status = String(row.status || '').toLowerCase();
  if (status === 'cancelled') return false;
  const bookingStatus = String(
    row.booking_status != null ? row.booking_status : (row.bookingStatus || ''),
  ).toLowerCase();
  if (bookingStatus && INACTIVE_BOOKING_STATUSES.has(bookingStatus)) return false;
  if (truthyArchivedFlag(row.schedule_archived)) return false;
  if (truthyArchivedFlag(row.sr_schedule_archived)) return false;
  if (truthyArchivedFlag(row.archived)) return false;
  return true;
}

/**
 * Coerce pg/jsonb date-array fields into ISO date strings.
 * Accepts arrays, JSON strings, and ignores malformed values safely.
 * Aligns with isIsoDate exact-shape semantics (no prefix slice on elements —
 * '2026-08-01junk' is not usable).
 */
function coerceIsoDateArray(raw) {
  if (raw == null) return [];
  let value = raw;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      value = JSON.parse(trimmed);
    } catch (_) {
      // Single bare date string is not a multi-day array.
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value.map((d) => String(d == null ? '' : d).trim()).filter(isIsoDate),
  )].sort();
}

/**
 * True when rental_service_dates or covered_dates contains any exact ISO date.
 * Used for service_date fallback parity with SQL (not merely empty arrays).
 */
function reservationHasUsableOccupiedDates(row) {
  const r = row || {};
  if (coerceIsoDateArray(r.rental_service_dates).length) return true;
  if (coerceIsoDateArray(r.covered_dates).length) return true;
  return false;
}

/**
 * Effective location for a reservation row.
 * Service metadata first, booking metadata second, then explicit default only.
 * Does NOT silently treat missing as the requested location — callers must pass
 * defaultLocationId when legacy rows should inherit a tenant default (e.g. sunset-somo).
 */
function resolveReservationLocationId({
  serviceLocationId = null,
  bookingLocationId = null,
  defaultLocationId = null,
} = {}) {
  const sr = String(serviceLocationId == null ? '' : serviceLocationId).trim();
  if (sr) return sr;
  const b = String(bookingLocationId == null ? '' : bookingLocationId).trim();
  if (b) return b;
  const d = defaultLocationId == null ? '' : String(defaultLocationId).trim();
  return d || null;
}

/**
 * Expand one reservation row into per-calendar-date demand units.
 * Prefer rental_service_dates / covered_dates when present; else service_date.
 */
function expandReservationDemand(reservation) {
  const r = reservation || {};
  const offeringKey = String(r.offering_key || '').trim();
  const bookingId = r.booking_id != null ? String(r.booking_id) : null;
  const qty = Number(r.quantity);
  const quantity = Number.isInteger(qty) && qty > 0 ? qty : 0;
  if (!offeringKey || quantity < 1) return [];

  let dates = coerceIsoDateArray(r.rental_service_dates);
  if (!dates.length) dates = coerceIsoDateArray(r.covered_dates);
  if (!dates.length) {
    const single = String(r.service_date || '').slice(0, 10);
    if (isIsoDate(single)) dates = [single];
  }
  return dates.map((date) => ({
    date,
    quantity,
    booking_id: bookingId,
    offering_key: offeringKey,
  }));
}

function explicitBundleGroupId(row) {
  const fromPricing = String(row.pricing_group_id || '').trim();
  if (fromPricing) return fromPricing;
  return String(row.rental_bundle_id || '').trim();
}

function explicitBundlePart(row) {
  const part = String(row.bundle_part || '').trim();
  if (part) return part;
  return String(row.rental_pricing_role || '').trim();
}

/**
 * Normalize reservation demand into per-(booking, offering, date) quantities.
 *
 * - Legitimate independent rows SUM (two qty 2 + 3 → 5).
 * - Historical bundle component duplicates collapse only when a shared
 *   pricing_group_id / rental_bundle_id has at least two DISTINCT nonempty
 *   bundle_part / rental_pricing_role values for the same booking+offering+date
 *   (production markers from sunset-schedule-booking-writes). Quantity is MAX.
 * - Same group with only one distinct part (e.g. repeated surfboard rows) SUM.
 * - Never infers cross-offering deductions.
 */
function normalizeReservationDemand(rows) {
  const list = Array.isArray(rows) ? rows : [];
  // booking\0offering\0date → quantity
  const sumMap = new Map();
  // booking\0offering\0date\0groupId → { max, sum, parts:Set, unit }
  const bundleMap = new Map();

  for (const row of list) {
    if (!isActiveReservation(row)) continue;
    const groupId = explicitBundleGroupId(row);
    const part = explicitBundlePart(row);
    const expanded = expandReservationDemand(row);
    if (!expanded.length) continue;

    if (groupId && part) {
      for (const unit of expanded) {
        const bid = unit.booking_id == null ? '' : unit.booking_id;
        const bKey = `${bid}\0${unit.offering_key}\0${unit.date}\0${groupId}`;
        const prev = bundleMap.get(bKey);
        if (!prev) {
          bundleMap.set(bKey, {
            max: unit.quantity,
            sum: unit.quantity,
            parts: new Set([part]),
            unit: {
              date: unit.date,
              quantity: unit.quantity,
              booking_id: unit.booking_id,
              offering_key: unit.offering_key,
            },
          });
        } else {
          prev.parts.add(part);
          prev.sum += unit.quantity;
          if (unit.quantity > prev.max) prev.max = unit.quantity;
        }
      }
    } else {
      for (const unit of expanded) {
        const bid = unit.booking_id == null ? '' : unit.booking_id;
        const key = `${bid}\0${unit.offering_key}\0${unit.date}`;
        const prev = sumMap.get(key);
        if (!prev) {
          sumMap.set(key, {
            date: unit.date,
            quantity: unit.quantity,
            booking_id: unit.booking_id,
            offering_key: unit.offering_key,
          });
        } else {
          prev.quantity += unit.quantity;
        }
      }
    }
  }

  for (const bucket of bundleMap.values()) {
    // Distinct component parts (≥2) → one historical bundle at MAX qty.
    // Single distinct part (incl. repeated surfboard rows) → SUM all rows.
    const qty = bucket.parts.size >= 2 ? bucket.max : bucket.sum;
    const unit = bucket.unit;
    const bid = unit.booking_id == null ? '' : unit.booking_id;
    const key = `${bid}\0${unit.offering_key}\0${unit.date}`;
    const prev = sumMap.get(key);
    if (!prev) {
      sumMap.set(key, {
        date: unit.date,
        quantity: qty,
        booking_id: unit.booking_id,
        offering_key: unit.offering_key,
      });
    } else {
      prev.quantity += qty;
    }
  }

  return [...sumMap.values()].sort((a, b) => {
    const d = a.date.localeCompare(b.date);
    if (d !== 0) return d;
    const o = a.offering_key.localeCompare(b.offering_key);
    if (o !== 0) return o;
    return String(a.booking_id || '').localeCompare(String(b.booking_id || ''));
  });
}

function resolveRequestDates(opts) {
  if (Array.isArray(opts.dates) && opts.dates.length) {
    return [...new Set(opts.dates.map((d) => String(d || '').slice(0, 10)).filter(isIsoDate))].sort();
  }
  return inclusiveIsoDates(opts.date_from || opts.dateFrom, opts.date_to || opts.dateTo);
}

/**
 * Pure stock availability for one offering over a date range.
 *
 * @returns
 *   { ok:true, offering_key, stock_quantity, requested_quantity, reserved, remaining,
 *     limiting_date, days:[{date, reserved, remaining}] }
 * | { ok:false, error, ...structured fields }
 */
function computeRentalStockAvailability(opts = {}) {
  const offeringKey = String(opts.offering_key || opts.offeringKey || '').trim();
  const rawQty = opts.quantity;
  const quantity = Number(rawQty);
  const stockRaw = opts.stock_quantity !== undefined ? opts.stock_quantity : opts.stockQuantity;
  const excludeBookingId = opts.exclude_booking_id != null
    ? String(opts.exclude_booking_id)
    : (opts.excludeBookingId != null ? String(opts.excludeBookingId) : null);

  if (!offeringKey) {
    return { ok: false, error: ERROR_INVALID_REQUEST, message: 'offering_key is required' };
  }
  if (!Number.isInteger(quantity) || quantity < 1) {
    return {
      ok: false,
      error: ERROR_INVALID_REQUEST,
      offering_key: offeringKey,
      message: 'quantity must be a positive integer',
      requested_quantity: rawQty,
    };
  }

  if (stockRaw === null || stockRaw === undefined) {
    return {
      ok: false,
      error: ERROR_STOCK_NOT_CONFIGURED,
      offering_key: offeringKey,
      requested_quantity: quantity,
      stock_quantity: null,
      message: 'rental stock is not configured for this offering',
    };
  }
  if (!isValidStockQuantity(stockRaw)) {
    return {
      ok: false,
      error: ERROR_INVALID_STOCK,
      offering_key: offeringKey,
      stock_quantity: stockRaw,
      requested_quantity: quantity,
    };
  }

  const dates = resolveRequestDates(opts);
  if (!dates.length) {
    return {
      ok: false,
      error: ERROR_INVALID_REQUEST,
      offering_key: offeringKey,
      requested_quantity: quantity,
      message: 'date_from/date_to (or dates[]) required',
    };
  }

  const normalized = normalizeReservationDemand(opts.reservations || []);
  const reservedByDate = new Map(dates.map((d) => [d, 0]));
  for (const unit of normalized) {
    if (unit.offering_key !== offeringKey) continue;
    if (excludeBookingId && unit.booking_id === excludeBookingId) continue;
    if (!reservedByDate.has(unit.date)) continue;
    reservedByDate.set(unit.date, reservedByDate.get(unit.date) + unit.quantity);
  }

  const days = dates.map((date) => {
    const reserved = reservedByDate.get(date) || 0;
    return {
      date,
      reserved,
      remaining: stockRaw - reserved,
    };
  });

  let limiting = days[0];
  for (const day of days) {
    if (day.remaining < limiting.remaining) limiting = day;
    else if (day.remaining === limiting.remaining && day.date < limiting.date) limiting = day;
  }

  const base = {
    offering_key: offeringKey,
    stock_quantity: stockRaw,
    requested_quantity: quantity,
    reserved: limiting.reserved,
    remaining: limiting.remaining,
    limiting_date: limiting.date,
    days,
  };

  if (limiting.remaining < quantity) {
    return {
      ok: false,
      error: ERROR_STOCK_UNAVAILABLE,
      ...base,
      message: 'requested quantity exceeds remaining stock on at least one date',
    };
  }
  return { ok: true, ...base };
}

function normalizeOfferingKeys(offeringKeys) {
  return [...new Set(
    (Array.isArray(offeringKeys) ? offeringKeys : [])
      .map((k) => String(k || '').trim())
      .filter(Boolean),
  )].sort();
}

/**
 * Deterministic PostgreSQL row-lock contract for later Create/Edit/Restore.
 * Locks active offering candidates for exact client_slug with location fallback
 * (exact location_id OR client-wide NULL), ordered for deadlock-free acquisition.
 * Callers resolve one canonical row per offering_key after lock (exact before NULL).
 */
function buildRentalStockRowLockQuery({ clientSlug, locationId, offeringKeys } = {}) {
  const slug = String(clientSlug || '').trim();
  const loc = locationId == null ? null : String(locationId).trim() || null;
  const keys = normalizeOfferingKeys(offeringKeys);

  // Match listRentalOfferings: exact location + client-wide NULL rows.
  // When request location is NULL, only client-wide rows apply.
  const sql = loc == null
    ? `
SELECT id, client_slug, location_id, offering_key, stock_quantity
  FROM tenant_rental_offerings
 WHERE client_slug = $1
   AND location_id IS NULL
   AND offering_key = ANY($2::text[])
   AND active = true
 ORDER BY offering_key ASC, id ASC
   FOR UPDATE`.replace(/\s+/g, ' ').trim()
    : `
SELECT id, client_slug, location_id, offering_key, stock_quantity
  FROM tenant_rental_offerings
 WHERE client_slug = $1
   AND (location_id = $2 OR location_id IS NULL)
   AND offering_key = ANY($3::text[])
   AND active = true
 ORDER BY offering_key ASC,
          CASE WHEN location_id IS NOT DISTINCT FROM $2 THEN 0 ELSE 1 END ASC,
          id ASC
   FOR UPDATE`.replace(/\s+/g, ' ').trim();

  const params = loc == null ? [slug, keys] : [slug, loc, keys];

  return {
    sql,
    params,
    lock_order: keys,
    client_slug: slug,
    location_id: loc,
  };
}

/**
 * Resolve one canonical stock row per offering_key from locked candidates.
 * Exact location wins over location_id NULL. Never crosses clients (caller filters).
 *
 * @returns {{
 *   resolved: Array<{offering_key, row, resolved_location_id, stock_scope}>,
 *   missing_keys: string[]
 * }}
 */
function resolveLockedStockRows({ requestedKeys, lockedRows, locationId } = {}) {
  const keys = normalizeOfferingKeys(requestedKeys);
  const loc = locationId == null ? null : String(locationId).trim() || null;
  const byKey = new Map(); // offering_key → { exact: row|null, fallback: row|null }

  for (const row of (Array.isArray(lockedRows) ? lockedRows : [])) {
    if (!row || row.active === false) continue;
    const ok = String(row.offering_key || '').trim();
    if (!ok) continue;
    if (!byKey.has(ok)) byKey.set(ok, { exact: null, fallback: null });
    const bucket = byKey.get(ok);
    const rowLoc = row.location_id == null ? null : String(row.location_id).trim() || null;
    if (loc != null && rowLoc === loc) {
      if (!bucket.exact) bucket.exact = row;
    } else if (rowLoc == null) {
      if (!bucket.fallback) bucket.fallback = row;
    }
  }

  const resolved = [];
  const missing = [];
  for (const key of keys) {
    const bucket = byKey.get(key);
    const chosen = bucket && (bucket.exact || bucket.fallback);
    if (!chosen) {
      missing.push(key);
      continue;
    }
    const resolvedLoc = chosen.location_id == null
      ? null
      : String(chosen.location_id).trim() || null;
    const stockScope = resolvedLoc == null ? 'client' : 'location';
    resolved.push({
      offering_key: key,
      row: chosen,
      resolved_location_id: resolvedLoc,
      stock_scope: stockScope,
    });
  }
  return { resolved, missing_keys: missing };
}

/**
 * Execute the stock row-lock contract against a pg-compatible client.
 * Caller owns the surrounding transaction (BEGIN/COMMIT).
 * Fail-closed: every requested key must resolve to an active accessible row.
 */
async function lockRentalStockRows(pg, opts = {}) {
  const plan = buildRentalStockRowLockQuery(opts);
  if (!plan.client_slug) {
    return { ok: false, error: ERROR_INVALID_REQUEST, message: 'clientSlug is required' };
  }
  if (!plan.lock_order.length) {
    return { ok: false, error: ERROR_INVALID_REQUEST, message: 'offeringKeys required' };
  }
  const res = await pg.query(plan.sql, plan.params);
  const lockedRows = res.rows || [];
  const { resolved, missing_keys: missing } = resolveLockedStockRows({
    requestedKeys: plan.lock_order,
    lockedRows,
    locationId: plan.location_id,
  });

  if (missing.length) {
    return {
      ok: false,
      error: ERROR_STOCK_NOT_CONFIGURED,
      missing_keys: missing,
      lock_order: plan.lock_order,
      plan,
      message: 'one or more rental stock rows are missing, inactive, or inaccessible',
      rows: [],
    };
  }

  const rows = resolved.map((r) => ({
    ...r.row,
    offering_key: r.offering_key,
    resolved_location_id: r.resolved_location_id,
    stock_scope: r.stock_scope,
  })).sort((a, b) => String(a.offering_key).localeCompare(String(b.offering_key)));

  return {
    ok: true,
    rows,
    lock_order: plan.lock_order,
    plan,
  };
}

/**
 * Load configured stock for one offering at client+location with NULL fallback.
 * Prefer exact location_id; fall back to client-wide location_id NULL.
 */
function buildConfiguredStockQuery({ clientSlug, locationId, offeringKey } = {}) {
  const slug = String(clientSlug || '').trim();
  const loc = locationId == null ? null : String(locationId).trim() || null;
  const key = String(offeringKey || '').trim();

  if (loc == null) {
    const sql = `
SELECT id, client_slug, location_id, offering_key, stock_quantity, active
  FROM tenant_rental_offerings
 WHERE client_slug = $1
   AND location_id IS NULL
   AND offering_key = $2
   AND active = true
 ORDER BY id ASC
 LIMIT 1`.replace(/\s+/g, ' ').trim();
    return { sql, params: [slug, key] };
  }

  // Exact first, then NULL-location fallback (ORDER BY exact match rank).
  const sql = `
SELECT id, client_slug, location_id, offering_key, stock_quantity, active
  FROM tenant_rental_offerings
 WHERE client_slug = $1
   AND (location_id = $2 OR location_id IS NULL)
   AND offering_key = $3
   AND active = true
 ORDER BY CASE WHEN location_id IS NOT DISTINCT FROM $2 THEN 0 ELSE 1 END ASC, id ASC
 LIMIT 1`.replace(/\s+/g, ' ').trim();
  return { sql, params: [slug, loc, key] };
}

/**
 * SQL fragment: true when any authoritative occupied date overlaps [$from,$to].
 * Safe against non-array JSONB (jsonb_typeof guard).
 *
 * Never casts untrusted array text to date (no val::date). Exact-shape
 * YYYY-MM-DD is enforced with a fully anchored regex; comparison to window
 * bounds is lexical on text after converting trusted ISO params to text.
 * service_date fallback applies when neither rental_service_dates nor
 * covered_dates contains ANY usable exact-format date — not merely when
 * the raw arrays are empty.
 */
function sqlOccupiedDateOverlap(fromParam, toParam) {
  // fromParam/toParam are `$N` placeholders for the inclusive window bounds.
  // Fully anchored: junk suffixes / impossible-length values never match.
  const isoExact = "'^\\d{4}-\\d{2}-\\d{2}$'";
  const rentalArr = `CASE
            WHEN jsonb_typeof(COALESCE(sr.metadata->'rental_service_dates', 'null'::jsonb)) = 'array'
            THEN sr.metadata->'rental_service_dates'
            ELSE '[]'::jsonb
          END`;
  const coveredArr = `CASE
            WHEN jsonb_typeof(COALESCE(sr.metadata->'covered_dates', 'null'::jsonb)) = 'array'
            THEN sr.metadata->'covered_dates'
            ELSE '[]'::jsonb
          END`;
  return `(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements_text(${rentalArr}) AS d(val)
       WHERE val ~ ${isoExact}
         AND val >= ${fromParam}::text
         AND val <= ${toParam}::text
    )
    OR EXISTS (
      SELECT 1
        FROM jsonb_array_elements_text(${coveredArr}) AS d(val)
       WHERE val ~ ${isoExact}
         AND val >= ${fromParam}::text
         AND val <= ${toParam}::text
    )
    OR (
      NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements_text(${rentalArr}) AS d(val)
         WHERE val ~ ${isoExact}
      )
      AND NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements_text(${coveredArr}) AS d(val)
         WHERE val ~ ${isoExact}
      )
      AND sr.service_date >= ${fromParam}::date
      AND sr.service_date <= ${toParam}::date
    )
  )`;
}

/**
 * Active reservation load contract (exact offering_key; no cross-key deduction).
 *
 * Matches sunset-schedule-queries active gear semantics for booking/status
 * cancellation, plus schedule_archived exclusion on booking and service row.
 * Occupancy uses metadata date arrays (not only anchor service_date).
 *
 * stock_scope:
 *   - 'location' (default when locationId set): filter reservations to that location
 *   - 'client': client-wide shared stock; do not filter by location
 *
 * Location resolution (location stock only), aligned with production COALESCE
 * order in sunset-school-locations / sunset-schedule-queries:
 *   1. sr.metadata.location_id (nonempty)
 *   2. b.metadata.location_id (nonempty)
 *   3. explicit caller-provided defaultLocationId only
 * Never silently assigns missing rows to the requested location in this
 * multiclient helper — pass defaultLocationId (e.g. 'sunset-somo') when
 * legacy neither-location rows should count toward a tenant default.
 */
function buildActiveRentalReservationsQuery({
  clientSlug,
  locationId,
  offeringKey,
  dateFrom,
  dateTo,
  excludeBookingId = null,
  stockScope = null,
  defaultLocationId = null,
} = {}) {
  const slug = String(clientSlug || '').trim();
  const loc = locationId == null ? null : String(locationId).trim() || null;
  const key = String(offeringKey || '').trim();
  const from = String(dateFrom || '').slice(0, 10);
  const to = String(dateTo || '').slice(0, 10);
  const scope = stockScope || (loc == null ? 'client' : 'location');
  const defaultLoc = defaultLocationId == null
    ? null
    : (String(defaultLocationId).trim() || null);

  const params = [slug, key, from, to];
  let locationClause = '';
  if (scope === 'location' && loc != null) {
    params.push(loc);
    const locParam = params.length;
    // Explicit default only — NULL when caller omits defaultLocationId so
    // rows with neither service nor booking location do not match arbitrarily.
    params.push(defaultLoc);
    const defaultParam = params.length;
    locationClause = ` AND COALESCE(`
      + `NULLIF(sr.metadata->>'location_id', ''), `
      + `NULLIF(b.metadata->>'location_id', ''), `
      + `NULLIF($${defaultParam}::text, '')`
      + `) = $${locParam}`;
  }

  let excludeClause = '';
  if (excludeBookingId) {
    params.push(String(excludeBookingId));
    excludeClause = ` AND sr.booking_id IS DISTINCT FROM $${params.length}::uuid`;
  }

  const fromIdx = 3;
  const toIdx = 4;
  const overlap = sqlOccupiedDateOverlap(`$${fromIdx}`, `$${toIdx}`);

  // MULTICLIENT_SCOPE_OK: clients.slug + sr.client_slug + exact offering_key
  const sql = `
SELECT sr.booking_id,
       sr.service_date::text AS service_date,
       sr.quantity,
       sr.status,
       LOWER(b.status::text) AS booking_status,
       sr.metadata->>'offering_key' AS offering_key,
       sr.metadata->'rental_service_dates' AS rental_service_dates,
       sr.metadata->'covered_dates' AS covered_dates,
       sr.metadata->>'pricing_group_id' AS pricing_group_id,
       sr.metadata->>'rental_bundle_id' AS rental_bundle_id,
       sr.metadata->>'bundle_part' AS bundle_part,
       sr.metadata->>'rental_pricing_role' AS rental_pricing_role,
       COALESCE(b.metadata->>'schedule_archived', '') AS schedule_archived,
       COALESCE(sr.metadata->>'schedule_archived', '') AS sr_schedule_archived
  FROM booking_service_records sr
 INNER JOIN bookings b ON b.id = sr.booking_id
 INNER JOIN clients c ON c.id = b.client_id
 WHERE c.slug = $1
   AND sr.client_slug = $1
   AND sr.metadata->>'offering_key' = $2
   AND sr.booking_id IS NOT NULL
   AND sr.status <> 'cancelled'
   AND LOWER(b.status::text) NOT IN ('cancelled', 'canceled', 'expired')
   AND COALESCE(b.metadata->>'schedule_archived', '') <> 'true'
   AND COALESCE(sr.metadata->>'schedule_archived', '') <> 'true'
   AND ${overlap}
   ${locationClause}
   ${excludeClause}
 ORDER BY sr.service_date ASC, sr.booking_id ASC, sr.id ASC`.replace(/\s+/g, ' ').trim();

  return {
    sql,
    params,
    offering_key: key,
    client_slug: slug,
    location_id: loc,
    stock_scope: scope,
    default_location_id: defaultLoc,
  };
}

function offeringStateKey(clientSlug, locationId, offeringKey) {
  return `${String(clientSlug || '').trim()}|${locationId == null ? '' : String(locationId).trim()}|${String(offeringKey || '').trim()}`;
}

/**
 * In-memory transactional stock gate modeling FOR UPDATE serialization.
 * Used to prove concurrency semantics (last-unit race, lock order, missing rows)
 * without a live DB. Does NOT synthesize missing offerings — mirrors PostgreSQL
 * fail-closed behavior when no active row exists.
 *
 * @param {object} opts
 * @param {object} opts.offerings  map of stateKey → { stock_quantity, location_id? }
 * @param {function} [opts.onLock]  optional spy(key) when a row lock is acquired
 */
function createInMemoryStockTxnGate(opts = {}) {
  const offerings = new Map();
  const initial = opts.offerings || {};
  for (const [k, v] of Object.entries(initial)) {
    offerings.set(k, {
      stock_quantity: v.stock_quantity,
      location_id: Object.prototype.hasOwnProperty.call(v, 'location_id')
        ? v.location_id
        : (k.split('|')[1] === '' ? null : k.split('|')[1]),
      offering_key: v.offering_key || k.split('|')[2],
      client_slug: v.client_slug || k.split('|')[0],
      active: v.active !== false,
      // date → Map(booking_id → quantity)
      reserved: new Map(),
    });
  }
  const onLock = typeof opts.onLock === 'function' ? opts.onLock : null;

  // Per-key mutex queue implementing lock serialization.
  const waiters = new Map(); // key → Promise chain tail

  function enqueue(key, fn) {
    const prev = waiters.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const next = prev.then(() => gate);
    waiters.set(key, next.then(() => {}, () => {}));
    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        release();
      }
    });
  }

  async function acquireLocks(keys) {
    // Acquire in sorted order, holding all until releaseAll.
    const sorted = [...keys].sort();
    const held = [];
    const releases = [];
    for (const key of sorted) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolveOuter) => {
        enqueue(key, async () => {
          if (onLock) onLock(key);
          held.push(key);
          await new Promise((resolveHold) => {
            releases.push(resolveHold);
            resolveOuter();
          });
        });
      });
    }
    return () => {
      for (let i = releases.length - 1; i >= 0; i -= 1) releases[i]();
    };
  }

  function candidateRows(clientSlug, locationId, offeringKeys) {
    const slug = String(clientSlug || '').trim();
    const loc = locationId == null ? null : String(locationId).trim() || null;
    const keys = normalizeOfferingKeys(offeringKeys);
    const out = [];
    for (const [stateKey, row] of offerings.entries()) {
      if (!row.active) continue;
      if (String(row.client_slug || '').trim() !== slug) continue;
      const ok = String(row.offering_key || '').trim();
      if (!keys.includes(ok)) continue;
      const rowLoc = row.location_id == null ? null : String(row.location_id).trim() || null;
      if (loc == null) {
        if (rowLoc != null) continue;
      } else if (rowLoc !== loc && rowLoc != null) {
        continue;
      }
      out.push({
        id: stateKey,
        client_slug: slug,
        location_id: rowLoc,
        offering_key: ok,
        stock_quantity: row.stock_quantity,
        active: true,
        _stateKey: stateKey,
        _row: row,
      });
    }
    // Deterministic order: offering_key, exact location before NULL, id.
    out.sort((a, b) => {
      const o = a.offering_key.localeCompare(b.offering_key);
      if (o !== 0) return o;
      const aExact = loc != null && a.location_id === loc ? 0 : 1;
      const bExact = loc != null && b.location_id === loc ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      return String(a.id).localeCompare(String(b.id));
    });
    return out;
  }

  function reservationsFor(row, offeringKey) {
    const out = [];
    for (const [date, byBooking] of row.reserved.entries()) {
      for (const [bookingId, qty] of byBooking.entries()) {
        out.push({
          booking_id: bookingId,
          offering_key: offeringKey,
          service_date: date,
          quantity: qty,
          status: 'confirmed',
        });
      }
    }
    return out;
  }

  function runTransaction(fn) {
    return (async () => {
      let releaseLocks = () => {};
      const txn = {
        async lockStockRows({ clientSlug, locationId, offeringKeys }) {
          const plan = buildRentalStockRowLockQuery({ clientSlug, locationId, offeringKeys });
          const candidates = candidateRows(clientSlug, locationId, plan.lock_order);
          // Lock every candidate state key deterministically (mirrors FOR UPDATE set).
          const stateKeys = candidates.map((c) => c._stateKey);
          // Also lock phantom keys for requested offerings so concurrent missing
          // lookups serialize — but do NOT create offerings.
          const requestedStateKeys = plan.lock_order.map((ok) => {
            // Prefer exact location state key when present; else NULL fallback key.
            const exact = offeringStateKey(clientSlug, locationId, ok);
            const fallback = offeringStateKey(clientSlug, null, ok);
            if (offerings.has(exact)) return exact;
            if (offerings.has(fallback)) return fallback;
            // Missing: still take a mutex on the exact requested key so races
            // do not invent rows; resolution fails closed afterward.
            return exact;
          });
          const lockKeys = [...new Set([...stateKeys, ...requestedStateKeys])].sort();
          releaseLocks = await acquireLocks(lockKeys);

          const { resolved, missing_keys: missing } = resolveLockedStockRows({
            requestedKeys: plan.lock_order,
            lockedRows: candidates,
            locationId,
          });

          if (missing.length) {
            return {
              ok: false,
              error: ERROR_STOCK_NOT_CONFIGURED,
              missing_keys: missing,
              lock_order: plan.lock_order,
              rows: [],
              message: 'one or more rental stock rows are missing, inactive, or inaccessible',
            };
          }

          return {
            ok: true,
            rows: resolved.map((r) => ({
              ...r.row,
              offering_key: r.offering_key,
              resolved_location_id: r.resolved_location_id,
              stock_scope: r.stock_scope,
            })),
            lock_order: plan.lock_order,
          };
        },
        checkAvailability(params) {
          // Resolve stock row with same precedence; fail closed if missing.
          const candidates = candidateRows(
            params.clientSlug,
            params.locationId,
            [params.offering_key],
          );
          const { resolved, missing_keys: missing } = resolveLockedStockRows({
            requestedKeys: [params.offering_key],
            lockedRows: candidates,
            locationId: params.locationId,
          });
          if (missing.length || !resolved.length) {
            return {
              ok: false,
              error: ERROR_STOCK_NOT_CONFIGURED,
              offering_key: params.offering_key,
              requested_quantity: params.quantity,
              stock_quantity: null,
              missing_keys: missing.length ? missing : [params.offering_key],
              message: 'rental stock is not configured for this offering',
            };
          }
          const chosen = resolved[0];
          const stateKey = chosen.row._stateKey || chosen.row.id;
          const live = offerings.get(stateKey);
          if (!live) {
            return {
              ok: false,
              error: ERROR_STOCK_NOT_CONFIGURED,
              offering_key: params.offering_key,
              stock_quantity: null,
              missing_keys: [params.offering_key],
            };
          }
          return computeRentalStockAvailability({
            offering_key: params.offering_key,
            stock_quantity: live.stock_quantity,
            quantity: params.quantity,
            date_from: params.date_from,
            date_to: params.date_to,
            exclude_booking_id: params.exclude_booking_id,
            reservations: reservationsFor(live, params.offering_key),
          });
        },
        reserve(params) {
          const candidates = candidateRows(
            params.clientSlug,
            params.locationId,
            [params.offering_key],
          );
          const { resolved, missing_keys: missing } = resolveLockedStockRows({
            requestedKeys: [params.offering_key],
            lockedRows: candidates,
            locationId: params.locationId,
          });
          if (missing.length || !resolved.length) {
            return {
              ok: false,
              error: ERROR_STOCK_NOT_CONFIGURED,
              missing_keys: missing.length ? missing : [params.offering_key],
            };
          }
          const stateKey = resolved[0].row._stateKey || resolved[0].row.id;
          const row = offerings.get(stateKey);
          if (!row) {
            return {
              ok: false,
              error: ERROR_STOCK_NOT_CONFIGURED,
              missing_keys: [params.offering_key],
            };
          }
          const dates = inclusiveIsoDates(params.date_from, params.date_to);
          const bookingId = String(params.booking_id);
          const qty = Number(params.quantity);
          for (const date of dates) {
            if (!row.reserved.has(date)) row.reserved.set(date, new Map());
            const byBooking = row.reserved.get(date);
            byBooking.set(bookingId, (byBooking.get(bookingId) || 0) + qty);
          }
          return { ok: true, stock_scope: resolved[0].stock_scope, resolved_location_id: resolved[0].resolved_location_id };
        },
      };
      try {
        return await fn(txn);
      } finally {
        releaseLocks();
      }
    })();
  }

  return {
    runTransaction,
    _debugState: () => offerings,
  };
}

module.exports = {
  STOCK_MIN,
  STOCK_MAX,
  ERROR_STOCK_NOT_CONFIGURED,
  ERROR_STOCK_UNAVAILABLE,
  ERROR_INVALID_STOCK,
  ERROR_INVALID_REQUEST,
  INACTIVE_BOOKING_STATUSES,
  isValidStockQuantity,
  validateStockQuantity,
  isIsoDate,
  inclusiveIsoDates,
  isActiveReservation,
  coerceIsoDateArray,
  reservationHasUsableOccupiedDates,
  resolveReservationLocationId,
  expandReservationDemand,
  normalizeReservationDemand,
  computeRentalStockAvailability,
  buildRentalStockRowLockQuery,
  resolveLockedStockRows,
  lockRentalStockRows,
  buildConfiguredStockQuery,
  buildActiveRentalReservationsQuery,
  sqlOccupiedDateOverlap,
  createInMemoryStockTxnGate,
  offeringStateKey,
};

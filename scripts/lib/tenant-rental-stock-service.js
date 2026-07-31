'use strict';

/**
 * Application service for rental equipment stock (Integration Slice B).
 *
 * Owns:
 *   - date-range availability query (Staff API / Schedule / Admin / Luna)
 *   - in-transaction lock + recheck for Create / Edit / Restore
 *
 * Every exact offering_key is an independent stock pool. No bundle deductions.
 * null stock_quantity = not configured (fail closed). 0 = sold out.
 *
 * Callers must pass defaultLocationId explicitly for tenants that need legacy
 * neither-location rows counted (Sunset → 'sunset-somo'). This helper never
 * silently invents a requested location.
 *
 * Refs: .hermes/plans/2026-07-31_173018-rental-equipment-stock.md slices 3–5.
 */

const {
  ERROR_STOCK_NOT_CONFIGURED,
  ERROR_STOCK_UNAVAILABLE,
  ERROR_INVALID_REQUEST,
  ERROR_INVALID_STOCK,
  computeRentalStockAvailability,
  lockRentalStockRows,
  buildConfiguredStockQuery,
  buildActiveRentalReservationsQuery,
  inclusiveIsoDates,
  isIsoDate,
  normalizeOfferingKeys: _normalizeOfferingKeysFromStock,
} = (() => {
  const stock = require('./tenant-rental-stock');
  return stock;
})();

// Re-export error constants for route/UI mapping.
const STOCK_ERRORS = Object.freeze({
  NOT_CONFIGURED: ERROR_STOCK_NOT_CONFIGURED,
  UNAVAILABLE: ERROR_STOCK_UNAVAILABLE,
  INVALID_REQUEST: ERROR_INVALID_REQUEST,
  INVALID_STOCK: ERROR_INVALID_STOCK,
});

function normalizeOfferingKeys(keys) {
  if (typeof _normalizeOfferingKeysFromStock === 'function') {
    return _normalizeOfferingKeysFromStock(keys);
  }
  return [...new Set(
    (Array.isArray(keys) ? keys : [])
      .map((k) => String(k || '').trim())
      .filter(Boolean),
  )].sort();
}

/**
 * Normalize stock claims from a rentals[] payload.
 * @returns {{ok:true, claims:Array}|{ok:false, error, message}}
 */
function collectRentalStockClaims(rentals, dateFrom, dateTo) {
  const from = String(dateFrom || '').slice(0, 10);
  const to = String(dateTo || dateFrom || '').slice(0, 10);
  if (!isIsoDate(from) || !isIsoDate(to) || from > to) {
    return {
      ok: false,
      error: ERROR_INVALID_REQUEST,
      message: 'date_from/date_to required for stock claims',
    };
  }
  const dates = inclusiveIsoDates(from, to);
  if (!dates.length) {
    return {
      ok: false,
      error: ERROR_INVALID_REQUEST,
      message: 'invalid date range for stock claims',
    };
  }
  const list = Array.isArray(rentals) ? rentals : [];
  const byKey = new Map();
  for (let i = 0; i < list.length; i += 1) {
    const row = list[i];
    if (!row || typeof row !== 'object') {
      return {
        ok: false,
        error: ERROR_INVALID_REQUEST,
        message: `rentals[${i}] must be an object`,
      };
    }
    const key = String(row.offering_key || '').trim();
    if (!key) continue;
    const qty = Number(row.quantity);
    if (!Number.isInteger(qty) || qty < 1) {
      return {
        ok: false,
        error: ERROR_INVALID_REQUEST,
        message: `rentals[${i}].quantity must be a positive integer`,
        offering_key: key,
      };
    }
    // Independent per exact key — never expand board_and_suit into components.
    const prev = byKey.get(key);
    if (prev) {
      byKey.set(key, {
        offering_key: key,
        quantity: prev.quantity + qty,
        date_from: from,
        date_to: to,
        dates,
      });
    } else {
      byKey.set(key, {
        offering_key: key,
        quantity: qty,
        date_from: from,
        date_to: to,
        dates,
      });
    }
  }
  const claims = [...byKey.values()].sort((a, b) => a.offering_key.localeCompare(b.offering_key));
  return { ok: true, claims, date_from: from, date_to: to, dates };
}

/**
 * Load configured stock row (no lock). Fail closed when missing/inactive.
 */
async function loadConfiguredStockRow(pg, { clientSlug, locationId, offeringKey }) {
  const plan = buildConfiguredStockQuery({ clientSlug, locationId, offeringKey });
  const res = await pg.query(plan.sql, plan.params);
  const row = (res.rows && res.rows[0]) || null;
  if (!row) {
    return {
      ok: false,
      error: ERROR_STOCK_NOT_CONFIGURED,
      offering_key: offeringKey,
      stock_quantity: null,
      message: 'rental stock is not configured for this offering',
    };
  }
  const resolvedLoc = row.location_id == null ? null : String(row.location_id).trim() || null;
  return {
    ok: true,
    row,
    stock_quantity: row.stock_quantity,
    stock_scope: resolvedLoc == null ? 'client' : 'location',
    resolved_location_id: resolvedLoc,
  };
}

/**
 * Load active reservations for one offering over a date window (no lock).
 */
async function loadActiveReservations(pg, opts) {
  const plan = buildActiveRentalReservationsQuery(opts);
  const res = await pg.query(plan.sql, plan.params);
  return res.rows || [];
}

function classifyAvailability(result) {
  if (!result || result.ok !== true) {
    if (result && result.error === ERROR_STOCK_NOT_CONFIGURED) {
      return {
        status: 'not_configured',
        sold_out: false,
        not_configured: true,
        remaining: null,
        stock_quantity: null,
      };
    }
    if (result && result.error === ERROR_STOCK_UNAVAILABLE) {
      const rem = Number(result.remaining);
      return {
        status: rem <= 0 ? 'sold_out' : 'unavailable',
        sold_out: rem <= 0,
        not_configured: false,
        remaining: Number.isFinite(rem) ? rem : 0,
        stock_quantity: result.stock_quantity,
      };
    }
    return {
      status: 'error',
      sold_out: false,
      not_configured: false,
      remaining: null,
      stock_quantity: result && result.stock_quantity,
    };
  }
  const rem = Number(result.remaining);
  return {
    status: rem <= 0 ? 'sold_out' : 'available',
    sold_out: rem <= 0,
    not_configured: false,
    remaining: rem,
    stock_quantity: result.stock_quantity,
  };
}

/**
 * Non-locking date-range availability for many offerings.
 * quantity defaults to 1 when omitted (used for "X available" readout).
 */
async function queryRentalStockAvailability(pg, opts = {}) {
  const clientSlug = String(opts.clientSlug || '').trim();
  const locationId = opts.locationId == null ? null : (String(opts.locationId).trim() || null);
  const dateFrom = String(opts.dateFrom || opts.date_from || '').slice(0, 10);
  const dateTo = String(opts.dateTo || opts.date_to || dateFrom).slice(0, 10);
  const excludeBookingId = opts.excludeBookingId != null
    ? String(opts.excludeBookingId)
    : (opts.exclude_booking_id != null ? String(opts.exclude_booking_id) : null);
  // Explicit only — never invent a default location inside this multiclient helper.
  const defaultLocationId = opts.defaultLocationId == null
    ? null
    : (String(opts.defaultLocationId).trim() || null);

  if (!clientSlug) {
    return {
      ok: false,
      error: ERROR_INVALID_REQUEST,
      message: 'clientSlug is required',
    };
  }
  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo) || dateFrom > dateTo) {
    return {
      ok: false,
      error: ERROR_INVALID_REQUEST,
      message: 'date_from/date_to required',
    };
  }

  let offeringInputs = [];
  if (Array.isArray(opts.offerings) && opts.offerings.length) {
    offeringInputs = opts.offerings.map((o) => {
      if (typeof o === 'string') return { offering_key: o, quantity: 1 };
      const key = String((o && o.offering_key) || '').trim();
      const qtyRaw = o && o.quantity != null ? Number(o.quantity) : 1;
      const quantity = Number.isInteger(qtyRaw) && qtyRaw >= 1 ? qtyRaw : 1;
      return { offering_key: key, quantity };
    }).filter((o) => o.offering_key);
  } else if (Array.isArray(opts.offeringKeys) || Array.isArray(opts.offering_keys)) {
    const keys = opts.offeringKeys || opts.offering_keys;
    offeringInputs = normalizeOfferingKeys(keys).map((k) => ({ offering_key: k, quantity: 1 }));
  }

  if (!offeringInputs.length) {
    return {
      ok: false,
      error: ERROR_INVALID_REQUEST,
      message: 'offerings required',
    };
  }

  // Deterministic order for stable responses + parallel-safe iteration.
  offeringInputs.sort((a, b) => a.offering_key.localeCompare(b.offering_key));

  const items = [];
  let allOk = true;
  for (const input of offeringInputs) {
    // eslint-disable-next-line no-await-in-loop
    const configured = await loadConfiguredStockRow(pg, {
      clientSlug,
      locationId,
      offeringKey: input.offering_key,
    });
    if (!configured.ok) {
      allOk = false;
      items.push({
        offering_key: input.offering_key,
        requested_quantity: input.quantity,
        ok: false,
        error: configured.error,
        message: configured.message,
        stock_quantity: null,
        reserved: null,
        remaining: null,
        limiting_date: null,
        days: [],
        status: 'not_configured',
        sold_out: false,
        not_configured: true,
      });
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const reservations = await loadActiveReservations(pg, {
      clientSlug,
      locationId,
      offeringKey: input.offering_key,
      dateFrom,
      dateTo,
      excludeBookingId,
      stockScope: configured.stock_scope,
      defaultLocationId,
    });

    const computed = computeRentalStockAvailability({
      offering_key: input.offering_key,
      stock_quantity: configured.stock_quantity,
      quantity: input.quantity,
      date_from: dateFrom,
      date_to: dateTo,
      exclude_booking_id: excludeBookingId,
      reservations,
    });
    const flags = classifyAvailability(computed);
    if (!computed.ok) allOk = false;
    items.push({
      ...computed,
      ...flags,
      requested_quantity: input.quantity,
      stock_scope: configured.stock_scope,
      resolved_location_id: configured.resolved_location_id,
    });
  }

  return {
    ok: allOk,
    client_slug: clientSlug,
    location_id: locationId,
    date_from: dateFrom,
    date_to: dateTo,
    exclude_booking_id: excludeBookingId,
    items,
  };
}

/**
 * Lock exact stock rows and recheck every claim inside the caller's transaction.
 * Fail closed: missing rows, null stock, or insufficient remaining → reject all.
 *
 * @param {object} pg  transaction-scoped client
 * @param {object} opts
 * @returns {{ok:true, lock, checks}|{ok:false, error, ...structured}}
 */
async function assertRentalStockClaimsInTxn(pg, opts = {}) {
  const clientSlug = String(opts.clientSlug || '').trim();
  const locationId = opts.locationId == null ? null : (String(opts.locationId).trim() || null);
  const excludeBookingId = opts.excludeBookingId != null
    ? String(opts.excludeBookingId)
    : (opts.exclude_booking_id != null ? String(opts.exclude_booking_id) : null);
  const defaultLocationId = opts.defaultLocationId == null
    ? null
    : (String(opts.defaultLocationId).trim() || null);

  let claims = Array.isArray(opts.claims) ? opts.claims : null;
  if (!claims) {
    const collected = collectRentalStockClaims(
      opts.rentals,
      opts.dateFrom || opts.date_from,
      opts.dateTo || opts.date_to,
    );
    if (!collected.ok) return collected;
    claims = collected.claims;
  }

  if (!clientSlug) {
    return {
      ok: false,
      error: ERROR_INVALID_REQUEST,
      message: 'clientSlug is required',
    };
  }
  if (!claims.length) {
    // No rental claims → nothing to enforce (lesson-only / accom-only writes).
    return { ok: true, skipped: true, claims: [], checks: [] };
  }

  const offeringKeys = normalizeOfferingKeys(claims.map((c) => c.offering_key));
  const lock = await lockRentalStockRows(pg, {
    clientSlug,
    locationId,
    offeringKeys,
  });
  if (!lock.ok) {
    return {
      ok: false,
      error: lock.error || ERROR_STOCK_NOT_CONFIGURED,
      message: lock.message || 'stock rows missing or inaccessible',
      missing_keys: lock.missing_keys || offeringKeys,
      lock_order: lock.lock_order || offeringKeys,
      status: 409,
      body: {
        success: false,
        error: lock.error || ERROR_STOCK_NOT_CONFIGURED,
        reason_code: lock.error || ERROR_STOCK_NOT_CONFIGURED,
        message: lock.message || 'rental stock is not configured',
        missing_keys: lock.missing_keys || offeringKeys,
      },
    };
  }

  const rowByKey = new Map(
    (lock.rows || []).map((r) => [String(r.offering_key), r]),
  );
  const checks = [];

  for (const claim of claims) {
    const key = String(claim.offering_key || '').trim();
    const row = rowByKey.get(key);
    if (!row) {
      return {
        ok: false,
        error: ERROR_STOCK_NOT_CONFIGURED,
        offering_key: key,
        missing_keys: [key],
        status: 409,
        body: {
          success: false,
          error: ERROR_STOCK_NOT_CONFIGURED,
          reason_code: ERROR_STOCK_NOT_CONFIGURED,
          offering_key: key,
          message: 'rental stock is not configured for this offering',
        },
      };
    }

    const stockScope = row.stock_scope
      || (row.resolved_location_id == null && row.location_id == null ? 'client' : 'location');
    const dateFrom = String(claim.date_from || claim.dateFrom || '').slice(0, 10);
    const dateTo = String(claim.date_to || claim.dateTo || dateFrom).slice(0, 10);

    // eslint-disable-next-line no-await-in-loop
    const reservations = await loadActiveReservations(pg, {
      clientSlug,
      locationId,
      offeringKey: key,
      dateFrom,
      dateTo,
      excludeBookingId,
      stockScope,
      defaultLocationId,
    });

    const computed = computeRentalStockAvailability({
      offering_key: key,
      stock_quantity: row.stock_quantity,
      quantity: claim.quantity,
      date_from: dateFrom,
      date_to: dateTo,
      exclude_booking_id: excludeBookingId,
      reservations,
    });
    checks.push(computed);

    if (!computed.ok) {
      const flags = classifyAvailability(computed);
      return {
        ok: false,
        error: computed.error,
        offering_key: key,
        check: computed,
        checks,
        lock,
        status: 409,
        body: {
          success: false,
          error: computed.error,
          reason_code: computed.error,
          offering_key: key,
          requested_quantity: computed.requested_quantity,
          remaining: computed.remaining,
          reserved: computed.reserved,
          stock_quantity: computed.stock_quantity,
          limiting_date: computed.limiting_date,
          message: computed.message || (
            computed.error === ERROR_STOCK_NOT_CONFIGURED
              ? 'rental stock is not configured for this offering'
              : 'requested quantity exceeds remaining stock'
          ),
          sold_out: flags.sold_out,
          not_configured: flags.not_configured,
        },
      };
    }
  }

  return {
    ok: true,
    lock,
    checks,
    claims,
  };
}

/**
 * Map stock failure to Staff API / Create response shape.
 */
function stockFailureHttp(result) {
  if (!result || result.ok) return null;
  if (result.body && result.status) {
    return { status: result.status, body: result.body };
  }
  const error = result.error || ERROR_INVALID_REQUEST;
  const status = error === ERROR_INVALID_REQUEST ? 400 : 409;
  return {
    status,
    body: {
      success: false,
      error,
      reason_code: error,
      offering_key: result.offering_key || null,
      message: result.message || error,
      ...(result.remaining != null ? { remaining: result.remaining } : {}),
      ...(result.requested_quantity != null
        ? { requested_quantity: result.requested_quantity }
        : {}),
      ...(result.stock_quantity !== undefined
        ? { stock_quantity: result.stock_quantity }
        : {}),
      ...(result.limiting_date ? { limiting_date: result.limiting_date } : {}),
      ...(result.missing_keys ? { missing_keys: result.missing_keys } : {}),
    },
  };
}

/**
 * Course-equipment selection rows (wire: offering_key + quantity) as stock claims.
 * Exact offering_key only — no component expansion.
 */
function collectCourseEquipmentStockClaims(courseEquipment, dateFrom, dateTo) {
  if (!Array.isArray(courseEquipment) || !courseEquipment.length) {
    return { ok: true, claims: [], skipped: true };
  }
  return collectRentalStockClaims(
    courseEquipment.map((row) => ({
      offering_key: row && row.offering_key,
      quantity: row && row.quantity,
    })),
    dateFrom,
    dateTo,
  );
}

/**
 * Merge independent claim lists by exact offering_key.
 * Quantities SUM when the same key appears in multiple lists without an explicit
 * shared logical claim identity (create/edit payloads have none). Date span
 * is the union of each claim's range.
 */
function mergeExactOfferingStockClaims(...claimLists) {
  const byKey = new Map();
  for (const list of claimLists) {
    for (const claim of (Array.isArray(list) ? list : [])) {
      if (!claim || !claim.offering_key) continue;
      const key = String(claim.offering_key).trim();
      if (!key) continue;
      const qty = Number(claim.quantity);
      if (!Number.isInteger(qty) || qty < 1) continue;
      const from = String(claim.date_from || claim.dateFrom || '').slice(0, 10);
      const to = String(claim.date_to || claim.dateTo || from).slice(0, 10);
      const dates = Array.isArray(claim.dates)
        ? claim.dates.map((d) => String(d || '').slice(0, 10)).filter(isIsoDate)
        : inclusiveIsoDates(from, to);
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, {
          offering_key: key,
          quantity: qty,
          date_from: from,
          date_to: to,
          dates: [...new Set(dates)].sort(),
        });
      } else {
        prev.quantity += qty;
        const allDates = [...new Set([...(prev.dates || []), ...dates])].sort();
        prev.dates = allDates;
        if (allDates.length) {
          prev.date_from = allDates[0];
          prev.date_to = allDates[allDates.length - 1];
        }
      }
    }
  }
  const claims = [...byKey.values()].sort((a, b) => a.offering_key.localeCompare(b.offering_key));
  return { ok: true, claims };
}

/**
 * Extract rental stock claims from a locked booking bundle (restore path).
 *
 * Aligns with normalizeReservationDemand:
 *   - independent same-key rows SUM per exact offering + occupied date
 *   - explicit historical component pairs (shared group + ≥2 distinct parts) dedupe once
 *   - never MAX across independent rows
 *   - never sum multi-day demand into a single inflated per-day request
 *
 * Emits one claim per (offering_key, date) so each day's actual demand is checked
 * and the limiting date is correct. assertRentalStockClaimsInTxn locks distinct
 * offering keys once in deterministic order.
 */
function collectRentalStockClaimsFromServices(services, opts = {}) {
  const list = Array.isArray(services) ? services : [];
  const reservationRows = [];
  const {
    normalizeReservationDemand,
  } = require('./tenant-rental-stock');

  for (const sr of list) {
    if (!sr) continue;
    let meta = sr.metadata;
    if (typeof meta === 'string') {
      try { meta = JSON.parse(meta); } catch (_) { meta = {}; }
    }
    meta = meta && typeof meta === 'object' ? meta : {};
    const key = String(meta.offering_key || '').trim();
    if (!key) continue;

    // Only equipment rental / course-equipment style rows.
    const stype = String(sr.service_type || '').toLowerCase();
    const isRental = meta.rental_offering === true
      || meta.course_equipment === true
      || meta.staff_ui_service_type === 'rental'
      || meta.staff_ui_service_type === 'course_equipment'
      || meta.component === 'rental'
      || meta.component === 'course_equipment'
      || meta.component === 'surfboard'
      || meta.component === 'wetsuit'
      || stype === 'surfboard'
      || stype === 'wetsuit'
      || stype === 'addon_service'
      || key.endsWith('_rental');
    if (!isRental) continue;

    const qty = Number(sr.quantity != null ? sr.quantity : meta.quantity);
    const quantity = Number.isInteger(qty) && qty > 0 ? qty : 0;
    if (quantity < 1) continue;

    let dates = [];
    const rawDates = meta.rental_service_dates || meta.covered_dates;
    if (Array.isArray(rawDates)) {
      dates = rawDates.map((d) => String(d || '').slice(0, 10)).filter(isIsoDate);
    }
    if (!dates.length) {
      const single = String(sr.service_date || '').slice(0, 10);
      if (isIsoDate(single)) dates = [single];
    }
    if (!dates.length) continue;

    reservationRows.push({
      booking_id: sr.booking_id != null ? sr.booking_id : (meta.booking_id || ''),
      offering_key: key,
      service_date: dates[0],
      quantity,
      status: 'confirmed',
      booking_status: 'confirmed',
      rental_service_dates: dates,
      covered_dates: dates,
      pricing_group_id: meta.pricing_group_id || null,
      rental_bundle_id: meta.rental_bundle_id || null,
      bundle_part: meta.bundle_part || null,
      rental_pricing_role: meta.rental_pricing_role || null,
    });
  }

  const normalized = normalizeReservationDemand(reservationRows);
  // One claim per (offering_key, date) — correct per-day demand, no cross-date SUM.
  const claims = normalized
    .filter((unit) => unit && unit.offering_key && unit.quantity >= 1 && isIsoDate(unit.date))
    .map((unit) => ({
      offering_key: unit.offering_key,
      quantity: unit.quantity,
      date_from: unit.date,
      date_to: unit.date,
      dates: [unit.date],
    }))
    .sort((a, b) => {
      const o = a.offering_key.localeCompare(b.offering_key);
      if (o !== 0) return o;
      return a.date_from.localeCompare(b.date_from);
    });

  return { ok: true, claims };
}

module.exports = {
  STOCK_ERRORS,
  collectRentalStockClaims,
  collectCourseEquipmentStockClaims,
  mergeExactOfferingStockClaims,
  collectRentalStockClaimsFromServices,
  loadConfiguredStockRow,
  loadActiveReservations,
  queryRentalStockAvailability,
  assertRentalStockClaimsInTxn,
  stockFailureHttp,
  classifyAvailability,
  normalizeOfferingKeys,
};

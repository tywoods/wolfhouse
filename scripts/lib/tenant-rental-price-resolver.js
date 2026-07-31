'use strict';

/**
 * tenant-rental-price-resolver.js — Phase 2, step 1 of the generic-rental
 * booking-acceptance path (docs/PHASE-2-RENTAL-BOOKING-ACCEPTANCE.md).
 *
 * Pure, offering_key-NATIVE price resolver. Given a generic rentable offering
 * (e.g. `kayak_rental`) + duration + quantity, it resolves the authoritative
 * per-period price from `tenant_price_rules` via the SAME injected `loadRule`
 * contract the live async lookup already uses (loadTenantPriceRuleFromDb):
 *
 *   loadRule({ clientSlug, locationId, itemType:'rental', itemCode, duration,
 *              billingUnit, pgClient })
 *     -> { status:'found', amount_cents, currency, item_code, unit, location_id }
 *      | { status:'not_found' | 'invalid_location' | 'tables_missing' | ... }
 *
 * WHAT THIS IS NOT: it does not carry the frozen `ITEM_ALIASES` whitelist that
 * gates lookupSunsetRentalPrice[Async] (the wall that rejects generic offerings).
 * The DB rule lookup is already generic (exact `item_code = offering__duration`);
 * this resolver simply declines to re-impose the closed set. It writes nothing
 * and touches no live path — it is additive and fully offline-testable.
 *
 * Fail-closed: any missing/invalid input, unknown price, or a rule whose
 * item_code does not match the requested `offering_key__duration_key` returns
 * `{ ok:false, reason }` and NEVER a guessed amount.
 */

const { resolveRentalBillingUnit, resolveDurationKey } = require('./sunset-rental-price-lookup');
const { isValidOfferingKey } = require('./tenant-rental-offerings');
const { parseRentalDurationKey, rentalDurationKeyFromUnitCount } = require('../browser/sunset-rental-duration-model');

async function defaultLoadRule(params) {
  const { loadTenantPriceRuleFromDb } = require('./tenant-business-config');
  if (params.pgClient) return loadTenantPriceRuleFromDb(params.pgClient, params);
  const { withPgClient } = require('./pg-connect');
  return withPgClient((client) => loadTenantPriceRuleFromDb(client, params));
}

function fail(reason, extra) {
  return { ok: false, reason, ...(extra || {}) };
}

/**
 * Day-tier discount continuation (pure).
 *
 * For requested N calendar rental days:
 *   - exact configured N-day tier wins
 *   - else longest configured day tier M where M <= N; continue that tier's
 *     effective discounted per-day rate across all N days
 *
 * Cent convention (matches course multi-day continuation):
 *   one_item_cents = Math.round(tier_unit_cents * requestedDays / tierDays)
 *   amount_cents   = one_item_cents * quantity
 *
 * Quantity is physical equipment units only — never guest/surfer count.
 *
 * @param {object} opts
 * @param {number} opts.requestedDays  N >= 1
 * @param {Array<{days:number, amount_cents:number, duration_key?:string}>} opts.tiers
 * @param {number} [opts.quantity=1]
 * @returns {{ok:true, ...} | {ok:false, reason}}
 */
function resolveDayRentalContinuation(opts) {
  const o = opts || {};
  const requestedDays = Number(o.requestedDays);
  const rawQty = o.quantity === undefined ? 1 : o.quantity;
  const quantity = Number(rawQty);
  if (!Number.isInteger(requestedDays) || requestedDays < 1) {
    return fail('invalid_requested_days', { requested_days: o.requestedDays });
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    return fail('invalid_quantity', { quantity: rawQty });
  }
  const rawTiers = Array.isArray(o.tiers) ? o.tiers : [];
  const tiers = [];
  for (let i = 0; i < rawTiers.length; i += 1) {
    const t = rawTiers[i];
    if (!t) continue;
    let days = Number(t.days);
    if (!Number.isInteger(days) || days < 1) {
      const parsed = parseRentalDurationKey(t.duration_key || t.unit || '');
      if (parsed && parsed.unit === 'days') days = parsed.count;
    }
    const amount = Math.round(Number(t.amount_cents));
    if (!Number.isInteger(days) || days < 1) continue;
    if (!Number.isFinite(amount) || amount < 0) continue;
    const durationKey = String(
      t.duration_key || rentalDurationKeyFromUnitCount('days', days) || '',
    ).trim();
    tiers.push({ days, amount_cents: amount, duration_key: durationKey });
  }
  if (!tiers.length) return fail('no_day_tiers');

  // Prefer exact N-day tier.
  const exact = tiers
    .filter((t) => t.days === requestedDays)
    .sort((a, b) => a.amount_cents - b.amount_cents)[0];
  if (exact) {
    const unitForDuration = exact.amount_cents;
    return {
      ok: true,
      requested_days: requestedDays,
      base_days: exact.days,
      base_duration_key: exact.duration_key || rentalDurationKeyFromUnitCount('days', exact.days),
      pricing_mode: 'exact_duration_package',
      package_repeat_count: 1,
      unit_cents: unitForDuration,
      quantity,
      amount_cents: unitForDuration * quantity,
    };
  }

  // Longest configured day duration <= N.
  const eligible = tiers.filter((t) => t.days <= requestedDays);
  if (!eligible.length) return fail('no_eligible_day_tier', { requested_days: requestedDays });
  eligible.sort((a, b) => b.days - a.days || a.amount_cents - b.amount_cents);
  const base = eligible[0];
  const unitForDuration = Math.round((base.amount_cents * requestedDays) / base.days);
  return {
    ok: true,
    requested_days: requestedDays,
    base_days: base.days,
    base_duration_key: base.duration_key || rentalDurationKeyFromUnitCount('days', base.days),
    pricing_mode: 'continued_day_discount',
    package_repeat_count: requestedDays,
    unit_cents: unitForDuration,
    quantity,
    amount_cents: unitForDuration * quantity,
  };
}

/**
 * Normalize a duration_key into day count for multi-day packages, or null.
 */
function dayCountFromDurationKey(durationKey) {
  const parsed = parseRentalDurationKey(durationKey);
  if (!parsed || parsed.unit !== 'days') return null;
  return parsed.count;
}

/**
 * True when duration is an hour / session package (never multi-day).
 */
function isHourRentalDurationKey(durationKey) {
  const k = String(durationKey || '').trim();
  if (!k) return false;
  if (/hour|half_day|lesson/i.test(k)) return true;
  const parsed = parseRentalDurationKey(k);
  return !!(parsed && parsed.unit === 'hours');
}

/**
 * @param {object} opts
 * @param {string} opts.clientSlug
 * @param {string} opts.locationId
 * @param {string} opts.offeringKey     bare catalog key, no `__`
 * @param {string} opts.durationKey     e.g. 'half_day', '1_day', '3_days'
 * @param {number} [opts.quantity=1]
 * @param {boolean} [opts.requireConfirmed=true]
 * @param {function} [opts.loadRule]    test/DI seam; defaults to DB path
 * @param {*} [opts.pgClient]
 * @returns {Promise<object>} {ok:true, ...priced} | {ok:false, reason}
 */
async function resolveGenericRentalPrice(opts) {
  const o = opts || {};
  const clientSlug = String(o.clientSlug || '').trim();
  const locationId = o.locationId;
  const offeringKey = String(o.offeringKey || '').trim();
  const durationKey = resolveDurationKey(o.durationKey);
  const requireConfirmed = o.requireConfirmed !== false;

  if (!clientSlug) return fail('missing_client');
  if (!isValidOfferingKey(offeringKey)) return fail('invalid_offering_key', { offering_key: offeringKey });
  if (!durationKey) return fail('missing_duration_key', { offering_key: offeringKey });

  // Quantity must be a positive integer; a bad qty must never silently price as 1.
  const rawQty = o.quantity === undefined ? 1 : o.quantity;
  const quantity = Number(rawQty);
  if (!Number.isInteger(quantity) || quantity < 1) {
    return fail('invalid_quantity', { offering_key: offeringKey, quantity: rawQty });
  }

  const billingUnit = resolveRentalBillingUnit(durationKey);
  if (!billingUnit) return fail('unsupported_duration', { offering_key: offeringKey, duration_key: durationKey });

  const loadRule = o.loadRule || defaultLoadRule;
  let dbRes;
  try {
    dbRes = await loadRule({
      clientSlug,
      locationId,
      itemType: 'rental',
      itemCode: offeringKey,
      duration: durationKey,
      billingUnit,
      pgClient: o.pgClient,
    });
  } catch (err) {
    return fail('price_lookup_failed', {
      offering_key: offeringKey,
      duration_key: durationKey,
      detail: (err && err.message) ? err.message : 'load_error',
    });
  }

  if (!dbRes || dbRes.status !== 'found') {
    // Every non-found status (not_found / invalid_location / tables_missing /
    // location_scope_unavailable / billing_unit_required / null) fails closed.
    return fail('price_not_found', {
      offering_key: offeringKey,
      duration_key: durationKey,
      status: dbRes ? dbRes.status : 'null_response',
    });
  }

  const unitCents = Number(dbRes.amount_cents);
  if (!Number.isFinite(unitCents) || unitCents < 0) {
    return fail('price_not_found', { offering_key: offeringKey, duration_key: durationKey, status: 'invalid_amount' });
  }

  // Duration/item integrity (blocker #3): the resolved rule MUST be exactly the
  // requested offering+duration. A rule for a different item_code or a bundle
  // window must never be borrowed to price this generic item.
  const expectedItemCode = `${offeringKey}__${durationKey}`;
  if (dbRes.item_code != null && String(dbRes.item_code).trim() !== expectedItemCode) {
    return fail('price_scope_mismatch', {
      offering_key: offeringKey,
      duration_key: durationKey,
      expected_item_code: expectedItemCode,
      got_item_code: String(dbRes.item_code).trim(),
    });
  }
  if (dbRes.unit != null && String(dbRes.unit).trim() !== billingUnit) {
    return fail('price_scope_mismatch', {
      offering_key: offeringKey,
      duration_key: durationKey,
      expected_unit: billingUnit,
      got_unit: String(dbRes.unit).trim(),
    });
  }

  const pricingStatus = String(dbRes.pricing_status || dbRes.status_confirmed || 'confirmed').trim();
  if (requireConfirmed && pricingStatus !== 'confirmed' && dbRes.pricing_status != null) {
    return fail('price_unverified', { offering_key: offeringKey, duration_key: durationKey, pricing_status: pricingStatus });
  }

  return {
    ok: true,
    client_slug: clientSlug,
    location_id: dbRes.location_id != null ? dbRes.location_id : locationId,
    offering_key: offeringKey,
    duration_key: durationKey,
    item_code: expectedItemCode,
    unit: billingUnit,
    unit_cents: Math.round(unitCents),
    quantity,
    amount_cents: Math.round(unitCents) * quantity,
    currency: dbRes.currency || 'EUR',
  };
}

// Coarse operational category for a generic rentable item. Migration 029 opened
// booking_service_records.service_type to include 'addon_service' (with an
// idempotent runtime twin, since Lunabox can't reach staging Postgres). Generic
// rentals persist under this bucket; the specific rentable identity lives in
// metadata.offering_key — no new migration required.
const GENERIC_RENTAL_SERVICE_TYPE = 'addon_service';

/**
 * Step 2: pure map from a priced generic rental (resolveGenericRentalPrice
 * ok-result) to a first-class booking_service_records descriptor. Writes
 * nothing — returns the neutral row shape the concrete INSERT paths already use
 * (client_slug, service_type, service_date, quantity, amount_due_cents,
 * payment_status, source, metadata). Fail-closed: refuses to build a record from
 * an unpriced/degenerate input.
 *
 * @param {object} priced  ok-result of resolveGenericRentalPrice
 * @param {object} ctx      { bookingId, bookingCode, guestName, serviceDate,
 *                            source?, status?, paymentStatus?, notes? }
 * @returns {{ok:true, record:object} | {ok:false, reason:string}}
 */
function buildGenericRentalServiceRecord(priced, ctx) {
  const p = priced || {};
  if (p.ok !== true) return { ok: false, reason: 'unpriced' };
  if (!Number.isFinite(Number(p.amount_cents))) return { ok: false, reason: 'unpriced' };
  const c = ctx || {};
  const serviceDate = c.serviceDate == null ? '' : String(c.serviceDate).trim();
  if (!serviceDate) return { ok: false, reason: 'missing_service_date' };
  if (!p.offering_key || !p.duration_key) return { ok: false, reason: 'unpriced' };

  // Multi-day occupancy: prefer explicit serviceDates/coveredDates for stock.
  // Historical single-day callers omit these and stock falls back to service_date.
  let occupancyDates = null;
  if (Array.isArray(c.serviceDates) && c.serviceDates.length) {
    occupancyDates = [...new Set(
      c.serviceDates.map((d) => String(d || '').slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
    )].sort();
  } else if (Array.isArray(c.coveredDates) && c.coveredDates.length) {
    occupancyDates = [...new Set(
      c.coveredDates.map((d) => String(d || '').slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
    )].sort();
  }

  const record = {
    client_slug: p.client_slug,
    booking_id: c.bookingId != null ? c.bookingId : null,
    booking_code: c.bookingCode != null ? c.bookingCode : null,
    guest_name: c.guestName != null ? c.guestName : null,
    service_type: GENERIC_RENTAL_SERVICE_TYPE,
    service_date: serviceDate,
    quantity: p.quantity,
    status: c.status || 'requested',
    amount_due_cents: Math.round(Number(p.amount_cents)),
    amount_paid_cents: 0,
    payment_status: c.paymentStatus || 'not_requested',
    source: c.source || 'staff_manual',
    notes: c.notes != null ? c.notes : null,
    metadata: {
      rental_offering: true,
      offering_key: p.offering_key,
      offering_label: p.offering_label != null ? String(p.offering_label) : null,
      duration_key: p.duration_key,
      item_code: p.item_code,
      unit: p.unit,
      unit_cents: p.unit_cents,
      rental_units: p.quantity,
      pricing_mode: p.pricing_mode || 'base_package',
      package_repeat_count: p.package_repeat_count || 1,
      selected_duration_key: p.selected_duration_key || p.duration_key,
      booking_duration_key: p.booking_duration_key || p.duration_key,
      currency: p.currency || 'EUR',
      location_id: p.location_id != null ? p.location_id : null,
      staff_ui_service_type: 'rental',
      // Exact offering-native persistence — never invents bundle component parts.
      ...(occupancyDates && occupancyDates.length
        ? {
          rental_service_dates: occupancyDates,
          covered_dates: occupancyDates,
        }
        : {}),
    },
  };
  return { ok: true, record };
}

/**
 * Step 3 foundation: split an incoming rentals[] into the canonical
 * board/wetsuit/bundle lane (existing component-based persistence) and the
 * generic lane (priced via resolveGenericRentalPrice, persisted via
 * buildGenericRentalServiceRecord). Pure — no DB.
 *
 * Catalog membership is the only generic-lane gate: a non-canonical key is
 * accepted into the generic lane ONLY if it is in `catalogKeys`. Unknown keys
 * fail closed. `genericEnabled` is ignored (deprecated; was an env-flag stand-in).
 *
 * @param {Array} rentals  shape-validated [{offering_key, duration_key, quantity}]
 * @param {object} opts { canonicalKeys:string[], catalogKeys:string[], genericEnabled?:boolean }
 * @returns {{ok:true, canonical:Array, generic:Array} | {ok:false, reason, error, index, offering_key}}
 */
function partitionRentalsForCreate(rentals, opts) {
  const o = opts || {};
  const canonicalSet = new Set((o.canonicalKeys || []).map((k) => String(k)));
  const catalogSet = new Set((o.catalogKeys || []).map((k) => String(k)));
  const list = Array.isArray(rentals) ? rentals : [];
  const canonical = [];
  const generic = [];
  for (let i = 0; i < list.length; i += 1) {
    const row = list[i];
    const key = String((row && row.offering_key) || '').trim();
    if (canonicalSet.has(key)) { canonical.push(row); continue; }
    if (catalogSet.has(key)) { generic.push(row); continue; }
    return {
      ok: false,
      reason: 'invalid_rental_offering',
      error: `rentals[${i}].offering_key is not allowed`,
      index: i,
      offering_key: key,
    };
  }
  return { ok: true, canonical, generic };
}

module.exports = {
  resolveGenericRentalPrice,
  buildGenericRentalServiceRecord,
  partitionRentalsForCreate,
  resolveDayRentalContinuation,
  dayCountFromDurationKey,
  isHourRentalDurationKey,
  GENERIC_RENTAL_SERVICE_TYPE,
};

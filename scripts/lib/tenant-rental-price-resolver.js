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
 * Behavior-preserving by construction: when `genericEnabled` is false, ANY
 * non-canonical key returns the SAME `invalid_rental_offering` rejection the
 * create handler produces today, so wiring this in with the flag OFF is a no-op.
 * When enabled, a non-canonical key is accepted into the generic lane ONLY if it
 * is a known active catalog offering (`catalogKeys`); an unknown key still
 * fails closed.
 *
 * @param {Array} rentals  shape-validated [{offering_key, duration_key, quantity}]
 * @param {object} opts { canonicalKeys:string[], catalogKeys:string[], genericEnabled:boolean }
 * @returns {{ok:true, canonical:Array, generic:Array} | {ok:false, reason, error, index, offering_key}}
 */
function partitionRentalsForCreate(rentals, opts) {
  const o = opts || {};
  const canonicalSet = new Set((o.canonicalKeys || []).map((k) => String(k)));
  const catalogSet = new Set((o.catalogKeys || []).map((k) => String(k)));
  const genericEnabled = o.genericEnabled === true;
  const list = Array.isArray(rentals) ? rentals : [];
  const canonical = [];
  const generic = [];
  for (let i = 0; i < list.length; i += 1) {
    const row = list[i];
    const key = String((row && row.offering_key) || '').trim();
    if (canonicalSet.has(key)) { canonical.push(row); continue; }
    if (genericEnabled && catalogSet.has(key)) { generic.push(row); continue; }
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
  GENERIC_RENTAL_SERVICE_TYPE,
};

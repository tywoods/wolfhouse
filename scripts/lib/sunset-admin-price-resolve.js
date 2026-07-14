'use strict';

/**
 * Generic Sunset Admin price resolver.
 *
 * All Sunset booking / quote / payment paths should call
 * resolveActiveSunsetAdminPrice rather than inventing service-specific prices.
 */

const {
  isSunsetAdminDbReadEnabled,
  loadTenantPriceRuleFromDb,
} = require('./tenant-business-config');
const {
  EXPECTED_TENANT,
  resolveSunsetPriceIdentity,
  priceIdentityKey,
} = require('./sunset-admin-price-identity');
const {
  isSunsetLocationId,
  normalizeSunsetLocationId,
} = require('./sunset-school-locations');

async function defaultLoadRule(params) {
  if (params.pgClient) {
    return loadTenantPriceRuleFromDb(params.pgClient, params);
  }
  const { withPgClient } = require('./pg-connect');
  return withPgClient((client) => loadTenantPriceRuleFromDb(client, params));
}

/**
 * @param {object} pg - pg client (optional if loadRule/pgClient in opts)
 * @param {object} opts
 * @returns {Promise<object>}
 */
async function resolveActiveSunsetAdminPrice(pg, opts) {
  const options = opts || {};
  const clientSlug = String(options.clientSlug || options.client_slug || EXPECTED_TENANT).trim();
  if (clientSlug !== EXPECTED_TENANT) {
    return {
      ok: false,
      reason: 'tenant_mismatch',
      client_slug: clientSlug,
      expected_tenant: EXPECTED_TENANT,
    };
  }

  const locationRaw = options.locationId != null ? options.locationId : options.location_id;
  if (locationRaw == null || String(locationRaw).trim() === '' || !isSunsetLocationId(locationRaw)) {
    return {
      ok: false,
      reason: 'unknown_location',
      client_slug: clientSlug,
      location_id: locationRaw == null ? locationRaw : String(locationRaw).trim(),
    };
  }
  const locationId = normalizeSunsetLocationId(locationRaw);

  const identity = resolveSunsetPriceIdentity({
    ...options,
    location_id: locationId,
    metadata: options.metadata || options,
    offering_id: options.offeringId || options.offering_id,
    price_id: options.priceId || options.price_id,
    item_type: options.itemType || options.item_type,
    item_code: options.itemCode || options.item_code,
    billing_unit: options.billingUnit || options.billing_unit,
  });

  if (!identity) {
    return {
      ok: false,
      reason: 'unresolved_offering_identity',
      client_slug: clientSlug,
      location_id: locationId,
      source: 'admin_db',
    };
  }

  if (!isSunsetAdminDbReadEnabled()) {
    return {
      ok: false,
      reason: 'db_read_disabled',
      client_slug: clientSlug,
      location_id: locationId,
      identity,
      source: 'admin_db',
    };
  }

  const quantity = Math.max(1, Number(options.quantity) || 1);
  const loadRule = options.loadRule || defaultLoadRule;
  const pgClient = options.pgClient || pg;

  let dbRes;
  try {
    dbRes = await loadRule({
      clientSlug,
      locationId,
      itemType: identity.item_type,
      itemCode: identity.item_code,
      duration: '',
      billingUnit: identity.billing_unit,
      pgClient,
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'price_lookup_failed',
      client_slug: clientSlug,
      location_id: locationId,
      identity,
      detail: err && err.message ? err.message : 'db_error',
    };
  }

  if (!dbRes || dbRes.status === 'tables_missing') {
    return {
      ok: false,
      reason: 'tables_missing',
      client_slug: clientSlug,
      location_id: locationId,
      identity,
    };
  }

  if (dbRes.status === 'ambiguous' || dbRes.ambiguous === true) {
    return {
      ok: false,
      reason: 'ambiguous_price',
      client_slug: clientSlug,
      location_id: locationId,
      identity,
      source: 'admin_db',
    };
  }

  if (dbRes.status !== 'found') {
    return {
      ok: false,
      reason: 'price_not_configured',
      client_slug: clientSlug,
      location_id: locationId,
      identity,
      detail: dbRes.status,
      source: 'admin_db',
    };
  }

  const unitAmount = Math.round(Number(dbRes.amount_cents));
  if (!Number.isFinite(unitAmount) || unitAmount <= 0) {
    return {
      ok: false,
      reason: 'price_not_configured',
      client_slug: clientSlug,
      location_id: locationId,
      identity,
      detail: 'non_positive_amount',
      source: 'admin_db',
    };
  }

  const mode = identity.billing_mode || 'unit_x_qty';
  // Quantity always multiplies once. Multi-day course expansion is handled by
  // the booking pricer (charge primary course row only), not here.
  const due = unitAmount * quantity;

  return {
    ok: true,
    client_slug: clientSlug,
    location_id: dbRes.location_id || locationId,
    offering_id: identity.offering_id,
    price_id: dbRes.id || identity.price_id || null,
    item_type: identity.item_type,
    item_code: identity.item_code,
    billing_unit: identity.billing_unit,
    billing_mode: mode,
    unit_amount_cents: unitAmount,
    amount_cents: due,
    quantity,
    currency: dbRes.currency || 'EUR',
    price_source: 'admin_db',
    identity_key: priceIdentityKey(identity),
    identity,
  };
}

function staffFacingSunsetAdminPriceError(reasonCode, identity) {
  const code = String(reasonCode || 'pricing_failed');
  if (/no_price_for_|price_not_configured|unresolved_offering|admin_price/i.test(code)) {
    const kind = identity && identity.item_type === 'package'
      ? 'course option'
      : 'service option';
    return {
      error: `This ${kind} is missing an active Admin price. Re-open it in Admin and confirm its price.`,
      reason_code: code.startsWith('no_price_for_') ? code : 'no_price_for_surf_lesson',
    };
  }
  if (/ambiguous/i.test(code)) {
    return {
      error: 'This service has duplicate active Admin prices. Clean them up in Admin before booking.',
      reason_code: 'ambiguous_price',
    };
  }
  if (/tier_key is required|course_tier/i.test(code)) {
    return {
      error: 'Select a course duration before creating the booking.',
      reason_code: code,
    };
  }
  return { error: code, reason_code: code };
}

module.exports = {
  resolveActiveSunsetAdminPrice,
  staffFacingSunsetAdminPriceError,
};

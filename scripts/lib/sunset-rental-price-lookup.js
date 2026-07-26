'use strict';

/**
 * sunset-rental-price-lookup.js
 *
 * Pure Sunset rental price lookup from school-scoped admin config.
 * No DB, no network, no Stripe, no WhatsApp.
 */

const { resolveSunsetAdminConfigForLuna } = require('./sunset-luna-school-context');
const {
  normalizeSunsetLocationId,
  isSunsetLocationId,
  DEFAULT_SUNSET_LOCATION_ID,
} = require('./sunset-school-locations');
const { isSunsetAdminDbReadEnabled } = require('./tenant-business-config');
const locationStore = require('./sunset-admin-location-store');

const EXPECTED_TENANT = 'sunset';

const ITEM_ALIASES = {
  board: 'board_rental',
  surfboard: 'board_rental',
  board_rental: 'board_rental',
  wetsuit: 'wetsuit_rental',
  wetsuit_rental: 'wetsuit_rental',
  board_suit: 'board_and_suit_rental',
  'board+suit': 'board_and_suit_rental',
  'board+suit bundle': 'board_and_suit_rental',
  'board+wetsuit': 'board_and_suit_rental',
  'board+wetsuit bundle': 'board_and_suit_rental',
  'board and suit': 'board_and_suit_rental',
  'board and wetsuit': 'board_and_suit_rental',
  'board + suit': 'board_and_suit_rental',
  'board + wetsuit': 'board_and_suit_rental',
  board_and_suit: 'board_and_suit_rental',
  board_and_suit_rental: 'board_and_suit_rental',
  bundle: 'board_and_suit_rental',
  sup: 'sup_rental',
  paddleboard: 'sup_rental',
  sup_rental: 'sup_rental',
};

const DURATION_ALIASES = {
  '1h': '1_hour',
  '1 hour': '1_hour',
  '1_hour': '1_hour',
  'half day': 'half_day',
  half_day: 'half_day',
  '1 day': '1_day',
  '1_day': '1_day',
  day: '1_day',
  '2 days': '2_days',
  '2_days': '2_days',
  '3 days': '3_days',
  '3_days': '3_days',
  '4 days': '4_days',
  '4_days': '4_days',
  '5 days': '5_days',
  '5_days': '5_days',
  '6 days': '6_days',
  '6_days': '6_days',
  '7 days': '7_days',
  '7_days': '7_days',
  week: '7_days',
};

function resolveItemCode(raw) {
  const key = String(raw || '').trim().toLowerCase();
  return ITEM_ALIASES[key] || key;
}

function resolveDurationKey(raw) {
  const key = String(raw || '').trim().toLowerCase();
  return DURATION_ALIASES[key] || key;
}

function findAdminPriceRule(adminCfg, itemCode, durationKey) {
  const prices = adminCfg && Array.isArray(adminCfg.prices) ? adminCfg.prices : [];
  return prices.find((p) => {
    if (!p) return false;
    const offering = String(p.offering_key || p.item_code || '').trim();
    const unit = String(p.unit || p.duration || p.window || '').trim();
    return offering === itemCode && unit === durationKey;
  }) || prices.find((p) => String(p.offering_key || '').trim() === itemCode
    && String(p.display_name || '').toLowerCase().includes(durationKey.replace(/_/g, ' ')));
}

function lookupSunsetRentalPrice(opts) {
  const options = opts || {};
  const rawSlug = options.client_slug;
  const clientSlug = (rawSlug != null) ? String(rawSlug).trim() : EXPECTED_TENANT;
  const rawItem = String(options.item || '').trim();
  const duration = resolveDurationKey(options.duration);
  const requireConfirmed = options.require_confirmed !== false;
  const locationId = normalizeSunsetLocationId(options.location_id || DEFAULT_SUNSET_LOCATION_ID);

  if (clientSlug !== EXPECTED_TENANT) {
    return {
      ok: false,
      reason: 'tenant_mismatch',
      client_slug: clientSlug,
      expected_tenant: EXPECTED_TENANT,
    };
  }

  const adminCfg = resolveSunsetAdminConfigForLuna(clientSlug, locationId);
  if (!adminCfg || adminCfg.ok === false) {
    return {
      ok: false,
      reason: 'config_not_found',
      client_slug: clientSlug,
      location_id: locationId,
    };
  }

  const itemCode = resolveItemCode(rawItem);
  if (!Object.values(ITEM_ALIASES).includes(itemCode)) {
    return { ok: false, reason: 'unknown_item', client_slug: clientSlug, tenant_id: clientSlug, location_id: locationId, item: itemCode, duration };
  }
  if (!duration) {
    return { ok: false, reason: 'price_not_configured', client_slug: clientSlug, tenant_id: clientSlug, location_id: locationId, item: itemCode, duration };
  }
  const rule = findAdminPriceRule(adminCfg, itemCode, duration);
  if (!rule) {
    return {
      ok: false,
      reason: 'price_not_configured',
      client_slug: clientSlug,
      location_id: locationId,
      item: itemCode,
      duration,
    };
  }

  // Config-backed rules expose amount in EUR; DB-backed rules expose
  // amount_cents. Normalize both into one authoritative cents value.
  const amountCents = Number.isFinite(Number(rule.amount_cents))
    ? Math.round(Number(rule.amount_cents))
    : (Number.isFinite(Number(rule.amount)) ? Math.round(Number(rule.amount) * 100) : NaN);
  if (!Number.isFinite(amountCents)) {
    return {
      ok: false,
      reason: 'price_not_configured',
      client_slug: clientSlug,
      location_id: locationId,
      item: itemCode,
      duration,
    };
  }

  const pricingStatus = String(rule.pricing_status || rule.status || 'confirmed').trim();
  const liveQuoteAllowed = pricingStatus === 'confirmed';

  if (requireConfirmed && !liveQuoteAllowed) {
    return {
      ok: false,
      reason: 'price_unverified',
      client_slug: clientSlug,
      location_id: locationId,
      item: itemCode,
      duration,
      pricing_status: pricingStatus,
      live_quote_allowed: false,
    };
  }

  return {
    ok: true,
    client_slug: clientSlug,
    tenant_id: clientSlug,
    location_id: locationId,
    location_label: adminCfg.location_label,
    item: itemCode,
    duration,
    amount_cents: amountCents,
    amount_eur: amountCents / 100,
    currency: rule.currency || 'EUR',
    pricing_status: pricingStatus,
    live_quote_allowed: liveQuoteAllowed,
    source: rule.seed_source || rule.source || 'admin_config',
    source_url: rule.seed_source_url || null,
  };
}

function resolveRentalBillingUnit(durationKey) {
  const key = String(durationKey || '').trim();
  if (/hour|half_day|lesson/i.test(key)) return 'session';
  // Inclusive 1–7 day windows share billing grain "day" (whole-window price row).
  if (key === '1_day' || /^[1-7]_days$/.test(key)) return 'day';
  return null;
}

async function defaultLoadRentalRule(params) {
  const { loadTenantPriceRuleFromDb } = require('./tenant-business-config');
  if (params.pgClient) {
    return loadTenantPriceRuleFromDb(params.pgClient, params);
  }
  const { withPgClient } = require('./pg-connect');
  return withPgClient((client) => loadTenantPriceRuleFromDb(client, params));
}

/**
 * Async, DB-authoritative rental price lookup for LIVE Staff API / tool paths.
 *
 * Fail-closed ownership for live Admin pricing (ALL prices from Admin tab):
 *   - SUNSET_ADMIN_DB_READ_ENABLED off → pure baseline/config (bootstrap/offline only).
 *   - flag on: tenant+location scoped tenant_price_rules row is sole price owner.
 *   - DB rule found (valid cents) → return it (source=db, source_url=null).
 *   - table exists, no rule → fail closed (price_not_configured); NEVER the
 *                             stale public_site baseline seed.
 *   - null response or tables_missing while DB-read is on → fail closed
 *     (price_lookup_failed); NEVER baseline/public_site cents. Baseline is
 *     allowed ONLY when the DB-read feature flag is OFF.
 *   - location mismatch / invalid location / query error → fail closed;
 *     never silent baseline merge while live DB-read mode is on.
 *
 * @param {object} opts client_slug, item, duration, location_id, require_confirmed,
 *                       plus optional pgClient / loadRule (test injection).
 */
async function lookupSunsetRentalPriceAsync(opts) {
  const options = opts || {};
  const rawSlug = options.client_slug;
  const clientSlug = (rawSlug != null) ? String(rawSlug).trim() : EXPECTED_TENANT;
  const rawItem = String(options.item || '').trim();
  const duration = resolveDurationKey(options.duration);
  const requireConfirmed = options.require_confirmed !== false;

  if (clientSlug !== EXPECTED_TENANT) {
    return { ok: false, reason: 'tenant_mismatch', client_slug: clientSlug, expected_tenant: EXPECTED_TENANT };
  }

  // Distinguish omitted location (fixed-ingress Somo default) from explicitly
  // supplied null/empty/invalid values, which must fail closed.
  const locationExplicit = Object.prototype.hasOwnProperty.call(options, 'location_id');
  const rawLoc = options.location_id;
  if (locationExplicit) {
    if (rawLoc == null || String(rawLoc).trim() === '' || !isSunsetLocationId(rawLoc)) {
      return {
        ok: false,
        reason: 'unknown_location',
        client_slug: clientSlug,
        location_id: rawLoc == null ? rawLoc : String(rawLoc).trim(),
      };
    }
  }
  const locationId = locationExplicit
    ? normalizeSunsetLocationId(rawLoc)
    : DEFAULT_SUNSET_LOCATION_ID;

  const itemCode = resolveItemCode(rawItem);
  if (!Object.values(ITEM_ALIASES).includes(itemCode)) {
    return { ok: false, reason: 'unknown_item', client_slug: clientSlug, tenant_id: clientSlug, location_id: locationId, item: itemCode, duration };
  }
  if (!duration) {
    return { ok: false, reason: 'price_not_configured', client_slug: clientSlug, tenant_id: clientSlug, location_id: locationId, item: itemCode, duration };
  }

  // Flag off → baseline/config path (preview & bootstrap only). Never a live fallback.
  if (!isSunsetAdminDbReadEnabled()) {
    return lookupSunsetRentalPrice({
      client_slug: clientSlug,
      location_id: locationId,
      item: itemCode,
      duration,
      require_confirmed: requireConfirmed,
    });
  }

  const billingUnit = resolveRentalBillingUnit(duration);
  if (!billingUnit) {
    return {
      ok: false,
      reason: 'price_not_configured',
      client_slug: clientSlug,
      tenant_id: clientSlug,
      location_id: locationId,
      item: itemCode,
      duration,
      source: 'db',
    };
  }

  const loadRule = options.loadRule || defaultLoadRentalRule;
  let dbRes;
  try {
    dbRes = await loadRule({
      clientSlug,
      locationId,
      itemType: 'rental',
      itemCode,
      duration,
      billingUnit,
      pgClient: options.pgClient,
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'price_lookup_failed',
      client_slug: clientSlug,
      tenant_id: clientSlug,
      location_id: locationId,
      item: itemCode,
      duration,
      detail: (err && err.message) ? err.message : 'db_error',
    };
  }

  // DB-read mode: null / tables_missing fail closed — never baseline/public_site cents.
  if (!dbRes || dbRes.status === 'tables_missing') {
    return {
      ok: false,
      reason: 'price_lookup_failed',
      client_slug: clientSlug,
      tenant_id: clientSlug,
      location_id: locationId,
      item: itemCode,
      duration,
      detail: !dbRes ? 'null_response' : 'tables_missing',
    };
  }

  if (dbRes.status !== 'found') {
    const failClosed = dbRes.status === 'billing_unit_required'
      || dbRes.status === 'location_scope_unavailable'
      || dbRes.status === 'invalid_location'
      || dbRes.status === 'not_found';
    if (!failClosed) {
      return {
        ok: false,
        reason: 'price_lookup_failed',
        client_slug: clientSlug,
        tenant_id: clientSlug,
        location_id: locationId,
        item: itemCode,
        duration,
        detail: dbRes.status,
      };
    }
    return {
      ok: false,
      reason: 'price_not_configured',
      client_slug: clientSlug,
      tenant_id: clientSlug,
      location_id: locationId,
      item: itemCode,
      duration,
      source: 'db',
    };
  }

  const amountCents = Math.round(Number(dbRes.amount_cents));
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return {
      ok: false,
      reason: 'price_not_configured',
      client_slug: clientSlug,
      tenant_id: clientSlug,
      location_id: locationId,
      item: itemCode,
      duration,
      source: 'db',
    };
  }

  const effectiveLoc = dbRes.location_id || locationId;
  return {
    ok: true,
    client_slug: clientSlug,
    tenant_id: clientSlug,
    location_id: effectiveLoc,
    location_label: locationStore.resolveLocationLabel(effectiveLoc),
    item: itemCode,
    duration,
    amount_cents: amountCents,
    amount_eur: amountCents / 100,
    currency: dbRes.currency || 'EUR',
    // Owner-managed portal rules are authoritative → always live-quotable.
    pricing_status: 'confirmed',
    live_quote_allowed: true,
    source: 'db',
    source_url: null,
  };
}

const FULL_DAY_EQUIPMENT_ADDON_KEY = 'full_day_equipment_extension';
const FULL_DAY_EQUIPMENT_ADDON_DURATION = 'day';
const FULL_DAY_EQUIPMENT_ADDON_BILLING_UNIT = 'day';
const FULL_DAY_EQUIPMENT_ADDON_ITEM_CODE = `${FULL_DAY_EQUIPMENT_ADDON_KEY}__${FULL_DAY_EQUIPMENT_ADDON_DURATION}`;

// Read the active state + config/DB price for the full-day equipment add-on, school-scoped.
// Sync baseline path only — live Staff Create/Edit must use the async DB-authoritative
// variant when SUNSET_ADMIN_DB_READ_ENABLED is on. Baseline is allowed ONLY when that
// flag is off; the async path never falls back to this helper under DB-read mode.
// Fail-closed on unknown tenant/location, missing/disabled price.
function lookupSunsetFullDayEquipmentAddon(opts) {
  const options = opts || {};
  const rawSlug = options.client_slug;
  const clientSlug = (rawSlug != null) ? String(rawSlug).trim() : EXPECTED_TENANT;
  const locationId = normalizeSunsetLocationId(options.location_id || DEFAULT_SUNSET_LOCATION_ID);

  if (clientSlug !== EXPECTED_TENANT) {
    return { ok: false, reason: 'tenant_mismatch', client_slug: clientSlug, expected_tenant: EXPECTED_TENANT };
  }
  const adminCfg = resolveSunsetAdminConfigForLuna(clientSlug, locationId);
  if (!adminCfg || adminCfg.ok === false) {
    return { ok: false, reason: 'config_not_found', client_slug: clientSlug, location_id: locationId };
  }
  const prices = Array.isArray(adminCfg.prices) ? adminCfg.prices : [];
  const rule = prices.find((p) => {
    if (!p || p.active === false) return false;
    if (String(p.category || '').toLowerCase() !== 'rental') return false;
    const key = String(p.offering_key || p.item_code || '');
    const unit = String(p.unit || '');
    return (key === FULL_DAY_EQUIPMENT_ADDON_KEY && (!unit || unit === FULL_DAY_EQUIPMENT_ADDON_DURATION))
      || key === FULL_DAY_EQUIPMENT_ADDON_ITEM_CODE;
  });
  if (!rule) {
    return {
      ok: false, reason: 'addon_disabled', client_slug: clientSlug, location_id: locationId,
      addon_key: FULL_DAY_EQUIPMENT_ADDON_KEY, active: false,
    };
  }
  let amountCents = null;
  if (rule.amount_cents != null && Number.isFinite(Number(rule.amount_cents))) amountCents = Math.round(Number(rule.amount_cents));
  else if (rule.amount != null && Number.isFinite(Number(rule.amount))) amountCents = Math.round(Number(rule.amount) * 100);
  if (amountCents == null || amountCents <= 0) {
    return {
      ok: false, reason: 'price_not_configured', client_slug: clientSlug, location_id: locationId,
      addon_key: FULL_DAY_EQUIPMENT_ADDON_KEY,
    };
  }
  return {
    ok: true,
    client_slug: clientSlug,
    tenant_id: clientSlug,
    location_id: locationId,
    location_label: adminCfg.location_label,
    addon_key: FULL_DAY_EQUIPMENT_ADDON_KEY,
    active: true,
    billing_unit: 'person_per_day',
    unit: FULL_DAY_EQUIPMENT_ADDON_DURATION,
    amount_cents: amountCents,
    amount_eur: amountCents / 100,
    currency: rule.currency || 'EUR',
    source: rule.source === 'db' ? 'db' : 'admin_config',
  };
}

/**
 * Async, DB-authoritative full-day equipment add-on price lookup for LIVE paths.
 *
 * Fail-closed ownership for Create/Edit Admin pricing:
 *   - SUNSET_ADMIN_DB_READ_ENABLED off → pure baseline/config (bootstrap/offline only).
 *   - flag on: tenant+location scoped tenant_price_rules row is sole price owner.
 *   - DB found active valid cents → exact cents (source=db); never client/static merge.
 *   - row missing/disabled/invalid, location mismatch, query error → fail closed;
 *     never silent baseline/config merge fallback while live DB-read mode is on.
 *   - null response or tables_missing while DB-read is on → fail closed
 *     (price_lookup_failed / stable reason); NEVER baseline cents. Baseline is
 *     allowed ONLY when the DB-read feature flag is OFF.
 *
 * Admin row identity: item_type=rental, item_code=full_day_equipment_extension__day,
 * unit=day (billing grain), location_id exact.
 */
async function lookupSunsetFullDayEquipmentAddonAsync(opts) {
  const options = opts || {};
  const rawSlug = options.client_slug;
  const clientSlug = (rawSlug != null) ? String(rawSlug).trim() : EXPECTED_TENANT;

  if (clientSlug !== EXPECTED_TENANT) {
    return { ok: false, reason: 'tenant_mismatch', client_slug: clientSlug, expected_tenant: EXPECTED_TENANT };
  }

  // Distinguish omitted location (fixed-ingress Somo default) from explicitly
  // supplied null/empty/invalid values, which must fail closed.
  const locationExplicit = Object.prototype.hasOwnProperty.call(options, 'location_id');
  const rawLoc = options.location_id;
  if (locationExplicit) {
    if (rawLoc == null || String(rawLoc).trim() === '' || !isSunsetLocationId(rawLoc)) {
      return {
        ok: false,
        reason: 'unknown_location',
        client_slug: clientSlug,
        location_id: rawLoc == null ? rawLoc : String(rawLoc).trim(),
        addon_key: FULL_DAY_EQUIPMENT_ADDON_KEY,
      };
    }
  }
  const locationId = locationExplicit
    ? normalizeSunsetLocationId(rawLoc)
    : DEFAULT_SUNSET_LOCATION_ID;

  // Flag off → baseline/config path (preview & bootstrap only). Never a live fallback.
  if (!isSunsetAdminDbReadEnabled()) {
    return lookupSunsetFullDayEquipmentAddon({
      client_slug: clientSlug,
      location_id: locationId,
    });
  }

  const loadRule = options.loadRule || defaultLoadRentalRule;
  let dbRes;
  try {
    dbRes = await loadRule({
      clientSlug,
      locationId,
      itemType: 'rental',
      // Offering key + duration → persisted full_day_equipment_extension__day.
      itemCode: FULL_DAY_EQUIPMENT_ADDON_KEY,
      duration: FULL_DAY_EQUIPMENT_ADDON_DURATION,
      billingUnit: FULL_DAY_EQUIPMENT_ADDON_BILLING_UNIT,
      pgClient: options.pgClient,
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'price_lookup_failed',
      client_slug: clientSlug,
      tenant_id: clientSlug,
      location_id: locationId,
      addon_key: FULL_DAY_EQUIPMENT_ADDON_KEY,
      detail: (err && err.message) ? err.message : 'db_error',
    };
  }

  // DB-read mode: null / tables_missing fail closed — never baseline cents.
  if (!dbRes || dbRes.status === 'tables_missing') {
    return {
      ok: false,
      reason: 'price_lookup_failed',
      client_slug: clientSlug,
      tenant_id: clientSlug,
      location_id: locationId,
      addon_key: FULL_DAY_EQUIPMENT_ADDON_KEY,
      detail: !dbRes ? 'null_response' : 'tables_missing',
    };
  }

  if (dbRes.status !== 'found') {
    const failClosed = dbRes.status === 'billing_unit_required'
      || dbRes.status === 'location_scope_unavailable'
      || dbRes.status === 'invalid_location'
      || dbRes.status === 'not_found';
    if (!failClosed) {
      return {
        ok: false,
        reason: 'price_lookup_failed',
        client_slug: clientSlug,
        tenant_id: clientSlug,
        location_id: locationId,
        addon_key: FULL_DAY_EQUIPMENT_ADDON_KEY,
        detail: dbRes.status,
      };
    }
    return {
      ok: false,
      reason: 'price_not_configured',
      client_slug: clientSlug,
      tenant_id: clientSlug,
      location_id: locationId,
      addon_key: FULL_DAY_EQUIPMENT_ADDON_KEY,
      source: 'db',
    };
  }

  const amountCents = Math.round(Number(dbRes.amount_cents));
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return {
      ok: false,
      reason: 'price_not_configured',
      client_slug: clientSlug,
      tenant_id: clientSlug,
      location_id: locationId,
      addon_key: FULL_DAY_EQUIPMENT_ADDON_KEY,
      source: 'db',
    };
  }

  const effectiveLoc = dbRes.location_id || locationId;
  return {
    ok: true,
    client_slug: clientSlug,
    tenant_id: clientSlug,
    location_id: effectiveLoc,
    location_label: locationStore.resolveLocationLabel(effectiveLoc),
    addon_key: FULL_DAY_EQUIPMENT_ADDON_KEY,
    active: true,
    billing_unit: 'person_per_day',
    unit: FULL_DAY_EQUIPMENT_ADDON_DURATION,
    amount_cents: amountCents,
    amount_eur: amountCents / 100,
    currency: dbRes.currency || 'EUR',
    pricing_status: 'confirmed',
    live_quote_allowed: true,
    source: 'db',
    source_url: null,
  };
}

module.exports = {
  lookupSunsetRentalPrice,
  lookupSunsetRentalPriceAsync,
  lookupSunsetFullDayEquipmentAddon,
  lookupSunsetFullDayEquipmentAddonAsync,
  FULL_DAY_EQUIPMENT_ADDON_KEY,
  FULL_DAY_EQUIPMENT_ADDON_ITEM_CODE,
  ITEM_ALIASES,
  DURATION_ALIASES,
  resolveRentalBillingUnit,
  resolveDurationKey,
};

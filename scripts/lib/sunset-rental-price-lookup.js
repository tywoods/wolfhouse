'use strict';

/**
 * sunset-rental-price-lookup.js
 *
 * Pure Sunset rental price lookup from school-scoped admin config.
 * No DB, no network, no Stripe, no WhatsApp.
 */

const { resolveSunsetAdminConfigForLuna } = require('./sunset-luna-school-context');
const { normalizeSunsetLocationId, DEFAULT_SUNSET_LOCATION_ID } = require('./sunset-school-locations');

const EXPECTED_TENANT = 'sunset';

const ITEM_ALIASES = {
  board: 'board_rental',
  surfboard: 'board_rental',
  board_rental: 'board_rental',
  wetsuit: 'wetsuit_rental',
  wetsuit_rental: 'wetsuit_rental',
  board_suit: 'board_and_suit_rental',
  board_and_suit: 'board_and_suit_rental',
  board_and_suit_rental: 'board_and_suit_rental',
  bundle: 'board_and_suit_rental',
  sup: 'sup_rental',
  paddleboard: 'sup_rental',
  sup_rental: 'sup_rental',
};

const DURATION_ALIASES = {
  '1h': '1_hour',
  '1_hour': '1_hour',
  half_day: 'half_day',
  '1_day': '1_day',
  day: '1_day',
  '2_days': '2_days',
  '5_days': '5_days',
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

  const amountCents = Number(rule.amount_cents);
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
    source: 'admin_config',
  };
}

const FULL_DAY_EQUIPMENT_ADDON_KEY = 'full_day_equipment_extension';

// Read the active state + config/DB price for the full-day equipment add-on, school-scoped.
// Fail-closed on unknown tenant/location, missing/disabled price. Price strictly config/DB-backed.
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
    return (key === FULL_DAY_EQUIPMENT_ADDON_KEY && (!unit || unit === 'day'))
      || key === `${FULL_DAY_EQUIPMENT_ADDON_KEY}__day`;
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
    unit: 'day',
    amount_cents: amountCents,
    amount_eur: amountCents / 100,
    currency: rule.currency || 'EUR',
    source: rule.source === 'db' ? 'db' : 'admin_config',
  };
}

module.exports = {
  lookupSunsetRentalPrice,
  lookupSunsetFullDayEquipmentAddon,
  FULL_DAY_EQUIPMENT_ADDON_KEY,
  ITEM_ALIASES,
};

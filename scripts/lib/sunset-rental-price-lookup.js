'use strict';

/**
 * sunset-rental-price-lookup.js
 *
 * Pure Sunset rental price lookup from tenant config.
 * No DB, no network, no Stripe, no Staff API, no WhatsApp.
 *
 * Part of the Luna Front Desk platform service catalog — tenant_id=sunset.
 * Not imported by live Luna runtime yet; test/preview only for this slice.
 *
 * @module sunset-rental-price-lookup
 */

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config', 'clients');
const EXPECTED_TENANT = 'sunset';

function loadClientBaseline(clientSlug) {
  const slug = String(clientSlug || '').trim();
  if (!slug) return null;
  try {
    const filePath = path.join(CONFIG_DIR, `${slug}.baseline.json`);
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * Canonical item-code aliases — normalise common shorthand to config keys.
 * Guest messages and callers may use short forms; config uses the full keys.
 */
const ITEM_ALIASES = {
  board:          'board_rental',
  surfboard:      'board_rental',
  board_rental:   'board_rental',
  wetsuit:        'wetsuit_rental',
  wetsuit_rental: 'wetsuit_rental',
  board_suit:         'board_and_suit_rental',
  board_and_suit:     'board_and_suit_rental',
  board_and_suit_rental: 'board_and_suit_rental',
  bundle:         'board_and_suit_rental',
  sup:            'sup_rental',
  paddleboard:    'sup_rental',
  sup_rental:     'sup_rental',
};

function resolveItemCode(raw) {
  const key = String(raw || '').trim().toLowerCase();
  return ITEM_ALIASES[key] || key;
}

/**
 * lookupSunsetRentalPrice(opts)
 *
 * @param {object} opts
 *   client_slug        {string}   Must be 'sunset'. Default 'sunset'.
 *   item               {string}   Canonical or alias item code (see ITEM_ALIASES).
 *   duration           {string}   Window key as stored in config: '1_hour' | 'half_day' | '1_day' | '2_days' | '5_days' | '7_days'
 *   require_confirmed  {boolean}  Default true. When true, blocks prices where pricing_status !== 'confirmed'.
 *
 * @returns {object}
 *   Success:
 *     { ok: true, client_slug, tenant_id, item, duration, amount_eur, currency,
 *       pricing_status, live_quote_allowed, source, source_url }
 *   Failure:
 *     { ok: false, reason, client_slug?, tenant_id?, item?, duration? }
 *
 * Failure reasons:
 *   'tenant_mismatch'       — client_slug is not 'sunset'
 *   'config_not_found'      — baseline.json could not be loaded
 *   'unknown_item'          — item not found in catalog.rentals.offerings
 *   'price_not_configured'  — window key absent or value is null in prices_eur
 *   'price_unverified'      — pricing_status is not 'confirmed' and require_confirmed=true
 */
function lookupSunsetRentalPrice(opts) {
  const options = opts || {};
  // Treat null/undefined as "caller is in a sunset-only context" (default to sunset).
  // Treat an explicit empty string as missing/unknown — fail the tenant guard rather than silently defaulting.
  const rawSlug    = options.client_slug;
  const clientSlug = (rawSlug != null) ? String(rawSlug).trim() : EXPECTED_TENANT;
  const rawItem    = String(options.item || '').trim();
  const duration   = String(options.duration || '').trim();
  const requireConfirmed = options.require_confirmed !== false; // default true

  // Guard: tenant isolation — only serves sunset config
  if (clientSlug !== EXPECTED_TENANT) {
    return {
      ok: false,
      reason: 'tenant_mismatch',
      client_slug: clientSlug,
      expected_tenant: EXPECTED_TENANT,
    };
  }

  const baseline = loadClientBaseline(clientSlug);
  if (!baseline) {
    return {
      ok: false,
      reason: 'config_not_found',
      client_slug: clientSlug,
    };
  }

  const tenantId  = (baseline._meta && baseline._meta.tenant_id) || clientSlug;
  const currency  = (baseline.pricing_policy && baseline.pricing_policy.currency)
    || (baseline._meta && baseline._meta.currency)
    || 'EUR';

  const itemCode  = resolveItemCode(rawItem);
  const offerings = baseline.catalog
    && baseline.catalog.rentals
    && baseline.catalog.rentals.offerings;

  if (!offerings || typeof offerings !== 'object') {
    return {
      ok: false,
      reason: 'unknown_item',
      client_slug: clientSlug,
      tenant_id: tenantId,
      item: itemCode,
      duration,
    };
  }

  const offering = offerings[itemCode];
  if (!offering) {
    return {
      ok: false,
      reason: 'unknown_item',
      client_slug: clientSlug,
      tenant_id: tenantId,
      item: itemCode,
      duration,
    };
  }

  const prices = offering.prices_eur;
  if (!prices || typeof prices !== 'object') {
    return {
      ok: false,
      reason: 'price_not_configured',
      client_slug: clientSlug,
      tenant_id: tenantId,
      item: itemCode,
      duration,
    };
  }

  // Check window exists and is non-null
  if (!Object.prototype.hasOwnProperty.call(prices, duration) || prices[duration] == null) {
    return {
      ok: false,
      reason: 'price_not_configured',
      client_slug: clientSlug,
      tenant_id: tenantId,
      item: itemCode,
      duration,
    };
  }

  const amountEur      = prices[duration];
  const pricingStatus  = String(offering.pricing_status || 'unverified_seed').trim();
  const liveQuoteAllowed = pricingStatus === 'confirmed';

  // Block unverified prices in live/confirmed mode
  if (requireConfirmed && !liveQuoteAllowed) {
    return {
      ok: false,
      reason: 'price_unverified',
      client_slug: clientSlug,
      tenant_id: tenantId,
      item: itemCode,
      duration,
      pricing_status: pricingStatus,
      live_quote_allowed: false,
    };
  }

  return {
    ok: true,
    client_slug: clientSlug,
    tenant_id: tenantId,
    item: itemCode,
    duration,
    amount_eur: amountEur,
    currency,
    pricing_status: pricingStatus,
    live_quote_allowed: liveQuoteAllowed,
    source: offering.seed_source || null,
    source_url: offering.seed_source_url || null,
  };
}

module.exports = {
  lookupSunsetRentalPrice,
  ITEM_ALIASES,
};

'use strict';

/**
 * wh_pricing_items.metadata for the config export/import adapter.
 *
 * Typed keys are the ones Staff Admin Pricing and Luna catalog actually
 * read and write (not an invented 4-key allowlist):
 *
 *   scripts/lib/wolfhouse-pricing-resolve.js
 *     includes, pebble, min_days, allow_daily_proration, minimum_nights
 *   scripts/lib/wolfhouse-pricing-store.js
 *     promoted_from, pebble, min_days, allow_daily_proration
 *   scripts/lib/wolfhouse-pricing-writes.js
 *     includes, minimum_nights, plus the rest of body.metadata
 *   scripts/browser/wolfhouse-admin-pricing-ui.js
 *     pebble, min_days, allow_daily_proration, includes
 *   scripts/lib/model-led-luna/index.js
 *     includes, min_days, allow_daily_proration
 *
 * pricing_unit / per_guest / inclusions stay typed because the previous
 * contract already checked them. Unknown keys are copied unchanged with a
 * logged warning so a TEST→prod config copy stays faithful. Never drop.
 */

function fail(code) {
  const err = new Error(code);
  err.code = code;
  throw err;
}

function isStringList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isNonNegInt(value) {
  return Number.isInteger(value) && value >= 0;
}

const TYPED_PRICING_ITEM_METADATA = Object.freeze({
  allow_daily_proration: (value) => typeof value === 'boolean',
  includes: isStringList,
  min_days: isNonNegInt,
  pebble: (value) => typeof value === 'string',
  promoted_from: (value) => typeof value === 'string',
  minimum_nights: isNonNegInt,
  pricing_unit: (value) => typeof value === 'string',
  per_guest: (value) => typeof value === 'boolean',
  inclusions: isStringList,
});

function warnUnknownMetadataKey(key) {
  process.stderr.write('unknown_pricing_item_metadata_key:' + key + '\n');
}

function normalizePricingItemMetadata(metadata) {
  if (metadata == null) return {};
  if (typeof metadata !== 'object' || Array.isArray(metadata)) fail('invalid_metadata');
  const out = {};
  for (const key of Object.keys(metadata)) {
    const value = metadata[key];
    const check = TYPED_PRICING_ITEM_METADATA[key];
    if (check) {
      if (!check(value)) fail('invalid_metadata');
    } else {
      warnUnknownMetadataKey(key);
    }
    out[key] = value;
  }
  return out;
}

module.exports = {
  TYPED_PRICING_ITEM_METADATA,
  normalizePricingItemMetadata,
};

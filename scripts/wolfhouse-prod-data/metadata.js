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
 *
 * The typed map is null-prototype so inherited names (hasOwnProperty,
 * constructor, toString, __proto__) cannot be mistaken for validators.
 * Copies use own-key defineProperty. JSON null stays null. Validation
 * never mutates the caller's row.
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

const TYPED_PRICING_ITEM_METADATA = Object.freeze(Object.assign(Object.create(null), {
  allow_daily_proration: (value) => typeof value === 'boolean',
  includes: isStringList,
  min_days: isNonNegInt,
  pebble: (value) => typeof value === 'string',
  promoted_from: (value) => typeof value === 'string',
  minimum_nights: isNonNegInt,
  pricing_unit: (value) => typeof value === 'string',
  per_guest: (value) => typeof value === 'boolean',
  inclusions: isStringList,
}));

function warnUnknownMetadataKey(key) {
  process.stderr.write('unknown_pricing_item_metadata_key:' + key + '\n');
}

function readOwn(object, key) {
  const desc = Object.getOwnPropertyDescriptor(object, key);
  return desc ? desc.value : undefined;
}

function copyOwn(object) {
  const out = Object.create(null);
  for (const key of Object.keys(object)) {
    Object.defineProperty(out, key, {
      value: readOwn(object, key),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function typedValidator(key) {
  return Object.prototype.hasOwnProperty.call(TYPED_PRICING_ITEM_METADATA, key)
    ? TYPED_PRICING_ITEM_METADATA[key]
    : null;
}

function normalizePricingItemMetadata(metadata) {
  if (metadata == null) return metadata;
  if (typeof metadata !== 'object' || Array.isArray(metadata)) fail('invalid_metadata');
  const out = copyOwn(metadata);
  for (const key of Object.keys(out)) {
    const check = typedValidator(key);
    if (check) {
      if (!check(out[key])) fail('invalid_metadata');
    } else {
      warnUnknownMetadataKey(key);
    }
  }
  return out;
}

module.exports = {
  TYPED_PRICING_ITEM_METADATA,
  normalizePricingItemMetadata,
};

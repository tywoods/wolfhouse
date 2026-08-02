'use strict';

/**
 * sunset-rental-standalone-price-audit.js
 *
 * READ-ONLY operator audit helper — NOT production price authority.
 * Production quote/create enforce exact tenant_price_rules via
 * loadTenantPriceRuleFromDb / resolveGenericRentalPrice /
 * lookupSunsetRentalPrice[Async]. This module never writes and is never on the
 * booking money path.
 *
 * Use to compare exact-key presence vs alias-family neighbours before Admin
 * resave. Do not treat its output as runtime pricing enforcement.
 *
 * Exact-row proof (strict):
 *   - clientSlug must be sunset
 *   - locationId must be an explicit known Sunset location
 *   - row.location_id must be present and equal requested location
 *   - row.item_code must equal `${offering_key}__${duration_key}`
 *   - row tenant/client_slug when present must be sunset
 * Missing row location or alternate projected shapes alone are not exact proof.
 */

const {
  resolveRentalBillingUnit,
  resolveDurationKey,
  rentalOfferingKeyCandidates,
} = require('./sunset-rental-price-lookup');
const {
  isSunsetLocationId,
  normalizeSunsetLocationId,
} = require('./sunset-school-locations');

const BUNDLE_FAMILY = Object.freeze([
  'board_and_suit_rental',
  'surfboard_wetsuit_rental',
  'board_and_wetsuit_rental',
]);

const EXPECTED_TENANT = 'sunset';

/**
 * @param {object} opts
 * @param {string} opts.clientSlug  required — must be sunset
 * @param {string} opts.offeringKey
 * @param {string} opts.durationKey
 * @param {string} opts.locationId  required known Sunset location
 * @param {Array<object>} opts.priceRows
 * @returns {{ok:true,...}|{ok:false,reason:string}}
 */
function auditStandaloneRentalPriceRows(opts) {
  const o = opts || {};
  const clientSlug = String(o.clientSlug || o.client_slug || '').trim();
  if (clientSlug !== EXPECTED_TENANT) {
    return {
      ok: false,
      reason: 'tenant_mismatch',
      client_slug: clientSlug,
      expected_tenant: EXPECTED_TENANT,
      mode: 'read_only_audit',
      production_authority: false,
    };
  }
  const offeringKey = String(o.offeringKey || '').trim();
  const durationKey = resolveDurationKey(o.durationKey);
  const rawLoc = o.locationId != null ? o.locationId : o.location_id;
  if (rawLoc == null || String(rawLoc).trim() === '' || !isSunsetLocationId(rawLoc)) {
    return {
      ok: false,
      reason: 'unknown_location',
      client_slug: clientSlug,
      location_id: rawLoc == null ? rawLoc : String(rawLoc).trim(),
      mode: 'read_only_audit',
      production_authority: false,
    };
  }
  const locationId = normalizeSunsetLocationId(rawLoc);
  const billingUnit = resolveRentalBillingUnit(durationKey);
  const expectedCode = offeringKey && durationKey ? `${offeringKey}__${durationKey}` : '';
  const rows = Array.isArray(o.priceRows) ? o.priceRows : [];

  function rowTenantOk(row) {
    const t = row.client_slug != null ? String(row.client_slug).trim()
      : (row.tenant != null ? String(row.tenant).trim() : '');
    if (!t) return true; // absent tenant column: still require location + item_code
    return t === EXPECTED_TENANT;
  }

  function matchExact(row) {
    if (!row || row.active === false) return false;
    if (!rowTenantOk(row)) return false;
    // Exact location required — missing location is not proof of exact row.
    if (row.location_id == null || String(row.location_id).trim() === '') return false;
    if (String(row.location_id).trim() !== locationId) return false;
    // Exact item_code only — bare offering_key / projected aliases alone do not count.
    const code = String(row.item_code || '').trim();
    if (code !== expectedCode) return false;
    const unit = String(row.unit || row.duration || '').trim();
    if (unit && unit !== billingUnit && unit !== durationKey) return false;
    return true;
  }

  const exactHits = rows.filter(matchExact).map((r) => ({
    item_code: String(r.item_code).trim(),
    offering_key: offeringKey,
    unit: r.unit,
    amount_cents: r.amount_cents != null
      ? Math.round(Number(r.amount_cents))
      : (r.amount != null ? Math.round(Number(r.amount) * 100) : null),
    active: r.active !== false,
    location_id: String(r.location_id).trim(),
    client_slug: r.client_slug != null ? String(r.client_slug).trim()
      : (r.tenant != null ? String(r.tenant).trim() : null),
  }));

  const exact = exactHits.find((h) => Number.isFinite(h.amount_cents) && h.amount_cents > 0) || null;
  const exactZero = exactHits.find((h) => h.amount_cents != null && h.amount_cents <= 0) || null;

  const family = rentalOfferingKeyCandidates(offeringKey)
    .filter((k) => k && k !== offeringKey);
  const aliases = [];
  for (const alias of family) {
    const aliasCode = `${alias}__${durationKey}`;
    for (const r of rows) {
      if (!r || r.active === false) continue;
      if (!rowTenantOk(r)) continue;
      if (r.location_id == null || String(r.location_id).trim() === '') continue;
      if (String(r.location_id).trim() !== locationId) continue;
      const code = String(r.item_code || '').trim();
      if (code !== aliasCode) continue;
      const cents = r.amount_cents != null
        ? Math.round(Number(r.amount_cents))
        : (r.amount != null ? Math.round(Number(r.amount) * 100) : null);
      aliases.push({
        offering_key: alias,
        item_code: code,
        amount_cents: cents,
        unit: r.unit || null,
        location_id: String(r.location_id).trim(),
      });
    }
  }

  let recommendation = 'ok_exact';
  let conflict = false;
  if (exact) {
    if (aliases.some((a) => a.amount_cents != null && a.amount_cents !== exact.amount_cents)) {
      conflict = true;
      recommendation = 'exact_wins_ignore_aliases_do_not_borrow';
    }
  } else if (exactZero) {
    recommendation = 'exact_row_non_positive_fail_closed_resave_in_admin';
    conflict = true;
  } else if (aliases.length) {
    recommendation = 'missing_exact_row_do_not_borrow_alias_resave_exact_in_admin';
    conflict = true;
  } else {
    recommendation = 'missing_exact_and_aliases_fail_closed';
  }

  return {
    ok: true,
    client_slug: clientSlug,
    offering_key: offeringKey,
    duration_key: durationKey,
    expected_item_code: expectedCode,
    billing_unit: billingUnit,
    location_id: locationId,
    exact,
    exact_non_positive: exactZero || null,
    aliases,
    conflict,
    recommendation,
    bundle_family: BUNDLE_FAMILY.slice(),
    mode: 'read_only_audit',
    production_authority: false,
    note: 'Operator audit only — production enforces via tenant_price_rules loaders',
  };
}

// Backward-compatible alias name used by early P0b verifier.
const auditStandaloneRentalPriceAuthority = auditStandaloneRentalPriceRows;

/** Documented production contract — not enforced by this audit module. */
const STANDALONE_RENTAL_SSOT_DOC = Object.freeze({
  table: 'tenant_price_rules',
  item_type: 'rental',
  item_code_pattern: '<offering_key>__<duration_key>',
  authorities: Object.freeze([
    'standalone_tenant_price_rules',
    'course_equipment_during_course',
    'course_equipment_all_day',
  ]),
  no_alias_after_concrete_selection: true,
  no_write_time_healing: true,
  enforced_by: Object.freeze([
    'loadTenantPriceRuleFromDb',
    'resolveGenericRentalPrice',
    'lookupSunsetRentalPrice',
    'lookupSunsetRentalPriceAsync',
  ]),
  this_module: 'read_only_operator_audit_only',
});

module.exports = {
  auditStandaloneRentalPriceRows,
  auditStandaloneRentalPriceAuthority,
  BUNDLE_FAMILY,
  STANDALONE_RENTAL_SSOT_DOC,
  /** @deprecated Prefer STANDALONE_RENTAL_SSOT_DOC — documentation only, not runtime authority. */
  STANDALONE_RENTAL_SSOT: STANDALONE_RENTAL_SSOT_DOC,
};

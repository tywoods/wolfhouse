'use strict';

/**
 * Phase 2: derive tenant_rental_offerings rows from a client's surf-school
 * config, with the mutual-exclusion rules that today are hardcoded in
 * scripts/staff-query-api.js (bundle vs its component board/wetsuit).
 *
 * Pure/offline — produces row objects; the DB seed + admin CRUD wiring consume
 * these later. For Sunset this reproduces the current 4-item catalog exactly
 * (parity), so seeding is a no-op change to guest/staff behaviour.
 *
 * Exclusion model: a bundle (an offering_key that combines board + wetsuit)
 * cannot be co-selected with its individual components, and vice-versa. Encoded
 * symmetrically in each row's `excludes` array.
 *
 * Refs: docs/SURF-SCHOOL-TEMPLATE-PLAN.md Phase 2.
 */

const { resolveSurfSchoolConfig } = require('./surf-school-config');

// Component offering_keys a bundle is composed of. Data-derived default keyed
// off the well-known Sunset bundle; extendable per-client later.
const BUNDLE_COMPONENTS = Object.freeze({
  board_and_suit_rental: Object.freeze(['board_rental', 'wetsuit_rental']),
});

function deriveExclusions(offeringKeys) {
  const present = new Set(offeringKeys);
  const excludes = {};
  for (const key of offeringKeys) excludes[key] = new Set();
  for (const [bundle, components] of Object.entries(BUNDLE_COMPONENTS)) {
    if (!present.has(bundle)) continue;
    for (const comp of components) {
      if (!present.has(comp)) continue;
      // Bundle and each present component mutually exclude.
      excludes[bundle].add(comp);
      excludes[comp].add(bundle);
    }
  }
  return excludes;
}

/**
 * @param {string} clientSlug
 * @returns {null | Array<{client_slug, offering_key, label, group_key, excludes:string[], sort_order}>}
 */
function buildRentalOfferingRows(clientSlug) {
  const cfg = resolveSurfSchoolConfig(clientSlug);
  if (!cfg) return null;
  const groups = cfg.catalog.rental_groups || [];
  const offeringKeys = groups.map((g) => g.offering_key).filter(Boolean);
  const excludes = deriveExclusions(offeringKeys);
  return groups.map((g, idx) => ({
    client_slug: cfg.client_slug,
    offering_key: g.offering_key,
    label: g.label,
    group_key: g.key,
    excludes: [...(excludes[g.offering_key] || [])].sort(),
    sort_order: idx,
  }));
}

module.exports = {
  BUNDLE_COMPONENTS,
  deriveExclusions,
  buildRentalOfferingRows,
};

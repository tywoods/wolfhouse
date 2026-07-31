'use strict';

/**
 * Phase 2: derive tenant_rental_offerings rows from a client's surf-school
 * config. Every seed row is an independent catalog item — no automatic
 * bundle/component mutual-exclusion is written for new catalog paths.
 *
 * Pure/offline — produces row objects; the DB seed + admin CRUD wiring consume
 * these later. For Sunset this still yields the 4 canonical offering keys with
 * their historical labels/group_keys, but `excludes` is always empty so
 * "Surfboard + Wetsuit" is ordinary stock-controlled equipment like any other.
 *
 * HISTORICAL-READ-ONLY: BUNDLE_COMPONENTS + deriveExclusions remain exported
 * only so legacy booking/read adapters can interpret older rows that still
 * carry excludes. New seed and Admin create/edit never call them.
 *
 * Refs: docs/SURF-SCHOOL-TEMPLATE-PLAN.md Phase 2; rental stock Slice A.
 */

const { resolveSurfSchoolConfig } = require('./surf-school-config');

/**
 * HISTORICAL-READ-ONLY map of former bundle → component offering_keys.
 * Not applied by buildRentalOfferingRows. Do not use for new catalog writes.
 */
const BUNDLE_COMPONENTS = Object.freeze({
  board_and_suit_rental: Object.freeze(['board_rental', 'wetsuit_rental']),
});

/**
 * HISTORICAL-READ-ONLY: recompute legacy mutual-exclusion sets from
 * BUNDLE_COMPONENTS. New catalog seed/create paths must not call this.
 */
function deriveExclusions(offeringKeys) {
  const present = new Set(offeringKeys);
  const excludes = {};
  for (const key of offeringKeys) excludes[key] = new Set();
  for (const [bundle, components] of Object.entries(BUNDLE_COMPONENTS)) {
    if (!present.has(bundle)) continue;
    for (const comp of components) {
      if (!present.has(comp)) continue;
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
  // Independent offerings: no auto-derived excludes for future Admin/seed paths.
  return groups.map((g, idx) => ({
    client_slug: cfg.client_slug,
    offering_key: g.offering_key,
    label: g.label,
    group_key: g.key,
    excludes: [],
    sort_order: idx,
  }));
}

module.exports = {
  BUNDLE_COMPONENTS,
  deriveExclusions,
  buildRentalOfferingRows,
};

'use strict';

/**
 * Surf-school archetype config resolver (Phase 0 of the surf-school template).
 *
 * Single source of truth for the per-client catalog *shape* that is today
 * hardcoded across the sunset-* files: beaches, age bands, group sizes, weekly
 * cadence, and the rental group -> offering map.
 *
 * ADDITIVE ONLY — this module introduces a read API. It does not yet replace
 * the in-code enums (PACK_BEACHES, RENTAL_GROUP_OFFERING, …). Phases 2/3 swap
 * the call sites over to this resolver. Until then behaviour is unchanged.
 *
 * Layering:
 *   archetype defaults (generic surf_school_shop)   <- this file
 *     |  merged with
 *   per-client baseline overrides (config/clients/<slug>.baseline.json:catalog.enums)
 *     |  with
 *   documented reference fallback for `sunset` (migration bridge, removed in Phase 3
 *   once the values live fully in sunset.baseline.json)
 *
 * Decisions: docs/SURF-SCHOOL-TEMPLATE-PLAN.md (locked 2026-07-28).
 */

const fs = require('fs');
const path = require('path');
const { loadBaselineJson, isSurfVertical } = require('./staff-portal-clients');

const CLIENTS_REGISTRY = path.join(__dirname, '..', '..', 'config', 'clients', 'clients.json');

const SURF_SCHOOL_BUSINESS_TYPE = 'surf_school_shop';

/** Locations come from the client registry (clients.json), the same source the
 * staff portal uses; baseline JSON does not carry a top-level locations array. */
function loadRegistryLocations(clientSlug) {
  try {
    const reg = JSON.parse(fs.readFileSync(CLIENTS_REGISTRY, 'utf8'));
    const entry = (reg.clients || []).find((c) => String(c.client_slug || '').trim() === clientSlug);
    return (entry && Array.isArray(entry.locations)) ? entry.locations : [];
  } catch (_) {
    return [];
  }
}

/** Verticals in existing baselines that map to the surf_school_shop archetype. */
const SURF_SCHOOL_VERTICALS = new Set([
  'surf_school_rentals',
  'surf_shop_rentals',
  'surf_school_lessons',
]);

/**
 * Generic archetype defaults. These are business-type-level (not location or
 * region specific) and match Sunset's current in-code values so migrating call
 * sites onto this resolver is a no-op for Sunset.
 */
const ARCHETYPE_DEFAULTS = Object.freeze({
  currency: 'EUR',
  age_bands: Object.freeze(['all_ages', '6_and_up', '6_to_11', '12_and_up']),
  group_sizes: Object.freeze([8, 12, 16, 20, 24]),
  weekly: Object.freeze(['daily', 'mon_fri', 'sat_sun']),
  offering_types: Object.freeze(['group_lesson', 'private_lesson', 'rental']),
  // Rental groups: the closed set is archetype-level today; Phase 2 moves this
  // into a client+location scoped tenant_rental_offerings table so schools can
  // add/delete items. Shape mirrors RENTAL_GROUP_OFFERING / RENTAL_GROUP_DISPLAY.
  rental_groups: Object.freeze([
    Object.freeze({ key: 'bundles', offering_key: 'board_and_suit_rental', label: 'Surfboard + Wetsuit' }),
    Object.freeze({ key: 'boards', offering_key: 'board_rental', label: 'Surfboard' }),
    Object.freeze({ key: 'wetsuits', offering_key: 'wetsuit_rental', label: 'Wetsuit' }),
    Object.freeze({ key: 'sup', offering_key: 'sup_rental', label: 'SUP' }),
  ]),
});

/**
 * Migration bridge: values that are region-specific and thus genuinely
 * per-client, kept here only until Phase 3 moves them into the baseline JSON.
 * Beaches are NOT an archetype default (a Moroccan school has different beaches),
 * so they must come from client config; this map preserves Sunset parity now.
 */
const CLIENT_REFERENCE_FALLBACK = Object.freeze({
  sunset: Object.freeze({
    beaches: Object.freeze(['el_sardinero', 'liencres', 'somo']),
  }),
});

function resolveBusinessType(clientSlug, cfg) {
  const vertical = (cfg && cfg._meta && cfg._meta.vertical)
    || (cfg && cfg.portal && cfg.portal.vertical)
    || '';
  if (SURF_SCHOOL_VERTICALS.has(String(vertical).trim())) return SURF_SCHOOL_BUSINESS_TYPE;
  if (isSurfVertical(vertical)) return SURF_SCHOOL_BUSINESS_TYPE;
  return null;
}

function normalizeList(value) {
  return Array.isArray(value) ? value.slice() : null;
}

/**
 * @param {string} clientSlug
 * @returns {null|{
 *   client_slug:string, business_type:string, currency:string,
 *   locations:Array<{id:string,display_name:string}>,
 *   catalog:{ beaches:string[], age_bands:string[], group_sizes:number[],
 *             weekly:string[], offering_types:string[],
 *             rental_groups:Array<{key:string,offering_key:string,label:string}> }
 * }}
 */
function resolveSurfSchoolConfig(clientSlug) {
  const slug = String(clientSlug || '').trim();
  if (!slug) return null;
  const cfg = loadBaselineJson(slug);
  const businessType = resolveBusinessType(slug, cfg);
  if (!businessType) return null;

  const enums = (cfg && cfg.catalog && cfg.catalog.enums) || {};
  const fallback = CLIENT_REFERENCE_FALLBACK[slug] || {};

  const locations = [];
  const rawLocations = (cfg && Array.isArray(cfg.locations)) ? cfg.locations : loadRegistryLocations(slug);
  for (const loc of rawLocations) {
    const id = String((loc && (loc.location_id || loc.id)) || '').trim();
    if (!id) continue;
    locations.push({ id, display_name: String((loc && loc.display_name) || id) });
  }

  const catalog = {
    beaches: normalizeList(enums.beaches) || normalizeList(fallback.beaches) || [],
    age_bands: normalizeList(enums.age_bands) || ARCHETYPE_DEFAULTS.age_bands.slice(),
    group_sizes: normalizeList(enums.group_sizes) || ARCHETYPE_DEFAULTS.group_sizes.slice(),
    weekly: normalizeList(enums.weekly) || ARCHETYPE_DEFAULTS.weekly.slice(),
    offering_types: normalizeList(enums.offering_types) || ARCHETYPE_DEFAULTS.offering_types.slice(),
    rental_groups: normalizeList(enums.rental_groups)
      || ARCHETYPE_DEFAULTS.rental_groups.map((g) => ({ ...g })),
  };

  return {
    client_slug: slug,
    business_type: businessType,
    currency: (cfg && cfg._meta && cfg._meta.currency) || ARCHETYPE_DEFAULTS.currency,
    locations,
    catalog,
  };
}

function isSurfSchoolClient(clientSlug) {
  return resolveSurfSchoolConfig(clientSlug) != null;
}

module.exports = {
  SURF_SCHOOL_BUSINESS_TYPE,
  SURF_SCHOOL_VERTICALS,
  ARCHETYPE_DEFAULTS,
  resolveSurfSchoolConfig,
  isSurfSchoolClient,
  resolveBusinessType,
};

'use strict';

/**
 * FACTORY Slice 1B — archetype schema + disabled-by-default static templates.
 *
 * Static templates only under config/archetypes/. No generator, no client
 * instance materialization, no runtime loading, no IaC/DB/deploy/live calls.
 *
 * Pricing shape for surf_house is derived from wolfhouse-quote-calculator
 * reads of wolfhouse-somo.pricing.json (add_ons, deposits.tiers,
 * room_supplements, numeric month_numbers + priority). rounding/hold are
 * recognized companion metadata (canonical file parity) — not calculator reads.
 *
 * Consumer-facing scalars must be exact runtime types or strict {{TOKEN}}
 * placeholders — never objects / notes-only maps.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const SLICE = 'FACTORY-1B';
const BRANCH = 'factory/slice-1b-archetype-templates';
const MASTER_BASIS = '86f4cb9daaefdecab75ad02a2e755e2e7503216d';
const OUTCOME_ID = '1B_archetype_schema_disabled_templates';

const ARCHETYPE_IDS = Object.freeze(['surf_house', 'surf_school_shop']);

const ARCHETYPE_ROOT = 'config/archetypes';

const ARCHETYPE_FILES = Object.freeze({
  surf_house: Object.freeze([
    'config/archetypes/surf_house/archetype.manifest.json',
    'config/archetypes/surf_house/baseline.template.json',
    'config/archetypes/surf_house/pricing.template.json',
    'config/archetypes/surf_house/secrets.example.template.json',
    'config/archetypes/surf_house/compatibility.json',
  ]),
  surf_school_shop: Object.freeze([
    'config/archetypes/surf_school_shop/archetype.manifest.json',
    'config/archetypes/surf_school_shop/baseline.template.json',
    'config/archetypes/surf_school_shop/secrets.example.template.json',
    'config/archetypes/surf_school_shop/compatibility.json',
  ]),
});

/** Exact blob SHAs of reference baselines that must remain byte-identical on master. */
const PRESERVED_REFERENCE_BLOBS = Object.freeze({
  'config/clients/wolfhouse-somo.baseline.json':
    '82b4856d88ed647a6e74cb1bafa44f4140e30606',
  'config/clients/sunset.baseline.json':
    '773deffaa3a2e0cdd3fec05c41ac3f8b47857b24',
  'config/clients/wolfhouse-somo.pricing.json':
    '985402b4c349d80e28c37c427e72c1905c6bbdda',
});

const PLACEHOLDER_RE = /^\{\{[A-Z0-9_]+\}\}$/;
/** Normalized slot times: HH:MM or HH:MM-HH:MM (24h). */
const SLOT_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(?:-([01]\d|2[0-3]):[0-5]\d)?$/;

/** Calculator-handled add-on pricing units (+ per_lesson on lesson codes). */
const SUPPORTED_PRICING_UNITS = Object.freeze([
  'per_day',
  'per_class',
  'per_meal',
  'per_lesson',
]);

/** Calculator-echoed payment_options values. */
const SUPPORTED_PAYMENT_OPTIONS = Object.freeze([
  'deposit',
  'full',
  'pay_on_arrival',
]);

/** Recognized rounding.method values (metadata; not calculator-consumed). */
const RECOGNIZED_ROUNDING_METHODS = Object.freeze([
  'ceil_to_nearest_5_eur',
]);

/** Calculator-required add_on keys (wolfhouse-quote-calculator.js). */
const REQUIRED_ADD_ON_KEYS = Object.freeze([
  'wetsuit_rental',
  'soft_top_rental',
  'hard_board_rental',
  'wetsuit_soft_top_combo',
  'wetsuit_hard_board_combo',
  'surf_lesson_single',
  'surf_lesson_multi',
  'yoga_class',
  'meal',
  'meals',
]);

/**
 * Compatibility field_mappings must declare consumption_class so FACTORY-only
 * generator fields are not mislabeled as legacy-consumed.
 */
const COMPAT_CONSUMPTION_CLASSES = Object.freeze([
  'legacy_consumed',
  'factory_generator_only',
  'mixed',
]);

/**
 * Required JSON pointer-like paths (dot notation) that must exist on each
 * baseline template. Derived from 1A physical-site consumers + baseline shape.
 */
const REQUIRED_BASELINE_PATHS = Object.freeze({
  surf_house: Object.freeze([
    '_meta.client_slug',
    '_meta.vertical',
    '_meta.timezone',
    '_meta.currency',
    'live_enabled',
    'deployment.enabled',
    'channels.whatsapp.enabled',
    'channels.email.enabled',
    'pricing_policy.currency',
    'pricing_policy.live_autonomous_charge_requires',
    'packages.known_packages',
    'packages.price_basis',
    'packages.base_nights',
    'packages.currency',
    'packages.inclusions',
    'packages.seasons',
    'packages.prices_per_person_base_nights_shared',
    'packages.closed_months',
    'service_addons.service_catalog',
    'service_addons.bundles',
    'service_addons.lesson_scheduling.enabled',
    'service_addons.lesson_scheduling.daily_slots',
    'service_addons.lesson_scheduling.bot_assigns_slot',
    'service_addons.lesson_scheduling.bot_collects_request_then_staff_schedule',
    'rooming.rooms',
    'rooming.rooming_auto_assign_allowed',
    'payment.payment_link_auto_allowed',
    'payment.deposit_rule.type',
    'payment.deposit_rule.default_eur',
    'payment.deposit_rule.tiers.standard_package.amount_eur',
    'payment.deposit_rule.tiers.custom_or_short_stay.amount_eur',
    'confirmation.confirmation_send_mode',
    'confirmation.confirmation_requires_payment_truth',
    'operations.check_in_time',
    'operations.check_out_time',
    'persona.assistant_name',
    'persona.brand_name',
    'secrets.example_file',
    'secrets.keys',
    'handoff.handoff_whatsapp_target.phone_ref',
    'features.portal_default_tab',
    'features.inventory_model',
  ]),
  surf_school_shop: Object.freeze([
    '_meta.client_slug',
    '_meta.vertical',
    '_meta.timezone',
    '_meta.currency',
    'live_enabled',
    'deployment.enabled',
    'deployment.whatsapp_phone_number_id',
    'channels.whatsapp.enabled',
    'channels.email.enabled',
    'pricing_policy.currency',
    'pricing_policy.live_autonomous_charge_requires',
    'catalog.rentals.inventory_model',
    'catalog.rentals.offerings',
    'catalog.rentals.windows',
    'catalog.lessons.inventory_model',
    'catalog.lessons.offerings',
    'catalog.lessons.scheduling.common_slot_times',
    'catalog.lessons.scheduling.bot_assigns_slot',
    'catalog.lessons.scheduling.bot_collects_request_then_staff_schedule',
    'catalog.lessons.scheduling.arrive_before_class_minutes',
    'catalog.accommodation.inventory_model',
    'catalog.accommodation.offerings',
    'service_addons.lesson_scheduling.enabled',
    'service_addons.lesson_scheduling.daily_slots',
    'payment.payment_link_auto_allowed',
    'payment.deposit_rule.type',
    'confirmation.confirmation_send_mode',
    'confirmation.confirmation_requires_payment_truth',
    'persona.assistant_name',
    'persona.brand_name',
    'secrets.example_file',
    'secrets.keys',
    'handoff.handoff_whatsapp_target.phone_ref',
    'locations',
    'features.portal_default_tab',
    'features.inventory_model',
  ]),
});

/** Quote-calculator-derived pricing paths (not invented addons/deposit). */
const REQUIRED_PRICING_PATHS = Object.freeze([
  '_meta.client_slug',
  'client_slug',
  'currency',
  'seasons',
  'packages',
  'room_supplements',
  'room_supplements.shared.per_person_per_night_cents',
  'room_supplements.double.per_room_per_night_cents',
  'room_supplements.private.per_room_per_night_cents',
  'rounding.method',
  'rounding.nearest_cents',
  'hold.expiry_minutes',
  'payment_options',
  'add_ons',
  'add_ons.surf_lesson_single.price_cents',
  'add_ons.surf_lesson_multi.price_cents_each',
  'deposits',
  'deposits.tiers.standard_package.amount_cents',
  'deposits.tiers.custom_or_short_stay.amount_cents',
]);

const INVENTED_PRICING_KEYS = Object.freeze(['addons', 'deposit']);

const REQUIRED_MANIFEST_PATHS = Object.freeze([
  'schema_version',
  'slice',
  'archetype_id',
  'label',
  'reference_client_slug',
  'reference_location_ids',
  'reference_baseline',
  'legacy_vertical',
  'live_enabled',
  'files',
  'compatibility_file',
]);

const REQUIRED_COMPATIBILITY_PATHS = Object.freeze([
  'archetype_id',
  'reference_client_slug',
  'reference_location_ids',
  'legacy_vertical',
  'portal_default_tab',
  'registry_shape',
  'field_mappings',
  'field_mappings.pricing',
  'field_mappings.services',
  'field_mappings.schedule',
  'field_mappings.profile',
  'field_mappings.features',
  'consumer_categories',
]);

const ARCHETYPE_LOCKS = Object.freeze({
  surf_house: Object.freeze({
    id: 'surf_house',
    label: 'Surf house',
    reference_client_slug: 'wolfhouse',
    reference_location_ids: Object.freeze(['wolfhouse-somo']),
    reference_baseline: 'config/clients/wolfhouse-somo.baseline.json',
    reference_pricing: 'config/clients/wolfhouse-somo.pricing.json',
    legacy_vertical: 'lodging_surf_house',
    portal_default_tab: 'bed-calendar',
    location_cardinality: 'single_primary',
    inventory_model: 'lodging_rooms_beds',
    required_companion_files: Object.freeze(['pricing.template.json']),
  }),
  surf_school_shop: Object.freeze({
    id: 'surf_school_shop',
    label: 'Surf school + shop',
    reference_client_slug: 'sunset',
    reference_location_ids: Object.freeze(['sunset-somo', 'sunset-sardinero']),
    reference_baseline: 'config/clients/sunset.baseline.json',
    reference_pricing: null,
    legacy_vertical: 'surf_school_rentals',
    portal_default_tab: 'portal-home',
    location_cardinality: 'multi_location',
    inventory_model: 'lessons_capacity_plus_rentals_unlimited',
    required_companion_files: Object.freeze([]),
  }),
});

const FORBIDDEN_PRODUCTIZATION_PATHS = Object.freeze([
  'scripts/lib/factory-client-generator.js',
  'scripts/generate-client-config.js',
  'config/clients/_archetype-surf_house.template.json',
  'config/clients/_archetype-surf_school_shop.template.json',
]);


const PACKAGE_JSON_ALLOWED_SCRIPT_KEY = 'verify:factory-slice1b-archetype-templates';
const PACKAGE_JSON_ALLOWED_SCRIPT_VALUE =
  'node scripts/verify-factory-slice1b-archetype-templates.js';

const EXISTING_REGRESSION_GATES = Object.freeze([
  'node scripts/verify-multiclient-isolation.js',
  'node scripts/verify-no-client-hardcoding.js',
  'node scripts/verify-tenant-resolution.js',
  'node scripts/verify-meta-whatsapp-tenant-shadow.js',
  'npm run verify:factory-slice1a-acceptance-contract',
]);

/** Live-target / secret-shaped patterns forbidden in committed archetype templates. */
const FORBIDDEN_CONTENT_PATTERNS = Object.freeze([
  Object.freeze({ id: 'stripe_live_secret', re: /sk_live_[A-Za-z0-9]+/ }),
  Object.freeze({ id: 'stripe_test_secret', re: /sk_test_[A-Za-z0-9]+/ }),
  Object.freeze({ id: 'stripe_live_pk', re: /pk_live_[A-Za-z0-9]+/ }),
  Object.freeze({ id: 'stripe_test_pk', re: /pk_test_[A-Za-z0-9]+/ }),
  Object.freeze({ id: 'stripe_webhook_secret', re: /whsec_[A-Za-z0-9]+/ }),
  Object.freeze({ id: 'azure_subscription', re: /\/subscriptions\/[0-9a-f-]{36}/i }),
  Object.freeze({ id: 'azure_resource_id', re: /\/resourceGroups\/[^"'\s]+/i }),
  Object.freeze({
    id: 'live_hostname',
    re: /(?:lunafrontdesk\.com|azurewebsites\.net|database\.azure\.com|blob\.core\.windows\.net)/i,
  }),
  Object.freeze({
    id: 'meta_phone_number_id_value',
    re: /phone_number_id["\s:=]+["']?\d{6,}/i,
  }),
  Object.freeze({ id: 'postgres_url', re: /postgres(?:ql)?:\/\//i }),
  Object.freeze({ id: 'mongodb_url', re: /mongodb(?:\+srv)?:\/\//i }),
  Object.freeze({ id: 'aws_access_key', re: /AKIA[0-9A-Z]{16}/ }),
  Object.freeze({
    id: 'copied_live_staff_host',
    re: /staff-(?:staging|prod)\.lunafrontdesk\.com/i,
  }),
  Object.freeze({
    id: 'copied_sunset_public_host',
    re: /escueladesurfsunset\.com/i,
  }),
  Object.freeze({
    id: 'copied_wolfhouse_public_host',
    re: /wolf-house\.com/i,
  }),
]);

const ENABLEMENT_FALSE_PATHS = Object.freeze({
  surf_house: Object.freeze([
    'live_enabled',
    'deployment.enabled',
    'channels.whatsapp.enabled',
    'channels.email.enabled',
    'payment.payment_link_auto_allowed',
    'service_addons.lesson_scheduling.enabled',
  ]),
  surf_school_shop: Object.freeze([
    'live_enabled',
    'deployment.enabled',
    'channels.whatsapp.enabled',
    'channels.email.enabled',
    'payment.payment_link_auto_allowed',
    'service_addons.lesson_scheduling.enabled',
  ]),
});

const SEND_MODE_ALLOWED = Object.freeze(['dry_run', 'staff_approval']);

function thaw(value) {
  if (Array.isArray(value)) return value.map(thaw);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = thaw(value[key]);
    return out;
  }
  return value;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a == null || b == null) return a === b;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === 'object') {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (!deepEqual(ak, bk)) return false;
    for (const k of ak) {
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

function getPath(obj, dotted) {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object' || !(p in cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

function hasPath(obj, dotted) {
  return getPath(obj, dotted) !== undefined;
}

function isPlaceholderString(value) {
  return typeof value === 'string' && PLACEHOLDER_RE.test(value);
}

/**
 * Consumer-facing scalar: exact runtime type OR strict {{TOKEN}} placeholder.
 * Objects / notes-only maps are never valid.
 */
function isNumberOrTypedPlaceholder(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return true;
  return isPlaceholderString(value);
}

function isIntegerMonthOrTypedPlaceholder(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 12) {
    return true;
  }
  return isPlaceholderString(value);
}

function isNormalizedSlotTimeOrTypedPlaceholder(value) {
  if (isPlaceholderString(value)) return true;
  return typeof value === 'string' && SLOT_TIME_RE.test(value);
}

function isObjectOrNotesOnlyMap(value) {
  return value !== null && typeof value === 'object';
}

function requireNumberOrTypedPlaceholder(value, errorCode, errors) {
  if (isObjectOrNotesOnlyMap(value) || !isNumberOrTypedPlaceholder(value)) {
    errors.push(errorCode);
    return false;
  }
  return true;
}

function pathBasename(p) {
  const parts = String(p).split('/');
  return parts[parts.length - 1];
}

function walkStrings(value, visit, trail) {
  const pathParts = trail || [];
  if (typeof value === 'string') {
    visit(value, pathParts.join('.'));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkStrings(v, visit, pathParts.concat(String(i))));
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      walkStrings(value[key], visit, pathParts.concat(key));
    }
  }
}

function collectPlaceholders(value, into) {
  const set = into || new Set();
  walkStrings(value, (s) => {
    if (isPlaceholderString(s)) set.add(s);
  });
  return set;
}

function scanForbiddenContent(text) {
  const hits = [];
  for (const row of FORBIDDEN_CONTENT_PATTERNS) {
    if (row.re.test(text)) hits.push(row.id);
  }
  return hits;
}

function validateEnablementOff(baseline, archetypeId) {
  const errors = [];
  const paths = ENABLEMENT_FALSE_PATHS[archetypeId] || [];
  for (const p of paths) {
    if (getPath(baseline, p) !== false) errors.push(`enablement_not_false:${p}`);
  }
  const sendMode = getPath(baseline, 'confirmation.confirmation_send_mode');
  if (!SEND_MODE_ALLOWED.includes(sendMode)) {
    errors.push(`confirmation_send_mode_not_gated:${sendMode}`);
  }
  if (hasPath(baseline, 'deployment.whatsapp_phone_number_id')) {
    const phoneId = getPath(baseline, 'deployment.whatsapp_phone_number_id');
    if (phoneId !== null) errors.push('whatsapp_phone_number_id_must_be_null');
  }
  return errors;
}

function validateRequiredPaths(obj, requiredPaths, label) {
  const missing = [];
  for (const p of requiredPaths) {
    if (!hasPath(obj, p)) missing.push(`${label}:${p}`);
  }
  return missing;
}

function validateManifest(manifest, archetypeId) {
  const errors = [];
  errors.push(...validateRequiredPaths(manifest, REQUIRED_MANIFEST_PATHS, 'manifest'));
  if (manifest.archetype_id !== archetypeId) errors.push('manifest_archetype_id_mismatch');
  if (manifest.slice !== SLICE) errors.push('manifest_slice_mismatch');
  if (manifest.live_enabled !== false) errors.push('manifest_live_enabled_not_false');
  const lock = ARCHETYPE_LOCKS[archetypeId];
  if (!lock) {
    errors.push('unknown_archetype');
    return errors;
  }
  if (manifest.reference_client_slug !== lock.reference_client_slug) {
    errors.push('manifest_reference_client_mismatch');
  }
  if (!deepEqual(manifest.reference_location_ids, thaw(lock.reference_location_ids))) {
    errors.push('manifest_reference_locations_mismatch');
  }
  if (manifest.legacy_vertical !== lock.legacy_vertical) {
    errors.push('manifest_legacy_vertical_mismatch');
  }
  if (manifest.reference_baseline !== lock.reference_baseline) {
    errors.push('manifest_reference_baseline_mismatch');
  }
  return errors;
}

function validateCompatibility(compat, archetypeId) {
  const errors = [];
  errors.push(...validateRequiredPaths(compat, REQUIRED_COMPATIBILITY_PATHS, 'compatibility'));
  const lock = ARCHETYPE_LOCKS[archetypeId];
  if (!lock) return errors.concat(['unknown_archetype']);
  if (compat.archetype_id !== archetypeId) errors.push('compat_archetype_id_mismatch');
  if (compat.reference_client_slug !== lock.reference_client_slug) {
    errors.push('compat_reference_client_mismatch');
  }
  if (!deepEqual(compat.reference_location_ids, thaw(lock.reference_location_ids))) {
    errors.push('compat_reference_locations_mismatch');
  }
  if (compat.legacy_vertical !== lock.legacy_vertical) {
    errors.push('compat_legacy_vertical_mismatch');
  }
  if (compat.portal_default_tab !== lock.portal_default_tab) {
    errors.push('compat_portal_default_tab_mismatch');
  }
  const features = getPath(compat, 'field_mappings.features') || {};
  if (features.portal_default_tab !== lock.portal_default_tab) {
    errors.push('compat_features_portal_default_tab_mismatch');
  }
  if (features.inventory_model !== lock.inventory_model) {
    errors.push('compat_features_inventory_model_mismatch');
  }
  // features.* are FACTORY generator guidance — portal derives tabs from vertical.
  if (features.consumption_class !== 'factory_generator_only') {
    errors.push('compat_features_must_be_factory_generator_only');
  }
  if (Array.isArray(features.legacy_consumers) && features.legacy_consumers.length > 0) {
    errors.push('compat_features_false_legacy_consumers');
  }

  const mappingKeys = ['pricing', 'services', 'schedule', 'profile', 'features'];
  if (archetypeId === 'surf_school_shop') mappingKeys.push('locations');
  if (archetypeId === 'surf_house') mappingKeys.push('inventory');
  for (const key of mappingKeys) {
    const mapping = getPath(compat, `field_mappings.${key}`);
    if (!mapping || typeof mapping !== 'object') {
      errors.push(`compat_mapping_missing:${key}`);
      continue;
    }
    if (!COMPAT_CONSUMPTION_CLASSES.includes(mapping.consumption_class)) {
      errors.push(`compat_consumption_class_missing:${key}`);
    }
  }

  const pricingMap = getPath(compat, 'field_mappings.pricing') || {};
  if (Array.isArray(pricingMap.calculator_consumed_fields)
    && (pricingMap.calculator_consumed_fields.includes('rounding')
      || pricingMap.calculator_consumed_fields.includes('hold'))) {
    errors.push('compat_false_claim_calculator_reads_rounding_or_hold');
  }
  if (archetypeId === 'surf_house') {
    const metaNotCalc = pricingMap.companion_metadata_not_calculator_consumed;
    if (!Array.isArray(metaNotCalc)
      || !metaNotCalc.includes('rounding')
      || !metaNotCalc.includes('hold')) {
      errors.push('compat_rounding_hold_must_be_marked_non_calculator');
    }
  }

  if (archetypeId === 'surf_school_shop') {
    const locs = getPath(compat, 'field_mappings.locations') || {};
    if (locs.consumption_class !== 'factory_generator_only') {
      errors.push('compat_locations_must_be_factory_generator_only');
    }
    if (Array.isArray(locs.legacy_consumers) && locs.legacy_consumers.length > 0) {
      errors.push('compat_locations_false_legacy_consumers');
    }
  }

  const schedule = getPath(compat, 'field_mappings.schedule');
  if (!schedule || typeof schedule !== 'object' || !schedule.baseline_path) {
    errors.push('compat_schedule_mapping_missing');
  }
  const profile = getPath(compat, 'field_mappings.profile');
  if (!profile || typeof profile !== 'object' || !profile.baseline_path) {
    errors.push('compat_profile_mapping_missing');
  }
  const reg = compat.registry_shape || {};
  if (reg.live_enabled !== false) errors.push('compat_registry_live_enabled_not_false');
  if (lock.location_cardinality === 'single_primary') {
    if (!Array.isArray(reg.location_id_placeholders) || reg.location_id_placeholders.length !== 1) {
      errors.push('compat_single_location_cardinality');
    }
  }
  if (lock.location_cardinality === 'multi_location') {
    if (!Array.isArray(reg.location_id_placeholders) || reg.location_id_placeholders.length < 2) {
      errors.push('compat_multi_location_cardinality');
    }
  }
  return errors;
}

function validateSurfHouseBaselineDeep(baseline) {
  const errors = [];
  const known = getPath(baseline, 'packages.known_packages');
  if (!Array.isArray(known) || known.length < 1) errors.push('surf_house_packages_missing');
  const seasons = getPath(baseline, 'packages.seasons');
  const prices = getPath(baseline, 'packages.prices_per_person_base_nights_shared');
  const inclusions = getPath(baseline, 'packages.inclusions');
  if (!seasons || typeof seasons !== 'object') errors.push('surf_house_seasons_missing');
  if (!prices || typeof prices !== 'object') errors.push('surf_house_seasonal_prices_matrix_missing');
  if (seasons && prices) {
    for (const season of Object.keys(seasons)) {
      if (!prices[season] || typeof prices[season] !== 'object') {
        errors.push(`surf_house_prices_missing_season:${season}`);
      } else if (Array.isArray(known)) {
        for (const pkg of known) {
          if (!(pkg in prices[season])) {
            errors.push(`surf_house_prices_missing_package:${season}.${pkg}`);
          }
        }
      }
    }
  }
  if (Array.isArray(known) && inclusions && typeof inclusions === 'object') {
    for (const pkg of known) {
      if (!Array.isArray(inclusions[pkg])) errors.push(`surf_house_inclusions_missing:${pkg}`);
    }
  }
  const slots = getPath(baseline, 'service_addons.lesson_scheduling.daily_slots');
  if (!Array.isArray(slots) || slots.length < 1) {
    errors.push('surf_house_schedule_daily_slots_missing');
  } else {
    for (const slot of slots) {
      if (!slot || typeof slot !== 'object') {
        errors.push('surf_house_schedule_slot_invalid');
        break;
      }
      if (!('group' in slot) || !('transport_time' in slot) || !('lesson_window' in slot)) {
        errors.push('surf_house_schedule_slot_fields_missing');
        break;
      }
    }
  }
  const rooms = getPath(baseline, 'rooming.rooms');
  if (!rooms || typeof rooms !== 'object' || Array.isArray(rooms) || Object.keys(rooms).length < 1) {
    errors.push('surf_house_rooms_missing');
  } else {
    for (const [roomId, room] of Object.entries(rooms)) {
      if (!isPlaceholderString(roomId)) errors.push(`surf_house_room_id_not_placeholder:${roomId}`);
      if (!room || !('capacity' in room) || !('type' in room)) {
        errors.push(`surf_house_room_fields_missing:${roomId}`);
      }
    }
  }
  return errors;
}

function validateSurfSchoolShopBaselineDeep(baseline) {
  const errors = [];
  const locs = getPath(baseline, 'locations');
  if (!Array.isArray(locs) || locs.length < 2) errors.push('surf_school_shop_locations_lt_2');
  const seen = new Set();
  for (const loc of locs || []) {
    if (!loc || !isPlaceholderString(loc.location_id)) {
      errors.push('surf_school_shop_location_id_not_placeholder');
      break;
    }
    if (loc.location_id === 'sunset-somo' || loc.location_id === 'sunset-sardinero') {
      errors.push('surf_school_shop_location_copied_live_target');
      break;
    }
    if (seen.has(loc.location_id)) {
      errors.push('surf_school_shop_location_id_duplicate');
      break;
    }
    seen.add(loc.location_id);
    if (!loc.display_name) errors.push('surf_school_shop_location_display_name_missing');
  }
  const windows = getPath(baseline, 'catalog.rentals.windows');
  const rentals = getPath(baseline, 'catalog.rentals.offerings');
  if (!Array.isArray(windows) || windows.length < 1) errors.push('rentals_windows_missing');
  if (!rentals || typeof rentals !== 'object') {
    errors.push('rentals_offerings_missing');
  } else {
    for (const [code, off] of Object.entries(rentals)) {
      if (!off || typeof off !== 'object') {
        errors.push(`rental_offering_invalid:${code}`);
        continue;
      }
      if (!off.label) errors.push(`rental_label_missing:${code}`);
      if (!off.prices_eur || typeof off.prices_eur !== 'object'
        || Object.keys(off.prices_eur).length < 1) {
        errors.push(`rental_prices_eur_missing:${code}`);
      } else {
        // Reserved keys (_*) are metadata only. Require ≥1 non-reserved key with a
        // usable scalar; reserved-only maps fail before any per-window checks.
        const nonReserved = Object.entries(off.prices_eur)
          .filter(([unitKey]) => !unitKey.startsWith('_'));
        if (nonReserved.length === 0) {
          errors.push(`rental_prices_eur_reserved_only:${code}`);
          continue;
        }
        if (Array.isArray(windows)) {
          for (const w of windows) {
            if (!(w in off.prices_eur)) {
              errors.push(`rental_prices_eur_window_missing:${code}.${w}`);
            }
          }
        }
        let hasUsableScalar = false;
        for (const [unitKey, amount] of nonReserved) {
          if (isObjectOrNotesOnlyMap(amount) || !isNumberOrTypedPlaceholder(amount)) {
            errors.push(`rental_prices_eur_not_usable_scalar:${code}.${unitKey}`);
          } else {
            hasUsableScalar = true;
          }
        }
        if (!hasUsableScalar) {
          errors.push(`rental_prices_eur_no_usable_non_reserved:${code}`);
        }
      }
    }
  }
  const lessons = getPath(baseline, 'catalog.lessons.offerings');
  if (!lessons || typeof lessons !== 'object') {
    errors.push('lessons_offerings_missing');
  } else {
    for (const [code, off] of Object.entries(lessons)) {
      if (!off || typeof off !== 'object') {
        errors.push(`lesson_offering_invalid:${code}`);
        continue;
      }
      if (!off.prices_eur || typeof off.prices_eur !== 'object'
        || Object.keys(off.prices_eur).length < 1) {
        errors.push(`lesson_prices_eur_missing:${code}`);
      } else {
        // Reserved keys (_*) are metadata only. Require ≥1 non-reserved key with a
        // usable scalar; reserved-only maps fail with a deterministic error.
        const nonReserved = Object.entries(off.prices_eur)
          .filter(([unitKey]) => !unitKey.startsWith('_'));
        if (nonReserved.length === 0) {
          errors.push(`lesson_prices_eur_reserved_only:${code}`);
          continue;
        }
        let hasUsableScalar = false;
        for (const [unitKey, amount] of nonReserved) {
          if (isObjectOrNotesOnlyMap(amount) || !isNumberOrTypedPlaceholder(amount)) {
            errors.push(`lesson_prices_eur_not_usable_scalar:${code}.${unitKey}`);
          } else {
            hasUsableScalar = true;
          }
        }
        if (!hasUsableScalar) {
          errors.push(`lesson_prices_eur_no_usable_non_reserved:${code}`);
        }
      }
    }
  }
  const slots = getPath(baseline, 'catalog.lessons.scheduling.common_slot_times');
  if (!Array.isArray(slots) || slots.length < 1) {
    errors.push('lessons_scheduling_common_slot_times_missing');
  } else {
    for (let i = 0; i < slots.length; i += 1) {
      const slot = slots[i];
      if (isObjectOrNotesOnlyMap(slot) || !isNormalizedSlotTimeOrTypedPlaceholder(slot)) {
        errors.push(`lessons_scheduling_slot_time_not_normalized_scalar:${i}`);
      }
    }
  }
  const arriveBefore = getPath(baseline, 'catalog.lessons.scheduling.arrive_before_class_minutes');
  if (isObjectOrNotesOnlyMap(arriveBefore) || !isNumberOrTypedPlaceholder(arriveBefore)) {
    errors.push('lessons_scheduling_arrive_before_not_numeric_scalar');
  }
  if (getPath(baseline, 'catalog.lessons.scheduling.bot_assigns_slot') === undefined) {
    errors.push('lessons_scheduling_bot_assigns_slot_missing');
  }
  if (getPath(baseline, 'features.portal_default_tab') === undefined) {
    errors.push('features_portal_default_tab_missing');
  }
  if (getPath(baseline, 'features.inventory_model') === undefined) {
    errors.push('features_inventory_model_missing');
  }
  if (!getPath(baseline, 'persona.assistant_name') || !getPath(baseline, 'persona.brand_name')) {
    errors.push('profile_persona_fields_missing');
  }
  return errors;
}

function validateBaselineTemplate(baseline, archetypeId) {
  const errors = [];
  const required = REQUIRED_BASELINE_PATHS[archetypeId] || [];
  errors.push(...validateRequiredPaths(baseline, required, 'baseline'));
  errors.push(...validateEnablementOff(baseline, archetypeId));

  const lock = ARCHETYPE_LOCKS[archetypeId];
  if (getPath(baseline, '_meta.vertical') !== lock.legacy_vertical) {
    errors.push('baseline_vertical_mismatch');
  }
  if (getPath(baseline, 'features.portal_default_tab') !== lock.portal_default_tab) {
    errors.push('baseline_portal_default_tab_mismatch');
  }
  if (getPath(baseline, 'features.inventory_model') !== lock.inventory_model) {
    errors.push('baseline_inventory_model_mismatch');
  }
  if (baseline.live_enabled !== false) errors.push('baseline_live_enabled_not_false');

  const slug = getPath(baseline, '_meta.client_slug');
  if (!isPlaceholderString(slug)) errors.push('baseline_client_slug_not_placeholder');
  if (slug === 'wolfhouse' || slug === 'sunset' || slug === 'wolfhouse-somo') {
    errors.push('baseline_client_slug_copied_live_target');
  }

  if (archetypeId === 'surf_house') {
    errors.push(...validateSurfHouseBaselineDeep(baseline));
  }
  if (archetypeId === 'surf_school_shop') {
    errors.push(...validateSurfSchoolShopBaselineDeep(baseline));
  }

  const phoneRef = getPath(baseline, 'handoff.handoff_whatsapp_target.phone_ref');
  if (typeof phoneRef !== 'string' || !phoneRef.startsWith('secret:')) {
    errors.push('handoff_phone_ref_must_be_secret_ref');
  }

  return errors;
}

function validateMonthNumbers(season, index) {
  const errors = [];
  const months = season && season.month_numbers;
  if (!Array.isArray(months) || months.length < 1) {
    errors.push(`pricing_month_numbers_missing:${index}`);
    return errors;
  }
  const seenInSeason = new Set();
  for (let i = 0; i < months.length; i += 1) {
    const m = months[i];
    if (!isIntegerMonthOrTypedPlaceholder(m)) {
      errors.push(`pricing_month_numbers_not_numeric:${index}.${i}`);
      continue;
    }
    if (typeof m === 'number') {
      if (seenInSeason.has(m)) {
        errors.push(`pricing_month_numbers_duplicate_in_season:${index}.${m}`);
      }
      seenInSeason.add(m);
    }
  }
  return errors;
}

/**
 * Deterministic season coverage: no month overlap across seasons, OR every
 * overlapping season group has unique numeric priorities (consumed by findSeason).
 */
function validateSeasonOverlapOrUniquePriority(seasons) {
  const errors = [];
  if (!Array.isArray(seasons)) return errors;
  const monthOwners = new Map();
  for (let i = 0; i < seasons.length; i += 1) {
    const season = seasons[i];
    if (!season || typeof season !== 'object') continue;
    const months = Array.isArray(season.month_numbers) ? season.month_numbers : [];
    const priority = Object.prototype.hasOwnProperty.call(season, 'priority')
      ? season.priority
      : 0;
    if (Object.prototype.hasOwnProperty.call(season, 'priority')
      && !isNumberOrTypedPlaceholder(priority)) {
      errors.push(`pricing_season_priority_not_numeric:${i}`);
    }
    for (const m of months) {
      if (typeof m !== 'number') continue;
      if (!monthOwners.has(m)) monthOwners.set(m, []);
      monthOwners.get(m).push({
        index: i,
        code: season.code || String(i),
        priority,
      });
    }
  }
  for (const [month, owners] of monthOwners.entries()) {
    if (owners.length < 2) continue;
    const priorities = owners.map((o) => o.priority);
    const allNumeric = priorities.every((p) => typeof p === 'number' && Number.isFinite(p));
    const unique = allNumeric && new Set(priorities).size === priorities.length;
    if (!unique) {
      errors.push(`pricing_season_month_overlap_without_unique_priority:${month}`);
    }
  }
  return errors;
}

function validatePricingTemplate(pricing) {
  const errors = [];
  if (!pricing || typeof pricing !== 'object') {
    errors.push('pricing_missing');
    return errors;
  }
  errors.push(...validateRequiredPaths(pricing, REQUIRED_PRICING_PATHS, 'pricing'));

  for (const invented of INVENTED_PRICING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(pricing, invented)) {
      errors.push(`pricing_invented_key:${invented}`);
    }
  }

  const slug = getPath(pricing, 'client_slug');
  const metaSlug = getPath(pricing, '_meta.client_slug');
  if (!isPlaceholderString(slug)) errors.push('pricing_client_slug_not_placeholder');
  if (!isPlaceholderString(metaSlug)) errors.push('pricing_meta_client_slug_not_placeholder');
  if (slug !== metaSlug) errors.push('pricing_client_slug_cross_mismatch');

  if (!Array.isArray(pricing.packages) || pricing.packages.length < 1) {
    errors.push('pricing_packages_empty');
  }
  if (!Array.isArray(pricing.seasons) || pricing.seasons.length < 1) {
    errors.push('pricing_seasons_empty');
  }

  const bookableSeasonCodes = [];
  for (let i = 0; i < (pricing.seasons || []).length; i += 1) {
    const season = pricing.seasons[i];
    if (!season || typeof season !== 'object' || !season.code) {
      errors.push(`pricing_season_invalid:${i}`);
      continue;
    }
    errors.push(...validateMonthNumbers(season, i));
    if (season.bookable !== false) bookableSeasonCodes.push(season.code);
  }
  errors.push(...validateSeasonOverlapOrUniquePriority(pricing.seasons || []));

  for (let i = 0; i < (pricing.packages || []).length; i += 1) {
    const pkg = pricing.packages[i];
    if (!pkg || typeof pkg !== 'object') {
      errors.push(`pricing_package_invalid:${i}`);
      continue;
    }
    if (!pkg.code) errors.push(`pricing_package_code_missing:${i}`);
    if (!pkg.seasonal_prices || typeof pkg.seasonal_prices !== 'object') {
      errors.push(`pricing_seasonal_prices_missing:${pkg.code || i}`);
      continue;
    }
    for (const code of bookableSeasonCodes) {
      const row = pkg.seasonal_prices[code];
      if (!row || typeof row !== 'object' || !('weekly_per_person_cents' in row)) {
        errors.push(`pricing_seasonal_prices_missing_season:${pkg.code || i}.${code}`);
        continue;
      }
      const cents = row.weekly_per_person_cents;
      if (isObjectOrNotesOnlyMap(cents) || !isNumberOrTypedPlaceholder(cents)) {
        errors.push(`pricing_seasonal_prices_not_numeric_scalar:${pkg.code || i}.${code}`);
      }
    }
  }

  const supplements = pricing.room_supplements;
  if (supplements && typeof supplements === 'object') {
    for (const roomType of ['shared', 'double', 'private']) {
      const row = supplements[roomType];
      if (!row || typeof row !== 'object') continue;
      for (const key of Object.keys(row)) {
        if (key.startsWith('_') || key === 'pricing_status') continue;
        if (!/cents$/.test(key)) continue;
        if (isObjectOrNotesOnlyMap(row[key]) || !isNumberOrTypedPlaceholder(row[key])) {
          errors.push(`pricing_room_supplement_not_numeric_scalar:${roomType}.${key}`);
        }
      }
    }
  }

  const addOns = pricing.add_ons;
  if (!addOns || typeof addOns !== 'object' || Array.isArray(addOns)) {
    errors.push('pricing_add_ons_missing');
  } else {
    for (const key of REQUIRED_ADD_ON_KEYS) {
      if (!addOns[key] || typeof addOns[key] !== 'object') {
        errors.push(`pricing_add_on_missing:${key}`);
        continue;
      }
      const unit = addOns[key].pricing_unit;
      if (!SUPPORTED_PRICING_UNITS.includes(unit)) {
        errors.push(`pricing_add_on_unsupported_pricing_unit:${key}:${unit}`);
      }
      if (key === 'surf_lesson_multi') {
        if (!('price_cents_each' in addOns[key])) {
          errors.push('pricing_surf_lesson_multi_price_cents_each_missing');
        } else {
          requireNumberOrTypedPlaceholder(
            addOns[key].price_cents_each,
            'pricing_surf_lesson_multi_price_cents_each_not_numeric_scalar',
            errors,
          );
        }
        if (addOns[key].pricing_model === 'tiered_by_quantity' || Array.isArray(addOns[key].tiers)) {
          errors.push('pricing_invented_lesson_tiers');
        }
      } else if (!('price_cents' in addOns[key])) {
        errors.push(`pricing_add_on_price_cents_missing:${key}`);
      } else {
        requireNumberOrTypedPlaceholder(
          addOns[key].price_cents,
          `pricing_add_on_price_cents_not_numeric_scalar:${key}`,
          errors,
        );
      }
    }
  }

  if (!Array.isArray(pricing.payment_options) || pricing.payment_options.length < 1) {
    errors.push('pricing_payment_options_missing');
  } else {
    for (const opt of pricing.payment_options) {
      if (!SUPPORTED_PAYMENT_OPTIONS.includes(opt)) {
        errors.push(`pricing_payment_option_unsupported:${opt}`);
      }
    }
  }

  const roundingMethod = getPath(pricing, 'rounding.method');
  if (!RECOGNIZED_ROUNDING_METHODS.includes(roundingMethod)) {
    errors.push(`pricing_rounding_method_unrecognized:${roundingMethod}`);
  }
  const nearest = getPath(pricing, 'rounding.nearest_cents');
  if (typeof nearest !== 'number' || !Number.isFinite(nearest)) {
    errors.push('pricing_rounding_nearest_cents_not_number');
  }

  const holdExpiry = getPath(pricing, 'hold.expiry_minutes');
  if (isObjectOrNotesOnlyMap(holdExpiry) || !isNumberOrTypedPlaceholder(holdExpiry)) {
    errors.push('pricing_hold_expiry_minutes_not_numeric_scalar');
  }

  for (const tier of ['standard_package', 'custom_or_short_stay']) {
    const amount = getPath(pricing, `deposits.tiers.${tier}.amount_cents`);
    requireNumberOrTypedPlaceholder(
      amount,
      `pricing_deposit_amount_not_numeric_scalar:${tier}`,
      errors,
    );
  }
  if (Object.prototype.hasOwnProperty.call(pricing.deposits || {}, 'default_cents')) {
    requireNumberOrTypedPlaceholder(
      pricing.deposits.default_cents,
      'pricing_deposit_default_not_numeric_scalar',
      errors,
    );
  }

  // Must not claim calculator consumes rounding/hold.
  const metaNotes = getPath(pricing, '_meta.notes');
  const purpose = String(getPath(pricing, '_meta.purpose') || '');
  const metaBlob = [
    purpose,
    ...(Array.isArray(metaNotes) ? metaNotes : []),
  ].join('\n');
  if (claimsCalculatorConsumesRoundingOrHold(metaBlob)) {
    errors.push('pricing_meta_false_claim_calculator_uses_rounding_or_hold');
  }

  return errors;
}

function claimsCalculatorConsumesRoundingOrHold(text) {
  const s = String(text || '');
  // Explicit denial / companion-metadata framing is truthful.
  if (/not (?:read by|calculator-consumed)|companion metadata[^\n]*not[^\n]*calculator/i.test(s)
    || /rounding\/hold are recognized companion metadata/i.test(s)
    || /rounding and hold are recognized companion metadata/i.test(s)) {
    return false;
  }
  // Old false claim patterns: listing rounding/hold among calculator-accessed fields.
  if (/calculator-accessed fields:[^\n]*\b(?:rounding|hold)\b/i.test(s)) return true;
  if (/calculator reads[^\n]*\b(?:rounding|hold)\b/i.test(s)) return true;
  if (/derived from[^\n]*calculator[^\n]*\b(?:rounding|hold)\b/i.test(s)) return true;
  return false;
}

function validatePlaceholderAlignment(bundle) {
  const errors = [];
  const { baseline, pricing, compatibility, archetypeId } = bundle;
  const lock = ARCHETYPE_LOCKS[archetypeId];
  const baselineSlug = getPath(baseline, '_meta.client_slug');
  const compatSlug = getPath(compatibility, 'registry_shape.client_slug_placeholder');
  if (baselineSlug !== compatSlug) {
    errors.push('placeholder_drift:CLIENT_SLUG');
  }
  if (getPath(baseline, 'features.portal_default_tab')
    !== getPath(compatibility, 'field_mappings.features.portal_default_tab')) {
    errors.push('placeholder_drift:features.portal_default_tab');
  }
  if (getPath(baseline, 'features.inventory_model')
    !== getPath(compatibility, 'field_mappings.features.inventory_model')) {
    errors.push('placeholder_drift:features.inventory_model');
  }
  if (getPath(compatibility, 'field_mappings.features.portal_default_tab') !== lock.portal_default_tab) {
    errors.push('coordinated_lock_compat_drift:portal_default_tab');
  }
  if (getPath(compatibility, 'field_mappings.features.inventory_model') !== lock.inventory_model) {
    errors.push('coordinated_lock_compat_drift:inventory_model');
  }
  if (!deepEqual(
    getPath(compatibility, 'reference_location_ids'),
    thaw(lock.reference_location_ids),
  )) {
    errors.push('coordinated_lock_compat_drift:reference_location_ids');
  }

  if (archetypeId === 'surf_house' && pricing) {
    if (getPath(pricing, 'client_slug') !== baselineSlug) {
      errors.push('placeholder_drift:pricing.client_slug');
    }
    const known = getPath(baseline, 'packages.known_packages') || [];
    const pricingCodes = (pricing.packages || []).map((p) => p && p.code);
    if (!deepEqual([...known].sort(), [...pricingCodes].sort())) {
      errors.push('placeholder_drift:PACKAGE_CODES');
    }
    const baselineSeasons = Object.keys(getPath(baseline, 'packages.seasons') || {}).sort();
    const pricingSeasons = (pricing.seasons || [])
      .filter((s) => s && s.bookable !== false)
      .map((s) => s.code)
      .sort();
    if (!deepEqual(baselineSeasons, pricingSeasons)) {
      errors.push('placeholder_drift:SEASON_CODES');
    }
  }

  if (archetypeId === 'surf_school_shop') {
    const locs = (getPath(baseline, 'locations') || []).map((l) => l && l.location_id);
    const compatLocs = getPath(compatibility, 'registry_shape.location_id_placeholders') || [];
    if (!deepEqual([...locs].sort(), [...compatLocs].sort())) {
      errors.push('placeholder_drift:LOCATION_IDS');
    }
  }

  return errors;
}

function validateCrossFileReferences(bundle) {
  const errors = [];
  const { manifest, baseline, pricing, secretsExample, compatibility, archetypeId } = bundle;
  const expectedFiles = thaw(ARCHETYPE_FILES[archetypeId]);
  for (const f of expectedFiles) {
    const base = pathBasename(f);
    if (!(manifest.files || []).includes(base) && !(manifest.files || []).includes(f)) {
      errors.push(`manifest_missing_file:${base}`);
    }
  }
  if (manifest.compatibility_file !== 'compatibility.json'
    && manifest.compatibility_file !== `${ARCHETYPE_ROOT}/${archetypeId}/compatibility.json`) {
    errors.push('manifest_compatibility_file_mismatch');
  }
  if (compatibility.archetype_id !== manifest.archetype_id) {
    errors.push('cross_manifest_compat_archetype');
  }
  if (getPath(baseline, 'features.portal_default_tab') !== compatibility.portal_default_tab) {
    errors.push('cross_baseline_compat_portal_tab');
  }
  if (getPath(baseline, '_meta.vertical') !== compatibility.legacy_vertical) {
    errors.push('cross_baseline_compat_vertical');
  }
  const secretExamplePath = getPath(baseline, 'secrets.example_file');
  if (typeof secretExamplePath !== 'string'
    || !secretExamplePath.endsWith('secrets.example.template.json')) {
    errors.push('baseline_secrets_example_file_mismatch');
  }
  const keys = getPath(baseline, 'secrets.keys');
  if (!Array.isArray(keys) || keys.length < 1) errors.push('baseline_secrets_keys_missing');
  if (secretsExample && Array.isArray(keys)) {
    for (const k of keys) {
      if (!Object.prototype.hasOwnProperty.call(secretsExample, k)) {
        errors.push(`secrets_example_missing_key:${k}`);
      }
    }
  }
  if (archetypeId === 'surf_house') {
    if (!pricing) errors.push('surf_house_pricing_required');
    else if (getPath(pricing, 'client_slug') !== getPath(baseline, '_meta.client_slug')) {
      errors.push('pricing_baseline_client_slug_mismatch');
    }
  }
  if (archetypeId === 'surf_school_shop' && pricing) {
    errors.push('surf_school_shop_must_not_ship_pricing_template');
  }
  errors.push(...validatePlaceholderAlignment(bundle));
  return errors;
}

function validateTenantLocationIsolation(surfHouse, surfSchoolShop) {
  const errors = [];
  const aLocs = (surfHouse.compatibility.registry_shape
    && surfHouse.compatibility.registry_shape.location_id_placeholders) || [];
  const bLocs = (surfSchoolShop.compatibility.registry_shape
    && surfSchoolShop.compatibility.registry_shape.location_id_placeholders) || [];
  const set = new Set([...aLocs, ...bLocs]);
  if (set.size !== aLocs.length + bLocs.length) {
    errors.push('archetype_location_placeholders_collide');
  }
  for (const id of [...aLocs, ...bLocs]) {
    if (id === 'wolfhouse-somo' || id === 'sunset-somo' || id === 'sunset-sardinero') {
      errors.push(`location_placeholder_is_live_id:${id}`);
    }
    if (!isPlaceholderString(id)) {
      errors.push(`location_placeholder_not_token:${id}`);
    }
  }
  const aSlug = surfHouse.compatibility.registry_shape
    && surfHouse.compatibility.registry_shape.client_slug_placeholder;
  const bSlug = surfSchoolShop.compatibility.registry_shape
    && surfSchoolShop.compatibility.registry_shape.client_slug_placeholder;
  if (!isPlaceholderString(aSlug) || !isPlaceholderString(bSlug)) {
    errors.push('client_slug_placeholder_not_token');
  }
  return errors;
}

/**
 * Enumerate actual archetype directories and JSON file sets on disk.
 * Returns { dirs: string[], files: { [archetypeId]: string[] } }.
 */
function enumerateArchetypeFileSets(repoRoot) {
  const root = path.join(repoRoot, ARCHETYPE_ROOT);
  if (!fs.existsSync(root)) {
    return { dirs: [], files: {} };
  }
  const dirs = fs.readdirSync(root)
    .filter((name) => fs.statSync(path.join(root, name)).isDirectory())
    .sort();
  const files = {};
  for (const id of dirs) {
    const dir = path.join(root, id);
    files[id] = fs.readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .sort()
      .map((n) => `${ARCHETYPE_ROOT}/${id}/${n}`);
  }
  return { dirs, files };
}

function validateArchetypeFileSets(repoRoot) {
  const errors = [];
  const { dirs, files } = enumerateArchetypeFileSets(repoRoot);
  const expectedDirs = [...ARCHETYPE_IDS].sort();
  if (!deepEqual(dirs, expectedDirs)) {
    errors.push(`archetype_dir_set_mismatch:got=${dirs.join(',')}`);
  }
  for (const id of ARCHETYPE_IDS) {
    const expected = [...ARCHETYPE_FILES[id]].sort();
    const got = (files[id] || []).slice().sort();
    if (!deepEqual(got, expected)) {
      errors.push(`file_set_mismatch:${id}:got=${got.join('|')}:want=${expected.join('|')}`);
    }
  }
  return errors;
}

/** Working-tree blob SHA via git hash-object (not HEAD:path). */
function workingTreeBlobShaSafe(repoRoot, rel) {
  const abs = path.join(repoRoot, rel);
  if (!fs.existsSync(abs)) return `__missing_file__:${rel}`;
  try {
    return execSync(`git hash-object -- ${rel}`, {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch (err) {
    return `__hash_failed__:${err && err.message}`;
  }
}

/** Resolve blob SHA from a git ref (prefer master / MASTER_BASIS — never HEAD tip alone). */
function refBlobSha(repoRoot, gitRef, rel) {
  try {
    return execSync(`git rev-parse ${gitRef}:${rel}`, {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch (err) {
    return `__missing__:${err && err.message}`;
  }
}

/**
 * Verify working-tree reference bytes match pinned master blobs.
 * Compares hash-object(working tree) against PRESERVED_REFERENCE_BLOBS and
 * against MASTER_BASIS / origin/master (not HEAD).
 */
function validateReferenceBytesAgainstMaster(repoRoot) {
  const errors = [];
  for (const [rel, pinned] of Object.entries(PRESERVED_REFERENCE_BLOBS)) {
    const wt = workingTreeBlobShaSafe(repoRoot, rel);
    if (wt !== pinned) {
      errors.push(`reference_worktree_blob_drift:${rel}:got=${wt}:want=${pinned}`);
    }
    const masterBasis = refBlobSha(repoRoot, MASTER_BASIS, rel);
    if (masterBasis !== pinned) {
      errors.push(`reference_master_basis_blob_drift:${rel}:got=${masterBasis}:want=${pinned}`);
    }
    // Prefer origin/master when present; fall back to master.
    let masterTip = refBlobSha(repoRoot, 'origin/master', rel);
    if (String(masterTip).startsWith('__missing__')) {
      masterTip = refBlobSha(repoRoot, 'master', rel);
    }
    if (!String(masterTip).startsWith('__missing__') && masterTip !== pinned) {
      errors.push(`reference_master_tip_blob_drift:${rel}:got=${masterTip}:want=${pinned}`);
    }
  }
  return errors;
}

deepFreeze(ARCHETYPE_LOCKS);
deepFreeze(REQUIRED_BASELINE_PATHS);
deepFreeze(ARCHETYPE_FILES);
deepFreeze(PRESERVED_REFERENCE_BLOBS);
deepFreeze(FORBIDDEN_CONTENT_PATTERNS);
deepFreeze(ENABLEMENT_FALSE_PATHS);
deepFreeze(EXISTING_REGRESSION_GATES);
deepFreeze(FORBIDDEN_PRODUCTIZATION_PATHS);
deepFreeze(REQUIRED_ADD_ON_KEYS);
deepFreeze(INVENTED_PRICING_KEYS);
deepFreeze(SUPPORTED_PRICING_UNITS);
deepFreeze(SUPPORTED_PAYMENT_OPTIONS);
deepFreeze(RECOGNIZED_ROUNDING_METHODS);
deepFreeze(COMPAT_CONSUMPTION_CLASSES);

module.exports = Object.freeze({
  SLICE,
  BRANCH,
  MASTER_BASIS,
  OUTCOME_ID,
  ARCHETYPE_IDS,
  ARCHETYPE_ROOT,
  ARCHETYPE_FILES,
  ARCHETYPE_LOCKS,
  PRESERVED_REFERENCE_BLOBS,
  REQUIRED_BASELINE_PATHS,
  REQUIRED_PRICING_PATHS,
  REQUIRED_ADD_ON_KEYS,
  INVENTED_PRICING_KEYS,
  REQUIRED_MANIFEST_PATHS,
  REQUIRED_COMPATIBILITY_PATHS,
  FORBIDDEN_PRODUCTIZATION_PATHS,
  PACKAGE_JSON_ALLOWED_SCRIPT_KEY,
  PACKAGE_JSON_ALLOWED_SCRIPT_VALUE,
  EXISTING_REGRESSION_GATES,
  FORBIDDEN_CONTENT_PATTERNS,
  ENABLEMENT_FALSE_PATHS,
  SEND_MODE_ALLOWED,
  PLACEHOLDER_RE,
  SLOT_TIME_RE,
  SUPPORTED_PRICING_UNITS,
  SUPPORTED_PAYMENT_OPTIONS,
  RECOGNIZED_ROUNDING_METHODS,
  COMPAT_CONSUMPTION_CLASSES,
  thaw,
  deepEqual,
  getPath,
  hasPath,
  isPlaceholderString,
  isNumberOrTypedPlaceholder,
  isIntegerMonthOrTypedPlaceholder,
  isNormalizedSlotTimeOrTypedPlaceholder,
  isObjectOrNotesOnlyMap,
  walkStrings,
  collectPlaceholders,
  scanForbiddenContent,
  validateEnablementOff,
  validateRequiredPaths,
  validateManifest,
  validateCompatibility,
  validateBaselineTemplate,
  validatePricingTemplate,
  validateSeasonOverlapOrUniquePriority,
  validatePlaceholderAlignment,
  validateCrossFileReferences,
  validateTenantLocationIsolation,
  enumerateArchetypeFileSets,
  validateArchetypeFileSets,
  workingTreeBlobShaSafe,
  refBlobSha,
  validateReferenceBytesAgainstMaster,
});

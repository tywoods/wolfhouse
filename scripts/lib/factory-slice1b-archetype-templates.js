'use strict';

/**
 * FACTORY Slice 1B — archetype schema + disabled-by-default static templates.
 *
 * Static templates only under config/archetypes/. No generator, no client
 * instance materialization, no runtime loading, no IaC/DB/deploy/live calls.
 */

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

/** Exact blob SHAs of reference baselines that must remain byte-identical. */
const PRESERVED_REFERENCE_BLOBS = Object.freeze({
  'config/clients/wolfhouse-somo.baseline.json':
    '82b4856d88ed647a6e74cb1bafa44f4140e30606',
  'config/clients/sunset.baseline.json':
    '773deffaa3a2e0cdd3fec05c41ac3f8b47857b24',
  'config/clients/wolfhouse-somo.pricing.json':
    '985402b4c349d80e28c37c427e72c1905c6bbdda',
});

const PLACEHOLDER_RE = /^\{\{[A-Z0-9_]+\}\}$/;

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
    'rooming.rooms',
    'rooming.rooming_auto_assign_allowed',
    'payment.payment_link_auto_allowed',
    'payment.deposit_rule.type',
    'payment.deposit_rule.default_eur',
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

const REQUIRED_PRICING_PATHS = Object.freeze([
  '_meta.client_slug',
  'client_slug',
  'currency',
  'seasons',
  'packages',
  'addons',
  'deposit',
]);

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

const ALLOWED_TIP_PATH_PREFIXES = Object.freeze([
  'config/archetypes/',
  'docs/FACTORY-CLIENT-PRODUCTIZATION.md',
  'fixtures/factory-client-productization/',
  'scripts/lib/factory-slice1a-acceptance-contract.js',
  'scripts/lib/factory-slice1b-archetype-templates.js',
  'scripts/verify-factory-slice1a-acceptance-contract.js',
  'scripts/verify-factory-slice1b-archetype-templates.js',
  'package.json',
  'package-lock.json',
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

function walkStrings(value, visit, trail) {
  const path = trail || [];
  if (typeof value === 'string') {
    visit(value, path.join('.'));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkStrings(v, visit, path.concat(String(i))));
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      // Skip documentation/note keys for placeholder-shape enforcement,
      // but still scan them for forbidden secret/live patterns separately.
      walkStrings(value[key], visit, path.concat(key));
    }
  }
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

  // Instance identity must be placeholders — never copied live slugs.
  const slug = getPath(baseline, '_meta.client_slug');
  if (!isPlaceholderString(slug)) errors.push('baseline_client_slug_not_placeholder');
  if (slug === 'wolfhouse' || slug === 'sunset' || slug === 'wolfhouse-somo') {
    errors.push('baseline_client_slug_copied_live_target');
  }

  if (archetypeId === 'surf_house') {
    const rooms = getPath(baseline, 'rooming.rooms');
    if (!rooms || typeof rooms !== 'object' || Array.isArray(rooms) || Object.keys(rooms).length < 1) {
      errors.push('surf_house_rooms_missing');
    }
    const known = getPath(baseline, 'packages.known_packages');
    if (!Array.isArray(known) || known.length < 1) errors.push('surf_house_packages_missing');
  }

  if (archetypeId === 'surf_school_shop') {
    const locs = getPath(baseline, 'locations');
    if (!Array.isArray(locs) || locs.length < 2) errors.push('surf_school_shop_locations_lt_2');
    for (const loc of locs || []) {
      if (!loc || !isPlaceholderString(loc.location_id)) {
        errors.push('surf_school_shop_location_id_not_placeholder');
        break;
      }
      if (loc.location_id === 'sunset-somo' || loc.location_id === 'sunset-sardinero') {
        errors.push('surf_school_shop_location_copied_live_target');
        break;
      }
    }
    const rentals = getPath(baseline, 'catalog.rentals.offerings');
    const lessons = getPath(baseline, 'catalog.lessons.offerings');
    if (!rentals || typeof rentals !== 'object') errors.push('rentals_offerings_missing');
    if (!lessons || typeof lessons !== 'object') errors.push('lessons_offerings_missing');
  }

  // Secret refs only — never embedded secret values.
  const phoneRef = getPath(baseline, 'handoff.handoff_whatsapp_target.phone_ref');
  if (typeof phoneRef !== 'string' || !phoneRef.startsWith('secret:')) {
    errors.push('handoff_phone_ref_must_be_secret_ref');
  }

  return errors;
}

function validatePricingTemplate(pricing) {
  const errors = [];
  errors.push(...validateRequiredPaths(pricing, REQUIRED_PRICING_PATHS, 'pricing'));
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
  return errors;
}

function validateCrossFileReferences(bundle) {
  const errors = [];
  const { manifest, baseline, pricing, secretsExample, compatibility, archetypeId } = bundle;
  const expectedFiles = thaw(ARCHETYPE_FILES[archetypeId]);
  const listed = (manifest.files || []).map((f) => (
    f.startsWith('config/') ? f : `${ARCHETYPE_ROOT}/${archetypeId}/${f}`
  ));
  for (const f of expectedFiles) {
    if (!listed.includes(f) && !listed.includes(pathBasename(f))) {
      // allow basename listing
      const base = pathBasename(f);
      if (!(manifest.files || []).includes(base) && !(manifest.files || []).includes(f)) {
        errors.push(`manifest_missing_file:${base}`);
      }
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
  return errors;
}

function pathBasename(p) {
  const parts = String(p).split('/');
  return parts[parts.length - 1];
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
  // Templates must not claim ownership of live reference location ids.
  for (const id of [...aLocs, ...bLocs]) {
    if (id === 'wolfhouse-somo' || id === 'sunset-somo' || id === 'sunset-sardinero') {
      errors.push(`location_placeholder_is_live_id:${id}`);
    }
    if (!isPlaceholderString(id)) {
      errors.push(`location_placeholder_not_token:${id}`);
    }
  }
  // Registry client slug placeholders must be tokens (may share the same token
  // name across archetypes; generator assigns unique values later).
  const aSlug = surfHouse.compatibility.registry_shape
    && surfHouse.compatibility.registry_shape.client_slug_placeholder;
  const bSlug = surfSchoolShop.compatibility.registry_shape
    && surfSchoolShop.compatibility.registry_shape.client_slug_placeholder;
  if (!isPlaceholderString(aSlug) || !isPlaceholderString(bSlug)) {
    errors.push('client_slug_placeholder_not_token');
  }
  return errors;
}

deepFreeze(ARCHETYPE_LOCKS);
deepFreeze(REQUIRED_BASELINE_PATHS);
deepFreeze(ARCHETYPE_FILES);
deepFreeze(PRESERVED_REFERENCE_BLOBS);
deepFreeze(FORBIDDEN_CONTENT_PATTERNS);
deepFreeze(ENABLEMENT_FALSE_PATHS);
deepFreeze(ALLOWED_TIP_PATH_PREFIXES);
deepFreeze(EXISTING_REGRESSION_GATES);
deepFreeze(FORBIDDEN_PRODUCTIZATION_PATHS);

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
  REQUIRED_MANIFEST_PATHS,
  REQUIRED_COMPATIBILITY_PATHS,
  FORBIDDEN_PRODUCTIZATION_PATHS,
  ALLOWED_TIP_PATH_PREFIXES,
  PACKAGE_JSON_ALLOWED_SCRIPT_KEY,
  PACKAGE_JSON_ALLOWED_SCRIPT_VALUE,
  EXISTING_REGRESSION_GATES,
  FORBIDDEN_CONTENT_PATTERNS,
  ENABLEMENT_FALSE_PATHS,
  SEND_MODE_ALLOWED,
  PLACEHOLDER_RE,
  thaw,
  deepEqual,
  getPath,
  hasPath,
  isPlaceholderString,
  walkStrings,
  scanForbiddenContent,
  validateEnablementOff,
  validateRequiredPaths,
  validateManifest,
  validateCompatibility,
  validateBaselineTemplate,
  validatePricingTemplate,
  validateCrossFileReferences,
  validateTenantLocationIsolation,
});

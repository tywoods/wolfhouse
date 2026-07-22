'use strict';

/**
 * FACTORY Slice 1A — finite source-only acceptance contract locks.
 *
 * Canonical freeze for client-productization stages 1A–1E and the nine
 * acceptance gates. Docs/fixtures/verifier only — no templates, generator,
 * runtime, IaC, DB, deploy, secrets, or live calls in this slice.
 *
 * Third-tenant live/prod work is out of scope for current-stage evidence and
 * requires RADAR reopen trigger `third_tenant_factory`.
 */

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const SLICE = 'FACTORY-1A';
const BRANCH = 'factory/slice-1a-contract';
const MASTER_BASIS = '0ef5958ed8b81ca04b196062505bf4be7a403221';
/** Frozen tip that delivered 1A onto master; later stages must not widen this tip scope check. */
const SLICE_TIP_SHA = '86f4cb9daaefdecab75ad02a2e755e2e7503216d';
const OUTCOME_ID = '1A_source_only_acceptance_contract';

const FINITE_STAGES = Object.freeze([
  Object.freeze({
    id: '1A',
    title: 'Source-only acceptance contract',
    status: 'complete',
    allows: Object.freeze([
      'docs',
      'fixtures',
      'independent_verifier',
      'inventory_freeze',
      'gate_freeze',
      'stage_fence',
      'package_json_verifier_script_registration',
    ]),
    forbids: Object.freeze([
      'templates',
      'generator',
      'runtime',
      'iac',
      'db',
      'deploy',
      'secrets',
      'live_calls',
    ]),
  }),
  Object.freeze({
    id: '1B',
    title: 'Archetype schema and disabled-by-default templates',
    status: 'complete',
    depends_on: '1A',
    completion_evidence: '1B_static_disabled_archetype_templates',
    completion_requires: 'verify:factory-slice1b-archetype-templates',
  }),
  Object.freeze({
    id: '1C',
    title: 'Deterministic generator with secret rejection and no live-target copy',
    status: 'complete',
    depends_on: '1B',
    completion_evidence: '1C_deterministic_disabled_dry_run_generator',
    completion_requires: 'verify:factory-slice1c-dry-run-generator',
  }),
  Object.freeze({
    id: '1D',
    title: 'Tenant/location isolation and legacy-compatibility wiring proofs',
    status: 'deferred_future_stage',
    depends_on: '1C',
  }),
  Object.freeze({
    id: '1E',
    title: 'Dry-run proof packaging and milestone closeout',
    status: 'deferred_future_stage',
    depends_on: '1D',
  }),
]);

const ARCHETYPES = Object.freeze([
  Object.freeze({
    id: 'surf_house',
    label: 'Surf house',
    reference_client_slug: 'wolfhouse',
    reference_location_ids: Object.freeze(['wolfhouse-somo']),
    reference_baseline: 'config/clients/wolfhouse-somo.baseline.json',
    legacy_vertical: 'lodging_surf_house',
    crowsnest_template_id: 'surf_house',
  }),
  Object.freeze({
    id: 'surf_school_shop',
    label: 'Surf school + shop',
    reference_client_slug: 'sunset',
    reference_location_ids: Object.freeze(['sunset-somo', 'sunset-sardinero']),
    reference_baseline: 'config/clients/sunset.baseline.json',
    legacy_vertical: 'surf_school_rentals',
    crowsnest_template_id: 'surf_school',
  }),
]);

const GATES = Object.freeze([
  Object.freeze({
    id: 'G_ARCHETYPE_SURF_HOUSE',
    title: 'surf_house archetype gate',
    requirement:
      'Productization must emit a surf_house client whose reference shape matches Wolfhouse lodging_surf_house (single primary location, bed/room inventory, portal default bed-calendar).',
    proof_stage: '1B+',
    current_stage_evidence: '1B_static_disabled_archetype_templates',
  }),
  Object.freeze({
    id: 'G_ARCHETYPE_SURF_SCHOOL_SHOP',
    title: 'surf_school_shop archetype gate',
    requirement:
      'Productization must emit a surf_school_shop client whose reference shape matches Sunset surf_school_rentals (multi-location, lessons+rentals catalog, portal default portal-home).',
    proof_stage: '1B+',
    current_stage_evidence: '1B_static_disabled_archetype_templates',
  }),
  Object.freeze({
    id: 'G_DISABLED_BY_DEFAULT_GENERATION',
    title: 'Deterministic disabled-by-default generation',
    requirement:
      'Generated clients must set live_enabled=false, deployment.enabled=false (or equivalent), and channel enabled=false unless an explicit later enablement gate flips them. Generation must be deterministic for identical inputs.',
    proof_stage: '1C+',
    current_stage_evidence: '1C_deterministic_disabled_dry_run_generator',
  }),
  Object.freeze({
    id: 'G_SECRET_REJECTION',
    title: 'Secret rejection',
    requirement:
      'Generator and templates must reject embedding live secret values; only secret:<key> refs and *.secrets.example.json shapes are allowed in committed outputs.',
    proof_stage: '1C+',
    current_stage_evidence: '1C_deterministic_disabled_dry_run_generator',
  }),
  Object.freeze({
    id: 'G_NO_LIVE_TARGET_COPYING',
    title: 'No live-target copying',
    requirement:
      'Generation must not copy production/live Azure resource IDs, phone_number_id values, Stripe live keys, or live hostnames from Wolfhouse/Sunset live targets into a new client.',
    proof_stage: '1C+',
    current_stage_evidence: '1C_deterministic_disabled_dry_run_generator',
  }),
  Object.freeze({
    id: 'G_TENANT_LOCATION_ISOLATION',
    title: 'Tenant and location isolation',
    requirement:
      'New clients get unique client_slug; locations get globally unique location_id owned by exactly one client; no cross-tenant secret/DB/runtime sharing in live model (per docs/MULTICLIENT-ARCHITECTURE.md).',
    proof_stage: '1D+',
    current_stage_evidence: 'existing_multiclient_verifiers_retained',
  }),
  Object.freeze({
    id: 'G_LEGACY_COMPATIBILITY',
    title: 'Legacy compatibility',
    requirement:
      'Wolfhouse lodging_surf_house and Sunset surf_school_rentals continue to load via existing baseline/portal/resolver paths without requiring FACTORY migration in 1A–1E.',
    proof_stage: '1D+',
    current_stage_evidence: 'inventory_maps_legacy_verticals',
  }),
  Object.freeze({
    id: 'G_DRY_RUN_PROOF',
    title: 'Dry-run proof',
    requirement:
      'A dry-run generation path must produce inspectable artifacts and pass offline verifiers without writing live targets, secrets, DB rows, or deploying.',
    proof_stage: '1E',
    current_stage_evidence: 'gate_text_freeze_only',
  }),
  Object.freeze({
    id: 'G_MILESTONE_CLOSEOUT',
    title: 'Milestone closeout',
    requirement:
      'FACTORY 1A–1E closes only when all nine gates have stage-appropriate evidence, finite stage fence is intact, and third-tenant live/prod remains blocked pending RADAR reopen.',
    proof_stage: '1E',
    current_stage_evidence: 'closeout_deferred_to_1E',
  }),
]);

const EVIDENCE_CLASSES = Object.freeze({
  required_current_stage: Object.freeze([
    'source_inventory_of_wolfhouse_sunset_configs_registries_flags_consumers_overlays_verifiers',
    'finite_stage_fence_1A_through_1E',
    'nine_acceptance_gates_frozen',
    'independent_source_derived_inventory_completeness',
    'docs_fixtures_verifier_only_delivery',
  ]),
  out_of_scope_current_stage: Object.freeze([
    'templates',
    'generator',
    'runtime_productization',
    'iac_mutation',
    'db_mutation',
    'deploy',
    'secret_materialization',
    'live_network_calls',
    'third_tenant_live_or_prod_onboarding',
  ]),
  third_tenant_live_prod: Object.freeze({
    status: 'out_of_scope',
    effect: 'triggers_RADAR_reopen',
    reopen_trigger_id: 'third_tenant_factory',
    threshold: 'tenant_count_gt_2_or_new_tenant_slug_beyond_wolfhouse_somo_and_sunset',
    note:
      'Non-reference registry sample clients remain inventory-only while live_enabled=false; live/prod onboarding of a tenant beyond the Wolfhouse+Sunset pair is not FACTORY 1A–1E current-stage evidence.',
  }),
});

const SCOPE_FENCE = Object.freeze({
  allowed_stage_ids: Object.freeze(['1A', '1B', '1C', '1D', '1E']),
  reject_stage_drift: true,
  reject_extra_stages: true,
  reject_renaming_gates: true,
  reject_raising_third_tenant_live_as_current_evidence: true,
});

const COMPLETENESS_METHOD = 'source_derived_registration_read_site_inventory';

/** Tip path scope: docs/fixtures/verifier-support only, plus locked package.json script + Acorn pin. */
const ALLOWED_TIP_PATH_PREFIXES = Object.freeze([
  'docs/FACTORY-CLIENT-PRODUCTIZATION.md',
  'fixtures/factory-client-productization/',
  'scripts/lib/factory-slice1a-acceptance-contract.js',
  'scripts/lib/factory-slice1a-inventory-discovery.js',
  'scripts/verify-factory-slice1a-acceptance-contract.js',
  'package.json',
  'package-lock.json',
]);

const PACKAGE_JSON_ALLOWED_SCRIPT_KEY = 'verify:factory-slice1a-acceptance-contract';
const PACKAGE_JSON_ALLOWED_SCRIPT_VALUE =
  'node scripts/verify-factory-slice1a-acceptance-contract.js';

/** Exact Acorn pin required for ESTree physical-site discovery. */
const PACKAGE_JSON_ALLOWED_ACORN_PIN = Object.freeze({
  name: 'acorn',
  version: '8.14.1',
});

const EXISTING_REGRESSION_GATES = Object.freeze([
  'node scripts/verify-multiclient-isolation.js',
  'node scripts/verify-no-client-hardcoding.js',
  'node scripts/verify-tenant-resolution.js',
  'node scripts/verify-meta-whatsapp-tenant-shadow.js',
]);

/** Pre-existing master REDs retained (not introduced by 1A; not fail-closed here). */
const EXISTING_REGRESSION_RETAINED_MASTER_RED = Object.freeze([
  Object.freeze({
    gate: 'node scripts/verify-staff-tenant-scope.js',
    retained_failure: 'H3 stripe webhook addon idempotent COUNT filters by client_slug',
  }),
  Object.freeze({
    gate: 'node scripts/verify-tenant-business-config.js',
    retained_failure: 'DB prices used (async DB overlay merges baseline prices; length>1)',
  }),
]);

const CONTRACT = deepFreeze({
  schema_version: 1,
  slice: SLICE,
  outcome_id: OUTCOME_ID,
  branch: BRANCH,
  master_basis: MASTER_BASIS,
  live_mutation: false,
  runtime_behavior_changed: false,
  completeness_method: COMPLETENESS_METHOD,
  finite_stages: FINITE_STAGES,
  archetypes: ARCHETYPES,
  gates: GATES,
  evidence_classes: EVIDENCE_CLASSES,
  scope_fence: SCOPE_FENCE,
  tip_scope: Object.freeze({
    allowed_path_prefixes: ALLOWED_TIP_PATH_PREFIXES,
    package_json_allowed_script_key: PACKAGE_JSON_ALLOWED_SCRIPT_KEY,
    package_json_allowed_script_value: PACKAGE_JSON_ALLOWED_SCRIPT_VALUE,
    package_json_allowed_acorn_pin: PACKAGE_JSON_ALLOWED_ACORN_PIN,
  }),
  existing_regression_gates: EXISTING_REGRESSION_GATES,
  existing_regression_retained_master_red: EXISTING_REGRESSION_RETAINED_MASTER_RED,
});

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

function validateFactory1aContract(candidate) {
  const errors = [];
  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, errors: ['candidate_missing'] };
  }
  const expected = thaw(CONTRACT);
  if (!deepEqual(candidate.slice, expected.slice)) errors.push('slice_mismatch');
  if (!deepEqual(candidate.outcome_id, expected.outcome_id)) errors.push('outcome_id_mismatch');
  if (!deepEqual(candidate.master_basis, expected.master_basis)) errors.push('master_basis_mismatch');
  if (!deepEqual(candidate.completeness_method, expected.completeness_method)) {
    errors.push('completeness_method_mismatch');
  }
  if (!deepEqual(candidate.finite_stages, expected.finite_stages)) errors.push('finite_stages_mismatch');
  if (!deepEqual(candidate.archetypes, expected.archetypes)) errors.push('archetypes_mismatch');
  if (!deepEqual(candidate.gates, expected.gates)) errors.push('gates_mismatch');
  if (!deepEqual(candidate.evidence_classes, expected.evidence_classes)) {
    errors.push('evidence_classes_mismatch');
  }
  if (!deepEqual(candidate.scope_fence, expected.scope_fence)) errors.push('scope_fence_mismatch');
  if (!deepEqual(candidate.tip_scope, expected.tip_scope)) errors.push('tip_scope_mismatch');
  if (!deepEqual(candidate.existing_regression_gates, expected.existing_regression_gates)) {
    errors.push('existing_regression_gates_mismatch');
  }
  if (!deepEqual(
    candidate.existing_regression_retained_master_red,
    expected.existing_regression_retained_master_red,
  )) {
    errors.push('retained_master_red_mismatch');
  }
  if (candidate.live_mutation !== false) errors.push('live_mutation_must_be_false');
  if (candidate.runtime_behavior_changed !== false) {
    errors.push('runtime_behavior_changed_must_be_false');
  }

  const stageIds = (candidate.finite_stages || []).map((s) => s && s.id);
  if (!deepEqual(stageIds, ['1A', '1B', '1C', '1D', '1E'])) {
    errors.push('stage_drift_rejected');
  }
  const gateIds = (candidate.gates || []).map((g) => g && g.id);
  const expectedGateIds = expected.gates.map((g) => g.id);
  if (!deepEqual(gateIds, expectedGateIds)) errors.push('gate_drift_rejected');

  const third = candidate.evidence_classes && candidate.evidence_classes.third_tenant_live_prod;
  if (!third || third.status !== 'out_of_scope' || third.effect !== 'triggers_RADAR_reopen') {
    errors.push('third_tenant_must_remain_out_of_scope');
  }
  if (third && third.reopen_trigger_id !== 'third_tenant_factory') {
    errors.push('third_tenant_reopen_trigger_mismatch');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 1B ledger may claim complete only when the independent 1B verifier passed.
 * Gates G_ARCHETYPE_* must carry matching 1B evidence in that case.
 */
function validate1bLedgerClaim(stage1b, gates, slice1bVerifierPassed) {
  const errors = [];
  if (!stage1b || stage1b.id !== '1B') {
    errors.push('1b_stage_missing');
    return errors;
  }
  if (stage1b.status === 'complete') {
    if (!slice1bVerifierPassed) {
      errors.push('1b_complete_without_independent_validator');
    }
    if (stage1b.completion_evidence !== '1B_static_disabled_archetype_templates') {
      errors.push('1b_complete_evidence_mismatch');
    }
    if (stage1b.completion_requires !== 'verify:factory-slice1b-archetype-templates') {
      errors.push('1b_complete_requires_mismatch');
    }
    const g0 = gates && gates[0];
    const g1 = gates && gates[1];
    if (!g0 || g0.current_stage_evidence !== '1B_static_disabled_archetype_templates') {
      errors.push('1b_gate_surf_house_evidence_mismatch');
    }
    if (!g1 || g1.current_stage_evidence !== '1B_static_disabled_archetype_templates') {
      errors.push('1b_gate_surf_school_shop_evidence_mismatch');
    }
  }
  return errors;
}

/**
 * 1C ledger may claim complete only when the independent 1C verifier passed.
 * Gates G_DISABLED / G_SECRET / G_NO_LIVE_TARGET must carry matching 1C evidence.
 */
function validate1cLedgerClaim(stage1c, gates, slice1cVerifierPassed) {
  const errors = [];
  if (!stage1c || stage1c.id !== '1C') {
    errors.push('1c_stage_missing');
    return errors;
  }
  const evidence = '1C_deterministic_disabled_dry_run_generator';
  const requires = 'verify:factory-slice1c-dry-run-generator';
  if (stage1c.status === 'complete') {
    if (!slice1cVerifierPassed) {
      errors.push('1c_complete_without_independent_validator');
    }
    if (stage1c.completion_evidence !== evidence) {
      errors.push('1c_complete_evidence_mismatch');
    }
    if (stage1c.completion_requires !== requires) {
      errors.push('1c_complete_requires_mismatch');
    }
    const byId = new Map((gates || []).map((g) => [g.id, g]));
    for (const gateId of [
      'G_DISABLED_BY_DEFAULT_GENERATION',
      'G_SECRET_REJECTION',
      'G_NO_LIVE_TARGET_COPYING',
    ]) {
      const g = byId.get(gateId);
      if (!g || g.current_stage_evidence !== evidence) {
        errors.push(`1c_gate_evidence_mismatch:${gateId}`);
      }
    }
  }
  return errors;
}

deepFreeze(CONTRACT);

module.exports = Object.freeze({
  SLICE,
  BRANCH,
  MASTER_BASIS,
  SLICE_TIP_SHA,
  OUTCOME_ID,
  FINITE_STAGES,
  ARCHETYPES,
  GATES,
  EVIDENCE_CLASSES,
  SCOPE_FENCE,
  COMPLETENESS_METHOD,
  ALLOWED_TIP_PATH_PREFIXES,
  PACKAGE_JSON_ALLOWED_SCRIPT_KEY,
  PACKAGE_JSON_ALLOWED_SCRIPT_VALUE,
  PACKAGE_JSON_ALLOWED_ACORN_PIN,
  EXISTING_REGRESSION_GATES,
  EXISTING_REGRESSION_RETAINED_MASTER_RED,
  CONTRACT,
  thaw,
  deepEqual,
  validateFactory1aContract,
  validate1bLedgerClaim,
  validate1cLedgerClaim,
});

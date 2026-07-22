'use strict';

/**
 * FACTORY Slice 1D — integration evidence locks for the reviewed 1C generator.
 *
 * Docs/fixtures/independent verifier only. Does not change product, runtime,
 * archetype templates, or generator behavior. Proves portable byte-determinism,
 * consumer-shape compatibility via pure validators/calculators on verifier-owned
 * temp fixtures, tenant/location isolation, disabled enablement, reference-blob
 * immutability, and no process/env/module-cache leakage.
 */

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const SLICE = 'FACTORY-1D';
const BRANCH = 'factory/slice-1d-integration-proof';
const MASTER_BASIS = '210b3643793ad5569dc466977b8fe4421c22ef92';
const OUTCOME_ID = '1D_integration_isolation_legacy_compat_proof';
const COMPLETION_EVIDENCE = '1D_integration_isolation_legacy_compat_proof';
const COMPLETION_REQUIRES = 'verify:factory-slice1d-integration-proof';

const ARCHETYPE_IDS = Object.freeze(['surf_house', 'surf_school_shop']);

const ALLOWED_TIP_PATH_PREFIXES = Object.freeze([
  'docs/FACTORY-CLIENT-PRODUCTIZATION.md',
  'fixtures/factory-client-productization/',
  'scripts/lib/factory-slice1a-acceptance-contract.js',
  'scripts/lib/factory-slice1b-archetype-templates.js',
  'scripts/lib/factory-slice1d-integration-proof.js',
  'scripts/verify-factory-slice1a-acceptance-contract.js',
  'scripts/verify-factory-slice1d-integration-proof.js',
  'package.json',
  'package-lock.json',
]);

const PACKAGE_JSON_ALLOWED_SCRIPT_KEY = 'verify:factory-slice1d-integration-proof';
const PACKAGE_JSON_ALLOWED_SCRIPT_VALUE =
  'node scripts/verify-factory-slice1d-integration-proof.js';

/** Identity tokens that must never appear as live tenant/location values. */
const FORBIDDEN_LIVE_IDENTITY = Object.freeze([
  'wolfhouse',
  'wolfhouse-somo',
  'sunset',
  'sunset-somo',
  'sunset-sardinero',
]);

const EXISTING_REGRESSION_GATES = Object.freeze([
  'npm run verify:factory-slice1c-dry-run-generator',
  'npm run verify:factory-slice1b-archetype-templates',
  'npm run verify:factory-slice1a-acceptance-contract',
  'npm run verify:luna-all',
  'npm run verify:multiclient',
  'node scripts/verify-multiclient-isolation.js',
  'node scripts/verify-no-client-hardcoding.js',
  'node scripts/verify-tenant-resolution.js',
  'node scripts/verify-meta-whatsapp-tenant-shadow.js',
]);

/** Pre-existing master REDs retained (not introduced by 1D; classified, not fail-closed). */
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

const EVIDENCE_CLASSES = Object.freeze({
  required_current_stage: Object.freeze([
    'independent_fresh_process_portability_matrix',
    'byte_identical_canonical_envelopes_and_golden_hashes',
    'verifier_owned_temp_consumer_validation',
    'cross_tenant_location_substitution_isolation',
    'no_wolfhouse_sunset_live_identity_or_secrets',
    'disabled_enablement_preserved',
    'reference_blobs_unchanged',
    'no_process_env_module_cache_leakage',
    'legacy_luna_multiclient_gates_plus_retained_red_classification',
  ]),
  out_of_scope_current_stage: Object.freeze([
    'product_runtime_template_generator_behavior_changes',
    'apply_path',
    'safe_disk_materialization',
    'registry_edits',
    'config_clients_writes',
    'runtime_registration',
    'client_creation',
    'iac_mutation',
    'db_mutation',
    'deploy',
    'secret_materialization',
    'live_network_calls',
    'third_tenant_live_or_prod_onboarding',
  ]),
});

/**
 * 1D ledger may claim complete only when the independent 1D verifier passed.
 * Gates G_TENANT_LOCATION_ISOLATION and G_LEGACY_COMPATIBILITY must carry
 * matching 1D evidence in that case.
 */
function validate1dLedgerClaim(stage1d, gates, slice1dVerifierPassed) {
  const errors = [];
  if (!stage1d || stage1d.id !== '1D') {
    errors.push('1d_stage_missing');
    return errors;
  }
  if (stage1d.status === 'complete') {
    if (!slice1dVerifierPassed) {
      errors.push('1d_complete_without_independent_validator');
    }
    if (stage1d.completion_evidence !== COMPLETION_EVIDENCE) {
      errors.push('1d_complete_evidence_mismatch');
    }
    if (stage1d.completion_requires !== COMPLETION_REQUIRES) {
      errors.push('1d_complete_requires_mismatch');
    }
    const byId = new Map((gates || []).map((g) => [g.id, g]));
    for (const gateId of ['G_TENANT_LOCATION_ISOLATION', 'G_LEGACY_COMPATIBILITY']) {
      const g = byId.get(gateId);
      if (!g || g.current_stage_evidence !== COMPLETION_EVIDENCE) {
        errors.push(`1d_gate_evidence_mismatch:${gateId}`);
      }
    }
  }
  return errors;
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

deepFreeze(EVIDENCE_CLASSES);
deepFreeze(EXISTING_REGRESSION_GATES);
deepFreeze(EXISTING_REGRESSION_RETAINED_MASTER_RED);
deepFreeze(ALLOWED_TIP_PATH_PREFIXES);
deepFreeze(FORBIDDEN_LIVE_IDENTITY);

module.exports = Object.freeze({
  SLICE,
  BRANCH,
  MASTER_BASIS,
  OUTCOME_ID,
  COMPLETION_EVIDENCE,
  COMPLETION_REQUIRES,
  ARCHETYPE_IDS,
  ALLOWED_TIP_PATH_PREFIXES,
  PACKAGE_JSON_ALLOWED_SCRIPT_KEY,
  PACKAGE_JSON_ALLOWED_SCRIPT_VALUE,
  FORBIDDEN_LIVE_IDENTITY,
  EXISTING_REGRESSION_GATES,
  EXISTING_REGRESSION_RETAINED_MASTER_RED,
  EVIDENCE_CLASSES,
  validate1dLedgerClaim,
  deepEqual,
});

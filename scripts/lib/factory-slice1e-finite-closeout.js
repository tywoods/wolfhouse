'use strict';

/**
 * FACTORY Slice 1E — dry-run proof packaging + finite milestone closeout locks.
 *
 * Docs/fixtures/independent verifier only. Does not change product, runtime,
 * archetype templates, or generator behavior. Commits one synthetic third-tenant
 * stdout dry-run artifact and proves byte-identical regeneration with no side
 * effects. Milestone stages/gates may claim complete only after the independent
 * 1E verifier passes.
 */

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const SLICE = 'FACTORY-1E';
const BRANCH = 'factory/slice-1e-finite-closeout';
const MASTER_BASIS = 'e8452d178ad8f4b6aadc8b59b2d3032634952471';
/** Fail-closed candidate range — bare working-tree `git diff --check` can miss committed trailing WS. */
const RANGE_DIFF_CHECK_GATE = `git diff --check ${MASTER_BASIS}...HEAD`;
const OUTCOME_ID = '1E_dry_run_proof_packaging_milestone_closeout';
const COMPLETION_EVIDENCE = '1E_dry_run_proof_packaging_milestone_closeout';
const COMPLETION_REQUIRES = 'verify:factory-slice1e-finite-closeout';

const ARCHETYPE = 'surf_house';
const CLIENT_SLUG = 'zyx-null-beacon';
const LOCATION_IDS = Object.freeze(['zyx-null-beacon-main']);

const SUBSTITUTIONS_REL =
  'fixtures/factory-client-productization/slice1e-substitutions-zyx-null-beacon.json';
const STDOUT_ARTIFACT_REL =
  'fixtures/factory-client-productization/slice1e-third-tenant-dry-run-stdout.json';
const ARTIFACT_LOCK_REL =
  'fixtures/factory-client-productization/slice1e-artifact-lock.json';
const CONTRACT_REL = 'fixtures/factory-client-productization/slice1e-contract.json';
const FINDINGS_REL = 'fixtures/factory-client-productization/slice1e-findings.md';
const HANDOFF_REL = 'fixtures/factory-client-productization/slice1e-operator-handoff.md';

const ALLOWED_TIP_PATH_PREFIXES = Object.freeze([
  'docs/FACTORY-CLIENT-PRODUCTIZATION.md',
  'fixtures/factory-client-productization/',
  'scripts/lib/factory-slice1a-acceptance-contract.js',
  'scripts/lib/factory-slice1b-archetype-templates.js',
  'scripts/lib/factory-slice1c-dry-run-generator.js',
  'scripts/lib/factory-slice1d-integration-proof.js',
  'scripts/lib/factory-slice1e-finite-closeout.js',
  'scripts/verify-factory-slice1a-acceptance-contract.js',
  'scripts/verify-factory-slice1b-archetype-templates.js',
  'scripts/verify-factory-slice1c-dry-run-generator.js',
  'scripts/verify-factory-slice1d-integration-proof.js',
  'scripts/verify-factory-slice1e-finite-closeout.js',
  'scripts/lib/messi-slice1a-acceptance-ledger.js',
  'scripts/verify-messi-slice1a-acceptance-ledger.js',
  'docs/MESSI-ACCEPTANCE-LEDGER.md',
  'fixtures/messi-acceptance/',
  'package.json',
  'package-lock.json',
]);

const PACKAGE_JSON_ALLOWED_SCRIPT_KEY = 'verify:factory-slice1e-finite-closeout';
const PACKAGE_JSON_ALLOWED_SCRIPT_VALUE =
  'node scripts/verify-factory-slice1e-finite-closeout.js';

/** Names/slugs that must never appear as the synthetic third-tenant identity. */
const FORBIDDEN_IDENTITY_TOKENS = Object.freeze([
  'crowsnest',
  'wolfhouse',
  'sunset',
  'elsardi',
  'el-sardi',
  'el_sardi',
]);

const EXISTING_REGRESSION_GATES = Object.freeze([
  'npm run verify:factory-slice1a-acceptance-contract',
  'npm run verify:factory-slice1b-archetype-templates',
  'npm run verify:factory-slice1c-dry-run-generator',
  'npm run verify:factory-slice1d-integration-proof',
  'npm run verify:luna-all',
  'npm run verify:multiclient',
  'node scripts/verify-multiclient-isolation.js',
  'node scripts/verify-no-client-hardcoding.js',
  'node scripts/verify-tenant-resolution.js',
  'node scripts/verify-meta-whatsapp-tenant-shadow.js',
]);

/** Pre-existing master REDs retained (not introduced by 1E; classified, not fail-closed). */
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
    'committed_synthetic_third_tenant_stdout_dry_run_artifact',
    'fresh_process_byte_identical_regeneration',
    'exact_artifact_and_manifest_hash_compare',
    'no_side_effects_on_config_clients_registry_templates',
    'all_enablement_false_no_secrets_no_live_targets',
    'independent_1a_through_1d_plus_luna_hard_multiclient_gates',
    'operator_handoff_stdout_only_no_deploy',
    'retained_master_red_classification',
  ]),
  out_of_scope_current_stage: Object.freeze([
    'product_runtime_archetype_template_generator_behavior_changes',
    'apply_path',
    'safe_disk_materialization',
    'registry_edits',
    'config_clients_writes',
    'runtime_registration',
    'client_creation',
    'iac_mutation',
    'db_mutation',
    'deploy',
    'staging_or_production_rollout',
    'secret_materialization',
    'live_network_calls',
    'third_tenant_live_or_prod_onboarding',
    'radar_third_tenant_factory_reopen_satisfaction',
  ]),
});

const PROVES = Object.freeze([
  'offline_deterministic_stdout_dry_run_packaging_for_one_synthetic_third_tenant',
  'all_enablement_false_and_no_secret_or_live_target_shaped_bytes_in_artifact',
  'no_registry_config_clients_runtime_writes_during_regeneration',
  'exact_manifest_and_file_hashes_locked',
  'factory_1a_through_1d_verifiers_still_pass',
  'luna_all_and_hard_multiclient_subset_still_pass',
  'finite_five_stages_and_nine_gates_have_stage_appropriate_evidence_after_proof',
]);

const DOES_NOT_PROVE = Object.freeze([
  'live_or_prod_third_tenant_onboarding',
  'apply_or_disk_materialization_path',
  'registry_or_config_clients_publication',
  'runtime_registration_or_client_creation',
  'staging_or_production_deploy',
  'radar_security_clearance_for_real_third_tenant',
  'fixing_retained_master_reds',
]);

/**
 * 1E ledger may claim complete only when the independent 1E verifier passed.
 * Gates G_DRY_RUN_PROOF and G_MILESTONE_CLOSEOUT must carry matching 1E evidence.
 */
function validate1eLedgerClaim(stage1e, gates, slice1eVerifierPassed) {
  const errors = [];
  if (!stage1e || stage1e.id !== '1E') {
    errors.push('1e_stage_missing');
    return errors;
  }
  if (stage1e.status === 'complete') {
    if (!slice1eVerifierPassed) {
      errors.push('1e_complete_without_independent_validator');
    }
    if (stage1e.completion_evidence !== COMPLETION_EVIDENCE) {
      errors.push('1e_complete_evidence_mismatch');
    }
    if (stage1e.completion_requires !== COMPLETION_REQUIRES) {
      errors.push('1e_complete_requires_mismatch');
    }
    const byId = new Map((gates || []).map((g) => [g.id, g]));
    for (const gateId of ['G_DRY_RUN_PROOF', 'G_MILESTONE_CLOSEOUT']) {
      const g = byId.get(gateId);
      if (!g || g.current_stage_evidence !== COMPLETION_EVIDENCE) {
        errors.push(`1e_gate_evidence_mismatch:${gateId}`);
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

function identityTextHasForbiddenToken(text) {
  const lower = String(text || '').toLowerCase();
  return FORBIDDEN_IDENTITY_TOKENS.some((tok) => lower.includes(tok));
}

deepFreeze(EVIDENCE_CLASSES);
deepFreeze(EXISTING_REGRESSION_GATES);
deepFreeze(EXISTING_REGRESSION_RETAINED_MASTER_RED);
deepFreeze(ALLOWED_TIP_PATH_PREFIXES);
deepFreeze(FORBIDDEN_IDENTITY_TOKENS);
deepFreeze(LOCATION_IDS);
deepFreeze(PROVES);
deepFreeze(DOES_NOT_PROVE);

module.exports = Object.freeze({
  SLICE,
  BRANCH,
  MASTER_BASIS,
  RANGE_DIFF_CHECK_GATE,
  OUTCOME_ID,
  COMPLETION_EVIDENCE,
  COMPLETION_REQUIRES,
  ARCHETYPE,
  CLIENT_SLUG,
  LOCATION_IDS,
  SUBSTITUTIONS_REL,
  STDOUT_ARTIFACT_REL,
  ARTIFACT_LOCK_REL,
  CONTRACT_REL,
  FINDINGS_REL,
  HANDOFF_REL,
  ALLOWED_TIP_PATH_PREFIXES,
  PACKAGE_JSON_ALLOWED_SCRIPT_KEY,
  PACKAGE_JSON_ALLOWED_SCRIPT_VALUE,
  FORBIDDEN_IDENTITY_TOKENS,
  EXISTING_REGRESSION_GATES,
  EXISTING_REGRESSION_RETAINED_MASTER_RED,
  EVIDENCE_CLASSES,
  PROVES,
  DOES_NOT_PROVE,
  validate1eLedgerClaim,
  deepEqual,
  identityTextHasForbiddenToken,
});

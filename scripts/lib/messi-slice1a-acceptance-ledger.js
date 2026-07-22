'use strict';

/**
 * messi-slice1a-acceptance-ledger — MESSI sole production classifier and
 * parent-binding locks (docs/fixtures/verifier only).
 *
 * Slice 1E wires the reviewed FORTRESS 1D finite audit closeout into this
 * canonical ledger: bind exact 1D candidate fa2c5d71 + merge tip ff285598
 * evidence through Git-anchored reviewed-candidate blob certificates, execute
 * verify:messi-slice1d-fortress-closeout, expose finite audit/source
 * workstream completion on G_FORTRESS_PARENT only, and keep that parent
 * partial while matrix 3 unproven / 4 vulnerable, live KV/deploy activation,
 * production tenant/security proof, drills, and operated readiness remain
 * missing. Ledger semantic changes are FORTRESS-confined: the five unrelated
 * gate objects stay byte-identical to master basis 28ba003a (including
 * G_FOUNDATION_PARENT.finite_staging_workstream_complete and
 * G_MESSI_MILESTONE_CLOSEOUT.workstream_class). Frozen score 0/4/2, RADAR
 * formal 0/9/0, and false production/MESSI completion are preserved.
 *
 * Post-merge tip scope: immutable reviewed-candidate blob certificates at HEAD.
 * Never infer 1A/1E scope from MASTER_BASIS..HEAD path allowlists (concurrent
 * unrelated master commits after the squash — e.g. #147 — are irrelevant).
 *
 * Parent milestones are never marked complete from labels, summaries, or
 * self-authored booleans — only from inventory + exact hash binding + real
 * retained gate execution + deterministic classification with explicit missing
 * proof.
 *
 * Threat boundary (honest): module.exports is recursively deep-frozen. This
 * does NOT defend against require.cache replacement or rewriting this file
 * before load.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawnSync } = require('child_process');
const blobCerts = require('./reviewed-candidate-blob-certificates');
const { commitTree } = require('./git-identity-commit-tree');

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function thaw(value) {
  return deepClone(value);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function sha256File(absPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

const SLICE = 'MESSI-1E';
const BRANCH = 'messi/slice-1e-fortress-wiring';
const OUTCOME_ID = '1E_fortress_finite_closeout_ledger_wiring';
/** Master tip this slice starts from (#151 blob-certificate anchor). */
const MASTER_BASIS = '28ba003acc57bd732df17d799a95a4d99f69f2f9';
/** Git-anchored whole-path redesign pin (never frozen_only / fixture trust root). */
const redesignPin = require('./breakglass-redesign-candidate-sha');
/**
 * Exact reviewed 1E candidate (pre-squash tip of messi/slice-1e-fortress-wiring).
 * Tip scope binds via immutable reviewed-candidate blob certificates and
 * candidate-path blob equality with the squash landing — never
 * MASTER_BASIS..HEAD path allowlists or ancestry inference.
 */
const REVIEWED_CANDIDATE = redesignPin.SQUASH_PROOF_REVIEWED_CANDIDATE
  || '9a35afcc6b94fc4bf49a96b11654c6e8ec424bb1';
/** Squash-merge tip on master for this slice (PR #154). */
const LANDING_TIP = redesignPin.SQUASH_PROOF_LANDING_TIP
  || 'c61bc9feba412de8e24cd14b5907bd62b65abd13';
/** Break-glass correction candidate (immutable reviewed-candidate blob certificates). */
const CORRECTION_CANDIDATE_53C1 = '53c1abcfb67edb491c5100de571260c60813aec4';
const PROGRESS_CLASS = 'fortress_finite_closeout_ledger_wiring_only';
/** Preserved from base 28ba003a / 98202775 — not overwritten by 1E progress_class. */
const MESSI_CLOSEOUT_WORKSTREAM_CLASS = 'acceptance_ledger_inventory_and_verifier_only';

/** Reviewed FOUNDATION 1B squash candidate (same tree as 1B merge tip). */
const FOUNDATION_1B_MERGE_TIP = '98202775a57e64597e0e606a6e58933bb8ba7250';
const FOUNDATION_1B_CANDIDATE_SHA = '4a550b44bb7669a860557f0ec211260d7b76250c';
const FOUNDATION_1B_MASTER_BASIS = '6106c27c54e25a8e4ba5ba00178d20be0c3e55f5';

/** Reviewed FORTRESS 1D candidate + squash-merge tip on master (PR #148). */
const FORTRESS_1D_MERGE_TIP = 'ff285598ac2cfec980e8316e772924a9c79a6a7e';
const FORTRESS_1D_CANDIDATE_SHA = 'fa2c5d71ad6c662b4c4f60b08ede409064acf2fe';
const FORTRESS_1D_MASTER_BASIS = '949be24936c3056b19904904f98feccab5caf883';

const GATE_IDS = Object.freeze([
  'G_FOUNDATION_PARENT',
  'G_FORTRESS_PARENT',
  'G_RADAR_PARENT',
  'G_FACTORY_PARENT',
  'G_CROSS_PARENT_INTEGRATION',
  'G_MESSI_MILESTONE_CLOSEOUT',
]);

/** Non-FORTRESS gates — must remain byte-identical to master basis 28ba003a ledger. */
const UNRELATED_GATE_IDS = Object.freeze([
  'G_FOUNDATION_PARENT',
  'G_RADAR_PARENT',
  'G_FACTORY_PARENT',
  'G_CROSS_PARENT_INTEGRATION',
  'G_MESSI_MILESTONE_CLOSEOUT',
]);

/**
 * Exact unrelated gate objects from fixtures/messi-acceptance/slice1a-ledger.json
 * at master basis 28ba003a (pre-1E). Semantic ledger confinement proof target.
 */
const BASE_UNRELATED_GATE_OBJECTS = Object.freeze([
  Object.freeze({
    id: 'G_FOUNDATION_PARENT',
    verdict: 'partial',
    parent: 'FOUNDATION',
    workstream_class: 'finite_staging_schema_migration_recovery_closeout',
    production_readiness: 'absent',
    finite_closeout_analog: 'verify:messi-slice1b-foundation-closeout',
    finite_staging_workstream_complete: true,
    missing_proof: Object.freeze([
      'docker_fresh_db_replacement_proof',
      'production_schema_readiness',
      'live_restore_drill',
      'operated_readiness',
    ]),
  }),
  Object.freeze({
    id: 'G_RADAR_PARENT',
    verdict: 'partial',
    parent: 'RADAR',
    workstream_class: 'finite_milestone_closeout_staging_readiness_only',
    production_readiness: 'absent',
    finite_closeout_analog: 'verify:radar-slice16ap-finite-closeout',
    missing_proof: Object.freeze([
      'formal_gates_raised_from_partial_to_proven',
      'production_only_unknowns_closed',
      'full_G06_proven_forbidden_by_16AP',
      'production_ready_claim_forbidden_by_16AP',
    ]),
  }),
  Object.freeze({
    id: 'G_FACTORY_PARENT',
    verdict: 'partial',
    parent: 'FACTORY',
    workstream_class: 'finite_offline_dry_run_packaging_closeout',
    production_readiness: 'absent',
    finite_closeout_analog: 'verify:factory-slice1e-finite-closeout',
    missing_proof: Object.freeze([
      'third_tenant_live_or_prod_onboarding',
      'apply_or_disk_materialization',
      'RADAR_reopen_third_tenant_factory_clearance',
      'production_client_productization_readiness',
    ]),
  }),
  Object.freeze({
    id: 'G_CROSS_PARENT_INTEGRATION',
    verdict: 'absent',
    parent: null,
    workstream_class: 'none',
    production_readiness: 'absent',
    finite_closeout_analog: null,
    missing_proof: Object.freeze([
      'committed_cross_parent_integration_proof',
      'composed_foundation_fortress_radar_factory_production_evidence',
      'end_to_end_live_staging_integration_beyond_parent_silos',
    ]),
  }),
  Object.freeze({
    id: 'G_MESSI_MILESTONE_CLOSEOUT',
    verdict: 'absent',
    parent: null,
    workstream_class: MESSI_CLOSEOUT_WORKSTREAM_CLASS,
    production_readiness: 'absent',
    finite_closeout_analog: null,
    missing_proof: Object.freeze([
      'all_parent_messi_gates_complete',
      'cross_parent_integration_complete',
      'production_readiness_proven',
      'radar_formal_gates_no_longer_partial',
    ]),
  }),
]);

const VERDICTS = Object.freeze(['complete', 'partial', 'absent']);

const FROZEN_MESSI_SCORE = Object.freeze({
  proven: 0,
  partial: 4,
  absent: 2,
  total: 6,
});

/** RADAR formal truth must remain exactly this — never raised by MESSI. */
const RADAR_FORMAL_SCORE = Object.freeze({
  proven: 0,
  partial: 9,
  absent: 0,
  total: 9,
});

const FORTRESS_MATRIX_VERDICT_COUNTS = Object.freeze({
  proven_fail_closed: 5,
  proven_isolated_by_runtime: 3,
  unproven: 3,
  vulnerable: 4,
  total: 15,
});

const PACKAGE_JSON_ALLOWED_SCRIPT_KEY = 'verify:messi-slice1a-acceptance-ledger';
const PACKAGE_JSON_ALLOWED_SCRIPT_VALUE =
  'node scripts/verify-messi-slice1a-acceptance-ledger.js';
const PACKAGE_JSON_1C_SCRIPT_KEY = 'verify:messi-slice1c-foundation-wiring';
const PACKAGE_JSON_1C_SCRIPT_VALUE =
  'node scripts/verify-messi-slice1a-acceptance-ledger.js';
const PACKAGE_JSON_1E_SCRIPT_KEY = 'verify:messi-slice1e-fortress-wiring';
const PACKAGE_JSON_1E_SCRIPT_VALUE =
  'node scripts/verify-messi-slice1a-acceptance-ledger.js';

const SCOPE_FENCE = Object.freeze({
  allowed: Object.freeze([
    'docs',
    'fixtures',
    'independent_verifier',
    'parent_inventory',
    'exact_hash_binding',
    'parent_sha_provenance',
    'retained_offline_gate_execution',
    'deterministic_classification',
    'package_json_verifier_script_registration',
  ]),
  forbids: Object.freeze([
    'product_runtime_template_behavior',
    'deploy',
    'db_mutation',
    'cloud_mutation',
    'network_live_action',
    'production_access',
    'raising_radar_formal_gates',
    'self_authored_parent_completion_booleans',
    'label_or_summary_completion',
  ]),
});

/**
 * Canonical parent inventory. completion_boolean is intentionally omitted —
 * classifiers derive verdicts; fixtures must not ship parent_complete flags.
 */
/**
 * Parent SHA provenance (cryptographic — not declarative-only):
 * - canonical_tip + candidate_sha are bound into lock + ledger
 * - provenance_bound_files blobs at canonical_tip must equal BOUND_FILE_HASHES
 * - each canonical_tip must be an ancestor of MESSI MASTER_BASIS
 * - candidate_sha must be an ancestor of canonical_tip (identity OK when equal)
 *
 * Tip-scope verifier/lock mutations are certified via reviewed-candidate blob
 * certificates — not parent-tip provenance_bound_files.
 */
const PARENTS = Object.freeze({
  FOUNDATION: Object.freeze({
    id: 'FOUNDATION',
    title: 'Sunset schema / Phase D foundation workstream',
    tip_slice: 'MESSI-1B',
    outcome_id: '1B_foundation_finite_workstream_closeout',
    master_basis: FOUNDATION_1B_MASTER_BASIS,
    // Squash-merge on master (1B PR #145). Candidate is the reviewed branch tip;
    // same tree as merge (not a git ancestor — squash).
    canonical_tip: FOUNDATION_1B_MERGE_TIP,
    candidate_sha: FOUNDATION_1B_CANDIDATE_SHA,
    tip_sha_on_master: FOUNDATION_1B_MERGE_TIP,
    workstream_class: 'finite_staging_schema_migration_recovery_closeout',
    finite_closeout_analog: 'verify:messi-slice1b-foundation-closeout',
    production_readiness: 'absent',
    docs: Object.freeze([
      'docs/FOUNDATION-FINITE-CLOSEOUT.md',
    ]),
    evidence: Object.freeze([
      'fixtures/foundation-closeout/finite-closeout.json',
      'fixtures/foundation-closeout/contract.json',
      'fixtures/foundation-closeout/findings.md',
    ]),
    // Tip-blob provenance at 1B merge (parent evidence only).
    provenance_bound_files: Object.freeze([
      'docs/FOUNDATION-FINITE-CLOSEOUT.md',
      'fixtures/foundation-closeout/finite-closeout.json',
      'fixtures/foundation-closeout/contract.json',
      'fixtures/foundation-closeout/findings.md',
    ]),
    lock_module: 'scripts/lib/messi-slice1b-foundation-closeout.js',
    verifier_script: 'scripts/verify-messi-slice1b-foundation-closeout.js',
    npm_script: 'verify:messi-slice1b-foundation-closeout',
    retained_gates: Object.freeze([
      Object.freeze({
        id: 'foundation_1b_finite_closeout',
        kind: 'node',
        script: 'scripts/verify-messi-slice1b-foundation-closeout.js',
        npm: 'verify:messi-slice1b-foundation-closeout',
      }),
    ]),
    // Finite staging closeout is wired; parent stays incomplete without these.
    missing_proof_for_complete: Object.freeze([
      'docker_fresh_db_replacement_proof',
      'production_schema_readiness',
      'live_restore_drill',
      'operated_readiness',
    ]),
  }),
  FORTRESS: Object.freeze({
    id: 'FORTRESS',
    title: 'Tenant identity / confused-deputy boundary workstream',
    tip_slice: 'MESSI-1D',
    audit_slice: 'FORTRESS-15A',
    outcome_id: '1D_fortress_finite_audit_workstream_closeout',
    master_basis: FORTRESS_1D_MASTER_BASIS,
    // Squash-merge on master (1D PR #148). Candidate is the reviewed branch tip;
    // concurrent #147 means whole trees differ — provenance_bound_files blobs match.
    canonical_tip: FORTRESS_1D_MERGE_TIP,
    candidate_sha: FORTRESS_1D_CANDIDATE_SHA,
    tip_sha_on_master: FORTRESS_1D_MERGE_TIP,
    workstream_class: 'finite_fortress_audit_workstream_closeout',
    finite_closeout_analog: 'verify:messi-slice1d-fortress-closeout',
    production_readiness: 'absent',
    docs: Object.freeze([
      'docs/FORTRESS-FINITE-CLOSEOUT.md',
    ]),
    evidence: Object.freeze([
      'fixtures/fortress-closeout/finite-closeout.json',
      'fixtures/fortress-closeout/contract.json',
      'fixtures/fortress-closeout/findings.md',
    ]),
    provenance_bound_files: Object.freeze([
      'docs/FORTRESS-FINITE-CLOSEOUT.md',
      'fixtures/fortress-closeout/finite-closeout.json',
      'fixtures/fortress-closeout/contract.json',
      'fixtures/fortress-closeout/findings.md',
    ]),
    lock_module: 'scripts/lib/messi-slice1d-fortress-closeout.js',
    verifier_script: 'scripts/verify-messi-slice1d-fortress-closeout.js',
    npm_script: 'verify:messi-slice1d-fortress-closeout',
    retained_gates: Object.freeze([
      Object.freeze({
        id: 'fortress_1d_finite_closeout',
        kind: 'node',
        script: 'scripts/verify-messi-slice1d-fortress-closeout.js',
        npm: 'verify:messi-slice1d-fortress-closeout',
      }),
    ]),
    // Finite audit closeout is wired; parent stays incomplete without these.
    missing_proof_for_complete: Object.freeze([
      'matrix_unproven_cleared_to_proven_fail_closed',
      'matrix_vulnerable_remediated',
      '15L_live_kv_secret_creation_and_staff_api_deploy_activation',
      'B02_meta_live_client_slug_authority_activation',
      'production_tenant_boundary_proof',
      'security_drills',
      'operated_readiness',
    ]),
    locked_matrix_counts: FORTRESS_MATRIX_VERDICT_COUNTS,
  }),
  RADAR: Object.freeze({
    id: 'RADAR',
    title: 'Operations gate ledger / staging-readiness workstream',
    tip_slice: 'RADAR-16AP',
    outcome_id: '16AP_finite_milestone_closeout',
    master_basis: '66e34a5833ff3bcc7f297108f594b4fc58a0eccc',
    // Reviewed PR candidate; bound artifact tip is post-correction master tip.
    candidate_sha: '7870a9fb818bbd94d33b291c8782851276e2715e',
    canonical_tip: '7e56a99a2d69e13bf1a764090e4033195e189641',
    tip_sha_on_master: '7e56a99a2d69e13bf1a764090e4033195e189641',
    workstream_class: 'finite_milestone_closeout_staging_readiness_only',
    finite_closeout_analog: 'verify:radar-slice16ap-finite-closeout',
    production_readiness: 'absent',
    formal_score: RADAR_FORMAL_SCORE,
    docs: Object.freeze([
      'docs/RADAR-OPERATIONS-GATE-LEDGER.md',
    ]),
    evidence: Object.freeze([
      'fixtures/radar-operations/slice16ap-finite-closeout.json',
      'fixtures/radar-operations/slice16ap-expected-contract.json',
    ]),
    provenance_bound_files: Object.freeze([
      'docs/RADAR-OPERATIONS-GATE-LEDGER.md',
      'fixtures/radar-operations/slice16ap-finite-closeout.json',
      'fixtures/radar-operations/slice16ap-expected-contract.json',
      'scripts/lib/radar-slice16ap-finite-closeout.js',
      'scripts/verify-radar-slice16ap-finite-closeout.js',
    ]),
    lock_module: 'scripts/lib/radar-slice16ap-finite-closeout.js',
    verifier_script: 'scripts/verify-radar-slice16ap-finite-closeout.js',
    npm_script: 'verify:radar-slice16ap-finite-closeout',
    retained_gates: Object.freeze([
      Object.freeze({
        id: 'radar_16ap_finite_closeout',
        kind: 'node',
        script: 'scripts/verify-radar-slice16ap-finite-closeout.js',
        npm: 'verify:radar-slice16ap-finite-closeout',
      }),
    ]),
    missing_proof_for_complete: Object.freeze([
      'formal_gates_raised_from_partial_to_proven',
      'production_only_unknowns_closed',
      'full_G06_proven_forbidden_by_16AP',
      'production_ready_claim_forbidden_by_16AP',
    ]),
  }),
  FACTORY: Object.freeze({
    id: 'FACTORY',
    title: 'Client productization offline dry-run workstream',
    tip_slice: 'FACTORY-1E',
    outcome_id: '1E_dry_run_proof_packaging_milestone_closeout',
    master_basis: 'e8452d178ad8f4b6aadc8b59b2d3032634952471',
    canonical_tip: '14facf5d54be8767cf9aca4d69a880f28ea3dc2e',
    candidate_sha: '14facf5d54be8767cf9aca4d69a880f28ea3dc2e',
    tip_sha_on_master: '14facf5d54be8767cf9aca4d69a880f28ea3dc2e',
    workstream_class: 'finite_offline_dry_run_packaging_closeout',
    finite_closeout_analog: 'verify:factory-slice1e-finite-closeout',
    production_readiness: 'absent',
    docs: Object.freeze([
      'docs/FACTORY-CLIENT-PRODUCTIZATION.md',
    ]),
    evidence: Object.freeze([
      'fixtures/factory-client-productization/slice1e-contract.json',
      'fixtures/factory-client-productization/slice1e-findings.md',
      'fixtures/factory-client-productization/slice1e-operator-handoff.md',
      'fixtures/factory-client-productization/slice1e-artifact-lock.json',
      'fixtures/factory-client-productization/slice1e-third-tenant-dry-run-stdout.json',
      'scripts/lib/factory-slice1b-archetype-templates.js',
      'scripts/lib/factory-slice1c-dry-run-generator.js',
      'scripts/lib/factory-slice1d-integration-proof.js',
      'scripts/lib/factory-slice1e-finite-closeout.js',
    ]),
    // Tip-blob provenance is parent evidence only (not tip-scope cert paths).
    provenance_bound_files: Object.freeze([
      'docs/FACTORY-CLIENT-PRODUCTIZATION.md',
      'fixtures/factory-client-productization/slice1e-contract.json',
      'fixtures/factory-client-productization/slice1e-findings.md',
      'fixtures/factory-client-productization/slice1e-operator-handoff.md',
      'fixtures/factory-client-productization/slice1e-artifact-lock.json',
      'fixtures/factory-client-productization/slice1e-third-tenant-dry-run-stdout.json',
    ]),
    lock_module: 'scripts/lib/factory-slice1e-finite-closeout.js',
    verifier_script: 'scripts/verify-factory-slice1e-finite-closeout.js',
    npm_script: 'verify:factory-slice1e-finite-closeout',
    retained_gates: Object.freeze([
      Object.freeze({
        id: 'factory_1e_finite_closeout',
        kind: 'node',
        script: 'scripts/verify-factory-slice1e-finite-closeout.js',
        npm: 'verify:factory-slice1e-finite-closeout',
      }),
    ]),
    missing_proof_for_complete: Object.freeze([
      'third_tenant_live_or_prod_onboarding',
      'apply_or_disk_materialization',
      'RADAR_reopen_third_tenant_factory_clearance',
      'production_client_productization_readiness',
    ]),
  }),
});

const MESSI_GATES = Object.freeze([
  Object.freeze({
    id: 'G_FOUNDATION_PARENT',
    parent: 'FOUNDATION',
    title: 'FOUNDATION parent evidence binding + retained gate',
    requirement:
      'Inventory FOUNDATION 1B finite closeout, bind exact 1B merge/candidate tip blobs, run verify:messi-slice1b-foundation-closeout, expose finite staging-workstream completion, and keep parent partial while Docker fresh-db, production schema, live restore/drill, and operated-readiness remain missing. Do not mark complete from labels.',
  }),
  Object.freeze({
    id: 'G_FORTRESS_PARENT',
    parent: 'FORTRESS',
    title: 'FORTRESS parent evidence binding + retained gates',
    requirement:
      'Inventory FORTRESS 1D finite audit closeout, bind exact 1D candidate fa2c5d71 + merge tip ff285598 evidence blobs, run verify:messi-slice1d-fortress-closeout, expose finite audit/source workstream completion, and keep parent partial while matrix 3 unproven / 4 vulnerable, live KV/deploy, production tenant/security proof, drills, and operated readiness remain missing. Do not mark complete from labels or treat finite audit as security readiness.',
  }),
  Object.freeze({
    id: 'G_RADAR_PARENT',
    parent: 'RADAR',
    title: 'RADAR parent evidence binding + formal 0/9/0 truth',
    requirement:
      'Inventory RADAR 16AP closeout, bind hashes, run verify:radar-slice16ap-finite-closeout, and preserve formal score proven=0/partial=9/absent=0. Staging-readiness exit is not production readiness.',
  }),
  Object.freeze({
    id: 'G_FACTORY_PARENT',
    parent: 'FACTORY',
    title: 'FACTORY parent evidence binding + retained closeout gate',
    requirement:
      'Inventory FACTORY 1E finite offline closeout, bind hashes, run verify:factory-slice1e-finite-closeout, and treat offline closeout as distinct from live/prod readiness.',
  }),
  Object.freeze({
    id: 'G_CROSS_PARENT_INTEGRATION',
    parent: null,
    title: 'Cross-parent integration proof',
    requirement:
      'Committed proof that FOUNDATION+FORTRESS+RADAR+FACTORY compose into an integrated production-ready system. Slice 1A inventories only — does not invent integration proof.',
  }),
  Object.freeze({
    id: 'G_MESSI_MILESTONE_CLOSEOUT',
    parent: null,
    title: 'MESSI milestone closeout',
    requirement:
      'MESSI closes only when all parent MESSI gates are complete with production-grade proof. Slice 1A freezes the ledger; MESSI remains absent.',
  }),
]);

/** Exact sha256 pins for parent-bound committed files (recomputed by verifier). */
const BOUND_FILE_HASHES = Object.freeze({
  'docs/FOUNDATION-FINITE-CLOSEOUT.md':
    '9381b71ee596a6cb14942d014da11dbbc607b3d9f3108155e67d3a08dbe577cc',
  'fixtures/foundation-closeout/finite-closeout.json':
    '3411701e798e863e7d3d1583963336f0d19fe740823f07280060230a500a9e52',
  'fixtures/foundation-closeout/contract.json':
    '3e2d2520e4c497b7ec17b76669cc29703b3c1eb7a890125b007dd805a5503e40',
  'fixtures/foundation-closeout/findings.md':
    '8dc32ea7e17a7b75f224b7f908f04c0ed467a9a6feb8df8223125bdd5dd7f439',
  'scripts/lib/messi-slice1b-foundation-closeout.js':
    '4a1d5c368676c4d728b66f7c869a4e229b254edafac960bdf701d7e12b20d15b',
  'scripts/verify-messi-slice1b-foundation-closeout.js':
    '19d03e5e482ea4b8f8bb25c1bbb3e53ccae17a4b712ca6bdea631c559b2fbcac',
  'docs/FORTRESS-FINITE-CLOSEOUT.md':
    'e5eea1639d80a11bd6c16782db88c8da388bbd5dd8b655ef5b7014b3ee59a0ab',
  'fixtures/fortress-closeout/finite-closeout.json':
    '8e65993bac48effd75ab016f50c7f15500b47faa9517972dd599670181f5bad5',
  'fixtures/fortress-closeout/contract.json':
    '8801c4a5a198231ccd5c29b1e28b3bd0194a8a06fcd9ac7ee18cef5f652800e7',
  'fixtures/fortress-closeout/findings.md':
    '5b57d89556f490697d72ae75348e468692a4c1df6a01434f3bb3c881ecb8da1b',
  'scripts/lib/messi-slice1d-fortress-closeout.js':
    'cd64f6bffc79f5d3ac5d607afd6f3d2d23b615288c7deecd2791f219b199f3d1',
  'scripts/verify-messi-slice1d-fortress-closeout.js':
    '7e6f65264984961d504c2e2881417eab361538f9b9ba66d10fa564588b2ca05e',
  'docs/RADAR-OPERATIONS-GATE-LEDGER.md':
    'c3aac5ad4a083868a3350a5ca099447faed0f016f3ee92570997e2533747e5d9',
  'fixtures/radar-operations/slice16ap-finite-closeout.json':
    '158e3418cc573852780766cc78dafdfa427a3e9a27e0a14e3036266bde91ece2',
  'fixtures/radar-operations/slice16ap-expected-contract.json':
    'ad856cfe50b1eb8f6a535bdc137ec4a23daa6d89d8bcd0b2a4b90103a95f8621',
  'scripts/lib/radar-slice16ap-finite-closeout.js':
    '4ba18280ac6b595921e20e1f9989662d6379456eb6f24303a2ab71dd2302bf77',
  'scripts/verify-radar-slice16ap-finite-closeout.js':
    '8a4d0b03bae605c0370c1bdbbcbce501a1bdf7710a9006005638ebc24fc51bfc',
  'docs/FACTORY-CLIENT-PRODUCTIZATION.md':
    '3a5c44e0f247fb1ca35397f3e1faaa0f9c9e26b9bcd80271671a6874cea38265',
  'fixtures/factory-client-productization/slice1e-contract.json':
    '2cc3a5992207070e4f6212a8c30f0d4aed44056c226d6bfe911a6e5f6088b717',
  'fixtures/factory-client-productization/slice1e-findings.md':
    '792b739448e7148769ff36bd24fc1bf22b0ca05ba9c6ccfe4ff7e040e146c12b',
  'fixtures/factory-client-productization/slice1e-operator-handoff.md':
    '845c9fb43c8aadee65dd54e3b403dd8e523810b4c84a6f4fcf20c28d6b4d3163',
  'fixtures/factory-client-productization/slice1e-artifact-lock.json':
    'fad80e4f02dce0c0e9047a31326220889555948c0eeaefc0536720b626ca2901',
  'fixtures/factory-client-productization/slice1e-third-tenant-dry-run-stdout.json':
    '1204d0f32729f2e5f258908e84ea0735bdb5bb3ab1b1c360751691a233ef99cd',
  'scripts/lib/factory-slice1b-archetype-templates.js':
    '1e3683e9cbb9027f74d17390ce98c241a8bfbe09599b93e6bd83573bc237f624',
  'scripts/lib/factory-slice1c-dry-run-generator.js':
    'c6864be5c9770c8b05915ca8d892a1a4f5768e012afb32a458f4ad6a3f6be879',
  'scripts/lib/factory-slice1d-integration-proof.js':
    '0db5a8d0aedf9418ef58dc1d842a558059c5c58d5f85a3465d92aeec159da8d8',
  'scripts/lib/factory-slice1e-finite-closeout.js':
    '6016f1b42190aca2d4466162aaf747a05b2ccf33b30f67bef6af9052741ba3f7',
  'scripts/verify-factory-slice1e-finite-closeout.js':
    '99207f55880b52a859e3169b9c3167b11995cb17804ac858e4e0da5d6c809b1d',
});

const ARTIFACT_RELS = Object.freeze({
  doc: 'docs/MESSI-ACCEPTANCE-LEDGER.md',
  contract: 'fixtures/messi-acceptance/slice1a-contract.json',
  ledger: 'fixtures/messi-acceptance/slice1a-ledger.json',
  findings: 'fixtures/messi-acceptance/slice1a-findings.md',
  lock_module: 'scripts/lib/messi-slice1a-acceptance-ledger.js',
  verifier: 'scripts/verify-messi-slice1a-acceptance-ledger.js',
});

const SELF_REF_FORBIDDEN_PREFIXES = Object.freeze([
  'fixtures/messi-acceptance/',
  'docs/MESSI-ACCEPTANCE-LEDGER.md',
  'scripts/lib/messi-slice1a-acceptance-ledger.js',
  'scripts/verify-messi-slice1a-acceptance-ledger.js',
]);

function rootJoin(root, ...parts) {
  return path.join(root, ...parts);
}

function listBoundRels() {
  return Object.keys(BOUND_FILE_HASHES).sort();
}

function recomputeBoundHashes(root) {
  const out = {};
  const errors = [];
  for (const rel of listBoundRels()) {
    const abs = rootJoin(root, rel);
    if (!fs.existsSync(abs)) {
      errors.push(`missing:${rel}`);
      continue;
    }
    out[rel] = sha256File(abs);
    if (out[rel] !== BOUND_FILE_HASHES[rel]) {
      errors.push(`hash_mismatch:${rel}:got=${out[rel]}:expected=${BOUND_FILE_HASHES[rel]}`);
    }
  }
  return { hashes: out, errors, ok: errors.length === 0 };
}

function resolveCommitSha(root, sha) {
  const raw = String(sha || '').trim();
  if (!/^[0-9a-f]{7,40}$/i.test(raw)) return null;
  try {
    return execSync(`git rev-parse --verify ${raw}^{commit}`, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (_) {
    return null;
  }
}

function isGitAncestor(root, ancestor, descendant) {
  try {
    execSync(`git merge-base --is-ancestor ${ancestor} ${descendant}`, {
      cwd: root,
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
    });
    return true;
  } catch (_) {
    return false;
  }
}

/** True when two commits point at the identical tree (squash-merge equivalent). */
function sameGitTree(root, shaA, shaB) {
  try {
    const a = execSync(`git rev-parse ${shaA}^{tree}`, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const b = execSync(`git rev-parse ${shaB}^{tree}`, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return Boolean(a) && a === b;
  } catch (_) {
    return false;
  }
}

/**
 * Candidate must be ancestor of tip, identical to tip, same-tree (clean squash),
 * or path-filtered blob-identical on provenance_bound_files (concurrent-merge
 * squash where unrelated paths diverge — e.g. #147 between 1D candidate and tip).
 */
function sameBoundBlobsAtCommits(root, shaA, shaB, paths) {
  if (!Array.isArray(paths) || paths.length === 0) return false;
  for (const rel of paths) {
    const a = gitBlobSha256AtCommit(root, shaA, rel);
    const b = gitBlobSha256AtCommit(root, shaB, rel);
    if (!a.ok || !b.ok || a.sha256 !== b.sha256) return false;
  }
  return true;
}

function candidateFitsTip(root, candidateSha, tipSha, boundPaths) {
  if (!candidateSha || !tipSha) return false;
  if (candidateSha === tipSha) return true;
  if (isGitAncestor(root, candidateSha, tipSha)) return true;
  if (sameGitTree(root, candidateSha, tipSha)) return true;
  if (Array.isArray(boundPaths) && boundPaths.length > 0) {
    return sameBoundBlobsAtCommits(root, candidateSha, tipSha, boundPaths);
  }
  return false;
}

function assertShaAncestor(root, sha, descendant) {
  const tip = descendant || 'HEAD';
  const resolved = resolveCommitSha(root, sha);
  if (!resolved) return { ok: false, detail: `missing_ref:${sha}` };
  if (!isGitAncestor(root, resolved, tip)) {
    return { ok: false, detail: `not_ancestor:${resolved}:${tip}` };
  }
  return { ok: true, sha: resolved };
}

function assertCandidateFitsTip(root, candidate, tip, boundPaths) {
  const cand = resolveCommitSha(root, candidate);
  const tipSha = resolveCommitSha(root, tip);
  if (!cand) return { ok: false, detail: `missing_ref:candidate:${candidate}` };
  if (!tipSha) return { ok: false, detail: `missing_ref:tip:${tip}` };
  if (!candidateFitsTip(root, cand, tipSha, boundPaths)) {
    return { ok: false, detail: `candidate_not_fit_tip:${cand}:${tipSha}` };
  }
  return { ok: true, candidate: cand, tip: tipSha };
}

function gitBlobSha256AtCommit(root, commitSha, rel) {
  const r = spawnSync('git', ['show', `${commitSha}:${rel}`], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (r.status !== 0) {
    return {
      ok: false,
      detail: String(r.stderr || r.stdout || 'git show failed'),
    };
  }
  return {
    ok: true,
    sha256: crypto.createHash('sha256').update(Buffer.from(r.stdout)).digest('hex'),
  };
}

function currentHeadSha(root) {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  } catch (_) {
    return '';
  }
}

function resolveTipSha(root, tipSha) {
  const raw = String(tipSha || '').trim();
  if (!raw || raw === 'HEAD') return currentHeadSha(root);
  return blobCerts.resolveCommitSha(root, raw);
}

function reviewedBlobCertificateConfig() {
  return {
    slice_cert_id: 'messi-1e-reviewed',
    master_basis: MASTER_BASIS,
    reviewed_candidate: REVIEWED_CANDIDATE,
    binding_tip_sha: LANDING_TIP,
    path_universe: redesignPin.REDESIGN_PATHS,
    correction_candidate: CORRECTION_CANDIDATE_53C1,
    correction_cert_id: 'breakglass-53c1abcf',
    correction_changed_paths: [],
    redesign_cert_id: redesignPin.REDESIGN_CERT_ID,
    redesign_candidate_sha: redesignPin.REDESIGN_CANDIDATE_SHA,
    redesign_paths: redesignPin.REDESIGN_PATHS,
    squash_proof_cert_id: redesignPin.SQUASH_PROOF_CERT_ID,
    squash_proof_candidate_sha: redesignPin.SQUASH_PROOF_CANDIDATE_SHA,
    squash_proof_paths: redesignPin.SQUASH_PROOF_PATHS,
  };
}

/**
 * Build the locked reviewed-candidate blob certificate chain for this slice.
 */
function buildLockedReviewedBlobCertificates(root) {
  return blobCerts.buildSupersedingCertificateChain(root, reviewedBlobCertificateConfig());
}

/**
 * Tip + optional forged chain verification. Branch name is never trusted.
 */
function verifyReviewedBlobCertificatesAtTip(root, opts) {
  const options = opts || {};
  const built = buildLockedReviewedBlobCertificates(root);
  if (!built.ok) {
    return {
      ok: false,
      errors: built.errors,
      certificates: [],
      tipSha: null,
      effective: {},
      source: {},
    };
  }
  const tipSha = resolveTipSha(root, options.tip_sha);
  if (!tipSha) {
    return {
      ok: false,
      errors: ['missing_ref:tip'],
      certificates: built.certificates,
      tipSha: null,
      effective: {},
      source: {},
    };
  }
  return blobCerts.verifyReviewedBlobCertificates(root, {
    certificates: built.certificates,
    claimed_certificates: options.claimed_certificates,
    tip_sha: tipSha,
    branch_name: options.branch_name,
    skip_anchor_validation: options.skip_anchor_validation === true,
  });
}

/**
 * Tip acceptance: effective certificate blobs match tip tree. Branch never trusted.
 */
function tipAcceptsCertificates(root, tipSha, branchName) {
  const built = buildLockedReviewedBlobCertificates(root);
  if (!built.ok) return false;
  const resolved = resolveTipSha(root, tipSha);
  if (!resolved) return false;
  return blobCerts.verifyReviewedBlobCertificates(root, {
    certificates: built.certificates,
    tip_sha: resolved,
    branch_name: branchName,
  }).ok === true;
}

function makeUnrelatedOrphanCommit(root) {
  const tree = execSync(`git rev-parse ${MASTER_BASIS}^{tree}`, {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  return commitTree(root, tree, [], 'messi1a-unrelated-orphan-proof');
}

/**
 * @deprecated Use verifyReviewedBlobCertificatesAtTip — retained for hostile RED fixtures.
 */
function verifyReviewedCandidateScope(root, opts) {
  return verifyReviewedBlobCertificatesAtTip(root, opts);
}

/**
 * @deprecated Superseded by immutable blob certificates at tip.
 */
function verifyMergedProvenance(root, opts) {
  void opts;
  return verifyReviewedBlobCertificatesAtTip(root);
}

/**
 * @deprecated Superseded by verifyReviewedBlobCertificatesAtTip at HEAD.
 */
function verifyWorkingTreeDeltaScope(root, opts) {
  return verifyReviewedBlobCertificatesAtTip(root, opts);
}

/**
 * Cryptographic parent SHA provenance.
 *
 * opts.claimedParents: optional forged claim map
 *   { [parentId]: { canonical_tip?, candidate_sha?, bound_hashes? } }
 * compared against locked PARENTS + BOUND_FILE_HASHES.
 *
 * opts.workingTreeHashes: optional rel->sha256 map (else read filesystem)
 * opts.skipWorkingTreeCheck: skip wt alteration checks
 */
function verifyParentShaProvenance(root, opts) {
  const options = opts || {};
  const claimedParents = options.claimedParents || {};
  const errors = [];
  const perParent = {};

  for (const parentId of Object.keys(PARENTS)) {
    const locked = PARENTS[parentId];
    const claim = claimedParents[parentId] || {};
    const claimTip = claim.canonical_tip || locked.canonical_tip;
    const claimCandidate = claim.candidate_sha || locked.candidate_sha;
    const claimHashes = claim.bound_hashes || BOUND_FILE_HASHES;
    const parentErrors = [];

    const lockedTipSha = resolveCommitSha(root, locked.canonical_tip);
    const lockedCandidateSha = resolveCommitSha(root, locked.candidate_sha);
    if (!lockedTipSha) parentErrors.push(`missing_ref:locked_canonical_tip:${locked.canonical_tip}`);
    if (!lockedCandidateSha) {
      parentErrors.push(`missing_ref:locked_candidate_sha:${locked.candidate_sha}`);
    }

    const tipSha = resolveCommitSha(root, claimTip);
    if (!tipSha) {
      parentErrors.push(`missing_ref:canonical_tip:${claimTip}`);
    }

    const candidateSha = resolveCommitSha(root, claimCandidate);
    if (!candidateSha) {
      parentErrors.push(`missing_ref:candidate_sha:${claimCandidate}`);
    }

    // Exact tip identity — reject stale-but-valid ancestors of the locked tip.
    if (tipSha && lockedTipSha && tipSha !== lockedTipSha) {
      parentErrors.push(`stale_or_wrong_canonical_tip:claimed=${tipSha}:locked=${lockedTipSha}`);
    }
    if (candidateSha && lockedCandidateSha && candidateSha !== lockedCandidateSha) {
      parentErrors.push(
        `stale_or_wrong_candidate_sha:claimed=${candidateSha}:locked=${lockedCandidateSha}`,
      );
    }

    if (tipSha && !isGitAncestor(root, tipSha, MASTER_BASIS)) {
      parentErrors.push(`canonical_tip_not_ancestor_of_messi_base:${tipSha}`);
    }
    if (tipSha && !isGitAncestor(root, tipSha, 'HEAD')) {
      parentErrors.push(`canonical_tip_not_ancestor_of_messi_tip:${tipSha}`);
    }

    if (tipSha && candidateSha && !candidateFitsTip(
      root,
      candidateSha,
      tipSha,
      locked.provenance_bound_files,
    )) {
      parentErrors.push(`mismatched_candidate_tip_pair:${candidateSha}:${tipSha}`);
    }
    // Also enforce locked pair relationship independently of forged claims.
    if (
      lockedTipSha
      && lockedCandidateSha
      && !candidateFitsTip(
        root,
        lockedCandidateSha,
        lockedTipSha,
        locked.provenance_bound_files,
      )
    ) {
      parentErrors.push(
        `locked_mismatched_candidate_tip_pair:${lockedCandidateSha}:${lockedTipSha}`,
      );
    }

    const tipForBlobs = tipSha || lockedTipSha;
    if (tipForBlobs) {
      for (const rel of locked.provenance_bound_files) {
        const expectedLocked = BOUND_FILE_HASHES[rel];
        const expectedClaim = claimHashes[rel];
        if (!expectedLocked) {
          parentErrors.push(`missing_bound_hash_entry:${rel}`);
          continue;
        }
        const tipBlob = gitBlobSha256AtCommit(root, tipForBlobs, rel);
        if (!tipBlob.ok) {
          parentErrors.push(`missing_blob_at_tip:${rel}`);
          continue;
        }
        // Claimed hashes must match the blob at the claimed tip (detects
        // repinned current-tree hashes under a stale tip claim).
        if (expectedClaim && tipBlob.sha256 !== expectedClaim) {
          parentErrors.push(
            `repinned_or_tip_blob_mismatch:${rel}:tip=${tipBlob.sha256}:claimed_hash=${expectedClaim}`,
          );
        }
        // Locked hashes must match the blob at the locked tip.
        if (lockedTipSha) {
          const lockedBlob = gitBlobSha256AtCommit(root, lockedTipSha, rel);
          if (!lockedBlob.ok) {
            parentErrors.push(`missing_blob_at_locked_tip:${rel}`);
          } else if (lockedBlob.sha256 !== expectedLocked) {
            parentErrors.push(
              `locked_tip_blob_mismatch:${rel}:got=${lockedBlob.sha256}:expected=${expectedLocked}`,
            );
          }
        }
        if (!options.skipWorkingTreeCheck) {
          let wtHash = null;
          if (options.workingTreeHashes && options.workingTreeHashes[rel]) {
            wtHash = options.workingTreeHashes[rel];
          } else {
            const abs = rootJoin(root, rel);
            if (!fs.existsSync(abs)) {
              parentErrors.push(`missing_working_tree_file:${rel}`);
              continue;
            }
            wtHash = sha256File(abs);
          }
          if (wtHash !== expectedLocked) {
            parentErrors.push(`altered_parent_file:${rel}:wt=${wtHash}:expected=${expectedLocked}`);
          }
        }
      }
    }


    perParent[parentId] = {
      canonical_tip: tipSha,
      candidate_sha: candidateSha,
      locked_canonical_tip: lockedTipSha,
      locked_candidate_sha: lockedCandidateSha,
      errors: parentErrors,
      ok: parentErrors.length === 0,
    };
    for (const e of parentErrors) errors.push(`${parentId}:${e}`);
  }

  return { ok: errors.length === 0, errors, perParent };
}

function runRetainedGate(root, gate, timeoutMs) {
  const scriptAbs = rootJoin(root, gate.script);
  const started = Date.now();
  const r = spawnSync(process.execPath, [scriptAbs], {
    cwd: root,
    encoding: 'utf8',
    timeout: timeoutMs || 900000,
    env: { ...process.env, MESSI_NESTED_GATE: '1' },
  });
  return {
    id: gate.id,
    script: gate.script,
    npm: gate.npm,
    status: r.status,
    signal: r.signal || null,
    ok: r.status === 0,
    elapsed_ms: Date.now() - started,
    stdout_tail: String(r.stdout || '').slice(-400),
    stderr_tail: String(r.stderr || '').slice(-400),
  };
}

function runAllRetainedGates(root) {
  const results = {};
  for (const parentId of Object.keys(PARENTS)) {
    const parent = PARENTS[parentId];
    results[parentId] = parent.retained_gates.map((g) => {
      // FOUNDATION 1B nests 14AE; FORTRESS 1D nests 15A+15L; FACTORY nests 1A–1D.
      const timeout = (parentId === 'FACTORY' || parentId === 'FOUNDATION'
        || parentId === 'FORTRESS')
        ? 1200000
        : 180000;
      return runRetainedGate(root, g, timeout);
    });
  }
  return results;
}

function parentGatesAllPass(gateResults) {
  return Array.isArray(gateResults) && gateResults.length > 0 && gateResults.every((g) => g.ok);
}

function parentEvidenceSelfReferential(parent) {
  const paths = []
    .concat(parent.docs || [])
    .concat(parent.evidence || [])
    .concat(parent.verifier_script ? [parent.verifier_script] : [])
    .concat(parent.audit_verifier_script ? [parent.audit_verifier_script] : [])
    .concat(parent.lock_module ? [parent.lock_module] : []);
  return paths.filter((p) => SELF_REF_FORBIDDEN_PREFIXES.some((pref) => (
    pref.endsWith('/') ? p.startsWith(pref) : p === pref
  )));
}

/**
 * Sole production classifier. Never trusts ledger-authored parent_complete
 * booleans. Verdicts require hash binding + retained gate exit 0 + honesty
 * about finite vs production.
 */
function classifyMessiGates(opts) {
  const {
    hashBindingOk,
    gateResults,
    radarFormalScore,
    fortressMatrixCounts,
  } = opts;

  const errors = [];
  if (!hashBindingOk) errors.push('hash_binding_failed');

  if (!deepEqual(radarFormalScore, RADAR_FORMAL_SCORE)) {
    errors.push('radar_formal_score_drift');
  }
  if (!deepEqual(fortressMatrixCounts, FORTRESS_MATRIX_VERDICT_COUNTS)) {
    errors.push('fortress_matrix_count_drift');
  }

  for (const parentId of Object.keys(PARENTS)) {
    const selfHits = parentEvidenceSelfReferential(PARENTS[parentId]);
    if (selfHits.length) errors.push(`self_referential_parent_evidence:${parentId}:${selfHits.join(',')}`);
  }

  const gates = [];

  function pushParentGate(gateId, parentId) {
    const parent = PARENTS[parentId];
    const results = gateResults[parentId] || [];
    const gatesPass = parentGatesAllPass(results);
    const missing = [...parent.missing_proof_for_complete];
    let verdict = 'absent';
    if (!hashBindingOk || !gatesPass) {
      verdict = 'absent';
      if (!gatesPass) missing.unshift('retained_gate_exit_nonzero_or_missing');
      if (!hashBindingOk) missing.unshift('exact_file_hash_binding_failed');
    } else {
      // Retained gates pass + hashes bind, but production unknowns / matrix
      // gaps (FORTRESS) or formal partials (RADAR) or offline-only closeout
      // (FACTORY) or FOUNDATION production/Docker/restore/operated unknowns
      // keep MESSI parent gates partial. Finite staging (FOUNDATION) and
      // finite audit (FORTRESS) completion are exposed separately — never as
      // parent complete or security/production readiness.
      verdict = 'partial';
    }
    const gate = {
      id: gateId,
      verdict,
      parent: parentId,
      workstream_class: parent.workstream_class,
      production_readiness: parent.production_readiness,
      finite_closeout_analog: parent.finite_closeout_analog,
      retained_gate_results: results.map((r) => ({
        id: r.id,
        script: r.script,
        status: r.status,
        ok: r.ok,
        elapsed_ms: r.elapsed_ms,
      })),
      missing_proof: missing,
    };
    // Finite staging completion is FOUNDATION-only — never leak onto other parents.
    if (parentId === 'FOUNDATION') {
      gate.finite_staging_workstream_complete = parent.workstream_class
          === 'finite_staging_schema_migration_recovery_closeout'
        && parent.finite_closeout_analog === 'verify:messi-slice1b-foundation-closeout'
        && hashBindingOk
        && gatesPass;
    }
    // Finite audit/source completion is FORTRESS-only — never security readiness.
    if (parentId === 'FORTRESS') {
      gate.finite_audit_workstream_complete = parent.workstream_class
          === 'finite_fortress_audit_workstream_closeout'
        && parent.finite_closeout_analog === 'verify:messi-slice1d-fortress-closeout'
        && hashBindingOk
        && gatesPass;
    }
    gates.push(gate);
  }

  pushParentGate('G_FOUNDATION_PARENT', 'FOUNDATION');
  pushParentGate('G_FORTRESS_PARENT', 'FORTRESS');
  pushParentGate('G_RADAR_PARENT', 'RADAR');
  pushParentGate('G_FACTORY_PARENT', 'FACTORY');

  gates.push({
    id: 'G_CROSS_PARENT_INTEGRATION',
    verdict: 'absent',
    parent: null,
    workstream_class: 'none',
    production_readiness: 'absent',
    finite_closeout_analog: null,
    retained_gate_results: [],
    missing_proof: Object.freeze([
      'committed_cross_parent_integration_proof',
      'composed_foundation_fortress_radar_factory_production_evidence',
      'end_to_end_live_staging_integration_beyond_parent_silos',
    ]),
  });

  gates.push({
    id: 'G_MESSI_MILESTONE_CLOSEOUT',
    verdict: 'absent',
    parent: null,
    // Preserve base 98202775 workstream_class — not 1C progress_class.
    workstream_class: MESSI_CLOSEOUT_WORKSTREAM_CLASS,
    production_readiness: 'absent',
    finite_closeout_analog: null,
    retained_gate_results: [],
    missing_proof: Object.freeze([
      'all_parent_messi_gates_complete',
      'cross_parent_integration_complete',
      'production_readiness_proven',
      'radar_formal_gates_no_longer_partial',
    ]),
  });

  // Hard contract: FOUNDATION parent never complete without production proofs.
  const foundationGate = gates.find((g) => g.id === 'G_FOUNDATION_PARENT');
  if (foundationGate) {
    const requiredMissing = [
      'docker_fresh_db_replacement_proof',
      'production_schema_readiness',
      'live_restore_drill',
      'operated_readiness',
    ];
    for (const m of requiredMissing) {
      if (!foundationGate.missing_proof.includes(m)) {
        errors.push(`foundation_hidden_missing_proof:${m}`);
      }
    }
    if (foundationGate.verdict === 'complete') {
      errors.push('foundation_complete_without_production_proofs');
    }
  }

  // Hard contract: FORTRESS parent never complete / never security-ready from finite audit.
  const fortressGate = gates.find((g) => g.id === 'G_FORTRESS_PARENT');
  if (fortressGate) {
    const requiredMissing = [
      'matrix_unproven_cleared_to_proven_fail_closed',
      'matrix_vulnerable_remediated',
      '15L_live_kv_secret_creation_and_staff_api_deploy_activation',
      'B02_meta_live_client_slug_authority_activation',
      'production_tenant_boundary_proof',
      'security_drills',
      'operated_readiness',
    ];
    for (const m of requiredMissing) {
      if (!fortressGate.missing_proof.includes(m)) {
        errors.push(`fortress_hidden_missing_proof:${m}`);
      }
    }
    if (fortressGate.verdict === 'complete') {
      errors.push('fortress_complete_without_security_production_proofs');
    }
    if (fortressGate.finite_audit_workstream_complete === true
      && fortressGate.production_readiness !== 'absent') {
      errors.push('finite_audit_as_security_or_production_readiness');
    }
  }

  const score = {
    proven: gates.filter((g) => g.verdict === 'complete').length,
    partial: gates.filter((g) => g.verdict === 'partial').length,
    absent: gates.filter((g) => g.verdict === 'absent').length,
    total: gates.length,
  };

  return {
    ok: errors.length === 0
      && deepEqual(score, FROZEN_MESSI_SCORE)
      && gates.every((g) => VERDICTS.includes(g.verdict))
      && !gates.some((g) => g.verdict === 'complete'),
    errors,
    score,
    gates,
    radar_formal_score: RADAR_FORMAL_SCORE,
    fortress_matrix_counts: FORTRESS_MATRIX_VERDICT_COUNTS,
    messi_complete: false,
    production_ready: false,
  };
}

function readFortressMatrixCounts(root) {
  const matrix = JSON.parse(
    fs.readFileSync(rootJoin(root, 'fixtures/fortress-tenant-identity/boundary-matrix.json'), 'utf8'),
  );
  const counts = {
    proven_fail_closed: 0,
    proven_isolated_by_runtime: 0,
    unproven: 0,
    vulnerable: 0,
    total: 0,
  };
  for (const b of matrix.boundaries || []) {
    counts.total += 1;
    if (Object.prototype.hasOwnProperty.call(counts, b.verdict)) counts[b.verdict] += 1;
  }
  return counts;
}

function readRadarFormalScore(root) {
  const evidence = JSON.parse(
    fs.readFileSync(rootJoin(root, 'fixtures/radar-operations/slice16ap-finite-closeout.json'), 'utf8'),
  );
  return evidence.frozen_score;
}

function buildExpectedLedgerSkeleton() {
  return {
    schema_version: 1,
    slice: SLICE,
    outcome_id: OUTCOME_ID,
    branch: BRANCH,
    master_basis: MASTER_BASIS,
    progress_class: PROGRESS_CLASS,
    live_mutation: false,
    runtime_behavior_changed: false,
    messi_definition:
      'MESSI is the integration gate above FOUNDATION, FORTRESS, RADAR, and FACTORY.',
    completion_policy:
      'Parent milestones are never marked complete from labels, summaries, or self-authored booleans. Classification requires inventory + exact hash binding + real retained gate execution + explicit missing proof.',
    parents: Object.keys(PARENTS).map((id) => {
      const p = PARENTS[id];
      return {
        id: p.id,
        tip_slice: p.tip_slice,
        outcome_id: p.outcome_id,
        master_basis: p.master_basis,
        canonical_tip: p.canonical_tip,
        candidate_sha: p.candidate_sha,
        workstream_class: p.workstream_class,
        finite_closeout_analog: p.finite_closeout_analog,
        production_readiness: p.production_readiness,
        npm_script: p.npm_script,
        evidence: [...p.evidence],
        docs: [...(p.docs || [])],
        verifier_script: p.verifier_script,
        provenance_bound_files: [...p.provenance_bound_files],
        missing_proof_for_complete: [...p.missing_proof_for_complete],
      };
    }),
    bound_file_hashes: { ...BOUND_FILE_HASHES },
    parent_sha_provenance: Object.keys(PARENTS).reduce((acc, id) => {
      const p = PARENTS[id];
      acc[id] = {
        canonical_tip: p.canonical_tip,
        candidate_sha: p.candidate_sha,
        master_basis: p.master_basis,
        provenance_bound_files: [...p.provenance_bound_files],
      };
      return acc;
    }, {}),
    gate_ids: [...GATE_IDS],
    frozen_messi_score: { ...FROZEN_MESSI_SCORE },
    radar_formal_score: { ...RADAR_FORMAL_SCORE },
    fortress_matrix_counts: { ...FORTRESS_MATRIX_VERDICT_COUNTS },
    messi_complete: false,
    production_ready: false,
  };
}

/**
 * Ledger/classifier semantic gate object (strips retained_gate_results).
 * finite_staging_workstream_complete / finite_audit_workstream_complete are
 * included only when present (FOUNDATION / FORTRESS respectively).
 */
function ledgerGateObject(g) {
  if (!g || typeof g !== 'object') return null;
  const out = {
    id: g.id,
    verdict: g.verdict,
    parent: g.parent,
    workstream_class: g.workstream_class,
    production_readiness: g.production_readiness,
    finite_closeout_analog: g.finite_closeout_analog,
  };
  if (Object.prototype.hasOwnProperty.call(g, 'finite_staging_workstream_complete')) {
    out.finite_staging_workstream_complete = g.finite_staging_workstream_complete;
  }
  if (Object.prototype.hasOwnProperty.call(g, 'finite_audit_workstream_complete')) {
    out.finite_audit_workstream_complete = g.finite_audit_workstream_complete;
  }
  out.missing_proof = Array.isArray(g.missing_proof) ? [...g.missing_proof] : g.missing_proof;
  return out;
}

function unrelatedGatesMatchBase(gates) {
  const errors = [];
  const byId = {};
  for (const g of gates || []) byId[g.id] = g;
  for (const exp of BASE_UNRELATED_GATE_OBJECTS) {
    const got = byId[exp.id];
    if (!got) {
      errors.push(`unrelated_gate_missing:${exp.id}`);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(got, 'finite_audit_workstream_complete')) {
      errors.push(`finite_audit_on_unrelated_gate:${exp.id}`);
    }
    if (!deepEqual(ledgerGateObject(got), deepClone(exp))) {
      errors.push(`unrelated_gate_drift:${exp.id}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function validateLedgerFixture(ledger, classification) {
  const errors = [];
  if (ledger.slice !== SLICE) errors.push('slice');
  if (ledger.outcome_id !== OUTCOME_ID) errors.push('outcome_id');
  if (ledger.branch !== BRANCH) errors.push('branch');
  if (ledger.master_basis !== MASTER_BASIS) errors.push('master_basis');
  if (ledger.messi_complete === true) errors.push('false_messi_complete');
  if (ledger.production_ready === true) errors.push('false_production_ready');
  if (!deepEqual(ledger.frozen_messi_score, FROZEN_MESSI_SCORE)) errors.push('frozen_messi_score');
  if (!deepEqual(ledger.radar_formal_score, RADAR_FORMAL_SCORE)) errors.push('radar_formal_score');
  if (!deepEqual(ledger.bound_file_hashes, BOUND_FILE_HASHES)) errors.push('bound_file_hashes');
  if (!ledger.parent_sha_provenance) {
    errors.push('parent_sha_provenance_missing');
  } else {
    for (const id of Object.keys(PARENTS)) {
      const got = ledger.parent_sha_provenance[id];
      const exp = PARENTS[id];
      if (!got) {
        errors.push(`parent_sha_provenance_missing:${id}`);
        continue;
      }
      if (got.canonical_tip !== exp.canonical_tip) errors.push(`parent_canonical_tip:${id}`);
      if (got.candidate_sha !== exp.candidate_sha) errors.push(`parent_candidate_sha:${id}`);
      if (!deepEqual(got.provenance_bound_files, [...exp.provenance_bound_files])) {
        errors.push(`parent_provenance_bound_files:${id}`);
      }
    }
  }
  if (Array.isArray(ledger.parents)) {
    for (const p of ledger.parents) {
      const exp = PARENTS[p.id];
      if (!exp) continue;
      if (p.canonical_tip !== exp.canonical_tip) errors.push(`ledger_parent_canonical_tip:${p.id}`);
      if (p.candidate_sha !== exp.candidate_sha) errors.push(`ledger_parent_candidate_sha:${p.id}`);
    }
  }
  if (ledger.parent_complete || ledger.parents_complete) errors.push('self_authored_parent_complete_boolean');
  if (Array.isArray(ledger.parents)) {
    for (const p of ledger.parents) {
      if (p && (p.complete === true || p.parent_complete === true || p.milestone_complete === true)) {
        errors.push(`self_authored_parent_complete_boolean:${p.id}`);
      }
    }
  }
  if (!classification || !classification.gates) {
    errors.push('classification_missing');
  } else {
    if (!deepEqual(ledger.score, classification.score)) errors.push('score_mismatch');
    const byId = {};
    for (const g of ledger.gates || []) byId[g.id] = g;
    for (const g of classification.gates) {
      const got = byId[g.id];
      if (!got) {
        errors.push(`gate_missing_in_ledger:${g.id}`);
        continue;
      }
      if (got.verdict !== g.verdict) errors.push(`gate_verdict_mismatch:${g.id}`);
      if (!deepEqual(got.missing_proof, [...g.missing_proof])) {
        errors.push(`gate_missing_proof_mismatch:${g.id}`);
      }
      if (got.verdict === 'complete') errors.push(`downgraded_or_false_complete:${g.id}`);
      if (Object.prototype.hasOwnProperty.call(g, 'finite_staging_workstream_complete')
        && got.finite_staging_workstream_complete !== g.finite_staging_workstream_complete) {
        errors.push(`finite_staging_workstream_complete_mismatch:${g.id}`);
      }
      if (Object.prototype.hasOwnProperty.call(g, 'finite_audit_workstream_complete')
        && got.finite_audit_workstream_complete !== g.finite_audit_workstream_complete) {
        errors.push(`finite_audit_workstream_complete_mismatch:${g.id}`);
      }
    }
    // FOUNDATION finite staging must remain exposed; FORTRESS finite audit must be exposed.
    const foundationGot = byId.G_FOUNDATION_PARENT;
    if (foundationGot
      && foundationGot.finite_staging_workstream_complete !== true
      && classification.gates.find((x) => x.id === 'G_FOUNDATION_PARENT')
        ?.finite_staging_workstream_complete === true) {
      errors.push('foundation_finite_staging_missing_in_ledger');
    }
    const fortressGot = byId.G_FORTRESS_PARENT;
    if (fortressGot
      && fortressGot.finite_audit_workstream_complete !== true
      && classification.gates.find((x) => x.id === 'G_FORTRESS_PARENT')
        ?.finite_audit_workstream_complete === true) {
      errors.push('fortress_finite_audit_missing_in_ledger');
    }
    const unrelatedLedger = unrelatedGatesMatchBase(ledger.gates || []);
    for (const e of unrelatedLedger.errors) errors.push(e);
    const unrelatedClass = unrelatedGatesMatchBase(classification.gates);
    for (const e of unrelatedClass.errors) {
      errors.push(`classifier_${e}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

const REQUIRED_RED = Object.freeze([
  'missing_bound_evidence',
  'tampered_bound_hash',
  'self_referential_parent_expectation',
  'stale_master_basis_sha',
  'stale_but_valid_ancestor_tip',
  'repinned_current_tree_hashes',
  'mismatched_candidate_tip_pair',
  'missing_parent_ref',
  'altered_allowed_parent_file',
  'stale_bound_file_hash',
  'downgraded_partial_to_complete',
  'radar_formal_score_raised',
  'false_messi_completion',
  // MESSI 1C — FOUNDATION finite closeout wiring hostiles
  'finite_closeout_as_production_completion',
  'stale_or_repinned_1b_provenance',
  'hidden_missing_proofs',
  'self_authored_score_change',
  'unrelated_gate_semantic_drift',
  // MESSI 1E — FORTRESS finite audit wiring hostiles
  'finite_as_security_overclaim',
  'unrelated_gate_identity',
  'stale_or_repinned_1d_provenance',
  'hidden_fortress_missing_proofs',
  'concurrent_merge_topology',
  'altered_candidate_scope',
  'altered_certificate_scope',
  'missing_reviewed_candidate_ref',
  'reordered_or_superseded_certificates',
  'multi_squash_unrelated_topology',
  'changed_protected_blob',
  'spoofed_locked_branch_name_rejected',
  'source_fixture_co_tamper',
  'fixture_metadata_tamper',
  'redesign_ref_tamper',
  'redesign_hash_tamper',
  'obsolete_authorization_green_name_absent',
]);

const REQUIRED_GREEN = Object.freeze([
  'parent_inventory_bound',
  'exact_hashes_match',
  'parent_sha_provenance_enforced',
  'retained_gates_executed',
  'classification_matches_ledger',
  'radar_formal_0_9_0_preserved',
  'finite_vs_production_distinguished',
  'foundation_finite_staging_exposed',
  'fortress_finite_audit_exposed',
  'unrelated_gates_byte_identical_to_base',
  'messi_not_complete',
  'package_script_registered',
  'candidate_certificate_paths_git_bound',
  'blob_certificates_match_current_tree',
]);

deepFreeze(PARENTS);
deepFreeze(MESSI_GATES);
deepFreeze(BOUND_FILE_HASHES);
deepFreeze(SCOPE_FENCE);
deepFreeze(ARTIFACT_RELS);
deepFreeze(FROZEN_MESSI_SCORE);
deepFreeze(RADAR_FORMAL_SCORE);
deepFreeze(FORTRESS_MATRIX_VERDICT_COUNTS);
deepFreeze(SELF_REF_FORBIDDEN_PREFIXES);
deepFreeze(REQUIRED_RED);
deepFreeze(REQUIRED_GREEN);
deepFreeze(GATE_IDS);
deepFreeze(UNRELATED_GATE_IDS);
deepFreeze(BASE_UNRELATED_GATE_OBJECTS);

module.exports = deepFreeze({
  SLICE,
  BRANCH,
  OUTCOME_ID,
  MASTER_BASIS,
  REVIEWED_CANDIDATE,
  LANDING_TIP,
  CORRECTION_CANDIDATE_53C1,
  redesignPin,
  PROGRESS_CLASS,
  MESSI_CLOSEOUT_WORKSTREAM_CLASS,
  FOUNDATION_1B_MERGE_TIP,
  FOUNDATION_1B_CANDIDATE_SHA,
  FOUNDATION_1B_MASTER_BASIS,
  FORTRESS_1D_MERGE_TIP,
  FORTRESS_1D_CANDIDATE_SHA,
  FORTRESS_1D_MASTER_BASIS,
  GATE_IDS,
  UNRELATED_GATE_IDS,
  BASE_UNRELATED_GATE_OBJECTS,
  VERDICTS,
  FROZEN_MESSI_SCORE,
  RADAR_FORMAL_SCORE,
  FORTRESS_MATRIX_VERDICT_COUNTS,
  PACKAGE_JSON_ALLOWED_SCRIPT_KEY,
  PACKAGE_JSON_ALLOWED_SCRIPT_VALUE,
  PACKAGE_JSON_1C_SCRIPT_KEY,
  PACKAGE_JSON_1C_SCRIPT_VALUE,
  PACKAGE_JSON_1E_SCRIPT_KEY,
  PACKAGE_JSON_1E_SCRIPT_VALUE,
  SCOPE_FENCE,
  PARENTS,
  MESSI_GATES,
  BOUND_FILE_HASHES,
  ARTIFACT_RELS,
  SELF_REF_FORBIDDEN_PREFIXES,
  REQUIRED_RED,
  REQUIRED_GREEN,
  deepFreeze,
  deepClone,
  deepEqual,
  thaw,
  stableStringify,
  sha256File,
  sha256Text,
  listBoundRels,
  recomputeBoundHashes,
  resolveCommitSha,
  isGitAncestor,
  sameGitTree,
  sameBoundBlobsAtCommits,
  candidateFitsTip,
  assertShaAncestor,
  assertCandidateFitsTip,
  gitBlobSha256AtCommit,
  currentHeadSha,
  resolveTipSha,
  reviewedBlobCertificateConfig,
  buildLockedReviewedBlobCertificates,
  verifyReviewedBlobCertificatesAtTip,
  tipAcceptsCertificates,
  makeUnrelatedOrphanCommit,
  verifyReviewedCandidateScope,
  verifyMergedProvenance,
  verifyWorkingTreeDeltaScope,
  verifyParentShaProvenance,
  runRetainedGate,
  runAllRetainedGates,
  parentGatesAllPass,
  parentEvidenceSelfReferential,
  classifyMessiGates,
  readFortressMatrixCounts,
  readRadarFormalScore,
  buildExpectedLedgerSkeleton,
  ledgerGateObject,
  unrelatedGatesMatchBase,
  validateLedgerFixture,
});

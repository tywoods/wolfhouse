'use strict';

/**
 * messi-slice1a-acceptance-ledger — MESSI Slice 1A sole production classifier
 * and parent-binding locks (docs/fixtures/verifier only).
 *
 * MESSI is the integration gate above FOUNDATION, FORTRESS, RADAR, and FACTORY.
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

const SLICE = 'MESSI-1A';
const BRANCH = 'messi/slice-1a-acceptance-ledger';
const OUTCOME_ID = '1A_messi_acceptance_ledger';
const MASTER_BASIS = '14facf5d54be8767cf9aca4d69a880f28ea3dc2e';
const PROGRESS_CLASS = 'acceptance_ledger_inventory_and_verifier_only';

const GATE_IDS = Object.freeze([
  'G_FOUNDATION_PARENT',
  'G_FORTRESS_PARENT',
  'G_RADAR_PARENT',
  'G_FACTORY_PARENT',
  'G_CROSS_PARENT_INTEGRATION',
  'G_MESSI_MILESTONE_CLOSEOUT',
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

const ALLOWED_TIP_PATH_PREFIXES = Object.freeze([
  'docs/MESSI-ACCEPTANCE-LEDGER.md',
  'fixtures/messi-acceptance/',
  'scripts/lib/messi-slice1a-acceptance-ledger.js',
  'scripts/verify-messi-slice1a-acceptance-ledger.js',
  // Forward-compat tip-allowlist path entries only on FACTORY 1B–1E locks
  // (same pattern 1E used for itself). No generator/template/runtime behavior.
  'scripts/lib/factory-slice1b-archetype-templates.js',
  'scripts/lib/factory-slice1c-dry-run-generator.js',
  'scripts/lib/factory-slice1d-integration-proof.js',
  'scripts/lib/factory-slice1e-finite-closeout.js',
  'scripts/verify-factory-slice1e-finite-closeout.js',
  'package.json',
]);

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
 * FACTORY tip-scope forward-compat allowlist edits are intentionally excluded
 * from provenance_bound_files (see TIP_SCOPE_FORWARD_COMPAT_RELS) — they are
 * MESSI tip mutations, not parent-tip evidence.
 */
const PARENTS = Object.freeze({
  FOUNDATION: Object.freeze({
    id: 'FOUNDATION',
    title: 'Sunset schema / Phase D foundation workstream',
    tip_slice: 'FOUNDATION-14AE',
    outcome_id: 'canonical_runner_noop_live_ok',
    master_basis: '21371079ac5a331d47e7ed5f79351fceeeceefa6',
    canonical_tip: '32b44930685450cb27ac519d052332be7b18150d',
    candidate_sha: '32b44930685450cb27ac519d052332be7b18150d',
    tip_sha_on_master: '32b44930685450cb27ac519d052332be7b18150d',
    workstream_class: 'tip_retained_staging_schema_noop',
    finite_closeout_analog: null,
    production_readiness: 'absent',
    docs: Object.freeze([]),
    evidence: Object.freeze([
      'fixtures/sunset-schema-observer/slice14ae-canonical-runner-noop-contract.json',
      'fixtures/sunset-schema-observer/slice14ae-canonical-runner-noop-evidence.json',
      'fixtures/sunset-schema-observer/slice14ae-findings.md',
    ]),
    provenance_bound_files: Object.freeze([
      'fixtures/sunset-schema-observer/slice14ae-canonical-runner-noop-contract.json',
      'fixtures/sunset-schema-observer/slice14ae-canonical-runner-noop-evidence.json',
      'fixtures/sunset-schema-observer/slice14ae-findings.md',
      'scripts/verify-sunset-schema-slice14ae.js',
    ]),
    verifier_script: 'scripts/verify-sunset-schema-slice14ae.js',
    npm_script: 'verify:sunset-schema-slice14ae',
    retained_gates: Object.freeze([
      Object.freeze({
        id: 'foundation_14ae_offline',
        kind: 'node',
        script: 'scripts/verify-sunset-schema-slice14ae.js',
        npm: 'verify:sunset-schema-slice14ae',
      }),
    ]),
    missing_proof_for_complete: Object.freeze([
      'finite_milestone_closeout_disposition_analogous_to_16AP_or_1E',
      'docker_fresh_db_replacement_proof',
      'production_schema_readiness',
      'claim_zero_remaining_drift_forbidden_by_14AE',
    ]),
  }),
  FORTRESS: Object.freeze({
    id: 'FORTRESS',
    title: 'Tenant identity / confused-deputy boundary workstream',
    tip_slice: 'FORTRESS-15L',
    audit_slice: 'FORTRESS-15A',
    outcome_id: '15L_meta_signature_fail_closed',
    master_basis: 'f703f3e07d3cd9214c661f169c23c7d5d5370709',
    canonical_tip: '28a30a688baa637e1bcb549d9b585cb5917942d1',
    candidate_sha: '28a30a688baa637e1bcb549d9b585cb5917942d1',
    tip_sha_on_master: '28a30a688baa637e1bcb549d9b585cb5917942d1',
    audit_master_basis: '32b44930685450cb27ac519d052332be7b18150d',
    workstream_class: 'tip_retained_security_remediation_plus_audit_matrix',
    finite_closeout_analog: null,
    production_readiness: 'absent',
    docs: Object.freeze([
      'docs/FORTRESS-TENANT-IDENTITY-BOUNDARY-MATRIX.md',
    ]),
    evidence: Object.freeze([
      'fixtures/fortress-tenant-identity/boundary-matrix.json',
      'fixtures/fortress-tenant-identity/attack-cases.json',
      'fixtures/fortress-tenant-identity/slice15l-contract.json',
      'fixtures/fortress-tenant-identity/slice15l-evidence.json',
      'fixtures/fortress-tenant-identity/slice15l-findings.md',
    ]),
    provenance_bound_files: Object.freeze([
      'docs/FORTRESS-TENANT-IDENTITY-BOUNDARY-MATRIX.md',
      'fixtures/fortress-tenant-identity/boundary-matrix.json',
      'fixtures/fortress-tenant-identity/attack-cases.json',
      'fixtures/fortress-tenant-identity/slice15l-contract.json',
      'fixtures/fortress-tenant-identity/slice15l-evidence.json',
      'fixtures/fortress-tenant-identity/slice15l-findings.md',
      'scripts/lib/fortress-tenant-identity-boundary.js',
      'scripts/verify-fortress-tenant-identity-boundary-matrix.js',
      'scripts/verify-fortress-slice15l-meta-signature-fail-closed.js',
    ]),
    verifier_script: 'scripts/verify-fortress-slice15l-meta-signature-fail-closed.js',
    audit_verifier_script: 'scripts/verify-fortress-tenant-identity-boundary-matrix.js',
    npm_script: 'verify:fortress-slice15l-meta-signature-fail-closed',
    retained_gates: Object.freeze([
      Object.freeze({
        id: 'fortress_15a_matrix',
        kind: 'node',
        script: 'scripts/verify-fortress-tenant-identity-boundary-matrix.js',
        npm: 'verify:fortress-tenant-identity-boundary-matrix',
      }),
      Object.freeze({
        id: 'fortress_15l_signature',
        kind: 'node',
        script: 'scripts/verify-fortress-slice15l-meta-signature-fail-closed.js',
        npm: 'verify:fortress-slice15l-meta-signature-fail-closed',
      }),
    ]),
    missing_proof_for_complete: Object.freeze([
      'finite_milestone_closeout_disposition',
      'matrix_unproven_cleared_to_proven_fail_closed',
      'matrix_vulnerable_remediated',
      '15L_live_kv_secret_creation_and_staff_api_deploy_activation',
      'B02_meta_live_client_slug_authority_activation',
      'production_tenant_boundary_proof',
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
    // Tip-blob provenance excludes MESSI forward-compat allowlist mutations.
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

/** MESSI tip-scope only — current-tree hash bound, NOT parent-tip blob provenance. */
const TIP_SCOPE_FORWARD_COMPAT_RELS = Object.freeze([
  'scripts/lib/factory-slice1b-archetype-templates.js',
  'scripts/lib/factory-slice1c-dry-run-generator.js',
  'scripts/lib/factory-slice1d-integration-proof.js',
  'scripts/lib/factory-slice1e-finite-closeout.js',
  'scripts/verify-factory-slice1e-finite-closeout.js',
]);

const MESSI_GATES = Object.freeze([
  Object.freeze({
    id: 'G_FOUNDATION_PARENT',
    parent: 'FOUNDATION',
    title: 'FOUNDATION parent evidence binding + retained gate',
    requirement:
      'Inventory FOUNDATION canonical tip evidence/verifier, bind exact file hashes, run verify:sunset-schema-slice14ae, and classify with explicit missing proof. Do not mark complete from labels.',
  }),
  Object.freeze({
    id: 'G_FORTRESS_PARENT',
    parent: 'FORTRESS',
    title: 'FORTRESS parent evidence binding + retained gates',
    requirement:
      'Inventory FORTRESS 15A matrix + 15L tip evidence/verifiers, bind hashes, run both retained offline gates, preserve matrix unproven/vulnerable counts, classify with explicit missing proof.',
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
  'fixtures/sunset-schema-observer/slice14ae-canonical-runner-noop-contract.json':
    '08bc566478a1d9fe6a47fe696dfa426d3707c1089c963941110104a541804327',
  'fixtures/sunset-schema-observer/slice14ae-canonical-runner-noop-evidence.json':
    'bbcd89f68c882168f0344ad4cfa252225d234ad65cc72149dd770f16c288a567',
  'fixtures/sunset-schema-observer/slice14ae-findings.md':
    '442548e91d36c739c411294a6c3ac4da7a834ac8497e1ea95eee23a0926b1947',
  'scripts/verify-sunset-schema-slice14ae.js':
    '73bb073442a78e30bec6d8717cfc7a4d10d85002e3257e1491f2da1c6b14faa4',
  'docs/FORTRESS-TENANT-IDENTITY-BOUNDARY-MATRIX.md':
    'ec8fe4e611d086651842f287610a13495ef34df174e801e0bdc8e35d45bfccf9',
  'fixtures/fortress-tenant-identity/boundary-matrix.json':
    '7503c290cca697af916edd9d570eb4973a88f0c3dc349042a2392fc220aede1d',
  'fixtures/fortress-tenant-identity/attack-cases.json':
    '6f73fb951e49d45ed264a1383dc6e65224937da29d91ea6dafd0cd50430fc5bc',
  'fixtures/fortress-tenant-identity/slice15l-contract.json':
    '0f12fa1a35d0a9e087fece87b6211760f33d7c8f3ea5ffd31581ba314045005d',
  'fixtures/fortress-tenant-identity/slice15l-evidence.json':
    'd52c801dde68cc74ff59685543a7ba1927118d1a140b7971f2422db021a88cd3',
  'fixtures/fortress-tenant-identity/slice15l-findings.md':
    'c6f63bb9b9d407d0095c3c44e5aa9f1c21b6271156d80c078be946ce0dbafbfd',
  'scripts/lib/fortress-tenant-identity-boundary.js':
    '42bf5c258f93a6acc31011e15ef160157d51942f3cd5a5a7a89b022206c28e9d',
  'scripts/verify-fortress-tenant-identity-boundary-matrix.js':
    'ed60a75f5693e8f2d205f1ddcd286d3ad120252b2eb47037a6e480d4c803f274',
  'scripts/verify-fortress-slice15l-meta-signature-fail-closed.js':
    '5c6296df732e1ad7f34c4190dccb59fb4947f9be9cb307175813535cacc75c4e',
  'docs/RADAR-OPERATIONS-GATE-LEDGER.md':
    'c3aac5ad4a083868a3350a5ca099447faed0f016f3ee92570997e2533747e5d9',
  'fixtures/radar-operations/slice16ap-finite-closeout.json':
    '158e3418cc573852780766cc78dafdfa427a3e9a27e0a14e3036266bde91ece2',
  'fixtures/radar-operations/slice16ap-expected-contract.json':
    'ad856cfe50b1eb8f6a535bdc137ec4a23daa6d89d8bcd0b2a4b90103a95f8621',
  'scripts/lib/radar-slice16ap-finite-closeout.js':
    '4ba18280ac6b595921e20e1f9989662d6379456eb6f24303a2ab71dd2302bf77',
  'scripts/verify-radar-slice16ap-finite-closeout.js':
    '44746f0b016539d34ba73f71ca7c86b442eb5245bdb72f1c666d5ceb04106d01',
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
    '2d0e993d2e46f32914979fc50082cfb6b166852cc1db9d977f161d768aeb9413',
  'scripts/lib/factory-slice1c-dry-run-generator.js':
    '00b9c044998f72888de136a234adc9419586ac438b4e4feb246cf046cb7e6aba',
  'scripts/lib/factory-slice1d-integration-proof.js':
    '7bbe71fcb2eb00a5ce7ee8756fa2d49afae5cf73e5bf2a4c15e99f5e36034852',
  'scripts/lib/factory-slice1e-finite-closeout.js':
    '4179ad5123e6a75104e126c83c36b442049f0119d2d5bc235795322f4d311e56',
  'scripts/verify-factory-slice1e-finite-closeout.js':
    '3d0acb8b5f7f0275b506a519461baaebe0f06ce82988069df4a062cdab112991',
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

function assertShaAncestor(root, sha, descendant) {
  const tip = descendant || 'HEAD';
  const resolved = resolveCommitSha(root, sha);
  if (!resolved) return { ok: false, detail: `missing_ref:${sha}` };
  if (!isGitAncestor(root, resolved, tip)) {
    return { ok: false, detail: `not_ancestor:${resolved}:${tip}` };
  }
  return { ok: true, sha: resolved };
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

    if (tipSha && candidateSha && !isGitAncestor(root, candidateSha, tipSha)) {
      parentErrors.push(`mismatched_candidate_tip_pair:${candidateSha}:${tipSha}`);
    }
    // Also enforce locked pair relationship independently of forged claims.
    if (
      lockedTipSha
      && lockedCandidateSha
      && !isGitAncestor(root, lockedCandidateSha, lockedTipSha)
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

    for (const rel of TIP_SCOPE_FORWARD_COMPAT_RELS) {
      if (locked.provenance_bound_files.includes(rel)) {
        parentErrors.push(`tip_scope_file_claimed_as_provenance:${rel}`);
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
      const timeout = parentId === 'FACTORY' ? 1200000 : 180000;
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
      // Retained gates pass + hashes bind, but production unknowns / missing
      // finite-closeout (FOUNDATION/FORTRESS) or formal partials (RADAR) or
      // offline-only closeout (FACTORY) keep MESSI parent gates partial.
      verdict = 'partial';
    }
    gates.push({
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
    });
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
    workstream_class: PROGRESS_CLASS,
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
    tip_scope_forward_compat_rels: [...TIP_SCOPE_FORWARD_COMPAT_RELS],
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
  if (!deepEqual(ledger.tip_scope_forward_compat_rels, [...TIP_SCOPE_FORWARD_COMPAT_RELS])) {
    errors.push('tip_scope_forward_compat_rels');
  }
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
]);

const REQUIRED_GREEN = Object.freeze([
  'parent_inventory_bound',
  'exact_hashes_match',
  'parent_sha_provenance_enforced',
  'retained_gates_executed',
  'classification_matches_ledger',
  'radar_formal_0_9_0_preserved',
  'finite_vs_production_distinguished',
  'messi_not_complete',
  'package_script_registered',
]);

deepFreeze(PARENTS);
deepFreeze(MESSI_GATES);
deepFreeze(BOUND_FILE_HASHES);
deepFreeze(TIP_SCOPE_FORWARD_COMPAT_RELS);
deepFreeze(SCOPE_FENCE);
deepFreeze(ARTIFACT_RELS);
deepFreeze(FROZEN_MESSI_SCORE);
deepFreeze(RADAR_FORMAL_SCORE);
deepFreeze(FORTRESS_MATRIX_VERDICT_COUNTS);
deepFreeze(ALLOWED_TIP_PATH_PREFIXES);
deepFreeze(SELF_REF_FORBIDDEN_PREFIXES);
deepFreeze(REQUIRED_RED);
deepFreeze(REQUIRED_GREEN);
deepFreeze(GATE_IDS);

module.exports = deepFreeze({
  SLICE,
  BRANCH,
  OUTCOME_ID,
  MASTER_BASIS,
  PROGRESS_CLASS,
  GATE_IDS,
  VERDICTS,
  FROZEN_MESSI_SCORE,
  RADAR_FORMAL_SCORE,
  FORTRESS_MATRIX_VERDICT_COUNTS,
  PACKAGE_JSON_ALLOWED_SCRIPT_KEY,
  PACKAGE_JSON_ALLOWED_SCRIPT_VALUE,
  ALLOWED_TIP_PATH_PREFIXES,
  SCOPE_FENCE,
  PARENTS,
  MESSI_GATES,
  BOUND_FILE_HASHES,
  TIP_SCOPE_FORWARD_COMPAT_RELS,
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
  assertShaAncestor,
  gitBlobSha256AtCommit,
  verifyParentShaProvenance,
  runRetainedGate,
  runAllRetainedGates,
  parentGatesAllPass,
  parentEvidenceSelfReferential,
  classifyMessiGates,
  readFortressMatrixCounts,
  readRadarFormalScore,
  buildExpectedLedgerSkeleton,
  validateLedgerFixture,
});

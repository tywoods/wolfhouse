'use strict';

/**
 * messi-slice1d-fortress-closeout — MESSI Slice 1D sole production validation
 * module (docs/fixtures/library/verifier only).
 *
 * Freezes a finite FORTRESS audit workstream closeout disposition derived from
 * the exact reviewed 15A matrix + 15L signature tip blobs and both retained
 * offline gates. Marks only the finite audit/source workstream complete where
 * proven. Matrix still locks 3 unproven / 4 vulnerable; live Key Vault/deploy
 * activation, production tenant isolation/payment/network/secret proof, drills,
 * and operated readiness remain absent. FORTRESS security/production readiness
 * must not close. Does NOT update the MESSI ledger, claim production readiness,
 * or close MESSI.
 *
 * Threat boundary (honest): module.exports is recursively deep-frozen with
 * non-writable/non-configurable descriptors so post-require assignment /
 * redefinition of exported locks or validateCloseout cannot alter validation.
 * This does NOT defend against require.cache replacement, rewriting this file
 * before load, or other process-level code injection.
 *
 * Post-merge tip scope: immutable reviewed-candidate blob certificates at HEAD.
 * Never infer 1D scope from MASTER_BASIS..HEAD path allowlists (concurrent
 * unrelated master commits after the squash — e.g. #147 — are irrelevant).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawnSync } = require('child_process');
const blobCerts = require('./reviewed-candidate-blob-certificates');

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

function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function sha256File(absPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

const SLICE = 'MESSI-1D';
const BRANCH = 'messi/slice-1d-fortress-closeout';
const OUTCOME_ID = '1D_fortress_finite_audit_workstream_closeout';
const COMPLETION_EVIDENCE = '1D_fortress_finite_audit_workstream_closeout';
const COMPLETION_REQUIRES = 'verify:messi-slice1d-fortress-closeout';
/** MESSI 1C merge tip on master — this slice starts from that SHA. */
const MASTER_BASIS = '949be24936c3056b19904904f98feccab5caf883';
/**
 * Exact reviewed 1D candidate (pre-squash). Tip scope binds to
 * MASTER_BASIS..REVIEWED_CANDIDATE — never base-to-HEAD (concurrent #147
 * landed between basis and squash merge #148).
 */
const REVIEWED_CANDIDATE = 'fa2c5d71ad6c662b4c4f60b08ede409064acf2fe';
/** Squash-merge tip on master for this slice (PR #148). Historical — not a tip-scope gate. */
const LANDING_TIP = 'ff285598ac2cfec980e8316e772924a9c79a6a7e';
/** Break-glass correction candidate (immutable reviewed-candidate blob certificates). */
const CORRECTION_CANDIDATE_53C1 = '53c1abcfb67edb491c5100de571260c60813aec4';
/** Git-anchored whole-path redesign pin (never frozen_only / fixture trust root). */
const redesignPin = require('./breakglass-redesign-candidate-sha');
const PROGRESS_CLASS = 'finite_fortress_audit_workstream_closeout_only';
const WORKSTREAM_CLASS = 'finite_fortress_audit_workstream_closeout';

/** Exact reviewed FORTRESS tip (15L). Identity candidate. */
const FORTRESS_TIP = '28a30a688baa637e1bcb549d9b585cb5917942d1';
const FORTRESS_CANDIDATE = FORTRESS_TIP;
const FORTRESS_MASTER_BASIS = 'f703f3e07d3cd9214c661f169c23c7d5d5370709';
const FORTRESS_TIP_SLICE = 'FORTRESS-15L';
const FORTRESS_AUDIT_SLICE = 'FORTRESS-15A';
const FORTRESS_OUTCOME_ID = '15L_meta_signature_fail_closed';
const FORTRESS_AUDIT_MASTER_BASIS = '32b44930685450cb27ac519d052332be7b18150d';
/** Reviewed 15A matrix landing — matrix content blobs match tip. */
const FORTRESS_15A_TIP = '8ed81111b9a67a656dee0b7dbd5a46ab91ca125c';

const FORTRESS_15A_NPM_GATE = 'verify:fortress-tenant-identity-boundary-matrix';
const FORTRESS_15A_VERIFIER_SCRIPT =
  'scripts/verify-fortress-tenant-identity-boundary-matrix.js';
const FORTRESS_15L_NPM_GATE = 'verify:fortress-slice15l-meta-signature-fail-closed';
const FORTRESS_15L_VERIFIER_SCRIPT =
  'scripts/verify-fortress-slice15l-meta-signature-fail-closed.js';

const VERDICTS = Object.freeze(['complete', 'partial', 'absent']);

const GATE_IDS = Object.freeze([
  'G_15A_MATRIX_AUDIT',
  'G_15L_SIGNATURE_SOURCE',
  'G_MATRIX_UNPROVEN_CLEARED',
  'G_MATRIX_VULNERABLE_REMEDIATED',
  'G_15L_LIVE_KV_DEPLOY_ACTIVATION',
  'G_PRODUCTION_TENANT_BOUNDARY_PROOF',
  'G_SECURITY_DRILLS',
  'G_OPERATED_READINESS',
  'G_FORTRESS_FINITE_AUDIT_WORKSTREAM',
  'G_FORTRESS_SECURITY_PRODUCTION_READINESS',
  'G_MESSI_MILESTONE',
]);

/** Frozen closeout score — only finite audit/source gates may be complete. */
const FROZEN_SCORE = Object.freeze({
  proven: 3,
  partial: 0,
  absent: 8,
  total: 11,
});

const FORTRESS_MATRIX_VERDICT_COUNTS = Object.freeze({
  proven_fail_closed: 5,
  proven_isolated_by_runtime: 3,
  unproven: 3,
  vulnerable: 4,
  total: 15,
});

const MATRIX_UNPROVEN_IDS = Object.freeze([
  'B01_meta_whatsapp_signature_ingress',
  'B14_stripe_locked_payment_identity',
  'B15_booking_hold_payment_callbacks',
]);

const MATRIX_VULNERABLE_IDS = Object.freeze([
  'B02_meta_normalize_live_client_slug',
  'B06_staff_bot_auth_principal',
  'B07_staff_bot_body_client_slug',
  'B13_stripe_webhook_payment_lookup',
]);

const PACKAGE_JSON_ALLOWED_SCRIPT_KEY = 'verify:messi-slice1d-fortress-closeout';
const PACKAGE_JSON_ALLOWED_SCRIPT_VALUE =
  'node scripts/verify-messi-slice1d-fortress-closeout.js';

const DOC_REL = 'docs/FORTRESS-FINITE-CLOSEOUT.md';
const EVIDENCE_REL = 'fixtures/fortress-closeout/finite-closeout.json';
const CONTRACT_REL = 'fixtures/fortress-closeout/contract.json';
const FINDINGS_REL = 'fixtures/fortress-closeout/findings.md';
const LOCK_MODULE_REL = 'scripts/lib/messi-slice1d-fortress-closeout.js';
const VERIFIER_REL = 'scripts/verify-messi-slice1d-fortress-closeout.js';

/**
 * Exact tip-blob sha256 for FORTRESS provenance_bound_files at FORTRESS_TIP
 * (15L). Matrix content blobs are identical at FORTRESS_15A_TIP; verifier
 * script for 15A is bound at the 15L tip (current retained gate).
 */
const FORTRESS_TIP_BOUND_HASHES = Object.freeze({
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
});

/** Matrix-only content blobs — identical at 15A tip and 15L tip. */
const FORTRESS_15A_MATRIX_BOUND_HASHES = Object.freeze({
  'docs/FORTRESS-TENANT-IDENTITY-BOUNDARY-MATRIX.md':
    FORTRESS_TIP_BOUND_HASHES['docs/FORTRESS-TENANT-IDENTITY-BOUNDARY-MATRIX.md'],
  'fixtures/fortress-tenant-identity/boundary-matrix.json':
    FORTRESS_TIP_BOUND_HASHES['fixtures/fortress-tenant-identity/boundary-matrix.json'],
  'fixtures/fortress-tenant-identity/attack-cases.json':
    FORTRESS_TIP_BOUND_HASHES['fixtures/fortress-tenant-identity/attack-cases.json'],
  'scripts/lib/fortress-tenant-identity-boundary.js':
    FORTRESS_TIP_BOUND_HASHES['scripts/lib/fortress-tenant-identity-boundary.js'],
});

const FORTRESS_PROVENANCE_BOUND_FILES = Object.freeze(
  Object.keys(FORTRESS_TIP_BOUND_HASHES).sort(),
);

const FORTRESS_15A_MATRIX_BOUND_FILES = Object.freeze(
  Object.keys(FORTRESS_15A_MATRIX_BOUND_HASHES).sort(),
);

/** Runtime / security / deploy paths this slice must not mutate vs MASTER_BASIS. */
const MUST_NOT_MUTATE = Object.freeze([
  'database/',
  'infra/',
  'scripts/staff-query-api.js',
  'scripts/lib/luna-meta-whatsapp-webhook.js',
  'scripts/lib/meta-whatsapp-signature-config.js',
  'scripts/lib/fortress-tenant-identity-boundary.js',
  'scripts/verify-fortress-tenant-identity-boundary-matrix.js',
  'scripts/verify-fortress-slice15l-meta-signature-fail-closed.js',
  'docs/FORTRESS-TENANT-IDENTITY-BOUNDARY-MATRIX.md',
  'fixtures/fortress-tenant-identity/',
  'docker/hermes-staging/SOUL.md',
]);

/**
 * Immutable independent gate expectations. Classifier output must match these
 * when retained gates pass and tip provenance binds — never from self-authored
 * booleans in the evidence fixture alone.
 */
const GATE_EXPECTATIONS = Object.freeze([
  Object.freeze({
    id: 'G_15A_MATRIX_AUDIT',
    verdict: 'complete',
    evidence_class: 'tip_retained_matrix_audit',
    title: 'FORTRESS 15A tenant-identity boundary matrix audit',
    source_proven: Object.freeze([
      'FORTRESS_15A_matrix_offline_gate',
      'locked_matrix_counts_5_3_3_4',
      'exact_tip_blob_hash_binding_at_28a30a68',
      'matrix_content_identical_at_8ed81111',
    ]),
    staging_complete: Object.freeze([
      'boundary_matrix_audit_disposition_frozen',
      'unproven_and_vulnerable_counts_preserved',
    ]),
    production_only_unknowns: Object.freeze([]),
    retained_gaps: Object.freeze([
      'matrix_unproven_not_cleared',
      'matrix_vulnerable_not_remediated',
      'audit_is_not_security_readiness',
    ]),
    missing_proof: Object.freeze([]),
  }),
  Object.freeze({
    id: 'G_15L_SIGNATURE_SOURCE',
    verdict: 'complete',
    evidence_class: 'tip_retained_signature_source_fail_closed',
    title: 'FORTRESS 15L Meta signature fail-closed source evidence',
    source_proven: Object.freeze([
      'FORTRESS_15L_offline_gate',
      'source_and_iac_fail_closed_at_28a30a68',
      'exact_15L_tip_blob_hash_binding',
    ]),
    staging_complete: Object.freeze([
      'offline_signature_fail_closed_source_proven',
    ]),
    production_only_unknowns: Object.freeze([]),
    retained_gaps: Object.freeze([
      'source_is_not_live_kv_or_deploy_activation',
      'B01_matrix_row_remains_unproven_historically',
    ]),
    missing_proof: Object.freeze([]),
  }),
  Object.freeze({
    id: 'G_MATRIX_UNPROVEN_CLEARED',
    verdict: 'absent',
    evidence_class: 'explicit_unknown',
    title: 'Matrix unproven controls cleared to proven_fail_closed',
    source_proven: Object.freeze([]),
    staging_complete: Object.freeze([]),
    production_only_unknowns: Object.freeze([
      'matrix_unproven_cleared_to_proven_fail_closed',
    ]),
    retained_gaps: Object.freeze([
      'three_unproven_controls_remain',
      ...MATRIX_UNPROVEN_IDS,
    ]),
    missing_proof: Object.freeze([
      'matrix_unproven_cleared_to_proven_fail_closed',
    ]),
  }),
  Object.freeze({
    id: 'G_MATRIX_VULNERABLE_REMEDIATED',
    verdict: 'absent',
    evidence_class: 'explicit_unknown',
    title: 'Matrix vulnerable controls remediated',
    source_proven: Object.freeze([]),
    staging_complete: Object.freeze([]),
    production_only_unknowns: Object.freeze([
      'matrix_vulnerable_remediated',
    ]),
    retained_gaps: Object.freeze([
      'four_vulnerable_controls_remain',
      ...MATRIX_VULNERABLE_IDS,
    ]),
    missing_proof: Object.freeze([
      'matrix_vulnerable_remediated',
    ]),
  }),
  Object.freeze({
    id: 'G_15L_LIVE_KV_DEPLOY_ACTIVATION',
    verdict: 'absent',
    evidence_class: 'explicit_unknown',
    title: '15L live Key Vault secret creation + Staff API deploy activation',
    source_proven: Object.freeze([]),
    staging_complete: Object.freeze([]),
    production_only_unknowns: Object.freeze([
      '15L_live_kv_secret_creation_and_staff_api_deploy_activation',
      'B02_meta_live_client_slug_authority_activation',
    ]),
    retained_gaps: Object.freeze([
      'source_and_iac_are_not_activation',
      'no_live_kv_or_deploy_in_this_slice',
    ]),
    missing_proof: Object.freeze([
      '15L_live_kv_secret_creation_and_staff_api_deploy_activation',
    ]),
  }),
  Object.freeze({
    id: 'G_PRODUCTION_TENANT_BOUNDARY_PROOF',
    verdict: 'absent',
    evidence_class: 'explicit_unknown',
    title: 'Production tenant isolation / payment / network / secret proof',
    source_proven: Object.freeze([]),
    staging_complete: Object.freeze([]),
    production_only_unknowns: Object.freeze([
      'production_tenant_isolation_proof',
      'production_payment_boundary_proof',
      'production_network_boundary_proof',
      'production_secret_mount_proof',
    ]),
    retained_gaps: Object.freeze([
      'offline_audit_is_not_production_tenant_boundary_proof',
    ]),
    missing_proof: Object.freeze([
      'production_tenant_boundary_proof',
    ]),
  }),
  Object.freeze({
    id: 'G_SECURITY_DRILLS',
    verdict: 'absent',
    evidence_class: 'explicit_unknown',
    title: 'Security / incident drills',
    source_proven: Object.freeze([]),
    staging_complete: Object.freeze([]),
    production_only_unknowns: Object.freeze([
      'security_drills',
      'incident_response_drill',
    ]),
    retained_gaps: Object.freeze([
      'no_committed_security_drill_evidence',
    ]),
    missing_proof: Object.freeze([
      'security_drills',
    ]),
  }),
  Object.freeze({
    id: 'G_OPERATED_READINESS',
    verdict: 'absent',
    evidence_class: 'explicit_unknown',
    title: 'Operated readiness (runbooks / on-call operated state)',
    source_proven: Object.freeze([]),
    staging_complete: Object.freeze([]),
    production_only_unknowns: Object.freeze([
      'operated_readiness',
      'production_operated_runbooks',
    ]),
    retained_gaps: Object.freeze([
      'operated_readiness_not_proven_by_offline_audit',
    ]),
    missing_proof: Object.freeze([
      'operated_readiness',
    ]),
  }),
  Object.freeze({
    id: 'G_FORTRESS_FINITE_AUDIT_WORKSTREAM',
    verdict: 'complete',
    evidence_class: 'finite_workstream_closeout_disposition',
    title: 'Finite FORTRESS audit workstream closeout',
    source_proven: Object.freeze([
      'independent_1D_validateCloseout',
      'retained_15A_and_15L_offline_gates_exit_0',
      'exact_git_tip_provenance',
    ]),
    staging_complete: Object.freeze([
      'finite_fortress_audit_workstream_closed',
    ]),
    production_only_unknowns: Object.freeze([
      'matrix_unproven_cleared_to_proven_fail_closed',
      'matrix_vulnerable_remediated',
      '15L_live_kv_secret_creation_and_staff_api_deploy_activation',
      'production_tenant_boundary_proof',
      'security_drills',
      'operated_readiness',
    ]),
    retained_gaps: Object.freeze([
      'fortress_security_and_production_readiness_remain_open',
      'MESSI_ledger_not_updated_by_this_slice',
    ]),
    missing_proof: Object.freeze([]),
  }),
  Object.freeze({
    id: 'G_FORTRESS_SECURITY_PRODUCTION_READINESS',
    verdict: 'absent',
    evidence_class: 'explicit_unknown',
    title: 'FORTRESS security / production readiness (aggregate)',
    source_proven: Object.freeze([]),
    staging_complete: Object.freeze([]),
    production_only_unknowns: Object.freeze([
      'matrix_unproven_cleared_to_proven_fail_closed',
      'matrix_vulnerable_remediated',
      '15L_live_kv_secret_creation_and_staff_api_deploy_activation',
      'production_tenant_boundary_proof',
      'security_drills',
      'operated_readiness',
    ]),
    retained_gaps: Object.freeze([
      'finite_audit_closeout_is_not_fortress_security_or_production_readiness',
    ]),
    missing_proof: Object.freeze([
      'fortress_security_production_readiness_proven',
    ]),
  }),
  Object.freeze({
    id: 'G_MESSI_MILESTONE',
    verdict: 'absent',
    evidence_class: 'explicit_unknown',
    title: 'MESSI milestone closeout',
    source_proven: Object.freeze([]),
    staging_complete: Object.freeze([]),
    production_only_unknowns: Object.freeze([
      'messi_parent_gates_complete',
      'cross_parent_integration',
      'production_readiness_proven',
    ]),
    retained_gaps: Object.freeze([
      '1D_does_not_update_MESSI_ledger',
      '1D_closes_FORTRESS_finite_audit_workstream_only',
    ]),
    missing_proof: Object.freeze([
      'messi_milestone_closeout',
    ]),
  }),
]);

const PROVES = Object.freeze([
  'finite_FORTRESS_audit_workstream_closed',
  'exact_git_provenance_for_15A_matrix_and_15L_signature_tip_blobs',
  'retained_15A_and_15L_offline_gates_executed',
  'matrix_counts_frozen_with_3_unproven_and_4_vulnerable',
  'deterministic_complete_partial_absent_classification',
  'activation_production_drills_operated_unknowns_remain_absent',
  'MESSI_ledger_untouched_by_1D_disposition',
]);

const DOES_NOT_PROVE = Object.freeze([
  'matrix_unproven_cleared',
  'matrix_vulnerable_remediated',
  '15L_live_kv_secret_creation_and_staff_api_deploy_activation',
  'production_tenant_isolation_payment_network_secret_proof',
  'security_drills',
  'operated_readiness',
  'FORTRESS_security_production_readiness',
  'MESSI_complete',
  'MESSI_ledger_G_FORTRESS_PARENT_complete',
  'runtime_security_deploy_behavior_change',
]);

const SCOPE_FENCE = Object.freeze({
  allowed: Object.freeze([
    'docs',
    'fixtures',
    'library_lock_module',
    'independent_verifier',
    'package_json_script_registration',
    'messi_1a_1b_factory_tip_allowlist_forward_compat_paths_only',
  ]),
  forbids: Object.freeze([
    'messi_ledger_semantic_update',
    'runtime_behavior_change',
    'security_config_change',
    'deploy_behavior_change',
    'db_mutation',
    'cloud_mutation',
    'network_live_action',
    'production_access',
    'relabeling_source_as_activation',
    'hiding_vulnerable_or_unproven_controls',
    'self_authored_completion_booleans',
  ]),
});

const THREAT_BOUNDARY = Object.freeze({
  summary:
    'Exports are deep-frozen against post-require assignment/redefinition. Not a defense against require.cache replacement or process-level code injection.',
  claimed: Object.freeze([
    'post_require_assignment_and_redefinition_of_exported_locks_and_validateCloseout',
  ]),
  not_claimed: Object.freeze([
    'require_cache_replacement',
    'rewrite_before_load',
    'process_level_code_injection',
  ]),
});

const REQUIRED_RED = Object.freeze([
  'stale_but_valid_ancestor_tip',
  'repinned_current_tree_hashes',
  'self_authored_completion_boolean',
  'hiding_vulnerable_unproven_controls',
  'relabeling_source_as_activation',
  'spoofed_locked_branch_name_rejected',
  'score_inflation_rejected',
  'fortress_readiness_flipped_complete',
  'messi_milestone_flipped_complete',
  'missing_fortress_ref',
  'altered_fortress_tip_file',
  'lock_hash_mismatch_rejected',
  'retained_gate_skip_env_rejected',
  'concurrent_merge_topology',
  'altered_candidate_scope',
  'non_descendant_tip_rejected',
  'missing_reviewed_candidate_ref',
  'altered_certificate_scope',
  'reordered_or_superseded_certificates',
  'multi_squash_unrelated_topology',
  'changed_protected_blob',
  'redesign_hash_tamper',
  'redesign_ref_tamper',
  'fixture_metadata_tamper',
  'source_fixture_co_tamper',
  'obsolete_authorization_green_name_absent',
]);

const REQUIRED_GREEN = Object.freeze([
  'score_frozen_3_0_8',
  'audit_source_and_finite_workstream_complete',
  'unknowns_absent',
  'matrix_counts_locked',
  'fortress_tip_provenance_enforced',
  'retained_15a_and_15l_gates_executed',
  'runtime_paths_unchanged',
  'messi_ledger_untouched',
  'package_script_registered',
  'no_doc_overclaim',
  'export_object_frozen',
  'master_basis_ancestor_of_head',
  'candidate_certificate_paths_git_bound',
  'blob_certificates_match_current_tree',
]);

const VALIDATOR_EXPORT = 'validateCloseout';
const MODULE_REL = LOCK_MODULE_REL;

function rootJoin(root, ...parts) {
  return path.join(root, ...parts);
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

function gitBlobSha256AtCommit(root, commitSha, rel) {
  const r = spawnSync('git', ['show', `${commitSha}:${rel}`], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) {
    return {
      ok: false,
      detail: String(r.stderr || r.stdout || 'git show failed'),
    };
  }
  return {
    ok: true,
    sha256: crypto.createHash('sha256').update(r.stdout).digest('hex'),
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

function currentBranch(root) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  } catch (_) {
    return 'HEAD';
  }
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

/** @deprecated Use tipAcceptsCertificates — branch name never trusted. */
function tipAccepts1d(tipSha, branchName, root) {
  return tipAcceptsCertificates(root, tipSha, branchName);
}

function makeSyntheticDescendantOfMaster(root) {
  const tree = execSync(`git rev-parse ${MASTER_BASIS}^{tree}`, {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  return execSync(
    `git commit-tree ${tree} -p ${MASTER_BASIS} -m "messi1d-synth-descendant-proof"`,
    { cwd: root, encoding: 'utf8' },
  ).trim();
}

function makeSyntheticDescendantOfLanding(root) {
  const head = currentHeadSha(root);
  const tree = execSync(`git rev-parse ${head}^{tree}`, {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const landing = resolveCommitSha(root, LANDING_TIP);
  const parent = landing || LANDING_TIP;
  return execSync(
    `git commit-tree ${tree} -p ${parent} -m "messi1d-synth-landing-descendant-proof"`,
    { cwd: root, encoding: 'utf8' },
  ).trim();
}

function makeUnrelatedOrphanCommit(root) {
  const tree = execSync(`git rev-parse ${FORTRESS_MASTER_BASIS}^{tree}`, {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  return execSync(
    `git commit-tree ${tree} -m "messi1d-unrelated-orphan-proof"`,
    { cwd: root, encoding: 'utf8' },
  ).trim();
}

function resolveTipSha(root, tipSha) {
  const raw = String(tipSha || '').trim();
  if (!raw || raw === 'HEAD') return currentHeadSha(root);
  return blobCerts.resolveCommitSha(root, raw);
}

function reviewedBlobCertificateConfig() {
  return {
    slice_cert_id: 'messi-1d-reviewed',
    master_basis: MASTER_BASIS,
    reviewed_candidate: REVIEWED_CANDIDATE,
    correction_candidate: CORRECTION_CANDIDATE_53C1,
    correction_cert_id: 'breakglass-53c1abcf',
    correction_basis: 'ff285598ac2cfec980e8316e772924a9c79a6a7e',
    redesign_cert_id: redesignPin.REDESIGN_CERT_ID,
    redesign_candidate_sha: redesignPin.REDESIGN_CANDIDATE_SHA,
    redesign_paths: redesignPin.REDESIGN_PATHS,
  };
}

function buildLockedReviewedBlobCertificates(root) {
  return blobCerts.buildSupersedingCertificateChain(root, reviewedBlobCertificateConfig());
}

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
 * @deprecated Use verifyReviewedBlobCertificatesAtTip.
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
function verifyPostLandingDeltaScope(root, opts) {
  return verifyReviewedBlobCertificatesAtTip(root, opts);
}

/**
 * Cryptographic FORTRESS tip provenance. Rejects stale-but-valid ancestors,
 * repinned current-tree hashes under a stale tip, and missing refs.
 */
function verifyFortressTipProvenance(root, opts) {
  const options = opts || {};
  const claimTip = options.canonical_tip || FORTRESS_TIP;
  const claimCandidate = options.candidate_sha || FORTRESS_CANDIDATE;
  const claimHashes = options.bound_hashes || FORTRESS_TIP_BOUND_HASHES;
  const errors = [];

  const lockedTip = resolveCommitSha(root, FORTRESS_TIP);
  const lockedCandidate = resolveCommitSha(root, FORTRESS_CANDIDATE);
  if (!lockedTip) errors.push(`missing_ref:locked_canonical_tip:${FORTRESS_TIP}`);
  if (!lockedCandidate) {
    errors.push(`missing_ref:locked_candidate_sha:${FORTRESS_CANDIDATE}`);
  }

  const tipSha = resolveCommitSha(root, claimTip);
  if (!tipSha) errors.push(`missing_ref:canonical_tip:${claimTip}`);
  const candidateSha = resolveCommitSha(root, claimCandidate);
  if (!candidateSha) errors.push(`missing_ref:candidate_sha:${claimCandidate}`);

  if (tipSha && lockedTip && tipSha !== lockedTip) {
    errors.push(`stale_or_wrong_canonical_tip:claimed=${tipSha}:locked=${lockedTip}`);
  }
  if (candidateSha && lockedCandidate && candidateSha !== lockedCandidate) {
    errors.push(
      `stale_or_wrong_candidate_sha:claimed=${candidateSha}:locked=${lockedCandidate}`,
    );
  }

  if (tipSha && !isGitAncestor(root, tipSha, MASTER_BASIS)
    && tipSha !== resolveCommitSha(root, MASTER_BASIS)) {
    if (!isGitAncestor(root, tipSha, MASTER_BASIS)) {
      errors.push(`fortress_tip_not_ancestor_of_messi_1d_basis:${tipSha}`);
    }
  }

  const tipForBlobs = tipSha || lockedTip;
  if (tipForBlobs) {
    for (const rel of FORTRESS_PROVENANCE_BOUND_FILES) {
      const expectedLocked = FORTRESS_TIP_BOUND_HASHES[rel];
      const expectedClaim = claimHashes[rel];
      const tipBlob = gitBlobSha256AtCommit(root, tipForBlobs, rel);
      if (!tipBlob.ok) {
        errors.push(`missing_blob_at_tip:${rel}`);
        continue;
      }
      if (expectedClaim && tipBlob.sha256 !== expectedClaim) {
        errors.push(
          `repinned_or_tip_blob_mismatch:${rel}:tip=${tipBlob.sha256}:claimed_hash=${expectedClaim}`,
        );
      }
      if (lockedTip) {
        const lockedBlob = gitBlobSha256AtCommit(root, lockedTip, rel);
        if (!lockedBlob.ok) {
          errors.push(`missing_blob_at_locked_tip:${rel}`);
        } else if (lockedBlob.sha256 !== expectedLocked) {
          errors.push(
            `locked_tip_blob_mismatch:${rel}:got=${lockedBlob.sha256}:expected=${expectedLocked}`,
          );
        }
      }
      if (!options.skipWorkingTreeCheck) {
        let wt = null;
        if (options.workingTreeHashes && options.workingTreeHashes[rel]) {
          wt = options.workingTreeHashes[rel];
        } else {
          const abs = rootJoin(root, rel);
          if (!fs.existsSync(abs)) {
            errors.push(`altered_fortress_file_missing:${rel}`);
            continue;
          }
          wt = sha256File(abs);
        }
        if (wt !== expectedLocked) {
          errors.push(`altered_fortress_tip_file:${rel}`);
        }
      }
    }
  }

  // Independent 15A matrix content binding at reviewed 15A tip.
  const auditTip = resolveCommitSha(root, FORTRESS_15A_TIP);
  if (!auditTip) {
    errors.push(`missing_ref:fortress_15a_tip:${FORTRESS_15A_TIP}`);
  } else {
    for (const rel of FORTRESS_15A_MATRIX_BOUND_FILES) {
      const expected = FORTRESS_15A_MATRIX_BOUND_HASHES[rel];
      const blob = gitBlobSha256AtCommit(root, auditTip, rel);
      if (!blob.ok) {
        errors.push(`missing_blob_at_15a_tip:${rel}`);
      } else if (blob.sha256 !== expected) {
        errors.push(
          `15a_matrix_blob_mismatch:${rel}:got=${blob.sha256}:expected=${expected}`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors, tipSha, candidateSha, auditTip };
}

function runRetainedFortressGate(root, scriptRel, npm, timeoutMs) {
  const scriptAbs = rootJoin(root, scriptRel);
  const started = Date.now();
  const env = { ...process.env };
  delete env.MESSI_1D_SKIP_FORTRESS_GATE;
  delete env.FORTRESS_SKIP_VERIFY;
  delete env.MESSI_1D_SKIP_15A_GATE;
  delete env.MESSI_1D_SKIP_15L_GATE;
  const r = spawnSync(process.execPath, [scriptAbs], {
    cwd: root,
    encoding: 'utf8',
    timeout: timeoutMs || 900000,
    env: { ...env, MESSI_NESTED_GATE: '1' },
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    id: npm,
    script: scriptRel,
    npm,
    status: r.status,
    ok: r.status === 0,
    elapsed_ms: Date.now() - started,
    stderr_tail: String(r.stderr || '').slice(-500),
  };
}

function runRetained15AGate(root, timeoutMs) {
  return runRetainedFortressGate(
    root,
    FORTRESS_15A_VERIFIER_SCRIPT,
    FORTRESS_15A_NPM_GATE,
    timeoutMs,
  );
}

function runRetained15LGate(root, timeoutMs) {
  return runRetainedFortressGate(
    root,
    FORTRESS_15L_VERIFIER_SCRIPT,
    FORTRESS_15L_NPM_GATE,
    timeoutMs,
  );
}

function readMatrixCounts(root) {
  const abs = rootJoin(root, 'fixtures/fortress-tenant-identity/boundary-matrix.json');
  const matrix = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const counts = {
    proven_fail_closed: 0,
    proven_isolated_by_runtime: 0,
    unproven: 0,
    vulnerable: 0,
    total: 0,
  };
  for (const b of matrix.boundaries || []) {
    if (Object.prototype.hasOwnProperty.call(counts, b.verdict)) {
      counts[b.verdict] += 1;
    }
    counts.total += 1;
  }
  return counts;
}

/**
 * Deterministic classifier. Verdicts come ONLY from GATE_EXPECTATIONS + whether
 * provenance/gate/matrix preconditions hold — never from evidence.self_authored.
 */
function classifyFortressCloseout(opts) {
  const {
    hashBindingOk,
    provenanceOk,
    retained15aOk,
    retained15lOk,
    matrixCountsOk,
  } = opts;

  const errors = [];
  if (!hashBindingOk) errors.push('hash_binding_failed');
  if (!provenanceOk) errors.push('fortress_tip_provenance_failed');
  if (!retained15aOk) errors.push('retained_15a_gate_failed');
  if (!retained15lOk) errors.push('retained_15l_gate_failed');
  if (!matrixCountsOk) errors.push('matrix_counts_mismatch');

  const preconditionsOk = hashBindingOk && provenanceOk && retained15aOk
    && retained15lOk && matrixCountsOk;
  const gates = GATE_EXPECTATIONS.map((exp) => {
    let verdict = exp.verdict;
    const missing = [...exp.missing_proof];
    if (!preconditionsOk) {
      if (exp.verdict === 'complete') {
        verdict = 'absent';
        if (!retained15aOk) missing.unshift('retained_15a_gate_exit_nonzero_or_missing');
        if (!retained15lOk) missing.unshift('retained_15l_gate_exit_nonzero_or_missing');
        if (!provenanceOk) missing.unshift('fortress_tip_provenance_failed');
        if (!hashBindingOk) missing.unshift('exact_file_hash_binding_failed');
        if (!matrixCountsOk) missing.unshift('matrix_counts_mismatch');
      }
    }
    return {
      id: exp.id,
      verdict,
      evidence_class: exp.evidence_class,
      title: exp.title,
      source_proven: [...exp.source_proven],
      staging_complete: [...exp.staging_complete],
      production_only_unknowns: [...exp.production_only_unknowns],
      retained_gaps: [...exp.retained_gaps],
      missing_proof: missing,
    };
  });

  const score = {
    proven: gates.filter((g) => g.verdict === 'complete').length,
    partial: gates.filter((g) => g.verdict === 'partial').length,
    absent: gates.filter((g) => g.verdict === 'absent').length,
    total: gates.length,
  };

  const finiteClosed = preconditionsOk
    && gates.find((g) => g.id === 'G_FORTRESS_FINITE_AUDIT_WORKSTREAM').verdict === 'complete'
    && gates.find((g) => g.id === 'G_15A_MATRIX_AUDIT').verdict === 'complete'
    && gates.find((g) => g.id === 'G_15L_SIGNATURE_SOURCE').verdict === 'complete';

  return {
    ok: errors.length === 0
      && deepEqual(score, FROZEN_SCORE)
      && gates.every((g) => VERDICTS.includes(g.verdict))
      && gates.find((g) => g.id === 'G_FORTRESS_SECURITY_PRODUCTION_READINESS').verdict === 'absent'
      && gates.find((g) => g.id === 'G_MESSI_MILESTONE').verdict === 'absent'
      && gates.find((g) => g.id === 'G_MATRIX_UNPROVEN_CLEARED').verdict === 'absent'
      && gates.find((g) => g.id === 'G_MATRIX_VULNERABLE_REMEDIATED').verdict === 'absent'
      && gates.find((g) => g.id === 'G_15L_LIVE_KV_DEPLOY_ACTIVATION').verdict === 'absent'
      && gates.find((g) => g.id === 'G_PRODUCTION_TENANT_BOUNDARY_PROOF').verdict === 'absent'
      && gates.find((g) => g.id === 'G_SECURITY_DRILLS').verdict === 'absent'
      && gates.find((g) => g.id === 'G_OPERATED_READINESS').verdict === 'absent',
    errors,
    score,
    gates,
    finite_workstream_closed: finiteClosed,
    fortress_security_production_ready: false,
    production_ready: false,
    messi_complete: false,
    workstream_class: WORKSTREAM_CLASS,
    progress_class: PROGRESS_CLASS,
    fortress_matrix_counts: { ...FORTRESS_MATRIX_VERDICT_COUNTS },
  };
}

function computeLockHash(evidence) {
  const copy = deepClone(evidence);
  delete copy.lock_hash;
  return sha256Text(stableStringify(copy));
}

function expectGateRow(evidenceGate, expected) {
  const errors = [];
  if (!evidenceGate) {
    errors.push(`missing_gate:${expected.id}`);
    return errors;
  }
  if (evidenceGate.verdict !== expected.verdict) {
    errors.push(
      `gate_verdict_mismatch:${expected.id}:got=${evidenceGate.verdict}:expected=${expected.verdict}`,
    );
  }
  if (evidenceGate.evidence_class !== expected.evidence_class) {
    errors.push(`gate_evidence_class_mismatch:${expected.id}`);
  }
  for (const field of [
    'source_proven',
    'staging_complete',
    'production_only_unknowns',
    'retained_gaps',
    'missing_proof',
  ]) {
    if (!deepEqual(evidenceGate[field] || [], [...expected[field]])) {
      errors.push(`gate_field_mismatch:${expected.id}:${field}`);
    }
  }
  return errors;
}

/**
 * Production validation path for committed evidence + every hostile RED mutation.
 */
function validateCloseout(evidence) {
  const errors = [];
  if (!evidence || typeof evidence !== 'object') {
    return { ok: false, errors: ['evidence_missing'] };
  }

  if (evidence.slice !== SLICE) errors.push('slice');
  if (evidence.outcome_id !== OUTCOME_ID) errors.push('outcome_id');
  if (evidence.branch !== BRANCH) errors.push('branch');
  if (evidence.master_basis !== MASTER_BASIS) errors.push('master_basis');
  if (evidence.progress_class !== PROGRESS_CLASS) errors.push('progress_class');
  if (evidence.workstream_class !== WORKSTREAM_CLASS) errors.push('workstream_class');
  if (evidence.completion_evidence !== COMPLETION_EVIDENCE) {
    errors.push('completion_evidence');
  }
  if (evidence.completion_requires !== COMPLETION_REQUIRES) {
    errors.push('completion_requires');
  }
  if (evidence.live_mutation !== false) errors.push('live_mutation');
  if (evidence.runtime_behavior_changed !== false) {
    errors.push('runtime_behavior_changed');
  }
  if (evidence.messi_ledger_updated !== false) errors.push('messi_ledger_updated');
  if (evidence.production_ready === true) errors.push('false_production_ready');
  if (evidence.messi_complete === true) errors.push('false_messi_complete');
  if (evidence.fortress_complete === true) {
    errors.push('self_authored_completion_boolean:fortress_complete');
  }
  if (evidence.fortress_security_production_ready === true) {
    errors.push('self_authored_completion_boolean:fortress_security_production_ready');
  }
  if (evidence.parent_complete === true) {
    errors.push('self_authored_completion_boolean:parent_complete');
  }
  if (evidence.workstream_complete === true) {
    errors.push('self_authored_completion_boolean:workstream_complete');
  }
  if (evidence.activation_complete === true) {
    errors.push('self_authored_completion_boolean:activation_complete');
  }

  if (!deepEqual(evidence.frozen_score, FROZEN_SCORE)) errors.push('frozen_score');
  if (!deepEqual(evidence.fortress_matrix_counts, { ...FORTRESS_MATRIX_VERDICT_COUNTS })) {
    errors.push('fortress_matrix_counts');
  }
  if (!deepEqual(evidence.matrix_unproven_ids, [...MATRIX_UNPROVEN_IDS])) {
    errors.push('matrix_unproven_ids');
  }
  if (!deepEqual(evidence.matrix_vulnerable_ids, [...MATRIX_VULNERABLE_IDS])) {
    errors.push('matrix_vulnerable_ids');
  }

  if (!deepEqual(evidence.fortress_tip, {
    canonical_tip: FORTRESS_TIP,
    candidate_sha: FORTRESS_CANDIDATE,
    master_basis: FORTRESS_MASTER_BASIS,
    tip_slice: FORTRESS_TIP_SLICE,
    audit_slice: FORTRESS_AUDIT_SLICE,
    audit_tip: FORTRESS_15A_TIP,
    audit_master_basis: FORTRESS_AUDIT_MASTER_BASIS,
    outcome_id: FORTRESS_OUTCOME_ID,
    npm_script_15a: FORTRESS_15A_NPM_GATE,
    npm_script_15l: FORTRESS_15L_NPM_GATE,
    verifier_script_15a: FORTRESS_15A_VERIFIER_SCRIPT,
    verifier_script_15l: FORTRESS_15L_VERIFIER_SCRIPT,
  })) {
    errors.push('fortress_tip_identity');
  }
  if (!deepEqual(evidence.fortress_tip_bound_hashes, { ...FORTRESS_TIP_BOUND_HASHES })) {
    errors.push('fortress_tip_bound_hashes');
  }
  if (!deepEqual(
    evidence.fortress_15a_matrix_bound_hashes,
    { ...FORTRESS_15A_MATRIX_BOUND_HASHES },
  )) {
    errors.push('fortress_15a_matrix_bound_hashes');
  }
  if (!deepEqual(evidence.proves, [...PROVES])) errors.push('proves');
  if (!deepEqual(evidence.does_not_prove, [...DOES_NOT_PROVE])) {
    errors.push('does_not_prove');
  }

  if (!Array.isArray(evidence.gates) || evidence.gates.length !== GATE_EXPECTATIONS.length) {
    errors.push('gates_length');
  } else {
    for (let i = 0; i < GATE_EXPECTATIONS.length; i += 1) {
      errors.push(...expectGateRow(evidence.gates[i], GATE_EXPECTATIONS[i]));
    }
  }

  // Hidden production/security gap: any absent-unknown gate flipped or unknowns emptied.
  for (const exp of GATE_EXPECTATIONS) {
    if (exp.verdict !== 'absent') continue;
    const g = (evidence.gates || []).find((x) => x.id === exp.id);
    if (g && g.verdict === 'complete') {
      errors.push(`hidden_production_gap_as_complete:${exp.id}`);
    }
    if (g && Array.isArray(g.production_only_unknowns)
      && exp.production_only_unknowns.length > 0
      && g.production_only_unknowns.length === 0) {
      errors.push(`production_unknowns_erased:${exp.id}`);
    }
  }

  // Hiding vulnerable/unproven controls via count wipe or id erasure.
  const counts = evidence.fortress_matrix_counts || {};
  if (counts.unproven === 0 || counts.vulnerable === 0
    || counts.unproven !== FORTRESS_MATRIX_VERDICT_COUNTS.unproven
    || counts.vulnerable !== FORTRESS_MATRIX_VERDICT_COUNTS.vulnerable) {
    errors.push('hiding_vulnerable_unproven_controls');
  }
  if (!Array.isArray(evidence.matrix_unproven_ids)
    || evidence.matrix_unproven_ids.length !== MATRIX_UNPROVEN_IDS.length
    || !Array.isArray(evidence.matrix_vulnerable_ids)
    || evidence.matrix_vulnerable_ids.length !== MATRIX_VULNERABLE_IDS.length) {
    errors.push('hiding_vulnerable_unproven_controls:ids');
  }

  // Relabeling source as activation.
  const act = (evidence.gates || []).find((x) => x.id === 'G_15L_LIVE_KV_DEPLOY_ACTIVATION');
  if (act && act.verdict === 'complete') {
    errors.push('relabeling_source_as_activation');
  }
  if (evidence.source_is_activation === true
    || evidence.live_activation_from_source === true) {
    errors.push('relabeling_source_as_activation:flag');
  }

  const expectedHash = computeLockHash(evidence);
  if (evidence.lock_hash !== expectedHash) {
    errors.push(`lock_hash_mismatch:got=${evidence.lock_hash}:expected=${expectedHash}`);
  }

  return { ok: errors.length === 0, errors };
}

function buildExpectedEvidenceSkeleton() {
  const skeleton = {
    schema_version: 1,
    slice: SLICE,
    outcome_id: OUTCOME_ID,
    branch: BRANCH,
    master_basis: MASTER_BASIS,
    progress_class: PROGRESS_CLASS,
    workstream_class: WORKSTREAM_CLASS,
    completion_evidence: COMPLETION_EVIDENCE,
    completion_requires: COMPLETION_REQUIRES,
    audit_only: true,
    live_mutation: false,
    runtime_behavior_changed: false,
    messi_ledger_updated: false,
    this_slice_deploys: false,
    production_ready: false,
    messi_complete: false,
    fortress_security_production_ready: false,
    title:
      'Finite FORTRESS audit workstream closeout — 15A matrix + 15L source proven offline; 3 unproven / 4 vulnerable retained; live KV/deploy activation, production tenant/payment/network/secret proof, drills, operated readiness, and FORTRESS security/production readiness remain absent; MESSI ledger not updated',
    fortress_tip: {
      canonical_tip: FORTRESS_TIP,
      candidate_sha: FORTRESS_CANDIDATE,
      master_basis: FORTRESS_MASTER_BASIS,
      tip_slice: FORTRESS_TIP_SLICE,
      audit_slice: FORTRESS_AUDIT_SLICE,
      audit_tip: FORTRESS_15A_TIP,
      audit_master_basis: FORTRESS_AUDIT_MASTER_BASIS,
      outcome_id: FORTRESS_OUTCOME_ID,
      npm_script_15a: FORTRESS_15A_NPM_GATE,
      npm_script_15l: FORTRESS_15L_NPM_GATE,
      verifier_script_15a: FORTRESS_15A_VERIFIER_SCRIPT,
      verifier_script_15l: FORTRESS_15L_VERIFIER_SCRIPT,
    },
    fortress_tip_bound_hashes: { ...FORTRESS_TIP_BOUND_HASHES },
    fortress_15a_matrix_bound_hashes: { ...FORTRESS_15A_MATRIX_BOUND_HASHES },
    fortress_matrix_counts: { ...FORTRESS_MATRIX_VERDICT_COUNTS },
    matrix_unproven_ids: [...MATRIX_UNPROVEN_IDS],
    matrix_vulnerable_ids: [...MATRIX_VULNERABLE_IDS],
    frozen_score: { ...FROZEN_SCORE },
    gate_ids: [...GATE_IDS],
    gates: GATE_EXPECTATIONS.map((g) => ({
      id: g.id,
      verdict: g.verdict,
      evidence_class: g.evidence_class,
      title: g.title,
      source_proven: [...g.source_proven],
      staging_complete: [...g.staging_complete],
      production_only_unknowns: [...g.production_only_unknowns],
      retained_gaps: [...g.retained_gaps],
      missing_proof: [...g.missing_proof],
    })),
    proves: [...PROVES],
    does_not_prove: [...DOES_NOT_PROVE],
    scope_fence: {
      allowed: [...SCOPE_FENCE.allowed],
      forbids: [...SCOPE_FENCE.forbids],
    },
  };
  skeleton.lock_hash = computeLockHash(skeleton);
  return skeleton;
}

deepFreeze(GATE_EXPECTATIONS);
deepFreeze(FORTRESS_TIP_BOUND_HASHES);
deepFreeze(FORTRESS_15A_MATRIX_BOUND_HASHES);
deepFreeze(FORTRESS_PROVENANCE_BOUND_FILES);
deepFreeze(FORTRESS_15A_MATRIX_BOUND_FILES);
deepFreeze(MUST_NOT_MUTATE);
deepFreeze(SCOPE_FENCE);
deepFreeze(PROVES);
deepFreeze(DOES_NOT_PROVE);
deepFreeze(FROZEN_SCORE);
deepFreeze(FORTRESS_MATRIX_VERDICT_COUNTS);
deepFreeze(MATRIX_UNPROVEN_IDS);
deepFreeze(MATRIX_VULNERABLE_IDS);
deepFreeze(GATE_IDS);
deepFreeze(REQUIRED_RED);
deepFreeze(REQUIRED_GREEN);
deepFreeze(THREAT_BOUNDARY);
deepFreeze(VERDICTS);

module.exports = deepFreeze({
  SLICE,
  BRANCH,
  OUTCOME_ID,
  COMPLETION_EVIDENCE,
  COMPLETION_REQUIRES,
  MASTER_BASIS,
  REVIEWED_CANDIDATE,
  LANDING_TIP,
  CORRECTION_CANDIDATE_53C1,
  redesignPin,
  PROGRESS_CLASS,
  WORKSTREAM_CLASS,
  FORTRESS_TIP,
  FORTRESS_CANDIDATE,
  FORTRESS_MASTER_BASIS,
  FORTRESS_TIP_SLICE,
  FORTRESS_AUDIT_SLICE,
  FORTRESS_OUTCOME_ID,
  FORTRESS_AUDIT_MASTER_BASIS,
  FORTRESS_15A_TIP,
  FORTRESS_15A_NPM_GATE,
  FORTRESS_15A_VERIFIER_SCRIPT,
  FORTRESS_15L_NPM_GATE,
  FORTRESS_15L_VERIFIER_SCRIPT,
  VERDICTS,
  GATE_IDS,
  FROZEN_SCORE,
  FORTRESS_MATRIX_VERDICT_COUNTS,
  MATRIX_UNPROVEN_IDS,
  MATRIX_VULNERABLE_IDS,
  PACKAGE_JSON_ALLOWED_SCRIPT_KEY,
  PACKAGE_JSON_ALLOWED_SCRIPT_VALUE,
  DOC_REL,
  EVIDENCE_REL,
  CONTRACT_REL,
  FINDINGS_REL,
  LOCK_MODULE_REL,
  VERIFIER_REL,
  MODULE_REL,
  FORTRESS_TIP_BOUND_HASHES,
  FORTRESS_15A_MATRIX_BOUND_HASHES,
  FORTRESS_PROVENANCE_BOUND_FILES,
  FORTRESS_15A_MATRIX_BOUND_FILES,
  MUST_NOT_MUTATE,
  GATE_EXPECTATIONS,
  PROVES,
  DOES_NOT_PROVE,
  SCOPE_FENCE,
  THREAT_BOUNDARY,
  REQUIRED_RED,
  REQUIRED_GREEN,
  VALIDATOR_EXPORT,
  deepFreeze,
  deepClone,
  deepEqual,
  thaw,
  stableStringify,
  sha256Text,
  sha256File,
  resolveCommitSha,
  isGitAncestor,
  gitBlobSha256AtCommit,
  currentHeadSha,
  currentBranch,
  tipAcceptsCertificates,
  tipAccepts1d,
  resolveTipSha,
  reviewedBlobCertificateConfig,
  buildLockedReviewedBlobCertificates,
  verifyReviewedBlobCertificatesAtTip,
  verifyReviewedCandidateScope,
  verifyMergedProvenance,
  verifyPostLandingDeltaScope,
  makeSyntheticDescendantOfMaster,
  makeSyntheticDescendantOfLanding,
  makeUnrelatedOrphanCommit,
  verifyFortressTipProvenance,
  runRetained15AGate,
  runRetained15LGate,
  readMatrixCounts,
  classifyFortressCloseout,
  computeLockHash,
  validateCloseout,
  buildExpectedEvidenceSkeleton,
});

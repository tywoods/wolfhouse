'use strict';

/**
 * messi-slice1b-foundation-closeout — MESSI Slice 1B sole production validation
 * module (docs/fixtures/library/verifier only).
 *
 * Freezes a finite FOUNDATION workstream closeout disposition derived from the
 * exact reviewed FOUNDATION-14AE tip blobs + retained offline gate. Marks only
 * the staging schema/migration/recovery finite workstream complete. Production
 * schema readiness, Docker fresh-db replacement, live restore/drill, and
 * operated-readiness remain absent unknowns. Does NOT update the MESSI 1A
 * ledger, claim production readiness, or close MESSI.
 *
 * Threat boundary (honest): module.exports is recursively deep-frozen with
 * non-writable/non-configurable descriptors so post-require assignment /
 * redefinition of exported locks or validateCloseout cannot alter validation.
 * This does NOT defend against require.cache replacement, rewriting this file
 * before load, or other process-level code injection.
 *
 * Post-merge tip scope: bind REVIEWED_CANDIDATE + LANDING_TIP provenance.
 * Never infer 1B scope from MASTER_BASIS..HEAD (concurrent unrelated master
 * commits after the squash — e.g. #147 — must not require a file allowlist).
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

function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function sha256File(absPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

const SLICE = 'MESSI-1B';
const BRANCH = 'messi/slice-1b-foundation-closeout';
const OUTCOME_ID = '1B_foundation_finite_workstream_closeout';
const COMPLETION_EVIDENCE = '1B_foundation_finite_workstream_closeout';
const COMPLETION_REQUIRES = 'verify:messi-slice1b-foundation-closeout';
/** MESSI 1A merge tip — this slice starts from master at this SHA. */
const MASTER_BASIS = '6106c27c54e25a8e4ba5ba00178d20be0c3e55f5';
/**
 * Exact reviewed 1B candidate (pre-squash). Tip scope binds to
 * MASTER_BASIS..REVIEWED_CANDIDATE — never base-to-HEAD (concurrent #147
 * landed after squash merge #145).
 */
const REVIEWED_CANDIDATE = '4a550b44bb7669a860557f0ec211260d7b76250c';
/** Squash-merge tip on master for this slice (PR #145). */
const LANDING_TIP = '98202775a57e64597e0e606a6e58933bb8ba7250';
const PROGRESS_CLASS = 'finite_staging_schema_migration_recovery_closeout_only';
const WORKSTREAM_CLASS = 'finite_staging_schema_migration_recovery_closeout';

/** Exact reviewed FOUNDATION tip (14AE). Identity candidate. */
const FOUNDATION_TIP = '32b44930685450cb27ac519d052332be7b18150d';
const FOUNDATION_CANDIDATE = FOUNDATION_TIP;
const FOUNDATION_MASTER_BASIS = '21371079ac5a331d47e7ed5f79351fceeeceefa6';
const FOUNDATION_TIP_SLICE = 'FOUNDATION-14AE';
const FOUNDATION_OUTCOME_ID = 'canonical_runner_noop_live_ok';
const FOUNDATION_NPM_GATE = 'verify:sunset-schema-slice14ae';
const FOUNDATION_VERIFIER_SCRIPT = 'scripts/verify-sunset-schema-slice14ae.js';

const VERDICTS = Object.freeze(['complete', 'partial', 'absent']);

const GATE_IDS = Object.freeze([
  'G_STAGING_SCHEMA_MIGRATION_RECOVERY',
  'G_DOCKER_FRESH_DB_REPLACEMENT',
  'G_PRODUCTION_SCHEMA_READINESS',
  'G_LIVE_RESTORE_DRILL',
  'G_OPERATED_READINESS',
  'G_FOUNDATION_FINITE_WORKSTREAM',
  'G_PRODUCTION_READINESS',
  'G_MESSI_MILESTONE',
]);

/** Frozen closeout score — only finite staging workstream gates may be complete. */
const FROZEN_SCORE = Object.freeze({
  proven: 2,
  partial: 0,
  absent: 6,
  total: 8,
});

const PACKAGE_JSON_ALLOWED_SCRIPT_KEY = 'verify:messi-slice1b-foundation-closeout';
const PACKAGE_JSON_ALLOWED_SCRIPT_VALUE =
  'node scripts/verify-messi-slice1b-foundation-closeout.js';

const DOC_REL = 'docs/FOUNDATION-FINITE-CLOSEOUT.md';
const EVIDENCE_REL = 'fixtures/foundation-closeout/finite-closeout.json';
const CONTRACT_REL = 'fixtures/foundation-closeout/contract.json';
const FINDINGS_REL = 'fixtures/foundation-closeout/findings.md';
const LOCK_MODULE_REL = 'scripts/lib/messi-slice1b-foundation-closeout.js';
const VERIFIER_REL = 'scripts/verify-messi-slice1b-foundation-closeout.js';

const ALLOWED_TIP_PATH_PREFIXES = Object.freeze([
  DOC_REL,
  'fixtures/foundation-closeout/',
  LOCK_MODULE_REL,
  VERIFIER_REL,
  // Tip-scope forward-compat only on MESSI 1A/1C allowlist + FACTORY 1B–1E
  // allowlists (paths / tip-scope hash rebinds; no ledger semantics from 1B).
  'docs/MESSI-ACCEPTANCE-LEDGER.md',
  'fixtures/messi-acceptance/',
  'scripts/lib/messi-slice1a-acceptance-ledger.js',
  'scripts/verify-messi-slice1a-acceptance-ledger.js',
  'scripts/lib/factory-slice1b-archetype-templates.js',
  'scripts/lib/factory-slice1c-dry-run-generator.js',
  'scripts/lib/factory-slice1d-integration-proof.js',
  'scripts/lib/factory-slice1e-finite-closeout.js',
  'scripts/verify-factory-slice1b-archetype-templates.js',
  'scripts/verify-factory-slice1e-finite-closeout.js',
  // Forward-compat tip-allowlist for MESSI 1D FORTRESS closeout (paths only).
  'docs/FORTRESS-FINITE-CLOSEOUT.md',
  'fixtures/fortress-closeout/',
  'scripts/lib/messi-slice1d-fortress-closeout.js',
  'scripts/verify-messi-slice1d-fortress-closeout.js',
  'package.json',
  'package-lock.json',
]);

/**
 * Exact tip-blob sha256 for FOUNDATION provenance_bound_files at FOUNDATION_TIP.
 * Independent of working-tree mutation after tip; must match git show tip:path.
 */
const FOUNDATION_TIP_BOUND_HASHES = Object.freeze({
  'fixtures/sunset-schema-observer/slice14ae-canonical-runner-noop-contract.json':
    '08bc566478a1d9fe6a47fe696dfa426d3707c1089c963941110104a541804327',
  'fixtures/sunset-schema-observer/slice14ae-canonical-runner-noop-evidence.json':
    'bbcd89f68c882168f0344ad4cfa252225d234ad65cc72149dd770f16c288a567',
  'fixtures/sunset-schema-observer/slice14ae-findings.md':
    '442548e91d36c739c411294a6c3ac4da7a834ac8497e1ea95eee23a0926b1947',
  'scripts/verify-sunset-schema-slice14ae.js':
    '73bb073442a78e30bec6d8717cfc7a4d10d85002e3257e1491f2da1c6b14faa4',
});

const FOUNDATION_PROVENANCE_BOUND_FILES = Object.freeze(
  Object.keys(FOUNDATION_TIP_BOUND_HASHES).sort(),
);

/** Runtime / migration / deploy paths this slice must not mutate vs MASTER_BASIS. */
const MUST_NOT_MUTATE = Object.freeze([
  'database/',
  'infra/',
  'scripts/staff-query-api.js',
  'scripts/run-canonical-migrations.js',
  'scripts/lib/migration-integrity.js',
  'scripts/lib/phase-d-canonical-runner-noop.js',
  'scripts/run-phase-d-canonical-runner-noop.js',
  'scripts/prove-sunset-schema-slice14ae-canonical-runner-noop.js',
  'scripts/verify-sunset-schema-slice14ae.js',
  'fixtures/sunset-schema-observer/slice14ae-canonical-runner-noop-contract.json',
  'fixtures/sunset-schema-observer/slice14ae-canonical-runner-noop-evidence.json',
  'fixtures/sunset-schema-observer/slice14ae-findings.md',
  'docker/hermes-staging/SOUL.md',
  // MESSI 1A semantic ledger fixtures may receive tip-scope hash rebinds only
  // (FACTORY forward-compat allowlist hashes). Classification / score / parents
  // must stay frozen — enforced in the verifier, not via blanket path ban.
]);

/**
 * Immutable independent gate expectations. Classifier output must match these
 * when retained gate passes and tip provenance binds — never from self-authored
 * booleans in the evidence fixture alone.
 */
const GATE_EXPECTATIONS = Object.freeze([
  Object.freeze({
    id: 'G_STAGING_SCHEMA_MIGRATION_RECOVERY',
    verdict: 'complete',
    evidence_class: 'tip_retained_staging_schema_noop',
    title: 'Sunset staging schema/migration/recovery finite workstream (14AE)',
    source_proven: Object.freeze([
      'FOUNDATION_14AE_canonical_runner_noop_live_ok',
      '39_row_provenance_baseline_ledger_zero_apply',
      'offline_verify_sunset_schema_slice14ae',
      'exact_tip_blob_hash_binding_at_32b44930',
    ]),
    staging_complete: Object.freeze([
      'sunset_staging_canonical_runner_noop',
      'ledger_digest_unchanged_pre_post',
      'zero_migration_sql_zero_ledger_insert',
    ]),
    production_only_unknowns: Object.freeze([]),
    retained_gaps: Object.freeze([
      'docker_fresh_db_replacement_not_this_gate',
      'production_schema_not_this_gate',
    ]),
    missing_proof: Object.freeze([]),
  }),
  Object.freeze({
    id: 'G_DOCKER_FRESH_DB_REPLACEMENT',
    verdict: 'absent',
    evidence_class: 'explicit_unknown',
    title: 'Docker fresh-db replacement proof',
    source_proven: Object.freeze([]),
    staging_complete: Object.freeze([]),
    production_only_unknowns: Object.freeze([
      'docker_fresh_db_replacement_proof',
    ]),
    retained_gaps: Object.freeze([
      '14AE_explicitly_forbids_claiming_docker_fresh_db_replacement',
      'docker_unavailable_on_14AE_host',
    ]),
    missing_proof: Object.freeze([
      'docker_fresh_db_replacement_proof',
    ]),
  }),
  Object.freeze({
    id: 'G_PRODUCTION_SCHEMA_READINESS',
    verdict: 'absent',
    evidence_class: 'explicit_unknown',
    title: 'Production schema readiness',
    source_proven: Object.freeze([]),
    staging_complete: Object.freeze([]),
    production_only_unknowns: Object.freeze([
      'production_schema_readiness',
      'production_migration_apply_path',
      'production_ledger_baseline',
    ]),
    retained_gaps: Object.freeze([
      'production_forbidden_in_14AE_and_1B',
      'claim_zero_remaining_drift_forbidden_by_14AE',
    ]),
    missing_proof: Object.freeze([
      'production_schema_readiness',
    ]),
  }),
  Object.freeze({
    id: 'G_LIVE_RESTORE_DRILL',
    verdict: 'absent',
    evidence_class: 'explicit_unknown',
    title: 'Live restore / recovery drill',
    source_proven: Object.freeze([]),
    staging_complete: Object.freeze([]),
    production_only_unknowns: Object.freeze([
      'live_restore_drill',
      'backup_restore_verification',
    ]),
    retained_gaps: Object.freeze([
      'no_committed_live_restore_drill_evidence',
    ]),
    missing_proof: Object.freeze([
      'live_restore_drill',
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
      'operated_readiness_not_proven_by_schema_noop',
    ]),
    missing_proof: Object.freeze([
      'operated_readiness',
    ]),
  }),
  Object.freeze({
    id: 'G_FOUNDATION_FINITE_WORKSTREAM',
    verdict: 'complete',
    evidence_class: 'finite_workstream_closeout_disposition',
    title: 'Finite FOUNDATION workstream closeout (staging only)',
    source_proven: Object.freeze([
      'independent_1B_validateCloseout',
      'retained_14AE_offline_gate_exit_0',
      'exact_git_tip_provenance',
    ]),
    staging_complete: Object.freeze([
      'finite_staging_schema_migration_recovery_closed',
    ]),
    production_only_unknowns: Object.freeze([
      'production_schema_readiness',
      'docker_fresh_db_replacement_proof',
      'live_restore_drill',
      'operated_readiness',
    ]),
    retained_gaps: Object.freeze([
      'production_and_MESSI_remain_open',
      'MESSI_1A_ledger_not_updated_by_this_slice',
    ]),
    missing_proof: Object.freeze([]),
  }),
  Object.freeze({
    id: 'G_PRODUCTION_READINESS',
    verdict: 'absent',
    evidence_class: 'explicit_unknown',
    title: 'Production readiness (aggregate)',
    source_proven: Object.freeze([]),
    staging_complete: Object.freeze([]),
    production_only_unknowns: Object.freeze([
      'production_schema_readiness',
      'docker_fresh_db_replacement_proof',
      'live_restore_drill',
      'operated_readiness',
    ]),
    retained_gaps: Object.freeze([
      'finite_staging_closeout_is_not_production_readiness',
    ]),
    missing_proof: Object.freeze([
      'production_readiness_proven',
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
      '1B_does_not_update_MESSI_1A_ledger',
      '1B_closes_FOUNDATION_finite_workstream_only',
    ]),
    missing_proof: Object.freeze([
      'messi_milestone_closeout',
    ]),
  }),
]);

const PROVES = Object.freeze([
  'finite_FOUNDATION_staging_schema_migration_recovery_workstream_closed',
  'exact_git_provenance_for_14AE_tip_blobs_and_retained_gate',
  'deterministic_complete_partial_absent_classification',
  'production_docker_restore_operated_unknowns_remain_absent',
  'MESSI_ledger_untouched_by_1B_disposition',
]);

const DOES_NOT_PROVE = Object.freeze([
  'production_schema_readiness',
  'docker_fresh_db_replacement',
  'live_restore_drill',
  'operated_readiness',
  'MESSI_complete',
  'MESSI_1A_ledger_G_FOUNDATION_PARENT_complete',
  'zero_remaining_drift',
  'runtime_migration_deploy_behavior_change',
]);

const SCOPE_FENCE = Object.freeze({
  allowed: Object.freeze([
    'docs',
    'fixtures',
    'library_lock_module',
    'independent_verifier',
    'package_json_script_registration',
    'messi_1a_tip_allowlist_forward_compat_paths_only',
  ]),
  forbids: Object.freeze([
    'messi_1a_ledger_semantic_update',
    'runtime_behavior_change',
    'migration_behavior_change',
    'deploy_behavior_change',
    'db_mutation',
    'cloud_mutation',
    'network_live_action',
    'production_access',
    'relabeling_production_unknowns_as_complete',
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
  'hidden_production_gap_as_complete',
  'spoofed_locked_branch_name_rejected',
  'score_inflation_rejected',
  'docker_unknown_flipped_complete',
  'production_unknown_flipped_complete',
  'messi_milestone_flipped_complete',
  'missing_foundation_ref',
  'altered_foundation_tip_file',
  'lock_hash_mismatch_rejected',
  'retained_gate_skip_env_rejected',
  'concurrent_merge_topology',
  'altered_candidate_scope',
  'non_descendant_tip_rejected',
  'missing_reviewed_candidate_ref',
]);

const REQUIRED_GREEN = Object.freeze([
  'score_frozen_2_0_6',
  'staging_and_finite_workstream_complete',
  'unknowns_absent',
  'foundation_tip_provenance_enforced',
  'retained_14ae_gate_executed',
  'runtime_paths_unchanged',
  'messi_ledger_untouched',
  'package_script_registered',
  'no_doc_overclaim',
  'export_object_frozen',
  'master_basis_ancestor_of_head',
  'reviewed_candidate_scope_authorized',
  'merged_provenance_matches_reviewed_candidate',
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
 * Tip acceptance is ancestry-only: HEAD (or claimed tip) must contain
 * LANDING_TIP (squash merge #145) as ancestor. Branch name is informational
 * and never trusted — including a tip claiming messi/slice-1b-foundation-closeout.
 * MASTER_BASIS-only descendants (pre-merge side tips) are rejected.
 */
function tipAccepts1b(tipSha, _branchName, root) {
  const tip = String(tipSha || '').trim();
  if (!/^[0-9a-f]{7,40}$/i.test(tip)) return false;
  const landing = resolveCommitSha(root, LANDING_TIP);
  if (!landing) return false;
  return isGitAncestor(root, landing, tip) || tip === landing;
}

function makeSyntheticDescendantOfMaster(root) {
  const tree = execSync(`git rev-parse ${MASTER_BASIS}^{tree}`, {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  return execSync(
    `git commit-tree ${tree} -p ${MASTER_BASIS} -m "messi1b-synth-descendant-proof"`,
    { cwd: root, encoding: 'utf8' },
  ).trim();
}

function makeSyntheticDescendantOfLanding(root) {
  const tree = execSync(`git rev-parse ${LANDING_TIP}^{tree}`, {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  return execSync(
    `git commit-tree ${tree} -p ${LANDING_TIP} -m "messi1b-synth-landing-descendant-proof"`,
    { cwd: root, encoding: 'utf8' },
  ).trim();
}

function makeUnrelatedOrphanCommit(root) {
  const tree = execSync(`git rev-parse ${FOUNDATION_MASTER_BASIS}^{tree}`, {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  return execSync(
    `git commit-tree ${tree} -m "messi1b-unrelated-orphan-proof"`,
    { cwd: root, encoding: 'utf8' },
  ).trim();
}

function tipPathAllowed(rel) {
  const p = String(rel || '');
  return ALLOWED_TIP_PATH_PREFIXES.some((pref) => (
    pref.endsWith('/')
      ? p.startsWith(pref) || p === pref.slice(0, -1)
      : p === pref
  ));
}

function unauthorizedTipPaths(paths) {
  return (paths || []).filter((p) => !tipPathAllowed(p));
}

/**
 * Paths changed between two commits. Fail-closed: returns null on git error.
 * Uses A..B (merge-base(A,B)..B).
 */
function listDiffPaths(root, fromSha, toSha) {
  try {
    const out = execSync(`git diff --name-only ${fromSha}..${toSha}`, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!out) return [];
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (_) {
    return null;
  }
}

/**
 * Scope fence for the exact reviewed candidate only. Unrelated commits that
 * landed on master after LANDING_TIP (e.g. #147) are not part of this diff and
 * need no file allowlist.
 */
function verifyReviewedCandidateScope(root, opts) {
  const options = opts || {};
  const claimCandidate = options.candidate_sha || REVIEWED_CANDIDATE;
  const errors = [];

  const lockedCandidate = resolveCommitSha(root, REVIEWED_CANDIDATE);
  if (!lockedCandidate) {
    errors.push(`missing_ref:locked_reviewed_candidate:${REVIEWED_CANDIDATE}`);
  }

  const candidateSha = resolveCommitSha(root, claimCandidate);
  if (!candidateSha) {
    errors.push(`missing_ref:reviewed_candidate:${claimCandidate}`);
  }

  if (candidateSha && lockedCandidate && candidateSha !== lockedCandidate) {
    errors.push(
      `stale_or_wrong_reviewed_candidate:claimed=${candidateSha}:locked=${lockedCandidate}`,
    );
  }

  if (candidateSha) {
    const basis = resolveCommitSha(root, MASTER_BASIS);
    if (basis
      && candidateSha !== basis
      && !isGitAncestor(root, basis, candidateSha)) {
      errors.push(`reviewed_candidate_not_descendant_of_master_basis:${candidateSha}`);
    }

    const paths = listDiffPaths(root, MASTER_BASIS, candidateSha);
    if (paths === null) {
      errors.push('candidate_diff_failed');
      return { ok: false, errors, paths: [], candidateSha };
    }
    const bad = unauthorizedTipPaths(paths);
    if (bad.length > 0) {
      errors.push(`altered_candidate_scope:${bad.join(',')}`);
    }
    return {
      ok: errors.length === 0,
      errors,
      paths,
      unauthorized: bad,
      candidateSha,
    };
  }

  return { ok: false, errors, paths: [], candidateSha: null };
}

/**
 * Merged provenance: LANDING_TIP (squash #145) carries the same blobs as
 * REVIEWED_CANDIDATE for every path in the candidate scope. Full-tree equality
 * is not required — later concurrent commits may differ outside 1B paths.
 */
function verifyMergedProvenance(root, opts) {
  const options = opts || {};
  const claimLanding = options.landing_tip || LANDING_TIP;
  const claimCandidate = options.candidate_sha || REVIEWED_CANDIDATE;
  const errors = [];

  const lockedLanding = resolveCommitSha(root, LANDING_TIP);
  const lockedCandidate = resolveCommitSha(root, REVIEWED_CANDIDATE);
  if (!lockedLanding) errors.push(`missing_ref:locked_landing_tip:${LANDING_TIP}`);
  if (!lockedCandidate) {
    errors.push(`missing_ref:locked_reviewed_candidate:${REVIEWED_CANDIDATE}`);
  }

  const landingSha = resolveCommitSha(root, claimLanding);
  if (!landingSha) errors.push(`missing_ref:landing_tip:${claimLanding}`);
  const candidateSha = resolveCommitSha(root, claimCandidate);
  if (!candidateSha) errors.push(`missing_ref:reviewed_candidate:${claimCandidate}`);

  if (landingSha && lockedLanding && landingSha !== lockedLanding) {
    errors.push(
      `stale_or_wrong_landing_tip:claimed=${landingSha}:locked=${lockedLanding}`,
    );
  }
  if (candidateSha && lockedCandidate && candidateSha !== lockedCandidate) {
    errors.push(
      `stale_or_wrong_reviewed_candidate:claimed=${candidateSha}:locked=${lockedCandidate}`,
    );
  }

  if (landingSha && candidateSha) {
    const basis = resolveCommitSha(root, MASTER_BASIS);
    if (basis
      && landingSha !== basis
      && !isGitAncestor(root, basis, landingSha)) {
      errors.push(`landing_tip_not_descendant_of_master_basis:${landingSha}`);
    }

    const paths = listDiffPaths(root, MASTER_BASIS, candidateSha);
    if (paths === null) {
      errors.push('candidate_diff_failed');
    } else {
      for (const rel of paths) {
        const a = gitBlobSha256AtCommit(root, candidateSha, rel);
        const b = gitBlobSha256AtCommit(root, landingSha, rel);
        if (!a.ok || !b.ok || a.sha256 !== b.sha256) {
          errors.push(`merged_provenance_blob_mismatch:${rel}`);
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    landingSha,
    candidateSha,
  };
}

/**
 * Dirty working-tree / untracked delta only (break-glass edits). Does not
 * re-scan MASTER_BASIS..HEAD concurrent files.
 */
function verifyWorkingTreeDeltaScope(root, opts) {
  const options = opts || {};
  const errors = [];
  let paths = [];
  try {
    const out = execSync('git diff --name-only HEAD', {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const staged = execSync('git diff --cached --name-only', {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    paths = [out, staged]
      .filter(Boolean)
      .join('\n')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (_) {
    errors.push('working_tree_diff_failed');
  }

  const untracked = options.untracked_paths;
  let extra = [];
  if (Array.isArray(untracked)) {
    extra = untracked;
  } else {
    try {
      extra = execSync('git ls-files --others --exclude-standard', {
        cwd: root,
        encoding: 'utf8',
      }).split('\n').map((s) => s.trim()).filter(Boolean)
        .filter((p) => !p.startsWith('tmp/'));
    } catch (_) {
      errors.push('untracked_list_failed');
    }
  }

  const all = [...new Set(paths.concat(extra))];
  const bad = unauthorizedTipPaths(all);
  if (bad.length > 0) errors.push(`working_tree_unauthorized:${bad.join(',')}`);
  return { ok: errors.length === 0, errors, paths: all, unauthorized: bad };
}

/**
 * Cryptographic FOUNDATION tip provenance. Rejects stale-but-valid ancestors,
 * repinned current-tree hashes under a stale tip, and missing refs.
 */
function verifyFoundationTipProvenance(root, opts) {
  const options = opts || {};
  const claimTip = options.canonical_tip || FOUNDATION_TIP;
  const claimCandidate = options.candidate_sha || FOUNDATION_CANDIDATE;
  const claimHashes = options.bound_hashes || FOUNDATION_TIP_BOUND_HASHES;
  const errors = [];

  const lockedTip = resolveCommitSha(root, FOUNDATION_TIP);
  const lockedCandidate = resolveCommitSha(root, FOUNDATION_CANDIDATE);
  if (!lockedTip) errors.push(`missing_ref:locked_canonical_tip:${FOUNDATION_TIP}`);
  if (!lockedCandidate) errors.push(`missing_ref:locked_candidate_sha:${FOUNDATION_CANDIDATE}`);

  const tipSha = resolveCommitSha(root, claimTip);
  if (!tipSha) errors.push(`missing_ref:canonical_tip:${claimTip}`);
  const candidateSha = resolveCommitSha(root, claimCandidate);
  if (!candidateSha) errors.push(`missing_ref:candidate_sha:${claimCandidate}`);

  if (tipSha && lockedTip && tipSha !== lockedTip) {
    errors.push(`stale_or_wrong_canonical_tip:claimed=${tipSha}:locked=${lockedTip}`);
  }
  if (candidateSha && lockedCandidate && candidateSha !== lockedCandidate) {
    errors.push(`stale_or_wrong_candidate_sha:claimed=${candidateSha}:locked=${lockedCandidate}`);
  }

  if (tipSha && !isGitAncestor(root, tipSha, MASTER_BASIS) && tipSha !== resolveCommitSha(root, MASTER_BASIS)) {
    // Tip must be ancestor of MESSI 1B master basis (14AE is on master lineage).
    if (!isGitAncestor(root, tipSha, MASTER_BASIS)) {
      errors.push(`foundation_tip_not_ancestor_of_messi_1b_basis:${tipSha}`);
    }
  }

  const tipForBlobs = tipSha || lockedTip;
  if (tipForBlobs) {
    for (const rel of FOUNDATION_PROVENANCE_BOUND_FILES) {
      const expectedLocked = FOUNDATION_TIP_BOUND_HASHES[rel];
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
            errors.push(`altered_foundation_file_missing:${rel}`);
            continue;
          }
          wt = sha256File(abs);
        }
        if (wt !== expectedLocked) {
          errors.push(`altered_foundation_tip_file:${rel}`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, tipSha, candidateSha };
}

function runRetainedFoundationGate(root, timeoutMs) {
  const scriptAbs = rootJoin(root, FOUNDATION_VERIFIER_SCRIPT);
  const started = Date.now();
  const env = { ...process.env };
  // Hostile: skip/probe env must not reduce checks.
  delete env.MESSI_1B_SKIP_FOUNDATION_GATE;
  delete env.FOUNDATION_SKIP_VERIFY;
  delete env.SUNSET_SCHEMA_SKIP_VERIFY;
  const r = spawnSync(process.execPath, [scriptAbs], {
    cwd: root,
    encoding: 'utf8',
    timeout: timeoutMs || 900000,
    env: { ...env, MESSI_NESTED_GATE: '1' },
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    id: 'foundation_14ae_offline',
    script: FOUNDATION_VERIFIER_SCRIPT,
    npm: FOUNDATION_NPM_GATE,
    status: r.status,
    ok: r.status === 0,
    elapsed_ms: Date.now() - started,
    stderr_tail: String(r.stderr || '').slice(-500),
  };
}

/**
 * Deterministic classifier. Verdicts come ONLY from GATE_EXPECTATIONS + whether
 * provenance/gate preconditions hold — never from evidence.self_authored flags.
 */
function classifyFoundationCloseout(opts) {
  const {
    hashBindingOk,
    provenanceOk,
    retainedGateOk,
  } = opts;

  const errors = [];
  if (!hashBindingOk) errors.push('hash_binding_failed');
  if (!provenanceOk) errors.push('foundation_tip_provenance_failed');
  if (!retainedGateOk) errors.push('retained_gate_failed');

  const preconditionsOk = hashBindingOk && provenanceOk && retainedGateOk;
  const gates = GATE_EXPECTATIONS.map((exp) => {
    let verdict = exp.verdict;
    const missing = [...exp.missing_proof];
    if (!preconditionsOk) {
      // Fail closed: cannot claim staging/finite complete without proof.
      if (exp.verdict === 'complete') {
        verdict = 'absent';
        if (!retainedGateOk) missing.unshift('retained_gate_exit_nonzero_or_missing');
        if (!provenanceOk) missing.unshift('foundation_tip_provenance_failed');
        if (!hashBindingOk) missing.unshift('exact_file_hash_binding_failed');
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
    && gates.find((g) => g.id === 'G_FOUNDATION_FINITE_WORKSTREAM').verdict === 'complete'
    && gates.find((g) => g.id === 'G_STAGING_SCHEMA_MIGRATION_RECOVERY').verdict === 'complete';

  return {
    ok: errors.length === 0
      && deepEqual(score, FROZEN_SCORE)
      && gates.every((g) => VERDICTS.includes(g.verdict))
      && gates.find((g) => g.id === 'G_PRODUCTION_READINESS').verdict === 'absent'
      && gates.find((g) => g.id === 'G_MESSI_MILESTONE').verdict === 'absent'
      && gates.find((g) => g.id === 'G_DOCKER_FRESH_DB_REPLACEMENT').verdict === 'absent'
      && gates.find((g) => g.id === 'G_PRODUCTION_SCHEMA_READINESS').verdict === 'absent'
      && gates.find((g) => g.id === 'G_LIVE_RESTORE_DRILL').verdict === 'absent'
      && gates.find((g) => g.id === 'G_OPERATED_READINESS').verdict === 'absent',
    errors,
    score,
    gates,
    finite_workstream_closed: finiteClosed,
    production_ready: false,
    messi_complete: false,
    workstream_class: WORKSTREAM_CLASS,
    progress_class: PROGRESS_CLASS,
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
    errors.push(`gate_verdict_mismatch:${expected.id}:got=${evidenceGate.verdict}:expected=${expected.verdict}`);
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
  if (evidence.completion_evidence !== COMPLETION_EVIDENCE) errors.push('completion_evidence');
  if (evidence.completion_requires !== COMPLETION_REQUIRES) errors.push('completion_requires');
  if (evidence.live_mutation !== false) errors.push('live_mutation');
  if (evidence.runtime_behavior_changed !== false) errors.push('runtime_behavior_changed');
  if (evidence.messi_ledger_updated !== false) errors.push('messi_ledger_updated');
  if (evidence.production_ready === true) errors.push('false_production_ready');
  if (evidence.messi_complete === true) errors.push('false_messi_complete');
  if (evidence.foundation_complete === true) errors.push('self_authored_completion_boolean:foundation_complete');
  if (evidence.parent_complete === true) errors.push('self_authored_completion_boolean:parent_complete');
  if (evidence.workstream_complete === true) {
    errors.push('self_authored_completion_boolean:workstream_complete');
  }

  if (!deepEqual(evidence.frozen_score, FROZEN_SCORE)) errors.push('frozen_score');
  if (!deepEqual(evidence.foundation_tip, {
    canonical_tip: FOUNDATION_TIP,
    candidate_sha: FOUNDATION_CANDIDATE,
    master_basis: FOUNDATION_MASTER_BASIS,
    tip_slice: FOUNDATION_TIP_SLICE,
    outcome_id: FOUNDATION_OUTCOME_ID,
    npm_script: FOUNDATION_NPM_GATE,
    verifier_script: FOUNDATION_VERIFIER_SCRIPT,
  })) {
    errors.push('foundation_tip_identity');
  }
  if (!deepEqual(evidence.foundation_tip_bound_hashes, { ...FOUNDATION_TIP_BOUND_HASHES })) {
    errors.push('foundation_tip_bound_hashes');
  }
  if (!deepEqual(evidence.proves, [...PROVES])) errors.push('proves');
  if (!deepEqual(evidence.does_not_prove, [...DOES_NOT_PROVE])) errors.push('does_not_prove');

  if (!Array.isArray(evidence.gates) || evidence.gates.length !== GATE_EXPECTATIONS.length) {
    errors.push('gates_length');
  } else {
    for (let i = 0; i < GATE_EXPECTATIONS.length; i += 1) {
      errors.push(...expectGateRow(evidence.gates[i], GATE_EXPECTATIONS[i]));
    }
  }

  // Hidden production gap: any absent-unknown gate flipped or unknowns emptied.
  for (const exp of GATE_EXPECTATIONS) {
    if (exp.verdict !== 'absent') continue;
    const g = (evidence.gates || []).find((x) => x.id === exp.id);
    if (g && g.verdict === 'complete') {
      errors.push(`hidden_production_gap_as_complete:${exp.id}`);
    }
    if (g && Array.isArray(g.production_only_unknowns) && exp.production_only_unknowns.length > 0
      && g.production_only_unknowns.length === 0) {
      errors.push(`production_unknowns_erased:${exp.id}`);
    }
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
    title:
      'Finite FOUNDATION workstream closeout — staging schema/migration/recovery complete; production/Docker/restore/operated unknowns remain absent; MESSI ledger not updated',
    foundation_tip: {
      canonical_tip: FOUNDATION_TIP,
      candidate_sha: FOUNDATION_CANDIDATE,
      master_basis: FOUNDATION_MASTER_BASIS,
      tip_slice: FOUNDATION_TIP_SLICE,
      outcome_id: FOUNDATION_OUTCOME_ID,
      npm_script: FOUNDATION_NPM_GATE,
      verifier_script: FOUNDATION_VERIFIER_SCRIPT,
    },
    foundation_tip_bound_hashes: { ...FOUNDATION_TIP_BOUND_HASHES },
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
deepFreeze(FOUNDATION_TIP_BOUND_HASHES);
deepFreeze(FOUNDATION_PROVENANCE_BOUND_FILES);
deepFreeze(MUST_NOT_MUTATE);
deepFreeze(ALLOWED_TIP_PATH_PREFIXES);
deepFreeze(SCOPE_FENCE);
deepFreeze(PROVES);
deepFreeze(DOES_NOT_PROVE);
deepFreeze(FROZEN_SCORE);
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
  PROGRESS_CLASS,
  WORKSTREAM_CLASS,
  REVIEWED_CANDIDATE,
  LANDING_TIP,
  FOUNDATION_TIP,
  FOUNDATION_CANDIDATE,
  FOUNDATION_MASTER_BASIS,
  FOUNDATION_TIP_SLICE,
  FOUNDATION_OUTCOME_ID,
  FOUNDATION_NPM_GATE,
  FOUNDATION_VERIFIER_SCRIPT,
  VERDICTS,
  GATE_IDS,
  FROZEN_SCORE,
  PACKAGE_JSON_ALLOWED_SCRIPT_KEY,
  PACKAGE_JSON_ALLOWED_SCRIPT_VALUE,
  DOC_REL,
  EVIDENCE_REL,
  CONTRACT_REL,
  FINDINGS_REL,
  LOCK_MODULE_REL,
  VERIFIER_REL,
  MODULE_REL,
  ALLOWED_TIP_PATH_PREFIXES,
  FOUNDATION_TIP_BOUND_HASHES,
  FOUNDATION_PROVENANCE_BOUND_FILES,
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
  tipAccepts1b,
  tipPathAllowed,
  unauthorizedTipPaths,
  listDiffPaths,
  verifyReviewedCandidateScope,
  verifyMergedProvenance,
  verifyWorkingTreeDeltaScope,
  makeSyntheticDescendantOfMaster,
  makeSyntheticDescendantOfLanding,
  makeUnrelatedOrphanCommit,
  verifyFoundationTipProvenance,
  runRetainedFoundationGate,
  classifyFoundationCloseout,
  computeLockHash,
  validateCloseout,
  buildExpectedEvidenceSkeleton,
});

'use strict';

/**
 * foundation-slice1j-docker-gate-complete — FOUNDATION Slice 1J
 *
 * One-gate classification: integrate the merged, reviewed
 * verify:foundation-docker-fresh-db-replacement-evidence result into a
 * FOUNDATION disposition overlay. Promotes G_DOCKER_FRESH_DB_REPLACEMENT
 * absent → complete (score 2/0/6 → 3/0/5). Does not mutate certificate-bound
 * MESSI-1B closeout blobs, the canonical MESSI ledger, or claim production
 * readiness. No certificate architecture. No live Docker rerun.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const dockerEvidence = require('./foundation-docker-fresh-db-replacement-evidence');
const foundation1b = require('./messi-slice1b-foundation-closeout');

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

const SLICE = 'FOUNDATION-1J';
const BRANCH = 'foundation/slice-1j-docker-gate-complete';
const OUTCOME_ID = '1J_docker_fresh_db_replacement_gate_complete';
const COMPLETION_EVIDENCE = '1J_docker_fresh_db_replacement_gate_complete';
const COMPLETION_REQUIRES = 'verify:foundation-slice1j-docker-gate-complete';
/** Slice starts from master at the Docker-proof re-anchor tip. */
const MASTER_BASIS = 'f99c8bdc3106c3995b72aaff22e351337eb71590';
const PROGRESS_CLASS = 'one_gate_docker_fresh_db_replacement_classification';
const WORKSTREAM_CLASS = 'finite_staging_schema_migration_recovery_closeout';

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

/** Frozen FOUNDATION disposition score after Docker-gate promotion. */
const FROZEN_SCORE = Object.freeze({
  proven: 3,
  partial: 0,
  absent: 5,
  total: 8,
});

/** Historical 1B score — certificate-bound disposition remains unchanged. */
const FOUNDATION_1B_FROZEN_SCORE = Object.freeze({
  proven: 2,
  partial: 0,
  absent: 6,
  total: 8,
});

const PACKAGE_JSON_ALLOWED_SCRIPT_KEY = 'verify:foundation-slice1j-docker-gate-complete';
const PACKAGE_JSON_ALLOWED_SCRIPT_VALUE =
  'node scripts/verify-foundation-slice1j-docker-gate-complete.js';

const DOC_REL = 'docs/FOUNDATION-SLICE-1J-DOCKER-GATE.md';
const EVIDENCE_REL = 'fixtures/foundation-slice1j/disposition.json';
const CONTRACT_REL = 'fixtures/foundation-slice1j/contract.json';
const FINDINGS_REL = 'fixtures/foundation-slice1j/findings.md';
const LOCK_MODULE_REL = 'scripts/lib/foundation-slice1j-docker-gate-complete.js';
const VERIFIER_REL = 'scripts/verify-foundation-slice1j-docker-gate-complete.js';

const EVIDENCE_NPM_GATE = 'verify:foundation-docker-fresh-db-replacement-evidence';
const EVIDENCE_VERIFIER_REL =
  'scripts/verify-foundation-docker-fresh-db-replacement-evidence.js';

const DOCKER_SOURCE_PROVEN = Object.freeze([
  'verify_foundation_docker_fresh_db_replacement_evidence',
  'two_empty_docker_postgres_volumes',
  'canonical_manifest_forward_43_applied_both_cycles',
  'identical_schema_migrations_hash_both_cycles',
  'identical_schema_fingerprint_both_cycles',
  'cleanup_verified_both_cycles',
]);

/**
 * Independent gate expectations. Docker gate complete only when the reviewed
 * evidence gate preconditions hold — never from self-authored booleans.
 */
const GATE_EXPECTATIONS = Object.freeze([
  Object.freeze({
    id: 'G_STAGING_SCHEMA_MIGRATION_RECOVERY',
    verdict: 'complete',
    evidence_class: 'tip_retained_staging_schema_noop',
    title: 'Sunset staging schema/migration/recovery finite workstream (14AE)',
    source_proven: Object.freeze([
      'FOUNDATION_14AE_canonical_runner_noop_live_ok',
      'MESSI_1B_finite_closeout_retained',
    ]),
    staging_complete: Object.freeze([
      'sunset_staging_canonical_runner_noop',
    ]),
    production_only_unknowns: Object.freeze([]),
    retained_gaps: Object.freeze([
      'production_schema_not_this_gate',
    ]),
    missing_proof: Object.freeze([]),
  }),
  Object.freeze({
    id: 'G_DOCKER_FRESH_DB_REPLACEMENT',
    verdict: 'complete',
    evidence_class: 'lunabox_disposable_docker_compared_evidence',
    title: 'Docker fresh-db replacement proof',
    source_proven: DOCKER_SOURCE_PROVEN,
    staging_complete: Object.freeze([
      'two_cycle_docker_fresh_db_replacement_compared',
    ]),
    production_only_unknowns: Object.freeze([]),
    retained_gaps: Object.freeze([
      'docker_proof_is_not_production_schema_readiness',
      'docker_proof_is_not_live_restore_drill',
      'docker_proof_is_not_FOUNDATION_production_readiness',
      'MESSI_1A_ledger_not_updated_by_this_slice',
    ]),
    missing_proof: Object.freeze([]),
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
      'production_forbidden_in_1J',
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
    title: 'Operated readiness / compatibility (runbooks / on-call)',
    source_proven: Object.freeze([]),
    staging_complete: Object.freeze([]),
    production_only_unknowns: Object.freeze([
      'operated_readiness',
      'production_operated_runbooks',
      'compatibility_operated_state',
    ]),
    retained_gaps: Object.freeze([
      'operated_readiness_not_proven_by_docker_proof',
    ]),
    missing_proof: Object.freeze([
      'operated_readiness',
    ]),
  }),
  Object.freeze({
    id: 'G_FOUNDATION_FINITE_WORKSTREAM',
    verdict: 'complete',
    evidence_class: 'finite_workstream_closeout_disposition',
    title: 'Finite FOUNDATION workstream closeout (staging + Docker gate)',
    source_proven: Object.freeze([
      'MESSI_1B_finite_closeout_retained',
      'independent_1J_validateDisposition',
      'reviewed_docker_evidence_gate_exit_0',
    ]),
    staging_complete: Object.freeze([
      'finite_staging_schema_migration_recovery_closed',
      'docker_fresh_db_replacement_gate_closed',
    ]),
    production_only_unknowns: Object.freeze([
      'production_schema_readiness',
      'live_restore_drill',
      'operated_readiness',
    ]),
    retained_gaps: Object.freeze([
      'production_and_MESSI_remain_open',
      'MESSI_1A_ledger_not_updated_by_this_slice',
      'certificate_bound_1B_blobs_unchanged',
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
      'live_restore_drill',
      'operated_readiness',
    ]),
    retained_gaps: Object.freeze([
      'docker_proof_is_not_production_readiness',
      'finite_closeout_is_not_production_readiness',
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
      '1J_does_not_update_MESSI_1A_ledger',
      '1J_closes_docker_gate_only',
    ]),
    missing_proof: Object.freeze([
      'messi_milestone_closeout',
    ]),
  }),
]);

/** Parent-level remaining missing proof after removing only the Docker gate. */
const PARENT_REMAINING_MISSING_PROOF = Object.freeze([
  'production_schema_readiness',
  'live_restore_drill',
  'operated_readiness',
]);

const PROVES = Object.freeze([
  'G_DOCKER_FRESH_DB_REPLACEMENT_complete_from_reviewed_evidence',
  'FOUNDATION_score_3_0_5',
  'docker_gate_removed_from_missing_proof_only',
  'production_schema_restore_operated_MESSI_remain_absent',
  'MESSI_ledger_untouched_by_1J_disposition',
  'certificate_bound_1B_disposition_unchanged',
]);

const DOES_NOT_PROVE = Object.freeze([
  'production_schema_readiness',
  'live_restore_drill',
  'operated_readiness',
  'FOUNDATION_production_readiness',
  'MESSI_complete',
  'MESSI_1A_ledger_G_FOUNDATION_PARENT_complete',
  'certificate_architecture',
  'live_docker_rerun',
  'runtime_migration_deploy_behavior_change',
]);

const SCOPE_FENCE = Object.freeze({
  allowed: Object.freeze([
    'docs',
    'fixtures_foundation_slice1j',
    'library_lock_module',
    'independent_verifier',
    'package_json_script_registration',
  ]),
  forbids: Object.freeze([
    'messi_1a_ledger_semantic_update',
    'certificate_bound_1b_blob_mutation',
    'certificate_architecture',
    'live_docker_rerun',
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

/** Exactly two hostile REDs for this one-gate slice. */
const REQUIRED_RED = Object.freeze([
  'evidence-gate-skipped',
  'Docker-proof-promoted-to-production-readiness',
]);

const REQUIRED_GREEN = Object.freeze([
  'score_frozen_3_0_5',
  'docker_gate_complete',
  'docker_removed_from_missing_proof_only',
  'unknowns_remain_absent',
  'evidence_gate_executed',
  'foundation_1b_disposition_untouched',
  'messi_ledger_untouched',
  'package_script_registered',
  'no_doc_overclaim',
  'export_object_frozen',
  'production_ready_false',
]);

const VALIDATOR_EXPORT = 'validateDisposition';
const MODULE_REL = LOCK_MODULE_REL;

function rootJoin(root, ...parts) {
  return path.join(root, ...parts);
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
 * Deterministic classifier. Docker complete only when evidenceGateOk.
 */
function classifyFoundation1j(opts) {
  const { evidenceGateOk, foundation1bUntouched } = opts;
  const errors = [];
  if (!evidenceGateOk) errors.push('evidence_gate_failed');
  if (!foundation1bUntouched) errors.push('foundation_1b_disposition_mutated');

  const preconditionsOk = evidenceGateOk === true && foundation1bUntouched === true;
  const gates = GATE_EXPECTATIONS.map((exp) => {
    let verdict = exp.verdict;
    const missing = [...exp.missing_proof];
    if (!preconditionsOk && exp.verdict === 'complete') {
      verdict = 'absent';
      if (!evidenceGateOk) missing.unshift('evidence_gate_exit_nonzero_or_skipped');
      if (!foundation1bUntouched) missing.unshift('foundation_1b_disposition_mutated');
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

  return {
    ok: errors.length === 0
      && deepEqual(score, FROZEN_SCORE)
      && gates.find((g) => g.id === 'G_DOCKER_FRESH_DB_REPLACEMENT').verdict === 'complete'
      && gates.find((g) => g.id === 'G_PRODUCTION_READINESS').verdict === 'absent'
      && gates.find((g) => g.id === 'G_MESSI_MILESTONE').verdict === 'absent'
      && gates.find((g) => g.id === 'G_PRODUCTION_SCHEMA_READINESS').verdict === 'absent'
      && gates.find((g) => g.id === 'G_LIVE_RESTORE_DRILL').verdict === 'absent'
      && gates.find((g) => g.id === 'G_OPERATED_READINESS').verdict === 'absent',
    errors,
    score,
    gates,
    production_ready: false,
    messi_complete: false,
    parent_remaining_missing_proof: [...PARENT_REMAINING_MISSING_PROOF],
    workstream_class: WORKSTREAM_CLASS,
    progress_class: PROGRESS_CLASS,
  };
}

function validateDisposition(evidence) {
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
  if (evidence.certificate_architecture !== false) errors.push('certificate_architecture');
  if (evidence.live_rerun !== false) errors.push('live_rerun');
  if (evidence.production_ready === true) errors.push('false_production_ready');
  if (evidence.messi_complete === true) errors.push('false_messi_complete');
  if (evidence.foundation_complete === true) {
    errors.push('self_authored_completion_boolean:foundation_complete');
  }
  if (evidence.parent_complete === true) {
    errors.push('self_authored_completion_boolean:parent_complete');
  }
  if (evidence.docker_gate_complete === true) {
    // Completion is classifier-derived, not a self-authored boolean.
    errors.push('self_authored_completion_boolean:docker_gate_complete');
  }

  if (!deepEqual(evidence.frozen_score, FROZEN_SCORE)) errors.push('frozen_score');
  if (!deepEqual(evidence.parent_remaining_missing_proof, [...PARENT_REMAINING_MISSING_PROOF])) {
    errors.push('parent_remaining_missing_proof');
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

  // Docker must be complete with empty missing_proof.
  const docker = (evidence.gates || []).find((g) => g.id === 'G_DOCKER_FRESH_DB_REPLACEMENT');
  if (!docker || docker.verdict !== 'complete' || (docker.missing_proof || []).length !== 0) {
    errors.push('docker_gate_not_complete');
  }

  // Parent remaining missing proof must not still list docker.
  if ((evidence.parent_remaining_missing_proof || [])
    .includes('docker_fresh_db_replacement_proof')) {
    errors.push('docker_still_in_missing_proof');
  }

  // Hidden production gap: absent unknowns flipped complete.
  for (const exp of GATE_EXPECTATIONS) {
    if (exp.verdict !== 'absent') continue;
    const g = (evidence.gates || []).find((x) => x.id === exp.id);
    if (g && g.verdict === 'complete') {
      errors.push(`hidden_production_gap_as_complete:${exp.id}`);
    }
  }

  // Docker proof must not imply production readiness.
  if (evidence.production_ready === true
    || (evidence.gates || []).find((g) => g.id === 'G_PRODUCTION_READINESS')?.verdict === 'complete') {
    errors.push('Docker-proof-promoted-to-production-readiness');
  }

  const expectedHash = computeLockHash(evidence);
  if (evidence.lock_hash !== expectedHash) {
    errors.push(`lock_hash_mismatch:got=${evidence.lock_hash}:expected=${expectedHash}`);
  }

  return { ok: errors.length === 0, errors };
}

function buildExpectedDispositionSkeleton() {
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
    certificate_architecture: false,
    live_rerun: false,
    this_slice_deploys: false,
    production_ready: false,
    messi_complete: false,
    title:
      'FOUNDATION 1J — Docker fresh-db replacement gate complete from reviewed evidence; production/restore/operated/MESSI remain absent; MESSI ledger not updated',
    evidence_gate: {
      npm_script: EVIDENCE_NPM_GATE,
      verifier_script: EVIDENCE_VERIFIER_REL,
      candidate_sha: dockerEvidence.CANDIDATE_SHA,
      outcome_id: dockerEvidence.OUTCOME_ID,
      forwardCount: dockerEvidence.FORWARD_COUNT,
      schema_fingerprint: dockerEvidence.SCHEMA_FINGERPRINT,
      schema_migrations_hash: dockerEvidence.SCHEMA_MIGRATIONS_HASH,
    },
    foundation_1b_retained: {
      npm_script: foundation1b.PACKAGE_JSON_ALLOWED_SCRIPT_KEY,
      frozen_score: { ...FOUNDATION_1B_FROZEN_SCORE },
      docker_gate_verdict: 'absent',
      note: 'Certificate-bound 1B disposition blobs remain unchanged; 1J is an overlay classification.',
    },
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
    parent_remaining_missing_proof: [...PARENT_REMAINING_MISSING_PROOF],
    parent_production_readiness: 'absent',
    parent_verdict: 'partial',
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

function runEvidenceGate(root, timeoutMs) {
  const started = Date.now();
  const env = { ...process.env };
  delete env.FOUNDATION_1J_SKIP_EVIDENCE_GATE;
  delete env.FOUNDATION_SKIP_DOCKER_EVIDENCE;
  delete env.SKIP_DOCKER_EVIDENCE_GATE;

  const r = spawnSync(process.execPath, [path.join('scripts', path.basename(EVIDENCE_VERIFIER_REL))], {
    cwd: root,
    encoding: 'utf8',
    timeout: timeoutMs || 120000,
    env: {
      ...env,
      MESSI_NESTED_GATE: '1',
      NODE_PATH: [path.join(root, 'node_modules'), env.NODE_PATH || '']
        .filter(Boolean)
        .join(path.delimiter),
    },
    maxBuffer: 16 * 1024 * 1024,
  });

  return {
    id: 'foundation_docker_evidence',
    script: EVIDENCE_VERIFIER_REL,
    npm: EVIDENCE_NPM_GATE,
    status: r.status,
    ok: r.status === 0,
    elapsed_ms: Date.now() - started,
    stderr_tail: String(r.stderr || '').slice(-500),
    stdout_tail: String(r.stdout || '').slice(-500),
  };
}

/**
 * Prove certificate-bound 1B docker gate + score bytes are still the frozen
 * absent/2-0-6 disposition (1J must not mutate those blobs).
 */
function foundation1bDispositionUntouched(root) {
  const errors = [];
  const closeoutRel = foundation1b.EVIDENCE_REL;
  const abs = rootJoin(root, closeoutRel);
  if (!fs.existsSync(abs)) {
    return { ok: false, errors: [`missing:${closeoutRel}`] };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    return { ok: false, errors: [`parse:${closeoutRel}:${String(err && err.message)}`] };
  }
  if (!deepEqual(parsed.frozen_score, FOUNDATION_1B_FROZEN_SCORE)) {
    errors.push('foundation_1b_frozen_score_drift');
  }
  const docker = (parsed.gates || []).find((g) => g.id === 'G_DOCKER_FRESH_DB_REPLACEMENT');
  if (!docker || docker.verdict !== 'absent') {
    errors.push('foundation_1b_docker_gate_not_absent');
  }
  if (!deepEqual(foundation1b.FROZEN_SCORE, FOUNDATION_1B_FROZEN_SCORE)) {
    errors.push('foundation_1b_lock_score_drift');
  }
  const lockDocker = foundation1b.GATE_EXPECTATIONS
    .find((g) => g.id === 'G_DOCKER_FRESH_DB_REPLACEMENT');
  if (!lockDocker || lockDocker.verdict !== 'absent') {
    errors.push('foundation_1b_lock_docker_not_absent');
  }
  return { ok: errors.length === 0, errors };
}

function messiLedgerUntouched(root) {
  const errors = [];
  const ledgerRel = 'fixtures/messi-acceptance/slice1a-ledger.json';
  const abs = rootJoin(root, ledgerRel);
  if (!fs.existsSync(abs)) {
    return { ok: false, errors: [`missing:${ledgerRel}`] };
  }
  const ledger = JSON.parse(fs.readFileSync(abs, 'utf8'));
  if (!deepEqual(ledger.frozen_messi_score, { proven: 0, partial: 4, absent: 2, total: 6 })) {
    errors.push('frozen_messi_score_drift');
  }
  const parent = (ledger.gates || []).find((g) => g.id === 'G_FOUNDATION_PARENT');
  if (!parent || parent.verdict !== 'partial') {
    errors.push('G_FOUNDATION_PARENT_not_partial');
  }
  if (!parent || parent.production_readiness !== 'absent') {
    errors.push('G_FOUNDATION_PARENT_production_readiness_not_absent');
  }
  // Post MESSI-1J wiring: docker proof removed from missing; score 3/0/5 exposed;
  // parent remains partial. Pre-wiring trees still listing docker fail this check.
  if (!Array.isArray(parent.missing_proof)
    || parent.missing_proof.includes('docker_fresh_db_replacement_proof')) {
    errors.push('MESSI_parent_missing_proof_still_lists_docker_after_wiring');
  }
  for (const m of [
    'production_schema_readiness',
    'live_restore_drill',
    'operated_readiness',
  ]) {
    if (!Array.isArray(parent.missing_proof) || !parent.missing_proof.includes(m)) {
      errors.push(`MESSI_parent_missing_proof_lost:${m}`);
    }
  }
  if (!parent.foundation_score
    || parent.foundation_score.proven !== 3
    || parent.foundation_score.partial !== 0
    || parent.foundation_score.absent !== 5) {
    errors.push('MESSI_parent_foundation_score_not_3_0_5');
  }
  return { ok: errors.length === 0, errors };
}

deepFreeze(GATE_EXPECTATIONS);
deepFreeze(PARENT_REMAINING_MISSING_PROOF);
deepFreeze(PROVES);
deepFreeze(DOES_NOT_PROVE);
deepFreeze(SCOPE_FENCE);
deepFreeze(FROZEN_SCORE);
deepFreeze(FOUNDATION_1B_FROZEN_SCORE);
deepFreeze(GATE_IDS);
deepFreeze(REQUIRED_RED);
deepFreeze(REQUIRED_GREEN);
deepFreeze(VERDICTS);
deepFreeze(DOCKER_SOURCE_PROVEN);

module.exports = deepFreeze({
  SLICE,
  BRANCH,
  OUTCOME_ID,
  COMPLETION_EVIDENCE,
  COMPLETION_REQUIRES,
  MASTER_BASIS,
  PROGRESS_CLASS,
  WORKSTREAM_CLASS,
  VERDICTS,
  GATE_IDS,
  FROZEN_SCORE,
  FOUNDATION_1B_FROZEN_SCORE,
  PACKAGE_JSON_ALLOWED_SCRIPT_KEY,
  PACKAGE_JSON_ALLOWED_SCRIPT_VALUE,
  DOC_REL,
  EVIDENCE_REL,
  CONTRACT_REL,
  FINDINGS_REL,
  LOCK_MODULE_REL,
  VERIFIER_REL,
  MODULE_REL,
  EVIDENCE_NPM_GATE,
  EVIDENCE_VERIFIER_REL,
  GATE_EXPECTATIONS,
  PARENT_REMAINING_MISSING_PROOF,
  PROVES,
  DOES_NOT_PROVE,
  SCOPE_FENCE,
  REQUIRED_RED,
  REQUIRED_GREEN,
  VALIDATOR_EXPORT,
  dockerEvidence,
  foundation1b,
  deepFreeze,
  deepClone,
  deepEqual,
  thaw,
  stableStringify,
  sha256Text,
  sha256File,
  computeLockHash,
  classifyFoundation1j,
  validateDisposition,
  buildExpectedDispositionSkeleton,
  runEvidenceGate,
  foundation1bDispositionUntouched,
  messiLedgerUntouched,
});

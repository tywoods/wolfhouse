'use strict';

/**
 * verify:staging-ledger-recovery — RED→GREEN gate for the staging ledger
 * recovery plan/certification contract (dry-run only; mutation disabled).
 *
 * No database connection. No Azure. No secrets. No live mutation.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  reconcileLedger,
  forwardEntries,
  loadManifest,
  validateManifestIntegrity,
  MANIFEST_PATH,
  APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER,
} = require('./lib/migration-integrity');
const { scanSecretValues } = require('./lib/sunset-staging-iac-drift');
const {
  STAGING_LEDGER_RECOVERY_MUTATION_ENABLED,
  EVIDENCE_KIND,
  SLICE_ID,
  ENV_RECOVERY,
  ENV_APPROVAL_TOKEN,
  CLI_PLAN_ONLY,
  CLI_APPROVE,
  CLI_APPLY_MUTATION,
  APPROVAL_TOKEN,
  KNOWN_PARTIAL_SCENARIO,
  RECOVERY_TARGET,
  SAFE_OUTPUT_KEYS,
  evaluateRecoveryGates,
  validateEvidenceArtifact,
  certifyContiguousBaseline,
  buildRecoveryPlan,
  executeRecoveryMutation,
  publicResult,
  sealEvidence,
  buildFixtureEvidence,
  exactRecoveryPlanArgv,
  recoveryPlanEnv,
  loadLiveManifestContext,
  digestEvidencePayload,
  APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE,
} = require('./lib/staging-ledger-recovery');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'staging-ledger-recovery');
const CONTRACT_PATH = path.join(FIX, 'staging-ledger-recovery-contract.json');
const EVIDENCE_PATH = path.join(FIX, 'staging-ledger-recovery-evidence.example.json');
const CLI_PATH = path.join(ROOT, 'scripts', 'run-staging-ledger-recovery.js');
const LIB_PATH = path.join(ROOT, 'scripts', 'lib', 'staging-ledger-recovery.js');
const DOC_PATH = path.join(ROOT, 'docs', 'STAGING-LEDGER-RECOVERY.md');

const REQUIRED_RED = [
  'default_path_disabled',
  'missing_approval_token',
  'missing_approval_flag',
  'production_target_refused',
  'target_mismatch',
  'partial_ledger_refused_unexpected_shape',
  'missing_evidence_historical',
  'missing_assertions',
  'checksum_mismatch',
  'manifest_hash_mismatch',
  'executed_runner_label_refused',
  'arbitrary_sql_refused',
  'non_contiguous_baseline',
  'mutation_disabled',
  'forbidden_argv_dsn_sql',
];

const REQUIRED_GREEN = [
  'mutation_remains_disabled',
  'canonical_reconcile_still_fails_partial_042',
  'fixture_evidence_certifies_contiguous_baseline',
  'projected_reconcile_ok',
  'never_labels_recovery_executed_runner',
  'dry_run_plan_public_output_secret_free',
  'cli_plan_only_success',
  'docs_and_contract_present',
];

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function deepClone(x) {
  return JSON.parse(JSON.stringify(x));
}

function runCli(env, argv) {
  return spawnSync(process.execPath, [CLI_PATH, ...argv], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function parseLastJson(stdout) {
  const text = String(stdout || '').trim();
  const start = text.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

function main() {
  console.log('verify:staging-ledger-recovery — RED→GREEN\n');

  const redCases = [];
  const greenCases = [];
  const ctx = loadLiveManifestContext();
  pass('live-manifest-integrity', ctx.integrity.ok, JSON.stringify((ctx.integrity.errors || []).slice(0, 2)));
  pass('live-forward-count-41', ctx.forward.length === 41, `forward=${ctx.forward.length}`);

  const goodEvidence = buildFixtureEvidence({ manifestContext: ctx });
  fs.mkdirSync(FIX, { recursive: true });
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(goodEvidence, null, 2)}\n`);

  const contractSeed = {
    kind: 'staging-ledger-recovery-contract',
    slice: SLICE_ID,
    secretFree: true,
    planOnly: true,
    dryRunDefault: true,
    containsLiveApplyCode: false,
    mutationEnabled: false,
    mutationMode: 'disabled_until_later_approved_slice',
    allowsExecutedByCanonicalRunnerLabel: false,
    acceptsArbitrarySql: false,
    weakensCanonicalReconcile: false,
    evidenceKind: EVIDENCE_KIND,
    knownPartialScenario: KNOWN_PARTIAL_SCENARIO,
    target: RECOVERY_TARGET,
    manifestHash: ctx.manifestHash,
    forwardCount: ctx.forward.length,
    checksumMode: 'canonical_lf_v1',
    approvalTokenEnv: ENV_APPROVAL_TOKEN,
    approvalFlag: CLI_APPROVE,
    planOnlyFlag: CLI_PLAN_ONLY,
    requiredRed: REQUIRED_RED,
    requiredGreen: REQUIRED_GREEN,
  };
  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(contractSeed, null, 2)}\n`);

  // ── RED cases ──────────────────────────────────────────────────────────
  {
    const gates = evaluateRecoveryGates({ env: {}, argv: [] });
    const ok = gates.ok === false && gates.errors.some((e) => e.code === 'env_required');
    redCases.push({ name: 'default_path_disabled', ok, code: gates.code });
    pass('red-default_path_disabled', ok);
  }
  {
    const gates = evaluateRecoveryGates({
      env: { [ENV_RECOVERY]: '1' },
      argv: exactRecoveryPlanArgv(EVIDENCE_PATH),
    });
    const ok = gates.ok === false
      && gates.errors.some((e) => e.code === 'operator_approval_token_required');
    redCases.push({ name: 'missing_approval_token', ok });
    pass('red-missing_approval_token', ok);
  }
  {
    const argv = exactRecoveryPlanArgv(EVIDENCE_PATH).filter((a) => a !== CLI_APPROVE);
    const gates = evaluateRecoveryGates({ env: recoveryPlanEnv(), argv });
    const ok = gates.ok === false
      && gates.errors.some((e) => e.code === 'operator_approval_flag_required');
    redCases.push({ name: 'missing_approval_flag', ok });
    pass('red-missing_approval_flag', ok);
  }
  {
    const ev = sealEvidence({
      ...deepClone(goodEvidence),
      target: { ...RECOVERY_TARGET, environment: 'production', database: 'production' },
    });
    delete ev.evidenceDigest;
    const sealed = sealEvidence(ev);
    const gate = validateEvidenceArtifact(sealed);
    const ok = gate.ok === false
      && gate.errors.some((e) => e.code === 'production_target_refused');
    redCases.push({ name: 'production_target_refused', ok });
    pass('red-production_target_refused', ok);
  }
  {
    const ev = deepClone(goodEvidence);
    ev.target = { ...RECOVERY_TARGET, database: 'wrong_db' };
    delete ev.evidenceDigest;
    const sealed = sealEvidence(ev);
    const gate = validateEvidenceArtifact(sealed);
    const ok = gate.ok === false
      && gate.errors.some((e) => e.code === 'target_database_mismatch' || e.code === 'target_mismatch');
    redCases.push({ name: 'target_mismatch', ok });
    pass('red-target_mismatch', ok, JSON.stringify((gate.errors || []).slice(0, 2)));
  }
  {
    const ev = deepClone(goodEvidence);
    ev.observedLedger = {
      diagnosisCode: KNOWN_PARTIAL_SCENARIO.diagnosisCode,
      rows: [
        ev.observedLedger.rows[0],
        { ...ev.observedLedger.rows[0], id: '041_notification_surfpack_convergence', apply_order: 39 },
      ],
    };
    delete ev.evidenceDigest;
    const sealed = sealEvidence(ev);
    const gate = validateEvidenceArtifact(sealed);
    const ok = gate.ok === false
      && gate.errors.some((e) => e.code === 'partial_ledger_refused');
    redCases.push({ name: 'partial_ledger_refused_unexpected_shape', ok });
    pass('red-partial_ledger_refused_unexpected_shape', ok);
  }
  {
    const ev = deepClone(goodEvidence);
    ev.historicalMigrations = ev.historicalMigrations.slice(1);
    delete ev.evidenceDigest;
    const sealed = sealEvidence(ev);
    const result = certifyContiguousBaseline({ evidence: sealed, manifestContext: ctx });
    const ok = result.ok === false
      && result.errors.some((e) => e.code === 'missing_evidence');
    redCases.push({ name: 'missing_evidence_historical', ok });
    pass('red-missing_evidence_historical', ok);
  }
  {
    const ev = deepClone(goodEvidence);
    ev.historicalMigrations[0].requiredAssertionIds = ['need-this'];
    ev.historicalMigrations[0].structuralAssertions = [];
    delete ev.evidenceDigest;
    const sealed = sealEvidence(ev);
    const result = certifyContiguousBaseline({ evidence: sealed, manifestContext: ctx });
    const ok = result.ok === false
      && result.errors.some((e) => e.code === 'missing_assertions');
    redCases.push({ name: 'missing_assertions', ok });
    pass('red-missing_assertions', ok);
  }
  {
    const ev = deepClone(goodEvidence);
    ev.historicalMigrations[0].checksumSha256 = '0'.repeat(64);
    delete ev.evidenceDigest;
    const sealed = sealEvidence(ev);
    const result = certifyContiguousBaseline({ evidence: sealed, manifestContext: ctx });
    const ok = result.ok === false
      && result.errors.some((e) => e.code === 'checksum_mismatch');
    redCases.push({ name: 'checksum_mismatch', ok });
    pass('red-checksum_mismatch', ok);
  }
  {
    const ev = deepClone(goodEvidence);
    ev.manifest.manifestHash = 'a'.repeat(64);
    delete ev.evidenceDigest;
    const sealed = sealEvidence(ev);
    const result = certifyContiguousBaseline({ evidence: sealed, manifestContext: ctx });
    const ok = result.ok === false
      && result.errors.some((e) => e.code === 'manifest_hash_mismatch');
    redCases.push({ name: 'manifest_hash_mismatch', ok });
    pass('red-manifest_hash_mismatch', ok);
  }
  {
    const ev = deepClone(goodEvidence);
    ev.historicalMigrations[0].applyKind = APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER;
    delete ev.evidenceDigest;
    const sealed = sealEvidence(ev);
    const result = certifyContiguousBaseline({ evidence: sealed, manifestContext: ctx });
    const ok = result.ok === false
      && result.errors.some((e) => e.code === 'executed_runner_label_refused');
    redCases.push({ name: 'executed_runner_label_refused', ok });
    pass('red-executed_runner_label_refused', ok);
  }
  {
    const ev = deepClone(goodEvidence);
    const a = ev.historicalMigrations[0].structuralAssertions[0];
    a.sql = 'SELECT 1';
    delete ev.evidenceDigest;
    const sealed = sealEvidence(ev);
    const result = certifyContiguousBaseline({ evidence: sealed, manifestContext: ctx });
    const ok = result.ok === false
      && result.errors.some((e) => e.code === 'arbitrary_sql_refused');
    redCases.push({ name: 'arbitrary_sql_refused', ok });
    pass('red-arbitrary_sql_refused', ok);
  }
  {
    const ev = deepClone(goodEvidence);
    // Drop order 1 evidence but keep count via duplicating another — force gap.
    ev.historicalMigrations = ev.historicalMigrations.filter((h) => h.order !== 1);
    const clone = deepClone(ev.historicalMigrations[0]);
    clone.id = `${clone.id}__dup`;
    ev.historicalMigrations.push(clone);
    delete ev.evidenceDigest;
    const sealed = sealEvidence(ev);
    const result = certifyContiguousBaseline({ evidence: sealed, manifestContext: ctx });
    const ok = result.ok === false
      && result.errors.some((e) => (
        e.code === 'non_contiguous_baseline'
        || e.code === 'missing_evidence'
        || e.code === 'unknown_migration_id'
      ));
    redCases.push({ name: 'non_contiguous_baseline', ok });
    pass('red-non_contiguous_baseline', ok, JSON.stringify((result.errors || []).slice(0, 3)));
  }
  {
    const mut = executeRecoveryMutation();
    const gates = evaluateRecoveryGates({
      env: recoveryPlanEnv(),
      argv: [...exactRecoveryPlanArgv(EVIDENCE_PATH), CLI_APPLY_MUTATION],
    });
    const ok = mut.ok === false
      && mut.code === 'mutation_disabled'
      && STAGING_LEDGER_RECOVERY_MUTATION_ENABLED === false
      && gates.ok === false
      && gates.errors.some((e) => e.code === 'mutation_disabled' || e.code === 'forbidden_argv');
    redCases.push({ name: 'mutation_disabled', ok });
    pass('red-mutation_disabled', ok);
  }
  {
    const gates = evaluateRecoveryGates({
      env: recoveryPlanEnv(),
      argv: [...exactRecoveryPlanArgv(EVIDENCE_PATH), '--dsn', 'postgres://secret'],
    });
    const ok = gates.ok === false
      && gates.errors.some((e) => e.code === 'forbidden_argv' && e.flag === '--dsn');
    redCases.push({ name: 'forbidden_argv_dsn_sql', ok });
    pass('red-forbidden_argv_dsn_sql', ok);
  }

  // ── GREEN cases ────────────────────────────────────────────────────────
  {
    const ok = STAGING_LEDGER_RECOVERY_MUTATION_ENABLED === false
      && executeRecoveryMutation().code === 'mutation_disabled';
    greenCases.push({ name: 'mutation_remains_disabled', ok });
    pass('green-mutation_remains_disabled', ok);
  }
  {
    const manifest = loadManifest(MANIFEST_PATH);
    const forward = forwardEntries(manifest);
    const only042 = forward.find((e) => e.id === KNOWN_PARTIAL_SCENARIO.soleRowId);
    const recon = reconcileLedger(forward, [{
      id: only042.id,
      filename: only042.filename,
      checksum_sha256: only042.sha256,
      apply_order: only042.order,
      apply_kind: APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER,
      checksum_mode: 'canonical_lf_v1',
      ledger_recorded_at: '2026-07-21T00:00:00.000Z',
    }]);
    const ok = recon.ok === false
      && recon.errors.some((e) => e.code === 'ledger_partial_history');
    greenCases.push({ name: 'canonical_reconcile_still_fails_partial_042', ok });
    pass('green-canonical_reconcile_still_fails_partial_042', ok);
  }
  {
    const result = certifyContiguousBaseline({
      evidence: goodEvidence,
      manifestContext: ctx,
      requireDigest: true,
    });
    const ok = result.ok === true
      && result.certified === true
      && result.code === 'contiguous_baseline_certified'
      && result.proposedInsertCount === KNOWN_PARTIAL_SCENARIO.historicalOrderEnd
      && result.projectedLedgerCount === KNOWN_PARTIAL_SCENARIO.recoveryTipOrder
      && result.dryRun === true
      && result.mutationEnabled === false;
    greenCases.push({ name: 'fixture_evidence_certifies_contiguous_baseline', ok });
    pass('green-fixture_evidence_certifies_contiguous_baseline', ok, result.code);
  }
  {
    const result = certifyContiguousBaseline({ evidence: goodEvidence, manifestContext: ctx });
    const recon = reconcileLedger(ctx.forward, result.projectedLedger || []);
    const ok = result.ok && recon.ok === true;
    greenCases.push({ name: 'projected_reconcile_ok', ok });
    pass('green-projected_reconcile_ok', ok, JSON.stringify((recon.errors || []).slice(0, 2)));
  }
  {
    const result = certifyContiguousBaseline({ evidence: goodEvidence, manifestContext: ctx });
    const ok = result.ok
      && (result.proposedInserts || []).every((r) => r.apply_kind !== APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER)
      && (result.proposedInserts || []).every((r) => r.apply_kind === APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE)
      && !/executed_by_canonical_runner/.test(JSON.stringify(result.proposedInserts || []));
    greenCases.push({ name: 'never_labels_recovery_executed_runner', ok });
    pass('green-never_labels_recovery_executed_runner', ok);
  }
  {
    const plan = buildRecoveryPlan({
      env: recoveryPlanEnv(),
      argv: exactRecoveryPlanArgv(EVIDENCE_PATH),
      evidence: goodEvidence,
      gates: { env: recoveryPlanEnv(), argv: exactRecoveryPlanArgv(EVIDENCE_PATH) },
    });
    const pub = publicResult(plan);
    const hits = scanSecretValues(pub);
    const ok = plan.ok === true
      && pub.ok === true
      && hits.length === 0
      && Object.keys(pub).every((k) => SAFE_OUTPUT_KEYS.includes(k))
      && !JSON.stringify(pub).includes('postgres://')
      && !JSON.stringify(pub).includes('PASSWORD');
    greenCases.push({ name: 'dry_run_plan_public_output_secret_free', ok });
    pass('green-dry_run_plan_public_output_secret_free', ok);
  }
  {
    const cli = runCli(recoveryPlanEnv(), exactRecoveryPlanArgv(EVIDENCE_PATH));
    const json = parseLastJson(cli.stdout);
    const ok = cli.status === 0
      && json
      && json.ok === true
      && json.certified === true
      && json.planOnly === true
      && json.mutationEnabled === false
      && json.liveMutation === false;
    greenCases.push({ name: 'cli_plan_only_success', ok });
    pass('green-cli_plan_only_success', ok, `status=${cli.status} code=${json && json.code}`);
  }
  {
    const ok = fs.existsSync(DOC_PATH)
      && fs.existsSync(CONTRACT_PATH)
      && fs.existsSync(LIB_PATH)
      && fs.existsSync(CLI_PATH)
      && /ledger_partial_history/.test(fs.readFileSync(DOC_PATH, 'utf8'))
      && /mutation/i.test(fs.readFileSync(DOC_PATH, 'utf8'))
      && /executed_by_canonical_runner/.test(fs.readFileSync(DOC_PATH, 'utf8'));
    greenCases.push({ name: 'docs_and_contract_present', ok });
    pass('green-docs_and_contract_present', ok);
  }

  // Contract artifact + secret-free source scan
  const contract = {
    kind: 'staging-ledger-recovery-contract',
    slice: SLICE_ID,
    secretFree: true,
    planOnly: true,
    dryRunDefault: true,
    containsLiveApplyCode: false,
    mutationEnabled: false,
    mutationMode: 'disabled_until_later_approved_slice',
    allowsExecutedByCanonicalRunnerLabel: false,
    acceptsArbitrarySql: false,
    weakensCanonicalReconcile: false,
    evidenceKind: EVIDENCE_KIND,
    knownPartialScenario: KNOWN_PARTIAL_SCENARIO,
    target: RECOVERY_TARGET,
    manifestHash: ctx.manifestHash,
    forwardCount: ctx.forward.length,
    checksumMode: 'canonical_lf_v1',
    approvalTokenEnv: ENV_APPROVAL_TOKEN,
    approvalFlag: CLI_APPROVE,
    planOnlyFlag: CLI_PLAN_ONLY,
    requiredRed: REQUIRED_RED,
    requiredGreen: REQUIRED_GREEN,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`);

  const redNames = redCases.map((c) => c.name);
  const greenNames = greenCases.map((c) => c.name);
  pass(
    'contract-required-red-complete',
    REQUIRED_RED.every((n) => redNames.includes(n)) && redCases.every((c) => c.ok),
    JSON.stringify(redCases.filter((c) => !c.ok).map((c) => c.name)),
  );
  pass(
    'contract-required-green-complete',
    REQUIRED_GREEN.every((n) => greenNames.includes(n)) && greenCases.every((c) => c.ok),
    JSON.stringify(greenCases.filter((c) => !c.ok).map((c) => c.name)),
  );

  const artifactPaths = [LIB_PATH, CLI_PATH, CONTRACT_PATH, EVIDENCE_PATH, DOC_PATH, __filename];
  let secretHits = 0;
  for (const p of artifactPaths) {
    if (!fs.existsSync(p)) continue;
    const hits = scanSecretValues(fs.readFileSync(p, 'utf8'));
    if (hits.length) {
      secretHits += 1;
      console.log(`        secret hit in ${path.relative(ROOT, p)}: ${hits.map((h) => h.pattern).join(',')}`);
    }
  }
  pass('green-artifacts-secret-free', secretHits === 0);

  // Evidence digest stability
  pass(
    'green-evidence-digest-stable',
    goodEvidence.evidenceDigest === digestEvidencePayload(goodEvidence),
  );

  // Canonical integrity untouched
  const integrity = validateManifestIntegrity(loadManifest(MANIFEST_PATH));
  pass('green-canonical-manifest-integrity-untouched', integrity.ok);

  console.log(`\n── verify:staging-ledger-recovery: ${failed ? 'FAILED' : 'PASSED'} ──`);
  process.exit(failed ? 1 : 0);
}

main();

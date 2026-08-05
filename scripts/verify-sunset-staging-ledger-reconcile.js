'use strict';

/**
 * verify:sunset-staging-ledger-reconcile — RED→GREEN gate (injected client + optional Docker proof).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  reconcileLedger,
  APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER,
} = require('./lib/migration-integrity');
const lib = require('./lib/sunset-staging-ledger-reconcile');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'run-sunset-staging-ledger-reconcile.js');
const DOC = path.join(ROOT, 'docs', 'SUNSET-STAGING-LEDGER-RECONCILE.md');
const CONTRACT = path.join(ROOT, 'fixtures', 'sunset-staging-ledger-reconcile', 'sunset-staging-ledger-reconcile-contract.json');

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function envWithToken(token) {
  return { [lib.ENV_ENABLED]: '1', [lib.ENV_TOKEN]: token };
}

function baseArgv(mode) {
  return [
    mode,
    lib.CLI_APPROVE,
    '--subscription', lib.RECONCILE_TARGET.subscriptionId,
    '--resource-group', lib.RECONCILE_TARGET.resourceGroup,
    '--postgres-server', lib.RECONCILE_TARGET.postgresServer,
    '--database', lib.RECONCILE_TARGET.database,
  ];
}

function preApplyStructural() {
  return {
    has_056_table: true,
    has_056_bookings_uidx: true,
    has_056_idem_uidx: true,
    refund_trigger_count: 2,
    has_057_locations: false,
    has_057_endpoints: false,
    has_058_connector_mode: false,
    has_059_grants: false,
    has_059_endpoint_uq: false,
    has_060_hidden: true,
    has_060_hidden_idx: true,
  };
}

async function buildFixture() {
  const ctx = lib.loadManifestContext();
  const ledgerRows = ctx.forward.slice(0, lib.PREFIX_END_ORDER).map((e) => ({
    id: e.id,
    filename: e.filename,
    checksum_sha256: e.sha256,
    apply_order: e.order,
    apply_kind: APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER,
    checksum_mode: lib.CHECKSUM_MODE_CANONICAL_LF_V1,
    evidence_ref: `fixture:${e.id}`,
    provenance_notes: 'fixture prefix ledger',
    applied_at: '2026-08-01T00:00:00.000Z',
    ledger_recorded_at: '2026-08-01T00:00:00.000Z',
  }));
  const structural = preApplyStructural();
  const fingerprint = lib.catalogFingerprintFromProbe(structural);
  const planDigest = lib.digestPlan(ctx.entries);
  const evidence = lib.sealEvidence({
    target: lib.RECONCILE_TARGET,
    manifestDigest: ctx.manifestDigest,
    planDigest,
    catalogFingerprint: fingerprint,
    ledgerRows,
    notes: ['synthetic offline fixture — not live Sunset evidence'],
  });
  const approvalToken = lib.deriveApprovalToken(evidence.evidenceDigest, planDigest);
  return { ctx, ledgerRows, structural, fingerprint, evidence, approvalToken, planDigest };
}

function runCli(env, argv) {
  return spawnSync(process.execPath, [CLI, ...argv], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

async function main() {
  console.log('verify:sunset-staging-ledger-reconcile — RED→GREEN\n');
  lib.resetReconcileCounters();
  const fx = await buildFixture();

  pass('docs_present', fs.existsSync(DOC));
  pass('contract_present', fs.existsSync(CONTRACT));

  // RED gates
  pass('rejects_missing_env', !lib.evaluateReconcileGates({ env: {}, argv: baseArgv(lib.CLI_DRY_RUN), evidence: fx.evidence }).ok);
  pass('rejects_wrong_database', !lib.evaluateReconcileGates({
    env: envWithToken(fx.approvalToken),
    argv: [...baseArgv(lib.CLI_DRY_RUN), '--database', 'wolfhouse_staging'],
    evidence: fx.evidence,
  }).ok);
  pass('rejects_wrong_host_via_target', !lib.assertLockedTarget({ ...lib.RECONCILE_TARGET, postgresHost: 'evil.example.com' }).ok);
  pass('rejects_missing_token', !lib.evaluateReconcileGates({
    env: { [lib.ENV_ENABLED]: '1' },
    argv: baseArgv(lib.CLI_DRY_RUN),
    evidence: fx.evidence,
  }).ok);
  pass('rejects_malformed_token', !lib.evaluateReconcileGates({
    env: { [lib.ENV_ENABLED]: '1', [lib.ENV_TOKEN]: 'not-a-token' },
    argv: baseArgv(lib.CLI_DRY_RUN),
    evidence: fx.evidence,
  }).ok);
  pass('rejects_token_digest_mismatch', !lib.evaluateReconcileGates({
    env: envWithToken(`${lib.APPROVAL_PREFIX}${'a'.repeat(32)}`),
    argv: baseArgv(lib.CLI_DRY_RUN),
    evidence: fx.evidence,
  }).ok);
  const badPlanEvidence = { ...fx.evidence, planDigest: 'deadbeef' };
  pass('rejects_plan_digest_mismatch', !lib.evaluateReconcileGates({
    env: envWithToken(fx.approvalToken),
    argv: baseArgv(lib.CLI_DRY_RUN),
    evidence: badPlanEvidence,
  }).ok);
  pass('rejects_email_composition_enabled', !lib.evaluateReconcileGates({
    env: { ...envWithToken(fx.approvalToken), [lib.ENV_EMAIL_COMPOSITION]: '1' },
    argv: baseArgv(lib.CLI_DRY_RUN),
    evidence: fx.evidence,
  }).ok);
  pass('rejects_forbidden_dsn_argv', !lib.evaluateReconcileGates({
    env: envWithToken(fx.approvalToken),
    argv: [...baseArgv(lib.CLI_DRY_RUN), '--dsn', 'postgres://x'],
    evidence: fx.evidence,
  }).ok);
  pass('rejects_both_modes', !lib.evaluateReconcileGates({
    env: envWithToken(fx.approvalToken),
    argv: [...baseArgv(lib.CLI_DRY_RUN), lib.CLI_APPLY],
    evidence: fx.evidence,
  }).ok);

  const shortLedger = { ...fx.evidence, ledgerRows: fx.ledgerRows.slice(0, 10) };
  pass('rejects_ledger_not_through_055', !lib.validateEvidenceArtifact(shortLedger, fx.ctx).ok);

  const with056 = {
    ...fx.evidence,
    ledgerRows: [...fx.ledgerRows, {
      id: lib.LOCKED_MIGRATION_IDS[0],
      apply_order: 54,
      checksum_sha256: 'a'.repeat(64),
      filename: 'x.sql',
      apply_kind: lib.APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE,
      checksum_mode: lib.CHECKSUM_MODE_CANONICAL_LF_V1,
      ledger_recorded_at: 'x', applied_at: 'x',
    }],
  };
  pass('rejects_056_already_ledgered', !lib.validateEvidenceArtifact(with056, fx.ctx).ok);

  const missing056 = { ...preApplyStructural(), has_056_table: false };
  pass('rejects_056_structure_absent', !lib.assertPreApplyStructural(missing056).ok);
  const unexpected057 = { ...preApplyStructural(), has_057_locations: true };
  pass('rejects_057_unexpected_object', !lib.assertPreApplyStructural(unexpected057).ok);

  const clientDry = lib.createScriptedReconcileFakeClient({
    ledgerRows: fx.ledgerRows,
    structuralRow: fx.structural,
  });
  const dryBeforeCalls = clientDry.calls.length;
  const dry = await lib.executeReconcileDryRun({
    env: envWithToken(fx.approvalToken),
    argv: baseArgv(lib.CLI_DRY_RUN),
    evidence: fx.evidence,
    context: fx.ctx,
    client: clientDry,
  });
  pass('dry_run_ok', dry.ok === true);
  pass('dry_run_zero_ledger_writes', clientDry.ledgerRows.length === fx.ledgerRows.length);
  pass('dry_run_no_begin', !clientDry.calls.some((c) => c.sql === 'BEGIN'));
  pass('dry_run_catalog_mismatch_refused', !(await lib.executeReconcileDryRun({
    env: envWithToken(fx.approvalToken),
    argv: baseArgv(lib.CLI_DRY_RUN),
    evidence: { ...fx.evidence, catalogFingerprint: 'f'.repeat(64) },
    context: fx.ctx,
    client: clientDry,
  })).ok);

  const clientApply = lib.createScriptedReconcileFakeClient({
    ledgerRows: fx.ledgerRows.map((r) => ({ ...r })),
    structuralRow: { ...fx.structural },
  });
  const applied = await lib.executeReconcileMutation({
    env: envWithToken(fx.approvalToken),
    argv: baseArgv(lib.CLI_APPLY),
    evidence: fx.evidence,
    context: fx.ctx,
    client: clientApply,
  });
  pass('apply_ok', applied.ok === true);
  pass('apply_ledger_58_rows', clientApply.ledgerRows.length === lib.TIP_ORDER);
  const row056 = clientApply.ledgerRows.find((r) => r.id === lib.LOCKED_MIGRATION_IDS[0]);
  const row060 = clientApply.ledgerRows.find((r) => r.id === lib.LOCKED_MIGRATION_IDS[4]);
  pass('056_baseline_kind', row056.apply_kind === lib.APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE);
  pass('060_baseline_kind', row060.apply_kind === lib.APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE);
  for (const id of lib.LOCKED_MIGRATION_IDS.slice(1, 4)) {
    pass(`runner_kind_${id}`, clientApply.ledgerRows.find((r) => r.id === id).apply_kind === APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER);
  }
  const recon = reconcileLedger(fx.ctx.forward, clientApply.ledgerRows);
  pass('post_apply_reconcile_ok', recon.ok === true);

  const rerun = await lib.executeReconcileMutation({
    env: envWithToken(fx.approvalToken),
    argv: baseArgv(lib.CLI_APPLY),
    evidence: fx.evidence,
    context: fx.ctx,
    client: clientApply,
  });
  pass('rerun_refused_after_success', rerun.ok === false);

  const rollbackClient = lib.createScriptedReconcileFakeClient({
    ledgerRows: fx.ledgerRows.map((r) => ({ ...r })),
    structuralRow: { ...fx.structural },
    failOnSubstr: 'tenant_email_delegated_grants',
  });
  const rollback = await lib.executeReconcileMutation({
    env: envWithToken(fx.approvalToken),
    argv: baseArgv(lib.CLI_APPLY),
    evidence: fx.evidence,
    context: fx.ctx,
    client: rollbackClient,
  });
  pass('injected_failure_rolls_back', rollback.ok === false && rollback.rolledBack === true);
  pass('rollback_no_extra_ledger_rows', rollbackClient.ledgerRows.length === fx.ledgerRows.length);
  pass('rollback_contains_rollback_step', (rollback.steps || []).includes('ROLLBACK'));

  const lockClient = lib.createScriptedReconcileFakeClient({
    ledgerRows: fx.ledgerRows.map((r) => ({ ...r })),
    structuralRow: { ...fx.structural },
    advisoryBlocked: true,
  });
  const lockFail = await lib.executeReconcileMutation({
    env: envWithToken(fx.approvalToken),
    argv: baseArgv(lib.CLI_APPLY),
    evidence: fx.evidence,
    context: fx.ctx,
    client: lockClient,
  });
  pass('advisory_lock_failure_rolls_back', lockFail.ok === false);

  const tmpEvidence = path.join(ROOT, 'tmp', 'sunset-reconcile-evidence-cli.json');
  fs.mkdirSync(path.dirname(tmpEvidence), { recursive: true });
  fs.writeFileSync(tmpEvidence, JSON.stringify(fx.evidence, null, 2));
  const cliDry = runCli(envWithToken(fx.approvalToken), [...baseArgv(lib.CLI_DRY_RUN), lib.CLI_EVIDENCE, tmpEvidence]);
  pass('cli_dry_run_exit_0_without_client', cliDry.status === 0);
  const secretProbe = JSON.stringify(applied);
  pass('public_output_secret_free', !secretProbe.includes('postgres://') && !secretProbe.includes(fx.approvalToken));

  // Optional Docker proof
  const docker = spawnSync('docker', ['info'], { encoding: 'utf8' });
  if (docker.status === 0) {
    console.log('\n── disposable Postgres proof ──');
    const prove = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'prove-sunset-staging-ledger-reconcile-fresh-db.js')], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 600000,
    });
    if (prove.status === 0) console.log(prove.stdout);
    else console.log(prove.stdout || prove.stderr);
    pass('prove_fresh_db', prove.status === 0, prove.stderr || prove.stdout);
  } else {
    console.log('\n  SKIP  prove_fresh_db (docker unavailable)');
  }

  console.log(`\n── verify:sunset-staging-ledger-reconcile: ${failed === 0 ? 'PASSED' : `FAILED (${failed})`} ──`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});

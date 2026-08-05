'use strict';

/**
 * verify:sunset-staging-ledger-reconcile — RED→GREEN gate (pinned client + optional Docker CLI proof).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execSync } = require('child_process');
const {
  reconcileLedger,
  APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER,
} = require('./lib/migration-integrity');
const lib = require('./lib/sunset-staging-ledger-reconcile');
const { buildCanonicalPreApplySemanticRow, driftCatalog, BASELINE_PATH, tryLoadCanonical056Baseline, verifyCanonical056BaselineBindings } = require('./lib/sunset-staging-ledger-reconcile-semantics');
const { runSunsetStagingLedgerReconcileCliTest } = require('./lib/sunset-staging-ledger-reconcile-test-runner');
const { sanitizeReconcileError } = require('./lib/sunset-staging-ledger-reconcile-redact');
const {
  assertPinnedReconcilePgClient,
  assertLiveSessionTarget,
  FORBIDDEN_PRODUCTION_SEAM_ENVS,
  resetPgCounters,
  getPgCounters,
  endClientAfterConnectFailure,
} = require('./lib/sunset-staging-ledger-reconcile-pg');
const { createDisposablePinnedPgClient } = require('./lib/sunset-staging-ledger-reconcile-disposable-pg');

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

function envWithToken(token, extra) {
  return { [lib.ENV_ENABLED]: '1', [lib.ENV_TOKEN]: token, ...(extra || {}) };
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
  const semantic = buildCanonicalPreApplySemanticRow();
  const fingerprint = lib.catalogFingerprintFromProbe(semantic);
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
  return { ctx, ledgerRows, semantic, fingerprint, evidence, approvalToken, planDigest };
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
  const beforePorcelain = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' }).trim();
  console.log(`  git status --porcelain (before): ${beforePorcelain ? `${beforePorcelain.split('\n').length} entries` : 'clean'}`);

  const tmpFiles = [];
  const mkTemp = (name) => {
    const p = path.join(os.tmpdir(), `wh-sunset-verify-${process.pid}-${name}`);
    tmpFiles.push(p);
    return p;
  };

  try {
    let binding = tryLoadCanonical056Baseline();
    if (!binding.ok) {
      const dockerInfo = spawnSync('docker', ['info'], { encoding: 'utf8' });
      if (dockerInfo.status === 0) {
        console.log('  INFO  capturing canonical-056 semantics baseline via Docker…');
        const cap = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'capture-sunset-056-semantics-baseline.js')], {
          cwd: ROOT,
          encoding: 'utf8',
          timeout: 600000,
        });
        if (cap.status !== 0) {
          console.error(cap.stdout || cap.stderr);
          process.exit(1);
        }
        binding = tryLoadCanonical056Baseline();
      } else {
        console.error(`  FAIL  baseline bindings refused (${binding.errors[0]?.code}) and docker unavailable`);
        process.exit(1);
      }
    }
    lib.resetReconcileCounters();
    const fx = await buildFixture();

    pass('docs_present', fs.existsSync(DOC));
    pass('contract_present', fs.existsSync(CONTRACT));
    pass('baseline_bindings_ok', binding.ok === true);
    const tampered = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    tampered.provenance = { ...(tampered.provenance || {}), migration056ChecksumSha256: '0'.repeat(64) };
    pass('baseline_provenance_refused_on_tamper', !verifyCanonical056BaselineBindings(tampered).ok);

    resetPgCounters();
    const disposableFail = await createDisposablePinnedPgClient({
      host: '127.0.0.1', port: 1, database: 'sunset_staging', user: 'x', password: 'y',
    }, lib.APPLICATION_NAME);
    pass('disposable_connect_failure_calls_end', disposableFail.ok === false && getPgCounters().connectFailureEndCalls === 1);

    resetPgCounters();
    let productionEndCalls = 0;
    const productionEndProbe = {
      async end() { productionEndCalls += 1; },
    };
    await endClientAfterConnectFailure(productionEndProbe);
    pass('production_connect_failure_calls_end', productionEndCalls === 1 && getPgCounters().connectFailureEndCalls === 1);

    const emptyAddrClient = {
      async query() {
        return {
          rows: [{
            database_name: lib.RECONCILE_TARGET.database,
            application_name: lib.APPLICATION_NAME,
            server_addr: '',
            server_port: 5432,
          }],
        };
      },
    };
    const SUNSET_LOCKED_CONNECT = Symbol.for('sunset.reconcile.lockedConnect');
    const SUNSET_LOCKED_HOST_IDENTITY = Symbol.for('sunset.reconcile.lockedHostIdentity');
    Object.defineProperty(emptyAddrClient, SUNSET_LOCKED_CONNECT, {
      value: Object.freeze({
        host: lib.RECONCILE_TARGET.postgresHost,
        port: 5432,
        database: lib.RECONCILE_TARGET.database,
        applicationName: lib.APPLICATION_NAME,
        tlsServername: lib.RECONCILE_TARGET.postgresHost,
      }),
    });
    Object.defineProperty(emptyAddrClient, SUNSET_LOCKED_HOST_IDENTITY, {
      value: Object.freeze({
        subscriptionId: lib.RECONCILE_TARGET.subscriptionId,
        resourceGroup: lib.RECONCILE_TARGET.resourceGroup,
        postgresServer: lib.RECONCILE_TARGET.postgresServer,
        host: lib.RECONCILE_TARGET.postgresHost,
        tlsServername: lib.RECONCILE_TARGET.postgresHost,
        publicDnsAddresses: ['51.124.155.177'],
        approvedPrivateAddresses: ['10.33.0.4'],
      }),
    });
    const emptyAddr = await assertLiveSessionTarget(emptyAddrClient, lib.APPLICATION_NAME);
    pass('rejects_empty_inet_server_addr', emptyAddr.ok === false && emptyAddr.errors.some((e) => e.code === 'live_server_addr_empty'));

    const targetProbe = async ({ addr = '10.33.0.4', database = lib.RECONCILE_TARGET.database,
      host = lib.RECONCILE_TARGET.postgresHost, tlsServername = lib.RECONCILE_TARGET.postgresHost,
      subscriptionId = lib.RECONCILE_TARGET.subscriptionId,
      resourceGroup = lib.RECONCILE_TARGET.resourceGroup,
      postgresServer = lib.RECONCILE_TARGET.postgresServer,
      publicDnsAddresses = ['51.124.155.177'], approvedPrivateAddresses = ['10.33.0.4'] } = {}) => {
      const client = {
        async query() {
          return { rows: [{ database_name: database, application_name: lib.APPLICATION_NAME, server_addr: addr, server_port: 5432 }] };
        },
      };
      Object.defineProperty(client, SUNSET_LOCKED_CONNECT, { value: Object.freeze({
        host, port: 5432, database: lib.RECONCILE_TARGET.database,
        applicationName: lib.APPLICATION_NAME, tlsServername,
      }) });
      Object.defineProperty(client, SUNSET_LOCKED_HOST_IDENTITY, { value: Object.freeze({
        subscriptionId, resourceGroup, postgresServer, host, tlsServername,
        publicDnsAddresses, approvedPrivateAddresses,
      }) });
      return assertLiveSessionTarget(client, lib.APPLICATION_NAME);
    };
    pass('accepts_approved_vnet_private_path_10_33_0_4', (await targetProbe()).ok === true);
    pass('preserves_locked_public_dns_path', (await targetProbe({ addr: '51.124.155.177' })).ok === true);
    pass('rejects_wrong_fqdn_or_tls_hostname', !(await targetProbe({ host: 'evil.example.com', tlsServername: 'evil.example.com' })).ok);
    pass('rejects_wrong_azure_resource', !(await targetProbe({ postgresServer: 'other-pg-server' })).ok);
    pass('rejects_wrong_live_database', !(await targetProbe({ database: 'postgres' })).ok);
    pass('rejects_arbitrary_private_ip', !(await targetProbe({ addr: '10.33.0.5' })).ok);
    pass('rejects_public_impostor', !(await targetProbe({ addr: '203.0.113.9' })).ok);
    pass('rejects_forged_private_address_seam', !(await targetProbe({
      addr: '10.33.0.5', approvedPrivateAddresses: ['10.33.0.5'],
    })).ok);

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
  pass('rejects_plan_digest_mismatch', !lib.evaluateReconcileGates({
    env: envWithToken(fx.approvalToken),
    argv: baseArgv(lib.CLI_DRY_RUN),
    evidence: { ...fx.evidence, planDigest: 'deadbeef' },
  }).ok);
  pass('rejects_ledger_prefix_digest_mismatch', !lib.validateEvidenceArtifact({
    ...fx.evidence,
    ledgerPrefixDigest: 'f'.repeat(64),
  }, fx.ctx).ok);
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

  for (const seamEnv of FORBIDDEN_PRODUCTION_SEAM_ENVS) {
    pass(`rejects_production_seam_env_${seamEnv}`, !lib.evaluateReconcileGates({
      env: { ...envWithToken(fx.approvalToken), [seamEnv]: '1' },
      argv: baseArgv(lib.CLI_DRY_RUN),
      evidence: fx.evidence,
      productionCli: true,
    }).ok);
  }
  pass('rejects_proof_connection_argv_on_production', !lib.evaluateReconcileGates({
    env: envWithToken(fx.approvalToken),
    argv: [...baseArgv(lib.CLI_DRY_RUN), '--proof-connection-file', 'x.json'],
    evidence: fx.evidence,
    productionCli: true,
  }).ok);
  pass('rejects_inject_fail_argv_on_production', !lib.evaluateReconcileGates({
    env: envWithToken(fx.approvalToken),
    argv: [...baseArgv(lib.CLI_DRY_RUN), '--inject-fail-step', 'apply_057'],
    evidence: fx.evidence,
    productionCli: true,
  }).ok);

  pass('rejects_pool_at_mutation_boundary', !assertPinnedReconcilePgClient({ query: async () => ({}), connect: async () => ({}), end: async () => ({}), totalCount: 0, idleCount: 0 }).ok);
  pass('rejects_query_facade_at_mutation_boundary', !assertPinnedReconcilePgClient({ query: async () => ({}) }).ok);

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

  const baseline = buildCanonicalPreApplySemanticRow();
  for (const kind of ['wrong_check', 'wrong_fk', 'wrong_index_keys', 'non_unique_index', 'wrong_trigger_event', 'wrong_function_body', 'wrong_pk_constraint', 'wrong_pk_index']) {
    const drifted = driftCatalog(baseline, kind);
    pass(`rejects_semantic_drift_${kind}`, !lib.assertPreApplyStructural(drifted, baseline).ok);
  }

  const badSemantic = { ...baseline, has_057_locations: true };
  pass('rejects_semantic_057_unexpected', !lib.assertPreApplyStructural(badSemantic).ok);
  const missing056 = { ...baseline, columns_056: [] };
  pass('rejects_semantic_056_drift', !lib.assertPreApplyStructural(missing056).ok);

  const clientDry = lib.createScriptedReconcileFakeClient({
    ledgerRows: fx.ledgerRows,
    semanticRow: fx.semantic,
    serverAddr: '10.0.0.1',
  });
  const dry = await lib.executeReconcileDryRun({
    env: envWithToken(fx.approvalToken),
    argv: baseArgv(lib.CLI_DRY_RUN),
    evidence: fx.evidence,
    context: fx.ctx,
    client: clientDry,
    pinnedClient: clientDry,
  });
  pass('dry_run_ok', dry.ok === true && dry.sessionPinned === true);
  pass('dry_run_zero_ledger_writes', clientDry.ledgerRows.length === fx.ledgerRows.length);
  pass('dry_run_no_begin', !clientDry.calls.some((c) => c.sql === 'BEGIN'));
  pass('dry_run_catalog_mismatch_refused', !(await lib.executeReconcileDryRun({
    env: envWithToken(fx.approvalToken),
    argv: baseArgv(lib.CLI_DRY_RUN),
    evidence: { ...fx.evidence, catalogFingerprint: 'f'.repeat(64) },
    context: fx.ctx,
    client: clientDry,
    pinnedClient: clientDry,
  })).ok);
  pass('dry_run_live_ledger_digest_mismatch_refused', !(await lib.executeReconcileDryRun({
    env: envWithToken(fx.approvalToken),
    argv: baseArgv(lib.CLI_DRY_RUN),
    evidence: fx.evidence,
    context: fx.ctx,
    client: lib.createScriptedReconcileFakeClient({
      ledgerRows: fx.ledgerRows.slice(0, 10),
      semanticRow: fx.semantic,
      serverAddr: '10.0.0.1',
    }),
    pinnedClient: lib.createScriptedReconcileFakeClient({
      ledgerRows: fx.ledgerRows.slice(0, 10),
      semanticRow: fx.semantic,
      serverAddr: '10.0.0.1',
    }),
  })).ok);

  const clientApply = lib.createScriptedReconcileFakeClient({
    ledgerRows: fx.ledgerRows.map((r) => ({ ...r })),
    semanticRow: { ...fx.semantic },
    serverAddr: '10.0.0.1',
  });
  const applied = await lib.executeReconcileMutation({
    env: envWithToken(fx.approvalToken),
    argv: baseArgv(lib.CLI_APPLY),
    evidence: fx.evidence,
    context: fx.ctx,
    client: clientApply,
    pinnedClient: clientApply,
  });
  pass('apply_ok', applied.ok === true && applied.sessionPinned === true);
  pass('apply_live_target_proof_recorded', applied.liveTargetProof && applied.liveTargetProof.database_name === 'sunset_staging');
  pass('apply_ledger_58_rows', clientApply.ledgerRows.length === lib.TIP_ORDER);
  const row056 = clientApply.ledgerRows.find((r) => r.id === lib.LOCKED_MIGRATION_IDS[0]);
  const row060 = clientApply.ledgerRows.find((r) => r.id === lib.LOCKED_MIGRATION_IDS[4]);
  pass('056_baseline_kind', row056.apply_kind === lib.APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE);
  pass('060_baseline_kind', row060.apply_kind === lib.APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE);
  for (const id of lib.LOCKED_MIGRATION_IDS.slice(1, 4)) {
    const row = clientApply.ledgerRows.find((r) => r.id === id);
    pass(`runner_kind_${id}`, row.apply_kind === APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER);
    pass(`runner_provenance_${id}`, String(row.provenance_notes).includes('wh-sunset-ledger-reconcile-056-060'));
    pass(`runner_not_runCanonicalMigrations_${id}`, !String(row.provenance_notes).includes('runCanonicalMigrations'));
  }
  const recon = reconcileLedger(fx.ctx.forward, clientApply.ledgerRows);
  pass('post_apply_reconcile_ok', recon.ok === true);

  const rerun = await lib.executeReconcileMutation({
    env: envWithToken(fx.approvalToken),
    argv: baseArgv(lib.CLI_APPLY),
    evidence: fx.evidence,
    context: fx.ctx,
    client: clientApply,
    pinnedClient: clientApply,
  });
  pass('rerun_refused_after_success', rerun.ok === false);

  const rollbackClient = lib.createScriptedReconcileFakeClient({
    ledgerRows: fx.ledgerRows.map((r) => ({ ...r })),
    semanticRow: { ...fx.semantic },
    serverAddr: '10.0.0.1',
  });
  const rollback = await lib.executeReconcileMutation({
    env: envWithToken(fx.approvalToken),
    argv: baseArgv(lib.CLI_APPLY),
    evidence: fx.evidence,
    context: fx.ctx,
    client: rollbackClient,
    pinnedClient: rollbackClient,
    injectFailStep: 'apply_057',
  });
  pass('injected_failure_rolls_back', rollback.ok === false && rollback.rolledBack === true && rollback.code === 'injected_failure');
  pass('rollback_contains_rollback_step', (rollback.steps || []).includes('ROLLBACK'));
  pass('rollback_past_056_baseline_write', (rollback.steps || []).includes('ledger_056_baseline'));
  pass('rollback_inject_step_reached', rollback.injectFailStepReached === 'apply_057');

  const lockClient = lib.createScriptedReconcileFakeClient({
    ledgerRows: fx.ledgerRows.map((r) => ({ ...r })),
    semanticRow: { ...fx.semantic },
    serverAddr: '10.0.0.1',
    advisoryBlocked: true,
  });
  const lockFail = await lib.executeReconcileMutation({
    env: envWithToken(fx.approvalToken),
    argv: baseArgv(lib.CLI_APPLY),
    evidence: fx.evidence,
    context: fx.ctx,
    client: lockClient,
    pinnedClient: lockClient,
  });
  pass('advisory_lock_failure_rolls_back', lockFail.ok === false);

  const tmpEvidence = mkTemp('evidence-cli.json');
  fs.writeFileSync(tmpEvidence, JSON.stringify(fx.evidence, null, 2));
  pass('rollback_after_ledger_baseline_write', rollbackClient.ledgerRows.length === fx.ledgerRows.length);

  resetPgCounters();
  let cleanupProbeClosed = 0;
  const failingFactory = () => {
    const c = lib.createScriptedReconcileFakeClient({
      ledgerRows: fx.ledgerRows,
      semanticRow: fx.semantic,
      serverAddr: '10.0.0.1',
    });
    const origEnd = c.end.bind(c);
    c.end = async () => { cleanupProbeClosed += 1; return origEnd(); };
    return c;
  };
  const wired = await runSunsetStagingLedgerReconcileCliTest({
    env: envWithToken(fx.approvalToken),
    argv: [...baseArgv(lib.CLI_DRY_RUN), lib.CLI_EVIDENCE, tmpEvidence],
    clientFactory: failingFactory,
  });
  pass('cli_pinned_client_dry_run_ok', wired.result.ok === true);
  pass('cli_cleanup_on_success', wired.clientsClosed === 1 && cleanupProbeClosed === 1);

  const throwFactory = () => {
    const c = lib.createScriptedReconcileFakeClient({
      ledgerRows: fx.ledgerRows,
      semanticRow: fx.semantic,
      serverAddr: '10.0.0.1',
    });
    const origQuery = c.query.bind(c);
    let closed = false;
    c.query = async (...args) => {
      if (String(args[0]).includes('schema_migration_ledger')) {
        throw Object.assign(new Error('hostile query failure'), { code: 'query_failed' });
      }
      return origQuery(...args);
    };
    const origEnd = c.end.bind(c);
    c.end = async () => { closed = true; return origEnd(); };
    c._closedProbe = () => closed;
    return c;
  };
  const queryFailClient = throwFactory();
  const queryFail = await runSunsetStagingLedgerReconcileCliTest({
    env: envWithToken(fx.approvalToken),
    argv: [...baseArgv(lib.CLI_DRY_RUN), lib.CLI_EVIDENCE, tmpEvidence],
    clientFactory: () => queryFailClient,
  });
  pass('cli_cleanup_on_query_failure', queryFail.clientsClosed === 1 && queryFailClient._closedProbe());
  const cliMissingCreds = runCli(envWithToken(fx.approvalToken), [...baseArgv(lib.CLI_DRY_RUN), lib.CLI_EVIDENCE, tmpEvidence]);
  pass('cli_rejects_missing_db_credentials', cliMissingCreds.status !== 0);
  const hostilePath = 'C:\\secrets\\cred-shaped-evidence.json';
  const hostileDsn = ['postgres', '://admin:supersecret@127.0.0.1/evidence'].join('');
  const hostileMsg = sanitizeReconcileError(
    Object.assign(new Error(`failed reading ${hostilePath} ${hostileDsn}`), { code: 'evidence_read_failed' }),
    envWithToken(fx.approvalToken),
  );
  pass('redacts_hostile_error_paths', !JSON.stringify(hostileMsg).includes('C:\\secrets') && !JSON.stringify(hostileMsg).includes(fx.approvalToken));
  pass('redacts_hostile_error_dsn', !JSON.stringify(hostileMsg).includes('supersecret') && !JSON.stringify(hostileMsg).includes('postgres://'));
  const seamSpawn = runCli({
    ...envWithToken(fx.approvalToken),
    SUNSET_STAGING_LEDGER_RECONCILE_DISPOSABLE_PROOF: '1',
  }, [...baseArgv(lib.CLI_DRY_RUN), lib.CLI_EVIDENCE, tmpEvidence]);
  pass('spawned_production_cli_rejects_disposable_seam', seamSpawn.status !== 0);
  const malformedEvidence = mkTemp('evidence-malformed.json');
  fs.writeFileSync(malformedEvidence, '{not-json');
  const malformedSpawn = runCli(envWithToken(fx.approvalToken, {
    SUNSET_STAGING_PG_ADMIN_USER: 'x',
    SUNSET_STAGING_PG_ADMIN_PASSWORD: 'y',
  }), [...baseArgv(lib.CLI_DRY_RUN), lib.CLI_EVIDENCE, malformedEvidence]);
  pass('spawned_production_cli_redacts_malformed_evidence', malformedSpawn.status !== 0 && !String(malformedSpawn.stdout).includes('postgres://'));
  const secretProbe = JSON.stringify(applied);
  pass('public_output_secret_free', !secretProbe.includes('postgres://') && !secretProbe.includes(fx.approvalToken));

  const docker = spawnSync('docker', ['info'], { encoding: 'utf8' });
  if (docker.status === 0) {
    console.log('\n── disposable Postgres CLI proof ──');
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
  const afterPorcelain = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' }).trim();
  console.log(`  git status --porcelain (after): ${afterPorcelain ? `${afterPorcelain.split('\n').length} entries` : 'clean'}`);
  pass('verify_tree_unchanged', beforePorcelain === afterPorcelain);
  process.exit(failed === 0 ? 0 : 1);
  } finally {
    for (const file of tmpFiles) {
      try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) { /* ignore */ }
    }
  }
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});

'use strict';

/**
 * Disposable local PostgreSQL proof via test-only disposable proof CLI.
 * Never connects to Azure or live sunset_staging hostnames.
 */

const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const {
  CHECKSUM_MODE_CANONICAL_LF_V1,
  MIGRATIONS_DIR,
  prepareMigrationBody,
  reconcileLedger,
} = require('./lib/migration-integrity');
const { ensureLedger, applyOne, loadLedger } = require('./run-canonical-migrations');
const lib = require('./lib/sunset-staging-ledger-reconcile');
const { probeSemanticCatalog, BASELINE_PATH } = require('./lib/sunset-staging-ledger-reconcile-semantics');
const { CLI_INJECT_FAIL } = require('./lib/sunset-staging-ledger-reconcile-disposable-runner');
const { FORBIDDEN_PRODUCTION_SEAM_ENVS } = require('./lib/sunset-staging-ledger-reconcile-pg');

const ROOT = path.join(__dirname, '..');
const PROD_CLI = path.join(ROOT, 'scripts', 'run-sunset-staging-ledger-reconcile.js');
const PROOF_CLI = path.join(ROOT, 'scripts', 'run-sunset-staging-ledger-reconcile-disposable-proof.js');
const DB_NAME = 'sunset_staging';

const ROLLBACK_STAGES = Object.freeze([
  'ledger_056_baseline',
  'apply_057',
  'apply_058',
  'apply_059',
]);

const suffix = crypto.randomBytes(3).toString('hex');
const container = `wh-sunset-reconcile-proof-${suffix}`;
const port = 55430 + (parseInt(suffix, 16) % 200);
const admin = { host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: 'postgres' };

function docker(...args) {
  execFileSync('docker', args, { stdio: 'inherit' });
}

async function waitReady(conn) {
  for (let i = 0; i < 40; i += 1) {
    const c = new Client({ ...conn, connectionTimeoutMillis: 2000 });
    try {
      await c.connect();
      await c.query('SELECT 1');
      await c.end();
      return;
    } catch (_) {
      try { await c.end(); } catch (e) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('postgres not ready');
}

async function applySqlFile(client, filename) {
  const prepared = prepareMigrationBody(fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8'));
  if (!prepared.ok) throw new Error(`prepare failed: ${filename}`);
  await client.query(prepared.body);
}

async function fingerprintLedgerAndCatalog(client) {
  const ledger = await loadLedger(client);
  const semantic = await probeSemanticCatalog(client);
  return {
    ledgerDigest: crypto.createHash('sha256').update(JSON.stringify(ledger.map((r) => ({
      id: r.id, order: r.apply_order, kind: r.apply_kind, sha: r.checksum_sha256,
    })))).digest('hex'),
    catalogFingerprint: semantic.fingerprint,
    ledgerPrefixDigest: lib.digestLedgerPrefix(ledger),
    ledgerRowCount: ledger.length,
    ledger,
    semantic: semantic.row,
  };
}

function writeProofConnectionFile(connection, filePath) {
  fs.writeFileSync(filePath, JSON.stringify({
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    password: connection.password,
  }));
}

function baseProofEnv(token) {
  return {
    ...process.env,
    SUNSET_STAGING_PG_ADMIN_USER: 'postgres',
    SUNSET_STAGING_PG_ADMIN_PASSWORD: 'postgres',
    [lib.ENV_ENABLED]: '1',
    [lib.ENV_TOKEN]: token,
  };
}

function baseProofArgv(mode, evidencePath, connectionPath, injectStep) {
  const argv = [
    mode,
    lib.CLI_APPROVE,
    lib.CLI_EVIDENCE, evidencePath,
    '--proof-connection-file', connectionPath,
    '--subscription', lib.RECONCILE_TARGET.subscriptionId,
    '--resource-group', lib.RECONCILE_TARGET.resourceGroup,
    '--postgres-server', lib.RECONCILE_TARGET.postgresServer,
    '--database', lib.RECONCILE_TARGET.database,
  ];
  if (injectStep) argv.push(CLI_INJECT_FAIL, injectStep);
  return argv;
}

function spawnProofCli(env, argv) {
  return spawnSync(process.execPath, [PROOF_CLI, ...argv], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 600000,
  });
}

function spawnProdCli(env, argv) {
  return spawnSync(process.execPath, [PROD_CLI, ...argv], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 600000,
  });
}

function assertRollbackJson(json, stage, pre) {
  if (json.code !== 'injected_failure') {
    throw new Error(`rollback stage ${stage}: expected code injected_failure, got ${json.code}`);
  }
  if (!Array.isArray(json.steps) || !json.steps.includes('ROLLBACK')) {
    throw new Error(`rollback stage ${stage}: missing ROLLBACK step`);
  }
  if (!json.steps.includes('ledger_056_baseline')) {
    throw new Error(`rollback stage ${stage}: mutation did not progress beyond first baseline ledger write`);
  }
  if (!json.steps.includes(stage)) {
    throw new Error(`rollback stage ${stage}: injection point not reached`);
  }
  if (json.injectFailStepReached !== stage) {
    throw new Error(`rollback stage ${stage}: injectFailStepReached mismatch`);
  }
  if (!json.rolledBack) {
    throw new Error(`rollback stage ${stage}: rolledBack not true`);
  }
  return {
    stage,
    code: json.code,
    steps: json.steps,
    injectFailStepReached: json.injectFailStepReached,
    rolledBack: json.rolledBack,
    preLedgerDigest: pre.ledgerDigest,
    preCatalogFingerprint: pre.catalogFingerprint,
  };
}

async function buildSplitState(connection) {
  const client = new Client(connection);
  await client.connect();
  const ctx = lib.loadManifestContext();
  await ensureLedger(client);
  for (const entry of ctx.forward.slice(0, lib.PREFIX_END_ORDER)) {
    await applyOne(client, entry, MIGRATIONS_DIR, null, CHECKSUM_MODE_CANONICAL_LF_V1);
  }
  await applySqlFile(client, ctx.entries[0].filename);
  await applySqlFile(client, ctx.entries[4].filename);
  const pre = await fingerprintLedgerAndCatalog(client);
  if (pre.ledger.length !== lib.PREFIX_END_ORDER) throw new Error('prefix ledger not built');
  const planDigest = lib.digestPlan(ctx.entries);
  const evidence = lib.sealEvidence({
    target: lib.RECONCILE_TARGET,
    manifestDigest: ctx.manifestDigest,
    planDigest,
    catalogFingerprint: pre.catalogFingerprint,
    ledgerRows: pre.ledger,
    notes: ['disposable-local proof fixture'],
  });
  const token = lib.deriveApprovalToken(evidence.evidenceDigest, planDigest);
  await client.end();
  return { ctx, evidence, token, pre, planDigest };
}

async function proveRollbackStage(adminConn, rollbackConn, stage, suffixLocal) {
  const split = await buildSplitState(rollbackConn);
  const evidencePath = path.join(ROOT, 'tmp', `sunset-reconcile-rollback-${stage}-${suffixLocal}.json`);
  const connectionPath = path.join(ROOT, 'tmp', `sunset-reconcile-conn-${stage}-${suffixLocal}.json`);
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, JSON.stringify(split.evidence, null, 2));
  writeProofConnectionFile(rollbackConn, connectionPath);

  const preClient = new Client(rollbackConn);
  await preClient.connect();
  const pre = await fingerprintLedgerAndCatalog(preClient);
  await preClient.end();

  const run = spawnProofCli(baseProofEnv(split.token), baseProofArgv(lib.CLI_APPLY, evidencePath, connectionPath, stage));
  if (!run.stdout) throw new Error(`rollback ${stage}: no stdout (${run.stderr || 'empty'})`);
  const json = JSON.parse(run.stdout);
  const evidence = assertRollbackJson(json, stage, pre);

  const postClient = new Client(rollbackConn);
  await postClient.connect();
  const post = await fingerprintLedgerAndCatalog(postClient);
  await postClient.end();

  if (pre.ledgerDigest !== post.ledgerDigest || pre.catalogFingerprint !== post.catalogFingerprint) {
    throw new Error(`rollback ${stage}: pre/post fingerprints differ`);
  }
  return {
    ...evidence,
    postLedgerDigest: post.ledgerDigest,
    postCatalogFingerprint: post.catalogFingerprint,
    ledgerIdentical: true,
    catalogIdentical: true,
    exitCode: run.status,
  };
}

async function main() {
  if (!fs.existsSync(BASELINE_PATH)) {
    const { main: capture } = require('./capture-sunset-056-semantics-baseline');
    await capture();
  }

  docker('run', '--rm', '-d', '--name', container, '-e', 'POSTGRES_PASSWORD=postgres', '-p', `${port}:5432`, 'postgres:16');
  await new Promise((r) => setTimeout(r, 8000));
  const proof = { ok: false, hostile: {}, cli: {}, rollbackStages: {} };
  try {
    await waitReady(admin);
    const boot = new Client(admin);
    await boot.connect();
    await boot.query(`CREATE DATABASE ${DB_NAME}`);
    await boot.end();

    const connection = { host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: DB_NAME };
    const split = await buildSplitState(connection);
    const evidencePath = path.join(ROOT, 'tmp', `sunset-reconcile-proof-${suffix}.json`);
    const connectionPath = path.join(ROOT, 'tmp', `sunset-reconcile-conn-${suffix}.json`);
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, JSON.stringify(split.evidence, null, 2));
    writeProofConnectionFile(connection, connectionPath);

    const preDryClient = new Client(connection);
    await preDryClient.connect();
    const preDry = await fingerprintLedgerAndCatalog(preDryClient);
    await preDryClient.end();

    const dryRun = spawnProofCli(baseProofEnv(split.token), baseProofArgv(lib.CLI_DRY_RUN, evidencePath, connectionPath));
    if (dryRun.status !== 0) throw new Error(`proof cli dry-run failed: ${dryRun.stdout || dryRun.stderr}`);
    const dryJson = JSON.parse(dryRun.stdout);
    proof.cli.dryRun = { ok: dryJson.ok, code: dryJson.code, sessionPinned: dryJson.sessionPinned };

    const postDryClient = new Client(connection);
    await postDryClient.connect();
    const postDry = await fingerprintLedgerAndCatalog(postDryClient);
    await postDryClient.end();
    if (preDry.ledgerDigest !== postDry.ledgerDigest || preDry.catalogFingerprint !== postDry.catalogFingerprint) {
      throw new Error('dry-run mutated state');
    }
    proof.dryRunProof = {
      preLedgerDigest: preDry.ledgerDigest,
      postLedgerDigest: postDry.ledgerDigest,
      preCatalogFingerprint: preDry.catalogFingerprint,
      postCatalogFingerprint: postDry.catalogFingerprint,
      ledgerIdentical: true,
      catalogIdentical: true,
    };

    const applyRun = spawnProofCli(baseProofEnv(split.token), baseProofArgv(lib.CLI_APPLY, evidencePath, connectionPath));
    if (applyRun.status !== 0) throw new Error(`proof cli apply failed: ${applyRun.stdout || applyRun.stderr}`);
    const applyJson = JSON.parse(applyRun.stdout);
    proof.cli.apply = {
      ok: applyJson.ok,
      code: applyJson.code,
      sessionPinned: applyJson.sessionPinned,
      liveTargetProof: applyJson.liveTargetProof,
      steps: applyJson.steps,
    };

    const finalClient = new Client(connection);
    await finalClient.connect();
    const postApply = await fingerprintLedgerAndCatalog(finalClient);
    const recon = reconcileLedger(split.ctx.forward, postApply.ledger);
    if (!recon.ok || postApply.ledger.length !== lib.TIP_ORDER) throw new Error('final reconcile failed');
    const sanitized = postApply.ledger
      .filter((r) => lib.LOCKED_MIGRATION_IDS.includes(r.id))
      .map((r) => ({
        id: r.id,
        apply_order: r.apply_order,
        apply_kind: r.apply_kind,
        checksum_sha256: r.checksum_sha256,
        checksum_mode: r.checksum_mode,
        provenance_notes: r.provenance_notes,
      }));
    await finalClient.end();

    const rerun = spawnProofCli(baseProofEnv(split.token), baseProofArgv(lib.CLI_APPLY, evidencePath, connectionPath));
    proof.rerunProof = { refused: rerun.status !== 0, exitCode: rerun.status };

    for (const stage of ROLLBACK_STAGES) {
      const rollbackDb = `sunset_staging_rb_${stage}_${suffix}`;
      const bootRb = new Client(admin);
      await bootRb.connect();
      await bootRb.query(`CREATE DATABASE ${rollbackDb}`);
      await bootRb.end();
      const rollbackConn = { host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: rollbackDb };
      proof.rollbackStages[stage] = await proveRollbackStage(admin, rollbackConn, stage, suffix);
    }

    const seamEnv = baseProofEnv(split.token);
    for (const name of FORBIDDEN_PRODUCTION_SEAM_ENVS) seamEnv[name] = '1';
    const prodSeam = spawnProdCli(seamEnv, [
      lib.CLI_DRY_RUN,
      lib.CLI_APPROVE,
      lib.CLI_EVIDENCE, evidencePath,
      '--subscription', lib.RECONCILE_TARGET.subscriptionId,
      '--resource-group', lib.RECONCILE_TARGET.resourceGroup,
      '--postgres-server', lib.RECONCILE_TARGET.postgresServer,
      '--database', lib.RECONCILE_TARGET.database,
    ]);
    const prodNoSeam = spawnProdCli({
      ...baseProofEnv(split.token),
      SUNSET_STAGING_PG_ADMIN_USER: 'postgres',
      SUNSET_STAGING_PG_ADMIN_PASSWORD: 'postgres',
    }, [
      lib.CLI_DRY_RUN,
      lib.CLI_APPROVE,
      lib.CLI_EVIDENCE, evidencePath,
      '--subscription', lib.RECONCILE_TARGET.subscriptionId,
      '--resource-group', lib.RECONCILE_TARGET.resourceGroup,
      '--postgres-server', lib.RECONCILE_TARGET.postgresServer,
      '--database', lib.RECONCILE_TARGET.database,
    ]);

    proof.hostile = {
      rerunRefused: rerun.status !== 0,
      productionSeamEnvRefused: prodSeam.status !== 0,
      productionLoopbackWithoutAzureRefused: prodNoSeam.status !== 0,
      rollbackStagesProved: ROLLBACK_STAGES.length,
    };

    proof.ok = true;
    proof.code = 'prove_sunset_ledger_reconcile_fresh_db_ok';
    proof.finalLedgerRows056to060 = sanitized;
    proof.reconcileOk = recon.ok;
    proof.postApply = {
      ledgerDigest: postApply.ledgerDigest,
      catalogFingerprint: postApply.catalogFingerprint,
      ledgerPrefixDigest: postApply.ledgerPrefixDigest,
      ledgerRowCount: postApply.ledgerRowCount,
    };
    console.log(JSON.stringify(proof, null, 2));
    console.log('prove-sunset-staging-ledger-reconcile-fresh-db: PASS');
  } finally {
    try { docker('rm', '-f', container); } catch (_) { /* ignore */ }
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.stack || e);
    process.exit(1);
  });
}

module.exports = { main, ROLLBACK_STAGES, assertRollbackJson };

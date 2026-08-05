'use strict';

/**
 * Disposable local PostgreSQL proof via production CLI subprocess.
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
const { probeSemanticCatalog } = require('./lib/sunset-staging-ledger-reconcile-semantics');
const {
  ENV_DISPOSABLE_PROOF,
  ENV_INTERNAL_CONNECT_HOST,
  ENV_INTERNAL_CONNECT_PORT,
} = require('./lib/sunset-staging-ledger-reconcile-pg');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'run-sunset-staging-ledger-reconcile.js');
const DB_NAME = 'sunset_staging';

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

function baseCliEnv(token, extra) {
  return {
    ...process.env,
    SUNSET_STAGING_PG_ADMIN_USER: 'postgres',
    SUNSET_STAGING_PG_ADMIN_PASSWORD: 'postgres',
    [lib.ENV_ENABLED]: '1',
    [lib.ENV_TOKEN]: token,
    [ENV_DISPOSABLE_PROOF]: '1',
    [ENV_INTERNAL_CONNECT_HOST]: '127.0.0.1',
    [ENV_INTERNAL_CONNECT_PORT]: String(port),
    ...(extra || {}),
  };
}

function baseCliArgv(mode, evidencePath) {
  return [
    mode,
    lib.CLI_APPROVE,
    lib.CLI_EVIDENCE, evidencePath,
    '--subscription', lib.RECONCILE_TARGET.subscriptionId,
    '--resource-group', lib.RECONCILE_TARGET.resourceGroup,
    '--postgres-server', lib.RECONCILE_TARGET.postgresServer,
    '--database', lib.RECONCILE_TARGET.database,
  ];
}

function spawnCli(env, argv) {
  return spawnSync(process.execPath, [CLI, ...argv], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 600000,
  });
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

async function main() {
  docker('run', '--rm', '-d', '--name', container, '-e', 'POSTGRES_PASSWORD=postgres', '-p', `${port}:5432`, 'postgres:16');
  const proof = { ok: false, hostile: {}, cli: {} };
  try {
    await waitReady(admin);
    const boot = new Client(admin);
    await boot.connect();
    await boot.query(`CREATE DATABASE ${DB_NAME}`);
    await boot.end();

    const connection = { host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: DB_NAME };
    const split = await buildSplitState(connection);
    const evidencePath = path.join(ROOT, 'tmp', `sunset-reconcile-proof-${suffix}.json`);
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, JSON.stringify(split.evidence, null, 2));

    const preDryClient = new Client(connection);
    await preDryClient.connect();
    const preDry = await fingerprintLedgerAndCatalog(preDryClient);
    await preDryClient.end();

    const dryRun = spawnCli(baseCliEnv(split.token), baseCliArgv(lib.CLI_DRY_RUN, evidencePath));
    if (dryRun.status !== 0) throw new Error(`cli dry-run failed: ${dryRun.stdout || dryRun.stderr}`);
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
      preLedgerPrefixDigest: preDry.ledgerPrefixDigest,
      postLedgerPrefixDigest: postDry.ledgerPrefixDigest,
      ledgerIdentical: true,
      catalogIdentical: true,
    };

    const applyRun = spawnCli(baseCliEnv(split.token), baseCliArgv(lib.CLI_APPLY, evidencePath));
    if (applyRun.status !== 0) throw new Error(`cli apply failed: ${applyRun.stdout || applyRun.stderr}`);
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

    const rerun = spawnCli(baseCliEnv(split.token), baseCliArgv(lib.CLI_APPLY, evidencePath));
    proof.rerunProof = { refused: rerun.status !== 0, exitCode: rerun.status };

    const rollbackDb = `sunset_staging_rb_${suffix}`;
    const bootRb = new Client(admin);
    await bootRb.connect();
    await bootRb.query(`CREATE DATABASE ${rollbackDb}`);
    await bootRb.end();
    const rollbackConn = { host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: rollbackDb };
    const rollbackSplit = await buildSplitState(rollbackConn);
    const rollbackEvidencePath = path.join(ROOT, 'tmp', `sunset-reconcile-rollback-${suffix}.json`);
    fs.writeFileSync(rollbackEvidencePath, JSON.stringify(rollbackSplit.evidence, null, 2));
    process.env.SUNSET_STAGING_LEDGER_RECONCILE_INJECT_FAIL_STEP = 'apply_057';
    const rollbackRun = spawnCli({
      ...baseCliEnv(rollbackSplit.token),
      SUNSET_STAGING_LEDGER_RECONCILE_INJECT_FAIL_STEP: 'apply_057',
    }, baseCliArgv(lib.CLI_APPLY, rollbackEvidencePath));
    delete process.env.SUNSET_STAGING_LEDGER_RECONCILE_INJECT_FAIL_STEP;
    const rollbackClient = new Client(rollbackConn);
    await rollbackClient.connect();
    const rollbackPost = await fingerprintLedgerAndCatalog(rollbackClient);
    await rollbackClient.end();
    proof.rollbackProof = {
      refused: rollbackRun.status !== 0,
      preLedgerDigest: rollbackSplit.pre.ledgerDigest,
      postLedgerDigest: rollbackPost.ledgerDigest,
      ledgerIdentical: rollbackSplit.pre.ledgerDigest === rollbackPost.ledgerDigest,
      catalogIdentical: rollbackSplit.pre.catalogFingerprint === rollbackPost.catalogFingerprint,
    };

    const wrongDbEnv = baseCliEnv(split.token, { [ENV_INTERNAL_CONNECT_PORT]: String(port) });
    const wrongDb = spawnCli(wrongDbEnv, baseCliArgv(lib.CLI_DRY_RUN, evidencePath));
    proof.hostile = {
      rerunRefused: rerun.status !== 0,
      rollbackLedgerUnchanged: proof.rollbackProof.ledgerIdentical,
      productionLoopbackRefused: (() => {
        const noSeam = spawnCli({
          ...baseCliEnv(split.token),
          [ENV_DISPOSABLE_PROOF]: '',
          [ENV_INTERNAL_CONNECT_HOST]: '',
          [ENV_INTERNAL_CONNECT_PORT]: '',
        }, baseCliArgv(lib.CLI_DRY_RUN, evidencePath));
        return noSeam.status !== 0;
      })(),
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

module.exports = { main };

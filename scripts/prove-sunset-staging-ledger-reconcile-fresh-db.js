'use strict';

/**
 * Disposable local PostgreSQL proof for Sunset 056–060 ledger reconcile.
 * Never connects to Azure or sunset_staging hostnames.
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const {
  CHECKSUM_MODE_CANONICAL_LF_V1,
  MIGRATIONS_DIR,
  prepareMigrationBody,
  reconcileLedger,
  forwardEntries,
  loadManifest,
} = require('./lib/migration-integrity');
const { ensureLedger, applyOne, loadLedger } = require('./run-canonical-migrations');
const lib = require('./lib/sunset-staging-ledger-reconcile');

const suffix = crypto.randomBytes(3).toString('hex');
const container = `wh-sunset-reconcile-proof-${suffix}`;
const port = 55430 + (parseInt(suffix, 16) % 200);
const db = `wh_mig_sunset_reconcile_${suffix}`;
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
  const structural = await lib.probeStructuralState(client);
  return {
    ledgerDigest: crypto.createHash('sha256').update(JSON.stringify(ledger.map((r) => ({
      id: r.id, order: r.apply_order, kind: r.apply_kind, sha: r.checksum_sha256,
    })))).digest('hex'),
    catalogFingerprint: structural.fingerprint,
    ledger,
    structural: structural.row,
  };
}

async function main() {
  docker('run', '--rm', '-d', '--name', container, '-e', 'POSTGRES_PASSWORD=postgres', '-p', `${port}:5432`, 'postgres:16');
  try {
    await waitReady(admin);
    const boot = new Client(admin);
    await boot.connect();
    await boot.query(`CREATE DATABASE ${db}`);
    await boot.end();

    const connection = { host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: db };
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

    const dryClient = new Client(connection);
    await dryClient.connect();
    const preDry = await fingerprintLedgerAndCatalog(dryClient);
    const dry = await lib.executeReconcileDryRun({
      env: { [lib.ENV_ENABLED]: '1', [lib.ENV_TOKEN]: token },
      argv: [
        lib.CLI_DRY_RUN, lib.CLI_APPROVE,
        '--subscription', lib.RECONCILE_TARGET.subscriptionId,
        '--resource-group', lib.RECONCILE_TARGET.resourceGroup,
        '--postgres-server', lib.RECONCILE_TARGET.postgresServer,
        '--database', lib.RECONCILE_TARGET.database,
      ],
      evidence,
      context: ctx,
      client: dryClient,
    });
    const postDry = await fingerprintLedgerAndCatalog(dryClient);
    await dryClient.end();
    if (!dry.ok) throw new Error(`dry-run failed: ${dry.code}`);
    if (preDry.ledgerDigest !== postDry.ledgerDigest || preDry.catalogFingerprint !== postDry.catalogFingerprint) {
      throw new Error('dry-run mutated state');
    }

    const applyResult = await lib.executeReconcileMutation({
      env: { [lib.ENV_ENABLED]: '1', [lib.ENV_TOKEN]: token },
      argv: [
        lib.CLI_APPLY, lib.CLI_APPROVE,
        '--subscription', lib.RECONCILE_TARGET.subscriptionId,
        '--resource-group', lib.RECONCILE_TARGET.resourceGroup,
        '--postgres-server', lib.RECONCILE_TARGET.postgresServer,
        '--database', lib.RECONCILE_TARGET.database,
      ],
      evidence,
      context: ctx,
      client,
    });
    if (!applyResult.ok) throw new Error(`apply failed: ${applyResult.code}`);

    const finalLedger = await loadLedger(client);
    if (finalLedger.length !== lib.TIP_ORDER) throw new Error(`expected ${lib.TIP_ORDER} ledger rows`);
    const recon = reconcileLedger(ctx.forward, finalLedger);
    if (!recon.ok) throw new Error('final reconcile failed');

    const sanitized = finalLedger
      .filter((r) => lib.LOCKED_MIGRATION_IDS.includes(r.id))
      .map((r) => ({
        id: r.id,
        apply_order: r.apply_order,
        apply_kind: r.apply_kind,
        checksum_sha256: r.checksum_sha256,
        checksum_mode: r.checksum_mode,
      }));
    console.log(JSON.stringify({
      ok: true,
      code: 'prove_sunset_ledger_reconcile_fresh_db_ok',
      finalLedgerRows056to060: sanitized,
      reconcileOk: recon.ok,
    }, null, 2));
    console.log('prove-sunset-staging-ledger-reconcile-fresh-db: PASS');
    await client.end();
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

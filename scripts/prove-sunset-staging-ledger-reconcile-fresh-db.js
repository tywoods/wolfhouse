'use strict';

/* Disposable local proof only. It never has an Azure target or credentials. */
const { execFileSync } = require('child_process');
const { Client } = require('pg');
const { ensureLedger, applyOne, loadLedger } = require('./run-canonical-migrations');
const r = require('./lib/sunset-staging-ledger-reconcile');

const port = Number(process.env.SUNSET_RECONCILE_PROOF_PORT || 55436);
const name = `wh-sunset-ledger-reconcile-proof-${process.pid}`;
const connection = { host: '127.0.0.1', port, database: 'wh_mig_sunset_reconcile', user: 'postgres', password: 'postgres' };
function docker(...args) { return execFileSync('docker', args, { stdio: 'inherit' }); }
async function waitForPg() {
  for (let i = 0; i < 30; i += 1) {
    const c = new Client(connection);
    try { await c.connect(); await c.end(); return; } catch (_) { try { await c.end(); } catch (_) {} await new Promise((x) => setTimeout(x, 500)); }
  }
  throw new Error('Postgres did not become ready');
}
async function main() {
  docker('run', '--rm', '-d', '--name', name, '-e', 'POSTGRES_PASSWORD=postgres', '-e', `POSTGRES_DB=${connection.database}`, '-p', `${port}:5432`, 'postgres:16');
  try {
    await waitForPg();
    const client = new Client(connection); await client.connect();
    const ctx = r.manifestContext();
    await ensureLedger(client);
    for (const entry of ctx.forward.slice(0, 53)) await applyOne(client, entry, undefined, undefined, r.CHECKSUM_MODE_CANONICAL_LF_V1);
    /* Simulate only the out-of-band DDL portions. */
    for (const entry of [ctx.entries[0], ctx.entries[4]]) {
      const { prepareMigrationBody } = require('./lib/migration-integrity');
      const fs = require('fs'); const path = require('path');
      const sql = prepareMigrationBody(fs.readFileSync(path.join(require('./lib/migration-integrity').MIGRATIONS_DIR, entry.filename), 'utf8'));
      await client.query(sql.body);
    }
    const catalog = await r.probeCatalog(client);
    const evidence = r.sealEvidence({ target: r.TARGET, manifestDigest: ctx.manifestDigest, catalogFingerprint: catalog.fingerprint, ledgerRows: await loadLedger(client) });
    const cert = r.certify({ evidence, context: ctx });
    if (!cert.ok) throw new Error(`evidence did not certify: ${cert.errors[0].code}`);
    const result = await r.executeReconcileMutation({
      env: { [r.ENV_ENABLED]: '1', [r.ENV_TOKEN]: cert.approvalToken },
      argv: ['--apply-sunset-ledger-reconcile', '--approve-sunset-ledger-reconcile', '--subscription', r.TARGET.subscriptionId, '--resource-group', r.TARGET.resourceGroup, '--postgres-server', r.TARGET.postgresServer, '--database', r.TARGET.database],
      evidence, context: ctx, client,
    });
    if (!result.ok || (await loadLedger(client)).length !== 58) throw new Error(`reconcile proof failed: ${result.code}`);
    console.log('prove-sunset-staging-ledger-reconcile-fresh-db: PASS');
    await client.end();
  } finally {
    try { docker('rm', '-f', name); } catch (_) { /* cleanup */ }
  }
}
if (require.main === module) main().catch((e) => { console.error(e.stack || e); process.exit(1); });
module.exports = { main };

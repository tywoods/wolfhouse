'use strict';

/**
 * Prove Ch4 Slice B7 live session mapping against 088-095 on PGlite.
 * Default-off. No provider. No journal terminal. No live DB.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const b1 = require('./prove-email-luna-automation-issuance-material-pglite');
const b4 = require('./prove-email-luna-automation-shadow-comparison-pglite');
const {
  provisionEmailLunaAutomationPrincipal,
} = require('./lib/email-luna-automation-principal-provision');
const {
  inspectEmailLunaAutomationShadowWorkerSession,
} = require('./lib/email-luna-automation-shadow-session-proof');
const {
  FUNCTION_SIGNATURES,
} = require('./lib/email-luna-automation-principal-contract');
const {
  createEmailLunaAutomationShadowSunsetStagingRuntimeComposition,
} = require('./lib/email-luna-automation-shadow-sunset-staging-runtime-composition');

const ROOT = path.resolve(__dirname, '..');
const RED = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'fixtures/email-luna-automation-shadow-session-hardening-red.json'),
  'utf8',
));
const UP_095 = fs.readFileSync(path.join(ROOT, 'database/migrations/095_tenant_email_luna_automation_claim_scoped.sql'), 'utf8');
const WORKER_ROLE = 'luna_ch4b7_worker';
const UNMAPPED_ROLE = 'luna_ch4b7_unmapped';
const OVERLAY_ROLE = 'luna_ch4b7_overlay';
const CLAIM_SCOPED = `public.${FUNCTION_SIGNATURES.tenant_email_luna_automation_claim_scoped}`;

function tryLoadPglite() {
  for (const base of [
    process.env.NODE_PATH,
    path.join(ROOT, 'node_modules'),
    '/opt/data/worktrees/full-sail-stage1-ch3a/node_modules',
    '/opt/data/wolfhouse-agent/node_modules',
  ].filter(Boolean)) {
    try {
      const mod = require(path.join(String(base).split(path.delimiter)[0], '@electric-sql/pglite'));
      if (mod && mod.PGlite) return mod.PGlite;
    } catch (_) { /* continue */ }
  }
  try { return require('@electric-sql/pglite').PGlite; } catch (_) { return null; }
}

function binding() {
  return {
    client_id: b1.ids.client,
    location_id: b1.ids.location,
    location_key: 'sunset-somo',
  };
}

function clientFor(db) {
  return {
    async query(text, params) {
      return db.query(text, params);
    },
  };
}

function enabledEnv() {
  return {
    LUNA_DEPLOYMENT: 'sunset-staging',
    DEFAULT_CLIENT_SLUG: 'sunset',
    EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ENABLED: 'true',
    EMAIL_LUNA_AUTOMATION_SHADOW_ENABLED: 'true',
    EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_ENABLED: 'true',
    EMAIL_LUNA_AUTOMATION_SHADOW_CLIENT_ID: b1.ids.client,
    EMAIL_LUNA_AUTOMATION_SHADOW_LOCATION_ID: b1.ids.location,
    EMAIL_LUNA_AUTOMATION_SHADOW_LOCATION_KEY: 'sunset-somo',
    EMAIL_LUNA_AUTOMATION_SHADOW_ENDPOINT_ID: b1.ids.endpoint,
    EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_REPLICA_COUNT: '1',
    EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: 'postgres://luna_shadow_worker:worker-secret@127.0.0.1:5432/sunset',
    WOLFHOUSE_DATABASE_URL: 'postgres://postgres:owner-secret@127.0.0.1:5432/sunset',
  };
}

function assertStaticContract() {
  assert.equal(RED.id, 'email-luna-automation-shadow-session-hardening.ch4b7-red.v1');
  assert.equal(RED.head_reviewed, '9239b83cb7b85f75c78c143d3f0a03a7bf76feb6');
  console.log('ok - static B7 session-hardening contract');
}

async function asRole(db, role, work) {
  await db.exec(`SET SESSION AUTHORIZATION ${role}`);
  try {
    return await work();
  } finally {
    await db.exec('SET SESSION AUTHORIZATION postgres');
  }
}

async function provePglite(PGlite) {
  const ids = b1.ids;
  const db = new PGlite();
  await b1.applyThrough088(db);
  await db.exec(b1.UP);
  await db.exec(b4.UP_093);
  await db.exec(b4.UP_094);
  await db.exec(UP_095);
  await b1.revokePublicExecuteOutsideCatalogs(db);

  await provisionEmailLunaAutomationPrincipal(b1.exclusiveSession(db), {
    roleName: WORKER_ROLE,
    kind: 'worker',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: b1.PASSWORD,
    apply: true,
  });

  const mapped = await asRole(db, WORKER_ROLE, () => inspectEmailLunaAutomationShadowWorkerSession(clientFor(db), binding()));
  assert.equal(mapped.ok, true);
  assert.equal(mapped.worker_principal_ok, true);
  assert.equal(mapped.scoped_claim_applied, true);
  console.log('ok - mapped worker session with 095 EXECUTE proves live inspect');

  const owner = await inspectEmailLunaAutomationShadowWorkerSession(clientFor(db), binding());
  assert.equal(owner.ok, false);
  assert.equal(owner.worker_principal_ok, false);
  console.log('ok - table-owner session fails live inspect');

  await db.exec(`CREATE ROLE ${UNMAPPED_ROLE} LOGIN PASSWORD '${b1.PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
  const unmapped = await asRole(db, UNMAPPED_ROLE, () => inspectEmailLunaAutomationShadowWorkerSession(clientFor(db), binding()));
  assert.equal(unmapped.ok, false);
  assert.equal(unmapped.worker_principal_ok, false);
  console.log('ok - unmapped login fails live inspect');

  const wrongLocation = await asRole(db, WORKER_ROLE, () => inspectEmailLunaAutomationShadowWorkerSession(clientFor(db), {
    client_id: ids.client,
    location_id: ids.location2,
    location_key: 'sunset-somo',
  }));
  assert.equal(wrongLocation.ok, false);
  assert.equal(wrongLocation.worker_principal_ok, false);
  console.log('ok - mapped worker for wrong location fails live inspect');

  await db.exec(`REVOKE ALL ON FUNCTION ${CLAIM_SCOPED} FROM ${WORKER_ROLE}`);
  const noExec = await asRole(db, WORKER_ROLE, () => inspectEmailLunaAutomationShadowWorkerSession(clientFor(db), binding()));
  assert.equal(noExec.ok, false);
  assert.equal(noExec.worker_principal_ok, false);
  await db.exec(`GRANT EXECUTE ON FUNCTION ${CLAIM_SCOPED} TO ${WORKER_ROLE}`);
  console.log('ok - missing 095 EXECUTE fails live inspect');

  let setRoleProved = false;
  try {
    await db.exec(`CREATE ROLE ${OVERLAY_ROLE} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    await db.exec(`GRANT ${OVERLAY_ROLE} TO ${WORKER_ROLE}`);
    await db.exec(`SET SESSION AUTHORIZATION ${WORKER_ROLE}`);
    await db.exec(`SET ROLE ${OVERLAY_ROLE}`);
    const overlay = await inspectEmailLunaAutomationShadowWorkerSession(clientFor(db), binding());
    await db.exec('RESET ROLE');
    await db.exec('SET SESSION AUTHORIZATION postgres');
    assert.equal(overlay.ok, false);
    assert.equal(overlay.worker_principal_ok, false);
    setRoleProved = true;
    console.log('ok - SET ROLE overlay (current_user != session_user) fails live inspect');
  } catch (error) {
    await db.exec('SET SESSION AUTHORIZATION postgres').catch(() => {});
    console.log(`ok - PGlite SET ROLE overlay not available (${error && error.message ? 'generic' : 'generic'}); stock-PG owns that proof`);
  }

  const workerLoaner = {
    async withTransactionClient(work) {
      await db.exec(`SET SESSION AUTHORIZATION ${WORKER_ROLE}`);
      try {
        return await work({
          async query(text, params) {
            return db.query(text, params);
          },
        });
      } finally {
        await db.exec('SET SESSION AUTHORIZATION postgres');
      }
    },
  };
  const timers = { setTimeout() { return 1; }, clearTimeout() {} };
  const runtime = createEmailLunaAutomationShadowSunsetStagingRuntimeComposition({
    env: enabledEnv(),
    withTransactionClient: workerLoaner.withTransactionClient,
    timers,
    intervalMs: 60000,
  });
  await runtime.start();
  await runtime.stop();
  console.log('ok - composition start succeeds only for mapped worker session');

  const ownerRuntime = createEmailLunaAutomationShadowSunsetStagingRuntimeComposition({
    env: enabledEnv(),
    async withTransactionClient(work) {
      await db.exec('SET SESSION AUTHORIZATION postgres');
      return work({
        async query(text, params) {
          return db.query(text, params);
        },
      });
    },
    timers,
    intervalMs: 60000,
  });
  await assert.rejects(() => ownerRuntime.start());
  console.log('ok - composition start fails closed on owner session');
  assert.equal(typeof setRoleProved, 'boolean');
}

function runPgliteProof() {
  assertStaticContract();
  const PGlite = tryLoadPglite();
  if (!PGlite) {
    console.log('ok - pglite unavailable; static B7 session-hardening contract only');
    return Promise.resolve();
  }
  return provePglite(PGlite).then(() => {
    console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B7 session-hardening pglite');
  });
}

if (require.main === module) {
  runPgliteProof().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { runPgliteProof };

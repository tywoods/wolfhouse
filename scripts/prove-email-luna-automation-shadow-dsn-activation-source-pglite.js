'use strict';

/**
 * Prove Ch4 Slice B8 binding getters cannot feed session-proof SQL on PGlite.
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
  copyPlainSessionBinding,
} = require('./lib/email-luna-automation-shadow-session-proof');
const {
  resolveEmailLunaAutomationShadowWorkerConnectionConfig,
  PRE_CONNECT_DISTINCTNESS_IS_NOT_LIVE_SESSION_PROOF,
} = require('./lib/email-luna-automation-shadow-worker-connection');

const ROOT = path.resolve(__dirname, '..');
const RED = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'fixtures/email-luna-automation-shadow-dsn-activation-source-red.json'),
  'utf8',
));
const UP_095 = fs.readFileSync(path.join(ROOT, 'database/migrations/095_tenant_email_luna_automation_claim_scoped.sql'), 'utf8');
const WORKER_ROLE = 'luna_ch4b8_worker';

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

function clientFor(db, onQuery) {
  return {
    async query(text, params) {
      if (typeof onQuery === 'function') onQuery(text, params);
      return db.query(text, params);
    },
  };
}

function assertStaticContract() {
  assert.equal(RED.id, 'email-luna-automation-shadow-dsn-activation-source.ch4b8-red.v1');
  assert.equal(RED.head_reviewed, '27f71394c8329868d177f2d9b50a0dbfb5ca6b75');
  assert.equal(PRE_CONNECT_DISTINCTNESS_IS_NOT_LIVE_SESSION_PROOF, true);
  const overlay = resolveEmailLunaAutomationShadowWorkerConnectionConfig({
    env: {
      EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: 'postgres://wolfhouse:x@decoy:5432/sunset?host=127.0.0.1',
      WOLFHOUSE_DATABASE_URL: 'postgres://wolfhouse:owner@127.0.0.1:5432/sunset',
    },
  });
  assert.equal(overlay.ok, false);
  assert.equal(overlay.reason, 'worker_connection_invalid');
  const localhost = resolveEmailLunaAutomationShadowWorkerConnectionConfig({
    env: {
      EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: 'postgres://wolfhouse:x@localhost:5432/sunset',
      WOLFHOUSE_DATABASE_URL: 'postgres://wolfhouse:owner@127.0.0.1:5432/sunset',
    },
  });
  assert.equal(localhost.ok, false);
  assert.equal(localhost.reason, 'worker_connection_is_app_owner');
  console.log('ok - static B8 DSN activation-source contract');
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
  assert.equal(mapped.inspect_failed, false);
  console.log('ok - plain own-scalar binding still proves mapped worker session');

  let getterQueries = 0;
  const getterBinding = {
    location_id: ids.location,
    location_key: 'sunset-somo',
  };
  Object.defineProperty(getterBinding, 'client_id', {
    get() { return ids.client; },
    enumerable: true,
  });
  assert.equal(copyPlainSessionBinding(getterBinding), null);
  const getterResult = await asRole(db, WORKER_ROLE, () => inspectEmailLunaAutomationShadowWorkerSession(
    clientFor(db, () => { getterQueries += 1; }),
    getterBinding,
  ));
  assert.equal(getterResult.inspect_failed, true);
  assert.equal(getterResult.ok, false);
  assert.equal(getterQueries, 0);
  console.log('ok - getter binding fails closed without querying');

  let proxyQueries = 0;
  const proxyBinding = new Proxy(binding(), {
    get(target, prop) {
      return target[prop];
    },
  });
  const proxyResult = await asRole(db, WORKER_ROLE, () => inspectEmailLunaAutomationShadowWorkerSession(
    clientFor(db, () => { proxyQueries += 1; }),
    proxyBinding,
  ));
  assert.equal(proxyResult.inspect_failed, true);
  assert.equal(proxyQueries, 0);
  console.log('ok - proxy binding fails closed without querying');
}

function runPgliteProof() {
  assertStaticContract();
  const PGlite = tryLoadPglite();
  if (!PGlite) {
    console.log('ok - pglite unavailable; static B8 DSN activation-source contract only');
    return Promise.resolve();
  }
  return provePglite(PGlite).then(() => {
    console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B8 DSN activation-source pglite');
  });
}

if (require.main === module) {
  runPgliteProof().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { runPgliteProof };

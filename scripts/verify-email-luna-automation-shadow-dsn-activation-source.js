'use strict';

/** FULL SAIL Stage 1 NIGHTWATCH Chapter 4 Slice B8: DSN/session activation-source. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  resolveEmailLunaAutomationShadowWorkerConnectionConfig,
  closeEmailLunaAutomationShadowWorkerPool,
  PRE_CONNECT_DISTINCTNESS_IS_NOT_LIVE_SESSION_PROOF,
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_CONNECTION_CLOSE_TIMEOUT_MS,
  ENV_WORKER_DATABASE_URL,
  WORKER_DSN_QUERY_ALLOWLIST,
  OVERLAY_QUERY_KEYS,
} = require('./lib/email-luna-automation-shadow-worker-connection');
const {
  inspectEmailLunaAutomationShadowWorkerSession,
  copyPlainSessionBinding,
} = require('./lib/email-luna-automation-shadow-session-proof');
const {
  runEmailLunaAutomationShadowRuntimeOperatorPreflight,
  runEmailLunaAutomationShadowRuntimePreflight,
  INSPECT_AUTHENTICITY_DEDICATED,
  INSPECT_AUTHENTICITY_FAILED,
  INSPECT_AUTHENTICITY_UNIT_TEST,
  UNIT_TEST_INSPECT_KEY,
} = require('./lib/email-luna-automation-shadow-runtime-preflight');
const {
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ACTIVATION,
} = require('./lib/email-luna-automation-shadow-sunset-staging-runtime-composition');
const {
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_RUNTIME_WIRED,
} = require('./lib/email-luna-automation-shadow-worker');
const {
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_WIRED,
} = require('./lib/email-luna-automation-shadow-orchestration');
const {
  EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_RUNTIME_WIRED,
} = require('./lib/email-luna-automation-shadow-outcome-store');

const ROOT = path.join(__dirname, '..');
const RED = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'fixtures/email-luna-automation-shadow-dsn-activation-source-red.json'),
  'utf8',
));
const CONNECTION_SRC = fs.readFileSync(require.resolve('./lib/email-luna-automation-shadow-worker-connection'), 'utf8');
const SESSION_SRC = fs.readFileSync(require.resolve('./lib/email-luna-automation-shadow-session-proof'), 'utf8');
const PREFLIGHT_SRC = fs.readFileSync(require.resolve('./lib/email-luna-automation-shadow-runtime-preflight'), 'utf8');
const COMP_SRC = fs.readFileSync(require.resolve('./lib/email-luna-automation-shadow-sunset-staging-runtime-composition'), 'utf8');
const STAFF_API_SRC = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

const C = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const E = '44444444-4444-4444-8444-444444444444';
const WORKER_SECRET = 'worker-secret-do-not-leak';
const OWNER_SECRET = 'owner-secret-do-not-leak';

console.log('FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B8 DSN activation-source verifier');

assert.equal(RED.id, 'email-luna-automation-shadow-dsn-activation-source.ch4b8-red.v1');
assert.equal(RED.head_reviewed, '27f71394c8329868d177f2d9b50a0dbfb5ca6b75');
assert.equal(RED.pr_reviewed, 706);
assert.equal(RED.runtime_activation, false);
assert.equal(RED.activation_authorized, false);
assert.equal(RED.findings.length, 4);
assert.ok(RED.findings.every((item) => item.red && item.green));
assert.equal(RED.findings[0].id, 'M1-dsn-query-host-port-overlay');
assert.equal(RED.findings[1].id, 'L1-session-proof-binding-getter');
assert.equal(RED.findings[2].id, 'L2-operator-failed-inspect-authenticity-label');
assert.equal(RED.findings[3].id, 'L3-force-close-bounded-termination-documented');
assert.equal(PRE_CONNECT_DISTINCTNESS_IS_NOT_LIVE_SESSION_PROOF, true);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_CONNECTION_CLOSE_TIMEOUT_MS, 5000);
assert.equal(ENV_WORKER_DATABASE_URL, 'EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL');
assert.deepEqual(WORKER_DSN_QUERY_ALLOWLIST.slice(), []);
assert.ok(OVERLAY_QUERY_KEYS.includes('host'));
assert.ok(OVERLAY_QUERY_KEYS.includes('hostname'));
assert.ok(OVERLAY_QUERY_KEYS.includes('port'));
assert.ok(OVERLAY_QUERY_KEYS.includes('database'));
assert.ok(OVERLAY_QUERY_KEYS.includes('dbname'));
assert.ok(OVERLAY_QUERY_KEYS.includes('service'));
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ACTIVATION, false);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_RUNTIME_WIRED, false);
assert.equal(INSPECT_AUTHENTICITY_FAILED, 'inspect_failed');
assert.equal(INSPECT_AUTHENTICITY_DEDICATED, 'dedicated_worker_session');
assert.equal(UNIT_TEST_INSPECT_KEY, 'unit_test_inspect');
console.log('  PASS  authentic RED artifact records PR #706 M1 and L1-L3; default-off pins hold');

function enabledEnv(patch = {}) {
  return {
    LUNA_DEPLOYMENT: 'sunset-staging',
    DEFAULT_CLIENT_SLUG: 'sunset',
    EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ENABLED: 'true',
    EMAIL_LUNA_AUTOMATION_SHADOW_ENABLED: 'true',
    EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_ENABLED: 'true',
    EMAIL_LUNA_AUTOMATION_SHADOW_CLIENT_ID: C,
    EMAIL_LUNA_AUTOMATION_SHADOW_LOCATION_ID: L,
    EMAIL_LUNA_AUTOMATION_SHADOW_LOCATION_KEY: 'sunset-somo',
    EMAIL_LUNA_AUTOMATION_SHADOW_ENDPOINT_ID: E,
    EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_REPLICA_COUNT: '1',
    EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: `postgres://luna_shadow_worker:${WORKER_SECRET}@127.0.0.1:5432/sunset`,
    WOLFHOUSE_DATABASE_URL: `postgres://wolfhouse:${OWNER_SECRET}@127.0.0.1:5432/sunset`,
    ...patch,
  };
}

function inspectRow(patch = {}) {
  return {
    outcomes_table: true,
    capture_fn: true,
    load_fn: true,
    project_fn: true,
    principal_fn: true,
    scoped_claim_fn: true,
    session_user: 'luna_shadow_worker',
    current_user: 'luna_shadow_worker',
    table_owner: 'wolfhouse',
    session_matches_current: true,
    worker_mapping_ok: true,
    scoped_claim_execute: true,
    project_def: "matched := 'staff_action_observed'",
    scoped_claim_def: "FOR UPDATE SKIP LOCKED principal_kind = 'worker' session_user IS DISTINCT FROM owner",
    ...patch,
  };
}

function resolve(patch) {
  return resolveEmailLunaAutomationShadowWorkerConnectionConfig({ env: enabledEnv(patch) });
}

function dumpHas(value, needle) {
  return JSON.stringify(value).includes(needle);
}

function assertNoSecrets(value) {
  assert.equal(dumpHas(value, WORKER_SECRET), false);
  assert.equal(dumpHas(value, OWNER_SECRET), false);
  assert.equal(dumpHas(value, 'password='), false);
}

const dedicated = resolve();
assert.equal(dedicated.ok, true);
assert.equal(dedicated.distinct_from_app, true);
assertNoSecrets(dedicated);

const hostOverlay = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: `postgres://wolfhouse:${WORKER_SECRET}@decoy:5432/sunset?host=127.0.0.1`,
});
assert.equal(hostOverlay.ok, false);
assert.equal(hostOverlay.reason, 'worker_connection_invalid');
assertNoSecrets(hostOverlay);

const hostnameOverlay = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: `postgres://luna_shadow_worker:${WORKER_SECRET}@decoy:5432/sunset?hostname=127.0.0.1`,
});
assert.equal(hostnameOverlay.ok, false);
assert.equal(hostnameOverlay.reason, 'worker_connection_invalid');

const portOverlay = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: `postgres://luna_shadow_worker:${WORKER_SECRET}@127.0.0.1:5432/sunset?port=65432`,
});
assert.equal(portOverlay.ok, false);
assert.equal(portOverlay.reason, 'worker_connection_invalid');

const databaseOverlay = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: `postgres://luna_shadow_worker:${WORKER_SECRET}@127.0.0.1:5432/sunset?database=other`,
});
assert.equal(databaseOverlay.ok, false);

const dbnameOverlay = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: `postgres://luna_shadow_worker:${WORKER_SECRET}@127.0.0.1:5432/sunset?dbname=other`,
});
assert.equal(dbnameOverlay.ok, false);

const serviceOverlay = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: `postgres://luna_shadow_worker:${WORKER_SECRET}@127.0.0.1:5432/sunset?service=wolfhouse`,
});
assert.equal(serviceOverlay.ok, false);

const encodedHost = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: `postgres://wolfhouse:${WORKER_SECRET}@decoy:5432/sunset?%68ost=127.0.0.1`,
});
assert.equal(encodedHost.ok, false);
assert.equal(encodedHost.reason, 'worker_connection_invalid');
assertNoSecrets(encodedHost);

const mixedHost = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: `postgres://luna_shadow_worker:${WORKER_SECRET}@decoy:5432/sunset?Host=127.0.0.1`,
});
assert.equal(mixedHost.ok, false);

const duplicateHost = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: `postgres://luna_shadow_worker:${WORKER_SECRET}@decoy:5432/sunset?host=127.0.0.1&host=10.0.0.1`,
});
assert.equal(duplicateHost.ok, false);

const whitespaceHost = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: `postgres://luna_shadow_worker:${WORKER_SECRET}@decoy:5432/sunset?%20host=127.0.0.1`,
});
assert.equal(whitespaceHost.ok, false);

const emptyQuery = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: `postgres://luna_shadow_worker:${WORKER_SECRET}@127.0.0.1:5432/sunset?`,
});
assert.equal(emptyQuery.ok, false);
assert.equal(emptyQuery.reason, 'worker_connection_invalid');

const sslmodeWorker = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: `postgres://luna_shadow_worker:${WORKER_SECRET}@127.0.0.1:5432/sunset?sslmode=require`,
});
assert.equal(sslmodeWorker.ok, false);
assert.equal(sslmodeWorker.reason, 'worker_connection_invalid');

const passfileWorker = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: `postgres://luna_shadow_worker:${WORKER_SECRET}@127.0.0.1:5432/sunset?passfile=/tmp/pgpass`,
});
assert.equal(passfileWorker.ok, false);

const sslcertWorker = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: `postgres://luna_shadow_worker:${WORKER_SECRET}@127.0.0.1:5432/sunset?sslcert=/tmp/client.crt`,
});
assert.equal(sslcertWorker.ok, false);

const unknownQuery = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: `postgres://luna_shadow_worker:${WORKER_SECRET}@127.0.0.1:5432/sunset?application_name=shadow`,
});
assert.equal(unknownQuery.ok, false);
assert.equal(unknownQuery.reason, 'worker_connection_invalid');
assertNoSecrets(unknownQuery);

const localhostSame = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: `postgres://wolfhouse:${WORKER_SECRET}@localhost:5432/sunset`,
  WOLFHOUSE_DATABASE_URL: `postgres://wolfhouse:${OWNER_SECRET}@127.0.0.1:5432/sunset`,
});
assert.equal(localhostSame.ok, false);
assert.equal(localhostSame.reason, 'worker_connection_is_app_owner');
assertNoSecrets(localhostSame);

const ipv6Same = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: `postgres://wolfhouse:${WORKER_SECRET}@[::1]:5432/sunset`,
  WOLFHOUSE_DATABASE_URL: `postgres://wolfhouse:${OWNER_SECRET}@127.0.0.1/sunset`,
});
assert.equal(ipv6Same.ok, false);
assert.equal(ipv6Same.reason, 'worker_connection_is_app_owner');

const defaultPortSame = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: `postgres://wolfhouse:${WORKER_SECRET}@127.0.0.1/sunset`,
  WOLFHOUSE_DATABASE_URL: `postgres://wolfhouse:${OWNER_SECRET}@127.0.0.1:5432/sunset`,
});
assert.equal(defaultPortSame.ok, false);
assert.equal(defaultPortSame.reason, 'worker_connection_is_app_owner');

const appHostOverlay = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: `postgres://wolfhouse:${WORKER_SECRET}@127.0.0.1:5432/sunset`,
  WOLFHOUSE_DATABASE_URL: `postgres://other:${OWNER_SECRET}@decoy:5432/sunset?host=127.0.0.1&user=wolfhouse`,
});
assert.equal(appHostOverlay.ok, false);
assert.equal(appHostOverlay.reason, 'worker_connection_is_app_owner');
assertNoSecrets(appHostOverlay);

const appSslmodeSame = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: `postgres://wolfhouse:${WORKER_SECRET}@127.0.0.1:5432/sunset`,
  WOLFHOUSE_DATABASE_URL: `postgres://wolfhouse:${OWNER_SECRET}@127.0.0.1/sunset?sslmode=require`,
});
assert.equal(appSslmodeSame.ok, false);
assert.equal(appSslmodeSame.reason, 'worker_connection_is_app_owner');

const appPassfileUnproven = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: `postgres://luna_shadow_worker:${WORKER_SECRET}@127.0.0.1:5432/sunset`,
  WOLFHOUSE_DATABASE_URL: `postgres://wolfhouse:${OWNER_SECRET}@127.0.0.1:5432/sunset?passfile=/tmp/pgpass`,
});
assert.equal(appPassfileUnproven.ok, false);
assert.equal(appPassfileUnproven.reason, 'app_connection_unproven');
assertNoSecrets(appPassfileUnproven);

const stillDistinct = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: `postgres://luna_shadow_worker:${WORKER_SECRET}@127.0.0.1:5432/sunset`,
  WOLFHOUSE_DATABASE_URL: `postgresql://wolfhouse:${OWNER_SECRET}@127.0.0.1:5432/sunset`,
});
assert.equal(stillDistinct.ok, true);
assert.equal(stillDistinct.distinct_from_app, true);
assertNoSecrets(stillDistinct);

function tryPgConnectionStringParse(dsn) {
  const candidates = [
    'pg-connection-string',
    path.join(ROOT, 'node_modules/pg-connection-string'),
    '/opt/data/calendar-inventory-bridge-bf/node_modules/pg-connection-string',
  ];
  for (let index = 0; index < candidates.length; index += 1) {
    try {
      const mod = require(candidates[index]);
      const parse = typeof mod.parse === 'function' ? mod.parse : mod;
      if (typeof parse === 'function') return parse(dsn);
    } catch (_) { /* continue */ }
  }
  return null;
}

const libraryParse = tryPgConnectionStringParse(
  `postgres://wolfhouse:${OWNER_SECRET}@decoy:5432/sunset?host=127.0.0.1`,
);
if (libraryParse) {
  assert.equal(libraryParse.host, '127.0.0.1');
  assert.equal(libraryParse.user, 'wolfhouse');
  console.log('  PASS  pg-connection-string host overlay matches pg.Pool identity');
} else {
  console.log('  PASS  pg-connection-string module optional; identity tests use documented 2.13.0 semantics');
}

assert.match(CONNECTION_SRC, /WORKER_DSN_QUERY_ALLOWLIST/);
assert.match(CONNECTION_SRC, /canonicalizeHost|loopback/);
assert.match(CONNECTION_SRC, /pg-connection-string/);
assert.match(CONNECTION_SRC, /Do not await pool\.end\(\)|must not await pool\.end/);
assert.equal(PRE_CONNECT_DISTINCTNESS_IS_NOT_LIVE_SESSION_PROOF, true);
console.log('  PASS  M1 worker query allowlist empty; host/port overlays, localhost/IPv6/default port, no secret leak');

async function main() {
  let getterRead = false;
  let queried = false;
  const getterBinding = {
    location_id: L,
    location_key: 'sunset-somo',
  };
  Object.defineProperty(getterBinding, 'client_id', {
    get() {
      getterRead = true;
      return C;
    },
    enumerable: true,
  });
  const getterResult = await inspectEmailLunaAutomationShadowWorkerSession({
    async query() {
      queried = true;
      return { rows: [inspectRow()] };
    },
  }, getterBinding);
  assert.equal(getterResult.inspect_failed, true);
  assert.equal(getterResult.ok, false);
  assert.equal(queried, false);
  assert.equal(getterRead, false);
  assert.equal(copyPlainSessionBinding(getterBinding), null);

  let proxyRead = false;
  let proxyQueried = false;
  const proxyBinding = new Proxy({
    client_id: C,
    location_id: L,
    location_key: 'sunset-somo',
  }, {
    get(target, prop) {
      proxyRead = true;
      return target[prop];
    },
  });
  const proxyResult = await inspectEmailLunaAutomationShadowWorkerSession({
    async query() {
      proxyQueried = true;
      return { rows: [inspectRow()] };
    },
  }, proxyBinding);
  assert.equal(proxyResult.inspect_failed, true);
  assert.equal(proxyQueried, false);
  assert.equal(proxyRead, false);
  assert.equal(copyPlainSessionBinding(proxyBinding), null);

  const plain = copyPlainSessionBinding({
    client_id: C,
    location_id: L,
    location_key: 'sunset-somo',
  });
  assert.equal(plain.client_id, C);
  assert.equal(Object.getPrototypeOf(plain), null);

  let plainQueried = false;
  let plainParams = null;
  const plainResult = await inspectEmailLunaAutomationShadowWorkerSession({
    async query(_sql, params) {
      plainQueried = true;
      plainParams = params;
      return { rows: [inspectRow()] };
    },
  }, {
    client_id: C,
    location_id: L,
    location_key: 'sunset-somo',
  });
  assert.equal(plainResult.inspect_failed, false);
  assert.equal(plainQueried, true);
  assert.deepEqual(plainParams, [C, L, 'sunset-somo']);
  assert.match(SESSION_SRC, /copyPlainSessionBinding/);
  console.log('  PASS  L1 getter/proxy binding cannot feed SQL params; plain own scalars copy first');

  const failedCreate = await runEmailLunaAutomationShadowRuntimeOperatorPreflight({
    env: enabledEnv({
      EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: '',
    }),
    appConnectionString: `postgres://wolfhouse:${OWNER_SECRET}@127.0.0.1:5432/sunset`,
  });
  assert.equal(failedCreate.ok, false);
  assert.equal(failedCreate.inspect_authenticity, INSPECT_AUTHENTICITY_FAILED);
  assert.notEqual(failedCreate.inspect_authenticity, INSPECT_AUTHENTICITY_DEDICATED);
  assert.ok(failedCreate.blockers.includes('schema_inspect_failed'));
  assertNoSecrets(failedCreate);

  const failedInspectOp = await runEmailLunaAutomationShadowRuntimeOperatorPreflight({
    env: enabledEnv(),
    appConnectionString: `postgres://wolfhouse:${OWNER_SECRET}@127.0.0.1:5432/sunset`,
  });
  assert.equal(failedInspectOp.ok, false);
  assert.equal(failedInspectOp.inspect_authenticity, INSPECT_AUTHENTICITY_FAILED);
  assert.notEqual(failedInspectOp.inspect_authenticity, INSPECT_AUTHENTICITY_DEDICATED);
  assert.ok(failedInspectOp.blockers.includes('schema_inspect_failed'));
  assertNoSecrets(failedInspectOp);
  assert.match(PREFLIGHT_SRC, /INSPECT_AUTHENTICITY_FAILED/);
  assert.doesNotMatch(
    PREFLIGHT_SRC.slice(PREFLIGHT_SRC.indexOf('async function runEmailLunaAutomationShadowRuntimeOperatorPreflight')),
    /const authentic = INSPECT_AUTHENTICITY_DEDICATED;/,
  );
  console.log('  PASS  L2 operator failure labels inspect_failed, never dedicated_worker_session');

  const unitReady = await runEmailLunaAutomationShadowRuntimePreflight({
    env: enabledEnv(),
    unit_test_inspect: true,
    async query() { return { rows: [inspectRow()] }; },
  });
  assert.equal(unitReady.ok, true);
  assert.equal(unitReady.inspect_authenticity, INSPECT_AUTHENTICITY_UNIT_TEST);
  assert.equal(unitReady.runtime_started, false);
  assert.equal(unitReady.activation_started, false);
  assert.equal(unitReady.provider_capability, false);
  assert.equal(unitReady.send_allowed, false);

  const stuckPool = {
    _clients: [{
      end() { return Promise.resolve(); },
    }],
    end() {
      return new Promise(() => {});
    },
    _remove() {
      this._clients = [];
    },
  };
  const closeStarted = Date.now();
  const closeOutcome = await closeEmailLunaAutomationShadowWorkerPool(stuckPool, 25);
  const closeElapsed = Date.now() - closeStarted;
  assert.equal(closeOutcome, 'timeout');
  assert.ok(closeElapsed < 200);
  assert.match(CONNECTION_SRC, /Do not await pool\.end\(\)|must not await pool\.end/);
  console.log('  PASS  L3 close timeout returns without awaiting pool.end() after force-remove');

  assert.match(STAFF_API_SRC, /runEmailLunaAutomationShadowRuntimeOperatorPreflight/);
  assert.match(COMP_SRC, /inspectEmailLunaAutomationShadowWorkerSession/);
  assert.doesNotMatch(STAFF_API_SRC, /unit_test_inspect/);
  console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B8 DSN activation-source');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

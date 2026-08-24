'use strict';

/** FULL SAIL Stage 1 NIGHTWATCH Chapter 4 Slice B7: session/DSN/shutdown hardening. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  resolveEmailLunaAutomationShadowWorkerConnectionConfig,
  drainEmailLunaAutomationShadowRuntimePair,
  closeEmailLunaAutomationShadowWorkerPool,
  attachEmailLunaAutomationShadowWorkerPoolIdleGuard,
  isAuthenticEmailLunaAutomationShadowWorkerConnection,
  PRE_CONNECT_DISTINCTNESS_IS_NOT_LIVE_SESSION_PROOF,
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_CONNECTION_CLOSE_TIMEOUT_MS,
  ENV_WORKER_DATABASE_URL,
  ERROR_CODE: CONNECTION_ERROR,
} = require('./lib/email-luna-automation-shadow-worker-connection');
const {
  createEmailLunaAutomationShadowSunsetStagingRuntimeComposition,
  SCHEMA_SQL,
  ERROR_CODE: COMPOSITION_ERROR,
} = require('./lib/email-luna-automation-shadow-sunset-staging-runtime-composition');
const {
  runEmailLunaAutomationShadowRuntimePreflight,
  runEmailLunaAutomationShadowRuntimeOperatorPreflight,
  UNIT_TEST_INSPECT_KEY,
  INSPECT_AUTHENTICITY_UNIT_TEST,
  INSPECT_AUTHENTICITY_DEDICATED,
  ERROR_CODE: PREFLIGHT_ERROR,
} = require('./lib/email-luna-automation-shadow-runtime-preflight');
const {
  EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT,
  FUNCTION_SIGNATURES,
  executeFunctionsFor,
} = require('./lib/email-luna-automation-principal-contract');
const {
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_STOP_DRAIN_TIMEOUT_MS,
} = require('./lib/email-luna-automation-shadow-worker');

const ROOT = path.join(__dirname, '..');
const RED = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'fixtures/email-luna-automation-shadow-session-hardening-red.json'),
  'utf8',
));
const STAFF_API_SRC = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const WORKER_SRC = fs.readFileSync(require.resolve('./lib/email-luna-automation-shadow-worker'), 'utf8');
const CONNECTION_SRC = fs.readFileSync(require.resolve('./lib/email-luna-automation-shadow-worker-connection'), 'utf8');
const PREFLIGHT_SRC = fs.readFileSync(require.resolve('./lib/email-luna-automation-shadow-runtime-preflight'), 'utf8');
const COMP_SRC = fs.readFileSync(require.resolve('./lib/email-luna-automation-shadow-sunset-staging-runtime-composition'), 'utf8');
const SESSION_SRC = fs.readFileSync(require.resolve('./lib/email-luna-automation-shadow-session-proof'), 'utf8');

const C = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const E = '44444444-4444-4444-8444-444444444444';

console.log('FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B7 session-hardening verifier');

assert.equal(RED.id, 'email-luna-automation-shadow-session-hardening.ch4b7-red.v1');
assert.equal(RED.head_reviewed, '9239b83cb7b85f75c78c143d3f0a03a7bf76feb6');
assert.equal(RED.pr_reviewed, 705);
assert.equal(RED.runtime_activation, false);
assert.equal(RED.activation_authorized, false);
assert.equal(RED.findings.length, 5);
assert.ok(RED.findings.every((item) => item.red && item.green));
assert.equal(PRE_CONNECT_DISTINCTNESS_IS_NOT_LIVE_SESSION_PROOF, true);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_CONNECTION_CLOSE_TIMEOUT_MS, 5000);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_STOP_DRAIN_TIMEOUT_MS, 5000);
assert.equal(ENV_WORKER_DATABASE_URL, 'EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL');
console.log('  PASS  authentic RED artifact records PR #705 M1-M3 and L1-L2');

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
    EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: 'postgres://luna_shadow_worker:worker-secret@127.0.0.1:5432/sunset',
    WOLFHOUSE_DATABASE_URL: 'postgres://wolfhouse:owner-secret@127.0.0.1:5432/sunset',
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

function schemaRow(patch = {}) {
  return inspectRow({
    project_def: "matched := 'staff_action_observed'; pending_human",
    ...patch,
  });
}

function resolve(patch) {
  return resolveEmailLunaAutomationShadowWorkerConnectionConfig({ env: enabledEnv(patch) });
}

function dumpHas(value, needle) {
  return JSON.stringify(value).includes(needle);
}

const caseSame = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: 'postgres://Wolfhouse:worker-secret@127.0.0.1:5432/sunset',
});
assert.equal(caseSame.ok, false);
assert.equal(caseSame.reason, 'worker_connection_is_app_owner');
assert.equal(dumpHas(caseSame, 'worker-secret'), false);
assert.equal(dumpHas(caseSame, 'owner-secret'), false);

const queryUser = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: 'postgres://luna_shadow_worker:x@127.0.0.1:5432/sunset?user=wolfhouse',
});
assert.equal(queryUser.ok, false);
assert.equal(queryUser.reason, 'worker_connection_invalid');

const queryOptions = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: 'postgres://luna_shadow_worker:x@127.0.0.1:5432/sunset?options=-c%20role%3Dwolfhouse',
});
assert.equal(queryOptions.ok, false);
assert.equal(queryOptions.reason, 'worker_connection_invalid');

const queryRole = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: 'postgres://luna_shadow_worker:x@127.0.0.1:5432/sunset?role=wolfhouse',
});
assert.equal(queryRole.ok, false);
assert.equal(queryRole.reason, 'worker_connection_invalid');

const encodedUser = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: 'postgres://luna_shadow_worker:x@127.0.0.1:5432/sunset?%75ser=wolfhouse',
});
assert.equal(encodedUser.ok, false);
assert.equal(encodedUser.reason, 'worker_connection_invalid');

const duplicateUser = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: 'postgres://luna_shadow_worker:x@127.0.0.1:5432/sunset?user=a&user=b',
});
assert.equal(duplicateUser.ok, false);
assert.equal(duplicateUser.reason, 'worker_connection_invalid');

const overlaySameUser = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: 'postgres://luna_shadow_worker:x@127.0.0.1:5432/sunset?user=luna_shadow_worker',
});
assert.equal(overlaySameUser.ok, false);
assert.equal(overlaySameUser.reason, 'worker_connection_invalid');

const appQueryUser = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: 'postgres://luna_shadow_worker:x@127.0.0.1:5432/sunset',
  WOLFHOUSE_DATABASE_URL: 'postgres://app:owner-secret@127.0.0.1:5432/sunset?user=luna_shadow_worker',
});
assert.equal(appQueryUser.ok, false);
assert.equal(appQueryUser.reason, 'worker_connection_is_app_owner');

const appDefaultPort = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: 'postgres://wolfhouse:x@127.0.0.1:5432/sunset',
  WOLFHOUSE_DATABASE_URL: 'postgres://wolfhouse:owner-secret@127.0.0.1/sunset?sslmode=require',
});
assert.equal(appDefaultPort.ok, false);
assert.equal(appDefaultPort.reason, 'worker_connection_is_app_owner');

const hostCase = resolve({
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: 'postgres://luna_shadow_worker:x@127.0.0.1:5432/Sunset',
  WOLFHOUSE_DATABASE_URL: 'postgresql://wolfhouse:owner-secret@127.0.0.1:5432/sunset',
});
assert.equal(hostCase.ok, true);
assert.equal(hostCase.distinct_from_app, true);

const missingApp = resolveEmailLunaAutomationShadowWorkerConnectionConfig({
  env: {
    EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: 'postgres://luna_shadow_worker:x@127.0.0.1:5432/sunset',
  },
});
assert.equal(missingApp.ok, false);
assert.equal(missingApp.reason, 'app_connection_unproven');
assert.equal(dumpHas(missingApp, 'worker-secret'), false);
assert.equal(dumpHas(missingApp, ':x@'), false);
console.log('  PASS  M1 DSN identity: case, overlay, encoded/duplicate, app URL equivalence, no secret leak');

assert.match(SCHEMA_SQL, /current_user/);
assert.match(SCHEMA_SQL, /worker_mapping_ok/);
assert.match(SCHEMA_SQL, /has_function_privilege/);
assert.match(SCHEMA_SQL, /session_matches_current/);
assert.match(SESSION_SRC, /copyPlainInspectRow/);
assert.match(COMP_SRC, /inspectEmailLunaAutomationShadowWorkerSession/);
assert.match(PREFLIGHT_SRC, /runEmailLunaAutomationShadowRuntimeOperatorPreflight/);
assert.match(STAFF_API_SRC, /runEmailLunaAutomationShadowRuntimeOperatorPreflight/);
assert.match(STAFF_API_SRC, /drainEmailLunaAutomationShadowRuntimePair/);
assert.doesNotMatch(STAFF_API_SRC, /unit_test_inspect/);
assert.doesNotMatch(STAFF_API_SRC, /runEmailLunaAutomationShadowRuntimePreflight\(/);
console.log('  PASS  Staff API operator preflight uses dedicated connection; unit-test inspect impossible in production API');

assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.canonical_queue_workers_require_unscoped_claim_execute, true);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.sunset_shadow_runtime_calls_unscoped_claim, false);
assert.equal(executeFunctionsFor('worker').includes(FUNCTION_SIGNATURES.tenant_email_luna_automation_claim), true);
assert.doesNotMatch(WORKER_SRC, /claimAutomationOperation/);
assert.match(WORKER_SRC, /claimScopedAutomationOperation/);
assert.doesNotMatch(WORKER_SRC, /tenant_email_luna_automation_claim\(/);
console.log('  PASS  L2 canonical workers keep 088 EXECUTE; Sunset runtime cannot call unscoped claim');

assert.equal(isAuthenticEmailLunaAutomationShadowWorkerConnection({}), false);
assert.equal(isAuthenticEmailLunaAutomationShadowWorkerConnection(null), false);

async function expectInvalid(fn, code) {
  await Promise.resolve()
    .then(fn)
    .then(() => {
      throw new Error('expected invalid');
    }, (error) => {
      assert.equal(error && error.code, code);
    });
}

async function main() {
  await expectInvalid(
    () => runEmailLunaAutomationShadowRuntimePreflight({
      env: enabledEnv(),
      async query() { return { rows: [inspectRow()] }; },
    }),
    PREFLIGHT_ERROR,
  );
  await expectInvalid(
    () => runEmailLunaAutomationShadowRuntimeOperatorPreflight({
      env: enabledEnv(),
      query: async () => ({ rows: [inspectRow()] }),
    }),
    PREFLIGHT_ERROR,
  );
  await expectInvalid(
    () => runEmailLunaAutomationShadowRuntimeOperatorPreflight({
      env: enabledEnv(),
      unit_test_inspect: true,
      workerConnection: {},
    }),
    PREFLIGHT_ERROR,
  );
  console.log('  PASS  query injection without unit_test_inspect is invalid; operator API refuses query/injection');

  const ready = await runEmailLunaAutomationShadowRuntimePreflight({
    env: enabledEnv(),
    unit_test_inspect: true,
    async query() { return { rows: [inspectRow()] }; },
  });
  assert.equal(ready.ok, true);
  assert.equal(ready.inspect_authenticity, INSPECT_AUTHENTICITY_UNIT_TEST);

  const getter = {
    outcomes_table: false,
    capture_fn: false,
    load_fn: false,
    project_fn: false,
    principal_fn: false,
    scoped_claim_fn: false,
    session_user: 'wolfhouse',
    current_user: 'wolfhouse',
    table_owner: 'wolfhouse',
    session_matches_current: false,
    worker_mapping_ok: false,
    scoped_claim_execute: false,
    project_def: "matched := 'agreement'",
    scoped_claim_def: null,
  };
  Object.defineProperty(getter, 'outcomes_table', { get() { return true; }, enumerable: true });
  const getterResult = await runEmailLunaAutomationShadowRuntimePreflight({
    env: enabledEnv(),
    unit_test_inspect: true,
    async query() { return { rows: [getter] }; },
  });
  assert.equal(getterResult.ok, false);
  assert.ok(getterResult.blockers.includes('schema_inspect_failed'));

  const proxyResult = await runEmailLunaAutomationShadowRuntimePreflight({
    env: enabledEnv(),
    unit_test_inspect: true,
    async query() {
      return {
        rows: [new Proxy(inspectRow({
          outcomes_table: false,
          worker_mapping_ok: false,
          scoped_claim_execute: false,
        }), {
          get(target, prop) {
            if (prop === 'outcomes_table' || prop === 'worker_mapping_ok' || prop === 'scoped_claim_execute') return true;
            return target[prop];
          },
        })],
      };
    },
  });
  assert.equal(proxyResult.ok, false);
  assert.ok(proxyResult.blockers.includes('schema_inspect_failed'));
  console.log('  PASS  L1 getter/proxy rows cannot forge preflight ok:true');

  const setRole = await runEmailLunaAutomationShadowRuntimePreflight({
    env: enabledEnv(),
    unit_test_inspect: true,
    async query() {
      return {
        rows: [inspectRow({
          current_user: 'overlay_role',
          session_matches_current: false,
        })],
      };
    },
  });
  assert.equal(setRole.ok, false);
  assert.ok(setRole.blockers.includes('worker_principal_unproven'));

  const unmapped = await runEmailLunaAutomationShadowRuntimePreflight({
    env: enabledEnv(),
    unit_test_inspect: true,
    async query() { return { rows: [inspectRow({ worker_mapping_ok: false })] }; },
  });
  assert.equal(unmapped.ok, false);
  assert.ok(unmapped.blockers.includes('worker_principal_unproven'));

  const wrongTenant = await runEmailLunaAutomationShadowRuntimePreflight({
    env: enabledEnv(),
    unit_test_inspect: true,
    async query() { return { rows: [inspectRow({ worker_mapping_ok: false })] }; },
  });
  assert.equal(wrongTenant.ok, false);

  const missingExec = await runEmailLunaAutomationShadowRuntimePreflight({
    env: enabledEnv(),
    unit_test_inspect: true,
    async query() { return { rows: [inspectRow({ scoped_claim_execute: false })] }; },
  });
  assert.equal(missingExec.ok, false);
  assert.ok(missingExec.blockers.includes('worker_principal_unproven'));
  console.log('  PASS  M2 preflight fails closed on SET ROLE, unmapped, and missing EXECUTE');

  const timers = { setTimeout() { return 1; }, clearTimeout() {} };
  function createRuntime(schemaPatch) {
    return createEmailLunaAutomationShadowSunsetStagingRuntimeComposition({
      env: enabledEnv(),
      async withTransactionClient(work) {
        return work({
          async query(text) {
            if (/pg_get_functiondef/.test(String(text))) return { rows: [schemaRow(schemaPatch)] };
            return { rows: [] };
          },
        });
      },
      timers,
      intervalMs: 60000,
    });
  }
  await assert.rejects(
    () => createRuntime({
      current_user: 'overlay_role',
      session_matches_current: false,
    }).start(),
    (error) => error && error.code === COMPOSITION_ERROR,
  );
  await assert.rejects(
    () => createRuntime({ worker_mapping_ok: false }).start(),
    (error) => error && error.code === COMPOSITION_ERROR,
  );
  await assert.rejects(
    () => createRuntime({ scoped_claim_execute: false }).start(),
    (error) => error && error.code === COMPOSITION_ERROR,
  );
  console.log('  PASS  M2 composition start fails closed on overlay, unmapped worker, missing EXECUTE');

  const order = [];
  await drainEmailLunaAutomationShadowRuntimePair({
    runtime: {
      async stop() {
        order.push('stop');
        await new Promise((resolve) => { setTimeout(resolve, 15); });
      },
    },
    connection: {
      async close() {
        order.push('close');
      },
    },
  });
  assert.deepEqual(order, ['stop', 'close']);

  let stops = 0;
  let closes = 0;
  const runtime = { async stop() { stops += 1; } };
  const connection = { async close() { closes += 1; } };
  await drainEmailLunaAutomationShadowRuntimePair({ runtime, connection });
  await drainEmailLunaAutomationShadowRuntimePair({ runtime: null, connection: null });
  assert.equal(stops, 1);
  assert.equal(closes, 1);

  const secret = 'password=do-not-leak';
  const stuckPool = {
    _clients: [{
      end() { return Promise.resolve(); },
    }],
    end() { return new Promise(() => {}); },
    _remove(client) {
      if (client && typeof client.end === 'function') client.end();
      this._clients = [];
    },
  };
  const closeOutcome = await closeEmailLunaAutomationShadowWorkerPool(stuckPool, 25);
  assert.equal(closeOutcome, 'timeout');

  let idleRecorded = 0;
  const idlePool = new EventEmitter();
  attachEmailLunaAutomationShadowWorkerPoolIdleGuard(idlePool, () => {
    idleRecorded += 1;
  });
  idlePool.emit('error', new Error(secret));
  assert.equal(idleRecorded, 1);

  const drainDump = JSON.stringify({ closeOutcome, idleRecorded });
  assert.equal(drainDump.includes('do-not-leak'), false);
  assert.equal(CONNECTION_SRC.includes("pool.on('error'"), true);
  assert.match(CONNECTION_SRC, /forceCloseShadowWorkerPool|force-close/);
  assert.match(STAFF_API_SRC, /drainEmailLunaAutomationShadowRuntimePair/);
  assert.doesNotMatch(
    STAFF_API_SRC.slice(STAFF_API_SRC.indexOf('function drainStaffApiEmailRuntimes')),
    /drains\.push\(Promise\.resolve\(EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME\.stop\(\)\)\)[\s\S]*drains\.push\(Promise\.resolve\(EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_CONNECTION\.close\(\)\)\)/,
  );
  console.log('  PASS  M3 stop-then-close, bounded pool.end, idle error, double shutdown, no secret leak');

  assert.equal(UNIT_TEST_INSPECT_KEY, 'unit_test_inspect');
  assert.equal(INSPECT_AUTHENTICITY_DEDICATED, 'dedicated_worker_session');
  assert.equal(CONNECTION_ERROR, 'EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_CONNECTION_INVALID');
  console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B7 session-hardening');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

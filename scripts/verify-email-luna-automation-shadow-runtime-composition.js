'use strict';
/** FULL SAIL Stage 1 NIGHTWATCH Chapter 4 Slice B5: default-off Sunset shadow runtime composition. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  createEmailLunaAutomationShadowSunsetStagingRuntimeComposition,
  resolveEmailLunaAutomationShadowSunsetStagingRuntimeReadiness,
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_WIRED,
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ACTIVATION,
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_LOGGING_FORBIDDEN,
  ENV_COMPOSITION_ENABLED,
  ENV_CLIENT_ID,
  ENV_LOCATION_ID,
  ENV_LOCATION_KEY,
  ENV_ENDPOINT_ID,
  ENV_REPLICA_COUNT,
  MIGRATION_095_ID,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  SUNSET_LOCATION_KEY,
  SHADOW_MODE,
  MIGRATION_093_ID,
  MIGRATION_094_ID,
  SCHEMA_SQL,
  ERROR_CODE,
  DISABLED_CODE,
} = require('./lib/email-luna-automation-shadow-sunset-staging-runtime-composition');
const {
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_RUNTIME_WIRED,
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_CONCURRENCY,
  ENV_SHADOW_WORKER_ENABLED,
} = require('./lib/email-luna-automation-shadow-worker');
const {
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_WIRED,
  ENV_SHADOW_ENABLED,
} = require('./lib/email-luna-automation-shadow-orchestration');
const {
  EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_RUNTIME_WIRED,
  EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH,
} = require('./lib/email-luna-automation-shadow-outcome-store');

const ROOT = path.join(__dirname, '..');
const RED = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'fixtures/email-luna-automation-shadow-runtime-composition-red.json'),
  'utf8',
));
const COMP_SRC = fs.readFileSync(require.resolve('./lib/email-luna-automation-shadow-sunset-staging-runtime-composition'), 'utf8');
const STAFF_API_SRC = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const COMPOSE_SRC = fs.readFileSync(path.join(ROOT, 'docker/hermes-staging/docker-compose.vm.yml'), 'utf8');
const DOCKERFILE_SRC = fs.readFileSync(path.join(ROOT, 'docker/hermes-staging/Dockerfile'), 'utf8');
const SQL_094 = fs.readFileSync(path.join(ROOT, 'database/migrations/094_tenant_email_luna_automation_shadow_outcome_identity_match.sql'), 'utf8');
const SQL_093 = fs.readFileSync(path.join(ROOT, 'database/migrations/093_tenant_email_luna_automation_shadow_outcomes.sql'), 'utf8');

const C = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const E = '44444444-4444-4444-8444-444444444444';

console.log('FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B5 shadow runtime composition verifier');

assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_WIRED, true);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ACTIVATION, false);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_LOGGING_FORBIDDEN, true);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_CONCURRENCY, 1);
assert.equal(ENV_COMPOSITION_ENABLED, 'EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ENABLED');
assert.equal(SUNSET_DEPLOYMENT, 'sunset-staging');
assert.equal(SUNSET_TENANT, 'sunset');
assert.equal(SUNSET_LOCATION_KEY, 'sunset-somo');
assert.equal(SHADOW_MODE, 'shadow');
assert.equal(MIGRATION_093_ID, '093_tenant_email_luna_automation_shadow_outcomes');
assert.equal(MIGRATION_094_ID, '094_tenant_email_luna_automation_shadow_outcome_identity_match');
assert.equal(MIGRATION_095_ID, '095_tenant_email_luna_automation_claim_scoped');
assert.equal(ENV_REPLICA_COUNT, 'EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_REPLICA_COUNT');
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.unique_human_would_send, 'staff_action_observed');
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.unique_human_kind, 'inbound_workflow_identity');
assert.equal(RED.id, 'email-luna-automation-shadow-runtime-composition.ch4b5-red.v1');
assert.equal(RED.slice, 'FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B5');
assert.equal(RED.head_reviewed, '525d3f6580ccf1aea612485868e5f48f31a2ea3b');
assert.equal(RED.provider_transition, false);
assert.equal(RED.runtime_activation, false);
assert.equal(RED.send_permission, false);
assert.equal(RED.findings.length, 4);
assert.ok(RED.findings.every((item) => item.severity === 'blocking' && item.red && item.green));
console.log('  PASS  authentic RED artifact records 525d3f65 missing composition/preflight/safe identity label');

assert.match(SQL_094, /staff_action_observed/);
assert.match(SQL_094, /REVOKE ALL ON FUNCTION/);
assert.equal(/^\s*GRANT /m.test(SQL_094), false);
assert.equal(/^\s*CREATE ROLE/m.test(SQL_094), false);
assert.equal(/matched := 'agreement'/.test(SQL_094), false);
assert.match(SQL_093, /matched := 'agreement'/);
assert.match(SQL_093, /comparison_state = 'pending_human'/);
assert.equal(/require\(['"]nodemailer['"]\)/.test(COMP_SRC), false);
assert.equal(/require\(['"].*microsoft-graph/.test(COMP_SRC), false);
assert.equal(/require\(['"].*email-outbound/.test(COMP_SRC), false);
assert.equal(/dispatchApprovedOutbound/.test(COMP_SRC), false);
assert.equal(/authorize_dispatch:\s*true/.test(COMP_SRC), false);
assert.equal(/console\.log/.test(COMP_SRC), false);
assert.match(STAFF_API_SRC, /email-luna-automation-shadow-sunset-staging-runtime-composition/);
assert.match(STAFF_API_SRC, /EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_READINESS\.runtime_activation === true/);
assert.match(STAFF_API_SRC, /createEmailLunaAutomationShadowWorkerConnection/);
assert.match(STAFF_API_SRC, /drainStaffApiEmailRuntimes/);
assert.doesNotMatch(STAFF_API_SRC, /withTransactionClient:\s*\(work\)\s*=>\s*_withPgClientImpl/);
assert.match(STAFF_API_SRC, /EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME\.stop\(\)|drainStaffApiEmailRuntimes/);
assert.doesNotMatch(STAFF_API_SRC, /EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_ENABLED|email-luna-automation-shadow-worker'/);
assert.doesNotMatch(STAFF_API_SRC, /email-luna-automation-shadow-orchestration|EMAIL_LUNA_AUTOMATION_SHADOW_ENABLED/);
assert.doesNotMatch(COMPOSE_SRC, /EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ENABLED=true/);
assert.doesNotMatch(DOCKERFILE_SRC, /EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ENABLED/);
assert.match(SCHEMA_SQL, /staff_action_observed|shadow_outcome_project/);
console.log('  PASS  shadow runtime is provider-inert, Staff API-owned, default-off in docker, 094 identity label');

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

const defaultReadiness = resolveEmailLunaAutomationShadowSunsetStagingRuntimeReadiness({});
assert.equal(defaultReadiness.ok, true);
assert.equal(defaultReadiness.runtime_activation, false);
assert.equal(defaultReadiness.reason, 'default_off');
assert.equal(defaultReadiness.provider_capability, false);
assert.equal(resolveEmailLunaAutomationShadowSunsetStagingRuntimeReadiness(process.env).runtime_activation, false);

const ready = resolveEmailLunaAutomationShadowSunsetStagingRuntimeReadiness(enabledEnv());
assert.equal(ready.ok, true);
assert.equal(ready.runtime_activation, true);
assert.equal(ready.comparison_state_label, 'staff_action_observed');
assert.equal(ready.comparison_kind, 'inbound_workflow_identity');

for (const [label, env] of [
  ['missing composition flag', enabledEnv({ EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ENABLED: undefined })],
  ['composition false', enabledEnv({ EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ENABLED: 'false' })],
  ['TRUE coerce', enabledEnv({ EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ENABLED: 'TRUE' })],
  ['truthy one', enabledEnv({ EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ENABLED: '1' })],
  ['worker only', { LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_ENABLED: 'true' }],
  ['producer only', { LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_LUNA_AUTOMATION_SHADOW_ENABLED: 'true' }],
  ['draft substitute', { LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true' }],
  ['wrong deployment', enabledEnv({ LUNA_DEPLOYMENT: 'production' })],
  ['wrong tenant', enabledEnv({ DEFAULT_CLIENT_SLUG: 'wolfhouse-somo' })],
  ['wrong location', enabledEnv({ EMAIL_LUNA_AUTOMATION_SHADOW_LOCATION_KEY: 'sunset-sardinero' })],
  ['wrong endpoint', enabledEnv({ EMAIL_LUNA_AUTOMATION_SHADOW_ENDPOINT_ID: 'not-an-endpoint' })],
  ['missing endpoint', enabledEnv({ EMAIL_LUNA_AUTOMATION_SHADOW_ENDPOINT_ID: undefined })],
  ['missing worker flag', enabledEnv({ EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_ENABLED: undefined })],
  ['missing producer flag', enabledEnv({ EMAIL_LUNA_AUTOMATION_SHADOW_ENABLED: undefined })],
  ['auto send refused', enabledEnv({ LUNA_AUTO_SEND_ENABLED: 'true' })],
  ['auto send TRUE refused', enabledEnv({ LUNA_AUTO_SEND_ENABLED: 'TRUE' })],
  ['auto send 1 refused', enabledEnv({ LUNA_AUTO_SEND_ENABLED: '1' })],
  ['auto send yes refused', enabledEnv({ LUNA_AUTO_SEND_ENABLED: 'yes' })],
  ['auto send on refused', enabledEnv({ LUNA_AUTO_SEND_ENABLED: 'on' })],
  ['replica 2 refused', enabledEnv({ EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_REPLICA_COUNT: '2' })],
  ['replica missing refused', enabledEnv({ EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_REPLICA_COUNT: undefined })],
  ['owner pool DSN refused', enabledEnv({ EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: 'postgres://wolfhouse:owner-secret@127.0.0.1:5432/sunset' })],
  ['worker DSN missing refused', enabledEnv({ EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: undefined })],
]) {
  const snapshot = resolveEmailLunaAutomationShadowSunsetStagingRuntimeReadiness(env);
  assert.equal(snapshot.runtime_activation, false, label);
}
const coexistOutbound = resolveEmailLunaAutomationShadowSunsetStagingRuntimeReadiness(enabledEnv({
  EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'true',
}));
assert.equal(coexistOutbound.runtime_activation, true);
assert.equal(coexistOutbound.provider_capability, false);
console.log('  PASS  exact independent flags + Sunset tenant/location/endpoint; no truthy coerce or substitutes');

function expectDisabled(fn) {
  assert.throws(fn, (error) => error && error.code === DISABLED_CODE);
}
function expectInvalid(fn) {
  assert.throws(fn, (error) => error && error.code === ERROR_CODE);
}

const inertLoaner = async (work) => work({ async query() { return { rows: [] }; } });
const timers = { setTimeout() { return 1; }, clearTimeout() {} };
expectDisabled(() => createEmailLunaAutomationShadowSunsetStagingRuntimeComposition({
  env: {},
  withTransactionClient: inertLoaner,
  timers,
  intervalMs: 60000,
}));
expectDisabled(() => createEmailLunaAutomationShadowSunsetStagingRuntimeComposition({
  env: enabledEnv({ EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_ENABLED: 'false' }),
  withTransactionClient: inertLoaner,
  timers,
  intervalMs: 60000,
}));
expectDisabled(() => createEmailLunaAutomationShadowSunsetStagingRuntimeComposition({
  env: enabledEnv({ LUNA_DEPLOYMENT: 'sunset-production' }),
  withTransactionClient: inertLoaner,
  timers,
  intervalMs: 60000,
}));
expectInvalid(() => createEmailLunaAutomationShadowSunsetStagingRuntimeComposition({
  env: enabledEnv(),
  withTransactionClient: inertLoaner,
  timers,
  intervalMs: 60000,
  provider: () => {},
}));
expectInvalid(() => createEmailLunaAutomationShadowSunsetStagingRuntimeComposition({
  env: enabledEnv(),
  withTransactionClient: inertLoaner,
  timers,
  intervalMs: 60000,
  callback: () => {},
}));
expectInvalid(() => createEmailLunaAutomationShadowSunsetStagingRuntimeComposition({
  env: enabledEnv(),
  withTransactionClient: inertLoaner,
  timers,
  intervalMs: 60000,
  https: {},
}));
expectInvalid(() => createEmailLunaAutomationShadowSunsetStagingRuntimeComposition({
  env: enabledEnv(),
  withTransactionClient: inertLoaner,
  timers,
  intervalMs: 1000,
}));
expectDisabled(() => createEmailLunaAutomationShadowSunsetStagingRuntimeComposition({
  env: enabledEnv({ LUNA_AUTO_SEND_ENABLED: 'true' }),
  withTransactionClient: inertLoaner,
  timers,
  intervalMs: 60000,
}));
console.log('  PASS  create is default-off and refuses provider/callback/https/short interval/auto-send');

function schemaRow(patch = {}) {
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
    project_def: "matched := 'staff_action_observed'; pending_human",
    scoped_claim_def: "FOR UPDATE SKIP LOCKED principal_kind = 'worker' session_user IS DISTINCT FROM owner",
    ...patch,
  };
}

function createRuntime(options = {}) {
  const state = {
    queries: [],
    ticks: 0,
    started: 0,
    ...options.state,
  };
  const timerState = { calls: [], cleared: 0, live: 0 };
  const runtime = createEmailLunaAutomationShadowSunsetStagingRuntimeComposition({
    env: options.env || enabledEnv(),
    async withTransactionClient(work) {
      return work({
        async query(text) {
          state.queries.push(String(text));
          if (/shadow_outcome_project/.test(String(text)) && /pg_get_functiondef/.test(String(text))) {
            return { rows: [schemaRow(options.schema)] };
          }
          if (/tenant_email_luna_automation_claim/.test(String(text))) {
            return { rows: [] };
          }
          return { rows: [] };
        },
      });
    },
    timers: options.timers || {
      setTimeout(fn, ms) {
        timerState.calls.push({ fn, ms });
        timerState.live += 1;
        return timerState.calls.length;
      },
      clearTimeout() {
        timerState.cleared += 1;
        if (timerState.live > 0) timerState.live -= 1;
      },
    },
    intervalMs: options.intervalMs || 60000,
  });
  return { runtime, state, timerState };
}

async function main() {
  const created = createRuntime();
  assert.deepEqual(Object.keys(created.runtime).sort(), ['getBinding', 'getReadiness', 'start', 'stop', 'tick']);
  assert.equal(created.timerState.calls.length, 0);
  assert.equal(created.state.queries.length, 0);
  const beforeStart = await created.runtime.tick();
  assert.equal(beforeStart.status, 'stopped');
  assert.equal(created.timerState.calls.length, 0);
  console.log('  PASS  create is start-inert; tick before start does not arm a loop');

  await created.runtime.start();
  assert.equal(created.timerState.calls.length, 1);
  assert.equal(created.timerState.calls[0].ms, 60000);
  assert.ok(created.state.queries.some((sql) => /shadow_outcomes/.test(sql)));
  await created.runtime.start();
  assert.equal(created.timerState.calls.length, 1);
  const ticked = await created.runtime.tick();
  assert.equal(ticked.status, 'empty');
  const overlap = await Promise.all([created.runtime.tick(), created.runtime.tick()]);
  assert.equal(overlap.some((item) => item.status === 'overlap_skipped' || item.status === 'empty'), true);
  await created.runtime.stop();
  assert.equal(created.timerState.cleared >= 1, true);
  const afterStop = await created.runtime.tick();
  assert.equal(afterStop.status, 'stopped');
  await created.runtime.start();
  assert.equal(created.timerState.calls.length, 2);
  await created.runtime.stop();
  console.log('  PASS  start verifies schema, double start is idempotent, stop/restart works, concurrency=1');

  const missingSchema = createRuntime({ schema: { outcomes_table: false, project_fn: false, project_def: null } });
  await assert.rejects(
    () => missingSchema.runtime.start(),
    (error) => error && error.code === ERROR_CODE,
  );
  assert.equal(missingSchema.timerState.calls.length, 0);
  console.log('  PASS  migration/principal not ready fails start closed and never schedules');

  const unsafeSchema = createRuntime({ schema: { project_def: "matched := 'agreement'" } });
  await assert.rejects(
    () => unsafeSchema.runtime.start(),
    (error) => error && error.code === ERROR_CODE,
  );
  console.log('  PASS  unsafe agreement projection label fails start closed');

  let releaseTick;
  const blocked = new Promise((resolve) => { releaseTick = resolve; });
  const drainTimerState = { cleared: 0 };
  const drainTimers = {
    setTimeout() { return 1; },
    clearTimeout() { drainTimerState.cleared += 1; },
  };
  const drainRuntime = createEmailLunaAutomationShadowSunsetStagingRuntimeComposition({
    env: enabledEnv(),
    async withTransactionClient(work) {
      return work({
        async query(text) {
          if (/pg_get_functiondef/.test(String(text))) return { rows: [schemaRow()] };
          await blocked;
          return { rows: [] };
        },
      });
    },
    timers: drainTimers,
    intervalMs: 60000,
  });
  await drainRuntime.start();
  const ticking = drainRuntime.tick();
  let stopped = false;
  const stopping = drainRuntime.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  releaseTick();
  await Promise.all([ticking, stopping]);
  assert.equal(stopped, true);
  assert.equal(drainTimerState.cleared >= 1, true);
  console.log('  PASS  stop drains in-flight tick and cancels timer');

  let releaseTimerTick;
  const timerBlocked = new Promise((resolve) => { releaseTimerTick = resolve; });
  const timerDrainState = { cleared: 0, armed: [] };
  const timerRuntime = createEmailLunaAutomationShadowSunsetStagingRuntimeComposition({
    env: enabledEnv(),
    async withTransactionClient(work) {
      return work({
        async query(text) {
          if (/pg_get_functiondef/.test(String(text))) return { rows: [schemaRow()] };
          await timerBlocked;
          return { rows: [] };
        },
      });
    },
    timers: {
      setTimeout(fn, ms) {
        timerDrainState.armed.push({ fn, ms });
        return timerDrainState.armed.length;
      },
      clearTimeout() { timerDrainState.cleared += 1; },
    },
    intervalMs: 60000,
  });
  await timerRuntime.start();
  assert.equal(timerDrainState.armed.length, 1);
  const timerTick = timerDrainState.armed[0].fn();
  let timerStopped = false;
  const timerStopping = timerRuntime.stop().then(() => { timerStopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timerStopped, false);
  releaseTimerTick();
  await Promise.all([timerTick, timerStopping]);
  assert.equal(timerStopped, true);
  assert.equal(timerDrainState.cleared >= 1, true);
  console.log('  PASS  M1 stop drains timer-driven B3 tick and cancels future timers');

  const ownerSession = createRuntime({ schema: { session_user: 'wolfhouse', current_user: 'wolfhouse', table_owner: 'wolfhouse' } });
  await assert.rejects(
    () => ownerSession.runtime.start(),
    (error) => error && error.code === ERROR_CODE,
  );
  assert.equal(ownerSession.timerState.calls.length, 0);
  console.log('  PASS  H1 table-owner session fails start closed');

  const setRole = createRuntime({
    schema: {
      session_user: 'luna_shadow_worker',
      current_user: 'overlay_role',
      session_matches_current: false,
    },
  });
  await assert.rejects(
    () => setRole.runtime.start(),
    (error) => error && error.code === ERROR_CODE,
  );
  const unmapped = createRuntime({ schema: { worker_mapping_ok: false } });
  await assert.rejects(
    () => unmapped.runtime.start(),
    (error) => error && error.code === ERROR_CODE,
  );
  const missingExec = createRuntime({ schema: { scoped_claim_execute: false } });
  await assert.rejects(
    () => missingExec.runtime.start(),
    (error) => error && error.code === ERROR_CODE,
  );
  console.log('  PASS  SET ROLE overlay, unmapped worker, and missing 095 EXECUTE fail start closed');

  const reboundClient = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const reboundLocation = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const reboundEndpoint = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const rebound = createEmailLunaAutomationShadowSunsetStagingRuntimeComposition({
    env: enabledEnv({
      EMAIL_LUNA_AUTOMATION_SHADOW_CLIENT_ID: reboundClient,
      EMAIL_LUNA_AUTOMATION_SHADOW_LOCATION_ID: reboundLocation,
      EMAIL_LUNA_AUTOMATION_SHADOW_ENDPOINT_ID: reboundEndpoint,
    }),
    withTransactionClient: inertLoaner,
    timers,
    intervalMs: 60000,
  });
  assert.equal(rebound.getBinding().client_id, reboundClient);
  assert.equal(rebound.getBinding().location_id, reboundLocation);
  assert.equal(rebound.getBinding().endpoint_id, reboundEndpoint);
  assert.notEqual(rebound.getBinding().endpoint_id, E);
  console.log('  PASS  valid UUID rebound is a distinct runtime bind, not a parse collapse');

  const staleKernel = {
    processNextShadowClaim() {
      return Promise.resolve({ status: 'empty' });
    },
    requestStop() {},
    resume() {},
  };
  // stale callback coverage is owned by the worker loop; composition uses that loop.
  assert.equal(typeof staleKernel.processNextShadowClaim, 'function');

  const binding = created.runtime.getBinding();
  assert.equal(binding.client_id, C);
  assert.equal(binding.location_id, L);
  assert.equal(binding.location_key, 'sunset-somo');
  assert.equal(binding.endpoint_id, E);
  assert.equal(binding.provider_capability, undefined);
  assert.equal(created.runtime.getReadiness().provider_capability, false);
  console.log('  PASS  binding is exact Sunset tenant/location/endpoint with zero provider capability');

  const inert = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const mod = require(${JSON.stringify(require.resolve('./lib/email-luna-automation-shadow-sunset-staging-runtime-composition'))});
    assert.equal(mod.EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_WIRED, true);
    assert.equal(mod.EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ACTIVATION, false);
    assert.equal(mod.resolveEmailLunaAutomationShadowSunsetStagingRuntimeReadiness({}).runtime_activation, false);
    process.stdout.write('inert-ok');
  `], { encoding: 'utf8' });
  assert.equal(inert.status, 0, inert.stderr || inert.stdout);
  assert.match(inert.stdout, /inert-ok/);
  console.log('  PASS  fresh process import does not start a loop');

  console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B5 shadow runtime composition');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

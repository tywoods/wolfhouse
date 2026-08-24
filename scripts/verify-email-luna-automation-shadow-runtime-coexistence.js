'use strict';

/** FULL SAIL Stage 1 NIGHTWATCH Chapter 4 Slice C1: staff outbound / shadow runtime coexistence. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  createEmailLunaAutomationShadowSunsetStagingRuntimeComposition,
  resolveEmailLunaAutomationShadowSunsetStagingRuntimeReadiness,
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_WIRED,
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ACTIVATION,
  ENV_COMPOSITION_ENABLED,
  ENV_REPLICA_COUNT,
  ERROR_CODE,
  DISABLED_CODE,
} = require('./lib/email-luna-automation-shadow-sunset-staging-runtime-composition');
const {
  resolveEmailLunaAutomationShadowWorkerConnectionConfig,
  WORKER_DSN_QUERY_ALLOWLIST,
  PRE_CONNECT_DISTINCTNESS_IS_NOT_LIVE_SESSION_PROOF,
} = require('./lib/email-luna-automation-shadow-worker-connection');
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
  path.join(ROOT, 'fixtures/email-luna-automation-shadow-runtime-coexistence-red.json'),
  'utf8',
));
const COMP_SRC = fs.readFileSync(require.resolve('./lib/email-luna-automation-shadow-sunset-staging-runtime-composition'), 'utf8');
const STAFF_API_SRC = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const INBOX_SRC = fs.readFileSync(require.resolve('./lib/staff-email-inbox-routes'), 'utf8');
const COMPOSE_SRC = fs.readFileSync(path.join(ROOT, 'docker/hermes-staging/docker-compose.vm.yml'), 'utf8');
const DOCKERFILE_SRC = fs.readFileSync(path.join(ROOT, 'docker/hermes-staging/Dockerfile'), 'utf8');

const C = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const E = '44444444-4444-4444-8444-444444444444';

console.log('FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice C1 shadow runtime coexistence verifier');

assert.equal(RED.id, 'email-luna-automation-shadow-runtime-coexistence.ch4c1-red.v1');
assert.equal(RED.slice, 'FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice C1');
assert.equal(RED.head_reviewed, '120b457f0fed3c960cf561330d9808e56268b6bd');
assert.equal(RED.pr_reviewed, 707);
assert.equal(RED.runtime_activation, false);
assert.equal(RED.activation_authorized, false);
assert.equal(RED.send_permission, false);
assert.equal(RED.journal_terminal, false);
assert.equal(RED.provider_transition, false);
assert.equal(RED.whole_process_provider_inertness, false);
assert.equal(RED.shadow_runtime_provider_inertness, true);
assert.equal(RED.findings.length, 2);
assert.equal(RED.findings[0].id, 'M1-staff-outbound-composition-blocks-shadow');
assert.equal(RED.findings[1].id, 'M2-auto-send-and-shadow-inertness-must-hold');
assert.ok(RED.findings.every((item) => item.red && item.green));
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_WIRED, true);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ACTIVATION, false);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_RUNTIME_WIRED, false);
assert.equal(ENV_COMPOSITION_ENABLED, 'EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ENABLED');
assert.match(COMP_SRC, /ENV_AUTO_SEND = 'LUNA_AUTO_SEND_ENABLED'/);
assert.match(COMP_SRC, /ENV_OUTBOUND = 'EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED'/);
assert.equal(ENV_REPLICA_COUNT, 'EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_REPLICA_COUNT');
assert.equal(PRE_CONNECT_DISTINCTNESS_IS_NOT_LIVE_SESSION_PROOF, true);
assert.deepEqual(WORKER_DSN_QUERY_ALLOWLIST.slice(), []);
console.log('  PASS  authentic RED artifact records PR #707 over-refusal; default-off pins hold');

assert.equal(/require\(['"]nodemailer['"]\)/.test(COMP_SRC), false);
assert.equal(/require\(['"].*microsoft-graph/.test(COMP_SRC), false);
assert.equal(/require\(['"].*email-outbound/.test(COMP_SRC), false);
assert.equal(/dispatchApprovedOutbound/.test(COMP_SRC), false);
assert.equal(/authorize_dispatch:\s*true/.test(COMP_SRC), false);
assert.equal(/console\.log/.test(COMP_SRC), false);
assert.match(STAFF_API_SRC, /createSunsetStagingEmailOutboundDispatch/);
assert.match(STAFF_API_SRC, /createOutboundDispatch\(pgClient, env\)/);
assert.match(STAFF_API_SRC, /email-luna-automation-shadow-sunset-staging-runtime-composition/);
assert.match(STAFF_API_SRC, /EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_CONNECTION\.withTransactionClient/);
assert.doesNotMatch(STAFF_API_SRC, /withTransactionClient:\s*\(work\)\s*=>\s*_withPgClientImpl/);
assert.match(INBOX_SRC, /EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED/);
assert.match(INBOX_SRC, /createOutboundDispatch/);
assert.doesNotMatch(COMPOSE_SRC, /EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ENABLED=true/);
assert.doesNotMatch(DOCKERFILE_SRC, /EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ENABLED/);
const refusedBlock = COMP_SRC.slice(
  COMP_SRC.indexOf('function refusedCapabilities'),
  COMP_SRC.indexOf('function replicaCountExact'),
);
assert.match(refusedBlock, /ENV_AUTO_SEND/);
assert.doesNotMatch(refusedBlock, /ENV_OUTBOUND/);
console.log('  PASS  shadow-runtime provider inertness; staff outbound is a separate Staff API lifecycle');

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
assert.equal(ready.provider_capability, false);
assert.equal(ready.journal_handoff, false);

const coexist = resolveEmailLunaAutomationShadowSunsetStagingRuntimeReadiness(enabledEnv({
  EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'true',
}));
assert.equal(coexist.ok, true, 'staff outbound composition true must not block shadow readiness');
assert.equal(coexist.runtime_activation, true);
assert.equal(coexist.provider_capability, false);
assert.equal(coexist.journal_handoff, false);
assert.equal(coexist.reason, 'exact_sunset_gates');
assert.notEqual(coexist.reason, 'provider_capability_refused');
console.log('  PASS  EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED=true no longer blocks shadow readiness');

for (const [label, env] of [
  ['auto send refused', enabledEnv({ LUNA_AUTO_SEND_ENABLED: 'true' })],
  ['auto send with outbound refused', enabledEnv({
    LUNA_AUTO_SEND_ENABLED: 'true',
    EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'true',
  })],
  ['auto send TRUE refused', enabledEnv({ LUNA_AUTO_SEND_ENABLED: 'TRUE' })],
  ['auto send 1 refused', enabledEnv({ LUNA_AUTO_SEND_ENABLED: '1' })],
  ['wrong deployment', enabledEnv({
    LUNA_DEPLOYMENT: 'production',
    EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'true',
  })],
  ['wrong tenant', enabledEnv({
    DEFAULT_CLIENT_SLUG: 'wolfhouse-somo',
    EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'true',
  })],
  ['wrong location', enabledEnv({
    EMAIL_LUNA_AUTOMATION_SHADOW_LOCATION_KEY: 'sunset-sardinero',
    EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'true',
  })],
  ['wrong endpoint', enabledEnv({
    EMAIL_LUNA_AUTOMATION_SHADOW_ENDPOINT_ID: 'not-an-endpoint',
    EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'true',
  })],
  ['replica 2 refused', enabledEnv({
    EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_REPLICA_COUNT: '2',
    EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'true',
  })],
  ['owner pool DSN refused', enabledEnv({
    EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: 'postgres://wolfhouse:owner-secret@127.0.0.1:5432/sunset',
    EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'true',
  })],
  ['query-host overlay refused', enabledEnv({
    EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: 'postgres://wolfhouse:worker-secret@decoy:5432/sunset?host=127.0.0.1',
    EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'true',
  })],
]) {
  const snapshot = resolveEmailLunaAutomationShadowSunsetStagingRuntimeReadiness(env);
  assert.equal(snapshot.runtime_activation, false, label);
}
assert.equal(
  resolveEmailLunaAutomationShadowSunsetStagingRuntimeReadiness(enabledEnv({ LUNA_AUTO_SEND_ENABLED: 'true' })).reason,
  'provider_capability_refused',
);
const hostOverlay = resolveEmailLunaAutomationShadowWorkerConnectionConfig({
  env: enabledEnv({
    EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'true',
    EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: 'postgres://wolfhouse:worker-secret@decoy:5432/sunset?host=127.0.0.1',
  }),
});
assert.equal(hostOverlay.ok, false);
assert.equal(hostOverlay.reason, 'worker_connection_invalid');
console.log('  PASS  LUNA_AUTO_SEND remains a hard refusal; DSN/session/replica/tenant-location-endpoint gates hold');

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
  env: enabledEnv({ LUNA_AUTO_SEND_ENABLED: 'true' }),
  withTransactionClient: inertLoaner,
  timers,
  intervalMs: 60000,
}));
expectDisabled(() => createEmailLunaAutomationShadowSunsetStagingRuntimeComposition({
  env: enabledEnv({
    LUNA_AUTO_SEND_ENABLED: 'true',
    EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'true',
  }),
  withTransactionClient: inertLoaner,
  timers,
  intervalMs: 60000,
}));
expectInvalid(() => createEmailLunaAutomationShadowSunsetStagingRuntimeComposition({
  env: enabledEnv({ EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'true' }),
  withTransactionClient: inertLoaner,
  timers,
  intervalMs: 60000,
  provider: () => {},
}));
expectInvalid(() => createEmailLunaAutomationShadowSunsetStagingRuntimeComposition({
  env: enabledEnv({ EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'true' }),
  withTransactionClient: inertLoaner,
  timers,
  intervalMs: 60000,
  callback: () => {},
}));
expectInvalid(() => createEmailLunaAutomationShadowSunsetStagingRuntimeComposition({
  env: enabledEnv({ EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'true' }),
  withTransactionClient: inertLoaner,
  timers,
  intervalMs: 60000,
  https: {},
}));
console.log('  PASS  create stays default-off; auto-send and injected provider/send/callback still fail closed');

async function main() {
  const coexistRuntime = createEmailLunaAutomationShadowSunsetStagingRuntimeComposition({
    env: enabledEnv({ EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'true' }),
    withTransactionClient: inertLoaner,
    timers,
    intervalMs: 60000,
  });
  assert.deepEqual(Object.keys(coexistRuntime).sort(), ['getBinding', 'getReadiness', 'start', 'stop', 'tick']);
  assert.equal(coexistRuntime.getReadiness().runtime_activation, true);
  assert.equal(coexistRuntime.getReadiness().provider_capability, false);
  assert.equal(coexistRuntime.getReadiness().journal_handoff, false);
  assert.equal(coexistRuntime.getBinding().provider_capability, undefined);
  const beforeStart = await coexistRuntime.tick();
  assert.equal(beforeStart.status, 'stopped');
  assert.equal(beforeStart.provider_invoked, false);
  assert.equal(beforeStart.journal_handoff, false);
  assert.equal(beforeStart.send_allowed, false);
  console.log('  PASS  shadow create with staff outbound composition is start-inert and send-inert');

  const inert = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const mod = require(${JSON.stringify(require.resolve('./lib/email-luna-automation-shadow-sunset-staging-runtime-composition'))});
    const env = {
      LUNA_DEPLOYMENT: 'sunset-staging',
      DEFAULT_CLIENT_SLUG: 'sunset',
      EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ENABLED: 'true',
      EMAIL_LUNA_AUTOMATION_SHADOW_ENABLED: 'true',
      EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_ENABLED: 'true',
      EMAIL_LUNA_AUTOMATION_SHADOW_CLIENT_ID: '11111111-1111-4111-8111-111111111111',
      EMAIL_LUNA_AUTOMATION_SHADOW_LOCATION_ID: '22222222-2222-4222-8222-222222222222',
      EMAIL_LUNA_AUTOMATION_SHADOW_LOCATION_KEY: 'sunset-somo',
      EMAIL_LUNA_AUTOMATION_SHADOW_ENDPOINT_ID: '44444444-4444-4444-8444-444444444444',
      EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_REPLICA_COUNT: '1',
      EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: 'postgres://luna_shadow_worker:worker-secret@127.0.0.1:5432/sunset',
      WOLFHOUSE_DATABASE_URL: 'postgres://wolfhouse:owner-secret@127.0.0.1:5432/sunset',
      EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'true',
    };
    const ready = mod.resolveEmailLunaAutomationShadowSunsetStagingRuntimeReadiness(env);
    assert.equal(ready.runtime_activation, true);
    assert.equal(ready.provider_capability, false);
    assert.equal(mod.resolveEmailLunaAutomationShadowSunsetStagingRuntimeReadiness({}).runtime_activation, false);
    process.stdout.write('inert-ok');
  `], { encoding: 'utf8' });
  assert.equal(inert.status, 0, inert.stderr || inert.stdout);
  assert.match(inert.stdout, /inert-ok/);
  console.log('  PASS  fresh process import does not start a loop; coexistence remains default-off until explicit start');

  console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice C1 shadow runtime coexistence');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

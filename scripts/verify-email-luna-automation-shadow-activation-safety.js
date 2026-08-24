'use strict';
/** FULL SAIL Stage 1 NIGHTWATCH Chapter 4 Slice B6: activation-safety corrections. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  resolveEmailLunaAutomationShadowWorkerConnectionConfig,
  ENV_WORKER_DATABASE_URL,
} = require('./lib/email-luna-automation-shadow-worker-connection');
const {
  resolveEmailLunaAutomationShadowSunsetStagingRuntimeReadiness,
  ENV_REPLICA_COUNT,
  MIGRATION_095_ID,
} = require('./lib/email-luna-automation-shadow-sunset-staging-runtime-composition');
const {
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_STOP_DRAIN_TIMEOUT_MS,
} = require('./lib/email-luna-automation-shadow-worker');
const {
  runEmailLunaAutomationShadowRuntimePreflight,
} = require('./lib/email-luna-automation-shadow-runtime-preflight');
const {
  SQL_CLAIM,
  SQL_CLAIM_SCOPED,
  EMAIL_LUNA_AUTOMATION_QUEUE_GRANT_CONTRACT,
} = require('./lib/email-luna-automation-queue-store');

const ROOT = path.join(__dirname, '..');
const RED = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'fixtures/email-luna-automation-shadow-activation-safety-red.json'),
  'utf8',
));
const STAFF_API_SRC = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const SQL_095 = fs.readFileSync(path.join(ROOT, 'database/migrations/095_tenant_email_luna_automation_claim_scoped.sql'), 'utf8');
const SQL_095_DOWN = fs.readFileSync(path.join(ROOT, 'database/migrations/095_tenant_email_luna_automation_claim_scoped_down.sql'), 'utf8');
const SQL_088 = fs.readFileSync(path.join(ROOT, 'database/migrations/088_tenant_email_luna_automation_principal_grants.sql'), 'utf8');

const C = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const E = '44444444-4444-4444-8444-444444444444';
const E2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

console.log('FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B6 activation-safety verifier');

assert.equal(RED.id, 'email-luna-automation-shadow-activation-safety.ch4b6-red.v1');
assert.equal(RED.head_reviewed, '5054b86647a2aaf28d65a5e180345a6526cde067');
assert.equal(RED.pr_reviewed, 704);
assert.equal(RED.runtime_activation, false);
assert.equal(RED.activation_authorized, false);
assert.equal(RED.findings.length, 6);
assert.ok(RED.findings.every((item) => item.red && item.green));
assert.equal(MIGRATION_095_ID, '095_tenant_email_luna_automation_claim_scoped');
assert.equal(ENV_WORKER_DATABASE_URL, 'EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL');
assert.equal(ENV_REPLICA_COUNT, 'EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_REPLICA_COUNT');
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_STOP_DRAIN_TIMEOUT_MS, 5000);
console.log('  PASS  authentic RED artifact records PR #704 H1 and M1-M5');

assert.match(SQL_095, /tenant_email_luna_automation_claim_scoped/);
assert.match(SQL_095, /FOR UPDATE SKIP LOCKED/);
assert.match(SQL_095, /session_user IS DISTINCT FROM/);
assert.match(SQL_095, /REVOKE ALL ON FUNCTION/);
assert.equal(/^\s*GRANT /m.test(SQL_095), false);
assert.equal(/^\s*CREATE ROLE/m.test(SQL_095), false);
assert.match(SQL_095, /Does not rewrite 088/);
assert.match(SQL_088, /CREATE OR REPLACE FUNCTION public\.tenant_email_luna_automation_claim\(p_owner uuid, p_operation uuid\)/);
assert.match(SQL_CLAIM, /tenant_email_luna_automation_claim\(/);
assert.match(SQL_CLAIM_SCOPED, /tenant_email_luna_automation_claim_scoped\(/);
assert.notEqual(SQL_CLAIM, SQL_CLAIM_SCOPED);
assert.match(SQL_095_DOWN, /095_down_refused/);
assert.match(SQL_095_DOWN, /DROP FUNCTION IF EXISTS public\.tenant_email_luna_automation_claim_scoped/);
assert.equal(EMAIL_LUNA_AUTOMATION_QUEUE_GRANT_CONTRACT.no_grant_in_095, true);
console.log('  PASS  095 adds scoped claim; 088 unscoped claim is unchanged; no GRANT/CREATE ROLE');

assert.match(STAFF_API_SRC, /createEmailLunaAutomationShadowWorkerConnection/);
assert.match(STAFF_API_SRC, /drainStaffApiEmailRuntimes/);
assert.match(STAFF_API_SRC, /await drainStaffApiEmailRuntimes\(\)/);
assert.doesNotMatch(STAFF_API_SRC, /withTransactionClient:\s*\(work\)\s*=>\s*_withPgClientImpl/);
assert.match(STAFF_API_SRC, /EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_CONNECTION\.withTransactionClient/);
console.log('  PASS  Staff API uses dedicated worker connection and drains on start failure');

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

const missing = resolveEmailLunaAutomationShadowWorkerConnectionConfig({ env: {} });
assert.equal(missing.ok, false);
assert.equal(missing.reason, 'worker_connection_required');
const sameOwner = resolveEmailLunaAutomationShadowWorkerConnectionConfig({
  env: enabledEnv({
    EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: 'postgres://wolfhouse:owner-secret@127.0.0.1:5432/sunset',
  }),
});
assert.equal(sameOwner.ok, false);
assert.equal(sameOwner.reason, 'worker_connection_is_app_owner');
assert.equal(JSON.stringify(sameOwner).includes('owner-secret'), false);
const dedicated = resolveEmailLunaAutomationShadowWorkerConnectionConfig({ env: enabledEnv() });
assert.equal(dedicated.ok, true);
assert.equal(dedicated.distinct_from_app, true);
assert.equal(JSON.stringify(dedicated).includes('worker-secret'), false);
console.log('  PASS  dedicated worker DSN required and distinct; credentials never returned');

const replica = resolveEmailLunaAutomationShadowSunsetStagingRuntimeReadiness(enabledEnv({
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_REPLICA_COUNT: '2',
}));
assert.equal(replica.runtime_activation, false);
assert.equal(replica.reason, 'replica_topology_unproven');
const ready = resolveEmailLunaAutomationShadowSunsetStagingRuntimeReadiness(enabledEnv());
assert.equal(ready.runtime_activation, true);
const rebound = resolveEmailLunaAutomationShadowSunsetStagingRuntimeReadiness(enabledEnv({
  EMAIL_LUNA_AUTOMATION_SHADOW_ENDPOINT_ID: E2,
}));
assert.equal(rebound.runtime_activation, true);
assert.notEqual(E2, E);
console.log('  PASS  replica topology fail-closed; valid UUID rebound is a distinct bind');

async function main() {
  const noQuery = await runEmailLunaAutomationShadowRuntimePreflight({ env: enabledEnv() });
  assert.equal(noQuery.ok, false);
  assert.equal(noQuery.inspect_required, true);
  assert.ok(noQuery.blockers.includes('inspect_required'));
  const inspectFail = await runEmailLunaAutomationShadowRuntimePreflight({
    env: enabledEnv(),
    unit_test_inspect: true,
    async query() {
      const error = new Error('password=do-not-leak uuid=99999999-9999-4999-8999-999999999999');
      error.code = '42501';
      throw error;
    },
  });
  assert.equal(inspectFail.ok, false);
  assert.ok(inspectFail.blockers.includes('schema_inspect_failed'));
  const dump = JSON.stringify(inspectFail);
  assert.equal(dump.includes('do-not-leak'), false);
  assert.equal(dump.includes('42501'), false);
  console.log('  PASS  M3/M4 preflight inspect_required and generic schema_inspect_failed');
  console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B6 activation-safety');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

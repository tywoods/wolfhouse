'use strict';
/** FULL SAIL Stage 1 NIGHTWATCH Chapter 4 Slice B5: read-only shadow comparison preflight. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  runEmailLunaAutomationShadowRuntimePreflight,
  ERROR_CODE,
} = require('./lib/email-luna-automation-shadow-runtime-preflight');
const {
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_WIRED,
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ACTIVATION,
} = require('./lib/email-luna-automation-shadow-sunset-staging-runtime-composition');
const {
  EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH,
} = require('./lib/email-luna-automation-shadow-outcome-store');

const ROOT = path.join(__dirname, '..');
const C = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const E = '44444444-4444-4444-8444-444444444444';

console.log('FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B5 shadow runtime preflight verifier');

assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_WIRED, true);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ACTIVATION, false);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.unique_human_would_send, 'staff_action_observed');
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.unsafe_labels.includes('agreement'), true);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.unsafe_labels.includes('staff sent Luna\'s mail'), true);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.unsafe_labels.includes('same draft'), true);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.unsafe_labels.includes('content agreement'), true);

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

function expectInvalid(fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      throw new Error('expected preflight invalid');
    }, (error) => {
      assert.equal(error && error.code, ERROR_CODE);
    });
}

async function main() {
  const absent = await runEmailLunaAutomationShadowRuntimePreflight({ env: {} });
  assert.equal(absent.activation_started, false);
  assert.equal(absent.runtime_started, false);
  assert.equal(absent.migration_applied, false);
  assert.equal(absent.roles_provisioned, false);
  assert.equal(absent.would_activate, false);
  assert.equal(absent.provider_capability, false);
  assert.equal(absent.journal_handoff, false);
  assert.equal(absent.send_allowed, false);
  assert.equal(absent.comparison_state_label, 'staff_action_observed');
  assert.equal(absent.comparison_kind, 'inbound_workflow_identity');
  assert.equal(absent.proves_provider_sent, false);
  assert.equal(absent.proves_same_luna_draft, false);
  assert.equal(absent.proves_content_agreement, false);
  assert.equal(absent.migration_files_ready, true);
  assert.equal(absent.files_ready, true);
  assert.equal(absent.principal_contract_ready, true);
  assert.equal(absent.schema_applied, 'unknown');
  assert.equal(absent.ok, false);
  assert.equal(absent.inspect_required, true);
  assert.ok(absent.blockers.includes('inspect_required'));
  assert.equal(absent.readiness_reason, 'default_off');
  console.log('  PASS  default-off preflight is read-only, files ready, identity labels safe, does not start');

  const readyFlags = await runEmailLunaAutomationShadowRuntimePreflight({ env: enabledEnv() });
  assert.equal(readyFlags.would_activate, true);
  assert.equal(readyFlags.runtime_started, false);
  assert.equal(readyFlags.activation_started, false);
  assert.equal(readyFlags.flags.EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ENABLED, true);
  assert.equal(readyFlags.flags.EMAIL_LUNA_AUTOMATION_SHADOW_ENABLED, true);
  assert.equal(readyFlags.flags.EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_ENABLED, true);
  assert.equal(readyFlags.binding.endpoint_id, E);
  assert.equal(readyFlags.binding.location_key, 'sunset-somo');
  assert.equal(readyFlags.binding.tenant, 'sunset');
  console.log('  PASS  exact flags + tenant/location/endpoint reported without starting runtime');

  const partial = await runEmailLunaAutomationShadowRuntimePreflight({
    env: { LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_ENABLED: 'true' },
  });
  assert.equal(partial.would_activate, false);
  assert.equal(partial.runtime_started, false);
  console.log('  PASS  partial flags cannot activate');

  await expectInvalid(() => runEmailLunaAutomationShadowRuntimePreflight({
    env: {},
    apply: true,
  }));
  await expectInvalid(() => runEmailLunaAutomationShadowRuntimePreflight({
    env: {},
    provision: true,
  }));
  await expectInvalid(() => runEmailLunaAutomationShadowRuntimePreflight({
    env: {},
    start: true,
  }));
  await expectInvalid(() => runEmailLunaAutomationShadowRuntimePreflight({
    env: {},
    send: true,
  }));
  await expectInvalid(() => runEmailLunaAutomationShadowRuntimePreflight({
    env: {},
    provider: () => {},
  }));
  console.log('  PASS  preflight refuses apply/provision/start/send/provider');

  const notReady = await runEmailLunaAutomationShadowRuntimePreflight({
    env: enabledEnv(),
    unit_test_inspect: true,
    async query() {
      return {
        rows: [inspectRow({
          outcomes_table: false,
          principal_fn: false,
          scoped_claim_fn: false,
          project_def: null,
          scoped_claim_def: null,
          worker_mapping_ok: false,
          scoped_claim_execute: false,
        })],
      };
    },
  });
  assert.equal(notReady.ok, false);
  assert.equal(notReady.schema_applied, false);
  assert.equal(notReady.principal_applied, false);
  assert.equal(notReady.identity_label_applied, false);
  assert.equal(notReady.runtime_started, false);
  assert.ok(notReady.blockers.includes('migration_not_applied'));
  assert.ok(notReady.blockers.includes('principal_not_applied'));
  assert.ok(notReady.blockers.includes('identity_label_not_applied'));
  console.log('  PASS  migration/principal not ready is reported and does not start');

  const unsafe = await runEmailLunaAutomationShadowRuntimePreflight({
    env: enabledEnv(),
    unit_test_inspect: true,
    async query() {
      return {
        rows: [inspectRow({
          project_def: "matched := 'agreement'",
        })],
      };
    },
  });
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.identity_label_applied, false);
  assert.ok(unsafe.blockers.includes('identity_label_not_applied'));
  console.log('  PASS  unsafe agreement wording is a preflight blocker');

  const readySchema = await runEmailLunaAutomationShadowRuntimePreflight({
    env: enabledEnv(),
    unit_test_inspect: true,
    async query() {
      return {
        rows: [inspectRow()],
      };
    },
  });
  assert.equal(readySchema.ok, true);
  assert.equal(readySchema.would_activate, true);
  assert.equal(readySchema.runtime_started, false);
  assert.equal(readySchema.schema_applied, true);
  assert.equal(readySchema.identity_label_applied, true);
  assert.equal(readySchema.principal_applied, true);
  assert.equal(readySchema.scoped_claim_applied, true);
  assert.equal(readySchema.worker_principal_ok, true);
  assert.equal(readySchema.inspect_required, false);
  assert.equal(readySchema.inspect_authenticity, 'unit_test_inspect');
  assert.deepEqual(readySchema.blockers.slice(), []);
  console.log('  PASS  ready schema + identity label still does not start, apply, or provision');

  const leakSecret = 'super-secret-password-do-not-leak';
  const leakUuid = '99999999-9999-4999-8999-999999999999';
  const leaked = await runEmailLunaAutomationShadowRuntimePreflight({
    env: enabledEnv(),
    unit_test_inspect: true,
    async query() {
      const error = new Error(`password=${leakSecret} uuid=${leakUuid} code=42501`);
      error.code = '42501';
      throw error;
    },
  });
  assert.equal(leaked.ok, false);
  assert.ok(leaked.blockers.includes('schema_inspect_failed'));
  assert.equal(leaked.blockers.includes('migration_not_applied'), false);
  const leakedDump = JSON.stringify(leaked);
  assert.equal(leakedDump.includes(leakSecret), false);
  assert.equal(leakedDump.includes(leakUuid), false);
  assert.equal(leakedDump.includes('42501'), false);
  assert.equal(leakedDump.includes('password='), false);
  console.log('  PASS  M3 query throw is generic schema_inspect_failed and does not leak secrets/UUIDs/SQLSTATE');

  const ownerSession = await runEmailLunaAutomationShadowRuntimePreflight({
    env: enabledEnv(),
    unit_test_inspect: true,
    async query() {
      return {
        rows: [inspectRow({
          session_user: 'wolfhouse',
          current_user: 'wolfhouse',
          table_owner: 'wolfhouse',
          worker_mapping_ok: false,
        })],
      };
    },
  });
  assert.equal(ownerSession.ok, false);
  assert.ok(ownerSession.blockers.includes('worker_principal_unproven'));
  console.log('  PASS  table-owner session_user is a preflight blocker');

  const replica = await runEmailLunaAutomationShadowRuntimePreflight({
    env: enabledEnv({ EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_REPLICA_COUNT: '2' }),
    unit_test_inspect: true,
    async query() {
      return {
        rows: [inspectRow()],
      };
    },
  });
  assert.equal(replica.ok, false);
  assert.ok(replica.blockers.includes('replica_topology_unproven'));
  console.log('  PASS  M5 replica count other than exact 1 is fail-closed');

  const sql094 = fs.readFileSync(path.join(ROOT, 'database/migrations/094_tenant_email_luna_automation_shadow_outcome_identity_match.sql'), 'utf8');
  assert.match(sql094, /inbound-workflow identity only/);
  assert.doesNotMatch(sql094, /staff sent Luna's mail/);
  console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B5 shadow runtime preflight');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

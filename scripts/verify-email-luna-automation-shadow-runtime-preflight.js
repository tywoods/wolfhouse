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
  assert.equal(absent.principal_contract_ready, true);
  assert.equal(absent.schema_applied, 'unknown');
  assert.equal(absent.ok, true);
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
    async query() {
      return {
        rows: [{
          outcomes_table: false,
          principal_fn: false,
          project_def: null,
        }],
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
    async query() {
      return {
        rows: [{
          outcomes_table: true,
          principal_fn: true,
          project_def: "matched := 'agreement'",
        }],
      };
    },
  });
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.identity_label_applied, false);
  assert.ok(unsafe.blockers.includes('identity_label_not_applied'));
  console.log('  PASS  unsafe agreement wording is a preflight blocker');

  const readySchema = await runEmailLunaAutomationShadowRuntimePreflight({
    env: enabledEnv(),
    async query() {
      return {
        rows: [{
          outcomes_table: true,
          principal_fn: true,
          project_def: "matched := 'staff_action_observed'",
        }],
      };
    },
  });
  assert.equal(readySchema.ok, true);
  assert.equal(readySchema.would_activate, true);
  assert.equal(readySchema.runtime_started, false);
  assert.equal(readySchema.schema_applied, true);
  assert.equal(readySchema.identity_label_applied, true);
  assert.equal(readySchema.principal_applied, true);
  assert.deepEqual(readySchema.blockers.slice(), []);
  console.log('  PASS  ready schema + identity label still does not start, apply, or provision');

  const sql094 = fs.readFileSync(path.join(ROOT, 'database/migrations/094_tenant_email_luna_automation_shadow_outcome_identity_match.sql'), 'utf8');
  assert.match(sql094, /inbound-workflow identity only/);
  assert.doesNotMatch(sql094, /staff sent Luna's mail/);
  console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B5 shadow runtime preflight');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

'use strict';
/** FULL SAIL Stage 1 NIGHTWATCH Chapter 4 Slice B4: durable shadow comparison outcome. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createEmailLunaAutomationShadowOutcomeStore,
  assertEmailLunaAutomationShadowOutcome,
  assertEmailLunaAutomationShadowComparisonProjection,
  EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_RUNTIME_WIRED,
  EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_LOGGING_FORBIDDEN,
  EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_GRANT_CONTRACT,
  EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_RECORD_KEYS,
  EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_STATES,
  EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH,
  STAFF_PROJECTION_KEYS,
  SHADOW_MODE,
} = require('./lib/email-luna-automation-shadow-outcome-store');
const {
  EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT,
  FUNCTION_SIGNATURES,
  executeFunctionsFor,
} = require('./lib/email-luna-automation-principal-contract');
const {
  EMAIL_LUNA_AUTOMATION_QUEUE_STATES,
  EMAIL_LUNA_AUTOMATION_QUEUE_RUNTIME_WIRED,
} = require('./lib/email-luna-automation-queue-store');
const {
  EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_RUNTIME_WIRED,
} = require('./lib/email-luna-automation-journal-handoff-store');
const {
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_RUNTIME_WIRED,
} = require('./lib/email-luna-automation-shadow-worker');
const {
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_WIRED,
} = require('./lib/email-luna-automation-shadow-orchestration');

const ROOT = path.join(__dirname, '..');
const SQL_093 = fs.readFileSync(path.join(ROOT, 'database/migrations/093_tenant_email_luna_automation_shadow_outcomes.sql'), 'utf8');
const DOWN_093 = fs.readFileSync(path.join(ROOT, 'database/migrations/093_tenant_email_luna_automation_shadow_outcomes_down.sql'), 'utf8');
const SQL_085 = fs.readFileSync(path.join(ROOT, 'database/migrations/085_tenant_email_luna_policy_audit.sql'), 'utf8');
const SQL_086 = fs.readFileSync(path.join(ROOT, 'database/migrations/086_tenant_email_luna_automation_queue.sql'), 'utf8');
const SQL_070 = fs.readFileSync(path.join(ROOT, 'database/migrations/070_tenant_email_reply_approvals.sql'), 'utf8');
const STORE_SRC = fs.readFileSync(require.resolve('./lib/email-luna-automation-shadow-outcome-store'), 'utf8');
const WORKER_SRC = fs.readFileSync(require.resolve('./lib/email-luna-automation-shadow-worker'), 'utf8');
const RED = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/email-luna-automation-shadow-comparison-red.json'), 'utf8'));
const RUNTIME_SRC = fs.readFileSync(require.resolve('./lib/email-luna-sunset-staging-runtime-composition'), 'utf8');
const STAFF_API_SRC = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const COMPOSE_SRC = fs.readFileSync(path.join(ROOT, 'docker/hermes-staging/docker-compose.vm.yml'), 'utf8');

const OP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ISS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OWNER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DIGEST = 'a'.repeat(64);

console.log('FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B4 shadow comparison verifier');

assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_LOGGING_FORBIDDEN, true);
assert.equal(EMAIL_LUNA_AUTOMATION_QUEUE_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.no_grant_in_093, true);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.no_create_role_in_093, true);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_GRANT_CONTRACT.no_grant_in_093, true);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_GRANT_CONTRACT.worker_shadow_outcome_select, false);
assert.deepEqual(EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_GRANT_CONTRACT.worker_table_privileges.slice(), []);
assert.deepEqual(
  EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_GRANT_CONTRACT.worker_execute_functions.slice().sort(),
  [
    'tenant_email_luna_automation_capture_shadow',
    'tenant_email_luna_automation_shadow_outcome_load',
    'tenant_email_luna_automation_shadow_outcome_project',
  ].sort(),
);
assert.equal(
  executeFunctionsFor('worker').includes(FUNCTION_SIGNATURES.tenant_email_luna_automation_capture_shadow),
  false,
  '088 worker grant list stays 088-only; 093 capture is optional-when-present',
);
assert.equal(executeFunctionsFor('producer').includes(FUNCTION_SIGNATURES.tenant_email_luna_automation_capture_shadow), false);
assert.ok(EMAIL_LUNA_AUTOMATION_QUEUE_STATES.includes('shadow_captured'));
assert.deepEqual(EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_STATES.slice(), [
  'pending_human', 'staff_action_observed', 'disagreement', 'excluded', 'invalid',
]);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.unique_human_would_send, 'staff_action_observed');
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.unique_human_kind, 'inbound_workflow_identity');
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.proves_provider_sent, false);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.proves_same_luna_draft, false);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.proves_content_agreement, false);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_GRANT_CONTRACT.no_grant_in_094, true);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_GRANT_CONTRACT.no_grant_in_095, true);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.human_owner, 'tenant_email_reply_approvals');
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.infer_from_absence, false);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.model_based, false);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.disagreement_grounded, false);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.luna_outbound_approvals, 'not_an_owner');
assert.deepEqual(EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.human_would_not_send_states.slice(), []);
assert.equal(SHADOW_MODE, 'shadow');

assert.equal(RED.id, 'email-luna-automation-shadow-comparison.ch4b4-red.v1');
assert.equal(RED.slice, 'FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B4');
assert.equal(RED.head_reviewed, '9c1fdba39fd7bcd640c78d9b2f8a68ef300f7713');
assert.equal(RED.provider_transition, false);
assert.equal(RED.runtime_activation, false);
assert.equal(RED.human_comparison_bound, false);
assert.equal(RED.findings.length, 4);
assert.ok(RED.findings.every((item) => item.severity === 'blocking' && item.red && item.green));
console.log('  PASS  authentic RED artifact records 9c1fdba3 missing durable comparison evidence');

assert.equal(/^\s*CREATE ROLE/m.test(SQL_093), false);
assert.equal(/^\s*GRANT /m.test(SQL_093), false);
assert.equal(/current_setting\s*\(/.test(SQL_093), false);
assert.equal(/PASSWORD\s+'/i.test(SQL_093), false);
assert.match(SQL_093, /CREATE TABLE IF NOT EXISTS public\.tenant_email_luna_automation_shadow_outcomes/);
assert.match(SQL_093, /tenant_email_luna_automation_capture_shadow/);
assert.match(SQL_093, /tenant_email_luna_automation_shadow_outcome_load/);
assert.match(SQL_093, /tenant_email_luna_automation_shadow_outcome_project/);
assert.match(SQL_093, /SET search_path TO pg_catalog, public/);
assert.match(SQL_093, /SECURITY DEFINER/);
assert.match(SQL_093, /principal_authorized/);
assert.match(SQL_093, /shadow_captured/);
assert.match(SQL_093, /pending_human/);
assert.match(SQL_093, /luna_decision = 'would_send'/);
assert.match(SQL_093, /append-only mutation refused/);
assert.match(SQL_093, /093: queue table owner missing/);
assert.match(SQL_093, /ON DELETE RESTRICT/);
assert.match(SQL_093, /p_operation uuid/);
assert.equal(/p_luna_decision/.test(SQL_093), false);
assert.equal(/p_comparison_state/.test(SQL_093), false);
assert.equal(/p_would_send/.test(SQL_093), false);
assert.equal(/handoff_established/.test(SQL_093), false);
assert.equal(/CREATE OR REPLACE FUNCTION public\.tenant_email_luna_automation_handoff/.test(SQL_093), false);
assert.equal(/nodemailer|microsoft-graph|smtp/i.test(SQL_093), false);
assert.match(DOWN_093, /093_down_refused/);
assert.match(DOWN_093, /DROP TABLE IF EXISTS public\.tenant_email_luna_automation_shadow_outcomes/);
assert.match(DOWN_093, /CHECK \(state IN \('pending', 'claimed', 'handed_off', 'handoff_required', 'cancelled'\)\)/);
assert.equal(/would_send/.test(SQL_085), false);
assert.equal(/shadow_captured/.test(SQL_086), false);
assert.match(SQL_070, /source_inbound_event_id/);
assert.match(SQL_070, /state IN \('draft', 'approved', 'terminal'\)/);
assert.equal(/rejected/.test(SQL_070), false);
console.log('  PASS  093 schema is append-only, send-inert, no product GRANT, 085/086 unrewritten');

assert.match(STORE_SRC, /AUTHENTIC_SHADOW_OUTCOMES/);
assert.match(STORE_SRC, /AUTHENTIC_STAFF_PROJECTIONS/);
assert.match(WORKER_SRC, /captureShadowOutcome/);
assert.match(WORKER_SRC, /shadow_captured/);
assert.equal(/console\.log/.test(STORE_SRC), false);
assert.doesNotMatch(STORE_SRC, /email-outbound|microsoft-graph|nodemailer|smtp|dispatchApprovedOutbound|staff-query-api/);
assert.doesNotMatch(RUNTIME_SRC, /email-luna-automation-shadow-outcome|EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON/);
assert.doesNotMatch(STAFF_API_SRC, /email-luna-automation-shadow-outcome|captureShadowOutcome/);
assert.doesNotMatch(COMPOSE_SRC, /email-luna-automation-shadow-outcome|captureShadowOutcome/);
const exports_ = require('./lib/email-luna-automation-shadow-outcome-store');
assert.equal('send' in exports_, false);
assert.equal('start' in exports_, false);
assert.equal('handoff' in exports_, false);
console.log('  PASS  owner is import-inert, send-inert, unwired from runtime/staff-query-api/docker');

function capturedSource(patch = {}) {
  return Object.assign(Object.create(null), {
    persist_status: 'committed',
    operation_id: OP,
    issuance_id: ISS,
    audit_operation_id: OP,
    claim_lease_owner: OWNER,
    client_id: '11111111-1111-4111-8111-111111111111',
    location_id: '22222222-2222-4222-8222-222222222222',
    location_key: 'sunset-somo',
    endpoint_id: '44444444-4444-4444-8444-444444444444',
    conversation_id: '33333333-3333-4333-8333-333333333333',
    inbound_event_id: '55555555-5555-4555-8555-555555555555',
    recipient_digest: DIGEST,
    policy_version: 'email-luna-draft-policy.v1',
    eligibility_policy_version: 'email-luna-autonomous-eligibility-policy.v1',
    validator_version: 'email-luna-draft-validator.v1',
    luna_decision: 'would_send',
    comparison_state: 'pending_human',
    queue_state: 'shadow_captured',
    attempt_count: 1,
    ...patch,
  });
}

async function main() {
  const queries = [];
  const store = createEmailLunaAutomationShadowOutcomeStore({
    async withTransactionClient(work) {
      return work({
        async query(text, params) {
          queries.push({ text: String(text), params });
          if (/capture_shadow/.test(String(text))) {
            assert.equal(params.length, 2);
            assert.equal(params[0], OP);
            assert.equal(params[1], OWNER);
            return { rows: [capturedSource()] };
          }
          if (/shadow_outcome_load/.test(String(text))) {
            return { rows: [capturedSource()] };
          }
          if (/shadow_outcome_project/.test(String(text))) {
            return {
              rows: [Object.assign(Object.create(null), {
                luna_decision: 'would_send',
                comparison_state: 'pending_human',
                policy_version: 'email-luna-draft-policy.v1',
                eligibility_policy_version: 'email-luna-autonomous-eligibility-policy.v1',
                validator_version: 'email-luna-draft-validator.v1',
                queue_state: 'shadow_captured',
                human_bound: false,
                duplicate_human: false,
              })],
            };
          }
          return { rows: [] };
        },
      });
    },
  });

  function assertInvalid(fn) {
    let threw = false;
    try { fn(); } catch (error) {
      threw = true;
      assert.equal(error && error.code, 'EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_INVALID');
    }
    assert.equal(threw, true);
  }
  assertInvalid(() => store.captureShadowOutcome({
    operation_id: OP,
    owner_token: OWNER,
    luna_decision: 'would_send',
  }));
  assertInvalid(() => store.captureShadowOutcome({
    operation_id: OP,
    owner_token: OWNER,
    comparison_state: 'agreement',
  }));
  assertInvalid(() => store.projectStaffSafeShadowComparison({
    operation_id: OP,
    issuance_id: ISS,
    human_outcome: 'would_send',
  }));
  console.log('  PASS  caller cannot select would_send, comparison, or human outcome');

  const captured = await store.captureShadowOutcome({ operation_id: OP, owner_token: OWNER });
  assert.equal(captured.status, 'committed');
  assertEmailLunaAutomationShadowOutcome(captured.record);
  assert.equal(captured.record.luna_decision, 'would_send');
  assert.equal(captured.record.comparison_state, 'pending_human');
  assert.equal(captured.record.queue_state, 'shadow_captured');
  assert.equal('recipient_address' in captured.record, false);
  assert.equal('subject' in captured.record, false);
  assert.equal('human_action_id' in captured.record, false);
  const copied = JSON.parse(JSON.stringify(captured.record));
  assert.throws(() => assertEmailLunaAutomationShadowOutcome(copied));
  console.log('  PASS  capture returns authentic pending_human outcome; JSON copy is not authority');

  const projected = await store.projectStaffSafeShadowComparison({ operation_id: OP, issuance_id: ISS });
  assert.equal(projected.status, 'projected');
  assertEmailLunaAutomationShadowComparisonProjection(projected.record);
  assert.deepEqual(Object.keys(projected.record), STAFF_PROJECTION_KEYS.slice());
  assert.equal(projected.record.comparison_state, 'pending_human');
  assert.equal(projected.record.send_allowed, false);
  assert.equal('operation_id' in projected.record, false);
  assert.equal('recipient_digest' in projected.record, false);
  assert.throws(() => assertEmailLunaAutomationShadowComparisonProjection(JSON.parse(JSON.stringify(projected.record))));
  console.log('  PASS  staff-safe projection hides raw IDs/secrets and is not copyable authority');

  const forgedStore = createEmailLunaAutomationShadowOutcomeStore({
    async withTransactionClient(work) {
      return work({
        async query() {
          return { rows: [capturedSource({ luna_decision: 'would_not_send', comparison_state: 'agreement' })] };
        },
      });
    },
  });
  await assert.rejects(
    () => forgedStore.captureShadowOutcome({ operation_id: OP, owner_token: OWNER }),
    (error) => error && error.code === 'EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_INVALID',
  );
  console.log('  PASS  forged caller-selected decision/comparison rows fail closed');

  assert.ok(EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_RECORD_KEYS.includes('recipient_digest'));
  assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_RECORD_KEYS.includes('recipient_address'), false);
  console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B4 shadow comparison');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

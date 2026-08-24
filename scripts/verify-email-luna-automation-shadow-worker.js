'use strict';
/** FULL SAIL Stage 1 NIGHTWATCH Chapter 4 Slice B3: provider-inert shadow worker kernel. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  createEmailLunaDraftEnvelope,
} = require('./lib/email-luna-draft-handoff-contract');
const {
  issueAndDecideEmailLunaDraftPolicy,
  readEmailLunaDraftPolicyIssuanceIdentity,
  EMAIL_LUNA_DRAFT_POLICY_VERSION,
} = require('./lib/email-luna-draft-policy');
const {
  EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_POLICY_VERSION,
} = require('./lib/email-luna-autonomous-eligibility-policy');
const {
  createEmailLunaDraftAuthor,
  readEmailLunaDraftAuthorPlan,
} = require('./lib/email-luna-draft-author');
const {
  validateEmailLunaDraft,
  EMAIL_LUNA_DRAFT_VALIDATOR_VERSION,
} = require('./lib/email-luna-draft-validator');
const {
  createEmailLunaAutomationShadowWorkerKernel,
  createEmailLunaAutomationShadowWorkerLoop,
  isEmailLunaAutomationShadowWorkerEnabled,
  assertEmailLunaAutomationShadowWorkerEvidence,
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_RUNTIME_WIRED,
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_LOGGING_FORBIDDEN,
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_CONCURRENCY,
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_MIN_INTERVAL_MS,
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_MAX_INTERVAL_MS,
  ENV_SHADOW_WORKER_ENABLED,
  SUNSET_DEPLOYMENT,
  SUNSET_LOCATION_KEY,
  SHADOW_MODE,
} = require('./lib/email-luna-automation-shadow-worker');
const {
  EMAIL_LUNA_AUTOMATION_QUEUE_RUNTIME_WIRED,
  EMAIL_LUNA_AUTOMATION_QUEUE_RECORD_KEYS,
} = require('./lib/email-luna-automation-queue-store');
const {
  EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_RUNTIME_WIRED,
} = require('./lib/email-luna-automation-journal-handoff-store');
const {
  EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_RUNTIME_WIRED,
} = require('./lib/email-luna-automation-issuance-material-store');
const {
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_WIRED,
} = require('./lib/email-luna-automation-shadow-orchestration');

const ROOT = path.join(__dirname, '..');
const RED = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'fixtures/email-luna-automation-shadow-worker-red.json'),
  'utf8',
));
const WORKER_SRC = fs.readFileSync(require.resolve('./lib/email-luna-automation-shadow-worker'), 'utf8');
const RUNTIME_SRC = fs.readFileSync(require.resolve('./lib/email-luna-sunset-staging-runtime-composition'), 'utf8');
const STAFF_API_SRC = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const COMPOSE_SRC = fs.readFileSync(path.join(ROOT, 'docker/hermes-staging/docker-compose.vm.yml'), 'utf8');
const DOCKERFILE_SRC = fs.readFileSync(path.join(ROOT, 'docker/hermes-staging/Dockerfile'), 'utf8');

const C = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const OTHER = '66666666-6666-4666-8666-666666666666';
const CONV = '33333333-3333-4333-8333-333333333333';
const ENDPOINT = '44444444-4444-4444-8444-444444444444';
const INBOUND = '55555555-5555-4555-8555-555555555555';
const OP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AUDIT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OWNER_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OWNER_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

console.log('FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B3 shadow worker verifier');

assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_LOGGING_FORBIDDEN, true);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_CONCURRENCY, 1);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_MIN_INTERVAL_MS, 60000);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_MAX_INTERVAL_MS, 120000);
assert.equal(EMAIL_LUNA_AUTOMATION_QUEUE_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_WIRED, false);
assert.equal(ENV_SHADOW_WORKER_ENABLED, 'EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_ENABLED');
assert.equal(SUNSET_DEPLOYMENT, 'sunset-staging');
assert.equal(SUNSET_LOCATION_KEY, 'sunset-somo');
assert.equal(SHADOW_MODE, 'shadow');
assert.equal(RED.id, 'email-luna-automation-shadow-worker.ch4b3-red.v1');
assert.equal(RED.slice, 'FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B3');
assert.equal(RED.head_reviewed, 'd1b2d55985a4801fe2e3986c0a51cf672b96330c');
assert.equal(RED.provider_transition, false);
assert.equal(RED.runtime_activation, false);
assert.equal(RED.worker_loop, true);
assert.equal(RED.send_permission, false);
assert.equal(RED.journal_terminal, false);
assert.equal(RED.findings.length, 4);
assert.ok(RED.findings.every((item) => item.severity === 'blocking' && item.red && item.green));
console.log('  PASS  authentic RED artifact records d1b2d559 missing shadow worker kernel');

assert.doesNotMatch(WORKER_SRC, /email-outbound|microsoft-graph|nodemailer|smtp|dispatchApprovedOutbound|staff-query-api/);
assert.equal(/require\('\.\/email-luna-automation-journal-handoff-store'\)/.test(WORKER_SRC), false);
assert.equal(/handOffAutomationOperation/.test(WORKER_SRC), false);
assert.equal(/establishCanonicalJournalHandoff/.test(WORKER_SRC), false);
assert.equal(/persistAndEnqueueAutomationIssuance/.test(WORKER_SRC), false);
assert.equal(/orchestrateShadowDecision/.test(WORKER_SRC), false);
assert.equal(/authorize_dispatch:\s*true/.test(WORKER_SRC), false);
assert.equal(/send_allowed:\s*true/.test(WORKER_SRC), false);
assert.equal(/console\.log/.test(WORKER_SRC), false);
assert.match(WORKER_SRC, /claimScopedAutomationOperation/);
assert.match(WORKER_SRC, /loadAutomationIssuanceMaterial/);
assert.match(WORKER_SRC, /recoverAutomationIssuance/);
assert.match(WORKER_SRC, /requireHandoffAutomationOperation/);
assert.match(WORKER_SRC, /EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_ENABLED/);
assert.doesNotMatch(RUNTIME_SRC, /email-luna-automation-shadow-worker|EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_ENABLED/);
assert.doesNotMatch(STAFF_API_SRC, /email-luna-automation-shadow-worker'|EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_ENABLED/);
assert.match(STAFF_API_SRC, /email-luna-automation-shadow-worker-connection/);
assert.doesNotMatch(COMPOSE_SRC, /email-luna-automation-shadow-worker|EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_ENABLED/);
assert.doesNotMatch(DOCKERFILE_SRC, /email-luna-automation-shadow-worker|EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_ENABLED/);
const workerExports = require('./lib/email-luna-automation-shadow-worker');
assert.deepEqual(Object.keys(workerExports).sort(), [
  'EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_CONCURRENCY',
  'EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_LOGGING_FORBIDDEN',
  'EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_MAX_INTERVAL_MS',
  'EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_MIN_INTERVAL_MS',
  'EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_RUNTIME_WIRED',
  'EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_STOP_DRAIN_TIMEOUT_MS',
  'ENV_SHADOW_WORKER_ENABLED',
  'SHADOW_MODE',
  'SUNSET_DEPLOYMENT',
  'SUNSET_LOCATION_KEY',
  'assertEmailLunaAutomationShadowWorkerEvidence',
  'createEmailLunaAutomationShadowWorkerKernel',
  'createEmailLunaAutomationShadowWorkerLoop',
  'isEmailLunaAutomationShadowWorkerEnabled',
]);
assert.equal('send' in workerExports, false);
assert.equal('start' in workerExports, false);
assert.equal('handoff' in workerExports, false);
assert.equal(typeof workerExports.createEmailLunaAutomationShadowWorkerKernel, 'function');
assert.equal(typeof workerExports.createEmailLunaAutomationShadowWorkerLoop, 'function');
console.log('  PASS  owner is import-inert, send-inert, unwired from runtime/staff-query-api/docker');

function frozen(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozen));
  if (value && typeof value !== 'object') return value;
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) value[key] = frozen(value[key]);
    return Object.freeze(value);
  }
  return value;
}

function env(patch = {}) {
  return { LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_ENABLED: 'true', ...patch };
}
function gate(patch = {}) {
  return { client_id: C, location_id: L, location_key: 'sunset-somo', shadow_enabled: true, endpoint_id: ENDPOINT, ...patch };
}
function authority(patch = {}) {
  return { client_id: C, location_id: L, location_key: 'sunset-somo', ...patch };
}
function enabledInput(patch = {}) {
  return { env: env(), tenant_location_gate: gate(), authority: authority(), ...patch };
}

assert.equal(isEmailLunaAutomationShadowWorkerEnabled(enabledInput()), true);
for (const [label, input] of [
  ['default off', enabledInput({ env: { LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_ENABLED: 'false' } })],
  ['missing flag', enabledInput({ env: { LUNA_DEPLOYMENT: 'sunset-staging' } })],
  ['near-match flag', enabledInput({ env: env({ EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_ENABLED: 'TRUE' }) })],
  ['truthy one', enabledInput({ env: env({ EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_ENABLED: '1' }) })],
  ['wrong deployment', enabledInput({ env: env({ LUNA_DEPLOYMENT: 'sunset-production' }) })],
  ['draft runtime flag is not worker', enabledInput({ env: { LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true' } })],
  ['producer shadow flag is not worker', enabledInput({ env: { LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_LUNA_AUTOMATION_SHADOW_ENABLED: 'true' } })],
  ['gate off', enabledInput({ tenant_location_gate: gate({ shadow_enabled: false }) })],
  ['tenant mismatch', enabledInput({ tenant_location_gate: gate({ client_id: OTHER }) })],
  ['location mismatch', enabledInput({ tenant_location_gate: gate({ location_id: OTHER }) })],
  ['location-key mismatch', enabledInput({ tenant_location_gate: gate({ location_key: 'sunset-sardinero' }) })],
]) {
  assert.equal(isEmailLunaAutomationShadowWorkerEnabled(input), false, label);
}
console.log('  PASS  exact Sunset-staging worker flag + tenant/location gate; no truthy coerce; producer/draft flags are not substitutes');

function expectDisabled(fn) {
  assert.throws(fn, (error) => {
    assert.equal(error && error.code, 'EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DISABLED');
    return true;
  });
}
function expectInvalid(fn) {
  assert.throws(fn, (error) => {
    assert.equal(error && error.code, 'EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_INVALID');
    return true;
  });
}

const inertLoaner = { async withTransactionClient(work) { return work({ async query() { return { rows: [] }; } }); } };
expectDisabled(() => createEmailLunaAutomationShadowWorkerKernel({
  withTransactionClient: inertLoaner.withTransactionClient,
  env: { LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_ENABLED: 'false' },
  tenant_location_gate: gate(),
  owner_token: OWNER_A,
}));
expectDisabled(() => createEmailLunaAutomationShadowWorkerKernel({
  withTransactionClient: inertLoaner.withTransactionClient,
  env: env(),
  tenant_location_gate: gate({ shadow_enabled: false }),
  owner_token: OWNER_A,
}));
expectInvalid(() => createEmailLunaAutomationShadowWorkerKernel({
  withTransactionClient: inertLoaner.withTransactionClient,
  env: env(),
  tenant_location_gate: gate(),
  owner_token: OWNER_A,
  provider: () => {},
}));
expectInvalid(() => createEmailLunaAutomationShadowWorkerKernel({
  withTransactionClient: inertLoaner.withTransactionClient,
  env: env(),
  tenant_location_gate: gate(),
  owner_token: OWNER_A,
  callback: () => {},
}));
expectInvalid(() => createEmailLunaAutomationShadowWorkerKernel({
  withTransactionClient: inertLoaner.withTransactionClient,
  env: env(),
  tenant_location_gate: gate(),
  owner_token: OWNER_A,
  onSend: () => {},
}));
expectInvalid(() => createEmailLunaAutomationShadowWorkerKernel({
  withTransactionClient: inertLoaner.withTransactionClient,
  env: env(),
  tenant_location_gate: gate(),
  owner_token: OWNER_A,
  operation_id: OP,
}));
expectInvalid(() => createEmailLunaAutomationShadowWorkerLoop({
  kernel: { processNextShadowClaim() {}, requestStop() {}, resume() {} },
  timers: { setTimeout() {}, clearTimeout() {} },
  intervalMs: 60000,
  provider: () => {},
}));
expectInvalid(() => createEmailLunaAutomationShadowWorkerLoop({
  kernel: { processNextShadowClaim() {}, requestStop() {}, resume() {} },
  timers: { setTimeout() {}, clearTimeout() {} },
  intervalMs: 1000,
}));
console.log('  PASS  factory is default-off and refuses provider/callback/operation rebind/short interval');

function catalogEvidence(patch = {}) {
  return frozen({
    client_id: C,
    location_id: L,
    conversation_id: CONV,
    endpoint_id: ENDPOINT,
    language: 'en',
    identity: 'matched',
    intent: 'catalog_question',
    intent_support: 'supported',
    requested_location_id: L,
    explicit_human_request: false,
    attachment_interpretation_required: false,
    unsafe_transactional_request: false,
    required_facts: ['catalog'],
    grounded_results: {
      catalog: Object.assign(Object.create(null), {
        fact: 'catalog',
        status: 'found',
        client_id: C,
        location_id: L,
        item: 'board_rental',
        label: 'Surfboard rental',
        currency: 'EUR',
        amount_cents: 4500,
        active: true,
      }),
    },
    ...patch,
  });
}

function makeEnvelope() {
  return createEmailLunaDraftEnvelope({
    authority: {
      client_id: C,
      location_id: L,
      location_key: 'sunset-somo',
      conversation_id: CONV,
      endpoint_id: ENDPOINT,
      inbound_message_id: INBOUND,
    },
    untrusted_content: {
      subject: 'Lesson question',
      body_text: 'How much is a surf lesson?',
      quoted_history: '',
      from_display_name: 'Elena',
      from_address: 'elena@example.test',
    },
  });
}

async function readyBundle() {
  const envelope = makeEnvelope();
  const issued = issueAndDecideEmailLunaDraftPolicy({
    envelope,
    evidence: catalogEvidence(),
  });
  const author = createEmailLunaDraftAuthor({
    callModel: () => Promise.resolve(JSON.stringify({
      template_id: 'catalog_reply', tone: 'concise', question_key: 'none', acknowledgment_key: 'thanks',
    })),
  });
  const draft = await author.authorDraft({
    envelope, evidence: issued.evidence, decision: issued.decision,
  });
  const validation = validateEmailLunaDraft({
    envelope, evidence: issued.evidence, decision: issued.decision, draft,
  });
  assert.equal(validation.status, 'valid');
  return { envelope, evidence: issued.evidence, decision: issued.decision, draft, validation };
}

function digestOf(draft) {
  return crypto.createHash('sha256')
    .update(draft.subject).update('\0').update(draft.body).update('\0').update(draft.language)
    .digest('hex');
}

function claimedRow(issuanceId, digest, owner, attempt) {
  const row = Object.create(null);
  row.operation_id = OP;
  row.issuance_id = issuanceId;
  row.audit_operation_id = AUDIT;
  row.client_id = C;
  row.location_id = L;
  row.location_key = 'sunset-somo';
  row.endpoint_id = ENDPOINT;
  row.conversation_id = CONV;
  row.inbound_event_id = INBOUND;
  row.recipient_address = 'elena@example.test';
  row.policy_version = EMAIL_LUNA_DRAFT_POLICY_VERSION;
  row.eligibility_policy_version = EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_POLICY_VERSION;
  row.validator_version = EMAIL_LUNA_DRAFT_VALIDATOR_VERSION;
  row.draft_digest = digest;
  row.state = 'claimed';
  row.attempt_count = attempt;
  row.lease_owner = owner;
  row.handoff_id = null;
  return row;
}

function capturedRow(issuanceId, digest, owner, attempt) {
  const row = Object.create(null);
  row.persist_status = 'committed';
  row.operation_id = OP;
  row.issuance_id = issuanceId;
  row.audit_operation_id = AUDIT;
  row.claim_lease_owner = owner;
  row.client_id = C;
  row.location_id = L;
  row.location_key = 'sunset-somo';
  row.endpoint_id = ENDPOINT;
  row.conversation_id = CONV;
  row.inbound_event_id = INBOUND;
  row.recipient_digest = crypto.createHash('sha256').update('elena@example.test').digest('hex');
  row.policy_version = EMAIL_LUNA_DRAFT_POLICY_VERSION;
  row.eligibility_policy_version = EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_POLICY_VERSION;
  row.validator_version = EMAIL_LUNA_DRAFT_VALIDATOR_VERSION;
  row.luna_decision = 'would_send';
  row.comparison_state = 'pending_human';
  row.queue_state = 'shadow_captured';
  row.attempt_count = attempt;
  return row;
}

function loadRow(issuanceId, digest, plan) {
  const row = Object.create(null);
  row.operation_id = OP;
  row.issuance_id = issuanceId;
  row.audit_operation_id = AUDIT;
  row.client_id = C;
  row.location_id = L;
  row.location_key = 'sunset-somo';
  row.endpoint_id = ENDPOINT;
  row.conversation_id = CONV;
  row.inbound_event_id = INBOUND;
  row.recipient_address = 'elena@example.test';
  row.draft_digest = digest;
  row.language = 'en';
  row.identity = 'matched';
  row.intent = 'catalog_question';
  row.intent_support = 'supported';
  row.requested_location_id = L;
  row.explicit_human_request = false;
  row.attachment_interpretation_required = false;
  row.unsafe_transactional_request = false;
  row.required_facts = ['catalog'];
  row.grounded_facts = {
    catalog: Object.assign(Object.create(null), {
      fact: 'catalog',
      status: 'found',
      client_id: C,
      location_id: L,
      item: 'board_rental',
      label: 'Surfboard rental',
      currency: 'EUR',
      amount_cents: 4500,
      active: true,
    }),
  };
  row.template_id = plan.template_id;
  row.tone = plan.tone;
  row.question_key = plan.question_key;
  row.acknowledgment_key = plan.acknowledgment_key;
  row.queue_state = 'claimed';
  row.envelope_subject = 'Lesson question';
  row.envelope_body_text = 'How much is a surf lesson?';
  row.envelope_from_address = 'elena@example.test';
  row.envelope_from_display_name = 'Elena';
  return row;
}

function sqlStateError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createMockState(options) {
  return {
    queries: [],
    claimed: false,
    claimOwner: null,
    claimOwners: [],
    requireOwners: [],
    claimAttempts: 0,
    expired: options.expired === true,
    emptyAfterClaim: options.emptyAfterClaim === true,
    requireConflict: options.requireConflict === true,
    loadEmpty: options.loadEmpty === true,
    loadThrow: options.loadThrow === true,
    forgedLoad: options.forgedLoad === true,
    stopOnClaim: options.stopOnClaim === true,
    claimSqlState: options.claimSqlState || null,
    foreignClaim: options.foreignClaim === true,
    claimRowPatch: options.claimRowPatch || null,
    kernel: null,
    issuanceId: options.issuanceId,
    digest: options.digest,
    plan: options.plan,
    requireCount: 0,
    journal: 0,
    send: 0,
    captured: false,
  };
}

function mockClient(state) {
  return {
    async query(text, params) {
      const sql = String(text);
      state.queries.push(sql);
      if (/tenant_email_outbound_send_journal|handoff_established|authorize_dispatch|nodemailer|smtp/.test(sql)) {
        state.journal += 1;
        state.send += 1;
      }
      if (/tenant_email_luna_automation_claim_scoped/.test(sql) || /tenant_email_luna_automation_claim\(/.test(sql)) {
        if (state.stopOnClaim && state.kernel) state.kernel.requestStop();
        if (state.claimSqlState) {
          throw sqlStateError(state.claimSqlState, 'tenant_email_luna_automation_queue: illegal state transition');
        }
        if (state.captured) return { rows: [] };
        if (state.claimed && !state.expired) return { rows: [] };
        if (state.emptyAfterClaim && state.claimed) return { rows: [] };
        // Authentic 086: expired attempt-capped rows are not selected.
        if (state.claimed && state.expired && state.claimAttempts >= 3) return { rows: [] };
        // Authentic 086 protect: claimed→claimed requires new_owner <> lease_owner.
        if (state.claimed && state.expired && state.claimOwner === params[0]) {
          throw sqlStateError('23514', 'tenant_email_luna_automation_queue: illegal state transition');
        }
        if (/tenant_email_luna_automation_claim_scoped/.test(sql) && state.foreignClaim) {
          const foreign = claimedRow(state.issuanceId, state.digest, params[0], 1);
          foreign.client_id = OTHER;
          foreign.location_id = OTHER;
          foreign.endpoint_id = OTHER;
          state.claimed = true;
          state.claimOwner = params[0];
          state.claimOwners.push(params[0]);
          state.claimAttempts += 1;
          return { rows: [foreign] };
        }
        if (/tenant_email_luna_automation_claim_scoped/.test(sql) && Array.isArray(params) && params.length >= 5) {
          if (params[1] !== C || params[2] !== L || params[3] !== 'sunset-somo' || params[4] !== ENDPOINT) {
            return { rows: [] };
          }
        }
        state.claimed = true;
        state.claimOwner = params[0];
        state.claimOwners.push(params[0]);
        state.claimAttempts += 1;
        state.expired = false;
        const row = claimedRow(state.issuanceId, state.digest, params[0], state.claimAttempts);
        if (state.claimRowPatch) Object.assign(row, state.claimRowPatch);
        return { rows: [row] };
      }
      if (/tenant_email_luna_automation_terminalize_attempt_cap/.test(sql)) {
        if (state.claimAttempts >= 3 && state.expired && params[1] === state.claimOwner) {
          const row = claimedRow(state.issuanceId, state.digest, params[1], 3);
          row.state = 'handoff_required';
          row.lease_owner = null;
          return { rows: [row] };
        }
        return { rows: [] };
      }
      if (/tenant_email_luna_automation_issuance_material_load/.test(sql)) {
        if (state.loadThrow) {
          throw sqlStateError('08000', 'simulated infrastructure load failure');
        }
        if (state.loadEmpty) return { rows: [] };
        if (state.forgedLoad) {
          const forged = loadRow(state.issuanceId, state.digest, state.plan);
          forged.client_id = OTHER;
          return { rows: [forged] };
        }
        return { rows: [loadRow(state.issuanceId, state.digest, state.plan)] };
      }
      if (/tenant_email_luna_automation_require_handoff_claimed/.test(sql)) {
        state.requireCount += 1;
        state.requireOwners.push(params[1]);
        if (state.requireConflict || state.expired || params[1] !== state.claimOwner) return { rows: [] };
        const row = claimedRow(state.issuanceId, state.digest, params[1], state.claimAttempts);
        row.state = 'handoff_required';
        row.lease_owner = null;
        state.claimed = false;
        return { rows: [row] };
      }
      if (/tenant_email_luna_automation_capture_shadow/.test(sql)) {
        if (state.captured) {
          const replay = capturedRow(state.issuanceId, state.digest, state.claimOwner, state.claimAttempts);
          replay.persist_status = 'replayed';
          return { rows: [replay] };
        }
        if (state.requireConflict || state.expired || params[1] !== state.claimOwner) return { rows: [] };
        state.captured = true;
        state.claimed = false;
        return { rows: [capturedRow(state.issuanceId, state.digest, params[1], state.claimAttempts)] };
      }
      if (/tenant_email_luna_automation_handoff\(/.test(sql) || /journal_handoff_lock/.test(sql)) {
        state.journal += 1;
        return { rows: [] };
      }
      if (/FOR SHARE/.test(sql) && /tenant_email_luna_automation_queue/.test(sql)) {
        if (!state.claimed) return { rows: [] };
        return { rows: [claimedRow(state.issuanceId, state.digest, state.claimOwner, state.claimAttempts)] };
      }
      return { rows: [] };
    },
  };
}

function createKernel(state, owner) {
  const kernel = createEmailLunaAutomationShadowWorkerKernel({
    async withTransactionClient(work) {
      return work(mockClient(state));
    },
    env: env(),
    tenant_location_gate: gate(),
    owner_token: owner,
  });
  state.kernel = kernel;
  return kernel;
}

function assertEvidenceShape(result) {
  assertEmailLunaAutomationShadowWorkerEvidence(result);
  assert.deepEqual(Object.keys(result), [
    'status', 'reason', 'mode', 'policy_version', 'eligibility_policy_version', 'validator_version',
    'canonical_status', 'eligibility_status', 'comparison_state', 'state', 'terminal',
    'operation_id', 'issuance_id', 'client_id', 'location_id', 'conversation_id',
    'lease_owner', 'attempt_count',
    'draft_only', 'requires_staff_review', 'send_allowed', 'auto_send_allowed',
    'provider_invoked', 'journal_handoff', 'provider_transition',
  ]);
  assert.equal(result.mode, 'shadow');
  assert.equal(result.send_allowed, false);
  assert.equal(result.auto_send_allowed, false);
  assert.equal(result.provider_invoked, false);
  assert.equal(result.journal_handoff, false);
  assert.equal(result.provider_transition, false);
  assert.equal('handoff_id' in result, false);
  assert.equal('recipient' in result, false);
  assert.equal('authorize_dispatch' in result, false);
  assert.equal('subject' in result, false);
}

async function main() {
  const bundle = await readyBundle();
  const issuanceId = readEmailLunaDraftPolicyIssuanceIdentity(bundle.evidence);
  const digest = digestOf(bundle.draft);
  const plan = readEmailLunaDraftAuthorPlan(bundle.draft);

  const happy = createMockState({ issuanceId, digest, plan });
  const kernel = createKernel(happy, OWNER_A);
  assert.deepEqual(Object.keys(kernel).sort(), ['processNextShadowClaim', 'requestStop', 'resume']);
  assert.equal('start' in kernel, false);
  assert.equal('send' in kernel, false);
  assert.equal('handoff' in kernel, false);
  await assert.rejects(() => kernel.processNextShadowClaim({ operation_id: OP }), (error) => {
    assert.equal(error && error.code, 'EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_INVALID');
    return true;
  });
  const wouldSend = await kernel.processNextShadowClaim();
  assertEvidenceShape(wouldSend);
  assert.equal(wouldSend.status, 'would_send');
  assert.equal(wouldSend.reason, null);
  assert.equal(wouldSend.state, 'shadow_captured');
  assert.equal(wouldSend.terminal, true);
  assert.equal(wouldSend.comparison_state, 'pending_human');
  assert.equal(wouldSend.operation_id, OP);
  assert.equal(wouldSend.issuance_id, issuanceId);
  assert.equal(wouldSend.client_id, C);
  assert.equal(wouldSend.location_id, L);
  assert.equal(wouldSend.conversation_id, CONV);
  assert.match(wouldSend.lease_owner, UUID_RE);
  assert.equal(wouldSend.lease_owner, happy.claimOwner);
  assert.notEqual(wouldSend.lease_owner, OWNER_A);
  assert.equal(wouldSend.attempt_count, 1);
  assert.equal(wouldSend.canonical_status, 'draft_ready');
  assert.equal(wouldSend.eligibility_status, 'eligible');
  assert.equal(happy.journal, 0);
  assert.equal(happy.send, 0);
  assert.equal(happy.requireCount, 0);
  assert.ok(happy.queries.some((sql) => /tenant_email_luna_automation_claim/.test(sql)));
  assert.ok(happy.queries.some((sql) => /issuance_material_load/.test(sql)));
  assert.ok(happy.queries.some((sql) => /tenant_email_luna_automation_capture_shadow/.test(sql)));
  assert.equal(happy.queries.some((sql) => /tenant_email_luna_automation_handoff\(/.test(sql)), false);
  console.log('  PASS  claim+load+recover captures would-send as shadow_captured/pending_human, zero journal/provider');

  const emptyState = createMockState({ issuanceId, digest, plan, emptyAfterClaim: false });
  emptyState.claimed = true;
  emptyState.claimOwner = OWNER_A;
  emptyState.expired = false;
  const emptyKernel = createKernel(emptyState, OWNER_B);
  const empty = await emptyKernel.processNextShadowClaim();
  assertEvidenceShape(empty);
  assert.equal(empty.status, 'empty');
  assert.equal(empty.terminal, false);
  assert.equal(empty.operation_id, null);
  console.log('  PASS  live claimed row is skipped by a second owner (concurrent claim exactly-once)');

  const concurrentState = createMockState({ issuanceId, digest, plan });
  const leftKernel = createKernel(concurrentState, OWNER_A);
  const rightKernel = createEmailLunaAutomationShadowWorkerKernel({
    async withTransactionClient(work) {
      return work(mockClient(concurrentState));
    },
    env: env(),
    tenant_location_gate: gate(),
    owner_token: OWNER_B,
  });
  const [left, right] = await Promise.all([
    leftKernel.processNextShadowClaim(),
    rightKernel.processNextShadowClaim(),
  ]);
  const statuses = [left.status, right.status].sort();
  assert.equal(statuses.includes('would_send'), true);
  assert.equal(statuses.includes('empty'), true);
  assert.equal(concurrentState.journal, 0);
  console.log('  PASS  concurrent processNext has one would-send winner and one empty');

  const stale = createMockState({ issuanceId, digest, plan, loadEmpty: true, requireConflict: true });
  const staleKernel = createKernel(stale, OWNER_A);
  const staleResult = await staleKernel.processNextShadowClaim();
  assertEvidenceShape(staleResult);
  assert.equal(staleResult.status, 'conflict');
  assert.equal(staleResult.reason, 'stale_lease');
  assert.equal(staleResult.terminal, false);
  assert.equal(stale.journal, 0);
  console.log('  PASS  stale owner cannot terminalize; fail closed without journal');

  const expire = createMockState({ issuanceId, digest, plan });
  const firstExpire = createKernel(expire, OWNER_A);
  const firstClaimed = await firstExpire.processNextShadowClaim();
  assert.equal(firstClaimed.status, 'would_send');
  assert.equal(firstClaimed.state, 'shadow_captured');
  assert.equal(firstClaimed.terminal, true);
  expire.expired = true;
  const reclaimKernel = createEmailLunaAutomationShadowWorkerKernel({
    async withTransactionClient(work) {
      return work(mockClient(expire));
    },
    env: env(),
    tenant_location_gate: gate(),
    owner_token: OWNER_B,
  });
  const reclaimed = await reclaimKernel.processNextShadowClaim();
  assert.equal(reclaimed.status, 'empty');
  assert.equal(reclaimed.terminal, false);
  assert.equal(expire.claimAttempts, 1);
  assert.equal(expire.captured, true);
  assert.equal(expire.journal, 0);
  console.log('  PASS  successful capture is shadow_captured; expiry does not reclaim or increment attempts');

  const sameOwnerExpire = createMockState({ issuanceId, digest, plan });
  const sameOwnerFirst = createKernel(sameOwnerExpire, OWNER_A);
  const sameOwnerWouldSend = await sameOwnerFirst.processNextShadowClaim();
  assert.equal(sameOwnerWouldSend.status, 'would_send');
  const firstLease = sameOwnerWouldSend.lease_owner;
  sameOwnerExpire.expired = true;
  const restartedSameOwner = createEmailLunaAutomationShadowWorkerKernel({
    async withTransactionClient(work) {
      return work(mockClient(sameOwnerExpire));
    },
    env: env(),
    tenant_location_gate: gate(),
    owner_token: OWNER_A,
  });
  const sameOwnerReclaim = await restartedSameOwner.processNextShadowClaim();
  assertEvidenceShape(sameOwnerReclaim);
  assert.equal(sameOwnerReclaim.status, 'empty');
  assert.equal(sameOwnerReclaim.terminal, false);
  assert.equal(sameOwnerExpire.claimAttempts, 1);
  assert.equal(sameOwnerExpire.captured, true);
  assert.equal(sameOwnerWouldSend.lease_owner, firstLease);
  assert.equal(sameOwnerExpire.journal, 0);
  assert.equal(sameOwnerExpire.requireCount, 0);
  console.log('  PASS  same-owner restart after capture does not reclaim or exhaust attempts');

  const cap = createMockState({ issuanceId, digest, plan });
  cap.claimed = true;
  cap.expired = true;
  cap.claimOwner = OWNER_A;
  cap.claimAttempts = 3;
  const capKernel = createKernel(cap, OWNER_A);
  const capped = await capKernel.processNextShadowClaim();
  assert.equal(capped.status, 'empty');
  assert.equal(capped.terminal, false);
  assert.equal(cap.journal, 0);
  assert.equal(cap.queries.some((sql) => /tenant_email_luna_automation_handoff\(/.test(sql)), false);
  console.log('  PASS  next-claim skips attempt-capped expired rows; no journal terminal');

  const stopBefore = createMockState({ issuanceId, digest, plan });
  const stopKernel = createKernel(stopBefore, OWNER_A);
  stopKernel.requestStop();
  const stopped = await stopKernel.processNextShadowClaim();
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopBefore.claimed, false);
  assert.equal(stopBefore.journal, 0);
  console.log('  PASS  stop before claim does not claim');

  const stopDuring = createMockState({ issuanceId, digest, plan, stopOnClaim: true });
  const stopDuringKernel = createKernel(stopDuring, OWNER_A);
  const stoppedClaim = await stopDuringKernel.processNextShadowClaim();
  assert.equal(stoppedClaim.status, 'stopped');
  assert.equal(stoppedClaim.state, 'claimed');
  assert.equal(stoppedClaim.terminal, false);
  assert.equal(stopDuring.journal, 0);
  assert.equal(stopDuring.queries.some((sql) => /require_handoff_claimed/.test(sql)), false);
  assert.equal(stopDuring.queries.some((sql) => /issuance_material_load/.test(sql)), false);
  console.log('  PASS  stop during claim keeps the lease nonterminal and skips load/journal');

  const foreign = createMockState({ issuanceId, digest, plan, foreignClaim: true });
  const foreignKernel = createKernel(foreign, OWNER_A);
  const foreignResult = await foreignKernel.processNextShadowClaim();
  assert.equal(foreignResult.status, 'conflict');
  assert.equal(foreignResult.terminal, false);
  assert.equal(foreign.requireCount, 0);
  assert.equal(foreign.journal, 0);
  assert.equal(foreign.queries.some((sql) => /require_handoff_claimed/.test(sql)), false);
  console.log('  PASS  H1 bind mismatch never require_handoff_claimed and leaves the foreign row retryable');

  const wrongEndpoint = createMockState({
    issuanceId,
    digest,
    plan,
    claimRowPatch: { endpoint_id: OTHER },
  });
  const wrongEndpointKernel = createKernel(wrongEndpoint, OWNER_A);
  const wrongEndpointResult = await wrongEndpointKernel.processNextShadowClaim();
  assert.equal(wrongEndpointResult.status, 'conflict');
  assert.equal(wrongEndpointResult.terminal, false);
  assert.equal(wrongEndpoint.requireCount, 0);
  assert.equal(wrongEndpoint.queries.some((sql) => /require_handoff_claimed/.test(sql)), false);
  console.log('  PASS  M2 valid wrong endpoint UUID does not terminalize; bindMatches includes endpoint');

  const missing = createMockState({ issuanceId, digest, plan, loadEmpty: true });
  const missingKernel = createKernel(missing, OWNER_A);
  const missingResult = await missingKernel.processNextShadowClaim();
  assert.equal(missingResult.status, 'would_not_send');
  assert.equal(missingResult.reason, 'material_missing');
  assert.equal(missingResult.state, 'handoff_required');
  assert.equal(missingResult.terminal, true);
  assert.equal(missing.journal, 0);
  assert.equal(missing.requireCount, 1);
  console.log('  PASS  partial failure (claim then missing material) require_handoff, no journal');

  const loadThrowState = createMockState({ issuanceId, digest, plan, loadThrow: true });
  const loadThrowKernel = createKernel(loadThrowState, OWNER_A);
  const loadThrowResult = await loadThrowKernel.processNextShadowClaim();
  assertEvidenceShape(loadThrowResult);
  assert.equal(loadThrowResult.status, 'conflict');
  assert.equal(loadThrowResult.reason, 'retryable_load');
  assert.equal(loadThrowResult.terminal, false);
  assert.equal(loadThrowResult.state, 'claimed');
  assert.equal(loadThrowState.requireCount, 0);
  assert.equal(loadThrowState.journal, 0);
  assert.equal(loadThrowState.queries.some((sql) => /require_handoff_claimed/.test(sql)), false);
  assert.equal(loadThrowState.queries.some((sql) => /tenant_email_luna_automation_handoff\(/.test(sql)), false);
  assert.equal(loadThrowState.claimed, true);
  console.log('  PASS  load/query throw preserves claimed lease; does not require_handoff or journal');

  const forged = createMockState({ issuanceId, digest, plan, forgedLoad: true });
  const forgedKernel = createKernel(forged, OWNER_A);
  const forgedResult = await forgedKernel.processNextShadowClaim();
  assert.ok(forgedResult.status === 'would_not_send' || forgedResult.status === 'conflict');
  assert.equal(forgedResult.journal_handoff, false);
  assert.equal(forged.journal, 0);
  console.log('  PASS  forged/rebound loaded material fail-closed without journal');

  const copied = JSON.parse(JSON.stringify(wouldSend));
  assert.throws(() => assertEmailLunaAutomationShadowWorkerEvidence(copied));
  assert.throws(() => assertEmailLunaAutomationShadowWorkerEvidence({ ...wouldSend, send_allowed: true }));
  console.log('  PASS  JSON/copied worker evidence is not authentic send authority');

  const timerCalls = { setTimeoutCalls: 0, clearTimeoutCalls: 0 };
  const timers = {
    setTimeout(fn, ms) {
      timerCalls.setTimeoutCalls += 1;
      assert.equal(ms, 60000);
      return 1;
    },
    clearTimeout() {
      timerCalls.clearTimeoutCalls += 1;
    },
  };
  const loopState = createMockState({ issuanceId, digest, plan });
  const loopKernel = createKernel(loopState, OWNER_A);
  const loop = createEmailLunaAutomationShadowWorkerLoop({
    kernel: loopKernel,
    timers,
    intervalMs: 60000,
  });
  assert.deepEqual(Object.keys(loop).sort(), ['start', 'stop', 'tick']);
  assert.equal(timerCalls.setTimeoutCalls, 0);
  loop.start();
  assert.equal(timerCalls.setTimeoutCalls, 1);
  const ticked = await loop.tick();
  assert.equal(ticked.status, 'would_send');
  const overlap = await Promise.all([loop.tick(), loop.tick()]);
  assert.equal(overlap.some((item) => item.status === 'overlap_skipped'), true);
  loop.stop();
  assert.equal(timerCalls.clearTimeoutCalls, 1);
  const afterStop = await loop.tick();
  assert.equal(afterStop.status, 'stopped');
  console.log('  PASS  loop is start-inert, concurrency=1 overlap skipped, stop is graceful');

  const sqlState = createMockState({ issuanceId, digest, plan, claimSqlState: '23514' });
  const sqlStateKernel = createKernel(sqlState, OWNER_A);
  const sqlStateResult = await sqlStateKernel.processNextShadowClaim();
  assertEvidenceShape(sqlStateResult);
  assert.ok(sqlStateResult.status === 'conflict' || sqlStateResult.status === 'empty');
  assert.equal(sqlStateResult.terminal, false);
  assert.equal(sqlState.journal, 0);
  assert.equal(sqlState.requireCount, 0);
  assert.equal(sqlState.queries.filter((sql) => /tenant_email_luna_automation_claim/.test(sql)).length, 1);
  console.log('  PASS  claim SQLSTATE 23514 classifies fail-closed as conflict/empty; no hot-loop');

  const staleToken = createMockState({ issuanceId, digest, plan });
  const staleTokenKernel = createKernel(staleToken, OWNER_A);
  const liveLease = await staleTokenKernel.processNextShadowClaim();
  assert.equal(liveLease.status, 'would_send');
  const priorLease = liveLease.lease_owner;
  staleToken.expired = true;
  staleToken.loadEmpty = true;
  const afterCapture = await staleTokenKernel.processNextShadowClaim();
  assert.equal(afterCapture.status, 'empty');
  assert.equal(staleToken.journal, 0);
  assert.equal(staleToken.requireCount, 0);
  assert.equal(staleToken.claimOwner, priorLease);
  assert.equal(staleToken.captured, true);
  console.log('  PASS  stale prior lease token cannot overwrite a captured shadow outcome');

  let releaseTick;
  const deferredKernel = {
    processNextShadowClaim() {
      return new Promise((resolve) => {
        releaseTick = () => resolve({ status: 'empty' });
      });
    },
    requestStop() {},
    resume() {},
  };
  const raceCalls = { setTimeoutCalls: 0, clearTimeoutCalls: 0, live: 0 };
  const raceCallbacks = [];
  const raceTimers = {
    setTimeout(fn, ms) {
      raceCalls.setTimeoutCalls += 1;
      raceCalls.live += 1;
      assert.equal(ms, 60000);
      const id = raceCalls.setTimeoutCalls;
      raceCallbacks.push({ id, fn, cancelled: false });
      return id;
    },
    clearTimeout(id) {
      raceCalls.clearTimeoutCalls += 1;
      const found = raceCallbacks.find((item) => item.id === id);
      if (found && !found.cancelled) {
        found.cancelled = true;
        raceCalls.live -= 1;
      }
    },
  };
  const raceLoop = createEmailLunaAutomationShadowWorkerLoop({
    kernel: deferredKernel,
    timers: raceTimers,
    intervalMs: 60000,
  });
  assert.equal(raceCalls.setTimeoutCalls, 0);
  raceLoop.start();
  assert.equal(raceCalls.setTimeoutCalls, 1);
  const firstCallback = raceCallbacks[0];
  const inFlight = firstCallback.fn();
  raceLoop.stop();
  raceLoop.start();
  assert.equal(raceCalls.setTimeoutCalls, 2);
  releaseTick();
  await inFlight;
  assert.equal(raceCalls.setTimeoutCalls, 2);
  assert.ok(raceCalls.live <= 1);
  const staleAfterRestart = raceCallbacks.filter((item) => !item.cancelled);
  assert.equal(staleAfterRestart.length, 1);
  assert.equal(staleAfterRestart[0].id, 2);
  raceLoop.stop();
  const afterRaceStop = await raceLoop.tick();
  assert.equal(afterRaceStop.status, 'stopped');
  console.log('  PASS  stop/start during in-flight tick cannot double-arm or leak a stale callback');

  const inert = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const worker = require(${JSON.stringify(require.resolve('./lib/email-luna-automation-shadow-worker'))});
    assert.equal(worker.EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_RUNTIME_WIRED, false);
    assert.equal('start' in worker, false);
    process.stdout.write('inert-ok');
  `], { encoding: 'utf8' });
  assert.equal(inert.status, 0, inert.stderr || inert.stdout);
  assert.match(inert.stdout, /inert-ok/);
  console.log('  PASS  fresh process import does not start a worker');

  assert.equal(EMAIL_LUNA_AUTOMATION_QUEUE_RECORD_KEYS.includes('handoff_id'), true);
  console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B3 shadow worker');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

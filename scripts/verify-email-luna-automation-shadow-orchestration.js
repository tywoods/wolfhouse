'use strict';
/** FULL SAIL Stage 1 NIGHTWATCH Chapter 4 Slice B2: shadow-only orchestration owner. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createEmailLunaDraftEnvelope,
} = require('./lib/email-luna-draft-handoff-contract');
const {
  issueAndDecideEmailLunaDraftPolicy,
  readEmailLunaDraftPolicyIssuanceIdentity,
  EMAIL_LUNA_DRAFT_POLICY_VERSION,
} = require('./lib/email-luna-draft-policy');
const {
  decideEmailLunaAutonomousEligibility,
  EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_POLICY_VERSION,
} = require('./lib/email-luna-autonomous-eligibility-policy');
const { createEmailLunaDraftAuthor } = require('./lib/email-luna-draft-author');
const { validateEmailLunaDraft } = require('./lib/email-luna-draft-validator');
const {
  EMAIL_LUNA_POLICY_AUDIT_RECORD_KEYS_086,
} = require('./lib/email-luna-policy-audit-store');
const {
  createEmailLunaAutomationShadowOrchestrator,
  isEmailLunaAutomationShadowEnabled,
  assertEmailLunaAutomationShadowProjection,
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_WIRED,
  EMAIL_LUNA_AUTOMATION_SHADOW_LOGGING_FORBIDDEN,
  ENV_SHADOW_ENABLED,
  SUNSET_DEPLOYMENT,
  SUNSET_LOCATION_KEY,
  SHADOW_MODE,
} = require('./lib/email-luna-automation-shadow-orchestration');
const {
  EMAIL_LUNA_AUTOMATION_QUEUE_RUNTIME_WIRED,
} = require('./lib/email-luna-automation-queue-store');
const {
  EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_RUNTIME_WIRED,
} = require('./lib/email-luna-automation-journal-handoff-store');
const {
  EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_RUNTIME_WIRED,
} = require('./lib/email-luna-automation-issuance-material-store');

const ROOT = path.join(__dirname, '..');
const RED = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'fixtures/email-luna-automation-shadow-orchestration-red.json'),
  'utf8',
));
const ORCH_SRC = fs.readFileSync(require.resolve('./lib/email-luna-automation-shadow-orchestration'), 'utf8');
const RUNTIME_SRC = fs.readFileSync(require.resolve('./lib/email-luna-sunset-staging-runtime-composition'), 'utf8');
const STAFF_API_SRC = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

console.log('FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B2 shadow-only orchestration verifier');

assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_LOGGING_FORBIDDEN, true);
assert.equal(EMAIL_LUNA_AUTOMATION_QUEUE_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_RUNTIME_WIRED, false);
assert.equal(ENV_SHADOW_ENABLED, 'EMAIL_LUNA_AUTOMATION_SHADOW_ENABLED');
assert.equal(SUNSET_DEPLOYMENT, 'sunset-staging');
assert.equal(SUNSET_LOCATION_KEY, 'sunset-somo');
assert.equal(SHADOW_MODE, 'shadow');
assert.equal(RED.id, 'email-luna-automation-shadow-orchestration.ch4b2-red.v1');
assert.equal(RED.slice, 'FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B2');
assert.equal(RED.head_reviewed, '566c2d6915718b5e04110284075e3f9a37ff65ce');
assert.equal(RED.provider_transition, false);
assert.equal(RED.runtime_activation, false);
assert.equal(RED.worker_loop, false);
assert.equal(RED.send_permission, false);
assert.equal(RED.findings.length, 4);
assert.ok(RED.findings.every((item) => item.severity === 'blocking' && item.red && item.green));
console.log('  PASS  authentic RED artifact records 566c2d69 missing shadow owner');

assert.doesNotMatch(ORCH_SRC, /email-outbound|microsoft-graph|nodemailer|smtp|dispatchApprovedOutbound|staff-query-api/);
assert.equal(/require\('\.\/email-luna-automation-journal-handoff-store'\)/.test(ORCH_SRC), false);
assert.equal(/require\('\.\/email-luna-automation-queue-store'\)/.test(ORCH_SRC), false);
assert.equal(/establishCanonicalJournalHandoff/.test(ORCH_SRC), false);
assert.equal(/claimAutomationOperation/.test(ORCH_SRC), false);
assert.equal(/authorize_dispatch:\s*true/.test(ORCH_SRC), false);
assert.equal(/send_allowed:\s*true/.test(ORCH_SRC), false);
assert.equal(/require\('\.\/email-luna-automation-journal-handoff-store'\)/.test(ORCH_SRC), false);
assert.equal(/require\('\.\/email-luna-automation-queue-store'\)/.test(ORCH_SRC), false);
assert.equal(/EMAIL_LUNA_DRAFT_RUNTIME_ENABLED/.test(ORCH_SRC), false);
assert.equal(/console\.log/.test(ORCH_SRC), false);
assert.equal(/worker_loop/.test(ORCH_SRC), false);
assert.match(ORCH_SRC, /persistAndEnqueueAutomationIssuance/);
assert.match(ORCH_SRC, /persistPolicyAudit/);
assert.match(ORCH_SRC, /decideEmailLunaAutonomousEligibility/);
assert.doesNotMatch(RUNTIME_SRC, /email-luna-automation-shadow-orchestration|EMAIL_LUNA_AUTOMATION_SHADOW_ENABLED/);
assert.doesNotMatch(STAFF_API_SRC, /email-luna-automation-shadow-orchestration|EMAIL_LUNA_AUTOMATION_SHADOW_ENABLED/);
const orchExports = require('./lib/email-luna-automation-shadow-orchestration');
assert.deepEqual(Object.keys(orchExports).sort(), [
  'EMAIL_LUNA_AUTOMATION_SHADOW_LOGGING_FORBIDDEN',
  'EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_WIRED',
  'ENV_SHADOW_ENABLED',
  'SHADOW_MODE',
  'SUNSET_DEPLOYMENT',
  'SUNSET_LOCATION_KEY',
  'assertEmailLunaAutomationShadowProjection',
  'createEmailLunaAutomationShadowOrchestrator',
  'isEmailLunaAutomationShadowEnabled',
]);
assert.equal('send' in orchExports, false);
assert.equal('claim' in orchExports, false);
assert.equal('handoff' in orchExports, false);
console.log('  PASS  owner is import-inert, send-inert, unwired from runtime and staff-query-api');

const C = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const OTHER = '66666666-6666-4666-8666-666666666666';
const CONV = '33333333-3333-4333-8333-333333333333';
const ENDPOINT = '44444444-4444-4444-8444-444444444444';
const INBOUND = '55555555-5555-4555-8555-555555555555';
const OP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OP2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';

function frozen(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozen));
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) value[key] = frozen(value[key]);
    return Object.freeze(value);
  }
  return value;
}

function env(patch = {}) {
  return { LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_LUNA_AUTOMATION_SHADOW_ENABLED: 'true', ...patch };
}
function gate(patch = {}) {
  return { client_id: C, location_id: L, location_key: 'sunset-somo', shadow_enabled: true, ...patch };
}
function authority(patch = {}) {
  return { client_id: C, location_id: L, location_key: 'sunset-somo', ...patch };
}
function enabledInput(patch = {}) {
  return { env: env(), tenant_location_gate: gate(), authority: authority(), ...patch };
}

assert.equal(isEmailLunaAutomationShadowEnabled(enabledInput()), true);
for (const [label, input] of [
  ['default off', enabledInput({ env: { LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_LUNA_AUTOMATION_SHADOW_ENABLED: 'false' } })],
  ['missing flag', enabledInput({ env: { LUNA_DEPLOYMENT: 'sunset-staging' } })],
  ['near-match flag', enabledInput({ env: env({ EMAIL_LUNA_AUTOMATION_SHADOW_ENABLED: 'TRUE' }) })],
  ['wrong deployment', enabledInput({ env: env({ LUNA_DEPLOYMENT: 'sunset-production' }) })],
  ['draft runtime flag is not shadow', enabledInput({ env: { LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true' } })],
  ['gate off', enabledInput({ tenant_location_gate: gate({ shadow_enabled: false }) })],
  ['tenant mismatch', enabledInput({ tenant_location_gate: gate({ client_id: OTHER }) })],
  ['location mismatch', enabledInput({ tenant_location_gate: gate({ location_id: OTHER }) })],
  ['location-key mismatch', enabledInput({ tenant_location_gate: gate({ location_key: 'sunset-sardinero' }) })],
]) {
  assert.equal(isEmailLunaAutomationShadowEnabled(input), false, label);
}
console.log('  PASS  exact Sunset-staging shadow flag + tenant/location gate are required; draft runtime flag is not a substitute');

function expectDisabled(fn) {
  assert.throws(fn, (error) => {
    assert.equal(error && error.code, 'EMAIL_LUNA_AUTOMATION_SHADOW_DISABLED');
    return true;
  });
}
function expectInvalid(fn) {
  assert.throws(fn, (error) => {
    assert.equal(error && error.code, 'EMAIL_LUNA_AUTOMATION_SHADOW_INVALID');
    return true;
  });
}
async function expectInvalidAsync(fn) {
  await assert.rejects(fn, (error) => {
    assert.equal(error && error.code, 'EMAIL_LUNA_AUTOMATION_SHADOW_INVALID');
    return true;
  });
}

const loaner = { async withTransactionClient(work) { return work({ async query() { return { rows: [] }; } }); } };
expectDisabled(() => createEmailLunaAutomationShadowOrchestrator({
  withTransactionClient: loaner.withTransactionClient,
  env: { LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_LUNA_AUTOMATION_SHADOW_ENABLED: 'false' },
  tenant_location_gate: gate(),
}));
expectDisabled(() => createEmailLunaAutomationShadowOrchestrator({
  withTransactionClient: loaner.withTransactionClient,
  env: env(),
  tenant_location_gate: gate({ shadow_enabled: false }),
}));
expectInvalid(() => createEmailLunaAutomationShadowOrchestrator({
  withTransactionClient: loaner.withTransactionClient,
  env: env(),
  tenant_location_gate: gate(),
  provider: () => {},
}));
expectInvalid(() => createEmailLunaAutomationShadowOrchestrator({
  withTransactionClient: loaner.withTransactionClient,
  env: env(),
  tenant_location_gate: gate(),
  authority: authority(),
}));
console.log('  PASS  factory is default-off and refuses caller-selected provider/authority');

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

function catalogTriplet() {
  const envelope = makeEnvelope();
  const issued = issueAndDecideEmailLunaDraftPolicy({
    envelope,
    evidence: catalogEvidence(),
  });
  return { envelope, evidence: issued.evidence, decision: issued.decision };
}

async function readyBundle() {
  const triplet = catalogTriplet();
  const author = createEmailLunaDraftAuthor({
    callModel: () => Promise.resolve(JSON.stringify({
      template_id: 'catalog_reply', tone: 'concise', question_key: 'none', acknowledgment_key: 'thanks',
    })),
  });
  const draft = await author.authorDraft({
    envelope: triplet.envelope, evidence: triplet.evidence, decision: triplet.decision,
  });
  const validation = validateEmailLunaDraft({
    envelope: triplet.envelope, evidence: triplet.evidence, decision: triplet.decision, draft,
  });
  assert.equal(validation.status, 'valid');
  return { triplet, draft, validation };
}

function mockClient(state) {
  return {
    async query(text, params) {
      const sql = String(text);
      state.queries.push(sql);
      if (/persist_and_enqueue/.test(sql)) {
        state.persist += 1;
        if (state.persistResult) return { rows: state.persistResult(params) };
        return {
          rows: [{
            persist_status: state.persistStatus || 'committed',
            operation_id: params[0],
            issuance_id: params[1],
            audit_operation_id: params[2],
            client_id: params[3],
            location_id: params[4],
            location_key: params[5],
            endpoint_id: params[6],
            conversation_id: params[7],
            inbound_event_id: params[8],
            recipient_address: params[9],
            draft_digest: params[13],
            state: state.queueState || 'pending',
            attempt_count: 0,
            lease_owner: null,
            handoff_id: null,
          }],
        };
      }
      if (/INSERT INTO tenant_email_luna_policy_audit/.test(sql)) {
        state.auditInsert += 1;
        const rec = {};
        for (let i = 0; i < EMAIL_LUNA_POLICY_AUDIT_RECORD_KEYS_086.length; i += 1) {
          rec[EMAIL_LUNA_POLICY_AUDIT_RECORD_KEYS_086[i]] = params[i];
        }
        return { rows: [rec] };
      }
      return { rows: [] };
    },
  };
}

function createEnabled(state) {
  return createEmailLunaAutomationShadowOrchestrator({
    async withTransactionClient(work) {
      return work(mockClient(state));
    },
    env: env(),
    tenant_location_gate: gate(),
  });
}

function assertProjectionShape(result) {
  assertEmailLunaAutomationShadowProjection(result);
  assert.deepEqual(Object.keys(result), [
    'status', 'reason', 'mode', 'policy_version', 'eligibility_policy_version',
    'canonical_status', 'eligibility_status', 'state',
    'operation_id', 'issuance_id', 'client_id', 'location_id', 'conversation_id',
    'draft_only', 'requires_staff_review', 'send_allowed', 'auto_send_allowed',
    'provider_invoked',
  ]);
  assert.equal(result.mode, 'shadow');
  assert.equal(result.policy_version, EMAIL_LUNA_DRAFT_POLICY_VERSION);
  assert.equal(result.eligibility_policy_version, EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_POLICY_VERSION);
  assert.equal(result.draft_only, true);
  assert.equal(result.requires_staff_review, true);
  assert.equal(result.send_allowed, false);
  assert.equal(result.auto_send_allowed, false);
  assert.equal(result.provider_invoked, false);
  assert.equal('recipient' in result, false);
  assert.equal('subject' in result, false);
  assert.equal('body' in result, false);
  assert.equal('authorize_dispatch' in result, false);
  assert.equal('handoff_id' in result, false);
}

async function main() {
  const owner = createEnabled({ queries: [], persist: 0, auditInsert: 0 });
  assert.deepEqual(Object.keys(owner), ['orchestrateShadowDecision']);
  assert.equal(typeof owner.orchestrateShadowDecision, 'function');
  assert.equal('send' in owner, false);
  assert.equal('claim' in owner, false);
  assert.equal('handoff' in owner, false);
  assert.equal('start' in owner, false);
  assert.equal('establishCanonicalJournalHandoff' in owner, false);

  const bundle = await readyBundle();
  const issuanceId = readEmailLunaDraftPolicyIssuanceIdentity(bundle.triplet.evidence);
  const wouldSendState = { queries: [], persist: 0, auditInsert: 0 };
  const sendOwner = createEnabled(wouldSendState);
  const wouldSend = await sendOwner.orchestrateShadowDecision({
    operation_id: OP,
    envelope: bundle.triplet.envelope,
    evidence: bundle.triplet.evidence,
    decision: bundle.triplet.decision,
    draft: bundle.draft,
    validation: bundle.validation,
  });
  assertProjectionShape(wouldSend);
  assert.equal(wouldSend.status, 'would_send');
  assert.equal(wouldSend.reason, null);
  assert.equal(wouldSend.canonical_status, 'draft_ready');
  assert.equal(wouldSend.eligibility_status, 'eligible');
  assert.equal(wouldSend.state, 'pending');
  assert.equal(wouldSend.operation_id, OP);
  assert.equal(wouldSend.issuance_id, issuanceId);
  assert.equal(wouldSend.client_id, C);
  assert.equal(wouldSend.location_id, L);
  assert.equal(wouldSend.conversation_id, CONV);
  assert.equal(wouldSendState.persist, 1);
  assert.equal(wouldSendState.auditInsert, 1);
  assert.ok(wouldSendState.queries.some((sql) => /persist_and_enqueue/.test(sql)));
  console.log('  PASS  authentic eligible issuance persists via producer and projects would-send without send permission');

  const replayBundle = await readyBundle();
  const replayState = { queries: [], persist: 0, auditInsert: 0, persistStatus: 'replayed' };
  const replayOwner = createEnabled(replayState);
  const replayed = await replayOwner.orchestrateShadowDecision({
    operation_id: OP,
    envelope: replayBundle.triplet.envelope,
    evidence: replayBundle.triplet.evidence,
    decision: replayBundle.triplet.decision,
    draft: replayBundle.draft,
    validation: replayBundle.validation,
  });
  assert.equal(replayed.status, 'would_send');
  assert.equal(replayed.state, 'replayed');
  assert.equal(replayed.send_allowed, false);
  console.log('  PASS  same-identity replay stays would-send/replayed and send-inert');

  const beyondBundle = await readyBundle();
  const claimedState = { queries: [], persist: 0, auditInsert: 0, queueState: 'handed_off' };
  const claimedOwner = createEnabled(claimedState);
  const beyond = await claimedOwner.orchestrateShadowDecision({
    operation_id: OP2,
    envelope: beyondBundle.triplet.envelope,
    evidence: beyondBundle.triplet.evidence,
    decision: beyondBundle.triplet.decision,
    draft: beyondBundle.draft,
    validation: beyondBundle.validation,
  });
  assert.equal(beyond.status, 'would_not_send');
  assert.equal(beyond.state, 'conflict');
  assert.equal(beyond.send_allowed, false);
  console.log('  PASS  queue state beyond pending cannot become a send-capable shadow result');

  const jsonState = { queries: [], persist: 0, auditInsert: 0 };
  const jsonOwner = createEnabled(jsonState);
  const cloned = await jsonOwner.orchestrateShadowDecision({
    operation_id: OP2,
    envelope: bundle.triplet.envelope,
    evidence: JSON.parse(JSON.stringify(bundle.triplet.evidence)),
    decision: JSON.parse(JSON.stringify(bundle.triplet.decision)),
  });
  assertProjectionShape(cloned);
  assert.equal(cloned.status, 'would_not_send');
  assert.equal(cloned.reason, 'unissued_evidence');
  assert.equal(cloned.state, 'not_queued');
  assert.equal(jsonState.persist, 0);
  assert.equal(jsonState.auditInsert, 0);
  console.log('  PASS  JSON-cloned issuance is would-not-send and does not persist');

  const copied = await jsonOwner.orchestrateShadowDecision({
    operation_id: OP2,
    envelope: bundle.triplet.envelope,
    evidence: { ...bundle.triplet.evidence },
    decision: { ...bundle.triplet.decision },
  });
  assert.equal(copied.status, 'would_not_send');
  assert.equal(copied.reason, 'unissued_evidence');
  assert.equal(jsonState.persist, 0);
  console.log('  PASS  copied issuance objects are would-not-send');

  await expectInvalidAsync(() => sendOwner.orchestrateShadowDecision({
    operation_id: OP,
    envelope: bundle.triplet.envelope,
    evidence: bundle.triplet.evidence,
    decision: bundle.triplet.decision,
    draft: bundle.draft,
    validation: bundle.validation,
    would_send: true,
  }));
  await expectInvalidAsync(() => sendOwner.orchestrateShadowDecision({
    operation_id: OP,
    envelope: bundle.triplet.envelope,
    evidence: bundle.triplet.evidence,
    decision: bundle.triplet.decision,
    status: 'would_send',
  }));
  await expectInvalidAsync(() => sendOwner.orchestrateShadowDecision({
    operation_id: OP,
    envelope: bundle.triplet.envelope,
    evidence: bundle.triplet.evidence,
    decision: bundle.triplet.decision,
    provider: { send() { return 'sent'; } },
  }));
  await expectInvalidAsync(() => sendOwner.orchestrateShadowDecision({
    operation_id: OP,
    envelope: bundle.triplet.envelope,
    evidence: bundle.triplet.evidence,
    decision: bundle.triplet.decision,
    callback: () => {},
  }));
  await expectInvalidAsync(() => sendOwner.orchestrateShadowDecision({
    operation_id: OP,
    envelope: bundle.triplet.envelope,
    evidence: bundle.triplet.evidence,
    decision: bundle.triplet.decision,
    onSend() { return true; },
  }));
  await expectInvalidAsync(() => sendOwner.orchestrateShadowDecision({
    operation_id: OP,
    envelope: bundle.triplet.envelope,
    evidence: bundle.triplet.evidence,
    decision: bundle.triplet.decision,
    owner_token: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  }));
  await expectInvalidAsync(() => sendOwner.orchestrateShadowDecision({
    operation_id: OP,
    envelope: bundle.triplet.envelope,
    evidence: bundle.triplet.evidence,
    decision: bundle.triplet.decision,
    client_id: OTHER,
    location_id: OTHER,
    recipient: 'attacker@example.test',
  }));
  await expectInvalidAsync(() => sendOwner.orchestrateShadowDecision({
    operation_id: OP,
    envelope: bundle.triplet.envelope,
    evidence: bundle.triplet.evidence,
    decision: bundle.triplet.decision,
    authorize_dispatch: true,
  }));
  console.log('  PASS  caller-selected shadow result, provider callback, tenant/recipient, and send/claim keys fail closed');

  const otherGate = createEmailLunaAutomationShadowOrchestrator({
    async withTransactionClient(work) { return work(mockClient({ queries: [], persist: 0, auditInsert: 0 })); },
    env: env(),
    tenant_location_gate: gate({ client_id: OTHER, location_id: OTHER }),
  });
  const rebound = await otherGate.orchestrateShadowDecision({
    operation_id: OP2,
    envelope: bundle.triplet.envelope,
    evidence: bundle.triplet.evidence,
    decision: bundle.triplet.decision,
    draft: bundle.draft,
    validation: bundle.validation,
  });
  assert.equal(rebound.status, 'would_not_send');
  assert.equal(rebound.reason, 'authority_mismatch');
  assert.equal(rebound.state, 'not_queued');
  console.log('  PASS  factory gate cannot rebind tenant/location onto envelope authority');

  const handoffEnvelope = makeEnvelope();
  const handoffIssued = issueAndDecideEmailLunaDraftPolicy({
    envelope: handoffEnvelope,
    evidence: catalogEvidence({ identity: 'ambiguous' }),
  });
  assert.equal(handoffIssued.decision.status, 'handoff_required');
  const handoffState = { queries: [], persist: 0, auditInsert: 0 };
  const handoffOwner = createEnabled(handoffState);
  const handoff = await handoffOwner.orchestrateShadowDecision({
    operation_id: OP2,
    envelope: handoffEnvelope,
    evidence: handoffIssued.evidence,
    decision: handoffIssued.decision,
  });
  assertProjectionShape(handoff);
  assert.equal(handoff.status, 'would_not_send');
  assert.equal(handoff.reason, 'ambiguous_identity');
  assert.equal(handoff.eligibility_status, 'handoff_required');
  assert.equal(handoff.state, 'not_queued');
  assert.equal(handoffState.persist, 0);
  assert.equal(handoffState.auditInsert, 1);
  console.log('  PASS  authentic unsupported/ambiguous issuance is would-not-send; no queue persist');

  const payEnvelope = makeEnvelope();
  const payIssued = issueAndDecideEmailLunaDraftPolicy({
    envelope: payEnvelope,
    evidence: frozen({
      client_id: C,
      location_id: L,
      conversation_id: CONV,
      endpoint_id: ENDPOINT,
      language: 'en',
      identity: 'matched',
      intent: 'payment_status_question',
      intent_support: 'supported',
      requested_location_id: L,
      explicit_human_request: false,
      attachment_interpretation_required: false,
      unsafe_transactional_request: false,
      required_facts: ['payment'],
      grounded_results: {
        payment: Object.assign(Object.create(null), {
          fact: 'payment',
          status: 'found',
          client_id: C,
          location_id: L,
          currency: 'EUR',
          payment_status: 'paid',
          amount_paid_cents: 10000,
          balance_due_cents: 0,
          label: 'Balance',
        }),
      },
    }),
  });
  const payState = { queries: [], persist: 0, auditInsert: 0 };
  const payOwner = createEnabled(payState);
  const pay = await payOwner.orchestrateShadowDecision({
    operation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
    envelope: payEnvelope,
    evidence: payIssued.evidence,
    decision: payIssued.decision,
  });
  assert.equal(pay.status, 'would_not_send');
  assert.equal(pay.reason, 'unsupported_intent');
  assert.equal(payState.persist, 0);
  console.log('  PASS  payment-status draft_ready stays would-not-send outside autonomous subset');

  const staleTriplet = catalogTriplet();
  decideEmailLunaAutonomousEligibility(staleTriplet);
  const staleState = { queries: [], persist: 0, auditInsert: 0 };
  const staleOwner = createEnabled(staleState);
  const stale = await staleOwner.orchestrateShadowDecision({
    operation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
    envelope: staleTriplet.envelope,
    evidence: staleTriplet.evidence,
    decision: staleTriplet.decision,
  });
  assert.equal(stale.status, 'would_not_send');
  assert.equal(stale.reason, 'stale_evidence');
  assert.equal(staleState.persist, 0);
  console.log('  PASS  consumed/stale policy decision is would-not-send');

  const incompleteState = { queries: [], persist: 0, auditInsert: 0 };
  const incompleteOwner = createEnabled(incompleteState);
  const fresh = catalogTriplet();
  const incomplete = await incompleteOwner.orchestrateShadowDecision({
    operation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
    envelope: fresh.envelope,
    evidence: fresh.evidence,
    decision: fresh.decision,
  });
  assert.equal(incomplete.status, 'would_not_send');
  assert.equal(incomplete.eligibility_status, 'eligible');
  assert.equal(incomplete.reason, null);
  assert.equal(incomplete.state, 'not_queued');
  assert.equal(incompleteState.persist, 0);
  assert.equal(incompleteState.auditInsert, 1);
  console.log('  PASS  eligible issuance without authentic draft/validation does not enqueue');

  const rebindState = { queries: [], persist: 0, auditInsert: 0 };
  const rebindOwner = createEnabled(rebindState);
  const otherThread = createEmailLunaDraftEnvelope({
    authority: {
      client_id: C,
      location_id: L,
      location_key: 'sunset-somo',
      conversation_id: '33333333-3333-4333-8333-333333333331',
      endpoint_id: ENDPOINT,
      inbound_message_id: INBOUND,
    },
    untrusted_content: {
      subject: 'Lesson question',
      body_text: 'How much is a surf lesson?',
      quoted_history: '',
      from_display_name: 'Elena',
      from_address: 'other.guest@example.test',
    },
  });
  const reboundThread = await rebindOwner.orchestrateShadowDecision({
    operation_id: OP,
    envelope: otherThread,
    evidence: bundle.triplet.evidence,
    decision: bundle.triplet.decision,
    draft: bundle.draft,
    validation: bundle.validation,
  });
  assert.equal(reboundThread.status, 'would_not_send');
  assert.equal(reboundThread.reason, 'unissued_evidence');
  assert.equal(rebindState.persist, 0);
  assert.equal(rebindState.auditInsert, 0);
  console.log('  PASS  thread/recipient rebinding of authentic issuance is would-not-send');

  assert.throws(() => assertEmailLunaAutomationShadowProjection(JSON.parse(JSON.stringify(wouldSend))));
  assert.throws(() => assertEmailLunaAutomationShadowProjection({ ...wouldSend, send_allowed: true }));
  console.log('  PASS  forged/copied shadow projections are not authentic send-capable decisions');

  console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B2 shadow-only orchestration');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

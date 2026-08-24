'use strict';
/** FULL SAIL Stage 1 NIGHTWATCH Chapter 3 Slice A: durable automation queue and idempotent operation identity. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const queueModule = require('./lib/email-luna-automation-queue-store');
const { createEmailLunaDraftEnvelope } = require('./lib/email-luna-draft-handoff-contract');
const {
  issueAndDecideEmailLunaDraftPolicy,
  createEmailLunaDraftPolicyEvidence,
  readEmailLunaDraftPolicyIssuanceIdentity,
  EMAIL_LUNA_DRAFT_POLICY_VERSION,
} = require('./lib/email-luna-draft-policy');
const {
  decideEmailLunaAutonomousEligibility,
  EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_POLICY_VERSION,
} = require('./lib/email-luna-autonomous-eligibility-policy');
const { createEmailLunaDraftAuthor } = require('./lib/email-luna-draft-author');
const {
  validateEmailLunaDraft,
  EMAIL_LUNA_DRAFT_VALIDATOR_VERSION,
} = require('./lib/email-luna-draft-validator');
const {
  createEmailLunaAutomationQueueStore,
  EMAIL_LUNA_AUTOMATION_QUEUE_RUNTIME_WIRED,
  EMAIL_LUNA_AUTOMATION_QUEUE_LOGGING_FORBIDDEN,
  EMAIL_LUNA_AUTOMATION_QUEUE_RECORD_KEYS,
  EMAIL_LUNA_AUTOMATION_QUEUE_STATES,
  EMAIL_LUNA_AUTOMATION_QUEUE_MAX_ATTEMPTS,
  SQL_LOCK_OPERATION,
  SQL_LOCK_ISSUANCE,
  SQL_LOCK_AUDIT,
  SQL_ENQUEUE,
  SQL_CLAIM,
  SQL_CLAIM_SCOPED,
  SQL_ATTEMPT_CAP,
  SQL_HANDOFF,
  SQL_CANCEL_CLAIMED,
  SQL_REQUIRE_HANDOFF_CLAIMED,
  EMAIL_LUNA_AUTOMATION_QUEUE_GRANT_CONTRACT,
} = queueModule;

const IDS = Object.freeze({
  client_id: '11111111-1111-4111-8111-111111111111',
  location_id: '22222222-2222-4222-8222-222222222222',
  conversation_id: '33333333-3333-4333-8333-333333333333',
  endpoint_id: '44444444-4444-4444-8444-444444444444',
  inbound_message_id: '55555555-5555-4555-8555-555555555555',
});
const OTHER = Object.freeze({
  client_id: '99999999-9999-4999-8999-999999999999',
  location_id: '66666666-6666-4666-8666-666666666666',
  conversation_id: '77777777-7777-4777-8777-777777777777',
  endpoint_id: '88888888-8888-4888-8888-888888888888',
});
const OP_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OP_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AUDIT_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OWNER_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OWNER_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const RECORD_KEYS = Object.freeze([
  'operation_id',
  'issuance_id',
  'audit_operation_id',
  'client_id',
  'location_id',
  'location_key',
  'endpoint_id',
  'conversation_id',
  'inbound_event_id',
  'recipient_address',
  'policy_version',
  'eligibility_policy_version',
  'validator_version',
  'draft_digest',
  'state',
  'attempt_count',
  'lease_owner',
  'handoff_id',
]);
const FORBIDDEN_RECORD_KEYS = Object.freeze([
  'subject', 'body', 'body_text', 'quoted_history', 'from_display_name',
  'password', 'secret', 'access_token', 'refresh_token', 'payment_url',
  'prompt', 'capabilities', 'provider', 'provider_message_id', 'provider_mailbox_id',
  'grounded_results', 'policy_text', 'amount_cents', 'message_text', 'draft_text',
  'auto_send_allowed', 'send_allowed', 'recipient', 'model', 'phase',
  'send_invocation_count', 'immutable_draft_id', 'approval_id',
]);
const STATES = Object.freeze(['pending', 'claimed', 'handed_off', 'handoff_required', 'cancelled', 'shadow_captured']);
const STORE_PATH = require.resolve('./lib/email-luna-automation-queue-store');
const SQL_PATH = path.join(__dirname, '..', 'database/migrations/086_tenant_email_luna_automation_queue.sql');
const DOWN_PATH = path.join(__dirname, '..', 'database/migrations/086_tenant_email_luna_automation_queue_down.sql');

function frozen(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozen));
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const nested = frozen(value[key]);
      if (!Object.isFrozen(value)) value[key] = nested;
    }
    return Object.freeze(value);
  }
  return value;
}

function authority(patch = {}) {
  return { ...IDS, location_key: 'sunset-somo', ...patch };
}
function content(patch = {}) {
  return {
    subject: 'Question about a lesson',
    body_text: 'How much is a surf lesson?',
    quoted_history: '<blockquote>Previous guest email only.</blockquote>',
    from_display_name: 'Elena',
    from_address: 'elena@example.test',
    ...patch,
  };
}
function envelope(contentPatch = {}, authorityPatch = {}) {
  return createEmailLunaDraftEnvelope({
    authority: authority(authorityPatch),
    untrusted_content: content(contentPatch),
  });
}
function found(fact, extra = {}) {
  const facts = {
    catalog: { item: 'board_rental', label: 'Surfboard rental', currency: 'EUR', amount_cents: 4500, active: true },
    availability: { item: 'group_lesson', label: 'Morning lesson', date: '2026-08-12', slot_time: '09:00', available: true, capacity: 4 },
    policy: { label: 'House policy', policy_key: 'cancellation_48h', policy_text: 'Check-in is from 15:00.' },
    booking: { booking_code: 'SUN-42', booking_status: 'confirmed' },
    payment: { currency: 'EUR', payment_status: 'partially_paid', amount_paid_cents: 5000, balance_due_cents: 7500 },
  };
  return frozen(Object.assign(Object.create(null), {
    fact,
    status: 'found',
    client_id: IDS.client_id,
    location_id: IDS.location_id,
    ...facts[fact],
    ...extra,
  }));
}
function evidence(patch = {}) {
  const intent = patch.intent || 'catalog_question';
  const requiredByIntent = {
    catalog_question: ['catalog'],
    availability_question: ['availability'],
    policy_question: ['policy'],
    booking_status_question: ['booking'],
    payment_status_question: ['payment'],
  };
  const required = Object.hasOwn(requiredByIntent, intent) ? requiredByIntent[intent] : (patch.required_facts || []);
  const grounded = {};
  for (const fact of required) grounded[fact] = found(fact);
  const value = {
    client_id: IDS.client_id,
    location_id: IDS.location_id,
    conversation_id: IDS.conversation_id,
    endpoint_id: IDS.endpoint_id,
    language: 'en',
    identity: 'matched',
    intent,
    intent_support: 'supported',
    requested_location_id: IDS.location_id,
    explicit_human_request: false,
    attachment_interpretation_required: false,
    unsafe_transactional_request: false,
    required_facts: required,
    grounded_results: frozen(grounded),
    ...patch,
  };
  if (patch.grounded_results === undefined && value.required_facts !== required) {
    const next = {};
    for (const fact of value.required_facts) next[fact] = found(fact);
    value.grounded_results = frozen(next);
  }
  return frozen(value);
}
function issue(input = {}) {
  const env = input.envelope || envelope(input.contentPatch, input.authorityPatch);
  const issued = issueAndDecideEmailLunaDraftPolicy({
    envelope: env,
    evidence: input.evidence || evidence(input.evidencePatch),
  });
  return { envelope: env, evidence: issued.evidence, decision: issued.decision };
}
function planFor(intent) {
  const templates = {
    catalog_question: 'catalog_reply',
    availability_question: 'availability_reply',
    policy_question: 'policy_reply',
    booking_status_question: 'booking_status_reply',
  };
  return JSON.stringify({
    template_id: templates[intent] || 'catalog_reply',
    tone: 'concise',
    question_key: 'none',
    acknowledgment_key: 'thanks',
  });
}
async function authenticDraft(triplet) {
  const author = createEmailLunaDraftAuthor({
    callModel: () => Promise.resolve(planFor(triplet.decision.intent)),
  });
  return author.authorDraft({
    envelope: triplet.envelope,
    evidence: triplet.evidence,
    decision: triplet.decision,
  });
}
async function validBundle(input = {}) {
  const triplet = input.triplet || issue(input);
  const eligibility = Object.hasOwn(input, 'eligibility')
    ? input.eligibility
    : decideEmailLunaAutonomousEligibility(triplet);
  const draft = Object.hasOwn(input, 'draft') ? input.draft : await authenticDraft(triplet);
  const validation = Object.hasOwn(input, 'validation')
    ? input.validation
    : validateEmailLunaDraft({
      envelope: triplet.envelope,
      evidence: triplet.evidence,
      decision: triplet.decision,
      draft,
    });
  return { triplet, eligibility, draft, validation };
}
function expectedDigest(draft) {
  return crypto.createHash('sha256')
    .update(draft.subject)
    .update('\0')
    .update(draft.body)
    .update('\0')
    .update(draft.language)
    .digest('hex');
}
function cloneRow(row) {
  const copy = Object.create(null);
  for (const key of RECORD_KEYS) copy[key] = row[key];
  return copy;
}
function createMemoryQueueDb(options = {}) {
  const byOp = new Map();
  const byIssuance = new Map();
  const audits = options.audits || new Map();
  const inserts = [];
  const locked = new Set();
  let rollback = false;
  const snapshots = [];
  function snapshot() {
    const rows = [];
    for (const row of byOp.values()) rows.push(cloneRow(row));
    return rows;
  }
  function restore(rows) {
    byOp.clear();
    byIssuance.clear();
    for (const row of rows) {
      const copy = cloneRow(row);
      byOp.set(copy.operation_id, copy);
      byIssuance.set(copy.issuance_id, copy);
    }
  }
  function claimable(row) {
    if (row.state === 'pending' && row.attempt_count === 0) return true;
    if (row.state === 'claimed' && row.lease_expires_at instanceof Date
        && row.lease_expires_at.getTime() < Date.now()
        && row.attempt_count < EMAIL_LUNA_AUTOMATION_QUEUE_MAX_ATTEMPTS) return true;
    return false;
  }
  function capable(row) {
    return row.state === 'claimed'
      && row.lease_expires_at instanceof Date
      && row.lease_expires_at.getTime() < Date.now()
      && row.attempt_count >= EMAIL_LUNA_AUTOMATION_QUEUE_MAX_ATTEMPTS;
  }
  function liveOwner(row, owner) {
    return row.state === 'claimed'
      && row.lease_owner === owner
      && row.lease_expires_at instanceof Date
      && row.lease_expires_at.getTime() >= Date.now();
  }
  async function withTransactionClient(work) {
    snapshots.push(snapshot());
    rollback = false;
    const client = {
      async query(text, params) {
        if (text === SQL_LOCK_OPERATION) {
          const row = byOp.get(params[0]);
          return { rows: row ? [cloneRow(row)] : [] };
        }
        if (text === SQL_LOCK_ISSUANCE) {
          const row = byIssuance.get(params[0]);
          return { rows: row ? [cloneRow(row)] : [] };
        }
        if (text === SQL_LOCK_AUDIT) {
          const row = audits.get(params[0]);
          return { rows: row ? [{ ...row }] : [] };
        }
        if (text === SQL_ENQUEUE) {
          const row = Object.create(null);
          const keys = [
            'operation_id', 'issuance_id', 'audit_operation_id', 'client_id', 'location_id',
            'location_key', 'endpoint_id', 'conversation_id', 'inbound_event_id', 'recipient_address',
            'policy_version', 'eligibility_policy_version', 'validator_version', 'draft_digest',
          ];
          for (let index = 0; index < keys.length; index += 1) row[keys[index]] = params[index];
          row.state = 'pending';
          row.attempt_count = 0;
          row.lease_owner = null;
          row.handoff_id = null;
          row.lease_expires_at = null;
          if (byOp.has(row.operation_id) || byIssuance.has(row.issuance_id)) {
            const error = new Error('duplicate key');
            error.code = '23505';
            throw error;
          }
          byOp.set(row.operation_id, row);
          byIssuance.set(row.issuance_id, row);
          inserts.push(params.slice());
          return { rows: [cloneRow(row)] };
        }
        if (text === SQL_CLAIM) {
          const owner = params[0];
          const targeted = params[1];
          const candidates = [];
          for (const row of byOp.values()) {
            if (targeted && row.operation_id !== targeted) continue;
            if (!claimable(row)) continue;
            if (locked.has(row.operation_id)) continue;
            candidates.push(row);
          }
          candidates.sort((a, b) => String(a.operation_id).localeCompare(String(b.operation_id)));
          const row = candidates[0];
          if (!row) return { rows: [] };
          locked.add(row.operation_id);
          row.state = 'claimed';
          row.lease_owner = owner;
          row.lease_expires_at = new Date(Date.now() + 15 * 60 * 1000);
          row.attempt_count += 1;
          return { rows: [cloneRow(row)] };
        }
        if (text === SQL_ATTEMPT_CAP) {
          const targeted = params[0];
          const owner = params[1];
          const row = byOp.get(targeted);
          if (!row || row.lease_owner !== owner || !capable(row) || locked.has(row.operation_id)) return { rows: [] };
          locked.add(row.operation_id);
          row.state = 'handoff_required';
          row.lease_owner = null;
          row.lease_expires_at = null;
          return { rows: [cloneRow(row)] };
        }
        if (text === SQL_HANDOFF) {
          const row = byOp.get(params[0]);
          if (!row || !liveOwner(row, params[1])) return { rows: [] };
          row.state = 'handed_off';
          row.handoff_id = crypto.randomUUID();
          row.lease_owner = null;
          row.lease_expires_at = null;
          return { rows: [cloneRow(row)] };
        }
        if (text === SQL_CANCEL_CLAIMED) {
          const row = byOp.get(params[0]);
          if (!row || !liveOwner(row, params[1])) return { rows: [] };
          row.state = 'cancelled';
          row.lease_owner = null;
          row.lease_expires_at = null;
          return { rows: [cloneRow(row)] };
        }
        if (text === SQL_REQUIRE_HANDOFF_CLAIMED) {
          const row = byOp.get(params[0]);
          if (!row || !liveOwner(row, params[1])) return { rows: [] };
          row.state = 'handoff_required';
          row.lease_owner = null;
          row.lease_expires_at = null;
          return { rows: [cloneRow(row)] };
        }
        throw new Error('unexpected_sql');
      },
    };
    try {
      const result = await work(client);
      locked.clear();
      snapshots.pop();
      return result;
    } catch (error) {
      restore(snapshots.pop());
      locked.clear();
      rollback = true;
      throw error;
    }
  }
  return {
    withTransactionClient,
    byOp,
    byIssuance,
    audits,
    inserts,
    expire(operationId) {
      const row = byOp.get(operationId);
      if (row) row.lease_expires_at = new Date(Date.now() - 1000);
    },
    rolledBack: () => rollback,
  };
}
function seedAudit(db, triplet, auditOperationId = AUDIT_A) {
  const issuanceId = readEmailLunaDraftPolicyIssuanceIdentity(triplet.evidence);
  db.audits.set(issuanceId, {
    operation_id: auditOperationId,
    issuance_id: issuanceId,
    client_id: IDS.client_id,
    location_id: IDS.location_id,
    location_key: 'sunset-somo',
    endpoint_id: IDS.endpoint_id,
    conversation_id: IDS.conversation_id,
    inbound_event_id: IDS.inbound_message_id,
  });
  return auditOperationId;
}
function enqueueInput(bundle, patch = {}) {
  const value = {
    operation_id: OP_A,
    envelope: bundle.triplet.envelope,
    evidence: bundle.triplet.evidence,
    decision: bundle.triplet.decision,
    eligibility: bundle.eligibility,
    draft: bundle.draft,
    validation: bundle.validation,
  };
  return { ...value, ...patch };
}
function expectInvalid(fn, label) {
  let threw = false;
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      throw new Error(`${label}: expected sync throw`);
    }
  } catch (error) {
    threw = true;
    assert.equal(error && error.code, 'EMAIL_LUNA_AUTOMATION_QUEUE_INVALID', label);
    assert.equal(error && error.message, 'Email Luna automation queue failed.', label);
  }
  assert.equal(threw, true, label);
}
async function expectInvalidAsync(fn, label) {
  let threw = false;
  try {
    await fn();
  } catch (error) {
    threw = true;
    assert.equal(error && error.code, 'EMAIL_LUNA_AUTOMATION_QUEUE_INVALID', label);
    assert.equal(error && error.message, 'Email Luna automation queue failed.', label);
  }
  assert.equal(threw, true, label);
}
function assertRecord(record, expected) {
  assert.deepEqual(Object.keys(record), RECORD_KEYS.slice());
  assert.equal(Object.getPrototypeOf(record), null);
  assert.equal(Object.isFrozen(record), true);
  for (const key of FORBIDDEN_RECORD_KEYS) {
    assert.equal(Object.hasOwn(record, key), false, `record must not persist ${key}`);
  }
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(record[key], value, key);
  }
}

console.log('FULL SAIL Stage 1 NIGHTWATCH Ch3 Slice A automation queue verifier');

assert.equal(EMAIL_LUNA_AUTOMATION_QUEUE_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_AUTOMATION_QUEUE_LOGGING_FORBIDDEN, true);
assert.equal(EMAIL_LUNA_AUTOMATION_QUEUE_MAX_ATTEMPTS, 3);
assert.deepEqual(EMAIL_LUNA_AUTOMATION_QUEUE_STATES.slice(), STATES.slice());
assert.deepEqual(EMAIL_LUNA_AUTOMATION_QUEUE_RECORD_KEYS, RECORD_KEYS);
assert.deepEqual(Object.keys(queueModule).sort(), [
  'EMAIL_LUNA_AUTOMATION_QUEUE_GRANT_CONTRACT',
  'EMAIL_LUNA_AUTOMATION_QUEUE_LOGGING_FORBIDDEN',
  'EMAIL_LUNA_AUTOMATION_QUEUE_MAX_ATTEMPTS',
  'EMAIL_LUNA_AUTOMATION_QUEUE_RECORD_KEYS',
  'EMAIL_LUNA_AUTOMATION_QUEUE_RUNTIME_WIRED',
  'EMAIL_LUNA_AUTOMATION_QUEUE_STATES',
  'SQL_ATTEMPT_CAP',
  'SQL_CANCEL_CLAIMED',
  'SQL_CLAIM',
  'SQL_CLAIM_SCOPED',
  'SQL_ENQUEUE',
  'SQL_HANDOFF',
  'SQL_LOCK_AUDIT',
  'SQL_LOCK_ISSUANCE',
  'SQL_LOCK_OPERATION',
  'SQL_REQUIRE_HANDOFF_CLAIMED',
  'createEmailLunaAutomationQueueStore',
]);
assert.match(SQL_CLAIM, /tenant_email_luna_automation_claim\(/);
assert.match(SQL_CLAIM_SCOPED, /tenant_email_luna_automation_claim_scoped/);
assert.match(SQL_ATTEMPT_CAP, /tenant_email_luna_automation_terminalize_attempt_cap/);
assert.match(SQL_ENQUEUE, /tenant_email_luna_automation_enqueue/);
assert.match(SQL_HANDOFF, /tenant_email_luna_automation_handoff/);
assert.match(SQL_LOCK_AUDIT, /tenant_email_luna_policy_audit/);
assert.match(SQL_LOCK_OPERATION, /FOR SHARE/);
assert.equal(/UPDATE tenant_email_luna_automation_queue/.test(SQL_CLAIM), false);
assert.equal(/INSERT INTO tenant_email_luna_automation_queue/.test(SQL_ENQUEUE), false);
assert.equal(/tenant_email_outbound_send_journal/.test(SQL_ENQUEUE), false);
assert.equal(EMAIL_LUNA_AUTOMATION_QUEUE_GRANT_CONTRACT.table, 'tenant_email_luna_automation_queue');
assert.equal(EMAIL_LUNA_AUTOMATION_QUEUE_GRANT_CONTRACT.trusted_schema, 'public');
assert.deepEqual(EMAIL_LUNA_AUTOMATION_QUEUE_GRANT_CONTRACT.search_path.slice(), ['pg_catalog', 'public']);
assert.equal(EMAIL_LUNA_AUTOMATION_QUEUE_GRANT_CONTRACT.function_owner, 'table_owner');
assert.deepEqual(EMAIL_LUNA_AUTOMATION_QUEUE_GRANT_CONTRACT.worker_table_denied.slice(), ['INSERT', 'UPDATE', 'DELETE']);
assert.deepEqual(EMAIL_LUNA_AUTOMATION_QUEUE_GRANT_CONTRACT.worker_execute_functions.slice(), [
  'tenant_email_luna_automation_enqueue',
  'tenant_email_luna_automation_claim',
  'tenant_email_luna_automation_cancel_claimed',
  'tenant_email_luna_automation_require_handoff_claimed',
  'tenant_email_luna_automation_handoff',
  'tenant_email_luna_automation_terminalize_attempt_cap',
]);
assert.deepEqual(EMAIL_LUNA_AUTOMATION_QUEUE_GRANT_CONTRACT.operator_execute_functions.slice(), [
  'tenant_email_luna_automation_cancel_pending',
  'tenant_email_luna_automation_require_handoff_pending',
]);
assert.equal(
  EMAIL_LUNA_AUTOMATION_QUEUE_GRANT_CONTRACT.worker_execute_functions.includes('tenant_email_luna_automation_cancel_pending'),
  false,
);
assert.equal(
  EMAIL_LUNA_AUTOMATION_QUEUE_GRANT_CONTRACT.worker_execute_functions.includes('tenant_email_luna_automation_require_handoff_pending'),
  false,
);
assert.equal(EMAIL_LUNA_AUTOMATION_QUEUE_GRANT_CONTRACT.no_custom_guc, true);
assert.equal(EMAIL_LUNA_AUTOMATION_QUEUE_GRANT_CONTRACT.no_synthetic_runtime_role_in_migration, true);
assert.equal(EMAIL_LUNA_AUTOMATION_QUEUE_GRANT_CONTRACT.no_grant_in_086, true);
assert.deepEqual(EMAIL_LUNA_AUTOMATION_QUEUE_GRANT_CONTRACT.scoped_claim_worker_execute_functions.slice(), [
  'tenant_email_luna_automation_claim_scoped',
]);
assert.equal(EMAIL_LUNA_AUTOMATION_QUEUE_GRANT_CONTRACT.no_grant_in_095, true);
assert.equal(EMAIL_LUNA_AUTOMATION_QUEUE_GRANT_CONTRACT.no_create_role_in_095, true);
assert.match(SQL_ATTEMPT_CAP, /tenant_email_luna_automation_terminalize_attempt_cap\(\$1::uuid, \$2::uuid\)/);
assert.match(SQL_LOCK_AUDIT, /inbound_event_id/);
console.log('  PASS  store remains import-inert with a closed claim/enqueue surface');

async function main() {
  const ready = issue();
  assert.equal(ready.decision.status, 'draft_ready');
  const bundle = await validBundle({ triplet: ready });
  assert.equal(bundle.eligibility.status, 'eligible');
  assert.equal(bundle.draft.status, 'draft_ready');
  assert.equal(bundle.validation.status, 'valid');
  const digest = expectedDigest(bundle.draft);
  assert.match(digest, /^[0-9a-f]{64}$/);

  const db = createMemoryQueueDb();
  seedAudit(db, ready);
  const store = createEmailLunaAutomationQueueStore({ withTransactionClient: db.withTransactionClient });
  const first = await store.enqueueAutomationOperation(enqueueInput(bundle));
  assert.equal(first.status, 'committed');
  assertRecord(first.record, {
    operation_id: OP_A,
    issuance_id: readEmailLunaDraftPolicyIssuanceIdentity(ready.evidence),
    audit_operation_id: AUDIT_A,
    client_id: IDS.client_id,
    location_id: IDS.location_id,
    location_key: 'sunset-somo',
    endpoint_id: IDS.endpoint_id,
    conversation_id: IDS.conversation_id,
    inbound_event_id: IDS.inbound_message_id,
    recipient_address: 'elena@example.test',
    policy_version: EMAIL_LUNA_DRAFT_POLICY_VERSION,
    eligibility_policy_version: EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_POLICY_VERSION,
    validator_version: EMAIL_LUNA_DRAFT_VALIDATOR_VERSION,
    draft_digest: digest,
    state: 'pending',
    attempt_count: 0,
    lease_owner: null,
    handoff_id: null,
  });
  assert.equal(db.inserts.length, 1);
  const insertText = JSON.stringify(db.inserts[0]);
  assert.equal(insertText.includes('Surfboard rental'), false);
  assert.equal(insertText.includes(bundle.draft.body), false);
  assert.equal(insertText.includes('How much is a surf lesson'), false);
  assert.equal(insertText.includes('4500'), false);
  console.log('  PASS  valid eligible enqueue binds authority, recipient, digest, and audit identity');

  const replay = await store.enqueueAutomationOperation(enqueueInput(bundle));
  assert.equal(replay.status, 'replayed');
  assert.deepEqual(replay.record, first.record);
  assert.equal(db.inserts.length, 1);
  console.log('  PASS  exact authenticated input replay is an idempotent no-op');

  const other = issue();
  const otherBundle = await validBundle({ triplet: other });
  const otherDb = createMemoryQueueDb();
  seedAudit(otherDb, ready);
  seedAudit(otherDb, other, 'ffffffff-ffff-4fff-8fff-ffffffffffff');
  const conflictStore = createEmailLunaAutomationQueueStore({ withTransactionClient: otherDb.withTransactionClient });
  await conflictStore.enqueueAutomationOperation(enqueueInput(bundle));
  const conflict = await conflictStore.enqueueAutomationOperation(enqueueInput(otherBundle));
  assert.equal(conflict.status, 'conflict');
  assert.equal(Object.hasOwn(conflict, 'record'), false);
  const issuanceConflict = await conflictStore.enqueueAutomationOperation(enqueueInput(bundle, { operation_id: OP_B }));
  assert.equal(issuanceConflict.status, 'conflict');
  console.log('  PASS  conflicting operation or source issuance identity fails closed');

  await expectInvalidAsync(
    () => store.enqueueAutomationOperation(enqueueInput(bundle, { client_id: OTHER.client_id })),
    'caller tenant',
  );
  await expectInvalidAsync(
    () => store.enqueueAutomationOperation(enqueueInput(bundle, { location_id: OTHER.location_id })),
    'caller location',
  );
  await expectInvalidAsync(
    () => store.enqueueAutomationOperation(enqueueInput(bundle, { endpoint_id: OTHER.endpoint_id })),
    'caller endpoint',
  );
  await expectInvalidAsync(
    () => store.enqueueAutomationOperation(enqueueInput(bundle, { conversation_id: OTHER.conversation_id })),
    'caller conversation',
  );
  await expectInvalidAsync(
    () => store.enqueueAutomationOperation(enqueueInput(bundle, { recipient_address: 'attacker@evil.test' })),
    'caller recipient',
  );
  await expectInvalidAsync(
    () => store.enqueueAutomationOperation(enqueueInput(bundle, { provider: 'microsoft_graph' })),
    'caller provider',
  );
  await expectInvalidAsync(
    () => store.enqueueAutomationOperation(enqueueInput(bundle, { send_allowed: true })),
    'caller send capability',
  );
  const cross = issue({
    authorityPatch: { conversation_id: OTHER.conversation_id },
    evidencePatch: { conversation_id: OTHER.conversation_id },
  });
  const crossElig = decideEmailLunaAutonomousEligibility(cross);
  await expectInvalidAsync(
    () => store.enqueueAutomationOperation(enqueueInput(bundle, { eligibility: crossElig })),
    'cross conversation eligibility',
  );
  const mixedRecipient = issue({ contentPatch: { from_address: 'other.guest@example.test' } });
  const mixedBundle = await validBundle({ triplet: mixedRecipient });
  const mixedDb = createMemoryQueueDb();
  seedAudit(mixedDb, ready);
  const mixedStore = createEmailLunaAutomationQueueStore({ withTransactionClient: mixedDb.withTransactionClient });
  await mixedStore.enqueueAutomationOperation(enqueueInput(bundle));
  const mixedConflict = await mixedStore.enqueueAutomationOperation(enqueueInput(mixedBundle));
  assert.equal(mixedConflict.status, 'conflict');
  console.log('  PASS  caller/model cannot select tenant, location, endpoint, conversation, recipient, or provider');

  const states = await store.claimAutomationOperation({ owner_token: OWNER_A, operation_id: OP_A });
  assert.equal(states.status, 'claimed');
  assert.equal(states.record.state, 'claimed');
  assert.equal(states.record.lease_owner, OWNER_A);
  assert.equal(states.record.attempt_count, 1);
  assert.equal(states.record.handoff_id, null);
  const secondClaim = await store.claimAutomationOperation({ owner_token: OWNER_B, operation_id: OP_A });
  assert.equal(secondClaim.status, 'conflict');
  console.log('  PASS  exact pending/claimed states; live lease refuses a second claim');

  const concurrentDb = createMemoryQueueDb();
  seedAudit(concurrentDb, ready);
  const concurrentStore = createEmailLunaAutomationQueueStore({
    withTransactionClient: concurrentDb.withTransactionClient,
  });
  await concurrentStore.enqueueAutomationOperation(enqueueInput(bundle));
  const [left, right] = await Promise.all([
    concurrentStore.claimAutomationOperation({ owner_token: OWNER_A }),
    concurrentStore.claimAutomationOperation({ owner_token: OWNER_B }),
  ]);
  const winners = [left, right].filter((result) => result.status === 'claimed');
  const losers = [left, right].filter((result) => result.status !== 'claimed');
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].status, 'empty');
  assert.equal(winners[0].record.attempt_count, 1);
  console.log('  PASS  concurrent claim produces exactly one claimed automation operation');

  concurrentDb.expire(OP_A);
  const staleHandoff = await concurrentStore.handOffAutomationOperation({
    operation_id: OP_A,
    owner_token: winners[0].record.lease_owner,
  });
  assert.equal(staleHandoff.status, 'conflict');
  const reclaim = await concurrentStore.claimAutomationOperation({ owner_token: OWNER_B, operation_id: OP_A });
  assert.equal(reclaim.status, 'claimed');
  assert.equal(reclaim.record.lease_owner, OWNER_B);
  assert.equal(reclaim.record.attempt_count, 2);
  console.log('  PASS  expired lease can be reclaimed; stale owner cannot hand off');

  concurrentDb.expire(OP_A);
  const third = await concurrentStore.claimAutomationOperation({ owner_token: OWNER_A, operation_id: OP_A });
  assert.equal(third.status, 'claimed');
  assert.equal(third.record.attempt_count, 3);
  concurrentDb.expire(OP_A);
  const otherOwnerCap = await concurrentStore.claimAutomationOperation({ owner_token: OWNER_B, operation_id: OP_A });
  assert.equal(otherOwnerCap.status, 'conflict');
  const capped = await concurrentStore.claimAutomationOperation({ owner_token: OWNER_A, operation_id: OP_A });
  assert.equal(capped.status, 'attempt_cap');
  assert.equal(capped.record.state, 'handoff_required');
  assert.equal(capped.record.lease_owner, null);
  const afterCap = await concurrentStore.claimAutomationOperation({ owner_token: OWNER_A, operation_id: OP_A });
  assert.equal(afterCap.status, 'conflict');
  console.log('  PASS  attempt cap requires matching lease owner; other workers cannot globally terminalize');

  const cancelDb = createMemoryQueueDb();
  seedAudit(cancelDb, ready);
  const cancelStore = createEmailLunaAutomationQueueStore({ withTransactionClient: cancelDb.withTransactionClient });
  await cancelStore.enqueueAutomationOperation(enqueueInput(bundle));
  expectInvalid(
    () => cancelStore.cancelAutomationOperation({ operation_id: OP_A }),
    'pending cancel without owner is not on the worker store',
  );
  await cancelStore.claimAutomationOperation({ owner_token: OWNER_A, operation_id: OP_A });
  const cancelled = await cancelStore.cancelAutomationOperation({ operation_id: OP_A, owner_token: OWNER_A });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.record.state, 'cancelled');
  const cancelClaim = await cancelStore.claimAutomationOperation({ owner_token: OWNER_A, operation_id: OP_A });
  assert.equal(cancelClaim.status, 'conflict');
  const cancelAgain = await cancelStore.cancelAutomationOperation({ operation_id: OP_A, owner_token: OWNER_A });
  assert.equal(cancelAgain.status, 'conflict');
  const handoffDb = createMemoryQueueDb();
  seedAudit(handoffDb, ready);
  const handoffStore = createEmailLunaAutomationQueueStore({ withTransactionClient: handoffDb.withTransactionClient });
  await handoffStore.enqueueAutomationOperation(enqueueInput(bundle));
  await handoffStore.claimAutomationOperation({ owner_token: OWNER_A, operation_id: OP_A });
  const handed = await handoffStore.handOffAutomationOperation({ operation_id: OP_A, owner_token: OWNER_A });
  assert.equal(handed.status, 'handed_off');
  assert.equal(handed.record.state, 'handed_off');
  assert.match(handed.record.handoff_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(handed.record.lease_owner, null);
  const replayHandoff = await handoffStore.handOffAutomationOperation({ operation_id: OP_A, owner_token: OWNER_A });
  assert.equal(replayHandoff.status, 'conflict');
  assert.equal(handoffDb.byOp.get(OP_A).handoff_id, handed.record.handoff_id);
  const staleCancel = await handoffStore.cancelAutomationOperation({ operation_id: OP_A, owner_token: OWNER_A });
  assert.equal(staleCancel.status, 'conflict');
  console.log('  PASS  cancel and unique handoff are terminal; blind handoff replay cannot mint a second identity');

  const requireDb = createMemoryQueueDb();
  seedAudit(requireDb, ready);
  const requireStore = createEmailLunaAutomationQueueStore({ withTransactionClient: requireDb.withTransactionClient });
  await requireStore.enqueueAutomationOperation(enqueueInput(bundle));
  expectInvalid(
    () => requireStore.requireHandoffAutomationOperation({ operation_id: OP_A }),
    'pending require-handoff without owner is not on the worker store',
  );
  await requireStore.claimAutomationOperation({ owner_token: OWNER_A, operation_id: OP_A });
  const required = await requireStore.requireHandoffAutomationOperation({ operation_id: OP_A, owner_token: OWNER_A });
  assert.equal(required.status, 'handoff_required');
  assert.equal(required.record.state, 'handoff_required');
  const requireClaim = await requireStore.claimAutomationOperation({ owner_token: OWNER_A, operation_id: OP_A });
  assert.equal(requireClaim.status, 'conflict');
  console.log('  PASS  owner-scoped handoff_required is terminal and never becomes a claimed automation operation');

  expectInvalid(
    () => createEmailLunaAutomationQueueStore({ withTransactionClient: db.withTransactionClient, extra: true }),
    'extra store dep',
  );
  await expectInvalidAsync(
    () => store.enqueueAutomationOperation(enqueueInput(bundle, { subject: 'leak' })),
    'extra subject',
  );
  await expectInvalidAsync(
    () => store.enqueueAutomationOperation(enqueueInput(bundle, { body_text: 'leak' })),
    'extra body',
  );
  await expectInvalidAsync(
    () => store.enqueueAutomationOperation(enqueueInput(bundle, { access_token: 'secret' })),
    'credential',
  );
  await expectInvalidAsync(
    () => store.enqueueAutomationOperation(enqueueInput(bundle, { payment_url: 'https://pay.example/secret' })),
    'payment url',
  );
  await expectInvalidAsync(
    () => store.enqueueAutomationOperation(enqueueInput(bundle, { prompt: 'system' })),
    'prompt',
  );
  const ineligible = issue({ evidencePatch: { identity: 'ambiguous' } });
  const ineligibleElig = decideEmailLunaAutonomousEligibility(ineligible);
  assert.equal(ineligibleElig.status, 'handoff_required');
  await expectInvalidAsync(
    () => store.enqueueAutomationOperation(enqueueInput(bundle, {
      envelope: ineligible.envelope,
      evidence: ineligible.evidence,
      decision: ineligible.decision,
      eligibility: ineligibleElig,
    })),
    'ineligible decision',
  );
  const unissued = {
    envelope: ready.envelope,
    evidence: createEmailLunaDraftPolicyEvidence(evidence()),
    decision: ready.decision,
  };
  await expectInvalidAsync(
    () => store.enqueueAutomationOperation({
      operation_id: OP_B,
      envelope: unissued.envelope,
      evidence: unissued.evidence,
      decision: unissued.decision,
      eligibility: bundle.eligibility,
      draft: bundle.draft,
      validation: bundle.validation,
    }),
    'unissued evidence',
  );
  console.log('  PASS  enqueue requires authentic eligible issuance, draft, validation, and rejects sensitive fields');

  const missingAuditDb = createMemoryQueueDb();
  const missingAuditStore = createEmailLunaAutomationQueueStore({
    withTransactionClient: missingAuditDb.withTransactionClient,
  });
  await expectInvalidAsync(
    () => missingAuditStore.enqueueAutomationOperation(enqueueInput(bundle)),
    'missing audit',
  );
  console.log('  PASS  enqueue fails closed without authentic policy audit identity');

  const inboundMismatchDb = createMemoryQueueDb();
  seedAudit(inboundMismatchDb, ready);
  const mismatchIssuance = readEmailLunaDraftPolicyIssuanceIdentity(ready.evidence);
  inboundMismatchDb.audits.get(mismatchIssuance).inbound_event_id = '55555555-5555-4555-8555-555555555557';
  const inboundMismatchStore = createEmailLunaAutomationQueueStore({
    withTransactionClient: inboundMismatchDb.withTransactionClient,
  });
  await expectInvalidAsync(
    () => inboundMismatchStore.enqueueAutomationOperation(enqueueInput(bundle)),
    'same-authority different inbound audit binding',
  );
  console.log('  PASS  enqueue refuses same-authority audit bound to a different inbound_event_id');

  const rollDb = createMemoryQueueDb();
  seedAudit(rollDb, ready);
  let inner;
  const wrapping = {
    async withTransactionClient(work) {
      return rollDb.withTransactionClient(async (client) => {
        inner = client;
        const result = await work(client);
        const error = new Error('boom');
        error.code = 'TEST_ROLLBACK';
        throw error;
      });
    },
  };
  const rollStore = createEmailLunaAutomationQueueStore(wrapping);
  await assert.rejects(() => rollStore.enqueueAutomationOperation(enqueueInput(bundle)), (error) => {
    assert.equal(error && error.code, 'TEST_ROLLBACK');
    return true;
  });
  assert.equal(rollDb.byOp.size, 0);
  assert.equal(typeof inner.query, 'function');
  console.log('  PASS  transaction rollback does not persist a queue row');

  const storeSrc = fs.readFileSync(STORE_PATH, 'utf8');
  assert.equal(EMAIL_LUNA_AUTOMATION_QUEUE_RUNTIME_WIRED, false);
  assert.equal(/tenant_email_outbound_send_journal/.test(storeSrc), false);
  assert.equal(/createReply|sendMail|microsoft-graph|googleapis/.test(storeSrc), false);
  assert.equal(/EMAIL_LUNA_AUTOMATION_QUEUE_RUNTIME_WIRED\s*=\s*true/.test(storeSrc), false);
  assert.equal(/\bDate\.now\b/.test(storeSrc), false);
  assert.equal(/\bpg\.Pool\b|\bnew Pool\b|\bnet\.connect\b/.test(storeSrc), false);
  assert.equal(/INSERT INTO tenant_email_luna_automation_queue/.test(storeSrc), false);
  assert.equal(/UPDATE tenant_email_luna_automation_queue/.test(storeSrc), false);
  assert.equal(/current_setting\s*\(/.test(storeSrc), false);
  const compositionSrc = fs.readFileSync(require.resolve('./lib/email-luna-draft-open-policy-composition'), 'utf8');
  assert.equal(/email-luna-automation-queue-store/.test(compositionSrc), false);
  const runtimeSrc = fs.readFileSync(require.resolve('./lib/email-luna-sunset-staging-runtime-composition'), 'utf8');
  assert.equal(/email-luna-automation-queue-store/.test(runtimeSrc), false);
  const sqlSrc = fs.readFileSync(SQL_PATH, 'utf8');
  const downSrc = fs.readFileSync(DOWN_PATH, 'utf8');
  assert.match(sqlSrc, /CREATE TABLE public\.tenant_email_luna_automation_queue/);
  assert.match(sqlSrc, /NOT a second outbound send journal/);
  assert.match(sqlSrc, /tenant_email_luna_policy_audit_authority_identity_uq/);
  assert.match(sqlSrc, /tenant_email_inbound_events_luna_recipient_authority_uq/);
  assert.match(sqlSrc, /tenant_email_inbound_inbox_projections_luna_authority_uq/);
  assert.match(sqlSrc, /inbound_message_id is tenant_email_inbound_inbox_projections.inbound_event_id/);
  assert.match(sqlSrc, /inbound_event_id UUID NULL/);
  assert.match(sqlSrc, /UNIQUE \(operation_id, issuance_id, client_id, location_id, location_key, endpoint_id, conversation_id, inbound_event_id\)/);
  assert.match(sqlSrc, /SECURITY DEFINER/);
  assert.match(sqlSrc, /SET search_path TO pg_catalog, public/);
  assert.equal(/SET search_path FROM CURRENT/.test(sqlSrc), false);
  assert.equal(/SET search_path TO[^;\n]*pg_temp/.test(sqlSrc), false);
  assert.match(sqlSrc, /INSERT INTO public\.tenant_email_luna_automation_queue/);
  assert.match(sqlSrc, /RETURNS SETOF public\.tenant_email_luna_automation_queue/);
  assert.match(sqlSrc, /pg_catalog\.now\(\)/);
  assert.match(sqlSrc, /pg_catalog\.gen_random_uuid\(\)/);
  assert.match(sqlSrc, /FOR UPDATE SKIP LOCKED/);
  assert.match(sqlSrc, /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.tenant_email_luna_automation_queue FROM PUBLIC/);
  assert.match(sqlSrc, /never granted to the ordinary automation worker/);
  assert.match(sqlSrc, /No global or null mutation/);
  assert.match(sqlSrc, /Function owner is the table\/migration owner/);
  assert.equal(/^\s*CREATE ROLE/m.test(sqlSrc), false);
  assert.equal(/^\s*GRANT /m.test(sqlSrc), false);
  assert.equal(/current_setting\s*\(/.test(sqlSrc), false);
  assert.equal(/CREATE TABLE tenant_email_outbound_send_journal/.test(sqlSrc), false);
  assert.equal(/jsonb/i.test(sqlSrc), false);
  assert.match(downSrc, /086_down_refused/);
  assert.match(downSrc, /tenant_email_luna_policy_audit_authority_identity_uq/);
  assert.match(downSrc, /sender_address_normalized/);
  assert.match(downSrc, /DROP COLUMN IF EXISTS inbound_event_id/);
  assert.match(downSrc, /relname = 'tenant_email_luna_automation_queue'/);
  assert.match(downSrc, /DROP FUNCTION IF EXISTS public\.tenant_email_luna_automation_terminalize_attempt_cap\(uuid, uuid\)/);
  console.log('  PASS  queue owner is send-inert, unwired, and not a second outbound journal');

  function mutantStore(label, mutate) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `email-luna-automation-queue-${label}-`));
    const mutantPath = path.join(root, 'email-luna-automation-queue-store.js');
    const source = fs.readFileSync(STORE_PATH, 'utf8');
    const mutated = mutate(source);
    assert.notEqual(mutated, source, `${label}: mutation must apply`);
    fs.writeFileSync(mutantPath, mutated);
    return mutantPath;
  }
  function loadMutant(mutantPath) {
    delete require.cache[mutantPath];
    const resolvedPolicy = require.resolve('./lib/email-luna-draft-policy');
    const resolvedElig = require.resolve('./lib/email-luna-autonomous-eligibility-policy');
    const resolvedAuthor = require.resolve('./lib/email-luna-draft-author');
    const resolvedValidator = require.resolve('./lib/email-luna-draft-validator');
    const Module = require('module');
    const original = Module._resolveFilename;
    Module._resolveFilename = function patched(request, parent, isMain, options) {
      if (parent && parent.filename === mutantPath) {
        if (request === './email-luna-draft-policy') return resolvedPolicy;
        if (request === './email-luna-autonomous-eligibility-policy') return resolvedElig;
        if (request === './email-luna-draft-author') return resolvedAuthor;
        if (request === './email-luna-draft-validator') return resolvedValidator;
      }
      return original.call(this, request, parent, isMain, options);
    };
    try {
      return require(mutantPath);
    } finally {
      Module._resolveFilename = original;
    }
  }

  {
    const skipBlock = 'FOR UPDATE SKIP LOCKED';
    assert.equal(sqlSrc.split(skipBlock).length - 1, 3);
    const mutantSql = sqlSrc.replaceAll(skipBlock, 'FOR UPDATE');
    assert.equal(mutantSql.split(skipBlock).length - 1, 0);
    console.log('  PASS  mutation removing SKIP LOCKED is observable on the claim SQL');
  }
  {
    const eligibleBlock = "if (eligibility.status !== 'eligible') throw invalid();";
    assert.equal(storeSrc.split(eligibleBlock).length - 1, 1);
    const mutantPath = mutantStore('eligible-guard', (source) => source.replace(eligibleBlock, 'if (false) throw invalid();'));
    const mutantSrc = fs.readFileSync(mutantPath, 'utf8');
    assert.equal(mutantSrc.includes(eligibleBlock), false);
    console.log('  PASS  mutation isolation kills the eligible-decision enqueue guard');
  }
  {
    const mutantPath = mutantStore('attempt-cap', (source) => source.replace(
      'const EMAIL_LUNA_AUTOMATION_QUEUE_MAX_ATTEMPTS = 3;',
      'const EMAIL_LUNA_AUTOMATION_QUEUE_MAX_ATTEMPTS = 4;',
    ));
    const mutant = loadMutant(mutantPath);
    assert.equal(mutant.EMAIL_LUNA_AUTOMATION_QUEUE_MAX_ATTEMPTS, 4);
    assert.equal(sqlSrc.split('attempt_count < 3').length - 1, 2);
    const mutantCap = sqlSrc.replaceAll('attempt_count < 3', 'attempt_count < 4');
    assert.notEqual(mutantCap, sqlSrc);
    console.log('  PASS  mutation isolation kills the attempt-cap SQL bound');
  }

  console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch3 Slice A automation queue');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

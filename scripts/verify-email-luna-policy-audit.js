'use strict';
/** FULL SAIL Stage 1 NIGHTWATCH Chapter 1 Slice C: deterministic policy audit record. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const auditModule = require('./lib/email-luna-policy-audit-store');
const { createEmailLunaDraftEnvelope } = require('./lib/email-luna-draft-handoff-contract');
const {
  createEmailLunaDraftPolicyEvidence,
  decideEmailLunaDraftPolicy,
  issueAndDecideEmailLunaDraftPolicy,
  assertEmailLunaDraftPolicyIssuance,
  readEmailLunaDraftPolicyIssuanceIdentity,
  EMAIL_LUNA_DRAFT_POLICY_VERSION,
  EMAIL_LUNA_DRAFT_POLICY_HANDOFF_REASONS,
} = require('./lib/email-luna-draft-policy');
const {
  decideEmailLunaAutonomousEligibility,
  EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_POLICY_VERSION,
  EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_HANDOFF_REASONS,
} = require('./lib/email-luna-autonomous-eligibility-policy');
const {
  createEmailLunaPolicyAuditStore,
  EMAIL_LUNA_POLICY_AUDIT_RUNTIME_WIRED,
  EMAIL_LUNA_POLICY_AUDIT_LOGGING_FORBIDDEN,
  EMAIL_LUNA_POLICY_AUDIT_RECORD_KEYS,
  SQL_LOCK_OPERATION,
  SQL_LOCK_ISSUANCE,
  SQL_INSERT,
} = auditModule;

const IDS = Object.freeze({
  client_id: '11111111-1111-4111-8111-111111111111',
  location_id: '22222222-2222-4222-8222-222222222222',
  conversation_id: '33333333-3333-4333-8333-333333333333',
  endpoint_id: '44444444-4444-4444-8444-444444444444',
  inbound_message_id: '55555555-5555-4555-8555-555555555555',
});
const OTHER_CLIENT = '99999999-9999-4999-8999-999999999999';
const OTHER_LOCATION = '66666666-6666-4666-8666-666666666666';
const OP_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OP_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RECORD_KEYS = Object.freeze([
  'operation_id',
  'issuance_id',
  'client_id',
  'location_id',
  'location_key',
  'endpoint_id',
  'conversation_id',
  'policy_version',
  'eligibility_policy_version',
  'canonical_status',
  'canonical_reason',
  'eligibility_status',
  'eligibility_reason',
  'fact_refs',
]);
const FORBIDDEN_RECORD_KEYS = Object.freeze([
  'subject', 'body_text', 'quoted_history', 'from_address', 'from_display_name',
  'password', 'secret', 'access_token', 'refresh_token', 'payment_url',
  'prompt', 'capabilities', 'provider_message_id', 'provider_mailbox_id',
  'grounded_results', 'policy_text', 'amount_cents', 'message_text', 'draft_text',
  'auto_send_allowed', 'send_allowed', 'recipient', 'model',
]);
const STORE_PATH = require.resolve('./lib/email-luna-policy-audit-store');
const POLICY_PATH = require.resolve('./lib/email-luna-draft-policy');
const AUTONOMOUS_PATH = require.resolve('./lib/email-luna-autonomous-eligibility-policy');
const SQL_PATH = path.join(__dirname, '..', 'database/migrations/085_tenant_email_luna_policy_audit.sql');
const SAFE_FACT_REFS = Object.freeze(['catalog', 'availability', 'policy', 'booking', 'payment']);

function frozen(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozen));
  if (value && typeof value !== 'object') return value;
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
    catalog: { item: 'lesson', label: 'Surf lesson', currency: 'EUR', amount_cents: 4500, active: true },
    availability: { item: 'lesson', label: 'Morning lesson', date: '2026-08-12', slot_time: '09:00', available: true, capacity: 4 },
    policy: { label: 'House policy', policy_key: 'check_in', policy_text: 'Check-in is from 15:00.' },
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
function cloneRow(row) {
  const copy = Object.create(null);
  for (const key of RECORD_KEYS) copy[key] = key === 'fact_refs' ? row[key].slice() : row[key];
  return copy;
}
function createMemoryAuditDb() {
  const byOp = new Map();
  const byIssuance = new Map();
  const inserts = [];
  async function withTransactionClient(work) {
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
        if (text === SQL_INSERT) {
          const row = Object.create(null);
          const keys = RECORD_KEYS;
          for (let index = 0; index < keys.length; index += 1) {
            const key = keys[index];
            row[key] = key === 'fact_refs' ? params[index].slice() : params[index];
          }
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
        throw new Error('unexpected_sql');
      },
    };
    return work(client);
  }
  return { withTransactionClient, byOp, byIssuance, inserts };
}

function persistInput(triplet, patch = {}) {
  const value = {
    operation_id: OP_A,
    envelope: triplet.envelope,
    evidence: triplet.evidence,
    decision: triplet.decision,
    eligibility: Object.hasOwn(patch, 'eligibility')
      ? patch.eligibility
      : decideEmailLunaAutonomousEligibility(triplet),
  };
  return { ...value, ...patch };
}

function expectInvalid(fn, label) {
  assert.throws(fn, (error) => {
    assert.equal(error && error.code, 'EMAIL_LUNA_POLICY_AUDIT_INVALID', label);
    assert.equal(error && error.message, 'Email Luna policy audit failed.', label);
    return true;
  }, label);
}

function assertRecord(record, expected) {
  assert.deepEqual(Object.keys(record), RECORD_KEYS.slice());
  assert.equal(Object.getPrototypeOf(record), null);
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record.fact_refs), true);
  for (const key of FORBIDDEN_RECORD_KEYS) {
    assert.equal(Object.hasOwn(record, key), false, `record must not persist ${key}`);
  }
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'fact_refs') assert.deepEqual(record.fact_refs, value);
    else assert.equal(record[key], value, key);
  }
}

console.log('FULL SAIL Stage 1 NIGHTWATCH Ch1 Slice C deterministic policy audit verifier');

assert.equal(EMAIL_LUNA_POLICY_AUDIT_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_POLICY_AUDIT_LOGGING_FORBIDDEN, true);
assert.deepEqual(Object.keys(auditModule).sort(), [
  'EMAIL_LUNA_POLICY_AUDIT_LOGGING_FORBIDDEN',
  'EMAIL_LUNA_POLICY_AUDIT_RECORD_KEYS',
  'EMAIL_LUNA_POLICY_AUDIT_RUNTIME_WIRED',
  'SQL_INSERT',
  'SQL_LOCK_ISSUANCE',
  'SQL_LOCK_OPERATION',
  'createEmailLunaPolicyAuditStore',
]);
assert.deepEqual(EMAIL_LUNA_POLICY_AUDIT_RECORD_KEYS, RECORD_KEYS);
assert.equal(EMAIL_LUNA_DRAFT_POLICY_VERSION, 'email-luna-draft-policy.v1');
assert.equal(EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_POLICY_VERSION, 'email-luna-autonomous-eligibility-policy.v1');
assert.equal(typeof readEmailLunaDraftPolicyIssuanceIdentity, 'function');
console.log('  PASS  store remains import-inert and exports a closed persist surface');

const ready = issue();
assert.equal(ready.decision.status, 'draft_ready');
assertEmailLunaDraftPolicyIssuance(ready);
const issuanceId = readEmailLunaDraftPolicyIssuanceIdentity(ready.evidence);
assert.match(issuanceId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
assert.equal(readEmailLunaDraftPolicyIssuanceIdentity(ready.decision), issuanceId);
assert.throws(
  () => readEmailLunaDraftPolicyIssuanceIdentity(createEmailLunaDraftPolicyEvidence(evidence())),
  (error) => error && error.code === 'EMAIL_LUNA_DRAFT_POLICY_INVALID',
);
const laterDecide = decideEmailLunaDraftPolicy({ envelope: ready.envelope, evidence: ready.evidence });
assert.equal(laterDecide.status, 'handoff_required');
assert.throws(
  () => readEmailLunaDraftPolicyIssuanceIdentity(laterDecide),
  (error) => error && error.code === 'EMAIL_LUNA_DRAFT_POLICY_INVALID',
);
console.log('  PASS  canonical issue-and-decide mints a private non-secret issuance surrogate');

async function main() {
const db = createMemoryAuditDb();
const store = createEmailLunaPolicyAuditStore({ withTransactionClient: db.withTransactionClient });
const readyInput = persistInput(ready);
assert.equal(readyInput.eligibility.status, 'eligible');
const committed = await store.persistPolicyAudit(readyInput);
assert.equal(committed.status, 'committed');
assertRecord(committed.record, {
  operation_id: OP_A,
  issuance_id: issuanceId,
  client_id: IDS.client_id,
  location_id: IDS.location_id,
  location_key: 'sunset-somo',
  endpoint_id: IDS.endpoint_id,
  conversation_id: IDS.conversation_id,
  policy_version: EMAIL_LUNA_DRAFT_POLICY_VERSION,
  eligibility_policy_version: EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_POLICY_VERSION,
  canonical_status: 'draft_ready',
  canonical_reason: null,
  eligibility_status: 'eligible',
  eligibility_reason: null,
  fact_refs: ['catalog'],
});
assert.equal(db.inserts.length, 1);
const insertText = JSON.stringify(db.inserts[0]);
assert.equal(insertText.includes('Surf lesson'), false);
assert.equal(insertText.includes('4500'), false);
assert.equal(insertText.includes('elena@example.test'), false);
assert.equal(insertText.includes('How much is a surf lesson'), false);
assert.equal(insertText.includes('Check-in is from 15:00'), false);
assert.equal(insertText.includes('https://'), false);
console.log('  PASS  authentic eligible projection persists a bounded content-free audit record');

const replay = await store.persistPolicyAudit(readyInput);
assert.equal(replay.status, 'replayed');
assert.deepEqual(replay.record, committed.record);
assert.equal(db.inserts.length, 1);
console.log('  PASS  same canonical issuance/decision replay idempotently no-ops');

const handoffTriplet = issue({ evidencePatch: { identity: 'ambiguous' } });
assert.equal(handoffTriplet.decision.status, 'handoff_required');
assert.equal(handoffTriplet.decision.reason, 'ambiguous_identity');
const handoffEligibility = decideEmailLunaAutonomousEligibility(handoffTriplet);
assert.equal(handoffEligibility.status, 'handoff_required');
assert.equal(handoffEligibility.reason, 'ambiguous_identity');
const handoffDb = createMemoryAuditDb();
const handoffStore = createEmailLunaPolicyAuditStore({ withTransactionClient: handoffDb.withTransactionClient });
const handoffCommitted = await handoffStore.persistPolicyAudit(persistInput(handoffTriplet, { operation_id: OP_B }));
assert.equal(handoffCommitted.status, 'committed');
assertRecord(handoffCommitted.record, {
  operation_id: OP_B,
  issuance_id: readEmailLunaDraftPolicyIssuanceIdentity(handoffTriplet.evidence),
  canonical_status: 'handoff_required',
  canonical_reason: 'ambiguous_identity',
  eligibility_status: 'handoff_required',
  eligibility_reason: 'ambiguous_identity',
  fact_refs: [],
});
assert.equal(EMAIL_LUNA_DRAFT_POLICY_HANDOFF_REASONS.includes(handoffCommitted.record.canonical_reason), true);
assert.equal(EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_HANDOFF_REASONS.includes(handoffCommitted.record.eligibility_reason), true);
console.log('  PASS  authentic handoff results are auditable without fact values');

const payment = issue({ evidencePatch: { intent: 'payment_status_question' } });
assert.equal(payment.decision.status, 'draft_ready');
const paymentEligibility = decideEmailLunaAutonomousEligibility(payment);
assert.equal(paymentEligibility.status, 'handoff_required');
assert.equal(paymentEligibility.reason, 'unsupported_intent');
const paymentDb = createMemoryAuditDb();
const paymentStore = createEmailLunaPolicyAuditStore({ withTransactionClient: paymentDb.withTransactionClient });
const paymentCommitted = await paymentStore.persistPolicyAudit(persistInput(payment, { operation_id: OP_A }));
assertRecord(paymentCommitted.record, {
  canonical_status: 'draft_ready',
  canonical_reason: null,
  eligibility_status: 'handoff_required',
  eligibility_reason: 'unsupported_intent',
  fact_refs: ['payment'],
});
assert.equal(JSON.stringify(paymentDb.inserts[0]).includes('partially_paid'), false);
console.log('  PASS  canonical draft_ready with eligibility handoff audits safe fact refs only');

const conflictDb = createMemoryAuditDb();
const conflictStore = createEmailLunaPolicyAuditStore({ withTransactionClient: conflictDb.withTransactionClient });
const conflictReady = persistInput(ready);
await conflictStore.persistPolicyAudit(conflictReady);
const other = issue();
const conflict = await conflictStore.persistPolicyAudit(persistInput(other));
assert.equal(conflict.status, 'conflict');
assert.equal(Object.hasOwn(conflict, 'record'), false);
assert.equal(conflictDb.inserts.length, 1);
const issuanceConflict = await conflictStore.persistPolicyAudit({ ...conflictReady, operation_id: OP_B });
assert.equal(issuanceConflict.status, 'conflict');
console.log('  PASS  conflicting authority or payload under the same operation/issuance identity fail closed');

expectInvalid(() => store.persistPolicyAudit(persistInput(ready, { subject: 'leak' })), 'extra subject');
expectInvalid(() => store.persistPolicyAudit(persistInput(ready, { body_text: 'leak' })), 'extra body');
expectInvalid(() => store.persistPolicyAudit(persistInput(ready, { access_token: 'secret' })), 'credential');
expectInvalid(() => store.persistPolicyAudit(persistInput(ready, { payment_url: 'https://pay.example/secret' })), 'payment url');
expectInvalid(() => store.persistPolicyAudit(persistInput(ready, { prompt: 'system' })), 'prompt');
expectInvalid(() => store.persistPolicyAudit(persistInput(ready, { capabilities: { send: true } })), 'capabilities');
expectInvalid(() => store.persistPolicyAudit(persistInput(ready, { provider_message_id: 'graph-1' })), 'provider id');
expectInvalid(() => store.persistPolicyAudit(persistInput(ready, { policy_version: 'v-attacker' })), 'caller policy version');
expectInvalid(() => store.persistPolicyAudit(persistInput(ready, { issuance_id: OP_B })), 'caller issuance identity');
expectInvalid(() => store.persistPolicyAudit(persistInput(ready, { grounded_results: { catalog: found('catalog') } })), 'full facts');
expectInvalid(() => store.persistPolicyAudit(persistInput(ready, { metadata: { foo: 1 } })), 'caller metadata');
expectInvalid(() => createEmailLunaPolicyAuditStore({ withTransactionClient: db.withTransactionClient, extra: true }), 'extra store dep');
const rebound = issue({ authorityPatch: { conversation_id: '88888888-8888-4888-8888-888888888888' } });
expectInvalid(
  () => store.persistPolicyAudit(persistInput(ready, {
    operation_id: crypto.randomUUID(),
    eligibility: decideEmailLunaAutonomousEligibility(rebound),
  })),
  'rebound eligibility conversation',
);
console.log('  PASS  credentials, guest content, fact values, prompts, capabilities, and caller metadata are rejected');

const unissued = {
  envelope: ready.envelope,
  evidence: createEmailLunaDraftPolicyEvidence(evidence()),
  decision: ready.decision,
};
expectInvalid(
  () => store.persistPolicyAudit({
    operation_id: OP_B,
    envelope: unissued.envelope,
    evidence: unissued.evidence,
    decision: unissued.decision,
    eligibility: readyInput.eligibility,
  }),
  'unissued evidence',
);
console.log('  PASS  persist requires authentic canonical issuance, not a lookalike triplet');

const storeSrc = fs.readFileSync(STORE_PATH, 'utf8');
const policySrc = fs.readFileSync(POLICY_PATH, 'utf8');
assert.equal(EMAIL_LUNA_POLICY_AUDIT_RUNTIME_WIRED, false);
assert.equal(/tenant_email_outbound_send_journal/.test(storeSrc), false);
assert.equal(/createReply|sendMail|microsoft-graph/.test(storeSrc), false);
assert.equal(/EMAIL_LUNA_POLICY_AUDIT_RUNTIME_WIRED\s*=\s*true/.test(storeSrc), false);
assert.equal(/\bqueueMicrotask\b/.test(storeSrc), false);
assert.equal(/\bDate\.now\b/.test(policySrc), false);
const compositionSrc = fs.readFileSync(require.resolve('./lib/email-luna-draft-open-policy-composition'), 'utf8');
assert.equal(/email-luna-policy-audit-store/.test(compositionSrc), false);
const runtimeSrc = fs.readFileSync(require.resolve('./lib/email-luna-sunset-staging-runtime-composition'), 'utf8');
assert.equal(/email-luna-policy-audit-store/.test(runtimeSrc), false);
console.log('  PASS  audit owner is send-inert and unwired from composition/runtime/send journal');

function occurrences(source, block) {
  return source.split(block).length - 1;
}

const FACTS_BLOCK = "const FACTS = objectFreeze(['catalog', 'availability', 'policy', 'booking', 'payment']);";
assert.equal(occurrences(storeSrc, FACTS_BLOCK), 1);
const sqlSrc = fs.readFileSync(SQL_PATH, 'utf8');
assert.match(sqlSrc, /CONSTRAINT tenant_email_luna_policy_audit_fact_refs_bounds CHECK/);
assert.match(sqlSrc, /fact_refs IS NOT NULL/);
assert.match(sqlSrc, /array_position\(fact_refs, NULL\) IS NULL/);
assert.match(sqlSrc, /cardinality\(fact_refs\) BETWEEN 0 AND 5/);
assert.match(sqlSrc, /AND fact_refs IN \(/);
function orderedFactRefSubsets() {
  const out = [];
  const n = SAFE_FACT_REFS.length;
  function choose(k, start, acc) {
    if (acc.length === k) {
      out.push(acc.slice());
      return;
    }
    for (let index = start; index < n; index += 1) {
      acc.push(SAFE_FACT_REFS[index]);
      choose(k, index + 1, acc);
      acc.pop();
    }
  }
  for (let k = 0; k <= n; k += 1) choose(k, 0, []);
  return out;
}
function arrayLiteral(elements) {
  const inner = elements.map((value) => `'${value}'`).join(', ');
  return `ARRAY[${inner}]::text[]`;
}
const subsets = orderedFactRefSubsets();
assert.equal(subsets.length, 32);
const inList = `AND fact_refs IN (\n${subsets.map((subset) => `      ${arrayLiteral(subset)}`).join(',\n')}\n    )`;
assert.equal(occurrences(sqlSrc, inList), 1);
assert.equal(occurrences(sqlSrc, '    AND array_position(fact_refs, NULL) IS NULL\n'), 1);
console.log('  PASS  SQL fact_refs CHECK pins uniqueness, canonical order, and null-element defense');

function replaceUnique(source, block, replacement, label) {
  assert.equal(occurrences(source, block), 1, `${label}: pinned source block must occur exactly once`);
  const mutated = source.replace(block, replacement);
  assert.notEqual(mutated, source, `${label}: mutation must apply`);
  return mutated;
}
function loadMutant(name, storeSource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `email-luna-policy-audit-${name}-`));
  const mutantPath = path.join(root, 'email-luna-policy-audit-store.js');
  const rewritten = storeSource
    .replace("require('./email-luna-draft-policy')", `require(${JSON.stringify(POLICY_PATH)})`)
    .replace("require('./email-luna-autonomous-eligibility-policy')", `require(${JSON.stringify(AUTONOMOUS_PATH)})`);
  assert.notEqual(rewritten, storeSource, `${name}: mutant must pin production policy owners`);
  fs.writeFileSync(mutantPath, rewritten, { flag: 'wx' });
  return require(mutantPath);
}

const VERSION_BLOCK = [
  'record.policy_version = DRAFT_POLICY_VERSION;',
  '  record.eligibility_policy_version = ELIGIBILITY_POLICY_VERSION;',
  '  if (record.policy_version !== DRAFT_POLICY_VERSION || record.eligibility_policy_version !== ELIGIBILITY_POLICY_VERSION) throw invalid();',
].join('\n');
const VERSION_MUTANT = [
  "record.policy_version = 'attacker-version';",
  '  record.eligibility_policy_version = ELIGIBILITY_POLICY_VERSION;',
].join('\n');
const REASON_BLOCK = [
  "record.eligibility_reason = eligibility.status === 'handoff_required' ? eligibility.reason : null;",
  "  if (record.eligibility_status === 'handoff_required' && !arrayIncludes(ELIGIBILITY_REASONS, record.eligibility_reason)) throw invalid();",
].join('\n');
const REASON_MUTANT = "record.eligibility_reason = 'auto_send_allowed';";
const ISSUANCE_BLOCK = [
  'const issuanceId = readEmailLunaDraftPolicyIssuanceIdentity(request.evidence);',
  '  if (readEmailLunaDraftPolicyIssuanceIdentity(request.decision) !== issuanceId) throw invalid();',
].join('\n');
const ISSUANCE_MUTANT = "const issuanceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';";
const FACT_BLOCK = 'record.fact_refs = canonicalFactRefs(trusted, request.decision);';
const FACT_MUTANT = "record.fact_refs = Object.freeze(['payment_url']);";
const TENANT_BLOCK = 'if (eligibility.client_id !== trusted.binding.client_id || eligibility.location_id !== trusted.binding.location_id || eligibility.conversation_id !== trusted.binding.conversation_id) throw invalid();';
const TENANT_MUTANT = 'void 0;';

async function expectMutationKilled(label, block, replacement, attack) {
  const mutant = loadMutant(label, replaceUnique(storeSrc, block, replacement, label));
  const mutantDb = createMemoryAuditDb();
  const mutantStore = mutant.createEmailLunaPolicyAuditStore({ withTransactionClient: mutantDb.withTransactionClient });
  let accepted = false;
  try {
    accepted = await attack(mutantStore, mutantDb) === true;
  } catch (error) {
    assert.notEqual(error && error.code, 'ERR_ASSERTION', `${label}: mutation helper must not throw assertion`);
  }
  assert.equal(accepted, true, `${label}: mutation must demonstrate the bypass so the pin is live`);
}

await expectMutationKilled('policy-version', VERSION_BLOCK, VERSION_MUTANT, async (mutantStore) => {
  const result = await mutantStore.persistPolicyAudit(persistInput(issue(), {
    operation_id: crypto.randomUUID(),
  }));
  return result.status === 'committed' && result.record.policy_version === 'attacker-version';
});
await expectMutationKilled('eligibility-reason', REASON_BLOCK, REASON_MUTANT, async (mutantStore) => {
  const triplet = issue({ evidencePatch: { identity: 'ambiguous' } });
  const result = await mutantStore.persistPolicyAudit(persistInput(triplet, { operation_id: crypto.randomUUID() }));
  return result.status === 'committed' && result.record.eligibility_reason === 'auto_send_allowed';
});
await expectMutationKilled('issuance-identity', ISSUANCE_BLOCK, ISSUANCE_MUTANT, async (mutantStore) => {
  const triplet = issue();
  const result = await mutantStore.persistPolicyAudit(persistInput(triplet, { operation_id: crypto.randomUUID() }));
  return result.status === 'committed' && result.record.issuance_id === OP_B;
});
await expectMutationKilled('fact-refs', FACT_BLOCK, FACT_MUTANT, async (mutantStore) => {
  const triplet = issue();
  const result = await mutantStore.persistPolicyAudit(persistInput(triplet, { operation_id: crypto.randomUUID() }));
  return result.status === 'committed' && result.record.fact_refs[0] === 'payment_url';
});
await expectMutationKilled('tenant-binding', TENANT_BLOCK, TENANT_MUTANT, async (mutantStore) => {
  const triplet = issue();
  const otherConv = issue({ authorityPatch: { conversation_id: '88888888-8888-4888-8888-888888888888' } });
  const result = await mutantStore.persistPolicyAudit(persistInput(triplet, {
    operation_id: crypto.randomUUID(),
    eligibility: decideEmailLunaAutonomousEligibility(otherConv),
  }));
  return result.status === 'committed';
});
assert.equal(occurrences(storeSrc, VERSION_BLOCK), 1);
assert.equal(occurrences(storeSrc, REASON_BLOCK), 1);
assert.equal(occurrences(storeSrc, ISSUANCE_BLOCK), 1);
assert.equal(occurrences(storeSrc, FACT_BLOCK), 1);
assert.equal(occurrences(storeSrc, TENANT_BLOCK), 1);
console.log('  PASS  mutation isolation pins policy version, reason, issuance identity, fact refs, and tenant binding');

assert.equal(OTHER_CLIENT.length, 36);
assert.equal(OTHER_LOCATION.length, 36);
console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch1 Slice C policy audit');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

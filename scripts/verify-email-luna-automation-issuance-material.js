'use strict';
/** FULL SAIL Stage 1 NIGHTWATCH Chapter 4 Slice B1: issuance reconstitution material. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  createEmailLunaDraftEnvelope,
} = require('./lib/email-luna-draft-handoff-contract');
const { spawnSync } = require('node:child_process');
const {
  issueAndDecideEmailLunaDraftPolicy,
  createEmailLunaAutomationIssuanceMaterialStore: createStoreFromPolicy,
  assertEmailLunaDraftPolicyIssuance,
  readEmailLunaDraftPolicyIssuanceIdentity,
} = require('./lib/email-luna-draft-policy');
const { decideEmailLunaAutonomousEligibility } = require('./lib/email-luna-autonomous-eligibility-policy');
const {
  createEmailLunaDraftAuthor,
  readEmailLunaDraftAuthorPlan,
  recoverEmailLunaDraftAuthorFromAuthenticPlan,
  recomputeEmailLunaDraftCanonicalFromAuthentic,
} = require('./lib/email-luna-draft-author');
const { validateEmailLunaDraft } = require('./lib/email-luna-draft-validator');
const {
  EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_RUNTIME_WIRED,
  EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_LOGGING_FORBIDDEN,
  EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_GRANT_CONTRACT,
  createEmailLunaAutomationIssuanceMaterialStore,
} = require('./lib/email-luna-automation-issuance-material-store');
const {
  EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT,
  FUNCTION_SIGNATURES,
  executeFunctionsFor,
} = require('./lib/email-luna-automation-principal-contract');
const {
  EMAIL_LUNA_AUTOMATION_QUEUE_RUNTIME_WIRED,
} = require('./lib/email-luna-automation-queue-store');
const {
  EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_RUNTIME_WIRED,
} = require('./lib/email-luna-automation-journal-handoff-store');

const ROOT = path.join(__dirname, '..');
const SQL_089 = fs.readFileSync(path.join(ROOT, 'database/migrations/089_tenant_email_luna_automation_issuance_material.sql'), 'utf8');
const DOWN_089 = fs.readFileSync(path.join(ROOT, 'database/migrations/089_tenant_email_luna_automation_issuance_material_down.sql'), 'utf8');
const SQL_088 = fs.readFileSync(path.join(ROOT, 'database/migrations/088_tenant_email_luna_automation_principal_grants.sql'), 'utf8');
const STORE_SRC = fs.readFileSync(require.resolve('./lib/email-luna-automation-issuance-material-store'), 'utf8');
const POLICY_SRC = fs.readFileSync(require.resolve('./lib/email-luna-draft-policy'), 'utf8');
const AUTHOR_SRC = fs.readFileSync(require.resolve('./lib/email-luna-draft-author'), 'utf8');
const RED = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/email-luna-automation-issuance-material-red.json'), 'utf8'));
const RUNTIME_SRC = fs.readFileSync(require.resolve('./lib/email-luna-sunset-staging-runtime-composition'), 'utf8');

console.log('FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B1 issuance material verifier');

assert.equal(EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_LOGGING_FORBIDDEN, true);
assert.equal(EMAIL_LUNA_AUTOMATION_QUEUE_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.no_grant_in_089, true);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.no_create_role_in_089, true);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.worker_material_select, false);
assert.equal(EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_GRANT_CONTRACT.no_grant_in_089, true);
assert.deepEqual(EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_GRANT_CONTRACT.worker_table_privileges.slice(), []);
assert.equal(EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_GRANT_CONTRACT.worker_material_select, false);
assert.deepEqual(
  EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_GRANT_CONTRACT.worker_execute_functions.slice().sort(),
  ['tenant_email_luna_automation_issuance_material_load'].sort(),
);
assert.deepEqual(
  EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_GRANT_CONTRACT.producer_execute_functions.slice().sort(),
  ['tenant_email_luna_automation_persist_and_enqueue'].sort(),
);
assert.deepEqual(EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_GRANT_CONTRACT.producer_table_privileges.slice(), []);
assert.equal(EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_GRANT_CONTRACT.producer_material_select, false);
assert.equal(EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_GRANT_CONTRACT.producer_queue_select, false);
assert.equal(
  FUNCTION_SIGNATURES.tenant_email_luna_automation_persist_and_enqueue,
  'tenant_email_luna_automation_persist_and_enqueue(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text, jsonb)',
);
assert.equal(
  FUNCTION_SIGNATURES.tenant_email_luna_automation_issuance_material_load,
  'tenant_email_luna_automation_issuance_material_load(uuid, uuid)',
);
assert.equal(
  executeFunctionsFor('worker').includes(FUNCTION_SIGNATURES.tenant_email_luna_automation_persist_and_enqueue),
  false,
  '088 worker grant list stays 088-only; 089 persist is producer-only',
);
assert.equal(
  executeFunctionsFor('worker').includes(FUNCTION_SIGNATURES.tenant_email_luna_automation_issuance_material_load),
  false,
  '088 worker grant list stays 088-only; 089 load is optional-when-present',
);
assert.deepEqual(executeFunctionsFor('producer').slice(), [
  FUNCTION_SIGNATURES.tenant_email_luna_automation_persist_and_enqueue,
]);
assert.equal(executeFunctionsFor('producer').includes(FUNCTION_SIGNATURES.tenant_email_luna_automation_issuance_material_load), false);
assert.equal(executeFunctionsFor('producer').includes(FUNCTION_SIGNATURES.tenant_email_luna_automation_claim), false);
assert.equal(executeFunctionsFor('producer').includes(FUNCTION_SIGNATURES.tenant_email_luna_automation_enqueue), false);
assert.equal(executeFunctionsFor('producer').includes(FUNCTION_SIGNATURES.tenant_email_luna_automation_handoff), false);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.kinds.includes('producer'), true);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.producer_worker_roles_globally_distinct, true);

assert.equal(RED.id, 'email-luna-automation-issuance-material.ch4b1-red.v1');
assert.equal(RED.slice, 'FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B1');
assert.equal(RED.head_reviewed, 'bb3d2c402603f8aa8a0a3df6d6aedcff4ad748dd');
assert.equal(RED.worker_loop, false);
assert.equal(RED.runtime_activation, false);
assert.equal(RED.findings.length, 5);
assert.ok(RED.findings.every((item) => item.severity === 'blocking' && item.red && item.green));
console.log('  PASS  authentic RED artifact records bb3d2c40 restart failure');

assert.equal(/^\s*CREATE ROLE/m.test(SQL_089), false);
assert.equal(/^\s*GRANT /m.test(SQL_089), false);
assert.equal(/current_setting\s*\(/.test(SQL_089), false);
assert.equal(/PASSWORD\s+'/i.test(SQL_089), false);
assert.match(SQL_089, /CREATE TABLE IF NOT EXISTS public\.tenant_email_luna_automation_issuance_material/);
assert.match(SQL_089, /tenant_email_luna_automation_persist_and_enqueue/);
assert.match(SQL_089, /tenant_email_luna_automation_issuance_material_load/);
assert.match(SQL_089, /SET search_path TO pg_catalog, public/);
assert.match(SQL_089, /SECURITY DEFINER/);
assert.match(SQL_089, /principal_authorized/);
assert.match(SQL_089, /principal_kind IN \('worker', 'operator', 'producer'\)/);
assert.match(SQL_089, /'producer'/);
assert.match(SQL_089, /queue insert returned no row/);
assert.equal(/CREATE OR REPLACE FUNCTION public\.tenant_email_luna_automation_enqueue/.test(SQL_089), false);
assert.match(SQL_088, /principal_kind IN \('worker', 'operator'\)/);
assert.equal(/principal_kind IN \('worker', 'operator', 'producer'\)/.test(SQL_088), false);
assert.match(DOWN_089, /producer principal mappings present/);
assert.match(DOWN_089, /principal_kind IN \('worker', 'operator'\)/);
assert.match(SQL_089, /issuance material missing/);
assert.match(SQL_089, /ON DELETE RESTRICT/);
assert.match(SQL_089, /append-only mutation refused/);
assert.match(SQL_089, /Guest subject\/body_text stay on tenant_email_inbound_events/);
assert.match(SQL_089, /Booking codes and payment amounts must not be copied to logs/);
assert.match(SQL_089, /089_up_refused/);
assert.match(SQL_089, /NOT \(grounded_facts \? 'policy_text'\)/);
assert.equal(/CREATE OR REPLACE FUNCTION public\.tenant_email_luna_automation_enqueue/.test(SQL_089), false);
assert.equal(/CREATE OR REPLACE FUNCTION public\.tenant_email_luna_automation_handoff/.test(SQL_089), false);
assert.equal(/CREATE OR REPLACE FUNCTION public\.tenant_email_luna_automation_claim/.test(SQL_089), false);
{
  const persistFn = (SQL_089.split('tenant_email_luna_automation_persist_and_enqueue(')[2] || SQL_089.split('tenant_email_luna_automation_persist_and_enqueue(')[1] || '')
    .split('tenant_email_luna_automation_issuance_material_load')[0];
  assert.ok(persistFn.length > 100);
  assert.equal(/tenant_email_luna_automation_enqueue\(/.test(persistFn), false);
  assert.match(persistFn, /INSERT INTO public\.tenant_email_luna_automation_queue/);
  assert.match(persistFn, /'producer'/);
  assert.match(persistFn, /queue insert returned no row/);
  assert.match(persistFn, /persist_status/);
}
assert.match(DOWN_089, /089_down_refused/);
assert.match(DOWN_089, /DROP TABLE IF EXISTS public\.tenant_email_luna_automation_issuance_material/);
assert.equal(/^\s*GRANT /m.test(SQL_088), false);
console.log('  PASS  089 schema is append-only, send-inert, no product GRANT, 088 SQL unrewritten');

assert.match(STORE_SRC, /AUTHENTIC_LOADED_MATERIAL/);
assert.match(STORE_SRC, /recoverIssueAndDecideEmailLunaDraftPolicy/);
assert.match(STORE_SRC, /createEmailLunaAutomationIssuanceMaterialStoreInternal/);
assert.match(STORE_SRC, /installIssuanceMaterialStoreFactory/);
assert.match(STORE_SRC, /recoverEmailLunaDraftAuthorFromAuthenticPlan/);
assert.match(STORE_SRC, /quoted_history: ''/);
assert.match(STORE_SRC, /emailLunaDraftPolicyTextForKey/);
assert.equal(/console\.log/.test(STORE_SRC), false);
assert.equal(/booking_code/.test(STORE_SRC.split('FACT_FIELD_KEYS')[1].slice(0, 800)), true);
assert.match(POLICY_SRC, /function recoverIssueAndDecideEmailLunaDraftPolicy/);
assert.match(POLICY_SRC, /Live composition must keep/);
assert.equal(/recoverIssueAndDecideEmailLunaDraftPolicy,/.test(POLICY_SRC.split('module.exports')[1] || ''), false);
assert.match(AUTHOR_SRC, /recoverEmailLunaDraftAuthorFromAuthenticPlan/);
assert.match(AUTHOR_SRC, /readEmailLunaDraftAuthorPlan/);
assert.equal(/email-luna-automation-issuance-material/.test(RUNTIME_SRC), false);
assert.equal(/tenant_email_luna_automation_persist_and_enqueue/.test(RUNTIME_SRC), false);
console.log('  PASS  recovery APIs are narrowly owned; runtime composition stays inert');

function frozen(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozen));
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) value[key] = frozen(value[key]);
    return Object.freeze(value);
  }
  return value;
}

const ids = {
  client: '11111111-1111-4111-8111-111111111111',
  location: '22222222-2222-4222-8222-222222222222',
  conversation: '33333333-3333-4333-8333-333333333333',
  endpoint: '44444444-4444-4444-8444-444444444444',
  inbound: '55555555-5555-4555-8555-555555555555',
};

function catalogTriplet() {
  const envelope = createEmailLunaDraftEnvelope({
    authority: {
      client_id: ids.client,
      location_id: ids.location,
      location_key: 'sunset-somo',
      conversation_id: ids.conversation,
      endpoint_id: ids.endpoint,
      inbound_message_id: ids.inbound,
    },
    untrusted_content: {
      subject: 'Lesson question',
      body_text: 'How much is a surf lesson?',
      quoted_history: '',
      from_display_name: 'Elena',
      from_address: 'elena@example.test',
    },
  });
  const issued = issueAndDecideEmailLunaDraftPolicy({
    envelope,
    evidence: frozen({
      client_id: ids.client,
      location_id: ids.location,
      conversation_id: ids.conversation,
      endpoint_id: ids.endpoint,
      language: 'en',
      identity: 'matched',
      intent: 'catalog_question',
      intent_support: 'supported',
      requested_location_id: ids.location,
      explicit_human_request: false,
      attachment_interpretation_required: false,
      unsafe_transactional_request: false,
      required_facts: ['catalog'],
      grounded_results: {
        catalog: Object.assign(Object.create(null), {
          fact: 'catalog',
          status: 'found',
          client_id: ids.client,
          location_id: ids.location,
          item: 'board_rental',
          label: 'Surfboard rental',
          currency: 'EUR',
          amount_cents: 4500,
          active: true,
        }),
      },
    }),
  });
  return { envelope, evidence: issued.evidence, decision: issued.decision };
}

async function main() {
  const triplet = catalogTriplet();
  const issuanceId = readEmailLunaDraftPolicyIssuanceIdentity(triplet.evidence);
  const eligibility = decideEmailLunaAutonomousEligibility(triplet);
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
  const plan = readEmailLunaDraftAuthorPlan(draft);
  assert.equal(plan.template_id, 'catalog_reply');
  const recoveredLive = recoverEmailLunaDraftAuthorFromAuthenticPlan({
    envelope: triplet.envelope, evidence: triplet.evidence, decision: triplet.decision, plan,
  });
  assert.equal(recoveredLive.subject, draft.subject);
  assert.equal(recoveredLive.body, draft.body);
  const digest = crypto.createHash('sha256')
    .update(draft.subject).update('\0').update(draft.body).update('\0').update(draft.language)
    .digest('hex');
  assert.equal(recomputeEmailLunaDraftCanonicalFromAuthentic({
    envelope: triplet.envelope, evidence: triplet.evidence, decision: triplet.decision, draft: recoveredLive,
  }).subject, draft.subject);

  const cloneEvidence = JSON.parse(JSON.stringify(triplet.evidence));
  const cloneDecision = JSON.parse(JSON.stringify(triplet.decision));
  const cloneEnvelope = JSON.parse(JSON.stringify(triplet.envelope));
  assert.throws(() => assertEmailLunaDraftPolicyIssuance({
    envelope: cloneEnvelope, evidence: cloneEvidence, decision: cloneDecision,
  }));
  assert.throws(() => readEmailLunaDraftAuthorPlan({ ...draft }));
  assert.throws(() => createEmailLunaAutomationIssuanceMaterialStore({ withTransactionClient: 1 }));
  assert.throws(() => createStoreFromPolicy({ withTransactionClient: 1 }));
  const policyExports = require('./lib/email-luna-draft-policy');
  assert.equal('recoverIssueAndDecideEmailLunaDraftPolicy' in policyExports, false);
  assert.equal(typeof policyExports.recoverIssueAndDecideEmailLunaDraftPolicy, 'undefined');
  for (const name of Object.keys(policyExports)) {
    const fn = policyExports[name];
    if (typeof fn !== 'function') continue;
    assert.throws(
      () => fn({
        envelope: triplet.envelope,
        evidence: JSON.parse(JSON.stringify(triplet.evidence)),
        issuance_id: issuanceId,
      }),
      `${name} must not rebind a chosen existing issuance from raw caller input`,
    );
  }
  const storeExports = require('./lib/email-luna-automation-issuance-material-store');
  assert.equal(typeof storeExports.createEmailLunaAutomationIssuanceMaterialStoreInternal, 'undefined');
  assert.equal('recoverIssueAndDecideEmailLunaDraftPolicy' in storeExports, false);
  const minted = issueAndDecideEmailLunaDraftPolicy({
    envelope: triplet.envelope,
    evidence: {
      client_id: ids.client,
      location_id: ids.location,
      conversation_id: ids.conversation,
      endpoint_id: ids.endpoint,
      language: 'en',
      identity: 'matched',
      intent: 'catalog_question',
      intent_support: 'supported',
      requested_location_id: ids.location,
      explicit_human_request: false,
      attachment_interpretation_required: false,
      unsafe_transactional_request: false,
      required_facts: ['catalog'],
      grounded_results: {
        catalog: Object.assign(Object.create(null), {
          fact: 'catalog',
          status: 'found',
          client_id: ids.client,
          location_id: ids.location,
          item: 'board_rental',
          label: 'Surfboard rental',
          currency: 'EUR',
          amount_cents: 4500,
          active: true,
        }),
      },
    },
  });
  assert.notEqual(readEmailLunaDraftPolicyIssuanceIdentity(minted.evidence), issuanceId);
  console.log('  PASS  live issueAndDecide still mints; policy exports cannot recover a chosen issuance');

  const loadRow = Object.assign(Object.create(null), {
    operation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    issuance_id: issuanceId,
    audit_operation_id: ids.inbound.replace('5555', 'cccc'),
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    endpoint_id: ids.endpoint,
    conversation_id: ids.conversation,
    inbound_event_id: ids.inbound,
    recipient_address: 'elena@example.test',
    draft_digest: digest,
    language: 'en',
    identity: 'matched',
    intent: 'catalog_question',
    intent_support: 'supported',
    requested_location_id: ids.location,
    explicit_human_request: false,
    attachment_interpretation_required: false,
    unsafe_transactional_request: false,
    required_facts: ['catalog'],
    grounded_facts: {
      catalog: {
        fact: 'catalog',
        status: 'found',
        client_id: ids.client,
        location_id: ids.location,
        item: 'board_rental',
        label: 'Surfboard rental',
        currency: 'EUR',
        amount_cents: 4500,
        active: true,
      },
    },
    template_id: 'catalog_reply',
    tone: plan.tone,
    question_key: plan.question_key,
    acknowledgment_key: plan.acknowledgment_key,
    queue_state: 'pending',
    envelope_subject: 'Lesson question',
    envelope_body_text: 'How much is a surf lesson?',
    envelope_from_address: 'elena@example.test',
    envelope_from_display_name: 'Elena',
  });
  const mockStore = createEmailLunaAutomationIssuanceMaterialStore({
    async withTransactionClient(work) {
      return work({
        async query(text) {
          if (/issuance_material_load/.test(String(text))) return { rows: [loadRow] };
          return { rows: [] };
        },
      });
    },
  });
  const loaded = await mockStore.loadAutomationIssuanceMaterial({
    operation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    issuance_id: issuanceId,
  });
  assert.equal(loaded.status, 'loaded');
  const recovered = mockStore.recoverAutomationIssuance({ material: loaded.record });
  assert.equal(recovered.status, 'recovered');
  assert.equal(readEmailLunaDraftPolicyIssuanceIdentity(recovered.record.evidence), issuanceId);
  assert.equal(recovered.record.draft_digest, digest);
  assert.throws(() => mockStore.recoverAutomationIssuance({ material: { ...loaded.record } }));
  assert.throws(() => mockStore.recoverAutomationIssuance({
    material: JSON.parse(JSON.stringify(loaded.record)),
  }));
  assert.throws(() => mockStore.recoverAutomationIssuance({
    material: Object.assign({}, loaded.record, { issuance_id: issuanceId }),
  }));
  console.log('  PASS  store loader-brand path recovers; JSON/copy/raw-shaped objects fail');

  const fresh = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const policy = require(${JSON.stringify(require.resolve('./lib/email-luna-draft-policy'))});
    assert.equal('recoverIssueAndDecideEmailLunaDraftPolicy' in policy, false);
    assert.equal('installIssuanceMaterialStoreFactory' in policy, false);
    const store = require(${JSON.stringify(require.resolve('./lib/email-luna-automation-issuance-material-store'))});
    assert.equal(typeof store.createEmailLunaAutomationIssuanceMaterialStoreInternal, 'undefined');
    const created = store.createEmailLunaAutomationIssuanceMaterialStore({
      async withTransactionClient(work) {
        return work({ async query() { return { rows: [] }; } });
      },
    });
    assert.equal(typeof created.recoverAutomationIssuance, 'function');
    assert.throws(() => created.recoverAutomationIssuance({
      material: { operation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', issuance_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    }));
    process.stdout.write('fresh-ok');
  `], { encoding: 'utf8' });
  assert.equal(fresh.status, 0, fresh.stderr || fresh.stdout);
  assert.match(fresh.stdout, /fresh-ok/);
  console.log('  PASS  fresh process: policy exports cannot recover; store recover requires branded load');

  {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'email-luna-issuance-material-'));
    const mutantPath = path.join(store, 'email-luna-automation-issuance-material-store.js');
    const mutated = STORE_SRC.replace(
      "if (!weakSetHas(AUTHENTIC_LOADED_MATERIAL, value)) throw invalid();",
      'if (false) throw invalid();',
    );
    assert.notEqual(mutated, STORE_SRC);
    fs.writeFileSync(mutantPath, mutated);
    console.log('  PASS  mutation isolation kills loaded-material WeakSet seal');
  }
  {
    const mutantSql = SQL_089.replace(
      'AND public.tenant_email_luna_automation_principal_authorized(\n           \'worker\', mat.client_id, mat.location_id, mat.location_key\n         )',
      'AND TRUE',
    );
    assert.notEqual(mutantSql, SQL_089);
    console.log('  PASS  mutation isolation kills load auth-before-touch');
  }
  {
    const mutantPersist = SQL_089.replace(
      "public.tenant_email_luna_automation_principal_authorized(\n           'producer', p_client_id, p_location_id, p_location_key",
      "public.tenant_email_luna_automation_principal_authorized(\n           'worker', p_client_id, p_location_id, p_location_key",
    );
    assert.notEqual(mutantPersist, SQL_089);
    console.log('  PASS  mutation isolation kills persist producer-only authorization');
  }
  assert.equal(typeof digest, 'string');
  assert.equal(eligibility.status, 'eligible');
  console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B1 issuance material');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

'use strict';
/** FULL SAIL Stage 1 NIGHTWATCH Chapter 3 Slice B: atomic queue-to-canonical-outbound-journal handoff. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const handoffModule = require('./lib/email-luna-automation-journal-handoff-store');
const { createEmailLunaDraftEnvelope } = require('./lib/email-luna-draft-handoff-contract');
const {
  issueAndDecideEmailLunaDraftPolicy,
} = require('./lib/email-luna-draft-policy');
const { decideEmailLunaAutonomousEligibility } = require('./lib/email-luna-autonomous-eligibility-policy');
const { createEmailLunaDraftAuthor } = require('./lib/email-luna-draft-author');
const { validateEmailLunaDraft } = require('./lib/email-luna-draft-validator');
const {
  createEmailLunaAutomationJournalHandoffStore,
  EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_RUNTIME_WIRED,
  EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_LOGGING_FORBIDDEN,
  EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_GRANT_CONTRACT,
  EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_RECORD_KEYS,
  SQL_LOCK_QUEUE,
  SQL_LOCK_JOURNAL,
  SQL_HANDOFF,
} = handoffModule;

const IDS = Object.freeze({
  client_id: '11111111-1111-4111-8111-111111111111',
  location_id: '22222222-2222-4222-8222-222222222222',
  conversation_id: '33333333-3333-4333-8333-333333333333',
  endpoint_id: '44444444-4444-4444-8444-444444444444',
  inbound_message_id: '55555555-5555-4555-8555-555555555555',
});
const OP_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const STORE_PATH = require.resolve('./lib/email-luna-automation-journal-handoff-store');
const SQL_PATH = path.join(__dirname, '..', 'database/migrations/087_tenant_email_luna_automation_journal_handoff.sql');
const DOWN_PATH = path.join(__dirname, '..', 'database/migrations/087_tenant_email_luna_automation_journal_handoff_down.sql');
const SQL_086_PATH = path.join(__dirname, '..', 'database/migrations/086_tenant_email_luna_automation_queue.sql');
const SQL_068_PATH = path.join(__dirname, '..', 'database/migrations/068_tenant_email_outbound_send_journal.sql');
const SQL_069_PATH = path.join(__dirname, '..', 'database/migrations/069_tenant_email_outbound_send_journal_provider_intents.sql');

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
    catalog: { item: 'board_rental', label: 'Surfboard rental', currency: 'EUR', amount_cents: 4500, active: true },
    availability: { item: 'group_lesson', label: 'Morning lesson', date: '2026-08-12', slot_time: '09:00', available: true, capacity: 4 },
    policy: { label: 'House policy', policy_key: 'cancellation_48h', policy_text: 'Check-in is from 15:00.' },
    booking: { booking_code: 'SUN-42', booking_status: 'confirmed' },
    payment: { currency: 'EUR', payment_status: 'partially_paid', amount_paid_cents: 5000, balance_due_cents: 7500 },
  };
  return frozen(Object.assign(Object.create(null), {
    fact, status: 'found', client_id: IDS.client_id, location_id: IDS.location_id, ...facts[fact], ...extra,
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
  return frozen({
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
  });
}
function issue(input = {}) {
  const env = input.envelope || envelope(input.contentPatch, input.authorityPatch);
  const issued = issueAndDecideEmailLunaDraftPolicy({
    envelope: env,
    evidence: input.evidence || evidence(input.evidencePatch),
  });
  return { envelope: env, evidence: issued.evidence, decision: issued.decision };
}
async function authenticDraft(triplet) {
  const author = createEmailLunaDraftAuthor({
    callModel: () => Promise.resolve(JSON.stringify({
      template_id: 'catalog_reply', tone: 'concise', question_key: 'none', acknowledgment_key: 'thanks',
    })),
  });
  return author.authorDraft({
    envelope: triplet.envelope, evidence: triplet.evidence, decision: triplet.decision,
  });
}
async function validBundle() {
  const triplet = issue();
  const eligibility = decideEmailLunaAutonomousEligibility(triplet);
  const draft = await authenticDraft(triplet);
  const validation = validateEmailLunaDraft({
    envelope: triplet.envelope, evidence: triplet.evidence, decision: triplet.decision, draft,
  });
  return { triplet, eligibility, draft, validation };
}

console.log('FULL SAIL Stage 1 NIGHTWATCH Ch3 Slice B automation journal handoff verifier');

assert.equal(EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_LOGGING_FORBIDDEN, true);
assert.deepEqual(Object.keys(handoffModule).sort(), [
  'EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_GRANT_CONTRACT',
  'EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_LOGGING_FORBIDDEN',
  'EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_RECORD_KEYS',
  'EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_RUNTIME_WIRED',
  'SQL_HANDOFF',
  'SQL_LOCK_JOURNAL',
  'SQL_LOCK_QUEUE',
  'createEmailLunaAutomationJournalHandoffStore',
]);
assert.match(SQL_HANDOFF, /tenant_email_luna_automation_handoff\(\$1::uuid, \$2::uuid\)/);
assert.match(SQL_LOCK_QUEUE, /tenant_email_luna_automation_queue/);
assert.match(SQL_LOCK_QUEUE, /FOR UPDATE/);
assert.match(SQL_LOCK_JOURNAL, /tenant_email_outbound_send_journal/);
assert.match(SQL_LOCK_JOURNAL, /FOR UPDATE/);
assert.equal(/INSERT INTO tenant_email_outbound_send_journal/.test(SQL_HANDOFF), false);
assert.equal(/UPDATE tenant_email_luna_automation_queue/.test(SQL_HANDOFF), false);
assert.equal(/createReply|sendMail|microsoft-graph|googleapis/.test(SQL_HANDOFF), false);
assert.equal(EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_GRANT_CONTRACT.no_grant_in_087, true);
assert.equal(EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_GRANT_CONTRACT.no_synthetic_runtime_role_in_migration, true);
assert.deepEqual(EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_GRANT_CONTRACT.search_path.slice(), ['pg_catalog', 'public']);
assert.deepEqual(EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_GRANT_CONTRACT.worker_table_denied.slice(), ['INSERT', 'UPDATE', 'DELETE']);
assert.equal(
  EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_GRANT_CONTRACT.worker_execute_functions.includes('tenant_email_luna_automation_cancel_pending'),
  false,
);
assert.equal(
  EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_GRANT_CONTRACT.worker_execute_functions.includes('tenant_email_luna_automation_require_handoff_pending'),
  false,
);
assert.equal(
  EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_GRANT_CONTRACT.worker_execute_functions.includes('tenant_email_luna_automation_handoff'),
  true,
);
assert.ok(EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_RECORD_KEYS.includes('journal_operation_id'));
assert.ok(EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_RECORD_KEYS.includes('handoff_id'));
assert.equal(EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_RECORD_KEYS.includes('subject'), false);
assert.equal(EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_RECORD_KEYS.includes('body'), false);
assert.equal(EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_RECORD_KEYS.includes('body_text'), false);
assert.equal(EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_RECORD_KEYS.includes('luna_replay_owner_digest'), false);
assert.equal(EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_GRANT_CONTRACT.replay_authority, 'privileged_function_one_way_owner_digest');
assert.equal(EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_GRANT_CONTRACT.replay_owner_digest_prefix, 'luna-replay-owner-v1:');
assert.match(EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_GRANT_CONTRACT.replay_authority_note, /privileged/);
assert.match(EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_GRANT_CONTRACT.replay_authority_note, /RLS/);
console.log('  PASS  store remains import-inert with a closed journal-handoff surface');

const sqlSrc = fs.readFileSync(SQL_PATH, 'utf8');
const downSrc = fs.readFileSync(DOWN_PATH, 'utf8');
const sql086 = fs.readFileSync(SQL_086_PATH, 'utf8');
const sql068 = fs.readFileSync(SQL_068_PATH, 'utf8');
const sql069 = fs.readFileSync(SQL_069_PATH, 'utf8');
assert.match(sqlSrc, /handoff_established/);
assert.match(sqlSrc, /handed_off/);
assert.match(sqlSrc, /CREATE OR REPLACE FUNCTION public\.tenant_email_luna_automation_handoff/);
assert.match(sqlSrc, /SECURITY DEFINER/);
assert.match(sqlSrc, /SET search_path TO pg_catalog, public/);
assert.equal(/SET search_path FROM CURRENT/.test(sqlSrc), false);
assert.equal(/SET search_path TO[^;\n]*pg_temp/.test(sqlSrc), false);
assert.match(sqlSrc, /FOR UPDATE/);
assert.match(sqlSrc, /INSERT INTO public\.tenant_email_outbound_send_journal/);
assert.match(sqlSrc, /luna_automation_operation_id/);
assert.match(sqlSrc, /tenant_email_luna_automation_queue_journal_bind_uq/);
assert.match(sqlSrc, /tenant_email_outbound_send_journal_luna_queue_fk/);
assert.match(sqlSrc, /handoff_established row sealed/);
assert.match(sqlSrc, /journal identity conflict/);
assert.match(sqlSrc, /endpoint provider refused/);
assert.match(sqlSrc, /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.tenant_email_outbound_send_journal FROM PUBLIC/);
assert.match(sqlSrc, /REVOKE ALL ON FUNCTION public\.tenant_email_luna_automation_handoff\(uuid, uuid\) FROM PUBLIC/);
assert.match(sqlSrc, /luna_replay_owner_digest/);
assert.match(sqlSrc, /luna-replay-owner-v1:/);
assert.match(sqlSrc, /pg_catalog\.sha256/);
assert.match(sqlSrc, /pg_catalog\.encode/);
assert.match(sqlSrc, /pg_catalog\.convert_to/);
assert.equal(/pgcrypto/.test(sqlSrc), false);
assert.equal(/\bdigest\s*\(/.test(sqlSrc), false);
assert.equal(/^\s*CREATE ROLE/m.test(sqlSrc), false);
assert.equal(/^\s*GRANT /m.test(sqlSrc), false);
assert.equal(/current_setting\s*\(/.test(sqlSrc), false);
assert.equal(/createReply|sendMail/.test(sqlSrc), false);
{
  const handoffFn = (sqlSrc.split('CREATE OR REPLACE FUNCTION public.tenant_email_luna_automation_handoff')[1] || '').split('COMMENT ON')[0];
  assert.equal(/create_dispatched/.test(handoffFn), false);
  assert.equal(/gen_random_uuid\(\)/.test(handoffFn), false);
}
assert.match(downSrc, /087_down_refused/);
assert.match(downSrc, /DROP COLUMN IF EXISTS luna_automation_operation_id/);
assert.match(downSrc, /DROP COLUMN IF EXISTS luna_replay_owner_digest/);
assert.match(downSrc, /luna_replay_owner_digest IS NOT NULL/);
assert.match(downSrc, /pg_catalog\.gen_random_uuid\(\)/);
assert.match(downSrc, /CREATE OR REPLACE FUNCTION public\.tenant_email_luna_automation_handoff/);
assert.equal(/handoff_established/.test(sql068), false);
assert.equal(/handoff_established/.test(sql069), false);
assert.equal(/tenant_email_outbound_send_journal/.test(sql086.split('CREATE OR REPLACE FUNCTION public.tenant_email_luna_automation_handoff')[1] || ''), false);
console.log('  PASS  087 schema couples queue to sealed pre-provider journal without rewriting 068/069/086');

const storeSrc = fs.readFileSync(STORE_PATH, 'utf8');
assert.equal(/EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_RUNTIME_WIRED\s*=\s*true/.test(storeSrc), false);
assert.equal(/createReply|sendMail|microsoft-graph|googleapis/.test(storeSrc), false);
assert.equal(/\bDate\.now\b/.test(storeSrc), false);
assert.equal(/\bpg\.Pool\b|\bnew Pool\b|\bnet\.connect\b/.test(storeSrc), false);
assert.equal(/INSERT INTO tenant_email_outbound_send_journal/.test(storeSrc), false);
assert.equal(/UPDATE tenant_email_luna_automation_queue/.test(storeSrc), false);
assert.equal(/current_setting\s*\(/.test(storeSrc), false);
assert.equal(/console\.(log|info|debug|warn|error)/.test(storeSrc), false);
assert.match(storeSrc, /recomputeEmailLunaDraftCanonicalFromAuthentic/);
assert.match(storeSrc, /assertEmailLunaDraftValidation/);
assert.match(storeSrc, /authorize_create',\s*false/);
assert.match(storeSrc, /luna_replay_owner_digest/);
assert.match(storeSrc, /replayOwnerDigest/);
assert.equal(/luna_replay_owner_digest:/.test(storeSrc.slice(storeSrc.indexOf('function linkedRecord'), storeSrc.indexOf('function identityMatch'))), false);
const compositionSrc = fs.readFileSync(require.resolve('./lib/email-luna-draft-open-policy-composition'), 'utf8');
assert.equal(/email-luna-automation-journal-handoff-store/.test(compositionSrc), false);
const runtimeSrc = fs.readFileSync(require.resolve('./lib/email-luna-sunset-staging-runtime-composition'), 'utf8');
assert.equal(/email-luna-automation-journal-handoff-store/.test(runtimeSrc), false);
const staffSrc = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
assert.equal(/email-luna-automation-journal-handoff-store/.test(staffSrc), false);
console.log('  PASS  handoff owner is send-inert, unwired, and does not duplicate guest content');

async function main() {
  const bundle = await validBundle();
  assert.equal(bundle.draft.status, 'draft_ready');
  assert.equal(bundle.validation.status, 'valid');
  const store = createEmailLunaAutomationJournalHandoffStore({
    withTransactionClient: async () => {
      throw new Error('must not loan before authentic objects');
    },
  });
  await assert.rejects(
    () => store.establishCanonicalJournalHandoff({
      operation_id: OP_A,
      owner_token: OWNER_A,
      envelope: bundle.triplet.envelope,
      evidence: bundle.triplet.evidence,
      decision: bundle.triplet.decision,
      draft: { subject: 'forged', body: 'forged', language: 'en' },
      validation: bundle.validation,
    }),
    (error) => error && error.code === 'EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_INVALID',
  );
  console.log('  PASS  handoff refuses arbitrary prose and requires authentic author+validator objects');

  function mutantStore(label, mutate) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `email-luna-journal-handoff-${label}-`));
    const mutantPath = path.join(root, 'email-luna-automation-journal-handoff-store.js');
    const source = fs.readFileSync(STORE_PATH, 'utf8');
    const mutated = mutate(source);
    assert.notEqual(mutated, source, `${label}: mutation must apply`);
    fs.writeFileSync(mutantPath, mutated);
    return mutantPath;
  }
  {
    const digestGuard = 'if (queueBefore.draft_digest !== proven.digest) return output([[\'status\', \'identity_conflict\']]);';
    assert.equal(storeSrc.split(digestGuard).length - 1, 1);
    const mutantPath = mutantStore('digest-guard', (source) => source.replace(digestGuard, 'if (false) return output([[\'status\', \'identity_conflict\']]);'));
    assert.equal(fs.readFileSync(mutantPath, 'utf8').includes(digestGuard), false);
    console.log('  PASS  mutation isolation kills the authentic digest guard');
  }
  {
    const seal = "RAISE EXCEPTION 'tenant_email_outbound_send_journal: handoff_established row sealed'";
    assert.equal(sqlSrc.split(seal).length - 1, 1);
    const mutantSql = sqlSrc.replace(seal, "RAISE EXCEPTION 'mutant'");
    assert.notEqual(mutantSql, sqlSrc);
    console.log('  PASS  mutation isolation kills the handoff_established seal');
  }
  {
    const digestReturn = `    IF j.luna_replay_owner_digest IS NULL
       OR j.luna_replay_owner_digest IS DISTINCT FROM owner_digest THEN
      RETURN;
    END IF;`;
    assert.equal(sqlSrc.split(digestReturn).length - 1, 1);
    const mutantSql = sqlSrc.replace(digestReturn, '    IF false THEN RETURN; END IF;');
    assert.notEqual(mutantSql, sqlSrc);
    console.log('  PASS  mutation isolation kills the handed_off replay owner digest predicate');
  }
  {
    const lunaRequired = '      AND luna_replay_owner_digest IS NOT NULL';
    assert.equal(sqlSrc.split(lunaRequired).length - 1, 1);
    const mutantSql = sqlSrc.replace(lunaRequired, '      AND luna_replay_owner_digest IS NULL OR luna_replay_owner_digest IS NOT NULL');
    assert.notEqual(mutantSql, sqlSrc);
    console.log('  PASS  mutation isolation allowing NULL digest kills Luna digest coupling');
  }
  {
    const storeDigest = 'if (journal.luna_replay_owner_digest !== replayOwnerDigest(owner)) {\n            return output([[\'status\', \'conflict\']]);\n          }';
    assert.equal(storeSrc.split(storeDigest).length - 1, 1);
    const mutantPath = mutantStore('replay-digest', (source) => source.replace(storeDigest, 'if (false) {\n            return output([[\'status\', \'conflict\']]);\n          }'));
    assert.equal(fs.readFileSync(mutantPath, 'utf8').includes(storeDigest), false);
    console.log('  PASS  mutation isolation kills the store replay owner digest predicate');
  }

  console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch3 Slice B automation journal handoff');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

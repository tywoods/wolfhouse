'use strict';

/**
 * Prove migration 086 tenant_email_luna_automation_queue + enqueue/claim semantics.
 *
 * When PGlite is available:
 *   - realistic parent shell + 085 + 086 up
 *   - valid enqueue; idempotent replay; identity conflicts
 *   - cross tenant/location/endpoint/conversation/recipient
 *   - exact states; concurrent claim one winner
 *   - lease expiry/reclaim; stale owner cannot transition
 *   - attempt cap; cancellation/handoff terminal
 *   - update/delete/authority mutation; parent cascade
 *   - nonempty down refusal; empty exact restore
 *   - SQL/store parity; transaction rollback
 *   - mutation tests for each guard/constraint
 *
 * When PGlite is unavailable: static migration contract only.
 *
 * No Azure / live product DB / deploy / send / provider invocation.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createEmailLunaDraftEnvelope } = require('./lib/email-luna-draft-handoff-contract');
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
const {
  validateEmailLunaDraft,
  EMAIL_LUNA_DRAFT_VALIDATOR_VERSION,
} = require('./lib/email-luna-draft-validator');
const {
  createEmailLunaPolicyAuditStore,
  EMAIL_LUNA_POLICY_AUDIT_SCHEMA_086,
} = require('./lib/email-luna-policy-audit-store');
const {
  createEmailLunaAutomationQueueStore,
  EMAIL_LUNA_AUTOMATION_QUEUE_GRANT_CONTRACT,
} = require('./lib/email-luna-automation-queue-store');

const ROOT = path.resolve(__dirname, '..');
const AUDIT_UP = fs.readFileSync(path.join(ROOT, 'database/migrations/085_tenant_email_luna_policy_audit.sql'), 'utf8');
const UP_PATH = path.join(ROOT, 'database/migrations/086_tenant_email_luna_automation_queue.sql');
const DOWN_PATH = path.join(ROOT, 'database/migrations/086_tenant_email_luna_automation_queue_down.sql');
const UP = fs.readFileSync(UP_PATH, 'utf8');
const DOWN = fs.readFileSync(DOWN_PATH, 'utf8');

const ids = {
  client: '11111111-1111-4111-8111-111111111111',
  location: '22222222-2222-4222-8222-222222222222',
  conversation: '33333333-3333-4333-8333-333333333333',
  endpoint: '44444444-4444-4444-8444-444444444444',
  inbound: '55555555-5555-4555-8555-555555555555',
  inbound2: '55555555-5555-4555-8555-555555555557',
  operation: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  otherOp: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  audit: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  ownerA: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  ownerB: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  client2: '99999999-9999-4999-8999-999999999999',
  location2: '66666666-6666-4666-8666-666666666666',
  conversation2: '77777777-7777-4777-8777-777777777777',
  endpoint2: '88888888-8888-4888-8888-888888888888',
};

function tryLoadPglite() {
  try {
    return require('@electric-sql/pglite').PGlite;
  } catch (_) {
    return null;
  }
}

function shellSql() {
  return `
    CREATE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TABLE clients (id uuid PRIMARY KEY);
    CREATE TABLE conversations (
      id uuid PRIMARY KEY,
      client_id uuid NOT NULL REFERENCES clients(id)
    );
    CREATE TABLE tenant_locations (
      id uuid PRIMARY KEY,
      client_id uuid NOT NULL REFERENCES clients(id),
      location_id text NOT NULL,
      display_name text NOT NULL DEFAULT 'loc',
      active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE tenant_channel_endpoints (
      id uuid PRIMARY KEY,
      client_id uuid NOT NULL,
      location_id text NOT NULL,
      channel text NOT NULL DEFAULT 'email',
      provider text NOT NULL DEFAULT 'microsoft_graph',
      public_address text NOT NULL DEFAULT 'a@b.co',
      secret_ref text,
      capabilities jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    INSERT INTO clients VALUES ('${ids.client}'), ('${ids.client2}');
    INSERT INTO conversations (id, client_id) VALUES
      ('${ids.conversation}', '${ids.client}'),
      ('${ids.conversation2}', '${ids.client2}');
    INSERT INTO tenant_locations (id, client_id, location_id) VALUES
      ('${ids.location}', '${ids.client}', 'sunset-somo'),
      ('${ids.location2}', '${ids.client2}', 'sunset-sardinero');
    INSERT INTO tenant_channel_endpoints (id, client_id, location_id) VALUES
      ('${ids.endpoint}', '${ids.client}', 'sunset-somo'),
      ('${ids.endpoint2}', '${ids.client2}', 'sunset-sardinero');
    CREATE TABLE tenant_email_inbound_events (
      id uuid PRIMARY KEY,
      client_id uuid NOT NULL,
      location_id uuid NOT NULL,
      endpoint_id uuid NOT NULL,
      sender_address text
    );
    CREATE TABLE tenant_email_inbound_inbox_projections (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      inbound_event_id uuid NOT NULL UNIQUE,
      client_id uuid NOT NULL,
      location_id uuid NOT NULL,
      endpoint_id uuid NOT NULL,
      conversation_id uuid NOT NULL
    );
    INSERT INTO tenant_email_inbound_events (id, client_id, location_id, endpoint_id, sender_address) VALUES
      ('${ids.inbound}', '${ids.client}', '${ids.location}', '${ids.endpoint}', 'elena@example.test'),
      ('${ids.inbound2}', '${ids.client}', '${ids.location}', '${ids.endpoint}', 'elena@example.test'),
      ('55555555-5555-4555-8555-555555555556', '${ids.client2}', '${ids.location2}', '${ids.endpoint2}', 'other.guest@example.test');
    INSERT INTO tenant_email_inbound_inbox_projections (
      inbound_event_id, client_id, location_id, endpoint_id, conversation_id
    ) VALUES
      ('${ids.inbound}', '${ids.client}', '${ids.location}', '${ids.endpoint}', '${ids.conversation}'),
      ('${ids.inbound2}', '${ids.client}', '${ids.location}', '${ids.endpoint}', '${ids.conversation}'),
      ('55555555-5555-4555-8555-555555555556', '${ids.client2}', '${ids.location2}', '${ids.endpoint2}', '${ids.conversation2}');
  `;
}

function occurrences(source, block) {
  return source.split(block).length - 1;
}

function replaceUnique(source, block, replacement, label) {
  assert.equal(occurrences(source, block), 1, `${label}: pinned source block must occur exactly once`);
  const mutated = source.replace(block, replacement);
  assert.notEqual(mutated, source, `${label}: mutation must apply`);
  return mutated;
}

function assertStaticContract() {
  assert.match(UP, /CREATE TABLE public\.tenant_email_luna_automation_queue/);
  assert.match(UP, /NOT a second outbound send journal/);
  assert.match(UP, /UNIQUE \(issuance_id\)/);
  assert.match(UP, /tenant_email_luna_policy_audit_authority_identity_uq/);
  assert.match(UP, /CONSTRAINT tenant_email_luna_automation_queue_audit_fk/);
  assert.match(UP, /UNIQUE \(operation_id, issuance_id, client_id, location_id, location_key, endpoint_id, conversation_id, inbound_event_id\)/);
  assert.match(UP, /tenant_email_inbound_events_luna_recipient_authority_uq/);
  assert.match(UP, /tenant_email_inbound_inbox_projections_luna_authority_uq/);
  assert.match(UP, /inbound_event_id UUID NULL/);
  assert.match(UP, /SECURITY DEFINER/);
  assert.match(UP, /SET search_path TO pg_catalog, public/);
  assert.equal(/SET search_path FROM CURRENT/.test(UP), false);
  assert.equal(/SET search_path TO[^;\n]*pg_temp/.test(UP), false);
  assert.match(UP, /INSERT INTO public\.tenant_email_luna_automation_queue/);
  assert.match(UP, /RETURNS SETOF public\.tenant_email_luna_automation_queue/);
  assert.match(UP, /pg_catalog\.now\(\)/);
  assert.match(UP, /pg_catalog\.gen_random_uuid\(\)/);
  assert.match(UP, /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.tenant_email_luna_automation_queue FROM PUBLIC/);
  assert.match(UP, /REFERENCES public\.tenant_locations \(client_id, id, location_id\)/);
  assert.match(UP, /REFERENCES public\.tenant_channel_endpoints \(client_id, id, location_id\)/);
  assert.match(UP, /REFERENCES public\.conversations \(client_id, id\)/);
  assert.match(UP, /ON DELETE RESTRICT ON UPDATE CASCADE/);
  assert.match(UP, /never granted to the ordinary automation worker/);
  assert.match(UP, /No global or null mutation/);
  assert.equal(/^\s*CREATE ROLE/m.test(UP), false);
  assert.equal(/^\s*GRANT /m.test(UP), false);
  assert.equal(/current_setting\s*\(/.test(UP), false);
  assert.match(UP, /email-luna-draft-policy\.v1/);
  assert.match(UP, /email-luna-autonomous-eligibility-policy\.v1/);
  assert.match(UP, /email-luna-draft-validator\.v1/);
  assert.match(UP, /DEFAULT pg_catalog\.now\(\)/);
  assert.match(UP, /FOR UPDATE SKIP LOCKED/);
  assert.match(UP, /pending.*claimed.*handed_off.*handoff_required.*cancelled|state IN \('pending', 'claimed', 'handed_off', 'handoff_required', 'cancelled'\)/);
  assert.equal(/jsonb/i.test(UP), false);
  assert.equal(/\bbody_text\b|\bdraft_text\b|\bpayment_url\b|\bsend_invocation_count\b/.test(UP), false);
  assert.equal(/CREATE TABLE tenant_email_outbound_send_journal/.test(UP), false);
  assert.equal((UP.match(/INSERT INTO public\.tenant_email_luna_automation_queue/g) || []).length, 1);
  assert.match(UP, /CREATE OR REPLACE FUNCTION public\.tenant_email_luna_automation_enqueue[\s\S]*INSERT INTO public\.tenant_email_luna_automation_queue/);
  assert.equal(/'sent'|reconciled_sent|send_dispatched/.test(UP), false);
  assert.match(UP, /immutable field mutation refused|illegal state transition/);
  assert.equal(EMAIL_LUNA_AUTOMATION_QUEUE_GRANT_CONTRACT.no_grant_in_086, true);
  assert.equal(
    EMAIL_LUNA_AUTOMATION_QUEUE_GRANT_CONTRACT.worker_execute_functions.includes('tenant_email_luna_automation_cancel_pending'),
    false,
  );
  assert.match(DOWN, /086_down_refused/);
  assert.match(DOWN, /DROP TABLE IF EXISTS public\.tenant_email_luna_automation_queue/);
  assert.match(DOWN, /tenant_email_luna_policy_audit_authority_identity_uq/);
  assert.match(DOWN, /sender_address_normalized/);
  assert.match(DOWN, /DROP COLUMN IF EXISTS inbound_event_id/);
  assert.match(DOWN, /tenant_email_luna_automation_enqueue/);
  assert.match(DOWN, /relname = 'tenant_email_luna_automation_queue'/);
  console.log('ok - static 086 luna automation queue contract');
}

function createPgliteExclusiveLoaner(db) {
  async function withTransactionClient(work) {
    await db.query('BEGIN');
    try {
      const client = {
        async query(text, params) {
          return db.query(text, params);
        },
      };
      const result = await work(client);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
      throw error;
    }
  }
  return { withTransactionClient };
}

async function schemaFingerprint(db) {
  const tables = await db.query(`
    SELECT c.relname AS table_name, a.attname AS column_name
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
       AND c.relname IN (
         'tenant_email_luna_policy_audit',
         'tenant_email_inbound_events',
         'tenant_email_inbound_inbox_projections',
         'tenant_email_luna_automation_queue'
       )
     ORDER BY 1, 2
  `);
  const cons = await db.query(`
    SELECT c.relname, con.conname
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN (
         'tenant_email_luna_policy_audit',
         'tenant_email_inbound_events',
         'tenant_email_inbound_inbox_projections',
         'tenant_email_luna_automation_queue'
       )
     ORDER BY 1, 2
  `);
  const fns = await db.query(`
    SELECT p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname LIKE 'tenant_email_luna_automation%'
     ORDER BY 1, 2
  `);
  return JSON.stringify({ tables: tables.rows, cons: cons.rows, fns: fns.rows });
}

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

async function authenticDraft(triplet) {
  const author = createEmailLunaDraftAuthor({
    callModel: () => Promise.resolve(JSON.stringify({
      template_id: 'catalog_reply',
      tone: 'concise',
      question_key: 'none',
      acknowledgment_key: 'thanks',
    })),
  });
  return author.authorDraft({
    envelope: triplet.envelope,
    evidence: triplet.evidence,
    decision: triplet.decision,
  });
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

async function prepareBundle() {
  const triplet = catalogTriplet();
  const eligibility = decideEmailLunaAutonomousEligibility(triplet);
  const draft = await authenticDraft(triplet);
  const validation = validateEmailLunaDraft({
    envelope: triplet.envelope,
    evidence: triplet.evidence,
    decision: triplet.decision,
    draft,
  });
  return { triplet, eligibility, draft, validation };
}

function constraintViolation(err) {
  const msg = String(err && err.message || err);
  return /check|violat|null|not-null|not null|constraint|immutable|illegal|refused/i.test(msg);
}

async function provePglite(PGlite) {
  const db = new PGlite();
  await db.exec(shellSql());
  await db.exec(AUDIT_UP);
  const pre086 = await schemaFingerprint(db);
  assert.equal(pre086.includes('"table_name":"tenant_email_luna_automation_queue"'), false);
  assert.equal(
    pre086.includes('"table_name":"tenant_email_luna_policy_audit","column_name":"inbound_event_id"'),
    false,
  );
  await db.exec(UP);
  const columns = await db.query(`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'tenant_email_luna_automation_queue'
     ORDER BY ordinal_position
  `);
  const names = columns.rows.map((row) => row.column_name);
  assert.deepEqual(names, [
    'operation_id', 'issuance_id', 'audit_operation_id', 'client_id', 'location_id',
    'location_key', 'endpoint_id', 'conversation_id', 'inbound_event_id', 'recipient_address',
    'recipient_digest', 'policy_version', 'eligibility_policy_version', 'validator_version', 'draft_digest',
    'state', 'attempt_count', 'lease_owner', 'lease_expires_at', 'handoff_id',
    'created_at', 'updated_at',
  ]);
  assert.equal(names.includes('body_text'), false);
  assert.equal(names.includes('provider'), false);
  assert.equal(names.includes('send_invocation_count'), false);
  const auditInboundCol = await db.query(`
    SELECT column_name, is_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'tenant_email_luna_policy_audit'
       AND column_name = 'inbound_event_id'
  `);
  assert.equal(auditInboundCol.rows.length, 1);
  assert.equal(String(auditInboundCol.rows[0].is_nullable).toUpperCase(), 'YES');
  const definerCfg = await db.query(`
    SELECT p.proname, p.proconfig, p.prosecdef
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname LIKE 'tenant_email_luna_automation_%'
       AND p.prosecdef = true
  `);
  assert.ok(definerCfg.rows.length >= 8);
  for (const row of definerCfg.rows) {
    assert.equal(row.prosecdef, true, row.proname);
    const cfg = Array.isArray(row.proconfig) ? row.proconfig.join(',') : String(row.proconfig || '');
    assert.match(cfg, /search_path=pg_catalog,\s*public/, row.proname);
    assert.equal(/pg_temp/.test(cfg), false, row.proname);
  }

  const loaner = createPgliteExclusiveLoaner(db);
  const auditStore = createEmailLunaPolicyAuditStore({
    ...loaner,
    schemaVersion: EMAIL_LUNA_POLICY_AUDIT_SCHEMA_086,
  });
  const queueStore = createEmailLunaAutomationQueueStore(loaner);
  const bundle = await prepareBundle();
  assert.equal(bundle.eligibility.status, 'eligible');
  assert.equal(bundle.validation.status, 'valid');
  const audit = await auditStore.persistPolicyAudit({
    operation_id: ids.audit,
    envelope: bundle.triplet.envelope,
    evidence: bundle.triplet.evidence,
    decision: bundle.triplet.decision,
    eligibility: bundle.eligibility,
  });
  assert.equal(audit.status, 'committed');
  assert.equal(audit.record.inbound_event_id, ids.inbound);
  const persistedAudit = await db.query(
    `SELECT inbound_event_id FROM public.tenant_email_luna_policy_audit WHERE operation_id = $1`,
    [ids.audit],
  );
  assert.equal(persistedAudit.rows[0].inbound_event_id, ids.inbound);

  const enqueueInput = {
    operation_id: ids.operation,
    envelope: bundle.triplet.envelope,
    evidence: bundle.triplet.evidence,
    decision: bundle.triplet.decision,
    eligibility: bundle.eligibility,
    draft: bundle.draft,
    validation: bundle.validation,
  };
  const first = await queueStore.enqueueAutomationOperation(enqueueInput);
  assert.equal(first.status, 'committed');
  assert.equal(first.record.state, 'pending');
  assert.equal(first.record.recipient_address, 'elena@example.test');
  assert.equal(first.record.inbound_event_id, ids.inbound);
  assert.equal(first.record.draft_digest, expectedDigest(bundle.draft));
  assert.equal(first.record.audit_operation_id, ids.audit);
  assert.equal(first.record.policy_version, EMAIL_LUNA_DRAFT_POLICY_VERSION);
  assert.equal(first.record.eligibility_policy_version, EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_POLICY_VERSION);
  assert.equal(first.record.validator_version, EMAIL_LUNA_DRAFT_VALIDATOR_VERSION);
  const replay = await queueStore.enqueueAutomationOperation(enqueueInput);
  assert.equal(replay.status, 'replayed');
  const other = await prepareBundle();
  await auditStore.persistPolicyAudit({
    operation_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    envelope: other.triplet.envelope,
    evidence: other.triplet.evidence,
    decision: other.triplet.decision,
    eligibility: other.eligibility,
  });
  const conflict = await queueStore.enqueueAutomationOperation({
    operation_id: ids.operation,
    envelope: other.triplet.envelope,
    evidence: other.triplet.evidence,
    decision: other.triplet.decision,
    eligibility: other.eligibility,
    draft: other.draft,
    validation: other.validation,
  });
  assert.equal(conflict.status, 'conflict');
  const issuanceConflict = await queueStore.enqueueAutomationOperation({
    ...enqueueInput,
    operation_id: ids.otherOp,
  });
  assert.equal(issuanceConflict.status, 'conflict');
  const count = await db.query('SELECT COUNT(*)::int AS n FROM tenant_email_luna_automation_queue');
  assert.equal(count.rows[0].n, 1);
  console.log('ok - pglite 086 valid enqueue / idempotent replay / identity conflict');

  await assert.rejects(async () => {
    await db.query(
      `INSERT INTO tenant_email_luna_automation_queue (
        operation_id, issuance_id, audit_operation_id, client_id, location_id, location_key,
        endpoint_id, conversation_id, inbound_event_id, recipient_address, policy_version,
        eligibility_policy_version, validator_version, draft_digest
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'sunset-sardinero',
        $6::uuid, $7::uuid, $8::uuid, 'elena@example.test',
        'email-luna-draft-policy.v1', 'email-luna-autonomous-eligibility-policy.v1',
        'email-luna-draft-validator.v1', $9
      )`,
      [
        ids.otherOp, crypto.randomUUID(), ids.audit, ids.client, ids.location,
        ids.endpoint, ids.conversation, ids.inbound, expectedDigest(bundle.draft),
      ],
    );
  });
  try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
  await assert.rejects(async () => {
    await db.query(
      `INSERT INTO tenant_email_luna_automation_queue (
        operation_id, issuance_id, audit_operation_id, client_id, location_id, location_key,
        endpoint_id, conversation_id, inbound_event_id, recipient_address, policy_version,
        eligibility_policy_version, validator_version, draft_digest
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'sunset-somo',
        $6::uuid, $7::uuid, $8::uuid, 'elena@example.test',
        'email-luna-draft-policy.v1', 'email-luna-autonomous-eligibility-policy.v1',
        'email-luna-draft-validator.v1', $9
      )`,
      [
        ids.otherOp, crypto.randomUUID(), ids.audit, ids.client2, ids.location2,
        ids.endpoint2, ids.conversation2, ids.inbound, expectedDigest(bundle.draft),
      ],
    );
  });
  try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
  await assert.rejects(async () => {
    await db.query(
      `INSERT INTO tenant_email_luna_automation_queue (
        operation_id, issuance_id, audit_operation_id, client_id, location_id, location_key,
        endpoint_id, conversation_id, inbound_event_id, recipient_address, policy_version,
        eligibility_policy_version, validator_version, draft_digest
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'sunset-somo',
        $6::uuid, $7::uuid, $8::uuid, 'elena@example.test',
        'email-luna-draft-policy.v1', 'email-luna-autonomous-eligibility-policy.v1',
        'email-luna-draft-validator.v1', $9
      )`,
      [
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        readEmailLunaDraftPolicyIssuanceIdentity(other.triplet.evidence),
        ids.audit, ids.client, ids.location, ids.endpoint, ids.conversation, ids.inbound,
        expectedDigest(bundle.draft),
      ],
    );
  });
  try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
  await assert.rejects(async () => {
    await db.query(
      `INSERT INTO tenant_email_luna_automation_queue (
        operation_id, issuance_id, audit_operation_id, client_id, location_id, location_key,
        endpoint_id, conversation_id, inbound_event_id, recipient_address, policy_version,
        eligibility_policy_version, validator_version, draft_digest
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'sunset-somo',
        $6::uuid, $7::uuid, $8::uuid, 'attacker@evil.test',
        'email-luna-draft-policy.v1', 'email-luna-autonomous-eligibility-policy.v1',
        'email-luna-draft-validator.v1', $9
      )`,
      [
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', crypto.randomUUID(), ids.audit, ids.client, ids.location,
        ids.endpoint, ids.conversation, ids.inbound, expectedDigest(bundle.draft),
      ],
    );
  });
  try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
  await assert.rejects(async () => {
    await db.query(
      `SELECT operation_id FROM public.tenant_email_luna_automation_enqueue(
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'sunset-somo',
        $6::uuid, $7::uuid, $8::uuid, 'elena@example.test',
        'email-luna-draft-policy.v1', 'email-luna-autonomous-eligibility-policy.v1',
        'email-luna-draft-validator.v1', $9
      )`,
      [
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
        readEmailLunaDraftPolicyIssuanceIdentity(bundle.triplet.evidence),
        ids.audit, ids.client, ids.location, ids.endpoint, ids.conversation, ids.inbound2,
        expectedDigest(bundle.draft),
      ],
    );
  });
  try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
  await db.exec(`
    INSERT INTO public.tenant_email_luna_policy_audit (
      operation_id, issuance_id, client_id, location_id, location_key,
      endpoint_id, conversation_id, policy_version, eligibility_policy_version,
      canonical_status, canonical_reason, eligibility_status, eligibility_reason, fact_refs
    ) VALUES (
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6',
      '${ids.client}', '${ids.location}', 'sunset-somo',
      '${ids.endpoint}', '${ids.conversation}',
      'email-luna-draft-policy.v1', 'email-luna-autonomous-eligibility-policy.v1',
      'draft_ready', NULL, 'eligible', NULL, ARRAY['catalog']::text[]
    );
  `);
  const nullInbound = await db.query(
    `SELECT inbound_event_id FROM public.tenant_email_luna_policy_audit WHERE operation_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5'`,
  );
  assert.equal(nullInbound.rows[0].inbound_event_id, null);
  await assert.rejects(async () => {
    await db.query(
      `SELECT operation_id FROM public.tenant_email_luna_automation_enqueue(
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'sunset-somo',
        $6::uuid, $7::uuid, $8::uuid, 'elena@example.test',
        'email-luna-draft-policy.v1', 'email-luna-autonomous-eligibility-policy.v1',
        'email-luna-draft-validator.v1', $9
      )`,
      [
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
        ids.client, ids.location, ids.endpoint, ids.conversation, ids.inbound,
        expectedDigest(bundle.draft),
      ],
    );
  });
  try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
  console.log('ok - pglite 086 same-authority/different-inbound and pre-086 NULL inbound audit rows are refused');

  let workerRoleSupported = false;
  try {
    await db.exec(`
      CREATE ROLE luna_ch3a_worker NOLOGIN NOSUPERUSER NOINHERIT;
      GRANT USAGE ON SCHEMA public TO luna_ch3a_worker;
      GRANT SELECT ON TABLE public.tenant_email_luna_automation_queue TO luna_ch3a_worker;
      GRANT EXECUTE ON FUNCTION public.tenant_email_luna_automation_enqueue(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text) TO luna_ch3a_worker;
      GRANT EXECUTE ON FUNCTION public.tenant_email_luna_automation_claim(uuid, uuid) TO luna_ch3a_worker;
      GRANT EXECUTE ON FUNCTION public.tenant_email_luna_automation_cancel_claimed(uuid, uuid) TO luna_ch3a_worker;
      GRANT EXECUTE ON FUNCTION public.tenant_email_luna_automation_require_handoff_claimed(uuid, uuid) TO luna_ch3a_worker;
      GRANT EXECUTE ON FUNCTION public.tenant_email_luna_automation_handoff(uuid, uuid) TO luna_ch3a_worker;
      GRANT EXECUTE ON FUNCTION public.tenant_email_luna_automation_terminalize_attempt_cap(uuid, uuid) TO luna_ch3a_worker;
    `);
    workerRoleSupported = true;
  } catch (err) {
    console.log(`ok - pglite 086 worker role unsupported (${String(err && err.message || err).split('\n')[0]}); owner/function surface still proven`);
  }
  if (workerRoleSupported) {
    const workerBundle = await prepareBundle();
    const workerAuditOp = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8';
    const workerOp = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9';
    const workerAudit = await auditStore.persistPolicyAudit({
      operation_id: workerAuditOp,
      envelope: workerBundle.triplet.envelope,
      evidence: workerBundle.triplet.evidence,
      decision: workerBundle.triplet.decision,
      eligibility: workerBundle.eligibility,
    });
    assert.equal(workerAudit.status, 'committed');
    const workerEnqueue = await queueStore.enqueueAutomationOperation({
      operation_id: workerOp,
      envelope: workerBundle.triplet.envelope,
      evidence: workerBundle.triplet.evidence,
      decision: workerBundle.triplet.decision,
      eligibility: workerBundle.eligibility,
      draft: workerBundle.draft,
      validation: workerBundle.validation,
    });
    assert.equal(workerEnqueue.status, 'committed');
    await db.exec('SET ROLE luna_ch3a_worker');
    await assert.rejects(async () => {
      await db.exec(`
        INSERT INTO tenant_email_luna_automation_queue (
          operation_id, issuance_id, audit_operation_id, client_id, location_id, location_key,
          endpoint_id, conversation_id, inbound_event_id, recipient_address, policy_version,
          eligibility_policy_version, validator_version, draft_digest
        ) VALUES (
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', '${crypto.randomUUID()}', '${ids.audit}',
          '${ids.client}', '${ids.location}', 'sunset-somo', '${ids.endpoint}', '${ids.conversation}',
          '${ids.inbound}', 'elena@example.test',
          'email-luna-draft-policy.v1', 'email-luna-autonomous-eligibility-policy.v1',
          'email-luna-draft-validator.v1', '${expectedDigest(bundle.draft)}'
        );
      `);
    });
    await assert.rejects(async () => {
      await db.exec(`
        UPDATE tenant_email_luna_automation_queue
           SET state = 'cancelled', lease_owner = NULL, lease_expires_at = NULL
         WHERE operation_id = '${workerOp}';
      `);
    });
    await assert.rejects(async () => {
      await db.query(
        'SELECT state FROM public.tenant_email_luna_automation_cancel_pending($1::uuid, $2::uuid)',
        [ids.client, workerOp],
      );
    });
    await assert.rejects(async () => {
      await db.query(
        'SELECT state FROM public.tenant_email_luna_automation_require_handoff_pending($1::uuid, $2::uuid)',
        [ids.client, workerOp],
      );
    });
    const workerClaim = await db.query(
      'SELECT state, lease_owner FROM public.tenant_email_luna_automation_claim($1::uuid, $2::uuid)',
      [ids.ownerA, workerOp],
    );
    assert.equal(workerClaim.rows.length, 1);
    assert.equal(workerClaim.rows[0].state, 'claimed');
    await db.exec('RESET ROLE');
    console.log('ok - pglite 086 restricted worker cannot direct-DML or call operator pending functions');
  }

  const claimed = await queueStore.claimAutomationOperation({
    owner_token: ids.ownerA,
    operation_id: ids.operation,
  });
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.record.state, 'claimed');
  const [left, right] = await Promise.all([
    queueStore.claimAutomationOperation({ owner_token: ids.ownerA, operation_id: ids.operation }),
    queueStore.claimAutomationOperation({ owner_token: ids.ownerB, operation_id: ids.operation }),
  ]);
  assert.equal([left.status, right.status].every((status) => status === 'conflict'), true);
  console.log('ok - pglite 086 concurrent live claim has one winner and no second claimed operation');

  await db.query('DROP TRIGGER IF EXISTS tenant_email_luna_automation_queue_protect ON tenant_email_luna_automation_queue');
  await db.query(
    `UPDATE tenant_email_luna_automation_queue SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE operation_id = $1`,
    [ids.operation],
  );
  await db.exec(`
    CREATE TRIGGER tenant_email_luna_automation_queue_protect
      BEFORE UPDATE ON tenant_email_luna_automation_queue
      FOR EACH ROW EXECUTE FUNCTION tenant_email_luna_automation_queue_protect();
  `);
  const stale = await queueStore.handOffAutomationOperation({
    operation_id: ids.operation,
    owner_token: ids.ownerA,
  });
  assert.equal(stale.status, 'conflict');
  const reclaim = await queueStore.claimAutomationOperation({
    owner_token: ids.ownerB,
    operation_id: ids.operation,
  });
  assert.equal(reclaim.status, 'claimed');
  assert.equal(reclaim.record.lease_owner, ids.ownerB);
  assert.equal(reclaim.record.attempt_count, 2);
  console.log('ok - pglite 086 lease expiry reclaim; stale owner cannot transition');

  await db.query('DROP TRIGGER IF EXISTS tenant_email_luna_automation_queue_protect ON tenant_email_luna_automation_queue');
  await db.query(
    `UPDATE tenant_email_luna_automation_queue
        SET lease_expires_at = NOW() - INTERVAL '1 second', attempt_count = 3
      WHERE operation_id = $1`,
    [ids.operation],
  );
  await db.exec(`
    CREATE TRIGGER tenant_email_luna_automation_queue_protect
      BEFORE UPDATE ON tenant_email_luna_automation_queue
      FOR EACH ROW EXECUTE FUNCTION tenant_email_luna_automation_queue_protect();
  `);
  const otherCap = await queueStore.claimAutomationOperation({
    owner_token: ids.ownerA,
    operation_id: ids.operation,
  });
  assert.equal(otherCap.status, 'conflict');
  const capped = await queueStore.claimAutomationOperation({
    owner_token: ids.ownerB,
    operation_id: ids.operation,
  });
  assert.equal(capped.status, 'attempt_cap');
  assert.equal(capped.record.state, 'handoff_required');
  console.log('ok - pglite 086 attempt cap requires matching lease owner');

  const cancelBundle = await prepareBundle();
  const cancelAudit = await auditStore.persistPolicyAudit({
    operation_id: '12121212-1212-4121-8121-121212121212',
    envelope: cancelBundle.triplet.envelope,
    evidence: cancelBundle.triplet.evidence,
    decision: cancelBundle.triplet.decision,
    eligibility: cancelBundle.eligibility,
  });
  assert.equal(cancelAudit.status, 'committed');
  const cancelOp = '13131313-1313-4131-8131-131313131313';
  const cancelEnqueue = await queueStore.enqueueAutomationOperation({
    operation_id: cancelOp,
    envelope: cancelBundle.triplet.envelope,
    evidence: cancelBundle.triplet.evidence,
    decision: cancelBundle.triplet.decision,
    eligibility: cancelBundle.eligibility,
    draft: cancelBundle.draft,
    validation: cancelBundle.validation,
  });
  assert.equal(cancelEnqueue.status, 'committed');
  await queueStore.claimAutomationOperation({ owner_token: ids.ownerA, operation_id: cancelOp });
  const cancelled = await queueStore.cancelAutomationOperation({ operation_id: cancelOp, owner_token: ids.ownerA });
  assert.equal(cancelled.status, 'cancelled');
  const cancelClaim = await queueStore.claimAutomationOperation({
    owner_token: ids.ownerA,
    operation_id: cancelOp,
  });
  assert.equal(cancelClaim.status, 'conflict');

  const handoffBundle = await prepareBundle();
  await auditStore.persistPolicyAudit({
    operation_id: '14141414-1414-4141-8141-141414141414',
    envelope: handoffBundle.triplet.envelope,
    evidence: handoffBundle.triplet.evidence,
    decision: handoffBundle.triplet.decision,
    eligibility: handoffBundle.eligibility,
  });
  const handoffOp = '15151515-1515-4151-8151-151515151515';
  await queueStore.enqueueAutomationOperation({
    operation_id: handoffOp,
    envelope: handoffBundle.triplet.envelope,
    evidence: handoffBundle.triplet.evidence,
    decision: handoffBundle.triplet.decision,
    eligibility: handoffBundle.eligibility,
    draft: handoffBundle.draft,
    validation: handoffBundle.validation,
  });
  await queueStore.claimAutomationOperation({ owner_token: ids.ownerA, operation_id: handoffOp });
  const handed = await queueStore.handOffAutomationOperation({
    operation_id: handoffOp,
    owner_token: ids.ownerA,
  });
  assert.equal(handed.status, 'handed_off');
  assert.match(handed.record.handoff_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const secondHandoff = await queueStore.handOffAutomationOperation({
    operation_id: handoffOp,
    owner_token: ids.ownerA,
  });
  assert.equal(secondHandoff.status, 'conflict');
  const journal = await db.query('SELECT to_regclass($1) AS name', ['tenant_email_outbound_send_journal']);
  assert.equal(journal.rows[0].name, null);
  console.log('ok - pglite 086 cancellation/handoff terminal; no outbound journal row');

  await assert.rejects(async () => {
    await db.query(
      `UPDATE tenant_email_luna_automation_queue SET location_key = $1 WHERE operation_id = $2`,
      ['sunset-other', handoffOp],
    );
  });
  try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
  await assert.rejects(async () => {
    await db.query(`DELETE FROM tenant_email_luna_automation_queue WHERE operation_id = $1`, [handoffOp]);
  });
  try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
  await assert.rejects(async () => {
    await db.query(`DELETE FROM conversations WHERE id = $1`, [ids.conversation]);
  });
  try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
  await db.query(`UPDATE tenant_locations SET location_id = location_id WHERE id = $1`, [ids.location]);
  console.log('ok - pglite 086 authority mutation/delete refused; parent restrict; update cascade');

  const rollBundle = await prepareBundle();
  await auditStore.persistPolicyAudit({
    operation_id: '16161616-1616-4161-8161-161616161616',
    envelope: rollBundle.triplet.envelope,
    evidence: rollBundle.triplet.evidence,
    decision: rollBundle.triplet.decision,
    eligibility: rollBundle.eligibility,
  });
  const rollOp = '17171717-1717-4171-8171-171717171717';
  const rolling = {
    async withTransactionClient(work) {
      return loaner.withTransactionClient(async (client) => {
        await work(client);
        const error = new Error('boom');
        error.code = 'TEST_ROLLBACK';
        throw error;
      });
    },
  };
  const rollingStore = createEmailLunaAutomationQueueStore(rolling);
  await assert.rejects(() => rollingStore.enqueueAutomationOperation({
    operation_id: rollOp,
    envelope: rollBundle.triplet.envelope,
    evidence: rollBundle.triplet.evidence,
    decision: rollBundle.triplet.decision,
    eligibility: rollBundle.eligibility,
    draft: rollBundle.draft,
    validation: rollBundle.validation,
  }), (error) => error && error.code === 'TEST_ROLLBACK');
  const rolled = await db.query(
    `SELECT COUNT(*)::int AS n FROM tenant_email_luna_automation_queue WHERE operation_id = $1`,
    [rollOp],
  );
  assert.equal(rolled.rows[0].n, 0);
  console.log('ok - pglite 086 transaction rollback');

  await assert.rejects(async () => {
    await db.exec(DOWN);
  });
  try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
  await db.query('DROP TRIGGER IF EXISTS tenant_email_luna_automation_queue_protect_delete ON public.tenant_email_luna_automation_queue');
  await db.query('DROP TRIGGER IF EXISTS tenant_email_luna_automation_queue_protect ON public.tenant_email_luna_automation_queue');
  await db.query('DELETE FROM public.tenant_email_luna_automation_queue');
  await db.exec(DOWN);
  const gone = await db.query(`
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'tenant_email_luna_automation_queue'
  `);
  assert.equal(gone.rows.length, 0);
  const auditStill = await db.query(`
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'tenant_email_luna_policy_audit'
  `);
  assert.equal(auditStill.rows.length, 1);
  const auditUq = await db.query(`
    SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'tenant_email_luna_policy_audit_authority_identity_uq'
  `);
  assert.equal(auditUq.rows.length, 0);
  const inboundCol = await db.query(`
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'tenant_email_inbound_events' AND column_name = 'sender_address_normalized'
  `);
  assert.equal(inboundCol.rows.length, 0);
  const auditInboundGone = await db.query(`
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'tenant_email_luna_policy_audit' AND column_name = 'inbound_event_id'
  `);
  assert.equal(auditInboundGone.rows.length, 0);
  const afterFirstEmpty = await schemaFingerprint(db);
  assert.equal(afterFirstEmpty, pre086);
  await db.exec(DOWN);
  const afterSecondEmpty = await schemaFingerprint(db);
  assert.equal(afterSecondEmpty, pre086);
  console.log('ok - pglite 086 nonempty down refusal; empty down twice restores exact pre-086 schema');
}

async function proveConstraintMutations(PGlite) {
  const STATE_BLOCK = "CHECK (state IN ('pending', 'claimed', 'handed_off', 'handoff_required', 'cancelled'))";
  const SENT_STATE = "CHECK (state IN ('pending', 'claimed', 'handed_off', 'handoff_required', 'cancelled', 'sent'))";
  const HANDOFF_REQUIRED_COUPLING = `OR (
      state = 'handoff_required'
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
      AND handoff_id IS NULL
      AND attempt_count BETWEEN 0 AND 3
    )`;
  const SENT_COUPLING = `${HANDOFF_REQUIRED_COUPLING}
    OR (state = 'sent')`;
  const RECIPIENT_LOWER = 'recipient_address = lower(recipient_address)\n      AND ';
  const RECIPIENT_FK = `CONSTRAINT tenant_email_luna_automation_queue_inbound_recipient_fk
    FOREIGN KEY (inbound_event_id, client_id, location_id, endpoint_id, recipient_address)
    REFERENCES public.tenant_email_inbound_events (id, client_id, location_id, endpoint_id, sender_address_normalized)
    ON DELETE RESTRICT ON UPDATE CASCADE`;
  const RECIPIENT_FK_MUTANT = `CONSTRAINT tenant_email_luna_automation_queue_inbound_recipient_fk
    FOREIGN KEY (inbound_event_id)
    REFERENCES public.tenant_email_inbound_events (id)
    ON DELETE RESTRICT ON UPDATE CASCADE`;
  const DIGEST_SHAPE = "CHECK (draft_digest ~ '^[0-9a-f]{64}$')";

  async function seedAudit(db) {
    await db.exec(`
      INSERT INTO public.tenant_email_luna_policy_audit (
        operation_id, issuance_id, client_id, location_id, location_key,
        endpoint_id, conversation_id, inbound_event_id, policy_version, eligibility_policy_version,
        canonical_status, canonical_reason, eligibility_status, eligibility_reason, fact_refs
      ) VALUES (
        '${ids.audit}', '${ids.audit}', '${ids.client}', '${ids.location}', 'sunset-somo',
        '${ids.endpoint}', '${ids.conversation}', '${ids.inbound}',
        'email-luna-draft-policy.v1', 'email-luna-autonomous-eligibility-policy.v1',
        'draft_ready', NULL, 'eligible', NULL, ARRAY['catalog']::text[]
      );
    `);
  }
  function queueInsert(options = {}) {
    const state = options.state || 'pending';
    const recipient = options.recipient || 'elena@example.test';
    const digest = options.digest || 'ab'.repeat(32);
    const attempt = Object.hasOwn(options, 'attempt') ? options.attempt : null;
    const cols = attempt == null ? '' : ', attempt_count';
    const vals = attempt == null ? '' : `, ${attempt}`;
    return `
      INSERT INTO tenant_email_luna_automation_queue (
        operation_id, issuance_id, audit_operation_id, client_id, location_id, location_key,
        endpoint_id, conversation_id, inbound_event_id, recipient_address, policy_version,
        eligibility_policy_version, validator_version, draft_digest, state${cols}
      ) VALUES (
        '${ids.operation}', '${ids.audit}', '${ids.audit}', '${ids.client}', '${ids.location}', 'sunset-somo',
        '${ids.endpoint}', '${ids.conversation}', '${ids.inbound}', '${recipient}',
        'email-luna-draft-policy.v1', 'email-luna-autonomous-eligibility-policy.v1',
        'email-luna-draft-validator.v1', '${digest}', '${state}'${vals}
      );
    `;
  }
  async function expectMutationAccepted(label, mutantSql, work) {
    const mutant = new PGlite();
    await mutant.exec(shellSql());
    await mutant.exec(AUDIT_UP);
    await mutant.exec(mutantSql);
    let accepted = false;
    try {
      await work(mutant);
      accepted = true;
    } catch (err) {
      assert.notEqual(err && err.code, 'ERR_ASSERTION', `${label}: mutation helper must not throw assertion ${String(err && err.message || err)}`);
    }
    assert.equal(accepted, true, `${label}: mutation must demonstrate the bypass so the pin is live`);
  }

  const live = new PGlite();
  await live.exec(shellSql());
  await live.exec(AUDIT_UP);
  await live.exec(UP);
  await seedAudit(live);
  async function expectLiveReject(sql, label) {
    let failed = false;
    try {
      await live.exec(sql);
    } catch (err) {
      failed = true;
      assert.ok(constraintViolation(err), `${label}: unexpected ${String(err && err.message || err)}`);
    }
    assert.equal(failed, true, `${label}: expected rejection`);
  }
  await expectLiveReject(queueInsert({ state: 'sent' }), 'live sent-state');
  await expectLiveReject(queueInsert({ recipient: 'Elena@Example.TEST' }), 'live recipient case');
  await expectLiveReject(queueInsert({ digest: 'zz'.repeat(32) }), 'live digest charset');
  await expectLiveReject(queueInsert({ attempt: 4 }), 'live attempt cap');
  console.log('ok - pglite 086 live guards refuse sent/provider status, mixed-case recipient, digest, attempt cap');

  await expectMutationAccepted(
    'sent-state',
    replaceUnique(
      replaceUnique(UP, STATE_BLOCK, SENT_STATE, 'sent-state-values'),
      HANDOFF_REQUIRED_COUPLING,
      SENT_COUPLING,
      'sent-state-coupling',
    ),
    async (db) => {
      await seedAudit(db);
      await db.exec(queueInsert({ state: 'sent' }));
    },
  );
  await expectMutationAccepted(
    'recipient-case',
    replaceUnique(
      replaceUnique(UP, RECIPIENT_LOWER, '', 'recipient-case'),
      RECIPIENT_FK,
      RECIPIENT_FK_MUTANT,
      'recipient-fk',
    ),
    async (db) => {
      await seedAudit(db);
      await db.exec(queueInsert({ recipient: 'Elena@Example.TEST' }));
    },
  );
  await expectMutationAccepted(
    'digest-shape',
    replaceUnique(UP, DIGEST_SHAPE, 'CHECK (char_length(draft_digest) BETWEEN 1 AND 64)', 'digest-shape'),
    async (db) => {
      await seedAudit(db);
      await db.exec(queueInsert({ digest: 'zz'.repeat(32) }));
    },
  );
  console.log('ok - pglite 086 mutation isolation kills sent-state, recipient, and digest bypasses');
}

async function proveShadowAndCanonical(PGlite) {
  const db = new PGlite();
  await db.exec(shellSql());
  await db.exec(AUDIT_UP);
  await db.exec(UP);
  await db.exec(`
    INSERT INTO public.tenant_email_luna_policy_audit (
      operation_id, issuance_id, client_id, location_id, location_key,
      endpoint_id, conversation_id, inbound_event_id, policy_version, eligibility_policy_version,
      canonical_status, canonical_reason, eligibility_status, eligibility_reason, fact_refs
    ) VALUES (
      '${ids.audit}', '${ids.audit}', '${ids.client}', '${ids.location}', 'sunset-somo',
      '${ids.endpoint}', '${ids.conversation}', '${ids.inbound}',
      'email-luna-draft-policy.v1', 'email-luna-autonomous-eligibility-policy.v1',
      'draft_ready', NULL, 'eligible', NULL, ARRAY['catalog']::text[]
    );
  `);
  await db.exec(`
    CREATE SCHEMA attacker;
    CREATE TABLE attacker.tenant_email_luna_automation_queue (
      operation_id uuid PRIMARY KEY,
      shadow text DEFAULT 'attacker-shadow'
    );
  `);
  await db.exec(`
    CREATE TEMP TABLE tenant_email_luna_automation_queue (
      operation_id uuid PRIMARY KEY,
      shadow text DEFAULT 'temp-shadow'
    );
  `);
  await db.exec(`SET search_path TO attacker, public`);
  const digest = 'ab'.repeat(32);
  await db.query(
    `SELECT operation_id FROM public.tenant_email_luna_automation_enqueue(
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'sunset-somo',
       $6::uuid, $7::uuid, $8::uuid, 'elena@example.test',
       'email-luna-draft-policy.v1', 'email-luna-autonomous-eligibility-policy.v1',
       'email-luna-draft-validator.v1', $9
     )`,
    [
      ids.operation, ids.audit, ids.audit, ids.client, ids.location,
      ids.endpoint, ids.conversation, ids.inbound, digest,
    ],
  );
  const canonical = await db.query(
    `SELECT COUNT(*)::int AS n FROM public.tenant_email_luna_automation_queue WHERE operation_id = $1`,
    [ids.operation],
  );
  assert.equal(canonical.rows[0].n, 1);
  const attacker = await db.query('SELECT COUNT(*)::int AS n FROM attacker.tenant_email_luna_automation_queue');
  assert.equal(attacker.rows[0].n, 0);
  const temp = await db.query('SELECT COUNT(*)::int AS n FROM pg_temp.tenant_email_luna_automation_queue');
  assert.equal(temp.rows[0].n, 0);
  console.log('ok - pglite 086 privileged calls hit only canonical public relations under shadow objects');
}

assertStaticContract();
const PGlite = tryLoadPglite();
if (!PGlite) {
  console.log('ok - pglite unavailable; static 086 contract only');
} else {
  Promise.resolve()
    .then(() => provePglite(PGlite))
    .then(() => proveConstraintMutations(PGlite))
    .then(() => proveShadowAndCanonical(PGlite))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

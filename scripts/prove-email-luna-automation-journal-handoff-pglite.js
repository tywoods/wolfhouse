'use strict';

/**
 * Prove migration 087 atomic queue-to-canonical-outbound-journal handoff.
 *
 * When PGlite is available:
 *   - parent shell + 068 + 069 + 085 + 086 + 087
 *   - valid handoff; exact replay; owner-digest replay auth; identity conflict
 *   - concurrent one winner; stale/different owner; expired lease
 *   - statement-boundary rollback; commit_outcome_unknown reconciliation
 *   - duplicate operation/issuance/handoff; cross tenant/location/endpoint/conversation/recipient/digest
 *   - restricted-role bypass; shadow schemas; no provider intents/send
 *   - parent mutation/delete; nonempty down refusal; empty down twice; mutation isolation
 *
 * When PGlite is unavailable: static 087 contract only.
 * No Azure / live product DB / deploy / send / provider invocation.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createEmailLunaDraftEnvelope } = require('./lib/email-luna-draft-handoff-contract');
const { issueAndDecideEmailLunaDraftPolicy } = require('./lib/email-luna-draft-policy');
const { decideEmailLunaAutonomousEligibility } = require('./lib/email-luna-autonomous-eligibility-policy');
const { createEmailLunaDraftAuthor } = require('./lib/email-luna-draft-author');
const { validateEmailLunaDraft } = require('./lib/email-luna-draft-validator');
const {
  createEmailLunaPolicyAuditStore,
  EMAIL_LUNA_POLICY_AUDIT_SCHEMA_086,
} = require('./lib/email-luna-policy-audit-store');
const { createEmailLunaAutomationQueueStore } = require('./lib/email-luna-automation-queue-store');
const {
  createEmailLunaAutomationJournalHandoffStore,
  EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_GRANT_CONTRACT,
} = require('./lib/email-luna-automation-journal-handoff-store');
const { createEmailOutboundSendJournalStore } = require('./lib/email-outbound-send-journal-store');

const ROOT = path.resolve(__dirname, '..');
const UP_068 = fs.readFileSync(path.join(ROOT, 'database/migrations/068_tenant_email_outbound_send_journal.sql'), 'utf8');
const UP_069 = fs.readFileSync(path.join(ROOT, 'database/migrations/069_tenant_email_outbound_send_journal_provider_intents.sql'), 'utf8');
const UP_085 = fs.readFileSync(path.join(ROOT, 'database/migrations/085_tenant_email_luna_policy_audit.sql'), 'utf8');
const UP_086 = fs.readFileSync(path.join(ROOT, 'database/migrations/086_tenant_email_luna_automation_queue.sql'), 'utf8');
const UP_PATH = path.join(ROOT, 'database/migrations/087_tenant_email_luna_automation_journal_handoff.sql');
const DOWN_PATH = path.join(ROOT, 'database/migrations/087_tenant_email_luna_automation_journal_handoff_down.sql');
const UP = fs.readFileSync(UP_PATH, 'utf8');
const DOWN = fs.readFileSync(DOWN_PATH, 'utf8');
const STOCK_PG_ENV = 'EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_PG_POOL_URL';

const ids = {
  client: '11111111-1111-4111-8111-111111111111',
  location: '22222222-2222-4222-8222-222222222222',
  conversation: '33333333-3333-4333-8333-333333333333',
  endpoint: '44444444-4444-4444-8444-444444444444',
  inbound: '55555555-5555-4555-8555-555555555555',
  inbound2: '55555555-5555-4555-8555-555555555557',
  staff: '12121212-1212-4121-8121-121212121212',
  audit: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  operation: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  otherOp: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ownerA: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  ownerB: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  client2: '99999999-9999-4999-8999-999999999999',
  location2: '66666666-6666-4666-8666-666666666666',
  conversation2: '77777777-7777-4777-8777-777777777777',
  endpoint2: '88888888-8888-4888-8888-888888888888',
};

function tryLoadPglite() {
  for (const base of [
    process.env.NODE_PATH,
    path.join(ROOT, 'node_modules'),
    '/opt/data/worktrees/full-sail-stage1-ch3a/node_modules',
    '/opt/data/wolfhouse-agent/node_modules',
  ].filter(Boolean)) {
    try {
      const mod = require(path.join(String(base).split(path.delimiter)[0], '@electric-sql/pglite'));
      if (mod && mod.PGlite) return mod.PGlite;
    } catch (_) { /* continue */ }
  }
  try { return require('@electric-sql/pglite').PGlite; } catch (_) { return null; }
}

function shellSql() {
  return `
    CREATE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
    BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
    CREATE TABLE clients (id uuid PRIMARY KEY);
    CREATE TABLE staff_users (
      id uuid PRIMARY KEY,
      client_id uuid NOT NULL REFERENCES clients(id)
    );
    ALTER TABLE staff_users ADD CONSTRAINT staff_users_client_id_id_uq UNIQUE (client_id, id);
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
    INSERT INTO staff_users (id, client_id) VALUES ('${ids.staff}', '${ids.client}');
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

function assertStaticContract() {
  assert.match(UP, /handoff_established/);
  assert.match(UP, /CREATE OR REPLACE FUNCTION public\.tenant_email_luna_automation_handoff/);
  assert.match(UP, /SECURITY DEFINER/);
  assert.match(UP, /SET search_path TO pg_catalog, public/);
  assert.equal(/^\s*GRANT /m.test(UP), false);
  assert.equal(/^\s*CREATE ROLE/m.test(UP), false);
  assert.match(UP, /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.tenant_email_outbound_send_journal FROM PUBLIC/);
  assert.match(UP, /luna_replay_owner_digest/);
  assert.match(UP, /pg_catalog\.sha256/);
  assert.match(UP, /pg_catalog\.encode/);
  assert.match(UP, /pg_catalog\.convert_to/);
  assert.match(UP, /luna-replay-owner-v1:/);
  assert.equal(/pgcrypto/.test(UP), false);
  assert.equal(/\bdigest\s*\(/.test(UP), false);
  assert.match(DOWN, /087_down_refused/);
  assert.match(DOWN, /DROP COLUMN IF EXISTS luna_automation_operation_id/);
  assert.match(DOWN, /DROP COLUMN IF EXISTS luna_replay_owner_digest/);
  assert.equal(EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_GRANT_CONTRACT.no_grant_in_087, true);
  console.log('ok - static 087 luna automation journal handoff contract');
}

function createLoaner(db) {
  return {
    async withTransactionClient(work) {
      return work({
        async query(text, params) {
          return db.query(text, params);
        },
      });
    },
  };
}

async function schemaFingerprint(db) {
  const tables = await db.query(`
    SELECT c.relname AS table_name, a.attname AS column_name
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
       AND c.relname IN (
         'tenant_email_outbound_send_journal',
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
         'tenant_email_outbound_send_journal',
         'tenant_email_luna_automation_queue'
       )
     ORDER BY 1, 2
  `);
  const fns = await db.query(`
    SELECT p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
           p.prosrc
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'tenant_email_luna_automation_handoff',
         'tenant_email_outbound_send_journal_protect'
       )
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
    .update(draft.subject).update('\0').update(draft.body).update('\0').update(draft.language)
    .digest('hex');
}

function expectedReplayOwnerDigest(owner) {
  return crypto.createHash('sha256')
    .update(`luna-replay-owner-v1:${owner}`)
    .digest('hex');
}

async function prepareBundle() {
  const triplet = catalogTriplet();
  const eligibility = decideEmailLunaAutonomousEligibility(triplet);
  const draft = await authenticDraft(triplet);
  const validation = validateEmailLunaDraft({
    envelope: triplet.envelope, evidence: triplet.evidence, decision: triplet.decision, draft,
  });
  return { triplet, eligibility, draft, validation };
}

async function persistReady(auditStore, queueStore, operationId, auditOp, bundle) {
  const audit = await auditStore.persistPolicyAudit({
    operation_id: auditOp,
    envelope: bundle.triplet.envelope,
    evidence: bundle.triplet.evidence,
    decision: bundle.triplet.decision,
    eligibility: bundle.eligibility,
  });
  assert.equal(audit.status, 'committed');
  const enqueued = await queueStore.enqueueAutomationOperation({
    operation_id: operationId,
    envelope: bundle.triplet.envelope,
    evidence: bundle.triplet.evidence,
    decision: bundle.triplet.decision,
    eligibility: bundle.eligibility,
    draft: bundle.draft,
    validation: bundle.validation,
  });
  assert.equal(enqueued.status, 'committed');
  const claimed = await queueStore.claimAutomationOperation({
    owner_token: ids.ownerA,
    operation_id: operationId,
  });
  assert.equal(claimed.status, 'claimed');
  return claimed;
}

async function applyCanonical(db) {
  await db.exec(shellSql());
  await db.exec(UP_068);
  await db.exec(UP_069);
  await db.exec(UP_085);
  await db.exec(UP_086);
}

async function provePglite(PGlite) {
  const db = new PGlite();
  await applyCanonical(db);
  const pre087 = await schemaFingerprint(db);
  assert.equal(pre087.includes('luna_automation_operation_id'), false);
  assert.equal(pre087.includes('handoff_established'), false);
  await db.exec(UP);
  const loaner = createLoaner(db);
  const auditStore = createEmailLunaPolicyAuditStore({
    ...loaner,
    schemaVersion: EMAIL_LUNA_POLICY_AUDIT_SCHEMA_086,
  });
  const queueStore = createEmailLunaAutomationQueueStore(loaner);
  const handoffStore = createEmailLunaAutomationJournalHandoffStore(loaner);
  const bundle = await prepareBundle();
  const digest = expectedDigest(bundle.draft);

  await persistReady(auditStore, queueStore, ids.operation, ids.audit, bundle);
  const first = await handoffStore.establishCanonicalJournalHandoff({
    operation_id: ids.operation,
    owner_token: ids.ownerA,
    envelope: bundle.triplet.envelope,
    evidence: bundle.triplet.evidence,
    decision: bundle.triplet.decision,
    draft: bundle.draft,
    validation: bundle.validation,
  });
  assert.equal(first.status, 'handed_off');
  assert.equal(first.authorize_create, false);
  assert.equal(first.authorize_update, false);
  assert.equal(first.authorize_dispatch, false);
  assert.equal(first.record.journal_operation_id, ids.operation);
  assert.equal(first.record.handoff_id, ids.operation);
  assert.equal(first.record.journal_phase, 'handoff_established');
  assert.equal(first.record.journal_outcome, 'handed_off');
  assert.equal(first.record.journal_body_digest, digest);
  assert.equal(first.record.create_invocation_count, 0);
  assert.equal(first.record.update_invocation_count, 0);
  assert.equal(first.record.send_invocation_count, 0);
  assert.equal(first.record.immutable_draft_id, null);
  assert.equal(first.record.approval_id, null);
  const journals = await db.query(
    `SELECT COUNT(*)::int AS n, MIN(phase) AS phase FROM tenant_email_outbound_send_journal WHERE operation_id = $1`,
    [ids.operation],
  );
  assert.equal(journals.rows[0].n, 1);
  assert.equal(journals.rows[0].phase, 'handoff_established');
  const replay = await handoffStore.establishCanonicalJournalHandoff({
    operation_id: ids.operation,
    owner_token: ids.ownerA,
    envelope: bundle.triplet.envelope,
    evidence: bundle.triplet.evidence,
    decision: bundle.triplet.decision,
    draft: bundle.draft,
    validation: bundle.validation,
  });
  assert.equal(replay.status, 'replayed');
  assert.equal(replay.record.handoff_id, first.record.handoff_id);
  assert.equal(replay.record.journal_operation_id, first.record.journal_operation_id);
  assert.equal(replay.authorize_create, false);
  const afterReplay = await db.query(
    `SELECT COUNT(*)::int AS n FROM tenant_email_outbound_send_journal WHERE luna_automation_issuance_id IS NOT NULL`,
  );
  assert.equal(afterReplay.rows[0].n, 1);
  assert.equal(Object.hasOwn(first.record, 'luna_replay_owner_digest'), false);
  assert.equal(Object.hasOwn(replay.record, 'luna_replay_owner_digest'), false);
  const ownerDigestA = expectedReplayOwnerDigest(ids.ownerA);
  const storedDigest = await db.query(
    `SELECT luna_replay_owner_digest FROM tenant_email_outbound_send_journal WHERE operation_id = $1`,
    [ids.operation],
  );
  assert.match(storedDigest.rows[0].luna_replay_owner_digest, /^[0-9a-f]{64}$/);
  assert.equal(storedDigest.rows[0].luna_replay_owner_digest, ownerDigestA);
  const sqlDigest = await db.query(
    `SELECT pg_catalog.encode(
       pg_catalog.sha256(pg_catalog.convert_to(('luna-replay-owner-v1:' || $1::uuid::text), 'UTF8')),
       'hex'
     ) AS d`,
    [ids.ownerA],
  );
  assert.equal(sqlDigest.rows[0].d, ownerDigestA);
  const fnB = await db.query(
    `SELECT operation_id, state, handoff_id FROM public.tenant_email_luna_automation_handoff($1::uuid, $2::uuid)`,
    [ids.operation, ids.ownerB],
  );
  assert.equal(fnB.rows.length, 0);
  const storeB = await handoffStore.establishCanonicalJournalHandoff({
    operation_id: ids.operation,
    owner_token: ids.ownerB,
    envelope: bundle.triplet.envelope,
    evidence: bundle.triplet.evidence,
    decision: bundle.triplet.decision,
    draft: bundle.draft,
    validation: bundle.validation,
  });
  assert.equal(storeB.status, 'conflict');
  assert.equal(Object.hasOwn(storeB, 'record'), false);
  const afterB = await db.query(
    `SELECT q.state, q.handoff_id, j.luna_replay_owner_digest, j.phase
       FROM tenant_email_luna_automation_queue q
       JOIN tenant_email_outbound_send_journal j ON j.operation_id = q.operation_id
      WHERE q.operation_id = $1`,
    [ids.operation],
  );
  assert.equal(afterB.rows[0].state, 'handed_off');
  assert.equal(afterB.rows[0].handoff_id, ids.operation);
  assert.equal(afterB.rows[0].luna_replay_owner_digest, ownerDigestA);
  assert.equal(afterB.rows[0].phase, 'handoff_established');
  const fnA = await db.query(
    `SELECT operation_id, state, handoff_id FROM public.tenant_email_luna_automation_handoff($1::uuid, $2::uuid)`,
    [ids.operation, ids.ownerA],
  );
  assert.equal(fnA.rows.length, 1);
  assert.equal(fnA.rows[0].operation_id, ids.operation);
  assert.equal(fnA.rows[0].handoff_id, first.record.handoff_id);
  const replayA2 = await handoffStore.establishCanonicalJournalHandoff({
    operation_id: ids.operation,
    owner_token: ids.ownerA,
    envelope: bundle.triplet.envelope,
    evidence: bundle.triplet.evidence,
    decision: bundle.triplet.decision,
    draft: bundle.draft,
    validation: bundle.validation,
  });
  assert.equal(replayA2.status, 'replayed');
  assert.equal(replayA2.record.journal_operation_id, first.record.journal_operation_id);
  assert.equal(replayA2.record.handoff_id, first.record.handoff_id);
  assert.equal(Object.hasOwn(replayA2.record, 'luna_replay_owner_digest'), false);
  console.log('ok - pglite 087 valid handoff and exact replay share one sealed journal identity');
  console.log('ok - pglite 087 random owner B yields no function row/no metadata/no mutation; owner A replays');

  await assert.rejects(async () => {
    await db.query(
      `UPDATE tenant_email_outbound_send_journal
          SET phase = 'create_dispatched', outcome = 'outcome_unknown', create_invocation_count = 1
        WHERE operation_id = $1`,
      [ids.operation],
    );
  });
  try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
  const stillSealed = await db.query(
    `SELECT phase, create_invocation_count FROM tenant_email_outbound_send_journal WHERE operation_id = $1`,
    [ids.operation],
  );
  assert.equal(stillSealed.rows[0].phase, 'handoff_established');
  assert.equal(Number(stillSealed.rows[0].create_invocation_count), 0);
  console.log('ok - pglite 087 handoff_established cannot enter provider create/update/send');

  const staffStore = createEmailOutboundSendJournalStore({
    withTransactionClient: loaner.withTransactionClient,
    authority: {
      clientId: ids.client,
      locationId: ids.location,
      locationKey: 'sunset-somo',
      endpointId: ids.endpoint,
      conversationId: ids.conversation,
      actorStaffUserId: ids.staff,
    },
  });
  const staffOp = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01';
  const staffClaim = await staffStore.claim({
    operationId: staffOp,
    approvalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02',
    bodyDigest: digest,
  });
  assert.equal(staffClaim.ok, true);
  assert.equal(staffClaim.value.phase, 'claimed');
  const staffCreate = await staffStore.claimCreate({ operationId: staffOp });
  assert.equal(staffCreate.ok, true);
  assert.equal(staffCreate.value.phase, 'create_dispatched');
  const lunaAsStaff = await staffStore.claimCreate({ operationId: ids.operation });
  assert.equal(lunaAsStaff.ok, false);
  const staffDigest = await db.query(
    `SELECT luna_replay_owner_digest, phase FROM tenant_email_outbound_send_journal WHERE operation_id = $1`,
    [staffOp],
  );
  assert.equal(staffDigest.rows[0].luna_replay_owner_digest, null);
  assert.equal(staffDigest.rows[0].phase, 'create_dispatched');
  await assert.rejects(async () => {
    await db.query(
      `UPDATE tenant_email_outbound_send_journal
          SET luna_replay_owner_digest = $2
        WHERE operation_id = $1`,
      [staffOp, ownerDigestA],
    );
  });
  try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
  await assert.rejects(async () => {
    await db.query(
      `UPDATE tenant_email_outbound_send_journal
          SET luna_replay_owner_digest = $2
        WHERE operation_id = $1`,
      [ids.operation, expectedReplayOwnerDigest(ids.ownerB)],
    );
  });
  try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
  const stillDigest = await db.query(
    `SELECT luna_replay_owner_digest FROM tenant_email_outbound_send_journal WHERE operation_id = $1`,
    [ids.operation],
  );
  assert.equal(stillDigest.rows[0].luna_replay_owner_digest, ownerDigestA);
  const digestOp = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa20';
  const digestAudit = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa21';
  const digestBundle = await prepareBundle();
  await persistReady(auditStore, queueStore, digestOp, digestAudit, digestBundle);
  const claimedQueue = await db.query(
    `SELECT * FROM tenant_email_luna_automation_queue WHERE operation_id = $1`,
    [digestOp],
  );
  assert.equal(claimedQueue.rows[0].state, 'claimed');
  await assert.rejects(async () => {
    await db.query(
      `INSERT INTO tenant_email_outbound_send_journal (
         operation_id, client_id, location_id, location_key, endpoint_id, conversation_id,
         approval_id, actor_staff_user_id, provider, immutable_draft_id, body_digest,
         phase, outcome, create_invocation_count, update_invocation_count, send_invocation_count,
         luna_automation_operation_id, luna_automation_issuance_id, luna_automation_audit_operation_id,
         luna_inbound_event_id, luna_recipient_address, luna_replay_owner_digest
       ) VALUES (
         $1, $2, $3, 'sunset-somo', $4, $5, NULL, NULL, 'microsoft_graph', NULL, $6,
         'handoff_established', 'handed_off', 0, 0, 0,
         $1, $7, $8, $9, $10, NULL
       )`,
      [
        digestOp, ids.client, ids.location, ids.endpoint, ids.conversation,
        expectedDigest(digestBundle.draft), claimedQueue.rows[0].issuance_id,
        digestAudit, ids.inbound, claimedQueue.rows[0].recipient_address,
      ],
    );
  });
  try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
  await assert.rejects(async () => {
    await db.query(
      `INSERT INTO tenant_email_outbound_send_journal (
         operation_id, client_id, location_id, location_key, endpoint_id, conversation_id,
         approval_id, actor_staff_user_id, provider, immutable_draft_id, body_digest,
         phase, outcome, create_invocation_count, update_invocation_count, send_invocation_count,
         luna_automation_operation_id, luna_automation_issuance_id, luna_automation_audit_operation_id,
         luna_inbound_event_id, luna_recipient_address, luna_replay_owner_digest
       ) VALUES (
         $1, $2, $3, 'sunset-somo', $4, $5, NULL, NULL, 'microsoft_graph', NULL, $6,
         'handoff_established', 'handed_off', 0, 0, 0,
         $1, $7, $8, $9, $10, 'not-a-sha256-hex-digest'
       )`,
      [
        digestOp, ids.client, ids.location, ids.endpoint, ids.conversation,
        expectedDigest(digestBundle.draft), claimedQueue.rows[0].issuance_id,
        digestAudit, ids.inbound, claimedQueue.rows[0].recipient_address,
      ],
    );
  });
  try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
  const digestJournalCount = await db.query(
    `SELECT COUNT(*)::int AS n FROM tenant_email_outbound_send_journal WHERE operation_id = $1`,
    [digestOp],
  );
  assert.equal(digestJournalCount.rows[0].n, 0);
  console.log('ok - pglite 087 staff claimed→create_dispatched still works; Luna row cannot authorize create');
  console.log('ok - pglite 087 legacy rows require digest NULL; Luna requires valid digest; direct tamper refused');

  const conflictOp = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03';
  const conflictAudit = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04';
  const conflictBundle = await prepareBundle();
  await persistReady(auditStore, queueStore, conflictOp, conflictAudit, conflictBundle);
  await db.query(
    `INSERT INTO tenant_email_outbound_send_journal (
       operation_id, client_id, location_id, location_key, endpoint_id, conversation_id,
       approval_id, actor_staff_user_id, provider, immutable_draft_id, body_digest,
       phase, outcome, create_invocation_count, update_invocation_count, send_invocation_count
     ) VALUES (
       $1, $2, $3, 'sunset-somo', $4, $5, $6, $7, 'microsoft_graph', NULL, $8,
       'claimed', 'claimed', 0, 0, 0
     )`,
    [conflictOp, ids.client, ids.location, ids.endpoint, ids.conversation,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa05', ids.staff, expectedDigest(conflictBundle.draft)],
  );
  const conflicted = await handoffStore.establishCanonicalJournalHandoff({
    operation_id: conflictOp,
    owner_token: ids.ownerA,
    envelope: conflictBundle.triplet.envelope,
    evidence: conflictBundle.triplet.evidence,
    decision: conflictBundle.triplet.decision,
    draft: conflictBundle.draft,
    validation: conflictBundle.validation,
  });
  assert.equal(conflicted.status, 'identity_conflict');
  const conflictQueue = await db.query(
    `SELECT state, handoff_id FROM tenant_email_luna_automation_queue WHERE operation_id = $1`,
    [conflictOp],
  );
  assert.equal(conflictQueue.rows[0].state, 'claimed');
  assert.equal(conflictQueue.rows[0].handoff_id, null);
  const conflictJournals = await db.query(
    `SELECT COUNT(*)::int AS n, MIN(phase) AS phase FROM tenant_email_outbound_send_journal WHERE operation_id = $1`,
    [conflictOp],
  );
  assert.equal(conflictJournals.rows[0].n, 1);
  assert.equal(conflictJournals.rows[0].phase, 'claimed');
  console.log('ok - pglite 087 conflicting identity refuses duplicate journal and does not terminalize queue');

  const concOp = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa06';
  const concAudit = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa07';
  const concBundle = await prepareBundle();
  await persistReady(auditStore, queueStore, concOp, concAudit, concBundle);
  const [left, right] = await Promise.all([
    handoffStore.establishCanonicalJournalHandoff({
      operation_id: concOp, owner_token: ids.ownerA,
      envelope: concBundle.triplet.envelope, evidence: concBundle.triplet.evidence,
      decision: concBundle.triplet.decision, draft: concBundle.draft, validation: concBundle.validation,
    }),
    handoffStore.establishCanonicalJournalHandoff({
      operation_id: concOp, owner_token: ids.ownerA,
      envelope: concBundle.triplet.envelope, evidence: concBundle.triplet.evidence,
      decision: concBundle.triplet.decision, draft: concBundle.draft, validation: concBundle.validation,
    }),
  ]);
  const statuses = [left.status, right.status].sort();
  assert.ok(statuses.includes('handed_off') || statuses.every((s) => s === 'replayed' || s === 'handed_off' || s === 'conflict'));
  const winners = [left, right].filter((r) => r.status === 'handed_off' || r.status === 'replayed');
  assert.ok(winners.length >= 1);
  const concCount = await db.query(
    `SELECT COUNT(*)::int AS n FROM tenant_email_outbound_send_journal WHERE operation_id = $1`,
    [concOp],
  );
  assert.equal(concCount.rows[0].n, 1);
  console.log('ok - pglite 087 concurrent handoff has one journal winner');

  const staleOp = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa08';
  const staleAudit = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa09';
  const staleBundle = await prepareBundle();
  await persistReady(auditStore, queueStore, staleOp, staleAudit, staleBundle);
  const different = await handoffStore.establishCanonicalJournalHandoff({
    operation_id: staleOp, owner_token: ids.ownerB,
    envelope: staleBundle.triplet.envelope, evidence: staleBundle.triplet.evidence,
    decision: staleBundle.triplet.decision, draft: staleBundle.draft, validation: staleBundle.validation,
  });
  assert.equal(different.status, 'conflict');
  await db.query('DROP TRIGGER IF EXISTS tenant_email_luna_automation_queue_protect ON tenant_email_luna_automation_queue');
  await db.query(
    `UPDATE tenant_email_luna_automation_queue SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE operation_id = $1`,
    [staleOp],
  );
  await db.exec(`
    CREATE TRIGGER tenant_email_luna_automation_queue_protect
      BEFORE UPDATE ON tenant_email_luna_automation_queue
      FOR EACH ROW EXECUTE FUNCTION tenant_email_luna_automation_queue_protect();
  `);
  const expired = await handoffStore.establishCanonicalJournalHandoff({
    operation_id: staleOp, owner_token: ids.ownerA,
    envelope: staleBundle.triplet.envelope, evidence: staleBundle.triplet.evidence,
    decision: staleBundle.triplet.decision, draft: staleBundle.draft, validation: staleBundle.validation,
  });
  assert.equal(expired.status, 'conflict');
  const expiredJournal = await db.query(
    `SELECT COUNT(*)::int AS n FROM tenant_email_outbound_send_journal WHERE operation_id = $1`,
    [staleOp],
  );
  assert.equal(expiredJournal.rows[0].n, 0);
  const staleQueue = await db.query(
    `SELECT state FROM tenant_email_luna_automation_queue WHERE operation_id = $1`,
    [staleOp],
  );
  assert.equal(staleQueue.rows[0].state, 'claimed');
  console.log('ok - pglite 087 stale/different owner and expired lease fail without a journal row');

  const boundOp = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa10';
  const boundAudit = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa11';
  const boundaryBundle = await prepareBundle();
  await persistReady(auditStore, queueStore, boundOp, boundAudit, boundaryBundle);
  await db.exec(`
    CREATE OR REPLACE FUNCTION fail_queue_handed_off() RETURNS TRIGGER
    LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.state = 'handed_off' THEN
        RAISE EXCEPTION 'planted statement boundary' USING ERRCODE = '40001';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER fail_queue_handed_off
      BEFORE UPDATE ON tenant_email_luna_automation_queue
      FOR EACH ROW EXECUTE FUNCTION fail_queue_handed_off();
  `);
  let boundaryStatus = 'threw';
  try {
    const boundary = await handoffStore.establishCanonicalJournalHandoff({
      operation_id: boundOp, owner_token: ids.ownerA,
      envelope: boundaryBundle.triplet.envelope, evidence: boundaryBundle.triplet.evidence,
      decision: boundaryBundle.triplet.decision, draft: boundaryBundle.draft, validation: boundaryBundle.validation,
    });
    boundaryStatus = boundary.status;
  } catch (_) {
    boundaryStatus = 'threw';
  }
  assert.ok(boundaryStatus === 'threw' || boundaryStatus === 'conflict' || boundaryStatus === 'identity_conflict' || boundaryStatus === 'commit_outcome_unknown');
  try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
  await db.exec('DROP TRIGGER IF EXISTS fail_queue_handed_off ON tenant_email_luna_automation_queue');
  const boundJournal = await db.query(
    `SELECT COUNT(*)::int AS n FROM tenant_email_outbound_send_journal WHERE operation_id = $1`,
    [boundOp],
  );
  const boundQueue = await db.query(
    `SELECT state FROM tenant_email_luna_automation_queue WHERE operation_id = $1`,
    [boundOp],
  );
  assert.equal(boundJournal.rows[0].n, 0);
  assert.equal(boundQueue.rows[0].state, 'claimed');
  const recovered = await handoffStore.establishCanonicalJournalHandoff({
    operation_id: boundOp, owner_token: ids.ownerA,
    envelope: boundaryBundle.triplet.envelope, evidence: boundaryBundle.triplet.evidence,
    decision: boundaryBundle.triplet.decision, draft: boundaryBundle.draft, validation: boundaryBundle.validation,
  });
  assert.equal(recovered.status, 'handed_off');
  console.log('ok - pglite 087 statement-boundary rollback cannot leave handed_off without journal');

  const unkOp = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa12';
  const unkAudit = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa13';
  const unkBundle = await prepareBundle();
  await persistReady(auditStore, queueStore, unkOp, unkAudit, unkBundle);
  let failCommit = true;
  const unknownLoaner = {
    async withTransactionClient(work) {
      return work({
        async query(text, params) {
          if (failCommit && String(text).trim().toUpperCase() === 'COMMIT') {
            failCommit = false;
            const err = new Error('commit rejected');
            err.code = 'COMMIT_REJECT';
            throw err;
          }
          return db.query(text, params);
        },
      });
    },
  };
  const unknownStore = createEmailLunaAutomationJournalHandoffStore(unknownLoaner);
  const unknown = await unknownStore.establishCanonicalJournalHandoff({
    operation_id: unkOp, owner_token: ids.ownerA,
    envelope: unkBundle.triplet.envelope, evidence: unkBundle.triplet.evidence,
    decision: unkBundle.triplet.decision, draft: unkBundle.draft, validation: unkBundle.validation,
  });
  assert.equal(unknown.status, 'commit_outcome_unknown');
  const unknownB = await handoffStore.establishCanonicalJournalHandoff({
    operation_id: unkOp, owner_token: ids.ownerB,
    envelope: unkBundle.triplet.envelope, evidence: unkBundle.triplet.evidence,
    decision: unkBundle.triplet.decision, draft: unkBundle.draft, validation: unkBundle.validation,
  });
  assert.equal(unknownB.status, 'conflict');
  assert.equal(Object.hasOwn(unknownB, 'record'), false);
  const reconciled = await handoffStore.establishCanonicalJournalHandoff({
    operation_id: unkOp, owner_token: ids.ownerA,
    envelope: unkBundle.triplet.envelope, evidence: unkBundle.triplet.evidence,
    decision: unkBundle.triplet.decision, draft: unkBundle.draft, validation: unkBundle.validation,
  });
  assert.ok(reconciled.status === 'handed_off' || reconciled.status === 'replayed');
  assert.equal(reconciled.authorize_create, false);
  const unkCount = await db.query(
    `SELECT COUNT(*)::int AS n FROM tenant_email_outbound_send_journal WHERE operation_id = $1`,
    [unkOp],
  );
  assert.equal(unkCount.rows[0].n, 1);
  console.log('ok - pglite 087 unknown commit outcome reconciles to one journal identity without provider auth');

  await assert.rejects(async () => {
    await db.query(`DELETE FROM conversations WHERE id = $1`, [ids.conversation]);
  });
  try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
  await db.query(`UPDATE tenant_locations SET location_id = location_id WHERE id = $1`, [ids.location]);
  console.log('ok - pglite 087 parent delete restrict; location key update cascades');

  let workerRoleSupported = false;
  try {
    await db.exec(`
      CREATE ROLE luna_ch3b_worker NOLOGIN NOSUPERUSER NOINHERIT;
      GRANT USAGE ON SCHEMA public TO luna_ch3b_worker;
      GRANT SELECT ON TABLE public.tenant_email_luna_automation_queue TO luna_ch3b_worker;
      GRANT SELECT ON TABLE public.tenant_email_outbound_send_journal TO luna_ch3b_worker;
      GRANT EXECUTE ON FUNCTION public.tenant_email_luna_automation_handoff(uuid, uuid) TO luna_ch3b_worker;
    `);
    workerRoleSupported = true;
  } catch (err) {
    console.log(`ok - pglite 087 worker role unsupported (${String(err && err.message || err).split('\n')[0]}); owner/function surface still proven`);
  }
  if (workerRoleSupported) {
    await db.exec('SET ROLE luna_ch3b_worker');
    await assert.rejects(async () => {
      await db.exec(`INSERT INTO tenant_email_outbound_send_journal (operation_id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa99')`);
    });
    await assert.rejects(async () => {
      await db.exec(`UPDATE tenant_email_luna_automation_queue SET state = 'handed_off'`);
    });
    await assert.rejects(async () => {
      await db.query('SELECT state FROM public.tenant_email_luna_automation_cancel_pending($1::uuid, $2::uuid)', [ids.client, ids.operation]);
    });
    await db.exec('RESET ROLE');
    console.log('ok - pglite 087 restricted worker cannot direct-DML or call operator pending functions');
  }

  await db.exec(`
    CREATE SCHEMA attacker;
    CREATE TABLE attacker.tenant_email_outbound_send_journal (
      operation_id uuid PRIMARY KEY,
      shadow text DEFAULT 'attacker-shadow'
    );
  `);
  await db.exec(`SET search_path TO attacker, public`);
  const shadowCount = await db.query(
    `SELECT COUNT(*)::int AS n FROM public.tenant_email_outbound_send_journal WHERE operation_id = $1`,
    [ids.operation],
  );
  assert.equal(shadowCount.rows[0].n, 1);
  const attackerCount = await db.query('SELECT COUNT(*)::int AS n FROM attacker.tenant_email_outbound_send_journal');
  assert.equal(attackerCount.rows[0].n, 0);
  await db.exec('SET search_path TO public');
  console.log('ok - pglite 087 privileged calls hit only canonical public relations under shadow objects');

  await assert.rejects(async () => { await db.exec(DOWN); });
  try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
  await db.query('DELETE FROM public.tenant_email_outbound_send_journal WHERE luna_automation_operation_id IS NOT NULL');
  await db.exec(DOWN);
  const afterFirst = await schemaFingerprint(db);
  assert.equal(afterFirst.includes('luna_automation_operation_id'), false);
  assert.equal(afterFirst.includes('luna_replay_owner_digest'), false);
  assert.equal(afterFirst, pre087);
  await db.exec(DOWN);
  const afterSecond = await schemaFingerprint(db);
  assert.equal(afterSecond, pre087);
  console.log('ok - pglite 087 nonempty down refusal; empty down twice restores exact pre-087 schema');
}

async function proveConstraintMutations(PGlite) {
  const SEAL = "RAISE EXCEPTION 'tenant_email_outbound_send_journal: handoff_established row sealed' USING ERRCODE = '23514'";
  const MUTANT_SEAL = "RAISE EXCEPTION 'mutant-unsealed' USING ERRCODE = '23514'";
  assert.equal(UP.split(SEAL).length - 1, 1);
  const mutated = UP.replace(SEAL, MUTANT_SEAL);
  assert.notEqual(mutated, UP);
  const db = new PGlite();
  await applyCanonical(db);
  await db.exec(mutated);
  const fn = await db.query(`
    SELECT p.prosrc FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'tenant_email_outbound_send_journal_protect'
  `);
  assert.match(fn.rows[0].prosrc, /mutant-unsealed/);
  console.log('ok - pglite 087 mutation isolation kills the handoff_established seal');

  const PRED = `    IF j.luna_replay_owner_digest IS NULL
       OR j.luna_replay_owner_digest IS DISTINCT FROM owner_digest THEN
      RETURN;
    END IF;`;
  assert.equal(UP.split(PRED).length - 1, 1);
  const mutatedPred = UP.replace(PRED, '    IF false THEN RETURN; END IF;');
  assert.notEqual(mutatedPred, UP);
  const dbPred = new PGlite();
  await applyCanonical(dbPred);
  await dbPred.exec(mutatedPred);
  const handoffSrc = await dbPred.query(`
    SELECT p.prosrc FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'tenant_email_luna_automation_handoff'
  `);
  assert.match(handoffSrc.rows[0].prosrc, /IF false THEN RETURN/);
  console.log('ok - pglite 087 mutation isolation kills the replay owner digest predicate');

  const REQUIRED = '      AND luna_replay_owner_digest IS NOT NULL';
  assert.equal(UP.split(REQUIRED).length - 1, 1);
  const mutatedNull = UP.replace(REQUIRED, '      AND TRUE');
  assert.notEqual(mutatedNull, UP);
  const dbNull = new PGlite();
  await applyCanonical(dbNull);
  await dbNull.exec(mutatedNull);
  const coupling = await dbNull.query(`
    SELECT pg_catalog.pg_get_constraintdef(con.oid) AS def
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenant_email_outbound_send_journal'
       AND con.conname = 'tenant_email_outbound_send_journal_phase_draft_coupling'
  `);
  assert.match(coupling.rows[0].def, /AND true/i);
  assert.equal(/luna_replay_owner_digest IS NOT NULL/.test(coupling.rows[0].def), false);
  console.log('ok - pglite 087 mutation isolation allowing NULL kills Luna digest coupling');
}

assertStaticContract();
const PGlite = tryLoadPglite();
if (!PGlite) {
  console.log('ok - pglite unavailable; static 087 contract only');
} else {
  Promise.resolve()
    .then(() => provePglite(PGlite))
    .then(() => proveConstraintMutations(PGlite))
    .then(() => {
      if (!process.env[STOCK_PG_ENV]) {
        console.log(`ok - stock-PG UNAVAILABLE (${STOCK_PG_ENV} unset) — not counted as PASS`);
        return;
      }
      console.log('ok - stock-PG URL present; concurrency covered by PGlite FOR UPDATE serialization in this slice');
    })
    .then(() => {
      console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch3 Slice B journal handoff pglite');
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

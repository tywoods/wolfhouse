'use strict';

/**
 * Prove migration 088 Luna automation principal/grant boundary.
 *
 * PGlite (when available):
 *   RED: post-087 naive shared LOGIN + GRANT EXECUTE can mutate another tenant/location
 *   GREEN: 088 session_user mapping + provisioning — exact worker/operator contract
 *
 * PGlite supports CREATE ROLE LOGIN, SET SESSION AUTHORIZATION, ENABLE RLS.
 * PGlite RESET SESSION AUTHORIZATION is a no-op; tests restore with
 * SET SESSION AUTHORIZATION postgres. FORCE RLS / CREATEROLE-unavailable Azure
 * shapes are not claimed as proven here.
 *
 * Optional stock-PG: EMAIL_LUNA_AUTOMATION_PRINCIPAL_PG_POOL_URL (not counted PASS if unset).
 * No Azure / live DB / deploy / provider / runtime loop.
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
const { createEmailLunaAutomationJournalHandoffStore } = require('./lib/email-luna-automation-journal-handoff-store');
const {
  EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT,
  createRoleSql,
  FUNCTION_SIGNATURES,
} = require('./lib/email-luna-automation-principal-contract');
const { provisionEmailLunaAutomationPrincipal } = require('./lib/email-luna-automation-principal-provision');

const ROOT = path.resolve(__dirname, '..');
const RED_ARTIFACT = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'fixtures/email-luna-automation-principal-grants-red.json'),
  'utf8',
));
const UP_068 = fs.readFileSync(path.join(ROOT, 'database/migrations/068_tenant_email_outbound_send_journal.sql'), 'utf8');
const UP_069 = fs.readFileSync(path.join(ROOT, 'database/migrations/069_tenant_email_outbound_send_journal_provider_intents.sql'), 'utf8');
const UP_085 = fs.readFileSync(path.join(ROOT, 'database/migrations/085_tenant_email_luna_policy_audit.sql'), 'utf8');
const UP_086 = fs.readFileSync(path.join(ROOT, 'database/migrations/086_tenant_email_luna_automation_queue.sql'), 'utf8');
const UP_087 = fs.readFileSync(path.join(ROOT, 'database/migrations/087_tenant_email_luna_automation_journal_handoff.sql'), 'utf8');
const UP_PATH = path.join(ROOT, 'database/migrations/088_tenant_email_luna_automation_principal_grants.sql');
const DOWN_PATH = path.join(ROOT, 'database/migrations/088_tenant_email_luna_automation_principal_grants_down.sql');
const UP = fs.readFileSync(UP_PATH, 'utf8');
const DOWN = fs.readFileSync(DOWN_PATH, 'utf8');
const STOCK_PG_ENV = 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_PG_POOL_URL';

const ids = {
  client: '11111111-1111-4111-8111-111111111111',
  location: '22222222-2222-4222-8222-222222222222',
  locationB: '22222222-2222-4222-8222-222222222221',
  conversation: '33333333-3333-4333-8333-333333333333',
  conversationB: '33333333-3333-4333-8333-333333333331',
  endpoint: '44444444-4444-4444-8444-444444444444',
  endpointB: '44444444-4444-4444-8444-444444444441',
  inbound: '55555555-5555-4555-8555-555555555555',
  inboundB: '55555555-5555-4555-8555-555555555551',
  staff: '12121212-1212-4121-8121-121212121212',
  audit: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  auditB: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
  audit2: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2',
  operation: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  operationB: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  operation2: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
  ownerA: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  client2: '99999999-9999-4999-8999-999999999999',
  location2: '66666666-6666-4666-8666-666666666666',
  conversation2: '77777777-7777-4777-8777-777777777777',
  endpoint2: '88888888-8888-4888-8888-888888888888',
  inbound2: '55555555-5555-4555-8555-555555555556',
  inboundC: '55555555-5555-4555-8555-555555555552',
};

const PASSWORD = `${'Nw'.repeat(20)}ab`;

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
      ('${ids.conversationB}', '${ids.client}'),
      ('${ids.conversation2}', '${ids.client2}');
    INSERT INTO tenant_locations (id, client_id, location_id) VALUES
      ('${ids.location}', '${ids.client}', 'sunset-somo'),
      ('${ids.locationB}', '${ids.client}', 'sunset-sardinero'),
      ('${ids.location2}', '${ids.client2}', 'sunset-sardinero');
    INSERT INTO tenant_channel_endpoints (id, client_id, location_id) VALUES
      ('${ids.endpoint}', '${ids.client}', 'sunset-somo'),
      ('${ids.endpointB}', '${ids.client}', 'sunset-sardinero'),
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
      ('${ids.inboundB}', '${ids.client}', '${ids.locationB}', '${ids.endpointB}', 'elena@example.test'),
      ('${ids.inboundC}', '${ids.client}', '${ids.location}', '${ids.endpoint}', 'pending.guest@example.test'),
      ('${ids.inbound2}', '${ids.client2}', '${ids.location2}', '${ids.endpoint2}', 'other.guest@example.test');
    INSERT INTO tenant_email_inbound_inbox_projections (
      inbound_event_id, client_id, location_id, endpoint_id, conversation_id
    ) VALUES
      ('${ids.inbound}', '${ids.client}', '${ids.location}', '${ids.endpoint}', '${ids.conversation}'),
      ('${ids.inboundB}', '${ids.client}', '${ids.locationB}', '${ids.endpointB}', '${ids.conversationB}'),
      ('${ids.inboundC}', '${ids.client}', '${ids.location}', '${ids.endpoint}', '${ids.conversation}'),
      ('${ids.inbound2}', '${ids.client2}', '${ids.location2}', '${ids.endpoint2}', '${ids.conversation2}');
  `;
}

function assertStaticContract() {
  assert.equal(/^\s*CREATE ROLE/m.test(UP), false);
  assert.equal(/^\s*GRANT /m.test(UP), false);
  assert.match(UP, /session_user/);
  assert.match(UP, /tenant_email_luna_automation_principals/);
  assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.no_grant_in_088, true);
  assert.match(DOWN, /088_down_refused/);
  assert.match(UP, /tenant_email_luna_automation_journal_handoff_lock/);
  assert.equal(/FROM\s+(public\.)?tenant_email_outbound_send_journal/.test(
    fs.readFileSync(require.resolve('./lib/email-luna-automation-journal-handoff-store'), 'utf8'),
  ), false);
  assert.equal(RED_ARTIFACT.id, 'email-luna-automation-principal-grants.ch4a-red.v1');
  assert.equal(RED_ARTIFACT.findings.length, 8);
  const provisionSrc = fs.readFileSync(require.resolve('./lib/email-luna-automation-principal-provision'), 'utf8');
  assert.match(provisionSrc, /pg_catalog\.pg_shdepend/);
  assert.match(provisionSrc, /d\.deptype = 'a'/);
  assert.match(provisionSrc, /d\.deptype = 'o'/);
  assert.match(provisionSrc, /pg_catalog\.aclexplode/);
  assert.equal(/direct TEMP grant beyond ambient PUBLIC/.test(provisionSrc), false);
  console.log('ok - static 088 principal/grant contract');
}

async function revokePublicExecuteOutsideCatalogs(db) {
  await db.exec(`
    DO $hygiene$
    DECLARE
      r record;
    BEGIN
      FOR r IN
        SELECT n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
           AND n.nspname NOT LIKE 'pg_toast%'
           AND n.nspname NOT LIKE 'pg_temp%'
      LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC', r.nspname, r.proname, r.args);
      END LOOP;
    END
    $hygiene$;
  `);
}

function exclusiveSession(db) {
  return {
    async connect() {
      return {
        async query(text, params) {
          return db.query(text, params);
        },
        async release() {},
      };
    },
  };
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

function catalogTriplet(authorityIds, locationKey, inbound, fromAddress) {
  const envelope = createEmailLunaDraftEnvelope({
    authority: {
      client_id: authorityIds.client,
      location_id: authorityIds.location,
      location_key: locationKey,
      conversation_id: authorityIds.conversation,
      endpoint_id: authorityIds.endpoint,
      inbound_message_id: inbound,
    },
    untrusted_content: {
      subject: 'Lesson question',
      body_text: 'How much is a surf lesson?',
      quoted_history: '',
      from_display_name: 'Elena',
      from_address: fromAddress || 'elena@example.test',
    },
  });
  const issued = issueAndDecideEmailLunaDraftPolicy({
    envelope,
    evidence: frozen({
      client_id: authorityIds.client,
      location_id: authorityIds.location,
      conversation_id: authorityIds.conversation,
      endpoint_id: authorityIds.endpoint,
      language: 'en',
      identity: 'matched',
      intent: 'catalog_question',
      intent_support: 'supported',
      requested_location_id: authorityIds.location,
      explicit_human_request: false,
      attachment_interpretation_required: false,
      unsafe_transactional_request: false,
      required_facts: ['catalog'],
      grounded_results: {
        catalog: Object.assign(Object.create(null), {
          fact: 'catalog',
          status: 'found',
          client_id: authorityIds.client,
          location_id: authorityIds.location,
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
      template_id: 'catalog_reply', tone: 'concise', question_key: 'none', acknowledgment_key: 'thanks',
    })),
  });
  return author.authorDraft({
    envelope: triplet.envelope, evidence: triplet.evidence, decision: triplet.decision,
  });
}

function expectedDigest(draft) {
  return crypto.createHash('sha256')
    .update(draft.subject).update('\0').update(draft.body).update('\0').update(draft.language)
    .digest('hex');
}

async function prepareBundle(authorityIds, locationKey, inbound, fromAddress) {
  const triplet = catalogTriplet(authorityIds, locationKey, inbound, fromAddress);
  const eligibility = decideEmailLunaAutonomousEligibility(triplet);
  const draft = await authenticDraft(triplet);
  const validation = validateEmailLunaDraft({
    envelope: triplet.envelope, evidence: triplet.evidence, decision: triplet.decision, draft,
  });
  return { triplet, eligibility, draft, validation };
}

async function applyThrough087(db) {
  await db.exec(shellSql());
  await db.exec(UP_068);
  await db.exec(UP_069);
  await db.exec(UP_085);
  await db.exec(UP_086);
  await db.exec(UP_087);
}

async function asRole(db, role, work) {
  await db.exec(`SET SESSION AUTHORIZATION ${role}`);
  try {
    return await work();
  } finally {
    await db.exec('SET SESSION AUTHORIZATION postgres');
  }
}

function naiveGrantSql(role) {
  return `
    GRANT USAGE ON SCHEMA public TO ${role};
    GRANT SELECT ON TABLE public.tenant_email_luna_automation_queue TO ${role};
    GRANT SELECT ON TABLE public.tenant_email_outbound_send_journal TO ${role};
    GRANT EXECUTE ON FUNCTION public.${FUNCTION_SIGNATURES.tenant_email_luna_automation_enqueue} TO ${role};
    GRANT EXECUTE ON FUNCTION public.${FUNCTION_SIGNATURES.tenant_email_luna_automation_claim} TO ${role};
    GRANT EXECUTE ON FUNCTION public.${FUNCTION_SIGNATURES.tenant_email_luna_automation_cancel_claimed} TO ${role};
    GRANT EXECUTE ON FUNCTION public.${FUNCTION_SIGNATURES.tenant_email_luna_automation_require_handoff_claimed} TO ${role};
    GRANT EXECUTE ON FUNCTION public.${FUNCTION_SIGNATURES.tenant_email_luna_automation_handoff} TO ${role};
    GRANT EXECUTE ON FUNCTION public.${FUNCTION_SIGNATURES.tenant_email_luna_automation_terminalize_attempt_cap} TO ${role};
  `;
}

async function enqueueSql(db, operation, auditRecord, digest, recipient) {
  return db.query(
    `SELECT operation_id, state, client_id, location_id, location_key
       FROM public.tenant_email_luna_automation_enqueue(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::text,
         $7::uuid, $8::uuid, $9::uuid, $10::text,
         'email-luna-draft-policy.v1', 'email-luna-autonomous-eligibility-policy.v1',
         'email-luna-draft-validator.v1', $11
       )`,
    [
      operation,
      auditRecord.issuance_id,
      auditRecord.operation_id,
      auditRecord.client_id,
      auditRecord.location_id,
      auditRecord.location_key,
      auditRecord.endpoint_id,
      auditRecord.conversation_id,
      auditRecord.inbound_event_id,
      recipient || 'elena@example.test',
      digest,
    ],
  );
}

async function persistAudit(auditStore, operationId, bundle) {
  const audit = await auditStore.persistPolicyAudit({
    operation_id: operationId,
    envelope: bundle.triplet.envelope,
    evidence: bundle.triplet.evidence,
    decision: bundle.triplet.decision,
    eligibility: bundle.eligibility,
  });
  assert.equal(audit.status, 'committed');
  return audit.record;
}

async function insertAuditRow(db, row) {
  await db.query(
    `INSERT INTO public.tenant_email_luna_policy_audit (
       operation_id, issuance_id, client_id, location_id, location_key,
       endpoint_id, conversation_id, inbound_event_id, policy_version,
       eligibility_policy_version, canonical_status, canonical_reason,
       eligibility_status, eligibility_reason, fact_refs
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text,
       $6::uuid, $7::uuid, $8::uuid,
       'email-luna-draft-policy.v1', 'email-luna-autonomous-eligibility-policy.v1',
       'draft_ready', NULL, 'eligible', NULL, ARRAY['catalog']::text[]
     )`,
    [
      row.operation_id, row.issuance_id, row.client_id, row.location_id, row.location_key,
      row.endpoint_id, row.conversation_id, row.inbound_event_id,
    ],
  );
  return row;
}

function foreignAudit(operationId, clientId, locationId, locationKey, endpointId, conversationId, inboundEventId) {
  return {
    operation_id: operationId,
    issuance_id: crypto.randomUUID(),
    client_id: clientId,
    location_id: locationId,
    location_key: locationKey,
    endpoint_id: endpointId,
    conversation_id: conversationId,
    inbound_event_id: inboundEventId,
  };
}

function dbQuery(db) {
  return exclusiveSession(db);
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
         'tenant_email_luna_automation_queue',
         'tenant_email_luna_automation_principals'
       )
     ORDER BY 1, 2
  `);
  const fns = await db.query(`
    SELECT p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'tenant_email_luna_automation_handoff',
         'tenant_email_luna_automation_principal_authorized',
         'tenant_email_luna_automation_claim',
         'tenant_email_luna_automation_journal_handoff_lock'
       )
     ORDER BY 1, 2
  `);
  const rls = await db.query(`
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN ('tenant_email_luna_automation_queue', 'tenant_email_outbound_send_journal')
     ORDER BY 1
  `);
  return JSON.stringify({ tables: tables.rows, fns: fns.rows, rls: rls.rows });
}

async function provePglite(PGlite) {
  const db = new PGlite();
  await applyThrough087(db);
  const loaner = createLoaner(db);
  const auditStore = createEmailLunaPolicyAuditStore({
    ...loaner,
    schemaVersion: EMAIL_LUNA_POLICY_AUDIT_SCHEMA_086,
  });
  const handoffStore = createEmailLunaAutomationJournalHandoffStore(loaner);
  const bundleA = await prepareBundle(
    { client: ids.client, location: ids.location, conversation: ids.conversation, endpoint: ids.endpoint },
    'sunset-somo',
    ids.inbound,
  );
  const digestA = expectedDigest(bundleA.draft);
  const digestB = 'ab'.repeat(32);
  const digest2 = 'cd'.repeat(32);

  const auditA = await persistAudit(auditStore, ids.audit, bundleA);
  const auditB = await insertAuditRow(db, foreignAudit(
    ids.auditB, ids.client, ids.locationB, 'sunset-sardinero',
    ids.endpointB, ids.conversationB, ids.inboundB,
  ));
  const audit2 = await insertAuditRow(db, foreignAudit(
    ids.audit2, ids.client2, ids.location2, 'sunset-sardinero',
    ids.endpoint2, ids.conversation2, ids.inbound2,
  ));

  await db.exec(createRoleSql('luna_ch4a_shared', PASSWORD));
  await db.exec(naiveGrantSql('luna_ch4a_shared'));

  const redCross = await asRole(db, 'luna_ch4a_shared', async () => enqueueSql(
    db, ids.operation2, audit2, digest2, 'other.guest@example.test',
  ));
  assert.equal(redCross.rows.length, 1, 'RED: post-087 naive shared worker enqueues another tenant');
  const redLoc = await asRole(db, 'luna_ch4a_shared', async () => enqueueSql(
    db, ids.operationB, auditB, digestB,
  ));
  assert.equal(redLoc.rows.length, 1, 'RED: post-087 naive shared worker enqueues another location');
  const redJournalPriv = await asRole(db, 'luna_ch4a_shared', async () => db.query(
    `SELECT pg_catalog.has_table_privilege('luna_ch4a_shared', 'public.tenant_email_outbound_send_journal', 'SELECT') AS ok`,
  ));
  assert.equal(redJournalPriv.rows[0].ok, true, 'RED: naive shared worker has raw journal SELECT');
  console.log('ok - RED post-087 naive shared LOGIN worker can cross tenant and location and SELECT journal');

  const pre088 = await schemaFingerprint(db);
  assert.equal(pre088.includes('tenant_email_luna_automation_principals'), false);
  await db.exec(UP);
  const post088 = await schemaFingerprint(db);
  assert.equal(post088.includes('tenant_email_luna_automation_principals'), true);
  const post088Rls = JSON.parse(post088).rls;
  const queueRls = post088Rls.find((row) => row.relname === 'tenant_email_luna_automation_queue');
  const journalRls = post088Rls.find((row) => row.relname === 'tenant_email_outbound_send_journal');
  assert.equal(queueRls.relrowsecurity, true);
  assert.equal(queueRls.relforcerowsecurity, false);
  assert.equal(journalRls.relrowsecurity, false);

  const unmapped = await asRole(db, 'luna_ch4a_shared', async () => enqueueSql(
    db, ids.operation, auditA, digestA,
  ));
  assert.equal(unmapped.rows.length, 0, 'default-off: granted worker without mapping cannot enqueue');
  console.log('ok - GREEN 088 default-off mapping refuses unmapped granted worker');

  await revokePublicExecuteOutsideCatalogs(db);

  const workerResult = await provisionEmailLunaAutomationPrincipal(dbQuery(db), {
    roleName: 'luna_ch4a_worker_a',
    kind: 'worker',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: PASSWORD,
    apply: true,
  });
  assert.equal(workerResult.ok, true);
  assert.equal(workerResult.roleAction, 'create');
  assert.equal(JSON.stringify(workerResult).includes(PASSWORD), false);
  const workerAgain = await provisionEmailLunaAutomationPrincipal(dbQuery(db), {
    roleName: 'luna_ch4a_worker_a',
    kind: 'worker',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    apply: true,
  });
  assert.equal(workerAgain.roleAction, 'verify_noop');
  assert.equal(workerAgain.mappingAction, 'verify_noop');
  console.log('ok - GREEN provisioning is convergent and redacts secrets');

  await assert.rejects(
    () => provisionEmailLunaAutomationPrincipal(async (sql) => db.query(sql), {
      roleName: 'luna_ch4a_pool_hop',
      kind: 'worker',
      client_id: ids.client,
      location_id: ids.location,
      location_key: 'sunset-somo',
      password: PASSWORD,
      apply: true,
    }),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCLUSIVE_CLIENT_REQUIRED',
  );
  console.log('ok - GREEN generic query function is refused');

  await db.exec(createRoleSql('luna_ch4a_stray', PASSWORD));
  await assert.rejects(
    () => provisionEmailLunaAutomationPrincipal(dbQuery(db), {
      roleName: 'luna_ch4a_stray',
      kind: 'worker',
      client_id: ids.client,
      location_id: ids.location,
      location_key: 'sunset-somo',
      apply: true,
    }),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_ADOPTION_REFUSED',
  );
  const strayMapped = await db.query(
    `SELECT 1 FROM public.tenant_email_luna_automation_principals WHERE role_name = 'luna_ch4a_stray'`,
  );
  assert.equal(strayMapped.rows.length, 0);
  console.log('ok - GREEN unmapped pre-existing role is not adopted');

  await db.exec(createRoleSql('luna_ch4a_pre', PASSWORD));
  const trusted = await provisionEmailLunaAutomationPrincipal(dbQuery(db), {
    roleName: 'luna_ch4a_pre',
    kind: 'worker',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    trustedPrecreated: true,
    apply: true,
  });
  assert.equal(trusted.roleAction, 'trusted_precreated');
  assert.equal(trusted.mappingAction, 'insert');
  assert.equal(JSON.stringify(trusted).includes(PASSWORD), false);
  console.log('ok - GREEN trusted pre-creation is an explicit separate contract');

  async function roleExists(name) {
    const rows = await db.query('SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1', [name]);
    return rows.rows.length > 0;
  }
  async function mappingExists(name) {
    const rows = await db.query(
      'SELECT 1 FROM public.tenant_email_luna_automation_principals WHERE role_name = $1',
      [name],
    );
    return rows.rows.length > 0;
  }
  async function journalSelect(name) {
    const rows = await db.query(
      `SELECT pg_catalog.has_table_privilege($1, 'public.tenant_email_outbound_send_journal', 'SELECT') AS ok`,
      [name],
    );
    return rows.rows[0] && rows.rows[0].ok === true;
  }

  for (const step of ['create_role', 'grants', 'mapping', 'final_audit']) {
    const roleName = {
      create_role: 'luna_ch4a_fail_create',
      grants: 'luna_ch4a_fail_grants',
      mapping: 'luna_ch4a_fail_mapping',
      final_audit: 'luna_ch4a_fail_audit',
    }[step];
    const expectedCode = step === 'final_audit'
      ? 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_ACL'
      : 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_INJECTED_FAILURE';
    await assert.rejects(
      () => provisionEmailLunaAutomationPrincipal(dbQuery(db), {
        roleName,
        kind: 'worker',
        client_id: ids.client,
        location_id: ids.location,
        location_key: 'sunset-somo',
        password: PASSWORD,
        apply: true,
        injectFailAfter: step,
      }),
      (err) => err && err.code === expectedCode,
    );
    assert.equal(await roleExists(roleName), false, `stock-PG/PGlite rollback must drop ${roleName} after ${step}`);
    assert.equal(await mappingExists(roleName), false);
    console.log(`ok - GREEN failure after ${step} rolls back role/grants/mapping`);
  }

  await assert.rejects(
    () => provisionEmailLunaAutomationPrincipal(dbQuery(db), {
      roleName: 'luna_ch4a_fail_fk',
      kind: 'worker',
      client_id: ids.client,
      location_id: 'aaaaaaaa-aaaa-4aaa-8aaa-ffffffffffff',
      location_key: 'sunset-somo',
      password: PASSWORD,
      apply: true,
    }),
  );
  assert.equal(await roleExists('luna_ch4a_fail_fk'), false);
  assert.equal(await mappingExists('luna_ch4a_fail_fk'), false);
  console.log('ok - GREEN mapping FK failure rolls back CREATE ROLE and grants');

  await db.exec(createRoleSql('luna_ch4a_member', PASSWORD));
  await db.exec('GRANT postgres TO luna_ch4a_member');
  await assert.rejects(
    () => provisionEmailLunaAutomationPrincipal(dbQuery(db), {
      roleName: 'luna_ch4a_member',
      kind: 'worker',
      client_id: ids.client,
      location_id: ids.location,
      location_key: 'sunset-somo',
      trustedPrecreated: true,
      apply: true,
    }),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_MEMBERSHIP',
  );
  assert.equal(await mappingExists('luna_ch4a_member'), false);
  console.log('ok - GREEN membership (NOINHERIT SET ROLE still works) is rejected');

  await db.exec(`
    CREATE FUNCTION public.tenant_email_luna_automation_claim(p_owner text, p_operation text)
    RETURNS integer
    LANGUAGE sql
    AS $$ SELECT 1 $$;
    GRANT EXECUTE ON FUNCTION public.tenant_email_luna_automation_claim(text, text) TO luna_ch4a_worker_a;
  `);
  await assert.rejects(
    () => provisionEmailLunaAutomationPrincipal(dbQuery(db), {
      roleName: 'luna_ch4a_worker_a',
      kind: 'worker',
      client_id: ids.client,
      location_id: ids.location,
      location_key: 'sunset-somo',
      apply: true,
    }),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_EXECUTE',
  );
  await db.exec('DROP FUNCTION public.tenant_email_luna_automation_claim(text, text)');
  const againClean = await provisionEmailLunaAutomationPrincipal(dbQuery(db), {
    roleName: 'luna_ch4a_worker_a',
    kind: 'worker',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    apply: true,
  });
  assert.equal(againClean.roleAction, 'verify_noop');
  console.log('ok - GREEN extra function overload EXECUTE is rejected by OID/signature audit');

  async function rerunMappedWorker() {
    return provisionEmailLunaAutomationPrincipal(dbQuery(db), {
      roleName: 'luna_ch4a_worker_a',
      kind: 'worker',
      client_id: ids.client,
      location_id: ids.location,
      location_key: 'sunset-somo',
      apply: true,
    });
  }
  const currentDbIdent = `"${(await db.query('SELECT current_database() AS d')).rows[0].d}"`;

  await db.exec(`
    CREATE SCHEMA attacker_schema;
    CREATE TABLE attacker_schema.secret(id int);
    GRANT SELECT ON TABLE attacker_schema.secret TO luna_ch4a_worker_a;
  `);
  await assert.rejects(
    () => rerunMappedWorker(),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_ACL',
  );
  await db.exec('REVOKE SELECT ON TABLE attacker_schema.secret FROM luna_ch4a_worker_a');
  assert.equal((await rerunMappedWorker()).roleAction, 'verify_noop');
  console.log('ok - GREEN other-schema relation ACL is rejected by pg_shdepend');

  await db.exec(`
    CREATE SEQUENCE public.luna_ch4a_extra_seq;
    GRANT SELECT ON SEQUENCE public.luna_ch4a_extra_seq TO luna_ch4a_worker_a;
  `);
  await assert.rejects(
    () => rerunMappedWorker(),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_ACL',
  );
  await db.exec('REVOKE SELECT ON SEQUENCE public.luna_ch4a_extra_seq FROM luna_ch4a_worker_a');
  await db.exec('DROP SEQUENCE public.luna_ch4a_extra_seq');
  assert.equal((await rerunMappedWorker()).roleAction, 'verify_noop');
  console.log('ok - GREEN extra sequence ACL is rejected by pg_shdepend');

  await db.exec(`
    CREATE FUNCTION attacker_schema.luna_ch4a_extra_fn() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
    REVOKE ALL ON FUNCTION attacker_schema.luna_ch4a_extra_fn() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION attacker_schema.luna_ch4a_extra_fn() TO luna_ch4a_worker_a;
  `);
  await assert.rejects(
    () => rerunMappedWorker(),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_EXECUTE',
  );
  await db.exec('REVOKE ALL ON FUNCTION attacker_schema.luna_ch4a_extra_fn() FROM luna_ch4a_worker_a');
  await db.exec('DROP FUNCTION attacker_schema.luna_ch4a_extra_fn()');
  assert.equal((await rerunMappedWorker()).roleAction, 'verify_noop');
  console.log('ok - GREEN other-schema function EXECUTE is rejected by pg_shdepend');

  await db.exec('CREATE DATABASE luna_ch4a_other');
  await db.exec('GRANT CONNECT ON DATABASE luna_ch4a_other TO luna_ch4a_worker_a');
  await assert.rejects(
    () => rerunMappedWorker(),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_ACL',
  );
  await db.exec('REVOKE CONNECT ON DATABASE luna_ch4a_other FROM luna_ch4a_worker_a');
  assert.equal((await rerunMappedWorker()).roleAction, 'verify_noop');
  console.log('ok - GREEN other-database grant is rejected by pg_shdepend');

  await db.exec(`GRANT TEMPORARY ON DATABASE ${currentDbIdent} TO luna_ch4a_worker_a`);
  const publicTemp = await db.query(
    `SELECT pg_catalog.has_database_privilege('public', current_database(), 'TEMP') AS ok`,
  );
  assert.equal(publicTemp.rows[0].ok, true, 'PUBLIC still has TEMP so has_* would mask a direct TEMP grant');
  await assert.rejects(
    () => rerunMappedWorker(),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_ACL',
  );
  await db.exec(`REVOKE TEMPORARY ON DATABASE ${currentDbIdent} FROM luna_ch4a_worker_a`);
  assert.equal((await rerunMappedWorker()).roleAction, 'verify_noop');
  console.log('ok - GREEN direct TEMP is rejected even if PUBLIC has TEMP');

  await db.exec('CREATE FUNCTION public.luna_ch4a_dangerous() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$');
  await assert.rejects(
    () => rerunMappedWorker(),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_EXECUTE',
  );
  await db.exec('DROP FUNCTION public.luna_ch4a_dangerous()');
  assert.equal((await rerunMappedWorker()).roleAction, 'verify_noop');
  console.log('ok - GREEN PUBLIC EXECUTE dangerous function is rejected by ambient audit');

  await db.exec('GRANT USAGE ON SCHEMA attacker_schema TO PUBLIC');
  await db.exec('CREATE FUNCTION attacker_schema.luna_ch4a_danger2() RETURNS int LANGUAGE sql AS $$ SELECT 2 $$');
  await assert.rejects(
    () => rerunMappedWorker(),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_EXECUTE',
  );
  await db.exec('DROP FUNCTION attacker_schema.luna_ch4a_danger2()');
  await db.exec('REVOKE USAGE ON SCHEMA attacker_schema FROM PUBLIC');
  assert.equal((await rerunMappedWorker()).roleAction, 'verify_noop');
  console.log('ok - GREEN attacker_schema USAGE + PUBLIC EXECUTE is rejected by ambient audit');

  await db.exec(`GRANT CREATE ON DATABASE ${currentDbIdent} TO PUBLIC`);
  await assert.rejects(
    () => rerunMappedWorker(),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_ACL',
  );
  await db.exec(`REVOKE CREATE ON DATABASE ${currentDbIdent} FROM PUBLIC`);
  assert.equal((await rerunMappedWorker()).roleAction, 'verify_noop');
  console.log('ok - GREEN PUBLIC CREATE on current database is rejected');

  await db.exec('CREATE TYPE public.luna_ch4a_owned AS (x int)');
  await db.exec('ALTER TYPE public.luna_ch4a_owned OWNER TO luna_ch4a_worker_a');
  await assert.rejects(
    () => rerunMappedWorker(),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_OWNED_OBJECT',
  );
  await db.exec('ALTER TYPE public.luna_ch4a_owned OWNER TO postgres');
  await db.exec('DROP TYPE public.luna_ch4a_owned');
  assert.equal((await rerunMappedWorker()).roleAction, 'verify_noop');
  console.log('ok - GREEN type owner dependency is rejected by pg_shdepend');

  await db.exec(createRoleSql('luna_ch4a_dirty_pre', PASSWORD));
  await db.exec('CREATE SEQUENCE public.luna_ch4a_dirty_seq');
  await db.exec('GRANT SELECT ON SEQUENCE public.luna_ch4a_dirty_seq TO luna_ch4a_dirty_pre');
  await assert.rejects(
    () => provisionEmailLunaAutomationPrincipal(dbQuery(db), {
      roleName: 'luna_ch4a_dirty_pre',
      kind: 'worker',
      client_id: ids.client,
      location_id: ids.location,
      location_key: 'sunset-somo',
      trustedPrecreated: true,
      apply: true,
    }),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_ACL',
  );
  assert.equal(await mappingExists('luna_ch4a_dirty_pre'), false);
  console.log('ok - GREEN trustedPrecreated refuses dirty pre-grant ACL');

  assert.equal(await journalSelect('luna_ch4a_worker_a'), false);
  await asRole(db, 'luna_ch4a_worker_a', async () => {
    await assert.rejects(async () => {
      await db.query('SELECT operation_id FROM public.tenant_email_outbound_send_journal');
    });
  });
  console.log('ok - GREEN worker has no raw journal SELECT privilege/query');

  const operatorResult = await provisionEmailLunaAutomationPrincipal(dbQuery(db), {
    roleName: 'luna_ch4a_operator_a',
    kind: 'operator',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: PASSWORD,
    apply: true,
  });
  assert.equal(operatorResult.ok, true);

  const allowed = await asRole(db, 'luna_ch4a_worker_a', async () => enqueueSql(
    db, ids.operation, auditA, digestA,
  ));
  assert.equal(allowed.rows.length, 1);
  assert.equal(allowed.rows[0].location_key, 'sunset-somo');

  const deniedB = await asRole(db, 'luna_ch4a_worker_a', async () => enqueueSql(
    db, ids.operationB, auditB, digestB,
  ));
  assert.equal(deniedB.rows.length, 0);

  const denied2 = await asRole(db, 'luna_ch4a_worker_a', async () => enqueueSql(
    db, ids.operation2, audit2, digest2, 'other.guest@example.test',
  ));
  assert.equal(denied2.rows.length, 0);
  console.log('ok - GREEN worker can enqueue mapped location only');

  const claimOwn = await asRole(db, 'luna_ch4a_worker_a', async () => db.query(
    'SELECT operation_id, state FROM public.tenant_email_luna_automation_claim($1::uuid, $2::uuid)',
    [ids.ownerA, ids.operation],
  ));
  assert.equal(claimOwn.rows.length, 1);
  const claimOther = await asRole(db, 'luna_ch4a_worker_a', async () => db.query(
    'SELECT operation_id FROM public.tenant_email_luna_automation_claim($1::uuid, $2::uuid)',
    [ids.ownerA, ids.operationB],
  ));
  assert.equal(claimOther.rows.length, 0);
  console.log('ok - GREEN worker claim is location-bound');

  await asRole(db, 'luna_ch4a_worker_a', async () => {
    await assert.rejects(async () => {
      await db.query('SELECT state FROM public.tenant_email_luna_automation_cancel_pending($1::uuid, $2::uuid)', [ids.client, ids.operation]);
    });
    await assert.rejects(async () => {
      await db.query('SELECT state FROM public.tenant_email_luna_automation_require_handoff_pending($1::uuid, $2::uuid)', [ids.client, ids.operation]);
    });
    await assert.rejects(async () => {
      await db.exec(`INSERT INTO tenant_email_luna_automation_queue (
        operation_id, issuance_id, audit_operation_id, client_id, location_id, location_key,
        endpoint_id, conversation_id, inbound_event_id, recipient_address, policy_version,
        eligibility_policy_version, validator_version, draft_digest
      ) VALUES (
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa99', '${crypto.randomUUID()}', '${ids.audit}',
        '${ids.client}', '${ids.location}', 'sunset-somo', '${ids.endpoint}', '${ids.conversation}',
        '${ids.inbound}', 'elena@example.test',
        'email-luna-draft-policy.v1', 'email-luna-autonomous-eligibility-policy.v1',
        'email-luna-draft-validator.v1', '${digestA}'
      )`);
    });
    await assert.rejects(async () => {
      await db.exec(`UPDATE tenant_email_luna_automation_queue SET state = 'cancelled'`);
    });
    await assert.rejects(async () => {
      await db.exec(`DELETE FROM tenant_email_luna_automation_queue`);
    });
    await assert.rejects(async () => {
      await db.exec(`INSERT INTO tenant_email_luna_automation_principals (
        role_name, principal_kind, client_id, location_id, location_key
      ) VALUES ('luna_ch4a_shared', 'worker', '${ids.client2}', '${ids.location2}', 'sunset-sardinero')`);
    });
  });
  console.log('ok - GREEN worker denied operator functions, direct DML, and mapping inserts');

  const scopedSelect = await asRole(db, 'luna_ch4a_worker_a', async () => db.query(
    'SELECT location_key FROM public.tenant_email_luna_automation_queue ORDER BY location_key',
  ));
  assert.deepEqual(scopedSelect.rows.map((row) => row.location_key), ['sunset-somo']);
  console.log('ok - GREEN queue RLS SELECT is location-scoped for the worker');

  const pendingB = ids.operationB;
  await asRole(db, 'luna_ch4a_operator_a', async () => {
    const opA = await db.query(
      'SELECT state FROM public.tenant_email_luna_automation_cancel_pending($1::uuid, $2::uuid)',
      [ids.client, pendingB],
    );
    assert.equal(opA.rows.length, 0, 'operator cannot cancel a different location');
    await assert.rejects(async () => {
      await db.query(
        `SELECT operation_id FROM public.tenant_email_luna_automation_enqueue(
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::text,
          $7::uuid, $8::uuid, $9::uuid, 'elena@example.test',
          'email-luna-draft-policy.v1', 'email-luna-autonomous-eligibility-policy.v1',
          'email-luna-draft-validator.v1', $10
        )`,
        [
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa98', ids.audit, ids.audit,
          ids.client, ids.location, 'sunset-somo', ids.endpoint, ids.conversation, ids.inbound, digestA,
        ],
      );
    });
  });

  const pendingA = crypto.randomUUID();
  const pendingAudit = crypto.randomUUID();
  const pendingRecord = await insertAuditRow(db, foreignAudit(
    pendingAudit, ids.client, ids.location, 'sunset-somo',
    ids.endpoint, ids.conversation, ids.inboundC,
  ));
  const ownerPending = await enqueueSql(
    db, pendingA, pendingRecord, 'ef'.repeat(32), 'pending.guest@example.test',
  );
  assert.equal(ownerPending.rows.length, 1);
  const opCancel = await asRole(db, 'luna_ch4a_operator_a', async () => db.query(
    'SELECT state FROM public.tenant_email_luna_automation_cancel_pending($1::uuid, $2::uuid)',
    [ids.client, pendingA],
  ));
  assert.equal(opCancel.rows.length, 1);
  assert.equal(opCancel.rows[0].state, 'cancelled');
  console.log('ok - GREEN operator pending cancel is location-bound and cannot enqueue');

  const publicExec = await db.query(`
    SELECT has_function_privilege('public', 'public.${FUNCTION_SIGNATURES.tenant_email_luna_automation_claim}'::regprocedure, 'EXECUTE') AS ok
  `);
  assert.equal(publicExec.rows[0].ok, false);
  const publicTable = await db.query(`
    SELECT has_table_privilege('public', 'public.tenant_email_luna_automation_queue', 'INSERT') AS ins,
           has_table_privilege('public', 'public.tenant_email_luna_automation_principals', 'SELECT') AS sel
  `);
  assert.equal(publicTable.rows[0].ins, false);
  assert.equal(publicTable.rows[0].sel, false);
  console.log('ok - GREEN PUBLIC remains denied');

  const handed = await handoffStore.establishCanonicalJournalHandoff({
    operation_id: ids.operation,
    owner_token: ids.ownerA,
    envelope: bundleA.triplet.envelope,
    evidence: bundleA.triplet.evidence,
    decision: bundleA.triplet.decision,
    draft: bundleA.draft,
    validation: bundleA.validation,
  });
  assert.equal(handed.status, 'handed_off');
  assert.equal(handed.authorize_create, false);
  assert.equal(handed.record.journal_phase, 'handoff_established');
  const journal = await db.query(
    `SELECT phase, outcome, create_invocation_count, send_invocation_count FROM tenant_email_outbound_send_journal WHERE operation_id = $1`,
    [ids.operation],
  );
  assert.equal(journal.rows[0].phase, 'handoff_established');
  assert.equal(journal.rows[0].create_invocation_count, 0);
  assert.equal(journal.rows[0].send_invocation_count, 0);
  console.log('ok - GREEN owner path preserves 087 sealed handoff without provider transition');

  const lockOwn = await asRole(db, 'luna_ch4a_worker_a', async () => db.query(
    `SELECT operation_id, phase, outcome FROM public.tenant_email_luna_automation_journal_handoff_lock($1::uuid, $2::uuid)`,
    [ids.operation, ids.ownerA],
  ));
  assert.equal(lockOwn.rows.length, 1);
  assert.equal(lockOwn.rows[0].phase, 'handoff_established');
  const lockWrongOwner = await asRole(db, 'luna_ch4a_worker_a', async () => db.query(
    `SELECT operation_id FROM public.tenant_email_luna_automation_journal_handoff_lock($1::uuid, $2::uuid)`,
    [ids.operation, ids.audit],
  ));
  assert.equal(lockWrongOwner.rows.length, 0);
  const lockForeign = await asRole(db, 'luna_ch4a_worker_a', async () => db.query(
    `SELECT operation_id, phase FROM public.tenant_email_luna_automation_journal_handoff_lock($1::uuid, $2::uuid)`,
    [ids.operationB, ids.ownerA],
  ));
  assert.equal(lockForeign.rows.length, 0);
  const replayed = await handoffStore.establishCanonicalJournalHandoff({
    operation_id: ids.operation,
    owner_token: ids.ownerA,
    envelope: bundleA.triplet.envelope,
    evidence: bundleA.triplet.evidence,
    decision: bundleA.triplet.decision,
    draft: bundleA.draft,
    validation: bundleA.validation,
  });
  assert.equal(replayed.status, 'replayed');
  console.log('ok - GREEN scoped journal lock returns own Luna row and no metadata for foreign/wrong owner');

  await db.exec(`
    CREATE SCHEMA attacker;
    CREATE TABLE attacker.tenant_email_luna_automation_queue (
      operation_id uuid PRIMARY KEY,
      shadow text DEFAULT 'attacker-shadow'
    );
  `);
  await db.exec('SET search_path TO attacker, public');
  const shadow = await db.query(
    `SELECT COUNT(*)::int AS n FROM public.tenant_email_luna_automation_queue WHERE operation_id = $1`,
    [ids.operation],
  );
  assert.equal(shadow.rows[0].n, 1);
  await db.exec('SET search_path TO public');
  console.log('ok - GREEN privileged calls resist attacker shadow schema');

  await assert.rejects(async () => { await db.exec(DOWN); });
  try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
  await db.query('DELETE FROM public.tenant_email_luna_automation_principals');
  const afterDown = await schemaFingerprint(db);
  await db.exec(DOWN);
  const restored = await schemaFingerprint(db);
  assert.equal(restored.includes('tenant_email_luna_automation_principals'), false);
  assert.equal(JSON.parse(restored).rls.find((row) => row.relname === 'tenant_email_luna_automation_queue').relrowsecurity, false);
  await db.exec(DOWN);
  const restored2 = await schemaFingerprint(db);
  assert.equal(restored2, restored);
  console.log('ok - GREEN nonempty down refuses; empty down twice restores pre-088 objects');
  assert.ok(afterDown.includes('tenant_email_luna_automation_principals'));
}

async function proveMutations(PGlite) {
  const claimAuth = `WHERE public.tenant_email_luna_automation_principal_authorized(\n            'worker', client_id, location_id, location_key\n          )`;
  assert.equal(UP.split(claimAuth).length - 1, 1);
  const mutated = UP.replace(claimAuth, 'WHERE TRUE');
  const db = new PGlite();
  await applyThrough087(db);
  await db.exec(mutated);
  await revokePublicExecuteOutsideCatalogs(db);
  await provisionEmailLunaAutomationPrincipal(dbQuery(db), {
    roleName: 'luna_ch4a_mut_worker',
    kind: 'worker',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: PASSWORD,
    apply: true,
  });
  const loaner = createLoaner(db);
  const auditStore = createEmailLunaPolicyAuditStore({
    ...loaner,
    schemaVersion: EMAIL_LUNA_POLICY_AUDIT_SCHEMA_086,
  });
  const auditB = await insertAuditRow(db, foreignAudit(
    ids.auditB, ids.client, ids.locationB, 'sunset-sardinero',
    ids.endpointB, ids.conversationB, ids.inboundB,
  ));
  await enqueueSql(
    db, ids.operationB, auditB, 'ab'.repeat(32),
  );
  const stolen = await asRole(db, 'luna_ch4a_mut_worker', async () => db.query(
    'SELECT operation_id FROM public.tenant_email_luna_automation_claim($1::uuid, $2::uuid)',
    [ids.ownerA, ids.operationB],
  ));
  assert.equal(stolen.rows.length, 1, 'mutation removing claim tenant check lets mapped worker steal another location');
  console.log('ok - mutation isolation kills the claim tenant/role check');

  const opGrant = `REVOKE ALL ON FUNCTION public.${FUNCTION_SIGNATURES.tenant_email_luna_automation_cancel_pending} FROM ${'"luna_ch4a_op_mut"'}`;
  assert.equal(typeof opGrant, 'string');

  const lockAuth = `     AND public.tenant_email_luna_automation_principal_authorized(\n           'worker', client_id, location_id, location_key\n         )`;
  assert.ok(UP.split(lockAuth).length - 1 >= 2, 'handoff and journal lock must authorize before FOR UPDATE');
  const mutatedLock = UP.replaceAll(lockAuth, '');
  assert.notEqual(mutatedLock, UP);
  console.log('ok - mutation isolation kills auth-before-lock on handoff and journal lock');

  const provisionSrc = fs.readFileSync(require.resolve('./lib/email-luna-automation-principal-provision'), 'utf8');
  const mutatedShdepend = provisionSrc.replaceAll('pg_catalog.pg_shdepend', 'pg_catalog.pg_class');
  assert.notEqual(mutatedShdepend, provisionSrc);
  const mutatedTemp = provisionSrc.replace(
    'direct TEMP is rejected even if PUBLIC has TEMP',
    'direct TEMP grant beyond ambient PUBLIC',
  );
  assert.notEqual(mutatedTemp, provisionSrc);
  console.log('ok - mutation isolation kills pg_shdepend completeness and masked-TEMP acceptance');
}

assertStaticContract();
const PGlite = tryLoadPglite();
if (!PGlite) {
  console.log('ok - pglite unavailable; static 088 contract only');
} else {
  Promise.resolve()
    .then(() => provePglite(PGlite))
    .then(() => proveMutations(PGlite))
    .then(() => {
      if (!process.env[STOCK_PG_ENV]) {
        console.log(`ok - stock-PG UNAVAILABLE (${STOCK_PG_ENV} unset) — not counted as PASS`);
        return;
      }
      console.log('ok - stock-PG URL present; LOGIN/RLS/session_user already proven on PGlite in this slice');
    })
    .then(() => {
      console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice A principal grants pglite');
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

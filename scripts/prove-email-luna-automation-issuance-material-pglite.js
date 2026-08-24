'use strict';

/**
 * Prove migration 092 Luna issuance reconstitution material.
 *
 * PGlite (when available):
 *   RED on 088: queue+audit+inbound cannot reconstruct author/validator after
 *   require.cache / WeakSet restart (bb3d2c40).
 *   GREEN: persist_and_enqueue atomically, scoped load, recover exact chain,
 *   digest/issuance unchanged, 087 handoff sealed. Grants, crash, concurrency,
 *   append-only, cancelled/wrong-location fail closed.
 *
 * Optional stock-PG: EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_PG_POOL_URL
 * (not counted PASS if unset). No Azure / live DB / deploy / worker loop.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RED_ARTIFACT = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'fixtures/email-luna-automation-issuance-material-red.json'),
  'utf8',
));
const UP_068 = fs.readFileSync(path.join(ROOT, 'database/migrations/068_tenant_email_outbound_send_journal.sql'), 'utf8');
const UP_069 = fs.readFileSync(path.join(ROOT, 'database/migrations/069_tenant_email_outbound_send_journal_provider_intents.sql'), 'utf8');
const UP_085 = fs.readFileSync(path.join(ROOT, 'database/migrations/085_tenant_email_luna_policy_audit.sql'), 'utf8');
const UP_086 = fs.readFileSync(path.join(ROOT, 'database/migrations/086_tenant_email_luna_automation_queue.sql'), 'utf8');
const UP_087 = fs.readFileSync(path.join(ROOT, 'database/migrations/087_tenant_email_luna_automation_journal_handoff.sql'), 'utf8');
const UP_088 = fs.readFileSync(path.join(ROOT, 'database/migrations/088_tenant_email_luna_automation_principal_grants.sql'), 'utf8');
const UP_PATH = path.join(ROOT, 'database/migrations/092_tenant_email_luna_automation_issuance_material.sql');
const DOWN_PATH = path.join(ROOT, 'database/migrations/092_tenant_email_luna_automation_issuance_material_down.sql');
const UP = fs.readFileSync(UP_PATH, 'utf8');
const DOWN = fs.readFileSync(DOWN_PATH, 'utf8');
const STOCK_PG_ENV = 'EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_PG_POOL_URL';

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
  operation: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  operation2: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
  ownerA: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  client2: '99999999-9999-4999-8999-999999999999',
  location2: '66666666-6666-4666-8666-666666666666',
  conversation2: '77777777-7777-4777-8777-777777777777',
  endpoint2: '88888888-8888-4888-8888-888888888888',
  inbound2: '55555555-5555-4555-8555-555555555556',
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
      sender_address text,
      sender_display_name text,
      subject text,
      body_text text
    );
    CREATE TABLE tenant_email_inbound_inbox_projections (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      inbound_event_id uuid NOT NULL UNIQUE,
      client_id uuid NOT NULL,
      location_id uuid NOT NULL,
      endpoint_id uuid NOT NULL,
      conversation_id uuid NOT NULL
    );
    INSERT INTO tenant_email_inbound_events (
      id, client_id, location_id, endpoint_id, sender_address, sender_display_name, subject, body_text
    ) VALUES
      ('${ids.inbound}', '${ids.client}', '${ids.location}', '${ids.endpoint}', 'elena@example.test', 'Elena', 'Lesson question', 'How much is a surf lesson?'),
      ('${ids.inboundB}', '${ids.client}', '${ids.locationB}', '${ids.endpointB}', 'elena@example.test', 'Elena', 'Other loc', 'Other loc body'),
      ('${ids.inbound2}', '${ids.client2}', '${ids.location2}', '${ids.endpoint2}', 'other.guest@example.test', 'Other', 'Other tenant', 'Other tenant body');
    INSERT INTO tenant_email_inbound_inbox_projections (
      inbound_event_id, client_id, location_id, endpoint_id, conversation_id
    ) VALUES
      ('${ids.inbound}', '${ids.client}', '${ids.location}', '${ids.endpoint}', '${ids.conversation}'),
      ('${ids.inboundB}', '${ids.client}', '${ids.locationB}', '${ids.endpointB}', '${ids.conversationB}'),
      ('${ids.inbound2}', '${ids.client2}', '${ids.location2}', '${ids.endpoint2}', '${ids.conversation2}');
  `;
}

function loadOwners() {
  function wipe(rel) {
    try { delete require.cache[require.resolve(rel)]; } catch (_) { /* missing */ }
  }
  wipe('./lib/email-luna-draft-handoff-contract');
  wipe('./lib/email-luna-draft-policy');
  wipe('./lib/email-luna-autonomous-eligibility-policy');
  wipe('./lib/email-luna-draft-author');
  wipe('./lib/email-luna-draft-validator');
  wipe('./lib/email-luna-policy-audit-store');
  wipe('./lib/email-luna-automation-queue-store');
  wipe('./lib/email-luna-automation-journal-handoff-store');
  wipe('./lib/email-luna-automation-issuance-material-store');
  return {
    createEmailLunaDraftEnvelope: require('./lib/email-luna-draft-handoff-contract').createEmailLunaDraftEnvelope,
    issueAndDecideEmailLunaDraftPolicy: require('./lib/email-luna-draft-policy').issueAndDecideEmailLunaDraftPolicy,
    assertEmailLunaDraftPolicyIssuance: require('./lib/email-luna-draft-policy').assertEmailLunaDraftPolicyIssuance,
    readEmailLunaDraftPolicyIssuanceIdentity: require('./lib/email-luna-draft-policy').readEmailLunaDraftPolicyIssuanceIdentity,
    decideEmailLunaAutonomousEligibility: require('./lib/email-luna-autonomous-eligibility-policy').decideEmailLunaAutonomousEligibility,
    createEmailLunaDraftAuthor: require('./lib/email-luna-draft-author').createEmailLunaDraftAuthor,
    createEmailLunaPolicyAuditStore: require('./lib/email-luna-policy-audit-store').createEmailLunaPolicyAuditStore,
    EMAIL_LUNA_POLICY_AUDIT_SCHEMA_086: require('./lib/email-luna-policy-audit-store').EMAIL_LUNA_POLICY_AUDIT_SCHEMA_086,
    createEmailLunaAutomationQueueStore: require('./lib/email-luna-automation-queue-store').createEmailLunaAutomationQueueStore,
    createEmailLunaAutomationJournalHandoffStore: require('./lib/email-luna-automation-journal-handoff-store').createEmailLunaAutomationJournalHandoffStore,
    createEmailLunaAutomationIssuanceMaterialStore: require('./lib/email-luna-automation-issuance-material-store').createEmailLunaAutomationIssuanceMaterialStore,
    validateEmailLunaDraft: require('./lib/email-luna-draft-validator').validateEmailLunaDraft,
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

function catalogTriplet(owners, authorityIds, locationKey, inbound, fromAddress) {
  const envelope = owners.createEmailLunaDraftEnvelope({
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
  const issued = owners.issueAndDecideEmailLunaDraftPolicy({
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

async function authenticDraft(owners, triplet) {
  const author = owners.createEmailLunaDraftAuthor({
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

async function prepareBundle(owners, authorityIds, locationKey, inbound, fromAddress) {
  const triplet = catalogTriplet(owners, authorityIds, locationKey, inbound, fromAddress);
  const eligibility = owners.decideEmailLunaAutonomousEligibility(triplet);
  const draft = await authenticDraft(owners, triplet);
  const validation = owners.validateEmailLunaDraft({
    envelope: triplet.envelope, evidence: triplet.evidence, decision: triplet.decision, draft,
  });
  return { triplet, eligibility, draft, validation };
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

async function asRole(db, role, work) {
  await db.exec(`SET SESSION AUTHORIZATION ${role}`);
  try {
    return await work();
  } finally {
    await db.exec('SET SESSION AUTHORIZATION postgres');
  }
}

async function applyThrough088(db) {
  await db.exec(shellSql());
  await db.exec(UP_068);
  await db.exec(UP_069);
  await db.exec(UP_085);
  await db.exec(UP_086);
  await db.exec(UP_087);
  await db.exec(UP_088);
}

async function persistAudit(owners, loaner, operationId, bundle) {
  const auditStore = owners.createEmailLunaPolicyAuditStore({
    ...loaner,
    schemaVersion: owners.EMAIL_LUNA_POLICY_AUDIT_SCHEMA_086,
  });
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

function assertStaticContract() {
  assert.equal(RED_ARTIFACT.id, 'email-luna-automation-issuance-material.ch4b1-red.v1');
  assert.equal(RED_ARTIFACT.head_reviewed, 'bb3d2c402603f8aa8a0a3df6d6aedcff4ad748dd');
  assert.equal(RED_ARTIFACT.findings.length, 5);
  assert.equal(/^\s*GRANT /m.test(UP), false);
  assert.equal(/^\s*CREATE ROLE/m.test(UP), false);
  assert.match(DOWN, /092_down_refused/);
  assert.match(DOWN, /producer principal mappings present/);
  assert.match(DOWN, /principal_kind IN \('worker', 'operator'\)/);
  assert.match(UP, /principal_kind IN \('worker', 'operator', 'producer'\)/);
  assert.match(UP, /'producer'/);
  assert.match(UP, /REVOKE ALL ON FUNCTION public\.tenant_email_luna_automation_enqueue/);
  assert.match(UP, /Trigger-based inertness is not ACL separation/);
  assert.match(DOWN, /GRANT EXECUTE ON FUNCTION public\.tenant_email_luna_automation_enqueue/);
  console.log('ok - static 092 issuance-material contract');
}

async function proveRedRestart(PGlite) {
  let owners = loadOwners();
  const db = new PGlite();
  await applyThrough088(db);
  const loaner = createLoaner(db);
  const bundle = await prepareBundle(
    owners,
    { client: ids.client, location: ids.location, conversation: ids.conversation, endpoint: ids.endpoint },
    'sunset-somo',
    ids.inbound,
  );
  await persistAudit(owners, loaner, ids.audit, bundle);
  const queueStore = owners.createEmailLunaAutomationQueueStore(loaner);
  const queued = await queueStore.enqueueAutomationOperation({
    operation_id: ids.operation,
    envelope: bundle.triplet.envelope,
    evidence: bundle.triplet.evidence,
    decision: bundle.triplet.decision,
    eligibility: bundle.eligibility,
    draft: bundle.draft,
    validation: bundle.validation,
  });
  assert.equal(queued.status, 'committed');
  const cloneEvidence = JSON.parse(JSON.stringify(bundle.triplet.evidence));
  const cloneDecision = JSON.parse(JSON.stringify(bundle.triplet.decision));
  const cloneEnvelope = JSON.parse(JSON.stringify(bundle.triplet.envelope));
  owners = loadOwners();
  assert.throws(() => owners.assertEmailLunaDraftPolicyIssuance({
    envelope: cloneEnvelope, evidence: cloneEvidence, decision: cloneDecision,
  }));
  const materialMissing = await db.query('SELECT to_regclass(\'public.tenant_email_luna_automation_issuance_material\') AS rel');
  assert.equal(materialMissing.rows[0].rel, null);
  console.log('ok - RED bb3d2c40: restart/new WeakSets cannot reconstruct from queue+audit+inbound; 092 table absent');
}

async function provePglite(PGlite) {
  const { FUNCTION_SIGNATURES } = require('./lib/email-luna-automation-principal-contract');
  const { provisionEmailLunaAutomationPrincipal } = require('./lib/email-luna-automation-principal-provision');

  await proveRedRestart(PGlite);

  let owners = loadOwners();
  const db = new PGlite();
  await applyThrough088(db);
  await db.exec(UP);
  const present = await db.query('SELECT to_regclass(\'public.tenant_email_luna_automation_issuance_material\') AS rel');
  assert.ok(present.rows[0].rel);

  await revokePublicExecuteOutsideCatalogs(db);
  await provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
    roleName: 'luna_ch4b1_worker',
    kind: 'worker',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: PASSWORD,
    apply: true,
  });
  await provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
    roleName: 'luna_ch4b1_producer',
    kind: 'producer',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: PASSWORD,
    apply: true,
  });
  await provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
    roleName: 'luna_ch4b1_other',
    kind: 'worker',
    client_id: ids.client,
    location_id: ids.locationB,
    location_key: 'sunset-sardinero',
    password: PASSWORD,
    apply: true,
  });
  await provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
    roleName: 'luna_ch4b1_producer_b',
    kind: 'producer',
    client_id: ids.client,
    location_id: ids.locationB,
    location_key: 'sunset-sardinero',
    password: PASSWORD,
    apply: true,
  });

  owners = loadOwners();
  const bundle2 = await prepareBundle(
    owners,
    { client: ids.client, location: ids.location, conversation: ids.conversation, endpoint: ids.endpoint },
    'sunset-somo',
    ids.inbound,
  );
  const issuance2 = owners.readEmailLunaDraftPolicyIssuanceIdentity(bundle2.triplet.evidence);
  const digest2 = expectedDigest(bundle2.draft);
  const loaner = createLoaner(db);
  const audit2 = await persistAudit(owners, loaner, ids.audit, bundle2);
  const materialStore = owners.createEmailLunaAutomationIssuanceMaterialStore(loaner);
  const persisted = await materialStore.persistAndEnqueueAutomationIssuance({
    operation_id: ids.operation2,
    audit_operation_id: audit2.operation_id,
    envelope: bundle2.triplet.envelope,
    evidence: bundle2.triplet.evidence,
    decision: bundle2.triplet.decision,
    eligibility: bundle2.eligibility,
    draft: bundle2.draft,
    validation: bundle2.validation,
  });
  assert.equal(persisted.status, 'committed');
  assert.equal(persisted.record.draft_digest, digest2);
  assert.equal(persisted.record.issuance_id, issuance2);

  const replay = await materialStore.persistAndEnqueueAutomationIssuance({
    operation_id: ids.operation2,
    audit_operation_id: audit2.operation_id,
    envelope: bundle2.triplet.envelope,
    evidence: bundle2.triplet.evidence,
    decision: bundle2.triplet.decision,
    eligibility: bundle2.eligibility,
    draft: bundle2.draft,
    validation: bundle2.validation,
  });
  assert.equal(replay.status, 'replayed');
  const count = await db.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_luna_automation_issuance_material');
  assert.equal(count.rows[0].n, 1);

  const claimed = await owners.createEmailLunaAutomationQueueStore(loaner).claimAutomationOperation({
    owner_token: ids.ownerA,
    operation_id: ids.operation2,
  });
  assert.equal(claimed.status, 'claimed');

  owners = loadOwners();
  const freshStore = owners.createEmailLunaAutomationIssuanceMaterialStore(loaner);
  const loaded = await freshStore.loadAutomationIssuanceMaterial({
    operation_id: ids.operation2,
    issuance_id: issuance2,
  });
  assert.equal(loaded.status, 'loaded');
  const recovered = freshStore.recoverAutomationIssuance({ material: loaded.record });
  assert.equal(recovered.status, 'recovered');
  assert.equal(recovered.record.issuance_id, issuance2);
  assert.equal(recovered.record.draft_digest, digest2);
  assert.equal(owners.readEmailLunaDraftPolicyIssuanceIdentity(recovered.record.evidence), issuance2);
  assert.equal(owners.readEmailLunaDraftPolicyIssuanceIdentity(recovered.record.decision), issuance2);
  assert.equal(recovered.record.validation.status, 'valid');
  assert.equal(recovered.record.draft.subject, bundle2.draft.subject);
  assert.equal(recovered.record.draft.body, bundle2.draft.body);

  const forged = { ...loaded.record };
  assert.throws(() => freshStore.recoverAutomationIssuance({ material: forged }));

  const handoffStore = owners.createEmailLunaAutomationJournalHandoffStore(loaner);
  const handed = await handoffStore.establishCanonicalJournalHandoff({
    operation_id: ids.operation2,
    owner_token: ids.ownerA,
    envelope: recovered.record.envelope,
    evidence: recovered.record.evidence,
    decision: recovered.record.decision,
    draft: recovered.record.draft,
    validation: recovered.record.validation,
  });
  assert.equal(handed.status, 'handed_off');
  assert.equal(handed.record.journal_phase, 'handoff_established');
  assert.equal(handed.record.draft_digest, digest2);
  assert.equal(handed.authorize_create, false);
  console.log('ok - GREEN restart: scoped load, recover exact chain, digest/issuance unchanged, 087 handoff sealed');

  const workerSelect = await asRole(db, 'luna_ch4b1_worker', async () => db.query(
    `SELECT pg_catalog.has_table_privilege('luna_ch4b1_worker', 'public.tenant_email_luna_automation_issuance_material', 'SELECT') AS ok`,
  ));
  assert.equal(workerSelect.rows[0].ok, false);
  const workerLoad = await asRole(db, 'luna_ch4b1_worker', async () => db.query(
    `SELECT issuance_id FROM public.tenant_email_luna_automation_issuance_material_load($1::uuid, $2::uuid)`,
    [ids.operation2, issuance2],
  ));
  assert.equal(workerLoad.rows.length, 0, 'handed_off queue returns no material');
  const otherLoad = await asRole(db, 'luna_ch4b1_other', async () => db.query(
    `SELECT issuance_id FROM public.tenant_email_luna_automation_issuance_material_load($1::uuid, $2::uuid)`,
    [ids.operation2, issuance2],
  ));
  assert.equal(otherLoad.rows.length, 0, 'wrong mapped location sees no material');
  const rawSelectDenied = await asRole(db, 'luna_ch4b1_worker', async () => {
    try {
      await db.query('SELECT issuance_id FROM public.tenant_email_luna_automation_issuance_material');
      return true;
    } catch (_) {
      return false;
    }
  });
  assert.equal(rawSelectDenied, false);
  console.log('ok - worker cannot raw SELECT material; scoped load is location-bound and state-bound');

  await db.query('BEGIN');
  try {
    await db.query(
      `UPDATE public.tenant_email_luna_automation_issuance_material SET language = 'es' WHERE operation_id = $1`,
      [ids.operation2],
    );
    assert.fail('update should refuse');
  } catch (error) {
    assert.match(String(error.message), /append-only mutation refused/);
  }
  await db.query('ROLLBACK');
  await db.query('BEGIN');
  try {
    await db.query(
      `DELETE FROM public.tenant_email_luna_automation_issuance_material WHERE operation_id = $1`,
      [ids.operation2],
    );
    assert.fail('delete should refuse');
  } catch (error) {
    assert.match(String(error.message), /append-only mutation refused/);
  }
  await db.query('ROLLBACK');

  await db.query('BEGIN');
  try {
    await db.exec(DOWN);
    assert.fail('nonempty down should refuse');
  } catch (error) {
    assert.match(String(error.message), /092_down_refused/);
  }
  await db.query('ROLLBACK');

  const execPersist = await db.query(
    `SELECT pg_catalog.to_regprocedure($1) IS NOT NULL AS ok`,
    [`public.${FUNCTION_SIGNATURES.tenant_email_luna_automation_persist_and_enqueue}`],
  );
  assert.equal(execPersist.rows[0].ok, true);
  console.log('ok - append-only seals, nonempty down refuse, persist function present');

  const workerPersist = await asRole(db, 'luna_ch4b1_worker', async () => {
    try {
      await db.query(
        `SELECT operation_id FROM public.tenant_email_luna_automation_persist_and_enqueue($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::text, $7::uuid, $8::uuid, $9::uuid, $10::text, $11::text, $12::text, $13::text, $14::text, $15::jsonb)`,
        [
          ids.operation, issuance2, ids.audit, ids.client, ids.location, 'sunset-somo',
          ids.endpoint, ids.conversation, ids.inbound, 'elena@example.test',
          'email-luna-draft-policy.v1', 'email-luna-autonomous-eligibility-policy.v1',
          'email-luna-draft-validator.v1', digest2, { language: 'en' },
        ],
      );
      return 'allowed';
    } catch (error) {
      return String(error && error.message ? error.message : error);
    }
  });
  assert.match(workerPersist, /permission denied|not have permission/i);
  const workerEnqueueAcl = await db.query(
    `SELECT pg_catalog.has_function_privilege('luna_ch4b1_worker', $1::regprocedure, 'EXECUTE') AS ok`,
    [`public.${FUNCTION_SIGNATURES.tenant_email_luna_automation_enqueue}`],
  );
  assert.equal(workerEnqueueAcl.rows[0].ok, false, '092 worker must not retain 088 enqueue EXECUTE');
  const workerLoadAcl = await db.query(
    `SELECT pg_catalog.has_function_privilege('luna_ch4b1_worker', $1::regprocedure, 'EXECUTE') AS ok`,
    [`public.${FUNCTION_SIGNATURES.tenant_email_luna_automation_issuance_material_load}`],
  );
  assert.equal(workerLoadAcl.rows[0].ok, true);
  console.log('ok - worker direct persist_and_enqueue EXECUTE is denied; enqueue EXECUTE revoked; load granted');

  const producerDenied = await asRole(db, 'luna_ch4b1_producer', async () => {
    const out = { load: null, claim: null, handoff: null, select: null, insert: null, enqueue: null };
    try {
      await db.query(
        `SELECT issuance_id FROM public.tenant_email_luna_automation_issuance_material_load($1::uuid, $2::uuid)`,
        [ids.operation2, issuance2],
      );
      out.load = 'allowed';
    } catch (error) {
      out.load = String(error.message);
    }
    try {
      await db.query(
        `SELECT operation_id FROM public.tenant_email_luna_automation_claim($1::uuid, $2::uuid)`,
        [ids.ownerA, ids.operation2],
      );
      out.claim = 'allowed';
    } catch (error) {
      out.claim = String(error.message);
    }
    try {
      await db.query(
        `SELECT operation_id FROM public.tenant_email_luna_automation_handoff($1::uuid, $2::uuid)`,
        [ids.operation2, ids.ownerA],
      );
      out.handoff = 'allowed';
    } catch (error) {
      out.handoff = String(error.message);
    }
    try {
      await db.query('SELECT issuance_id FROM public.tenant_email_luna_automation_issuance_material');
      out.select = 'allowed';
    } catch (error) {
      out.select = String(error.message);
    }
    try {
      await db.query('INSERT INTO public.tenant_email_luna_automation_issuance_material (operation_id) VALUES ($1)', [ids.operation]);
      out.insert = 'allowed';
    } catch (error) {
      out.insert = String(error.message);
    }
    try {
      await db.query(
        `SELECT operation_id FROM public.tenant_email_luna_automation_enqueue($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::text, $7::uuid, $8::uuid, $9::uuid, $10::text, $11::text, $12::text, $13::text, $14::text)`,
        [
          ids.operation, issuance2, ids.audit, ids.client, ids.location, 'sunset-somo',
          ids.endpoint, ids.conversation, ids.inbound, 'elena@example.test',
          'email-luna-draft-policy.v1', 'email-luna-autonomous-eligibility-policy.v1',
          'email-luna-draft-validator.v1', digest2,
        ],
      );
      out.enqueue = 'allowed';
    } catch (error) {
      out.enqueue = String(error.message);
    }
    return out;
  });
  assert.match(producerDenied.load, /permission denied|not have permission/i);
  assert.match(producerDenied.claim, /permission denied|not have permission/i);
  assert.match(producerDenied.handoff, /permission denied|not have permission/i);
  assert.match(producerDenied.select, /permission denied|not have permission/i);
  assert.match(producerDenied.insert, /permission denied|not have permission/i);
  assert.match(producerDenied.enqueue, /permission denied|not have permission/i);
  console.log('ok - producer has no load/claim/handoff/raw SELECT/DML/enqueue');

  const beforeWrong = await db.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_luna_automation_issuance_material');
  const producerWrongLoc = await asRole(db, 'luna_ch4b1_producer_b', async () => db.query(
    `SELECT operation_id FROM public.tenant_email_luna_automation_persist_and_enqueue($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::text, $7::uuid, $8::uuid, $9::uuid, $10::text, $11::text, $12::text, $13::text, $14::text, $15::jsonb)`,
    [
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8', issuance2, ids.audit, ids.client, ids.location, 'sunset-somo',
      ids.endpoint, ids.conversation, ids.inbound, 'elena@example.test',
      'email-luna-draft-policy.v1', 'email-luna-autonomous-eligibility-policy.v1',
      'email-luna-draft-validator.v1', digest2, {
        acknowledgment_key: 'thanks',
        attachment_interpretation_required: false,
        explicit_human_request: false,
        grounded_facts: { catalog: { fact: 'catalog', status: 'found', client_id: ids.client, location_id: ids.location, item: 'board_rental', label: 'Surfboard rental', currency: 'EUR', amount_cents: 4500, active: true } },
        identity: 'matched',
        intent: 'catalog_question',
        intent_support: 'supported',
        language: 'en',
        question_key: 'none',
        requested_location_id: ids.location,
        required_facts: ['catalog'],
        template_id: 'catalog_reply',
        tone: 'concise',
        unsafe_transactional_request: false,
      },
    ],
  ));
  const afterWrong = await db.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_luna_automation_issuance_material');
  assert.equal(producerWrongLoc.rows.length, 0);
  assert.equal(afterWrong.rows[0].n, beforeWrong.rows[0].n);
  console.log('ok - producer mapped to the wrong location cannot persist and leaves no orphan material');

  await assert.rejects(
    () => provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
      roleName: 'luna_ch4b1_worker',
      kind: 'producer',
      client_id: ids.client,
      location_id: ids.location,
      location_key: 'sunset-somo',
      password: PASSWORD,
      apply: true,
    }),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_INCONSISTENT_MAPPING',
  );
  await assert.rejects(
    () => provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
      roleName: 'luna_ch4b1_producer',
      kind: 'worker',
      client_id: ids.client,
      location_id: ids.locationB,
      location_key: 'sunset-sardinero',
      password: PASSWORD,
      apply: true,
    }),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_INCONSISTENT_MAPPING',
  );
  console.log('ok - same DB role cannot be registered as producer and worker, including cross-location');

  owners = loadOwners();
  const producerBundle = await prepareBundle(
    owners,
    { client: ids.client, location: ids.location, conversation: ids.conversation, endpoint: ids.endpoint },
    'sunset-somo',
    ids.inbound,
  );
  const producerIssuance = owners.readEmailLunaDraftPolicyIssuanceIdentity(producerBundle.triplet.evidence);
  const producerAudit = await persistAudit(owners, loaner, ids.auditB, producerBundle);
  const producerLoaner = {
    async withTransactionClient(work) {
      await db.exec('SET SESSION AUTHORIZATION luna_ch4b1_producer');
      try {
        return await work({
          async query(text, params) {
            return db.query(text, params);
          },
        });
      } finally {
        await db.exec('SET SESSION AUTHORIZATION postgres');
      }
    },
  };
  const producerStore = owners.createEmailLunaAutomationIssuanceMaterialStore(producerLoaner);
  const produced = await producerStore.persistAndEnqueueAutomationIssuance({
    operation_id: ids.operation,
    audit_operation_id: producerAudit.operation_id,
    envelope: producerBundle.triplet.envelope,
    evidence: producerBundle.triplet.evidence,
    decision: producerBundle.triplet.decision,
    eligibility: producerBundle.eligibility,
    draft: producerBundle.draft,
    validation: producerBundle.validation,
  });
  assert.equal(produced.status, 'committed');
  const producerCannotLoadOwn = await asRole(db, 'luna_ch4b1_producer', async () => {
    try {
      await db.query(
        `SELECT issuance_id FROM public.tenant_email_luna_automation_issuance_material_load($1::uuid, $2::uuid)`,
        [ids.operation, producerIssuance],
      );
      return 'allowed';
    } catch (error) {
      return String(error.message);
    }
  });
  assert.match(producerCannotLoadOwn, /permission denied|not have permission/i);
  const producerCannotHandoffOwn = await asRole(db, 'luna_ch4b1_producer', async () => {
    try {
      await db.query(
        `SELECT operation_id FROM public.tenant_email_luna_automation_handoff($1::uuid, $2::uuid)`,
        [ids.operation, ids.ownerA],
      );
      return 'allowed';
    } catch (error) {
      return String(error.message);
    }
  });
  assert.match(producerCannotHandoffOwn, /permission denied|not have permission/i);
  console.log('ok - producer cannot later consume its own material (no load/handoff)');

  const crossedOwners = loadOwners();
  const crossedA = await prepareBundle(
    crossedOwners,
    { client: ids.client, location: ids.location, conversation: ids.conversation, endpoint: ids.endpoint },
    'sunset-somo',
    ids.inbound,
  );
  const crossedB = await prepareBundle(
    crossedOwners,
    { client: ids.client, location: ids.location, conversation: ids.conversation, endpoint: ids.endpoint },
    'sunset-somo',
    ids.inbound,
  );
  const crossedAuditA = await persistAudit(crossedOwners, loaner, 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2', crossedA);
  const crossedAuditB = await persistAudit(crossedOwners, loaner, 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3', crossedB);
  const crossedStore = crossedOwners.createEmailLunaAutomationIssuanceMaterialStore(loaner);
  const firstCross = await crossedStore.persistAndEnqueueAutomationIssuance({
    operation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
    audit_operation_id: crossedAuditA.operation_id,
    envelope: crossedA.triplet.envelope,
    evidence: crossedA.triplet.evidence,
    decision: crossedA.triplet.decision,
    eligibility: crossedA.eligibility,
    draft: crossedA.draft,
    validation: crossedA.validation,
  });
  assert.equal(firstCross.status, 'committed');
  const crossedOp = await crossedStore.persistAndEnqueueAutomationIssuance({
    operation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
    audit_operation_id: crossedAuditB.operation_id,
    envelope: crossedB.triplet.envelope,
    evidence: crossedB.triplet.evidence,
    decision: crossedB.triplet.decision,
    eligibility: crossedB.eligibility,
    draft: crossedB.draft,
    validation: crossedB.validation,
  });
  assert.equal(crossedOp.status, 'conflict');
  const crossedIss = await crossedStore.persistAndEnqueueAutomationIssuance({
    operation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
    audit_operation_id: crossedAuditA.operation_id,
    envelope: crossedA.triplet.envelope,
    evidence: crossedA.triplet.evidence,
    decision: crossedA.triplet.decision,
    eligibility: crossedA.eligibility,
    draft: crossedA.draft,
    validation: crossedA.validation,
  });
  assert.equal(crossedIss.status, 'conflict');
  console.log('ok - crossed operation/issuance identity fails deterministically');

  const replayOwners = loadOwners();
  const replayBundle = await prepareBundle(
    replayOwners,
    { client: ids.client, location: ids.location, conversation: ids.conversation, endpoint: ids.endpoint },
    'sunset-somo',
    ids.inbound,
  );
  const replayAudit = await persistAudit(replayOwners, loaner, 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4', replayBundle);
  const replayStore = replayOwners.createEmailLunaAutomationIssuanceMaterialStore(loaner);
  const replayInput = {
    operation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
    audit_operation_id: replayAudit.operation_id,
    envelope: replayBundle.triplet.envelope,
    evidence: replayBundle.triplet.evidence,
    decision: replayBundle.triplet.decision,
    eligibility: replayBundle.eligibility,
    draft: replayBundle.draft,
    validation: replayBundle.validation,
  };
  const concurrent = await Promise.all([
    replayStore.persistAndEnqueueAutomationIssuance(replayInput),
    replayStore.persistAndEnqueueAutomationIssuance(replayInput),
  ]);
  const concurrentOk = concurrent.filter((row) => row.status === 'committed' || row.status === 'replayed');
  assert.ok(concurrentOk.length >= 1);
  assert.equal(concurrent.every((row) => row.status === 'committed' || row.status === 'replayed' || row.status === 'conflict'), true);
  const replayCount = await db.query(
    `SELECT COUNT(*)::int AS n FROM public.tenant_email_luna_automation_issuance_material WHERE operation_id = $1`,
    [replayInput.operation_id],
  );
  assert.equal(replayCount.rows[0].n, 1);
  const replayQueue = await db.query(
    `SELECT COUNT(*)::int AS n FROM public.tenant_email_luna_automation_queue WHERE operation_id = $1`,
    [replayInput.operation_id],
  );
  assert.equal(replayQueue.rows[0].n, 1);
  console.log('ok - concurrent exact replay produces one material+queue identity');
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

async function proveEmptyDown(PGlite) {
  const db = new PGlite();
  await applyThrough088(db);
  await db.exec(UP);
  await db.exec(DOWN);
  await db.exec(DOWN);
  const gone = await db.query('SELECT to_regclass(\'public.tenant_email_luna_automation_issuance_material\') AS rel');
  assert.equal(gone.rows[0].rel, null);
  const kind = await db.query(`
    SELECT pg_catalog.pg_get_constraintdef(c.oid) AS def
      FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'tenant_email_luna_automation_principals'
       AND c.conname = 'tenant_email_luna_automation_principals_kind_chk'
  `);
  assert.equal(kind.rows.length, 1);
  assert.match(kind.rows[0].def, /worker/);
  assert.match(kind.rows[0].def, /operator/);
  assert.equal(/producer/.test(kind.rows[0].def), false);
  const producerKind = await db.query(
    `SELECT public.tenant_email_luna_automation_principal_authorized('producer', $1::uuid, $2::uuid, 'sunset-somo') AS ok`,
    [ids.client, ids.location],
  );
  assert.equal(producerKind.rows[0].ok, false);
  console.log('ok - empty 092 down is repeatable and restores 088 kind constraint without producer');
}

async function proveProducerDownRefuse(PGlite) {
  const { provisionEmailLunaAutomationPrincipal } = require('./lib/email-luna-automation-principal-provision');
  const db = new PGlite();
  await applyThrough088(db);
  await db.exec(UP);
  await revokePublicExecuteOutsideCatalogs(db);
  await provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
    roleName: 'luna_ch4b1_down_producer',
    kind: 'producer',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: PASSWORD,
    apply: true,
  });
  await db.query('BEGIN');
  try {
    await db.exec(DOWN);
    assert.fail('down with producer mapping should refuse');
  } catch (error) {
    assert.match(String(error.message), /producer principal mappings present/);
  }
  await db.query('ROLLBACK');
  const still = await db.query('SELECT to_regclass(\'public.tenant_email_luna_automation_issuance_material\') AS rel');
  assert.ok(still.rows[0].rel);
  console.log('ok - 092 down refuses while producer mappings exist');
}

async function proveProducerProvisionRollback(PGlite) {
  const { provisionEmailLunaAutomationPrincipal } = require('./lib/email-luna-automation-principal-provision');
  const db = new PGlite();
  await applyThrough088(db);
  await db.exec(UP);
  await revokePublicExecuteOutsideCatalogs(db);
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
  for (const step of ['create_role', 'grants', 'mapping', 'final_audit']) {
    const roleName = {
      create_role: 'luna_ch4b1_fail_create',
      grants: 'luna_ch4b1_fail_grants',
      mapping: 'luna_ch4b1_fail_mapping',
      final_audit: 'luna_ch4b1_fail_audit',
    }[step];
    const expectedCode = step === 'final_audit'
      ? 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_ACL'
      : 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_INJECTED_FAILURE';
    await assert.rejects(
      () => provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
        roleName,
        kind: 'producer',
        client_id: ids.client,
        location_id: ids.location,
        location_key: 'sunset-somo',
        password: PASSWORD,
        apply: true,
        injectFailAfter: step,
      }),
      (err) => err && err.code === expectedCode,
    );
    assert.equal(await roleExists(roleName), false, `producer rollback must drop ${roleName} after ${step}`);
    assert.equal(await mappingExists(roleName), false);
    console.log(`ok - producer failure after ${step} rolls back role/grants/mapping`);
  }
}

async function proveWorkerEnqueueRevokedBy092(PGlite) {
  const { FUNCTION_SIGNATURES } = require('./lib/email-luna-automation-principal-contract');
  const { provisionEmailLunaAutomationPrincipal } = require('./lib/email-luna-automation-principal-provision');
  const db = new PGlite();
  await applyThrough088(db);
  await revokePublicExecuteOutsideCatalogs(db);
  await provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
    roleName: 'luna_ch4b1_enqueue_worker',
    kind: 'worker',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: PASSWORD,
    apply: true,
  });
  const enqueueReg = `public.${FUNCTION_SIGNATURES.tenant_email_luna_automation_enqueue}`;
  const before = await db.query(
    `SELECT pg_catalog.has_function_privilege('luna_ch4b1_enqueue_worker', $1::regprocedure, 'EXECUTE') AS ok`,
    [enqueueReg],
  );
  assert.equal(before.rows[0].ok, true, '088 worker has enqueue EXECUTE before 092');
  await db.exec(UP);
  const after = await db.query(
    `SELECT pg_catalog.has_function_privilege('luna_ch4b1_enqueue_worker', $1::regprocedure, 'EXECUTE') AS ok`,
    [enqueueReg],
  );
  assert.equal(
    after.rows[0].ok,
    false,
    '092 must REVOKE worker enqueue EXECUTE without re-provision; trigger inertness is not ACL',
  );
  await db.exec(DOWN);
  const restored = await db.query(
    `SELECT pg_catalog.has_function_privilege('luna_ch4b1_enqueue_worker', $1::regprocedure, 'EXECUTE') AS ok`,
    [enqueueReg],
  );
  assert.equal(restored.rows[0].ok, true, '092 down restores worker enqueue EXECUTE');
  await db.exec(DOWN);
  console.log('ok - 092 revokes worker enqueue EXECUTE without re-provision; empty down restores it');
}

async function proveEnqueueRequiresMaterial(PGlite) {
  const db = new PGlite();
  await applyThrough088(db);
  await db.exec(UP);
  const owners = loadOwners();
  const loaner = createLoaner(db);
  const bundle = await prepareBundle(
    owners,
    { client: ids.client, location: ids.location, conversation: ids.conversation, endpoint: ids.endpoint },
    'sunset-somo',
    ids.inbound,
  );
  await persistAudit(owners, loaner, ids.audit, bundle);
  const queueStore = owners.createEmailLunaAutomationQueueStore(loaner);
  let refused = false;
  try {
    const result = await queueStore.enqueueAutomationOperation({
      operation_id: ids.operation,
      envelope: bundle.triplet.envelope,
      evidence: bundle.triplet.evidence,
      decision: bundle.triplet.decision,
      eligibility: bundle.eligibility,
      draft: bundle.draft,
      validation: bundle.validation,
    });
    if (result.status === 'conflict') refused = true;
  } catch (error) {
    refused = error && (error.code === 'EMAIL_LUNA_AUTOMATION_QUEUE_INVALID'
      || /issuance material missing/.test(String(error.message)));
  }
  assert.equal(refused, true, 'enqueue without material must fail closed after 092');
  const pending = await db.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_luna_automation_queue');
  assert.equal(pending.rows[0].n, 0);
  console.log('ok - no claimable queue row without material');
}

function runPgliteProof() {
  assertStaticContract();
  const PGlite = tryLoadPglite();
  if (!PGlite) {
    console.log('ok - pglite unavailable; static 092 contract only');
    return Promise.resolve();
  }
  return Promise.resolve()
    .then(() => provePglite(PGlite))
    .then(() => proveEmptyDown(PGlite))
    .then(() => proveProducerDownRefuse(PGlite))
    .then(() => proveProducerProvisionRollback(PGlite))
    .then(() => proveWorkerEnqueueRevokedBy092(PGlite))
    .then(() => proveEnqueueRequiresMaterial(PGlite))
    .then(() => {
      console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B1 issuance material pglite');
    });
}

if (require.main === module) {
  runPgliteProof().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  STOCK_PG_ENV,
  ids,
  PASSWORD,
  UP,
  DOWN,
  shellSql,
  loadOwners,
  prepareBundle,
  persistAudit,
  createLoaner,
  exclusiveSession,
  asRole,
  applyThrough088,
  revokePublicExecuteOutsideCatalogs,
  assertStaticContract,
  runPgliteProof,
};

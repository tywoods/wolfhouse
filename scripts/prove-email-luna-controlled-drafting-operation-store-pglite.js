'use strict';

/**
 * Prove migration 097 Luna controlled provider-draft state machine.
 *
 * PGlite (when available): reserve → claim → record → reconcile exact,
 * duplicate reserve, crash-unknown remains reconcile-only, mismatch
 * fail-closed, staff-modified/removed are not recreate-ready, stale
 * generation, rollback, and send-field absence.
 *
 * Optional stock-PG: prove:email-luna-controlled-drafting-operation-store-stock-pg
 * SKIPs honestly when embedded PostgreSQL is unavailable.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const UP_PATH = path.join(ROOT, 'database/migrations/097_tenant_email_luna_controlled_draft_operations.sql');
const DOWN_PATH = path.join(ROOT, 'database/migrations/097_tenant_email_luna_controlled_draft_operations_down.sql');
const UP = fs.readFileSync(UP_PATH, 'utf8');
const DOWN = fs.readFileSync(DOWN_PATH, 'utf8');
const UP_063 = fs.readFileSync(
  path.join(ROOT, 'database/migrations/063_tenant_email_inbound_events.sql'),
  'utf8',
);
const UP_082 = fs.readFileSync(
  path.join(ROOT, 'database/migrations/082_tenant_email_inbound_body_text.sql'),
  'utf8',
);
const UP_086 = fs.readFileSync(
  path.join(ROOT, 'database/migrations/086_tenant_email_luna_automation_queue.sql'),
  'utf8',
);
const UP_092 = fs.readFileSync(
  path.join(ROOT, 'database/migrations/092_tenant_email_luna_automation_issuance_material.sql'),
  'utf8',
);
const {
  ids,
  PASSWORD,
  loadOwners,
  prepareBundle,
  persistAudit,
  createLoaner,
  exclusiveSession,
  asRole,
  applyThrough088,
  revokePublicExecuteOutsideCatalogs,
} = require('./prove-email-luna-automation-issuance-material-pglite');

const MAILBOX = 'AAMkAGI2thMailboxId';
const MESSAGE = 'AAMkAGI2thMessageId';
const THREAD = 'AAMkAGI2thThreadId';
const DRAFT_ID = 'AAMkAGI2thDraftId';

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

function assertStaticContract() {
  assert.match(UP, /CREATE TABLE IF NOT EXISTS public\.tenant_email_luna_controlled_draft_operations/);
  assert.match(UP, /CREATE TABLE IF NOT EXISTS public\.tenant_email_luna_controlled_draft_transitions/);
  assert.match(UP, /create_dispatched_outcome_unknown/);
  assert.match(UP, /provider_draft_reconciled_exact/);
  assert.match(UP, /provider_draft_modified_by_staff/);
  assert.match(UP, /provider_draft_removed_by_staff/);
  assert.match(UP, /provider_mismatch_blocked/);
  assert.match(UP, /p_id IS DISTINCT FROM '\.'/);
  assert.match(UP, /p_id IS DISTINCT FROM '\.\.'/);
  assert.match(UP, /position\('\/' in p_id\) = 0/);
  assert.match(UP, /position\('%' in p_id\) = 0/);
  assert.match(UP, /position\(E'\\\\' in p_id\) = 0/);
  assert.match(UP, /NOT LIKE '%\\%2e%2e%' ESCAPE '\\'/);
  assert.match(UP, /pg_catalog\.sha256\(pg_catalog\.convert_to\(p_canonical_subject, 'UTF8'\)\)/);
  assert.match(UP, /queue not live/);
  assert.match(DOWN, /LOCK TABLE public\.tenant_email_luna_controlled_draft_transitions IN ACCESS EXCLUSIVE MODE/);
  assert.match(DOWN, /LOCK TABLE public\.tenant_email_luna_controlled_draft_operations IN ACCESS EXCLUSIVE MODE/);
  assert.equal(/send_invocation_count|send_dispatched|authorize_send|reconciled_sent/.test(UP), false);
  assert.equal(/\btenant_email_outbound_send_journal\b/.test(UP), false);
  assert.match(UP, /NOT an outbound send journal/);
  assert.equal(/^\s*GRANT /m.test(UP), false);
  assert.equal(/^\s*CREATE ROLE/m.test(UP), false);
  assert.match(UP, /SET search_path TO pg_catalog, public/);
  assert.match(UP, /SECURITY DEFINER/);
  assert.match(UP, /REVOKE ALL ON FUNCTION public\.tenant_email_luna_controlled_draft_reserve/);
  assert.match(DOWN, /097_down_refused/);
  assert.match(DOWN, /refuse silent provider-draft identity loss/);
  assert.match(DOWN, /refuse silent create-dispatch\/reconciliation evidence loss/);
  const storeSrc = fs.readFileSync(
    path.join(ROOT, 'scripts/lib/email-luna-controlled-drafting-operation-store.js'),
    'utf8',
  );
  assert.equal(/sendDraft|sendMail|authorizeSend|handoffToJournal/.test(storeSrc.replace(/FORBIDDEN_STORE_METHODS[\s\S]*?\]/, '')), false);
  assert.match(storeSrc, /no_send_phase: true/);
  console.log('ok - static 097 controlled-draft contract');
}

function ownerQueueStates() {
  const block = UP_086.match(/CONSTRAINT tenant_email_luna_automation_queue_state_values\s+CHECK \(state IN \(([^)]+)\)\)/);
  assert.ok(block, '086 queue state CHECK missing');
  return [...block[1].matchAll(/'([^']+)'/g)].map((row) => row[1]);
}

function assertSourceAnchored097() {
  assert.match(UP_063, /provider_mailbox_id\s+TEXT NOT NULL/);
  assert.match(UP_063, /provider_message_id\s+TEXT NOT NULL/);
  assert.match(UP_063, /conversation_id\s+TEXT NULL/);
  assert.match(UP_063, /UNIQUE \(provider, provider_mailbox_id, provider_message_id\)/);
  assert.match(UP_082, /ADD COLUMN body_text TEXT/);
  assert.match(UP_086, /CHECK \(state IN \('pending', 'claimed', 'handed_off', 'handoff_required', 'cancelled'\)\)/);
  assert.match(UP_092, /draft_digest text NOT NULL/);
  assert.match(UP, /REFERENCES public\.tenant_email_inbound_events/);
  assert.match(UP, /provider_mailbox_id, provider_message_id, conversation_id/);
  assert.match(UP, /sender_address_normalized/);
  assert.match(UP, /tenant_email_luna_automation_issuance_material/);
  assert.match(UP, /tenant_email_luna_automation_queue/);
  const states = ownerQueueStates();
  assert.deepEqual(states.slice().sort(), ['cancelled', 'claimed', 'handed_off', 'handoff_required', 'pending']);
}

async function applyCommittedInbound063Identity(db) {
  assertSourceAnchored097();
  await db.exec(`
    ALTER TABLE public.tenant_email_inbound_events
      ADD COLUMN IF NOT EXISTS provider text,
      ADD COLUMN IF NOT EXISTS provider_mailbox_id text,
      ADD COLUMN IF NOT EXISTS provider_message_id text,
      ADD COLUMN IF NOT EXISTS received_at timestamptz,
      ADD COLUMN IF NOT EXISTS is_read boolean,
      ADD COLUMN IF NOT EXISTS conversation_id text,
      ADD COLUMN IF NOT EXISTS internet_message_id text,
      ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT NOW();
    UPDATE public.tenant_email_inbound_events
       SET provider = COALESCE(provider, 'microsoft_graph'),
           provider_mailbox_id = COALESCE(provider_mailbox_id, '${MAILBOX}'),
           provider_message_id = COALESCE(provider_message_id, '${MESSAGE}' || replace(id::text, '-', '')),
           received_at = COALESCE(received_at, NOW()),
           is_read = COALESCE(is_read, FALSE),
           conversation_id = COALESCE(conversation_id, '${THREAD}')
     WHERE provider IS NULL
        OR provider_mailbox_id IS NULL
        OR provider_message_id IS NULL
        OR received_at IS NULL
        OR is_read IS NULL
        OR conversation_id IS NULL;
    ALTER TABLE public.tenant_email_inbound_events
      ALTER COLUMN provider SET NOT NULL,
      ALTER COLUMN provider_mailbox_id SET NOT NULL,
      ALTER COLUMN provider_message_id SET NOT NULL,
      ALTER COLUMN received_at SET NOT NULL,
      ALTER COLUMN is_read SET NOT NULL;
  `);
  await db.exec(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint
         WHERE conname = 'tenant_email_inbound_events_provider_values'
      ) THEN
        ALTER TABLE public.tenant_email_inbound_events
          ADD CONSTRAINT tenant_email_inbound_events_provider_values
          CHECK (provider IN ('microsoft_graph', 'gmail_api', 'imap_smtp'));
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint
         WHERE conname = 'tenant_email_inbound_events_mailbox_shape'
      ) THEN
        ALTER TABLE public.tenant_email_inbound_events
          ADD CONSTRAINT tenant_email_inbound_events_mailbox_shape
          CHECK (char_length(provider_mailbox_id) BETWEEN 1 AND 2048);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint
         WHERE conname = 'tenant_email_inbound_events_message_shape'
      ) THEN
        ALTER TABLE public.tenant_email_inbound_events
          ADD CONSTRAINT tenant_email_inbound_events_message_shape
          CHECK (char_length(provider_message_id) BETWEEN 1 AND 2048);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint
         WHERE conname = 'tenant_email_inbound_events_conversation_shape'
      ) THEN
        ALTER TABLE public.tenant_email_inbound_events
          ADD CONSTRAINT tenant_email_inbound_events_conversation_shape
          CHECK (conversation_id IS NULL OR char_length(conversation_id) BETWEEN 1 AND 2048);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint
         WHERE conname = 'tenant_email_inbound_events_identity_uq'
      ) THEN
        ALTER TABLE public.tenant_email_inbound_events
          ADD CONSTRAINT tenant_email_inbound_events_identity_uq
          UNIQUE (provider, provider_mailbox_id, provider_message_id);
      END IF;
    END $$;
  `);
  const bodyCol = await db.query(`
    SELECT 1 AS ok
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenant_email_inbound_events'
       AND a.attname = 'body_text'
       AND a.attnum > 0
       AND NOT a.attisdropped
  `);
  assert.equal(bodyCol.rows.length, 1, '082 body_text must exist on inbound events');
}

function createRoleLoaner(db, role) {
  return {
    async withTransactionClient(work) {
      await db.exec(`SET SESSION AUTHORIZATION ${role}`);
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
}

async function pgliteRoleSemantic(db, role) {
  try {
    await db.exec(`SET SESSION AUTHORIZATION ${role}`);
    const who = await db.query('SELECT session_user AS u');
    await db.exec('SET SESSION AUTHORIZATION postgres');
    return who.rows[0] && who.rows[0].u === role;
  } catch (_) {
    try { await db.exec('SET SESSION AUTHORIZATION postgres'); } catch (_) { /* ignore */ }
    return false;
  }
}

function createDraftStoreFor(loaner) {
  return loadDraftStore().createEmailLunaControlledDraftingOperationStore(loaner);
}

function loadDraftStore() {
  function wipe(rel) {
    try { delete require.cache[require.resolve(rel)]; } catch (_) { /* missing */ }
  }
  wipe('./lib/email-luna-controlled-drafting-operation-store');
  return require('./lib/email-luna-controlled-drafting-operation-store');
}

function digestUtf8(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function ackFor(record, extras) {
  const body = {
    body_digest: record.body_digest,
    client_id: record.client_id,
    endpoint_id: record.endpoint_id,
    inbound_provider_message_id: record.inbound_provider_message_id,
    inbound_provider_thread_id: record.inbound_provider_thread_id,
    is_draft: true,
    issuance_id: record.issuance_id,
    location_id: record.location_id,
    location_key: record.location_key,
    mailbox_id: record.mailbox_id,
    operation_id: record.operation_id,
    outcome: 'draft_created',
    provider: 'microsoft_graph',
    provider_draft_id: DRAFT_ID,
    recipient_address: record.recipient_address,
    subject_digest: record.subject_digest,
  };
  return Object.assign(body, extras || {});
}

async function persistIssuance(db, owners, loaner, operationId, auditId) {
  const bundle = await prepareBundle(
    owners,
    { client: ids.client, location: ids.location, conversation: ids.conversation, endpoint: ids.endpoint },
    'sunset-somo',
    ids.inbound,
  );
  const issuanceId = owners.readEmailLunaDraftPolicyIssuanceIdentity(bundle.triplet.evidence);
  const audit = await persistAudit(owners, loaner, auditId, bundle);
  const materialStore = owners.createEmailLunaAutomationIssuanceMaterialStore(loaner);
  const persistInput = {
    operation_id: operationId,
    audit_operation_id: audit.operation_id,
    envelope: bundle.triplet.envelope,
    evidence: bundle.triplet.evidence,
    decision: bundle.triplet.decision,
    eligibility: bundle.eligibility,
    draft: bundle.draft,
    validation: bundle.validation,
  };
  const persisted = await materialStore.persistAndEnqueueAutomationIssuance(persistInput);
  assert.ok(persisted.status === 'committed' || persisted.status === 'replayed');
  return { bundle, issuanceId, persisted, persistInput, materialStore };
}

async function provisionChapter2Roles(db) {
  const { provisionEmailLunaAutomationPrincipal } = require('./lib/email-luna-automation-principal-provision');
  await provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
    roleName: 'luna_ch2_worker',
    kind: 'worker',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: PASSWORD,
    apply: true,
  });
  await provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
    roleName: 'luna_ch2_producer',
    kind: 'producer',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: PASSWORD,
    apply: true,
  });
  const roles = await pgliteRoleSemantic(db, 'luna_ch2_producer')
    && await pgliteRoleSemantic(db, 'luna_ch2_worker');
  const ownerLoaner = createLoaner(db);
  if (!roles) {
    console.log('ok - PGlite limitation: session_user role semantic is not modeled; stock-PG is the authority proof');
    const store = createDraftStoreFor(ownerLoaner);
    return { ownerLoaner, producerStore: store, workerStore: store, rolesMode: false };
  }
  return {
    ownerLoaner,
    producerStore: createDraftStoreFor(createRoleLoaner(db, 'luna_ch2_producer')),
    workerStore: createDraftStoreFor(createRoleLoaner(db, 'luna_ch2_worker')),
    rolesMode: true,
  };
}

async function provePglite(PGlite) {
  assertStaticContract();
  const owners = loadOwners();
  const db = new PGlite();
  await applyThrough088(db);
  await db.exec(UP_092);
  await applyCommittedInbound063Identity(db);
  await db.exec(UP);
  const present = await db.query('SELECT to_regclass(\'public.tenant_email_luna_controlled_draft_operations\') AS rel');
  assert.ok(present.rows[0].rel);
  await revokePublicExecuteOutsideCatalogs(db);

  const { ownerLoaner, producerStore, workerStore, rolesMode } = await provisionChapter2Roles(db);
  const seeded = await persistIssuance(db, owners, ownerLoaner, ids.operation, ids.audit);
  const duplicateQueue = await seeded.materialStore.persistAndEnqueueAutomationIssuance(seeded.persistInput);
  assert.equal(duplicateQueue.status, 'replayed');
  console.log('ok - duplicate persist/enqueue is replayed');
  if (rolesMode) console.log('ok - PGlite reserve/claim use mapped producer/worker rather than table owner');

  const storeMod = loadDraftStore();
  const store = producerStore;
  const reserveInput = {
    operation_id: ids.operation,
    issuance_id: seeded.issuanceId,
    canonical_subject: seeded.bundle.draft.subject,
    canonical_body: seeded.bundle.draft.body,
    language: seeded.bundle.draft.language,
  };
  const reserved = await store.reserveControlledDraft(reserveInput);
  assert.equal(reserved.status, 'reserved');
  assert.equal(reserved.record.state, 'reserved');
  assert.equal(reserved.record.create_dispatch_claimed, false);
  assert.equal(reserved.record.mailbox_id, MAILBOX);
  assert.equal(reserved.record.inbound_provider_thread_id, THREAD);
  assert.equal(reserved.record.provider, 'microsoft_graph');
  assert.equal(reserved.record.subject_digest, digestUtf8(seeded.bundle.draft.subject));
  const replayReserve = await store.reserveControlledDraft(reserveInput);
  assert.equal(replayReserve.status, 'replayed');
  const countOps = await db.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_luna_controlled_draft_operations');
  assert.equal(countOps.rows[0].n, 1);
  console.log('ok - duplicate reserve returns existing row');

  await assert.rejects(
    () => store.reserveControlledDraft({
      ...reserveInput,
      canonical_subject: 'Different subject',
    }),
    (error) => error && error.code === 'EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_INVALID',
  );
  console.log('ok - reserve identity conflict / digest mismatch fail closed');

  const claimed = await workerStore.claimCreateDispatch({
    operation_id: ids.operation,
    issuance_id: seeded.issuanceId,
    expected_generation: 1,
  });
  assert.equal(claimed.status, 'create_dispatched_outcome_unknown');
  assert.equal(claimed.record.create_dispatch_claimed, true);
  assert.equal(claimed.record.provider_draft_id, null);
  const replayClaim = await workerStore.claimCreateDispatch({
    operation_id: ids.operation,
    issuance_id: seeded.issuanceId,
    expected_generation: null,
  });
  assert.equal(replayClaim.status, 'replayed');
  assert.equal(replayClaim.record.state, 'create_dispatched_outcome_unknown');
  assert.equal(replayClaim.record.state_generation, 2);
  const historyClaim = await db.query('SELECT action FROM public.tenant_email_luna_controlled_draft_transitions ORDER BY created_at, id');
  assert.deepEqual(historyClaim.rows.map((row) => row.action), ['reserve', 'claim_create']);
  console.log('ok - one create-dispatch claim; repeat is idempotent observation');

  const stale = await workerStore.recordProviderCreate({
    operation_id: ids.operation,
    issuance_id: seeded.issuanceId,
    expected_generation: 1,
    acknowledgement: ackFor(claimed.record),
  });
  assert.equal(stale.status, 'stale_generation');
  assert.equal(stale.record.state, 'create_dispatched_outcome_unknown');
  console.log('ok - stale generation does not mutate');

  const stillUnknown = await store.loadControlledDraft({
    operation_id: ids.operation,
    issuance_id: seeded.issuanceId,
  });
  assert.equal(stillUnknown.status, 'loaded');
  assert.equal(stillUnknown.record.state, 'create_dispatched_outcome_unknown');
  const reserveAfterDispatch = await store.reserveControlledDraft(reserveInput);
  assert.equal(reserveAfterDispatch.status, 'replayed');
  assert.equal(reserveAfterDispatch.record.state, 'create_dispatched_outcome_unknown');
  assert.throws(
    () => workerStore.reconcileProviderDraft({
      operation_id: ids.operation,
      issuance_id: seeded.issuanceId,
      expected_generation: null,
      observation: {
        kind: 'exact',
        provider_draft_id: '.',
        is_draft: true,
        subject_digest: claimed.record.subject_digest,
        body_digest: claimed.record.body_digest,
      },
    }),
    (error) => error && error.code === 'EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_INVALID',
  );
  assert.throws(
    () => workerStore.reconcileProviderDraft({
      operation_id: ids.operation,
      issuance_id: seeded.issuanceId,
      expected_generation: null,
      observation: {
        kind: 'exact',
        provider_draft_id: '..',
        is_draft: true,
        subject_digest: claimed.record.subject_digest,
        body_digest: claimed.record.body_digest,
      },
    }),
    (error) => error && error.code === 'EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_INVALID',
  );
  console.log('ok - crash-unknown remains reconcile-only; dot provider ids refused');

  const mismatchFalseDraft = await workerStore.recordProviderCreate({
    operation_id: ids.operation,
    issuance_id: seeded.issuanceId,
    expected_generation: 2,
    acknowledgement: ackFor(claimed.record, { is_draft: false }),
  });
  assert.equal(mismatchFalseDraft.status, 'provider_mismatch_blocked');
  assert.equal(mismatchFalseDraft.record.provider_draft_id, null);
  console.log('ok - is_draft false is durable mismatch and does not store identity');
}

async function proveHappyAndAdversarial(PGlite) {
  const owners = loadOwners();
  const db = new PGlite();
  await applyThrough088(db);
  await db.exec(UP_092);
  await applyCommittedInbound063Identity(db);
  await db.exec(UP);
  await revokePublicExecuteOutsideCatalogs(db);
  const { ownerLoaner, producerStore, workerStore } = await provisionChapter2Roles(db);
  const loaner = ownerLoaner;
  const seeded = await persistIssuance(db, owners, ownerLoaner, ids.operation, ids.audit);
  const storeMod = loadDraftStore();
  const store = workerStore;
  const reserveInput = {
    operation_id: ids.operation,
    issuance_id: seeded.issuanceId,
    canonical_subject: seeded.bundle.draft.subject,
    canonical_body: seeded.bundle.draft.body,
    language: seeded.bundle.draft.language,
  };
  const reserved = await producerStore.reserveControlledDraft(reserveInput);
  const claimed = await workerStore.claimCreateDispatch({
    operation_id: ids.operation,
    issuance_id: seeded.issuanceId,
    expected_generation: reserved.record.state_generation,
  });
  const recorded = await workerStore.recordProviderCreate({
    operation_id: ids.operation,
    issuance_id: seeded.issuanceId,
    expected_generation: claimed.record.state_generation,
    acknowledgement: ackFor(claimed.record),
  });
  assert.equal(recorded.status, 'provider_draft_reconciled_exact');
  assert.equal(recorded.record.provider_draft_id, DRAFT_ID);
  assert.equal(recorded.record.is_draft, true);

  const exact = await store.reconcileProviderDraft({
    operation_id: ids.operation,
    issuance_id: seeded.issuanceId,
    expected_generation: recorded.record.state_generation,
    observation: {
      kind: 'exact',
      provider_draft_id: DRAFT_ID,
      is_draft: true,
      subject_digest: recorded.record.subject_digest,
      body_digest: recorded.record.body_digest,
    },
  });
  assert.equal(exact.status, 'replayed');
  assert.equal(exact.record.state, 'provider_draft_reconciled_exact');
  console.log('ok - happy reserve → claim → record → reconcile exact');

  const wrongTenant = await store.recordProviderCreate({
    operation_id: ids.operation,
    issuance_id: seeded.issuanceId,
    expected_generation: exact.record.state_generation,
    acknowledgement: ackFor(exact.record, { client_id: ids.client2 }),
  }).catch((error) => error);
  assert.equal(wrongTenant && wrongTenant.code, 'EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_INVALID');
  const afterWrong = await store.loadControlledDraft({
    operation_id: ids.operation,
    issuance_id: seeded.issuanceId,
  });
  assert.equal(afterWrong.record.state, 'provider_draft_reconciled_exact');
  assert.equal(afterWrong.record.provider_draft_id, DRAFT_ID);
  console.log('ok - record after exact with wrong tenant fails closed without overwrite');

  const unexpectedId = await store.reconcileProviderDraft({
    operation_id: ids.operation,
    issuance_id: seeded.issuanceId,
    expected_generation: afterWrong.record.state_generation,
    observation: {
      kind: 'exact',
      provider_draft_id: 'AAMkAGI2-OTHER',
      is_draft: true,
      subject_digest: afterWrong.record.subject_digest,
      body_digest: afterWrong.record.body_digest,
    },
  });
  assert.equal(unexpectedId.status, 'provider_mismatch_blocked');
  assert.equal(unexpectedId.record.provider_draft_id, DRAFT_ID);
  console.log('ok - unexpected provider draft id is mismatch and never overwrites identity');

  const freshMod = loadDraftStore();
  const fresh = freshMod.createEmailLunaControlledDraftingOperationStore(loaner);
  const loaded = await fresh.loadControlledDraft({
    operation_id: ids.operation,
    issuance_id: seeded.issuanceId,
  });
  assert.equal(loaded.status, 'loaded');
  fresh.assertAuthenticLoadedOperation(loaded.record);
  const forged = { ...loaded.record };
  assert.throws(() => fresh.assertAuthenticLoadedOperation(forged));
  console.log('ok - fresh-process load/recovery; forged loaded material rejected');

  const recreate = await fresh.claimCreateDispatch({
    operation_id: ids.operation,
    issuance_id: seeded.issuanceId,
    expected_generation: null,
  });
  assert.equal(recreate.status, 'replayed');
  assert.equal(recreate.record.state, 'provider_mismatch_blocked');
  console.log('ok - mismatch is not recreate-ready');
}

async function proveStaffTerminalAndBindings(PGlite) {
  const owners = loadOwners();
  const db = new PGlite();
  await applyThrough088(db);
  await db.exec(UP_092);
  await applyCommittedInbound063Identity(db);
  await db.exec(UP);
  const loaner = createLoaner(db);
  const seeded = await persistIssuance(db, owners, loaner, ids.operation, ids.audit);
  const store = loadDraftStore().createEmailLunaControlledDraftingOperationStore(loaner);
  const reserved = await store.reserveControlledDraft({
    operation_id: ids.operation,
    issuance_id: seeded.issuanceId,
    canonical_subject: seeded.bundle.draft.subject,
    canonical_body: seeded.bundle.draft.body,
    language: seeded.bundle.draft.language,
  });
  await store.claimCreateDispatch({
    operation_id: ids.operation,
    issuance_id: seeded.issuanceId,
    expected_generation: reserved.record.state_generation,
  });
  const recorded = await store.recordProviderCreate({
    operation_id: ids.operation,
    issuance_id: seeded.issuanceId,
    expected_generation: null,
    acknowledgement: ackFor(reserved.record, {
      inbound_provider_message_id: reserved.record.inbound_provider_message_id,
      inbound_provider_thread_id: reserved.record.inbound_provider_thread_id,
      mailbox_id: reserved.record.mailbox_id,
      subject_digest: reserved.record.subject_digest,
      body_digest: reserved.record.body_digest,
      recipient_address: reserved.record.recipient_address,
    }),
  });
  assert.equal(recorded.status, 'provider_draft_reconciled_exact');

  const modified = await store.reconcileProviderDraft({
    operation_id: ids.operation,
    issuance_id: seeded.issuanceId,
    expected_generation: recorded.record.state_generation,
    observation: { kind: 'modified_by_staff', provider_draft_id: DRAFT_ID, is_draft: true },
  });
  assert.equal(modified.status, 'provider_draft_modified_by_staff');
  const modifiedAgain = await store.reconcileProviderDraft({
    operation_id: ids.operation,
    issuance_id: seeded.issuanceId,
    expected_generation: null,
    observation: { kind: 'exact', provider_draft_id: DRAFT_ID, is_draft: true, subject_digest: recorded.record.subject_digest, body_digest: recorded.record.body_digest },
  });
  assert.equal(modifiedAgain.status, 'provider_draft_modified_by_staff');
  const claimAfterModified = await store.claimCreateDispatch({
    operation_id: ids.operation,
    issuance_id: seeded.issuanceId,
    expected_generation: null,
  });
  assert.equal(claimAfterModified.status, 'replayed');
  assert.equal(claimAfterModified.record.state, 'provider_draft_modified_by_staff');
  console.log('ok - modified-by-staff is terminal / not recreate-ready');

  const db2 = new PGlite();
  await applyThrough088(db2);
  await db2.exec(UP_092);
  await applyCommittedInbound063Identity(db2);
  await db2.exec(UP);
  const loaner2 = createLoaner(db2);
  const seeded2 = await persistIssuance(db2, loadOwners(), loaner2, ids.operation, ids.audit);
  const store2 = loadDraftStore().createEmailLunaControlledDraftingOperationStore(loaner2);
  await store2.reserveControlledDraft({
    operation_id: ids.operation,
    issuance_id: seeded2.issuanceId,
    canonical_subject: seeded2.bundle.draft.subject,
    canonical_body: seeded2.bundle.draft.body,
    language: seeded2.bundle.draft.language,
  });
  await store2.claimCreateDispatch({
    operation_id: ids.operation,
    issuance_id: seeded2.issuanceId,
    expected_generation: null,
  });
  await store2.recordProviderCreate({
    operation_id: ids.operation,
    issuance_id: seeded2.issuanceId,
    expected_generation: null,
    acknowledgement: ackFor((await store2.loadControlledDraft({
      operation_id: ids.operation,
      issuance_id: seeded2.issuanceId,
    })).record),
  });
  const removed = await store2.reconcileProviderDraft({
    operation_id: ids.operation,
    issuance_id: seeded2.issuanceId,
    expected_generation: null,
    observation: { kind: 'removed_by_staff', provider_draft_id: DRAFT_ID },
  });
  assert.equal(removed.status, 'provider_draft_removed_by_staff');
  const notFound = await store2.reconcileProviderDraft({
    operation_id: ids.operation,
    issuance_id: seeded2.issuanceId,
    expected_generation: null,
    observation: { kind: 'not_found' },
  });
  assert.equal(notFound.status, 'provider_draft_removed_by_staff');
  const claimRemoved = await store2.claimCreateDispatch({
    operation_id: ids.operation,
    issuance_id: seeded2.issuanceId,
    expected_generation: null,
  });
  assert.equal(claimRemoved.status, 'replayed');
  assert.equal(claimRemoved.record.state, 'provider_draft_removed_by_staff');
  console.log('ok - removed-by-staff is terminal / not recreate-ready');

  await assert.rejects(
    () => store2.reserveControlledDraft({
      operation_id: ids.operation2,
      issuance_id: seeded2.issuanceId,
      canonical_subject: seeded2.bundle.draft.subject,
      canonical_body: seeded2.bundle.draft.body,
      language: seeded2.bundle.draft.language,
    }),
    (error) => error && error.code === 'EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_INVALID',
  );
  console.log('ok - wrong operation/issuance pair fail closed');
}

async function proveAccessorsRollbackPool(PGlite) {
  const owners = loadOwners();
  const db = new PGlite();
  await applyThrough088(db);
  await db.exec(UP_092);
  await applyCommittedInbound063Identity(db);
  await db.exec(UP);
  const loaner = createLoaner(db);
  const seeded = await persistIssuance(db, owners, loaner, ids.operation, ids.audit);
  const storeMod = loadDraftStore();
  const store = storeMod.createEmailLunaControlledDraftingOperationStore(loaner);

  const secret = {};
  Object.defineProperty(secret, 'access_token', { get() { throw new Error('SECRET_LEAK'); }, enumerable: true });
  Object.defineProperty(secret, 'operation_id', { value: ids.operation, enumerable: true });
  assert.throws(
    () => store.reserveControlledDraft(secret),
    (error) => error && error.code === 'EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_INVALID' && !String(error.message).includes('SECRET'),
  );
  assert.throws(
    () => storeMod.createEmailLunaControlledDraftingOperationStore({
      withTransactionClient: new Proxy(loaner.withTransactionClient, { apply: Reflect.apply }),
    }),
    (error) => error && error.code === 'EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_INVALID',
  );
  assert.throws(
    () => store.reserveControlledDraft({
      operation_id: ids.operation,
      issuance_id: seeded.issuanceId,
      canonical_subject: seeded.bundle.draft.subject,
      canonical_body: seeded.bundle.draft.body,
      language: seeded.bundle.draft.language,
      [Symbol('send')]: true,
    }),
    (error) => error && error.code === 'EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_INVALID',
  );
  console.log('ok - accessors/symbols/proxies/secret fields fail closed without leakage');

  const rotating = storeMod.createEmailLunaControlledDraftingOperationStore({
    async withTransactionClient(work) {
      return work(new Proxy({
        async query() { return { rows: [] }; },
      }, { get(target, prop, recv) { return Reflect.get(target, prop, recv); } }));
    },
  });
  await assert.rejects(
    () => rotating.reserveControlledDraft({
      operation_id: ids.operation,
      issuance_id: seeded.issuanceId,
      canonical_subject: seeded.bundle.draft.subject,
      canonical_body: seeded.bundle.draft.body,
      language: seeded.bundle.draft.language,
    }),
    (error) => error && error.code === 'EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_INVALID',
  );
  console.log('ok - rotating-pool / proxied client refused');

  const before = await db.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_luna_controlled_draft_operations');
  await assert.rejects(
    () => store.reserveControlledDraft({
      operation_id: ids.operation2,
      issuance_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa99',
      canonical_subject: seeded.bundle.draft.subject,
      canonical_body: seeded.bundle.draft.body,
      language: seeded.bundle.draft.language,
    }),
    (error) => error && error.code === 'EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_INVALID',
  );
  const after = await db.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_luna_controlled_draft_operations');
  assert.equal(after.rows[0].n, before.rows[0].n);
  console.log('ok - failed reserve rolls back and leaves no operation row');

  const sendCols = await db.query(`
    SELECT a.attname
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenant_email_luna_controlled_draft_operations'
       AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname ~ 'send'
  `);
  assert.equal(sendCols.rows.length, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(store, 'send'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(store, 'sendDraft'), false);
  console.log('ok - no send fields/phases/methods/counters');
}

async function proveEmptyDown(PGlite) {
  const db = new PGlite();
  await applyThrough088(db);
  await db.exec(UP_092);
  await applyCommittedInbound063Identity(db);
  await db.exec(UP);
  await db.exec(DOWN);
  await db.exec(DOWN);
  const gone = await db.query('SELECT to_regclass(\'public.tenant_email_luna_controlled_draft_operations\') AS rel');
  assert.equal(gone.rows[0].rel, null);
  console.log('ok - empty 097 down is repeatable');
}

async function proveNonemptyDown(PGlite) {
  const owners = loadOwners();
  const db = new PGlite();
  await applyThrough088(db);
  await db.exec(UP_092);
  await applyCommittedInbound063Identity(db);
  await db.exec(UP);
  const loaner = createLoaner(db);
  const seeded = await persistIssuance(db, owners, loaner, ids.operation, ids.audit);
  const store = loadDraftStore().createEmailLunaControlledDraftingOperationStore(loaner);
  await store.reserveControlledDraft({
    operation_id: ids.operation,
    issuance_id: seeded.issuanceId,
    canonical_subject: seeded.bundle.draft.subject,
    canonical_body: seeded.bundle.draft.body,
    language: seeded.bundle.draft.language,
  });
  try {
    await db.exec(DOWN);
    assert.fail('expected nonempty down refusal');
  } catch (error) {
    assert.match(String(error.message), /097_down_refused/);
    try { await db.query('ROLLBACK'); } catch (_) { /* aborted transaction */ }
  }
  const still = await db.query('SELECT to_regclass(\'public.tenant_email_luna_controlled_draft_operations\') AS rel');
  assert.ok(still.rows[0].rel);
  console.log('ok - nonempty 097 down refuses evidence loss');
}

const HOSTILE_PROVIDER_IDS = Object.freeze([
  '.', '..', '/', '?', '#', '%', '\\', ' ', '\t', '\n', '\u0001', '\u007f',
  'foo/bar', 'foo?x', 'foo#x', 'foo%2fbar', 'foo%2Fbar', 'foo%5cbar', 'foo%5Cbar',
  '%2e%2e', '%2E%2E', '%2f', '%2F', '%5c', '%5C', '..%2f', 'foo\\bar',
]);
const LEGIT_PROVIDER_IDS = Object.freeze([
  MAILBOX, MESSAGE, THREAD, DRAFT_ID, 'AAMkA-_=', 'opaque-id+with=padding',
]);

async function sqlCallReserve(db, args) {
  return db.query(
    'SELECT * FROM public.tenant_email_luna_controlled_draft_reserve($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text)',
    args,
  );
}

async function proveCanonicalAuthorityAndLiveness(PGlite) {
  const owners = loadOwners();
  const db = new PGlite();
  await applyThrough088(db);
  await db.exec(UP_092);
  await applyCommittedInbound063Identity(db);
  await db.exec(UP);
  await revokePublicExecuteOutsideCatalogs(db);
  const { ownerLoaner, producerStore, workerStore } = await provisionChapter2Roles(db);
  const seeded = await persistIssuance(db, owners, ownerLoaner, ids.operation, ids.audit);

  const material = await db.query(
    'SELECT draft_digest, language FROM public.tenant_email_luna_automation_issuance_material WHERE operation_id = $1 AND issuance_id = $2',
    [ids.operation, seeded.issuanceId],
  );
  assert.equal(material.rows.length, 1);
  const stolenDigest = material.rows[0].draft_digest;
  const stolenLanguage = material.rows[0].language;
  const evilSubject = 'EVIL SUBJECT FORGED';
  const evilBody = 'evil body forged against stolen 092 digest';
  const before = await db.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_luna_controlled_draft_operations');
  await assert.rejects(
    () => sqlCallReserve(db, [
      ids.operation, seeded.issuanceId, evilSubject, evilBody, stolenLanguage,
      digestUtf8(evilSubject), digestUtf8(evilBody), stolenDigest,
    ]),
    (error) => error && (error.code === '23514' || /digest\/language mismatch/.test(String(error.message))),
  );
  const after = await db.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_luna_controlled_draft_operations');
  assert.equal(after.rows[0].n, before.rows[0].n);
  console.log('ok - stolen 092 digest with evil subject/body fails closed and creates no row');

  for (const hostile of HOSTILE_PROVIDER_IDS) {
    const ok = await db.query(
      'SELECT public.tenant_email_luna_controlled_draft_provider_id_ok($1::text) AS ok',
      [hostile],
    );
    assert.equal(ok.rows[0].ok, false, `provider id should refuse ${JSON.stringify(hostile)}`);
  }
  for (const legit of LEGIT_PROVIDER_IDS) {
    const ok = await db.query(
      'SELECT public.tenant_email_luna_controlled_draft_provider_id_ok($1::text) AS ok',
      [legit],
    );
    assert.equal(ok.rows[0].ok, true, `provider id should accept ${JSON.stringify(legit)}`);
  }
  const storeMod = loadDraftStore();
  const jsStore = storeMod.createEmailLunaControlledDraftingOperationStore(ownerLoaner);
  for (const hostile of HOSTILE_PROVIDER_IDS) {
    assert.throws(
      () => jsStore.reconcileProviderDraft({
        operation_id: ids.operation,
        issuance_id: seeded.issuanceId,
        expected_generation: null,
        observation: {
          kind: 'exact',
          provider_draft_id: hostile,
          is_draft: true,
          subject_digest: digestUtf8('x'),
          body_digest: digestUtf8('y'),
        },
      }),
      (error) => error && error.code === 'EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_INVALID',
      `JS provider id should refuse ${JSON.stringify(hostile)}`,
    );
  }
  console.log('ok - SQL+JS provider-id owner rejects path/encoding confusion and keeps opaque Graph ids');

  const liveStates = new Set(['pending', 'claimed']);
  const authenticStates = ownerQueueStates();
  assert.ok(authenticStates.includes('pending'));
  assert.ok(authenticStates.includes('claimed'));
  for (const state of authenticStates) {
    const dbState = new PGlite();
    await applyThrough088(dbState);
    await dbState.exec(UP_092);
    await applyCommittedInbound063Identity(dbState);
    await dbState.exec(UP);
    await revokePublicExecuteOutsideCatalogs(dbState);
    const roles = await provisionChapter2Roles(dbState);
    const seed = await persistIssuance(dbState, loadOwners(), roles.ownerLoaner, ids.operation, ids.audit);
    if (state === 'claimed') {
      const claimedQ = await dbState.query(
        'SELECT * FROM public.tenant_email_luna_automation_claim($1::uuid, $2::uuid)',
        [ids.ownerA, ids.operation],
      );
      assert.equal(claimedQ.rows[0].state, 'claimed');
    } else if (state === 'cancelled') {
      const cancelled = await dbState.query(
        'SELECT * FROM public.tenant_email_luna_automation_cancel_pending($1::uuid, $2::uuid)',
        [ids.client, ids.operation],
      );
      assert.equal(cancelled.rows[0].state, 'cancelled');
    } else if (state === 'handoff_required') {
      const required = await dbState.query(
        'SELECT * FROM public.tenant_email_luna_automation_require_handoff_pending($1::uuid, $2::uuid)',
        [ids.client, ids.operation],
      );
      assert.equal(required.rows[0].state, 'handoff_required');
    } else if (state === 'handed_off') {
      const claimedQ = await dbState.query(
        'SELECT * FROM public.tenant_email_luna_automation_claim($1::uuid, $2::uuid)',
        [ids.ownerA, ids.operation],
      );
      assert.equal(claimedQ.rows[0].state, 'claimed');
      const handed = await dbState.query(
        'SELECT * FROM public.tenant_email_luna_automation_handoff($1::uuid, $2::uuid)',
        [ids.operation, ids.ownerA],
      );
      assert.equal(handed.rows[0].state, 'handed_off');
    } else if (state !== 'pending') {
      assert.fail(`unhandled authentic 086 queue state ${state}`);
    }
    const current = await dbState.query(
      'SELECT state FROM public.tenant_email_luna_automation_queue WHERE operation_id = $1',
      [ids.operation],
    );
    assert.equal(current.rows[0].state, state);
    const reserveInput = {
      operation_id: ids.operation,
      issuance_id: seed.issuanceId,
      canonical_subject: seed.bundle.draft.subject,
      canonical_body: seed.bundle.draft.body,
      language: seed.bundle.draft.language,
    };
    if (liveStates.has(state)) {
      const reserved = await roles.producerStore.reserveControlledDraft(reserveInput);
      assert.equal(reserved.status, 'reserved');
      const claimed = await roles.workerStore.claimCreateDispatch({
        operation_id: ids.operation,
        issuance_id: seed.issuanceId,
        expected_generation: reserved.record.state_generation,
      });
      assert.equal(claimed.status, 'create_dispatched_outcome_unknown');
    } else {
      await assert.rejects(
        () => roles.producerStore.reserveControlledDraft(reserveInput),
        (error) => error && error.code === 'EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_INVALID',
      );
      const n = await dbState.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_luna_controlled_draft_operations');
      assert.equal(n.rows[0].n, 0);
    }
  }

  const dbClaim = new PGlite();
  await applyThrough088(dbClaim);
  await dbClaim.exec(UP_092);
  await applyCommittedInbound063Identity(dbClaim);
  await dbClaim.exec(UP);
  await revokePublicExecuteOutsideCatalogs(dbClaim);
  const claimRoles = await provisionChapter2Roles(dbClaim);
  const claimSeed = await persistIssuance(dbClaim, loadOwners(), claimRoles.ownerLoaner, ids.operation, ids.audit);
  await claimRoles.producerStore.reserveControlledDraft({
    operation_id: ids.operation,
    issuance_id: claimSeed.issuanceId,
    canonical_subject: claimSeed.bundle.draft.subject,
    canonical_body: claimSeed.bundle.draft.body,
    language: claimSeed.bundle.draft.language,
  });
  const cancelledAfterReserve = await dbClaim.query(
    'SELECT * FROM public.tenant_email_luna_automation_cancel_pending($1::uuid, $2::uuid)',
    [ids.client, ids.operation],
  );
  assert.equal(cancelledAfterReserve.rows[0].state, 'cancelled');
  await assert.rejects(
    () => claimRoles.workerStore.claimCreateDispatch({
      operation_id: ids.operation,
      issuance_id: claimSeed.issuanceId,
      expected_generation: null,
    }),
    (error) => error && error.code === 'EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_INVALID',
  );
  const stillReserved = await dbClaim.query(
    'SELECT state FROM public.tenant_email_luna_controlled_draft_operations WHERE operation_id = $1',
    [ids.operation],
  );
  assert.equal(stillReserved.rows[0].state, 'reserved');
  console.log('ok - reserve/claim require authentic 086 pending|claimed; every other owner state fails closed');

  const tablePriv = await db.query(`
    SELECT
      pg_catalog.has_table_privilege('luna_ch2_producer', 'public.tenant_email_luna_controlled_draft_operations', 'SELECT') AS producer_ops_select,
      pg_catalog.has_table_privilege('luna_ch2_worker', 'public.tenant_email_luna_controlled_draft_operations', 'INSERT') AS worker_ops_insert,
      pg_catalog.has_table_privilege('luna_ch2_producer', 'public.tenant_email_luna_controlled_draft_transitions', 'UPDATE') AS producer_tr_update
  `);
  assert.equal(tablePriv.rows[0].producer_ops_select, false);
  assert.equal(tablePriv.rows[0].worker_ops_insert, false);
  assert.equal(tablePriv.rows[0].producer_tr_update, false);
  console.log('ok - producer/worker table SELECT/DML on 097 operations/transitions remain revoked');
  void producerStore;
  void workerStore;
}

function pgLikeRow(values) {
  const row = {};
  const keys = Object.keys(values);
  for (let i = 0; i < keys.length; i += 1) {
    Object.defineProperty(row, keys[i], {
      value: values[keys[i]], enumerable: true, writable: true, configurable: true,
    });
  }
  return row;
}

function authenticResultShape() {
  return {
    status: 'reserved',
    operation_id: ids.operation,
    issuance_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa10',
    audit_operation_id: ids.audit,
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    endpoint_id: ids.endpoint,
    conversation_id: ids.conversation,
    inbound_event_id: ids.inbound,
    provider: 'microsoft_graph',
    mailbox_id: MAILBOX,
    inbound_provider_message_id: MESSAGE,
    inbound_provider_thread_id: THREAD,
    recipient_address: 'elena@example.test',
    canonical_subject: 'Lesson question',
    canonical_body: 'How much is a surf lesson?',
    subject_digest: digestUtf8('Lesson question'),
    body_digest: digestUtf8('How much is a surf lesson?'),
    draft_digest: digestUtf8('unused'),
    policy_version: 'email-luna-draft-policy.v1',
    eligibility_policy_version: 'email-luna-autonomous-eligibility-policy.v1',
    validator_version: 'email-luna-draft-validator.v1',
    state: 'reserved',
    create_dispatch_claimed: false,
    provider_draft_id: null,
    is_draft: null,
    state_generation: 1,
  };
}

async function proveDescriptorSafeRows() {
  const storeMod = loadDraftStore();
  const reserveInput = {
    operation_id: ids.operation,
    issuance_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa10',
    canonical_subject: 'Lesson question',
    canonical_body: 'How much is a surf lesson?',
    language: 'en',
  };

  async function runAgainst(rowFactory) {
    const store = storeMod.createEmailLunaControlledDraftingOperationStore({
      async withTransactionClient(work) {
        return work({
          async query(text) {
            if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
            return { rows: [rowFactory()] };
          },
        });
      },
    });
    return store.reserveControlledDraft(reserveInput);
  }

  let getterCount = 0;
  await assert.rejects(
    () => runAgainst(() => {
      const row = pgLikeRow(authenticResultShape());
      delete row.status;
      Object.defineProperty(row, 'status', {
        get() { getterCount += 1; return 'reserved'; }, enumerable: true,
      });
      return row;
    }),
    (error) => error && error.code === 'EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_INVALID',
  );
  assert.equal(getterCount, 0);

  getterCount = 0;
  const inherited = { get status() { getterCount += 1; return 'reserved'; } };
  await assert.rejects(
    () => runAgainst(() => {
      const row = Object.create(inherited);
      const values = authenticResultShape();
      delete values.status;
      Object.assign(row, values);
      return row;
    }),
    (error) => error && error.code === 'EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_INVALID',
  );
  assert.equal(getterCount, 0);

  await assert.rejects(
    () => runAgainst(() => {
      const row = pgLikeRow(authenticResultShape());
      Object.defineProperty(row, Symbol('status'), { value: 'reserved', enumerable: true });
      delete row.status;
      return row;
    }),
    (error) => error && error.code === 'EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_INVALID',
  );

  await assert.rejects(
    () => runAgainst(() => new Proxy(pgLikeRow(authenticResultShape()), {
      get(target, prop, recv) { return Reflect.get(target, prop, recv); },
    })),
    (error) => error && error.code === 'EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_INVALID',
  );

  const protoKey = 'status';
  getterCount = 0;
  Object.defineProperty(Object.prototype, protoKey, {
    get() { getterCount += 1; return 'reserved'; }, configurable: true,
  });
  try {
    await assert.rejects(
      () => runAgainst(() => {
        const values = authenticResultShape();
        delete values.status;
        return pgLikeRow(values);
      }),
      (error) => error && error.code === 'EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_INVALID',
    );
  } finally {
    delete Object.prototype[protoKey];
  }
  assert.equal(getterCount, 0);

  const mutable = pgLikeRow(authenticResultShape());
  mutable.state = 'reserved';
  await assert.rejects(
    () => runAgainst(() => {
      const clone = pgLikeRow(authenticResultShape());
      Object.defineProperty(clone, 'status', { get() { return 'reserved'; }, enumerable: true });
      return clone;
    }),
    (error) => error && error.code === 'EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_INVALID',
  );
  assert.equal(mutable.state, 'reserved');
  console.log('ok - descriptor-safe result rows: getters/inherited/symbols/proxies/non-data fail closed after restore');
}

async function runPgliteProof() {
  assertStaticContract();
  const PGlite = tryLoadPglite();
  if (!PGlite) {
    console.log('SKIP pglite unavailable — static 097 contract still holds');
    return;
  }
  await proveEmptyDown(PGlite);
  await proveNonemptyDown(PGlite);
  await provePglite(PGlite);
  await proveHappyAndAdversarial(PGlite);
  await proveStaffTerminalAndBindings(PGlite);
  await proveAccessorsRollbackPool(PGlite);
  await proveCanonicalAuthorityAndLiveness(PGlite);
  await proveDescriptorSafeRows();
  console.log('ALL OK — FULL SAIL Stage 2 Chapter 2 controlled-draft operations pglite');
}

if (require.main === module) {
  runPgliteProof().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  UP,
  DOWN,
  ids,
  PASSWORD,
  MAILBOX,
  MESSAGE,
  THREAD,
  DRAFT_ID,
  assertStaticContract,
  applyCommittedInbound063Identity,
  loadDraftStore,
  ackFor,
  persistIssuance,
  runPgliteProof,
  tryLoadPglite,
};

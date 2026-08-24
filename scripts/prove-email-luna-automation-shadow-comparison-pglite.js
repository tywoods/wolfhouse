'use strict';

/**
 * Prove Ch4 Slice B4 durable shadow comparison outcomes against 085/086/087/088/092/093.
 * Optional 070 later-match. No provider. No journal terminal.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RED = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'fixtures/email-luna-automation-shadow-comparison-red.json'),
  'utf8',
));
const UP_070 = fs.readFileSync(path.join(ROOT, 'database/migrations/070_tenant_email_reply_approvals.sql'), 'utf8');
const UP_093 = fs.readFileSync(path.join(ROOT, 'database/migrations/093_tenant_email_luna_automation_shadow_outcomes.sql'), 'utf8');
const DOWN_093 = fs.readFileSync(path.join(ROOT, 'database/migrations/093_tenant_email_luna_automation_shadow_outcomes_down.sql'), 'utf8');
const UP_094 = fs.readFileSync(path.join(ROOT, 'database/migrations/094_tenant_email_luna_automation_shadow_outcome_identity_match.sql'), 'utf8');
const DOWN_094 = fs.readFileSync(path.join(ROOT, 'database/migrations/094_tenant_email_luna_automation_shadow_outcome_identity_match_down.sql'), 'utf8');
const b1 = require('./prove-email-luna-automation-issuance-material-pglite');
const {
  EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_RUNTIME_WIRED,
  EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH,
} = require('./lib/email-luna-automation-shadow-outcome-store');

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

function loadOwners() {
  const owners = b1.loadOwners();
  function wipe(rel) {
    try { delete require.cache[require.resolve(rel)]; } catch (_) { /* missing */ }
  }
  wipe('./lib/email-luna-automation-shadow-orchestration');
  wipe('./lib/email-luna-automation-shadow-outcome-store');
  wipe('./lib/email-luna-automation-shadow-worker');
  const shadow = require('./lib/email-luna-automation-shadow-orchestration');
  const outcome = require('./lib/email-luna-automation-shadow-outcome-store');
  const worker = require('./lib/email-luna-automation-shadow-worker');
  return {
    ...owners,
    createEmailLunaAutomationShadowOrchestrator: shadow.createEmailLunaAutomationShadowOrchestrator,
    createEmailLunaAutomationShadowOutcomeStore: outcome.createEmailLunaAutomationShadowOutcomeStore,
    createEmailLunaAutomationShadowWorkerKernel: worker.createEmailLunaAutomationShadowWorkerKernel,
    assertEmailLunaAutomationShadowComparisonProjection: outcome.assertEmailLunaAutomationShadowComparisonProjection,
    readEmailLunaDraftPolicyIssuanceIdentity: owners.readEmailLunaDraftPolicyIssuanceIdentity,
  };
}

function producerDeps(loaner, clientId, locationId) {
  return {
    withTransactionClient: loaner.withTransactionClient,
    env: {
      LUNA_DEPLOYMENT: 'sunset-staging',
      EMAIL_LUNA_AUTOMATION_SHADOW_ENABLED: 'true',
    },
    tenant_location_gate: {
      client_id: clientId,
      location_id: locationId,
      location_key: 'sunset-somo',
      shadow_enabled: true,
    },
  };
}

function workerDeps(loaner, clientId, locationId, ownerToken) {
  return {
    withTransactionClient: loaner.withTransactionClient,
    env: {
      LUNA_DEPLOYMENT: 'sunset-staging',
      EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_ENABLED: 'true',
    },
    tenant_location_gate: {
      client_id: clientId,
      location_id: locationId,
      location_key: 'sunset-somo',
      shadow_enabled: true,
    },
    owner_token: ownerToken,
  };
}

function catalogReady(owners, ids, inbound, fromAddress, conversation) {
  const envelope = owners.createEmailLunaDraftEnvelope({
    authority: {
      client_id: ids.client,
      location_id: ids.location,
      location_key: 'sunset-somo',
      conversation_id: conversation || ids.conversation,
      endpoint_id: ids.endpoint,
      inbound_message_id: inbound || ids.inbound,
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
    evidence: Object.freeze({
      client_id: ids.client,
      location_id: ids.location,
      conversation_id: conversation || ids.conversation,
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

async function authenticReady(owners, triplet) {
  const author = owners.createEmailLunaDraftAuthor({
    callModel: () => Promise.resolve(JSON.stringify({
      template_id: 'catalog_reply', tone: 'concise', question_key: 'none', acknowledgment_key: 'thanks',
    })),
  });
  const draft = await author.authorDraft({
    envelope: triplet.envelope, evidence: triplet.evidence, decision: triplet.decision,
  });
  const validation = owners.validateEmailLunaDraft({
    envelope: triplet.envelope, evidence: triplet.evidence, decision: triplet.decision, draft,
  });
  return { triplet, draft, validation };
}

async function persistPending(owners, loaner, ids, operationId) {
  const orch = owners.createEmailLunaAutomationShadowOrchestrator(
    producerDeps(loaner, ids.client, ids.location),
  );
  const bundle = await authenticReady(owners, catalogReady(owners, ids));
  const projected = await orch.orchestrateShadowDecision({
    operation_id: operationId,
    envelope: bundle.triplet.envelope,
    evidence: bundle.triplet.evidence,
    decision: bundle.triplet.decision,
    draft: bundle.draft,
    validation: bundle.validation,
  });
  assert.equal(projected.status, 'would_send');
  return {
    issuanceId: owners.readEmailLunaDraftPolicyIssuanceIdentity(bundle.triplet.evidence),
    projected,
  };
}

function bodyDigest(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function insertHumanApproval(db, ids, patch) {
  const approvalId = patch.approval_id;
  const operationId = patch.operation_id;
  const conversationId = patch.conversation_id || ids.conversation;
  const inboundId = patch.source_inbound_event_id || ids.inbound;
  const locationId = patch.location_id || ids.location;
  const endpointId = patch.endpoint_id || ids.endpoint;
  const locationKey = patch.location_key || 'sunset-somo';
  const state = patch.state || 'approved';
  const message = 'Thanks for asking about lessons.';
  await db.query(
    `INSERT INTO tenant_email_reply_approvals (
      approval_id, operation_id, client_id, location_id, location_key, endpoint_id,
      conversation_id, source_inbound_event_id, provider, provider_mailbox_id,
      provider_source_message_id, draft_actor_staff_user_id, approved_actor_staff_user_id,
      message_text, body_digest, state, approved_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, 'microsoft_graph', 'mailbox-1',
      'provider-source-1', $9, $9,
      $10, $11, $12, NOW()
    )`,
    [
      approvalId, operationId, ids.client, locationId, locationKey, endpointId,
      conversationId, inboundId, ids.staff, message, bodyDigest(message), state,
    ],
  );
}

function assertStaticContract() {
  assert.equal(RED.id, 'email-luna-automation-shadow-comparison.ch4b4-red.v1');
  assert.equal(RED.head_reviewed, '9c1fdba39fd7bcd640c78d9b2f8a68ef300f7713');
  assert.equal(RED.provider_transition, false);
  assert.equal(RED.send_permission, false);
  assert.equal(RED.journal_terminal, false);
  assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_RUNTIME_WIRED, false);
  assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.infer_from_absence, false);
  assert.equal(/^\s*GRANT /m.test(UP_093), false);
  console.log('ok - static B4 shadow comparison contract');
}

async function provePglite(PGlite) {
  const ids = b1.ids;
  let owners = loadOwners();
  const db = new PGlite();
  await b1.applyThrough088(db);
  await db.exec(b1.UP);
  await db.exec(UP_093);
  await db.exec(UP_094);
  await db.exec(UP_070);
  const loaner = b1.createLoaner(db);
  const outcomeStore = owners.createEmailLunaAutomationShadowOutcomeStore(loaner);
  const assertProjection = owners.assertEmailLunaAutomationShadowComparisonProjection;

  const persisted = await persistPending(owners, loaner, ids, ids.operation);
  const kernel = owners.createEmailLunaAutomationShadowWorkerKernel(
    workerDeps(loaner, ids.client, ids.location, ids.ownerA),
  );
  const first = await kernel.processNextShadowClaim();
  assert.equal(first.status, 'would_send');
  assert.equal(first.state, 'shadow_captured');
  assert.equal(first.terminal, true);
  assert.equal(first.comparison_state, 'pending_human');
  const queued = await db.query(
    'SELECT state, handoff_id, attempt_count, lease_owner FROM public.tenant_email_luna_automation_queue WHERE operation_id = $1',
    [ids.operation],
  );
  assert.equal(queued.rows[0].state, 'shadow_captured');
  assert.equal(queued.rows[0].handoff_id, null);
  assert.equal(queued.rows[0].attempt_count, 1);
  assert.equal(queued.rows[0].lease_owner, null);
  const outcomes = await db.query(
    'SELECT luna_decision, comparison_state, human_action_id, claim_lease_owner::text AS claim_lease_owner FROM public.tenant_email_luna_automation_shadow_outcomes WHERE operation_id = $1',
    [ids.operation],
  );
  assert.equal(outcomes.rows.length, 1);
  assert.equal(outcomes.rows[0].luna_decision, 'would_send');
  assert.equal(outcomes.rows[0].comparison_state, 'pending_human');
  assert.equal(outcomes.rows[0].human_action_id, null);
  assert.equal(outcomes.rows[0].claim_lease_owner, first.lease_owner);
  const journal = await db.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_outbound_send_journal');
  assert.equal(journal.rows[0].n, 0);
  console.log('ok - GREEN durable would_send/pending_human capture; queue shadow_captured; zero journal');

  const replay = await outcomeStore.captureShadowOutcome({
    operation_id: ids.operation,
    owner_token: first.lease_owner,
  });
  assert.equal(replay.status, 'replayed');
  assert.equal(replay.record.claim_lease_owner, first.lease_owner);
  const afterReplay = await db.query(
    'SELECT COUNT(*)::int AS n, MAX(attempt_count)::int AS attempts FROM public.tenant_email_luna_automation_queue WHERE operation_id = $1',
    [ids.operation],
  );
  assert.equal(afterReplay.rows[0].n, 1);
  assert.equal(afterReplay.rows[0].attempts, 1);
  const outcomeReplay = await db.query(
    'SELECT COUNT(*)::int AS n FROM public.tenant_email_luna_automation_shadow_outcomes',
  );
  assert.equal(outcomeReplay.rows[0].n, 1);
  console.log('ok - replay returns the same outcome without incrementing attempts');

  const stale = await outcomeStore.captureShadowOutcome({
    operation_id: ids.operation,
    owner_token: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  });
  assert.equal(stale.status, 'replayed');
  const staleOwner = await db.query(
    'SELECT claim_lease_owner::text AS claim_lease_owner FROM public.tenant_email_luna_automation_shadow_outcomes WHERE operation_id = $1',
    [ids.operation],
  );
  assert.equal(staleOwner.rows[0].claim_lease_owner, first.lease_owner);
  console.log('ok - stale owner cannot overwrite captured identity');

  owners = loadOwners();
  const restartKernel = owners.createEmailLunaAutomationShadowWorkerKernel(
    workerDeps(loaner, ids.client, ids.location, ids.ownerA),
  );
  const restarted = await restartKernel.processNextShadowClaim();
  assert.equal(restarted.status, 'empty');
  const still = await db.query(
    'SELECT state, attempt_count FROM public.tenant_email_luna_automation_queue WHERE operation_id = $1',
    [ids.operation],
  );
  assert.equal(still.rows[0].state, 'shadow_captured');
  assert.equal(still.rows[0].attempt_count, 1);
  console.log('ok - restart after capture does not reclaim or exhaust attempts');

  const none = await outcomeStore.projectStaffSafeShadowComparison({
    operation_id: ids.operation,
    issuance_id: persisted.issuanceId,
  });
  assert.equal(none.status, 'projected');
  assertProjection(none.record);
  assert.equal(none.record.comparison_state, 'pending_human');
  assert.equal(none.record.human_bound, false);
  console.log('ok - no-human-yet stays pending_human; absence is not disagreement');

  await insertHumanApproval(db, ids, {
    approval_id: 'a1111111-1111-4111-8111-111111111111',
    operation_id: 'b1111111-1111-4111-8111-111111111111',
  });
  const agreed = await outcomeStore.projectStaffSafeShadowComparison({
    operation_id: ids.operation,
    issuance_id: persisted.issuanceId,
  });
  assert.equal(agreed.record.comparison_state, 'staff_action_observed');
  assert.equal(agreed.record.human_bound, true);
  assert.equal(agreed.record.duplicate_human, false);
  const storedAfterLabel = await db.query(
    'SELECT comparison_state FROM public.tenant_email_luna_automation_shadow_outcomes WHERE operation_id = $1',
    [ids.operation],
  );
  assert.equal(storedAfterLabel.rows[0].comparison_state, 'pending_human');
  console.log('ok - unique 070 approved/terminal on exact inbound is staff_action_observed identity match');
  console.log('ok - 094 does not rewrite immutable stored pending_human capture');

  await insertHumanApproval(db, ids, {
    approval_id: 'a2222222-2222-4222-8222-222222222222',
    operation_id: 'b2222222-2222-4222-8222-222222222222',
  });
  const excluded = await outcomeStore.projectStaffSafeShadowComparison({
    operation_id: ids.operation,
    issuance_id: persisted.issuanceId,
  });
  assert.equal(excluded.record.comparison_state, 'excluded');
  assert.equal(excluded.record.duplicate_human, true);
  console.log('ok - duplicate human actions are excluded');

  const reboundOp = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9';
  owners = loadOwners();
  const reboundPersisted = await persistPending(owners, loaner, ids, reboundOp);
  const reboundKernel = owners.createEmailLunaAutomationShadowWorkerKernel(
    workerDeps(loaner, ids.client, ids.location, ids.ownerA),
  );
  const reboundCaptured = await reboundKernel.processNextShadowClaim();
  assert.equal(reboundCaptured.status, 'would_send');
  await db.query('DELETE FROM tenant_email_reply_approvals');
  await insertHumanApproval(db, ids, {
    approval_id: 'a3333333-3333-4333-8333-333333333333',
    operation_id: 'b3333333-3333-4333-8333-333333333333',
    conversation_id: ids.conversationB,
    source_inbound_event_id: ids.inbound,
  });
  const rebound = await outcomeStore.projectStaffSafeShadowComparison({
    operation_id: reboundOp,
    issuance_id: reboundPersisted.issuanceId,
  });
  assert.equal(rebound.record.comparison_state, 'invalid');
  assert.equal(rebound.record.human_bound, false);
  console.log('ok - human-thread rebind is invalid, not staff_action_observed');

  await db.query('DELETE FROM tenant_email_reply_approvals');
  await insertHumanApproval(db, ids, {
    approval_id: 'a4444444-4444-4444-8444-444444444444',
    operation_id: 'b4444444-4444-4444-8444-444444444444',
    source_inbound_event_id: ids.inboundB,
    conversation_id: ids.conversationB,
    location_id: ids.locationB,
    endpoint_id: ids.endpointB,
    location_key: 'sunset-sardinero',
  });
  const otherInbound = await outcomeStore.projectStaffSafeShadowComparison({
    operation_id: reboundOp,
    issuance_id: reboundPersisted.issuanceId,
  });
  assert.equal(otherInbound.record.comparison_state, 'pending_human');
  console.log('ok - different inbound/recipient is not a match');

  try {
    await db.query('UPDATE public.tenant_email_luna_automation_shadow_outcomes SET comparison_state = $1', ['agreement']);
    assert.fail('append-only update should refuse');
  } catch (error) {
    assert.match(String(error.message), /append-only mutation refused/);
    try { await db.query('ROLLBACK'); } catch (_) { /* pglite may already idle */ }
  }

  const concurrentOp = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5';
  owners = loadOwners();
  await persistPending(owners, loaner, ids, concurrentOp);
  const leftKernel = owners.createEmailLunaAutomationShadowWorkerKernel(
    workerDeps(loaner, ids.client, ids.location, ids.ownerA),
  );
  const rightKernel = owners.createEmailLunaAutomationShadowWorkerKernel(
    workerDeps(loaner, ids.client, ids.location, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
  );
  const [left, right] = await Promise.all([
    leftKernel.processNextShadowClaim(),
    rightKernel.processNextShadowClaim(),
  ]);
  const statuses = [left.status, right.status].sort();
  assert.equal(statuses.includes('would_send'), true);
  assert.equal(statuses.includes('empty'), true);
  const concurrentOutcomes = await db.query(
    'SELECT COUNT(*)::int AS n FROM public.tenant_email_luna_automation_shadow_outcomes WHERE operation_id = $1',
    [concurrentOp],
  );
  assert.equal(concurrentOutcomes.rows[0].n, 1);
  const concurrentJournal = await db.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_outbound_send_journal');
  assert.equal(concurrentJournal.rows[0].n, 0);
  console.log('ok - concurrent workers persist one outcome; zero journal rows');

  try {
    await db.exec(DOWN_093);
    assert.fail('nonempty 093 down should refuse');
  } catch (error) {
    assert.match(String(error.message), /093_down_refused/);
    try { await db.query('ROLLBACK'); } catch (_) { /* already idle */ }
  }
  console.log('ok - nonempty 093 down refuses comparison-evidence loss');
}

async function proveEmptyDown(PGlite) {
  const db = new PGlite();
  await b1.applyThrough088(db);
  await db.exec(b1.UP);
  await db.exec(UP_093);
  await db.exec(DOWN_093);
  await db.exec(DOWN_093);
  const gone = await db.query(`
    SELECT COUNT(*)::int AS n
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'tenant_email_luna_automation_shadow_outcomes'
  `);
  assert.equal(gone.rows[0].n, 0);
  const states = await db.query(`
    SELECT pg_catalog.pg_get_constraintdef(oid) AS def
      FROM pg_catalog.pg_constraint
     WHERE conname = 'tenant_email_luna_automation_queue_state_values'
  `);
  assert.match(states.rows[0].def, /pending.*claimed.*handed_off.*handoff_required.*cancelled/);
  assert.equal(/shadow_captured/.test(states.rows[0].def), false);
  console.log('ok - empty 093 down is repeatable and restores 086 queue states');
}

function runPgliteProof() {
  assertStaticContract();
  const PGlite = tryLoadPglite();
  if (!PGlite) {
    console.log('ok - pglite unavailable; static B4 shadow comparison contract only');
    return Promise.resolve();
  }
  return Promise.resolve()
    .then(() => provePglite(PGlite))
    .then(() => proveEmptyDown(PGlite))
    .then(() => {
      console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B4 shadow comparison pglite');
    });
}

if (require.main === module) {
  runPgliteProof().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  UP_093,
  DOWN_093,
  UP_094,
  DOWN_094,
  loadOwners,
  persistPending,
  producerDeps,
  workerDeps,
  insertHumanApproval,
  runPgliteProof,
  assertStaticContract,
};

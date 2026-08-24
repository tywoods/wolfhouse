'use strict';

/**
 * Prove Ch4 Slice B3 provider-inert shadow worker against 085/086/087/088/092.
 * No new migration. No GRANT. No provider. No journal terminal.
 *
 * PGlite (when available):
 *   Producer shadow persist stays pending. Worker claims, loads, recovers,
 *   projects would-send, queue stays claimed, journal count stays 0.
 *   Concurrent claim has one winner. Lease expiry reclaim replays.
 *   Stop during claim does not journal. Partial load failure require_handoff.
 *   Restart after WeakSet wipe recovers branded material.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RED = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'fixtures/email-luna-automation-shadow-worker-red.json'),
  'utf8',
));
const b1 = require('./prove-email-luna-automation-issuance-material-pglite');
const {
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_RUNTIME_WIRED,
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_CONCURRENCY,
} = require('./lib/email-luna-automation-shadow-worker');

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
  wipe('./lib/email-luna-automation-shadow-worker');
  const shadow = require('./lib/email-luna-automation-shadow-orchestration');
  const worker = require('./lib/email-luna-automation-shadow-worker');
  return {
    ...owners,
    createEmailLunaAutomationShadowOrchestrator: shadow.createEmailLunaAutomationShadowOrchestrator,
    createEmailLunaAutomationShadowWorkerKernel: worker.createEmailLunaAutomationShadowWorkerKernel,
    createEmailLunaAutomationShadowWorkerLoop: worker.createEmailLunaAutomationShadowWorkerLoop,
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
  assert.equal(projected.state === 'pending' || projected.state === 'replayed', true);
  return {
    issuanceId: owners.readEmailLunaDraftPolicyIssuanceIdentity(bundle.triplet.evidence),
    projected,
  };
}

function assertStaticContract() {
  assert.equal(RED.id, 'email-luna-automation-shadow-worker.ch4b3-red.v1');
  assert.equal(RED.head_reviewed, 'd1b2d55985a4801fe2e3986c0a51cf672b96330c');
  assert.equal(RED.provider_transition, false);
  assert.equal(RED.worker_loop, true);
  assert.equal(RED.send_permission, false);
  assert.equal(RED.journal_terminal, false);
  assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_RUNTIME_WIRED, false);
  assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_CONCURRENCY, 1);
  assert.equal(/^\s*GRANT /m.test(b1.UP), false);
  console.log('ok - static B3 shadow worker contract (no new migration, 092 remains send-inert)');
}

async function expireLease(db, operationId) {
  await db.query('DROP TRIGGER IF EXISTS tenant_email_luna_automation_queue_protect ON tenant_email_luna_automation_queue');
  await db.query(
    `UPDATE tenant_email_luna_automation_queue SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE operation_id = $1`,
    [operationId],
  );
  await db.exec(`
    CREATE TRIGGER tenant_email_luna_automation_queue_protect
      BEFORE UPDATE ON tenant_email_luna_automation_queue
      FOR EACH ROW EXECUTE FUNCTION tenant_email_luna_automation_queue_protect();
  `);
}

async function provePglite(PGlite) {
  const ids = b1.ids;
  let owners = loadOwners();
  const db = new PGlite();
  await b1.applyThrough088(db);
  await db.exec(b1.UP);
  const loaner = b1.createLoaner(db);

  const persisted = await persistPending(owners, loaner, ids, ids.operation);
  const pending = await db.query(
    'SELECT state, handoff_id, attempt_count FROM public.tenant_email_luna_automation_queue WHERE operation_id = $1',
    [ids.operation],
  );
  assert.equal(pending.rows.length, 1);
  assert.equal(pending.rows[0].state, 'pending');
  assert.equal(pending.rows[0].handoff_id, null);

  const kernel = owners.createEmailLunaAutomationShadowWorkerKernel(
    workerDeps(loaner, ids.client, ids.location, ids.ownerA),
  );
  assert.deepEqual(Object.keys(kernel).sort(), ['processNextShadowClaim', 'requestStop', 'resume']);
  const first = await kernel.processNextShadowClaim();
  assert.equal(first.status, 'would_send');
  assert.equal(first.state, 'claimed');
  assert.equal(first.terminal, false);
  assert.equal(first.send_allowed, false);
  assert.equal(first.auto_send_allowed, false);
  assert.equal(first.provider_invoked, false);
  assert.equal(first.journal_handoff, false);
  assert.equal(first.issuance_id, persisted.issuanceId);
  assert.match(first.lease_owner, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(first.lease_owner, ids.ownerA);
  assert.equal(first.attempt_count, 1);
  const queued = await db.query(
    'SELECT state, handoff_id, attempt_count, lease_owner::text AS lease_owner FROM public.tenant_email_luna_automation_queue WHERE operation_id = $1',
    [ids.operation],
  );
  assert.equal(queued.rows[0].state, 'claimed');
  assert.equal(queued.rows[0].handoff_id, null);
  assert.equal(queued.rows[0].attempt_count, 1);
  const journal = await db.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_outbound_send_journal');
  assert.equal(journal.rows[0].n, 0);
  console.log('ok - GREEN claim/load/recover would-send stays claimed; zero journal rows');

  const other = owners.createEmailLunaAutomationShadowWorkerKernel(
    workerDeps(loaner, ids.client, ids.location, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
  );
  const [left, right] = await Promise.all([
    kernel.processNextShadowClaim(),
    other.processNextShadowClaim(),
  ]);
  assert.equal(left.status, 'empty');
  assert.equal(right.status, 'empty');
  const still = await db.query(
    'SELECT COUNT(*)::int AS n FROM public.tenant_email_luna_automation_queue WHERE state = $1',
    ['claimed'],
  );
  assert.equal(still.rows[0].n, 1);
  console.log('ok - concurrent live claim has no second winner');

  await expireLease(db, ids.operation);
  const staleHandoff = owners.createEmailLunaAutomationQueueStore(loaner);
  const stale = await staleHandoff.handOffAutomationOperation({
    operation_id: ids.operation,
    owner_token: first.lease_owner,
  });
  assert.equal(stale.status, 'conflict');
  const journalStale = await db.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_outbound_send_journal');
  assert.equal(journalStale.rows[0].n, 0);

  let sameOwnerSqlState = null;
  try {
    await db.query(
      'SELECT operation_id FROM public.tenant_email_luna_automation_claim($1::uuid, $2::uuid)',
      [first.lease_owner, ids.operation],
    );
  } catch (error) {
    sameOwnerSqlState = error && error.code;
  }
  assert.equal(sameOwnerSqlState, '23514');
  const stillExpired = await db.query(
    'SELECT state, attempt_count, lease_owner::text AS lease_owner FROM public.tenant_email_luna_automation_queue WHERE operation_id = $1',
    [ids.operation],
  );
  assert.equal(stillExpired.rows[0].state, 'claimed');
  assert.equal(stillExpired.rows[0].attempt_count, 1);
  assert.equal(stillExpired.rows[0].lease_owner, first.lease_owner);

  owners = loadOwners();
  const sameOwnerRestart = owners.createEmailLunaAutomationShadowWorkerKernel(
    workerDeps(loaner, ids.client, ids.location, ids.ownerA),
  );
  const sameOwnerReplayed = await sameOwnerRestart.processNextShadowClaim();
  assert.equal(sameOwnerReplayed.status, 'would_send');
  assert.equal(sameOwnerReplayed.terminal, false);
  assert.notEqual(sameOwnerReplayed.lease_owner, first.lease_owner);
  assert.notEqual(sameOwnerReplayed.lease_owner, ids.ownerA);
  assert.equal(sameOwnerReplayed.attempt_count, 2);
  assert.equal(sameOwnerReplayed.issuance_id, persisted.issuanceId);
  assert.equal(sameOwnerReplayed.journal_handoff, false);

  await expireLease(db, ids.operation);
  owners = loadOwners();
  const restarted = owners.createEmailLunaAutomationShadowWorkerKernel(
    workerDeps(loaner, ids.client, ids.location, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
  );
  const replayed = await restarted.processNextShadowClaim();
  assert.equal(replayed.status, 'would_send');
  assert.equal(replayed.terminal, false);
  assert.notEqual(replayed.lease_owner, sameOwnerReplayed.lease_owner);
  assert.notEqual(replayed.lease_owner, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
  assert.equal(replayed.attempt_count, 3);
  assert.equal(replayed.issuance_id, persisted.issuanceId);
  assert.equal(replayed.journal_handoff, false);
  const afterReplay = await db.query(
    'SELECT state, handoff_id FROM public.tenant_email_luna_automation_queue WHERE operation_id = $1',
    [ids.operation],
  );
  assert.equal(afterReplay.rows[0].state, 'claimed');
  assert.equal(afterReplay.rows[0].handoff_id, null);
  const journalReplay = await db.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_outbound_send_journal');
  assert.equal(journalReplay.rows[0].n, 0);
  console.log('ok - same-owner restart after expiry reclaims; 086 still refuses same-token 23514; other-owner expiry also replays');

  const stopOp = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8';
  owners = loadOwners();
  await persistPending(owners, loaner, ids, stopOp);
  let claimStarted = false;
  const holder = { kernel: null };
  const stoppingLoaner = {
    async withTransactionClient(work) {
      return loaner.withTransactionClient(async (client) => {
        return work({
          async query(text, params) {
            if (/tenant_email_luna_automation_claim/.test(String(text))) {
              if (holder.kernel) holder.kernel.requestStop();
              claimStarted = true;
            }
            return client.query(text, params);
          },
        });
      });
    },
  };
  const stopKernel = owners.createEmailLunaAutomationShadowWorkerKernel(
    workerDeps(stoppingLoaner, ids.client, ids.location, ids.ownerA),
  );
  holder.kernel = stopKernel;
  const stopped = await stopKernel.processNextShadowClaim();
  assert.equal(claimStarted, true);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.terminal, false);
  const stopJournal = await db.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_outbound_send_journal');
  assert.equal(stopJournal.rows[0].n, 0);
  const stopQueue = await db.query(
    'SELECT state, handoff_id FROM public.tenant_email_luna_automation_queue WHERE operation_id = $1',
    [stopOp],
  );
  assert.equal(stopQueue.rows[0].state, 'claimed');
  assert.equal(stopQueue.rows[0].handoff_id, null);
  console.log('ok - stop during claim leaves claimed/nonterminal with zero journal rows');

  const missingOp = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7';
  owners = loadOwners();
  await persistPending(owners, loaner, ids, missingOp);
  const partialLoaner = {
    async withTransactionClient(work) {
      return loaner.withTransactionClient(async (client) => {
        const wrapped = {
          async query(text, params) {
            if (/issuance_material_load/.test(String(text))) return { rows: [] };
            return client.query(text, params);
          },
        };
        return work(wrapped);
      });
    },
  };
  const partialKernel = owners.createEmailLunaAutomationShadowWorkerKernel(
    workerDeps(partialLoaner, ids.client, ids.location, ids.ownerA),
  );
  const partial = await partialKernel.processNextShadowClaim();
  assert.equal(partial.status, 'would_not_send');
  assert.equal(partial.reason, 'material_missing');
  assert.equal(partial.state, 'handoff_required');
  assert.equal(partial.terminal, true);
  const partialQueue = await db.query(
    'SELECT state, handoff_id FROM public.tenant_email_luna_automation_queue WHERE operation_id = $1',
    [missingOp],
  );
  assert.equal(partialQueue.rows[0].state, 'handoff_required');
  assert.equal(partialQueue.rows[0].handoff_id, null);
  const partialJournal = await db.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_outbound_send_journal');
  assert.equal(partialJournal.rows[0].n, 0);
  console.log('ok - partial load failure require_handoff_claimed; still no journal');

  const throwOp = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6';
  owners = loadOwners();
  await persistPending(owners, loaner, ids, throwOp);
  const throwingLoaner = {
    async withTransactionClient(work) {
      return loaner.withTransactionClient(async (client) => {
        return work({
          async query(text, params) {
            if (/issuance_material_load/.test(String(text))) {
              const error = new Error('simulated infrastructure load failure');
              error.code = '08000';
              throw error;
            }
            return client.query(text, params);
          },
        });
      });
    },
  };
  const throwKernel = owners.createEmailLunaAutomationShadowWorkerKernel(
    workerDeps(throwingLoaner, ids.client, ids.location, ids.ownerA),
  );
  const thrown = await throwKernel.processNextShadowClaim();
  assert.equal(thrown.status, 'conflict');
  assert.equal(thrown.reason, 'retryable_load');
  assert.equal(thrown.terminal, false);
  assert.equal(thrown.state, 'claimed');
  const throwQueue = await db.query(
    'SELECT state, handoff_id FROM public.tenant_email_luna_automation_queue WHERE operation_id = $1',
    [throwOp],
  );
  assert.equal(throwQueue.rows[0].state, 'claimed');
  assert.equal(throwQueue.rows[0].handoff_id, null);
  const throwJournal = await db.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_outbound_send_journal');
  assert.equal(throwJournal.rows[0].n, 0);
  console.log('ok - load/query throw keeps claimed retryable lease; no require_handoff or journal');

  const callbackKernelAttempt = () => owners.createEmailLunaAutomationShadowWorkerKernel({
    ...workerDeps(loaner, ids.client, ids.location, ids.ownerA),
    callback: () => { throw new Error('injected'); },
  });
  assert.throws(callbackKernelAttempt);
  const keyKernelAttempt = () => owners.createEmailLunaAutomationShadowWorkerKernel({
    ...workerDeps(loaner, ids.client, ids.location, ids.ownerA),
    authorize_dispatch: true,
  });
  assert.throws(keyKernelAttempt);
  const finalJournal = await db.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_outbound_send_journal');
  assert.equal(finalJournal.rows[0].n, 0);
  const handed = await db.query(
    "SELECT COUNT(*)::int AS n FROM public.tenant_email_luna_automation_queue WHERE state = 'handed_off'",
  );
  assert.equal(handed.rows[0].n, 0);
  console.log('ok - callback/key injection refused; durable journal and handed_off remain zero');
}

function runPgliteProof() {
  assertStaticContract();
  const PGlite = tryLoadPglite();
  if (!PGlite) {
    console.log('ok - pglite unavailable; static B3 shadow worker contract only');
    return Promise.resolve();
  }
  return provePglite(PGlite).then(() => {
    console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B3 shadow worker pglite');
  });
}

if (require.main === module) {
  runPgliteProof().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { runPgliteProof };

'use strict';

/**
 * Prove Ch4 Slice B2 shadow-only orchestration against 085/086/088/092.
 * No new migration. No GRANT. No worker loop. No provider.
 *
 * PGlite (when available):
 *   would-send persists audit + producer persist_and_enqueue, queue stays pending.
 *   Restart recover + second orchestrate replays one queue row.
 *   Handoff/forged stay would-not-send without a queue row.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RED = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'fixtures/email-luna-automation-shadow-orchestration-red.json'),
  'utf8',
));
const b1 = require('./prove-email-luna-automation-issuance-material-pglite');
const {
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_WIRED,
} = require('./lib/email-luna-automation-shadow-orchestration');

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

function loadShadowOwners() {
  const owners = b1.loadOwners();
  function wipe(rel) {
    try { delete require.cache[require.resolve(rel)]; } catch (_) { /* missing */ }
  }
  wipe('./lib/email-luna-automation-shadow-orchestration');
  const shadow = require('./lib/email-luna-automation-shadow-orchestration');
  return {
    ...owners,
    createEmailLunaAutomationShadowOrchestrator: shadow.createEmailLunaAutomationShadowOrchestrator,
    readEmailLunaDraftPolicyIssuanceIdentity: owners.readEmailLunaDraftPolicyIssuanceIdentity,
  };
}

function enabledDeps(loaner, clientId, locationId) {
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

function catalogReady(owners, ids) {
  const envelope = owners.createEmailLunaDraftEnvelope({
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
  const issued = owners.issueAndDecideEmailLunaDraftPolicy({
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

function assertStaticContract() {
  assert.equal(RED.id, 'email-luna-automation-shadow-orchestration.ch4b2-red.v1');
  assert.equal(RED.head_reviewed, '566c2d6915718b5e04110284075e3f9a37ff65ce');
  assert.equal(RED.provider_transition, false);
  assert.equal(RED.worker_loop, false);
  assert.equal(RED.send_permission, false);
  assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_WIRED, false);
  assert.equal(/^\s*GRANT /m.test(b1.UP), false);
  console.log('ok - static B2 shadow contract (no new migration, 092 remains send-inert)');
}

async function provePglite(PGlite) {
  const ids = b1.ids;
  let owners = loadShadowOwners();
  const db = new PGlite();
  await b1.applyThrough088(db);
  await db.exec(b1.UP);
  const loaner = b1.createLoaner(db);
  const orch = owners.createEmailLunaAutomationShadowOrchestrator(
    enabledDeps(loaner, ids.client, ids.location),
  );
  assert.deepEqual(Object.keys(orch), ['orchestrateShadowDecision']);

  const bundle = await authenticReady(owners, catalogReady(owners, ids));
  const issuanceId = owners.readEmailLunaDraftPolicyIssuanceIdentity(bundle.triplet.evidence);
  const first = await orch.orchestrateShadowDecision({
    operation_id: ids.operation,
    envelope: bundle.triplet.envelope,
    evidence: bundle.triplet.evidence,
    decision: bundle.triplet.decision,
    draft: bundle.draft,
    validation: bundle.validation,
  });
  assert.equal(first.status, 'would_send');
  assert.equal(first.state, 'pending');
  assert.equal(first.send_allowed, false);
  assert.equal(first.auto_send_allowed, false);
  assert.equal(first.provider_invoked, false);
  assert.equal(first.mode, 'shadow');
  assert.equal(first.issuance_id, issuanceId);
  const queued = await db.query('SELECT state, handoff_id, attempt_count FROM public.tenant_email_luna_automation_queue WHERE operation_id = $1', [ids.operation]);
  assert.equal(queued.rows.length, 1);
  assert.equal(queued.rows[0].state, 'pending');
  assert.equal(queued.rows[0].handoff_id, null);
  const journal = await db.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_outbound_send_journal');
  assert.equal(journal.rows[0].n, 0);
  console.log('ok - GREEN would-send persists pending queue identity and no journal/provider row');

  owners = loadShadowOwners();
  const recoveredStore = owners.createEmailLunaAutomationIssuanceMaterialStore(loaner);
  const loaded = await recoveredStore.loadAutomationIssuanceMaterial({
    operation_id: ids.operation,
    issuance_id: issuanceId,
  });
  assert.equal(loaded.status, 'loaded');
  const recovered = recoveredStore.recoverAutomationIssuance({ material: loaded.record });
  assert.equal(recovered.status, 'recovered');
  const orch2 = owners.createEmailLunaAutomationShadowOrchestrator(
    enabledDeps(loaner, ids.client, ids.location),
  );
  const replay = await orch2.orchestrateShadowDecision({
    operation_id: ids.operation,
    envelope: recovered.record.envelope,
    evidence: recovered.record.evidence,
    decision: recovered.record.decision,
    draft: recovered.record.draft,
    validation: recovered.record.validation,
  });
  assert.equal(replay.status, 'would_send');
  assert.equal(replay.state, 'replayed');
  assert.equal(replay.issuance_id, issuanceId);
  assert.equal(replay.send_allowed, false);
  const count = await db.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_luna_automation_queue');
  assert.equal(count.rows[0].n, 1);
  const materialCount = await db.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_luna_automation_issuance_material');
  assert.equal(materialCount.rows[0].n, 1);
  console.log('ok - restart recover + shadow orchestrate replays one queue row, still send-inert');

  owners = loadShadowOwners();
  const handoffOwners = owners;
  const envelope = handoffOwners.createEmailLunaDraftEnvelope({
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
  const issued = handoffOwners.issueAndDecideEmailLunaDraftPolicy({
    envelope,
    evidence: Object.freeze({
      client_id: ids.client,
      location_id: ids.location,
      conversation_id: ids.conversation,
      endpoint_id: ids.endpoint,
      language: 'en',
      identity: 'ambiguous',
      intent: 'catalog_question',
      intent_support: 'supported',
      requested_location_id: ids.location,
      explicit_human_request: false,
      attachment_interpretation_required: false,
      unsafe_transactional_request: false,
      required_facts: ['catalog'],
      grounded_results: Object.freeze({
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
      }),
    }),
  });
  const orch3 = handoffOwners.createEmailLunaAutomationShadowOrchestrator(
    enabledDeps(loaner, ids.client, ids.location),
  );
  const handoff = await orch3.orchestrateShadowDecision({
    operation_id: ids.operation2,
    envelope,
    evidence: issued.evidence,
    decision: issued.decision,
  });
  assert.equal(handoff.status, 'would_not_send');
  assert.equal(handoff.reason, 'ambiguous_identity');
  const queueAfter = await db.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_luna_automation_queue WHERE operation_id = $1', [ids.operation2]);
  assert.equal(queueAfter.rows[0].n, 0);
  const journalAfter = await db.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_outbound_send_journal');
  assert.equal(journalAfter.rows[0].n, 0);
  console.log('ok - authentic handoff is would-not-send with no queue/journal row');

  const forged = await orch3.orchestrateShadowDecision({
    operation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9',
    envelope,
    evidence: JSON.parse(JSON.stringify(issued.evidence)),
    decision: JSON.parse(JSON.stringify(issued.decision)),
  });
  assert.equal(forged.status, 'would_not_send');
  assert.equal(forged.reason, 'unissued_evidence');
  console.log('ok - forged JSON issuance is would-not-send on durable path');
}

function runPgliteProof() {
  assertStaticContract();
  const PGlite = tryLoadPglite();
  if (!PGlite) {
    console.log('ok - pglite unavailable; static B2 shadow contract only');
    return Promise.resolve();
  }
  return provePglite(PGlite).then(() => {
    console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B2 shadow orchestration pglite');
  });
}

if (require.main === module) {
  runPgliteProof().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { runPgliteProof };

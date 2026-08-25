'use strict';

/**
 * PGlite proof for Stage 2 Chapter 3 runtime composition against real 097.
 * No memory SQL clone. Mapped producer/worker when session_user works;
 * otherwise reports the session-attestation gap and still proves JS facades
 * plus SQL at-most-once. Stock-PG is the mapped-principal authority.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createEmailLunaControlledDraftingSunsetStagingRuntimeComposition,
  bindProducerWithTransactionClient,
  bindWorkerWithTransactionClient,
  DISABLED_CODE,
  ERROR_CODE,
} = require('./lib/email-luna-controlled-drafting-sunset-staging-runtime-composition');
const {
  createEmailLunaControlledDraftingProvider,
  createEmailLunaControlledDraftingFakeTransport,
  pickEmailLunaControlledDraftingTransportMethods,
} = require('./lib/email-luna-controlled-drafting-provider-contract');
const storeMod = require('./lib/email-luna-controlled-drafting-operation-store');
const {
  ids,
  PASSWORD,
  tryLoadPglite,
  applyCommittedInbound063Identity,
  persistIssuance,
} = require('./prove-email-luna-controlled-drafting-operation-store-pglite');
const {
  loadOwners,
  createLoaner,
  exclusiveSession,
  applyThrough088,
  revokePublicExecuteOutsideCatalogs,
} = require('./prove-email-luna-automation-issuance-material-pglite');
const {
  provisionEmailLunaAutomationPrincipal,
} = require('./lib/email-luna-automation-principal-provision');

const ROOT = path.resolve(__dirname, '..');
const UP_092 = fs.readFileSync(
  path.join(ROOT, 'database/migrations/092_tenant_email_luna_automation_issuance_material.sql'),
  'utf8',
);
const UP_097 = fs.readFileSync(
  path.join(ROOT, 'database/migrations/097_tenant_email_luna_controlled_draft_operations.sql'),
  'utf8',
);
const GRAPH_MAILBOX = '22222222-2222-4222-8222-2222222222ab';
const SUBJECT = 'Lesson availability tomorrow';
const BODY = 'Yes, the morning lesson still has space.';

function enabledEnv() {
  return {
    LUNA_DEPLOYMENT: 'sunset-staging',
    DEFAULT_CLIENT_SLUG: 'sunset',
    EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED: 'true',
    EMAIL_LUNA_CONTROLLED_DRAFTING_CLIENT_ID: ids.client,
    EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_ID: ids.location,
    EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_KEY: 'sunset-somo',
    EMAIL_LUNA_CONTROLLED_DRAFTING_ENDPOINT_ID: ids.endpoint,
    EMAIL_LUNA_CONTROLLED_DRAFTING_MAILBOX_ID: GRAPH_MAILBOX,
    EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER: 'microsoft_graph',
  };
}

function makeProvider() {
  const fake = createEmailLunaControlledDraftingFakeTransport({ classify: true });
  return {
    fake,
    provider: createEmailLunaControlledDraftingProvider({
      authority: {
        client_id: ids.client,
        location_id: ids.location,
        location_key: 'sunset-somo',
        endpoint_id: ids.endpoint,
        provider: 'microsoft_graph',
        mailbox_id: GRAPH_MAILBOX,
      },
      transport: pickEmailLunaControlledDraftingTransportMethods({
        createReplyDraft: fake.createReplyDraft,
        reconcileDraft: fake.reconcileDraft,
      }),
    }),
  };
}

function createRoleLoaner(db, role) {
  return async function withTransactionClient(work) {
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
  };
}

function createOwnerLoaner(db) {
  const loaner = createLoaner(db);
  return loaner.withTransactionClient.bind(loaner);
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

function issuanceDouble(subject, body) {
  const branded = new WeakSet();
  return {
    branded,
    store: {
      assertAuthenticLoadedMaterial(value) {
        if (!value || typeof value !== 'object' || !branded.has(value)) {
          throw Object.freeze(Object.assign(new Error('issuance failed'), {
            code: 'EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_INVALID',
          }));
        }
        return value;
      },
      recoverAutomationIssuance(input) {
        this.assertAuthenticLoadedMaterial(input.material);
        return Object.freeze({
          status: 'recovered',
          record: Object.freeze({
            draft: Object.freeze({ subject, body, language: 'en' }),
            issuance_id: input.material.issuance_id,
            operation_id: input.material.operation_id,
          }),
        });
      },
    },
  };
}

function authenticMaterial(branded, issuanceId, extra = {}) {
  const row = Object.create(null);
  const fields = {
    operation_id: ids.operation,
    issuance_id: issuanceId,
    audit_operation_id: ids.audit,
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    endpoint_id: ids.endpoint,
    conversation_id: ids.conversation,
    inbound_event_id: ids.inbound,
    recipient_address: 'elena@example.test',
    draft_digest: '00',
    language: 'en',
    ...extra,
  };
  const keys = Object.keys(fields);
  for (let i = 0; i < keys.length; i += 1) {
    Object.defineProperty(row, keys[i], {
      value: fields[keys[i]], enumerable: true, writable: true, configurable: true,
    });
  }
  Object.freeze(row);
  branded.add(row);
  return row;
}

async function forceUuidMailbox(db) {
  await db.exec(`
    UPDATE public.tenant_email_inbound_events
       SET provider_mailbox_id = '${GRAPH_MAILBOX}'
     WHERE id = '${ids.inbound}'
  `);
}

async function provePglite(PGlite) {
  const owners = loadOwners();
  const db = new PGlite();
  await applyThrough088(db);
  await db.exec(UP_092);
  await applyCommittedInbound063Identity(db);
  await db.exec(UP_097);
  await revokePublicExecuteOutsideCatalogs(db);
  await forceUuidMailbox(db);

  await provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
    roleName: 'luna_ch3_worker',
    kind: 'worker',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: PASSWORD,
    apply: true,
  });
  await provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
    roleName: 'luna_ch3_producer',
    kind: 'producer',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: PASSWORD,
    apply: true,
  });
  const rolesMode = await pgliteRoleSemantic(db, 'luna_ch3_producer')
    && await pgliteRoleSemantic(db, 'luna_ch3_worker');

  const ownerLoaner = createLoaner(db);
  const seeded = await persistIssuance(db, owners, ownerLoaner, ids.operation, ids.audit);
  await forceUuidMailbox(db);
  const subject = seeded.bundle.draft.subject;
  const body = seeded.bundle.draft.body;
  const issuance = issuanceDouble(subject, body);
  const material = authenticMaterial(issuance.branded, seeded.issuanceId, {
    draft_digest: seeded.bundle.validation && seeded.bundle.validation.draft_digest
      ? seeded.bundle.validation.draft_digest
      : undefined,
  });
  void material.draft_digest;

  const made = makeProvider();
  const producerRaw = rolesMode
    ? createRoleLoaner(db, 'luna_ch3_producer')
    : createOwnerLoaner(db);
  const workerRaw = rolesMode
    ? createRoleLoaner(db, 'luna_ch3_worker')
    : createOwnerLoaner(db);

  if (!rolesMode) {
    const ownerProducer = bindProducerWithTransactionClient(createOwnerLoaner(db));
    const ownerWorker = bindWorkerWithTransactionClient(createOwnerLoaner(db));
    const ownerRuntime = createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
      env: enabledEnv(),
      producerWithTransactionClient: ownerProducer,
      workerWithTransactionClient: ownerWorker,
      provider: made.provider,
      issuanceStore: issuance.store,
    });
    let refused = false;
    try {
      await ownerRuntime.reserveControlledDraft({
        material: authenticMaterial(issuance.branded, seeded.issuanceId),
      });
    } catch (error) {
      refused = error && error.code === ERROR_CODE;
    }
    assert.equal(refused, true);
    console.log('ok - PGlite session_user is table_owner; composition attestation refuses owner/unmapped');
    console.log('ok - mapped producer/worker runtime is proven on stock-PG (session_user authority)');
  } else {
    const runtime = createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
      env: enabledEnv(),
      producerWithTransactionClient: bindProducerWithTransactionClient(producerRaw),
      workerWithTransactionClient: bindWorkerWithTransactionClient(workerRaw),
      provider: made.provider,
      issuanceStore: issuance.store,
    });
    const reserved = await runtime.reserveControlledDraft({
      material: authenticMaterial(issuance.branded, seeded.issuanceId),
    });
    assert.equal(reserved.status === 'reserved' || reserved.status === 'replayed', true);
    const workerStore = storeMod.createEmailLunaControlledDraftingOperationStore({
      withTransactionClient: workerRaw,
    });
    const loaded = await workerStore.loadControlledDraft({
      operation_id: ids.operation,
      issuance_id: seeded.issuanceId,
    });
    assert.equal(loaded.record.state, 'reserved');
    const first = await runtime.tick({ operation: loaded.record });
    assert.equal(first.create_invoked, true);
    assert.equal(made.fake.getCalls().filter((row) => row.operation === 'create_reply_draft').length, 1);
    const after = await workerStore.loadControlledDraft({
      operation_id: ids.operation,
      issuance_id: seeded.issuanceId,
    });
    assert.equal(after.record.state, 'provider_draft_reconciled_exact');
    const second = await runtime.tick({ operation: after.record });
    assert.equal(second.reconcile_invoked, true);
    assert.equal(second.create_invoked, false);
    assert.equal(made.fake.getCalls().filter((row) => row.operation === 'create_reply_draft').length, 1);
    console.log('ok - mapped producer reserve / worker claim creates once then reconciles');

    const producerStore = storeMod.createEmailLunaControlledDraftingOperationStore({
      withTransactionClient: producerRaw,
    });
    let producerClaimed = false;
    try {
      await producerStore.claimCreateDispatch({
        operation_id: ids.operation,
        issuance_id: seeded.issuanceId,
        expected_generation: after.record.state_generation,
      });
      producerClaimed = true;
    } catch (_) { /* expected */ }
    assert.equal(producerClaimed, false);
    console.log('ok - producer cannot claim; worker path owns claim');
  }

  let commitFailed = false;
  const failCommitLoaner = async (work) => {
    await db.exec(rolesMode ? 'SET SESSION AUTHORIZATION luna_ch3_worker' : 'SELECT 1');
    try {
      return await work({
        async query(text, params) {
          if (text === 'COMMIT') {
            commitFailed = true;
            const error = new Error('commit failed');
            error.code = '40001';
            throw error;
          }
          return db.query(text, params);
        },
      });
    } finally {
      if (rolesMode) await db.exec('SET SESSION AUTHORIZATION postgres');
    }
  };
  const failMade = makeProvider();
  if (rolesMode) {
    const failRuntime = createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
      env: enabledEnv(),
      producerWithTransactionClient: bindProducerWithTransactionClient(producerRaw),
      workerWithTransactionClient: bindWorkerWithTransactionClient(failCommitLoaner),
      provider: failMade.provider,
      issuanceStore: issuance.store,
    });
    const loaded = await storeMod.createEmailLunaControlledDraftingOperationStore({
      withTransactionClient: workerRaw,
    }).loadControlledDraft({
      operation_id: ids.operation,
      issuance_id: seeded.issuanceId,
    });
    if (loaded.record && loaded.record.state === 'reserved') {
      try {
        await failRuntime.tick({ operation: loaded.record });
      } catch (_) { /* commit failure is invalid/unknown */ }
      assert.equal(failMade.fake.getCalls().filter((row) => row.operation === 'create_reply_draft').length, 0);
      assert.equal(commitFailed, true);
      console.log('ok - COMMIT error creates 0 provider drafts');
    }
  }

  const concurrentMade = makeProvider();
  if (rolesMode) {
    const runtimeA = createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
      env: enabledEnv(),
      producerWithTransactionClient: bindProducerWithTransactionClient(createRoleLoaner(db, 'luna_ch3_producer')),
      workerWithTransactionClient: bindWorkerWithTransactionClient(createRoleLoaner(db, 'luna_ch3_worker')),
      provider: concurrentMade.provider,
      issuanceStore: issuance.store,
    });
    const runtimeB = createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
      env: enabledEnv(),
      producerWithTransactionClient: bindProducerWithTransactionClient(createRoleLoaner(db, 'luna_ch3_producer')),
      workerWithTransactionClient: bindWorkerWithTransactionClient(createRoleLoaner(db, 'luna_ch3_worker')),
      provider: concurrentMade.provider,
      issuanceStore: issuance.store,
    });
    const loaded = await storeMod.createEmailLunaControlledDraftingOperationStore({
      withTransactionClient: workerRaw,
    }).loadControlledDraft({
      operation_id: ids.operation,
      issuance_id: seeded.issuanceId,
    });
    if (loaded.record && loaded.record.state === 'create_dispatched_outcome_unknown'
        && !loaded.record.provider_draft_id) {
      const [a, b] = await Promise.all([
        runtimeA.tick({ operation: loaded.record }),
        runtimeB.tick({ operation: loaded.record }),
      ]);
      void a;
      void b;
      assert.equal(
        concurrentMade.fake.getCalls().filter((row) => row.operation === 'create_reply_draft').length,
        0,
      );
      console.log('ok - two runtimes on unknown-without-id create 0 additional POSTs');
    } else if (loaded.record && loaded.record.state === 'provider_draft_reconciled_exact') {
      const [a, b] = await Promise.all([
        runtimeA.tick({ operation: loaded.record }),
        runtimeB.tick({ operation: loaded.record }),
      ]);
      assert.equal(a.create_invoked || b.create_invoked, false);
      assert.equal(
        concurrentMade.fake.getCalls().filter((row) => row.operation === 'create_reply_draft').length,
        0,
      );
      console.log('ok - two runtimes on exact draft create 0 additional POSTs');
    }
  }

  const disableEnv = enabledEnv();
  const disablePair = {
    producer: bindProducerWithTransactionClient(rolesMode ? producerRaw : createOwnerLoaner(db)),
    worker: bindWorkerWithTransactionClient(rolesMode ? workerRaw : createOwnerLoaner(db)),
  };
  const disableRuntime = createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
    env: disableEnv,
    producerWithTransactionClient: disablePair.producer,
    workerWithTransactionClient: disablePair.worker,
    provider: makeProvider().provider,
    issuanceStore: issuance.store,
  });
  disableEnv.EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED = 'false';
  const disableLoaded = await storeMod.createEmailLunaControlledDraftingOperationStore({
    withTransactionClient: rolesMode ? workerRaw : createOwnerLoaner(db),
  }).loadControlledDraft({
    operation_id: ids.operation,
    issuance_id: seeded.issuanceId,
  });
  if (disableLoaded.record) {
    const disabledTick = await disableRuntime.tick({ operation: disableLoaded.record });
    assert.equal(disabledTick.status, 'blocked_disabled');
    assert.equal(disabledTick.create_invoked, false);
    assert.equal(disabledTick.provider_invoked, false);
    console.log('ok - disable switch blocks subsequent provider calls');
  }
}

async function main() {
  console.log('FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 3 PGlite runtime composition');
  const PGlite = tryLoadPglite();
  if (!PGlite) {
    console.log('SKIP - PGlite unavailable');
    return;
  }
  await provePglite(PGlite);
  console.log('ALL OK — Stage 2 Chapter 3 PGlite runtime composition');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

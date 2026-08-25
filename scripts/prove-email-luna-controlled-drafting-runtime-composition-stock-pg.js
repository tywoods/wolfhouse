'use strict';

/**
 * Stock PostgreSQL mapped-principal proof for Stage 2 Chapter 3 runtime.
 * SKIP honestly when embedded PostgreSQL is unavailable.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createEmailLunaControlledDraftingSunsetStagingRuntimeComposition,
  bindProducerWithTransactionClient,
  bindWorkerWithTransactionClient,
  ERROR_CODE,
} = require('./lib/email-luna-controlled-drafting-sunset-staging-runtime-composition');
const {
  createEmailLunaControlledDraftingProvider,
  createEmailLunaControlledDraftingFakeTransport,
  pickEmailLunaControlledDraftingTransportMethods,
} = require('./lib/email-luna-controlled-drafting-provider-contract');
const {
  ids,
  PASSWORD,
  persistIssuance,
  applyCommittedInbound063Identity,
} = require('./prove-email-luna-controlled-drafting-operation-store-pglite');
const storeMod = require('./lib/email-luna-controlled-drafting-operation-store');
const {
  exclusiveSession,
  applyThrough088,
  revokePublicExecuteOutsideCatalogs,
  loadOwners,
} = require('./prove-email-luna-automation-issuance-material-pglite');
const {
  provisionEmailLunaAutomationPrincipal,
} = require('./lib/email-luna-automation-principal-provision');
const { createRoleSql } = require('./lib/email-luna-automation-principal-contract');

const PG_MODULE = '/opt/data/calendar-inventory-bridge-bf/node_modules/pg';
const EMBEDDED_MODULE = '/opt/data/calendar-inventory-bridge-bf/node_modules/embedded-postgres/dist/index.js';
const GRAPH_MAILBOX = '22222222-2222-4222-8222-2222222222ab';
const UP_092 = fs.readFileSync(
  path.join(__dirname, '..', 'database/migrations/092_tenant_email_luna_automation_issuance_material.sql'),
  'utf8',
);
const UP_097 = fs.readFileSync(
  path.join(__dirname, '..', 'database/migrations/097_tenant_email_luna_controlled_draft_operations.sql'),
  'utf8',
);

function resolvePg() {
  try {
    return require(PG_MODULE);
  } catch (error) {
    const failed = new Error(`stock-PG blocker: cannot require pg: ${error && error.message}`);
    failed.code = 'STOCK_PG_PG_MODULE_MISSING';
    throw failed;
  }
}

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

function issuanceDouble(subject, body) {
  const branded = new WeakSet();
  return {
    branded,
    store: {
      assertAuthenticLoadedMaterial(value) {
        if (!value || !branded.has(value)) {
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

function authenticMaterial(branded, issuanceId) {
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

function wrapClient(client) {
  return {
    async exec(sql) { await client.query(sql); },
    async query(text, params) { return client.query(text, params); },
  };
}

const OPERATION_CALL_RE = /FROM public\.tenant_email_luna_controlled_draft_(reserve|claim_create|record_create|reconcile|load)\s*\(/i;

function roleLoaner(client, stats) {
  return async (work) => work({
    async query(text, params) {
      const sql = String(text || '');
      if (stats && OPERATION_CALL_RE.test(sql)) stats.operations += 1;
      return client.query(text, params);
    },
  });
}

async function expectReject(fn, stats, provider, createCallsBefore) {
  let rejected = false;
  try {
    await fn();
  } catch (error) {
    rejected = error && error.code === ERROR_CODE;
  }
  assert.equal(rejected, true);
  assert.equal(stats.operations, 0);
  const creates = provider.fake
    ? provider.fake.getCalls().filter((row) => row.operation === 'create_reply_draft').length
    : 0;
  assert.equal(creates, createCallsBefore);
}

async function proveStockPg(client, connectClone) {
  const db = wrapClient(client);
  await applyThrough088(db);
  await db.exec(UP_092);
  await applyCommittedInbound063Identity(db);
  await db.exec(UP_097);
  await revokePublicExecuteOutsideCatalogs(db);
  await db.exec(`
    UPDATE public.tenant_email_inbound_events
       SET provider_mailbox_id = '${GRAPH_MAILBOX}'
     WHERE id = '${ids.inbound}'
  `);

  await provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
    roleName: 'luna_ch3_stock_worker',
    kind: 'worker',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: PASSWORD,
    apply: true,
  });
  await provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
    roleName: 'luna_ch3_stock_producer',
    kind: 'producer',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: PASSWORD,
    apply: true,
  });
  await provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
    roleName: 'luna_ch3_operator',
    kind: 'operator',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: PASSWORD,
    apply: true,
  });
  await provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
    roleName: 'luna_ch3_wrong_loc',
    kind: 'producer',
    client_id: ids.client,
    location_id: ids.locationB,
    location_key: 'sunset-sardinero',
    password: PASSWORD,
    apply: true,
  });
  await db.exec(createRoleSql('luna_ch3_unmapped', PASSWORD));
  await db.exec('GRANT CONNECT ON DATABASE postgres TO luna_ch3_unmapped');
  await db.exec('GRANT USAGE ON SCHEMA public TO luna_ch3_unmapped');
  await db.exec(`
    CREATE ROLE luna_ch3_inherited LOGIN PASSWORD '${PASSWORD}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS
  `);
  await db.exec('GRANT CONNECT ON DATABASE postgres TO luna_ch3_inherited');
  await db.exec('GRANT USAGE ON SCHEMA public TO luna_ch3_inherited');
  await db.exec('GRANT luna_ch3_stock_producer TO luna_ch3_inherited');

  const owners = loadOwners();
  const ownerLoaner = {
    async withTransactionClient(work) {
      return work({
        async query(text, params) { return client.query(text, params); },
      });
    },
  };
  const seeded = await persistIssuance(db, owners, ownerLoaner, ids.operation, ids.audit);
  await db.exec(`
    UPDATE public.tenant_email_inbound_events
       SET provider_mailbox_id = '${GRAPH_MAILBOX}'
     WHERE id = '${ids.inbound}'
  `);

  const producer = await connectClone();
  const worker = await connectClone();
  const owner = await connectClone();
  const workerB = await connectClone();
  const unmapped = await connectClone();
  const operator = await connectClone();
  const inherited = await connectClone();
  const wrongLoc = await connectClone();
  const setRole = await connectClone();
  const clones = [producer, worker, owner, workerB, unmapped, operator, inherited, wrongLoc, setRole];
  try {
    await producer.query('SET SESSION AUTHORIZATION luna_ch3_stock_producer');
    await worker.query('SET SESSION AUTHORIZATION luna_ch3_stock_worker');
    await workerB.query('SET SESSION AUTHORIZATION luna_ch3_stock_worker');
    await unmapped.query('SET SESSION AUTHORIZATION luna_ch3_unmapped');
    await operator.query('SET SESSION AUTHORIZATION luna_ch3_operator');
    await inherited.query('SET SESSION AUTHORIZATION luna_ch3_inherited');
    await wrongLoc.query('SET SESSION AUTHORIZATION luna_ch3_wrong_loc');
    await setRole.query('SET ROLE luna_ch3_stock_producer');
    const issuance = issuanceDouble(seeded.bundle.draft.subject, seeded.bundle.draft.body);
    const made = makeProvider();
    const producerStats = { operations: 0 };
    const workerStats = { operations: 0 };
    const runtime = createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
      env: enabledEnv(),
      producerWithTransactionClient: bindProducerWithTransactionClient(roleLoaner(producer, producerStats)),
      workerWithTransactionClient: bindWorkerWithTransactionClient(roleLoaner(worker, workerStats)),
      provider: made.provider,
      issuanceStore: issuance.store,
    });
    const reserved = await runtime.reserveControlledDraft({
      material: authenticMaterial(issuance.branded, seeded.issuanceId),
    });
    assert.equal(reserved.status, 'reserved');
    assert.equal(producerStats.operations >= 1, true);
    const loaded = await storeMod.createEmailLunaControlledDraftingOperationStore({
      withTransactionClient: roleLoaner(worker),
    }).loadControlledDraft({
      operation_id: ids.operation,
      issuance_id: seeded.issuanceId,
    });
    const first = await runtime.tick({ operation: loaded.record });
    assert.equal(first.create_invoked, true);
    assert.equal(made.fake.getCalls().filter((row) => row.operation === 'create_reply_draft').length, 1);
    assert.equal(workerStats.operations >= 1, true);
    console.log('ok - stock-PG mapped producer attest+reserve; mapped worker attest+claim/record/reconcile/load');

    function rejectRuntime(producerClient, workerClient) {
      const stats = { operations: 0 };
      const provider = makeProvider();
      const composed = createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
        env: enabledEnv(),
        producerWithTransactionClient: bindProducerWithTransactionClient(roleLoaner(producerClient, stats)),
        workerWithTransactionClient: bindWorkerWithTransactionClient(roleLoaner(workerClient, stats)),
        provider: provider.provider,
        issuanceStore: issuance.store,
      });
      return { composed, stats, provider };
    }

    const unmappedCase = rejectRuntime(unmapped, workerB);
    await expectReject(
      () => unmappedCase.composed.reserveControlledDraft({
        material: authenticMaterial(issuance.branded, seeded.issuanceId),
      }),
      unmappedCase.stats,
      unmappedCase.provider,
      0,
    );
    console.log('ok - unmapped LOGIN rejected at composition attest');

    const operatorCase = rejectRuntime(operator, workerB);
    await expectReject(
      () => operatorCase.composed.reserveControlledDraft({
        material: authenticMaterial(issuance.branded, seeded.issuanceId),
      }),
      operatorCase.stats,
      operatorCase.provider,
      0,
    );
    console.log('ok - operator rejected at composition attest');

    const ownerCase = rejectRuntime(owner, workerB);
    await expectReject(
      () => ownerCase.composed.reserveControlledDraft({
        material: authenticMaterial(issuance.branded, seeded.issuanceId),
      }),
      ownerCase.stats,
      ownerCase.provider,
      0,
    );
    const ownerWrapA = rejectRuntime(owner, workerB);
    const ownerWrapB = rejectRuntime(owner, workerB);
    await expectReject(
      () => ownerWrapA.composed.reserveControlledDraft({
        material: authenticMaterial(issuance.branded, seeded.issuanceId),
      }),
      ownerWrapA.stats,
      ownerWrapA.provider,
      0,
    );
    await expectReject(
      () => ownerWrapB.composed.reserveControlledDraft({
        material: authenticMaterial(issuance.branded, seeded.issuanceId),
      }),
      ownerWrapB.stats,
      ownerWrapB.provider,
      0,
    );
    console.log('ok - table owner and two wrappers over one owner session rejected at attest');

    const setRoleWho = await setRole.query(
      'SELECT session_user::text AS session_user, current_user::text AS current_user',
    );
    assert.notEqual(setRoleWho.rows[0].session_user, setRoleWho.rows[0].current_user);
    const setRoleCase = rejectRuntime(setRole, workerB);
    await expectReject(
      () => setRoleCase.composed.reserveControlledDraft({
        material: authenticMaterial(issuance.branded, seeded.issuanceId),
      }),
      setRoleCase.stats,
      setRoleCase.provider,
      0,
    );
    console.log('ok - owner + SET ROLE producer rejected because session_user/current_user differ');

    const workerAsProducer = rejectRuntime(worker, workerB);
    await expectReject(
      () => workerAsProducer.composed.reserveControlledDraft({
        material: authenticMaterial(issuance.branded, seeded.issuanceId),
      }),
      workerAsProducer.stats,
      workerAsProducer.provider,
      0,
    );
    console.log('ok - mapped worker supplied as producer rejected at attest');

    const producerAsWorkerStats = { operations: 0 };
    const producerAsWorkerProvider = makeProvider();
    const producerAsWorker = createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
      env: enabledEnv(),
      producerWithTransactionClient: bindProducerWithTransactionClient(roleLoaner(producer)),
      workerWithTransactionClient: bindWorkerWithTransactionClient(roleLoaner(producer, producerAsWorkerStats)),
      provider: producerAsWorkerProvider.provider,
      issuanceStore: issuance.store,
    });
    const afterCreate = await storeMod.createEmailLunaControlledDraftingOperationStore({
      withTransactionClient: roleLoaner(worker),
    }).loadControlledDraft({
      operation_id: ids.operation,
      issuance_id: seeded.issuanceId,
    });
    await expectReject(
      () => producerAsWorker.tick({ operation: afterCreate.record }),
      producerAsWorkerStats,
      producerAsWorkerProvider,
      0,
    );
    console.log('ok - mapped producer supplied as worker rejected at attest');

    const inheritedCase = rejectRuntime(inherited, workerB);
    await expectReject(
      () => inheritedCase.composed.reserveControlledDraft({
        material: authenticMaterial(issuance.branded, seeded.issuanceId),
      }),
      inheritedCase.stats,
      inheritedCase.provider,
      0,
    );
    console.log('ok - inherited/non-mapped role rejected at attest');

    const wrongLocCase = rejectRuntime(wrongLoc, workerB);
    await expectReject(
      () => wrongLocCase.composed.reserveControlledDraft({
        material: authenticMaterial(issuance.branded, seeded.issuanceId),
      }),
      wrongLocCase.stats,
      wrongLocCase.provider,
      0,
    );
    console.log('ok - wrong tenant/location/location_key mapping rejected at attest');

    await client.query(
      `REVOKE EXECUTE ON FUNCTION public.tenant_email_luna_controlled_draft_reserve(uuid, uuid, text, text, text, text, text, text) FROM luna_ch3_stock_producer`,
    );
    const revokedProducer = await connectClone();
    clones.push(revokedProducer);
    await revokedProducer.query('SET SESSION AUTHORIZATION luna_ch3_stock_producer');
    const revokedCase = rejectRuntime(revokedProducer, workerB);
    await expectReject(
      () => revokedCase.composed.reserveControlledDraft({
        material: authenticMaterial(issuance.branded, seeded.issuanceId),
      }),
      revokedCase.stats,
      revokedCase.provider,
      0,
    );
    await client.query(
      `GRANT EXECUTE ON FUNCTION public.tenant_email_luna_controlled_draft_reserve(uuid, uuid, text, text, text, text, text, text) TO luna_ch3_stock_producer`,
    );
    console.log('ok - mapping correct but required EXECUTE revoked rejected at attest');

    const runtimeB = createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
      env: enabledEnv(),
      producerWithTransactionClient: bindProducerWithTransactionClient(roleLoaner(producer)),
      workerWithTransactionClient: bindWorkerWithTransactionClient(roleLoaner(workerB)),
      provider: made.provider,
      issuanceStore: issuance.store,
    });
    const after = await storeMod.createEmailLunaControlledDraftingOperationStore({
      withTransactionClient: roleLoaner(worker),
    }).loadControlledDraft({
      operation_id: ids.operation,
      issuance_id: seeded.issuanceId,
    });
    const [tickA, tickB] = await Promise.all([
      runtime.tick({ operation: after.record }),
      runtimeB.tick({ operation: after.record }),
    ]);
    assert.equal(tickA.create_invoked || tickB.create_invoked, false);
    assert.equal(made.fake.getCalls().filter((row) => row.operation === 'create_reply_draft').length, 1);
    console.log('ok - stock-PG two sessions/runtimes: exactly one POST authority');
  } finally {
    for (const clone of clones) {
      try { await clone.end(); } catch (_) { /* ignore */ }
    }
  }
}

async function main() {
  console.log('FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 3 stock-PG runtime composition');
  let EmbeddedPostgres;
  try {
    ({ default: EmbeddedPostgres } = await import(EMBEDDED_MODULE));
  } catch (error) {
    console.log(`SKIP - embedded PostgreSQL unavailable (${error && error.message})`);
    return;
  }
  const { Client } = resolvePg();
  const dataDir = fs.mkdtempSync(path.join('/opt/data/local-postgres', 'ch3-runtime-stock-'));
  const port = 56971 + (process.pid % 17);
  const password = 'local-disposable-ch3';
  const cluster = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password,
    port,
    persistent: false,
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
    onLog() {},
    onError(message) { console.error(String(message)); },
  });
  let started = false;
  const client = new Client({
    host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres',
  });
  try {
    await cluster.initialise();
    await cluster.start();
    started = true;
    await client.connect();
    await proveStockPg(client, async () => {
      const clone = new Client({
        host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres',
      });
      await clone.connect();
      return clone;
    });
    console.log(`ALL OK — Stage 2 Chapter 3 stock-PG runtime composition (${dataDir} port ${port})`);
  } finally {
    try { await client.end(); } catch (_) { /* ignore */ }
    if (started) {
      try { await cluster.stop(); } catch (_) { /* ignore */ }
    }
  }
}

main().catch((error) => {
  if (error && /STOCK_PG|embedded/i.test(String(error.code || error.message))) {
    console.log(`SKIP - ${error.message}`);
    return;
  }
  console.error(error);
  process.exit(1);
});

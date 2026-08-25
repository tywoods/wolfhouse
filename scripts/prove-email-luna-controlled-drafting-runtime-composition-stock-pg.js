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

function roleLoaner(client) {
  return async (work) => work({
    async query(text, params) {
      return client.query(text, params);
    },
  });
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
  try {
    await producer.query('SET SESSION AUTHORIZATION luna_ch3_stock_producer');
    await worker.query('SET SESSION AUTHORIZATION luna_ch3_stock_worker');
    await workerB.query('SET SESSION AUTHORIZATION luna_ch3_stock_worker');
    const issuance = issuanceDouble(seeded.bundle.draft.subject, seeded.bundle.draft.body);
    const made = makeProvider();
    const runtime = createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
      env: enabledEnv(),
      producerWithTransactionClient: bindProducerWithTransactionClient(roleLoaner(producer)),
      workerWithTransactionClient: bindWorkerWithTransactionClient(roleLoaner(worker)),
      provider: made.provider,
      issuanceStore: issuance.store,
    });
    const reserved = await runtime.reserveControlledDraft({
      material: authenticMaterial(issuance.branded, seeded.issuanceId),
    });
    assert.equal(reserved.status, 'reserved');
    const loaded = await storeMod.createEmailLunaControlledDraftingOperationStore({
      withTransactionClient: roleLoaner(worker),
    }).loadControlledDraft({
      operation_id: ids.operation,
      issuance_id: seeded.issuanceId,
    });
    const first = await runtime.tick({ operation: loaded.record });
    assert.equal(first.create_invoked, true);
    assert.equal(made.fake.getCalls().filter((row) => row.operation === 'create_reply_draft').length, 1);

    const ownerRuntime = createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
      env: enabledEnv(),
      producerWithTransactionClient: bindProducerWithTransactionClient(roleLoaner(owner)),
      workerWithTransactionClient: bindWorkerWithTransactionClient(roleLoaner(workerB)),
      provider: makeProvider().provider,
      issuanceStore: issuance.store,
    });
    let ownerRefused = false;
    try {
      await ownerRuntime.reserveControlledDraft({
        material: authenticMaterial(issuance.branded, seeded.issuanceId),
      });
    } catch (error) {
      ownerRefused = error && error.code === ERROR_CODE;
    }
    assert.equal(ownerRefused, true);
    console.log('ok - stock-PG table-owner composition refused; mapped producer/worker create once');

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
    for (const clone of [producer, worker, owner, workerB]) {
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

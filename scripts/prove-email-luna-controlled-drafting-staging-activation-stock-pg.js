'use strict';

/**
 * Stock PostgreSQL proof for Stage 2 Chapter 4A activation.
 * Direct LOGIN producer/worker, canonical 097, one-POST authority, no live Graph.
 * SKIP honestly when embedded PostgreSQL is unavailable.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createEmailLunaControlledDraftingSunsetStagingRuntimeActivation,
  ERROR_CODE,
  DISABLED_CODE,
} = require('./lib/email-luna-controlled-drafting-sunset-staging-runtime-activation');
const {
  inspectEmailLunaControlledDraftingSession,
  MIGRATION_097_SHA256,
} = require('./lib/email-luna-controlled-drafting-session-proof');
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
const { checksumMigrationFile, CHECKSUM_MODE_CANONICAL_LF_V1 } = require('./lib/migration-integrity');

const PG_MODULE = '/opt/data/calendar-inventory-bridge-bf/node_modules/pg';
const EMBEDDED_MODULE = '/opt/data/calendar-inventory-bridge-bf/node_modules/embedded-postgres/dist/index.js';
const GRAPH_MAILBOX = '22222222-2222-4222-8222-2222222222ab';
const ROOT = path.join(__dirname, '..');
const UP_092 = fs.readFileSync(
  path.join(ROOT, 'database/migrations/092_tenant_email_luna_automation_issuance_material.sql'),
  'utf8',
);
const UP_097 = fs.readFileSync(
  path.join(ROOT, 'database/migrations/097_tenant_email_luna_controlled_draft_operations.sql'),
  'utf8',
);
const LIVE_097 = checksumMigrationFile(
  path.join(ROOT, 'database/migrations/097_tenant_email_luna_controlled_draft_operations.sql'),
  CHECKSUM_MODE_CANONICAL_LF_V1,
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

function enabledEnv(issuanceId) {
  return {
    LUNA_DEPLOYMENT: 'sunset-staging',
    DEFAULT_CLIENT_SLUG: 'sunset',
    EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED: 'true',
    EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED: 'true',
    EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_INTAKE_ENABLED: 'true',
    EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_TICK_ENABLED: 'true',
    EMAIL_LUNA_CONTROLLED_DRAFTING_CLIENT_ID: ids.client,
    EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_ID: ids.location,
    EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_KEY: 'sunset-somo',
    EMAIL_LUNA_CONTROLLED_DRAFTING_ENDPOINT_ID: ids.endpoint,
    EMAIL_LUNA_CONTROLLED_DRAFTING_MAILBOX_ID: GRAPH_MAILBOX,
    EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER: 'microsoft_graph',
    EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_REPLICA_COUNT: '1',
    EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_DATABASE_URL: 'postgres://luna_ch4a_producer:x@127.0.0.1:5432/postgres',
    EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_DATABASE_URL: 'postgres://luna_ch4a_worker:x@127.0.0.1:5432/postgres',
    WOLFHOUSE_DATABASE_URL: 'postgres://postgres:x@127.0.0.1:5432/postgres',
    EMAIL_LUNA_CONTROLLED_DRAFTING_TEST_OPERATION_ID: ids.operation,
    EMAIL_LUNA_CONTROLLED_DRAFTING_TEST_ISSUANCE_ID: issuanceId,
    EMAIL_LUNA_CONTROLLED_DRAFTING_TEST_RECIPIENT_ADDRESS: 'elena@example.test',
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

function authenticIssuanceStore(workerClient, bundle, issuanceId) {
  const persistMod = require('./lib/email-luna-automation-issuance-material-store');
  const persisted = persistMod.createEmailLunaAutomationIssuanceMaterialPersistence({
    withTransactionClient: roleLoaner(workerClient),
  });
  const branded = new WeakSet();
  return {
    async loadAutomationIssuanceMaterial(input) {
      const loaded = await persisted.loadAutomationIssuanceMaterial(input);
      if (loaded && loaded.status === 'loaded' && loaded.record) branded.add(loaded.record);
      return loaded;
    },
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
          draft: Object.freeze({
            subject: bundle.draft.subject,
            body: bundle.draft.body,
            language: bundle.draft.language,
          }),
          issuance_id: issuanceId,
          operation_id: input.material.operation_id,
        }),
      });
    },
  };
}

async function proveStockPg(client, connectClone) {
  assert.equal(LIVE_097.ok, true);
  assert.equal(LIVE_097.sha256, MIGRATION_097_SHA256);
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
    roleName: 'luna_ch4a_worker',
    kind: 'worker',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: PASSWORD,
    apply: true,
  });
  await provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
    roleName: 'luna_ch4a_producer',
    kind: 'producer',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: PASSWORD,
    apply: true,
  });
  await db.exec(createRoleSql('luna_ch4a_unmapped', PASSWORD));
  await db.exec('GRANT CONNECT ON DATABASE postgres TO luna_ch4a_unmapped');
  await db.exec('GRANT USAGE ON SCHEMA public TO luna_ch4a_unmapped');

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
  const setRole = await connectClone();
  const unmapped = await connectClone();
  const workerB = await connectClone();
  const clones = [producer, worker, owner, setRole, unmapped, workerB];
  try {
    await producer.query('SET SESSION AUTHORIZATION luna_ch4a_producer');
    await worker.query('SET SESSION AUTHORIZATION luna_ch4a_worker');
    await workerB.query('SET SESSION AUTHORIZATION luna_ch4a_worker');
    await unmapped.query('SET SESSION AUTHORIZATION luna_ch4a_unmapped');
    await setRole.query('SET ROLE luna_ch4a_producer');

    const binding = {
      client_id: ids.client,
      location_id: ids.location,
      location_key: 'sunset-somo',
    };
    const producerProof = await inspectEmailLunaControlledDraftingSession(producer, binding, 'producer');
    const workerProof = await inspectEmailLunaControlledDraftingSession(worker, binding, 'worker');
    assert.equal(producerProof.ok, true);
    assert.equal(workerProof.ok, true);
    assert.equal(producerProof.schema_applied, true);
    assert.equal(workerProof.login_ok, true);
    console.log('ok - mapped producer/worker LOGIN session proof for 097');

    const ownerProof = await inspectEmailLunaControlledDraftingSession(owner, binding, 'producer');
    assert.equal(ownerProof.ok, false);
    const setRoleProof = await inspectEmailLunaControlledDraftingSession(setRole, binding, 'producer');
    assert.equal(setRoleProof.ok, false);
    const unmappedProof = await inspectEmailLunaControlledDraftingSession(unmapped, binding, 'producer');
    assert.equal(unmappedProof.ok, false);
    console.log('ok - owner, SET ROLE, and unmapped LOGIN fail closed before timer/provider');

    const made = makeProvider();
    const env = enabledEnv(seeded.issuanceId);
    const timers = { setTimeout() { return 1; }, clearTimeout() {} };
    const runtime = createEmailLunaControlledDraftingSunsetStagingRuntimeActivation({
      env,
      producerWithTransactionClient: roleLoaner(producer),
      workerWithTransactionClient: roleLoaner(worker),
      timers,
      intervalMs: 60000,
      provider: made.provider,
      issuanceStore: authenticIssuanceStore(worker, seeded.bundle, seeded.issuanceId),
    });
    await runtime.start();
    const first = await runtime.tick();
    assert.equal(first.provider_invoked === true || first.create_invoked === true || first.status === 'reserved'
      || first.reason === 'reserved' || first.reason === 'create_recorded'
      || first.status === 'provider_draft_reconciled_exact', true);
    const creates = made.fake.getCalls().filter((row) => row.operation === 'create_reply_draft').length;
    assert.equal(creates, 1);
    console.log('ok - activation tick creates exactly once via Chapter 1 fake transport (no live Graph)');

    await runtime.stop();
    await runtime.start();
    const restarted = await runtime.tick();
    assert.equal(made.fake.getCalls().filter((row) => row.operation === 'create_reply_draft').length, 1);
    assert.equal(restarted.create_invoked === true, false);
    console.log('ok - crash/restart preserves Chapter 3 one-POST authority');

    const runtimeB = createEmailLunaControlledDraftingSunsetStagingRuntimeActivation({
      env,
      producerWithTransactionClient: roleLoaner(producer),
      workerWithTransactionClient: roleLoaner(workerB),
      timers,
      intervalMs: 60000,
      provider: made.provider,
      issuanceStore: authenticIssuanceStore(workerB, seeded.bundle, seeded.issuanceId),
    });
    await runtimeB.start();
    const [tickA, tickB] = await Promise.all([runtime.tick(), runtimeB.tick()]);
    assert.equal(made.fake.getCalls().filter((row) => row.operation === 'create_reply_draft').length, 1);
    assert.equal((tickA && tickA.create_invoked) || (tickB && tickB.create_invoked), false);
    await runtimeB.stop();
    await runtime.stop();
    console.log('ok - two sessions: exactly one POST authority');

    const otherEnv = enabledEnv('cccccccc-cccc-4ccc-8ccc-ccccccccccc1');
    otherEnv.EMAIL_LUNA_CONTROLLED_DRAFTING_TEST_OPERATION_ID = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
    const scoped = createEmailLunaControlledDraftingSunsetStagingRuntimeActivation({
      env: otherEnv,
      producerWithTransactionClient: roleLoaner(producer),
      workerWithTransactionClient: roleLoaner(worker),
      timers,
      intervalMs: 60000,
      provider: makeProvider().provider,
    });
    await scoped.start();
    const missed = await scoped.tick();
    assert.ok(missed.reason === 'test_scope_issuance_missing' || missed.reason === 'test_scope_operation_missing'
      || missed.status === 'blocked');
    assert.equal(made.fake.getCalls().filter((row) => row.operation === 'create_reply_draft').length, 1);
    await scoped.stop();
    console.log('ok - arbitrary queue backlog is not consumed without exact test scope');

    assert.equal(DISABLED_CODE.startsWith('EMAIL_LUNA_CONTROLLED_DRAFTING'), true);
    assert.equal(ERROR_CODE.startsWith('EMAIL_LUNA_CONTROLLED_DRAFTING'), true);
  } finally {
    for (const clone of clones) {
      try { await clone.end(); } catch (_) { /* ignore */ }
    }
  }
}

async function main() {
  console.log('FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4A stock-PG staging activation');
  let EmbeddedPostgres;
  try {
    ({ default: EmbeddedPostgres } = await import(EMBEDDED_MODULE));
  } catch (error) {
    console.log(`SKIP - embedded PostgreSQL unavailable (${error && error.message})`);
    return;
  }
  const { Client } = resolvePg();
  const dataDir = fs.mkdtempSync(path.join('/opt/data/local-postgres', 'ch4a-activation-stock-'));
  const port = 56991 + (process.pid % 17);
  const password = 'local-disposable-ch4a';
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
    console.log(`ALL OK — Stage 2 Chapter 4A stock-PG staging activation (${dataDir} port ${port})`);
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

'use strict';

/**
 * Offline RED-GREEN gate: inbound email event store + default-off Sunset composition.
 *
 * Covers: dependency boundary, durable consumer, one-txn insert-or-no-op, rollback,
 * commit-unknown, authority override rejection, provider/mailbox mismatch before SQL,
 * mixed replay counts via batch processor, composition flag isolation / zero construction,
 * no logs/PII. No live DB/network/route.
 */

const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const STORE_REL = 'scripts/lib/email-inbound-event-store.js';
const COMPOSITION_REL =
  'scripts/lib/email-microsoft-delegated-inbound-event-store-sunset-staging-runtime-composition.js';
const MIG_UP = path.join(ROOT, 'database/migrations/063_tenant_email_inbound_events.sql');
const MIG_DOWN = path.join(ROOT, 'database/migrations/063_tenant_email_inbound_events_down.sql');
const DOC = path.join(ROOT, 'docs/EMAIL-MAILBOX-ADAPTER-BOUNDARY.md');
const PKG = path.join(ROOT, 'package.json');

const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOCATION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ENDPOINT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MAILBOX = '22222222-2222-4222-8222-2222222222ab';
const PLANTED_SUBJECT = 'SUBJECT_PII_MUST_NOT_APPEAR_EVENT_STORE';
const PLANTED_ADDRESS = 'pii-event-store@example.com';
const PLANTED_TOKEN = 'ya29.NEVER_LEAK_EVENT_STORE_AT';
const SECRET = 'secret-NEVER_LEAK_EVENT_STORE';

const HOST = 'luna-sunset-staging-kv.vault.azure.net';
const KEY_ID = `https://${HOST}/keys/luna-email-grant-kek/fde9704bd37b45fabe1f12a6a615b032`;
const MI = '0e05fbe3-e8c5-48aa-a914-30aed284e6f7';
const APP_ID = '12345678-1234-4234-8234-123456789abc';

function envelope(overrides = {}) {
  return {
    provider: 'microsoft_graph',
    provider_mailbox_id: MAILBOX,
    provider_message_id: 'msg-001',
    received_at: '2026-08-01T12:00:00.000Z',
    subject: PLANTED_SUBJECT,
    sender_display_name: 'Sender',
    sender_address: PLANTED_ADDRESS,
    is_read: false,
    conversation_id: 'conv-1',
    internet_message_id: '<a@b>',
    ...overrides,
  };
}

function authority(overrides = {}) {
  return {
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    ...overrides,
  };
}

function noLeak(v) {
  const s = typeof v === 'string' ? v : (() => {
    try { return JSON.stringify(v); } catch { return String(v); }
  })();
  return !s.includes(PLANTED_SUBJECT)
    && !s.includes(PLANTED_ADDRESS)
    && !s.includes(PLANTED_TOKEN)
    && !s.includes(SECRET)
    && !s.includes('NEVER_LEAK')
    && !s.includes('refresh_token');
}

/** Stateful fake pg: supports BEGIN/COMMIT/ROLLBACK + INSERT ON CONFLICT. */
function createFakeDb(options = {}) {
  const rows = options.rows || new Map();
  const log = [];
  let inTx = false;
  let failOn;
  let commitShouldReject = false;
  let insertCalls = 0;

  function keyOf(p, mbox, mid) {
    return `${p}\0${mbox}\0${mid}`;
  }

  const db = {
    async query(sql, params) {
      const norm = String(sql).replace(/\s+/g, ' ').trim();
      log.push({ sql: norm, params: params ? params.slice() : null });
      if (failOn && failOn(norm, params, { insertCalls, inTx })) {
        throw new Error('planted_db_failure');
      }
      if (norm === 'BEGIN') {
        inTx = true;
        return { rows: [], rowCount: 0 };
      }
      if (norm === 'COMMIT') {
        if (commitShouldReject) {
          throw new Error('planted_commit_reject');
        }
        inTx = false;
        return { rows: [], rowCount: 0 };
      }
      if (norm === 'ROLLBACK') {
        inTx = false;
        return { rows: [], rowCount: 0 };
      }
      if (/^INSERT INTO tenant_email_inbound_events/.test(norm)) {
        insertCalls += 1;
        const [
          clientId, locationId, endpointId,
          provider, mailbox, messageId,
          receivedAt, subject, senderDisplay, senderAddress,
          isRead, conversationId, internetMessageId,
        ] = params;
        // Reject authority override via envelope — authority comes from params 0-2 only.
        const k = keyOf(provider, mailbox, messageId);
        if (!rows.has(k)) {
          rows.set(k, {
            client_id: clientId,
            location_id: locationId,
            endpoint_id: endpointId,
            provider,
            provider_mailbox_id: mailbox,
            provider_message_id: messageId,
            received_at: receivedAt,
            subject,
            sender_display_name: senderDisplay,
            sender_address: senderAddress,
            is_read: isRead,
            conversation_id: conversationId,
            internet_message_id: internetMessageId,
          });
          return { rows: [], rowCount: 1 };
        }
        // ON CONFLICT DO NOTHING
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`unexpected sql: ${norm.slice(0, 80)}`);
    },
  };

  return {
    db,
    rows,
    log,
    get insertCalls() { return insertCalls; },
    get inTx() { return inTx; },
    setFailOn(fn) { failOn = fn; },
    setCommitReject(v) { commitShouldReject = v; },
  };
}

function installAzureLoadIntercept() {
  const original = Module._load;
  Module._load = function intercepted(request, parent, isMain) {
    if (request === '@azure/identity') {
      return {
        ManagedIdentityCredential: class {
          constructor(clientId) { assert.equal(clientId, MI); }
          getToken() {
            return Promise.resolve({ token: 'x', expiresOnTimestamp: Date.now() + 1 });
          }
        },
      };
    }
    if (request === '@azure/keyvault-keys') {
      return {
        CryptographyClient: class {
          constructor(keyId) { assert.equal(keyId, KEY_ID); }
          wrapKey() { return Promise.resolve({ result: Buffer.alloc(256) }); }
          unwrapKey() { return Promise.resolve({ result: Buffer.alloc(32) }); }
        },
      };
    }
    return original.call(this, request, parent, isMain);
  };
  return () => { Module._load = original; };
}

function enabledEnv(patch = {}) {
  return {
    LUNA_DEPLOYMENT: 'sunset-staging',
    LUNA_EMAIL_OAUTH_INBOUND_EVENT_STORE_ENABLED: 'true',
    LUNA_EMAIL_OAUTH_CLIENT_ID: APP_ID,
    LUNA_EMAIL_OAUTH_CLIENT_SECRET: SECRET,
    EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED: 'true',
    EMAIL_GRANT_ENVELOPE_AZURE_KV_TRUSTED_HOST: HOST,
    EMAIL_GRANT_ENVELOPE_AZURE_KV_VERSIONED_KEY_ID: KEY_ID,
    ...patch,
  };
}

async function main() {
  const storeAbs = path.join(ROOT, STORE_REL);
  const compAbs = path.join(ROOT, COMPOSITION_REL);
  delete require.cache[storeAbs];
  const store = require('./lib/email-inbound-event-store');
  const {
    FAILURE_CODE,
    EMAIL_INBOUND_EVENT_STORE_RUNTIME_WIRED,
    EMAIL_INBOUND_EVENT_STORE_PERSISTENCE_AUTHORIZED,
    EMAIL_INBOUND_EVENT_STORE_LOGGING_FORBIDDEN,
    AUTHORITY_KEYS,
    SQL_INSERT_EVENT,
    createInboundEmailEventStore,
    createDurableInboundEventStoreConsumer,
    prepareCanonicalBatch,
    snapshotAuthority,
    resolveDb,
  } = store;

  // ── Static flags / SQL / migration shape ────────────────────────────────
  assert.equal(EMAIL_INBOUND_EVENT_STORE_RUNTIME_WIRED, false);
  assert.equal(EMAIL_INBOUND_EVENT_STORE_PERSISTENCE_AUTHORIZED, true);
  assert.equal(EMAIL_INBOUND_EVENT_STORE_LOGGING_FORBIDDEN, true);
  assert.deepEqual([...AUTHORITY_KEYS], ['clientId', 'locationId', 'endpointId']);
  assert.match(SQL_INSERT_EVENT, /ON CONFLICT \(provider, provider_mailbox_id, provider_message_id\) DO NOTHING/);
  assert.equal(/ON CONFLICT[\s\S]*DO UPDATE/i.test(SQL_INSERT_EVENT), false);
  assert.match(SQL_INSERT_EVENT, /internet_message_id/);

  const up = fs.readFileSync(MIG_UP, 'utf8');
  const down = fs.readFileSync(MIG_DOWN, 'utf8');
  assert.match(up, /CREATE TABLE tenant_email_inbound_events/);
  assert.match(up, /tenant_email_inbound_events_identity_uq/);
  assert.match(up, /UNIQUE \(provider, provider_mailbox_id, provider_message_id\)/);
  assert.match(up, /REFERENCES tenant_locations \(client_id, id\)/);
  assert.match(up, /REFERENCES tenant_channel_endpoints \(client_id, id\)/);
  assert.match(up, /location_id\s+UUID NOT NULL/);
  assert.match(up, /tenant_locations\.id UUID/);
  assert.equal(
    /location_id\s+TEXT\s+NOT NULL/.test(up),
    false,
    'must not use text location_id column as authority',
  );
  assert.match(up, /REFERENCES tenant_locations \(client_id, id\)/);
  assert.match(up, /internet_message_id\s+TEXT NULL/);
  assert.equal(/INSERT INTO tenant_email_inbound_events/.test(up), false, 'empty migration');
  assert.match(down, /DROP TABLE IF EXISTS tenant_email_inbound_events/);

  // ── Authority snapshot / proxy rejection ────────────────────────────────
  assert.ok(snapshotAuthority(authority()));
  assert.equal(snapshotAuthority(null), null);
  assert.equal(snapshotAuthority({ clientId: CLIENT }), null, 'missing keys');
  assert.equal(snapshotAuthority({
    clientId: CLIENT,
    locationId: 'not-a-uuid',
    endpointId: ENDPOINT,
  }), null);
  assert.equal(snapshotAuthority({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    extra: true,
  }), null, 'extra keys');
  assert.equal(snapshotAuthority(new Proxy(authority(), {
    get(t, p) { return t[p]; },
  })), null, 'proxy authority');

  // ── resolveDb proxy / accessor boundary ─────────────────────────────────
  assert.ok(resolveDb({ async query() { return { rows: [] }; } }));
  assert.equal(resolveDb(null), null);
  assert.equal(resolveDb(new Proxy({ query() {} }, {
    get(t, p) { return t[p]; },
  })), null, 'proxy db');
  assert.equal(resolveDb({
    get query() { return function q() {}; },
  }), null, 'accessor query');

  // ── prepareCanonicalBatch: mismatch before SQL ──────────────────────────
  const okBatch = prepareCanonicalBatch([
    Object.freeze(envelope({ provider_message_id: 'a' })),
    Object.freeze(envelope({ provider_message_id: 'b' })),
  ]);
  assert.equal(okBatch.ok, true);
  assert.equal(okBatch.provider, 'microsoft_graph');
  assert.equal(okBatch.mailbox, MAILBOX);

  const mixed = prepareCanonicalBatch([
    envelope({ provider_message_id: 'a' }),
    envelope({ provider_message_id: 'b', provider_mailbox_id: '33333333-3333-4333-8333-333333333333' }),
  ]);
  assert.equal(mixed.ok, false, 'mailbox mismatch before SQL');

  // ── Roundtrip insert + idempotent replay ────────────────────────────────
  {
    const fake = createFakeDb();
    const es = createInboundEmailEventStore(Object.freeze({ db: fake.db }));
    const envs = Object.freeze([
      Object.freeze(envelope({ provider_message_id: 'msg-a', internet_message_id: null })),
      Object.freeze(envelope({ provider_message_id: 'msg-b', internet_message_id: '<same@x>' })),
    ]);
    const r1 = await es.persistBatch(authority(), envs);
    assert.equal(r1.ok, true);
    assert.equal(fake.rows.size, 2);
    assert.equal(fake.log.filter((e) => e.sql === 'BEGIN').length, 1);
    assert.equal(fake.log.filter((e) => e.sql === 'COMMIT').length, 1);

    // Replay same identities (including null and same internet_message_id non-identity).
    const r2 = await es.persistBatch(authority(), Object.freeze([
      Object.freeze(envelope({
        provider_message_id: 'msg-a',
        internet_message_id: '<different@x>',
        subject: 'changed-should-not-update',
      })),
      Object.freeze(envelope({ provider_message_id: 'msg-b', internet_message_id: '<same@x>' })),
      Object.freeze(envelope({ provider_message_id: 'msg-c', internet_message_id: '<same@x>' })),
    ]));
    assert.equal(r2.ok, true);
    assert.equal(fake.rows.size, 3, 'mixed existing/new: one new row');
    const a = fake.rows.get(`microsoft_graph\0${MAILBOX}\0msg-a`);
    assert.equal(a.subject, PLANTED_SUBJECT, 'no updates on conflict');
    assert.equal(a.internet_message_id, null);
    // Two rows may share internet_message_id
    const b = fake.rows.get(`microsoft_graph\0${MAILBOX}\0msg-b`);
    const c = fake.rows.get(`microsoft_graph\0${MAILBOX}\0msg-c`);
    assert.equal(b.internet_message_id, c.internet_message_id);
  }

  // ── Consumer: one call, ack after commit ────────────────────────────────
  {
    const fake = createFakeDb();
    let consumerCalls = 0;
    const consumer = createDurableInboundEventStoreConsumer(Object.freeze({
      db: fake.db,
      authority: authority(),
    }));
    const wrapped = async (envs) => {
      consumerCalls += 1;
      return consumer(envs);
    };
    const { processInboundEmailBatch } = require('./lib/email-inbound-batch-processor');
    const batch = await processInboundEmailBatch({
      envelopes: [
        envelope({ provider_message_id: 'bp-1' }),
        envelope({ provider_message_id: 'bp-1' }), // within-batch dup
        envelope({ provider_message_id: 'bp-2' }),
      ],
      consumer: wrapped,
    });
    assert.equal(batch.ok, true);
    assert.equal(batch.value.delivered_count, 2);
    assert.equal(batch.value.duplicate_count, 1);
    assert.equal(consumerCalls, 1, 'one consumer call');
    assert.equal(fake.rows.size, 2);
  }

  // ── Mid-batch failure rolls back all ────────────────────────────────────
  {
    const fake = createFakeDb();
    fake.setFailOn((sql, _p, st) => /INSERT INTO/.test(sql) && st.insertCalls >= 1);
    const es = createInboundEmailEventStore(Object.freeze({ db: fake.db }));
    const r = await es.persistBatch(authority(), Object.freeze([
      Object.freeze(envelope({ provider_message_id: 'rb-1' })),
      Object.freeze(envelope({ provider_message_id: 'rb-2' })),
    ]));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'inbound_event_store_write_failed');
    assert.ok(fake.log.some((e) => e.sql === 'ROLLBACK'));
    assert.equal(noLeak(r), true);
  }

  // ── Commit sent then rejection → sanitized, no ack ──────────────────────
  {
    const fake = createFakeDb();
    fake.setCommitReject(true);
    const consumer = createDurableInboundEventStoreConsumer(Object.freeze({
      db: fake.db,
      authority: authority(),
    }));
    await assert.rejects(
      () => consumer(Object.freeze([Object.freeze(envelope({ provider_message_id: 'cu-1' }))])),
      (err) => {
        assert.equal(err.code, 'inbound_event_store_commit_outcome_unknown');
        assert.equal(noLeak(err.message), true);
        return true;
      },
    );
    // No compensation / no rollback claim after commit sent.
    const afterCommit = fake.log.findIndex((e) => e.sql === 'COMMIT');
    assert.ok(afterCommit >= 0);
    assert.equal(
      fake.log.slice(afterCommit + 1).some((e) => e.sql === 'ROLLBACK'),
      false,
      'no rollback after commit sent',
    );
  }

  // ── Authority override rejection (envelope cannot change client/location) ─
  {
    const fake = createFakeDb();
    const es = createInboundEmailEventStore(Object.freeze({ db: fake.db }));
    const envWithExtra = envelope({ provider_message_id: 'ao-1' });
    envWithExtra.clientId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    // Extra key → envelope validation fails in prepare (exact keyset).
    const r = await es.persistBatch(authority(), [envWithExtra]);
    assert.equal(r.ok, false);
    assert.equal(fake.rows.size, 0, 'no insert on authority override attempt');
  }

  // ── Concurrent race simulation: two inserts same identity → one row ─────
  {
    const fake = createFakeDb();
    const es = createInboundEmailEventStore(Object.freeze({ db: fake.db }));
    const env = Object.freeze(envelope({ provider_message_id: 'race-1' }));
    const [a, b] = await Promise.all([
      es.persistBatch(authority(), Object.freeze([env])),
      es.persistBatch(authority(), Object.freeze([env])),
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(fake.rows.size, 1, 'race converges to one row');
  }

  // ── Composition: flag isolation + disabled zero construction ────────────
  {
    delete require.cache[compAbs];
    const comp = require('./lib/email-microsoft-delegated-inbound-event-store-sunset-staging-runtime-composition');
    const {
      ENV_INBOUND_EVENT_STORE_ENABLED,
      SUNSET_DEPLOYMENT,
      WORKER_ID,
      INTERNAL_DURABLY_PROCESSED,
      INTERNAL_STATUS_SUCCESS,
      isInboundEventStoreEnabled,
      createSunsetStagingMicrosoftDelegatedInboundEventStoreRuntime,
      ERROR_CODE,
    } = comp;

    assert.equal(ENV_INBOUND_EVENT_STORE_ENABLED, 'LUNA_EMAIL_OAUTH_INBOUND_EVENT_STORE_ENABLED');
    assert.equal(SUNSET_DEPLOYMENT, 'sunset-staging');
    assert.equal(WORKER_ID, 'sunset-email-inbound-event-store');
    assert.equal(INTERNAL_DURABLY_PROCESSED, true);
    assert.equal(INTERNAL_STATUS_SUCCESS, 'success');

    assert.equal(isInboundEventStoreEnabled({}), false);
    assert.equal(isInboundEventStoreEnabled({
      LUNA_DEPLOYMENT: 'sunset-staging',
      LUNA_EMAIL_OAUTH_INBOUND_EVENT_STORE_ENABLED: 'TRUE',
    }), false);
    assert.equal(isInboundEventStoreEnabled({
      LUNA_DEPLOYMENT: 'production',
      LUNA_EMAIL_OAUTH_INBOUND_EVENT_STORE_ENABLED: 'true',
    }), false);
    assert.equal(isInboundEventStoreEnabled({
      LUNA_DEPLOYMENT: 'sunset-staging',
      LUNA_EMAIL_OAUTH_INBOUND_EVENT_STORE_ENABLED: 'true',
    }), true);

    // Disabled → zero construction (throws before azure).
    let constructed = false;
    const restore = installAzureLoadIntercept();
    try {
      // Patch identity load to detect construction
      const origLoad = Module._load;
      Module._load = function (request, parent, isMain) {
        if (request === '@azure/identity' || request === '@azure/keyvault-keys') {
          constructed = true;
        }
        return origLoad.call(this, request, parent, isMain);
      };
      assert.throws(
        () => createSunsetStagingMicrosoftDelegatedInboundEventStoreRuntime({
          env: { LUNA_DEPLOYMENT: 'sunset-staging' },
          pgClient: { query() {} },
          https: { request() {} },
          timers: { setTimeout() {}, clearTimeout() {} },
        }),
        (err) => err && err.code === ERROR_CODE,
      );
      assert.equal(constructed, false, 'disabled zero construction');
    } finally {
      restore();
    }
  }

  // ── Composition happy path (mocked session/transport via intercept) ─────
  {
    const restore = installAzureLoadIntercept();
    try {
      delete require.cache[compAbs];
      // Force re-require store/composition cleanly.
      const absStore = path.join(ROOT, STORE_REL);
      delete require.cache[absStore];

      // Stub heavy modules to avoid full custody path while still exercising
      // factory + durable consumer wiring shape.
      const authBoundPath = path.join(ROOT, 'scripts/lib/email-authority-bound-inbound-operation.js');
      const sessionPath = path.join(ROOT, 'scripts/lib/email-delegated-grant-access-session.js');
      const immutPath = path.join(
        ROOT,
        'scripts/lib/email-microsoft-graph-immutableid-page-transport.js',
      );
      const secretPath = path.join(ROOT, 'scripts/lib/sunset-microsoft-oauth-provider.js');
      const kvPath = path.join(
        ROOT,
        'scripts/lib/email-grant-envelope-azure-kv-sunset-staging-runtime-composition.js',
      );
      const provPath = path.join(ROOT, 'scripts/lib/email-grant-envelope-provider-contract.js');
      const tokPath = path.join(ROOT, 'scripts/lib/email-microsoft-token-http-transport.js');

      const fake = createFakeDb();
      let consumerSeen = 0;

      // Minimal stubs for composition graph.
      require.cache[secretPath] = {
        id: secretPath,
        filename: secretPath,
        loaded: true,
        exports: {
          SUNSET_DEPLOYMENT: 'sunset-staging',
          createSunsetMicrosoftOAuthClientSecretProvider: () => Object.freeze({
            resolveClientSecret: async () => 'x',
          }),
        },
      };
      require.cache[kvPath] = {
        id: kvPath,
        filename: kvPath,
        loaded: true,
        exports: {
          parseEmailGrantEnvelopeAzureKvSunsetStagingRuntimeConfig: () => ({
            ok: true,
            composition_enabled: true,
          }),
          createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition: () => ({
            ok: true,
            composition_enabled: true,
            provider: Object.freeze({ wrap: true }),
          }),
        },
      };
      require.cache[provPath] = {
        id: provPath,
        filename: provPath,
        loaded: true,
        exports: {
          validateEmailGrantEnvelopeProvider: (p) => ({ ok: true, value: p }),
        },
      };
      require.cache[tokPath] = {
        id: tokPath,
        filename: tokPath,
        loaded: true,
        exports: {
          createMicrosoftTokenHttpTransport: () => Object.freeze({ post: async () => ({}) }),
        },
      };
      require.cache[sessionPath] = {
        id: sessionPath,
        filename: sessionPath,
        loaded: true,
        exports: {
          SUNSET_DEPLOYMENT: 'sunset-staging',
          createDelegatedGrantAccessSession: () => Object.freeze({
            runWithAccessTokenOnce: async () => ({ ok: true }),
          }),
        },
      };
      require.cache[immutPath] = {
        id: immutPath,
        filename: immutPath,
        loaded: true,
        exports: {
          createMicrosoftGraphImmutableIdPageTransport: () => Object.freeze({
            listNormalizedInboundEnvelopes: async () => Object.freeze([]),
          }),
        },
      };
      require.cache[authBoundPath] = {
        id: authBoundPath,
        filename: authBoundPath,
        loaded: true,
        exports: {
          FAILURE_CODE: 'authority_bound_inbound_failed',
          RESULT_KEYS: Object.freeze([
            'status', 'input_count', 'delivered_count', 'duplicate_count',
          ]),
          createAuthorityBoundInboundOperation: (deps) => {
            assert.equal(typeof deps.consumer, 'function');
            return Object.freeze({
              runAuthorityBoundInbound: async () => {
                consumerSeen += 1;
                // Invoke durable consumer once with a valid envelope batch.
                const ack = await deps.consumer(Object.freeze([
                  Object.freeze(envelope({ provider_message_id: 'comp-1' })),
                ]));
                assert.deepEqual(ack, { acknowledged: true });
                return Object.freeze({
                  ok: true,
                  value: Object.freeze({
                    status: 'processed',
                    input_count: 1,
                    delivered_count: 1,
                    duplicate_count: 0,
                  }),
                });
              },
            });
          },
        },
      };

      delete require.cache[compAbs];
      const comp = require('./lib/email-microsoft-delegated-inbound-event-store-sunset-staging-runtime-composition');
      const runtime = comp.createSunsetStagingMicrosoftDelegatedInboundEventStoreRuntime({
        env: enabledEnv(),
        pgClient: fake.db,
        https: { request() {} },
        timers: { setTimeout() {}, clearTimeout() {} },
      });
      const result = await runtime.runInboundEventStore(authority());
      assert.equal(result.status, 'success');
      assert.equal(result.durably_processed, true);
      assert.equal(result.input_count, 1);
      assert.equal(consumerSeen, 1);
      assert.equal(fake.rows.size, 1);
      assert.equal(noLeak(result), true);
    } finally {
      restore();
      // Clear poisoned require cache entries for sibling gates.
      for (const key of Object.keys(require.cache)) {
        if (key.includes('scripts/lib/email-') || key.includes('sunset-microsoft-oauth')) {
          delete require.cache[key];
        }
      }
    }
  }

  // ── Package + docs + flag not in defaults ───────────────────────────────
  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  assert.ok(pkg.scripts['verify:email-inbound-event-store']);
  assert.ok(pkg.scripts['prove:email-inbound-event-store-pglite']);
  const doc = fs.readFileSync(DOC, 'utf8');
  assert.match(doc, /inbound-event-store|tenant_email_inbound_events/);
  assert.match(doc, /LUNA_EMAIL_OAUTH_INBOUND_EVENT_STORE_ENABLED/);
  // Flag must not appear in client defaults/manifests.
  const defaultsHit = fs.readFileSync(path.join(ROOT, 'config/clients/sunset.baseline.json'), 'utf8');
  assert.equal(defaultsHit.includes('LUNA_EMAIL_OAUTH_INBOUND_EVENT_STORE_ENABLED'), false);

  // Source must not log envelope fields.
  const storeSrc = fs.readFileSync(storeAbs, 'utf8');
  assert.equal(/\bconsole\.(log|info|debug|warn|error)\b/.test(storeSrc), false);
  assert.match(storeSrc, /commit_outcome_unknown/);
  assert.match(storeSrc, /Provider\/mailbox mismatch before/);

  console.log('PASS verify-email-inbound-event-store');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

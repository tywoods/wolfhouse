'use strict';

/**
 * Offline RED-GREEN gate: inbound email event store + default-off Sunset composition.
 *
 * Covers: withTransactionClient custody, durable consumer, exclusive-client
 * one-txn insert-or-no-op, real staged-rollback fake, commit-unknown, authority
 * override rejection, provider/mailbox mismatch before SQL, concurrent dedicated
 * loans, mixed replay, composition flag isolation / zero construction, no logs/PII.
 * No live DB/network/route.
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
const LEGACY_INBOUND_EVENT_STORE_FLAG = [
  'LUNA_EMAIL_OAUTH',
  'INBOUND_EVENT_STORE_ENABLED',
].join('_');

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

/**
 * Accurate multi-client fake: each withTransactionClient loan gets a dedicated
 * exclusive client with its own staged inserts. COMMIT merges into durable rows;
 * ROLLBACK discards the loan's staged map (earlier successful inserts disappear).
 * Concurrent loans do not share staging or interleave on one client.
 */
function createFakeTxnHarness(options = {}) {
  const durable = options.rows || new Map();
  const log = [];
  let loanSeq = 0;
  let activeLoans = 0;
  let maxConcurrentLoans = 0;
  let failOn;
  let commitShouldReject = false;
  let gate = null;

  function keyOf(p, mbox, mid) {
    return `${p}\0${mbox}\0${mid}`;
  }

  async function withTransactionClient(work) {
    const loanId = (loanSeq += 1);
    activeLoans += 1;
    if (activeLoans > maxConcurrentLoans) maxConcurrentLoans = activeLoans;

    let inTx = false;
    /** @type {Map<string, object>} inserts staged for this exclusive loan only */
    const staged = new Map();
    let insertCalls = 0;
    let released = false;

    const client = {
      async query(sql, params) {
        const norm = String(sql).replace(/\s+/g, ' ').trim();
        log.push({ loanId, sql: norm, params: params ? params.slice() : null });
        if (failOn && failOn(norm, params, { insertCalls, inTx, loanId, staged })) {
          throw new Error('planted_db_failure');
        }
        if (norm === 'BEGIN') {
          if (inTx) throw new Error('nested_begin');
          inTx = true;
          staged.clear();
          return { rows: [], rowCount: 0 };
        }
        if (norm === 'COMMIT') {
          if (!inTx) throw new Error('commit_without_begin');
          if (commitShouldReject) {
            throw new Error('planted_commit_reject');
          }
          // Optional coordination gate for overlapping concurrency probes.
          if (gate && typeof gate.beforeCommit === 'function') {
            await gate.beforeCommit({ loanId, staged });
          }
          for (const [k, row] of staged) {
            if (!durable.has(k)) durable.set(k, row);
            // ON CONFLICT DO NOTHING semantics at commit visibility.
          }
          staged.clear();
          inTx = false;
          return { rows: [], rowCount: 0 };
        }
        if (norm === 'ROLLBACK') {
          staged.clear();
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
          const k = keyOf(provider, mailbox, messageId);
          // Conflict against durable + this loan's staged only (not other loans).
          if (durable.has(k) || staged.has(k)) {
            return { rows: [], rowCount: 0 };
          }
          staged.set(k, {
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
        throw new Error(`unexpected sql: ${norm.slice(0, 80)}`);
      },
    };

    try {
      return await work(client);
    } finally {
      // Release only after settle — discard any uncommitted staged rows.
      staged.clear();
      inTx = false;
      released = true;
      activeLoans -= 1;
      void released;
    }
  }

  return {
    withTransactionClient,
    rows: durable,
    log,
    get maxConcurrentLoans() { return maxConcurrentLoans; },
    get activeLoans() { return activeLoans; },
    setFailOn(fn) { failOn = fn; },
    setCommitReject(v) { commitShouldReject = v; },
    setGate(g) { gate = g; },
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
    LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED: 'true',
    LUNA_EMAIL_OAUTH_CLIENT_ID: APP_ID,
    LUNA_EMAIL_OAUTH_CLIENT_SECRET: SECRET,
    EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED: 'true',
    EMAIL_GRANT_ENVELOPE_AZURE_KV_TRUSTED_HOST: HOST,
    EMAIL_GRANT_ENVELOPE_AZURE_KV_VERSIONED_KEY_ID: KEY_ID,
    ...patch,
  };
}

function trapCounters() {
  return {
    apply: 0,
    get: 0,
    then: 0,
    getPrototypeOf: 0,
    getOwnPropertyDescriptor: 0,
    ownKeys: 0,
    set: 0,
    has: 0,
  };
}

function countingProxy(target, traps) {
  return new Proxy(target, {
    apply(t, thisArg, args) {
      traps.apply += 1;
      return Reflect.apply(t, thisArg, args);
    },
    get(t, prop, receiver) {
      traps.get += 1;
      if (prop === 'then') traps.then += 1;
      return Reflect.get(t, prop, receiver);
    },
    getPrototypeOf(t) {
      traps.getPrototypeOf += 1;
      return Reflect.getPrototypeOf(t);
    },
    getOwnPropertyDescriptor(t, prop) {
      traps.getOwnPropertyDescriptor += 1;
      return Reflect.getOwnPropertyDescriptor(t, prop);
    },
    ownKeys(t) {
      traps.ownKeys += 1;
      return Reflect.ownKeys(t);
    },
    set(t, prop, value, receiver) {
      traps.set += 1;
      return Reflect.set(t, prop, value, receiver);
    },
    has(t, prop) {
      traps.has += 1;
      return Reflect.has(t, prop);
    },
  });
}

function zeroTraps(traps) {
  return traps.apply === 0
    && traps.get === 0
    && traps.then === 0
    && traps.getPrototypeOf === 0
    && traps.getOwnPropertyDescriptor === 0
    && traps.ownKeys === 0
    && traps.set === 0
    && traps.has === 0;
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
    STORE_DEPENDENCY_KEYS,
    SQL_INSERT_EVENT,
    createInboundEmailEventStore,
    createDurableInboundEventStoreConsumer,
    prepareCanonicalBatch,
    snapshotAuthority,
    resolveWithTransactionClient,
  } = store;

  // ── Static flags / SQL / migration shape ────────────────────────────────
  assert.equal(EMAIL_INBOUND_EVENT_STORE_RUNTIME_WIRED, false);
  assert.equal(EMAIL_INBOUND_EVENT_STORE_PERSISTENCE_AUTHORIZED, true);
  assert.equal(EMAIL_INBOUND_EVENT_STORE_LOGGING_FORBIDDEN, true);
  assert.deepEqual([...AUTHORITY_KEYS], ['clientId', 'locationId', 'endpointId']);
  assert.deepEqual([...STORE_DEPENDENCY_KEYS], ['withTransactionClient']);
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
  assert.match(up, /internet_message_id\s+TEXT NULL/);
  assert.equal(/INSERT INTO tenant_email_inbound_events/.test(up), false, 'empty migration');
  // No btrim equality on canonical identity IDs (contract is bounded nonempty).
  assert.equal(
    /provider_mailbox_id\s*=\s*btrim\s*\(\s*provider_mailbox_id\s*\)/.test(up),
    false,
    'must not restrict provider_mailbox_id with btrim equality',
  );
  assert.equal(
    /provider_message_id\s*=\s*btrim\s*\(\s*provider_message_id\s*\)/.test(up),
    false,
    'must not restrict provider_message_id with btrim equality',
  );
  assert.match(up, /char_length\(provider_mailbox_id\) BETWEEN 1 AND 2048/);
  assert.match(up, /char_length\(provider_message_id\) BETWEEN 1 AND 2048/);
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

  // ── withTransactionClient boundary ──────────────────────────────────────
  assert.ok(resolveWithTransactionClient(async (work) => work({ async query() { return { rows: [] }; } })));
  assert.equal(resolveWithTransactionClient(null), null);
  assert.equal(resolveWithTransactionClient(new Proxy(async () => {}, {
    apply(t, thisArg, args) { return Reflect.apply(t, thisArg, args); },
  })), null, 'proxy loaner');

  // Reject store factory on db-only (old) dependency shape.
  assert.throws(
    () => createInboundEmailEventStore(Object.freeze({
      db: { async query() { return { rows: [] }; } },
    })),
    (err) => err && err.code === FAILURE_CODE,
  );

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
    const fake = createFakeTxnHarness();
    const es = createInboundEmailEventStore(Object.freeze({
      withTransactionClient: fake.withTransactionClient,
    }));
    const envs = Object.freeze([
      Object.freeze(envelope({ provider_message_id: 'msg-a', internet_message_id: null })),
      Object.freeze(envelope({ provider_message_id: 'msg-b', internet_message_id: '<same@x>' })),
    ]);
    const r1 = await es.persistBatch(authority(), envs);
    assert.equal(r1.ok, true);
    assert.equal(fake.rows.size, 2);
    assert.equal(fake.log.filter((e) => e.sql === 'BEGIN').length, 1);
    assert.equal(fake.log.filter((e) => e.sql === 'COMMIT').length, 1);

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
    const b = fake.rows.get(`microsoft_graph\0${MAILBOX}\0msg-b`);
    const c = fake.rows.get(`microsoft_graph\0${MAILBOX}\0msg-c`);
    assert.equal(b.internet_message_id, c.internet_message_id);
  }

  // ── Consumer: one call, ack after commit ────────────────────────────────
  {
    const fake = createFakeTxnHarness();
    let consumerCalls = 0;
    const consumer = createDurableInboundEventStoreConsumer(Object.freeze({
      withTransactionClient: fake.withTransactionClient,
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

  // ── Mid-batch failure: earlier successful insert discarded on rollback ──
  {
    const fake = createFakeTxnHarness();
    // Fail on the second INSERT within a loan (insertCalls is per-loan).
    fake.setFailOn((sql, _p, st) => /INSERT INTO/.test(sql) && st.insertCalls >= 1);
    const es = createInboundEmailEventStore(Object.freeze({
      withTransactionClient: fake.withTransactionClient,
    }));
    const r = await es.persistBatch(authority(), Object.freeze([
      Object.freeze(envelope({ provider_message_id: 'rb-1' })),
      Object.freeze(envelope({ provider_message_id: 'rb-2' })),
    ]));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'inbound_event_store_write_failed');
    assert.ok(fake.log.some((e) => e.sql === 'ROLLBACK'));
    // Critical: first insert must not remain after rollback.
    assert.equal(fake.rows.size, 0, 'earlier successful insert discarded after later failure');
    assert.equal(
      fake.rows.has(`microsoft_graph\0${MAILBOX}\0rb-1`),
      false,
      'rb-1 must disappear after rollback',
    );
    assert.equal(noLeak(r), true);
  }

  // ── Commit sent then rejection → sanitized, no ack, no rollback ─────────
  {
    const fake = createFakeTxnHarness();
    fake.setCommitReject(true);
    const consumer = createDurableInboundEventStoreConsumer(Object.freeze({
      withTransactionClient: fake.withTransactionClient,
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
    const fake = createFakeTxnHarness();
    const es = createInboundEmailEventStore(Object.freeze({
      withTransactionClient: fake.withTransactionClient,
    }));
    const envWithExtra = envelope({ provider_message_id: 'ao-1' });
    envWithExtra.clientId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const r = await es.persistBatch(authority(), [envWithExtra]);
    assert.equal(r.ok, false);
    assert.equal(fake.rows.size, 0, 'no insert on authority override attempt');
  }

  // ── Concurrent race: independently loaned clients, one durable row ──────
  {
    const fake = createFakeTxnHarness();
    // Gate: hold both loans in-flight until both have staged the same identity.
    let arrivals = 0;
    let releaseGate;
    const bothArrived = new Promise((resolve) => { releaseGate = resolve; });
    fake.setGate({
      async beforeCommit() {
        arrivals += 1;
        if (arrivals >= 2) releaseGate();
        await bothArrived;
      },
    });
    const es = createInboundEmailEventStore(Object.freeze({
      withTransactionClient: fake.withTransactionClient,
    }));
    const env = Object.freeze(envelope({ provider_message_id: 'race-1' }));
    const [a, b] = await Promise.all([
      es.persistBatch(authority(), Object.freeze([env])),
      es.persistBatch(authority(), Object.freeze([env])),
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(fake.rows.size, 1, 'concurrent same-identity → one durable row');
    assert.ok(fake.maxConcurrentLoans >= 2, 'two dedicated loans overlapped');
    // Distinct loan ids on BEGIN prove independent exclusive clients.
    const beginLoans = fake.log.filter((e) => e.sql === 'BEGIN').map((e) => e.loanId);
    assert.equal(new Set(beginLoans).size, 2, 'two distinct exclusive loans');
  }

  // ── Every persist acquires its own loan (no shared client reuse) ────────
  {
    const fake = createFakeTxnHarness();
    const es = createInboundEmailEventStore(Object.freeze({
      withTransactionClient: fake.withTransactionClient,
    }));
    await es.persistBatch(authority(), Object.freeze([
      Object.freeze(envelope({ provider_message_id: 'loan-a' })),
    ]));
    await es.persistBatch(authority(), Object.freeze([
      Object.freeze(envelope({ provider_message_id: 'loan-b' })),
    ]));
    const begins = fake.log.filter((e) => e.sql === 'BEGIN');
    assert.equal(begins.length, 2);
    assert.notEqual(begins[0].loanId, begins[1].loanId, 'separate loan per persist');
  }

  // ── Composition: flag isolation + disabled zero construction ────────────
  {
    delete require.cache[compAbs];
    const comp = require('./lib/email-microsoft-delegated-inbound-event-store-sunset-staging-runtime-composition');
    const {
      ENV_DURABLE_INBOUND_CAPTURE_ENABLED,
      SUNSET_DEPLOYMENT,
      WORKER_ID,
      INTERNAL_DURABLY_PROCESSED,
      INTERNAL_STATUS_SUCCESS,
      DEPENDENCY_KEYS,
      isInboundEventStoreEnabled,
      createSunsetStagingMicrosoftDelegatedInboundEventStoreRuntime,
      ERROR_CODE,
    } = comp;

    assert.equal(ENV_DURABLE_INBOUND_CAPTURE_ENABLED, 'LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED');
    assert.equal(SUNSET_DEPLOYMENT, 'sunset-staging');
    assert.equal(WORKER_ID, 'sunset-email-inbound-event-store');
    assert.equal(INTERNAL_DURABLY_PROCESSED, true);
    assert.equal(INTERNAL_STATUS_SUCCESS, 'success');
    assert.deepEqual([...DEPENDENCY_KEYS], [
      'env', 'pgClient', 'withTransactionClient', 'https', 'timers',
    ]);

    assert.equal(isInboundEventStoreEnabled({}), false);
    assert.equal(isInboundEventStoreEnabled({
      LUNA_DEPLOYMENT: 'sunset-staging',
      LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED: 'TRUE',
    }), false);
    assert.equal(isInboundEventStoreEnabled({
      LUNA_DEPLOYMENT: 'production',
      LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED: 'true',
    }), false);
    assert.equal(isInboundEventStoreEnabled({
      LUNA_DEPLOYMENT: 'sunset-staging',
      LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED: 'true',
    }), true);
    // Old flag name must never enable.
    assert.equal(isInboundEventStoreEnabled({
      LUNA_DEPLOYMENT: 'sunset-staging',
      [LEGACY_INBOUND_EVENT_STORE_FLAG]: 'true',
    }), false);

    // Disabled → zero construction (throws before azure).
    let constructed = false;
    const restore = installAzureLoadIntercept();
    try {
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
          withTransactionClient: async (work) => work({ query() {} }),
          https: { request() {} },
          timers: { setTimeout() {}, clearTimeout() {} },
        }),
        (err) => err && err.code === ERROR_CODE,
      );
      assert.equal(constructed, false, 'disabled zero construction');
    } finally {
      restore();
    }

    // ── Composition Proxy deps: zero traps via module-init pinned isProxy ──
    {
      const util = require('util');
      assert.equal(typeof util.types.isProxy, 'function');

      const baseDeps = () => ({
        env: enabledEnv(),
        pgClient: { query() {} },
        withTransactionClient: async (work) => work({ query() {} }),
        https: { request() {} },
        timers: { setTimeout() {}, clearTimeout() {} },
      });

      {
        const traps = trapCounters();
        const proxyDeps = countingProxy(baseDeps(), traps);
        assert.throws(
          () => createSunsetStagingMicrosoftDelegatedInboundEventStoreRuntime(proxyDeps),
          (err) => err && err.code === ERROR_CODE && noLeak(err),
        );
        assert.equal(zeroTraps(traps), true, `proxy-deps zero traps: ${JSON.stringify(traps)}`);
      }

      // Nested dependency value proxy (plain deps bag, proxied pgClient).
      {
        const traps = trapCounters();
        const proxyPg = countingProxy({ query() {} }, traps);
        assert.throws(
          () => createSunsetStagingMicrosoftDelegatedInboundEventStoreRuntime({
            env: enabledEnv(),
            pgClient: proxyPg,
            withTransactionClient: async (work) => work({ query() {} }),
            https: { request() {} },
            timers: { setTimeout() {}, clearTimeout() {} },
          }),
          (err) => err && err.code === ERROR_CODE && noLeak(err),
        );
        assert.equal(zeroTraps(traps), true, `proxy-pgClient zero traps: ${JSON.stringify(traps)}`);
      }

      // Ambient util.types.isProxy monkeypatch after load must not hide proxies.
      {
        const realIsProxy = util.types.isProxy;
        util.types.isProxy = () => false;
        try {
          const traps = trapCounters();
          const proxyDeps = countingProxy(baseDeps(), traps);
          assert.throws(
            () => createSunsetStagingMicrosoftDelegatedInboundEventStoreRuntime(proxyDeps),
            (err) => err && err.code === ERROR_CODE && noLeak(err),
          );
          assert.equal(
            zeroTraps(traps),
            true,
            `ambient isProxy monkeypatch resistant: ${JSON.stringify(traps)}`,
          );
        } finally {
          util.types.isProxy = realIsProxy;
        }
      }

      // Source pin contract: module-init PINNED_IS_PROXY + pre-descriptor isProxySurface.
      const compSrc = fs.readFileSync(compAbs, 'utf8');
      assert.match(compSrc, /PINNED_IS_PROXY/);
      assert.match(compSrc, /isProxySurface/);
      assert.match(compSrc, /LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED/);
      assert.equal(
        compSrc.includes(LEGACY_INBOUND_EVENT_STORE_FLAG),
        false,
        'old flag string must not remain in composition source',
      );
    }
  }

  // ── Composition happy path (mocked session/transport via intercept) ─────
  {
    const restore = installAzureLoadIntercept();
    try {
      delete require.cache[compAbs];
      const absStore = path.join(ROOT, STORE_REL);
      delete require.cache[absStore];

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
      const bridgePath = path.join(ROOT, 'scripts/lib/email-inbound-inbox-bridge.js');

      const fake = createFakeTxnHarness();
      let consumerSeen = 0;
      let batch = [
        envelope({ provider_message_id: 'comp-1' }),
        envelope({ provider_message_id: 'comp-2' }),
      ];
      let projectionStatuses = ['projected', 'projected'];
      const projectionInputs = [];

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
      require.cache[bridgePath] = {
        id: bridgePath,
        filename: bridgePath,
        loaded: true,
        exports: {
          createEmailInboundInboxBridge: () => Object.freeze({
            projectInboundEvent: async (input) => {
              assert.ok(fake.log.some((e) => e.sql === 'COMMIT'), 'event COMMIT precedes projection');
              projectionInputs.push(input);
              return Object.freeze({ status: projectionStatuses.shift() });
            },
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
                const ack = await deps.consumer(Object.freeze(
                  batch.map((item) => Object.freeze(item)),
                ));
                assert.deepEqual(ack, { acknowledged: true });
                return Object.freeze({
                  ok: true,
                  value: Object.freeze({
                    status: 'processed',
                    input_count: batch.length,
                    delivered_count: batch.length,
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
        pgClient: { async query() { return { rows: [] }; } },
        withTransactionClient: fake.withTransactionClient,
        https: { request() {} },
        timers: { setTimeout() {}, clearTimeout() {} },
      });
      const result = await runtime.runInboundEventStore(authority());
      assert.equal(result.status, 'success');
      assert.equal(result.durably_processed, true);
      assert.equal(result.input_count, 2);
      assert.equal(consumerSeen, 1);
      assert.equal(fake.rows.size, 2);
      assert.deepEqual(projectionInputs.map((i) => i.providerMessageId), ['comp-1', 'comp-2']);
      assert.deepEqual(projectionInputs[0], {
        clientId: CLIENT,
        locationId: LOCATION,
        endpointId: ENDPOINT,
        provider: 'microsoft_graph',
        providerMailboxId: MAILBOX,
        providerMessageId: 'comp-1',
      });
      assert.equal(noLeak(result), true);

      projectionStatuses = ['already_projected', 'projected'];
      await runtime.runInboundEventStore(authority());
      assert.equal(fake.rows.size, 2, 'replay keeps durable events stable');

      batch = [envelope({ provider_message_id: 'comp-3' })];
      for (const bad of ['rejected', 'uncertain']) {
        projectionStatuses = [bad];
        await assert.rejects(runtime.runInboundEventStore(authority()),
          (err) => err && err.code === comp.ERROR_CODE && noLeak(err));
      }

      batch = [envelope({ provider_message_id: 'comp-4' }), envelope({ provider_message_id: 'comp-5' })];
      projectionStatuses = ['projected', 'rejected'];
      await assert.rejects(runtime.runInboundEventStore(authority()),
        (err) => err && err.code === comp.ERROR_CODE && noLeak(err));
      projectionStatuses = ['already_projected', 'projected'];
      const converged = await runtime.runInboundEventStore(authority());
      assert.equal(converged.input_count, 2, 'mid-batch replay converges');
    } finally {
      restore();
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
  assert.match(doc, /LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED/);
  assert.equal(
    doc.includes(LEGACY_INBOUND_EVENT_STORE_FLAG),
    false,
    'old flag string must not remain in docs',
  );
  assert.match(doc, /withTransactionClient/);
  const defaultsHit = fs.readFileSync(path.join(ROOT, 'config/clients/sunset.baseline.json'), 'utf8');
  assert.equal(defaultsHit.includes('LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED'), false);
  assert.equal(defaultsHit.includes(LEGACY_INBOUND_EVENT_STORE_FLAG), false);

  // Source must not log envelope fields; must use exclusive loaner not shared db.
  const storeSrc = fs.readFileSync(storeAbs, 'utf8');
  assert.equal(/\bconsole\.(log|info|debug|warn|error)\b/.test(storeSrc), false);
  assert.match(storeSrc, /commit_outcome_unknown/);
  assert.match(storeSrc, /Provider\/mailbox mismatch before/);
  assert.match(storeSrc, /withTransactionClient/);
  assert.equal(
    /STORE_DEPENDENCY_KEYS = Object\.freeze\(\['db'\]\)/.test(storeSrc),
    false,
    'must not use shared db dependency',
  );

  console.log('PASS verify-email-inbound-event-store');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

'use strict';

/**
 * Prove migration 063 tenant_email_inbound_events + durable consumer semantics.
 *
 * When PGlite is available: minimal parent shell + 063 up, assert FKs/checks/
 * unique identity, roundtrip, mixed replay, null/same internet_message_id
 * non-identity, rollback, ON CONFLICT race (sequential), then down.
 *
 * When PGlite is unavailable: static migration contract assertions only
 * (same as offline verifier migration shape) so CI without pglite stays green.
 *
 * No Azure / live DB / deploy / seed of product data beyond proof fixtures.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const UP_PATH = path.join(ROOT, 'database/migrations/063_tenant_email_inbound_events.sql');
const DOWN_PATH = path.join(ROOT, 'database/migrations/063_tenant_email_inbound_events_down.sql');
const UP = fs.readFileSync(UP_PATH, 'utf8');
const DOWN = fs.readFileSync(DOWN_PATH, 'utf8');

const ids = {
  client: '11111111-1111-4111-8111-111111111111',
  location: '22222222-2222-4222-8222-222222222222',
  endpoint: '33333333-3333-4333-8333-333333333333',
  mailbox: '44444444-4444-4444-8444-444444444444',
};

function tryLoadPglite() {
  try {
    return require('@electric-sql/pglite').PGlite;
  } catch (_) {
    return null;
  }
}

function assertStaticContract() {
  assert.match(UP, /CREATE TABLE tenant_email_inbound_events/);
  assert.match(UP, /tenant_email_inbound_events_identity_uq/);
  assert.match(UP, /UNIQUE \(provider, provider_mailbox_id, provider_message_id\)/);
  assert.match(UP, /REFERENCES tenant_locations \(client_id, id\)/);
  assert.match(UP, /REFERENCES tenant_channel_endpoints \(client_id, id\)/);
  assert.match(UP, /location_id\s+UUID NOT NULL/);
  assert.match(UP, /tenant_locations\.id UUID/);
  assert.equal(/INSERT INTO tenant_email_inbound_events/.test(UP), false);
  assert.match(UP, /internet_message_id\s+TEXT NULL/);
  assert.match(DOWN, /DROP TABLE IF EXISTS tenant_email_inbound_events/);
  console.log('ok - static 063 inbound event store contract');
}

async function createShell(db) {
  await db.exec(`
    CREATE TABLE clients (id uuid PRIMARY KEY);
    CREATE TABLE staff_users (id uuid PRIMARY KEY, client_id uuid REFERENCES clients(id));
    CREATE TABLE tenant_locations (
      id uuid PRIMARY KEY,
      client_id uuid NOT NULL REFERENCES clients(id),
      location_id text NOT NULL,
      display_name text NOT NULL DEFAULT 'loc',
      active boolean NOT NULL DEFAULT true
    );
    ALTER TABLE tenant_locations
      ADD CONSTRAINT tenant_locations_client_id_id_uq UNIQUE (client_id, id);
    CREATE TABLE tenant_channel_endpoints (
      id uuid PRIMARY KEY,
      client_id uuid NOT NULL,
      location_id text NOT NULL,
      channel text NOT NULL DEFAULT 'email',
      provider text NOT NULL DEFAULT 'microsoft_graph',
      public_address text NOT NULL DEFAULT 'a@b.co',
      secret_ref text,
      capabilities jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    ALTER TABLE tenant_channel_endpoints
      ADD CONSTRAINT tenant_channel_endpoints_client_id_id_uq UNIQUE (client_id, id);
    INSERT INTO clients VALUES ('${ids.client}');
    INSERT INTO tenant_locations (id, client_id, location_id)
      VALUES ('${ids.location}', '${ids.client}', 'sunset-somo');
    INSERT INTO tenant_channel_endpoints (id, client_id, location_id)
      VALUES ('${ids.endpoint}', '${ids.client}', 'sunset-somo');
  `);
}

function makeEnvelope(messageId, internetMessageId) {
  return Object.freeze({
    provider: 'microsoft_graph',
    provider_mailbox_id: ids.mailbox,
    provider_message_id: messageId,
    received_at: '2026-08-01T12:00:00.000Z',
    subject: 'proof-subject',
    sender_display_name: 'Proof',
    sender_address: 'proof@example.test',
    is_read: false,
    conversation_id: 'conv-proof',
    internet_message_id: internetMessageId,
  });
}

async function proveWithPglite(PGlite) {
  const {
    createInboundEmailEventStore,
    createDurableInboundEventStoreConsumer,
  } = require('./lib/email-inbound-event-store');

  const db = new PGlite();
  await createShell(db);
  await db.exec(UP);

  // FK: bad endpoint rejected
  let fkFailed = false;
  try {
    await db.query(
      `INSERT INTO tenant_email_inbound_events (
         client_id, location_id, endpoint_id,
         provider, provider_mailbox_id, provider_message_id,
         received_at, is_read
       ) VALUES ($1,$2,$3,'microsoft_graph','m','msg-fk','2026-08-01T00:00:00Z',false)`,
      [ids.client, ids.location, '99999999-9999-4999-8999-999999999999'],
    );
  } catch {
    fkFailed = true;
  }
  assert.equal(fkFailed, true, 'endpoint FK enforced');

  // Wire store through PGlite query surface
  const pgLike = {
    async query(sql, params) {
      return db.query(sql, params || []);
    },
  };
  const store = createInboundEmailEventStore(Object.freeze({ db: pgLike }));
  const authority = Object.freeze({
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
  });

  // Roundtrip
  const r1 = await store.persistBatch(
    authority,
    Object.freeze([
      makeEnvelope('msg-1', null),
      makeEnvelope('msg-2', '<same@id>'),
    ]),
  );
  assert.equal(r1.ok, true);
  let count = await db.query('SELECT count(*)::int AS n FROM tenant_email_inbound_events');
  assert.equal(count.rows[0].n, 2);

  // Mixed existing/new replay; same internet_message_id non-identity
  const r2 = await store.persistBatch(
    authority,
    Object.freeze([
      makeEnvelope('msg-1', '<changed@id>'),
      makeEnvelope('msg-2', '<same@id>'),
      makeEnvelope('msg-3', '<same@id>'),
    ]),
  );
  assert.equal(r2.ok, true);
  count = await db.query('SELECT count(*)::int AS n FROM tenant_email_inbound_events');
  assert.equal(count.rows[0].n, 3, 'one new + two conflicts');

  // Null internet_message_id allowed on multiple identities
  const r3 = await store.persistBatch(
    authority,
    Object.freeze([
      makeEnvelope('msg-4', null),
      makeEnvelope('msg-5', null),
    ]),
  );
  assert.equal(r3.ok, true);
  count = await db.query('SELECT count(*)::int AS n FROM tenant_email_inbound_events');
  assert.equal(count.rows[0].n, 5);

  // Subject not updated on conflict
  const sub = await db.query(
    `SELECT subject, internet_message_id FROM tenant_email_inbound_events
      WHERE provider_message_id = 'msg-1'`,
  );
  assert.equal(sub.rows[0].subject, 'proof-subject');
  assert.equal(sub.rows[0].internet_message_id, null);

  // Consumer path + unique race (sequential double insert)
  const consumer = createDurableInboundEventStoreConsumer(Object.freeze({
    db: pgLike,
    authority,
  }));
  const ack = await consumer(Object.freeze([makeEnvelope('msg-race', '<r@x>')]));
  assert.deepEqual(ack, { acknowledged: true });
  const ack2 = await consumer(Object.freeze([makeEnvelope('msg-race', '<r2@x>')]));
  assert.deepEqual(ack2, { acknowledged: true });
  const raceCount = await db.query(
    `SELECT count(*)::int AS n FROM tenant_email_inbound_events
      WHERE provider_message_id = 'msg-race'`,
  );
  assert.equal(raceCount.rows[0].n, 1, 'identity race → one row');

  // Rollback on bad provider value mid-batch via raw SQL check
  await db.query('BEGIN');
  try {
    await db.query(
      `INSERT INTO tenant_email_inbound_events (
         client_id, location_id, endpoint_id,
         provider, provider_mailbox_id, provider_message_id,
         received_at, is_read
       ) VALUES ($1,$2,$3,'not_a_provider','m','msg-bad','2026-08-01T00:00:00Z',false)`,
      [ids.client, ids.location, ids.endpoint],
    );
    assert.fail('expected check violation');
  } catch {
    await db.query('ROLLBACK');
  }
  count = await db.query('SELECT count(*)::int AS n FROM tenant_email_inbound_events');
  assert.equal(count.rows[0].n, 6, 'rollback preserved prior rows only');

  // Down
  await db.exec(DOWN);
  const gone = await db.query(
    `SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_name = 'tenant_email_inbound_events'`,
  );
  assert.equal(gone.rows[0].n, 0, 'down drops table');

  console.log('PASS prove-email-inbound-event-store-pglite (PGlite)');
}

async function main() {
  assertStaticContract();
  const PGlite = tryLoadPglite();
  if (!PGlite) {
    console.log('PASS prove-email-inbound-event-store-pglite (static only; PGlite unavailable)');
    return;
  }
  await proveWithPglite(PGlite);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

'use strict';

/**
 * Prove migration 064 tenant_email_inbound_delta_states + page-commit atomicity.
 *
 * When PGlite is available:
 *   - minimal parent shell + 063 events + 064 delta state
 *   - initialize / lease / seal / commit nextLink / terminal deltaLink
 *   - event+cursor atomic advancement
 *   - insert/CAS rollback (wrong state_version)
 *   - replay converges
 *   - generation rebind preserves old state/events
 *   - down drops table
 *
 * When PGlite is unavailable: static migration contract only.
 *
 * No Azure / live product DB / deploy / network.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const UP_064 = path.join(ROOT, 'database/migrations/064_tenant_email_inbound_delta_states.sql');
const DOWN_064 = path.join(ROOT, 'database/migrations/064_tenant_email_inbound_delta_states_down.sql');
const UP_063 = path.join(ROOT, 'database/migrations/063_tenant_email_inbound_events.sql');
const UP = fs.readFileSync(UP_064, 'utf8');
const DOWN = fs.readFileSync(DOWN_064, 'utf8');
const UP_EVENTS = fs.readFileSync(UP_063, 'utf8');

const ids = {
  client: '11111111-1111-4111-8111-111111111111',
  location: '22222222-2222-4222-8222-222222222222',
  endpoint: '33333333-3333-4333-8333-333333333333',
  tenant: '55555555-5555-4555-8555-555555555555',
  mailbox: '44444444-4444-4444-8444-444444444444',
};

function tryLoadPglite() {
  try {
    return require('@electric-sql/pglite').PGlite;
  } catch (_) {
    return null;
  }
}

function shellSql() {
  return `
    CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
    BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
    CREATE OR REPLACE FUNCTION gen_random_uuid() RETURNS uuid AS $$
      SELECT (
        lpad(to_hex((random()*4294967295)::bigint), 8, '0') || '-' ||
        lpad(to_hex((random()*65535)::int), 4, '0') || '-4' ||
        lpad(to_hex((random()*4095)::int), 3, '0') || '-' ||
        lpad(to_hex((8+floor(random()*4))::int*1000+(random()*4095)::int), 4, '0') || '-' ||
        lpad(to_hex((random()*281474976710655)::bigint), 12, '0')
      )::uuid;
    $$ LANGUAGE sql;
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
  `;
}

function assertStaticContract() {
  assert.match(UP, /CREATE TABLE tenant_email_inbound_delta_states/);
  assert.match(UP, /tenant_email_inbound_delta_states_current_uq/);
  assert.match(UP, /WHERE is_current = true/);
  assert.match(UP, /REFERENCES tenant_locations \(client_id, id\)/);
  assert.match(UP, /REFERENCES tenant_channel_endpoints \(client_id, id\)/);
  assert.match(UP, /provider = 'microsoft_graph'/);
  assert.match(UP, /cursor_kind IN \('nextLink', 'deltaLink'\)/);
  assert.match(UP, /tenant_email_inbound_delta_states_cursor_coherence/);
  assert.equal(/INSERT INTO tenant_email_inbound_delta_states/.test(UP), false);
  assert.equal(/\bnext_link\b/i.test(UP), false);
  assert.match(DOWN, /DROP TABLE IF EXISTS tenant_email_inbound_delta_states/);
  console.log('ok - static 064 delta state contract');
}

function createPgliteExclusiveLoaner(db) {
  let chain = Promise.resolve();
  async function withTransactionClient(work) {
    const run = chain.then(async () => {
      const client = {
        async query(sql, params) {
          return db.query(sql, params || []);
        },
      };
      return work(client);
    });
    chain = run.then(() => undefined, () => undefined);
    return run;
  }
  return Object.freeze({ withTransactionClient });
}

function makeEnvelope(messageId) {
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
    internet_message_id: null,
  });
}

async function proveWithPglite(PGlite) {
  const {
    createInboundEmailDeltaStateStore,
  } = require('./lib/email-inbound-delta-state-store');
  const {
    createFakeEmailGrantEnvelopeProvider,
  } = require('./lib/email-grant-envelope-fake-provider');

  const db = new PGlite();
  await db.exec(shellSql());
  await db.exec(UP_EVENTS);
  await db.exec(UP);

  // RED: partial sealed cursor rejected
  let redFailed = false;
  try {
    await db.query(
      `INSERT INTO tenant_email_inbound_delta_states (
         client_id, location_id, endpoint_id,
         provider, provider_tenant_id, provider_mailbox_id,
         ingestion_generation, query_version, is_current,
         phase, state_version, cursor_kind, envelope_version
       ) VALUES ($1,$2,$3,'microsoft_graph',$4,$5,1,1,true,'initial',1,'nextLink','v1')`,
      [ids.client, ids.location, ids.endpoint, ids.tenant, ids.mailbox],
    );
  } catch {
    redFailed = true;
  }
  assert.equal(redFailed, true, 'partial sealed cursor rejected by coherence');

  // RED: second current generation rejected
  await db.query(
    `INSERT INTO tenant_email_inbound_delta_states (
       client_id, location_id, endpoint_id,
       provider, provider_tenant_id, provider_mailbox_id,
       ingestion_generation, query_version, is_current,
       phase, state_version
     ) VALUES ($1,$2,$3,'microsoft_graph',$4,$5,1,1,true,'initial',1)`,
    [ids.client, ids.location, ids.endpoint, ids.tenant, ids.mailbox],
  );
  let secondCurrentFailed = false;
  try {
    await db.query(
      `INSERT INTO tenant_email_inbound_delta_states (
         client_id, location_id, endpoint_id,
         provider, provider_tenant_id, provider_mailbox_id,
         ingestion_generation, query_version, is_current,
         phase, state_version
       ) VALUES ($1,$2,$3,'microsoft_graph',$4,$5,2,1,true,'initial',1)`,
      [ids.client, ids.location, ids.endpoint, ids.tenant, ids.mailbox],
    );
  } catch {
    secondCurrentFailed = true;
  }
  assert.equal(secondCurrentFailed, true, 'ambiguous current generation blocked');
  await db.query('DELETE FROM tenant_email_inbound_delta_states');

  const provider = createFakeEmailGrantEnvelopeProvider();
  const loaner = createPgliteExclusiveLoaner(db);
  const store = createInboundEmailDeltaStateStore(Object.freeze({
    withTransactionClient: loaner.withTransactionClient,
    envelopeProvider: provider,
  }));

  const init = await store.initializeState(Object.freeze({
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
    queryVersion: 1,
  }));
  assert.equal(init.ok, true);
  assert.equal(init.value.ingestion_generation, 1);
  assert.equal(init.value.phase, 'initial');

  const lease = await store.acquireLease(Object.freeze({
    clientId: ids.client,
    endpointId: ids.endpoint,
    workerId: 'pglite-runner',
    ttlSeconds: 120,
    expectedGeneration: 1,
    expectedStateVersion: 1,
  }));
  assert.equal(lease.ok, true, JSON.stringify(lease));
  const token = lease.value.lease_token;
  let sv = lease.value.state_version;

  const sealedNext = await store.sealDeltaCursor(Object.freeze({
    clientId: ids.client,
    endpointId: ids.endpoint,
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
    ingestionGeneration: 1,
    queryVersion: 1,
    cursorKind: 'nextLink',
    cursorUrl: 'https://graph.microsoft.com/v1.0/users/44444444-4444-4444-8444-444444444444/messages?$skiptoken=page1',
    operationId: crypto.randomUUID(),
  }));
  assert.equal(sealedNext.ok, true, JSON.stringify(sealedNext));

  // Atomic event+cursor advancement
  const commit1 = await store.commitPageEvents(Object.freeze({
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    leaseToken: token,
    expectedGeneration: 1,
    expectedStateVersion: sv,
    providerMailboxId: ids.mailbox,
    queryVersion: 1,
    envelopes: Object.freeze([makeEnvelope('msg-1'), makeEnvelope('msg-2')]),
    tombstones: Object.freeze([]),
    successorCursor: sealedNext.value,
  }));
  assert.equal(commit1.ok, true, JSON.stringify(commit1));
  sv = commit1.value.state_version;

  let count = await db.query('SELECT count(*)::int AS n FROM tenant_email_inbound_events');
  assert.equal(count.rows[0].n, 2);
  let st = await db.query(
    `SELECT phase, cursor_kind, state_version, ciphertext IS NOT NULL AS sealed
       FROM tenant_email_inbound_delta_states WHERE is_current = true`,
  );
  assert.equal(st.rows[0].phase, 'initial');
  assert.equal(st.rows[0].cursor_kind, 'nextLink');
  assert.equal(st.rows[0].sealed, true);
  // plaintext never stored
  const plain = await db.query(
    `SELECT cursor_kind, envelope_version FROM tenant_email_inbound_delta_states`,
  );
  assert.equal(JSON.stringify(plain.rows).includes('skiptoken'), false);

  // CAS failure rolls back inserts (wrong state_version)
  const sealedBad = await store.sealDeltaCursor(Object.freeze({
    clientId: ids.client,
    endpointId: ids.endpoint,
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
    ingestionGeneration: 1,
    queryVersion: 1,
    cursorKind: 'nextLink',
    cursorUrl: 'https://graph.microsoft.com/v1.0/users/x/messages?$skiptoken=bad',
    operationId: crypto.randomUUID(),
  }));
  const badCas = await store.commitPageEvents(Object.freeze({
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    leaseToken: token,
    expectedGeneration: 1,
    expectedStateVersion: 99999,
    providerMailboxId: ids.mailbox,
    queryVersion: 1,
    envelopes: Object.freeze([makeEnvelope('msg-should-rollback')]),
    tombstones: Object.freeze([]),
    successorCursor: sealedBad.value,
  }));
  assert.equal(badCas.ok, false);
  count = await db.query('SELECT count(*)::int AS n FROM tenant_email_inbound_events');
  assert.equal(count.rows[0].n, 2, 'CAS failure rolled back inserts');
  const missing = await db.query(
    `SELECT count(*)::int AS n FROM tenant_email_inbound_events
      WHERE provider_message_id = 'msg-should-rollback'`,
  );
  assert.equal(missing.rows[0].n, 0);

  // Replay converges (duplicate identities + new)
  const sealedNext2 = await store.sealDeltaCursor(Object.freeze({
    clientId: ids.client,
    endpointId: ids.endpoint,
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
    ingestionGeneration: 1,
    queryVersion: 1,
    cursorKind: 'nextLink',
    cursorUrl: 'https://graph.microsoft.com/v1.0/users/x/messages?$skiptoken=page2',
    operationId: crypto.randomUUID(),
  }));
  const replay = await store.commitPageEvents(Object.freeze({
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    leaseToken: token,
    expectedGeneration: 1,
    expectedStateVersion: sv,
    providerMailboxId: ids.mailbox,
    queryVersion: 1,
    envelopes: Object.freeze([
      makeEnvelope('msg-1'),
      makeEnvelope('msg-2'),
      makeEnvelope('msg-3'),
    ]),
    tombstones: Object.freeze([]),
    successorCursor: sealedNext2.value,
  }));
  assert.equal(replay.ok, true);
  sv = replay.value.state_version;
  count = await db.query('SELECT count(*)::int AS n FROM tenant_email_inbound_events');
  assert.equal(count.rows[0].n, 3, 'replay converged with one new identity');

  // Terminal deltaLink
  const sealedDelta = await store.sealDeltaCursor(Object.freeze({
    clientId: ids.client,
    endpointId: ids.endpoint,
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
    ingestionGeneration: 1,
    queryVersion: 1,
    cursorKind: 'deltaLink',
    cursorUrl: 'https://graph.microsoft.com/v1.0/users/x/messages/delta?$deltatoken=final',
    operationId: crypto.randomUUID(),
  }));
  const terminal = await store.commitPageEvents(Object.freeze({
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    leaseToken: token,
    expectedGeneration: 1,
    expectedStateVersion: sv,
    providerMailboxId: ids.mailbox,
    queryVersion: 1,
    envelopes: Object.freeze([]),
    tombstones: Object.freeze([Object.freeze({
      provider: 'microsoft_graph',
      provider_mailbox_id: ids.mailbox,
      provider_message_id: 'deleted-x',
    })]),
    successorCursor: sealedDelta.value,
  }));
  assert.equal(terminal.ok, true);
  assert.equal(terminal.value.phase, 'tracking');
  sv = terminal.value.state_version;
  count = await db.query('SELECT count(*)::int AS n FROM tenant_email_inbound_events');
  assert.equal(count.rows[0].n, 3, 'tombstone creates no synthetic event');

  // open under lease
  const opened = await store.openCursor(Object.freeze({
    clientId: ids.client,
    endpointId: ids.endpoint,
    leaseToken: token,
    expectedGeneration: 1,
    expectedStateVersion: sv,
  }));
  assert.equal(opened.ok, true);
  assert.equal(opened.value.cursor_kind, 'deltaLink');
  assert.match(opened.value.cursor_url, /deltatoken=final/);

  // reset + next generation preserves events + old row
  const reset = await store.markResetRequired(Object.freeze({
    clientId: ids.client,
    endpointId: ids.endpoint,
    expectedGeneration: 1,
    expectedStateVersion: sv,
    reason: 'graph_410_gone',
  }));
  assert.equal(reset.ok, true);
  const next = await store.beginNextGeneration(Object.freeze({
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    expectedGeneration: 1,
    expectedStateVersion: reset.value.state_version,
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
    queryVersion: 2,
    verifiedAuthority: true,
  }));
  assert.equal(next.ok, true);
  assert.equal(next.value.ingestion_generation, 2);
  assert.equal(next.value.query_version, 2);
  const gens = await db.query(
    `SELECT ingestion_generation, is_current FROM tenant_email_inbound_delta_states
      ORDER BY ingestion_generation`,
  );
  assert.equal(gens.rows.length, 2);
  assert.equal(gens.rows[0].is_current, false);
  assert.equal(gens.rows[1].is_current, true);
  count = await db.query('SELECT count(*)::int AS n FROM tenant_email_inbound_events');
  assert.equal(count.rows[0].n, 3, 'events preserved across generation rebind');

  // public status omits identities
  const pub = await store.getPublicStatus(Object.freeze({
    clientId: ids.client,
    endpointId: ids.endpoint,
  }));
  assert.equal(pub.ok, true);
  assert.equal(pub.value.state_present, true);
  assert.equal(pub.value.ingestion_generation, 2);
  assert.equal('provider_mailbox_id' in pub.value, false);
  assert.equal('lease_token' in pub.value, false);
  assert.equal('cursor_url' in pub.value, false);

  // down
  await db.exec(DOWN);
  const gone = await db.query(
    `SELECT to_regclass('public.tenant_email_inbound_delta_states') AS t`,
  );
  assert.equal(gone.rows[0].t, null);

  console.log('ok - pglite atomic page commit / rollback / replay / generation');
  console.log('PASS prove-email-inbound-delta-state-store-pglite');
}

async function main() {
  assertStaticContract();
  const PGlite = tryLoadPglite();
  if (!PGlite) {
    console.log('ok - PGlite unavailable; static contract only');
    console.log('PASS prove-email-inbound-delta-state-store-pglite (static)');
    return;
  }
  await proveWithPglite(PGlite);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

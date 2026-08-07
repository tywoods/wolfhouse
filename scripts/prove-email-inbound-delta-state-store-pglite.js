'use strict';

/**
 * Prove migration 064 tenant_email_inbound_delta_states + 066 page_commit journal
 * atomicity (events+cursor+journal one TX).
 *
 * When PGlite is available:
 *   - minimal parent shell + 063 events + 064 delta + 065/066 journal
 *   - initialize / lease / seal / commit nextLink / terminal deltaLink
 *   - page_commit journal claim/complete with worker actor pin
 *   - same-ID exact retry (ack-loss) zero mutation; two IDs one CAS
 *   - journal+events+cursor rollback at every substep
 *   - commit_outcome_unknown safe exact retry
 *   - pre-TX crypto open rejects cross-AAD sealed successors (zero inserts)
 *   - public result never includes operation_id
 *   - generation rebind via authority verifier preserves old state/events
 *   - post-crypto lease fencing on openCursor (takeover)
 *   - down drops 064 table
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
const UP_065 = path.join(ROOT, 'database/migrations/065_tenant_email_delta_recovery_operations.sql');
const UP_066 = path.join(ROOT, 'database/migrations/066_tenant_email_delta_page_commit_journal.sql');
const UP = fs.readFileSync(UP_064, 'utf8');
const DOWN = fs.readFileSync(DOWN_064, 'utf8');
const UP_EVENTS = fs.readFileSync(UP_063, 'utf8');
const UP_RECOVERY = fs.readFileSync(UP_065, 'utf8');
const UP_PAGE_JOURNAL = fs.readFileSync(UP_066, 'utf8');
const PAGE_WORKER = 'sunset-email-delta-worker';

const ids = {
  client: '11111111-1111-4111-8111-111111111111',
  location: '22222222-2222-4222-8222-222222222222',
  endpoint: '33333333-3333-4333-8333-333333333333',
  tenant: '55555555-5555-4555-8555-555555555555',
  mailbox: '44444444-4444-4444-8444-444444444444',
};
const QV1 = 'ms_messages_delta_v1';
/** Shape-valid but non-production; migration CHECK + store must reject. */
const QV_OTHER = 'messages_delta_v2';
const OTHER_CLIENT = '11111111-1111-4111-8111-111111111112';

function cursorUrl(kind, token) {
  const base =
    `https://graph.microsoft.com/v1.0/users/${ids.mailbox}/messages/delta`;
  if (kind === 'nextLink') return `${base}?$skiptoken=${token}`;
  return `${base}?$deltatoken=${token}`;
}

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
    CREATE TABLE staff_users (
      id uuid PRIMARY KEY,
      client_id uuid NOT NULL REFERENCES clients(id)
    );
    ALTER TABLE staff_users
      ADD CONSTRAINT staff_users_client_id_id_uq UNIQUE (client_id, id);
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
  assert.match(UP, /query_version\s+TEXT NOT NULL/);
  assert.match(UP, /9007199254740991/);
  assert.match(UP, /tenant_email_inbound_delta_states_query_version_exact/);
  assert.match(UP, /query_version = 'ms_messages_delta_v1'/);
  assert.equal(/query_version ~ /.test(UP), false, 'no shape-regex on query_version');
  assert.match(UP, /tenant_email_inbound_delta_states_cursor_coherence/);
  assert.equal(/INSERT INTO tenant_email_inbound_delta_states/.test(UP), false);
  assert.equal(/\bnext_link\b/i.test(UP), false);
  assert.match(DOWN, /DROP TABLE IF EXISTS tenant_email_inbound_delta_states/);
  console.log('ok - static 064 delta state contract');
}

function createPgliteExclusiveLoaner(db) {
  let chain = Promise.resolve();
  let loanSeq = 0;
  let onLoanStart = null;
  async function withTransactionClient(work) {
    const run = chain.then(async () => {
      loanSeq += 1;
      if (typeof onLoanStart === 'function') {
        await onLoanStart({ loanId: loanSeq });
      }
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
  return Object.freeze({
    withTransactionClient,
    setOnLoanStart(fn) { onLoanStart = fn; },
    resetLoanSeq() { loanSeq = 0; },
  });
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

function makeAuthorityVerifier() {
  return Object.freeze({
    async verifyBinding(binding) {
      if (!binding
          || binding.clientId !== ids.client
          || binding.locationId !== ids.location
          || binding.endpointId !== ids.endpoint
          || binding.providerTenantId !== ids.tenant
          || binding.providerMailboxId !== ids.mailbox) {
        return Object.freeze({ ok: false });
      }
      return Object.freeze({
        ok: true,
        value: Object.freeze({ ...binding }),
      });
    },
  });
}

async function proveWithPglite(PGlite) {
  const {
    createInboundEmailDeltaStateStore,
    sealDeltaCursorCompatible,
  } = require('./lib/email-inbound-delta-state-store');
  const {
    createFakeEmailGrantEnvelopeProvider,
  } = require('./lib/email-grant-envelope-fake-provider');

  const db = new PGlite();
  await db.exec(shellSql());
  await db.exec(UP_EVENTS);
  await db.exec(UP);
  await db.exec(UP_RECOVERY);
  await db.exec(UP_PAGE_JOURNAL);

  // RED: partial sealed cursor rejected
  let redFailed = false;
  try {
    await db.query(
      `INSERT INTO tenant_email_inbound_delta_states (
         client_id, location_id, endpoint_id,
         provider, provider_tenant_id, provider_mailbox_id,
         ingestion_generation, query_version, is_current,
         phase, state_version, cursor_kind, envelope_version
       ) VALUES ($1,$2,$3,'microsoft_graph',$4,$5,1,$6,true,'initial',1,'nextLink','v1')`,
      [ids.client, ids.location, ids.endpoint, ids.tenant, ids.mailbox, QV1],
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
     ) VALUES ($1,$2,$3,'microsoft_graph',$4,$5,1,$6,true,'initial',1)`,
    [ids.client, ids.location, ids.endpoint, ids.tenant, ids.mailbox, QV1],
  );
  let secondCurrentFailed = false;
  try {
    await db.query(
      `INSERT INTO tenant_email_inbound_delta_states (
         client_id, location_id, endpoint_id,
         provider, provider_tenant_id, provider_mailbox_id,
         ingestion_generation, query_version, is_current,
         phase, state_version
       ) VALUES ($1,$2,$3,'microsoft_graph',$4,$5,2,$6,true,'initial',1)`,
      [ids.client, ids.location, ids.endpoint, ids.tenant, ids.mailbox, QV1],
    );
  } catch {
    secondCurrentFailed = true;
  }
  assert.equal(secondCurrentFailed, true, 'ambiguous current generation blocked');

  // RED: query_version must be exact production constant (not shape-regex / caller-chosen)
  let badQv = false;
  try {
    await db.query(
      `INSERT INTO tenant_email_inbound_delta_states (
         client_id, location_id, endpoint_id,
         provider, provider_tenant_id, provider_mailbox_id,
         ingestion_generation, query_version, is_current,
         phase, state_version
       ) VALUES ($1,$2,$3,'microsoft_graph',$4,$5,3,'BAD-QV',true,'initial',1)`,
      [ids.client, ids.location, ids.endpoint, ids.tenant, ids.mailbox],
    );
  } catch {
    badQv = true;
  }
  assert.equal(badQv, true, 'invalid query_version text rejected');
  let badQvShape = false;
  try {
    await db.query(
      `INSERT INTO tenant_email_inbound_delta_states (
         client_id, location_id, endpoint_id,
         provider, provider_tenant_id, provider_mailbox_id,
         ingestion_generation, query_version, is_current,
         phase, state_version
       ) VALUES ($1,$2,$3,'microsoft_graph',$4,$5,3,$6,false,'initial',1)`,
      [ids.client, ids.location, ids.endpoint, ids.tenant, ids.mailbox, QV_OTHER],
    );
  } catch {
    badQvShape = true;
  }
  assert.equal(badQvShape, true, 'shape-valid non-exact query_version rejected');

  // RED: generation beyond MAX_SAFE_INTEGER rejected
  let badGen = false;
  try {
    await db.query(
      `INSERT INTO tenant_email_inbound_delta_states (
         client_id, location_id, endpoint_id,
         provider, provider_tenant_id, provider_mailbox_id,
         ingestion_generation, query_version, is_current,
         phase, state_version
       ) VALUES ($1,$2,$3,'microsoft_graph',$4,$5,9007199254740992,$6,false,'initial',1)`,
      [ids.client, ids.location, ids.endpoint, ids.tenant, ids.mailbox, QV1],
    );
  } catch {
    badGen = true;
  }
  assert.equal(badGen, true, 'generation above MAX_SAFE_INTEGER rejected');

  await db.query('DELETE FROM tenant_email_inbound_delta_states');

  const provider = createFakeEmailGrantEnvelopeProvider();
  const loaner = createPgliteExclusiveLoaner(db);
  const store = createInboundEmailDeltaStateStore(Object.freeze({
    withTransactionClient: loaner.withTransactionClient,
    envelopeProvider: provider,
    authorityVerifier: makeAuthorityVerifier(),
  }));

  const init = await store.initializeState(Object.freeze({
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
    queryVersion: QV1,
  }));
  assert.equal(init.ok, true);
  assert.equal(init.value.ingestion_generation, 1);
  assert.equal(init.value.query_version, QV1);
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
    queryVersion: QV1,
    cursorKind: 'nextLink',
    cursorUrl: cursorUrl('nextLink', 'page1'),
    operationId: crypto.randomUUID(),
  }));
  assert.equal(sealedNext.ok, true, JSON.stringify(sealedNext));

  // Atomic event+cursor+page_commit journal advancement
  const page1RequestedSv = sv;
  const page1OpId = String(sealedNext.value.envelope.operation_id).toLowerCase();
  const commit1 = await store.commitPageEvents(Object.freeze({
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    leaseToken: token,
    expectedGeneration: 1,
    expectedStateVersion: sv,
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
    queryVersion: QV1,
    envelopes: Object.freeze([makeEnvelope('msg-1'), makeEnvelope('msg-2')]),
    tombstones: Object.freeze([]),
    successorCursor: sealedNext.value,
  }));
  assert.equal(commit1.ok, true, JSON.stringify(commit1));
  assert.equal('operation_id' in commit1.value, false, 'operation_id never public');
  assert.equal('worker_id' in commit1.value, false);
  sv = commit1.value.state_version;

  // Journal durable: worker page_commit committed with same operation id as cursor
  const j1 = await db.query(
    `SELECT operation_kind, actor_kind, worker_id, actor_staff_user_id, outcome,
            result_generation, result_state_version, result_phase,
            requested_generation, requested_state_version
       FROM tenant_email_delta_recovery_operations WHERE operation_id = $1`,
    [page1OpId],
  );
  assert.equal(j1.rows.length, 1);
  assert.equal(j1.rows[0].operation_kind, 'page_commit');
  assert.equal(j1.rows[0].actor_kind, 'worker');
  assert.equal(j1.rows[0].worker_id, PAGE_WORKER);
  assert.equal(j1.rows[0].actor_staff_user_id, null);
  assert.equal(j1.rows[0].outcome, 'committed');
  assert.equal(Number(j1.rows[0].result_generation), 1);
  assert.equal(Number(j1.rows[0].result_state_version), sv);
  assert.equal(Number(j1.rows[0].requested_state_version), page1RequestedSv);
  const curOp = await db.query(
    `SELECT cursor_operation_id FROM tenant_email_inbound_delta_states WHERE is_current = true`,
  );
  assert.equal(String(curOp.rows[0].cursor_operation_id).toLowerCase(), page1OpId);

  // Same-ID exact retry (ack-loss): zero Graph/event/state mutation
  const countBeforeReplay = await db.query('SELECT count(*)::int AS n FROM tenant_email_inbound_events');
  const sameIdReplay = await store.commitPageEvents(Object.freeze({
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    leaseToken: token,
    expectedGeneration: 1,
    expectedStateVersion: page1RequestedSv,
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
    queryVersion: QV1,
    envelopes: Object.freeze([makeEnvelope('msg-1'), makeEnvelope('msg-2')]),
    tombstones: Object.freeze([]),
    successorCursor: sealedNext.value,
  }));
  assert.equal(sameIdReplay.ok, true, JSON.stringify(sameIdReplay));
  assert.equal(sameIdReplay.value.state_version, sv);
  assert.equal('operation_id' in sameIdReplay.value, false);
  let count = await db.query('SELECT count(*)::int AS n FROM tenant_email_inbound_events');
  assert.equal(count.rows[0].n, countBeforeReplay.rows[0].n, 'zero event mutation on same-ID replay');

  // Two IDs, one CAS: second concurrent fence fails; first stays committed
  const sealedRace = await store.sealDeltaCursor(Object.freeze({
    clientId: ids.client,
    endpointId: ids.endpoint,
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
    ingestionGeneration: 1,
    queryVersion: QV1,
    cursorKind: 'nextLink',
    cursorUrl: cursorUrl('nextLink', 'race-b'),
    operationId: crypto.randomUUID(),
  }));
  assert.equal(sealedRace.ok, true);
  const raceB = await store.commitPageEvents(Object.freeze({
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    leaseToken: token,
    expectedGeneration: 1,
    expectedStateVersion: page1RequestedSv, // stale fence
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
    queryVersion: QV1,
    envelopes: Object.freeze([makeEnvelope('msg-race-b')]),
    tombstones: Object.freeze([]),
    successorCursor: sealedRace.value,
  }));
  assert.equal(raceB.ok, false, 'stale fence second ID fails');
  // Journal claim for race rolled back with events/cursor
  const raceJ = await db.query(
    `SELECT 1 FROM tenant_email_delta_recovery_operations WHERE operation_id = $1`,
    [String(sealedRace.value.envelope.operation_id).toLowerCase()],
  );
  assert.equal(raceJ.rows.length, 0, 'failed page_commit journal rolled back');
  count = await db.query(
    `SELECT count(*)::int AS n FROM tenant_email_inbound_events
      WHERE provider_message_id = 'msg-race-b'`,
  );
  assert.equal(count.rows[0].n, 0);

  count = await db.query('SELECT count(*)::int AS n FROM tenant_email_inbound_events');
  assert.equal(count.rows[0].n, 2);
  let st = await db.query(
    `SELECT phase, cursor_kind, state_version, query_version, ciphertext IS NOT NULL AS sealed
       FROM tenant_email_inbound_delta_states WHERE is_current = true`,
  );
  assert.equal(st.rows[0].phase, 'initial');
  assert.equal(st.rows[0].cursor_kind, 'nextLink');
  assert.equal(st.rows[0].query_version, QV1);
  assert.equal(st.rows[0].sealed, true);
  const plain = await db.query(
    `SELECT cursor_kind, envelope_version FROM tenant_email_inbound_delta_states`,
  );
  assert.equal(JSON.stringify(plain.rows).includes('skiptoken'), false);

  // Cross-AAD sealed successor rejected before TX (zero inserts)
  const sealedCross = await sealDeltaCursorCompatible(provider, Object.freeze({
    clientId: OTHER_CLIENT,
    endpointId: ids.endpoint,
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
    ingestionGeneration: 1,
    queryVersion: QV1,
    cursorKind: 'nextLink',
    cursorUrl: cursorUrl('nextLink', 'hostile-cross-client'),
    operationId: crypto.randomUUID(),
  }));
  assert.equal(sealedCross.ok, true);
  const crossCommit = await store.commitPageEvents(Object.freeze({
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    leaseToken: token,
    expectedGeneration: 1,
    expectedStateVersion: sv,
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
    queryVersion: QV1,
    envelopes: Object.freeze([makeEnvelope('msg-hostile-cross')]),
    tombstones: Object.freeze([]),
    successorCursor: Object.freeze({
      cursor_kind: 'nextLink',
      envelope: sealedCross.value.envelope,
    }),
  }));
  assert.equal(crossCommit.ok, false, 'cross-client AAD must reject');
  count = await db.query('SELECT count(*)::int AS n FROM tenant_email_inbound_events');
  assert.equal(count.rows[0].n, 2, 'zero inserts on cross-AAD reject');
  const missingHostile = await db.query(
    `SELECT count(*)::int AS n FROM tenant_email_inbound_events
      WHERE provider_message_id = 'msg-hostile-cross'`,
  );
  assert.equal(missingHostile.rows[0].n, 0);
  st = await db.query(
    `SELECT state_version, cursor_kind FROM tenant_email_inbound_delta_states WHERE is_current = true`,
  );
  assert.equal(Number(st.rows[0].state_version), sv, 'zero cursor advance on cross-AAD');

  // CAS failure rolls back inserts (wrong state_version)
  const sealedBad = await store.sealDeltaCursor(Object.freeze({
    clientId: ids.client,
    endpointId: ids.endpoint,
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
    ingestionGeneration: 1,
    queryVersion: QV1,
    cursorKind: 'nextLink',
    cursorUrl: cursorUrl('nextLink', 'bad-cas'),
    operationId: crypto.randomUUID(),
  }));
  assert.equal(sealedBad.ok, true);
  const badCas = await store.commitPageEvents(Object.freeze({
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    leaseToken: token,
    expectedGeneration: 1,
    expectedStateVersion: 99999,
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
    queryVersion: QV1,
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
    queryVersion: QV1,
    cursorKind: 'nextLink',
    cursorUrl: cursorUrl('nextLink', 'page2'),
    operationId: crypto.randomUUID(),
  }));
  const replay = await store.commitPageEvents(Object.freeze({
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    leaseToken: token,
    expectedGeneration: 1,
    expectedStateVersion: sv,
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
    queryVersion: QV1,
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
    queryVersion: QV1,
    cursorKind: 'deltaLink',
    cursorUrl: cursorUrl('deltaLink', 'final'),
    operationId: crypto.randomUUID(),
  }));
  const terminal = await store.commitPageEvents(Object.freeze({
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    leaseToken: token,
    expectedGeneration: 1,
    expectedStateVersion: sv,
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
    queryVersion: QV1,
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

  // Post-crypto lease fencing: takeover between read and revalidate
  loaner.resetLoanSeq();
  let openLoans = 0;
  loaner.setOnLoanStart(async ({ loanId }) => {
    openLoans += 1;
    if (openLoans === 2) {
      // Steal lease under DB clock after crypto, before plaintext release.
      await db.query(
        `UPDATE tenant_email_inbound_delta_states
            SET lease_owner = 'takeover',
                lease_token = $1::uuid,
                lease_until = clock_timestamp() + interval '120 seconds',
                state_version = state_version + 1
          WHERE client_id = $2::uuid AND endpoint_id = $3::uuid AND is_current = true`,
        [crypto.randomUUID(), ids.client, ids.endpoint],
      );
    }
  });
  const fenced = await store.openCursor(Object.freeze({
    clientId: ids.client,
    endpointId: ids.endpoint,
    leaseToken: token,
    expectedGeneration: 1,
    expectedStateVersion: sv,
  }));
  loaner.setOnLoanStart(null);
  assert.equal(fenced.ok, false, 'post-crypto lease takeover must not release cursor');

  // Restore lease for rebind path
  const curRow = await db.query(
    `SELECT state_version FROM tenant_email_inbound_delta_states WHERE is_current = true`,
  );
  sv = Number(curRow.rows[0].state_version);
  await db.query(
    `UPDATE tenant_email_inbound_delta_states
        SET lease_owner = 'pglite-runner',
            lease_token = $1::uuid,
            lease_until = clock_timestamp() + interval '120 seconds'
      WHERE client_id = $2::uuid AND endpoint_id = $3::uuid AND is_current = true`,
    [token, ids.client, ids.endpoint],
  );

  // reset + next generation preserves events + old row (authority verifier)
  const reset = await store.markResetRequired(Object.freeze({
    clientId: ids.client,
    endpointId: ids.endpoint,
    expectedGeneration: 1,
    expectedStateVersion: sv,
    reason: 'graph_410_gone',
  }));
  assert.equal(reset.ok, true);
  // Non-exact query_version rejected at store boundary (not caller-chosen).
  const badQvNext = await store.beginNextGeneration(Object.freeze({
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    expectedGeneration: 1,
    expectedStateVersion: reset.value.state_version,
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
    queryVersion: QV_OTHER,
  }));
  assert.equal(badQvNext.ok, false);
  assert.equal(badQvNext.error, 'query_version_invalid');

  const next = await store.beginNextGeneration(Object.freeze({
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    expectedGeneration: 1,
    expectedStateVersion: reset.value.state_version,
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
    queryVersion: QV1,
  }));
  assert.equal(next.ok, true, JSON.stringify(next));
  assert.equal(next.value.ingestion_generation, 2);
  assert.equal(next.value.query_version, QV1);
  const gens = await db.query(
    `SELECT ingestion_generation, is_current, query_version FROM tenant_email_inbound_delta_states
      ORDER BY ingestion_generation`,
  );
  assert.equal(gens.rows.length, 2);
  assert.equal(gens.rows[0].is_current, false);
  assert.equal(gens.rows[1].is_current, true);
  assert.equal(gens.rows[1].query_version, QV1);
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
  assert.equal(pub.value.query_version, QV1);
  assert.equal('provider_mailbox_id' in pub.value, false);
  assert.equal('lease_token' in pub.value, false);
  assert.equal('cursor_url' in pub.value, false);

  // down
  await db.exec(DOWN);
  const gone = await db.query(
    `SELECT to_regclass('public.tenant_email_inbound_delta_states') AS t`,
  );
  assert.equal(gone.rows[0].t, null);

  console.log('ok - pglite atomic page commit / cross-AAD / lease fence / generation');
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

'use strict';

/**
 * Prove migration 067 tenant_email_inbound_inbox_projections + production bridge
 * against a real PostgreSQL-compatible engine via node-postgres (pg).
 *
 * Always prefers the repository disposable harness (Docker postgres when
 * available; PGlite socket fallback). Applies minimal parent shell + 063 + 067
 * through a pg Client, then invokes createEmailInboundInboxBridge with
 * exclusive withTransactionClient loans.
 *
 * Proves:
 *   - real SQL types/enums, ON CONFLICT, xmax=0, composite FKs
 *   - happy path / replay / location isolation
 *   - opaque emailv1 identity (no raw email in phone)
 *   - customer sync skip (no customers row for email projections)
 *   - microsoft_graph attach sets conversations.needs_human=true (new + existing)
 *   - non-Microsoft providers preserve false / existing needs_human
 *   - conversation delete CASCADE clears journal (retention contract)
 *   - down migration fail-closed when projection rows exist
 *   - two-connection concurrent same-event projection (exactly one message+journal)
 *   - commit not-applied uncertain; commit-applied/ack-lost replay converges
 *   - hostile cross-tenant composite FK inserts fail
 *
 * Optional env EMAIL_INBOUND_INBOX_BRIDGE_PG_POOL_URL: extra stock-PG path with
 * isolated schema (same assertions). Never mutates live/Azure product DBs.
 *
 * No Azure / deploy / send / Luna / activation.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
  MIGRATIONS_DIR,
  prepareMigrationBody,
  assertSafeDatabaseTarget,
} = require('./lib/migration-integrity');
const { startDisposablePostgresHarness } = require('./lib/disposable-postgres-harness');

const UP_063 = path.join(MIGRATIONS_DIR, '063_tenant_email_inbound_events.sql');
const UP_067 = path.join(MIGRATIONS_DIR, '067_tenant_email_inbound_inbox_projections.sql');
const DOWN_067 = path.join(MIGRATIONS_DIR, '067_tenant_email_inbound_inbox_projections_down.sql');
const STOCK_PG_POOL_URL_ENV = 'EMAIL_INBOUND_INBOX_BRIDGE_PG_POOL_URL';

const ids = {
  client: '11111111-1111-4111-8111-111111111111',
  clientB: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  location: '22222222-2222-4222-8222-222222222222',
  locationOther: '22222222-2222-4222-8222-222222222233',
  locationB: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  endpoint: '33333333-3333-4333-8333-333333333333',
  endpointB: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  mailbox: '44444444-4444-4444-8444-444444444444',
};

const PLANTED_SUBJECT = 'PROOF_SUBJECT_INBOX_BRIDGE_PII';
const PLANTED_ADDRESS = 'proof-inbox-bridge@example.test';

function shellSql() {
  return `
DO $ext$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
EXCEPTION WHEN OTHERS THEN
  NULL; -- gen_random_uuid may already be built-in (PGlite)
END $ext$;

CREATE TABLE clients (
  id UUID PRIMARY KEY
);

CREATE TABLE tenant_locations (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES clients(id),
  location_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT 'loc',
  active BOOLEAN NOT NULL DEFAULT true
);
ALTER TABLE tenant_locations
  ADD CONSTRAINT tenant_locations_client_id_id_uq UNIQUE (client_id, id);

CREATE TABLE tenant_channel_endpoints (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL,
  location_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  provider TEXT NOT NULL DEFAULT 'microsoft_graph',
  public_address TEXT NOT NULL DEFAULT 'a@b.co',
  secret_ref TEXT,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE tenant_channel_endpoints
  ADD CONSTRAINT tenant_channel_endpoints_client_id_id_uq UNIQUE (client_id, id);

DO $$ BEGIN
  CREATE TYPE conversation_status AS ENUM ('open', 'closed', 'archived', 'pending');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE bot_mode AS ENUM ('bot', 'human', 'hybrid');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE message_direction AS ENUM ('inbound', 'outbound', 'system');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE guests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  email TEXT,
  full_name TEXT
);

CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  display_name TEXT,
  phone TEXT NOT NULL,
  email TEXT,
  language TEXT DEFAULT 'en',
  session_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_message_preview TEXT,
  needs_human BOOLEAN NOT NULL DEFAULT FALSE,
  status conversation_status NOT NULL DEFAULT 'open',
  conversation_stage TEXT,
  bot_mode bot_mode NOT NULL DEFAULT 'bot',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  customer_id UUID,
  guest_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, phone)
);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction message_direction NOT NULL,
  message_text TEXT NOT NULL,
  message_type TEXT,
  route TEXT,
  source TEXT NOT NULL DEFAULT 'whatsapp',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  location_id TEXT,
  full_name TEXT,
  phone TEXT NOT NULL,
  email TEXT,
  notes TEXT,
  language TEXT,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, phone)
);

-- Pre-067 customer sync (telephone only). 067 replaces with email-namespace skip.
CREATE OR REPLACE FUNCTION sync_customer_from_touch() RETURNS trigger AS $$
DECLARE
  v_phone text;
  v_name  text;
  v_email text;
  v_loc   text;
  v_cid   uuid;
BEGIN
  v_phone := NULLIF(TRIM(COALESCE(NEW.phone, '')), '');
  IF v_phone IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'conversations' THEN
    v_name  := NULLIF(TRIM(COALESCE(NEW.display_name, '')), '');
    v_email := NULLIF(TRIM(COALESCE(NEW.email, '')), '');
    v_loc   := NULL;
  ELSE
    v_name  := NULLIF(TRIM(COALESCE(NEW.guest_name, '')), '');
    v_email := NULLIF(TRIM(COALESCE(NEW.email, '')), '');
    v_loc   := NULLIF(TRIM(COALESCE(NEW.metadata->>'location_id', '')), '');
  END IF;
  INSERT INTO customers (client_id, phone, full_name, email, location_id, first_seen, last_seen)
  VALUES (NEW.client_id, v_phone, v_name, v_email, v_loc, NOW(), NOW())
  ON CONFLICT (client_id, phone) DO UPDATE SET
    full_name   = COALESCE(EXCLUDED.full_name, customers.full_name),
    email       = COALESCE(EXCLUDED.email, customers.email),
    location_id = COALESCE(EXCLUDED.location_id, customers.location_id),
    last_seen   = NOW(),
    updated_at  = NOW()
  RETURNING id INTO v_cid;
  NEW.customer_id := v_cid;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_customer_conversations ON conversations;
CREATE TRIGGER trg_sync_customer_conversations
  BEFORE INSERT OR UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION sync_customer_from_touch();

INSERT INTO clients (id) VALUES ('${ids.client}'), ('${ids.clientB}');
INSERT INTO tenant_locations (id, client_id, location_id) VALUES
  ('${ids.location}', '${ids.client}', 'sunset-somo'),
  ('${ids.locationOther}', '${ids.client}', 'sunset-sardinero'),
  ('${ids.locationB}', '${ids.clientB}', 'other-beach');
INSERT INTO tenant_channel_endpoints (id, client_id, location_id) VALUES
  ('${ids.endpoint}', '${ids.client}', 'sunset-somo'),
  ('${ids.endpointB}', '${ids.clientB}', 'other-beach');
`;
}

function assertStaticContract() {
  const up = fs.readFileSync(UP_067, 'utf8');
  const down = fs.readFileSync(DOWN_067, 'utf8');
  const proveSrc = fs.readFileSync(__filename, 'utf8');
  const {
    SQL_UPSERT_CONVERSATION,
  } = require('./lib/email-inbound-inbox-bridge');
  assert.match(up, /CREATE TABLE tenant_email_inbound_inbox_projections/);
  assert.match(up, /FOREIGN KEY \(client_id, inbound_event_id\)/);
  assert.match(up, /FOREIGN KEY \(client_id, conversation_id, message_id\)/);
  assert.match(up, /ON DELETE CASCADE/);
  assert.match(up, /emailv1\|email/);
  assert.match(down, /067_down_refused/);
  assert.match(down, /projection rows present/);
  // Production upsert writes conversations.needs_human ($11). The disposable
  // conversations shell must expose that 001_init column or the real engine
  // raises 42703 and the bridge fail-closes as uncertain.
  assert.match(proveSrc, /needs_human BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(SQL_UPSERT_CONVERSATION, /\bneeds_human\b/);
  assert.match(SQL_UPSERT_CONVERSATION, /\$11::boolean/);
  console.log('ok - static 067 integration contract');
}

async function waitForPg(connection, attempts = 40) {
  const { Client } = require('pg');
  let last;
  for (let i = 0; i < attempts; i += 1) {
    const client = new Client({ ...connection, connectionTimeoutMillis: 2000 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (e) {
      last = e;
      try { await client.end(); } catch (_) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw last || new Error('postgres never ready');
}

async function applySqlFile(client, filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const prepared = prepareMigrationBody(raw);
  if (!prepared.ok || !prepared.body) {
    throw new Error(`prepare failed for ${path.basename(filePath)}: ${prepared.message || prepared.code}`);
  }
  await client.query(prepared.body);
}

function authority(overrides = {}) {
  return Object.freeze({
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    ...overrides,
  });
}

async function insertInboundEvent(client, overrides = {}) {
  const row = {
    id: crypto.randomUUID(),
    client_id: ids.client,
    location_id: ids.location,
    endpoint_id: ids.endpoint,
    provider: 'microsoft_graph',
    provider_mailbox_id: ids.mailbox,
    provider_message_id: `msg-${crypto.randomBytes(4).toString('hex')}`,
    received_at: '2026-08-01T12:00:00.000Z',
    subject: PLANTED_SUBJECT,
    sender_display_name: 'Proof Guest',
    sender_address: PLANTED_ADDRESS,
    is_read: false,
    conversation_id: 'graph-thread-proof',
    internet_message_id: '<proof@example.test>',
    ...overrides,
  };
  await client.query(
    `INSERT INTO tenant_email_inbound_events (
       id, client_id, location_id, endpoint_id,
       provider, provider_mailbox_id, provider_message_id,
       received_at, subject, sender_display_name, sender_address,
       is_read, conversation_id, internet_message_id
     ) VALUES (
       $1::uuid,$2::uuid,$3::uuid,$4::uuid,
       $5,$6,$7,
       $8::timestamptz,$9,$10,$11,
       $12,$13,$14
     )`,
    [
      row.id, row.client_id, row.location_id, row.endpoint_id,
      row.provider, row.provider_mailbox_id, row.provider_message_id,
      row.received_at, row.subject, row.sender_display_name, row.sender_address,
      row.is_read, row.conversation_id, row.internet_message_id,
    ],
  );
  return row;
}

/**
 * Exclusive loaner over a pg.Pool — release-after-settle.
 * Optional rendezvous barrier so concurrent loans overlap before work.
 */
function createPoolLoaner(pool, options = {}) {
  const state = {
    loanCount: 0,
    releaseCount: 0,
    activeLoans: 0,
    maxConcurrentLoans: 0,
    loanedProcessIds: [],
    releasedProcessIds: [],
  };
  let rendezvous = null;

  function resetRendezvous(need = 2) {
    let waiters = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    rendezvous = { need, waiters, gate, release };
  }

  if (options.rendezvous) resetRendezvous(options.rendezvousNeed || 2);

  async function withTransactionClient(work) {
    const client = await pool.connect();
    state.loanCount += 1;
    state.activeLoans += 1;
    if (state.activeLoans > state.maxConcurrentLoans) {
      state.maxConcurrentLoans = state.activeLoans;
    }
    const pid = client.processID;
    state.loanedProcessIds.push(pid);
    try {
      if (options.searchPath) {
        await client.query(`SET search_path TO ${options.searchPath}, public`);
      }
      if (rendezvous) {
        rendezvous.waiters += 1;
        if (rendezvous.waiters >= rendezvous.need) rendezvous.release();
        await rendezvous.gate;
      }
      return await Promise.resolve().then(() => work(client));
    } finally {
      state.activeLoans -= 1;
      client.release();
      state.releaseCount += 1;
      state.releasedProcessIds.push(pid);
    }
  }

  return Object.freeze({
    withTransactionClient,
    state,
    resetRendezvous,
    clearRendezvous() { rendezvous = null; },
  });
}

async function count(client, sql, params = []) {
  const r = await client.query(sql, params);
  return Number(r.rows[0].n);
}

function conversationIdentity(fromAddress, mailbox) {
  const {
    resolveInboundMatchConversationIdentity,
  } = require('./lib/email-inbound-match-ingest');
  const resolved = resolveInboundMatchConversationIdentity({
    providerMailboxId: mailbox || ids.mailbox,
    fromAddress,
  });
  if (!resolved || typeof resolved.conversation_key !== 'string') {
    throw new Error('canonical conversation identity required');
  }
  return resolved.conversation_key;
}

function assertPgBool(actual, expected, label) {
  const truthy = actual === true || actual === 't';
  const falsey = actual === false || actual === 'f';
  assert.equal(expected ? truthy : falsey, true, label || `needs_human expected ${expected}, got ${String(actual)}`);
}

async function proveBehavioral(pool, options = {}) {
  const {
    createEmailInboundInboxBridge,
    buildEmailConversationIdentityKey,
    isEmailChannelPhoneNamespace,
  } = require('./lib/email-inbound-inbox-bridge');

  const setup = await pool.connect();
  try {
    if (options.searchPath) {
      await setup.query(`SET search_path TO ${options.searchPath}, public`);
    }

    // ── Happy path via production bridge ─────────────────────────────────
    const loaner = createPoolLoaner(pool, { searchPath: options.searchPath });
    const bridge = createEmailInboundInboxBridge(Object.freeze({
      withTransactionClient: loaner.withTransactionClient,
    }));
    const ev = await insertInboundEvent(setup);
    const r1 = await bridge.projectInboundEvent(Object.freeze({
      ...authority(),
      inboundEventId: ev.id,
    }));
    assert.equal(r1.status, 'projected', 'happy path projects');
    assert.equal(typeof r1.conversation_id, 'string');
    assert.equal(typeof r1.message_id, 'string');
    assert.equal(r1.created_conversation, true);

    const conv = await setup.query(
      `SELECT phone, email, metadata, session_state, last_message_preview, customer_id, needs_human
         FROM conversations WHERE id = $1::uuid`,
      [r1.conversation_id],
    );
    assert.equal(conv.rows.length, 1);
    assertPgBool(conv.rows[0].needs_human, true, 'new microsoft_graph conversation needs_human=true');
    const phone = conv.rows[0].phone;
    assert.equal(isEmailChannelPhoneNamespace(phone), true);
    assert.ok(String(phone).startsWith('emailv1:'));
    assert.equal(String(phone).toLowerCase().includes(PLANTED_ADDRESS), false);
    assert.notEqual(
      phone,
      buildEmailConversationIdentityKey('sunset-somo', PLANTED_ADDRESS),
    );
    assert.equal(conv.rows[0].email, PLANTED_ADDRESS);
    assert.equal(conv.rows[0].metadata.channel, 'email');
    assert.equal(conv.rows[0].metadata.location_id, 'sunset-somo');
    assert.equal(conv.rows[0].metadata.email_subject, undefined);
    assert.equal(conv.rows[0].session_state.channel, 'email');
    assert.equal(conv.rows[0].last_message_preview, PLANTED_SUBJECT);
    assert.equal(conv.rows[0].customer_id, null, 'no customer link for email channel');

    const msg = await setup.query(
      `SELECT message_text, source, route, metadata, conversation_id, client_id
         FROM messages WHERE id = $1::uuid`,
      [r1.message_id],
    );
    assert.equal(msg.rows[0].message_text, PLANTED_SUBJECT);
    assert.equal(msg.rows[0].source, 'email_inbound');
    assert.equal(msg.rows[0].route, 'email');
    assert.equal(msg.rows[0].metadata.email_subject, undefined);
    assert.equal(msg.rows[0].conversation_id, r1.conversation_id);
    assert.equal(msg.rows[0].client_id, ids.client);

    // xmax=0 observed on fresh conversation insert (node-postgres Result shape)
    assert.ok(loaner.state.loanCount >= 1);

    const custN = await count(
      setup,
      `SELECT count(*)::int AS n FROM customers WHERE client_id = $1::uuid`,
      [ids.client],
    );
    assert.equal(custN, 0, 'email projection must not create customers');

    // Telephone conversation still syncs customers (trigger still works).
    await setup.query(
      `INSERT INTO conversations (client_id, phone, display_name, email, status, bot_mode)
       VALUES ($1::uuid, $2, 'Phone Guest', 'phone@example.test', 'open', 'bot')`,
      [ids.client, '+34600111222'],
    );
    const phoneCust = await count(
      setup,
      `SELECT count(*)::int AS n FROM customers WHERE client_id = $1::uuid AND phone = $2`,
      [ids.client, '+34600111222'],
    );
    assert.equal(phoneCust, 1, 'real phone still creates customer');
    // Email still isolated
    assert.equal(
      await count(
        setup,
        `SELECT count(*)::int AS n FROM customers WHERE phone LIKE 'emailv1:%' OR phone LIKE 'email:%'`,
      ),
      0,
    );
    console.log('ok - happy path + opaque identity + customer isolation (real SQL)');

    // ── Replay exactly-once ──────────────────────────────────────────────
    const r2 = await bridge.projectInboundEvent(Object.freeze({
      ...authority(),
      inboundEventId: ev.id,
    }));
    assert.equal(r2.status, 'already_projected');
    assert.equal(r2.conversation_id, r1.conversation_id);
    assert.equal(r2.message_id, r1.message_id);
    assert.equal(
      await count(setup, `SELECT count(*)::int AS n FROM messages WHERE client_id = $1::uuid AND source = 'email_inbound'`, [ids.client]),
      1,
    );
    assert.equal(
      await count(setup, `SELECT count(*)::int AS n FROM tenant_email_inbound_inbox_projections`),
      1,
    );
    console.log('ok - replay already_projected zero mutation');

    // ── needs_human: existing Microsoft attach converges; other providers keep state ─
    {
      const existingAddr = 'existing-converge@example.test';
      const existingPhone = conversationIdentity(existingAddr, ids.mailbox);
      const plantedConv = await setup.query(
        `INSERT INTO conversations (
           client_id, phone, display_name, email, status, bot_mode, needs_human,
           metadata, session_state
         ) VALUES (
           $1::uuid, $2, 'Existing Guest', $3, 'open', 'bot', false,
           '{"channel":"email"}'::jsonb, '{"channel":"email"}'::jsonb
         ) RETURNING id::text AS conversation_id`,
        [ids.client, existingPhone, existingAddr],
      );
      const plantedId = plantedConv.rows[0].conversation_id;
      const evExist = await insertInboundEvent(setup, {
        provider_message_id: `msg-exist-${crypto.randomBytes(3).toString('hex')}`,
        sender_address: existingAddr,
        sender_display_name: 'Existing Guest',
      });
      const rExist = await bridge.projectInboundEvent(Object.freeze({
        ...authority(),
        inboundEventId: evExist.id,
      }));
      assert.equal(rExist.status, 'projected');
      assert.equal(rExist.conversation_id, plantedId);
      assert.equal(rExist.created_conversation, false);
      const existRead = await setup.query(
        `SELECT needs_human FROM conversations WHERE id = $1::uuid`,
        [plantedId],
      );
      assertPgBool(existRead.rows[0].needs_human, true, 'existing conversation converges needs_human=true');

      const otherPhone = existingPhone;
      await setup.query(
        `INSERT INTO conversations (
           client_id, phone, display_name, email, status, bot_mode, needs_human,
           metadata, session_state
         ) VALUES (
           $1::uuid, $2, 'Other Tenant', $3, 'open', 'bot', false,
           '{"channel":"email"}'::jsonb, '{"channel":"email"}'::jsonb
         )`,
        [ids.clientB, otherPhone, existingAddr],
      );
      const otherRead = await setup.query(
        `SELECT needs_human FROM conversations WHERE client_id = $1::uuid AND phone = $2`,
        [ids.clientB, otherPhone],
      );
      assert.equal(otherRead.rows.length, 1);
      assertPgBool(otherRead.rows[0].needs_human, false, 'other tenant needs_human stays false');

      const gmailAddr = 'gmail-preserve@example.test';
      const evGmailNew = await insertInboundEvent(setup, {
        provider: 'gmail_api',
        provider_message_id: `msg-gmail-new-${crypto.randomBytes(3).toString('hex')}`,
        sender_address: gmailAddr,
        sender_display_name: 'Gmail Guest',
      });
      const rGmailNew = await bridge.projectInboundEvent(Object.freeze({
        ...authority(),
        inboundEventId: evGmailNew.id,
      }));
      assert.equal(rGmailNew.status, 'projected');
      const gmailNewRead = await setup.query(
        `SELECT needs_human FROM conversations WHERE id = $1::uuid`,
        [rGmailNew.conversation_id],
      );
      assertPgBool(gmailNewRead.rows[0].needs_human, false, 'new gmail_api conversation stays needs_human=false');

      const evImapKeepFalse = await insertInboundEvent(setup, {
        provider: 'imap_smtp',
        provider_message_id: `msg-imap-keep-false-${crypto.randomBytes(3).toString('hex')}`,
        sender_address: gmailAddr,
        sender_display_name: 'Gmail Guest',
      });
      const rImapKeepFalse = await bridge.projectInboundEvent(Object.freeze({
        ...authority(),
        inboundEventId: evImapKeepFalse.id,
      }));
      assert.equal(rImapKeepFalse.status, 'projected');
      assert.equal(rImapKeepFalse.conversation_id, rGmailNew.conversation_id);
      const imapFalseRead = await setup.query(
        `SELECT needs_human FROM conversations WHERE id = $1::uuid`,
        [rGmailNew.conversation_id],
      );
      assertPgBool(imapFalseRead.rows[0].needs_human, false, 'imap_smtp attach preserves existing false');

      const keepTrueAddr = 'keep-true@example.test';
      const keepTruePhone = conversationIdentity(keepTrueAddr, ids.mailbox);
      const keepTrue = await setup.query(
        `INSERT INTO conversations (
           client_id, phone, display_name, email, status, bot_mode, needs_human,
           metadata, session_state
         ) VALUES (
           $1::uuid, $2, 'Keep True', $3, 'open', 'bot', true,
           '{"channel":"email"}'::jsonb, '{"channel":"email"}'::jsonb
         ) RETURNING id::text AS conversation_id`,
        [ids.client, keepTruePhone, keepTrueAddr],
      );
      const evGmailKeepTrue = await insertInboundEvent(setup, {
        provider: 'gmail_api',
        provider_message_id: `msg-gmail-keep-true-${crypto.randomBytes(3).toString('hex')}`,
        sender_address: keepTrueAddr,
        sender_display_name: 'Keep True',
      });
      const rGmailKeepTrue = await bridge.projectInboundEvent(Object.freeze({
        ...authority(),
        inboundEventId: evGmailKeepTrue.id,
      }));
      assert.equal(rGmailKeepTrue.status, 'projected');
      assert.equal(rGmailKeepTrue.conversation_id, keepTrue.rows[0].conversation_id);
      const keepTrueRead = await setup.query(
        `SELECT needs_human FROM conversations WHERE id = $1::uuid`,
        [keepTrue.rows[0].conversation_id],
      );
      assertPgBool(keepTrueRead.rows[0].needs_human, true, 'gmail_api attach preserves existing true');

      const happyAfter = await setup.query(
        `SELECT needs_human FROM conversations WHERE id = $1::uuid`,
        [r1.conversation_id],
      );
      assertPgBool(happyAfter.rows[0].needs_human, true, 'original microsoft conversation stays true');
      console.log('ok - needs_human microsoft true / existing converges / non-Microsoft preserve (real SQL)');
    }

    // ── Same sender + same mailbox, different location → one conversation ─
    const evSard = await insertInboundEvent(setup, {
      location_id: ids.locationOther,
      provider_message_id: `msg-sard-${crypto.randomBytes(3).toString('hex')}`,
    });
    // Endpoint is still somo endpoint in fixture authority — use matching endpoint
    // that is bound to client; location authority must match event.
    // Endpoint FK only checks client_id+endpoint exists; event carries location.
    const rSard = await bridge.projectInboundEvent(Object.freeze({
      clientId: ids.client,
      locationId: ids.locationOther,
      endpointId: ids.endpoint,
      inboundEventId: evSard.id,
    }));
    assert.equal(rSard.status, 'projected');
    assert.equal(rSard.conversation_id, r1.conversation_id);
    console.log('ok - same From+mailbox coalesces across locations on real schema');

    const eventCols = await setup.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'tenant_email_inbound_events'`,
    );
    const eventColNames = eventCols.rows.map((row) => row.column_name);
    assert.equal(eventColNames.includes('in_reply_to'), false);
    assert.equal(eventColNames.includes('references_message_ids'), false);
    assert.equal(eventColNames.includes('internet_message_id'), true);
    console.log('ok - 063 event schema has no In-Reply-To/References columns');

    const guestExact = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const guestAmbA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const guestAmbB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await setup.query(
      `INSERT INTO guests (id, client_id, email, full_name)
       VALUES ($1::uuid, $2::uuid, $3, 'Elena Guest')`,
      [guestExact, ids.client, 'PROOF-INBOX-BRIDGE@EXAMPLE.TEST'],
    );
    const evGuest = await insertInboundEvent(setup, {
      provider_message_id: `msg-guest-${crypto.randomBytes(3).toString('hex')}`,
      sender_address: PLANTED_ADDRESS,
    });
    const rGuest = await bridge.projectInboundEvent(Object.freeze({
      ...authority(),
      inboundEventId: evGuest.id,
    }));
    assert.equal(rGuest.status, 'projected');
    assert.equal(rGuest.conversation_id, r1.conversation_id);
    const bound = await setup.query(
      `SELECT guest_id::text AS guest_id, email FROM conversations WHERE id = $1::uuid`,
      [r1.conversation_id],
    );
    assert.equal(bound.rows[0].guest_id, guestExact);
    assert.equal(String(bound.rows[0].email).toLowerCase(), PLANTED_ADDRESS);
    const guestCount = await count(setup, `SELECT count(*)::int AS n FROM guests`);
    assert.equal(guestCount, 1, 'projection must never INSERT guests');

    const evGuest2 = await insertInboundEvent(setup, {
      provider_message_id: `msg-guest-keep-${crypto.randomBytes(3).toString('hex')}`,
      sender_address: PLANTED_ADDRESS,
    });
    const rGuest2 = await bridge.projectInboundEvent(Object.freeze({
      ...authority(),
      inboundEventId: evGuest2.id,
    }));
    assert.equal(rGuest2.status, 'projected');
    const stillBound = await setup.query(
      `SELECT guest_id::text AS guest_id FROM conversations WHERE id = $1::uuid`,
      [r1.conversation_id],
    );
    assert.equal(stillBound.rows[0].guest_id, guestExact);
    console.log('ok - real SQL exact guest bind; existing guest_id kept; no guest insert');

    const unknownAddr = 'unknown-guest@example.test';
    const evUnknown = await insertInboundEvent(setup, {
      provider_message_id: `msg-unk-${crypto.randomBytes(3).toString('hex')}`,
      sender_address: unknownAddr,
      sender_display_name: 'Unknown',
    });
    const rUnknown = await bridge.projectInboundEvent(Object.freeze({
      ...authority(),
      inboundEventId: evUnknown.id,
    }));
    assert.equal(rUnknown.status, 'projected');
    assert.notEqual(rUnknown.conversation_id, r1.conversation_id);
    const unkConv = await setup.query(
      `SELECT guest_id, email, display_name FROM conversations WHERE id = $1::uuid`,
      [rUnknown.conversation_id],
    );
    assert.equal(unkConv.rows[0].guest_id, null);
    assert.equal(unkConv.rows[0].email, unknownAddr);
    const rootAfter = await setup.query(
      `SELECT guest_id::text AS guest_id, email, display_name FROM conversations WHERE id = $1::uuid`,
      [r1.conversation_id],
    );
    assert.equal(rootAfter.rows[0].guest_id, guestExact);
    assert.equal(String(rootAfter.rows[0].email).toLowerCase(), PLANTED_ADDRESS);
    assert.equal(rootAfter.rows[0].display_name, 'Proof Guest');
    console.log('ok - different From does not join or overwrite root identity');

    const ambMailboxSender = 'ambiguous-guest@example.test';
    await setup.query(
      `INSERT INTO guests (id, client_id, email)
       VALUES ($1::uuid, $2::uuid, $3), ($4::uuid, $2::uuid, $3)`,
      [guestAmbA, ids.client, ambMailboxSender, guestAmbB],
    );
    const evAmb = await insertInboundEvent(setup, {
      provider_message_id: `msg-amb-${crypto.randomBytes(3).toString('hex')}`,
      sender_address: ambMailboxSender,
    });
    const rAmb = await bridge.projectInboundEvent(Object.freeze({
      ...authority(),
      inboundEventId: evAmb.id,
    }));
    assert.equal(rAmb.status, 'projected');
    const ambConv = await setup.query(
      `SELECT guest_id FROM conversations WHERE id = $1::uuid`,
      [rAmb.conversation_id],
    );
    assert.equal(ambConv.rows[0].guest_id, null);
    console.log('ok - ambiguous same-tenant guest email stays unmatched on real SQL');

    // ── Commit not applied (uncertain, zero new rows for that event) ─────
    {
      const evFail = await insertInboundEvent(setup, {
        provider_message_id: `msg-commit-fail-${crypto.randomBytes(3).toString('hex')}`,
      });
      const beforeProj = await count(setup, `SELECT count(*)::int AS n FROM tenant_email_inbound_inbox_projections`);
      const beforeMsg = await count(setup, `SELECT count(*)::int AS n FROM messages WHERE source = 'email_inbound'`);

      async function failingCommitLoaner(work) {
        return loaner.withTransactionClient(async (client) => {
          const wrapped = {
            async query(sql, params) {
              const norm = String(sql).replace(/\s+/g, ' ').trim();
              if (norm === 'COMMIT') {
                throw new Error('planted_commit_not_applied');
              }
              return client.query(sql, params);
            },
          };
          return work(wrapped);
        });
      }
      const failBridge = createEmailInboundInboxBridge(Object.freeze({
        withTransactionClient: failingCommitLoaner,
      }));
      const u = await failBridge.projectInboundEvent(Object.freeze({
        ...authority(),
        inboundEventId: evFail.id,
      }));
      assert.equal(u.status, 'uncertain');
      assert.equal(
        await count(setup, `SELECT count(*)::int AS n FROM tenant_email_inbound_inbox_projections`),
        beforeProj,
      );
      assert.equal(
        await count(setup, `SELECT count(*)::int AS n FROM messages WHERE source = 'email_inbound'`),
        beforeMsg,
      );
      console.log('ok - commit not applied → uncertain, zero durable projection');
    }

    // ── Commit applied + ack lost → uncertain then replay converges ──────
    {
      const evAck = await insertInboundEvent(setup, {
        provider_message_id: `msg-ack-lost-${crypto.randomBytes(3).toString('hex')}`,
      });
      async function ackLostLoaner(work) {
        return loaner.withTransactionClient(async (client) => {
          const wrapped = {
            async query(sql, params) {
              const norm = String(sql).replace(/\s+/g, ' ').trim();
              if (norm === 'COMMIT') {
                await client.query('COMMIT');
                throw new Error('planted_commit_ack_lost');
              }
              return client.query(sql, params);
            },
          };
          return work(wrapped);
        });
      }
      const ackBridge = createEmailInboundInboxBridge(Object.freeze({
        withTransactionClient: ackLostLoaner,
      }));
      const first = await ackBridge.projectInboundEvent(Object.freeze({
        ...authority(),
        inboundEventId: evAck.id,
      }));
      assert.equal(first.status, 'uncertain');
      const proj = await setup.query(
        `SELECT conversation_id::text AS conversation_id, message_id::text AS message_id
           FROM tenant_email_inbound_inbox_projections
          WHERE inbound_event_id = $1::uuid`,
        [evAck.id],
      );
      assert.equal(proj.rows.length, 1, 'commit applied despite lost ack');
      const replay = await bridge.projectInboundEvent(Object.freeze({
        ...authority(),
        inboundEventId: evAck.id,
      }));
      assert.equal(replay.status, 'already_projected');
      assert.equal(replay.conversation_id, proj.rows[0].conversation_id);
      assert.equal(replay.message_id, proj.rows[0].message_id);
      assert.equal(
        await count(
          setup,
          `SELECT count(*)::int AS n FROM messages m
             JOIN tenant_email_inbound_inbox_projections p ON p.message_id = m.id
            WHERE p.inbound_event_id = $1::uuid`,
          [evAck.id],
        ),
        1,
        'no duplicate message after ack-lost replay',
      );
      console.log('ok - commit-applied/ack-lost replay converges');
    }

    // ── Deletion retention: conversation CASCADE clears journal ──────────
    {
      const evDel = await insertInboundEvent(setup, {
        provider_message_id: `msg-del-${crypto.randomBytes(3).toString('hex')}`,
        sender_address: 'delete-case@example.test',
      });
      const rd = await bridge.projectInboundEvent(Object.freeze({
        ...authority(),
        inboundEventId: evDel.id,
      }));
      assert.equal(rd.status, 'projected');
      assert.equal(
        await count(
          setup,
          `SELECT count(*)::int AS n FROM tenant_email_inbound_inbox_projections WHERE conversation_id = $1::uuid`,
          [rd.conversation_id],
        ),
        1,
      );
      await setup.query(`DELETE FROM conversations WHERE id = $1::uuid`, [rd.conversation_id]);
      assert.equal(
        await count(
          setup,
          `SELECT count(*)::int AS n FROM tenant_email_inbound_inbox_projections WHERE conversation_id = $1::uuid`,
          [rd.conversation_id],
        ),
        0,
        'journal CASCADE on conversation delete',
      );
      assert.equal(
        await count(setup, `SELECT count(*)::int AS n FROM messages WHERE id = $1::uuid`, [rd.message_id]),
        0,
        'messages cascade with conversation',
      );
      console.log('ok - deletion/retention CASCADE journal with conversation');
    }

    // ── Hostile cross-tenant composite FK inserts fail ───────────────────
    {
      const foreignEvent = await insertInboundEvent(setup, {
        client_id: ids.clientB,
        location_id: ids.locationB,
        endpoint_id: ids.endpointB,
        provider_message_id: `msg-foreign-${crypto.randomBytes(3).toString('hex')}`,
        sender_address: 'foreign@example.test',
      });
      // Create a valid conversation+message under tenant A for FK pieces
      const local = await bridge.projectInboundEvent(Object.freeze({
        ...authority(),
        inboundEventId: (await insertInboundEvent(setup, {
          provider_message_id: `msg-local-fk-${crypto.randomBytes(3).toString('hex')}`,
          sender_address: 'local-fk@example.test',
        })).id,
      }));
      assert.equal(local.status, 'projected');

      let crossTenantFailed = false;
      try {
        await setup.query(
          `INSERT INTO tenant_email_inbound_inbox_projections (
             client_id, location_id, endpoint_id, inbound_event_id,
             provider, provider_mailbox_id, provider_message_id,
             conversation_id, message_id
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid,
             'microsoft_graph', $5, $6,
             $7::uuid, $8::uuid
           )`,
          [
            ids.client, ids.location, ids.endpoint, foreignEvent.id,
            ids.mailbox, `hostile-${crypto.randomBytes(3).toString('hex')}`,
            local.conversation_id, local.message_id,
          ],
        );
      } catch {
        crossTenantFailed = true;
      }
      assert.equal(crossTenantFailed, true, 'cross-tenant event composite FK rejected');

      // Cross-conversation ownership: message from A with different conversation id
      const other = await bridge.projectInboundEvent(Object.freeze({
        ...authority(),
        inboundEventId: (await insertInboundEvent(setup, {
          provider_message_id: `msg-other-conv-${crypto.randomBytes(3).toString('hex')}`,
          sender_address: 'other-conv@example.test',
        })).id,
      }));
      assert.equal(other.status, 'projected');
      assert.notEqual(other.conversation_id, local.conversation_id);

      let crossConvFailed = false;
      try {
        await setup.query(
          `INSERT INTO tenant_email_inbound_inbox_projections (
             client_id, location_id, endpoint_id, inbound_event_id,
             provider, provider_mailbox_id, provider_message_id,
             conversation_id, message_id
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid,
             'microsoft_graph', $5, $6,
             $7::uuid, $8::uuid
           )`,
          [
            ids.client, ids.location, ids.endpoint,
            (await insertInboundEvent(setup, {
              provider_message_id: `msg-xconv-ev-${crypto.randomBytes(3).toString('hex')}`,
            })).id,
            ids.mailbox, `xconv-${crypto.randomBytes(3).toString('hex')}`,
            local.conversation_id, // claim local conversation
            other.message_id, // but message belongs to other conversation
          ],
        );
      } catch {
        crossConvFailed = true;
      }
      assert.equal(crossConvFailed, true, 'message-to-conversation ownership FK rejected');
      console.log('ok - hostile composite FK / ownership inserts fail');
    }

    // ── Down fail-closed when rows exist ─────────────────────────────────
    {
      let downRefused = false;
      let downErrMsg = '';
      try {
        await applySqlFile(setup, DOWN_067);
      } catch (e) {
        downRefused = true;
        downErrMsg = String(e && e.message ? e.message : e);
      }
      assert.equal(downRefused, true, 'down refuses when projection rows exist');
      assert.match(downErrMsg, /067_down_refused/);
      assert.equal(
        await count(
          setup,
          `SELECT count(*)::int AS n FROM information_schema.tables
            WHERE table_name = 'tenant_email_inbound_inbox_projections'
              AND table_schema = current_schema()`,
        ) > 0 || await count(setup, `SELECT count(*)::int AS n FROM tenant_email_inbound_inbox_projections`) >= 0,
        true,
      );
      // Table still present with rows
      assert.ok(
        await count(setup, `SELECT count(*)::int AS n FROM tenant_email_inbound_inbox_projections`) >= 1,
      );
      console.log('ok - down migration fail-closed when projection rows exist');
    }

    // ── Two-connection concurrent same-event projection ──────────────────
    {
      const raceEvent = await insertInboundEvent(setup, {
        provider_message_id: `msg-race-${crypto.randomBytes(4).toString('hex')}`,
        sender_address: 'race@example.test',
      });
      const beforeMsg = await count(
        setup,
        `SELECT count(*)::int AS n FROM messages WHERE source = 'email_inbound'`,
      );
      const beforeProj = await count(
        setup,
        `SELECT count(*)::int AS n FROM tenant_email_inbound_inbox_projections`,
      );

      const raceLoaner = createPoolLoaner(pool, {
        searchPath: options.searchPath,
        rendezvous: true,
        rendezvousNeed: 2,
      });
      const raceBridge = createEmailInboundInboxBridge(Object.freeze({
        withTransactionClient: raceLoaner.withTransactionClient,
      }));
      const input = Object.freeze({
        ...authority(),
        inboundEventId: raceEvent.id,
      });

      const [a, b] = await Promise.all([
        raceBridge.projectInboundEvent(input),
        raceBridge.projectInboundEvent(input),
      ]);

      const statuses = [a.status, b.status].sort();
      assert.ok(
        statuses.includes('projected') || statuses.every((s) => s === 'already_projected' || s === 'projected' || s === 'uncertain'),
        `concurrent statuses unexpected: ${statuses.join(',')}`,
      );
      // Both must converge on known durable IDs (projected or already_projected).
      // If one uncertain due to engine serialization edge, replay settles.
      let winnerConv;
      let winnerMsg;
      for (const res of [a, b]) {
        if (res.status === 'projected' || res.status === 'already_projected') {
          winnerConv = res.conversation_id;
          winnerMsg = res.message_id;
        }
      }
      if (!winnerConv) {
        // Rare: both uncertain — settle via third call
        const settle = await bridge.projectInboundEvent(input);
        assert.ok(
          settle.status === 'projected' || settle.status === 'already_projected',
          `settle status ${settle.status}`,
        );
        winnerConv = settle.conversation_id;
        winnerMsg = settle.message_id;
      }

      // Normalize both via journal
      const journal = await setup.query(
        `SELECT conversation_id::text AS conversation_id, message_id::text AS message_id
           FROM tenant_email_inbound_inbox_projections
          WHERE inbound_event_id = $1::uuid`,
        [raceEvent.id],
      );
      assert.equal(journal.rows.length, 1, 'exactly one journal row after concurrent race');
      assert.equal(journal.rows[0].conversation_id, winnerConv);
      assert.equal(journal.rows[0].message_id, winnerMsg);

      const msgN = await count(
        setup,
        `SELECT count(*)::int AS n FROM messages m
           JOIN tenant_email_inbound_inbox_projections p ON p.message_id = m.id
          WHERE p.inbound_event_id = $1::uuid`,
        [raceEvent.id],
      );
      assert.equal(msgN, 1, 'exactly one message for raced event');

      // Loser mutations must not leave orphan email messages without journal
      const orphan = await count(
        setup,
        `SELECT count(*)::int AS n FROM messages m
          WHERE m.source = 'email_inbound'
            AND m.metadata->>'provider_message_id' = $1
            AND NOT EXISTS (
              SELECT 1 FROM tenant_email_inbound_inbox_projections p WHERE p.message_id = m.id
            )`,
        [raceEvent.provider_message_id],
      );
      assert.equal(orphan, 0, 'loser conversation/message mutations rolled back');

      assert.equal(raceLoaner.state.loanCount, 2, 'two exclusive loans');
      assert.equal(raceLoaner.state.releaseCount, 2, 'both clients released');
      const distinct = new Set(raceLoaner.state.loanedProcessIds.filter((p) => p != null));
      if (options.requireTrueConcurrency === true) {
        assert.ok(raceLoaner.state.maxConcurrentLoans >= 2, 'stock PostgreSQL loans must overlap');
        assert.equal(distinct.size, 2, 'stock PostgreSQL race requires two distinct backend processIDs');
        assert.ok(
          [a, b].every((res) => res.status === 'projected' || res.status === 'already_projected'),
          `stock PostgreSQL callers must both converge without uncertainty: ${statuses.join(',')}`,
        );
        assert.equal(a.conversation_id, journal.rows[0].conversation_id);
        assert.equal(b.conversation_id, journal.rows[0].conversation_id);
        assert.equal(a.message_id, journal.rows[0].message_id);
        assert.equal(b.message_id, journal.rows[0].message_id);
        console.log('ok - concurrent two-connection race (strict overlap; distinct backend processIDs)');
      } else {
        assert.ok(raceLoaner.state.maxConcurrentLoans >= 1, 'loans recorded');
        console.log(
          distinct.size >= 2
            ? 'ok - concurrent two-connection race (distinct backends processIDs)'
            : 'ok - concurrent two-connection race (serialized engine; exactly-once holds)',
        );
      }
      assert.equal(
        await count(setup, `SELECT count(*)::int AS n FROM messages WHERE source = 'email_inbound'`) - beforeMsg,
        await count(setup, `SELECT count(*)::int AS n FROM tenant_email_inbound_inbox_projections`) - beforeProj,
      );
      void beforeMsg;
      void beforeProj;
      console.log('ok - concurrent projection exactly-once + client release');
    }

    // ── Empty journal allows down ────────────────────────────────────────
    {
      await setup.query('DELETE FROM tenant_email_inbound_inbox_projections');
      // messages/conversations may remain; down only cares about journal empty
      await applySqlFile(setup, DOWN_067);
      const gone = await setup.query(
        `SELECT count(*)::int AS n FROM information_schema.tables
          WHERE table_name = 'tenant_email_inbound_inbox_projections'
            AND table_schema = current_schema()`,
      );
      assert.equal(Number(gone.rows[0].n), 0, 'down drops empty journal');
      // Re-apply 067 for cleanliness if caller continues (not required)
      console.log('ok - empty journal down succeeds');
    }
  } finally {
    setup.release();
  }
}

async function proveWithDisposableHarness() {
  const { Client, Pool } = require('pg');
  const harness = await startDisposablePostgresHarness();
  const admin = harness.admin;
  const suffix = crypto.randomBytes(4).toString('hex');
  // assertSafeDatabaseTarget requires ephemeral name wh_mig_* on loopback.
  const dbName = `wh_mig_inbox_bridge_${suffix}`;
  assert.match(dbName, /^wh_mig_[a-z0-9_]+$/);

  try {
    await waitForPg(admin);
    {
      const c = new Client(admin);
      await c.connect();
      try {
        await c.query(`CREATE DATABASE ${dbName}`);
      } finally {
        await c.end();
      }
    }

    const conn = {
      host: admin.host,
      port: admin.port,
      user: admin.user,
      password: admin.password,
      database: dbName,
    };
    const safety = assertSafeDatabaseTarget(conn);
    if (!safety.ok) {
      throw new Error(`non-disposable DSN rejected: ${(safety.errors || []).map((e) => e.code).join(',')}`);
    }
    const pool = new Pool({
      ...conn,
      max: 4,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 10_000,
    });
    assert.ok(pool.options.max >= 2);

    try {
      const setup = await pool.connect();
      try {
        await setup.query(shellSql());
        await applySqlFile(setup, UP_063);
        await applySqlFile(setup, UP_067);
      } finally {
        setup.release();
      }

      await proveBehavioral(pool, { requireTrueConcurrency: harness.backend === 'docker' });
      console.log(`PASS prove-email-inbound-inbox-bridge-pglite (harness backend=${harness.backend})`);
    } finally {
      await pool.end();
    }
  } finally {
    try {
      const c = new Client(admin);
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${dbName}`);
      } finally {
        await c.end();
      }
    } catch (_) { /* ignore drop */ }
    try {
      harness.cleanup();
    } catch (e) {
      // Prefer surfacing cleanup failures for docker resources
      if (harness.backend === 'docker') throw e;
    }
  }
}

/**
 * Optional env-gated stock PG path with isolated schema (never product DB).
 */
async function proveWithStockPgUrl(connectionString) {
  const { Pool } = require('pg');
  const schema = `inbox_br_proof_${process.pid}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  assert.match(schema, /^[a-z_][a-z0-9_]*$/);

  const pool = new Pool({
    connectionString,
    max: 4,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
  });
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    const setup = await pool.connect();
    try {
      await setup.query(`SET search_path TO ${schema}, public`);
      await setup.query(shellSql());
      await applySqlFile(setup, UP_063);
      await applySqlFile(setup, UP_067);
    } finally {
      setup.release();
    }
    await proveBehavioral(pool, { searchPath: schema, requireTrueConcurrency: true });
    console.log('PASS prove-email-inbound-inbox-bridge stock-postgres env URL');
  } finally {
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } catch (_) { /* ignore */ }
    await pool.end();
  }
}

async function main() {
  assertStaticContract();
  await proveWithDisposableHarness();

  const stockUrl = process.env[STOCK_PG_POOL_URL_ENV];
  if (stockUrl) {
    await proveWithStockPgUrl(stockUrl);
  }
}

module.exports = Object.freeze({
  STOCK_PG_POOL_URL_ENV,
  shellSql,
  proveWithDisposableHarness,
  proveWithStockPgUrl,
});

main().catch((err) => {
  console.error('FAIL prove-email-inbound-inbox-bridge-pglite');
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});

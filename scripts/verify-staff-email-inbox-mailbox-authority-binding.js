'use strict';
/**
 * Gate 3 staff email inbox mailbox authority-binding verifier.
 *
 * Production-route / real node-postgres-shape proof that SQL_RESOLVE binds
 * reply authority only when the inbound event/projection Graph mailbox UUID
 * equals the exact current tenant_email_inbound_delta_states.provider_mailbox_id
 * for the same client_id + location_id + endpoint_id + provider.
 *
 * Live blocker (Sunset draft-only revision): SQL compared endpoint public_address
 * (email address) to event provider_mailbox_id (canonical Graph mailbox UUID).
 * Migration 064 owns authoritative mailbox UUID on current delta state; public
 * address can never equal UUID, so valid conversations returned fixed 404.
 *
 * No Azure / live product DB / OAuth / Graph / deploy / network.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const {
  SQL_RESOLVE,
  createStaffEmailInboxRoutes,
  EMAIL_DRAFT_PATH,
  isEmailStaffDraftsEnabled,
  snapshotGateEnv,
  ENV_DRAFTS_ENABLED,
  ENV_OUTBOUND_ENABLED,
  ENV_SEND_ENABLED,
  ENV_PORTAL_ORIGIN,
} = require('./lib/staff-email-inbox-routes');

const UP_064 = fs.readFileSync(
  path.join(ROOT, 'database/migrations/064_tenant_email_inbound_delta_states.sql'),
  'utf8',
);

const C = '11111111-1111-4111-8111-111111111111';
const C2 = '11111111-1111-4111-8111-111111111112';
const L = '22222222-2222-4222-8222-222222222222';
const L2 = '22222222-2222-4222-8222-222222222223';
const L3 = '22222222-2222-4222-8222-222222222224';
const E = '33333333-3333-4333-8333-333333333333';
const E2 = '33333333-3333-4333-8333-333333333334';
const E3 = '33333333-3333-4333-8333-333333333335';
const A = '55555555-5555-4555-8555-555555555555';
const V = '44444444-4444-4444-8444-444444444444';
const EV = '66666666-6666-4666-8666-666666666666';
const TENANT = '77777777-7777-4777-8777-777777777777';
const MAILBOX = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MAILBOX2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PUBLIC = 'desk@sunset.test';
const K = 'sunset-somo';
const K2 = 'other-loc';
const SRC = 'AAMkAGI2-SRC-MAILBOX-AUTHORITY';
const ORIGIN = 'https://staff.sunset.test';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function tryLoadPglite() {
  try {
    return require('@electric-sql/pglite').PGlite;
  } catch (_) {
    try {
      return require('/opt/data/wolfhouse-agent/node_modules/@electric-sql/pglite').PGlite;
    } catch (_2) {
      return null;
    }
  }
}

function shellSql() {
  // Minimal parent shell: columns SQL_RESOLVE joins + 064 FKs require.
  // Node-postgres shape: parameterized $1,$2,$3; result.rows array.
  return `
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TABLE clients (
  id UUID PRIMARY KEY,
  slug TEXT NOT NULL
);

CREATE TABLE staff_users (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES clients(id),
  email TEXT,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  UNIQUE (client_id, id)
);

CREATE TABLE conversations (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL,
  phone TEXT NOT NULL,
  UNIQUE (client_id, id)
);

CREATE TABLE tenant_locations (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL,
  location_id TEXT NOT NULL,
  UNIQUE (client_id, id),
  UNIQUE (client_id, location_id)
);

CREATE TABLE tenant_channel_endpoints (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL,
  location_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  provider TEXT NOT NULL DEFAULT 'microsoft_graph',
  public_address TEXT NOT NULL,
  secret_ref TEXT,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  outbound_enabled BOOLEAN NOT NULL DEFAULT true,
  auth_mode TEXT,
  connector_mode TEXT,
  mailbox_access_kind TEXT,
  binding_status TEXT,
  UNIQUE (client_id, id)
);

CREATE TABLE tenant_email_inbound_events (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL,
  location_id UUID NOT NULL,
  endpoint_id UUID NOT NULL,
  provider TEXT NOT NULL,
  provider_mailbox_id TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_read BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (client_id, id)
);

CREATE TABLE messages (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  UNIQUE (client_id, conversation_id, id)
);

CREATE TABLE tenant_email_inbound_inbox_projections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL,
  location_id UUID NOT NULL,
  endpoint_id UUID NOT NULL,
  inbound_event_id UUID NOT NULL,
  provider TEXT NOT NULL,
  provider_mailbox_id TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  conversation_id UUID NOT NULL,
  message_id UUID NOT NULL
);
`;
}

async function seedBase(db, opts = {}) {
  const clientId = opts.clientId || C;
  const locationId = opts.locationId || L;
  const locationKey = opts.locationKey || K;
  const endpointId = opts.endpointId || E;
  const actorId = opts.actorId || A;
  const conversationId = opts.conversationId || V;
  const eventId = opts.eventId || EV;
  const mailbox = opts.mailbox || MAILBOX;
  const publicAddress = opts.publicAddress || PUBLIC;
  const provider = opts.provider || 'microsoft_graph';
  const messageId = opts.messageId || crypto.randomUUID();
  const phone = opts.phone || 'emailv1:proof';
  const outbound = opts.outbound !== false;
  const binding = opts.bindingStatus || 'verified';
  const authMode = opts.authMode !== undefined ? opts.authMode : 'delegated_authorization_code';
  const connector = opts.connectorMode !== undefined ? opts.connectorMode : 'microsoft_delegated_oauth';
  const accessKind = opts.mailboxAccessKind !== undefined ? opts.mailboxAccessKind : 'own_user';

  await db.query(
    `INSERT INTO clients (id, slug) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [clientId, opts.slug || 'sunset'],
  );
  await db.query(
    `INSERT INTO staff_users (id, client_id, email, role, status)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [actorId, clientId, 'op@test', opts.role || 'operator', opts.status || 'active'],
  );
  await db.query(
    `INSERT INTO tenant_locations (id, client_id, location_id) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [locationId, clientId, locationKey],
  );
  await db.query(
    `INSERT INTO tenant_channel_endpoints (
       id, client_id, location_id, channel, provider, public_address, secret_ref,
       outbound_enabled, auth_mode, connector_mode, mailbox_access_kind, binding_status
     ) VALUES ($1,$2,$3,'email',$4,$5,'kv:test-ref',$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO NOTHING`,
    [
      endpointId, clientId, locationKey, provider, publicAddress,
      outbound, authMode, connector, accessKind, binding,
    ],
  );
  await db.query(
    `INSERT INTO conversations (id, client_id, phone) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [conversationId, clientId, phone],
  );
  await db.query(
    `INSERT INTO tenant_email_inbound_events (
       id, client_id, location_id, endpoint_id, provider, provider_mailbox_id,
       provider_message_id, received_at, is_read
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),false)
     ON CONFLICT (id) DO NOTHING`,
    [eventId, clientId, locationId, endpointId, provider, mailbox, SRC],
  );
  await db.query(
    `INSERT INTO messages (id, client_id, conversation_id) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [messageId, clientId, conversationId],
  );
  await db.query(
    `INSERT INTO tenant_email_inbound_inbox_projections (
       client_id, location_id, endpoint_id, inbound_event_id, provider,
       provider_mailbox_id, provider_message_id, conversation_id, message_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      clientId, locationId, endpointId, eventId, provider,
      mailbox, SRC, conversationId, messageId,
    ],
  );
}

async function insertDelta(db, opts = {}) {
  const clientId = opts.clientId || C;
  const locationId = opts.locationId || L;
  const endpointId = opts.endpointId || E;
  const mailbox = opts.mailbox || MAILBOX;
  const isCurrent = opts.isCurrent !== false;
  const provider = opts.provider || 'microsoft_graph';
  const generation = opts.generation || 1;
  const tenant = opts.tenant || TENANT;
  await db.query(
    `INSERT INTO tenant_email_inbound_delta_states (
       client_id, location_id, endpoint_id, provider, provider_tenant_id,
       provider_mailbox_id, ingestion_generation, query_version, is_current,
       phase, state_version
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,'ms_messages_delta_v1',$8,'tracking',1)`,
    [
      clientId, locationId, endpointId, provider, tenant,
      mailbox, generation, isCurrent,
    ],
  );
}

async function resolve(db, params = {}) {
  const clientId = params.clientId || C;
  const actorId = params.actorId || A;
  const conversationId = params.conversationId || V;
  // Real node-postgres shape: { rows: [...] }
  return db.query(SQL_RESOLVE, [clientId, actorId, conversationId]);
}

function rowCount(res) {
  if (!res || !Array.isArray(res.rows)) return -1;
  return res.rows.length;
}

function assertNoLeak(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  // Never surface raw mailbox UUID or public address in verifier failure output
  // paths that production HTTP would use; SQL itself may return them to server.
  return !text.includes('access_token')
    && !text.includes('refresh_token')
    && !text.includes('Bearer ');
}

function assertStaticSqlContract() {
  ok(
    'SQL_RESOLVE joins current delta state as authoritative mailbox',
    /tenant_email_inbound_delta_states/.test(SQL_RESOLVE)
      && /ds\.is_current\s*=\s*true/.test(SQL_RESOLVE)
      && /ds\.client_id\s*=\s*ev\.client_id/.test(SQL_RESOLVE)
      && /ds\.location_id\s*=\s*ev\.location_id/.test(SQL_RESOLVE)
      && /ds\.endpoint_id\s*=\s*ev\.endpoint_id/.test(SQL_RESOLVE)
      && /ds\.provider\s*=\s*ev\.provider/.test(SQL_RESOLVE)
      && /ds\.provider_mailbox_id\s*=\s*ev\.provider_mailbox_id/.test(SQL_RESOLVE),
  );
  ok(
    'SQL_RESOLVE never equates public_address to Graph mailbox UUID',
    !/public_address\s*\)\s*=\s*lower\s*\(\s*btrim\s*\(\s*ev\.provider_mailbox_id/.test(SQL_RESOLVE)
      && !/public_address\s*=\s*.*provider_mailbox_id/.test(SQL_RESOLVE)
      && !/provider_mailbox_id\s*=\s*.*public_address/.test(SQL_RESOLVE),
  );
  ok(
    'SQL_RESOLVE keeps public_address non-null verified sender config',
    /ep\.binding_status\s*=\s*'verified'/.test(SQL_RESOLVE)
      && /ep\.public_address\s+IS\s+NOT\s+NULL/.test(SQL_RESOLVE)
      && /btrim\s*\(\s*ep\.public_address\s*\)\s*<>\s*''/.test(SQL_RESOLVE),
  );
  ok(
    'SQL_RESOLVE preserves actor/client/conversation binding',
    /su\.id\s*=\s*\$2::uuid/.test(SQL_RESOLVE)
      && /cl\.id\s*=\s*\$1::uuid/.test(SQL_RESOLVE)
      && /c\.id\s*=\s*\$3::uuid/.test(SQL_RESOLVE)
      && /c\.client_id\s*=\s*cl\.id/.test(SQL_RESOLVE)
      && /p\.conversation_id\s*=\s*c\.id/.test(SQL_RESOLVE)
      && /ORDER BY ev\.received_at DESC, ev\.id DESC/.test(SQL_RESOLVE)
      && /LIMIT 1/.test(SQL_RESOLVE),
  );
  ok(
    '064 current-state cardinality unique (client_id, endpoint_id) WHERE is_current',
    /tenant_email_inbound_delta_states_current_uq/.test(UP_064)
      && /ON tenant_email_inbound_delta_states\s*\(\s*client_id\s*,\s*endpoint_id\s*\)/.test(UP_064)
      && /WHERE is_current\s*=\s*true/.test(UP_064)
      && /provider_mailbox_id\s*=\s*btrim\s*\(\s*provider_mailbox_id\s*\)/.test(UP_064)
      && /provider_mailbox_id\s*~\s*'\^\[0-9a-f\]\{8\}/.test(UP_064),
  );
  ok(
    '064 mailbox identity is Graph UUID not public_address',
    /authoritative mailbox UUID/i.test(UP_064)
      && !/public_address/.test(UP_064),
  );
}

async function provePglite(PGlite) {
  const db = new PGlite();
  await db.exec(shellSql());
  await db.exec(UP_064);

  // ── Happy path: UUID mailbox equals current delta state ──────────────
  await seedBase(db);
  await insertDelta(db, { mailbox: MAILBOX, isCurrent: true, generation: 1 });
  const happy = await resolve(db);
  ok(
    'valid authority binds when event mailbox UUID equals current delta',
    rowCount(happy) === 1
      && happy.rows[0]
      && String(happy.rows[0].client_id).toLowerCase() === C
      && String(happy.rows[0].location_id).toLowerCase() === L
      && String(happy.rows[0].endpoint_id).toLowerCase() === E
      && String(happy.rows[0].conversation_id).toLowerCase() === V
      && String(happy.rows[0].source_inbound_event_id).toLowerCase() === EV
      && happy.rows[0].provider === 'microsoft_graph'
      && happy.rows[0].provider_mailbox_id === MAILBOX
      && happy.rows[0].provider_source_message_id === SRC
      && happy.rows[0].public_address === PUBLIC
      && UUID_RE.test(String(happy.rows[0].provider_mailbox_id))
      && happy.rows[0].public_address !== happy.rows[0].provider_mailbox_id
      && assertNoLeak(happy.rows[0]),
    `rows=${rowCount(happy)}`,
  );

  // ── Public-address substitution cannot satisfy mailbox identity ──────
  // Event/projection incorrectly store public address as mailbox while
  // authoritative delta holds the Graph UUID — must not bind.
  await db.exec('DELETE FROM tenant_email_inbound_inbox_projections');
  await db.exec('DELETE FROM tenant_email_inbound_events');
  await db.exec('DELETE FROM messages');
  await db.exec('DELETE FROM tenant_email_inbound_delta_states');
  await seedBase(db, {
    mailbox: PUBLIC, // impossible live shape vs Graph UUID, but proves substitution fails
    messageId: crypto.randomUUID(),
  });
  await insertDelta(db, { mailbox: MAILBOX, isCurrent: true });
  const sub = await resolve(db);
  ok(
    'public-address substitution rejected (delta UUID ≠ event mailbox)',
    rowCount(sub) === 0,
    `rows=${rowCount(sub)}`,
  );

  // Restore happy path fixture for negative cases below
  await db.exec('DELETE FROM tenant_email_inbound_inbox_projections');
  await db.exec('DELETE FROM tenant_email_inbound_events');
  await db.exec('DELETE FROM messages');
  await db.exec('DELETE FROM tenant_email_inbound_delta_states');
  await db.exec('DELETE FROM conversations');
  await db.exec('DELETE FROM tenant_channel_endpoints');
  await db.exec('DELETE FROM tenant_locations');
  await db.exec('DELETE FROM staff_users');
  await db.exec('DELETE FROM clients');
  await seedBase(db);
  await insertDelta(db, { mailbox: MAILBOX, isCurrent: true, generation: 1 });

  // ── Foreign client ───────────────────────────────────────────────────
  const foreignClient = await resolve(db, { clientId: C2 });
  ok('foreign client rejected', rowCount(foreignClient) === 0);

  // Seed foreign client fully with own conversation — still no bind for actor's client query
  await seedBase(db, {
    clientId: C2,
    locationId: L2,
    locationKey: K2,
    endpointId: E2,
    actorId: '55555555-5555-4555-8555-555555555556',
    conversationId: '44444444-4444-4444-8444-444444444445',
    eventId: '66666666-6666-4666-8666-666666666667',
    mailbox: MAILBOX2,
    publicAddress: 'other@sunset.test',
    messageId: crypto.randomUUID(),
    slug: 'other',
  });
  await insertDelta(db, {
    clientId: C2,
    locationId: L2,
    endpointId: E2,
    mailbox: MAILBOX2,
    tenant: '77777777-7777-4777-8777-777777777778',
  });
  // Query as foreign client actor against home conversation → 0
  const crossClient = await resolve(db, {
    clientId: C2,
    actorId: '55555555-5555-4555-8555-555555555556',
    conversationId: V,
  });
  ok('foreign client cannot bind home conversation', rowCount(crossClient) === 0);

  // ── Noncurrent delta state only ──────────────────────────────────────
  await db.exec('DELETE FROM tenant_email_inbound_delta_states');
  await insertDelta(db, { mailbox: MAILBOX, isCurrent: false, generation: 1 });
  const noncurrent = await resolve(db);
  ok('noncurrent delta state rejected', rowCount(noncurrent) === 0);

  // ── Mailbox mismatch (current delta has different UUID) ──────────────
  await db.exec('DELETE FROM tenant_email_inbound_delta_states');
  await insertDelta(db, { mailbox: MAILBOX2, isCurrent: true, generation: 1 });
  const mbMismatch = await resolve(db);
  ok('mailbox UUID mismatch rejected', rowCount(mbMismatch) === 0);

  // ── Provider mismatch ────────────────────────────────────────────────
  // Delta states CHECK forces microsoft_graph; event/projection can differ.
  await db.exec('DELETE FROM tenant_email_inbound_delta_states');
  await db.exec('DELETE FROM tenant_email_inbound_inbox_projections');
  await db.exec('DELETE FROM tenant_email_inbound_events');
  await db.exec('DELETE FROM messages');
  await seedBase(db, {
    provider: 'gmail_api',
    mailbox: MAILBOX,
    messageId: crypto.randomUUID(),
  });
  // Cannot insert non-microsoft delta (064 CHECK). Absence of matching current
  // delta for gmail event is provider-mismatch fail-closed.
  const provMismatch = await resolve(db);
  ok('provider mismatch / missing microsoft delta rejected', rowCount(provMismatch) === 0);

  // Restore microsoft happy path
  await db.exec('DELETE FROM tenant_email_inbound_inbox_projections');
  await db.exec('DELETE FROM tenant_email_inbound_events');
  await db.exec('DELETE FROM messages');
  await seedBase(db, { messageId: crypto.randomUUID() });
  await insertDelta(db, { mailbox: MAILBOX, isCurrent: true, generation: 1 });

  // ── Foreign location (delta for other location_id under same client) ──
  await db.exec('DELETE FROM tenant_email_inbound_delta_states');
  // Distinct location UUID (L3) under home client — not the foreign-client L2.
  await db.query(
    `INSERT INTO tenant_locations (id, client_id, location_id) VALUES ($1,$2,$3)
     ON CONFLICT (id) DO NOTHING`,
    [L3, C, 'home-other-loc'],
  );
  await insertDelta(db, {
    clientId: C,
    locationId: L3,
    endpointId: E,
    mailbox: MAILBOX,
    isCurrent: true,
    generation: 1,
  });
  // Delta location_id must equal event.location_id for the join. Foreign → 0.
  const foreignLoc = await resolve(db);
  ok('foreign location delta rejected', rowCount(foreignLoc) === 0);

  // ── Foreign endpoint (same home client, different endpoint id) ───────
  await db.exec('DELETE FROM tenant_email_inbound_delta_states');
  await db.query(
    `INSERT INTO tenant_channel_endpoints (
       id, client_id, location_id, channel, provider, public_address, secret_ref,
       outbound_enabled, auth_mode, connector_mode, mailbox_access_kind, binding_status
     ) VALUES ($1,$2,$3,'email','microsoft_graph',$4,'kv:other',true,
       'delegated_authorization_code','microsoft_delegated_oauth','own_user','verified')
     ON CONFLICT (id) DO NOTHING`,
    [E3, C, K, 'alt@sunset.test'],
  );
  await insertDelta(db, {
    clientId: C,
    locationId: L,
    endpointId: E3,
    mailbox: MAILBOX,
    isCurrent: true,
    generation: 1,
  });
  const foreignEp = await resolve(db);
  ok('foreign endpoint delta rejected', rowCount(foreignEp) === 0);

  // ── Exact current cardinality via unique constraint ──────────────────
  await db.exec('DELETE FROM tenant_email_inbound_delta_states');
  await insertDelta(db, {
    clientId: C,
    locationId: L,
    endpointId: E,
    mailbox: MAILBOX,
    isCurrent: true,
    generation: 1,
  });
  let dupBlocked = false;
  try {
    await insertDelta(db, {
      clientId: C,
      locationId: L,
      endpointId: E,
      mailbox: MAILBOX2,
      isCurrent: true,
      generation: 2,
    });
  } catch {
    dupBlocked = true;
  }
  ok(
    'ambiguous dual-current state blocked by unique index',
    dupBlocked === true,
  );
  // Historical noncurrent + one current is allowed
  await insertDelta(db, {
    clientId: C,
    locationId: L,
    endpointId: E,
    mailbox: MAILBOX,
    isCurrent: false,
    generation: 2,
  });
  const afterHist = await resolve(db);
  ok(
    'one current + historical noncurrent still exact single bind',
    rowCount(afterHist) === 1
      && afterHist.rows[0].provider_mailbox_id === MAILBOX,
    `rows=${rowCount(afterHist)}`,
  );

  // ── Production draft route uses resolveAuthority → SQL_RESOLVE ───────
  // Wire real SQL through createStaffEmailInboxRoutes with PGlite loaner.
  const { EventEmitter } = require('node:events');
  function mockReq(bodyObj) {
    const ee = new EventEmitter();
    const payload = JSON.stringify(bodyObj);
    Object.defineProperty(ee, 'headers', {
      value: Object.assign(Object.create(null), {
        'content-type': 'application/json',
        origin: ORIGIN,
      }),
      enumerable: true,
      writable: true,
    });
    process.nextTick(() => {
      ee.emit('data', Buffer.from(payload, 'utf8'));
      ee.emit('end');
    });
    return ee;
  }
  const calls = [];
  const routes = createStaffEmailInboxRoutes({
    sendJSON(_r, status, body) {
      calls.push({ status, body: body && typeof body === 'object' ? { ...body } : body });
      return body;
    },
    withPgClient: async (fn) => fn({
      async query(sql, params) {
        return db.query(sql, params || []);
      },
    }),
    runtimeEnv: Object.freeze({
      [ENV_DRAFTS_ENABLED]: 'true',
      [ENV_OUTBOUND_ENABLED]: 'true',
      [ENV_SEND_ENABLED]: 'false',
      [ENV_PORTAL_ORIGIN]: ORIGIN,
    }),
  });
  // Need reply-approvals table for draft insert path after authority resolves
  await db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_email_reply_approvals (
      approval_id UUID PRIMARY KEY,
      operation_id UUID NOT NULL UNIQUE,
      client_id UUID NOT NULL,
      location_id UUID NOT NULL,
      location_key TEXT NOT NULL,
      endpoint_id UUID NOT NULL,
      conversation_id UUID NOT NULL,
      source_inbound_event_id UUID NOT NULL,
      provider TEXT NOT NULL,
      provider_mailbox_id TEXT NOT NULL,
      provider_source_message_id TEXT NOT NULL,
      draft_actor_staff_user_id UUID NOT NULL,
      approved_actor_staff_user_id UUID,
      message_text TEXT NOT NULL,
      body_digest TEXT NOT NULL,
      state TEXT NOT NULL,
      drafted_at TIMESTAMPTZ,
      approved_at TIMESTAMPTZ
    );
  `);
  const gate = snapshotGateEnv({
    [ENV_DRAFTS_ENABLED]: 'true',
    [ENV_OUTBOUND_ENABLED]: 'true',
    [ENV_SEND_ENABLED]: 'false',
    [ENV_PORTAL_ORIGIN]: ORIGIN,
  });
  const BODY = 'Mailbox authority draft body.';
  await routes.handleDraft(
    mockReq({ conversation_id: V, message_text: BODY, approval_id: null }),
    {},
    { staff_user_id: A, client_id: C, role: 'operator', status: 'active' },
    gate,
  );
  ok(
    'production draft route binds via delta mailbox UUID (not public_address)',
    calls.length === 1
      && calls[0].status === 200
      && calls[0].body
      && calls[0].body.success === true
      && calls[0].body.conversation_id === V
      && calls[0].body.message_text === BODY
      && UUID_RE.test(String(calls[0].body.approval_id))
      && !String(JSON.stringify(calls[0].body)).includes(PUBLIC)
      && !String(JSON.stringify(calls[0].body)).includes(MAILBOX)
      && assertNoLeak(calls[0].body),
    `status=${calls[0] && calls[0].status} body=${calls[0] && JSON.stringify(calls[0].body)}`,
  );

  // Broken-path simulation: only public_address match would have worked historically.
  // Remove delta → draft must 404 not_found (fail closed).
  await db.exec('DELETE FROM tenant_email_inbound_delta_states');
  calls.length = 0;
  await routes.handleDraft(
    mockReq({ conversation_id: V, message_text: BODY, approval_id: null }),
    {},
    { staff_user_id: A, client_id: C, role: 'operator', status: 'active' },
    gate,
  );
  ok(
    'missing current delta → draft 404 not_found (fail closed)',
    calls.length === 1
      && calls[0].status === 404
      && calls[0].body
      && calls[0].body.success === false
      && calls[0].body.error === 'not_found'
      && !String(JSON.stringify(calls[0].body)).includes(PUBLIC)
      && !String(JSON.stringify(calls[0].body)).includes(MAILBOX),
    `status=${calls[0] && calls[0].status}`,
  );

  await db.close?.();
}

function assertPackageAndSourcePins() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  ok(
    'package script verify:staff-email-inbox-mailbox-authority-binding',
    pkg.scripts
      && pkg.scripts['verify:staff-email-inbox-mailbox-authority-binding']
        === 'node scripts/verify-staff-email-inbox-mailbox-authority-binding.js',
  );
  ok(
    'route path + drafts gate unchanged',
    EMAIL_DRAFT_PATH === '/staff/inbox/email/draft'
      && isEmailStaffDraftsEnabled({ [ENV_DRAFTS_ENABLED]: 'true' }) === true
      && isEmailStaffDraftsEnabled({}) === false,
  );
  const src = fs.readFileSync(
    path.join(ROOT, 'scripts/lib/staff-email-inbox-routes.js'),
    'utf8',
  );
  ok(
    'source SQL_RESOLVE export matches runtime constant',
    src.includes('const SQL_RESOLVE =')
      && src.includes('tenant_email_inbound_delta_states')
      && !/lower\s*\(\s*btrim\s*\(\s*ep\.public_address\s*\)\s*\)\s*=\s*lower\s*\(\s*btrim\s*\(\s*ev\.provider_mailbox_id/.test(src),
  );
}

async function main() {
  console.log('verify:staff-email-inbox-mailbox-authority-binding\n');
  assertStaticSqlContract();
  assertPackageAndSourcePins();

  const PGlite = tryLoadPglite();
  if (!PGlite) {
    ok('PGlite required for production-shape proof', false, 'unavailable');
  } else {
    await provePglite(PGlite);
  }

  console.log(
    `\n── verify:staff-email-inbox-mailbox-authority-binding ${
      fail === 0 ? 'PASSED' : 'FAILED'
    } (${pass} pass, ${fail} fail) ──`,
  );
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

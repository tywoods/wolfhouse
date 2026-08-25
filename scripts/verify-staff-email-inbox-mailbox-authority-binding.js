'use strict';
/**
 * Gate 3 staff email inbox mailbox authority-binding verifier.
 *
 * Production-route / real node-postgres-shape proof that SQL_RESOLVE binds
 * reply authority only when the inbound event/projection Graph mailbox UUID
 * exactly equals tenant_channel_endpoints.provider_resource_id for the same
 * verified endpoint (client/location/endpoint/provider identity preserved).
 *
 * Live blocker after #442: SQL_RESOLVE INNER JOINed current
 * tenant_email_inbound_delta_states as mailbox identity. Sunset has ZERO
 * current delta rows because inbound polling is disabled (projected=3,
 * current delta matches=0) while endpoint.provider_resource_id is present
 * and exactly equals event.provider_mailbox_id for all live inbound events.
 * Valid conversations still returned fixed 404 not_found.
 *
 * Canonical identity (source contracts — not browser/public_address):
 * - email-delegated-grant-custodian: providerMailboxId always
 *   endpoint.provider_resource_id
 * - Phase B verified grant replacer: provider_resource_id == Graph /me
 *   principal id (validated/persisted)
 * - OAuth own-user live bind: persist /me.id as provider_resource_id
 * - Outbound authority uses that same providerMailboxId
 *
 * Current inbound delta state is operational cursor state only — not required
 * outbound mailbox identity. Public_address remains non-null sender config.
 *
 * No Azure / live product DB / OAuth / Graph / deploy / network.
 */
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

const CUSTODIAN_SRC = fs.readFileSync(
  path.join(ROOT, 'scripts/lib/email-delegated-grant-custodian.js'),
  'utf8',
);
const OAUTH_SRC = fs.readFileSync(
  path.join(ROOT, 'scripts/lib/email-microsoft-delegated-oauth-contract.js'),
  'utf8',
);
const PHASE_B_REPLACER_SRC = fs.readFileSync(
  path.join(ROOT, 'scripts/lib/email-microsoft-phase-b-verified-grant-replacer.js'),
  'utf8',
);
const GRANT_INSTALLER_SRC = fs.readFileSync(
  path.join(ROOT, 'scripts/lib/email-microsoft-verified-grant-installer.js'),
  'utf8',
);
const ROUTES_SRC = fs.readFileSync(
  path.join(ROOT, 'scripts/lib/staff-email-inbox-routes.js'),
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
const MAILBOX = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MAILBOX2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PUBLIC = 'desk@sunset.test';
const K = 'sunset-somo';
const K2 = 'other-loc';
const SRC = 'AAMkAGI2-SRC-PROVIDER-RESOURCE-AUTHORITY';
const ORIGIN = 'https://staff.sunset.test';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_SQL = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

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
  // Minimal parent shell: columns SQL_RESOLVE joins require.
  // Node-postgres shape: parameterized $1,$2,$3; result.rows array.
  // No tenant_email_inbound_delta_states — live Sunset has zero current rows.
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
  provider_resource_id TEXT,
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
  subject TEXT,
  UNIQUE (client_id, id)
);

CREATE TABLE messages (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  direction TEXT,
  source TEXT,
  route TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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

-- Minimal delta-states shell only so a pre-fix SQL that still joins 064 can
-- execute. Live Sunset has this table with ZERO current rows (inbound polling
-- disabled). Fixture intentionally never inserts is_current=true rows — the
-- GREEN bind must not require them.
CREATE TABLE tenant_email_inbound_delta_states (
  client_id UUID NOT NULL,
  location_id UUID NOT NULL,
  endpoint_id UUID NOT NULL,
  provider TEXT NOT NULL,
  provider_mailbox_id TEXT NOT NULL,
  is_current BOOLEAN NOT NULL DEFAULT false
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
  const resourceId = opts.resourceId !== undefined ? opts.resourceId : mailbox;
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
       id, client_id, location_id, channel, provider, public_address, provider_resource_id,
       secret_ref, outbound_enabled, auth_mode, connector_mode, mailbox_access_kind, binding_status
     ) VALUES ($1,$2,$3,'email',$4,$5,$6,'kv:test-ref',$7,$8,$9,$10,$11)
     ON CONFLICT (id) DO NOTHING`,
    [
      endpointId, clientId, locationKey, provider, publicAddress, resourceId,
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

async function resetHome(db) {
  await db.exec('DELETE FROM tenant_email_inbound_inbox_projections');
  await db.exec('DELETE FROM tenant_email_inbound_events');
  await db.exec('DELETE FROM messages');
  await db.exec('DELETE FROM conversations');
  await db.exec('DELETE FROM tenant_channel_endpoints');
  await db.exec('DELETE FROM tenant_locations');
  await db.exec('DELETE FROM staff_users');
  await db.exec('DELETE FROM clients');
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
  return !text.includes('access_token')
    && !text.includes('refresh_token')
    && !text.includes('Bearer ');
}

function assertPhaseBIdentityContracts() {
  ok(
    'custodian DTO: providerMailboxId always endpoint.provider_resource_id',
    /providerMailboxId is always endpoint\.provider_resource_id/.test(CUSTODIAN_SRC)
      && /providerMailboxId:\s*own\.provider_resource_id/.test(CUSTODIAN_SRC)
      && /e\.provider_resource_id IS NOT NULL/.test(CUSTODIAN_SRC)
      && /UUID_CANON\.test\(own\.provider_resource_id\)/.test(CUSTODIAN_SRC),
  );
  ok(
    'OAuth own-user live bind persists /me.id as provider_resource_id',
    /persist_me_id_as_provider_resource_id:\s*true/.test(OAUTH_SRC)
      && /require_me_id_equals_provider_principal_oid:\s*true/.test(OAUTH_SRC)
      && /live_graph_path:\s*'\/me'/.test(OAUTH_SRC)
      && /me_id_field:\s*'id'/.test(OAUTH_SRC)
      && /mail_upn_email_not_ownership_keys:\s*true/.test(OAUTH_SRC),
  );
  ok(
    'Phase B verified grant replacer requires provider_resource_id == principal id',
    /o\.provider_resource_id !== id\.providerPrincipalId/.test(PHASE_B_REPLACER_SRC)
      && /!isUuid\(o\.provider_resource_id\)/.test(PHASE_B_REPLACER_SRC),
  );
  ok(
    'verified grant installer persists principal as provider_resource_id (not public_address)',
    /provider_resource_id = providerPrincipalId/.test(GRANT_INSTALLER_SRC)
      && /own\.provider_resource_id !== snap\.identity\.providerPrincipalId/.test(GRANT_INSTALLER_SRC),
  );
  ok(
    'mailbox identity is Phase B provider_resource_id not browser public_address',
    !/public_address/.test(CUSTODIAN_SRC.match(/providerMailboxId[\s\S]{0,120}/)?.[0] || 'public_address')
      || (/never public_address/.test(CUSTODIAN_SRC)
        && /providerMailboxId is always endpoint\.provider_resource_id/.test(CUSTODIAN_SRC)),
  );
}

function assertStaticSqlContract() {
  ok(
    'SQL_RESOLVE binds event mailbox to endpoint.provider_resource_id (no delta join)',
    /ev\.provider_mailbox_id\s*=\s*ep\.provider_resource_id/.test(SQL_RESOLVE)
      && !/tenant_email_inbound_delta_states/.test(SQL_RESOLVE)
      && !/\bds\./.test(SQL_RESOLVE)
      && !/is_current\s*=\s*true/.test(SQL_RESOLVE),
  );
  ok(
    'SQL_RESOLVE requires non-null/nonblank UUID provider_resource_id',
    /ep\.provider_resource_id\s+IS\s+NOT\s+NULL/.test(SQL_RESOLVE)
      && /btrim\s*\(\s*ep\.provider_resource_id\s*\)\s*<>\s*''/.test(SQL_RESOLVE)
      && /ep\.provider_resource_id\s*~\s*'?\^\[0-9a-f\]\{8\}/.test(SQL_RESOLVE),
  );
  ok(
    'SQL_RESOLVE never equates public_address to Graph mailbox UUID',
    !/btrim\(ep\.public_address\)\)\s*=\s*lower\(btrim\(ev\.provider_mailbox_id/.test(SQL_RESOLVE)
      && !/btrim\(ev\.provider_mailbox_id\)\)\s*=\s*lower\(btrim\(ep\.public_address/.test(SQL_RESOLVE)
      && !/ep\.public_address\s*=\s*ev\.provider_mailbox_id/.test(SQL_RESOLVE)
      && !/ev\.provider_mailbox_id\s*=\s*ep\.public_address/.test(SQL_RESOLVE)
      && !/ep\.public_address\s*=\s*ep\.provider_resource_id/.test(SQL_RESOLVE),
  );
  ok(
    'SQL_RESOLVE keeps public_address non-null verified sender config',
    /ep\.binding_status\s*=\s*'verified'/.test(SQL_RESOLVE)
      && /ep\.public_address\s+IS\s+NOT\s+NULL/.test(SQL_RESOLVE)
      && /btrim\s*\(\s*ep\.public_address\s*\)\s*<>\s*''/.test(SQL_RESOLVE),
  );
  ok(
    'SQL_RESOLVE preserves actor/client/conversation/projection/event bindings',
    /su\.id\s*=\s*\$2::uuid/.test(SQL_RESOLVE)
      && /cl\.id\s*=\s*\$1::uuid/.test(SQL_RESOLVE)
      && /c\.id\s*=\s*\$3::uuid/.test(SQL_RESOLVE)
      && /c\.client_id\s*=\s*cl\.id/.test(SQL_RESOLVE)
      && /p\.conversation_id\s*=\s*c\.id/.test(SQL_RESOLVE)
      && /ev\.location_id\s*=\s*p\.location_id/.test(SQL_RESOLVE)
      && /ev\.endpoint_id\s*=\s*p\.endpoint_id/.test(SQL_RESOLVE)
      && /ev\.provider\s*=\s*p\.provider/.test(SQL_RESOLVE)
      && /ev\.provider_mailbox_id\s*=\s*p\.provider_mailbox_id/.test(SQL_RESOLVE)
      && /ev\.provider_message_id\s*=\s*p\.provider_message_id/.test(SQL_RESOLVE)
      && /ep\.location_id\s*=\s*loc\.location_id/.test(SQL_RESOLVE)
      && /ORDER BY ev\.received_at DESC, ev\.id DESC/.test(SQL_RESOLVE)
      && /LIMIT 1/.test(SQL_RESOLVE),
  );
  ok(
    'SQL_RESOLVE preserves verified microsoft delegated own_user endpoint filters',
    /ev\.provider\s*=\s*'microsoft_graph'/.test(SQL_RESOLVE)
      && /ep\.provider\s*=\s*'microsoft_graph'/.test(SQL_RESOLVE)
      && /ep\.channel\s*=\s*'email'/.test(SQL_RESOLVE)
      && /ep\.auth_mode\s*=\s*'delegated_authorization_code'/.test(SQL_RESOLVE)
      && /ep\.connector_mode\s*=\s*'microsoft_delegated_oauth'/.test(SQL_RESOLVE)
      && /ep\.mailbox_access_kind\s*=\s*'own_user'/.test(SQL_RESOLVE),
  );
}

async function provePglite(PGlite) {
  const db = new PGlite();
  await db.exec(shellSql());

  // ── #442 regression / live Sunset shape ──────────────────────────────
  // Valid endpoint/event authority: provider_resource_id exact-matches
  // event.provider_mailbox_id. ZERO current delta states (table not even
  // present). #442 still 404s; GREEN must bind via provider_resource_id.
  await seedBase(db, { mailbox: MAILBOX, resourceId: MAILBOX });
  const happy = await resolve(db);
  ok(
    'valid authority binds with provider_resource_id match and NO current delta',
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
  await resetHome(db);
  await seedBase(db, {
    mailbox: PUBLIC, // event wrongly stores email as mailbox
    resourceId: MAILBOX, // endpoint holds canonical Graph UUID from Phase B
    messageId: crypto.randomUUID(),
  });
  const sub = await resolve(db);
  ok(
    'public-address substitution rejected (event mailbox ≠ provider_resource_id)',
    rowCount(sub) === 0,
    `rows=${rowCount(sub)}`,
  );

  // Event mailbox = UUID but endpoint.provider_resource_id wrongly holds public address
  await resetHome(db);
  await seedBase(db, {
    mailbox: MAILBOX,
    resourceId: PUBLIC,
    messageId: crypto.randomUUID(),
  });
  const resourceIsEmail = await resolve(db);
  ok(
    'provider_resource_id public-address value rejected (not UUID domain)',
    rowCount(resourceIsEmail) === 0,
    `rows=${rowCount(resourceIsEmail)}`,
  );

  // ── Restore happy path fixture for negative cases ────────────────────
  await resetHome(db);
  await seedBase(db, { mailbox: MAILBOX, resourceId: MAILBOX });

  // ── Foreign client ───────────────────────────────────────────────────
  const foreignClient = await resolve(db, { clientId: C2 });
  ok('foreign client rejected', rowCount(foreignClient) === 0);

  await seedBase(db, {
    clientId: C2,
    locationId: L2,
    locationKey: K2,
    endpointId: E2,
    actorId: '55555555-5555-4555-8555-555555555556',
    conversationId: '44444444-4444-4444-8444-444444444445',
    eventId: '66666666-6666-4666-8666-666666666667',
    mailbox: MAILBOX2,
    resourceId: MAILBOX2,
    publicAddress: 'other@sunset.test',
    messageId: crypto.randomUUID(),
    slug: 'other',
  });
  const crossClient = await resolve(db, {
    clientId: C2,
    actorId: '55555555-5555-4555-8555-555555555556',
    conversationId: V,
  });
  ok('foreign client cannot bind home conversation', rowCount(crossClient) === 0);

  // ── Null / blank provider_resource_id ────────────────────────────────
  await db.query(
    `UPDATE tenant_channel_endpoints SET provider_resource_id = NULL
     WHERE id = $1 AND client_id = $2`,
    [E, C],
  );
  const nullResource = await resolve(db);
  ok('null provider_resource_id rejected', rowCount(nullResource) === 0);

  await db.query(
    `UPDATE tenant_channel_endpoints SET provider_resource_id = '   '
     WHERE id = $1 AND client_id = $2`,
    [E, C],
  );
  const blankResource = await resolve(db);
  ok('blank provider_resource_id rejected', rowCount(blankResource) === 0);

  // ── Mailbox / resource mismatch ──────────────────────────────────────
  await db.query(
    `UPDATE tenant_channel_endpoints SET provider_resource_id = $1
     WHERE id = $2 AND client_id = $3`,
    [MAILBOX2, E, C],
  );
  const mbMismatch = await resolve(db);
  ok('provider_resource_id ≠ event provider_mailbox_id rejected', rowCount(mbMismatch) === 0);

  // Restore match
  await db.query(
    `UPDATE tenant_channel_endpoints SET provider_resource_id = $1
     WHERE id = $2 AND client_id = $3`,
    [MAILBOX, E, C],
  );

  // ── Provider mismatch ────────────────────────────────────────────────
  await db.exec('DELETE FROM tenant_email_inbound_inbox_projections');
  await db.exec('DELETE FROM tenant_email_inbound_events');
  await db.exec('DELETE FROM messages');
  await seedBase(db, {
    provider: 'gmail_api',
    mailbox: MAILBOX,
    resourceId: MAILBOX,
    messageId: crypto.randomUUID(),
  });
  const provMismatch = await resolve(db);
  ok('provider mismatch rejected', rowCount(provMismatch) === 0);

  // Restore microsoft happy path
  await resetHome(db);
  await seedBase(db, { mailbox: MAILBOX, resourceId: MAILBOX, messageId: crypto.randomUUID() });

  // ── Foreign location (event/projection location must match join) ─────
  // Seed a second location; move only the endpoint location_id key away
  // from the event's location → ep.location_id join fails.
  await db.query(
    `INSERT INTO tenant_locations (id, client_id, location_id) VALUES ($1,$2,$3)
     ON CONFLICT (id) DO NOTHING`,
    [L3, C, 'home-other-loc'],
  );
  await db.query(
    `UPDATE tenant_channel_endpoints SET location_id = $1
     WHERE id = $2 AND client_id = $3`,
    ['home-other-loc', E, C],
  );
  const foreignLoc = await resolve(db);
  ok('foreign location endpoint rejected', rowCount(foreignLoc) === 0);

  // Restore endpoint location key
  await db.query(
    `UPDATE tenant_channel_endpoints SET location_id = $1
     WHERE id = $2 AND client_id = $3`,
    [K, E, C],
  );

  // ── Foreign endpoint (event points at different endpoint id) ─────────
  await db.query(
    `INSERT INTO tenant_channel_endpoints (
       id, client_id, location_id, channel, provider, public_address, provider_resource_id,
       secret_ref, outbound_enabled, auth_mode, connector_mode, mailbox_access_kind, binding_status
     ) VALUES ($1,$2,$3,'email','microsoft_graph',$4,$5,'kv:other',true,
       'delegated_authorization_code','microsoft_delegated_oauth','own_user','verified')
     ON CONFLICT (id) DO NOTHING`,
    [E3, C, K, 'alt@sunset.test', MAILBOX],
  );
  await db.query(
    `UPDATE tenant_email_inbound_events SET endpoint_id = $1 WHERE id = $2 AND client_id = $3`,
    [E3, EV, C],
  );
  await db.query(
    `UPDATE tenant_email_inbound_inbox_projections SET endpoint_id = $1
     WHERE inbound_event_id = $2 AND client_id = $3`,
    [E3, EV, C],
  );
  // Conversation still projects, but we query home conversation which now
  // points at E3 — authority should bind to E3 if resource matches (it does).
  // To prove foreign endpoint isolation: change E3 resource away from event mailbox.
  await db.query(
    `UPDATE tenant_channel_endpoints SET provider_resource_id = $1 WHERE id = $2`,
    [MAILBOX2, E3],
  );
  const foreignEp = await resolve(db);
  ok('foreign/mismatched endpoint resource rejected', rowCount(foreignEp) === 0);

  // Restore happy path for draft route
  await resetHome(db);
  await seedBase(db, { mailbox: MAILBOX, resourceId: MAILBOX, messageId: crypto.randomUUID() });

  // ── Production draft route uses resolveAuthority → SQL_RESOLVE ───────
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
      subject TEXT,
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
  const BODY = 'Provider resource authority draft body.';
  await routes.handleDraft(
    mockReq({ conversation_id: V, message_text: BODY, approval_id: null }),
    {},
    { staff_user_id: A, client_id: C, role: 'operator', status: 'active' },
    gate,
  );
  ok(
    'production draft route binds via provider_resource_id (no delta required)',
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

  // Broken-path simulation: null provider_resource_id → visible email 409 not sendable.
  await db.query(
    `UPDATE tenant_channel_endpoints SET provider_resource_id = NULL
     WHERE id = $1 AND client_id = $2`,
    [E, C],
  );
  calls.length = 0;
  await routes.handleDraft(
    mockReq({ conversation_id: V, message_text: BODY, approval_id: null }),
    {},
    { staff_user_id: A, client_id: C, role: 'operator', status: 'active' },
    gate,
  );
  ok(
    'missing provider_resource_id → draft 409 mailbox not sendable (fail closed)',
    calls.length === 1
      && calls[0].status === 409
      && calls[0].body
      && calls[0].body.success === false
      && calls[0].body.error === 'email_mailbox_not_sendable'
      && !String(JSON.stringify(calls[0].body)).includes(PUBLIC)
      && !String(JSON.stringify(calls[0].body)).includes(MAILBOX),
    `status=${calls[0] && calls[0].status}`,
  );

  // Stale/foreign event: event mailbox no longer matches restored resource.
  await db.query(
    `UPDATE tenant_channel_endpoints SET provider_resource_id = $1
     WHERE id = $2 AND client_id = $3`,
    [MAILBOX, E, C],
  );
  await db.query(
    `UPDATE tenant_email_inbound_events SET provider_mailbox_id = $1
     WHERE id = $2 AND client_id = $3`,
    [MAILBOX2, EV, C],
  );
  await db.query(
    `UPDATE tenant_email_inbound_inbox_projections SET provider_mailbox_id = $1
     WHERE inbound_event_id = $2 AND client_id = $3`,
    [MAILBOX2, EV, C],
  );
  calls.length = 0;
  await routes.handleDraft(
    mockReq({ conversation_id: V, message_text: BODY, approval_id: null }),
    {},
    { staff_user_id: A, client_id: C, role: 'operator', status: 'active' },
    gate,
  );
  ok(
    'stale/foreign event mailbox → draft 409 mailbox not sendable',
    calls.length === 1
      && calls[0].status === 409
      && calls[0].body
      && calls[0].body.error === 'email_mailbox_not_sendable',
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
  ok(
    'source SQL_RESOLVE uses provider_resource_id and omits delta_states',
    ROUTES_SRC.includes('const SQL_RESOLVE =')
      && /ev\.provider_mailbox_id\s*=\s*ep\.provider_resource_id/.test(ROUTES_SRC)
      && !/tenant_email_inbound_delta_states/.test(
        ROUTES_SRC.slice(
          ROUTES_SRC.indexOf('const SQL_RESOLVE ='),
          ROUTES_SRC.indexOf('const SQL_INSERT_DRAFT'),
        ),
      )
      && !/lower\s*\(\s*btrim\s*\(\s*ep\.public_address\s*\)\s*\)\s*=\s*lower\s*\(\s*btrim\s*\(\s*ev\.provider_mailbox_id/.test(ROUTES_SRC),
  );
  ok(
    'UUID domain pin matches Phase B canonical lowercase hyphenated UUID',
    UUID_RE.test(MAILBOX)
      && (
        SQL_RESOLVE.includes(UUID_SQL)
        || /ep\.provider_resource_id\s*~\s*'?\^\[0-9a-f\]\{8\}/.test(SQL_RESOLVE)
      ),
  );
}

async function main() {
  console.log('verify:staff-email-inbox-mailbox-authority-binding\n');
  assertPhaseBIdentityContracts();
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

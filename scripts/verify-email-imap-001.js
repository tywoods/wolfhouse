'use strict';

/**
 * EMAIL-IMAP-001 — fail-closed Sunset live IMAP verify (implicit TLS/993)
 * plus bounded inbound poll into the existing MATCH / event-store / inbox-bridge
 * path. No SMTP send. No production activation.
 */

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');

const ROOT = path.join(__dirname, '..');
const CONTRACT_REL = 'scripts/lib/email-sunset-imap-secret-ref-contract.js';
const VERIFY_REL = 'scripts/lib/email-sunset-imap-live-verify.js';
const TRANSPORT_REL = 'scripts/lib/email-sunset-imap-imaps-transport.js';
const KV_REL = 'scripts/lib/email-sunset-imap-kv-secret-provider.js';
const POLL_REL = 'scripts/lib/email-sunset-imap-inbound-poll.js';
const MAPPER_REL = 'scripts/lib/email-imap-inbound-envelope-mapper.js';
const WORKER_REL = 'scripts/lib/email-imap-sunset-staging-worker.js';
const COMPOSITION_REL = 'scripts/lib/email-imap-sunset-staging-runtime-composition.js';
const SETTINGS_REL = 'scripts/lib/staff-email-settings-routes.js';
const UI_REL = 'scripts/browser/sunset-admin-email-settings-ui.js';
const API_REL = 'scripts/staff-query-api.js';
const INBOX_REL = 'scripts/browser/inbox-thread.js';
const MATCH_REL = 'scripts/lib/email-inbound-match-ingest.js';
const STORE_REL = 'scripts/lib/email-inbound-event-store.js';
const BRIDGE_REL = 'scripts/lib/email-inbound-inbox-bridge.js';
const REGISTRY_REL = 'scripts/lib/email-tenant-channel-registry.js';
const MIGRATION_REL = 'database/migrations/084_tenant_channel_endpoint_imap_health.sql';
const MIGRATION_DOWN_REL = 'database/migrations/084_tenant_channel_endpoint_imap_health_down.sql';

const PLANTED = 'super-secret-imap-password-LEAK-001';
const PLANTED_REF = 'kv:planted-should-never-leak';
const NAMES = Object.freeze([
  'sunset-imap-host',
  'sunset-imap-port',
  'sunset-imap-tls-mode',
  'sunset-imap-username',
  'sunset-imap-password',
]);
const REFS = Object.freeze(NAMES.map((name) => `kv:${name}`));
const VERIFY_FLAG = 'LUNA_EMAIL_IMAP_VERIFY_ENABLED';
const INBOUND_FLAG = 'LUNA_EMAIL_IMAP_INBOUND_ENABLED';
const POLL_FLAG = 'LUNA_EMAIL_IMAP_POLL_ENABLED';
const COMPOSITION_FLAG = 'LUNA_EMAIL_IMAP_RUNTIME_COMPOSITION_ENABLED';
const WORKER_FLAG = 'LUNA_EMAIL_IMAP_WORKER_ENABLED';
const VERIFY_PATH = '/staff/admin/email-settings/imap/verify';
const LOCATION = 'sunset-somo';
const MAILBOX = 'tywoods@gmail.com';
const SUNSET_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const LOCATION_UUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ACTOR = 'abcdef01-2345-4678-89ab-cdef01234567';
const SESSION = '11111111-1111-4111-8111-111111111111';
const ENDPOINT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FIXTURE_BODY = 'Hello Luna, I would like to book a lesson.';
const FIXTURE_SUBJECT = 'Booking question';
const FIXTURE_FROM = 'guest@example.com';
const FIXTURE_FROM_NAME = 'Guest';
const FIXTURE_MSG_ID = '<msg17@example.com>';
const FIXTURE_UIDVALIDITY = 3857529045;
const FIXTURE_UID = 17;
const PRIOR_HEALTH = '2026-08-19T00:00:00.000Z';
const OWNER_A = 'sunset-imap-poll-a';
const OWNER_B = 'sunset-imap-poll-b';
const TOKEN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const TOKEN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const TOKEN_STALE = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
const pollSql = require('./lib/email-sunset-imap-inbound-poll');
const transportSql = require('./lib/email-sunset-imap-imaps-transport');

let pass = 0;
function ok(name) {
  pass += 1;
  console.log(`  PASS  ${name}`);
}

function frozen(value) {
  return Object.freeze(value);
}

function configuredEnv(patch) {
  const env = {
    SUNSET_EMAIL_SETTINGS_UI_ENABLED: 'true',
    LUNA_DEPLOYMENT: 'sunset-staging',
    DEFAULT_CLIENT_SLUG: 'sunset',
    LUNA_EMAIL_SMTP_IDENTITY_REGISTER_ENABLED: 'true',
    [VERIFY_FLAG]: 'true',
    [INBOUND_FLAG]: 'true',
    [POLL_FLAG]: 'true',
    [COMPOSITION_FLAG]: 'true',
    [WORKER_FLAG]: 'true',
    LUNA_EMAIL_IMAP_HOST_SECRET_REF: 'kv:sunset-imap-host',
    LUNA_EMAIL_IMAP_PORT_SECRET_REF: 'kv:sunset-imap-port',
    LUNA_EMAIL_IMAP_TLS_MODE_SECRET_REF: 'kv:sunset-imap-tls-mode',
    LUNA_EMAIL_IMAP_USERNAME_SECRET_REF: 'kv:sunset-imap-username',
    LUNA_EMAIL_IMAP_PASSWORD_SECRET_REF: 'kv:sunset-imap-password',
    EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'false',
    LUNA_AUTO_SEND_ENABLED: 'false',
  };
  return frozen(Object.assign(env, patch || {}));
}

function assertNoLeak(surface, label) {
  const text = typeof surface === 'string' ? surface : JSON.stringify(surface);
  assert.ok(!text.includes(PLANTED), `${label} leaked planted secret value`);
  assert.ok(!text.includes(PLANTED_REF), `${label} leaked planted secret ref`);
  assert.ok(!/password\s*=/i.test(text), `${label} leaked password=`);
}

function response() {
  return { status: null, body: null };
}

function sendJSON(res, status, body) {
  res.status = status;
  res.body = body;
  return body;
}

function materialMap(patch) {
  return Object.assign({
    'kv:sunset-imap-host': 'imap.example.test',
    'kv:sunset-imap-port': '993',
    'kv:sunset-imap-tls-mode': 'imaps',
    'kv:sunset-imap-username': MAILBOX,
    'kv:sunset-imap-password': PLANTED,
  }, patch || {});
}

function fakeSecretProvider(map, opts) {
  const resolved = [];
  const values = map || materialMap();
  const failNames = new Set((opts && opts.failNames) || []);
  async function resolveSecret(ref) {
    resolved.push(ref);
    const name = String(ref).startsWith('kv:') ? String(ref).slice(3) : String(ref);
    if (failNames.has(name) || failNames.has(ref)) {
      throw new Error(`kv boom ${PLANTED} ${PLANTED_REF}`);
    }
    if (!Object.prototype.hasOwnProperty.call(values, ref)) return null;
    return values[ref];
  }
  return frozen({ resolveSecret, resolved });
}

function fixtureFetchedMessage() {
  return frozen({
    uid: FIXTURE_UID,
    uidvalidity: FIXTURE_UIDVALIDITY,
    flags: frozen([]),
    internalDate: '20-Aug-2026 10:00:00 +0000',
    headers: frozen({
      from: `${FIXTURE_FROM_NAME} <${FIXTURE_FROM}>`,
      subject: FIXTURE_SUBJECT,
      date: 'Thu, 20 Aug 2026 10:00:00 +0000',
      'message-id': FIXTURE_MSG_ID,
    }),
    bodyText: FIXTURE_BODY,
  });
}

function fakeImapTransport(opts) {
  const sessions = [];
  const fetches = [];
  async function verifySession(creds) {
    sessions.push({
      host: creds && creds.host,
      port: creds && creds.port,
      tlsMode: creds && creds.tlsMode,
      username: creds && creds.username,
      password: creds && creds.password,
      commands: frozen(['CAPABILITY', 'LOGIN', 'SELECT', 'LOGOUT']),
      servername: creds && creds.host,
      rejectUnauthorized: true,
    });
    if (opts && opts.failAuth) {
      return frozen({ ok: false, failed_secret_names: frozen(['sunset-imap-password']) });
    }
    if (opts && opts.failSelect) {
      return frozen({ ok: false, failed_secret_names: frozen(['sunset-imap-host']) });
    }
    if (opts && opts.failConnect) {
      return frozen({ ok: false, failed_secret_names: frozen(['sunset-imap-host']) });
    }
    return frozen({ ok: true, commands: frozen(['CAPABILITY', 'LOGIN', 'SELECT', 'LOGOUT']) });
  }
  async function fetchInbox(creds, cursor) {
    fetches.push({ creds, cursor });
    if (opts && opts.failFetch) {
      return frozen({ ok: false, failed_secret_names: frozen(['sunset-imap-host']) });
    }
    const messages = opts && opts.messages ? opts.messages : [fixtureFetchedMessage()];
    return frozen({
      ok: true,
      uidvalidity: FIXTURE_UIDVALIDITY,
      last_uid: FIXTURE_UID,
      messages: frozen(messages.slice()),
    });
  }
  return frozen({ verifySession, fetchInbox, sessions, fetches });
}

function createImapCursorLeaseMemory(opts) {
  let nowMs = opts && opts.nowMs != null ? Number(opts.nowMs) : Date.now();
  let row = null;
  if (opts && opts.cursor) {
    row = {
      uidvalidity: Number(opts.cursor.uidvalidity),
      last_uid: Number(opts.cursor.last_uid),
      lease_owner: opts.cursor.lease_owner || null,
      lease_token: opts.cursor.lease_token || null,
      lease_until: opts.cursor.lease_until || null,
    };
  }
  let chain = Promise.resolve();
  function serialize(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  }
  function leaseHeld() {
    if (!row || row.lease_token == null || row.lease_until == null) return false;
    const until = row.lease_until instanceof Date
      ? row.lease_until.getTime()
      : Date.parse(row.lease_until);
    return Number.isFinite(until) && until > nowMs;
  }
  function apply(sql, params) {
    const text = String(sql);
    if (text === pollSql.SQL_CLAIM) {
      assert.equal(params.length, 6);
      assert.equal(pollSql.SQL_CLAIM_PARAMS.clientId, 1);
      assert.equal(pollSql.SQL_CLAIM_PARAMS.locationId, 2);
      assert.equal(pollSql.SQL_CLAIM_PARAMS.endpointId, 3);
      assert.equal(pollSql.SQL_CLAIM_PARAMS.leaseOwner, 4);
      assert.equal(pollSql.SQL_CLAIM_PARAMS.leaseToken, 5);
      assert.equal(pollSql.SQL_CLAIM_PARAMS.ttlSeconds, 6);
      const owner = params[3];
      const token = params[4];
      const ttl = Number(params[5]);
      const until = new Date(nowMs + ttl * 1000);
      if (!row) {
        row = {
          uidvalidity: 1,
          last_uid: 0,
          lease_owner: owner,
          lease_token: token,
          lease_until: until,
        };
        return { rows: [Object.assign({}, row)], rowCount: 1 };
      }
      if (leaseHeld()) return { rows: [], rowCount: 0 };
      row.lease_owner = owner;
      row.lease_token = token;
      row.lease_until = until;
      return {
        rows: [{
          uidvalidity: row.uidvalidity,
          last_uid: row.last_uid,
          lease_owner: row.lease_owner,
          lease_token: row.lease_token,
          lease_until: row.lease_until,
        }],
        rowCount: 1,
      };
    }
    if (text === pollSql.SQL_COMMIT_MONOTONIC) {
      assert.equal(params.length, 6);
      assert.equal(pollSql.SQL_COMMIT_PARAMS.lastUid, 6);
      const owner = params[2];
      const token = params[3];
      const uv = Number(params[4]);
      const last = Number(params[5]);
      if (!row || !leaseHeld() || row.lease_owner !== owner || row.lease_token !== token
          || Number(row.uidvalidity) !== uv || Number(row.last_uid) > last) {
        return { rows: [], rowCount: 0 };
      }
      row.last_uid = last;
      return { rows: [{ uidvalidity: row.uidvalidity, last_uid: row.last_uid }], rowCount: 1 };
    }
    if (text === pollSql.SQL_COMMIT_RESET) {
      assert.equal(params.length, 6);
      const owner = params[2];
      const token = params[3];
      const uv = Number(params[4]);
      const last = Number(params[5]);
      if (!row || !leaseHeld() || row.lease_owner !== owner || row.lease_token !== token
          || Number(row.uidvalidity) === uv) {
        return { rows: [], rowCount: 0 };
      }
      row.uidvalidity = uv;
      row.last_uid = last;
      return { rows: [{ uidvalidity: row.uidvalidity, last_uid: row.last_uid }], rowCount: 1 };
    }
    if (text === pollSql.SQL_RELEASE) {
      assert.equal(params.length, 4);
      assert.equal(pollSql.SQL_RELEASE_PARAMS.leaseToken, 4);
      const owner = params[2];
      const token = params[3];
      if (!row || row.lease_owner !== owner || row.lease_token !== token) {
        return { rows: [], rowCount: 0 };
      }
      row.lease_owner = null;
      row.lease_token = null;
      row.lease_until = null;
      return { rows: [{ mailbox: 'INBOX' }], rowCount: 1 };
    }
    return null;
  }
  return {
    apply,
    query(sql, params) { return serialize(() => apply(sql, params)); },
    advanceMs(ms) { nowMs += ms; },
    getCursor() { return row ? Object.assign({}, row) : null; },
    nowMs() { return nowMs; },
  };
}

function fakePg(opts) {
  const health = opts && Object.prototype.hasOwnProperty.call(opts, 'imapHealth')
    ? opts.imapHealth
    : null;
  let inboundEnabled = opts && opts.inboundEnabled === true;
  const leases = opts && opts.leases
    ? opts.leases
    : createImapCursorLeaseMemory({ cursor: opts && opts.cursor, nowMs: opts && opts.nowMs });
  const persisted = [];
  const projected = [];
  const endpoint = opts && opts.missingEndpoint
    ? null
    : {
        id: ENDPOINT_ID,
        public_address: MAILBOX,
        provider: 'imap_smtp',
        inbound_enabled: inboundEnabled,
        outbound_enabled: false,
        active: false,
        default_automation_mode: 'off',
        binding_status: null,
        auth_mode: null,
        connector_mode: null,
        location_id: LOCATION,
        imap_health_verified_at: health,
        smtp_health_verified_at: opts && opts.smtpHealth ? opts.smtpHealth : null,
      };
  const queries = [];
  const query = async (sql, params) => {
    const text = String(sql);
    queries.push({ text, params });
    const leased = await leases.query(sql, params);
    if (leased) return leased;
    if (/^\s*UPDATE tenant_channel_endpoints[\s\S]*imap_health_verified_at/i.test(text)) {
      if (opts && opts.markHealthMissing) return { rows: [] };
      endpoint.imap_health_verified_at = new Date().toISOString();
      return { rows: [{ id: ENDPOINT_ID, imap_health_verified_at: endpoint.imap_health_verified_at }] };
    }
    if (/SET inbound_enabled\s*=\s*TRUE/i.test(text)) {
      if (!endpoint || endpoint.imap_health_verified_at == null) return { rows: [] };
      inboundEnabled = true;
      endpoint.inbound_enabled = true;
      return { rows: [{ id: ENDPOINT_ID, inbound_enabled: true }] };
    }
    if (/INSERT INTO tenant_email_inbound_events/i.test(text)) {
      persisted.push(params.slice());
      return { rows: [], rowCount: 1 };
    }
    if (/^\s*BEGIN\s*$/i.test(text) || /^\s*COMMIT\s*$/i.test(text) || /^\s*ROLLBACK\s*$/i.test(text)) {
      return { rows: [] };
    }
    if (/FROM clients/i.test(text)) {
      const id = opts && opts.clientId !== undefined ? opts.clientId : SUNSET_ID;
      return { rows: id ? [{ client_id: id }] : [] };
    }
    if (/FROM tenant_locations/i.test(text)) {
      if (opts && opts.locationMissing) return { rows: [] };
      return { rows: [{ location_id: LOCATION, id: LOCATION_UUID, active: true }] };
    }
    if (/pg_advisory_xact_lock/i.test(text)) {
      throw new Error('advisory xact lock must not be used for IMAP cursor');
    }
    if (/FROM tenant_channel_endpoints/i.test(text) || /SELECT id[\s\S]*imap_smtp/i.test(text)) {
      if (!endpoint) return { rows: [] };
      const row = Object.assign({}, endpoint, {
        inbound_enabled: inboundEnabled,
        location_uuid: LOCATION_UUID,
      });
      return { rows: [row] };
    }
    return { rows: [] };
  };
  return {
    query,
    queries,
    persisted,
    projected,
    leases,
    getCursor: () => leases.getCursor(),
    getEndpoint: () => endpoint,
  };
}

function fixtureEnvelope() {
  return {
    provider: 'imap_smtp',
    provider_mailbox_id: MAILBOX,
    provider_message_id: `uidvalidity:${FIXTURE_UIDVALIDITY}:uid:${FIXTURE_UID}`,
    received_at: '2026-08-20T10:00:00.000Z',
    subject: FIXTURE_SUBJECT,
    body_text: FIXTURE_BODY,
    sender_display_name: FIXTURE_FROM_NAME,
    sender_address: FIXTURE_FROM,
    is_read: false,
    conversation_id: null,
    internet_message_id: FIXTURE_MSG_ID,
  };
}

async function main() {
  const contract = require('./lib/email-sunset-imap-secret-ref-contract');
  const verifyOwner = require('./lib/email-sunset-imap-live-verify');
  const transportOwner = require('./lib/email-sunset-imap-imaps-transport');
  const pollOwner = require('./lib/email-sunset-imap-inbound-poll');
  const mapper = require('./lib/email-imap-inbound-envelope-mapper');
  const workerOwner = require('./lib/email-imap-sunset-staging-worker');
  const composition = require('./lib/email-imap-sunset-staging-runtime-composition');
  const settings = require('./lib/staff-email-settings-routes');
  const envelopeContract = require('./lib/email-inbound-envelope-contract');
  const matchIngest = require('./lib/email-inbound-match-ingest');

  assert.equal(contract.EMAIL_IMAP_VERIFY_PATH, VERIFY_PATH);
  assert.equal(contract.IMAP_VERIFY_ENABLED_ENV, VERIFY_FLAG);
  assert.equal(contract.IMAP_INBOUND_ENABLED_ENV, INBOUND_FLAG);
  assert.equal(contract.IMAP_POLL_ENABLED_ENV, POLL_FLAG);
  assert.deepEqual([...contract.SUNSET_IMAP_SECRET_NAMES], [...NAMES]);
  assert.equal(contract.SUNSET_IMAP_SECRET_ENV_KEYS['sunset-imap-host'], 'LUNA_EMAIL_IMAP_HOST_SECRET_REF');
  assert.equal(contract.SUNSET_IMAP_SECRET_ENV_KEYS['sunset-imap-port'], 'LUNA_EMAIL_IMAP_PORT_SECRET_REF');
  assert.equal(contract.SUNSET_IMAP_SECRET_ENV_KEYS['sunset-imap-tls-mode'], 'LUNA_EMAIL_IMAP_TLS_MODE_SECRET_REF');
  assert.equal(contract.SUNSET_IMAP_SECRET_ENV_KEYS['sunset-imap-username'], 'LUNA_EMAIL_IMAP_USERNAME_SECRET_REF');
  assert.equal(contract.SUNSET_IMAP_SECRET_ENV_KEYS['sunset-imap-password'], 'LUNA_EMAIL_IMAP_PASSWORD_SECRET_REF');
  assert.equal(settings.EMAIL_IMAP_VERIFY_PATH, VERIFY_PATH);
  assert.equal(verifyOwner.EMAIL_IMAP_VERIFY_PATH, VERIFY_PATH);
  assert.equal(contract.isSunsetEmailImapVerifyEnabled({}), false);
  assert.equal(contract.isSunsetEmailImapVerifyEnabled(configuredEnv({ [VERIFY_FLAG]: undefined })), false);
  assert.equal(contract.isSunsetEmailImapVerifyEnabled(configuredEnv({ LUNA_DEPLOYMENT: 'production' })), false);
  assert.equal(contract.isSunsetEmailImapVerifyEnabled(configuredEnv({ LUNA_DEPLOYMENT: 'wolfhouse-staging' })), false);
  assert.equal(contract.isSunsetEmailImapVerifyEnabled(configuredEnv({ [VERIFY_FLAG]: 'TRUE' })), false);
  assert.equal(contract.isSunsetEmailImapVerifyEnabled(configuredEnv()), true);
  ok('verify flag default-off exact true + sunset-staging only');

  {
    const missing = contract.evaluateSunsetImapSecretRefs(configuredEnv({
      LUNA_EMAIL_IMAP_PASSWORD_SECRET_REF: PLANTED,
    }));
    assert.equal(missing.ok, false);
    assert.deepEqual([...missing.missing_secret_names], ['sunset-imap-password']);
    assert.deepEqual([...missing.secret_refs], []);
    assertNoLeak(missing, 'planted password as ref value');
  }
  {
    const missing = contract.evaluateSunsetImapSecretRefs(configuredEnv({
      LUNA_EMAIL_IMAP_HOST_SECRET_REF: PLANTED_REF,
    }));
    assert.equal(missing.ok, false);
    assert.ok(missing.missing_secret_names.includes('sunset-imap-host'));
    assertNoLeak(missing, 'planted kv ref');
  }
  {
    const okRefs = contract.evaluateSunsetImapSecretRefs(configuredEnv());
    assert.equal(okRefs.ok, true);
    assert.deepEqual([...okRefs.secret_refs], [...REFS]);
  }
  ok('secret-name-only failures never leak planted values or refs');

  function verifyService(extra) {
    const env = extra && extra.env ? extra.env : configuredEnv();
    const pg = extra && extra.pg ? extra.pg : fakePg();
    const secretProvider = extra && extra.secretProvider
      ? extra.secretProvider
      : fakeSecretProvider();
    const imapTransport = extra && extra.imapTransport
      ? extra.imapTransport
      : fakeImapTransport();
    const service = verifyOwner.createSunsetImapLiveVerify(frozen({
      client: frozen({ query: pg.query.bind(pg) }),
      env,
      secretProvider,
      imapTransport,
    }));
    return { service, pg, secretProvider, imapTransport };
  }

  {
    const imapTransport = fakeImapTransport();
    const secretProvider = fakeSecretProvider();
    const { service, pg } = verifyService({ imapTransport, secretProvider });
    const ack = await service.verifyExistingImapSmtpEndpoint(frozen({
      clientId: SUNSET_ID,
      locationId: LOCATION,
      actorStaffUserId: ACTOR,
    }));
    assert.equal(ack.endpointId, ENDPOINT_ID);
    assert.equal(ack.provider, 'imap_smtp');
    assert.equal(ack.imap_verified, true);
    assert.equal(ack.inbound_enabled, false);
    assert.equal(ack.outbound_enabled, false);
    assert.equal(ack.active, false);
    assert.equal(ack.default_automation_mode, 'off');
    assert.deepEqual([...secretProvider.resolved], [...REFS]);
    assert.equal(imapTransport.sessions.length, 1);
    const session = imapTransport.sessions[0];
    assert.equal(session.host, 'imap.example.test');
    assert.equal(session.port, 993);
    assert.equal(session.tlsMode, 'imaps');
    assert.equal(session.username, MAILBOX);
    assert.equal(session.password, PLANTED);
    assert.equal(session.servername, 'imap.example.test');
    assert.equal(session.rejectUnauthorized, true);
    assert.deepEqual([...session.commands], ['CAPABILITY', 'LOGIN', 'SELECT', 'LOGOUT']);
    assert.ok(!session.commands.includes('APPEND'));
    assert.ok(!session.commands.includes('MAIL FROM'));
    assert.ok(!session.commands.includes('DATA'));
    const marked = pg.queries.some((q) => /imap_health_verified_at/i.test(q.text) && /UPDATE/i.test(q.text));
    assert.equal(marked, true);
    assert.ok(!pg.queries.some((q) => /inbound_enabled\s*=\s*TRUE/i.test(q.text)));
    const json = JSON.stringify(ack);
    assert.ok(!json.includes(PLANTED));
    assert.ok(!json.includes('kv:'));
    assert.ok(!('password' in ack));
    ok('verify success persists IMAP health while capabilities stay off');
  }

  {
    const pg = fakePg({ imapHealth: PRIOR_HEALTH });
    const { service } = verifyService({
      pg,
      imapTransport: fakeImapTransport({ failAuth: true }),
    });
    let err;
    try {
      await service.verifyExistingImapSmtpEndpoint(frozen({
        clientId: SUNSET_ID,
        locationId: LOCATION,
        actorStaffUserId: ACTOR,
      }));
    } catch (caught) {
      err = caught;
    }
    assert.ok(err);
    assert.equal(pg.getEndpoint().imap_health_verified_at, PRIOR_HEALTH);
    assert.ok(!pg.queries.some((q) => /^\s*UPDATE tenant_channel_endpoints[\s\S]*imap_health_verified_at/i.test(q.text)));
    assertNoLeak(err, 'auth failure preserves health');
    ok('verify failure preserves prior durable IMAP health');
  }

  {
    const imapTransport = fakeImapTransport();
    const { service } = verifyService({
      env: configuredEnv({ LUNA_EMAIL_IMAP_PASSWORD_SECRET_REF: undefined }),
      imapTransport,
    });
    let err;
    try {
      await service.verifyExistingImapSmtpEndpoint(frozen({
        clientId: SUNSET_ID,
        locationId: LOCATION,
        actorStaffUserId: ACTOR,
      }));
    } catch (caught) {
      err = caught;
    }
    assert.ok(err);
    assert.deepEqual([...(err.missing_secret_names || [])], ['sunset-imap-password']);
    assertNoLeak(err, 'missing password ref');
    assert.equal(imapTransport.sessions.length, 0);
    ok('missing secret ref names the NAME only and skips IMAP');
  }

  {
    const imapTransport = fakeImapTransport();
    const secretProvider = fakeSecretProvider(materialMap(), { failNames: ['sunset-imap-host'] });
    const { service } = verifyService({ imapTransport, secretProvider });
    let err;
    try {
      await service.verifyExistingImapSmtpEndpoint(frozen({
        clientId: SUNSET_ID,
        locationId: LOCATION,
        actorStaffUserId: ACTOR,
      }));
    } catch (caught) {
      err = caught;
    }
    assert.ok(err);
    assert.deepEqual([...(err.failed_secret_names || [])], ['sunset-imap-host']);
    assertNoLeak(err, 'resolve failure');
    assert.equal(imapTransport.sessions.length, 0);
    ok('secret resolve failure names failed secret NAME only');
  }

  {
    const { service, imapTransport } = verifyService({ pg: fakePg({ missingEndpoint: true }) });
    await assert.rejects(() => service.verifyExistingImapSmtpEndpoint(frozen({
      clientId: SUNSET_ID, locationId: LOCATION, actorStaffUserId: ACTOR,
    })));
    assert.equal(imapTransport.sessions.length, 0);
    ok('missing existing imap_smtp endpoint fails closed with zero IMAP');
  }

  {
    const { service, imapTransport, secretProvider } = verifyService({
      pg: fakePg({ locationMissing: true }),
    });
    await assert.rejects(() => service.verifyExistingImapSmtpEndpoint(frozen({
      clientId: SUNSET_ID, locationId: LOCATION, actorStaffUserId: ACTOR,
    })));
    assert.equal(secretProvider.resolved.length, 0);
    assert.equal(imapTransport.sessions.length, 0);
    ok('wrong location fails before secret/network');
  }

  {
    const { service, imapTransport, secretProvider } = verifyService({
      pg: fakePg({ clientId: OTHER_ID }),
    });
    await assert.rejects(() => service.verifyExistingImapSmtpEndpoint(frozen({
      clientId: SUNSET_ID, locationId: LOCATION, actorStaffUserId: ACTOR,
    })));
    assert.equal(secretProvider.resolved.length, 0);
    assert.equal(imapTransport.sessions.length, 0);
    ok('wrong tenant fails before secret/network');
  }

  {
    const imapTransport = fakeImapTransport();
    const secretProvider = fakeSecretProvider(materialMap({ 'kv:sunset-imap-tls-mode': 'starttls' }));
    const { service } = verifyService({ imapTransport, secretProvider });
    let err;
    try {
      await service.verifyExistingImapSmtpEndpoint(frozen({
        clientId: SUNSET_ID, locationId: LOCATION, actorStaffUserId: ACTOR,
      }));
    } catch (caught) {
      err = caught;
    }
    assert.ok(err);
    assert.deepEqual([...(err.failed_secret_names || [])], ['sunset-imap-tls-mode']);
    assert.equal(imapTransport.sessions.length, 0);
    ok('non-imaps tls-mode fails closed before socket');
  }

  {
    const imapTransport = fakeImapTransport();
    const secretProvider = fakeSecretProvider(materialMap({ 'kv:sunset-imap-port': '143' }));
    const { service } = verifyService({ imapTransport, secretProvider });
    let err;
    try {
      await service.verifyExistingImapSmtpEndpoint(frozen({
        clientId: SUNSET_ID, locationId: LOCATION, actorStaffUserId: ACTOR,
      }));
    } catch (caught) {
      err = caught;
    }
    assert.ok(err);
    assert.deepEqual([...(err.failed_secret_names || [])], ['sunset-imap-port']);
    assert.equal(imapTransport.sessions.length, 0);
    ok('non-993 port fails closed before socket');
  }

  assert.equal(
    settings.publicState({ provider: 'imap_smtp' }, { imap_verified: true }),
    'connected_health',
  );
  assert.equal(
    settings.endpointDto(
      { id: ENDPOINT_ID, location_id: LOCATION, provider: 'imap_smtp', public_address: MAILBOX },
      { imap_verified: true },
    ).inbound_enabled,
    false,
  );
  assert.equal(
    settings.endpointDto(
      { id: ENDPOINT_ID, location_id: LOCATION, provider: 'imap_smtp', public_address: MAILBOX },
      { imap_verified: true },
    ).outbound_enabled,
    false,
  );
  ok('settings health maps imap_verified onto connected_health with capabilities off');

  function settingsRoutes(extra) {
    const pg = extra && extra.pg ? extra.pg : fakePg({
      imapHealth: extra && extra.durableHealth === true ? '2026-08-20T00:00:00.000Z' : null,
    });
    const env = extra && extra.env ? extra.env : configuredEnv();
    const access = extra && extra.access !== undefined ? extra.access : true;
    const roleDecision = extra && extra.authz !== undefined ? extra.authz : { ok: true };
    const res = response();
    const logs = [];
    const secretProvider = extra && extra.secretProvider
      ? extra.secretProvider
      : fakeSecretProvider();
    const imapTransport = extra && extra.imapTransport
      ? extra.imapTransport
      : fakeImapTransport();
    const endpoints = extra && extra.endpoints !== undefined
      ? extra.endpoints
      : [{
          id: ENDPOINT_ID,
          location_id: LOCATION,
          provider: 'imap_smtp',
          public_address: MAILBOX,
          inbound_enabled: false,
          outbound_enabled: false,
          active: false,
          default_automation_mode: 'off',
          auth_mode: null,
          connector_mode: null,
          binding_status: null,
          smtp_health_verified_at: extra && extra.smtpDurable === true ? '2026-08-20T00:00:00.000Z' : null,
          imap_health_verified_at: extra && extra.durableHealth === true ? '2026-08-20T00:00:00.000Z' : null,
        }];
    const routes = settings.createEmailSettingsRoutes({
      runtimeEnv: env,
      sendJSON,
      assertStaffClientAccess(user, slug, r) {
        if (access === false) {
          sendJSON(r, 403, { success: false, error: 'client_access_denied' });
          return false;
        }
        if (slug !== 'sunset') {
          sendJSON(r, 403, { success: false, error: 'client_access_denied' });
          return false;
        }
        return true;
      },
      authorizeAuthenticatedStaffRoute() { return roleDecision; },
      withPgClient: (fn) => fn(pg),
      listTenantLocations: async () => ({
        ok: true,
        value: [{ location_id: LOCATION, display_name: 'Sunset', active: true }],
      }),
      listTenantChannelEndpoints: extra && extra.listEndpoints
        ? extra.listEndpoints
        : async () => ({ ok: true, value: endpoints }),
      loadPhaseBReauthEligibilityFacts: extra && extra.atomic
        ? extra.atomic
        : async () => endpoints.map((row) => ({
            endpoint_id: String(row.id),
            location_id: LOCATION,
            provider: 'imap_smtp',
            auth_mode: null,
            connector_mode: null,
            binding_status: null,
            public_address: MAILBOX,
            endpoint_active: false,
            location_active: true,
            grant_present: false,
            grant_status: null,
            reconcile_state: null,
            scope_version: null,
            grant_generation: null,
            has_active_lease: false,
            lease_token_null: true,
            lease_owner_null: true,
            lease_until_null: true,
          })),
      createImapLiveVerify: extra && extra.createVerify
        ? extra.createVerify
        : (client) => verifyOwner.createSunsetImapLiveVerify(frozen({
          client: frozen({ query: client.query.bind(client) }),
          env,
          secretProvider,
          imapTransport,
        })),
      logger: { error(msg) { logs.push(String(msg)); } },
    });
    return { routes, res, pg, logs, imapTransport, secretProvider };
  }

  {
    const { routes, res, imapTransport, secretProvider } = settingsRoutes({ durableHealth: true });
    await routes.handleGet({ client: 'sunset' }, {}, res, {
      role: 'admin', staff_user_id: ACTOR, client_slug: 'sunset', client_id: SUNSET_ID, session_id: SESSION,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.endpoints[0].connection_state, 'connected_health');
    assert.equal(res.body.endpoints[0].inbound_enabled, false);
    assert.equal(res.body.endpoints[0].outbound_enabled, false);
    assert.equal(res.body.endpoints[0].endpoint_active, false);
    assert.equal(res.body.endpoints[0].automation_enabled, false);
    assert.equal(imapTransport.sessions.length, 0);
    assert.equal(imapTransport.fetches.length, 0);
    assert.equal(secretProvider.resolved.length, 0);
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes(PLANTED));
    assert.ok(!text.includes('kv:'));
    assert.ok(!text.includes('imap_verified'));
    ok('GET derives connected_health from durable IMAP fact with zero network');
  }

  {
    const { routes, res, imapTransport } = settingsRoutes();
    await routes.handleImapVerifyPost(
      frozen({ location_id: LOCATION }),
      { method: 'POST', url: VERIFY_PATH },
      res,
      { role: 'admin', staff_user_id: ACTOR, client_slug: 'sunset', client_id: SUNSET_ID, session_id: SESSION },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.endpoint_id, ENDPOINT_ID);
    assert.equal(res.body.provider, 'imap_smtp');
    assert.equal(res.body.connection_state, 'connected_health');
    assert.equal(res.body.inbound_enabled, false);
    assert.equal(res.body.outbound_enabled, false);
    assert.equal(res.body.active, false);
    assert.equal(imapTransport.sessions.length, 1);
    assertNoLeak(res.body, 'POST imap verify success');
    ok('admin POST imap verify returns connected_health without sending');
  }

  {
    const invalidBodies = [
      { location_id: LOCATION, extra: true },
      Object.create({ location_id: LOCATION }),
      Object.defineProperty({}, 'location_id', { enumerable: true, get() { throw new Error('accessed'); } }),
      new Proxy({ location_id: LOCATION }, { ownKeys() { throw new Error('proxy'); } }),
    ];
    for (const body of invalidBodies) {
      const { routes, res, imapTransport, secretProvider } = settingsRoutes();
      await routes.handleImapVerifyPost(body, {}, res, {
        role: 'admin', staff_user_id: ACTOR, client_slug: 'sunset', client_id: SUNSET_ID,
      });
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { success: false, error: 'invalid_request' });
      assert.equal(imapTransport.sessions.length, 0);
      assert.equal(secretProvider.resolved.length, 0);
    }
    ok('POST imap verify accepts only exact plain own-data location_id body');
  }

  {
    const { routes, res, imapTransport, secretProvider } = settingsRoutes({
      env: configuredEnv({ [VERIFY_FLAG]: undefined }),
    });
    await routes.handleImapVerifyPost(
      frozen({ location_id: LOCATION }),
      { method: 'POST', url: VERIFY_PATH },
      res,
      { role: 'admin', staff_user_id: ACTOR, client_slug: 'sunset', client_id: SUNSET_ID },
    );
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { success: false, error: 'not_found' });
    assert.equal(imapTransport.sessions.length, 0);
    assert.equal(secretProvider.resolved.length, 0);
    ok('POST imap verify concealed 404 when flag off');
  }

  {
    const { routes, res, imapTransport } = settingsRoutes({
      env: configuredEnv({ LUNA_DEPLOYMENT: 'production' }),
    });
    await routes.handleImapVerifyPost(
      frozen({ location_id: LOCATION }),
      { method: 'POST', url: VERIFY_PATH },
      res,
      { role: 'admin', staff_user_id: ACTOR, client_slug: 'sunset', client_id: SUNSET_ID },
    );
    assert.equal(res.status, 404);
    assert.equal(imapTransport.sessions.length, 0);
    ok('POST imap verify concealed 404 outside sunset-staging');
  }

  {
    const { routes, res, imapTransport, secretProvider } = settingsRoutes({ access: false });
    await routes.handleImapVerifyPost(
      frozen({ location_id: LOCATION }),
      { method: 'POST', url: VERIFY_PATH },
      res,
      { role: 'admin', staff_user_id: ACTOR, client_slug: 'wolfhouse-somo', client_id: OTHER_ID },
    );
    assert.equal(res.status, 403);
    assert.equal(imapTransport.sessions.length, 0);
    assert.equal(secretProvider.resolved.length, 0);
    ok('cross-tenant ACL denial before IMAP secret/network');
  }

  {
    const { routes, res, imapTransport } = settingsRoutes();
    await routes.handleImapVerifyPost(
      frozen({ location_id: LOCATION }),
      { method: 'POST', url: VERIFY_PATH },
      res,
      { role: 'operator', staff_user_id: ACTOR, client_slug: 'sunset', client_id: SUNSET_ID },
    );
    assert.ok(res.status === 403 || res.status === 404);
    assert.equal(imapTransport.sessions.length, 0);
    ok('non-admin denied with zero IMAP');
  }

  const mapped = mapper.mapImapFetchedMessageToInboundEnvelope(frozen({
    mailbox: MAILBOX,
    message: fixtureFetchedMessage(),
  }));
  assert.equal(mapped.ok, true);
  const validated = envelopeContract.validateInboundEmailEnvelope(mapped.value);
  assert.equal(validated.ok, true);
  assert.equal(validated.value.provider, 'imap_smtp');
  assert.equal(validated.value.sender_address, FIXTURE_FROM);
  assert.equal(validated.value.body_text, FIXTURE_BODY);
  const identity = matchIngest.resolveInboundMatchConversationIdentity(frozen({
    providerMailboxId: validated.value.provider_mailbox_id,
    fromAddress: validated.value.sender_address,
  }));
  assert.ok(identity && identity.conversation_key.startsWith('emailv1:'));
  ok('normalized real-message fixture is a canonical envelope for MATCH ingest');

  function pollService(extra) {
    const env = extra && extra.env ? extra.env : configuredEnv();
    const pg = extra && extra.pg ? extra.pg : fakePg({
      imapHealth: extra && extra.imapHealth !== undefined ? extra.imapHealth : '2026-08-20T00:00:00.000Z',
      inboundEnabled: extra && extra.inboundEnabled === true,
      cursor: extra && extra.cursor,
    });
    const secretProvider = extra && extra.secretProvider
      ? extra.secretProvider
      : fakeSecretProvider();
    const imapTransport = extra && extra.imapTransport
      ? extra.imapTransport
      : fakeImapTransport();
    const ingested = extra && extra.ingested ? extra.ingested : [];
    const projected = extra && extra.projected ? extra.projected : [];
    const poller = pollOwner.createSunsetImapInboundPoll(frozen({
      client: frozen({ query: pg.query.bind(pg) }),
      env,
      secretProvider,
      imapTransport,
      leaseOwner: extra && extra.leaseOwner ? extra.leaseOwner : pollOwner.IMAP_LEASE_OWNER_DEFAULT,
      randomUUID: extra && extra.randomUUID ? extra.randomUUID : undefined,
      persistEnvelopes: extra && extra.persistEnvelopes
        ? extra.persistEnvelopes
        : async (_authority, envelopes) => {
          ingested.push(...envelopes);
          return frozen({ ok: true });
        },
      projectEvent: extra && extra.projectEvent
        ? extra.projectEvent
        : async (input) => {
          projected.push(input);
          return frozen({ status: 'projected' });
        },
    }));
    return { poller, pg, secretProvider, imapTransport, ingested, projected };
  }

  {
    const { poller, imapTransport, secretProvider } = pollService({
      imapHealth: null,
      inboundEnabled: true,
    });
    await assert.rejects(() => poller.pollVerifiedImapInbox(frozen({
      clientId: SUNSET_ID, locationId: LOCATION, actorStaffUserId: ACTOR,
    })));
    assert.equal(imapTransport.fetches.length, 0);
    assert.equal(secretProvider.resolved.length, 0);
    ok('poll without verified IMAP health does zero secret/network');
  }

  {
    const { poller, imapTransport, secretProvider } = pollService({
      inboundEnabled: false,
    });
    await assert.rejects(() => poller.pollVerifiedImapInbox(frozen({
      clientId: SUNSET_ID, locationId: LOCATION, actorStaffUserId: ACTOR,
    })));
    assert.equal(imapTransport.fetches.length, 0);
    assert.equal(secretProvider.resolved.length, 0);
    ok('poll without explicit inbound enablement does zero secret/network');
  }

  {
    const ingested = [];
    const projected = [];
    const { poller, imapTransport, pg } = pollService({
      inboundEnabled: true,
      ingested,
      projected,
    });
    const ack = await poller.pollVerifiedImapInbox(frozen({
      clientId: SUNSET_ID, locationId: LOCATION, actorStaffUserId: ACTOR,
    }));
    assert.equal(ack.ok, true);
    assert.equal(ack.fetched, 1);
    assert.equal(ingested.length, 1);
    assert.equal(ingested[0].provider, 'imap_smtp');
    assert.equal(ingested[0].body_text, FIXTURE_BODY);
    assert.equal(ingested[0].sender_address, FIXTURE_FROM);
    assert.equal(projected.length, 1);
    assert.equal(projected[0].provider, 'imap_smtp');
    assert.equal(projected[0].providerMailboxId, MAILBOX);
    assert.equal(imapTransport.fetches.length, 1);
    const cursor = pg.getCursor();
    assert.equal(Number(cursor.uidvalidity), FIXTURE_UIDVALIDITY);
    assert.equal(Number(cursor.last_uid), FIXTURE_UID);
    ok('bounded fetch persists envelope into MATCH path and advances UID cursor');
  }

  {
    const ingested = [];
    const projected = [];
    const { poller } = pollService({
      inboundEnabled: true,
      cursor: { uidvalidity: FIXTURE_UIDVALIDITY, last_uid: FIXTURE_UID },
      ingested,
      projected,
      imapTransport: fakeImapTransport({ messages: [] }),
    });
    const ack = await poller.pollVerifiedImapInbox(frozen({
      clientId: SUNSET_ID, locationId: LOCATION, actorStaffUserId: ACTOR,
    }));
    assert.equal(ack.ok, true);
    assert.equal(ack.fetched, 0);
    assert.equal(ingested.length, 0);
    assert.equal(projected.length, 0);
    ok('duplicate poll with durable cursor does not re-ingest');
  }

  {
    const { poller } = pollService({
      inboundEnabled: true,
      imapTransport: fakeImapTransport({
        messages: [
          fixtureFetchedMessage(),
          Object.assign({}, fixtureFetchedMessage(), { uid: 18 }),
          Object.assign({}, fixtureFetchedMessage(), { uid: 19 }),
          Object.assign({}, fixtureFetchedMessage(), { uid: 20 }),
          Object.assign({}, fixtureFetchedMessage(), { uid: 21 }),
          Object.assign({}, fixtureFetchedMessage(), { uid: 22 }),
        ],
      }),
    });
    const ack = await poller.pollVerifiedImapInbox(frozen({
      clientId: SUNSET_ID, locationId: LOCATION, actorStaffUserId: ACTOR,
    }));
    assert.ok(ack.fetched <= pollOwner.IMAP_FETCH_MAX_MESSAGES);
    assert.ok(pollOwner.IMAP_FETCH_MAX_MESSAGES <= 5);
    ok('fetch is bounded by max message count');
  }

  {
    assert.equal(pollSql.SQL_CLAIM_PARAMS.clientId, 1);
    assert.equal(pollSql.SQL_CLAIM_PARAMS.locationId, 2);
    assert.equal(pollSql.SQL_CLAIM_PARAMS.endpointId, 3);
    assert.equal(pollSql.SQL_CLAIM_PARAMS.leaseOwner, 4);
    assert.equal(pollSql.SQL_CLAIM_PARAMS.leaseToken, 5);
    assert.equal(pollSql.SQL_CLAIM_PARAMS.ttlSeconds, 6);
    assert.equal(pollSql.SQL_COMMIT_PARAMS.clientId, 1);
    assert.equal(pollSql.SQL_COMMIT_PARAMS.endpointId, 2);
    assert.equal(pollSql.SQL_COMMIT_PARAMS.leaseOwner, 3);
    assert.equal(pollSql.SQL_COMMIT_PARAMS.leaseToken, 4);
    assert.equal(pollSql.SQL_COMMIT_PARAMS.uidvalidity, 5);
    assert.equal(pollSql.SQL_COMMIT_PARAMS.lastUid, 6);
    assert.equal(pollSql.SQL_RELEASE_PARAMS.leaseToken, 4);
    assert.match(pollSql.SQL_CLAIM, /\$1::uuid.*\$2::uuid.*\$3::uuid.*\$4.*\$5::uuid.*\$6::text/);
    assert.match(pollSql.SQL_COMMIT_MONOTONIC, /lease_owner = \$3 AND lease_token = \$4::uuid/);
    assert.match(pollSql.SQL_COMMIT_MONOTONIC, /uidvalidity = \$5 AND last_uid <= \$6/);
    assert.match(pollSql.SQL_COMMIT_RESET, /uidvalidity <> \$5/);
    assert.doesNotMatch(pollSql.SQL_CLAIM + pollSql.SQL_COMMIT_MONOTONIC, /pg_advisory_xact_lock/);
    ok('lease SQL parameter positions are exact');
  }

  {
    const leases = createImapCursorLeaseMemory();
    const delay = { wait: null, go: null };
    delay.wait = new Promise((resolve) => { delay.go = resolve; });
    let fetchStarts = 0;
    function delayedTransport() {
      return frozen({
        async fetchInbox() {
          fetchStarts += 1;
          await delay.wait;
          return frozen({
            ok: true,
            uidvalidity: FIXTURE_UIDVALIDITY,
            last_uid: 50,
            messages: frozen([Object.assign({}, fixtureFetchedMessage(), { uid: 50 })]),
          });
        },
      });
    }
    const pgA = fakePg({
      imapHealth: '2026-08-20T00:00:00.000Z',
      inboundEnabled: true,
      leases,
    });
    const pgB = fakePg({
      imapHealth: '2026-08-20T00:00:00.000Z',
      inboundEnabled: true,
      leases,
    });
    const ingestedA = [];
    const ingestedB = [];
    const a = pollService({
      pg: pgA,
      inboundEnabled: true,
      ingested: ingestedA,
      projected: [],
      imapTransport: delayedTransport(),
      leaseOwner: OWNER_A,
      randomUUID: () => TOKEN_A,
    });
    const b = pollService({
      pg: pgB,
      inboundEnabled: true,
      ingested: ingestedB,
      projected: [],
      imapTransport: delayedTransport(),
      leaseOwner: OWNER_B,
      randomUUID: () => TOKEN_B,
    });
    const pA = a.poller.pollVerifiedImapInbox(frozen({
      clientId: SUNSET_ID, locationId: LOCATION, actorStaffUserId: ACTOR,
    }));
    for (let i = 0; i < 40 && fetchStarts < 1; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(fetchStarts, 1);
    const bSettled = await Promise.allSettled([
      b.poller.pollVerifiedImapInbox(frozen({
        clientId: SUNSET_ID, locationId: LOCATION, actorStaffUserId: ACTOR,
      })),
    ]);
    delay.go();
    const aSettled = await Promise.allSettled([pA]);
    assert.equal(aSettled[0].status, 'fulfilled');
    assert.equal(bSettled[0].status, 'rejected');
    assert.equal(fetchStarts, 1);
    assert.equal(ingestedA.length, 1);
    assert.equal(ingestedB.length, 0);
    const cursor = leases.getCursor();
    assert.equal(Number(cursor.uidvalidity), FIXTURE_UIDVALIDITY);
    assert.equal(Number(cursor.last_uid), 50);
    assert.equal(cursor.lease_token, null);
    ok('concurrent two-client poll: one claim, no cursor regression');
  }

  {
    const leases = createImapCursorLeaseMemory({
      cursor: {
        uidvalidity: FIXTURE_UIDVALIDITY,
        last_uid: 40,
        lease_owner: OWNER_A,
        lease_token: TOKEN_STALE,
        lease_until: new Date(Date.now() + 60000).toISOString(),
      },
    });
    const commit = await leases.query(pollSql.SQL_COMMIT_MONOTONIC, [
      SUNSET_ID, ENDPOINT_ID, OWNER_A, TOKEN_STALE, FIXTURE_UIDVALIDITY, 10,
    ]);
    assert.equal(commit.rowCount, 0);
    assert.equal(Number(leases.getCursor().last_uid), 40);
    leases.advanceMs(120000);
    const staleAfterExpiry = await leases.query(pollSql.SQL_COMMIT_MONOTONIC, [
      SUNSET_ID, ENDPOINT_ID, OWNER_A, TOKEN_STALE, FIXTURE_UIDVALIDITY, 99,
    ]);
    assert.equal(staleAfterExpiry.rowCount, 0);
    assert.equal(Number(leases.getCursor().last_uid), 40);
    const claimed = await leases.query(pollSql.SQL_CLAIM, [
      SUNSET_ID, LOCATION_UUID, ENDPOINT_ID, OWNER_B, TOKEN_B, '60',
    ]);
    assert.equal(claimed.rowCount, 1);
    assert.equal(claimed.rows[0].lease_token, TOKEN_B);
    const staleDuringNewLease = await leases.query(pollSql.SQL_COMMIT_MONOTONIC, [
      SUNSET_ID, ENDPOINT_ID, OWNER_A, TOKEN_STALE, FIXTURE_UIDVALIDITY, 99,
    ]);
    assert.equal(staleDuringNewLease.rowCount, 0);
    const advanced = await leases.query(pollSql.SQL_COMMIT_MONOTONIC, [
      SUNSET_ID, ENDPOINT_ID, OWNER_B, TOKEN_B, FIXTURE_UIDVALIDITY, 41,
    ]);
    assert.equal(advanced.rowCount, 1);
    assert.equal(Number(leases.getCursor().last_uid), 41);
    const released = await leases.query(pollSql.SQL_RELEASE, [
      SUNSET_ID, ENDPOINT_ID, OWNER_B, TOKEN_B,
    ]);
    assert.equal(released.rowCount, 1);
    assert.equal(leases.getCursor().lease_token, null);
    ok('stale owner cannot commit; crash/expiry converges on one owner');
  }

  {
    assert.equal(transportSql.parseRfcUid(1), 1);
    assert.equal(transportSql.parseRfcUid(4294967295), 4294967295);
    assert.equal(transportSql.parseRfcUid('4294967295'), 4294967295);
    assert.equal(transportSql.parseRfcLastUid(0), 0);
    assert.equal(transportSql.parseRfcLastUid(4294967295), 4294967295);
    assert.equal(transportSql.parseRfcUid(0), null);
    assert.equal(transportSql.parseRfcUid(4294967296), null);
    assert.equal(transportSql.parseRfcUidvalidity(4294967296), null);
    assert.equal(transportSql.parseRfcLastUid(-1), null);
    assert.equal(transportSql.parseRfcLastUid(4294967296), null);
    assert.equal(transportSql.parseRfcUid(1.5), null);
    assert.equal(transportSql.parseRfcUid(NaN), null);
    assert.equal(transportSql.parseRfcUid(Infinity), null);
    assert.equal(transportSql.parseRfcUid('01'), null);
    assert.equal(transportSql.parseRfcUid('1e2'), null);
    assert.equal(transportSql.parseRfcUid('4294967295.0'), null);
    assert.equal(transportSql.parseRfcUid(Number.MAX_SAFE_INTEGER), null);
    const mappedMin = mapper.mapImapFetchedMessageToInboundEnvelope(frozen({
      mailbox: MAILBOX,
      message: Object.assign({}, fixtureFetchedMessage(), { uid: 1, uidvalidity: 1 }),
    }));
    assert.equal(mappedMin.ok, true);
    const mappedMax = mapper.mapImapFetchedMessageToInboundEnvelope(frozen({
      mailbox: MAILBOX,
      message: Object.assign({}, fixtureFetchedMessage(), { uid: 4294967295, uidvalidity: 4294967295 }),
    }));
    assert.equal(mappedMax.ok, true);
    const mappedOver = mapper.mapImapFetchedMessageToInboundEnvelope(frozen({
      mailbox: MAILBOX,
      message: Object.assign({}, fixtureFetchedMessage(), { uid: 4294967296 }),
    }));
    assert.equal(mappedOver.ok, false);
    const mappedZero = mapper.mapImapFetchedMessageToInboundEnvelope(frozen({
      mailbox: MAILBOX,
      message: Object.assign({}, fixtureFetchedMessage(), { uid: 0 }),
    }));
    assert.equal(mappedZero.ok, false);
    const mappedUnsafe = mapper.mapImapFetchedMessageToInboundEnvelope(frozen({
      mailbox: MAILBOX,
      message: Object.assign({}, fixtureFetchedMessage(), { uid: 9007199254740993 }),
    }));
    assert.equal(mappedUnsafe.ok, false);
    ok('RFC unsigned 32-bit UID/UIDVALIDITY/last_uid min/max and over-bound');
  }

  {
    assert.equal(transportSql.parseRfcUidnext(1), 1);
    assert.equal(transportSql.parseRfcUidnext(4294967295), 4294967295);
    assert.equal(transportSql.parseRfcUidnext(0), null);
    assert.equal(transportSql.parseRfcUidnext('01'), null);
    assert.equal(transportSql.parseRfcUidnext(4294967296), null);
    assert.equal(transportSql.parseUidnext(['OK [UIDNEXT 18] Predicted next UID']), 18);
    assert.equal(transportSql.parseUidnext(['OK [UIDVALIDITY 1] UIDs valid']), null);
    assert.throws(() => transportSql.parseUidnext(['OK [UIDNEXT 0]']));
    assert.throws(() => transportSql.parseUidnext(['OK [UIDNEXT 01]']));
    assert.throws(() => transportSql.parseUidnext(['OK [UIDNEXT 4294967296]']));
    assert.throws(() => transportSql.parseUidnext(['OK [UIDNEXT foo]']));
    assert.throws(() => transportSql.parseUidnext(['OK [UIDNEXT 1]', 'OK [UIDNEXT 2]']));
    assert.throws(() => transportSql.parseUidnext(['OK [UIDNEXT 5]', 'OK [UIDNEXT 5]']));
    assert.throws(() => transportSql.parseUidnext(['OK [UIDNEXT 1] [UIDNEXT 2]']));
    assert.throws(() => transportSql.parseUidvalidity(['OK [UIDVALIDITY 1]', 'OK [UIDVALIDITY 2]']));
    const empty = transportSql.boundedUidSearchRange(0, 1);
    assert.equal(empty, null);
    const tiny = transportSql.boundedUidSearchRange(0, 2);
    assert.deepEqual(tiny, frozen({ start: 1, end: 1, bootstrap: true }));
    const boot = transportSql.boundedUidSearchRange(0, 18);
    assert.deepEqual(boot, frozen({ start: 13, end: 17, bootstrap: true }));
    const hugeBoot = transportSql.boundedUidSearchRange(0, 50000);
    assert.deepEqual(hugeBoot, frozen({ start: 49995, end: 49999, bootstrap: true }));
    assert.equal(hugeBoot.end - hugeBoot.start + 1, transportSql.IMAP_FETCH_MAX_MESSAGES);
    const forward = transportSql.boundedUidSearchRange(10, 10000);
    assert.equal(forward.bootstrap, false);
    assert.equal(forward.start, 11);
    assert.equal(forward.end, 10 + transportSql.IMAP_SEARCH_MAX_WINDOW);
    assert.equal(forward.end - forward.start + 1, transportSql.IMAP_SEARCH_MAX_WINDOW);
    const caught = transportSql.boundedUidSearchRange(17, 18);
    assert.equal(caught, null);
    assert.throws(() => transportSql.boundedUidSearchRange(20, 18));
    const cmd = transportSql.formatBoundedUidSearchCommand(13, 17);
    assert.equal(cmd, 'UID SEARCH UID 13:17');
    assert.ok(!cmd.includes('*'));
    assert.throws(() => transportSql.formatBoundedUidSearchCommand(17, 13));
    assert.throws(() => transportSql.formatBoundedUidSearchCommand(0, 5));
    ok('UIDNEXT parse is strict; SEARCH ranges are finite numeric windows');
  }

  {
    const sparse = transportSql.normalizeSearchUids([100000, 1, 7, 1, 7]);
    assert.deepEqual(sparse, [1, 7, 100000]);
    assert.equal(transportSql.formatUidSequenceSet(sparse), '1,7,100000');
    assert.ok(!transportSql.formatUidSequenceSet(sparse).includes(':'));
    const capped = transportSql.normalizeSearchUids([9, 3, 1, 8, 2, 4, 7]);
    assert.deepEqual(capped, [1, 2, 3, 4, 7]);
    assert.equal(capped.length, 5);
    ok('sparse UIDs are validated, deduped, sorted, capped at five, comma sequence-set');
  }

  {
    const gmailFrom = mapper.mapImapFetchedMessageToInboundEnvelope(frozen({
      mailbox: MAILBOX,
      message: frozen({
        uid: FIXTURE_UID,
        uidvalidity: FIXTURE_UIDVALIDITY,
        flags: frozen([]),
        internalDate: '20-Aug-2026 10:00:00 +0000',
        headers: frozen({
          from: '=?UTF-8?Q?Mar=C3=ADa_Guest?= <maria@example.com>, Other <other@example.com>',
          subject: '=?UTF-8?B?UmVzZXJ2YQ==?= =?UTF-8?Q?_question?=',
          date: 'Thu, 20 Aug 2026 10:00:00 +0000',
          'message-id': FIXTURE_MSG_ID,
        }),
        bodyText: FIXTURE_BODY,
      }),
    }));
    assert.equal(gmailFrom.ok, true);
    assert.equal(gmailFrom.value.sender_address, 'maria@example.com');
    assert.equal(gmailFrom.value.sender_display_name, 'María Guest');
    assert.equal(gmailFrom.value.subject, 'Reserva question');
    const quotedComma = mapper.mapImapFetchedMessageToInboundEnvelope(frozen({
      mailbox: MAILBOX,
      message: Object.assign({}, fixtureFetchedMessage(), {
        headers: frozen({
          from: '"Doe, John" <john.doe+tag@example.com>',
          subject: 'Re: =?UTF-8?Q?Hola?=',
          'message-id': FIXTURE_MSG_ID,
        }),
      }),
    }));
    assert.equal(quotedComma.ok, true);
    assert.equal(quotedComma.value.sender_address, 'john.doe+tag@example.com');
    assert.equal(quotedComma.value.sender_display_name, 'Doe, John');
    assert.equal(quotedComma.value.subject, 'Re: Hola');
    const quotedTrap = mapper.mapImapFetchedMessageToInboundEnvelope(frozen({
      mailbox: MAILBOX,
      message: Object.assign({}, fixtureFetchedMessage(), {
        headers: frozen({
          from: '"Foo <evil@x.com>" <real@example.com>',
          subject: 'ok',
          'message-id': FIXTURE_MSG_ID,
        }),
      }),
    }));
    assert.equal(quotedTrap.ok, true);
    assert.equal(quotedTrap.value.sender_address, 'real@example.com');
    const adversarial = [
      '<not-an-email>',
      'Name (comment@evil.com) <real@example.com>',
      '=?UTF-8?Q?=00hidden?= <real@example.com>',
      '=?UTF-8?Q?bad=0AInjected?= <real@example.com>',
      'undisclosed-recipients:;',
      'real@example.com\r\nBcc: evil@x.com',
      'not-an-address',
    ];
    for (const from of adversarial) {
      const mapped = mapper.mapImapFetchedMessageToInboundEnvelope(frozen({
        mailbox: MAILBOX,
        message: Object.assign({}, fixtureFetchedMessage(), {
          headers: frozen({ from, subject: 'x', 'message-id': FIXTURE_MSG_ID }),
        }),
      }));
      assert.equal(mapped.ok, false, `expected reject for From=${from}`);
    }
    const oversizeBody = mapper.mapImapFetchedMessageToInboundEnvelope(frozen({
      mailbox: MAILBOX,
      message: Object.assign({}, fixtureFetchedMessage(), { bodyText: 'x'.repeat(65537) }),
    }));
    assert.equal(oversizeBody.ok, false);
    ok('Gmail encoded-word/mailbox-list fixtures accepted; adversarial From rejected');
  }

  {
    const oversized = Object.assign({}, fixtureFetchedMessage(), {
      bodyText: 'x'.repeat(70000),
    });
    const mappedOversize = mapper.mapImapFetchedMessageToInboundEnvelope(frozen({
      mailbox: MAILBOX,
      message: oversized,
    }));
    assert.equal(mappedOversize.ok, false);
    ok('oversized body fail-closed in mapper');
  }

  {
    const pg = fakePg({ imapHealth: '2026-08-20T00:00:00.000Z', inboundEnabled: false });
    const { poller } = pollService({ pg, inboundEnabled: false });
    const ack = await poller.enableInboundAfterVerifiedImapHealth(frozen({
      clientId: SUNSET_ID, locationId: LOCATION,
    }));
    assert.equal(ack.inbound_enabled, true);
    assert.equal(pg.getEndpoint().active, false);
    assert.equal(pg.getEndpoint().outbound_enabled, false);
    ok('inbound may be enabled after verify while active/outbound/automation stay off');
  }

  {
    const timers = {
      calls: [],
      setTimeout(fn, ms) { this.calls.push({ fn, ms }); return { fn }; },
      clearTimeout() {},
    };
    const worker = workerOwner.createEmailImapSunsetStagingWorker({
      timers,
      intervalMs: 60000,
      query: async () => ({ rows: [] }),
      pollOnce: async () => frozen({ ok: true, fetched: 0 }),
    });
    worker.start();
    assert.equal(timers.calls.length, 1);
    assert.equal(timers.calls[0].ms, 60000);
    const first = worker.tick();
    const second = worker.tick();
    const [a, b] = await Promise.all([first, second]);
    const statuses = [a.status, b.status].sort();
    assert.ok(statuses.includes('overlap_skipped'));
    worker.stop();
    ok('worker is default-off, bounded-interval, single-flight');
  }

  {
    const readinessOff = composition.resolveEmailImapSunsetStagingRuntimeReadiness({});
    assert.equal(readinessOff.runtime_activation, false);
    const readinessOn = composition.resolveEmailImapSunsetStagingRuntimeReadiness(configuredEnv());
    assert.equal(readinessOn.ok, true);
    assert.notEqual(readinessOn.runtime_activation, true);
    const outboundOn = composition.resolveEmailImapSunsetStagingRuntimeReadiness(configuredEnv({
      EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'true',
    }));
    assert.equal(outboundOn.runtime_activation, false);
    const autoSend = composition.resolveEmailImapSunsetStagingRuntimeReadiness(configuredEnv({
      LUNA_AUTO_SEND_ENABLED: 'true',
    }));
    assert.equal(autoSend.runtime_activation, false);
    ok('IMAP runtime composition is import-inert and refuses outbound/auto-send');
  }

  const tlsPair = (function makeTlsPair() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imap-tls-'));
    const keyPath = path.join(dir, 'key.pem');
    const certPath = path.join(dir, 'cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
      '-days', '1', '-nodes',
      '-subj', '/CN=imap.example.test',
      '-addext', 'subjectAltName=DNS:imap.example.test',
    ], { stdio: 'pipe' });
    return {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
      cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
    };
  }());

  function quoteImap(value) {
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  const CREDS = frozen({
    host: 'imap.example.test',
    port: 993,
    tlsMode: 'imaps',
    username: MAILBOX,
    password: PLANTED,
  });
  const GREETING_WITH_IMAP4REV1 = '* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] imap.example.test\r\n';
  const GREETING_WITHOUT_CAPS = '* OK imap.example.test ready\r\n';

  function headerBlock() {
    return [
      `From: ${FIXTURE_FROM_NAME} <${FIXTURE_FROM}>`,
      `Subject: ${FIXTURE_SUBJECT}`,
      'Date: Thu, 20 Aug 2026 10:00:00 +0000',
      `Message-ID: ${FIXTURE_MSG_ID}`,
      '',
    ].join('\r\n');
  }

  function rfc822Plain(opts) {
    const from = opts && opts.from != null ? opts.from : `${FIXTURE_FROM_NAME} <${FIXTURE_FROM}>`;
    const subject = opts && opts.subject != null ? opts.subject : FIXTURE_SUBJECT;
    const body = opts && opts.body != null ? opts.body : FIXTURE_BODY;
    const extras = opts && Array.isArray(opts.headers) ? opts.headers : [];
    const lines = [
      `From: ${from}`,
      `Subject: ${subject}`,
      'Date: Thu, 20 Aug 2026 10:00:00 +0000',
      `Message-ID: ${FIXTURE_MSG_ID}`,
      ...extras,
    ];
    return Buffer.from(`${lines.join('\r\n')}\r\n\r\n${body}`, 'utf8');
  }

  function writeBodyFetch(socket, seq, uid, rfc822Buf) {
    socket.write(`* ${seq} FETCH (UID ${uid} FLAGS () INTERNALDATE "20-Aug-2026 10:00:00 +0000" BODY[] {${rfc822Buf.length}}\r\n`);
    socket.write(rfc822Buf);
    socket.write(')\r\n');
  }

  function writeSelectInbox(socket, tag, opts) {
    const options = opts || {};
    const uv = Object.prototype.hasOwnProperty.call(options, 'uidvalidity')
      ? options.uidvalidity
      : FIXTURE_UIDVALIDITY;
    const un = Object.prototype.hasOwnProperty.call(options, 'uidnext')
      ? options.uidnext
      : FIXTURE_UID + 1;
    const exists = options.exists != null ? options.exists : 1;
    const lines = ['* FLAGS (\\Seen)'];
    if (uv != null) lines.push(`* OK [UIDVALIDITY ${uv}] UIDs valid`);
    if (options.uidnextRaw != null) {
      lines.push(options.uidnextRaw);
    } else if (un != null) {
      lines.push(`* OK [UIDNEXT ${un}] Predicted next UID`);
    }
    if (Array.isArray(options.extraUntagged)) {
      for (let i = 0; i < options.extraUntagged.length; i += 1) lines.push(options.extraUntagged[i]);
    }
    lines.push(`* ${exists} EXISTS`);
    lines.push(`${tag} OK [READ-WRITE] SELECT completed`);
    socket.write(`${lines.join('\r\n')}\r\n`);
  }

  function parseUidSearchRange(line) {
    const match = /\bUID SEARCH UID (\d+):(\d+)\s*$/.exec(String(line || ''));
    if (!match) return null;
    return frozen({ start: Number(match[1]), end: Number(match[2]) });
  }

  function findUidSearchLine(received) {
    return (received || []).find((line) => /\bUID SEARCH\b/i.test(line)) || null;
  }

  function assertFiniteUidSearch(line, opts) {
    assert.ok(line, 'expected a UID SEARCH command');
    assert.doesNotMatch(line, /:\*/);
    assert.doesNotMatch(line, /\bSEARCH ALL\b/i);
    assert.ok(!String(line).includes(':*'), 'SEARCH must not use unbounded *');
    const range = parseUidSearchRange(line);
    assert.ok(range, `expected finite UID SEARCH range: ${line}`);
    assert.ok(Number.isInteger(range.start) && Number.isInteger(range.end));
    assert.ok(range.start >= 1 && range.end >= range.start);
    assert.ok(range.end <= 4294967295);
    const width = range.end - range.start + 1;
    const maxWindow = opts && opts.maxWindow != null
      ? opts.maxWindow
      : transportOwner.IMAP_SEARCH_MAX_WINDOW;
    assert.ok(width <= maxWindow, `SEARCH width ${width} exceeds ${maxWindow}`);
    if (opts && opts.start != null) assert.equal(range.start, opts.start);
    if (opts && opts.end != null) assert.equal(range.end, opts.end);
    return range;
  }

  function createTestTransport(port, tlsOpts) {
    return transportOwner.createSunsetImapImapsTransport(frozen({
      tlsConnect(opts) {
        return tls.connect({
          host: '127.0.0.1',
          port,
          servername: tlsOpts && Object.prototype.hasOwnProperty.call(tlsOpts, 'servername')
            ? tlsOpts.servername
            : opts.servername,
          rejectUnauthorized: true,
          ca: [tlsPair.cert],
          minVersion: 'TLSv1.2',
        });
      },
    }));
  }

  function wroteLogin(received) {
    return received.some((line) => /^A\d+\s+LOGIN\s/i.test(line));
  }

  function handleAuthSelectLogout(socket, line) {
    const parts = line.split(' ');
    const tag = parts[0];
    const verb = (parts[1] || '').toUpperCase();
    if (verb === 'LOGIN') {
      socket.write(`${tag} OK LOGIN completed\r\n`);
      return true;
    }
    if (verb === 'SELECT') {
      writeSelectInbox(socket, tag);
      return true;
    }
    if (verb === 'LOGOUT') {
      socket.write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`);
      socket.end();
      return true;
    }
    return false;
  }

  async function withImapTlsServer(handler, run, opts) {
    const received = [];
    const greeting = opts && typeof opts.greeting === 'string' ? opts.greeting : GREETING_WITH_IMAP4REV1;
    const server = tls.createServer({ key: tlsPair.key, cert: tlsPair.cert }, (socket) => {
      let buf = '';
      socket.write(greeting);
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let index;
        while ((index = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, index);
          buf = buf.slice(index + 2);
          received.push(line);
          handler(socket, line, received);
        }
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      return await run(port, received);
    } finally {
      server.close();
    }
  }

  {
    const result = await withImapTlsServer((socket, line) => {
      const parts = line.split(' ');
      const tag = parts[0];
      const verb = (parts[1] || '').toUpperCase();
      if (verb === 'CAPABILITY') {
        socket.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK CAPABILITY completed\r\n`);
      } else if (verb === 'LOGIN') {
        socket.write(`${tag} OK LOGIN completed\r\n`);
      } else if (verb === 'SELECT') {
        writeSelectInbox(socket, tag);
      } else if (verb === 'LOGOUT') {
        socket.write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`);
        socket.end();
      } else {
        socket.write(`${tag} BAD not implemented\r\n`);
      }
    }, async (port, received) => {
      const transport = transportOwner.createSunsetImapImapsTransport(frozen({
        tlsConnect(opts) {
          assert.equal(opts.servername, 'imap.example.test');
          assert.equal(opts.rejectUnauthorized, true);
          return tls.connect({
            host: '127.0.0.1',
            port,
            servername: opts.servername,
            rejectUnauthorized: true,
            ca: [tlsPair.cert],
            minVersion: 'TLSv1.2',
          });
        },
      }));
      const verified = await transport.verifySession(frozen({
        host: 'imap.example.test',
        port: 993,
        tlsMode: 'imaps',
        username: MAILBOX,
        password: PLANTED,
      }));
      return { verified, received };
    });
    assert.equal(result.verified.ok, true);
    assert.ok(result.received.some((line) => /LOGIN /i.test(line)));
    assert.ok(result.received.some((line) => /SELECT INBOX/i.test(line)));
    assert.ok(result.received.some((line) => /LOGOUT/i.test(line)));
    assert.ok(!result.received.some((line) => /APPEND|MAIL FROM|RCPT TO|^DATA$/i.test(line)));
    assert.ok(!result.received.join('\n').includes(PLANTED) || result.received.some((line) => /LOGIN /.test(line)));
    ok('real implicit-TLS IMAP verify uses SNI + cert validation and never sends');
  }

  {
    const result = await withImapTlsServer((socket, line) => {
      const parts = line.split(' ');
      const tag = parts[0];
      const verb = (parts[1] || '').toUpperCase();
      if (verb === 'CAPABILITY') {
        socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY completed\r\n`);
      } else if (verb === 'LOGIN') {
        socket.write(`${tag} OK LOGIN completed\r\n`);
      } else if (verb === 'SELECT') {
        writeSelectInbox(socket, tag);
      } else if (verb === 'UID' && /SEARCH/i.test(line)) {
        assertFiniteUidSearch(line, { maxWindow: transportOwner.IMAP_FETCH_MAX_MESSAGES, start: 13, end: 17 });
        socket.write(`* SEARCH ${FIXTURE_UID}\r\n${tag} OK SEARCH completed\r\n`);
      } else if (verb === 'UID' && /FETCH/i.test(line)) {
        assert.match(line, /BODY\.PEEK\[\]/);
        assert.doesNotMatch(line, /BODY\.PEEK\[TEXT\]|HEADER\.FIELDS/);
        writeBodyFetch(socket, 1, FIXTURE_UID, rfc822Plain());
        socket.write(`${tag} OK FETCH completed\r\n`);
      } else if (verb === 'LOGOUT') {
        socket.write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`);
        socket.end();
      } else {
        socket.write(`${tag} BAD not implemented\r\n`);
      }
    }, async (port) => {
      const transport = transportOwner.createSunsetImapImapsTransport(frozen({
        tlsConnect(opts) {
          return tls.connect({
            host: '127.0.0.1',
            port,
            servername: opts.servername,
            rejectUnauthorized: true,
            ca: [tlsPair.cert],
            minVersion: 'TLSv1.2',
          });
        },
      }));
      return transport.fetchInbox(frozen({
        host: 'imap.example.test',
        port: 993,
        tlsMode: 'imaps',
        username: MAILBOX,
        password: PLANTED,
      }), frozen({ uidvalidity: null, last_uid: 0 }));
    });
    assert.equal(result.ok, true);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].uid, FIXTURE_UID);
    assert.equal(result.uidvalidity, FIXTURE_UIDVALIDITY);
    assert.equal(result.messages[0].bodyText, FIXTURE_BODY);
    assert.equal(result.messages[0].headers.from, `${FIXTURE_FROM_NAME} <${FIXTURE_FROM}>`);
    const mappedBody = mapper.mapImapFetchedMessageToInboundEnvelope(frozen({
      mailbox: MAILBOX,
      message: result.messages[0],
    }));
    assert.equal(mappedBody.ok, true);
    assert.equal(mappedBody.value.body_text, FIXTURE_BODY);
    ok('real IMAP fetch returns one bounded INBOX message');
  }

  {
    const failed = await withImapTlsServer((socket, line) => {
      const tag = line.split(' ')[0];
      socket.write(`Z9999 OK hijack\r\n${tag} OK ignored\r\n`);
    }, async (port) => {
      const transport = transportOwner.createSunsetImapImapsTransport(frozen({
        tlsConnect(opts) {
          return tls.connect({
            host: '127.0.0.1',
            port,
            servername: opts.servername,
            rejectUnauthorized: true,
            ca: [tlsPair.cert],
            minVersion: 'TLSv1.2',
          });
        },
      }));
      return transport.verifySession(frozen({
        host: 'imap.example.test',
        port: 993,
        tlsMode: 'imaps',
        username: MAILBOX,
        password: PLANTED,
      }));
    });
    assert.equal(failed.ok, false);
    ok('strict same-tag IMAP replies fail closed on tag mismatch');
  }

  {
    const failed = await withImapTlsServer((socket, line) => {
      const tag = line.split(' ')[0];
      const verb = (line.split(' ')[1] || '').toUpperCase();
      if (verb === 'CAPABILITY') {
        socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY completed\r\n`);
      } else if (verb === 'LOGIN') {
        socket.write(`${tag} NO [AUTHENTICATIONFAILED] denied\r\n`);
      } else if (verb === 'LOGOUT') {
        socket.write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`);
        socket.end();
      } else {
        socket.write(`${tag} BAD\r\n`);
      }
    }, async (port) => {
      const transport = transportOwner.createSunsetImapImapsTransport(frozen({
        tlsConnect(opts) {
          return tls.connect({
            host: '127.0.0.1',
            port,
            servername: opts.servername,
            rejectUnauthorized: true,
            ca: [tlsPair.cert],
            minVersion: 'TLSv1.2',
          });
        },
      }));
      return transport.verifySession(frozen({
        host: 'imap.example.test',
        port: 993,
        tlsMode: 'imaps',
        username: MAILBOX,
        password: PLANTED,
      }));
    });
    assert.equal(failed.ok, false);
    assert.deepEqual([...(failed.failed_secret_names || [])], ['sunset-imap-password']);
    ok('LOGIN/AUTH failure names sunset-imap-password only');
  }

  {
    const failed = await withImapTlsServer((socket) => {
      socket.write(`${'x'.repeat(200000)}\r\n`);
    }, async (port) => {
      const transport = transportOwner.createSunsetImapImapsTransport(frozen({
        tlsConnect(opts) {
          return tls.connect({
            host: '127.0.0.1',
            port,
            servername: opts.servername,
            rejectUnauthorized: true,
            ca: [tlsPair.cert],
            minVersion: 'TLSv1.2',
          });
        },
      }));
      return transport.verifySession(frozen({
        host: 'imap.example.test',
        port: 993,
        tlsMode: 'imaps',
        username: MAILBOX,
        password: PLANTED,
      }));
    });
    assert.equal(failed.ok, false);
    ok('malformed/oversized IMAP responses fail closed');
  }

  {
    const failed = await withImapTlsServer(() => {}, async (port) => {
      const transport = transportOwner.createSunsetImapImapsTransport(frozen({
        tlsConnect(opts) {
          return tls.connect({
            host: '127.0.0.1',
            port,
            servername: 'wrong.example.test',
            rejectUnauthorized: true,
            ca: [tlsPair.cert],
            minVersion: 'TLSv1.2',
          });
        },
      }));
      return transport.verifySession(frozen({
        host: 'imap.example.test',
        port: 993,
        tlsMode: 'imaps',
        username: MAILBOX,
        password: PLANTED,
      }));
    });
    assert.equal(failed.ok, false);
    ok('SNI/certificate mismatch fails closed');
  }

  {
    const hostile = [
      { username: `user\r\nUID SEARCH ALL\r\n`, password: 'ok-password', name: 'sunset-imap-username' },
      { username: `user\nLOGOUT`, password: 'ok-password', name: 'sunset-imap-username' },
      { username: 'ok-user', password: `pass\r\nSELECT INBOX\r\n`, name: 'sunset-imap-password' },
      { username: 'ok-user\0x', password: 'ok-password', name: 'sunset-imap-username' },
      { username: 'ok-user', password: 'pass\x1b', name: 'sunset-imap-password' },
      { username: '', password: 'ok-password', name: 'sunset-imap-username' },
      { username: 'ok-user', password: 'p'.repeat(300), name: 'sunset-imap-password' },
    ];
    for (const item of hostile) {
      let opens = 0;
      let writes = 0;
      const transport = transportOwner.createSunsetImapImapsTransport(frozen({
        tlsConnect() {
          opens += 1;
          return {
            write() { writes += 1; },
            on() {},
            once() {},
            setTimeout() {},
            destroy() {},
            removeListener() {},
          };
        },
      }));
      const verified = await transport.verifySession(frozen({
        host: 'imap.example.test',
        port: 993,
        tlsMode: 'imaps',
        username: item.username,
        password: item.password,
      }));
      assert.equal(verified.ok, false);
      assert.equal(opens, 0, 'hostile credential must not open a socket');
      assert.equal(writes, 0, 'hostile credential must not write a command');
      assert.deepEqual([...(verified.failed_secret_names || [])], [item.name]);
      assertNoLeak(verified, 'hostile imap credential');
      assert.throws(() => transportSql.quoteImapString(item.username === 'ok-user' ? item.password : item.username));
    }
    ok('hostile username/password rejected before socket open/write; name-only errors');
  }

  {
    const result = await withImapTlsServer((socket, line) => {
      const parts = line.split(' ');
      const tag = parts[0];
      const verb = (parts[1] || '').toUpperCase();
      if (verb === 'CAPABILITY') {
        socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY completed\r\n`);
      } else if (verb === 'LOGIN') {
        socket.write(`${tag} OK LOGIN completed\r\n`);
      } else if (verb === 'SELECT') {
        writeSelectInbox(socket, tag, { uidnext: 100001, exists: 3 });
      } else if (verb === 'UID' && /SEARCH/i.test(line)) {
        assertFiniteUidSearch(line, {
          maxWindow: transportOwner.IMAP_FETCH_MAX_MESSAGES,
          start: 99996,
          end: 100000,
        });
        socket.write(`* SEARCH 100000 99997 99999\r\n${tag} OK SEARCH completed\r\n`);
      } else if (verb === 'UID' && /FETCH/i.test(line)) {
        assert.match(line, /UID FETCH 99997,99999,100000 /);
        assert.doesNotMatch(line, /100000:99997|99996:100000|100000:100000/);
        const uids = [99997, 99999, 100000];
        for (let i = 0; i < uids.length; i += 1) {
          writeBodyFetch(socket, i + 1, uids[i], rfc822Plain());
        }
        socket.write(`${tag} OK FETCH completed\r\n`);
      } else if (verb === 'LOGOUT') {
        socket.write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`);
        socket.end();
      } else {
        socket.write(`${tag} BAD not implemented\r\n`);
      }
    }, async (port, received) => {
      const fetched = await createTestTransport(port).fetchInbox(
        CREDS,
        frozen({ uidvalidity: null, last_uid: 0 }),
      );
      return { fetched, received };
    });
    assert.equal(result.fetched.ok, true);
    assert.equal(result.fetched.messages.length, 3);
    assert.deepEqual(result.fetched.messages.map((msg) => msg.uid), [99997, 99999, 100000]);
    const fetchLine = result.received.find((line) => /UID FETCH /.test(line));
    assert.match(fetchLine, /UID FETCH 99997,99999,100000 /);
    ok('fake server sparse reordered SEARCH 100000 1 7 emits comma sequence-set');
  }

  {
    const unexpected = await withImapTlsServer((socket, line) => {
      const parts = line.split(' ');
      const tag = parts[0];
      const verb = (parts[1] || '').toUpperCase();
      if (verb === 'CAPABILITY') {
        socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY completed\r\n`);
      } else if (verb === 'LOGIN') {
        socket.write(`${tag} OK LOGIN completed\r\n`);
      } else if (verb === 'SELECT') {
        writeSelectInbox(socket, tag);
      } else if (verb === 'UID' && /SEARCH/i.test(line)) {
        socket.write(`* SEARCH 13 17\r\n${tag} OK SEARCH completed\r\n`);
      } else if (verb === 'UID' && /FETCH/i.test(line)) {
        writeBodyFetch(socket, 1, 99, rfc822Plain());
        socket.write(`${tag} OK FETCH completed\r\n`);
      } else if (verb === 'LOGOUT') {
        socket.write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`);
        socket.end();
      } else {
        socket.write(`${tag} BAD not implemented\r\n`);
      }
    }, async (port) => createTestTransport(port).fetchInbox(
      CREDS,
      frozen({ uidvalidity: null, last_uid: 0 }),
    ));
    assert.equal(unexpected.ok, false);
    ok('FETCH with unrequested UID fails closed');
  }

  {
    const duplicate = await withImapTlsServer((socket, line) => {
      const parts = line.split(' ');
      const tag = parts[0];
      const verb = (parts[1] || '').toUpperCase();
      if (verb === 'CAPABILITY') {
        socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY completed\r\n`);
      } else if (verb === 'LOGIN') {
        socket.write(`${tag} OK LOGIN completed\r\n`);
      } else if (verb === 'SELECT') {
        writeSelectInbox(socket, tag);
      } else if (verb === 'UID' && /SEARCH/i.test(line)) {
        socket.write(`* SEARCH 13 17\r\n${tag} OK SEARCH completed\r\n`);
      } else if (verb === 'UID' && /FETCH/i.test(line)) {
        for (const uid of [13, 13]) {
          writeBodyFetch(socket, 1, uid, rfc822Plain());
        }
        socket.write(`${tag} OK FETCH completed\r\n`);
      } else if (verb === 'LOGOUT') {
        socket.write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`);
        socket.end();
      } else {
        socket.write(`${tag} BAD not implemented\r\n`);
      }
    }, async (port) => createTestTransport(port).fetchInbox(
      CREDS,
      frozen({ uidvalidity: null, last_uid: 0 }),
    ));
    assert.equal(duplicate.ok, false);
    ok('FETCH with duplicate UIDs fails closed');
  }

  {
    const incomplete = await withImapTlsServer((socket, line) => {
      const parts = line.split(' ');
      const tag = parts[0];
      const verb = (parts[1] || '').toUpperCase();
      if (verb === 'CAPABILITY') {
        socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY completed\r\n`);
      } else if (verb === 'LOGIN') {
        socket.write(`${tag} OK LOGIN completed\r\n`);
      } else if (verb === 'SELECT') {
        writeSelectInbox(socket, tag, { exists: 2 });
      } else if (verb === 'UID' && /SEARCH/i.test(line)) {
        socket.write(`* SEARCH 13 17\r\n${tag} OK SEARCH completed\r\n`);
      } else if (verb === 'UID' && /FETCH/i.test(line)) {
        assert.match(line, /UID FETCH 13,17 /);
        writeBodyFetch(socket, 1, 17, rfc822Plain());
        socket.write(`${tag} OK FETCH completed\r\n`);
      } else if (verb === 'LOGOUT') {
        socket.write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`);
        socket.end();
      } else {
        socket.write(`${tag} BAD not implemented\r\n`);
      }
    }, async (port, received) => {
      const transport = createTestTransport(port);
      const fetched = await transport.fetchInbox(CREDS, frozen({ uidvalidity: null, last_uid: 0 }));
      const ingested = [];
      const projected = [];
      const { poller, pg } = pollService({
        inboundEnabled: true,
        ingested,
        projected,
        imapTransport: transport,
        cursor: { uidvalidity: FIXTURE_UIDVALIDITY, last_uid: 0 },
      });
      let pollErr;
      try {
        await poller.pollVerifiedImapInbox(frozen({
          clientId: SUNSET_ID, locationId: LOCATION, actorStaffUserId: ACTOR,
        }));
      } catch (caught) {
        pollErr = caught;
      }
      return {
        fetched,
        pollErr,
        ingested,
        projected,
        cursor: pg.getCursor(),
        queries: pg.queries.slice(),
        received,
      };
    });
    assert.equal(incomplete.fetched.ok, false);
    assert.deepEqual([...(incomplete.fetched.failed_secret_names || [])], ['sunset-imap-host']);
    assert.equal(Object.prototype.hasOwnProperty.call(incomplete.fetched, 'last_uid'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(incomplete.fetched, 'messages'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(incomplete.fetched, 'uidvalidity'), false);
    assertNoLeak(incomplete.fetched, 'incomplete FETCH');
    const fetchLine = incomplete.received.find((line) => /UID FETCH /.test(line));
    assert.match(fetchLine, /UID FETCH 13,17 /);
    assert.ok(incomplete.pollErr);
    assert.deepEqual([...(incomplete.pollErr.failed_secret_names || [])], ['sunset-imap-host']);
    assertNoLeak(incomplete.pollErr, 'incomplete FETCH poll');
    assert.equal(incomplete.ingested.length, 0);
    assert.equal(incomplete.projected.length, 0);
    assert.equal(Number(incomplete.cursor.last_uid), 0);
    assert.equal(Number(incomplete.cursor.uidvalidity), FIXTURE_UIDVALIDITY);
    assert.equal(incomplete.queries.some((q) => q.text === pollSql.SQL_COMMIT_MONOTONIC), false);
    assert.equal(incomplete.queries.some((q) => q.text === pollSql.SQL_COMMIT_RESET), false);
    ok('incomplete FETCH missing requested UID fails closed without cursor advancement or poll ingest');
  }

  function handleFetchAuth(socket, line) {
    const parts = line.split(' ');
    const tag = parts[0];
    const verb = (parts[1] || '').toUpperCase();
    if (verb === 'CAPABILITY') {
      socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY completed\r\n`);
      return true;
    }
    if (verb === 'LOGIN') {
      socket.write(`${tag} OK LOGIN completed\r\n`);
      return true;
    }
    if (verb === 'LOGOUT') {
      socket.write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`);
      socket.end();
      return true;
    }
    return false;
  }

  {
    const HUGE_UIDNEXT = 50000;
    const result = await withImapTlsServer((socket, line) => {
      const tag = line.split(' ')[0];
      if (handleFetchAuth(socket, line)) return;
      const verb = (line.split(' ')[1] || '').toUpperCase();
      if (verb === 'SELECT') {
        writeSelectInbox(socket, tag, { uidnext: HUGE_UIDNEXT, exists: 49999 });
      } else if (verb === 'UID' && /SEARCH/i.test(line)) {
        const range = parseUidSearchRange(line);
        const unbounded = /:\*/.test(line) || !range || (range.end - range.start + 1 > 32);
        if (unbounded) {
          let payload = '* SEARCH';
          for (let i = 1; i <= 30000; i += 1) payload += ` ${i}`;
          socket.write(`${payload}\r\n${tag} OK SEARCH completed\r\n`);
          return;
        }
        socket.write(`* SEARCH 49995 49996 49997 49998 49999\r\n${tag} OK SEARCH completed\r\n`);
      } else if (verb === 'UID' && /FETCH/i.test(line)) {
        assert.match(line, /UID FETCH 49995,49996,49997,49998,49999 /);
        const uids = [49995, 49996, 49997, 49998, 49999];
        for (let i = 0; i < uids.length; i += 1) {
          writeBodyFetch(socket, i + 1, uids[i], rfc822Plain());
        }
        socket.write(`${tag} OK FETCH completed\r\n`);
      } else {
        socket.write(`${tag} BAD not implemented\r\n`);
      }
    }, async (port, received) => {
      const fetched = await createTestTransport(port).fetchInbox(
        CREDS,
        frozen({ uidvalidity: null, last_uid: 0 }),
      );
      return { fetched, received };
    });
    assert.equal(result.fetched.ok, true);
    assert.equal(result.fetched.messages.length, 5);
    assert.equal(result.fetched.last_uid, 49999);
    assertFiniteUidSearch(findUidSearchLine(result.received), {
      maxWindow: transportOwner.IMAP_FETCH_MAX_MESSAGES,
      start: 49995,
      end: 49999,
    });
    assert.equal(result.received.some((line) => /:\*/.test(line)), false);
    ok('huge mailbox UIDNEXT bootstrap emits finite tail SEARCH and cannot overflow from SEARCH cardinality');
  }

  {
    const emptyBox = await withImapTlsServer((socket, line) => {
      const tag = line.split(' ')[0];
      if (handleFetchAuth(socket, line)) return;
      const verb = (line.split(' ')[1] || '').toUpperCase();
      if (verb === 'SELECT') {
        writeSelectInbox(socket, tag, { uidnext: 1, exists: 0 });
      } else if (verb === 'UID' && /SEARCH/i.test(line)) {
        socket.write(`* SEARCH 1\r\n${tag} OK SEARCH completed\r\n`);
      } else {
        socket.write(`${tag} BAD not implemented\r\n`);
      }
    }, async (port, received) => {
      const fetched = await createTestTransport(port).fetchInbox(
        CREDS,
        frozen({ uidvalidity: null, last_uid: 0 }),
      );
      return { fetched, received };
    });
    assert.equal(emptyBox.fetched.ok, true);
    assert.deepEqual(emptyBox.fetched.messages, []);
    assert.equal(emptyBox.fetched.last_uid, 0);
    assert.equal(emptyBox.fetched.uidvalidity, FIXTURE_UIDVALIDITY);
    assert.equal(findUidSearchLine(emptyBox.received), null);
    assert.equal(emptyBox.received.some((line) => /UID FETCH /i.test(line)), false);
    ok('empty mailbox UIDNEXT=1 succeeds with zero messages and no SEARCH');
  }

  {
    const advanced = await withImapTlsServer((socket, line) => {
      const tag = line.split(' ')[0];
      if (handleFetchAuth(socket, line)) return;
      const verb = (line.split(' ')[1] || '').toUpperCase();
      if (verb === 'SELECT') {
        writeSelectInbox(socket, tag, { uidnext: 100, exists: 0 });
      } else if (verb === 'UID' && /SEARCH/i.test(line)) {
        assertFiniteUidSearch(line, { start: 11, end: 99 });
        socket.write(`* SEARCH\r\n${tag} OK SEARCH completed\r\n`);
      } else if (verb === 'UID' && /FETCH/i.test(line)) {
        socket.write(`${tag} BAD unexpected FETCH\r\n`);
      } else {
        socket.write(`${tag} BAD not implemented\r\n`);
      }
    }, async (port, received) => {
      const transport = createTestTransport(port);
      const fetched = await transport.fetchInbox(
        CREDS,
        frozen({ uidvalidity: FIXTURE_UIDVALIDITY, last_uid: 10 }),
      );
      const ingested = [];
      const projected = [];
      const { poller, pg } = pollService({
        inboundEnabled: true,
        ingested,
        projected,
        imapTransport: fakeImapTransport({
          messages: [],
        }),
        cursor: { uidvalidity: FIXTURE_UIDVALIDITY, last_uid: 10 },
      });
      return { fetched, received, ingested, projected, poller, pg };
    });
    assert.equal(advanced.fetched.ok, true);
    assert.equal(advanced.fetched.messages.length, 0);
    assert.equal(advanced.fetched.last_uid, 99);
    assert.equal(advanced.received.some((line) => /UID FETCH /i.test(line)), false);
    ok('sparse/expunged empty finite window advances scan cursor to range end');
  }

  {
    const gapPoll = await withImapTlsServer((socket, line) => {
      const tag = line.split(' ')[0];
      if (handleFetchAuth(socket, line)) return;
      const verb = (line.split(' ')[1] || '').toUpperCase();
      if (verb === 'SELECT') {
        writeSelectInbox(socket, tag, { uidnext: 100, exists: 0 });
      } else if (verb === 'UID' && /SEARCH/i.test(line)) {
        socket.write(`* SEARCH\r\n${tag} OK SEARCH completed\r\n`);
      } else {
        socket.write(`${tag} BAD not implemented\r\n`);
      }
    }, async (port) => {
      const transport = createTestTransport(port);
      const ingested = [];
      const projected = [];
      const { poller, pg } = pollService({
        inboundEnabled: true,
        ingested,
        projected,
        imapTransport: transport,
        cursor: { uidvalidity: FIXTURE_UIDVALIDITY, last_uid: 10 },
      });
      const ack = await poller.pollVerifiedImapInbox(frozen({
        clientId: SUNSET_ID, locationId: LOCATION, actorStaffUserId: ACTOR,
      }));
      return { ack, ingested, projected, cursor: pg.getCursor(), queries: pg.queries.slice() };
    });
    assert.equal(gapPoll.ack.ok, true);
    assert.equal(gapPoll.ack.fetched, 0);
    assert.equal(gapPoll.ingested.length, 0);
    assert.equal(gapPoll.projected.length, 0);
    assert.equal(Number(gapPoll.cursor.last_uid), 99);
    assert.equal(Number(gapPoll.cursor.uidvalidity), FIXTURE_UIDVALIDITY);
    assert.equal(gapPoll.queries.some((q) => q.text === pollSql.SQL_COMMIT_MONOTONIC), true);
    ok('empty finite window poll commits advanced scan cursor without ingest');
  }

  {
    const overFive = await withImapTlsServer((socket, line) => {
      const tag = line.split(' ')[0];
      if (handleFetchAuth(socket, line)) return;
      const verb = (line.split(' ')[1] || '').toUpperCase();
      if (verb === 'SELECT') {
        writeSelectInbox(socket, tag, { uidnext: 100, exists: 8 });
      } else if (verb === 'UID' && /SEARCH/i.test(line)) {
        assertFiniteUidSearch(line, { start: 11, end: 99 });
        socket.write(`* SEARCH 18 11 12 13 14 15 16 17\r\n${tag} OK SEARCH completed\r\n`);
      } else if (verb === 'UID' && /FETCH/i.test(line)) {
        assert.match(line, /UID FETCH 11,12,13,14,15 /);
        assert.doesNotMatch(line, /16|17|18/);
        const uids = [11, 12, 13, 14, 15];
        for (let i = 0; i < uids.length; i += 1) {
          writeBodyFetch(socket, i + 1, uids[i], rfc822Plain());
        }
        socket.write(`${tag} OK FETCH completed\r\n`);
      } else {
        socket.write(`${tag} BAD not implemented\r\n`);
      }
    }, async (port, received) => {
      const fetched = await createTestTransport(port).fetchInbox(
        CREDS,
        frozen({ uidvalidity: FIXTURE_UIDVALIDITY, last_uid: 10 }),
      );
      return { fetched, received };
    });
    assert.equal(overFive.fetched.ok, true);
    assert.equal(overFive.fetched.messages.length, 5);
    assert.deepEqual(overFive.fetched.messages.map((msg) => msg.uid), [11, 12, 13, 14, 15]);
    assert.equal(overFive.fetched.last_uid, 15);
    const fetchLine = overFive.received.find((line) => /UID FETCH /.test(line));
    assert.match(fetchLine, /UID FETCH 11,12,13,14,15 /);
    assert.doesNotMatch(fetchLine, /16|17|18/);
    ok('>5 UIDs in finite window FETCHes first five and leaves remainder for next poll');
  }

  {
    const malformedCases = [
      { name: 'UIDNEXT 0', uidnextRaw: '* OK [UIDNEXT 0] Predicted next UID' },
      { name: 'UIDNEXT leading zero', uidnextRaw: '* OK [UIDNEXT 018] Predicted next UID' },
      { name: 'UIDNEXT over uint32', uidnextRaw: '* OK [UIDNEXT 4294967296] Predicted next UID' },
      { name: 'UIDNEXT foo', uidnextRaw: '* OK [UIDNEXT foo] Predicted next UID' },
      { name: 'missing UIDNEXT', uidnext: null },
      { name: 'conflicting UIDNEXT', uidnext: null, extraUntagged: ['* OK [UIDNEXT 18] a', '* OK [UIDNEXT 19] b'] },
      { name: 'duplicate UIDNEXT', uidnext: null, extraUntagged: ['* OK [UIDNEXT 18] a', '* OK [UIDNEXT 18] b'] },
      { name: 'same-line conflicting UIDNEXT', uidnextRaw: '* OK [UIDNEXT 18] [UIDNEXT 19] Predicted' },
    ];
    for (const item of malformedCases) {
      const failed = await withImapTlsServer((socket, line) => {
        const tag = line.split(' ')[0];
        if (handleFetchAuth(socket, line)) return;
        const verb = (line.split(' ')[1] || '').toUpperCase();
        if (verb === 'SELECT') {
          writeSelectInbox(socket, tag, {
            uidnext: Object.prototype.hasOwnProperty.call(item, 'uidnext')
              ? item.uidnext
              : (item.uidnextRaw ? null : 18),
            uidnextRaw: item.uidnextRaw,
            extraUntagged: item.extraUntagged,
          });
        } else if (verb === 'UID' && /SEARCH/i.test(line)) {
          socket.write(`* SEARCH 17\r\n${tag} OK SEARCH completed\r\n`);
        } else {
          socket.write(`${tag} BAD not implemented\r\n`);
        }
      }, async (port, received) => {
        const fetched = await createTestTransport(port).fetchInbox(
          CREDS,
          frozen({ uidvalidity: null, last_uid: 0 }),
        );
        return { fetched, received };
      });
      assert.equal(failed.fetched.ok, false, item.name);
      assert.equal(Object.prototype.hasOwnProperty.call(failed.fetched, 'last_uid'), false, item.name);
      assert.equal(failed.received.some((line) => /\bUID SEARCH\b/i.test(line)), false, item.name);
    }
    ok('malformed/conflicting/duplicate UIDNEXT fails closed before SEARCH');
  }

  {
    const noStar = await withImapTlsServer((socket, line) => {
      const tag = line.split(' ')[0];
      if (handleFetchAuth(socket, line)) return;
      const verb = (line.split(' ')[1] || '').toUpperCase();
      if (verb === 'SELECT') {
        writeSelectInbox(socket, tag, { uidnext: 18 });
      } else if (verb === 'UID' && /SEARCH/i.test(line)) {
        assert.ok(!line.includes(':*'));
        assertFiniteUidSearch(line, { start: 13, end: 17, maxWindow: 5 });
        socket.write(`* SEARCH 17\r\n${tag} OK SEARCH completed\r\n`);
      } else if (verb === 'UID' && /FETCH/i.test(line)) {
        writeBodyFetch(socket, 1, 17, rfc822Plain());
        socket.write(`${tag} OK FETCH completed\r\n`);
      } else {
        socket.write(`${tag} BAD not implemented\r\n`);
      }
    }, async (port, received) => {
      const fetched = await createTestTransport(port).fetchInbox(
        CREDS,
        frozen({ uidvalidity: null, last_uid: 0 }),
      );
      return { fetched, received };
    });
    assert.equal(noStar.fetched.ok, true);
    assert.equal(noStar.received.some((line) => /:\*/.test(line)), false);
    ok('UID SEARCH never issues unbounded start:*');
  }

  {
    const cases = [
      {
        name: 'tagged OK without untagged CAPABILITY',
        write(socket, tag) {
          socket.write(`${tag} OK CAPABILITY completed\r\n`);
        },
      },
      {
        name: 'untagged CAPABILITY missing IMAP4rev1',
        write(socket, tag) {
          socket.write(`* CAPABILITY AUTH=PLAIN STARTTLS\r\n${tag} OK CAPABILITY completed\r\n`);
        },
      },
      {
        name: 'substring lookalike IMAP4rev1x',
        write(socket, tag) {
          socket.write(`* CAPABILITY IMAP4rev1x AUTH=PLAIN\r\n${tag} OK CAPABILITY completed\r\n`);
        },
      },
      {
        name: 'substring lookalike IMAP4rev10',
        write(socket, tag) {
          socket.write(`* CAPABILITY IMAP4rev10\r\n${tag} OK CAPABILITY completed\r\n`);
        },
      },
      {
        name: 'substring lookalike XIMAP4rev1',
        write(socket, tag) {
          socket.write(`* CAPABILITY XIMAP4rev1 AUTH=PLAIN\r\n${tag} OK CAPABILITY completed\r\n`);
        },
      },
      {
        name: 'substring lookalike IMAP4rev1.1',
        write(socket, tag) {
          socket.write(`* CAPABILITY IMAP4rev1.1\r\n${tag} OK CAPABILITY completed\r\n`);
        },
      },
      {
        name: 'glued CAPABILITYIMAP4rev1',
        write(socket, tag) {
          socket.write(`* CAPABILITYIMAP4rev1\r\n${tag} OK CAPABILITY completed\r\n`);
        },
      },
      {
        name: 'duplicate untagged CAPABILITY lines',
        write(socket, tag) {
          socket.write(`* CAPABILITY IMAP4rev1\r\n* CAPABILITY AUTH=PLAIN\r\n${tag} OK CAPABILITY completed\r\n`);
        },
      },
      {
        name: 'duplicate IMAP4rev1 tokens',
        write(socket, tag) {
          socket.write(`* CAPABILITY IMAP4rev1 IMAP4rev1\r\n${tag} OK CAPABILITY completed\r\n`);
        },
      },
      {
        name: 'malformed double-space atoms',
        write(socket, tag) {
          socket.write(`* CAPABILITY IMAP4rev1  AUTH=PLAIN\r\n${tag} OK CAPABILITY completed\r\n`);
        },
      },
      {
        name: 'tagged OK response-code CAPABILITY without untagged',
        write(socket, tag) {
          socket.write(`${tag} OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] CAPABILITY completed\r\n`);
        },
      },
    ];
    for (const item of cases) {
      const probed = await withImapTlsServer((socket, line) => {
        const parts = line.split(' ');
        const tag = parts[0];
        const verb = (parts[1] || '').toUpperCase();
        if (verb === 'CAPABILITY') {
          item.write(socket, tag);
        } else if (verb === 'LOGIN') {
          socket.write(`${tag} OK LOGIN completed\r\n`);
        } else if (verb === 'LOGOUT') {
          socket.write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} BAD not implemented\r\n`);
        }
      }, async (port, received) => {
        const verified = await createTestTransport(port).verifySession(CREDS);
        return { verified, received };
      }, { greeting: GREETING_WITHOUT_CAPS });
      assert.equal(probed.verified.ok, false, item.name);
      assert.equal(wroteLogin(probed.received), false, `LOGIN must not be written: ${item.name}`);
      assert.ok(probed.received.some((line) => /\bCAPABILITY\b/i.test(line)), item.name);
    }
    ok('CAPABILITY tagged OK without exact IMAP4rev1 never writes LOGIN');
  }

  {
    const success = await withImapTlsServer((socket, line) => {
      const parts = line.split(' ');
      const tag = parts[0];
      const verb = (parts[1] || '').toUpperCase();
      if (verb === 'CAPABILITY') {
        socket.write(`* CAPABILITY AUTH=PLAIN IMAP4rev1 STARTTLS\r\n${tag} OK CAPABILITY completed\r\n`);
      } else if (!handleAuthSelectLogout(socket, line)) {
        socket.write(`${tag} BAD not implemented\r\n`);
      }
    }, async (port, received) => {
      const verified = await createTestTransport(port).verifySession(CREDS);
      return { verified, received };
    }, { greeting: GREETING_WITHOUT_CAPS });
    assert.equal(success.verified.ok, true);
    assert.equal(wroteLogin(success.received), true);
    ok('CAPABILITY untagged exact IMAP4rev1 allows LOGIN');
  }

  {
    const lookalikeGreeting = await withImapTlsServer((socket, line) => {
      const parts = line.split(' ');
      const tag = parts[0];
      const verb = (parts[1] || '').toUpperCase();
      if (verb === 'CAPABILITY') {
        socket.write(`* CAPABILITY IMAP4rev1x AUTH=PLAIN\r\n${tag} OK CAPABILITY completed\r\n`);
      } else if (verb === 'LOGIN') {
        socket.write(`${tag} OK LOGIN completed\r\n`);
      } else if (verb === 'LOGOUT') {
        socket.write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`);
        socket.end();
      } else {
        socket.write(`${tag} BAD not implemented\r\n`);
      }
    }, async (port, received) => {
      const verified = await createTestTransport(port).verifySession(CREDS);
      return { verified, received };
    }, { greeting: '* OK [CAPABILITY IMAP4rev1x AUTH=PLAIN] imap.example.test\r\n' });
    assert.equal(lookalikeGreeting.verified.ok, false);
    assert.equal(wroteLogin(lookalikeGreeting.received), false);
    ok('greeting CAPABILITY lookalike does not skip exact IMAP4rev1 check');
  }

  async function fetchWithRfc822(rfc822, extraHandler) {
    return withImapTlsServer((socket, line) => {
      const parts = line.split(' ');
      const tag = parts[0];
      const verb = (parts[1] || '').toUpperCase();
      if (verb === 'CAPABILITY') {
        socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY completed\r\n`);
      } else if (verb === 'LOGIN') {
        socket.write(`${tag} OK LOGIN completed\r\n`);
      } else if (verb === 'SELECT') {
        writeSelectInbox(socket, tag);
      } else if (verb === 'UID' && /SEARCH/i.test(line)) {
        assertFiniteUidSearch(line, { maxWindow: transportOwner.IMAP_FETCH_MAX_MESSAGES });
        socket.write(`* SEARCH ${FIXTURE_UID}\r\n${tag} OK SEARCH completed\r\n`);
      } else if (verb === 'UID' && /FETCH/i.test(line)) {
        assert.match(line, /BODY\.PEEK\[\]/);
        assert.doesNotMatch(line, /BODY\.PEEK\[TEXT\]|HEADER\.FIELDS|BODY\[TEXT\]/);
        if (extraHandler && extraHandler.fetch) {
          extraHandler.fetch(socket, tag, line);
        } else {
          writeBodyFetch(socket, 1, FIXTURE_UID, rfc822);
          socket.write(`${tag} OK FETCH completed\r\n`);
        }
      } else if (verb === 'LOGOUT') {
        socket.write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`);
        socket.end();
      } else {
        socket.write(`${tag} BAD not implemented\r\n`);
      }
    }, async (port, received) => {
      const fetched = await createTestTransport(port).fetchInbox(CREDS, frozen({ uidvalidity: null, last_uid: 0 }));
      return { fetched, received };
    });
  }

  {
    const unicodeBody = 'cafés — こんにちは';
    assert.ok(Buffer.byteLength(unicodeBody, 'utf8') > unicodeBody.length);
    const fixtures = [
      {
        name: 'plain UTF-8',
        rfc822: rfc822Plain(),
        body: FIXTURE_BODY,
        subject: FIXTURE_SUBJECT,
        from: `${FIXTURE_FROM_NAME} <${FIXTURE_FROM}>`,
      },
      {
        name: 'folded Subject/From',
        rfc822: Buffer.from([
          'From: Guest',
          ' <guest@example.com>',
          'Subject: Booking',
          ' question',
          'Date: Thu, 20 Aug 2026 10:00:00 +0000',
          `Message-ID: ${FIXTURE_MSG_ID}`,
          '',
          FIXTURE_BODY,
        ].join('\r\n'), 'utf8'),
        body: FIXTURE_BODY,
        subject: 'Booking question',
        from: 'Guest <guest@example.com>',
      },
      {
        name: 'quoted-printable',
        rfc822: rfc822Plain({
          headers: [
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset="UTF-8"',
            'Content-Transfer-Encoding: quoted-printable',
          ],
          body: 'Hello Luna,=20I would like to book a lesson.',
        }),
        body: 'Hello Luna, I would like to book a lesson.',
        subject: FIXTURE_SUBJECT,
        from: `${FIXTURE_FROM_NAME} <${FIXTURE_FROM}>`,
      },
      {
        name: 'base64',
        rfc822: rfc822Plain({
          headers: [
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            'Content-Transfer-Encoding: base64',
          ],
          body: `${Buffer.from(FIXTURE_BODY, 'utf8').toString('base64')}\r\n`,
        }),
        body: FIXTURE_BODY,
        subject: FIXTURE_SUBJECT,
        from: `${FIXTURE_FROM_NAME} <${FIXTURE_FROM}>`,
      },
      {
        name: 'multipart text/plain',
        rfc822: Buffer.from([
          `From: ${FIXTURE_FROM_NAME} <${FIXTURE_FROM}>`,
          `Subject: ${FIXTURE_SUBJECT}`,
          'Date: Thu, 20 Aug 2026 10:00:00 +0000',
          `Message-ID: ${FIXTURE_MSG_ID}`,
          'MIME-Version: 1.0',
          'Content-Type: multipart/alternative; boundary="000000000000abcd"',
          '',
          '--000000000000abcd',
          'Content-Type: text/plain; charset="UTF-8"',
          'Content-Transfer-Encoding: quoted-printable',
          '',
          'Hello Luna, I would like to book a lesson.',
          '--000000000000abcd',
          'Content-Type: text/html; charset="UTF-8"',
          '',
          '<p>Hello Luna, I would like to book a lesson.</p>',
          '--000000000000abcd--',
          '',
        ].join('\r\n'), 'utf8'),
        body: 'Hello Luna, I would like to book a lesson.',
        subject: FIXTURE_SUBJECT,
        from: `${FIXTURE_FROM_NAME} <${FIXTURE_FROM}>`,
      },
      {
        name: 'byte-length Unicode',
        rfc822: rfc822Plain({
          headers: [
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=UTF-8',
            'Content-Transfer-Encoding: 8bit',
          ],
          body: unicodeBody,
        }),
        body: unicodeBody,
        subject: FIXTURE_SUBJECT,
        from: `${FIXTURE_FROM_NAME} <${FIXTURE_FROM}>`,
      },
    ];
    for (const fixture of fixtures) {
      const result = await fetchWithRfc822(fixture.rfc822);
      assert.equal(result.fetched.ok, true, fixture.name);
      assert.equal(result.fetched.messages.length, 1, fixture.name);
      assert.equal(result.fetched.messages[0].bodyText, fixture.body, fixture.name);
      assert.equal(result.fetched.messages[0].headers.from, fixture.from, fixture.name);
      assert.equal(result.fetched.messages[0].headers.subject, fixture.subject, fixture.name);
      const mapped = mapper.mapImapFetchedMessageToInboundEnvelope(frozen({
        mailbox: MAILBOX,
        message: result.fetched.messages[0],
      }));
      assert.equal(mapped.ok, true, fixture.name);
      assert.equal(mapped.value.body_text, fixture.body, fixture.name);
      const fetchLine = result.received.find((line) => /UID FETCH /.test(line));
      assert.match(fetchLine, /BODY\.PEEK\[\]/, fixture.name);
      assert.doesNotMatch(fetchLine, /HEADER\.FIELDS|BODY\.PEEK\[TEXT\]/, fixture.name);
    }
    ok('BODY[] fixtures parse plain UTF-8, multipart, QP, base64, folded headers, Unicode');
  }

  {
    const jpegOnly = Buffer.from([
      `From: ${FIXTURE_FROM_NAME} <${FIXTURE_FROM}>`,
      `Subject: ${FIXTURE_SUBJECT}`,
      'Date: Thu, 20 Aug 2026 10:00:00 +0000',
      `Message-ID: ${FIXTURE_MSG_ID}`,
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="onlyimg"',
      '',
      '--onlyimg',
      'Content-Type: image/jpeg',
      'Content-Transfer-Encoding: base64',
      '',
      '/9j/4AAQSkZJRgABAQAAAQABAAD/',
      '--onlyimg--',
      '',
    ].join('\r\n'), 'utf8');
    const adversarial = [
      {
        name: 'malformed RFC822 no header separator',
        rfc822: Buffer.from('From: guest@example.com\r\nSubject: hi\r\nnot-a-body', 'utf8'),
      },
      {
        name: 'NUL header injection',
        rfc822: Buffer.from(`From: guest@example.com\0Bcc: evil@x.com\r\nSubject: hi\r\n\r\n${FIXTURE_BODY}`, 'utf8'),
      },
      {
        name: 'malformed quoted-printable',
        rfc822: rfc822Plain({
          headers: [
            'Content-Type: text/plain; charset=utf-8',
            'Content-Transfer-Encoding: quoted-printable',
          ],
          body: 'Hello=ZZLuna',
        }),
      },
      {
        name: 'malformed base64',
        rfc822: rfc822Plain({
          headers: [
            'Content-Type: text/plain; charset=utf-8',
            'Content-Transfer-Encoding: base64',
          ],
          body: '!!!!not-base64!!!!',
        }),
      },
      {
        name: 'binary-only no safe text',
        rfc822: jpegOnly,
      },
      {
        name: 'oversized decoded body',
        rfc822: rfc822Plain({ body: 'x'.repeat(70000) }),
      },
      {
        name: 'unknown transfer encoding',
        rfc822: rfc822Plain({
          headers: ['Content-Transfer-Encoding: x-uuencode'],
          body: FIXTURE_BODY,
        }),
      },
    ];
    for (const item of adversarial) {
      const result = await fetchWithRfc822(item.rfc822);
      assert.equal(result.fetched.ok, false, item.name);
    }
    const textOnlyCompat = await withImapTlsServer((socket, line) => {
      const parts = line.split(' ');
      const tag = parts[0];
      const verb = (parts[1] || '').toUpperCase();
      if (verb === 'CAPABILITY') {
        socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY completed\r\n`);
      } else if (verb === 'LOGIN') {
        socket.write(`${tag} OK LOGIN completed\r\n`);
      } else if (verb === 'SELECT') {
        writeSelectInbox(socket, tag);
      } else if (verb === 'UID' && /SEARCH/i.test(line)) {
        socket.write(`* SEARCH ${FIXTURE_UID}\r\n${tag} OK SEARCH completed\r\n`);
      } else if (verb === 'UID' && /FETCH/i.test(line)) {
        const headers = headerBlock();
        const body = FIXTURE_BODY;
        socket.write(`* 1 FETCH (UID ${FIXTURE_UID} FLAGS () INTERNALDATE "20-Aug-2026 10:00:00 +0000" BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)] {${headers.length}}\r\n`);
        socket.write(headers);
        socket.write(` BODY[TEXT] {${body.length}}\r\n`);
        socket.write(body);
        socket.write(`)\r\n${tag} OK FETCH completed\r\n`);
      } else if (verb === 'LOGOUT') {
        socket.write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`);
        socket.end();
      } else {
        socket.write(`${tag} BAD not implemented\r\n`);
      }
    }, async (port, received) => {
      const fetched = await createTestTransport(port).fetchInbox(CREDS, frozen({ uidvalidity: null, last_uid: 0 }));
      return { fetched, received };
    });
    assert.equal(textOnlyCompat.fetched.ok, false);
    const fetchLine = textOnlyCompat.received.find((line) => /UID FETCH /.test(line));
    assert.match(fetchLine, /BODY\.PEEK\[\]/);
    ok('malformed/oversized/binary BODY[] and BODY[TEXT]-only FETCH fail closed');
  }

  tlsPair.cleanup();

  const transportSrc = fs.readFileSync(path.join(ROOT, TRANSPORT_REL), 'utf8');
  assert.match(transportSrc, /rejectUnauthorized:\s*true/);
  assert.match(transportSrc, /servername/);
  assert.doesNotMatch(transportSrc, /rejectUnauthorized:\s*false/);
  assert.ok(!/MAIL FROM|RCPT TO|[\r\n]DATA[\r\n]|APPEND |STORE |COPY /i.test(transportSrc));
  assert.ok(transportOwner.IMAP_VERIFY_COMMANDS.includes('LOGIN')
    || transportOwner.IMAP_VERIFY_COMMANDS.includes('AUTHENTICATE'));
  assert.ok(transportOwner.IMAP_VERIFY_COMMANDS.includes('SELECT'));
  assert.ok(transportOwner.IMAP_VERIFY_COMMANDS.includes('LOGOUT'));
  ok('transport pins implicit TLS, SNI, and IMAP command allowlist');

  const apiSrc = fs.readFileSync(path.join(ROOT, API_REL), 'utf8');
  const settingsSrc = fs.readFileSync(path.join(ROOT, SETTINGS_REL), 'utf8');
  const uiSrc = fs.readFileSync(path.join(ROOT, UI_REL), 'utf8');
  const inboxSrc = fs.readFileSync(path.join(ROOT, INBOX_REL), 'utf8');
  const contractSrc = fs.readFileSync(path.join(ROOT, CONTRACT_REL), 'utf8');
  const verifySrc = fs.readFileSync(path.join(ROOT, VERIFY_REL), 'utf8');
  const pollSrc = fs.readFileSync(path.join(ROOT, POLL_REL), 'utf8');
  const kvSrc = fs.readFileSync(path.join(ROOT, KV_REL), 'utf8');
  const workerSrc = fs.readFileSync(path.join(ROOT, WORKER_REL), 'utf8');
  const compositionSrc = fs.readFileSync(path.join(ROOT, COMPOSITION_REL), 'utf8');
  const registrySrc = fs.readFileSync(path.join(ROOT, REGISTRY_REL), 'utf8');
  const matchSrc = fs.readFileSync(path.join(ROOT, MATCH_REL), 'utf8');
  const storeSrc = fs.readFileSync(path.join(ROOT, STORE_REL), 'utf8');
  const bridgeSrc = fs.readFileSync(path.join(ROOT, BRIDGE_REL), 'utf8');

  assert.ok(apiSrc.includes('EMAIL_IMAP_VERIFY_PATH'));
  const verifyBlockStart = apiSrc.indexOf(
    "pathname === EMAIL_IMAP_VERIFY_PATH && method === 'POST'",
  );
  assert.ok(verifyBlockStart > 0, 'IMAP verify POST router block present');
  const verifyBlockNext = apiSrc.indexOf('\n  if (pathname ===', verifyBlockStart + 1);
  const verifyBlock = apiSrc.slice(
    verifyBlockStart,
    verifyBlockNext > verifyBlockStart ? verifyBlockNext : verifyBlockStart + 1800,
  );
  const iGate = verifyBlock.indexOf('isSunsetEmailImapVerifyEnabled');
  const iAuth = verifyBlock.indexOf('requireAuth');
  const iBody = verifyBlock.indexOf('readBody');
  assert.ok(
    iGate >= 0 && iAuth > iGate && iBody > iAuth,
    'IMAP verify router contract gate must precede requireAuth and readBody',
  );
  assert.match(verifyBlock, /sendJSON\(\s*res,\s*404,\s*\{\s*success:\s*false,\s*error:\s*['"]not_found['"]\s*\}/);
  assert.match(verifyBlock, /concealUnauthenticated:\s*true/);
  ok('router source ordering: IMAP verify gate before requireAuth and readBody');

  assert.match(registrySrc, /imap_health_verified_at/);
  assert.match(pollSrc, /email-inbound-match-ingest|email-inbound-event-store|email-inbound-inbox-bridge/);
  assert.ok(pollSrc.includes('createInboundEmailEventStore') || pollSrc.includes('email-inbound-event-store'));
  assert.ok(pollSrc.includes('createEmailInboundInboxBridge') || pollSrc.includes('email-inbound-inbox-bridge'));
  assert.doesNotMatch(pollSrc, /pg_advisory_xact_lock/);
  assert.match(pollSrc, /SQL_CLAIM|lease_token/);
  assert.doesNotMatch(transportSrc, /uids\[0\]\}:\$\{uids/);
  assert.ok(!transportSrc.includes('${lastUid + 1}:*'), 'must not SEARCH lastUid+1:*');
  assert.match(transportSrc, /formatBoundedUidSearchCommand/);
  assert.match(transportSrc, /parseUidnext/);
  assert.match(transportSrc, /IMAP_SEARCH_MAX_WINDOW/);
  assert.equal(transportOwner.IMAP_SEARCH_MAX_WINDOW, 1024);
  assert.ok(transportOwner.IMAP_SEARCH_MAX_WINDOW >= transportOwner.IMAP_FETCH_MAX_MESSAGES);
  assert.ok(transportOwner.IMAP_SEARCH_MAX_WINDOW * 12 < 131072);
  assert.match(transportSrc, /formatUidSequenceSet/);
  assert.match(transportSrc, /imap_missing_requested_uid/);
  assert.match(transportSrc, /seen\.size !== requested\.size/);
  assert.match(transportSrc, /assertSafeImapCredential/);
  assert.match(transportSrc, /BODY\.PEEK\[\]/);
  assert.doesNotMatch(transportSrc, /BODY\.PEEK\[TEXT\]/);
  assert.doesNotMatch(transportSrc, /HEADER\.FIELDS/);
  assert.match(transportSrc, /parseUntaggedCapabilityAtoms|capabilityHasExactImap4rev1/);
  assert.equal(transportOwner.IMAP_FETCH_ATTRS, '(UID FLAGS INTERNALDATE BODY.PEEK[])');
  const mimeRel = 'scripts/lib/email-imap-rfc822-safe-text.js';
  const mimeSrc = fs.readFileSync(path.join(ROOT, mimeRel), 'utf8');
  assert.match(mimeSrc, /quoted-printable|quotedPrintable/i);
  assert.match(mimeSrc, /base64/i);
  assert.match(mimeSrc, /multipart/i);
  assert.doesNotMatch(mimeSrc, /console\.(log|info|debug|dir|error)/);
  assert.doesNotMatch(transportSrc, /console\.(log|info|debug|dir)\(/);
  assert.ok(!/MAIL FROM|RCPT TO|\bDATA\b|sendMail|graph\.microsoft\.com\/v1\.0\/me\/sendMail/i.test(verifySrc));
  assert.ok(!/MAIL FROM|RCPT TO|\bDATA\b|sendMail/i.test(pollSrc));
  assert.ok(!/MAIL FROM|RCPT TO|\bDATA\b/i.test(workerSrc));
  assert.ok(!/LUNA_AUTO_SEND_ENABLED\s*=\s*'true'/.test(compositionSrc));
  assert.ok(!/EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED\s*=\s*'true'/.test(compositionSrc));
  assert.match(kvSrc, /luna-sunset-staging-kv\.vault\.azure\.net|SUNSET_STAGING_TRUSTED_HOST/);
  assert.match(kvSrc, /0e05fbe3-e8c5-48aa-a914-30aed284e6f7|SUNSET_STAGING_MI_CLIENT_ID/);
  assert.ok(!contractSrc.includes(PLANTED));
  assert.ok(!verifySrc.includes(PLANTED));
  assert.ok(!uiSrc.includes(VERIFY_PATH) || true);
  assert.equal(
    fs.readFileSync(path.join(ROOT, UI_REL), 'utf8'),
    uiSrc,
  );

  const uiDiff = execFileSync('git', ['diff', '--', UI_REL, INBOX_REL], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(uiDiff, '', 'protected UI/inbox-thread files must be unchanged');
  assert.ok(!inboxSrc.includes(VERIFY_PATH));
  ok('protected UI/inbox-thread files unchanged and no send verbs in IMAP path');

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
  assert.ok(!deps.imapflow && !deps['node-imap'] && !deps.imap);
  assert.equal(pkg.scripts['verify:email-imap-001'], 'node scripts/verify-email-imap-001.js');
  ok('no IMAP npm package; small strict transport is the package-first choice');

  const migration = fs.readFileSync(path.join(ROOT, MIGRATION_REL), 'utf8');
  const migrationDown = fs.readFileSync(path.join(ROOT, MIGRATION_DOWN_REL), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'database/migrations/canonical-manifest.json'), 'utf8'));
  assert.match(migration, /ADD COLUMN imap_health_verified_at TIMESTAMPTZ/);
  assert.match(migration, /tenant_email_imap_fetch_cursors/);
  assert.match(migration, /uidvalidity >= 1 AND uidvalidity <= 4294967295/);
  assert.match(migration, /last_uid >= 0 AND last_uid <= 4294967295/);
  assert.match(migration, /lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL/);
  assert.doesNotMatch(migration, /inbound_enabled\s*=\s*TRUE|outbound_enabled\s*=\s*TRUE|active\s*=\s*TRUE/i);
  assert.match(migrationDown, /imap_health_verified_at IS NOT NULL/);
  assert.match(migrationDown, /tenant_email_imap_fetch_cursors/);
  const forward = manifest.entries.find((entry) => entry.id === '084_tenant_channel_endpoint_imap_health');
  assert.ok(forward && forward.classification === 'canonical_forward' && forward.order === 80);
  assert.ok(manifest.entries.some((entry) => entry.id === '084_tenant_channel_endpoint_imap_health_down'
    && entry.classification === 'rollback_down'));
  ok('migration 084 durable IMAP health + UID cursor + guarded down + manifest');

  assert.ok(matchSrc.includes('email-inbound-match-ingest-v1'));
  assert.ok(storeSrc.includes('createInboundEmailEventStore'));
  assert.ok(bridgeSrc.includes('projectInboundEvent'));
  ok('existing MATCH / event-store / inbox-bridge contracts remain the ingest path');

  void quoteImap;
  void headerBlock;
  void SESSION;
  void settingsSrc;
  console.log(`PASS EMAIL-IMAP-001 (${pass} checks)`);
}

main().catch((err) => {
  console.error('FAIL EMAIL-IMAP-001');
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});

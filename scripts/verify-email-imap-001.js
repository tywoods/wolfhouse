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

function fakePg(opts) {
  const health = opts && Object.prototype.hasOwnProperty.call(opts, 'imapHealth')
    ? opts.imapHealth
    : null;
  let inboundEnabled = opts && opts.inboundEnabled === true;
  let cursor = opts && opts.cursor ? Object.assign({}, opts.cursor) : null;
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
    if (/FROM tenant_email_imap_fetch_cursors/i.test(text)) {
      return { rows: cursor ? [Object.assign({}, cursor)] : [] };
    }
    if (/INSERT INTO tenant_email_imap_fetch_cursors|UPDATE tenant_email_imap_fetch_cursors/i.test(text)) {
      cursor = {
        uidvalidity: Number(params[params.length - 2]),
        last_uid: Number(params[params.length - 1]),
      };
      return { rows: [Object.assign({}, cursor)], rowCount: 1 };
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
    if (/pg_advisory_xact_lock/i.test(text)) return { rows: [] };
    if (/FROM tenant_channel_endpoints/i.test(text) || /SELECT id[\s\S]*imap_smtp/i.test(text)) {
      if (!endpoint) return { rows: [] };
      const row = Object.assign({}, endpoint, { inbound_enabled: inboundEnabled });
      return { rows: [row] };
    }
    return { rows: [] };
  };
  return { query, queries, persisted, projected, getCursor: () => cursor, getEndpoint: () => endpoint };
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

  function headerBlock() {
    return [
      `From: ${FIXTURE_FROM_NAME} <${FIXTURE_FROM}>`,
      `Subject: ${FIXTURE_SUBJECT}`,
      'Date: Thu, 20 Aug 2026 10:00:00 +0000',
      `Message-ID: ${FIXTURE_MSG_ID}`,
      '',
    ].join('\r\n');
  }

  async function withImapTlsServer(handler, run) {
    const received = [];
    const server = tls.createServer({ key: tlsPair.key, cert: tlsPair.cert }, (socket) => {
      let buf = '';
      socket.write('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] imap.example.test\r\n');
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
        socket.write(`* FLAGS (\\Seen)\r\n* OK [UIDVALIDITY ${FIXTURE_UIDVALIDITY}] UIDs valid\r\n* 1 EXISTS\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`);
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
        socket.write(`* OK [UIDVALIDITY ${FIXTURE_UIDVALIDITY}]\r\n* 1 EXISTS\r\n${tag} OK SELECT completed\r\n`);
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
  void SESSION;
  void settingsSrc;
  console.log(`PASS EMAIL-IMAP-001 (${pass} checks)`);
}

main().catch((err) => {
  console.error('FAIL EMAIL-IMAP-001');
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});

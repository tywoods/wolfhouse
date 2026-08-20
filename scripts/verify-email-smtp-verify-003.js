'use strict';

/**
 * EMAIL-SMTP-003 — fail-closed Sunset live SMTP verify (STARTTLS + AUTH + QUIT).
 *
 * Existing imap_smtp identity may be health-checked only. No MAIL FROM / RCPT TO
 * / DATA / send. Success projects settings connected_health. Failure stays
 * registered_not_connected and names missing/failed secret NAMES only.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const CONTRACT_REL = 'scripts/lib/email-sunset-smtp-secret-ref-contract.js';
const VERIFY_REL = 'scripts/lib/email-sunset-smtp-live-verify.js';
const TRANSPORT_REL = 'scripts/lib/email-sunset-smtp-starttls-transport.js';
const SETTINGS_REL = 'scripts/lib/staff-email-settings-routes.js';
const UI_REL = 'scripts/browser/sunset-admin-email-settings-ui.js';
const API_REL = 'scripts/staff-query-api.js';
const INBOX_REL = 'scripts/browser/inbox-thread.js';

const PLANTED = 'super-secret-smtp-password-LEAK-001';
const NAMES = Object.freeze([
  'sunset-smtp-host',
  'sunset-smtp-port',
  'sunset-smtp-tls-mode',
  'sunset-smtp-username',
  'sunset-smtp-password',
]);
const REFS = Object.freeze(NAMES.map((name) => `kv:${name}`));
const REGISTER_FLAG = 'LUNA_EMAIL_SMTP_IDENTITY_REGISTER_ENABLED';
const VERIFY_FLAG = 'LUNA_EMAIL_SMTP_VERIFY_ENABLED';
const VERIFY_PATH = '/staff/admin/email-settings/smtp/verify';
const IDENTITY_PATH = '/staff/admin/email-settings/smtp/endpoint';
const GMAIL_CALLBACK = '/staff/email/google/callback';
const LOCATION = 'sunset-somo';
const MAILBOX = 'tywoods@gmail.com';
const SUNSET_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ACTOR = 'abcdef01-2345-4678-89ab-cdef01234567';
const SESSION = '11111111-1111-4111-8111-111111111111';
const ENDPOINT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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
    [REGISTER_FLAG]: 'true',
    [VERIFY_FLAG]: 'true',
    LUNA_EMAIL_SMTP_HOST_SECRET_REF: 'kv:sunset-smtp-host',
    LUNA_EMAIL_SMTP_PORT_SECRET_REF: 'kv:sunset-smtp-port',
    LUNA_EMAIL_SMTP_TLS_MODE_SECRET_REF: 'kv:sunset-smtp-tls-mode',
    LUNA_EMAIL_SMTP_USERNAME_SECRET_REF: 'kv:sunset-smtp-username',
    LUNA_EMAIL_SMTP_PASSWORD_SECRET_REF: 'kv:sunset-smtp-password',
  };
  return frozen(Object.assign(env, patch || {}));
}

function assertNoLeak(surface, label) {
  const text = typeof surface === 'string' ? surface : JSON.stringify(surface);
  assert.ok(!text.includes(PLANTED), `${label} leaked planted secret value`);
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
    'kv:sunset-smtp-host': 'smtp.example.test',
    'kv:sunset-smtp-port': '587',
    'kv:sunset-smtp-tls-mode': 'starttls',
    'kv:sunset-smtp-username': 'tywoods@gmail.com',
    'kv:sunset-smtp-password': PLANTED,
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
      throw new Error(`kv boom ${PLANTED}`);
    }
    if (!Object.prototype.hasOwnProperty.call(values, ref)) return null;
    return values[ref];
  }
  return frozen({ resolveSecret, resolved });
}

function fakeSmtpTransport(opts) {
  const sessions = [];
  async function verifySession(creds) {
    const host = creds && creds.host;
    const port = creds && creds.port;
    const tlsMode = creds && creds.tlsMode;
    const username = creds && creds.username;
    const password = creds && creds.password;
    const commands = ['EHLO', 'STARTTLS', 'EHLO', 'AUTH', 'QUIT'];
    sessions.push({ host, port, tlsMode, username, password, commands });
    if (opts && opts.failAuth) {
      return frozen({ ok: false, failed_secret_names: frozen(['sunset-smtp-password']) });
    }
    if (opts && opts.failConnect) {
      return frozen({ ok: false, failed_secret_names: frozen(['sunset-smtp-host']) });
    }
    return frozen({ ok: true, commands: frozen(commands.slice()) });
  }
  return frozen({ verifySession, sessions });
}

function fakePg(opts) {
  const endpoint = opts && opts.missingEndpoint
    ? null
    : {
        id: ENDPOINT_ID,
        public_address: MAILBOX,
        provider: 'imap_smtp',
        inbound_enabled: false,
        outbound_enabled: false,
        active: false,
        default_automation_mode: 'off',
        binding_status: null,
        auth_mode: null,
        connector_mode: null,
        location_id: LOCATION,
      };
  const query = async (sql) => {
    const text = String(sql);
    if (/^\s*BEGIN\s*$/i.test(text)) return { rows: [] };
    if (/^\s*COMMIT\s*$/i.test(text)) return { rows: [] };
    if (/^\s*ROLLBACK\s*$/i.test(text)) return { rows: [] };
    if (/FROM clients/i.test(text)) {
      const id = opts && opts.clientId !== undefined ? opts.clientId : SUNSET_ID;
      return { rows: id ? [{ client_id: id }] : [] };
    }
    if (/FROM tenant_locations/i.test(text)) {
      if (opts && opts.locationMissing) return { rows: [] };
      return { rows: [{ location_id: LOCATION, active: true }] };
    }
    if (/pg_advisory_xact_lock/i.test(text)) return { rows: [] };
    if (/FROM tenant_channel_endpoints/i.test(text) || /SELECT id[\s\S]*imap_smtp/i.test(text)) {
      return { rows: endpoint ? [Object.assign({}, endpoint)] : [] };
    }
    return { rows: [] };
  };
  return { query };
}

async function main() {
const contract = require('./lib/email-sunset-smtp-secret-ref-contract');
const verifyOwner = require('./lib/email-sunset-smtp-live-verify');
const transportOwner = require('./lib/email-sunset-smtp-starttls-transport');
const settings = require('./lib/staff-email-settings-routes');

assert.equal(contract.EMAIL_SMTP_VERIFY_PATH, VERIFY_PATH);
assert.equal(contract.SMTP_VERIFY_ENABLED_ENV, VERIFY_FLAG);
assert.equal(settings.EMAIL_SMTP_VERIFY_PATH, VERIFY_PATH);
assert.equal(verifyOwner.EMAIL_SMTP_VERIFY_PATH, VERIFY_PATH);
assert.equal(contract.isSunsetEmailSmtpVerifyEnabled({}), false);
assert.equal(contract.isSunsetEmailSmtpVerifyEnabled(configuredEnv({ [VERIFY_FLAG]: undefined })), false);
assert.equal(contract.isSunsetEmailSmtpVerifyEnabled(configuredEnv({ LUNA_DEPLOYMENT: 'production' })), false);
assert.equal(contract.isSunsetEmailSmtpVerifyEnabled(configuredEnv({ LUNA_DEPLOYMENT: 'wolfhouse-staging' })), false);
assert.equal(contract.isSunsetEmailSmtpVerifyEnabled(configuredEnv({ [VERIFY_FLAG]: 'TRUE' })), false);
assert.equal(contract.isSunsetEmailSmtpVerifyEnabled(configuredEnv()), true);
ok('verify flag default-off exact true + sunset-staging only');

function verifyService(extra) {
  const env = extra && extra.env ? extra.env : configuredEnv();
  const pg = extra && extra.pg ? extra.pg : fakePg();
  const secretProvider = extra && extra.secretProvider
    ? extra.secretProvider
    : fakeSecretProvider();
  const smtpTransport = extra && extra.smtpTransport
    ? extra.smtpTransport
    : fakeSmtpTransport();
  const service = verifyOwner.createSunsetSmtpLiveVerify(frozen({
    client: frozen({ query: pg.query.bind(pg) }),
    env,
    secretProvider,
    smtpTransport,
  }));
  return { service, pg, secretProvider, smtpTransport };
}

{
  const smtpTransport = fakeSmtpTransport();
  const secretProvider = fakeSecretProvider();
  const { service } = verifyService({ smtpTransport, secretProvider });
  const ack = await service.verifyExistingImapSmtpEndpoint(frozen({
    clientId: SUNSET_ID,
    locationId: LOCATION,
    actorStaffUserId: ACTOR,
  }));
  assert.equal(ack.endpointId, ENDPOINT_ID);
  assert.equal(ack.provider, 'imap_smtp');
  assert.equal(ack.smtp_verified, true);
  assert.equal(ack.inbound_enabled, false);
  assert.equal(ack.outbound_enabled, false);
  assert.equal(ack.active, false);
  assert.equal(ack.default_automation_mode, 'off');
  assert.deepEqual([...secretProvider.resolved], [...REFS]);
  assert.equal(smtpTransport.sessions.length, 1);
  const session = smtpTransport.sessions[0];
  assert.equal(session.host, 'smtp.example.test');
  assert.equal(session.port, 587);
  assert.equal(session.tlsMode, 'starttls');
  assert.equal(session.username, 'tywoods@gmail.com');
  assert.equal(session.password, PLANTED);
  assert.deepEqual([...session.commands], ['EHLO', 'STARTTLS', 'EHLO', 'AUTH', 'QUIT']);
  assert.ok(!session.commands.includes('MAIL FROM'));
  assert.ok(!session.commands.includes('RCPT TO'));
  assert.ok(!session.commands.includes('DATA'));
  const json = JSON.stringify(ack);
  assert.ok(!json.includes(PLANTED));
  assert.ok(!json.includes('kv:'));
  assert.ok(!('password' in ack));
  assert.ok(!('secret_ref' in ack));
  ok('verify success STARTTLS+AUTH+QUIT never sends and never echoes secrets');
}

{
  const { service } = verifyService({ pg: fakePg({ missingEndpoint: true }) });
  await assert.rejects(() => service.verifyExistingImapSmtpEndpoint(frozen({
    clientId: SUNSET_ID,
    locationId: LOCATION,
    actorStaffUserId: ACTOR,
  })));
  ok('missing existing imap_smtp endpoint fails closed with zero SMTP');
}

{
  const smtpTransport = fakeSmtpTransport();
  const { service } = verifyService({
    env: configuredEnv({ LUNA_EMAIL_SMTP_PASSWORD_SECRET_REF: undefined }),
    smtpTransport,
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
  assert.deepEqual([...(err.missing_secret_names || [])], ['sunset-smtp-password']);
  assertNoLeak(err, 'missing password ref');
  assert.equal(smtpTransport.sessions.length, 0);
  ok('missing secret ref names the NAME only and skips SMTP');
}

{
  const smtpTransport = fakeSmtpTransport();
  const secretProvider = fakeSecretProvider(materialMap(), { failNames: ['sunset-smtp-host'] });
  const { service } = verifyService({ smtpTransport, secretProvider });
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
  assert.deepEqual([...(err.failed_secret_names || [])], ['sunset-smtp-host']);
  assertNoLeak(err, 'resolve failure');
  assertNoLeak(JSON.stringify(err), 'resolve failure json');
  assert.equal(smtpTransport.sessions.length, 0);
  ok('secret resolve failure names failed secret NAME only');
}

{
  const smtpTransport = fakeSmtpTransport({ failAuth: true });
  const { service } = verifyService({ smtpTransport });
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
  assert.deepEqual([...(err.failed_secret_names || [])], ['sunset-smtp-password']);
  assertNoLeak(err, 'auth failure');
  ok('SMTP AUTH failure names sunset-smtp-password only');
}

{
  const smtpTransport = fakeSmtpTransport();
  const { service } = verifyService({ smtpTransport });
  const input = frozen({
    clientId: SUNSET_ID,
    locationId: LOCATION,
    actorStaffUserId: ACTOR,
  });
  await service.verifyExistingImapSmtpEndpoint(input);
  await assert.rejects(() => service.verifyExistingImapSmtpEndpoint(input));
  ok('verify factory is single-use');
}

{
  const smtpTransport = fakeSmtpTransport();
  const { service } = verifyService({
    env: configuredEnv({ LUNA_DEPLOYMENT: 'production' }),
    smtpTransport,
  });
  await assert.rejects(() => service.verifyExistingImapSmtpEndpoint(frozen({
    clientId: SUNSET_ID,
    locationId: LOCATION,
    actorStaffUserId: ACTOR,
  })));
  assert.equal(smtpTransport.sessions.length, 0);
  ok('production deployment never opens SMTP');
}

{
  const smtpTransport = fakeSmtpTransport();
  const secretProvider = fakeSecretProvider(materialMap({ 'kv:sunset-smtp-tls-mode': 'none' }));
  const { service } = verifyService({ smtpTransport, secretProvider });
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
  assert.deepEqual([...(err.failed_secret_names || [])], ['sunset-smtp-tls-mode']);
  assert.equal(smtpTransport.sessions.length, 0);
  ok('non-starttls tls-mode fails closed before socket');
}

assert.equal(
  settings.publicState({ provider: 'imap_smtp' }, { smtp_verified: true }).connection_state
    || settings.publicState({ provider: 'imap_smtp' }, { smtp_verified: true }),
  'connected_health',
);
assert.equal(
  settings.publicState({ provider: 'imap_smtp' }, { grant_present: false }),
  'registered_not_connected',
);
assert.equal(
  settings.endpointDto(
    { id: ENDPOINT_ID, location_id: LOCATION, provider: 'imap_smtp', public_address: MAILBOX },
    { smtp_verified: true },
  ).connection_state,
  'connected_health',
);
assert.equal(
  settings.endpointDto(
    { id: ENDPOINT_ID, location_id: LOCATION, provider: 'imap_smtp', public_address: MAILBOX },
    { smtp_verified: true },
  ).inbound_enabled,
  false,
);
assert.equal(
  settings.endpointDto(
    { id: ENDPOINT_ID, location_id: LOCATION, provider: 'imap_smtp', public_address: MAILBOX },
    { smtp_verified: true },
  ).outbound_enabled,
  false,
);
assert.equal(
  settings.endpointDto(
    { id: ENDPOINT_ID, location_id: LOCATION, provider: 'imap_smtp', public_address: MAILBOX },
    { smtp_verified: true },
  ).endpoint_active,
  false,
);
assert.equal(
  settings.endpointDto(
    { id: ENDPOINT_ID, location_id: LOCATION, provider: 'imap_smtp', public_address: MAILBOX },
    { smtp_verified: true },
  ).automation_enabled,
  false,
);
ok('settings health maps smtp_verified onto connected_health with capabilities off');

function settingsRoutes(extra) {
  const pg = extra && extra.pg ? extra.pg : fakePg();
  const env = extra && extra.env ? extra.env : configuredEnv();
  const access = extra && extra.access !== undefined ? extra.access : true;
  const roleDecision = extra && extra.authz !== undefined ? extra.authz : { ok: true };
  const res = response();
  const logs = [];
  const secretProvider = extra && extra.secretProvider
    ? extra.secretProvider
    : fakeSecretProvider();
  const smtpTransport = extra && extra.smtpTransport
    ? extra.smtpTransport
    : fakeSmtpTransport();
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
    createSmtpLiveVerify: extra && extra.createVerify
      ? extra.createVerify
      : (client) => verifyOwner.createSunsetSmtpLiveVerify(frozen({
        client: frozen({ query: client.query.bind(client) }),
        env,
        secretProvider,
        smtpTransport,
      })),
    logger: { error(msg) { logs.push(String(msg)); } },
  });
  return { routes, res, pg, logs, smtpTransport, secretProvider };
}

{
  const { routes, res, smtpTransport } = settingsRoutes();
  await routes.handleGet({ client: 'sunset' }, {}, res, {
    role: 'admin', staff_user_id: ACTOR, client_slug: 'sunset', client_id: SUNSET_ID, session_id: SESSION,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.endpoints[0].connection_state, 'connected_health');
  assert.equal(res.body.endpoints[0].inbound_enabled, false);
  assert.equal(res.body.endpoints[0].outbound_enabled, false);
  assert.equal(res.body.endpoints[0].endpoint_active, false);
  assert.equal(res.body.endpoints[0].automation_enabled, false);
  assert.equal(res.body.provider_actions.imap_smtp.connect, false);
  assert.equal(smtpTransport.sessions.length, 1);
  assert.deepEqual([...smtpTransport.sessions[0].commands], ['EHLO', 'STARTTLS', 'EHLO', 'AUTH', 'QUIT']);
  assertNoLeak(res.body, 'GET success');
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes(PLANTED));
  assert.ok(!text.includes('kv:'));
  assert.ok(!text.includes('smtp_verified'));
  ok('GET settings live verify success returns connected_health capabilities off');
}

{
  const { routes, res, smtpTransport } = settingsRoutes({
    smtpTransport: fakeSmtpTransport({ failAuth: true }),
  });
  await routes.handleGet({ client: 'sunset' }, {}, res, {
    role: 'admin', staff_user_id: ACTOR, client_slug: 'sunset', client_id: SUNSET_ID,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.endpoints[0].connection_state, 'registered_not_connected');
  assert.deepEqual(res.body.smtp_secret_status.failed_secret_names, ['sunset-smtp-password']);
  assertNoLeak(res.body, 'GET auth fail');
  assert.equal(smtpTransport.sessions.length, 1);
  ok('GET verify failure stays registered_not_connected and names failed secret');
}

{
  const { routes, res, smtpTransport } = settingsRoutes({
    env: configuredEnv({ [VERIFY_FLAG]: undefined }),
  });
  await routes.handleGet({ client: 'sunset' }, {}, res, {
    role: 'admin', staff_user_id: ACTOR, client_slug: 'sunset', client_id: SUNSET_ID,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.endpoints[0].connection_state, 'registered_not_connected');
  assert.equal(smtpTransport.sessions.length, 0);
  ok('GET skips live SMTP when verify flag off');
}

{
  const { routes, res, smtpTransport } = settingsRoutes();
  await routes.handleVerifyPost(
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
  assert.equal(smtpTransport.sessions.length, 1);
  assertNoLeak(res.body, 'POST verify success');
  ok('admin POST verify returns connected_health without sending');
}

{
  const { routes, res, smtpTransport } = settingsRoutes({
    env: configuredEnv({ [VERIFY_FLAG]: undefined }),
  });
  await routes.handleVerifyPost(
    frozen({ location_id: LOCATION }),
    { method: 'POST', url: VERIFY_PATH },
    res,
    { role: 'admin', staff_user_id: ACTOR, client_slug: 'sunset', client_id: SUNSET_ID },
  );
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { success: false, error: 'not_found' });
  assert.equal(smtpTransport.sessions.length, 0);
  ok('POST verify concealed 404 when flag off');
}

{
  const { routes, res, smtpTransport } = settingsRoutes({
    env: configuredEnv({ LUNA_DEPLOYMENT: 'production' }),
  });
  await routes.handleVerifyPost(
    frozen({ location_id: LOCATION }),
    { method: 'POST', url: VERIFY_PATH },
    res,
    { role: 'admin', staff_user_id: ACTOR, client_slug: 'sunset', client_id: SUNSET_ID },
  );
  assert.equal(res.status, 404);
  assert.equal(smtpTransport.sessions.length, 0);
  ok('POST verify concealed 404 outside sunset-staging');
}

{
  const { routes, res, smtpTransport } = settingsRoutes({ access: false });
  await routes.handleVerifyPost(
    frozen({ location_id: LOCATION }),
    { method: 'POST', url: VERIFY_PATH },
    res,
    { role: 'admin', staff_user_id: ACTOR, client_slug: 'wolfhouse-somo', client_id: OTHER_ID },
  );
  assert.equal(res.status, 403);
  assert.equal(smtpTransport.sessions.length, 0);
  ok('cross-tenant ACL denial before SMTP');
}

{
  const { routes, res, smtpTransport } = settingsRoutes();
  await routes.handleVerifyPost(
    frozen({ location_id: LOCATION }),
    { method: 'POST', url: VERIFY_PATH },
    res,
    { role: 'operator', staff_user_id: ACTOR, client_slug: 'sunset', client_id: SUNSET_ID },
  );
  assert.ok(res.status === 403 || res.status === 404);
  assert.equal(smtpTransport.sessions.length, 0);
  ok('non-admin denied with zero SMTP');
}

{
  const { routes, res, smtpTransport } = settingsRoutes({
    smtpTransport: fakeSmtpTransport({ failAuth: true }),
  });
  await routes.handleVerifyPost(
    frozen({ location_id: LOCATION }),
    { method: 'POST', url: VERIFY_PATH },
    res,
    { role: 'admin', staff_user_id: ACTOR, client_slug: 'sunset', client_id: SUNSET_ID },
  );
  assert.ok(res.status >= 400);
  assert.equal(res.body.success, false);
  assert.deepEqual(res.body.failed_secret_names, ['sunset-smtp-password']);
  assertNoLeak(res.body, 'POST auth fail');
  assert.equal(res.body.connection_state, 'registered_not_connected');
  ok('POST verify AUTH failure names password secret only');
}

{
  const { routes, res } = settingsRoutes({
    env: configuredEnv({ LUNA_EMAIL_SMTP_HOST_SECRET_REF: undefined }),
  });
  await routes.handleVerifyPost(
    frozen({ location_id: LOCATION }),
    { method: 'POST', url: VERIFY_PATH },
    res,
    { role: 'admin', staff_user_id: ACTOR, client_slug: 'sunset', client_id: SUNSET_ID },
  );
  assert.ok(res.status >= 400);
  assert.deepEqual(res.body.missing_secret_names, ['sunset-smtp-host']);
  assertNoLeak(res.body, 'POST missing host');
  ok('POST verify missing secret names only the exact NAME');
}

{
  const { createSunsetSmtpStarttlsTransport } = transportOwner;
  const received = [];
  const server = net.createServer((socket) => {
    let upgraded = false;
    let buf = '';
    socket.write('220 smtp.example.test ESMTP\r\n');
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\r\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        received.push(line);
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO' && !upgraded) {
          socket.write('250-smtp.example.test\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN\r\n');
        } else if (verb === 'STARTTLS') {
          socket.write('220 ready\r\n');
        } else if (verb === 'EHLO' && upgraded) {
          socket.write('250-smtp.example.test\r\n250 AUTH PLAIN LOGIN\r\n');
        } else if (verb === 'AUTH') {
          socket.write('235 2.7.0 accepted\r\n');
        } else if (verb === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else {
          socket.write('502 not implemented\r\n');
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const transport = createSunsetSmtpStarttlsTransport(frozen({
    netModule: net,
    tlsConnect(opts, cb) {
      upgraded = true;
      const socket = opts.socket;
      if (typeof cb === 'function') queueMicrotask(cb);
      return socket;
    },
  }));
  let upgraded = false;
  const result = await transport.verifySession(frozen({
    host: '127.0.0.1',
    port,
    tlsMode: 'starttls',
    username: 'tywoods@gmail.com',
    password: PLANTED,
  }));
  server.close();
  assert.equal(result.ok, true);
  assert.ok(received.some((line) => /^EHLO\b/i.test(line)));
  assert.ok(received.some((line) => /^STARTTLS$/i.test(line)));
  assert.ok(received.some((line) => /^AUTH PLAIN\b/i.test(line)));
  assert.ok(received.some((line) => /^QUIT$/i.test(line)));
  assert.ok(!received.some((line) => /MAIL FROM|RCPT TO|^DATA$/i.test(line)));
  assert.ok(!received.join('\n').includes(PLANTED));
  assertNoLeak(result, 'local SMTP mock');
  ok('real STARTTLS transport AUTH+QUIT never MAIL FROM/RCPT TO/DATA');
}

const apiSrc = fs.readFileSync(path.join(ROOT, API_REL), 'utf8');
const settingsSrc = fs.readFileSync(path.join(ROOT, SETTINGS_REL), 'utf8');
const uiSrc = fs.readFileSync(path.join(ROOT, UI_REL), 'utf8');
const contractSrc = fs.readFileSync(path.join(ROOT, CONTRACT_REL), 'utf8');
const verifySrc = fs.readFileSync(path.join(ROOT, VERIFY_REL), 'utf8');
const transportSrc = fs.readFileSync(path.join(ROOT, TRANSPORT_REL), 'utf8');
const inboxSrc = fs.existsSync(path.join(ROOT, INBOX_REL))
  ? fs.readFileSync(path.join(ROOT, INBOX_REL), 'utf8')
  : '';

assert.ok(apiSrc.includes('EMAIL_SMTP_VERIFY_PATH'));
const verifyBlockStart = apiSrc.indexOf(
  "pathname === EMAIL_SMTP_VERIFY_PATH && method === 'POST'",
);
assert.ok(verifyBlockStart > 0, 'SMTP verify POST router block present');
const verifyBlockNext = apiSrc.indexOf('\n  if (pathname ===', verifyBlockStart + 1);
const verifyBlock = apiSrc.slice(
  verifyBlockStart,
  verifyBlockNext > verifyBlockStart ? verifyBlockNext : verifyBlockStart + 1800,
);
const iGate = verifyBlock.indexOf('isSunsetEmailSmtpVerifyEnabled');
const iAuth = verifyBlock.indexOf('requireAuth');
const iBody = verifyBlock.indexOf('readBody');
assert.ok(
  iGate >= 0 && iAuth > iGate && iBody > iAuth,
  'SMTP verify router contract gate must precede requireAuth and readBody',
);
assert.match(verifyBlock, /sendJSON\(\s*res,\s*404,\s*\{\s*success:\s*false,\s*error:\s*['"]not_found['"]\s*\}/);
ok('router source ordering: verify gate before requireAuth and readBody');

assert.ok(!/MAIL FROM|RCPT TO|\bDATA\b/i.test(verifySrc));
assert.doesNotMatch(transportSrc, /MAIL FROM|RCPT TO|[\r\n]DATA[\r\n]/);
assert.ok(/STARTTLS/.test(transportSrc) && /AUTH/.test(transportSrc) && /QUIT/.test(transportSrc));
assert.ok(!/LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED\s*=\s*'true'/.test(verifySrc));
assert.ok(!uiSrc.includes('inbox-thread'));
assert.ok(!verifySrc.includes('inbox-thread'));
assert.ok(uiSrc.includes(GMAIL_CALLBACK) || uiSrc.includes('https://sunset-staging.lunafrontdesk.com/staff/email/google/callback'));
assert.ok(!/type="password"/.test(uiSrc));
assert.ok(!contractSrc.includes(PLANTED));
assert.ok(!verifySrc.includes(PLANTED));
assert.ok(!inboxSrc.includes(VERIFY_PATH));
assert.ok(!inboxSrc.includes('sunset-smtp-password'));
assert.equal(settings.isSunsetEmailGoogleOAuthStartEnabled(configuredEnv()), false);
ok('wiring + no send verbs + Gmail/Inbox/UI exclusions hold');

console.log(`PASS EMAIL-SMTP-003 live verify (${pass} checks)`);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

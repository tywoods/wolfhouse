'use strict';

/**
 * EMAIL-SMTP-002 — fail-closed Sunset SMTP identity register/connect.
 *
 * Authentic focused gate: Staff Admin Email Settings may register a disabled
 * `imap_smtp` identity only when all five approved opaque Key Vault secret
 * references are configured. No values, send, IMAP poll, SMTP socket, Gmail
 * drift, or activation. Default-off outside sunset-staging.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const CONTRACT_REL = 'scripts/lib/email-sunset-smtp-secret-ref-contract.js';
const REGISTER_REL = 'scripts/lib/email-sunset-smtp-identity-register.js';
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
const FLAG = 'LUNA_EMAIL_SMTP_IDENTITY_REGISTER_ENABLED';
const PATH = '/staff/admin/email-settings/smtp/endpoint';
const GMAIL_CALLBACK = '/staff/email/google/callback';
const IDENTITY_REF = 'secret-ref:email/smtp/sunset-staging';
const LOCATION = 'sunset-somo';
const MAILBOX = 'desk@sunset.example';
const SUNSET_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ACTOR = 'abcdef01-2345-4678-89ab-cdef01234567';
const SESSION = '11111111-1111-4111-8111-111111111111';
const ENDPOINT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EIGHT_OFF = Object.freeze({
  push_notifications: false,
  provider_threads: false,
  remote_drafts: false,
  reply: false,
  reply_all: false,
  forward: false,
  attachments_metadata: false,
  delivery_events: false,
});

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
    [FLAG]: 'true',
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

function ownData(obj, key) {
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  return desc && Object.hasOwn(desc, 'value') ? desc.value : undefined;
}

function response() {
  return { status: null, body: null };
}

function sendJSON(res, status, body) {
  res.status = status;
  res.body = body;
  return body;
}

async function main() {
const contract = require('./lib/email-sunset-smtp-secret-ref-contract');
const registerOwner = require('./lib/email-sunset-smtp-identity-register');
const settings = require('./lib/staff-email-settings-routes');

assert.equal(contract.SUNSET_SMTP_SECRET_NAMES.length, 5);
assert.deepEqual([...contract.SUNSET_SMTP_SECRET_NAMES], [...NAMES]);
assert.deepEqual([...contract.SUNSET_SMTP_SECRET_REFS], [...REFS]);
assert.equal(contract.SUNSET_SMTP_IDENTITY_SECRET_REF, IDENTITY_REF);
assert.equal(contract.SMTP_IDENTITY_REGISTER_ENABLED_ENV, FLAG);
assert.equal(contract.EMAIL_SMTP_IDENTITY_PATH, PATH);
assert.equal(settings.EMAIL_SMTP_IDENTITY_PATH, PATH);
assert.equal(registerOwner.EMAIL_SMTP_IDENTITY_PATH, PATH);
ok('exact approved KV names and opaque refs');

assert.equal(contract.isSunsetEmailSmtpIdentityRegisterEnabled({}), false);
assert.equal(contract.isSunsetEmailSmtpIdentityRegisterEnabled({
  SUNSET_EMAIL_SETTINGS_UI_ENABLED: 'true',
  LUNA_DEPLOYMENT: 'sunset-staging',
}), false);
for (const bad of ['TRUE', '1', true, 'yes', 'sunset-staging ']) {
  assert.equal(contract.isSunsetEmailSmtpIdentityRegisterEnabled(configuredEnv({
    [FLAG]: bad === 'sunset-staging ' ? 'true' : bad,
    LUNA_DEPLOYMENT: bad === 'sunset-staging ' ? bad : 'sunset-staging',
  })), false);
}
assert.equal(contract.isSunsetEmailSmtpIdentityRegisterEnabled(configuredEnv({
  LUNA_DEPLOYMENT: 'wolfhouse-staging',
})), false);
assert.equal(contract.isSunsetEmailSmtpIdentityRegisterEnabled(configuredEnv({
  LUNA_DEPLOYMENT: 'production',
})), false);
assert.equal(contract.isSunsetEmailSmtpIdentityRegisterEnabled(configuredEnv()), true);
ok('runtime flag default-off exact true + sunset-staging only');

const ready = contract.evaluateSunsetSmtpSecretRefs(configuredEnv());
assert.equal(ready.ok, true);
assert.deepEqual([...ready.missing_secret_names], []);
assert.deepEqual([...ready.secret_refs], [...REFS]);
assertNoLeak(ready, 'ready evaluation');
ok('all five refs configured reports ok with opaque refs only');

for (const name of NAMES) {
  const envKey = contract.SUNSET_SMTP_SECRET_ENV_KEYS[name];
  const missing = contract.evaluateSunsetSmtpSecretRefs(configuredEnv({ [envKey]: undefined }));
  assert.equal(missing.ok, false);
  assert.deepEqual([...missing.missing_secret_names], [name]);
  assertNoLeak(missing, `missing ${name}`);
  const wrong = contract.evaluateSunsetSmtpSecretRefs(configuredEnv({ [envKey]: PLANTED }));
  assert.equal(wrong.ok, false);
  assert.deepEqual([...wrong.missing_secret_names], [name]);
  assertNoLeak(wrong, `planted value as ${name} ref`);
  const alias = contract.evaluateSunsetSmtpSecretRefs(configuredEnv({
    [envKey]: `kv:${name}-alias`,
  }));
  assert.equal(alias.ok, false);
  assert.deepEqual([...alias.missing_secret_names], [name]);
}
ok('missing each exact ref name fail-closed; planted values never echoed');

const getterEnv = { ...configuredEnv() };
Object.defineProperty(getterEnv, 'LUNA_EMAIL_SMTP_PASSWORD_SECRET_REF', {
  get() { throw new Error(PLANTED); },
  enumerable: true,
});
const getterResult = contract.evaluateSunsetSmtpSecretRefs(getterEnv);
assert.equal(getterResult.ok, false);
assert.ok(getterResult.missing_secret_names.includes('sunset-smtp-password'));
assertNoLeak(getterResult, 'getter env');
ok('accessor env descriptors fail closed without invoking secret getters');

const protoEnv = Object.create({ LUNA_EMAIL_SMTP_HOST_SECRET_REF: PLANTED });
Object.assign(protoEnv, configuredEnv({ LUNA_EMAIL_SMTP_HOST_SECRET_REF: undefined }));
const inherited = contract.evaluateSunsetSmtpSecretRefs(frozen(protoEnv));
assert.equal(inherited.ok, false);
assert.ok(inherited.missing_secret_names.includes('sunset-smtp-host'));
assertNoLeak(inherited, 'inherited env');
ok('inherited env values are not trusted');

const proxyEnv = new Proxy(configuredEnv(), {
  get() { throw new Error(PLANTED); },
});
const proxied = contract.evaluateSunsetSmtpSecretRefs(proxyEnv);
assert.equal(proxied.ok, false);
assertNoLeak(proxied, 'proxy env');
ok('proxy env rejected before traps');

function fakePg(opts) {
  const inserts = [];
  const stored = [];
  if (opts && opts.existing) {
    stored.push(opts.existing === true
      ? {
          id: ENDPOINT_ID,
          public_address: MAILBOX,
          inbound_enabled: false,
          outbound_enabled: false,
          active: false,
          default_automation_mode: 'off',
        }
      : opts.existing);
  }
  const query = async (sql, params) => {
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
      return { rows: [{ client_id: SUNSET_ID, location_id: LOCATION, active: true, display_name: 'Sunset' }] };
    }
    if (/pg_advisory_xact_lock/i.test(text)) return { rows: [] };
    if (/lower\(public_address\)/i.test(text)) {
      if (opts && opts.existingAddress) return { rows: [{ id: ENDPOINT_ID }] };
      return { rows: stored.filter((row) => row.public_address === (params && params[1])).map((row) => Object.assign({}, row)) };
    }
    if (/SELECT id[\s\S]*tenant_channel_endpoints/i.test(text)) {
      return { rows: stored.map((row) => Object.assign({}, row)) };
    }
    if (/UPDATE tenant_channel_endpoints/i.test(text)) {
      return { rows: stored.map((row) => ({ id: row.id })) };
    }
    if (/INSERT INTO tenant_channel_endpoints/i.test(text)) {
      inserts.push({ sql: text, params: params.slice() });
      stored.push({
        id: ENDPOINT_ID,
        public_address: params[2],
        inbound_enabled: false,
        outbound_enabled: false,
        active: false,
        default_automation_mode: 'off',
      });
      return {
        rows: [{
          id: ENDPOINT_ID,
          client_id: SUNSET_ID,
          location_id: LOCATION,
          channel: 'email',
          provider: 'imap_smtp',
          public_address: MAILBOX,
          secret_ref: IDENTITY_REF,
          provider_resource_id: null,
          capabilities: EIGHT_OFF,
          inbound_enabled: false,
          outbound_enabled: false,
          default_automation_mode: 'off',
          active: false,
          created_at: '2026-08-19T00:00:00.000Z',
          updated_at: '2026-08-19T00:00:00.000Z',
          created_by: ACTOR,
          updated_by: ACTOR,
        }],
      };
    }
    return { rows: [] };
  };
  return { query, inserts };
}

function registerService(pg, env) {
  return registerOwner.createSunsetSmtpIdentityRegister(frozen({
    client: frozen({ query: pg.query.bind(pg) }),
    env: env || configuredEnv(),
  }));
}

{
  const pg = fakePg();
  const service = registerService(pg);
  const ack = await service.registerDisabledImapSmtpIdentity(frozen({
    clientId: SUNSET_ID,
    locationId: LOCATION,
    publicAddress: MAILBOX,
    actorStaffUserId: ACTOR,
  }));
  assert.equal(ack.endpointId, ENDPOINT_ID);
  assert.equal(ack.provider, 'imap_smtp');
  assert.equal(ack.inbound_enabled, false);
  assert.equal(ack.outbound_enabled, false);
  assert.equal(ack.active, false);
  assert.equal(ack.default_automation_mode, 'off');
  assert.equal(pg.inserts.length, 1);
  const params = pg.inserts[0].params;
  assert.equal(params.length, 5);
  assert.equal(params[0], SUNSET_ID);
  assert.equal(params[1], LOCATION);
  assert.equal(params[2], MAILBOX);
  assert.equal(params[3], JSON.stringify(EIGHT_OFF));
  assert.equal(params[4], ACTOR);
  const sql = pg.inserts[0].sql;
  assert.match(sql, /'imap_smtp'/);
  assert.match(sql, /'secret-ref:email\/smtp\/sunset-staging'/);
  assert.match(sql, /false, false, 'off', false/);
  assert.match(sql, /NULL, NULL, NULL, NULL, NULL, NULL, NULL/);
  assert.doesNotMatch(sql, /\$6/);
  const json = JSON.stringify(ack);
  assert.ok(!json.includes(IDENTITY_REF));
  assert.ok(!json.includes(PLANTED));
  assert.ok(!('secret_ref' in ack));
  assert.ok(!('inboundEnabled' in ack));
  ok('register returns disabled identity and forced-safe INSERT params');
}

{
  const pg = fakePg({ existing: true });
  const service = registerService(pg);
  const ack = await service.registerDisabledImapSmtpIdentity(frozen({
    clientId: SUNSET_ID,
    locationId: LOCATION,
    publicAddress: MAILBOX,
    actorStaffUserId: ACTOR,
  }));
  assert.equal(ack.endpointId, ENDPOINT_ID);
  assert.equal(ack.provider, 'imap_smtp');
  assert.equal(ack.inbound_enabled, false);
  assert.equal(ack.outbound_enabled, false);
  assert.equal(ack.active, false);
  assert.equal(ack.default_automation_mode, 'off');
  assert.equal(pg.inserts.length, 0);
  ok('existing same-address imap_smtp at location returns forced-disabled ack with zero INSERT');
}

{
  const pg = fakePg({ existingAddress: true });
  const service = registerService(pg);
  await assert.rejects(() => service.registerDisabledImapSmtpIdentity(frozen({
    clientId: SUNSET_ID,
    locationId: LOCATION,
    publicAddress: MAILBOX,
    actorStaffUserId: ACTOR,
  })));
  assert.equal(pg.inserts.length, 0);
  ok('existing imap_smtp at address denied with zero INSERT');
}

{
  const pg = fakePg();
  const service = registerService(pg);
  const input = frozen({
    clientId: SUNSET_ID,
    locationId: LOCATION,
    publicAddress: MAILBOX,
    actorStaffUserId: ACTOR,
  });
  await service.registerDisabledImapSmtpIdentity(input);
  await assert.rejects(() => service.registerDisabledImapSmtpIdentity(input));
  assert.equal(pg.inserts.length, 1);
  ok('register factory is single-use');
}

{
  const pg = fakePg();
  const service = registerService(pg);
  const input = frozen({
    clientId: SUNSET_ID,
    locationId: LOCATION,
    publicAddress: MAILBOX,
    actorStaffUserId: ACTOR,
  });
  const first = await service.registerDisabledImapSmtpIdentity(input);
  assert.equal(first.endpointId, ENDPOINT_ID);
  assert.equal(pg.inserts.length, 1);
  const retry = await registerService(pg).registerDisabledImapSmtpIdentity(input);
  assert.equal(retry.endpointId, ENDPOINT_ID);
  assert.equal(retry.provider, 'imap_smtp');
  assert.equal(retry.inbound_enabled, false);
  assert.equal(retry.outbound_enabled, false);
  assert.equal(retry.active, false);
  assert.equal(retry.default_automation_mode, 'off');
  assert.equal(pg.inserts.length, 1);
  assert.ok(!('secret_ref' in retry));
  ok('lost-response retry returns existing forced-disabled identity with zero INSERT');
}

{
  const pg = fakePg({
    existing: {
      id: ENDPOINT_ID,
      public_address: 'other@sunset.example',
      inbound_enabled: false,
      outbound_enabled: false,
      active: false,
      default_automation_mode: 'off',
    },
  });
  const service = registerService(pg);
  await assert.rejects(() => service.registerDisabledImapSmtpIdentity(frozen({
    clientId: SUNSET_ID,
    locationId: LOCATION,
    publicAddress: MAILBOX,
    actorStaffUserId: ACTOR,
  })));
  assert.equal(pg.inserts.length, 0);
  ok('different public address does not alias existing imap_smtp identity');
}

{
  const pg = fakePg();
  const service = registerService(pg);
  await assert.rejects(() => service.registerDisabledImapSmtpIdentity(frozen({
    clientId: SUNSET_ID,
    locationId: LOCATION,
    publicAddress: MAILBOX,
    actorStaffUserId: ACTOR,
    inbound_enabled: true,
    outbound_enabled: true,
    active: true,
    default_automation_mode: 'automatic',
    send: true,
    auto_send: true,
    secret_ref: PLANTED,
    password: PLANTED,
  })));
  assert.equal(pg.inserts.length, 0);
  ok('extra/activation/send/secret fields rejected before write');
}

{
  const pg = fakePg();
  const service = registerService(pg);
  const accessor = {};
  Object.defineProperty(accessor, 'clientId', { value: SUNSET_ID, enumerable: true });
  Object.defineProperty(accessor, 'locationId', { value: LOCATION, enumerable: true });
  Object.defineProperty(accessor, 'publicAddress', { value: MAILBOX, enumerable: true });
  Object.defineProperty(accessor, 'actorStaffUserId', {
    get() { throw new Error(PLANTED); },
    enumerable: true,
  });
  await assert.rejects(() => service.registerDisabledImapSmtpIdentity(frozen(accessor)));
  assert.equal(pg.inserts.length, 0);
  ok('getter inputs rejected without invoking');
}

{
  const pg = fakePg();
  const service = registerService(pg);
  const hostile = new Proxy(frozen({
    clientId: SUNSET_ID,
    locationId: LOCATION,
    publicAddress: MAILBOX,
    actorStaffUserId: ACTOR,
  }), {
    get() { throw new Error(PLANTED); },
    ownKeys() { throw new Error(PLANTED); },
  });
  await assert.rejects(() => service.registerDisabledImapSmtpIdentity(hostile));
  assert.equal(pg.inserts.length, 0);
  ok('proxy inputs rejected before traps');
}

{
  const pg = fakePg({ locationMissing: true });
  const service = registerService(pg);
  await assert.rejects(() => service.registerDisabledImapSmtpIdentity(frozen({
    clientId: SUNSET_ID,
    locationId: 'wolfhouse-somo',
    publicAddress: MAILBOX,
    actorStaffUserId: ACTOR,
  })));
  assert.equal(pg.inserts.length, 0);
  ok('cross-location/missing location denied with zero INSERT');
}

{
  const pg = fakePg({ clientId: null });
  const service = registerService(pg);
  await assert.rejects(() => service.registerDisabledImapSmtpIdentity(frozen({
    clientId: OTHER_ID,
    locationId: LOCATION,
    publicAddress: MAILBOX,
    actorStaffUserId: ACTOR,
  })));
  assert.equal(pg.inserts.length, 0);
  ok('non-Sunset client UUID denied before write');
}

{
  const pg = fakePg();
  const service = registerService(pg, configuredEnv({
    LUNA_EMAIL_SMTP_PASSWORD_SECRET_REF: undefined,
  }));
  let err;
  try {
    await service.registerDisabledImapSmtpIdentity(frozen({
      clientId: SUNSET_ID,
      locationId: LOCATION,
      publicAddress: MAILBOX,
      actorStaffUserId: ACTOR,
    }));
  } catch (caught) {
    err = caught;
  }
  assert.ok(err);
  const surface = JSON.stringify(err) + String(err && err.message) + String(err && err.code);
  assert.ok(surface.includes('sunset-smtp-password') || (err.missing_secret_names || []).includes('sunset-smtp-password'));
  assert.ok(!surface.includes(PLANTED));
  assert.equal(pg.inserts.length, 0);
  ok('register fail-closed names missing secret only');
}

function settingsRoutes(extra) {
  const pg = extra && extra.pg ? extra.pg : fakePg();
  const env = extra && extra.env ? extra.env : configuredEnv();
  const access = extra && extra.access !== undefined ? extra.access : true;
  const roleDecision = extra && extra.authz !== undefined ? extra.authz : { ok: true };
  const res = response();
  const logs = [];
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
    listTenantLocations: extra && extra.listLocations
      ? extra.listLocations
      : async () => ({ ok: true, value: [{ location_id: LOCATION, display_name: 'Sunset', active: true }] }),
    listTenantChannelEndpoints: extra && extra.listEndpoints
      ? extra.listEndpoints
      : async () => ({ ok: true, value: [] }),
    loadPhaseBReauthEligibilityFacts: extra && extra.atomic
      ? extra.atomic
      : async () => [],
    createSmtpIdentityRegister: extra && extra.createRegister
      ? extra.createRegister
      : (client) => registerOwner.createSunsetSmtpIdentityRegister(frozen({
        client: frozen({ query: client.query.bind(client) }),
        env,
      })),
    logger: { error(msg) { logs.push(String(msg)); } },
  });
  return { routes, res, pg, logs };
}

{
  const { routes, res } = settingsRoutes({ env: configuredEnv({ [FLAG]: undefined }) });
  await routes.handlePost(
    frozen({ location_id: LOCATION, public_address: MAILBOX }),
    { method: 'POST', url: PATH },
    res,
    { role: 'admin', staff_user_id: ACTOR, client_slug: 'sunset', client_id: SUNSET_ID, session_id: SESSION },
  );
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { success: false, error: 'not_found' });
  ok('POST concealed 404 when SMTP identity flag off');
}

{
  const { routes, res, pg } = settingsRoutes({ env: configuredEnv({ LUNA_DEPLOYMENT: 'production' }) });
  await routes.handlePost(
    frozen({ location_id: LOCATION, public_address: MAILBOX }),
    { method: 'POST', url: PATH },
    res,
    { role: 'admin', staff_user_id: ACTOR, client_slug: 'sunset', client_id: SUNSET_ID, session_id: SESSION },
  );
  assert.equal(res.status, 404);
  assert.equal(pg.inserts.length, 0);
  ok('POST concealed 404 outside sunset-staging');
}

{
  const { routes, res, pg } = settingsRoutes({ access: false });
  await routes.handlePost(
    frozen({ location_id: LOCATION, public_address: MAILBOX }),
    { method: 'POST', url: PATH },
    res,
    { role: 'admin', staff_user_id: ACTOR, client_slug: 'wolfhouse-somo', client_id: OTHER_ID, session_id: SESSION },
  );
  assert.equal(res.status, 403);
  assert.equal(pg.inserts.length, 0);
  ok('cross-tenant ACL denial before write');
}

{
  const { routes, res, pg } = settingsRoutes();
  await routes.handlePost(
    frozen({ location_id: LOCATION, public_address: MAILBOX }),
    { method: 'POST', url: PATH },
    res,
    { role: 'operator', staff_user_id: ACTOR, client_slug: 'sunset', client_id: SUNSET_ID, session_id: SESSION },
  );
  assert.ok(res.status === 403 || res.status === 404);
  assert.equal(pg.inserts.length, 0);
  ok('non-admin denied with zero INSERT');
}

{
  const { routes, res } = settingsRoutes({
    env: configuredEnv({ LUNA_EMAIL_SMTP_HOST_SECRET_REF: undefined }),
  });
  await routes.handlePost(
    frozen({ location_id: LOCATION, public_address: MAILBOX }),
    { method: 'POST', url: PATH },
    res,
    { role: 'admin', staff_user_id: ACTOR, client_slug: 'sunset', client_id: SUNSET_ID, session_id: SESSION },
  );
  assert.ok(res.status >= 400);
  assert.equal(res.body.success, false);
  assert.deepEqual(res.body.missing_secret_names, ['sunset-smtp-host']);
  assertNoLeak(res.body, 'POST missing host');
  ok('POST missing secret names only the exact NAME');
}

{
  const { routes, res, pg } = settingsRoutes();
  await routes.handlePost(
    frozen({
      location_id: LOCATION,
      public_address: MAILBOX,
      inbound_enabled: true,
      outbound_enabled: true,
      active: true,
      auto_send: true,
      secret_ref: PLANTED,
      password: PLANTED,
    }),
    { method: 'POST', url: PATH },
    res,
    { role: 'admin', staff_user_id: ACTOR, client_slug: 'sunset', client_id: SUNSET_ID, session_id: SESSION },
  );
  assert.ok(res.status >= 400);
  assert.equal(pg.inserts.length, 0);
  assertNoLeak(res.body, 'POST forbidden fields');
  ok('POST rejects forbidden activation/send/secret fields');
}

{
  const { routes, res, pg } = settingsRoutes();
  await routes.handlePost(
    frozen({ location_id: LOCATION, public_address: MAILBOX }),
    { method: 'POST', url: PATH },
    res,
    { role: 'owner', staff_user_id: ACTOR, client_slug: 'sunset', client_id: SUNSET_ID, session_id: SESSION },
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.endpoint_id, ENDPOINT_ID);
  assert.equal(res.body.provider, 'imap_smtp');
  assert.equal(res.body.inbound_enabled, false);
  assert.equal(res.body.outbound_enabled, false);
  assert.equal(res.body.active, false);
  assert.equal(res.body.default_automation_mode, 'off');
  assert.equal(pg.inserts.length, 1);
  assert.ok(!JSON.stringify(res.body).includes(IDENTITY_REF));
  assert.ok(!JSON.stringify(res.body).includes('secret_ref'));
  assert.ok(!JSON.stringify(res.body).includes('kv:'));
  assertNoLeak(res.body, 'POST success');
  ok('admin/owner POST creates disabled imap_smtp identity');
}

{
  const { routes, res } = settingsRoutes();
  await routes.handleGet({ client: 'sunset' }, {}, res, {
    role: 'admin', staff_user_id: ACTOR, client_slug: 'sunset', client_id: SUNSET_ID, session_id: SESSION,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.provider_actions.imap_smtp.prepare, true);
  assert.equal(res.body.provider_actions.imap_smtp.connect, false);
  assert.equal(res.body.provider_actions.imap_smtp.disconnect, false);
  assert.equal(res.body.provider_actions.imap_smtp.reauthorize, false);
  assert.equal(res.body.smtp_secret_status.configured, true);
  assert.deepEqual(res.body.smtp_secret_status.missing_secret_names, []);
  assert.equal(res.body.provider_actions.gmail_api.prepare, false);
  assertNoLeak(res.body, 'GET ready');
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes(IDENTITY_REF));
  assert.ok(!text.includes(PLANTED));
  assert.ok(!text.includes('kv:'));
  assert.ok(!text.includes('secret_ref'));
  ok('GET projects smtp prepare when refs configured; Gmail stays off');
}

{
  const { routes, res } = settingsRoutes({
    env: configuredEnv({ LUNA_EMAIL_SMTP_PORT_SECRET_REF: undefined }),
  });
  await routes.handleGet({ client: 'sunset' }, {}, res, {
    role: 'admin', staff_user_id: ACTOR, client_slug: 'sunset',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.provider_actions.imap_smtp.prepare, false);
  assert.deepEqual(res.body.smtp_secret_status.missing_secret_names, ['sunset-smtp-port']);
  assert.equal(res.body.smtp_secret_status.configured, false);
  assertNoLeak(res.body, 'GET missing port');
  ok('GET fail-closed identifies exact missing secret NAME');
}

{
  const { routes, res } = settingsRoutes({ env: configuredEnv({ [FLAG]: undefined }) });
  await routes.handleGet({ client: 'sunset' }, {}, res, { role: 'admin' });
  assert.equal(res.status, 200);
  assert.equal(res.body.provider_actions.imap_smtp.prepare, false);
  assert.ok(!res.body.smtp_secret_status);
  ok('GET omits SMTP secret status when flag off');
}

const apiSrc = fs.readFileSync(path.join(ROOT, API_REL), 'utf8');
const settingsSrc = fs.readFileSync(path.join(ROOT, SETTINGS_REL), 'utf8');
const uiSrc = fs.readFileSync(path.join(ROOT, UI_REL), 'utf8');
const contractSrc = fs.readFileSync(path.join(ROOT, CONTRACT_REL), 'utf8');
const registerSrc = fs.readFileSync(path.join(ROOT, REGISTER_REL), 'utf8');
const inboxSrc = fs.existsSync(path.join(ROOT, INBOX_REL))
  ? fs.readFileSync(path.join(ROOT, INBOX_REL), 'utf8')
  : '';

assert.ok(apiSrc.includes('EMAIL_SMTP_IDENTITY_PATH'));
assert.ok(apiSrc.includes('handleSmtpIdentityPost') || apiSrc.includes('EMAIL_SMTP_IDENTITY_PATH'));
assert.match(
  apiSrc,
  /isSunsetEmailSmtpIdentityRegisterEnabled[\s\S]{0,80}require\('\.\/lib\/email-sunset-smtp-secret-ref-contract'\)|require\('\.\/lib\/email-sunset-smtp-secret-ref-contract'\)[\s\S]{0,200}isSunsetEmailSmtpIdentityRegisterEnabled/,
);
assert.match(apiSrc, /isSunsetEmailSmtpIdentityRegisterEnabled/);
const smtpBlockStart = apiSrc.indexOf(
  "pathname === EMAIL_SMTP_IDENTITY_PATH && method === 'POST'",
);
assert.ok(smtpBlockStart > 0, 'SMTP identity POST router block present');
const smtpBlockNext = apiSrc.indexOf('\n  if (pathname ===', smtpBlockStart + 1);
const smtpBlock = apiSrc.slice(
  smtpBlockStart,
  smtpBlockNext > smtpBlockStart ? smtpBlockNext : smtpBlockStart + 1600,
);
const iSmtpGate = smtpBlock.indexOf('isSunsetEmailSmtpIdentityRegisterEnabled');
const iSmtpAuth = smtpBlock.indexOf('requireAuth');
const iSmtpBody = smtpBlock.indexOf('readBody');
assert.ok(
  iSmtpGate >= 0 && iSmtpAuth > iSmtpGate && iSmtpBody > iSmtpAuth,
  'SMTP router contract gate must precede requireAuth and readBody',
);
assert.match(smtpBlock, /sendJSON\(\s*res,\s*404,\s*\{\s*success:\s*false,\s*error:\s*['"]not_found['"]\s*\}/);
assert.equal(
  /LUNA_EMAIL_SMTP_IDENTITY_REGISTER_ENABLED\s*===/.test(smtpBlock)
    || /LUNA_DEPLOYMENT\s*===\s*['"]sunset-staging['"]/.test(smtpBlock),
  false,
  'router must use canonical contract gate, not duplicated flag/deployment logic',
);
ok('router source ordering: contract gate before requireAuth and readBody');
assert.ok(!/createTransport|nodemailer|smtp:\/\//i.test(registerSrc));
assert.ok(!/createTransport|nodemailer|net\.connect|tls\.connect/i.test(settingsSrc));
assert.ok(!/LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED\s*=\s*'true'/.test(registerSrc));
assert.ok(!uiSrc.includes('inbox-thread'));
assert.ok(!registerSrc.includes('inbox-thread'));
assert.ok(uiSrc.includes(GMAIL_CALLBACK) || uiSrc.includes('https://sunset-staging.lunafrontdesk.com/staff/email/google/callback'));
assert.ok(uiSrc.includes(PATH));
assert.ok(uiSrc.includes('imap_smtp'));
assert.ok(!/type="password"/.test(uiSrc));
assert.ok(!contractSrc.includes(PLANTED));
assert.ok(!registerSrc.includes(PLANTED));
assert.match(registerOwner.SQL_INSERT_ENDPOINT, /'secret-ref:email\/smtp\/sunset-staging'/);
assert.match(registerOwner.SQL_INSERT_ENDPOINT, /'imap_smtp'/);
assert.match(registerOwner.SQL_EXISTING_BY_ADDRESS, /lower\(public_address\)/);
assert.ok(!inboxSrc.includes(PATH));
assert.ok(!inboxSrc.includes('sunset-smtp-password'));
for (const name of NAMES) {
  assert.ok(contractSrc.includes(name), `contract owns ${name}`);
}
ok('wiring + Gmail callback unchanged + no SMTP network/password inputs');

assert.equal(settings.isSunsetEmailGoogleOAuthStartEnabled(configuredEnv()), false);
assert.ok(uiSrc.includes("https://sunset-staging.lunafrontdesk.com/staff/email/google/callback"));
ok('no Gmail OAuth enablement drift');

console.log(`PASS EMAIL-SMTP-002 identity register (${pass} checks)`);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

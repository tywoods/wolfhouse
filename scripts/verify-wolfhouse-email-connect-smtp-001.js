'use strict';

const assert = require('node:assert/strict');
const {
  BUNDLE_SECRET_NAME,
  createWolfhouseEmailConnectService,
  createWolfhouseKvStore,
  isEnabled,
  resolvePublicHost,
  sanitizeError,
  validateConnect,
} = require('./lib/email-wolfhouse-smtp-imap-connect');
const routes = require('./lib/staff-wolfhouse-email-connect-routes');

const UUID = '11111111-1111-4111-8111-111111111111';
const CLIENT_UUID = '22222222-2222-4222-8222-222222222222';
const input = Object.freeze({
  clientSlug: 'wolfhouse-somo',
  deployment: 'staff-staging',
  locationId: 'wolfhouse-somo',
  publicAddress: 'frontdesk@example.test',
  smtp: { server: 'smtp.example.test', port: 587, tls: 'starttls', user: 'frontdesk@example.test', password: 'smtp-super-secret' },
  imap: { server: 'imap.example.test', port: 993, tls: 'tls', user: 'frontdesk@example.test', password: 'imap-super-secret' },
  actorStaffUserId: UUID,
  clientId: CLIENT_UUID,
});

function harness(options = {}) {
  let bundle = options.initialBundle || null;
  const events = [];
  const kv = {
    async readBundle() { events.push(['kv-read']); return bundle; },
    async writeBundle(value) {
      events.push(['kv-write']);
      if (options.failWrite) throw new Error(`vault ${input.smtp.password}`);
      bundle = value;
      return 'kv:wolfhouse-email-imap-smtp-credentials/test-version';
    },
  };
  const store = {
    async runExclusive(value, operation) {
      events.push(['lock', value]);
      return operation(store);
    },
    async publishConnected(value) {
      events.push(['publish', value]);
      if (options.failPublish) throw new Error(`database ${input.imap.password}`);
      return { endpointId: UUID };
    },
    async publishDisconnected(value) {
      events.push(['disconnect', value]);
      if (options.failDisconnect) throw new Error('database');
      return { endpointId: value.endpointId };
    },
  };
  const smtp = { async authenticate() { events.push(['smtp-auth']); return { ok: !options.smtpFail }; } };
  const imap = { async authenticate() { events.push(['imap-auth']); return { ok: !options.imapFail }; } };
  return {
    events,
    getBundle: () => bundle,
    service: createWolfhouseEmailConnectService({ kv, store, smtp, imap, resolveHost: async () => '8.8.8.8' }),
  };
}

(async () => {
  assert.equal(isEnabled({
    LUNA_DEPLOYMENT: 'staff-staging',
    WOLFHOUSE_EMAIL_SETTINGS_UI_ENABLED: 'true',
    WOLFHOUSE_EMAIL_SMTP_CONNECT_ENABLED: 'true',
  }), true);
  assert.equal(isEnabled({
    LUNA_DEPLOYMENT: 'sunset-staging',
    WOLFHOUSE_EMAIL_SETTINGS_UI_ENABLED: 'true',
    WOLFHOUSE_EMAIL_SMTP_CONNECT_ENABLED: 'true',
  }), false);
  assert.equal(isEnabled({
    LUNA_DEPLOYMENT: 'staff-staging',
    WOLFHOUSE_EMAIL_SETTINGS_UI_ENABLED: 'true',
    WOLFHOUSE_EMAIL_SMTP_CONNECT_ENABLED: 'TRUE',
  }), false);
  assert.equal(BUNDLE_SECRET_NAME, 'wolfhouse-email-imap-smtp-credentials');
  assert.ok(validateConnect(input));
  assert.equal(validateConnect({ ...input, clientSlug: 'sunset' }), null);
  assert.equal(validateConnect({ ...input, extra: true }), null);
  assert.equal(validateConnect({ ...input, smtp: { ...input.smtp, tls: 'tls' } }), null);
  assert.equal(validateConnect({ ...input, smtp: { ...input.smtp, port: 25 } }), null);
  assert.equal(validateConnect({ ...input, imap: { ...input.imap, port: 143 } }), null);
  await assert.rejects(() => resolvePublicHost('smtp.example.test', async () => [
    { address: '169.254.169.254', family: 4 },
  ]), /Email connection failed/);
  for (const address of ['::ffff:127.0.0.1', '::ffff:169.254.169.254', 'ff02::1']) {
    await assert.rejects(() => resolvePublicHost('smtp.example.test', async () => [
      { address, family: 6 },
    ]), /Email connection failed/);
  }
  assert.equal(await resolvePublicHost('smtp.example.test', async () => [
    { address: '8.8.8.8', family: 4 },
  ]), '8.8.8.8');

  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push([url, options]);
    return { ok: true, status: 200, json: async () => ({ value: 'old', id: 'https://wh-staging-kv.vault.azure.net/secrets/wolfhouse-email-imap-smtp-credentials/abc123' }) };
  };
  const kvStore = createWolfhouseKvStore({
    credential: { getToken: async () => ({ token: 'token' }) },
    fetchImpl: fakeFetch,
  });
  assert.equal(await kvStore.readBundle(), 'old');
  assert.equal(await kvStore.writeBundle('{"version":1}'), 'kv:wolfhouse-email-imap-smtp-credentials/abc123');
  assert.match(calls[0][0], /^https:\/\/wh-staging-kv\.vault\.azure\.net\/secrets\/wolfhouse-email-imap-smtp-credentials\?/);
  assert.equal(calls[0][1].headers.authorization, 'Bearer token');
  assert.equal(calls[1][1].method, 'PUT');

  let h = harness();
  const connected = await h.service.connect(input);
  assert.equal(connected.status, 'connected');
  assert.equal(connected.inbound_enabled, false);
  assert.equal(connected.outbound_enabled, false);
  assert.equal(connected.active, false);
  assert.equal(connected.default_automation_mode, 'off');
  assert.equal(h.events[0][0], 'lock');
  assert.ok(h.events.findIndex((event) => event[0] === 'kv-write') > h.events.findIndex((event) => event[0] === 'imap-auth'));
  assert.ok(h.events.findIndex((event) => event[0] === 'publish') > h.events.findIndex((event) => event[0] === 'kv-write'));
  assert.equal(h.events.find((event) => event[0] === 'publish')[1].secretRef,
    'kv:wolfhouse-email-imap-smtp-credentials/test-version');
  assert.match(h.getBundle(), /"version":1/);

  h = harness({ smtpFail: true });
  await assert.rejects(() => h.service.connect(input), (error) => error.message === 'Email connection failed.'
    && !JSON.stringify(error).includes('super-secret'));
  assert.equal(h.events.some((event) => event[0] === 'kv-write'), false);
  assert.equal(h.events.some((event) => event[0] === 'publish'), false);

  h = harness({ imapFail: true });
  await assert.rejects(() => h.service.connect(input), /Email connection failed/);
  assert.equal(h.events.some((event) => event[0] === 'kv-write'), false);

  h = harness({ initialBundle: 'prior', failPublish: true });
  await assert.rejects(() => h.service.connect(input), (error) => !JSON.stringify(error).includes('imap-super-secret'));
  assert.notEqual(h.getBundle(), 'prior');
  assert.equal(h.events.filter((event) => event[0] === 'publish').length, 1);

  h = harness();
  const disconnected = await h.service.disconnect(Object.freeze({
    clientSlug: 'wolfhouse-somo', deployment: 'staff-staging', locationId: 'wolfhouse-somo',
    endpointId: UUID, actorStaffUserId: UUID, clientId: CLIENT_UUID,
  }));
  assert.equal(disconnected.status, 'disconnected');
  assert.equal(h.events.some((event) => event[0] === 'kv-write'), false);

  assert.equal(sanitizeError(new Error('smtp-super-secret')).message, 'Email connection failed.');
  assert.match(routes.SQL_PROVE, /slug = 'wolfhouse-somo'/);
  assert.match(routes.SQL_LOCK, /pg_advisory_xact_lock/);
  assert.match(routes.SQL_CONNECTED, /LIMIT 1[\s\S]*FOR UPDATE/);
  assert.match(routes.SQL_SANITIZE_DUPLICATES, /id <> \$2::uuid/);
  assert.match(routes.SQL_SANITIZE_DUPLICATES, /secret_ref = NULL/);
  assert.match(routes.SQL_CONNECTED, /inbound_enabled = false/);
  assert.match(routes.SQL_CONNECTED, /outbound_enabled = false/);
  assert.match(routes.SQL_CONNECTED, /default_automation_mode = 'off'/);
  assert.match(routes.SQL_CONNECTED, /active = false/);
  assert.match(routes.SQL_DISCONNECTED, /id = \$2::uuid/);
  assert.equal(routes.hasExactOwnDataKeys({ location_id: 'wolfhouse-somo', endpoint_id: UUID }, ['location_id', 'endpoint_id']), true);
  assert.equal(routes.hasExactOwnDataKeys({ location_id: 'wolfhouse-somo', endpoint_id: UUID, extra: true }, ['location_id', 'endpoint_id']), false);
  assert.doesNotMatch(routes.SQL_PROVE + routes.SQL_CONNECTED + routes.SQL_DISCONNECTED, /sunset/i);

  const txEvents = [];
  const txStore = routes.createStore({ query: async (sql) => {
    txEvents.push(sql);
    if (sql === routes.SQL_PROVE) return { rows: [{ id: CLIENT_UUID }] };
    return { rows: [] };
  } });
  await assert.rejects(() => txStore.runExclusive({ clientId: CLIENT_UUID }, async () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(txEvents.slice(0, 3), ['BEGIN', routes.SQL_LOCK, routes.SQL_PROVE]);
  assert.equal(txEvents.at(-1), 'ROLLBACK');

  const fallbackEvents = [];
  const fallbackStore = routes.createStore({ query: async (sql) => {
    fallbackEvents.push(sql);
    if (sql === routes.SQL_PROVE) return { rows: [{ id: CLIENT_UUID }] };
    if (sql === routes.SQL_CONNECTED) return { rows: [] };
    if (sql === routes.SQL_INSERT_CONNECTED) return { rows: [{ id: UUID }] };
    return { rows: [] };
  } });
  const fallbackRow = await fallbackStore.runExclusive({ clientId: CLIENT_UUID }, (locked) => locked.publishConnected({
    clientId: CLIENT_UUID, publicAddress: input.publicAddress,
    secretRef: 'kv:wolfhouse-email-imap-smtp-credentials/fallback-version', actorStaffUserId: UUID,
  }));
  assert.equal(fallbackRow.endpointId, UUID);
  assert.ok(fallbackEvents.includes(routes.SQL_INSERT_CONNECTED));
  assert.ok(fallbackEvents.includes(routes.SQL_SANITIZE_DUPLICATES));
  assert.equal(fallbackEvents.at(-1), 'COMMIT');

  const routeEvents = [];
  const pg = { query: async (sql) => {
    routeEvents.push(['sql', sql]);
    if (sql === routes.SQL_PROVE) return { rows: [{ id: CLIENT_UUID }] };
    if (sql === routes.SQL_CONNECTED) return { rows: [{ id: UUID }] };
    return { rows: [] };
  } };
  let response = null;
  const routeOwner = routes.createStaffWolfhouseEmailConnectRoutes({
    env: {},
    withPgClient: async (fn) => fn(pg),
    sendJSON: (_res, status, body) => { response = { status, body }; return true; },
    assertStaffClientAccess: () => true,
    authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
    kv: { writeBundle: async () => 'kv:wolfhouse-email-imap-smtp-credentials/route-version' },
    createSmtpTransport: () => ({ verifySession: async (credentials) => {
      assert.equal(credentials.connectHost, '8.8.8.8'); return { ok: true };
    } }),
    createImapTransport: () => ({ verifySession: async (credentials) => {
      assert.equal(credentials.connectHost, '8.8.8.8'); return { ok: true };
    } }),
    resolveHost: async () => '8.8.8.8',
  });
  await routeOwner.handleConnect({
    location_id: 'wolfhouse-somo', public_address: input.publicAddress,
    smtp: input.smtp, imap: input.imap,
  }, {}, {}, { role: 'admin', client_slug: 'wolfhouse-somo', client_id: CLIENT_UUID, staff_user_id: UUID });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'connected');
  assert.equal(JSON.stringify(response).includes('super-secret'), false);
  assert.ok(routeEvents.findIndex((event) => event[1] === routes.SQL_LOCK)
    < routeEvents.findIndex((event) => event[1] === routes.SQL_CONNECTED));

  console.log('verify-wolfhouse-email-connect-smtp-001: PASS (gates, SSRF pinning, real auth, versioned KV, serialized publish, redaction, disconnect, send-off SQL)');
})().catch((error) => {
  console.error('verify-wolfhouse-email-connect-smtp-001: FAIL', error.message);
  process.exit(1);
});

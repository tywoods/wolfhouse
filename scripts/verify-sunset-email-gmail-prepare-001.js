'use strict';

/**
 * EMAIL-GMAIL-PREPARE-001 — Adapt the loaned PoolClient at the Gmail prepare
 * integration boundary. pinQuery stays strict (own-data query, no connect /
 * pool stats). Production wiring must wrap the genuine loan as an exact frozen
 * query-only facade so filled-address prepare is not 503 from pinQuery.
 *
 * Existing gmail_api rows for the same location or address fail closed. Do not
 * delete or overwrite Microsoft or Gmail endpoints. Frozen input DTO and
 * one-shot prepare stay. Auto-send and prior stay-offs stay off.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const owner = require('./lib/staff-google-oauth-production-integration');
const prepareOwner = require('./lib/email-sunset-google-endpoint-prepare');

const CLIENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ACTOR = 'abcdef01-2345-4678-89ab-cdef01234567';
const ENDPOINT = '11111111-2222-4333-8444-555555555555';
const EXISTING = '99999999-8888-4777-8666-555555555555';
const MICROSOFT = '22222222-2222-4222-8222-222222222222';
const LOCATION = 'sunset-somo';
const ADDRESS = 'desk@gmail.example';

const apiSrc = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
const integrationSrc = fs.readFileSync(require.resolve('./lib/staff-google-oauth-production-integration.js'), 'utf8');
const prepareSrc = fs.readFileSync(require.resolve('./lib/email-sunset-google-endpoint-prepare.js'), 'utf8');
const uiSrc = fs.readFileSync(path.join(__dirname, 'browser/sunset-admin-email-settings-ui.js'), 'utf8');

assert.match(
  apiSrc,
  /createEndpointPrepare:\s*pg\s*=>\s*createSunsetGoogleEndpointPrepare\(\s*Object\.freeze\(\{\s*client:\s*Object\.freeze\(\{\s*query:\s*pg\.query\.bind\(pg\)\s*\}\)\s*\}\)\s*\)/,
  'staff-query-api must wrap the loan as a frozen query-only facade before pinQuery',
);
assert.match(apiSrc, /Object\.freeze\(\{\s*query:\s*pg\.query\.bind\(pg\)\s*\}\)/);
assert.doesNotMatch(
  apiSrc,
  /createEndpointPrepare:\s*pg\s*=>\s*createSunsetGoogleEndpointPrepare\(Object\.freeze\(\{client:pg\}\)\)/,
  'raw PoolClient must not be passed as {client:pg}',
);
assert.match(
  integrationSrc,
  /(?:Object\.freeze|objectFreeze)\(\{\s*query:\s*pg\.query\.bind\(pg\)\s*\}\)/,
  'production integration must adapt the loaned client at the boundary',
);
assert.match(prepareSrc, /if \(typeof client\.connect === 'function' \|\| \['totalCount', 'idleCount', 'waitingCount'\]\.some/);
assert.match(prepareSrc, /return descriptor\.value\.bind\(client\);/);

function RealisticPoolClient(options = {}) {
  this.calls = [];
  this.deleted = [];
  this.connect = function connect() { this.connected = true; return this; };
  this.totalCount = 1;
  this.idleCount = 0;
  this.waitingCount = 0;
  this.release = function release() { this.released = true; };
  this._sameLocation = options.sameLocation === true;
  this._sameAddress = options.sameAddress === true;
}
RealisticPoolClient.prototype.query = async function query(sql, params) {
  this.calls.push({ sql: String(sql), params: params && params.slice(), receiver: this });
  if (/\bDELETE\b/i.test(sql)) this.deleted.push(String(sql));
  if (/FROM clients/.test(sql)) return { command: 'SELECT', rowCount: 1, rows: [{ client_id: CLIENT }] };
  if (/FROM tenant_locations/.test(sql)) return { rowCount: 1, rows: [{ location_id: LOCATION }] };
  if (sql === prepareOwner.SQL_EXISTING_BY_LOCATION) {
    return { rows: this._sameLocation ? [{ id: EXISTING }] : [] };
  }
  if (sql === prepareOwner.SQL_EXISTING_BY_ADDRESS) {
    return { rows: this._sameAddress ? [{ id: EXISTING }] : [] };
  }
  if (/INSERT INTO/.test(sql)) return { command: 'INSERT', rowCount: 1, rows: [{ id: ENDPOINT }] };
  return { command: String(sql).split(' ')[0], rows: [] };
};

function naiveCreateEndpointPrepare(pg) {
  return prepareOwner.createSunsetGoogleEndpointPrepare(Object.freeze({ client: pg }));
}

function productionCreateEndpointPrepare(pg) {
  return prepareOwner.createSunsetGoogleEndpointPrepare(Object.freeze({
    client: Object.freeze({ query: pg.query.bind(pg) }),
  }));
}

function enabledEnv() {
  return Object.freeze({
    LUNA_DEPLOYMENT: 'sunset-staging',
    LUNA_EMAIL_GOOGLE_OAUTH_ENDPOINT_ENABLED: 'true',
  });
}

async function dispatchPrepare(options = {}) {
  const replies = [];
  const received = [];
  const loan = options.loan || new RealisticPoolClient(options);
  const create = options.createEndpointPrepare || naiveCreateEndpointPrepare;
  const adapter = owner.createStaffGoogleOAuthProductionIntegration(Object.freeze({
    env: enabledEnv(),
    sendJSON(_res, status, body) { replies.push({ status, body }); },
    sendHTML() { throw new Error('html'); },
    async requireAdmin() {
      return { ok: true, user: Object.freeze({ client_id: CLIENT, staff_user_id: ACTOR, client_slug: 'sunset' }) };
    },
    assertStaffClientAccess() { return true; },
    authorizeAuthenticatedStaffRoute() { return { ok: true }; },
    async readBody() {
      return JSON.stringify({ location_id: LOCATION, public_address: options.address || ADDRESS });
    },
    withPgClient(fn) { return fn(loan); },
    createEndpointPrepare(pg) {
      received.push(pg);
      return create(pg);
    },
  }));
  const req = {
    method: 'POST',
    url: owner.GOOGLE_ENDPOINT_PATH,
    headers: { 'content-type': 'application/json' },
  };
  await adapter.dispatch(req, {}, owner.GOOGLE_ENDPOINT_PATH);
  return { replies, received, loan };
}

function assertQueryOnlyFacade(facade, loan) {
  assert.equal(Object.getPrototypeOf(facade), Object.prototype);
  assert.equal(Object.isFrozen(facade), true);
  assert.deepEqual(Reflect.ownKeys(facade), ['query']);
  const descriptor = Object.getOwnPropertyDescriptor(facade, 'query');
  assert.equal(typeof descriptor.value, 'function');
  assert.equal(Object.hasOwn(descriptor, 'value'), true);
  assert.equal(typeof facade.connect, 'undefined');
  assert.equal('connect' in facade, false);
  assert.equal('totalCount' in facade, false);
  assert.equal('idleCount' in facade, false);
  assert.equal('waitingCount' in facade, false);
  assert.notEqual(facade, loan);
}

function assertNoMutation(loan) {
  assert.equal(loan.deleted.length, 0);
  assert.equal(loan.calls.some((c) => /^\s*DELETE\b/i.test(c.sql)), false);
  assert.equal(loan.calls.some((c) => /^\s*UPDATE\b/i.test(c.sql)), false);
  assert.equal(loan.calls.some((c) => /microsoft_graph/.test(c.sql)), false);
  assert.equal(loan.calls.some((c) => c.sql.includes(MICROSOFT)), false);
}

(async () => {
  assert.throws(
    () => naiveCreateEndpointPrepare(new RealisticPoolClient()),
    (error) => error && error.code === prepareOwner.ERROR_CODE,
    'pinQuery must keep rejecting a realistic PoolClient',
  );

  {
    const { replies, received, loan } = await dispatchPrepare();
    assert.equal(received.length, 1, 'production integration must hand the adapted loan to createEndpointPrepare');
    assertQueryOnlyFacade(received[0], loan);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].status, 200, 'filled-address prepare must not 503 from pinQuery');
    assert.notEqual(replies[0].body && replies[0].body.error, 'endpoint_prepare_unavailable');
    assert.equal(replies[0].body.success, true);
    assert.equal(replies[0].body.endpoint_id, ENDPOINT);
    assert.equal(Object.isFrozen(replies[0].body), true);
    assert.deepEqual(Reflect.ownKeys(replies[0].body), ['success', 'endpoint_id']);
    assert.equal(loan.calls.some((c) => /INSERT INTO/.test(c.sql)), true);
    assert.ok(loan.calls.every((c) => c.receiver === loan), 'query must stay bound to the genuine loan');
    assertNoMutation(loan);
    assert.match(prepareOwner.SQL_INSERT_ENDPOINT, /false, false, 'off', false/);
  }

  {
    const { replies, received, loan } = await dispatchPrepare({
      createEndpointPrepare: productionCreateEndpointPrepare,
    });
    assertQueryOnlyFacade(received[0], loan);
    assert.equal(replies[0].status, 200);
    assert.equal(replies[0].body.endpoint_id, ENDPOINT);
    assert.ok(loan.calls.every((c) => c.receiver === loan));
  }

  for (const option of ['sameLocation', 'sameAddress']) {
    const { replies, loan } = await dispatchPrepare({ [option]: true });
    assert.equal(replies[0].status, 503);
    assert.equal(replies[0].body.error, 'endpoint_prepare_unavailable');
    assert.equal(loan.calls.some((c) => /INSERT INTO/.test(c.sql)), false);
    assert.equal(loan.calls.at(-1).sql, 'ROLLBACK');
    assertNoMutation(loan);
  }

  {
    const loan = new RealisticPoolClient();
    const service = productionCreateEndpointPrepare(loan);
    const input = Object.freeze({
      clientId: CLIENT,
      locationId: LOCATION,
      publicAddress: ADDRESS,
      actorStaffUserId: ACTOR,
    });
    const ack = await service.prepareDisabledDelegatedEndpoint(input);
    assert.deepEqual(ack, { endpointId: ENDPOINT });
    assert.equal(Object.isFrozen(ack), true);
    await assert.rejects(
      () => service.prepareDisabledDelegatedEndpoint(input),
      (error) => error && error.code === prepareOwner.ERROR_CODE,
    );
    assert.equal(loan.calls.filter((c) => c.sql === 'COMMIT').length, 1);
  }

  assert.doesNotMatch(apiSrc, /LUNA_AUTO_SEND_ENABLED\s*=\s*['"]true['"]/);
  assert.doesNotMatch(integrationSrc, /LUNA_AUTO_SEND_ENABLED\s*=\s*['"]true['"]/);
  assert.doesNotMatch(prepareSrc, /LUNA_AUTO_SEND_ENABLED/);
  assert.doesNotMatch(uiSrc, /inbox-thread/);
  assert.doesNotMatch(uiSrc, /provider_actions\.gmail_api\s*=\s*\{[^}]*disconnect:\s*true/);
  assert.doesNotMatch(prepareSrc, /^\s*DELETE\b/m);
  assert.match(prepareSrc, /provider = 'gmail_api'/);
  assert.match(prepareOwner.SQL_EXISTING_BY_LOCATION, /provider = 'gmail_api'/);
  assert.match(prepareOwner.SQL_EXISTING_BY_ADDRESS, /provider = 'gmail_api'/);
  assert.doesNotMatch(uiSrc, /console\.log\(dto\.authorizationUrl\)/);

  console.log('PASS EMAIL-GMAIL-PREPARE-001 PoolClient prepare boundary');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});

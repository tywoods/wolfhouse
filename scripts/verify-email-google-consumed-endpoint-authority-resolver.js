'use strict';
const assert = require('node:assert/strict');
const utilTypes = require('node:util').types;
// Authentic RED: this production owner is intentionally absent in the RED commit.
const { createGoogleConsumedEndpointAuthorityResolver } = require('./lib/email-google-consumed-endpoint-authority-resolver');

const freeze = Object.freeze;
const CLIENT_A = 'a1111111-bbbb-4ccc-8ddd-eeeeeeeeeee1';
const CLIENT_B = 'b2222222-bbbb-4ccc-8ddd-eeeeeeeeeee2';
const LOCATION_A = 'c3333333-bbbb-4ccc-8ddd-eeeeeeeeeee3';
const LOCATION_B = 'd4444444-bbbb-4ccc-8ddd-eeeeeeeeeee4';
const ENDPOINT_A = 'e5555555-bbbb-4ccc-8ddd-eeeeeeeeeee5';
const ENDPOINT_B = 'f6666666-bbbb-4ccc-8ddd-eeeeeeeeeee6';
const REF_A = 'kv:email/google/client-a';
const REF_B = 'secret-ref:email/google/client-b';
const FAILURE = 'GOOGLE_CONSUMED_ENDPOINT_AUTHORITY_FAILED';
const SQL = `SELECT id, client_id, location_id, channel, provider, secret_ref, active
       FROM tenant_channel_endpoints
      WHERE id = $1
        AND client_id = $2
        AND location_id = $3
        AND provider = 'gmail_api'
        AND channel = 'email'
        AND active = TRUE`;
const input = (patch = {}) => freeze({
  tenantSlug: 'sunset', clientId: CLIENT_A, locationKey: 'sunset-somo',
  locationId: LOCATION_A, endpointId: ENDPOINT_A, ...patch,
});
const row = (patch = {}) => freeze({
  id: ENDPOINT_A, client_id: CLIENT_A, location_id: LOCATION_A,
  channel: 'email', provider: 'gmail_api', secret_ref: REF_A, active: true, ...patch,
});
const wrapper = (rows) => freeze({ rows: freeze(rows) });
function db(result, behavior) {
  const calls = [];
  const owner = freeze({
    query(text, params) {
      assert.equal(this, owner);
      calls.push([text, params]);
      if (behavior) return behavior();
      return Promise.resolve(result);
    },
  });
  return { owner, calls };
}
function clean(error) {
  assert.equal(error.code, FAILURE);
  assert.equal(error.stack, undefined);
  assert.equal(Object.isFrozen(error), true);
  const rendered = `${error}${JSON.stringify(error)}${error.stack || ''}`;
  for (const value of [REF_A, REF_B, 'HOSTILE_PRIVATE_SECRET', ENDPOINT_A]) {
    assert.equal(rendered.includes(value), false);
  }
  return true;
}
async function rejects(action) { await assert.rejects(action, clean); }
async function main() {
  assert.deepEqual(Reflect.ownKeys(require('./lib/email-google-consumed-endpoint-authority-resolver')),
    ['createGoogleConsumedEndpointAuthorityResolver']);

  for (const tuple of [
    [CLIENT_A, LOCATION_A, ENDPOINT_A, REF_A],
    [CLIENT_B, LOCATION_B, ENDPOINT_B, REF_B],
  ]) {
    const [clientId, locationId, endpointId, secretRef] = tuple;
    const fixture = db(wrapper([row({ id: endpointId, client_id: clientId, location_id: locationId, secret_ref: secretRef })]));
    const owner = createGoogleConsumedEndpointAuthorityResolver(freeze({ db: fixture.owner }));
    assert.deepEqual(Reflect.ownKeys(owner), ['resolveConsumedEndpointAuthority']);
    assert.equal(Object.isFrozen(owner), true);
    const ack = await owner.resolveConsumedEndpointAuthority(input({ clientId, locationId, endpointId }));
    assert.deepEqual(ack, freeze({ tenantSlug: 'sunset', clientId, locationKey: 'sunset-somo', locationId, endpointId, secretRef }));
    assert.deepEqual(Reflect.ownKeys(ack), ['tenantSlug', 'clientId', 'locationKey', 'locationId', 'endpointId', 'secretRef']);
    assert.equal(Object.isFrozen(ack), true);
    assert.deepEqual(fixture.calls, [[SQL, [endpointId, clientId, locationId]]]);
  }

  const malformedInputs = [
    {}, { ...input() }, freeze({ ...input(), extra: true }),
    freeze({ clientId: CLIENT_A, tenantSlug: 'sunset', locationKey: 'sunset-somo', locationId: LOCATION_A, endpointId: ENDPOINT_A }),
    freeze(Object.create(null, Object.getOwnPropertyDescriptors(input()))),
    freeze(Object.defineProperty({ ...input() }, 'clientId', { get: () => CLIENT_A, enumerable: true })),
    new Proxy(input(), {}), input({ tenantSlug: 'other' }), input({ locationKey: 'other' }),
    input({ clientId: CLIENT_A.toUpperCase() }), input({ endpointId: 'not-a-uuid' }),
  ];
  for (const bad of malformedInputs) {
    const fixture = db(wrapper([row()]));
    let owner;
    try { owner = createGoogleConsumedEndpointAuthorityResolver(freeze({ db: fixture.owner })); } catch (error) { assert.fail(error); }
    await rejects(() => owner.resolveConsumedEndpointAuthority(bad));
    assert.equal(fixture.calls.length, 0);
  }

  const badRows = [
    wrapper([]), wrapper([row(), row()]), {}, freeze({ rows: [row()] }),
    freeze({ rows: freeze([new Proxy(row(), {})]) }), freeze({ rows: freeze([{ ...row() }]) }),
    wrapper([row({ id: ENDPOINT_B })]), wrapper([row({ client_id: CLIENT_B })]),
    wrapper([row({ location_id: LOCATION_B })]), wrapper([row({ provider: 'microsoft_graph' })]),
    wrapper([row({ channel: 'sms' })]), wrapper([row({ active: false })]),
    wrapper([row({ secret_ref: null })]), wrapper([row({ secret_ref: 'raw-secret' })]),
    wrapper([row({ secret_ref: 'kv:sk-123456789012345' })]),
  ];
  for (const result of badRows) {
    const fixture = db(result);
    const owner = createGoogleConsumedEndpointAuthorityResolver(freeze({ db: fixture.owner }));
    await rejects(() => owner.resolveConsumedEndpointAuthority(input()));
  }

  for (const behavior of [
    () => { throw new Error('HOSTILE_PRIVATE_SECRET'); },
    () => Promise.reject(new Error('HOSTILE_PRIVATE_SECRET')),
    () => ({ then() { throw new Error('HOSTILE_PRIVATE_SECRET'); } }),
    () => new Proxy(Promise.resolve(wrapper([row()])), {}),
  ]) {
    const fixture = db(undefined, behavior);
    const owner = createGoogleConsumedEndpointAuthorityResolver(freeze({ db: fixture.owner }));
    await rejects(() => owner.resolveConsumedEndpointAuthority(input()));
  }

  for (const dependency of [
    {}, freeze({ db: { query() {} } }), freeze({ db: new Proxy(freeze({ query() {} }), {}) }),
    freeze({ db: freeze({ query: new Proxy(() => {}, {}) }) }), freeze({ db: fixtureDbWithExtra() }),
  ]) assert.throws(() => createGoogleConsumedEndpointAuthorityResolver(dependency), clean);

  console.log('email google consumed endpoint authority resolver verifier: PASS');
}
function fixtureDbWithExtra() { return freeze({ query() {}, extra: true }); }
main().catch((error) => { console.error(error); process.exitCode = 1; });

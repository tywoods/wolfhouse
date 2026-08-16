'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const utilTypes = require('node:util').types;
const O = Object;
const R = Reflect;
const pinned = Object.freeze({
  freeze: O.freeze, isFrozen: O.isFrozen, isExtensible: O.isExtensible, getPrototypeOf: O.getPrototypeOf,
  getOwnPropertyDescriptor: O.getOwnPropertyDescriptor, getOwnPropertyDescriptors: O.getOwnPropertyDescriptors,
  hasOwn: O.hasOwn, ownKeys: R.ownKeys, apply: R.apply, regexpTest: RegExp.prototype.test,
  isProxy: utilTypes.isProxy, isPromise: utilTypes.isPromise, then: Promise.prototype.then,
});
const { createGoogleConsumedEndpointAuthorityResolver } = require('./lib/email-google-consumed-endpoint-authority-resolver');
const freeze = pinned.freeze;
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
const input = (patch = {}) => freeze({ tenantSlug: 'sunset', clientId: CLIENT_A,
  locationKey: 'sunset-somo', locationId: LOCATION_A, endpointId: ENDPOINT_A, ...patch });
const row = (patch = {}) => freeze({ id: ENDPOINT_A, client_id: CLIENT_A,
  location_id: LOCATION_A, channel: 'email', provider: 'gmail_api', secret_ref: REF_A,
  active: true, ...patch });
const wrapper = (rows) => freeze({ rows: freeze(rows) });
function db(result, behavior) {
  const calls = [];
  const owner = freeze({ query(text, params) {
    assert.equal(this, owner); calls.push([text, params]);
    return behavior ? behavior() : Promise.resolve(result);
  } });
  return { owner, calls };
}
function clean(error) {
  assert.deepEqual(pinned.ownKeys(error), ['stack', 'message', 'name', 'code']);
  assert.equal(error.name, 'GoogleConsumedEndpointAuthorityError');
  assert.equal(error.message, FAILURE); assert.equal(error.code, FAILURE);
  assert.equal(error.stack, undefined); assert.equal(pinned.isFrozen(error), true);
  const expected = {
    stack: { value: undefined, writable: false, enumerable: false, configurable: false },
    message: { value: FAILURE, writable: false, enumerable: false, configurable: false },
    name: { value: 'GoogleConsumedEndpointAuthorityError', writable: false, enumerable: false, configurable: false },
    code: { value: FAILURE, writable: false, enumerable: true, configurable: false },
  };
  for (const key of pinned.ownKeys(expected)) assert.deepEqual(pinned.getOwnPropertyDescriptor(error, key), expected[key]);
  const rendered = `${error}${JSON.stringify(error)}${error.stack || ''}`;
  for (const value of [REF_A, REF_B, 'HOSTILE_PRIVATE_SECRET', ENDPOINT_A]) assert.equal(rendered.includes(value), false);
  return true;
}
async function rejects(action) { await assert.rejects(action, clean); }
function defineFrozen(properties, prototype = O.prototype) {
  return freeze(O.create(prototype, properties));
}
function reordered(source, order) {
  const descriptors = pinned.getOwnPropertyDescriptors(source);
  return defineFrozen(O.fromEntries(order.map((key) => [key, descriptors[key]])));
}
function hostileProxy(target = {}) {
  let reads = 0;
  const proxy = new Proxy(target, new Proxy({}, { get() { reads += 1; throw new Error('HOSTILE_PRIVATE_SECRET'); } }));
  return { proxy, reads: () => reads };
}
async function expectBadResult(result) {
  const fixture = db(result); const owner = createGoogleConsumedEndpointAuthorityResolver(freeze({ db: fixture.owner }));
  await rejects(() => owner.resolveConsumedEndpointAuthority(input()));
}
async function expectBadPending(factory) {
  const fixture = db(undefined, factory); const owner = createGoogleConsumedEndpointAuthorityResolver(freeze({ db: fixture.owner }));
  await rejects(() => owner.resolveConsumedEndpointAuthority(input()));
}
async function main() {
  assert.deepEqual(pinned.ownKeys(require('./lib/email-google-consumed-endpoint-authority-resolver')),
    ['createGoogleConsumedEndpointAuthorityResolver']);
  for (const [clientId, locationId, endpointId, secretRef] of [
    [CLIENT_A, LOCATION_A, ENDPOINT_A, REF_A], [CLIENT_B, LOCATION_B, ENDPOINT_B, REF_B],
  ]) {
    const fixture = db(wrapper([row({ id: endpointId, client_id: clientId, location_id: locationId, secret_ref: secretRef })]));
    const owner = createGoogleConsumedEndpointAuthorityResolver(freeze({ db: fixture.owner }));
    assert.deepEqual(pinned.ownKeys(owner), ['resolveConsumedEndpointAuthority']); assert.equal(pinned.isFrozen(owner), true);
    const ack = await owner.resolveConsumedEndpointAuthority(input({ clientId, locationId, endpointId }));
    assert.deepEqual(ack, freeze({ tenantSlug: 'sunset', clientId, locationKey: 'sunset-somo', locationId, endpointId, secretRef }));
    assert.deepEqual(pinned.ownKeys(ack), ['tenantSlug', 'clientId', 'locationKey', 'locationId', 'endpointId', 'secretRef']);
    assert.equal(pinned.isFrozen(ack), true); assert.deepEqual(fixture.calls, [[SQL, [endpointId, clientId, locationId]]]);
  }
  const inputKeys = ['tenantSlug', 'clientId', 'locationKey', 'locationId', 'endpointId'];
  const malformedInputs = [
    {}, { ...input() }, freeze({ ...input(), extra: true }),
    reordered(input(), [...inputKeys].reverse()), defineFrozen(pinned.getOwnPropertyDescriptors(input()), null),
    freeze(O.defineProperty({ ...input() }, 'clientId', { get: () => CLIENT_A, enumerable: true })),
    freeze({ ...input(), [Symbol('hostile')]: true }), new Proxy(input(), {}),
    input({ tenantSlug: 'other' }), input({ locationKey: 'other' }),
    input({ clientId: CLIENT_A.toUpperCase() }), input({ endpointId: 'not-a-uuid' }),
  ];
  for (const bad of malformedInputs) {
    const fixture = db(wrapper([row()])); const owner = createGoogleConsumedEndpointAuthorityResolver(freeze({ db: fixture.owner }));
    await rejects(() => owner.resolveConsumedEndpointAuthority(bad)); assert.equal(fixture.calls.length, 0);
  }
  const wrapperAccessor = freeze(O.defineProperty({}, 'rows', { get: () => freeze([row()]), enumerable: true }));
  const wrapperSymbol = freeze({ rows: freeze([row()]), [Symbol('x')]: 1 });
  // A one-key wrapper has no distinct reordered form; extra-key order is covered by wrapperSymbol.
  // Result envelopes may have any prototype; only own data metadata is trusted.
  const rowKeys = ['id', 'client_id', 'location_id', 'channel', 'provider', 'secret_ref', 'active'];
  const rowAccessor = freeze(O.defineProperty({ ...row() }, 'secret_ref', { get: () => REF_A, enumerable: true }));
  const rowSymbol = freeze({ ...row(), [Symbol('x')]: 1 });
  const rowReordered = reordered(row(), [...rowKeys].reverse());
  const rowProto = defineFrozen(pinned.getOwnPropertyDescriptors(row()), null);
  const sparse = []; sparse.length = 1; freeze(sparse);
  const arraySymbol = [row()]; arraySymbol[Symbol('x')] = 1; freeze(arraySymbol);
  const arrayAccessor = []; O.defineProperty(arrayAccessor, '0', { get: () => row(), enumerable: true }); freeze(arrayAccessor);
  const arrayProto = [row()]; O.setPrototypeOf(arrayProto, null); freeze(arrayProto);
  const badRows = [wrapper([]), wrapper([row(), row()]), {}, freeze({ rows: [row()] }),
    new Proxy(wrapper([row()]), {}), wrapperAccessor, wrapperSymbol,
    wrapper(sparse), wrapper(arraySymbol), wrapper(arrayAccessor), wrapper(arrayProto),
    wrapper([new Proxy(row(), {})]), wrapper([{ ...row() }]), wrapper([rowAccessor]), wrapper([rowSymbol]),
    wrapper([rowReordered]), wrapper([rowProto]), wrapper([row({ id: ENDPOINT_B })]),
    wrapper([row({ client_id: CLIENT_B })]), wrapper([row({ location_id: LOCATION_B })]),
    wrapper([row({ provider: 'microsoft_graph' })]), wrapper([row({ channel: 'sms' })]),
    wrapper([row({ active: false })]), wrapper([row({ secret_ref: null })]),
    wrapper([row({ secret_ref: 'raw-secret' })]),
  ];
  for (const result of badRows) await expectBadResult(result);
  class PromiseSubclass extends Promise {}
  const crossRealmPromise = vm.runInNewContext('Promise.resolve(1)');
  let relevantTraps = 0;
  const transparentPromise = new Proxy(Promise.resolve(wrapper([row()])), {});
  const trappingPromise = new Proxy(Promise.resolve(wrapper([row()])), { getPrototypeOf() { relevantTraps += 1; return Promise.prototype; } });
  const unhandled = []; const listener = (reason) => unhandled.push(reason); process.on('unhandledRejection', listener);
  try {
    for (let index = 0; index < 20; index += 1) await expectBadPending(() => transparentPromise);
    await new Promise((resolve) => setImmediate(resolve)); assert.deepEqual(unhandled, []);
  } finally { process.removeListener('unhandledRejection', listener); }
  for (const behavior of [
    () => { throw new Error('HOSTILE_PRIVATE_SECRET'); },
    () => Promise.reject(new Error('HOSTILE_PRIVATE_SECRET')),
    () => ({ then() { throw new Error('HOSTILE_PRIVATE_SECRET'); } }),
    () => new PromiseSubclass((resolve) => resolve(wrapper([row()]))),
    () => crossRealmPromise, () => trappingPromise,
  ]) await expectBadPending(behavior);
  assert.equal(relevantTraps, 0);
  const thrownAccessor = {}; let getterReads = 0;
  O.defineProperty(thrownAccessor, 'stack', { get() { getterReads += 1; throw new Error('HOSTILE_PRIVATE_SECRET'); } });
  await expectBadPending(() => { throw thrownAccessor; }); assert.equal(getterReads, 0);
  const hostile = hostileProxy(); await expectBadPending(() => { throw hostile.proxy; }); assert.equal(hostile.reads(), 0);
  for (const dependency of [{}, freeze({ db: { query() {} } }),
    freeze({ db: new Proxy(freeze({ query() {} }), {}) }),
    freeze({ db: freeze({ query: new Proxy(() => {}, {}) }) }), freeze({ db: freeze({ query() {}, extra: true }) })])
    assert.throws(() => createGoogleConsumedEndpointAuthorityResolver(dependency), clean);
  const originals = [[O, 'freeze', pinned.freeze], [O, 'isFrozen', pinned.isFrozen],
    [O, 'isExtensible', pinned.isExtensible],
    [O, 'getPrototypeOf', pinned.getPrototypeOf], [O, 'getOwnPropertyDescriptor', pinned.getOwnPropertyDescriptor],
    [O, 'hasOwn', pinned.hasOwn], [R, 'apply', pinned.apply], [R, 'ownKeys', pinned.ownKeys],
    [RegExp.prototype, 'test', pinned.regexpTest], [utilTypes, 'isProxy', pinned.isProxy],
    [utilTypes, 'isPromise', pinned.isPromise], [Promise.prototype, 'then', pinned.then]];
  try {
    for (const [owner, key] of originals) owner[key] = () => { throw new Error(`poison:${key}`); };
    const fixture = db(wrapper([row()])); const owner = createGoogleConsumedEndpointAuthorityResolver(freeze({ db: fixture.owner }));
    const ack = await owner.resolveConsumedEndpointAuthority(input()); assert.equal(ack.secretRef, REF_A);
    await rejects(() => owner.resolveConsumedEndpointAuthority(freeze({ ...input(), extra: true })));
    await expectBadPending(() => new PromiseSubclass((resolve) => resolve(wrapper([row()]))));
  } finally { for (const [owner, key, original] of originals) owner[key] = original; }
  console.log('email google consumed endpoint authority resolver verifier: PASS');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

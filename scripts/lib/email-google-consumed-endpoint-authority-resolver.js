'use strict';
/** Schema-owned, unwired Google consumed-endpoint authority resolver. */
const utilTypes = require('node:util').types;
const apply = Reflect.apply;
const ownKeys = Reflect.ownKeys;
const freeze = Object.freeze;
const isFrozen = Object.isFrozen;
const getPrototypeOf = Object.getPrototypeOf;
const getDescriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const create = Object.create;
const defineProperty = Object.defineProperty;
const objectPrototype = Object.prototype;
const promisePrototype = Promise.prototype;
const promiseThen = Promise.prototype.then;
const arrayIsArray = Array.isArray;
const isProxy = utilTypes.isProxy;
const isPromise = utilTypes.isPromise;
const regexpTest = RegExp.prototype.test;
const stringIndexOf = String.prototype.indexOf;
const stringSlice = String.prototype.slice;
const stringToLowerCase = String.prototype.toLowerCase;
const ErrorConstructor = Error;
const INPUT_KEYS = freeze(['tenantSlug', 'clientId', 'locationKey', 'locationId', 'endpointId']);
const DEPENDENCY_KEYS = freeze(['db']);
const DB_KEYS = freeze(['query']);
const WRAPPER_KEYS = freeze(['rows']);
const ROW_KEYS = freeze(['id', 'client_id', 'location_id', 'channel', 'provider', 'secret_ref', 'active']);
const OWNER_KEYS = freeze(['resolveConsumedEndpointAuthority']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SECRET_BODY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/;
const FAILURE = 'GOOGLE_CONSUMED_ENDPOINT_AUTHORITY_FAILED';
const SQL = `SELECT id, client_id, location_id, channel, provider, secret_ref, active
       FROM tenant_channel_endpoints
      WHERE id = $1
        AND client_id = $2
        AND location_id = $3
        AND provider = 'gmail_api'
        AND channel = 'email'
        AND active = TRUE`;
function proxy(value) { return apply(isProxy, undefined, [value]); }
function test(pattern, value) { return apply(regexpTest, pattern, [value]); }
function failure() {
  const error = new ErrorConstructor(FAILURE);
  defineProperty(error, 'name', { value: 'GoogleConsumedEndpointAuthorityError' });
  defineProperty(error, 'code', { value: FAILURE, enumerable: true });
  defineProperty(error, 'stack', { value: undefined });
  return freeze(error);
}
function fail() { throw failure(); }
function snapshot(value, keys) {
  if (value === null || typeof value !== 'object' || proxy(value) || arrayIsArray(value)
      || apply(getPrototypeOf, Object, [value]) !== objectPrototype
      || !apply(isFrozen, Object, [value])) return null;
  const actual = apply(ownKeys, Reflect, [value]);
  if (actual.length !== keys.length) return null;
  const result = apply(create, Object, [null]);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (actual[index] !== key) return null;
    const descriptor = apply(getDescriptor, Object, [value, key]);
    if (!descriptor || !apply(hasOwn, Object, [descriptor, 'value']) || !descriptor.enumerable
        || descriptor.writable || descriptor.configurable) return null;
    result[key] = descriptor.value;
  }
  return result;
}
function nativePromise(value) {
  return value !== null && typeof value === 'object' && !proxy(value)
    && apply(getPrototypeOf, Object, [value]) === promisePrototype
    && apply(isPromise, undefined, [value]);
}
function validSecretRef(value) {
  if (typeof value !== 'string') return false;
  const colon = apply(stringIndexOf, value, [':']);
  if (colon < 1) return false;
  const rawScheme = apply(stringSlice, value, [0, colon]);
  const scheme = apply(stringToLowerCase, rawScheme, []);
  const body = apply(stringSlice, value, [colon + 1]);
  return rawScheme === scheme && (scheme === 'kv' || scheme === 'secret-ref')
    && test(SECRET_BODY, body)
    && !test(/^sk-[A-Za-z0-9]{10,}/, body)
    && !test(/^sk-ant-[A-Za-z0-9_-]{10,}/, body)
    && !test(/^Bearer(?:\s+|[._-])/i, body)
    && !test(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, body)
    && !test(/password\s*=/i, body) && !test(/^password[-_]/i, body)
    && !test(/client_secret\s*=/i, body) && !test(/api[_-]?key\s*=/i, body)
    && !test(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/, body)
    && !test(/^ya29\.[A-Za-z0-9._-]+/, body);
}
function frozenRows(value) {
  if (!arrayIsArray(value) || proxy(value) || !apply(isFrozen, Object, [value])
      || apply(getPrototypeOf, Object, [value]) !== Array.prototype) return null;
  const keys = apply(ownKeys, Reflect, [value]);
  if (keys.length !== value.length + 1 || keys[keys.length - 1] !== 'length') return null;
  const rows = [];
  for (let index = 0; index < value.length; index += 1) {
    if (keys[index] !== String(index)) return null;
    const descriptor = apply(getDescriptor, Object, [value, String(index)]);
    if (!descriptor || !apply(hasOwn, Object, [descriptor, 'value']) || descriptor.writable
        || descriptor.configurable || !descriptor.enumerable) return null;
    rows.push(descriptor.value);
  }
  return rows;
}
function createGoogleConsumedEndpointAuthorityResolver(dependencies) {
  try {
    const dependency = snapshot(dependencies, DEPENDENCY_KEYS);
    const db = dependency && snapshot(dependency.db, DB_KEYS);
    if (!db || typeof db.query !== 'function' || proxy(db.query)) fail();
    const receiver = dependency.db;
    const query = db.query;
    async function resolveConsumedEndpointAuthority(value) {
      try {
        const input = snapshot(value, INPUT_KEYS);
        if (!input || input.tenantSlug !== 'sunset' || input.locationKey !== 'sunset-somo'
            || !test(UUID, input.clientId) || !test(UUID, input.locationId)
            || !test(UUID, input.endpointId)) fail();
        const pending = apply(query, receiver, [SQL, [input.endpointId, input.clientId, input.locationId]]);
        if (!nativePromise(pending)) fail();
        const wrapper = await apply(promiseThen, pending, [(result) => result]);
        const wrapped = snapshot(wrapper, WRAPPER_KEYS);
        const rows = wrapped && frozenRows(wrapped.rows);
        if (!rows || rows.length !== 1) fail();
        const row = snapshot(rows[0], ROW_KEYS);
        if (!row || row.id !== input.endpointId || row.client_id !== input.clientId
            || row.location_id !== input.locationId || row.channel !== 'email'
            || row.provider !== 'gmail_api' || row.active !== true
            || !validSecretRef(row.secret_ref)) fail();
        return freeze({ tenantSlug: input.tenantSlug, clientId: input.clientId,
          locationKey: input.locationKey, locationId: input.locationId,
          endpointId: input.endpointId, secretRef: row.secret_ref });
      } catch (_) { fail(); }
    }
    freeze(resolveConsumedEndpointAuthority);
    return freeze({ resolveConsumedEndpointAuthority });
  } catch (_) { fail(); }
}
freeze(createGoogleConsumedEndpointAuthorityResolver);
module.exports = freeze({ createGoogleConsumedEndpointAuthorityResolver });

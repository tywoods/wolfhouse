'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4A.
 *
 * Dedicated Sunset producer + worker LOGIN connection pair. Code/config
 * only — does not create secrets, roles, or GRANT. Fail closed if either
 * DSN is absent, unparseable, uses a query string, shares identity with
 * the Staff API table-owner / app pool, or shares identity with the other
 * principal. Never SET ROLE. Errors and return values must not include
 * credentials. Pool close is bounded; idle errors are generic.
 */

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const runtimeIsProxy = require('node:util').types.isProxy.bind(undefined);
const {
  isProxySurface,
  ownData,
} = require('./email-luna-controlled-drafting-closed-data');

const objectCreate = Object.create;
const objectDefineProperty = Object.defineProperty;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const objectPrototype = Object.prototype;
const reflectOwnKeys = Reflect.ownKeys;
const arrayIsArray = Array.isArray;
const arrayIncludes = uncurryThis(Array.prototype.includes);
const stringTrim = uncurryThis(String.prototype.trim);
const stringToLowerCase = uncurryThis(String.prototype.toLowerCase);
const stringReplace = uncurryThis(String.prototype.replace);
const stringSlice = uncurryThis(String.prototype.slice);
const regexpTest = uncurryThis(RegExp.prototype.test);
const weakSetAdd = uncurryThis(WeakSet.prototype.add);
const weakSetHas = uncurryThis(WeakSet.prototype.has);
const nativeSetTimeout = setTimeout;

const AUTHENTIC_PAIRS = new WeakSet();
const AUTHENTIC_CONNECTIONS = new WeakSet();
const ENV_PRODUCER_DATABASE_URL = 'EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_DATABASE_URL';
const ENV_WORKER_DATABASE_URL = 'EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_DATABASE_URL';
const ENV_APP_DATABASE_URL = 'WOLFHOUSE_DATABASE_URL';
const ENV_DATABASE_URL = 'DATABASE_URL';
const ERROR_CODE = 'EMAIL_LUNA_CONTROLLED_DRAFTING_PRINCIPAL_CONNECTION_INVALID';
const CREATE_KEYS = objectFreeze(['env', 'appConnectionString']);
const DRAIN_KEYS = objectFreeze(['runtime', 'connection']);
const FORBIDDEN_INPUT_KEYS = objectFreeze([
  'password', 'secret', 'token', 'dsn', 'connectionString', 'roleName', 'setRole',
]);
const PRINCIPAL_DSN_QUERY_ALLOWLIST = objectFreeze([]);
const APP_UNPROVEN_QUERY_KEYS = objectFreeze([
  'passfile', 'sslcert', 'sslkey', 'sslrootcert', 'sslpassword', 'service',
  'options', 'session_authorization',
]);
const PRE_CONNECT_DISTINCTNESS_IS_NOT_LIVE_SESSION_PROOF = true;
const CLOSE_TIMEOUT_MS = 5000;
const STOP_DRAIN_TIMEOUT_MS = 5000;

function invalid() {
  const error = new Error('Email Luna controlled drafting principal connection failed.');
  error.code = ERROR_CODE;
  return error;
}

function freeze(value) {
  return objectFreeze(value);
}

function output(entries) {
  const value = objectCreate(null);
  for (let index = 0; index < entries.length; index += 1) {
    objectDefineProperty(value, entries[index][0], {
      value: entries[index][1], enumerable: true, writable: true, configurable: true,
    });
  }
  return freeze(value);
}

function safeOwnKeys(value) {
  try {
    return reflectOwnKeys(value);
  } catch (_) {
    throw invalid();
  }
}

function refuseForbiddenKeys(value) {
  const ownKeys = safeOwnKeys(value);
  for (let index = 0; index < ownKeys.length; index += 1) {
    if (arrayIncludes(FORBIDDEN_INPUT_KEYS, ownKeys[index])) throw invalid();
  }
}

function boundedAwait(promise, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = nativeSetTimeout(() => finish('timeout'), timeoutMs);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { clearTimeout(timer); } catch (_) { /* ignore */ }
      resolve(result);
    };
    Promise.resolve(promise).then(
      () => finish('ok'),
      () => finish('rejected'),
    );
  });
}

function collectQueryValues(url) {
  const lower = objectCreate(null);
  const exact = objectCreate(null);
  const exactCounts = objectCreate(null);
  try {
    const params = url.searchParams;
    if (!params || typeof params.entries !== 'function') {
      return { lower, exact, exactCounts };
    }
    for (const entry of params.entries()) {
      if (!entry || entry.length < 1) continue;
      const rawKey = entry[0];
      const rawValue = entry[1];
      if (typeof rawKey !== 'string') continue;
      const key = stringToLowerCase(rawKey);
      const value = typeof rawValue === 'string' ? rawValue : '';
      if (!lower[key]) lower[key] = [];
      lower[key].push(value);
      exact[rawKey] = value;
      exactCounts[rawKey] = (exactCounts[rawKey] || 0) + 1;
    }
  } catch (_) {
    return {
      lower: objectCreate(null),
      exact: objectCreate(null),
      exactCounts: objectCreate(null),
    };
  }
  return { lower, exact, exactCounts };
}

function dsnHasQueryMarker(text) {
  if (typeof text !== 'string') return false;
  const hashIndex = text.indexOf('#');
  const clipped = hashIndex === -1 ? text : stringSlice(text, 0, hashIndex);
  return clipped.indexOf('?') !== -1;
}

function principalQueryForbidden(url, query, rawText) {
  if (dsnHasQueryMarker(rawText)) return true;
  if (typeof url.search === 'string' && url.search !== '') return true;
  const lowerKeys = reflectOwnKeys(query.lower);
  for (let index = 0; index < lowerKeys.length; index += 1) {
    const key = lowerKeys[index];
    if (typeof key !== 'string' || !arrayIncludes(PRINCIPAL_DSN_QUERY_ALLOWLIST, key)) return true;
  }
  const exactKeys = reflectOwnKeys(query.exact);
  for (let index = 0; index < exactKeys.length; index += 1) {
    const key = exactKeys[index];
    if (typeof key !== 'string') return true;
    if (!arrayIncludes(PRINCIPAL_DSN_QUERY_ALLOWLIST, stringToLowerCase(key))) return true;
  }
  return false;
}

function appQueryUnproven(query) {
  for (let index = 0; index < APP_UNPROVEN_QUERY_KEYS.length; index += 1) {
    const key = APP_UNPROVEN_QUERY_KEYS[index];
    if (query.lower[key] && query.lower[key].length > 0) return true;
  }
  return false;
}

function unwrapIpv6Host(host) {
  if (typeof host !== 'string' || host.length < 2) return host;
  if (host.charAt(0) === '[' && host.charAt(host.length - 1) === ']') {
    return stringSlice(host, 1, host.length - 1);
  }
  return host;
}

function canonicalizeHost(host) {
  if (typeof host !== 'string') return '';
  const normalized = stringToLowerCase(stringTrim(unwrapIpv6Host(host)));
  if (normalized === 'localhost'
      || normalized === '127.0.0.1'
      || normalized === '::1'
      || normalized === '0:0:0:0:0:0:0:1'
      || normalized === '::ffff:127.0.0.1') {
    return 'loopback';
  }
  return normalized;
}

function canonicalizePort(port) {
  if (port == null || port === '') return '5432';
  const text = stringTrim(String(port));
  if (!regexpTest(/^[0-9]+$/, text)) return null;
  const parsed = Number.parseInt(text, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return null;
  return String(parsed);
}

function identityFromParts(user, host, port, database) {
  if (typeof user !== 'string' || typeof host !== 'string' || typeof database !== 'string') return null;
  const normalizedUser = stringToLowerCase(stringTrim(user));
  const normalizedHost = canonicalizeHost(host);
  const normalizedDatabase = stringToLowerCase(stringReplace(stringTrim(database), /\/+$/g, ''));
  const normalizedPort = canonicalizePort(port);
  if (!normalizedUser || !normalizedHost || !normalizedDatabase || !normalizedPort) return null;
  return freeze({
    user: normalizedUser,
    host: normalizedHost,
    port: normalizedPort,
    database: normalizedDatabase,
  });
}

function decodeUserinfo(raw) {
  if (typeof raw !== 'string' || raw === '') return '';
  try {
    return decodeURIComponent(raw);
  } catch (_) {
    return raw;
  }
}

function hasExactDuplicateKeys(exactCounts) {
  const keys = reflectOwnKeys(exactCounts);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key === 'string' && exactCounts[key] > 1) return true;
  }
  return false;
}

function parseDsnIdentities(raw, mode) {
  if (typeof raw !== 'string') {
    return { identities: [], invalid: raw != null };
  }
  const text = stringTrim(raw);
  if (!text) return { identities: [], invalid: false };
  try {
    const normalized = stringReplace(text, /^postgres(ql)?:/i, 'http:');
    const url = new URL(normalized);
    const query = collectQueryValues(url);
    const pathnameDatabase = stringReplace(stringTrim(url.pathname || ''), /^\//, '').split('?')[0];
    const urlUser = decodeUserinfo(url.username || '');
    const urlHost = url.hostname;
    const urlPort = url.port || '';
    if (mode === 'principal') {
      if (principalQueryForbidden(url, query, text)) return { identities: [], invalid: true };
      const identity = identityFromParts(urlUser, urlHost, urlPort, pathnameDatabase);
      if (!identity) return { identities: [], invalid: true };
      return { identities: [identity], invalid: false };
    }
    if (hasExactDuplicateKeys(query.exactCounts)) return { identities: [], invalid: true };
    if (appQueryUnproven(query)) return { identities: [], invalid: true };
    const pgUser = objectHasOwn(query.exact, 'user') ? decodeUserinfo(query.exact.user) : urlUser;
    const pgHost = objectHasOwn(query.exact, 'host') ? query.exact.host : urlHost;
    const pgPort = objectHasOwn(query.exact, 'port') && query.exact.port !== '' ? query.exact.port : urlPort;
    const identity = identityFromParts(pgUser, pgHost, pgPort, pathnameDatabase);
    if (!identity) return { identities: [], invalid: true };
    const identities = [identity];
    const urlIdentity = identityFromParts(urlUser, urlHost, urlPort, pathnameDatabase);
    if (urlIdentity && !sameLoginIdentity(urlIdentity, identity)) identities.push(urlIdentity);
    return { identities, invalid: false };
  } catch (_) {
    return { identities: [], invalid: true };
  }
}

function sameLoginIdentity(left, right) {
  return Boolean(left && right
    && left.user === right.user
    && left.host === right.host
    && left.port === right.port
    && left.database === right.database);
}

function collectAppIdentities(env, appConnectionString) {
  const identities = [];
  const seen = new Set();
  let unproven = false;
  const candidates = [
    ownData(env, ENV_APP_DATABASE_URL),
    ownData(env, ENV_DATABASE_URL),
    appConnectionString,
  ];
  for (let index = 0; index < candidates.length; index += 1) {
    const raw = candidates[index];
    if (typeof raw !== 'string' || stringTrim(raw) === '') continue;
    const parsed = parseDsnIdentities(raw, 'app');
    if (parsed.invalid || parsed.identities.length === 0) {
      unproven = true;
      continue;
    }
    for (let i = 0; i < parsed.identities.length; i += 1) {
      const identity = parsed.identities[i];
      const key = `${identity.user}@${identity.host}:${identity.port}/${identity.database}`;
      if (seen.has(key)) continue;
      seen.add(key);
      identities.push(identity);
    }
  }
  return { identities, unproven };
}

function parsePrincipal(raw) {
  if (typeof raw !== 'string' || stringTrim(raw) === '') {
    return { ok: false, reason: 'principal_connection_required' };
  }
  const parsed = parseDsnIdentities(raw, 'principal');
  if (parsed.invalid || parsed.identities.length !== 1) {
    return { ok: false, reason: 'principal_connection_invalid' };
  }
  return { ok: true, identity: parsed.identities[0] };
}

function resolveEmailLunaControlledDraftingPrincipalConnectionConfig(input) {
  if (arguments.length !== 1) throw invalid();
  if (!input || typeof input !== 'object' || runtimeIsProxy(input) || isProxySurface(input) || arrayIsArray(input)) {
    throw invalid();
  }
  if (objectGetPrototypeOf(input) !== objectPrototype) throw invalid();
  refuseForbiddenKeys(input);
  const own = safeOwnKeys(input);
  for (let index = 0; index < own.length; index += 1) {
    if (own[index] !== 'env' && own[index] !== 'appConnectionString') throw invalid();
  }
  const env = ownData(input, 'env');
  const appConnectionString = ownData(input, 'appConnectionString');
  if (appConnectionString !== undefined && typeof appConnectionString !== 'string') throw invalid();
  const producerParsed = parsePrincipal(ownData(env, ENV_PRODUCER_DATABASE_URL));
  const workerParsed = parsePrincipal(ownData(env, ENV_WORKER_DATABASE_URL));
  if (!producerParsed.ok || !workerParsed.ok) {
    return output([
      ['ok', false],
      ['configured', producerParsed.ok || workerParsed.ok],
      ['producer_distinct_from_app', false],
      ['worker_distinct_from_app', false],
      ['producer_distinct_from_worker', false],
      ['reason', !producerParsed.ok ? producerParsed.reason : workerParsed.reason],
    ]);
  }
  if (sameLoginIdentity(producerParsed.identity, workerParsed.identity)) {
    return output([
      ['ok', false],
      ['configured', true],
      ['producer_distinct_from_app', false],
      ['worker_distinct_from_app', false],
      ['producer_distinct_from_worker', false],
      ['reason', 'producer_worker_identity_collision'],
    ]);
  }
  const app = collectAppIdentities(env, appConnectionString);
  if (app.unproven || app.identities.length === 0) {
    return output([
      ['ok', false],
      ['configured', true],
      ['producer_distinct_from_app', false],
      ['worker_distinct_from_app', false],
      ['producer_distinct_from_worker', true],
      ['reason', 'app_connection_unproven'],
    ]);
  }
  let producerDistinct = true;
  let workerDistinct = true;
  for (let index = 0; index < app.identities.length; index += 1) {
    if (sameLoginIdentity(producerParsed.identity, app.identities[index])) producerDistinct = false;
    if (sameLoginIdentity(workerParsed.identity, app.identities[index])) workerDistinct = false;
  }
  if (!producerDistinct || !workerDistinct) {
    return output([
      ['ok', false],
      ['configured', true],
      ['producer_distinct_from_app', producerDistinct],
      ['worker_distinct_from_app', workerDistinct],
      ['producer_distinct_from_worker', true],
      ['reason', 'principal_connection_is_app_owner'],
    ]);
  }
  return output([
    ['ok', true],
    ['configured', true],
    ['producer_distinct_from_app', true],
    ['worker_distinct_from_app', true],
    ['producer_distinct_from_worker', true],
    ['reason', 'dedicated_producer_worker_logins'],
  ]);
}

function forceClosePool(pool) {
  try {
    if (!pool || typeof pool !== 'object' || runtimeIsProxy(pool)) return;
    const clients = pool._clients;
    if (!arrayIsArray(clients)) return;
    const snapshot = clients.slice();
    for (let index = 0; index < snapshot.length; index += 1) {
      const client = snapshot[index];
      try {
        if (typeof pool._remove === 'function') {
          pool._remove(client);
        } else if (client && typeof client.end === 'function' && !runtimeIsProxy(client.end)) {
          Promise.resolve(client.end()).then(() => {}, () => {});
        }
      } catch (_) {
        /* generic force-close */
      }
    }
  } catch (_) {
    /* generic force-close */
  }
}

async function closePool(pool, timeoutMs) {
  const ms = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : CLOSE_TIMEOUT_MS;
  const ended = Promise.resolve()
    .then(() => {
      if (!pool || typeof pool.end !== 'function' || runtimeIsProxy(pool.end)) return undefined;
      return pool.end();
    })
    .then(() => {}, () => {});
  const outcome = await boundedAwait(ended, ms);
  if (outcome === 'timeout') {
    forceClosePool(pool);
    return 'timeout';
  }
  return outcome === 'ok' ? 'ok' : 'rejected';
}

function attachIdleGuard(pool, recordFailure) {
  if (!pool || typeof pool !== 'object' || runtimeIsProxy(pool) || typeof pool.on !== 'function') {
    throw invalid();
  }
  if (typeof recordFailure !== 'function' || runtimeIsProxy(recordFailure)) throw invalid();
  try {
    pool.on('error', () => {
      try { recordFailure(); } catch (_) { /* idle errors must not crash */ }
    });
  } catch (_) {
    throw invalid();
  }
}

function createOneConnection(connectionString) {
  if (typeof connectionString !== 'string') throw invalid();
  let Pool;
  try {
    ({ Pool } = require('pg'));
  } catch (_) {
    throw invalid();
  }
  const pool = new Pool({
    connectionString,
    max: 1,
    allowExitOnIdle: true,
  });
  let closed = false;
  let idleFailure = false;
  attachIdleGuard(pool, () => { idleFailure = true; });

  async function withTransactionClient(work) {
    if (typeof work !== 'function' || runtimeIsProxy(work) || isProxySurface(work)) throw invalid();
    if (closed) throw invalid();
    let client;
    try {
      client = await pool.connect();
    } catch (_) {
      throw invalid();
    }
    try {
      try {
        await client.query('BEGIN');
      } catch (_) {
        throw invalid();
      }
      try {
        const result = await work(client);
        try {
          await client.query('COMMIT');
        } catch (_) {
          throw invalid();
        }
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) { /* already failed */ }
        throw error;
      }
    } finally {
      try { client.release(); } catch (_) { /* ignore */ }
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    await closePool(pool, CLOSE_TIMEOUT_MS);
  }

  const handle = freeze({
    withTransactionClient,
    close,
    getReadinessFailure: () => (idleFailure ? 'principal_pool_idle_error' : null),
  });
  weakSetAdd(AUTHENTIC_CONNECTIONS, handle);
  return handle;
}

function isAuthenticEmailLunaControlledDraftingPrincipalConnection(value) {
  try {
    return Boolean(value && typeof value === 'object' && weakSetHas(AUTHENTIC_CONNECTIONS, value));
  } catch (_) {
    return false;
  }
}

function isAuthenticEmailLunaControlledDraftingPrincipalConnectionPair(value) {
  try {
    return Boolean(value && typeof value === 'object' && weakSetHas(AUTHENTIC_PAIRS, value));
  } catch (_) {
    return false;
  }
}

function createEmailLunaControlledDraftingPrincipalConnectionPair(input) {
  if (arguments.length !== 1) throw invalid();
  const config = resolveEmailLunaControlledDraftingPrincipalConnectionConfig(input);
  if (!config || config.ok !== true) throw invalid();
  const env = ownData(input, 'env');
  const producer = createOneConnection(ownData(env, ENV_PRODUCER_DATABASE_URL));
  const worker = createOneConnection(ownData(env, ENV_WORKER_DATABASE_URL));
  async function close() {
    await producer.close();
    await worker.close();
  }
  const handle = freeze({
    producer,
    worker,
    close,
    getConfig: () => config,
  });
  weakSetAdd(AUTHENTIC_PAIRS, handle);
  return handle;
}

async function drainEmailLunaControlledDraftingRuntimePair(input) {
  try {
    if (input == null) return;
    if (typeof input !== 'object' || runtimeIsProxy(input) || arrayIsArray(input)) return;
    const proto = objectGetPrototypeOf(input);
    if (proto !== objectPrototype && proto !== null) return;
    let own;
    try { own = reflectOwnKeys(input); } catch (_) { return; }
    for (let index = 0; index < own.length; index += 1) {
      if (!arrayIncludes(DRAIN_KEYS, own[index])) return;
    }
    const runtime = ownData(input, 'runtime');
    const connection = ownData(input, 'connection');
    if (runtime && typeof runtime === 'object' && !runtimeIsProxy(runtime) && !arrayIsArray(runtime)) {
      const stop = ownData(runtime, 'stop');
      if (typeof stop === 'function' && !runtimeIsProxy(stop)) {
        await boundedAwait(
          Promise.resolve().then(() => stop.call(runtime)).then(() => {}, () => {}),
          STOP_DRAIN_TIMEOUT_MS,
        );
      }
    }
    if (connection && typeof connection === 'object' && !runtimeIsProxy(connection) && !arrayIsArray(connection)) {
      const close = ownData(connection, 'close');
      if (typeof close === 'function' && !runtimeIsProxy(close)) {
        await boundedAwait(
          Promise.resolve().then(() => close.call(connection)).then(() => {}, () => {}),
          CLOSE_TIMEOUT_MS,
        );
      }
    }
  } catch (_) {
    /* shutdown must not hang or leak */
  }
}

module.exports = objectFreeze({
  ENV_PRODUCER_DATABASE_URL,
  ENV_WORKER_DATABASE_URL,
  ERROR_CODE,
  CREATE_KEYS,
  PRE_CONNECT_DISTINCTNESS_IS_NOT_LIVE_SESSION_PROOF,
  CLOSE_TIMEOUT_MS,
  STOP_DRAIN_TIMEOUT_MS,
  resolveEmailLunaControlledDraftingPrincipalConnectionConfig,
  createEmailLunaControlledDraftingPrincipalConnectionPair,
  drainEmailLunaControlledDraftingRuntimePair,
  isAuthenticEmailLunaControlledDraftingPrincipalConnection,
  isAuthenticEmailLunaControlledDraftingPrincipalConnectionPair,
});

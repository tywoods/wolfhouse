'use strict';

/**
 * FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B6/B7: dedicated Sunset shadow-worker
 * DB connection contract. Code/config only — does not create secrets, roles,
 * or GRANT. Fail closed if the worker DSN is absent, unparseable, uses a
 * query/session role overlay, or the same login identity as the Staff API
 * table-owner / app pool. Pre-connect DSN comparison is not live session
 * verification. Never SET ROLE. Errors and return values must not include
 * credentials. Pool close is bounded; idle errors are generic and non-fatal.
 */

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const runtimeIsProxy = require('node:util').types.isProxy.bind(undefined);

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
const weakSetAdd = uncurryThis(WeakSet.prototype.add);
const weakSetHas = uncurryThis(WeakSet.prototype.has);
const nativeSetTimeout = setTimeout;

const AUTHENTIC_WORKER_CONNECTIONS = new WeakSet();
const ENV_WORKER_DATABASE_URL = 'EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL';
const ENV_APP_DATABASE_URL = 'WOLFHOUSE_DATABASE_URL';
const ENV_DATABASE_URL = 'DATABASE_URL';
const ERROR_CODE = 'EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_CONNECTION_INVALID';
const CREATE_KEYS = objectFreeze(['env', 'appConnectionString']);
const DRAIN_KEYS = objectFreeze(['runtime', 'connection']);
const FORBIDDEN_INPUT_KEYS = objectFreeze([
  'password', 'secret', 'token', 'dsn', 'connectionString', 'roleName', 'setRole',
]);
const OVERLAY_QUERY_KEYS = objectFreeze([
  'user',
  'username',
  'role',
  'options',
  'session_authorization',
]);
const PRE_CONNECT_DISTINCTNESS_IS_NOT_LIVE_SESSION_PROOF = true;
const EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_CONNECTION_CLOSE_TIMEOUT_MS = 5000;
const EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_STOP_DRAIN_TIMEOUT_MS = 5000;

function invalid() {
  const error = new Error('Email Luna automation shadow worker connection failed.');
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

function ownData(value, key) {
  try {
    if (!value || typeof value !== 'object' || runtimeIsProxy(value) || arrayIsArray(value)) return undefined;
    const descriptor = objectGetOwnPropertyDescriptor(value, key);
    if (!descriptor || !objectHasOwn(descriptor, 'value') || descriptor.get || descriptor.set) return undefined;
    return descriptor.value;
  } catch (_) {
    return undefined;
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
  const map = objectCreate(null);
  try {
    const params = url.searchParams;
    if (!params || typeof params.entries !== 'function') return map;
    for (const entry of params.entries()) {
      if (!entry || entry.length < 1) continue;
      const rawKey = entry[0];
      const rawValue = entry[1];
      if (typeof rawKey !== 'string') continue;
      const key = stringToLowerCase(rawKey);
      if (!map[key]) map[key] = [];
      map[key].push(typeof rawValue === 'string' ? rawValue : '');
    }
  } catch (_) {
    return objectCreate(null);
  }
  return map;
}

function hasOverlayQuery(queryMap) {
  for (let index = 0; index < OVERLAY_QUERY_KEYS.length; index += 1) {
    const key = OVERLAY_QUERY_KEYS[index];
    if (queryMap[key] && queryMap[key].length > 0) return true;
  }
  return false;
}

function identityFromParts(user, host, port, database) {
  if (typeof user !== 'string' || typeof host !== 'string' || typeof database !== 'string') return null;
  const normalizedUser = stringToLowerCase(stringTrim(user));
  const normalizedHost = stringToLowerCase(stringTrim(host));
  const normalizedDatabase = stringToLowerCase(stringReplace(stringTrim(database), /\/+$/g, ''));
  const normalizedPort = port ? stringTrim(port) : '5432';
  if (!normalizedUser || !normalizedHost || !normalizedDatabase) return null;
  return freeze({
    user: normalizedUser,
    host: normalizedHost,
    port: normalizedPort || '5432',
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

/**
 * Pre-connect DSN identity only. Not a substitute for live session_user /
 * current_user / mapping / EXECUTE verification on the dedicated client.
 */
function parseDsnIdentities(raw, mode) {
  if (typeof raw !== 'string') {
    return { identities: [], invalid: raw != null };
  }
  const text = stringTrim(raw);
  if (!text) return { identities: [], invalid: false };
  try {
    const normalized = stringReplace(text, /^postgres(ql)?:/i, 'http:');
    const url = new URL(normalized);
    const database = stringReplace(stringTrim(url.pathname || ''), /^\//, '').split('?')[0];
    const urlUser = decodeUserinfo(url.username || '');
    const host = url.hostname;
    const port = url.port || '5432';
    const queryMap = collectQueryValues(url);
    const overlay = hasOverlayQuery(queryMap);
    if (mode === 'worker') {
      if (overlay) return { identities: [], invalid: true };
      const identity = identityFromParts(urlUser, host, port, database);
      if (!identity) return { identities: [], invalid: true };
      return { identities: [identity], invalid: false };
    }
    const identities = [];
    const seen = new Set();
    const candidates = [urlUser];
    const queryUsers = [];
    if (queryMap.user) {
      for (let i = 0; i < queryMap.user.length; i += 1) queryUsers.push(queryMap.user[i]);
    }
    if (queryMap.username) {
      for (let i = 0; i < queryMap.username.length; i += 1) queryUsers.push(queryMap.username[i]);
    }
    if (queryMap.role) {
      for (let i = 0; i < queryMap.role.length; i += 1) queryUsers.push(queryMap.role[i]);
    }
    for (let i = 0; i < queryUsers.length; i += 1) candidates.push(decodeUserinfo(queryUsers[i]));
    if (queryMap.user && queryMap.user.length > 1) {
      return { identities: [], invalid: true };
    }
    if (queryMap.username && queryMap.username.length > 1) {
      return { identities: [], invalid: true };
    }
    if (queryMap.role && queryMap.role.length > 1) {
      return { identities: [], invalid: true };
    }
    for (let i = 0; i < candidates.length; i += 1) {
      const identity = identityFromParts(candidates[i], host, port, database);
      if (!identity) continue;
      const key = `${identity.user}@${identity.host}:${identity.port}/${identity.database}`;
      if (seen.has(key)) continue;
      seen.add(key);
      identities.push(identity);
    }
    if (!identities.length) return { identities: [], invalid: true };
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

function resolveEmailLunaAutomationShadowWorkerConnectionConfig(input) {
  if (arguments.length !== 1) throw invalid();
  if (!input || typeof input !== 'object' || runtimeIsProxy(input) || arrayIsArray(input)) throw invalid();
  if (objectGetPrototypeOf(input) !== objectPrototype) throw invalid();
  refuseForbiddenKeys(input);
  const env = ownData(input, 'env');
  const appConnectionString = ownData(input, 'appConnectionString');
  const own = safeOwnKeys(input);
  for (let index = 0; index < own.length; index += 1) {
    if (own[index] !== 'env' && own[index] !== 'appConnectionString') throw invalid();
  }
  if (appConnectionString !== undefined && typeof appConnectionString !== 'string') throw invalid();
  const workerRaw = ownData(env, ENV_WORKER_DATABASE_URL);
  if (typeof workerRaw !== 'string' || stringTrim(workerRaw) === '') {
    return output([
      ['ok', false],
      ['configured', false],
      ['distinct_from_app', false],
      ['reason', 'worker_connection_required'],
    ]);
  }
  const workerParsed = parseDsnIdentities(workerRaw, 'worker');
  if (workerParsed.invalid || workerParsed.identities.length !== 1) {
    return output([
      ['ok', false],
      ['configured', true],
      ['distinct_from_app', false],
      ['reason', 'worker_connection_invalid'],
    ]);
  }
  const workerIdentity = workerParsed.identities[0];
  const app = collectAppIdentities(env, appConnectionString);
  if (app.unproven || app.identities.length === 0) {
    return output([
      ['ok', false],
      ['configured', true],
      ['distinct_from_app', false],
      ['reason', 'app_connection_unproven'],
    ]);
  }
  for (let index = 0; index < app.identities.length; index += 1) {
    if (sameLoginIdentity(workerIdentity, app.identities[index])) {
      return output([
        ['ok', false],
        ['configured', true],
        ['distinct_from_app', false],
        ['reason', 'worker_connection_is_app_owner'],
      ]);
    }
  }
  return output([
    ['ok', true],
    ['configured', true],
    ['distinct_from_app', true],
    ['reason', 'dedicated_worker_connection'],
  ]);
}

function forceCloseShadowWorkerPool(pool) {
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

function attachEmailLunaAutomationShadowWorkerPoolIdleGuard(pool, recordFailure) {
  if (!pool || typeof pool !== 'object' || runtimeIsProxy(pool) || typeof pool.on !== 'function') {
    throw invalid();
  }
  if (typeof recordFailure !== 'function' || runtimeIsProxy(recordFailure)) throw invalid();
  try {
    pool.on('error', () => {
      try {
        recordFailure();
      } catch (_) {
        /* idle errors must not crash */
      }
    });
  } catch (_) {
    throw invalid();
  }
}

async function closeEmailLunaAutomationShadowWorkerPool(pool, timeoutMs) {
  const ms = Number.isInteger(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_CONNECTION_CLOSE_TIMEOUT_MS;
  const ended = Promise.resolve()
    .then(() => {
      if (!pool || typeof pool.end !== 'function' || runtimeIsProxy(pool.end)) return undefined;
      return pool.end();
    })
    .then(() => {}, () => {});
  const outcome = await boundedAwait(ended, ms);
  if (outcome === 'timeout') {
    forceCloseShadowWorkerPool(pool);
    return 'timeout';
  }
  return outcome === 'ok' ? 'ok' : 'rejected';
}

async function drainEmailLunaAutomationShadowRuntimePair(input) {
  try {
    if (input == null) return;
    if (typeof input !== 'object' || runtimeIsProxy(input) || arrayIsArray(input)) return;
    const proto = objectGetPrototypeOf(input);
    if (proto !== objectPrototype && proto !== null) return;
    let own;
    try {
      own = reflectOwnKeys(input);
    } catch (_) {
      return;
    }
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
          EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_STOP_DRAIN_TIMEOUT_MS,
        );
      }
    }
    if (connection && typeof connection === 'object' && !runtimeIsProxy(connection) && !arrayIsArray(connection)) {
      const close = ownData(connection, 'close');
      if (typeof close === 'function' && !runtimeIsProxy(close)) {
        await boundedAwait(
          Promise.resolve().then(() => close.call(connection)).then(() => {}, () => {}),
          EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_CONNECTION_CLOSE_TIMEOUT_MS,
        );
      }
    }
  } catch (_) {
    /* shutdown must not hang or leak */
  }
}

function isAuthenticEmailLunaAutomationShadowWorkerConnection(value) {
  try {
    return Boolean(value && typeof value === 'object' && weakSetHas(AUTHENTIC_WORKER_CONNECTIONS, value));
  } catch (_) {
    return false;
  }
}

function createEmailLunaAutomationShadowWorkerConnection(input) {
  if (arguments.length !== 1) throw invalid();
  if (!input || typeof input !== 'object' || runtimeIsProxy(input) || arrayIsArray(input)) throw invalid();
  if (objectGetPrototypeOf(input) !== objectPrototype) throw invalid();
  refuseForbiddenKeys(input);
  const env = ownData(input, 'env');
  const appConnectionString = ownData(input, 'appConnectionString');
  const own = safeOwnKeys(input);
  for (let index = 0; index < own.length; index += 1) {
    if (own[index] !== 'env' && own[index] !== 'appConnectionString') throw invalid();
  }
  const config = resolveEmailLunaAutomationShadowWorkerConnectionConfig({
    env,
    appConnectionString,
  });
  if (!config || config.ok !== true) throw invalid();
  const connectionString = ownData(env, ENV_WORKER_DATABASE_URL);
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
  attachEmailLunaAutomationShadowWorkerPoolIdleGuard(pool, () => {
    idleFailure = true;
  });

  async function withTransactionClient(work) {
    if (typeof work !== 'function' || runtimeIsProxy(work)) throw invalid();
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
    await closeEmailLunaAutomationShadowWorkerPool(
      pool,
      EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_CONNECTION_CLOSE_TIMEOUT_MS,
    );
  }

  const handle = freeze({
    withTransactionClient,
    close,
    getConfig: () => config,
    getReadinessFailure: () => (idleFailure ? 'worker_pool_idle_error' : null),
  });
  weakSetAdd(AUTHENTIC_WORKER_CONNECTIONS, handle);
  return handle;
}

module.exports = objectFreeze({
  ENV_WORKER_DATABASE_URL,
  ERROR_CODE,
  CREATE_KEYS,
  OVERLAY_QUERY_KEYS,
  PRE_CONNECT_DISTINCTNESS_IS_NOT_LIVE_SESSION_PROOF,
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_CONNECTION_CLOSE_TIMEOUT_MS,
  resolveEmailLunaAutomationShadowWorkerConnectionConfig,
  createEmailLunaAutomationShadowWorkerConnection,
  drainEmailLunaAutomationShadowRuntimePair,
  closeEmailLunaAutomationShadowWorkerPool,
  attachEmailLunaAutomationShadowWorkerPoolIdleGuard,
  isAuthenticEmailLunaAutomationShadowWorkerConnection,
});

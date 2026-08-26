'use strict';

/**
 * FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B6/B7: dedicated Sunset shadow-worker
 * DB connection contract. Code/config only — does not create secrets, roles,
 * or GRANT. Fail closed if the worker DSN is absent, unparseable, uses a
 * query string (empty allowlist), or the same login identity as the Staff API
 * table-owner / app pool. Identities follow pg-connection-string@2.13.0
 * assignment semantics used by pg.Pool, without ssl/file side effects.
 * localhost/127.0.0.1/::1 and default port 5432 canonicalize. Pre-connect
 * DSN comparison is not live session verification. Never SET ROLE. Errors
 * and return values must not include credentials. Pool close is bounded;
 * idle errors are generic and non-fatal. Do not await pool.end() after
 * forced client removal.
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
const stringSlice = uncurryThis(String.prototype.slice);
const regexpTest = uncurryThis(RegExp.prototype.test);
const weakSetAdd = uncurryThis(WeakSet.prototype.add);
const weakSetHas = uncurryThis(WeakSet.prototype.has);
const nativeSetTimeout = setTimeout;

const AUTHENTIC_WORKER_CONNECTIONS = new WeakSet();
const AUTHENTIC_DIRECT_LOGIN_CONNECTIONS = new WeakSet();
const AUTHENTIC_DIRECT_LOGIN_PAIRS = new WeakSet();
const ENV_WORKER_DATABASE_URL = 'EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL';
const ENV_APP_DATABASE_URL = 'WOLFHOUSE_DATABASE_URL';
const ENV_DATABASE_URL = 'DATABASE_URL';
const ENV_DIRECT_LOGIN_PG_CA = 'EMAIL_LUNA_DIRECT_LOGIN_PG_CA';
const ERROR_CODE = 'EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_CONNECTION_INVALID';
const DIRECT_LOGIN_CONNECTION_TIMEOUT_MS = 5000;
const EXPECTED_DATABASE_SUNSET_STAGING = 'sunset_staging';
const AZURE_PG_HOST_RE = /\.postgres\.database\.azure\.com$/i;
const CREATE_KEYS = objectFreeze(['env', 'appConnectionString']);
const DRAIN_KEYS = objectFreeze(['runtime', 'connection']);
const FORBIDDEN_INPUT_KEYS = objectFreeze([
  'password', 'secret', 'token', 'dsn', 'connectionString', 'roleName', 'setRole',
]);
const WORKER_DSN_QUERY_ALLOWLIST = objectFreeze([]);
const OVERLAY_QUERY_KEYS = objectFreeze([
  'user',
  'username',
  'role',
  'options',
  'session_authorization',
  'host',
  'hostname',
  'hostaddr',
  'port',
  'database',
  'dbname',
  'service',
  'passfile',
  'sslcert',
  'sslkey',
  'sslrootcert',
  'sslpassword',
]);
const APP_UNPROVEN_QUERY_KEYS = objectFreeze([
  'passfile',
  'sslcert',
  'sslkey',
  'sslrootcert',
  'sslpassword',
  'service',
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

function hasExactDuplicateKeys(exactCounts) {
  const keys = reflectOwnKeys(exactCounts);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key === 'string' && exactCounts[key] > 1) return true;
  }
  return false;
}

function dsnHasQueryMarker(text) {
  if (typeof text !== 'string') return false;
  const hashIndex = text.indexOf('#');
  const clipped = hashIndex === -1 ? text : stringSlice(text, 0, hashIndex);
  return clipped.indexOf('?') !== -1;
}

function workerQueryForbidden(url, query, rawText) {
  if (dsnHasQueryMarker(rawText)) return true;
  if (typeof url.search === 'string' && url.search !== '') return true;
  const lowerKeys = reflectOwnKeys(query.lower);
  for (let index = 0; index < lowerKeys.length; index += 1) {
    const key = lowerKeys[index];
    if (typeof key !== 'string' || !arrayIncludes(WORKER_DSN_QUERY_ALLOWLIST, key)) return true;
  }
  const exactKeys = reflectOwnKeys(query.exact);
  for (let index = 0; index < exactKeys.length; index += 1) {
    const key = exactKeys[index];
    if (typeof key !== 'string') return true;
    if (!arrayIncludes(WORKER_DSN_QUERY_ALLOWLIST, stringToLowerCase(key))) return true;
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

function pushUnique(list, value) {
  if (typeof value !== 'string') return;
  for (let index = 0; index < list.length; index += 1) {
    if (list[index] === value) return;
  }
  list.push(value);
}

function pushAll(list, values) {
  if (!values) return;
  for (let index = 0; index < values.length; index += 1) {
    pushUnique(list, values[index]);
  }
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
 * Pre-connect DSN identity using pg-connection-string@2.13.0 / pg.Pool
 * assignment semantics, without executing ssl/file side effects:
 *   query params last-wins, case-sensitive keys
 *   config.user = query user || URL username
 *   config.host = query host || URL hostname
 *   config.port = query port || URL port
 *   config.database always from pathname
 * Worker DSNs may not carry any query string (empty allowlist).
 * Not a substitute for live session_user / current_user / mapping / EXECUTE.
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
    const query = collectQueryValues(url);
    const pathnameDatabase = stringReplace(stringTrim(url.pathname || ''), /^\//, '').split('?')[0];
    const urlUser = decodeUserinfo(url.username || '');
    const urlHost = url.hostname;
    const urlPort = url.port || '';
    if (mode === 'worker') {
      if (workerQueryForbidden(url, query, text)) return { identities: [], invalid: true };
      const identity = identityFromParts(urlUser, urlHost, urlPort, pathnameDatabase);
      if (!identity) return { identities: [], invalid: true };
      return { identities: [identity], invalid: false };
    }
    if (hasExactDuplicateKeys(query.exactCounts)) return { identities: [], invalid: true };
    if (appQueryUnproven(query)) return { identities: [], invalid: true };
    const pgUser = objectHasOwn(query.exact, 'user') ? decodeUserinfo(query.exact.user) : urlUser;
    const pgHost = objectHasOwn(query.exact, 'host') ? query.exact.host : urlHost;
    const pgPort = objectHasOwn(query.exact, 'port') && query.exact.port !== '' ? query.exact.port : urlPort;
    const users = [];
    pushUnique(users, urlUser);
    pushUnique(users, pgUser);
    if (query.lower.user) {
      for (let index = 0; index < query.lower.user.length; index += 1) {
        pushUnique(users, decodeUserinfo(query.lower.user[index]));
      }
    }
    if (query.lower.username) {
      for (let index = 0; index < query.lower.username.length; index += 1) {
        pushUnique(users, decodeUserinfo(query.lower.username[index]));
      }
    }
    if (query.lower.role) {
      for (let index = 0; index < query.lower.role.length; index += 1) {
        pushUnique(users, decodeUserinfo(query.lower.role[index]));
      }
    }
    const hosts = [];
    pushUnique(hosts, urlHost);
    pushUnique(hosts, pgHost);
    pushAll(hosts, query.lower.hostname);
    pushAll(hosts, query.lower.hostaddr);
    if (query.lower.host) {
      for (let index = 0; index < query.lower.host.length; index += 1) {
        pushUnique(hosts, query.lower.host[index]);
      }
    }
    const ports = [];
    pushUnique(ports, urlPort);
    pushUnique(ports, pgPort);
    if (query.lower.port) {
      for (let index = 0; index < query.lower.port.length; index += 1) {
        pushUnique(ports, query.lower.port[index]);
      }
    }
    const databases = [];
    pushUnique(databases, pathnameDatabase);
    pushAll(databases, query.lower.database);
    pushAll(databases, query.lower.dbname);
    const identities = [];
    const seen = new Set();
    for (let u = 0; u < users.length; u += 1) {
      for (let h = 0; h < hosts.length; h += 1) {
        for (let p = 0; p < ports.length; p += 1) {
          for (let d = 0; d < databases.length; d += 1) {
            const identity = identityFromParts(users[u], hosts[h], ports[p], databases[d]);
            if (!identity) continue;
            const key = `${identity.user}@${identity.host}:${identity.port}/${identity.database}`;
            if (seen.has(key)) continue;
            seen.add(key);
            identities.push(identity);
          }
        }
      }
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
    // Bounded termination only. Do not await pool.end() after forced
    // client removal; that promise may never settle. Force-close is not
    // live socket proof.
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

function tlsHostFromDsn(raw) {
  if (typeof raw !== 'string') return '';
  try {
    const text = stringTrim(raw);
    const normalized = stringReplace(text, /^postgres(ql)?:/i, 'http:');
    const url = new URL(normalized);
    return stringToLowerCase(stringTrim(unwrapIpv6Host(url.hostname || '')));
  } catch (_) {
    return '';
  }
}

function resolveEmailLunaDirectLoginPoolTransport(input) {
  try {
    if (!input || typeof input !== 'object' || runtimeIsProxy(input) || arrayIsArray(input)) {
      return output([
        ['ok', false],
        ['reason', 'pg_tls_unproven'],
        ['connectionTimeoutMillis', DIRECT_LOGIN_CONNECTION_TIMEOUT_MS],
        ['ssl', null],
        ['tls_mode', 'unproven'],
      ]);
    }
    const host = ownData(input, 'host');
    const caText = ownData(input, 'caText');
    if (typeof host !== 'string' || stringTrim(host) === '') {
      return output([
        ['ok', false],
        ['reason', 'pg_tls_host_unproven'],
        ['connectionTimeoutMillis', DIRECT_LOGIN_CONNECTION_TIMEOUT_MS],
        ['ssl', null],
        ['tls_mode', 'unproven'],
      ]);
    }
    if (canonicalizeHost(host) === 'loopback') {
      return output([
        ['ok', true],
        ['reason', 'loopback_cleartext'],
        ['connectionTimeoutMillis', DIRECT_LOGIN_CONNECTION_TIMEOUT_MS],
        ['ssl', false],
        ['tls_mode', 'loopback_cleartext'],
      ]);
    }
    const rawHost = stringToLowerCase(stringTrim(unwrapIpv6Host(host)));
    if (typeof caText !== 'string' || caText.indexOf('BEGIN CERTIFICATE') === -1) {
      return output([
        ['ok', false],
        ['reason', 'pg_ca_unproven'],
        ['connectionTimeoutMillis', DIRECT_LOGIN_CONNECTION_TIMEOUT_MS],
        ['ssl', null],
        ['tls_mode', 'unproven'],
      ]);
    }
    const ssl = freeze({
      rejectUnauthorized: true,
      ca: caText,
      servername: rawHost,
    });
    return output([
      ['ok', true],
      ['reason', AZURE_PG_HOST_RE.test(rawHost) ? 'verify-full' : 'verify-full'],
      ['connectionTimeoutMillis', DIRECT_LOGIN_CONNECTION_TIMEOUT_MS],
      ['ssl', ssl],
      ['tls_mode', 'verify-full'],
    ]);
  } catch (_) {
    return output([
      ['ok', false],
      ['reason', 'pg_tls_unproven'],
      ['connectionTimeoutMillis', DIRECT_LOGIN_CONNECTION_TIMEOUT_MS],
      ['ssl', null],
      ['tls_mode', 'unproven'],
    ]);
  }
}

function instantiateDirectLoginConnection(connectionString, options) {
  if (typeof connectionString !== 'string') throw invalid();
  const idleReason = options && options.idleReason === 'worker_pool_idle_error'
    ? 'worker_pool_idle_error'
    : 'principal_pool_idle_error';
  const caText = options && options.caText;
  const transport = resolveEmailLunaDirectLoginPoolTransport({
    host: tlsHostFromDsn(connectionString),
    caText,
  });
  if (!transport || transport.ok !== true) throw invalid();
  let Pool;
  try {
    ({ Pool } = require('pg'));
  } catch (_) {
    throw invalid();
  }
  const poolConfig = {
    connectionString,
    max: 1,
    allowExitOnIdle: true,
    connectionTimeoutMillis: DIRECT_LOGIN_CONNECTION_TIMEOUT_MS,
  };
  if (transport.ssl && typeof transport.ssl === 'object') {
    poolConfig.ssl = {
      rejectUnauthorized: transport.ssl.rejectUnauthorized === true,
      ca: transport.ssl.ca,
      servername: transport.ssl.servername,
    };
  }
  const pool = new Pool(poolConfig);
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

  async function withReadOnlyTransactionClient(work) {
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
        await client.query('BEGIN READ ONLY');
      } catch (_) {
        throw invalid();
      }
      let workError = null;
      let workResult;
      try {
        workResult = await work(client);
      } catch (error) {
        workError = error;
      }
      try {
        await client.query('ROLLBACK');
      } catch (_) {
        throw invalid();
      }
      if (workError) throw workError;
      return workResult;
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
    withReadOnlyTransactionClient,
    close,
    getReadinessFailure: () => (idleFailure ? idleReason : null),
    getTransport: () => transport,
  });
  weakSetAdd(AUTHENTIC_DIRECT_LOGIN_CONNECTIONS, handle);
  return handle;
}

function parseDedicatedDsn(raw) {
  if (typeof raw !== 'string' || stringTrim(raw) === '') {
    return { ok: false, reason: 'principal_connection_required' };
  }
  const parsed = parseDsnIdentities(raw, 'worker');
  if (parsed.invalid || parsed.identities.length !== 1) {
    return { ok: false, reason: 'principal_connection_invalid' };
  }
  return { ok: true, identity: parsed.identities[0] };
}

function resolveEmailLunaDirectLoginPairConfig(input) {
  if (arguments.length !== 1) throw invalid();
  if (!input || typeof input !== 'object' || runtimeIsProxy(input) || arrayIsArray(input)) throw invalid();
  if (objectGetPrototypeOf(input) !== objectPrototype) throw invalid();
  refuseForbiddenKeys(input);
  const own = safeOwnKeys(input);
  for (let index = 0; index < own.length; index += 1) {
    if (
      own[index] !== 'env'
      && own[index] !== 'appConnectionString'
      && own[index] !== 'producerEnvKey'
      && own[index] !== 'workerEnvKey'
      && own[index] !== 'expectedDatabase'
    ) {
      throw invalid();
    }
  }
  const env = ownData(input, 'env');
  const appConnectionString = ownData(input, 'appConnectionString');
  const producerEnvKey = ownData(input, 'producerEnvKey');
  const workerEnvKey = ownData(input, 'workerEnvKey');
  const expectedDatabase = ownData(input, 'expectedDatabase');
  if (appConnectionString !== undefined && typeof appConnectionString !== 'string') throw invalid();
  if (typeof producerEnvKey !== 'string' || typeof workerEnvKey !== 'string') throw invalid();
  if (expectedDatabase !== undefined && typeof expectedDatabase !== 'string') throw invalid();
  const producerParsed = parseDedicatedDsn(ownData(env, producerEnvKey));
  const workerParsed = parseDedicatedDsn(ownData(env, workerEnvKey));
  if (!producerParsed.ok || !workerParsed.ok) {
    return output([
      ['ok', false],
      ['configured', producerParsed.ok || workerParsed.ok],
      ['producer_distinct_from_app', false],
      ['worker_distinct_from_app', false],
      ['producer_distinct_from_worker', false],
      ['database_ok', false],
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
      ['database_ok', false],
      ['reason', 'producer_worker_identity_collision'],
    ]);
  }
  const databaseOk = expectedDatabase == null
    || (
      producerParsed.identity.database === expectedDatabase
      && workerParsed.identity.database === expectedDatabase
    );
  if (!databaseOk) {
    return output([
      ['ok', false],
      ['configured', true],
      ['producer_distinct_from_app', false],
      ['worker_distinct_from_app', false],
      ['producer_distinct_from_worker', true],
      ['database_ok', false],
      ['reason', 'principal_database_unproven'],
    ]);
  }
  const producerTransport = resolveEmailLunaDirectLoginPoolTransport({
    host: tlsHostFromDsn(ownData(env, producerEnvKey)),
    caText: ownData(env, ENV_DIRECT_LOGIN_PG_CA),
  });
  const workerTransport = resolveEmailLunaDirectLoginPoolTransport({
    host: tlsHostFromDsn(ownData(env, workerEnvKey)),
    caText: ownData(env, ENV_DIRECT_LOGIN_PG_CA),
  });
  if (!producerTransport.ok || !workerTransport.ok) {
    return output([
      ['ok', false],
      ['configured', true],
      ['producer_distinct_from_app', false],
      ['worker_distinct_from_app', false],
      ['producer_distinct_from_worker', true],
      ['database_ok', true],
      ['reason', producerTransport.reason || workerTransport.reason || 'pg_tls_unproven'],
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
      ['database_ok', true],
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
      ['database_ok', true],
      ['reason', 'principal_connection_is_app_owner'],
    ]);
  }
  return output([
    ['ok', true],
    ['configured', true],
    ['producer_distinct_from_app', true],
    ['worker_distinct_from_app', true],
    ['producer_distinct_from_worker', true],
    ['database_ok', true],
    ['reason', 'dedicated_producer_worker_logins'],
  ]);
}

function isAuthenticEmailLunaDirectLoginConnection(value) {
  try {
    return Boolean(value && typeof value === 'object' && weakSetHas(AUTHENTIC_DIRECT_LOGIN_CONNECTIONS, value));
  } catch (_) {
    return false;
  }
}

function isAuthenticEmailLunaDirectLoginConnectionPair(value) {
  try {
    return Boolean(value && typeof value === 'object' && weakSetHas(AUTHENTIC_DIRECT_LOGIN_PAIRS, value));
  } catch (_) {
    return false;
  }
}

function createEmailLunaDirectLoginConnectionPair(input) {
  if (arguments.length !== 1) throw invalid();
  const config = resolveEmailLunaDirectLoginPairConfig(input);
  if (!config || config.ok !== true) throw invalid();
  const env = ownData(input, 'env');
  const producerEnvKey = ownData(input, 'producerEnvKey');
  const workerEnvKey = ownData(input, 'workerEnvKey');
  const caText = ownData(env, ENV_DIRECT_LOGIN_PG_CA);
  const producer = instantiateDirectLoginConnection(ownData(env, producerEnvKey), {
    idleReason: 'principal_pool_idle_error',
    caText,
  });
  const worker = instantiateDirectLoginConnection(ownData(env, workerEnvKey), {
    idleReason: 'principal_pool_idle_error',
    caText,
  });
  async function close() {
    try { await producer.close(); } catch (_) { /* bounded */ }
    try { await worker.close(); } catch (_) { /* bounded */ }
  }
  const handle = freeze({
    producer,
    worker,
    close,
    getConfig: () => config,
  });
  weakSetAdd(AUTHENTIC_DIRECT_LOGIN_PAIRS, handle);
  return handle;
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
  const handle = instantiateDirectLoginConnection(connectionString, {
    idleReason: 'worker_pool_idle_error',
    caText: ownData(env, ENV_DIRECT_LOGIN_PG_CA),
  });
  const wrapped = freeze({
    withTransactionClient: handle.withTransactionClient,
    close: handle.close,
    getConfig: () => config,
    getReadinessFailure: handle.getReadinessFailure,
    getTransport: handle.getTransport,
  });
  weakSetAdd(AUTHENTIC_WORKER_CONNECTIONS, wrapped);
  return wrapped;
}

module.exports = objectFreeze({
  ENV_WORKER_DATABASE_URL,
  ENV_DIRECT_LOGIN_PG_CA,
  ERROR_CODE,
  CREATE_KEYS,
  OVERLAY_QUERY_KEYS,
  WORKER_DSN_QUERY_ALLOWLIST,
  APP_UNPROVEN_QUERY_KEYS,
  PRE_CONNECT_DISTINCTNESS_IS_NOT_LIVE_SESSION_PROOF,
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_CONNECTION_CLOSE_TIMEOUT_MS,
  DIRECT_LOGIN_CONNECTION_TIMEOUT_MS,
  EXPECTED_DATABASE_SUNSET_STAGING,
  resolveEmailLunaAutomationShadowWorkerConnectionConfig,
  resolveEmailLunaDirectLoginPoolTransport,
  resolveEmailLunaDirectLoginPairConfig,
  createEmailLunaAutomationShadowWorkerConnection,
  createEmailLunaDirectLoginConnectionPair,
  drainEmailLunaAutomationShadowRuntimePair,
  closeEmailLunaAutomationShadowWorkerPool,
  attachEmailLunaAutomationShadowWorkerPoolIdleGuard,
  isAuthenticEmailLunaAutomationShadowWorkerConnection,
  isAuthenticEmailLunaDirectLoginConnection,
  isAuthenticEmailLunaDirectLoginConnectionPair,
});

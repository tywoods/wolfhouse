'use strict';

/**
 * FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B6: dedicated Sunset shadow-worker
 * DB connection contract. Code/config only — does not create secrets, roles,
 * or GRANT. Fail closed if the worker DSN is absent, unparseable, or the same
 * login identity as the Staff API table-owner / app pool. Never SET ROLE.
 * Errors and return values must not include credentials.
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

const ENV_WORKER_DATABASE_URL = 'EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL';
const ENV_APP_DATABASE_URL = 'WOLFHOUSE_DATABASE_URL';
const ENV_DATABASE_URL = 'DATABASE_URL';
const ERROR_CODE = 'EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_CONNECTION_INVALID';
const CREATE_KEYS = objectFreeze(['env', 'appConnectionString']);
const FORBIDDEN_INPUT_KEYS = objectFreeze([
  'password', 'secret', 'token', 'dsn', 'connectionString', 'roleName', 'setRole',
]);

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

function parseDsnIdentity(raw) {
  if (typeof raw !== 'string') return null;
  const text = stringTrim(raw);
  if (!text) return null;
  try {
    const normalized = text.replace(/^postgres(ql)?:/i, 'http:');
    const url = new URL(normalized);
    const database = stringTrim(url.pathname || '').replace(/^\//, '').split('?')[0];
    const user = url.username ? decodeURIComponent(url.username) : '';
    if (!user || !url.hostname || !database) return null;
    return freeze({
      user,
      host: stringToLowerCase(url.hostname),
      port: url.port || '5432',
      database: stringToLowerCase(database),
    });
  } catch (_) {
    return null;
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
  const candidates = [
    ownData(env, ENV_APP_DATABASE_URL),
    ownData(env, ENV_DATABASE_URL),
    appConnectionString,
  ];
  for (let index = 0; index < candidates.length; index += 1) {
    const identity = parseDsnIdentity(candidates[index]);
    if (!identity) continue;
    const key = `${identity.user}@${identity.host}:${identity.port}/${identity.database}`;
    if (seen.has(key)) continue;
    seen.add(key);
    identities.push(identity);
  }
  return identities;
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
  const workerIdentity = parseDsnIdentity(workerRaw);
  if (!workerIdentity) {
    return output([
      ['ok', false],
      ['configured', true],
      ['distinct_from_app', false],
      ['reason', 'worker_connection_invalid'],
    ]);
  }
  const appIdentities = collectAppIdentities(env, appConnectionString);
  for (let index = 0; index < appIdentities.length; index += 1) {
    if (sameLoginIdentity(workerIdentity, appIdentities[index])) {
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
    try {
      await pool.end();
    } catch (_) {
      /* already closed */
    }
  }

  return freeze({
    withTransactionClient,
    close,
    getConfig: () => config,
  });
}

module.exports = objectFreeze({
  ENV_WORKER_DATABASE_URL,
  ERROR_CODE,
  CREATE_KEYS,
  resolveEmailLunaAutomationShadowWorkerConnectionConfig,
  createEmailLunaAutomationShadowWorkerConnection,
});

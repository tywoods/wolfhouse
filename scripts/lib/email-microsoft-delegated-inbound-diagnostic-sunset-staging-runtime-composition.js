'use strict';

/**
 * Sunset-staging Microsoft delegated inbound diagnostic runtime composition.
 *
 * Default-off via exact `LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED=true` and
 * `LUNA_DEPLOYMENT=sunset-staging`. Explicit factory only — never Staff API
 * startup, cron, or poller. Does not enable start/callback/refresh-health/
 * read-health flags, activation, automation, inbound/outbound, or persistence.
 *
 * Composes (no refresh/custody duplication inside this module):
 *   1) callback-scoped delegated grant access-session (lease→…→confirmed CAS)
 *   2) ImmutableId page transport (authority-bound `/users/{uuid}/messages`)
 *   3) authority-bound inbound operation (merged authority resolve → session
 *      token loan → ImmutableId → inbound batch processor once)
 *   4) factory-fixed **module-owned** diagnostic consumer that never inspects,
 *      iterates, copies, logs, retains, or persists envelopes and returns only
 *      exact synchronous `{ acknowledged: true }` (never durability)
 *
 * Internal composition result is identity-free with exact ordered keys only;
 * the Staff HTTP route remaps it to the separately documented public DTO.
 * (`status: 'success'`, `durably_processed: false`, `input_count`,
 * `delivered_count`, `duplicate_count`) — maps authority-bound internal
 * counts by the same names (no received/accepted/discarded synonyms).
 * Never internal `processed` status, IDs, PII, stage, or generation.
 * `durably_processed` is always literal false (diagnostic never claims durability).
 *
 * @module email-microsoft-delegated-inbound-diagnostic-sunset-staging-runtime-composition
 */

const {
  createSunsetMicrosoftOAuthClientSecretProvider,
  SUNSET_DEPLOYMENT: SECRET_SUNSET,
} = require('./sunset-microsoft-oauth-provider');
const {
  createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition,
  parseEmailGrantEnvelopeAzureKvSunsetStagingRuntimeConfig,
} = require('./email-grant-envelope-azure-kv-sunset-staging-runtime-composition');
const {
  validateEmailGrantEnvelopeProvider,
} = require('./email-grant-envelope-provider-contract');
const {
  createMicrosoftTokenHttpTransport,
} = require('./email-microsoft-token-http-transport');
const {
  createDelegatedGrantAccessSession,
  SUNSET_DEPLOYMENT: SESSION_SUNSET,
} = require('./email-delegated-grant-access-session');
const {
  createMicrosoftGraphImmutableIdPageTransport,
} = require('./email-microsoft-graph-immutableid-page-transport');
const {
  createAuthorityBoundInboundOperation,
  RESULT_KEYS: AUTHORITY_BOUND_RESULT_KEYS,
  FAILURE_CODE: AUTHORITY_BOUND_FAILURE_CODE,
} = require('./email-authority-bound-inbound-operation');

const ERROR_CODE = 'MICROSOFT_DELEGATED_INBOUND_DIAGNOSTIC_RUNTIME_COMPOSITION_INVALID';
const ERROR_MESSAGE = 'Microsoft delegated inbound diagnostic runtime composition failed.';
const SUNSET_DEPLOYMENT = 'sunset-staging';
const WORKER_ID = 'sunset-email-inbound-diagnostic';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Exact env flag — absent/other/false never enable. Not present in manifests/defaults. */
const ENV_INBOUND_DIAGNOSTIC_ENABLED = 'LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED';

const DEPENDENCY_KEYS = Object.freeze([
  'env',
  'pgClient',
  'https',
  'timers',
]);

const HTTPS_KEYS = Object.freeze(['request']);
const TIMERS_KEYS = Object.freeze(['setTimeout', 'clearTimeout']);

/** Exact ordered internal composition result keys (identity-free; no stage/generation). */
const INTERNAL_RESULT_KEYS = Object.freeze([
  'status',
  'durably_processed',
  'input_count',
  'delivered_count',
  'duplicate_count',
]);

/** Internal composition success status literal; the HTTP route remaps it. */
const INTERNAL_STATUS_SUCCESS = 'success';
/** Diagnostic never claims durable processing; always literal false. */
const INTERNAL_DURABLY_PROCESSED = false;
const MAX_COUNT = 5;

/**
 * Module-owned factory-fixed diagnostic consumer.
 *
 * Synchronous handoff only: exact `{ acknowledged: true }`.
 * Must not inspect, iterate, copy, log, retain, or persist envelopes.
 * Not a durable acknowledgement of non-retention or delivery.
 */
function diagnosticInboundConsumer() {
  // Zero argument / element / property access — never touch the loaned array.
  return Object.freeze({ acknowledged: true });
}

const DIAGNOSTIC_INBOUND_CONSUMER = diagnosticInboundConsumer;

if (SECRET_SUNSET !== SUNSET_DEPLOYMENT || SESSION_SUNSET !== SUNSET_DEPLOYMENT) {
  throw new Error('inbound_diagnostic_runtime_composition_sunset_deployment_mismatch');
}

function failure() {
  const error = new Error(ERROR_MESSAGE);
  Object.defineProperty(error, 'name', {
    value: 'MicrosoftDelegatedInboundDiagnosticRuntimeCompositionError',
  });
  Object.defineProperty(error, 'code', { value: ERROR_CODE, enumerable: true });
  return Object.freeze(error);
}

function ownData(object, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor
      && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      && !descriptor.get
      && !descriptor.set
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function ownDataFunction(object, key) {
  try {
    if (object == null || (typeof object !== 'object' && typeof object !== 'function')) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || descriptor.get
        || descriptor.set
        || typeof descriptor.value !== 'function') {
      try {
        const value = object[key];
        return typeof value === 'function' ? value : null;
      } catch {
        return null;
      }
    }
    return descriptor.value;
  } catch {
    return null;
  }
}

function exactPlainData(object, keys) {
  try {
    if (!object || Object.getPrototypeOf(object) !== Object.prototype) return false;
    const actual = Reflect.ownKeys(object);
    if (actual.length !== keys.length
        || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) {
      return false;
    }
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      return Boolean(
        descriptor
        && Object.prototype.hasOwnProperty.call(descriptor, 'value')
        && descriptor.enumerable
        && !descriptor.get
        && !descriptor.set,
      );
    });
  } catch {
    return false;
  }
}

function exactFrozenData(object, keys) {
  return Boolean(object && Object.isFrozen(object) && exactPlainData(object, keys));
}

function snapshotNativeMethodBag(raw, keys) {
  try {
    if (!raw || (typeof raw !== 'object' && typeof raw !== 'function')) return null;
    if (Array.isArray(raw)) return null;
    const captured = Object.create(null);
    for (const key of keys) {
      const fn = ownDataFunction(raw, key);
      if (typeof fn !== 'function') return null;
      captured[key] = fn;
    }
    const owner = raw;
    const out = {};
    for (const key of keys) {
      const fn = captured[key];
      out[key] = function pinnedNative(...args) {
        return Reflect.apply(fn, owner, args);
      };
    }
    return Object.freeze(out);
  } catch {
    return null;
  }
}

function pinNativeSurfaces(httpsRaw, timersRaw) {
  let httpsPinned;
  if (exactFrozenData(httpsRaw, HTTPS_KEYS)) {
    const request = ownDataFunction(httpsRaw, 'request');
    if (!request) return null;
    httpsPinned = Object.freeze({
      request(...args) { return Reflect.apply(request, httpsRaw, args); },
    });
  } else {
    httpsPinned = snapshotNativeMethodBag(httpsRaw, HTTPS_KEYS);
  }
  if (!httpsPinned) return null;

  let timersPinned;
  if (exactFrozenData(timersRaw, TIMERS_KEYS)) {
    const setTimeoutFn = ownDataFunction(timersRaw, 'setTimeout');
    const clearTimeoutFn = ownDataFunction(timersRaw, 'clearTimeout');
    if (!setTimeoutFn || !clearTimeoutFn) return null;
    timersPinned = Object.freeze({
      setTimeout(...args) { return Reflect.apply(setTimeoutFn, timersRaw, args); },
      clearTimeout(...args) { return Reflect.apply(clearTimeoutFn, timersRaw, args); },
    });
  } else {
    timersPinned = snapshotNativeMethodBag(timersRaw, TIMERS_KEYS);
  }
  if (!timersPinned) return null;
  return Object.freeze({ https: httpsPinned, timers: timersPinned });
}

/**
 * Exact gate: sunset-staging deployment + flag string `'true'` only.
 * Absent / other / production / wolfhouse / empty → false (concealed 404 path).
 */
function isInboundDiagnosticEnabled(env) {
  try {
    return !!env
      && env.LUNA_DEPLOYMENT === SUNSET_DEPLOYMENT
      && env[ENV_INBOUND_DIAGNOSTIC_ENABLED] === 'true';
  } catch {
    return false;
  }
}

function snapshotEnvReadiness(env) {
  try {
    if (!isInboundDiagnosticEnabled(env)) return null;
    const appId = env.LUNA_EMAIL_OAUTH_CLIENT_ID;
    if (typeof appId !== 'string' || !UUID_RE.test(appId)) return null;
    const kv = parseEmailGrantEnvelopeAzureKvSunsetStagingRuntimeConfig(env);
    if (!kv.ok || kv.composition_enabled !== true) return null;
    return Object.freeze({
      env,
      applicationClientId: appId.toLowerCase(),
    });
  } catch {
    return null;
  }
}

/**
 * Map authority-bound internal identity-free result → internal composition DTO.
 * Internal `{ status:'processed', input_count, delivered_count, duplicate_count }`
 * maps to public `{ status:'success', durably_processed:false, input_count,
 * delivered_count, duplicate_count }` — same count names, no synonyms.
 * Max-5; observed (input) = unique (delivered) + duplicate.
 * Never expose internal `processed` status, stage, generation, IDs, or PII.
 *
 * @param {object} internal frozen authority-bound result keys
 * @returns {object|null}
 */
function mapInternalDiagnosticResult(internal) {
  try {
    if (!exactFrozenData(internal, AUTHORITY_BOUND_RESULT_KEYS)) return null;
    if (ownData(internal, 'status') !== 'processed') return null;
    const inputCount = ownData(internal, 'input_count');
    const deliveredCount = ownData(internal, 'delivered_count');
    const duplicateCount = ownData(internal, 'duplicate_count');
    if (!Number.isInteger(inputCount) || inputCount < 0 || inputCount > MAX_COUNT) {
      return null;
    }
    if (!Number.isInteger(deliveredCount) || deliveredCount < 0 || deliveredCount > inputCount) {
      return null;
    }
    // observed = unique + duplicate  (input = delivered + duplicate)
    if (!Number.isInteger(duplicateCount) || duplicateCount < 0
        || duplicateCount !== inputCount - deliveredCount) {
      return null;
    }
    // Build with explicit assignment order (exact INTERNAL_RESULT_KEYS).
    const out = {};
    out.status = INTERNAL_STATUS_SUCCESS;
    out.durably_processed = INTERNAL_DURABLY_PROCESSED;
    out.input_count = inputCount;
    out.delivered_count = deliveredCount;
    out.duplicate_count = duplicateCount;
    return Object.freeze(out);
  } catch {
    return null;
  }
}

/**
 * @param {{ env: object, pgClient: object, https: object, timers: object }} deps
 * @returns {Readonly<{ runInboundDiagnostic: Function }>}
 */
function createSunsetStagingMicrosoftDelegatedInboundDiagnosticRuntime(deps) {
  try {
    if (!exactPlainData(deps, DEPENDENCY_KEYS)) throw failure();
    const env = ownData(deps, 'env');
    const pgClient = ownData(deps, 'pgClient');
    const httpsRaw = ownData(deps, 'https');
    const timersRaw = ownData(deps, 'timers');
    const ready = snapshotEnvReadiness(env);
    if (!ready) throw failure();
    if (!pgClient || typeof pgClient !== 'object' || typeof pgClient.query !== 'function') {
      throw failure();
    }
    // Reject Pool-shaped surfaces — require pinned client like other compositions.
    if (typeof pgClient.connect === 'function'
        && (typeof pgClient.totalCount === 'number' || typeof pgClient.idleCount === 'number')) {
      throw failure();
    }
    const natives = pinNativeSurfaces(httpsRaw, timersRaw);
    if (!natives) throw failure();

    const secretProvider = createSunsetMicrosoftOAuthClientSecretProvider(Object.freeze({
      deployment: SUNSET_DEPLOYMENT,
      env: ready.env,
    }));
    const composition = createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(ready.env);
    if (!composition
        || composition.ok !== true
        || composition.composition_enabled !== true
        || !composition.provider) {
      throw failure();
    }
    const prov = validateEmailGrantEnvelopeProvider(composition.provider);
    if (!prov.ok) throw failure();

    // Token HTTP transport for MS refresh exchange only (session owns lifecycle).
    const tokenTransport = createMicrosoftTokenHttpTransport(Object.freeze({
      httpsImpl: natives.https,
      timers: natives.timers,
    }));

    // Callback-scoped one-shot grant session — no second lease/refresh owner here.
    const grantSession = createDelegatedGrantAccessSession(Object.freeze({
      deployment: SUNSET_DEPLOYMENT,
      applicationClientId: ready.applicationClientId,
      client: pgClient,
      envelopeProvider: prov.value,
      secretProvider,
      transport: tokenTransport,
      workerId: WORKER_ID,
    }));

    // ImmutableId page transport — authority-bound /users path; max-5 envelopes.
    const immutableIdPageTransport = createMicrosoftGraphImmutableIdPageTransport(Object.freeze({
      httpsImpl: natives.https,
      timers: natives.timers,
    }));

    // Authority-bound operation: resolve → session loan → ImmutableId → batch once.
    // Factory-fixed module-owned diagnostic consumer only (never caller-supplied).
    const operation = createAuthorityBoundInboundOperation(Object.freeze({
      db: pgClient,
      grantSession,
      immutableIdPageTransport,
      consumer: DIAGNOSTIC_INBOUND_CONSUMER,
    }));

    async function runInboundDiagnostic(input) {
      let out;
      try {
        out = await operation.runAuthorityBoundInbound(input);
      } catch (err) {
        if (err && err.code === AUTHORITY_BOUND_FAILURE_CODE) throw failure();
        throw failure();
      }
      if (!out || out.ok !== true || !out.value) throw failure();
      const internalResult = mapInternalDiagnosticResult(out.value);
      if (!internalResult
          || !exactFrozenData(internalResult, INTERNAL_RESULT_KEYS)
          || ownData(internalResult, 'status') !== INTERNAL_STATUS_SUCCESS
          || ownData(internalResult, 'durably_processed') !== INTERNAL_DURABLY_PROCESSED) {
        throw failure();
      }
      return internalResult;
    }

    return Object.freeze({ runInboundDiagnostic });
  } catch (err) {
    if (err && err.code === ERROR_CODE) throw err;
    throw failure();
  }
}

module.exports = Object.freeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  SUNSET_DEPLOYMENT,
  WORKER_ID,
  ENV_INBOUND_DIAGNOSTIC_ENABLED,
  DEPENDENCY_KEYS,
  INTERNAL_RESULT_KEYS,
  INTERNAL_STATUS_SUCCESS,
  INTERNAL_DURABLY_PROCESSED,
  MAX_COUNT,
  DIAGNOSTIC_INBOUND_CONSUMER,
  isInboundDiagnosticEnabled,
  mapInternalDiagnosticResult,
  createSunsetStagingMicrosoftDelegatedInboundDiagnosticRuntime,
});

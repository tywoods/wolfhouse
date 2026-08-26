'use strict';

/**
 * Sunset-staging Microsoft delegated inbound event-store runtime composition.
 *
 * Default-off via exact `LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED=true` and
 * `LUNA_DEPLOYMENT=sunset-staging`. Explicit factory only — never Staff API
 * startup, cron, poller, route, or diagnostic path. Flag not in manifests/defaults.
 *
 * Composes (no second contract/custody/network owner):
 *   1) callback-scoped delegated grant access-session
 *   2) ImmutableId page transport
 *   3) authority-bound inbound operation + batch processor
 *   4) factory-fixed durable event-store consumer (one exclusive-client txn per
 *      batch via withTransactionClient; insert-or-no-op; ack only after COMMIT)
 *   5) inbox bridge projection into Staff Inbox (067 journal + conversations/messages)
 *
 * Import-inert: zero credential/session/transport construction at require time.
 * Disabled env → factory throws before any Azure/session/network construction.
 *
 * Dependency surfaces: module-init pinned `util.types.isProxy` rejects Proxy
 * deps before any prototype/key/descriptor operations (ambient isProxy
 * monkeypatch after load must not weaken detection).
 *
 * @module email-microsoft-delegated-inbound-event-store-sunset-staging-runtime-composition
 */

const util = require('util');

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
const {
  createDurableInboundEventStoreConsumer,
  EMAIL_INBOUND_EVENT_STORE_RUNTIME_WIRED,
  resolveWithTransactionClient,
} = require('./email-inbound-event-store');
const {
  createEmailInboundInboxBridge,
} = require('./email-inbound-inbox-bridge');

const ERROR_CODE = 'MICROSOFT_DELEGATED_INBOUND_EVENT_STORE_RUNTIME_COMPOSITION_INVALID';
const ERROR_MESSAGE = 'Microsoft delegated inbound event-store runtime composition failed.';
const SUNSET_DEPLOYMENT = 'sunset-staging';
const WORKER_ID = 'sunset-email-inbound-event-store';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Exact env flag — absent/other/false never enable. Not present in manifests/defaults. */
const ENV_DURABLE_INBOUND_CAPTURE_ENABLED = 'LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED';

const DEPENDENCY_KEYS = Object.freeze([
  'env',
  'pgClient',
  'withTransactionClient',
  'https',
  'timers',
]);

const HTTPS_KEYS = Object.freeze(['request']);
const TIMERS_KEYS = Object.freeze(['setTimeout', 'clearTimeout']);
const INPUT_KEYS = Object.freeze(['clientId', 'locationId', 'endpointId']);
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** Exact ordered internal composition result keys (identity-free). */
const INTERNAL_RESULT_KEYS = Object.freeze([
  'status',
  'durably_processed',
  'input_count',
  'delivered_count',
  'duplicate_count',
]);

const INTERNAL_STATUS_SUCCESS = 'success';
/** Event-store success path claims durability after consumer commit+ack. */
const INTERNAL_DURABLY_PROCESSED = true;
const MAX_COUNT = 5;

// Module-init pins: ambient isProxy monkeypatches after load must not weaken detection.
const PINNED_UTIL_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_UTIL_TYPES && typeof PINNED_UTIL_TYPES.isProxy === 'function'
  ? PINNED_UTIL_TYPES.isProxy
  : null;

if (SECRET_SUNSET !== SUNSET_DEPLOYMENT || SESSION_SUNSET !== SUNSET_DEPLOYMENT) {
  throw new Error('inbound_event_store_runtime_composition_sunset_deployment_mismatch');
}
if (EMAIL_INBOUND_EVENT_STORE_RUNTIME_WIRED !== false) {
  throw new Error('inbound_event_store_runtime_wired');
}

function failure() {
  const error = new Error(ERROR_MESSAGE);
  Object.defineProperty(error, 'name', {
    value: 'MicrosoftDelegatedInboundEventStoreRuntimeCompositionError',
  });
  Object.defineProperty(error, 'code', { value: ERROR_CODE, enumerable: true });
  return Object.freeze(error);
}

/**
 * Module-init pinned native util.types.isProxy via Reflect.apply.
 * isProxy throw / missing pin → conservatively treat as proxy (caller rejects).
 */
function isProxySurface(value) {
  try {
    if (typeof PINNED_IS_PROXY !== 'function' || !PINNED_UTIL_TYPES) return true;
    return Reflect.apply(PINNED_IS_PROXY, PINNED_UTIL_TYPES, [value]) === true;
  } catch {
    return true;
  }
}

function ownData(object, key) {
  try {
    if (object == null || isProxySurface(object)) return undefined;
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
    if (isProxySurface(object)) return null;
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
    if (!object || typeof object !== 'object' || Array.isArray(object)) return false;
    // Reject Proxy before any prototype / ownKeys / descriptor operations.
    if (isProxySurface(object)) return false;
    if (Object.getPrototypeOf(object) !== Object.prototype) return false;
    const actual = Reflect.ownKeys(object);
    if (actual.length !== keys.length
        || actual.some((key) => typeof key !== 'string'
          || DANGEROUS_KEYS.has(key)
          || !keys.includes(key))) {
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
    if (isProxySurface(raw)) return null;
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
  if (isProxySurface(httpsRaw) || isProxySurface(timersRaw)) return null;
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
 */
function isInboundEventStoreEnabled(env) {
  try {
    if (!env || isProxySurface(env)) return false;
    return env.LUNA_DEPLOYMENT === SUNSET_DEPLOYMENT
      && env[ENV_DURABLE_INBOUND_CAPTURE_ENABLED] === 'true';
  } catch {
    return false;
  }
}

function snapshotEnvReadiness(env) {
  try {
    if (!isInboundEventStoreEnabled(env)) return null;
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

function snapshotInput(input) {
  try {
    if (!exactPlainData(input, INPUT_KEYS) && !exactFrozenData(input, INPUT_KEYS)) {
      return null;
    }
    const clientId = ownData(input, 'clientId');
    const locationId = ownData(input, 'locationId');
    const endpointId = ownData(input, 'endpointId');
    if (typeof clientId !== 'string' || !UUID_RE.test(clientId)) return null;
    if (typeof locationId !== 'string' || !UUID_RE.test(locationId)) return null;
    if (typeof endpointId !== 'string' || !UUID_RE.test(endpointId)) return null;
    return Object.freeze({
      clientId: clientId.toLowerCase(),
      locationId: locationId.toLowerCase(),
      endpointId: endpointId.toLowerCase(),
    });
  } catch {
    return null;
  }
}

/**
 * Map authority-bound identity-free result → internal composition DTO.
 * Success path: status success + durably_processed true (consumer committed).
 */
function mapInternalEventStoreResult(internal) {
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
    if (!Number.isInteger(duplicateCount) || duplicateCount < 0
        || duplicateCount !== inputCount - deliveredCount) {
      return null;
    }
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
 * @param {{
 *   env: object,
 *   pgClient: object,
 *   withTransactionClient: Function,
 *   https: object,
 *   timers: object,
 * }} deps
 * @returns {Readonly<{ runInboundEventStore: Function }>}
 */
function createSunsetStagingMicrosoftDelegatedInboundEventStoreRuntime(deps) {
  try {
    // Reject dependency Proxy before any prototype/key/descriptor operations.
    if (deps == null || isProxySurface(deps) || !exactPlainData(deps, DEPENDENCY_KEYS)) {
      throw failure();
    }
    const env = ownData(deps, 'env');
    const pgClient = ownData(deps, 'pgClient');
    const withTxnRaw = ownData(deps, 'withTransactionClient');
    const httpsRaw = ownData(deps, 'https');
    const timersRaw = ownData(deps, 'timers');

    // Individual dependency values: reject proxies before further ops.
    if (isProxySurface(env)
        || isProxySurface(pgClient)
        || isProxySurface(withTxnRaw)
        || isProxySurface(httpsRaw)
        || isProxySurface(timersRaw)) {
      throw failure();
    }

    // Disabled → zero construction of credentials/session/transport.
    const ready = snapshotEnvReadiness(env);
    if (!ready) throw failure();

    if (!pgClient || typeof pgClient !== 'object' || typeof pgClient.query !== 'function') {
      throw failure();
    }
    if (typeof pgClient.connect === 'function'
        && (typeof pgClient.totalCount === 'number' || typeof pgClient.idleCount === 'number')) {
      throw failure();
    }

    // Factory-fixed exclusive transaction loaner (descriptor/proxy-safe capture).
    const withTransactionClient = resolveWithTransactionClient(withTxnRaw);
    if (!withTransactionClient) throw failure();
    const inboxBridge = createEmailInboundInboxBridge(Object.freeze({ withTransactionClient }));

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

    // Pin natives + providers at factory (enabled path only). Grant-session and
    // authority-bound operation are one-shot — recreated per run with a
    // factory-fixed durable consumer closed over that run's trusted UUIDs.
    const tokenTransport = createMicrosoftTokenHttpTransport(Object.freeze({
      httpsImpl: natives.https,
      timers: natives.timers,
    }));

    const immutableIdPageTransport = createMicrosoftGraphImmutableIdPageTransport(Object.freeze({
      httpsImpl: natives.https,
      timers: natives.timers,
    }));

    /**
     * Per-run: new one-shot grant session + durable consumer (authority closed)
     * + authority-bound operation. Consumer ack only after exclusive-client COMMIT.
     */
    async function runInboundEventStore(input) {
      const ids = snapshotInput(input);
      if (!ids) throw failure();

      const grantSession = createDelegatedGrantAccessSession(Object.freeze({
        deployment: SUNSET_DEPLOYMENT,
        applicationClientId: ready.applicationClientId,
        client: pgClient,
        envelopeProvider: prov.value,
        secretProvider,
        transport: tokenTransport,
        workerId: WORKER_ID,
      }));

      const durableConsumer = createDurableInboundEventStoreConsumer(Object.freeze({
        withTransactionClient,
        authority: ids,
      }));
      const consumer = async (envelopes) => {
        const acknowledged = await durableConsumer(envelopes);
        const {
          isEmailMicrosoftAutoSendEmergencyEnabled,
          shouldSuppressInboundNeedsHuman,
          afterMicrosoftInboundProjected,
        } = require('./email-luna-microsoft-auto-create-send');
        const autoFlagsOn = isEmailMicrosoftAutoSendEmergencyEnabled(ready.env);
        let suppressNeedsHuman = false;
        if (autoFlagsOn) {
          try {
            suppressNeedsHuman = await shouldSuppressInboundNeedsHuman({
              env: ready.env,
              clientId: ids.clientId,
              withTransactionClient,
            });
          } catch {
            suppressNeedsHuman = false;
          }
        }
        for (const envelope of envelopes) {
          const projectInput = {
            clientId: ids.clientId,
            locationId: ids.locationId,
            endpointId: ids.endpointId,
            provider: envelope.provider,
            providerMailboxId: envelope.provider_mailbox_id,
            providerMessageId: envelope.provider_message_id,
          };
          if (suppressNeedsHuman) projectInput.setNeedsHuman = false;
          const projected = await inboxBridge.projectInboundEvent(Object.freeze(projectInput));
          if (!projected
              || (projected.status !== 'projected'
                && projected.status !== 'already_projected')) {
            throw failure();
          }
          if (autoFlagsOn) {
            try {
              await afterMicrosoftInboundProjected({
                env: ready.env,
                pgClient,
                withTransactionClient,
                https: natives.https,
                timers: natives.timers,
                authority: ids,
                envelope,
                projection: projected,
              });
            } catch {
              // Auto failure must not unwind inbound durability.
            }
          }
        }
        return acknowledged;
      };

      const operation = createAuthorityBoundInboundOperation(Object.freeze({
        db: pgClient,
        grantSession,
        immutableIdPageTransport,
        consumer,
      }));

      let out;
      try {
        out = await operation.runAuthorityBoundInbound(ids);
      } catch (err) {
        if (err && err.code === AUTHORITY_BOUND_FAILURE_CODE) throw failure();
        throw failure();
      }
      if (!out || out.ok !== true || !out.value) throw failure();
      const internalResult = mapInternalEventStoreResult(out.value);
      if (!internalResult
          || !exactFrozenData(internalResult, INTERNAL_RESULT_KEYS)
          || ownData(internalResult, 'status') !== INTERNAL_STATUS_SUCCESS
          || ownData(internalResult, 'durably_processed') !== INTERNAL_DURABLY_PROCESSED) {
        throw failure();
      }
      return internalResult;
    }

    return Object.freeze({ runInboundEventStore });
  } catch (err) {
    if (err && err.code === ERROR_CODE) throw err;
    throw failure();
  }
}

/** Capture composition projects persisted events through inbox bridge (Milestone 1). */
const EMAIL_INBOUND_CAPTURE_INBOX_BRIDGE_WIRED = true;

module.exports = Object.freeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  SUNSET_DEPLOYMENT,
  WORKER_ID,
  ENV_DURABLE_INBOUND_CAPTURE_ENABLED,
  DEPENDENCY_KEYS,
  INTERNAL_RESULT_KEYS,
  INTERNAL_STATUS_SUCCESS,
  INTERNAL_DURABLY_PROCESSED,
  MAX_COUNT,
  EMAIL_INBOUND_CAPTURE_INBOX_BRIDGE_WIRED,
  isInboundEventStoreEnabled,
  mapInternalEventStoreResult,
  createSunsetStagingMicrosoftDelegatedInboundEventStoreRuntime,
});

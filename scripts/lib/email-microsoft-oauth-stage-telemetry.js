'use strict';

/**
 * Phase 1 sanitized Microsoft OAuth downstream stage telemetry.
 *
 * One request-correlated safe event surface for the completing OAuth callback
 * pipeline. Emits only allowlisted stage milestones with a per-callback
 * server-generated UUIDv4 — never secrets, codes, tokens, provider
 * status/body/claims, email, tenant/DB ids, or exception messages/codes.
 *
 * Exact event schema:
 *   { event: 'email_oauth_stage', stage: <allowlisted>, request_id: <uuid> }
 *
 * Ownership:
 *   - Explicit factory injection (requestId + logger) for tests / callers.
 *   - Production callback path: createCallbackEmailOAuthStageTelemetry —
 *     server-generated UUIDv4 via module-init pinned native crypto.randomUUID
 *     (not ambient/substitutable; independent of HTTP/ALS x-request-id).
 *   - No ambient mutable module logger, no ALS logger/id lookup.
 *   - Logging failures never throw and never alter OAuth control flow.
 *   - Invalid stage / invalid pin → silent no-op emit (or factory fail-closed
 *     for construction). randomUUID failure → noop telemetry only.
 *
 * @module email-microsoft-oauth-stage-telemetry
 */

const crypto = require('crypto');
const util = require('util');

/**
 * Module-init pin of native crypto.randomUUID. Capture the function reference
 * and owner once so post-load ambient monkeypatches on crypto.randomUUID are
 * irrelevant to callback telemetry correlation.
 */
const PINNED_CRYPTO = crypto;
const PINNED_RANDOM_UUID = crypto.randomUUID;
const PINNED_UTIL_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_UTIL_TYPES && typeof PINNED_UTIL_TYPES.isProxy === 'function'
  ? PINNED_UTIL_TYPES.isProxy : null;

function isProxy(value) {
  try {
    if (typeof PINNED_IS_PROXY !== 'function' || !PINNED_UTIL_TYPES) return true;
    return Reflect.apply(PINNED_IS_PROXY, PINNED_UTIL_TYPES, [value]) === true;
  } catch {
    return true;
  }
}

/** Canonical UUIDv4 lowercase (correlation id shape only — not HTTP ALS). */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const EVENT_NAME = 'email_oauth_stage';

/**
 * Allowlisted stage vocabulary (exact strings only).
 * Success milestones after transaction consume, plus terminal failure.
 */
const STAGES = Object.freeze([
  'callback_route_accepted',
  'callback_owner_authenticated',
  'callback_query_validated',
  'callback_pg_acquired',
  'callback_dispatch_constructed',
  'phase_a_started',
  'phase_a_invalid',
  'phase_b_runtime_constructed',
  'phase_b_started',
  'phase_b_owner_validated',
  'phase_b_input_validated',
  'phase_b_state_hashed',
  'phase_b_clock_validated',
  'phase_b_consume_started',
  'phase_b_consume_returned',
  'phase_b_consume_matched',
  'phase_b_row_validated',
  'callback_consumed',
  'token_request_started',
  'token_response_received',
  'token_response_validated',
  'oidc_verified',
  // Finer Graph /me milestones (diagnose live callback_failed after oidc_verified).
  'graph_request_started',
  'graph_response_received',
  // Response-validation chain: isolate failures after graph_response_received
  // without logging status/error/body/headers/identity (same 3-field events).
  'graph_http_accepted',
  'graph_headers_accepted',
  'graph_body_collected',
  'graph_json_validated',
  'graph_mailbox_selected',
  'graph_response_validated',
  'graph_principal_matched',
  'graph_identity_verified',
  'envelope_sealed',
  'installer_started',
  'installer_committed',
  'callback_failed',
]);

const STAGE_SET = new Set(STAGES);

/** Exact ordered event keys only. */
const EVENT_KEYS = Object.freeze(['event', 'stage', 'request_id']);

/** Exact factory dependency order. */
const FACTORY_KEYS = Object.freeze(['requestId', 'logger']);

/** Exact telemetry service surface. */
const TELEMETRY_METHOD = 'emit';
const TELEMETRY_KEYS = Object.freeze([TELEMETRY_METHOD]);

const ERROR_CODE = 'MICROSOFT_OAUTH_STAGE_TELEMETRY_INVALID';
const ERROR_MESSAGE = 'Microsoft OAuth stage telemetry failed.';

function failure() {
  const error = new Error(ERROR_MESSAGE);
  Object.defineProperty(error, 'name', { value: 'MicrosoftOAuthStageTelemetryError' });
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

function exactFrozenService(object, methodName) {
  return Boolean(
    exactFrozenData(object, [methodName])
    && typeof ownData(object, methodName) === 'function',
  );
}

/**
 * Default synchronous stdout logger (existing console). Not ambient-mutable —
 * each factory pins the logger function provided at construction.
 * @param {object} record
 */
function defaultEmailOAuthStageLogger(record) {
  console.log(JSON.stringify(record));
}

/**
 * Build exact three-key allowlisted stage event, or null if invalid.
 * Never copies extra fields from input.
 * @param {{ stage?: unknown, request_id?: unknown }} fields
 * @returns {object|null}
 */
function buildEmailOAuthStageEvent(fields) {
  try {
    if (!fields || typeof fields !== 'object') return null;
    const stage = ownData(fields, 'stage');
    const requestId = ownData(fields, 'request_id');
    if (typeof stage !== 'string' || !STAGE_SET.has(stage)) return null;
    if (typeof requestId !== 'string'
        || !UUID_V4_RE.test(requestId)
        || requestId !== requestId.toLowerCase()) {
      return null;
    }
    // Exact key order: event, stage, request_id.
    const record = {
      event: EVENT_NAME,
      stage,
      request_id: requestId,
    };
    if (!exactPlainData(record, EVENT_KEYS)) return null;
    return Object.freeze(record);
  } catch {
    return null;
  }
}

/**
 * Assert a record matches the safe stage event contract (for verifiers).
 * @param {object} event
 * @returns {{ ok: boolean, detail?: string }}
 */
function assertSafeEmailOAuthStageEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { ok: false, detail: 'event_not_object' };
  }
  if (event.event !== EVENT_NAME) {
    return { ok: false, detail: 'bad_event_name' };
  }
  let keys;
  try {
    keys = Reflect.ownKeys(event);
  } catch {
    return { ok: false, detail: 'own_keys_failed' };
  }
  if (keys.length !== EVENT_KEYS.length) {
    return { ok: false, detail: 'bad_key_count' };
  }
  for (let i = 0; i < EVENT_KEYS.length; i += 1) {
    if (keys[i] !== EVENT_KEYS[i]) {
      return { ok: false, detail: `bad_key_order:${String(keys[i])}` };
    }
  }
  if (typeof event.stage !== 'string' || !STAGE_SET.has(event.stage)) {
    return { ok: false, detail: 'bad_stage' };
  }
  if (typeof event.request_id !== 'string'
      || !UUID_V4_RE.test(event.request_id)
      || event.request_id !== event.request_id.toLowerCase()) {
    return { ok: false, detail: 'bad_request_id' };
  }
  return { ok: true };
}

/**
 * Pin an already-constructed telemetry surface (owner-preserving emit wrapper).
 * Rejects accessors/proxies/extra keys; returns null on failure.
 * @param {unknown} raw
 * @returns {{ emit: Function }|null}
 */
function pinEmailOAuthStageTelemetry(raw) {
  try {
    // Native proxy detection is deliberately the first reflective operation.
    if (isProxy(raw)) return null;
    if (!exactFrozenService(raw, TELEMETRY_METHOD)) return null;
    const emitFn = ownData(raw, TELEMETRY_METHOD);
    if (typeof emitFn !== 'function') return null;
    const owner = raw;
    return Object.freeze({
      emit(...args) {
        try {
          Reflect.apply(emitFn, owner, args);
        } catch {
          // Logger / emit failure must never affect OAuth control flow.
        }
      },
    });
  } catch {
    return null;
  }
}

/**
 * Resolve optional stageTelemetry from an exact frozen dependency bag.
 * Accepts either exact coreKeys (noop telemetry) or exact
 * [...coreKeys, 'stageTelemetry'] with a pinned surface.
 * Preserves single-use factory contracts for bags that omit telemetry.
 *
 * @param {object} dependencies
 * @param {readonly string[]} coreKeys
 * @returns {{ ok: boolean, stageTelemetry: { emit: Function }|null }}
 */
function resolveOptionalStageTelemetry(dependencies, coreKeys) {
  try {
    if (!dependencies || typeof dependencies !== 'object') {
      return { ok: false, stageTelemetry: null };
    }
    const withStageKeys = Object.freeze([...coreKeys, 'stageTelemetry']);
    // Set-membership only (matches existing exactFrozenData factory pins).
    // Callers that also enforce key order (operation composition) do so separately.
    if (exactFrozenData(dependencies, withStageKeys)) {
      const pinned = pinEmailOAuthStageTelemetry(ownData(dependencies, 'stageTelemetry'));
      if (!pinned) return { ok: false, stageTelemetry: null };
      return { ok: true, stageTelemetry: pinned };
    }
    if (exactFrozenData(dependencies, coreKeys)) {
      return { ok: true, stageTelemetry: createNoopEmailOAuthStageTelemetry() };
    }
    return { ok: false, stageTelemetry: null };
  } catch {
    return { ok: false, stageTelemetry: null };
  }
}

/**
 * No-op telemetry surface (frozen). Used when production path has no request
 * UUID yet or unit tests omit injection.
 * @returns {{ emit: Function }}
 */
function createNoopEmailOAuthStageTelemetry() {
  return Object.freeze({
    emit() {
      // intentionally empty
    },
  });
}

/**
 * Create request-correlated stage telemetry.
 *
 * @param {object} dependencies exact frozen { requestId, logger }
 * @returns {{ emit: Function }} frozen single-method surface
 */
function createEmailOAuthStageTelemetry(dependencies) {
  let requestId;
  let logger;
  try {
    if (!exactFrozenData(dependencies, FACTORY_KEYS)) throw failure();
    // Exact order required.
    const ordered = Reflect.ownKeys(dependencies);
    if (ordered.length !== FACTORY_KEYS.length
        || ordered[0] !== 'requestId'
        || ordered[1] !== 'logger') {
      throw failure();
    }
    requestId = ownData(dependencies, 'requestId');
    logger = ownData(dependencies, 'logger');
    if (typeof requestId !== 'string'
        || !UUID_V4_RE.test(requestId)
        || requestId !== requestId.toLowerCase()) {
      throw failure();
    }
    if (typeof logger !== 'function') throw failure();
  } catch (err) {
    if (err && err.code === ERROR_CODE) throw err;
    throw failure();
  }

  // Pin once — post-factory mutation of deps bag is irrelevant.
  const pinnedRequestId = requestId;
  const pinnedLogger = logger;

  let terminalFailureEmitted = false;
  function emit(stage) {
    try {
      if (typeof stage !== 'string' || !STAGE_SET.has(stage)) return;
      if (stage === 'callback_failed') {
        if (terminalFailureEmitted) return;
        terminalFailureEmitted = true;
      } else if (terminalFailureEmitted) return;
      const record = buildEmailOAuthStageEvent({
        stage,
        request_id: pinnedRequestId,
      });
      if (!record) return;
      try {
        pinnedLogger(record);
      } catch {
        // Logger failure must never alter OAuth result.
      }
    } catch {
      // Emit is always fail-open for the OAuth path.
    }
  }

  return Object.freeze({ emit });
}

/**
 * Production callback path: per-callback server-generated UUIDv4 correlation.
 *
 * Uses the module-init pinned native crypto.randomUUID wrapper only (not
 * ambient crypto.randomUUID, not ALS/HTTP x-request-id). All stages for one
 * returned surface share the same id. The id need not equal the public route
 * request_id — it correlates telemetry stages internally.
 *
 * Generation failure / invalid UUID → noop telemetry; never throws, never
 * affects OAuth control flow.
 *
 * @param {Function} [logger] optional logger; defaults to defaultEmailOAuthStageLogger
 * @returns {{ emit: Function }} frozen single-method surface
 */
function createCallbackEmailOAuthStageTelemetry(logger) {
  try {
    const log = logger === undefined ? defaultEmailOAuthStageLogger : logger;
    if (typeof log !== 'function') return createNoopEmailOAuthStageTelemetry();
    let requestId;
    try {
      requestId = Reflect.apply(PINNED_RANDOM_UUID, PINNED_CRYPTO, []);
    } catch {
      return createNoopEmailOAuthStageTelemetry();
    }
    if (typeof requestId !== 'string'
        || !UUID_V4_RE.test(requestId)
        || requestId !== requestId.toLowerCase()) {
      return createNoopEmailOAuthStageTelemetry();
    }
    return createEmailOAuthStageTelemetry(Object.freeze({
      requestId,
      logger: log,
    }));
  } catch {
    return createNoopEmailOAuthStageTelemetry();
  }
}

/**
 * Safe emit helper: never throws even if telemetry surface is hostile.
 * @param {{ emit?: Function }|null|undefined} telemetry
 * @param {string} stage
 */
function safeEmitStage(telemetry, stage) {
  try {
    if (!telemetry || typeof telemetry !== 'object') return;
    const emitFn = ownData(telemetry, 'emit');
    if (typeof emitFn !== 'function') return;
    Reflect.apply(emitFn, telemetry, [stage]);
  } catch {
    // never throw
  }
}

module.exports = Object.freeze({
  EVENT_NAME,
  STAGES,
  EVENT_KEYS,
  FACTORY_KEYS,
  TELEMETRY_METHOD,
  TELEMETRY_KEYS,
  ERROR_CODE,
  ERROR_MESSAGE,
  UUID_V4_RE,
  defaultEmailOAuthStageLogger,
  buildEmailOAuthStageEvent,
  assertSafeEmailOAuthStageEvent,
  pinEmailOAuthStageTelemetry,
  resolveOptionalStageTelemetry,
  createNoopEmailOAuthStageTelemetry,
  createEmailOAuthStageTelemetry,
  createCallbackEmailOAuthStageTelemetry,
  safeEmitStage,
});

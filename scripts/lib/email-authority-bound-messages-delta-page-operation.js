'use strict';

/**
 * Authority-bound Microsoft Graph messages-delta one-page durable operation
 * (OFFLINE / UNWIRED composition).
 *
 * Exact state machine (one page per run):
 *   1) resolve verified microsoft authority first
 *      (trusted providerTenantId + providerMailboxId local only)
 *   2) getPublicStatus
 *   3) absent → initialize generation 1 / phase initial /
 *      query_version ms_messages_delta_v1; already-exists race → reread once
 *   4) paused / reset_required → stop (sanitized)
 *   5) acquireLease using current generation/version
 *   6) openCursor using acquired lease returned version (PR408 post-crypto fence)
 *   7) no cursor valid only initial → fetchInitialPage;
 *      else fetchContinuationPage with kind/url
 *   8) fresh one-shot grant-session factory per run; token callback exactly once;
 *      exactly one Graph request
 *   9) Inside callback: fetch then seal successor via PR408 outside TX;
 *      one mutable cursor capability owner; scrub plaintext URL/path/callback
 *      aliases; return only envelopes, tombstones, sealed successor
 *  10) Trusted continuation-only PR409 cursor_gone → markResetRequired
 *      reason graph_delta_cursor_gone CAS; classify exact PR408 result shapes:
 *        - success → reset_required public status; no release (PR408 cleared lease)
 *        - inbound_delta_state_commit_outcome_unknown → sanitized uncertain;
 *          ZERO release / retry / reset / rollover / success actions
 *        - conclusive pre-COMMIT failure / reset_cas_conflict → best-effort
 *          release with known lease version only
 *      never initial 410 / forged error; never auto beginNextGeneration
 *  11) Otherwise commitPageEvents exactly once with exact authority /
 *      generation / lease / version / query values (PR408 owns pre-TX successor
 *      verify + atomic event/cursor TX; no standalone batch/event consumer)
 *  12) On successful commit: releaseLease with returned generation/state_version;
 *      report committed only after conclusive release
 *  13) Precommit failure: best-effort release with known lease version
 *  14) commit_outcome_unknown: exact sanitized uncertain — NO retry / refetch /
 *      reseal / release guess / reset / new generation / success claim
 *  15) Release failure after conclusive commit (lease_fenced / conflict /
 *      commit_outcome_unknown): no page retry; sanitized
 *      committed_but_lease_release_uncertain
 *
 * Phase consistency (strict equality, no OR loophole):
 *   publicStatus.phase → leaseHandle.phase → openCursor.phase must all match.
 *   No-cursor valid only when that phase is exactly 'initial'.
 *   Cursor kind/phase pins: initial → none|nextLink; tracking → nextLink|deltaLink.
 *   Reject mismatches before grant token / network / commit.
 *
 * Public input: exact own-data `{ clientId, locationId, endpointId }` only.
 * Public result: frozen identity-free / cursor-free sanitized status only.
 * No caller verifiedAuthority / provider / tenant / mailbox / generation /
 * query / token / lease / consumer. Factory-fixed authority verifier.
 *
 * Composes only existing merged owners:
 *   - resolveDelegatedReadAuthorityBinding (same SQL as resolveDelegatedReadAuthority
 *     + private provider_tenant_id row field)
 *   - createDelegatedReadAuthorityBindingVerifier → PR408 authorityVerifier
 *   - fresh one-shot grant-session factory per run
 *   - PR409 createMicrosoftGraphMessagesDeltaPageTransport surface
 *   - PR408 createInboundEmailDeltaStateStore / envelopeProvider /
 *     withTransactionClient
 *
 * Transaction loan is exclusively PR408 withTransactionClient.
 * Operation has no SQL / BEGIN / network / crypto / refresh / URL parser.
 * Default-off / import-inert / no route/runtime/cron/startup/feature activation.
 *
 * @module email-authority-bound-messages-delta-page-operation
 */

const util = require('util');
const crypto = require('crypto');

const {
  resolveDelegatedReadAuthorityBinding,
  createDelegatedReadAuthorityBindingVerifier,
  DELEGATED_READ_AUTHORITY_INPUT_KEYS,
  DELEGATED_READ_AUTHORITY_BINDING_DTO_KEYS,
  EMAIL_DELEGATED_READ_AUTHORITY_RUNTIME_WIRED,
} = require('./email-delegated-grant-custodian');
const {
  createInboundEmailDeltaStateStore,
  DEFAULT_QUERY_VERSION,
  EMAIL_INBOUND_DELTA_STATE_RUNTIME_WIRED,
  EMAIL_INBOUND_DELTA_STATE_PAGE_COMMIT_OWNER,
} = require('./email-inbound-delta-state-store');
const {
  readTrustedMessagesDeltaOutcome,
  MESSAGES_DELTA_PAGE_RESULT_KEYS,
  EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_RUNTIME_WIRED,
} = require('./email-microsoft-graph-messages-delta-page-transport');

const FAILURE_CODE = 'authority_bound_messages_delta_page_failed';
const FAILURE_MESSAGE = 'Authority-bound messages-delta page operation failed.';

const EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_RUNTIME_WIRED = false;
const EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_PERSISTENCE_READY = false;
const EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_LOGGING_FORBIDDEN = true;
const EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_SAFE_FOR_RUNTIME_ROUTE_CRON = false;
const EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_AUTO_BEGIN_GENERATION = false;
const EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_MULTIPAGE = false;

/** Exact ordered own-data caller input keys. */
const INPUT_KEYS = DELEGATED_READ_AUTHORITY_INPUT_KEYS;

/** Exact ordered factory dependency keys. */
const DEPENDENCY_KEYS = Object.freeze([
  'db',
  'createGrantSession',
  'messagesDeltaPageTransport',
  'withTransactionClient',
  'envelopeProvider',
]);

const GRANT_SESSION_KEYS = Object.freeze(['runWithAccessTokenOnce']);
const TRANSPORT_KEYS = Object.freeze(['fetchInitialPage', 'fetchContinuationPage']);
const GRANT_SESSION_CALL_KEYS = Object.freeze(['clientId', 'endpointId']);
const LOAN_KEYS = Object.freeze(['accessToken']);

/**
 * Exact ordered identity-free / cursor-free public result keys.
 * No IDs, secrets, envelopes, lease tokens, cursor URLs, generations.
 */
const RESULT_KEYS = Object.freeze([
  'status',
  'phase',
  'envelopes_presented',
  'tombstones_presented',
]);

/** Factory-fixed ingestion lease worker id (not caller-supplied). */
const WORKER_ID = 'authority-bound-messages-delta-page';
const LEASE_TTL_SECONDS = 60;
const RESET_REASON_CURSOR_GONE = 'graph_delta_cursor_gone';
const QUERY_VERSION = DEFAULT_QUERY_VERSION;

const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN_LIMIT = 16_384;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_PAGE = 5;

// Module-init pins.
const PINNED_UTIL_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_UTIL_TYPES && typeof PINNED_UTIL_TYPES.isProxy === 'function'
  ? PINNED_UTIL_TYPES.isProxy
  : null;
const PINNED_ARRAY_PROTOTYPE = Array.prototype;

if (EMAIL_DELEGATED_READ_AUTHORITY_RUNTIME_WIRED !== false) {
  throw new Error('authority_bound_delta_page_read_authority_runtime_wired');
}
if (EMAIL_INBOUND_DELTA_STATE_RUNTIME_WIRED !== false) {
  throw new Error('authority_bound_delta_page_state_runtime_wired');
}
if (EMAIL_INBOUND_DELTA_STATE_PAGE_COMMIT_OWNER !== true) {
  throw new Error('authority_bound_delta_page_commit_owner_unexpected');
}
if (EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_RUNTIME_WIRED !== false) {
  throw new Error('authority_bound_delta_page_transport_runtime_wired');
}
if (typeof QUERY_VERSION !== 'string' || QUERY_VERSION !== 'ms_messages_delta_from_now_v2') {
  throw new Error('authority_bound_delta_page_query_version_unexpected');
}

function failure(code, message) {
  const error = new Error(message || FAILURE_MESSAGE);
  Object.defineProperty(error, 'name', {
    value: 'AuthorityBoundMessagesDeltaPageOperationError',
  });
  Object.defineProperty(error, 'code', {
    value: code || FAILURE_CODE,
    enumerable: true,
  });
  return Object.freeze(error);
}

function failResult(error) {
  return Object.freeze({ ok: false, error: String(error || FAILURE_CODE) });
}

function okResult(value) {
  return Object.freeze({ ok: true, value: Object.freeze({ ...value }) });
}

/** Closed-enum internal observation stages. Never includes IDs, tokens, or errors. */
const AUTHORITY_BOUND_PAGE_INTERNAL_STAGES = Object.freeze([
  'authority',
  'status',
  'lease',
  'grant',
  'transport',
  'seal',
  'store',
  'store_exception',
  'store_page_batch_invalid',
  'store_page_tombstones_invalid',
  'store_successor_cursor_rejected',
  'store_authority_not_verified',
  'store_operation_id_conflict',
  'store_delta_state_not_found',
  'store_authority_mismatch',
  'store_inbound_delta_state_write_failed',
  'store_generation_mismatch',
  'store_state_version_mismatch',
  'store_lease_fenced',
  'store_tenant_mismatch',
  'store_mailbox_mismatch',
  'store_query_version_mismatch',
  'store_reset_required',
  'store_phase_paused',
  'store_commit_cas_conflict',
  'release',
]);
const INTERNAL_STAGE_SET = new Set(AUTHORITY_BOUND_PAGE_INTERNAL_STAGES);
const INTERNAL_STAGE_NOTE_KEYS = Object.freeze(['stage', 'code']);
const INTERNAL_STAGE_BRAND = new WeakMap();
const CREATED_OPERATIONS = new WeakSet();
const OPERATION_OBSERVERS = new WeakMap();

function freezeInternalStageNote(stage) {
  try {
    if (typeof stage !== 'string' || !INTERNAL_STAGE_SET.has(stage)) return null;
    const note = { stage, code: stage };
    if (!exactPlainData(note, INTERNAL_STAGE_NOTE_KEYS)) return null;
    return Object.freeze(note);
  } catch {
    return null;
  }
}

function brandTrustedAuthorityBoundPageInternalStage(target, stage) {
  try {
    if (target == null || (typeof target !== 'object' && typeof target !== 'function')) {
      return target;
    }
    if (typeof stage !== 'string' || !INTERNAL_STAGE_SET.has(stage)) return target;
    INTERNAL_STAGE_BRAND.set(target, stage);
    return target;
  } catch {
    return target;
  }
}

function readTrustedAuthorityBoundPageInternalStage(target) {
  try {
    if (target == null || (typeof target !== 'object' && typeof target !== 'function')) {
      return null;
    }
    return freezeInternalStageNote(INTERNAL_STAGE_BRAND.get(target));
  } catch {
    return null;
  }
}

function bindTrustedAuthorityBoundPageInternalStageObserver(operation, observer) {
  try {
    if (!operation || !CREATED_OPERATIONS.has(operation)) return false;
    if (typeof observer !== 'function' || isProxySurface(observer)) return false;
    OPERATION_OBSERVERS.set(operation, observer);
    return true;
  } catch {
    return false;
  }
}

function notifyInternalStageObserver(operation, stage) {
  try {
    const observer = OPERATION_OBSERVERS.get(operation);
    if (typeof observer !== 'function') return;
    const note = freezeInternalStageNote(stage);
    if (!note) return;
    observer(note);
  } catch {
    // Observer failure must never alter page control flow.
  }
}

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
    if (!object || typeof object !== 'object' || Array.isArray(object)) return false;
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
  return Object.isFrozen(object) && exactPlainData(object, keys);
}

function snapshotInput(input) {
  if (!exactPlainData(input, INPUT_KEYS) && !exactFrozenData(input, INPUT_KEYS)) {
    return null;
  }
  const clientId = ownData(input, 'clientId');
  const locationId = ownData(input, 'locationId');
  const endpointId = ownData(input, 'endpointId');
  if (typeof clientId !== 'string' || !UUID_CANON.test(clientId)) return null;
  if (typeof locationId !== 'string' || !UUID_CANON.test(locationId)) return null;
  if (typeof endpointId !== 'string' || !UUID_CANON.test(endpointId)) return null;
  return Object.freeze({ clientId, locationId, endpointId });
}

function acceptBindingDto(value) {
  if (!exactFrozenData(value, DELEGATED_READ_AUTHORITY_BINDING_DTO_KEYS)) return null;
  const clientId = ownData(value, 'clientId');
  const locationId = ownData(value, 'locationId');
  const endpointId = ownData(value, 'endpointId');
  const provider = ownData(value, 'provider');
  const providerMailboxId = ownData(value, 'providerMailboxId');
  const providerTenantId = ownData(value, 'providerTenantId');
  const bindingStatus = ownData(value, 'bindingStatus');
  if (typeof clientId !== 'string' || !UUID_CANON.test(clientId)) return null;
  if (typeof locationId !== 'string' || !UUID_CANON.test(locationId)) return null;
  if (typeof endpointId !== 'string' || !UUID_CANON.test(endpointId)) return null;
  if (provider !== 'microsoft_graph') return null;
  if (typeof providerMailboxId !== 'string' || !UUID_CANON.test(providerMailboxId)) {
    return null;
  }
  if (typeof providerTenantId !== 'string' || !UUID_CANON.test(providerTenantId)) {
    return null;
  }
  if (bindingStatus !== 'verified') return null;
  return Object.freeze({
    clientId,
    locationId,
    endpointId,
    provider,
    providerMailboxId,
    providerTenantId,
    bindingStatus,
  });
}

function acceptLoanAccessToken(loan) {
  if (!exactPlainData(loan, LOAN_KEYS)) return null;
  const token = ownData(loan, 'accessToken');
  if (typeof token !== 'string' || token.length < 1 || token.length > TOKEN_LIMIT
      || !/^[\x21-\x7e]+$/.test(token)) {
    return null;
  }
  return token;
}

function acceptEnvelopeArray(value, maxLen) {
  try {
    if (value == null || typeof value !== 'object') return null;
    if (isProxySurface(value)) return null;
    if (!Array.isArray(value)) return null;
    if (Object.getPrototypeOf(value) !== PINNED_ARRAY_PROTOTYPE) return null;
    if (!Object.isFrozen(value)) return null;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor
        || Object.prototype.hasOwnProperty.call(lengthDescriptor, 'get')
        || Object.prototype.hasOwnProperty.call(lengthDescriptor, 'set')
        || typeof lengthDescriptor.value !== 'number') {
      return null;
    }
    const len = lengthDescriptor.value;
    if (!Number.isInteger(len) || len < 0 || len > maxLen) return null;
    if (Reflect.ownKeys(value).length !== len + 1) return null;
    const accepted = [];
    for (let i = 0; i < len; i += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor
          || descriptor.enumerable !== true
          || Object.prototype.hasOwnProperty.call(descriptor, 'get')
          || Object.prototype.hasOwnProperty.call(descriptor, 'set')
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        return null;
      }
      const env = descriptor.value;
      if (!env || typeof env !== 'object' || isProxySurface(env) || !Object.isFrozen(env)) {
        return null;
      }
      accepted.push(env);
    }
    return Object.freeze(accepted);
  } catch {
    return null;
  }
}

function acceptTombstoneArray(value, maxLen) {
  return acceptEnvelopeArray(value, maxLen);
}

function acceptTransportPageDto(value) {
  try {
    if (!exactFrozenData(value, MESSAGES_DELTA_PAGE_RESULT_KEYS)) return null;
    const envelopes = acceptEnvelopeArray(ownData(value, 'envelopes'), MAX_PAGE);
    if (!envelopes) return null;
    const tombstones = acceptTombstoneArray(ownData(value, 'tombstones'), MAX_PAGE);
    if (!tombstones) return null;
    const observed = ownData(value, 'observed_count');
    if (!Number.isInteger(observed) || observed < 0
        || observed !== envelopes.length + tombstones.length) {
      return null;
    }
    const successor = ownData(value, 'successor_cursor');
    if (!successor || typeof successor !== 'object' || isProxySurface(successor)) {
      return null;
    }
    if (!exactPlainData(successor, Object.freeze(['cursor_kind', 'cursor_url']))
        && !exactFrozenData(successor, Object.freeze(['cursor_kind', 'cursor_url']))) {
      return null;
    }
    const cursorKind = ownData(successor, 'cursor_kind');
    const cursorUrl = ownData(successor, 'cursor_url');
    if (cursorKind !== 'nextLink' && cursorKind !== 'deltaLink') return null;
    if (typeof cursorUrl !== 'string' || cursorUrl.length < 1) return null;
    return Object.freeze({
      envelopes,
      tombstones,
      observed_count: observed,
      // Mutable capability owner for successor URL — never retain plaintext string
      // as an immutable parallel alias after extraction.
      successorOwner: { kind: cursorKind, url: cursorUrl },
    });
  } catch {
    return null;
  }
}

function envelopesMatchAuthority(envelopes, authority) {
  try {
    for (let i = 0; i < envelopes.length; i += 1) {
      const env = envelopes[i];
      if (ownData(env, 'provider') !== authority.provider
          || ownData(env, 'provider_mailbox_id') !== authority.providerMailboxId) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function tombstonesMatchAuthority(tombstones, authority) {
  try {
    for (let i = 0; i < tombstones.length; i += 1) {
      const t = tombstones[i];
      if (ownData(t, 'provider') !== authority.provider
          || ownData(t, 'provider_mailbox_id') !== authority.providerMailboxId) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function resolvePgLikeQueryMethod(surface) {
  try {
    if (!surface || (typeof surface !== 'object' && typeof surface !== 'function')) {
      return null;
    }
    if (isProxySurface(surface)) return null;
    const own = Object.getOwnPropertyDescriptor(surface, 'query');
    if (own) {
      if (Object.prototype.hasOwnProperty.call(own, 'value')
          && typeof own.value === 'function'
          && !own.get
          && !own.set) {
        return own.value;
      }
      return null;
    }
    let proto = Object.getPrototypeOf(surface);
    let depth = 0;
    while (proto && proto !== Object.prototype && depth < 8) {
      if (isProxySurface(proto)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'query');
      if (descriptor) {
        if (Object.prototype.hasOwnProperty.call(descriptor, 'value')
            && typeof descriptor.value === 'function'
            && !descriptor.get
            && !descriptor.set) {
          return descriptor.value;
        }
        return null;
      }
      proto = Object.getPrototypeOf(proto);
      depth += 1;
    }
    return null;
  } catch {
    return null;
  }
}

function resolveDb(db) {
  try {
    if (db == null || (typeof db !== 'object' && typeof db !== 'function')) return null;
    if (isProxySurface(db)) return null;
    const capturedQuery = resolvePgLikeQueryMethod(db);
    if (typeof capturedQuery !== 'function' || isProxySurface(capturedQuery)) return null;
    const trustedReceiver = db;
    return Object.freeze({
      query(...args) {
        return Reflect.apply(capturedQuery, trustedReceiver, args);
      },
    });
  } catch {
    return null;
  }
}

function resolveCreateGrantSession(fn) {
  try {
    if (typeof fn !== 'function' || isProxySurface(fn)) return null;
    return fn;
  } catch {
    return null;
  }
}

function resolveTransport(transport) {
  try {
    if (!transport || typeof transport !== 'object' || isProxySurface(transport)) {
      return null;
    }
    if (!exactFrozenData(transport, TRANSPORT_KEYS)
        && !exactPlainData(transport, TRANSPORT_KEYS)) {
      return null;
    }
    const fetchInitial = ownData(transport, 'fetchInitialPage');
    const fetchContinuation = ownData(transport, 'fetchContinuationPage');
    if (typeof fetchInitial !== 'function' || isProxySurface(fetchInitial)) return null;
    if (typeof fetchContinuation !== 'function' || isProxySurface(fetchContinuation)) {
      return null;
    }
    return Object.freeze({
      fetchInitialPage: fetchInitial,
      fetchContinuationPage: fetchContinuation,
    });
  } catch {
    return null;
  }
}

function resolveFreshGrantSession(createGrantSession) {
  try {
    const session = createGrantSession();
    if (!session || typeof session !== 'object' || isProxySurface(session)) return null;
    if (!exactFrozenData(session, GRANT_SESSION_KEYS)
        && !exactPlainData(session, GRANT_SESSION_KEYS)) {
      return null;
    }
    const fn = ownData(session, 'runWithAccessTokenOnce');
    if (typeof fn !== 'function' || isProxySurface(fn)) return null;
    return Object.freeze({ runWithAccessTokenOnce: fn });
  } catch {
    return null;
  }
}

function buildPublicResult(status, phase, envelopesPresented, tombstonesPresented) {
  const out = {
    status,
    phase: phase == null ? null : String(phase),
    envelopes_presented: envelopesPresented == null ? null : envelopesPresented,
    tombstones_presented: tombstonesPresented == null ? null : tombstonesPresented,
  };
  const keys = Object.keys(out);
  if (keys.length !== RESULT_KEYS.length
      || keys.some((k, i) => k !== RESULT_KEYS[i])) {
    return null;
  }
  return Object.freeze(out);
}

/**
 * Factory: pin trusted deps; factory-fixed authority verifier + PR408 store.
 * No caller verifiedAuthority / provider / tenant / mailbox / generation /
 * query / token / lease / consumer.
 *
 * @param {object} deps exact DEPENDENCY_KEYS bag
 * @returns {Readonly<{ runAuthorityBoundMessagesDeltaPage: Function }>}
 */
function createAuthorityBoundMessagesDeltaPageOperation(deps) {
  let db;
  let createGrantSession;
  let transport;
  let deltaStore;
  try {
    if (deps == null || isProxySurface(deps)
        || (!exactPlainData(deps, DEPENDENCY_KEYS)
          && !exactFrozenData(deps, DEPENDENCY_KEYS))) {
      throw failure();
    }
    db = resolveDb(ownData(deps, 'db'));
    createGrantSession = resolveCreateGrantSession(ownData(deps, 'createGrantSession'));
    transport = resolveTransport(ownData(deps, 'messagesDeltaPageTransport'));
    const withTransactionClient = ownData(deps, 'withTransactionClient');
    const envelopeProvider = ownData(deps, 'envelopeProvider');
    if (!db || !createGrantSession || !transport) throw failure();
    if (typeof withTransactionClient !== 'function' || isProxySurface(withTransactionClient)) {
      throw failure();
    }
    if (!envelopeProvider || typeof envelopeProvider !== 'object'
        || isProxySurface(envelopeProvider)) {
      throw failure();
    }

    // Factory-fixed authority verifier — same SQL semantics + private tenant field.
    const authorityVerifier = createDelegatedReadAuthorityBindingVerifier(
      Object.freeze({ db }),
    );
    deltaStore = createInboundEmailDeltaStateStore(Object.freeze({
      withTransactionClient,
      envelopeProvider,
      authorityVerifier,
    }));
  } catch (err) {
    if (err && err.code === FAILURE_CODE) throw err;
    if (err && err.code === 'authority_binding_verifier_invalid') throw failure();
    if (err && err.code === 'inbound_delta_state_failed') throw failure();
    throw failure();
  }

  /**
   * Best-effort precommit lease release with the known post-acquire lease version.
   * Never used after commit_outcome_unknown.
   */
  async function bestEffortRelease(ids, leaseHandle) {
    try {
      await deltaStore.releaseLease(Object.freeze({
        clientId: ids.clientId,
        endpointId: ids.endpointId,
        leaseToken: leaseHandle.lease_token,
        expectedGeneration: leaseHandle.ingestion_generation,
        expectedStateVersion: leaseHandle.state_version,
      }));
    } catch {
      // best-effort only
    }
  }

  /**
   * @param {object} input exact { clientId, locationId, endpointId }
   * @returns {Promise<{ok:true,value:object}|{ok:false,error:string}>}
   */
  async function runAuthorityBoundMessagesDeltaPage(input) {
    function failAt(stage) {
      const result = failResult(FAILURE_CODE);
      brandTrustedAuthorityBoundPageInternalStage(result, stage);
      notifyInternalStageObserver(operation, stage);
      return result;
    }

    const ids = snapshotInput(input);
    if (!ids) return failAt('authority');

    // ── 1) Resolve verified microsoft authority (tenant+mailbox local only) ─
    let authorityRaw;
    try {
      authorityRaw = await resolveDelegatedReadAuthorityBinding(ids, { db });
    } catch {
      return failAt('authority');
    }
    if (!authorityRaw || authorityRaw.ok !== true) return failAt('authority');
    const authority = acceptBindingDto(authorityRaw.value);
    authorityRaw = null;
    if (!authority) return failAt('authority');
    if (authority.clientId !== ids.clientId
        || authority.locationId !== ids.locationId
        || authority.endpointId !== ids.endpointId) {
      return failAt('authority');
    }
    // Local-only trusted identities — never escape into public result.
    const providerTenantId = authority.providerTenantId;
    const providerMailboxId = authority.providerMailboxId;

    // ── 2) Public status ───────────────────────────────────────────────────
    let statusRes;
    try {
      statusRes = await deltaStore.getPublicStatus(Object.freeze({
        clientId: ids.clientId,
        endpointId: ids.endpointId,
      }));
    } catch {
      return failAt('status');
    }
    if (!statusRes || statusRes.ok !== true || !statusRes.value) {
      return failAt('status');
    }

    // ── 3) Absent → initialize generation 1; race reread once ────────────
    if (statusRes.value.state_present !== true) {
      let initRes;
      try {
        initRes = await deltaStore.initializeState(Object.freeze({
          clientId: ids.clientId,
          locationId: ids.locationId,
          endpointId: ids.endpointId,
          providerTenantId,
          providerMailboxId,
          queryVersion: QUERY_VERSION,
        }));
      } catch {
        return failAt('status');
      }
      if (!initRes || initRes.ok !== true) {
        if (initRes && initRes.error === 'delta_state_already_exists') {
          // Concurrent initialize race — reread status exactly once.
          try {
            statusRes = await deltaStore.getPublicStatus(Object.freeze({
              clientId: ids.clientId,
              endpointId: ids.endpointId,
            }));
          } catch {
            return failAt('status');
          }
          if (!statusRes || statusRes.ok !== true
              || !statusRes.value || statusRes.value.state_present !== true) {
            return failAt('status');
          }
        } else {
          return failAt('status');
        }
      } else {
        // Seed status from initialize return (generation 1 / version 1 / initial).
        statusRes = Object.freeze({
          ok: true,
          value: Object.freeze({
            state_present: true,
            phase: initRes.value.phase,
            ingestion_generation: initRes.value.ingestion_generation,
            query_version: initRes.value.query_version,
            state_version: initRes.value.state_version,
            has_active_lease: false,
            has_sealed_cursor: false,
            cursor_kind: null,
            reset_reason: null,
          }),
        });
      }
    }

    const publicStatus = statusRes.value;
    if (publicStatus.query_version != null
        && publicStatus.query_version !== QUERY_VERSION) {
      return failAt('status');
    }

    // ── 4) paused / reset_required stop ──────────────────────────────────
    if (publicStatus.phase === 'paused') {
      const paused = buildPublicResult('paused', 'paused', null, null);
      return paused ? okResult(paused) : failAt('status');
    }
    if (publicStatus.phase === 'reset_required') {
      const rr = buildPublicResult('reset_required', 'reset_required', null, null);
      return rr ? okResult(rr) : failAt('status');
    }
    if (publicStatus.phase !== 'initial' && publicStatus.phase !== 'tracking') {
      return failAt('status');
    }

    const generation = publicStatus.ingestion_generation;
    const statusVersion = publicStatus.state_version;
    if (!Number.isInteger(generation) || generation < 1) return failAt('status');
    if (!Number.isInteger(statusVersion) || statusVersion < 1) {
      return failAt('status');
    }

    // ── 5) Acquire lease using current generation/version ────────────────
    let leaseRes;
    try {
      leaseRes = await deltaStore.acquireLease(Object.freeze({
        clientId: ids.clientId,
        endpointId: ids.endpointId,
        workerId: WORKER_ID,
        ttlSeconds: LEASE_TTL_SECONDS,
        expectedGeneration: generation,
        expectedStateVersion: statusVersion,
      }));
    } catch {
      return failAt('lease');
    }
    if (!leaseRes || leaseRes.ok !== true || !leaseRes.value) {
      return failAt('lease');
    }
    const leaseHandle = Object.freeze({
      lease_token: String(leaseRes.value.lease_token),
      ingestion_generation: leaseRes.value.ingestion_generation,
      state_version: leaseRes.value.state_version,
      phase: leaseRes.value.phase,
      query_version: String(leaseRes.value.query_version || QUERY_VERSION),
    });
    if (leaseHandle.ingestion_generation !== generation
        || leaseHandle.query_version !== QUERY_VERSION
        || leaseHandle.phase !== publicStatus.phase
        || (leaseHandle.phase !== 'initial' && leaseHandle.phase !== 'tracking')) {
      // Hold lease but status/lease phase or generation drifted — release only.
      await bestEffortRelease(ids, leaseHandle);
      return failAt('lease');
    }

    // ── 6) Open cursor using acquired lease returned version ─────────────
    let openRes;
    try {
      openRes = await deltaStore.openCursor(Object.freeze({
        clientId: ids.clientId,
        endpointId: ids.endpointId,
        leaseToken: leaseHandle.lease_token,
        expectedGeneration: leaseHandle.ingestion_generation,
        expectedStateVersion: leaseHandle.state_version,
      }));
    } catch {
      await bestEffortRelease(ids, leaseHandle);
      return failAt('status');
    }
    if (!openRes || openRes.ok !== true || !openRes.value) {
      await bestEffortRelease(ids, leaseHandle);
      return failAt('status');
    }

    // Strict phase equality across publicStatus → leaseHandle → openCursor.
    // No OR loophole: every authoritative observed phase must match exactly.
    const openPhase = openRes.value.phase;
    if (openPhase !== publicStatus.phase
        || openPhase !== leaseHandle.phase
        || (openPhase !== 'initial' && openPhase !== 'tracking')) {
      if (openRes.value.cursor_present === true
          && typeof openRes.value.cursor_url === 'string') {
        try { openRes.value.cursor_url = null; } catch { /* frozen */ }
      }
      openRes = null;
      await bestEffortRelease(ids, leaseHandle);
      return failAt('status');
    }
    const observedPhase = openPhase;

    // One mutable cursor capability owner for continuation plaintext URL.
    // No-cursor valid only when observed phase is exactly 'initial'.
    // Kind/phase pins: initial → none|nextLink; tracking → nextLink|deltaLink.
    let cursorCapability = null;
    if (openRes.value.cursor_present === true) {
      const kind = openRes.value.cursor_kind;
      const url = openRes.value.cursor_url;
      if ((kind !== 'nextLink' && kind !== 'deltaLink')
          || typeof url !== 'string' || url.length < 1) {
        openRes = null;
        await bestEffortRelease(ids, leaseHandle);
        return failAt('status');
      }
      if (observedPhase === 'initial' && kind !== 'nextLink') {
        // initial must not carry deltaLink; reject before token/network/commit.
        openRes = null;
        await bestEffortRelease(ids, leaseHandle);
        return failAt('status');
      }
      if (observedPhase === 'tracking'
          && kind !== 'nextLink' && kind !== 'deltaLink') {
        openRes = null;
        await bestEffortRelease(ids, leaseHandle);
        return failAt('status');
      }
      cursorCapability = { kind, url };
    } else if (openRes.value.cursor_present === false) {
      if (observedPhase !== 'initial') {
        // Tracking (or any non-initial) missing cursor fails before grant/network.
        openRes = null;
        await bestEffortRelease(ids, leaseHandle);
        return failAt('status');
      }
      cursorCapability = null;
    } else {
      openRes = null;
      await bestEffortRelease(ids, leaseHandle);
      return failAt('status');
    }
    // Drop openRes reference so plaintext URL is only in cursorCapability.
    openRes = null;

    // ── 7–9) Fresh grant session + exactly one Graph + seal outside TX ───
    const grantSession = resolveFreshGrantSession(createGrantSession);
    if (!grantSession) {
      if (cursorCapability) {
        try { cursorCapability.url = null; } catch { /* */ }
        cursorCapability = null;
      }
      await bestEffortRelease(ids, leaseHandle);
      return failAt('grant');
    }

    const sessionInput = Object.freeze({
      clientId: authority.clientId,
      endpointId: authority.endpointId,
    });
    if (!exactFrozenData(sessionInput, GRANT_SESSION_CALL_KEYS)) {
      if (cursorCapability) {
        try { cursorCapability.url = null; } catch { /* */ }
        cursorCapability = null;
      }
      await bestEffortRelease(ids, leaseHandle);
      return failAt('grant');
    }

    // Capture mode for cursor_gone trust (continuation only).
    const wasContinuation = cursorCapability !== null;

    let sessionOut;
    try {
      sessionOut = await Reflect.apply(
        grantSession.runWithAccessTokenOnce,
        grantSession,
        [
          sessionInput,
          async function tokenCallback(loan) {
            let accessTokenOwner = null;
            let graphInput = null;
            let pageDto = null;
            try {
              accessTokenOwner = acceptLoanAccessToken(loan);
              if (accessTokenOwner === null) {
                throw brandTrustedAuthorityBoundPageInternalStage(failure(), 'grant');
              }

              // ── Exactly one Graph request ─────────────────────────────
              let transportResult;
              try {
                if (cursorCapability === null) {
                  graphInput = {
                    accessToken: accessTokenOwner,
                    provider_mailbox_id: providerMailboxId,
                  };
                  try { loan.accessToken = null; } catch { /* */ }
                  try {
                    transportResult = await Reflect.apply(
                      transport.fetchInitialPage,
                      transport,
                      [graphInput],
                    );
                  } finally {
                    if (graphInput) {
                      try { graphInput.accessToken = null; } catch { /* */ }
                      graphInput = null;
                    }
                  }
                } else {
                  graphInput = {
                    accessToken: accessTokenOwner,
                    provider_mailbox_id: providerMailboxId,
                    cursor_kind: cursorCapability.kind,
                    cursor_url: cursorCapability.url,
                  };
                  // Scrub capability owner before/after request (no parallel alias).
                  try { cursorCapability.url = null; } catch { /* */ }
                  try { cursorCapability.kind = null; } catch { /* */ }
                  cursorCapability = null;
                  try { loan.accessToken = null; } catch { /* */ }
                  try {
                    transportResult = await Reflect.apply(
                      transport.fetchContinuationPage,
                      transport,
                      [graphInput],
                    );
                  } finally {
                    if (graphInput) {
                      try { graphInput.accessToken = null; } catch { /* */ }
                      try { graphInput.cursor_url = null; } catch { /* */ }
                      try { graphInput.cursor_kind = null; } catch { /* */ }
                      graphInput = null;
                    }
                  }
                }
              } catch (err) {
                if (wasContinuation
                    && err
                    && readTrustedMessagesDeltaOutcome(err) === 'cursor_gone') {
                  throw err;
                }
                throw brandTrustedAuthorityBoundPageInternalStage(failure(), 'transport');
              }

              pageDto = acceptTransportPageDto(transportResult);
              transportResult = null;
              if (!pageDto) {
                throw brandTrustedAuthorityBoundPageInternalStage(failure(), 'transport');
              }
              if (!envelopesMatchAuthority(pageDto.envelopes, authority)) {
                throw brandTrustedAuthorityBoundPageInternalStage(failure(), 'transport');
              }
              if (!tombstonesMatchAuthority(pageDto.tombstones, authority)) {
                throw brandTrustedAuthorityBoundPageInternalStage(failure(), 'transport');
              }

              // Seal successor via PR408 outside TX — one mutable URL owner.
              const successorOwner = pageDto.successorOwner;
              pageDto = Object.freeze({
                envelopes: pageDto.envelopes,
                tombstones: pageDto.tombstones,
                observed_count: pageDto.observed_count,
              });
              let sealed;
              try {
                sealed = await deltaStore.sealDeltaCursor(Object.freeze({
                  clientId: ids.clientId,
                  endpointId: ids.endpointId,
                  providerTenantId,
                  providerMailboxId,
                  ingestionGeneration: leaseHandle.ingestion_generation,
                  queryVersion: QUERY_VERSION,
                  cursorKind: successorOwner.kind,
                  cursorUrl: successorOwner.url,
                  operationId: crypto.randomUUID(),
                }));
              } catch {
                throw brandTrustedAuthorityBoundPageInternalStage(failure(), 'seal');
              } finally {
                try { successorOwner.url = null; } catch { /* */ }
                try { successorOwner.kind = null; } catch { /* */ }
              }
              if (!sealed || sealed.ok !== true || !sealed.value) {
                throw brandTrustedAuthorityBoundPageInternalStage(failure(), 'seal');
              }

              // Return only envelopes, tombstones, sealed successor — no plaintext.
              return Object.freeze({
                kind: 'page',
                envelopes: pageDto.envelopes,
                tombstones: pageDto.tombstones,
                sealedSuccessor: Object.freeze({
                  cursor_kind: sealed.value.cursor_kind,
                  envelope: sealed.value.envelope,
                }),
              });
            } catch (err) {
              // Trusted continuation-only PR409 cursor_gone brand.
              if (wasContinuation
                  && err
                  && readTrustedMessagesDeltaOutcome(err) === 'cursor_gone') {
                return Object.freeze({ kind: 'cursor_gone' });
              }
              if (readTrustedAuthorityBoundPageInternalStage(err)) throw err;
              throw brandTrustedAuthorityBoundPageInternalStage(
                err && err.code === FAILURE_CODE ? err : failure(),
                'grant',
              );
            } finally {
              if (graphInput) {
                try { graphInput.accessToken = null; } catch { /* */ }
                try { graphInput.cursor_url = null; } catch { /* */ }
                graphInput = null;
              }
              if (cursorCapability) {
                try { cursorCapability.url = null; } catch { /* */ }
                cursorCapability = null;
              }
              accessTokenOwner = null;
              if (loan) {
                try { loan.accessToken = null; } catch { /* */ }
              }
            }
          },
        ],
      );
    } catch (err) {
      if (cursorCapability) {
        try { cursorCapability.url = null; } catch { /* */ }
        cursorCapability = null;
      }
      await bestEffortRelease(ids, leaseHandle);
      const branded = readTrustedAuthorityBoundPageInternalStage(err);
      return failAt(branded ? branded.stage : 'grant');
    }

    // Ensure cursor capability scrubbed even if session never ran callback.
    if (cursorCapability) {
      try { cursorCapability.url = null; } catch { /* */ }
      cursorCapability = null;
    }

    // Pre-CAS / CAS failure from grant session → zero graph/seal (callback never).
    if (!sessionOut || sessionOut.ok !== true || sessionOut.value == null) {
      await bestEffortRelease(ids, leaseHandle);
      return failAt('grant');
    }

    const pageResult = sessionOut.value;
    sessionOut = null;

    // ── 10) Trusted cursor_gone → markResetRequired; classify PR408 shapes ─
    if (pageResult && pageResult.kind === 'cursor_gone') {
      if (!wasContinuation) {
        // Never treat initial 410 / forged error as cursor_gone.
        await bestEffortRelease(ids, leaseHandle);
        return failAt('transport');
      }
      let resetRes;
      try {
        resetRes = await deltaStore.markResetRequired(Object.freeze({
          clientId: ids.clientId,
          endpointId: ids.endpointId,
          expectedGeneration: leaseHandle.ingestion_generation,
          expectedStateVersion: leaseHandle.state_version,
          reason: RESET_REASON_CURSOR_GONE,
        }));
      } catch {
        // Thrown path is not a PR408 result shape; treat as pre-COMMIT failure.
        await bestEffortRelease(ids, leaseHandle);
        return failAt('store');
      }
      // Exact PR408 commit-unknown: sanitized uncertain — ZERO release/retry/
      // reset/rollover/success actions (may or may not have cleared lease).
      if (resetRes
          && resetRes.ok === false
          && resetRes.error === 'inbound_delta_state_commit_outcome_unknown') {
        const uncertain = buildPublicResult('uncertain', null, null, null);
        return uncertain ? okResult(uncertain) : failAt('store');
      }
      // Conclusive pre-COMMIT failure / reset_cas_conflict only may best-effort
      // release using the known post-acquire lease version. Never auto rollover.
      if (!resetRes || resetRes.ok !== true) {
        await bestEffortRelease(ids, leaseHandle);
        return failAt('store');
      }
      // Successful reset clears lease inside PR408 — no release after.
      // Never auto beginNextGeneration.
      const out = buildPublicResult(
        'reset_required',
        'reset_required',
        null,
        null,
      );
      return out ? okResult(out) : failAt('store');
    }

    if (!pageResult || pageResult.kind !== 'page'
        || !pageResult.envelopes || !pageResult.tombstones
        || !pageResult.sealedSuccessor) {
      await bestEffortRelease(ids, leaseHandle);
      return failAt('transport');
    }

    // ── 11) commitPageEvents exactly once (PR408 owns TX) ────────────────
    let commitRes;
    try {
      commitRes = await deltaStore.commitPageEvents(Object.freeze({
        clientId: ids.clientId,
        locationId: ids.locationId,
        endpointId: ids.endpointId,
        leaseToken: leaseHandle.lease_token,
        expectedGeneration: leaseHandle.ingestion_generation,
        expectedStateVersion: leaseHandle.state_version,
        providerTenantId,
        providerMailboxId,
        queryVersion: QUERY_VERSION,
        envelopes: pageResult.envelopes,
        tombstones: pageResult.tombstones,
        successorCursor: pageResult.sealedSuccessor,
      }));
    } catch {
      await bestEffortRelease(ids, leaseHandle);
      return failAt('store_exception');
    }

    // ── 14) Commit-outcome-unknown: exact sanitized uncertain ────────────
    if (commitRes && commitRes.ok === false
        && commitRes.error === 'inbound_delta_state_commit_outcome_unknown') {
      // NO retry / refetch / reseal / release guess / reset / new generation /
      // success claim.
      const uncertain = buildPublicResult('uncertain', null, null, null);
      return uncertain ? okResult(uncertain) : failAt('store');
    }

    if (!commitRes || commitRes.ok !== true || !commitRes.value) {
      // Precommit / CAS / validation failure — best-effort release.
      await bestEffortRelease(ids, leaseHandle);
      const diagnosticStage = commitRes && commitRes.ok === false
        && [
          'page_batch_invalid',
          'page_tombstones_invalid',
          'successor_cursor_rejected',
          'authority_not_verified',
          'operation_id_conflict',
          'delta_state_not_found',
          'authority_mismatch',
          'inbound_delta_state_write_failed',
          'generation_mismatch',
          'state_version_mismatch',
          'lease_fenced',
          'tenant_mismatch',
          'mailbox_mismatch',
          'query_version_mismatch',
          'reset_required',
          'phase_paused',
          'commit_cas_conflict',
        ].includes(commitRes.error)
        ? `store_${commitRes.error}`
        : 'store';
      return failAt(diagnosticStage);
    }

    const committed = commitRes.value;
    const envelopesPresented = committed.envelopes_presented;
    const tombstonesPresented = committed.tombstones_presented;
    const committedPhase = committed.phase;
    const releaseGeneration = committed.ingestion_generation;
    const releaseVersion = committed.state_version;

    // ── 12) Release with returned generation/state_version ───────────────
    // After conclusive commit: release conflict, release commit-unknown, or
    // throw all map to committed_but_lease_release_uncertain — no page retry.
    let releaseRes;
    try {
      releaseRes = await deltaStore.releaseLease(Object.freeze({
        clientId: ids.clientId,
        endpointId: ids.endpointId,
        leaseToken: leaseHandle.lease_token,
        expectedGeneration: releaseGeneration,
        expectedStateVersion: releaseVersion,
      }));
    } catch {
      const busy = buildPublicResult(
        'committed_but_lease_release_uncertain',
        committedPhase,
        envelopesPresented,
        tombstonesPresented,
      );
      if (!busy) return failAt('release');
      const out = okResult(busy);
      brandTrustedAuthorityBoundPageInternalStage(out, 'release');
      notifyInternalStageObserver(operation, 'release');
      return out;
    }
    if (!releaseRes || releaseRes.ok !== true) {
      // Covers lease_fenced / conflict and inbound_delta_state_commit_outcome_unknown.
      const busy = buildPublicResult(
        'committed_but_lease_release_uncertain',
        committedPhase,
        envelopesPresented,
        tombstonesPresented,
      );
      if (!busy) return failAt('release');
      const out = okResult(busy);
      brandTrustedAuthorityBoundPageInternalStage(out, 'release');
      notifyInternalStageObserver(operation, 'release');
      return out;
    }

    // Report committed only after conclusive release.
    const success = buildPublicResult(
      'committed',
      committedPhase,
      envelopesPresented,
      tombstonesPresented,
    );
    return success ? okResult(success) : failAt('store');
  }

  const operation = Object.freeze({ runAuthorityBoundMessagesDeltaPage });
  CREATED_OPERATIONS.add(operation);
  return operation;
}

module.exports = Object.freeze({
  FAILURE_CODE,
  FAILURE_MESSAGE,
  INPUT_KEYS,
  DEPENDENCY_KEYS,
  RESULT_KEYS,
  WORKER_ID,
  LEASE_TTL_SECONDS,
  RESET_REASON_CURSOR_GONE,
  QUERY_VERSION,
  EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_RUNTIME_WIRED,
  EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_PERSISTENCE_READY,
  EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_LOGGING_FORBIDDEN,
  EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_SAFE_FOR_RUNTIME_ROUTE_CRON,
  EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_AUTO_BEGIN_GENERATION,
  EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_MULTIPAGE,
  AUTHORITY_BOUND_PAGE_INTERNAL_STAGES,
  createAuthorityBoundMessagesDeltaPageOperation,
  readTrustedAuthorityBoundPageInternalStage,
  bindTrustedAuthorityBoundPageInternalStageObserver,
});

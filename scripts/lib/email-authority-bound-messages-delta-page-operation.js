'use strict';

/**
 * Authority-bound Microsoft Graph messages-delta one-page durable operation
 * (OFFLINE / UNWIRED composition) with opaque retry-stable page attempts.
 *
 * Corrective capability (retry-stable page attempt):
 *   createPageAttempt({clientId,locationId,endpointId}) allocates a canonical
 *   page-commit operation UUID BEFORE any Graph / grant / KV / lease / DB side
 *   effect, closes over it privately (no id property, enumeration, log, result,
 *   or error leakage), and returns a frozen exact surface {run,reconcile,status}.
 *
 *   Repeated run on the same attempt after commit_outcome_unknown first queries
 *   durable migration-066 journal by exact enclosed id + tenant/endpoint/fences:
 *     committed → sanitized committed replay; zero Graph/KV/grant/lease/event/
 *       cursor mutation
 *     claimed / ambiguous → uncertain / evidence unavailable; zero refetch
 *     absent after confirmed rollback → may execute once safely
 *
 *   Requested generation/stateVersion fences may be unknown before lease: the
 *   attempt is allocated before Graph; fences are captured after authoritative
 *   lease/status without changing the operation id; journal uses exact fences.
 *   Reconcile classification is journal-only via recovery-store
 *   readPageCommitOutcome. Worker id is source-pinned sunset-email-delta-worker.
 *
 *   Direct runAuthorityBoundMessagesDeltaPage remains offline-only and explicitly
 *   activation-ineligible (ephemeral attempt; no durable caller handle). Runtime
 *   composition must eventually require the attempt API. Worker activation is
 *   blocked until a caller durability lifecycle exists (process-crash recovery
 *   of opaque attempt handles is not invented here without scheduler control).
 *
 * Exact state machine (one page per execute):
 *   1) resolve verified microsoft authority first
 *      (trusted providerTenantId + providerMailboxId local only)
 *   2) getPublicStatus
 *   3) absent → initialize generation 1 / phase initial /
 *      query_version ms_messages_delta_v1; already-exists race → reread once
 *   4) paused / reset_required → stop (sanitized)
 *   5) acquireLease using current generation/version; capture fences
 *   6) openCursor using acquired lease returned version (PR408 post-crypto fence)
 *   7) no cursor valid only initial → fetchInitialPage;
 *      else fetchContinuationPage with kind/url
 *   8) fresh one-shot grant-session factory per run; token callback exactly once;
 *      exactly one Graph request
 *   9) Inside callback: fetch then seal successor via PR408 outside TX using the
 *      attempt-closed operation id (never post-Graph randomUUID); one mutable
 *      cursor capability owner; scrub plaintext URL/path/callback aliases;
 *      return only envelopes, tombstones, sealed successor
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
 *   - email-delta-recovery-operation-store.readPageCommitOutcome (journal-only)
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
const {
  createEmailDeltaRecoveryOperationStore,
  PAGE_COMMIT_WORKER_ID,
  PAGE_COMMIT_OUTCOME_KEYS,
  EMAIL_DELTA_RECOVERY_OPERATION_RUNTIME_WIRED,
} = require('./email-delta-recovery-operation-store');

const FAILURE_CODE = 'authority_bound_messages_delta_page_failed';
const FAILURE_MESSAGE = 'Authority-bound messages-delta page operation failed.';

const EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_RUNTIME_WIRED = false;
const EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_PERSISTENCE_READY = false;
const EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_LOGGING_FORBIDDEN = true;
const EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_SAFE_FOR_RUNTIME_ROUTE_CRON = false;
const EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_AUTO_BEGIN_GENERATION = false;
const EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_MULTIPAGE = false;
/**
 * Caller durability lifecycle (retain opaque attempt across process crash /
 * scheduler control) is not present. Worker must not activate until it exists.
 */
const EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_CALLER_DURABILITY_LIFECYCLE_READY = false;
/** Runtime composition must require createPageAttempt (not direct single-shot). */
const EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_ATTEMPT_API_REQUIRED_FOR_RUNTIME = true;
/**
 * Direct runAuthorityBoundMessagesDeltaPage is offline-only and activation-
 * ineligible (ephemeral attempt; no durable same-ID caller handle).
 */
const EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_DIRECT_RUN_ACTIVATION_INELIGIBLE = true;

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

/** Exact frozen attempt surface keys (no operation id). */
const ATTEMPT_SURFACE_KEYS = Object.freeze([
  'run',
  'reconcile',
  'status',
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

/**
 * Factory-fixed worker id for lease + page_commit journal attribution.
 * Source-pinned to migration 066 PAGE_COMMIT_WORKER_ID (never caller-supplied).
 */
const WORKER_ID = PAGE_COMMIT_WORKER_ID;
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
if (EMAIL_DELTA_RECOVERY_OPERATION_RUNTIME_WIRED !== false) {
  throw new Error('authority_bound_delta_page_recovery_runtime_wired');
}
if (typeof QUERY_VERSION !== 'string' || QUERY_VERSION !== 'ms_messages_delta_v1') {
  throw new Error('authority_bound_delta_page_query_version_unexpected');
}
if (WORKER_ID !== 'sunset-email-delta-worker') {
  throw new Error('authority_bound_delta_page_worker_id_unexpected');
}
if (EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_CALLER_DURABILITY_LIFECYCLE_READY !== false) {
  throw new Error('authority_bound_delta_page_caller_durability_ready_unexpected');
}
if (EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_ATTEMPT_API_REQUIRED_FOR_RUNTIME !== true) {
  throw new Error('authority_bound_delta_page_attempt_api_required_unexpected');
}
if (EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_DIRECT_RUN_ACTIVATION_INELIGIBLE !== true) {
  throw new Error('authority_bound_delta_page_direct_run_ineligible_unexpected');
}
if (EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_SAFE_FOR_RUNTIME_ROUTE_CRON !== false) {
  throw new Error('authority_bound_delta_page_runtime_safe_unexpected');
}
if (EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_PERSISTENCE_READY !== false) {
  throw new Error('authority_bound_delta_page_persistence_ready_unexpected');
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
 * Allocate a canonical lowercase UUID. Used only before side effects so the
 * attempt id is stable for seal/journal/same-ID replay.
 */
function allocateCanonicalOperationId() {
  try {
    const raw = crypto.randomUUID();
    if (typeof raw !== 'string') return null;
    const id = raw.trim().toLowerCase();
    if (!UUID_CANON.test(id)) return null;
    return id;
  } catch {
    return null;
  }
}

/**
 * Factory: pin trusted deps; factory-fixed authority verifier + PR408 store +
 * recovery journal reader. No caller verifiedAuthority / provider / tenant /
 * mailbox / generation / query / token / lease / consumer / worker id.
 *
 * @param {object} deps exact DEPENDENCY_KEYS bag
 * @returns {Readonly<{
 *   createPageAttempt: Function,
 *   runAuthorityBoundMessagesDeltaPage: Function,
 * }>}
 */
function createAuthorityBoundMessagesDeltaPageOperation(deps) {
  let db;
  let createGrantSession;
  let transport;
  let deltaStore;
  let recoveryStore;
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
    recoveryStore = createEmailDeltaRecoveryOperationStore(Object.freeze({
      withTransactionClient,
      authorityVerifier,
      inboundDeltaStateStore: deltaStore,
    }));
  } catch (err) {
    if (err && err.code === FAILURE_CODE) throw err;
    if (err && err.code === 'authority_binding_verifier_invalid') throw failure();
    if (err && err.code === 'inbound_delta_state_failed') throw failure();
    if (err && err.code === 'email_delta_recovery_failed') throw failure();
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

  async function resolveAuthority(ids) {
    let authorityRaw;
    try {
      authorityRaw = await resolveDelegatedReadAuthorityBinding(ids, { db });
    } catch {
      return null;
    }
    if (!authorityRaw || authorityRaw.ok !== true) return null;
    const authority = acceptBindingDto(authorityRaw.value);
    if (!authority) return null;
    if (authority.clientId !== ids.clientId
        || authority.locationId !== ids.locationId
        || authority.endpointId !== ids.endpointId) {
      return null;
    }
    return authority;
  }

  /**
   * Journal-only consult for a retained attempt. Never mutates.
   * Returns { kind:'absent'|'committed'|'uncertain'|'conflict'|'error' }.
   */
  async function consultPageCommitJournal(ids, authority, operationId, fences) {
    try {
      const read = await recoveryStore.readPageCommitOutcome(Object.freeze({
        operationId,
        clientId: ids.clientId,
        locationId: ids.locationId,
        endpointId: ids.endpointId,
        expectedGeneration: fences.requestedGeneration,
        expectedStateVersion: fences.requestedStateVersion,
        providerTenantId: authority.providerTenantId,
        providerMailboxId: authority.providerMailboxId,
      }));
      if (!read || read.ok !== true || !read.value) {
        if (read && read.error === 'operation_id_conflict') {
          return Object.freeze({ kind: 'conflict' });
        }
        if (read && read.error === 'authority_not_verified') {
          return Object.freeze({ kind: 'error' });
        }
        return Object.freeze({ kind: 'error' });
      }
      const v = read.value;
      if (v.presence === 'absent') {
        return Object.freeze({ kind: 'absent' });
      }
      if (v.presence !== 'present' || typeof v.outcome !== 'string') {
        return Object.freeze({ kind: 'error' });
      }
      if (v.outcome === 'committed') {
        return Object.freeze({
          kind: 'committed',
          phase: v.result_phase,
          result_generation: v.result_generation,
          result_state_version: v.result_state_version,
        });
      }
      // claimed / commit_outcome_unknown / ambiguous → zero refetch
      if (v.outcome === 'claimed'
          || v.outcome === 'commit_outcome_unknown'
          || v.outcome === 'evidence_unavailable') {
        return Object.freeze({ kind: 'uncertain' });
      }
      if (v.outcome === 'not_committed' || v.outcome === 'conflict') {
        return Object.freeze({ kind: 'conflict' });
      }
      return Object.freeze({ kind: 'uncertain' });
    } catch {
      return Object.freeze({ kind: 'error' });
    }
  }

  /**
   * Execute one page with a pre-allocated operation id (attempt-closed).
   * Captures requested generation/stateVersion into fenceHolder after lease
   * without changing the operation id.
   *
   * @param {object} ids frozen {clientId,locationId,endpointId}
   * @param {string} operationId canonical UUID (private)
   * @param {{ requestedGeneration: number|null, requestedStateVersion: number|null }} fenceHolder
   */
  async function executePageWithOperationId(ids, operationId, fenceHolder) {
    if (typeof operationId !== 'string' || !UUID_CANON.test(operationId)) {
      return failResult(FAILURE_CODE);
    }

    // ── 1) Resolve verified microsoft authority (tenant+mailbox local only) ─
    const authority = await resolveAuthority(ids);
    if (!authority) return failResult(FAILURE_CODE);
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
      return failResult(FAILURE_CODE);
    }
    if (!statusRes || statusRes.ok !== true || !statusRes.value) {
      return failResult(FAILURE_CODE);
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
        return failResult(FAILURE_CODE);
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
            return failResult(FAILURE_CODE);
          }
          if (!statusRes || statusRes.ok !== true
              || !statusRes.value || statusRes.value.state_present !== true) {
            return failResult(FAILURE_CODE);
          }
        } else {
          return failResult(FAILURE_CODE);
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
      return failResult(FAILURE_CODE);
    }

    // ── 4) paused / reset_required stop ──────────────────────────────────
    if (publicStatus.phase === 'paused') {
      const paused = buildPublicResult('paused', 'paused', null, null);
      return paused ? okResult(paused) : failResult(FAILURE_CODE);
    }
    if (publicStatus.phase === 'reset_required') {
      const rr = buildPublicResult('reset_required', 'reset_required', null, null);
      return rr ? okResult(rr) : failResult(FAILURE_CODE);
    }
    if (publicStatus.phase !== 'initial' && publicStatus.phase !== 'tracking') {
      return failResult(FAILURE_CODE);
    }

    const generation = publicStatus.ingestion_generation;
    const statusVersion = publicStatus.state_version;
    if (!Number.isInteger(generation) || generation < 1) return failResult(FAILURE_CODE);
    if (!Number.isInteger(statusVersion) || statusVersion < 1) {
      return failResult(FAILURE_CODE);
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
      return failResult(FAILURE_CODE);
    }
    if (!leaseRes || leaseRes.ok !== true || !leaseRes.value) {
      return failResult(FAILURE_CODE);
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
      return failResult(FAILURE_CODE);
    }

    // Capture journal fences after authoritative lease without changing the
    // pre-allocated operation id. Journal requested_* match commitPageEvents
    // expected generation + post-acquire lease state_version (not pre-lease).
    if (fenceHolder && typeof fenceHolder === 'object') {
      fenceHolder.requestedGeneration = leaseHandle.ingestion_generation;
      fenceHolder.requestedStateVersion = leaseHandle.state_version;
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
      return failResult(FAILURE_CODE);
    }
    if (!openRes || openRes.ok !== true || !openRes.value) {
      await bestEffortRelease(ids, leaseHandle);
      return failResult(FAILURE_CODE);
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
      return failResult(FAILURE_CODE);
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
        return failResult(FAILURE_CODE);
      }
      if (observedPhase === 'initial' && kind !== 'nextLink') {
        // initial must not carry deltaLink; reject before token/network/commit.
        openRes = null;
        await bestEffortRelease(ids, leaseHandle);
        return failResult(FAILURE_CODE);
      }
      if (observedPhase === 'tracking'
          && kind !== 'nextLink' && kind !== 'deltaLink') {
        openRes = null;
        await bestEffortRelease(ids, leaseHandle);
        return failResult(FAILURE_CODE);
      }
      cursorCapability = { kind, url };
    } else if (openRes.value.cursor_present === false) {
      if (observedPhase !== 'initial') {
        // Tracking (or any non-initial) missing cursor fails before grant/network.
        openRes = null;
        await bestEffortRelease(ids, leaseHandle);
        return failResult(FAILURE_CODE);
      }
      cursorCapability = null;
    } else {
      openRes = null;
      await bestEffortRelease(ids, leaseHandle);
      return failResult(FAILURE_CODE);
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
      return failResult(FAILURE_CODE);
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
      return failResult(FAILURE_CODE);
    }

    // Capture mode for cursor_gone trust (continuation only).
    const wasContinuation = cursorCapability !== null;

    // Close over attempt operation id for seal — never allocate post-Graph.
    const sealedOperationId = operationId;

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
              if (accessTokenOwner === null) throw failure();

              // ── Exactly one Graph request ─────────────────────────────
              let transportResult;
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

              pageDto = acceptTransportPageDto(transportResult);
              transportResult = null;
              if (!pageDto) throw failure();
              if (!envelopesMatchAuthority(pageDto.envelopes, authority)) {
                throw failure();
              }
              if (!tombstonesMatchAuthority(pageDto.tombstones, authority)) {
                throw failure();
              }

              // Seal successor via PR408 outside TX — attempt-stable operation id.
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
                  operationId: sealedOperationId,
                }));
              } finally {
                try { successorOwner.url = null; } catch { /* */ }
                try { successorOwner.kind = null; } catch { /* */ }
              }
              if (!sealed || sealed.ok !== true || !sealed.value) throw failure();

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
              throw err && err.code === FAILURE_CODE ? err : failure();
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
    } catch {
      if (cursorCapability) {
        try { cursorCapability.url = null; } catch { /* */ }
        cursorCapability = null;
      }
      await bestEffortRelease(ids, leaseHandle);
      return failResult(FAILURE_CODE);
    }

    // Ensure cursor capability scrubbed even if session never ran callback.
    if (cursorCapability) {
      try { cursorCapability.url = null; } catch { /* */ }
      cursorCapability = null;
    }

    // Pre-CAS / CAS failure from grant session → zero graph/seal (callback never).
    if (!sessionOut || sessionOut.ok !== true || sessionOut.value == null) {
      await bestEffortRelease(ids, leaseHandle);
      return failResult(FAILURE_CODE);
    }

    const pageResult = sessionOut.value;
    sessionOut = null;

    // ── 10) Trusted cursor_gone → markResetRequired; classify PR408 shapes ─
    if (pageResult && pageResult.kind === 'cursor_gone') {
      if (!wasContinuation) {
        // Never treat initial 410 / forged error as cursor_gone.
        await bestEffortRelease(ids, leaseHandle);
        return failResult(FAILURE_CODE);
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
        return failResult(FAILURE_CODE);
      }
      // Exact PR408 commit-unknown: sanitized uncertain — ZERO release/retry/
      // reset/rollover/success actions (may or may not have cleared lease).
      if (resetRes
          && resetRes.ok === false
          && resetRes.error === 'inbound_delta_state_commit_outcome_unknown') {
        const uncertain = buildPublicResult('uncertain', null, null, null);
        return uncertain ? okResult(uncertain) : failResult(FAILURE_CODE);
      }
      // Conclusive pre-COMMIT failure / reset_cas_conflict only may best-effort
      // release using the known post-acquire lease version. Never auto rollover.
      if (!resetRes || resetRes.ok !== true) {
        await bestEffortRelease(ids, leaseHandle);
        return failResult(FAILURE_CODE);
      }
      // Successful reset clears lease inside PR408 — no release after.
      // Never auto beginNextGeneration.
      const out = buildPublicResult(
        'reset_required',
        'reset_required',
        null,
        null,
      );
      return out ? okResult(out) : failResult(FAILURE_CODE);
    }

    if (!pageResult || pageResult.kind !== 'page'
        || !pageResult.envelopes || !pageResult.tombstones
        || !pageResult.sealedSuccessor) {
      await bestEffortRelease(ids, leaseHandle);
      return failResult(FAILURE_CODE);
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
      return failResult(FAILURE_CODE);
    }

    // ── 14) Commit-outcome-unknown: exact sanitized uncertain ────────────
    if (commitRes && commitRes.ok === false
        && commitRes.error === 'inbound_delta_state_commit_outcome_unknown') {
      // NO retry / refetch / reseal / release guess / reset / new generation /
      // success claim. Attempt retains operation id + fences for journal consult.
      const uncertain = buildPublicResult('uncertain', null, null, null);
      return uncertain ? okResult(uncertain) : failResult(FAILURE_CODE);
    }

    if (!commitRes || commitRes.ok !== true || !commitRes.value) {
      // Precommit / CAS / validation failure — best-effort release.
      await bestEffortRelease(ids, leaseHandle);
      return failResult(FAILURE_CODE);
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
      return busy ? okResult(busy) : failResult(FAILURE_CODE);
    }
    if (!releaseRes || releaseRes.ok !== true) {
      // Covers lease_fenced / conflict and inbound_delta_state_commit_outcome_unknown.
      const busy = buildPublicResult(
        'committed_but_lease_release_uncertain',
        committedPhase,
        envelopesPresented,
        tombstonesPresented,
      );
      return busy ? okResult(busy) : failResult(FAILURE_CODE);
    }

    // Report committed only after conclusive release.
    const success = buildPublicResult(
      'committed',
      committedPhase,
      envelopesPresented,
      tombstonesPresented,
    );
    return success ? okResult(success) : failResult(FAILURE_CODE);
  }

  /**
   * Opaque retry-stable page attempt.
   * Allocates canonical operation UUID before any Graph/grant/KV/lease/DB
   * side effect; closes over it privately (no id property/enumeration/log).
   * Frozen surface: run / reconcile / status only.
   *
   * @param {object} input exact { clientId, locationId, endpointId }
   * @returns {Readonly<{run:Function,reconcile:Function,status:Function}>}
   */
  function createPageAttempt(input) {
    const ids = snapshotInput(input);
    if (!ids) throw failure();

    // Allocate BEFORE any side effect (no Graph/grant/KV/lease/DB/journal).
    const operationId = allocateCanonicalOperationId();
    if (!operationId) throw failure();

    // Process-local fence capture after authoritative lease/status.
    const fenceHolder = {
      requestedGeneration: null,
      requestedStateVersion: null,
    };
    // Process-local last public result for status() without re-execution.
    let lastPublicResult = null;

    function remember(result) {
      if (result && result.ok === true && result.value) {
        lastPublicResult = result.value;
      }
      return result;
    }

    function noIdLeak(value) {
      try {
        const s = typeof value === 'string' ? value : JSON.stringify(value);
        // Enclosed operation id must never appear in public results/errors.
        return typeof s !== 'string' || !s.includes(operationId);
      } catch {
        return true;
      }
    }

    /**
     * Execute or journal-replay this attempt.
     * After commit_outcome_unknown, consults migration-066 journal first.
     */
    async function run() {
      // Resolve authority once for journal consult path (read-only SQL, not Graph).
      const authority = await resolveAuthority(ids);
      if (!authority) return remember(failResult(FAILURE_CODE));

      const fencesReady = Number.isInteger(fenceHolder.requestedGeneration)
        && fenceHolder.requestedGeneration >= 1
        && Number.isInteger(fenceHolder.requestedStateVersion)
        && fenceHolder.requestedStateVersion >= 1;

      if (fencesReady) {
        const consult = await consultPageCommitJournal(
          ids,
          authority,
          operationId,
          Object.freeze({
            requestedGeneration: fenceHolder.requestedGeneration,
            requestedStateVersion: fenceHolder.requestedStateVersion,
          }),
        );
        if (consult.kind === 'committed') {
          // Sanitized committed replay — zero Graph/KV/grant/lease/event/cursor.
          const phase = consult.phase == null ? null : String(consult.phase);
          const replay = buildPublicResult('committed', phase, null, null);
          if (!replay || !noIdLeak(replay)) return remember(failResult(FAILURE_CODE));
          return remember(okResult(replay));
        }
        if (consult.kind === 'uncertain') {
          // claimed / ambiguous — zero refetch.
          const uncertain = buildPublicResult('uncertain', null, null, null);
          if (!uncertain || !noIdLeak(uncertain)) return remember(failResult(FAILURE_CODE));
          return remember(okResult(uncertain));
        }
        if (consult.kind === 'conflict' || consult.kind === 'error') {
          return remember(failResult(FAILURE_CODE));
        }
        // absent after confirmed rollback → fall through and execute once safely.
      }

      const executed = await executePageWithOperationId(ids, operationId, fenceHolder);
      if (!noIdLeak(executed)) return remember(failResult(FAILURE_CODE));
      return remember(executed);
    }

    /**
     * Journal-only classification for the enclosed attempt id.
     * Zero Graph/grant/lease/event/cursor mutation. Never returns operation id.
     */
    async function reconcile() {
      const authority = await resolveAuthority(ids);
      if (!authority) return failResult(FAILURE_CODE);

      const fencesReady = Number.isInteger(fenceHolder.requestedGeneration)
        && fenceHolder.requestedGeneration >= 1
        && Number.isInteger(fenceHolder.requestedStateVersion)
        && fenceHolder.requestedStateVersion >= 1;
      if (!fencesReady) {
        // Fences unknown — cannot classify; honest evidence unavailable.
        const out = buildPublicResult('evidence_unavailable', null, null, null);
        return out && noIdLeak(out) ? okResult(out) : failResult(FAILURE_CODE);
      }

      const consult = await consultPageCommitJournal(
        ids,
        authority,
        operationId,
        Object.freeze({
          requestedGeneration: fenceHolder.requestedGeneration,
          requestedStateVersion: fenceHolder.requestedStateVersion,
        }),
      );
      if (consult.kind === 'committed') {
        const phase = consult.phase == null ? null : String(consult.phase);
        const out = buildPublicResult('committed', phase, null, null);
        return out && noIdLeak(out) ? okResult(out) : failResult(FAILURE_CODE);
      }
      if (consult.kind === 'absent') {
        const out = buildPublicResult('evidence_unavailable', null, null, null);
        return out && noIdLeak(out) ? okResult(out) : failResult(FAILURE_CODE);
      }
      if (consult.kind === 'uncertain') {
        const out = buildPublicResult('uncertain', null, null, null);
        return out && noIdLeak(out) ? okResult(out) : failResult(FAILURE_CODE);
      }
      return failResult(FAILURE_CODE);
    }

    /**
     * Process-local attempt status: last public result when available;
     * otherwise journal reconcile when fences known; otherwise open.
     */
    async function status() {
      if (lastPublicResult && exactFrozenData(lastPublicResult, RESULT_KEYS)) {
        if (!noIdLeak(lastPublicResult)) return failResult(FAILURE_CODE);
        return okResult(lastPublicResult);
      }
      const authority = await resolveAuthority(ids);
      if (!authority) return failResult(FAILURE_CODE);
      const fencesReady = Number.isInteger(fenceHolder.requestedGeneration)
        && fenceHolder.requestedGeneration >= 1
        && Number.isInteger(fenceHolder.requestedStateVersion)
        && fenceHolder.requestedStateVersion >= 1;
      if (!fencesReady) {
        const open = buildPublicResult('open', null, null, null);
        return open && noIdLeak(open) ? okResult(open) : failResult(FAILURE_CODE);
      }
      return reconcile();
    }

    const surface = Object.freeze({
      run,
      reconcile,
      status,
    });
    // Hostile: no operation id property, no non-enumerable leak, exact keys only.
    if (!exactFrozenData(surface, ATTEMPT_SURFACE_KEYS)) throw failure();
    try {
      const keys = Reflect.ownKeys(surface);
      if (keys.length !== ATTEMPT_SURFACE_KEYS.length) throw failure();
      if (keys.some((k) => typeof k !== 'string' || !ATTEMPT_SURFACE_KEYS.includes(k))) {
        throw failure();
      }
    } catch {
      throw failure();
    }
    return surface;
  }

  /**
   * Direct single-shot offline API — explicitly activation-ineligible.
   * Uses an ephemeral attempt (operation id allocated pre-Graph) but the
   * caller cannot retain the handle for same-ID replay. Prefer createPageAttempt.
   *
   * @param {object} input exact { clientId, locationId, endpointId }
   * @returns {Promise<{ok:true,value:object}|{ok:false,error:string}>}
   */
  async function runAuthorityBoundMessagesDeltaPage(input) {
    let attempt;
    try {
      attempt = createPageAttempt(input);
    } catch {
      return failResult(FAILURE_CODE);
    }
    return attempt.run();
  }

  return Object.freeze({
    createPageAttempt,
    runAuthorityBoundMessagesDeltaPage,
  });
}

module.exports = Object.freeze({
  FAILURE_CODE,
  FAILURE_MESSAGE,
  INPUT_KEYS,
  DEPENDENCY_KEYS,
  ATTEMPT_SURFACE_KEYS,
  RESULT_KEYS,
  WORKER_ID,
  PAGE_COMMIT_WORKER_ID,
  PAGE_COMMIT_OUTCOME_KEYS,
  LEASE_TTL_SECONDS,
  RESET_REASON_CURSOR_GONE,
  QUERY_VERSION,
  EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_RUNTIME_WIRED,
  EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_PERSISTENCE_READY,
  EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_LOGGING_FORBIDDEN,
  EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_SAFE_FOR_RUNTIME_ROUTE_CRON,
  EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_AUTO_BEGIN_GENERATION,
  EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_MULTIPAGE,
  EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_CALLER_DURABILITY_LIFECYCLE_READY,
  EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_ATTEMPT_API_REQUIRED_FOR_RUNTIME,
  EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_DIRECT_RUN_ACTIVATION_INELIGIBLE,
  createAuthorityBoundMessagesDeltaPageOperation,
});

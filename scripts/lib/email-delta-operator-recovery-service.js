'use strict';

/**
 * Email-delta operator recovery service (Sunset-staging; default-off).
 *
 * Thin service owner over the merged offline recovery-operation store:
 *   - getStatus
 *   - restartGeneration
 *   - reconcilePageCommit
 *
 * Factory-fixed deps only (exact keys):
 *   - withTransactionClient (exclusive loan; outer withPgClient release owner)
 *   - authorityVerifier
 *   - inboundDeltaStateStore (factory object capability)
 *   - resolveAuthorityBinding (trusted DB → private provider tenant/mailbox)
 *
 * Tenant fixed from deployment resolution (caller supplies trusted clientId
 * already resolved from Sunset deployment). Provider tenant/mailbox are loaded
 * via resolveAuthorityBinding only — never HTTP/DTO/log.
 *
 * Maps store outcomes to bounded service results for HTTP mapping:
 *   - success / replay → ok with frozen PII-free DTO
 *   - conflict / not_committed / evidence_unavailable / operation_id_conflict → conflict
 *   - commit_outcome_unknown → uncertain (HTTP 503; never success/retry/new ID)
 *   - invalid input / authority → invalid / not_found
 *
 * No auto-410. No event/cursor/gen/lease mutation on reconcile.
 * Logless except allowlisted correlation IDs at the route layer.
 *
 * @module email-delta-operator-recovery-service
 */

const util = require('util');

const {
  snapshotOwnDataProps,
} = require('./email-grant-envelope-provider-contract');
const {
  createEmailDeltaRecoveryOperationStore,
  RECOVERY_STATUS_KEYS,
  RECOVERY_RESULT_KEYS,
  OUTCOMES,
} = require('./email-delta-recovery-operation-store');

const FAILURE_CODE = 'email_delta_operator_recovery_service_failed';
const FAILURE_MESSAGE = 'Email delta operator recovery service failed.';

const SERVICE_DEPENDENCY_KEYS = Object.freeze([
  'withTransactionClient',
  'authorityVerifier',
  'inboundDeltaStateStore',
  'resolveAuthorityBinding',
]);

const STATUS_INPUT_KEYS = Object.freeze([
  'clientId',
  'locationId',
  'endpointId',
]);

const RESTART_INPUT_KEYS = Object.freeze([
  'operationId',
  'clientId',
  'locationId',
  'endpointId',
  'actorStaffUserId',
  'expectedGeneration',
  'expectedStateVersion',
]);

const RECONCILE_INPUT_KEYS = Object.freeze([
  'operationId',
  'clientId',
  'locationId',
  'endpointId',
  'actorStaffUserId',
  'expectedGeneration',
  'expectedStateVersion',
  'targetOperationId',
]);

/** Bounded HTTP-facing outcome classes (route maps these). */
const SERVICE_OUTCOME = Object.freeze({
  SUCCESS: 'success',
  CONFLICT: 'conflict',
  UNCERTAIN: 'uncertain',
  NOT_FOUND: 'not_found',
  INVALID: 'invalid',
  UNAVAILABLE: 'unavailable',
});

const CONFLICT_STORE_ERRORS = new Set([
  'operation_id_conflict',
  'generation_cas_conflict',
]);

const CONFLICT_OUTCOMES = new Set([
  'conflict',
  'not_committed',
  'evidence_unavailable',
]);

const PINNED_UTIL_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_UTIL_TYPES && typeof PINNED_UTIL_TYPES.isProxy === 'function'
  ? PINNED_UTIL_TYPES.isProxy
  : null;
const PINNED_OBJECT_PROTOTYPE = Object.prototype;
const PINNED_REFLECT_APPLY = typeof Reflect.apply === 'function' ? Reflect.apply : null;
const PINNED_REFLECT_OWN_KEYS = typeof Reflect.ownKeys === 'function' ? Reflect.ownKeys : null;
const PINNED_GET_OWN_PROPERTY_DESCRIPTOR =
  typeof Object.getOwnPropertyDescriptor === 'function' ? Object.getOwnPropertyDescriptor : null;
const PINNED_GET_PROTOTYPE_OF =
  typeof Object.getPrototypeOf === 'function' ? Object.getPrototypeOf : null;
const PINNED_OBJECT_FREEZE =
  typeof Object.freeze === 'function' ? Object.freeze : null;
const PINNED_IS_FROZEN =
  typeof Object.isFrozen === 'function' ? Object.isFrozen : null;
const PINNED_HAS_OWN =
  typeof Object.prototype.hasOwnProperty === 'function'
    ? Object.prototype.hasOwnProperty
    : null;

const PINNED_INTRINSICS_READY = Boolean(
  PINNED_IS_PROXY
  && PINNED_UTIL_TYPES
  && PINNED_REFLECT_APPLY
  && PINNED_REFLECT_OWN_KEYS
  && PINNED_GET_OWN_PROPERTY_DESCRIPTOR
  && PINNED_GET_PROTOTYPE_OF
  && PINNED_OBJECT_FREEZE
  && PINNED_IS_FROZEN
  && PINNED_HAS_OWN
  && PINNED_OBJECT_PROTOTYPE,
);

function pinnedFreeze(value) {
  return PINNED_OBJECT_FREEZE.call(Object, value);
}

function failure(code) {
  const error = new Error(FAILURE_MESSAGE);
  Object.defineProperty(error, 'name', { value: 'EmailDeltaOperatorRecoveryServiceError' });
  Object.defineProperty(error, 'code', {
    value: typeof code === 'string' && code ? code : FAILURE_CODE,
    enumerable: true,
  });
  return pinnedFreeze(error);
}

function isProxySurface(value) {
  try {
    if (!PINNED_INTRINSICS_READY) return true;
    return PINNED_REFLECT_APPLY.call(Reflect, PINNED_IS_PROXY, PINNED_UTIL_TYPES, [value]) === true;
  } catch {
    return true;
  }
}

function safeHasOwn(object, key) {
  try {
    if (!PINNED_HAS_OWN || object == null) return false;
    return PINNED_HAS_OWN.call(object, key) === true;
  } catch {
    return false;
  }
}

function ownData(object, key) {
  try {
    if (!PINNED_GET_OWN_PROPERTY_DESCRIPTOR || !PINNED_HAS_OWN) return undefined;
    const descriptor = PINNED_GET_OWN_PROPERTY_DESCRIPTOR.call(Object, object, key);
    return descriptor
      && PINNED_HAS_OWN.call(descriptor, 'value')
      && !descriptor.get
      && !descriptor.set
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function exactOwnDataKeys(object, keys) {
  try {
    if (object == null || typeof object !== 'object' || Array.isArray(object)) return false;
    if (!PINNED_INTRINSICS_READY) return false;
    if (isProxySurface(object)) return false;
    const actual = PINNED_REFLECT_OWN_KEYS.call(Reflect, object);
    if (actual.length !== keys.length) return false;
    for (let i = 0; i < keys.length; i += 1) {
      if (actual[i] !== keys[i] || typeof actual[i] !== 'string') return false;
      const desc = PINNED_GET_OWN_PROPERTY_DESCRIPTOR.call(Object, object, keys[i]);
      if (!desc
          || !safeHasOwn(desc, 'value')
          || desc.get
          || desc.set
          || desc.enumerable !== true) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function serviceResult(kind, payload) {
  if (kind === SERVICE_OUTCOME.SUCCESS) {
    return pinnedFreeze({ ok: true, kind, value: payload });
  }
  return pinnedFreeze({
    ok: false,
    kind,
    error: typeof payload === 'string' && payload ? payload : FAILURE_CODE,
    value: payload && typeof payload === 'object' ? payload : undefined,
  });
}

function mapStoreStatus(result) {
  if (!result || result.ok !== true || !result.value) {
    if (result && result.error === 'input_invalid') {
      return serviceResult(SERVICE_OUTCOME.INVALID, 'invalid_request');
    }
    return serviceResult(SERVICE_OUTCOME.UNAVAILABLE, 'operator_recovery_unavailable');
  }
  const v = result.value;
  const out = {};
  for (const key of RECOVERY_STATUS_KEYS) {
    out[key] = v[key];
  }
  return serviceResult(SERVICE_OUTCOME.SUCCESS, pinnedFreeze(out));
}

function mapStoreOperation(result) {
  if (!result) {
    return serviceResult(SERVICE_OUTCOME.UNAVAILABLE, 'operator_recovery_unavailable');
  }
  if (result.ok === true && result.value) {
    const v = result.value;
    const outcome = String(v.outcome || '');
    const out = {};
    for (const key of RECOVERY_RESULT_KEYS) {
      out[key] = v[key];
    }
    const frozen = pinnedFreeze(out);
    if (CONFLICT_OUTCOMES.has(outcome)) {
      return serviceResult(SERVICE_OUTCOME.CONFLICT, frozen);
    }
    if (outcome === 'commit_outcome_unknown') {
      return serviceResult(SERVICE_OUTCOME.UNCERTAIN, frozen);
    }
    if (outcome === 'committed' || outcome === 'claimed') {
      // claimed should not escape as durable success; fail closed.
      if (outcome === 'claimed') {
        return serviceResult(SERVICE_OUTCOME.UNAVAILABLE, 'operator_recovery_unavailable');
      }
      return serviceResult(SERVICE_OUTCOME.SUCCESS, frozen);
    }
    return serviceResult(SERVICE_OUTCOME.UNAVAILABLE, 'operator_recovery_unavailable');
  }

  const err = typeof result.error === 'string' ? result.error : FAILURE_CODE;
  if (err === 'commit_outcome_unknown') {
    return serviceResult(SERVICE_OUTCOME.UNCERTAIN, 'commit_outcome_unknown');
  }
  if (CONFLICT_STORE_ERRORS.has(err)) {
    return serviceResult(SERVICE_OUTCOME.CONFLICT, err);
  }
  if (err === 'authority_not_verified'
      || err === 'client_id_invalid'
      || err === 'location_id_invalid'
      || err === 'endpoint_id_invalid'
      || err === 'operation_id_invalid'
      || err === 'target_operation_id_invalid'
      || err === 'actor_staff_user_id_invalid'
      || err === 'input_invalid'
      || err === 'provider_tenant_id_invalid'
      || err === 'provider_mailbox_id_invalid') {
    return serviceResult(SERVICE_OUTCOME.INVALID, 'invalid_request');
  }
  return serviceResult(SERVICE_OUTCOME.UNAVAILABLE, 'operator_recovery_unavailable');
}

function snapshotServiceInput(input, keys) {
  try {
    if (!exactOwnDataKeys(input, keys) && !exactOwnDataKeys(
      // also accept frozen key-order independent own-data after snapshot
      input && typeof input === 'object' ? input : null,
      keys,
    )) {
      // Fall back to snapshotOwnDataProps + exact key set (order-flexible).
      if (input == null || typeof input !== 'object' || Array.isArray(input)) {
        return null;
      }
      if (isProxySurface(input)) return null;
      const snap = snapshotOwnDataProps(input);
      if (!snap.ok) return null;
      const keySet = new Set(Object.keys(snap.value));
      if (keySet.size !== keys.length) return null;
      for (const k of keys) {
        if (!keySet.has(k)) return null;
      }
      // Reject forbidden provider/client/HTTP inheritance fields if present.
      const forbidden = [
        'providerTenantId', 'providerMailboxId', 'provider_tenant_id',
        'provider_mailbox_id', 'client_slug', 'clientSlug', 'client_id',
        'verifiedAuthority', 'mailbox', 'public_address', 'accessToken',
      ];
      for (const f of forbidden) {
        if (Object.prototype.hasOwnProperty.call(snap.value, f)) return null;
      }
      const out = {};
      for (const k of keys) {
        out[k] = snap.value[k];
      }
      return pinnedFreeze(out);
    }
    const out = {};
    for (const k of keys) {
      out[k] = ownData(input, k);
    }
    return pinnedFreeze(out);
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   withTransactionClient: Function,
 *   authorityVerifier: { verifyBinding: Function },
 *   inboundDeltaStateStore: object,
 *   resolveAuthorityBinding: Function,
 * }} deps
 */
function createEmailDeltaOperatorRecoveryService(deps) {
  let withTransactionClient;
  let authorityVerifier;
  let inboundDeltaStateStore;
  let resolveAuthorityBinding;
  let store;
  try {
    if (deps == null || typeof deps !== 'object' || Array.isArray(deps)) throw failure();
    if (isProxySurface(deps)) throw failure();
    const snap = snapshotOwnDataProps(deps);
    if (!snap.ok) throw failure();
    const keySet = new Set(Object.keys(snap.value));
    if (keySet.size !== SERVICE_DEPENDENCY_KEYS.length) throw failure();
    for (const k of SERVICE_DEPENDENCY_KEYS) {
      if (!keySet.has(k)) throw failure();
    }
    withTransactionClient = snap.value.withTransactionClient;
    authorityVerifier = snap.value.authorityVerifier;
    inboundDeltaStateStore = snap.value.inboundDeltaStateStore;
    resolveAuthorityBinding = snap.value.resolveAuthorityBinding;
    if (typeof withTransactionClient !== 'function'
        || isProxySurface(withTransactionClient)) {
      throw failure();
    }
    if (!authorityVerifier || typeof authorityVerifier !== 'object'
        || typeof authorityVerifier.verifyBinding !== 'function'
        || isProxySurface(authorityVerifier)) {
      throw failure();
    }
    if (!inboundDeltaStateStore || typeof inboundDeltaStateStore !== 'object'
        || isProxySurface(inboundDeltaStateStore)) {
      throw failure();
    }
    if (typeof resolveAuthorityBinding !== 'function'
        || isProxySurface(resolveAuthorityBinding)) {
      throw failure();
    }
    store = createEmailDeltaRecoveryOperationStore(Object.freeze({
      withTransactionClient,
      authorityVerifier,
      inboundDeltaStateStore,
    }));
  } catch (err) {
    if (err && err.code === FAILURE_CODE) throw err;
    throw failure();
  }

  async function loadPrivateProviderBinding(ids) {
    let loaded;
    try {
      loaded = await resolveAuthorityBinding(pinnedFreeze({
        clientId: ids.clientId,
        locationId: ids.locationId,
        endpointId: ids.endpointId,
      }));
    } catch {
      return null;
    }
    if (!loaded || loaded.ok !== true || !loaded.value) return null;
    const v = loaded.value;
    const tenant = v.providerTenantId;
    const mailbox = v.providerMailboxId;
    if (typeof tenant !== 'string' || typeof mailbox !== 'string') return null;
    if (String(v.clientId || '').toLowerCase() !== ids.clientId
        || String(v.locationId || '').toLowerCase() !== ids.locationId
        || String(v.endpointId || '').toLowerCase() !== ids.endpointId) {
      return null;
    }
    // Private only — never returned to HTTP.
    return pinnedFreeze({
      providerTenantId: String(tenant).toLowerCase(),
      providerMailboxId: String(mailbox).toLowerCase(),
    });
  }

  async function getStatus(input) {
    const ids = snapshotServiceInput(input, STATUS_INPUT_KEYS);
    if (!ids) return serviceResult(SERVICE_OUTCOME.INVALID, 'invalid_request');
    try {
      // Status does not require provider fields; uses trusted client/endpoint only.
      const result = await store.getRecoveryStatus(pinnedFreeze({
        clientId: ids.clientId,
        endpointId: ids.endpointId,
      }));
      return mapStoreStatus(result);
    } catch {
      return serviceResult(SERVICE_OUTCOME.UNAVAILABLE, 'operator_recovery_unavailable');
    }
  }

  async function restartGeneration(input) {
    const ids = snapshotServiceInput(input, RESTART_INPUT_KEYS);
    if (!ids) return serviceResult(SERVICE_OUTCOME.INVALID, 'invalid_request');
    try {
      const provider = await loadPrivateProviderBinding(ids);
      if (!provider) {
        return serviceResult(SERVICE_OUTCOME.NOT_FOUND, 'endpoint_not_found');
      }
      const result = await store.restartGeneration(pinnedFreeze({
        operationId: ids.operationId,
        clientId: ids.clientId,
        locationId: ids.locationId,
        endpointId: ids.endpointId,
        actorStaffUserId: ids.actorStaffUserId,
        expectedGeneration: ids.expectedGeneration,
        expectedStateVersion: ids.expectedStateVersion,
        providerTenantId: provider.providerTenantId,
        providerMailboxId: provider.providerMailboxId,
      }));
      return mapStoreOperation(result);
    } catch {
      return serviceResult(SERVICE_OUTCOME.UNAVAILABLE, 'operator_recovery_unavailable');
    }
  }

  async function reconcilePageCommit(input) {
    const ids = snapshotServiceInput(input, RECONCILE_INPUT_KEYS);
    if (!ids) return serviceResult(SERVICE_OUTCOME.INVALID, 'invalid_request');
    try {
      const provider = await loadPrivateProviderBinding(ids);
      if (!provider) {
        return serviceResult(SERVICE_OUTCOME.NOT_FOUND, 'endpoint_not_found');
      }
      const result = await store.reconcilePageCommit(pinnedFreeze({
        operationId: ids.operationId,
        targetOperationId: ids.targetOperationId,
        clientId: ids.clientId,
        locationId: ids.locationId,
        endpointId: ids.endpointId,
        actorStaffUserId: ids.actorStaffUserId,
        expectedGeneration: ids.expectedGeneration,
        expectedStateVersion: ids.expectedStateVersion,
        providerTenantId: provider.providerTenantId,
        providerMailboxId: provider.providerMailboxId,
      }));
      return mapStoreOperation(result);
    } catch {
      return serviceResult(SERVICE_OUTCOME.UNAVAILABLE, 'operator_recovery_unavailable');
    }
  }

  return pinnedFreeze({
    getStatus,
    restartGeneration,
    reconcilePageCommit,
  });
}

module.exports = pinnedFreeze({
  FAILURE_CODE,
  FAILURE_MESSAGE,
  SERVICE_DEPENDENCY_KEYS,
  STATUS_INPUT_KEYS,
  RESTART_INPUT_KEYS,
  RECONCILE_INPUT_KEYS,
  SERVICE_OUTCOME,
  RECOVERY_STATUS_KEYS,
  RECOVERY_RESULT_KEYS,
  OUTCOMES,
  createEmailDeltaOperatorRecoveryService,
});

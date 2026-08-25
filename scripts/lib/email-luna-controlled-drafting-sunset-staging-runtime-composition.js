'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 3.
 *
 * Disabled-by-default Sunset staging runtime composition. Consumes authentic
 * Stage 1 issuance material, reserves/claims the Chapter 2 operation store,
 * and invokes only the Chapter 1 draft-only provider surface.
 *
 * Unknown-outcome proof (Microsoft Graph createReply):
 * - POST /users/{id}/messages/{id}/createReply is not idempotent. Each call
 *   creates a new draft. client-request-id is correlation, not idempotency.
 * - Clients cannot assign Graph message `id`. Chapter 1 reconcileDraft is
 *   GET by provider_draft_id only. Chapter 1 has no list/search/filter.
 * - A lost createReply response therefore cannot be observed without a
 *   persisted draft id. This runtime never invents a search API.
 * - Fail-closed at-most-once is the Chapter 2 claim bit: create is invoked
 *   only on first claim authority. Repeat/restart/timeout/abort never
 *   create again. Unknown without a persisted draft id is
 *   `unknown_create_unobservable` — no provider call, never recreate-ready.
 * - Known draft id is GET-reconciled through Chapter 1 only.
 * - Fake-transport idempotency is not live Graph at-most-once.
 *
 * Disablement: no new reserve, claim, or provider create/reconcile.
 * Already-unknown work is surfaced blocked; provider calls do not continue.
 *
 * Unwired: not imported by Staff API, not activated in docker, no live Graph.
 */

const util = require('node:util');
const {
  createEmailLunaControlledDraftingOperationStore,
  ACK_KEYS,
  EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_RUNTIME_WIRED,
} = require('./email-luna-controlled-drafting-operation-store');
const {
  createEmailLunaAutomationIssuanceMaterialStore,
} = require('./email-luna-automation-issuance-material-store');
const {
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_WIRED,
  EMAIL_LUNA_CONTROLLED_DRAFTING_ACTIVATION,
  EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER,
  EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_KEY,
  EMAIL_LUNA_CONTROLLED_DRAFTING_CAPABILITY_MANIFEST,
} = require('./email-luna-controlled-drafting-provider-contract');

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const PINNED_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_TYPES && typeof PINNED_TYPES.isProxy === 'function'
  ? PINNED_TYPES.isProxy.bind(PINNED_TYPES)
  : null;

const arrayIncludes = uncurryThis(Array.prototype.includes);
const objectCreate = Object.create;
const objectDefineProperty = Object.defineProperty;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const objectPrototype = Object.prototype;
const reflectOwnKeys = Reflect.ownKeys;
const arrayIsArray = Array.isArray;
const regexpTest = uncurryThis(RegExp.prototype.test);
const stringTrim = uncurryThis(String.prototype.trim);
const stringToLowerCase = uncurryThis(String.prototype.toLowerCase);

const EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_WIRED = true;
const EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ACTIVATION = false;
const EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_LOGGING_FORBIDDEN = true;
const EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_SEND_ALLOWED = false;
const EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_JOURNAL_HANDOFF = false;

const ENV_COMPOSITION_ENABLED = 'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED';
const ENV_CLIENT_ID = 'EMAIL_LUNA_CONTROLLED_DRAFTING_CLIENT_ID';
const ENV_LOCATION_ID = 'EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_ID';
const ENV_LOCATION_KEY = 'EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_KEY';
const ENV_ENDPOINT_ID = 'EMAIL_LUNA_CONTROLLED_DRAFTING_ENDPOINT_ID';
const ENV_MAILBOX_ID = 'EMAIL_LUNA_CONTROLLED_DRAFTING_MAILBOX_ID';
const ENV_PROVIDER = 'EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER';
const ENV_DEPLOYMENT = 'LUNA_DEPLOYMENT';
const ENV_TENANT = 'DEFAULT_CLIENT_SLUG';
const ENV_AUTO_SEND = 'LUNA_AUTO_SEND_ENABLED';
const ENV_DRAFT_RUNTIME = 'EMAIL_LUNA_DRAFT_RUNTIME_ENABLED';
const ENV_SHADOW = 'EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ENABLED';

const SUNSET_DEPLOYMENT = 'sunset-staging';
const SUNSET_TENANT = 'sunset';
const SUNSET_LOCATION_KEY = EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_KEY;
const CONTROLLED_DRAFTING_MODE = 'controlled_drafting';
const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ERROR_CODE = 'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_INVALID';
const ERROR_MESSAGE = 'Email Luna controlled drafting runtime composition failed.';
const DISABLED_CODE = 'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_DISABLED';
const DISABLED_MESSAGE = 'Email Luna controlled drafting runtime composition disabled.';

const EMAIL_LUNA_CONTROLLED_DRAFTING_UNKNOWN_CREATE_POLICY = objectFreeze({
  graph_createreply_idempotent: false,
  client_request_id_is_idempotency: false,
  chapter1_reconcile_requires_provider_draft_id: true,
  chapter1_has_search: false,
  lost_create_response_observable: false,
  first_claim_create_at_most_once: true,
  unknown_without_draft_id: 'unknown_create_unobservable',
  unknown_without_draft_id_provider_calls: false,
  unknown_without_draft_id_recreate: false,
  disablement_provider_calls: false,
  disablement_unknown: 'surface_blocked_no_provider_calls',
  fake_transport_is_not_live_graph_at_most_once: true,
});

const PROVIDER_SURFACE_KEYS = objectFreeze(['attest', 'createReplyDraft', 'reconcileDraft']);
const FORBIDDEN_PROVIDER_KEYS = objectFreeze([
  'send', 'sendDraft', 'sendMail', 'scheduleSend', 'forward', 'createForward',
  'reply', 'replyAll', 'createReplyAll', 'request', 'https', 'http', 'client',
  'graphClient', 'accessToken', 'access_token', 'fetch', 'path', 'url', 'method',
]);
const CREATE_KEYS = objectFreeze([
  'env', 'producerWithTransactionClient', 'workerWithTransactionClient', 'provider',
]);
const OPTIONAL_CREATE_KEYS = objectFreeze([
  'crashSeams', 'issuanceStore',
]);
const CRASH_SEAM_KEYS = objectFreeze([
  'before_claim',
  'after_claim_before_provider',
  'during_provider',
  'after_provider_before_record',
  'after_record',
]);
const RESERVE_INPUT_KEYS = objectFreeze(['material']);
const TICK_INPUT_KEYS = objectFreeze(['operation']);
const FORBIDDEN_FIELD_NAMES = objectFreeze([
  'access_token', 'refresh_token', 'id_token', 'accessToken', 'refreshToken',
  'Authorization', 'authorization', 'token', 'client_secret', 'password',
  'api_key', 'raw_secret',
]);
const FORBIDDEN_CREATE_KEYS = objectFreeze([
  'send', 'onSend', 'https', 'graph', 'transport', 'callback', 'fetch',
  'authorize_send', 'journal', 'accessToken',
]);

if (EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_WIRED !== true
    || EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ACTIVATION !== false
    || EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_WIRED !== false
    || EMAIL_LUNA_CONTROLLED_DRAFTING_ACTIVATION !== false
    || EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_RUNTIME_WIRED !== false) {
  throw new Error('controlled_drafting_runtime_composition_activation_unexpected');
}
if (EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_SEND_ALLOWED !== false
    || EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_JOURNAL_HANDOFF !== false) {
  throw new Error('controlled_drafting_runtime_send_not_absent');
}

function invalid() {
  const error = new Error(ERROR_MESSAGE);
  error.code = ERROR_CODE;
  return objectFreeze(error);
}

function disabledError() {
  const error = new Error(DISABLED_MESSAGE);
  error.code = DISABLED_CODE;
  return objectFreeze(error);
}

function rethrowAsRuntime(error) {
  if (error && error.code === ERROR_CODE) throw error;
  if (error && error.code === DISABLED_CODE) throw error;
  throw invalid();
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

function isProxySurface(value) {
  try {
    if (!PINNED_IS_PROXY) return true;
    return PINNED_IS_PROXY(value) === true;
  } catch (_) {
    return true;
  }
}

function safeOwnKeys(value) {
  try {
    return reflectOwnKeys(value);
  } catch (_) {
    throw invalid();
  }
}

function rejectForbiddenFields(record) {
  const keys = safeOwnKeys(record);
  for (let i = 0; i < keys.length; i += 1) {
    if (arrayIncludes(FORBIDDEN_FIELD_NAMES, keys[i])) return false;
  }
  return true;
}

function exactPlain(value, keys) {
  if (value === null || typeof value !== 'object' || isProxySurface(value) || arrayIsArray(value)) throw invalid();
  try {
    const proto = objectGetPrototypeOf(value);
    if (proto !== objectPrototype && proto !== null) throw invalid();
    const ownKeys = safeOwnKeys(value);
    if (ownKeys.length !== keys.length) throw invalid();
    if (!rejectForbiddenFields(value)) throw invalid();
    const snapshot = objectCreate(null);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (!arrayIncludes(ownKeys, key)) throw invalid();
      const descriptor = objectGetOwnPropertyDescriptor(value, key);
      if (!descriptor || !objectHasOwn(descriptor, 'value') || descriptor.get || descriptor.set) throw invalid();
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch (error) {
    if (error && error.code === ERROR_CODE) throw error;
    throw invalid();
  }
}

function subsetPlain(value, allowed) {
  if (value === null || typeof value !== 'object' || isProxySurface(value) || arrayIsArray(value)) throw invalid();
  try {
    const proto = objectGetPrototypeOf(value);
    if (proto !== objectPrototype && proto !== null) throw invalid();
    const ownKeys = safeOwnKeys(value);
    if (!rejectForbiddenFields(value)) throw invalid();
    const snapshot = objectCreate(null);
    for (let index = 0; index < ownKeys.length; index += 1) {
      const key = ownKeys[index];
      if (typeof key !== 'string' || !arrayIncludes(allowed, key)) throw invalid();
      const descriptor = objectGetOwnPropertyDescriptor(value, key);
      if (!descriptor || !objectHasOwn(descriptor, 'value') || descriptor.get || descriptor.set) throw invalid();
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch (error) {
    if (error && error.code === ERROR_CODE) throw error;
    throw invalid();
  }
}

function ownData(value, key) {
  try {
    if (!value || typeof value !== 'object' || isProxySurface(value) || arrayIsArray(value)) return undefined;
    const descriptor = objectGetOwnPropertyDescriptor(value, key);
    if (!descriptor || !objectHasOwn(descriptor, 'value') || descriptor.get || descriptor.set) return undefined;
    return descriptor.value;
  } catch (_) {
    return undefined;
  }
}

function parseUuid(raw) {
  if (typeof raw !== 'string') return null;
  const id = stringToLowerCase(raw);
  if (!regexpTest(UUID_CANON, id) || stringTrim(raw) !== raw) return null;
  return id;
}

function envFlag(env, key) {
  return ownData(env, key) === 'true';
}

function isConflictTruthy(raw) {
  if (raw === true) return true;
  if (typeof raw !== 'string') return false;
  const value = stringToLowerCase(stringTrim(raw));
  return value === 'true' || value === '1' || value === 'yes' || value === 'on';
}

function readBinding(env) {
  return {
    client_id: parseUuid(ownData(env, ENV_CLIENT_ID)),
    location_id: parseUuid(ownData(env, ENV_LOCATION_ID)),
    location_key: ownData(env, ENV_LOCATION_KEY),
    endpoint_id: parseUuid(ownData(env, ENV_ENDPOINT_ID)),
    mailbox_id: parseUuid(ownData(env, ENV_MAILBOX_ID)),
    provider: ownData(env, ENV_PROVIDER),
  };
}

function flagsExact(env) {
  return envFlag(env, ENV_COMPOSITION_ENABLED)
    && ownData(env, ENV_DEPLOYMENT) === SUNSET_DEPLOYMENT
    && ownData(env, ENV_TENANT) === SUNSET_TENANT
    && ownData(env, ENV_LOCATION_KEY) === SUNSET_LOCATION_KEY
    && ownData(env, ENV_PROVIDER) === EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER;
}

function bindingComplete(binding) {
  return Boolean(binding.client_id && binding.location_id && binding.endpoint_id
    && binding.mailbox_id && binding.location_key === SUNSET_LOCATION_KEY
    && binding.provider === EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER);
}

function substituteAttempt(env) {
  if (envFlag(env, ENV_COMPOSITION_ENABLED)) return false;
  return envFlag(env, ENV_DRAFT_RUNTIME) || envFlag(env, ENV_SHADOW);
}

function presentFlagCount(env) {
  return ownData(env, ENV_COMPOSITION_ENABLED) === undefined ? 0 : 1;
}

function evidenceBase(reason, extra) {
  const entries = [
    ['ok', extra && extra.ok === true],
    ['runtime_activation', extra && extra.runtime_activation === true],
    ['composition_wired', true],
    ['provider_capability', extra && extra.provider_capability === true],
    ['create_capability', extra && extra.provider_capability === true],
    ['send_allowed', false],
    ['journal_handoff', false],
    ['mode', CONTROLLED_DRAFTING_MODE],
    ['reason', reason],
  ];
  return output(entries);
}

function resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness(env) {
  const inert = evidenceBase('default_off', { ok: true, runtime_activation: false, provider_capability: false });
  try {
    if (!env || typeof env !== 'object' || isProxySurface(env) || arrayIsArray(env)) {
      return evidenceBase('invalid_env', { ok: false, runtime_activation: false, provider_capability: false });
    }
    if (isConflictTruthy(ownData(env, ENV_AUTO_SEND))) {
      return evidenceBase('provider_capability_refused', { ok: false, runtime_activation: false, provider_capability: false });
    }
    const binding = readBinding(env);
    if (!flagsExact(env) || !bindingComplete(binding)) {
      const flagsAbsent = presentFlagCount(env) === 0;
      const reason = flagsAbsent
        ? 'default_off'
        : (substituteAttempt(env) ? 'flag_substitution' : 'partial_or_mismatched_gates');
      return evidenceBase(reason, {
        ok: flagsAbsent,
        runtime_activation: false,
        provider_capability: false,
      });
    }
    return evidenceBase('exact_sunset_gates', {
      ok: true,
      runtime_activation: true,
      provider_capability: true,
    });
  } catch (_) {
    return inert;
  }
}

function refuseForbiddenCreateKeys(value) {
  const ownKeys = safeOwnKeys(value);
  for (let index = 0; index < ownKeys.length; index += 1) {
    if (arrayIncludes(FORBIDDEN_CREATE_KEYS, ownKeys[index])) throw invalid();
  }
}

function closedProvider(provider) {
  if (!provider || typeof provider !== 'object' || isProxySurface(provider) || arrayIsArray(provider)) {
    throw invalid();
  }
  const proto = objectGetPrototypeOf(provider);
  if (proto !== objectPrototype && proto !== null) throw invalid();
  const keys = safeOwnKeys(provider);
  if (keys.length !== PROVIDER_SURFACE_KEYS.length) throw invalid();
  for (let i = 0; i < PROVIDER_SURFACE_KEYS.length; i += 1) {
    if (!arrayIncludes(keys, PROVIDER_SURFACE_KEYS[i])) throw invalid();
    const fn = ownData(provider, PROVIDER_SURFACE_KEYS[i]);
    if (typeof fn !== 'function' || isProxySurface(fn)) throw invalid();
  }
  for (let i = 0; i < FORBIDDEN_PROVIDER_KEYS.length; i += 1) {
    if (objectHasOwn(provider, FORBIDDEN_PROVIDER_KEYS[i])) throw invalid();
  }
  let attest;
  try {
    attest = provider.attest();
  } catch (_) {
    throw invalid();
  }
  if (!attest || attest.create_reply_draft === false) throw invalid();
  const caps = ownData(attest, 'capabilities') || attest.capabilities;
  if (caps && (caps.send === true || caps.send_draft === true || caps.send_mail === true
      || caps.generic_http === true || caps.raw_sdk === true || caps.access_token_export === true)) {
    throw invalid();
  }
  if (EMAIL_LUNA_CONTROLLED_DRAFTING_CAPABILITY_MANIFEST.capabilities.send !== false) throw invalid();
  return freeze({
    attest: ownData(provider, 'attest'),
    createReplyDraft: ownData(provider, 'createReplyDraft'),
    reconcileDraft: ownData(provider, 'reconcileDraft'),
  });
}

function fireCrash(seams, name) {
  if (!seams || !objectHasOwn(seams, name)) return;
  const hook = seams[name];
  if (hook === true) throw invalid();
  if (typeof hook === 'function' && !isProxySurface(hook)) hook();
}

function readDraftCanonical(draft) {
  if (!draft || typeof draft !== 'object' || isProxySurface(draft) || arrayIsArray(draft)) throw invalid();
  const subject = ownData(draft, 'subject');
  const body = ownData(draft, 'body');
  const language = ownData(draft, 'language');
  if (typeof subject !== 'string' || typeof body !== 'string') throw invalid();
  if (language !== 'en' && language !== 'es') throw invalid();
  return { subject, body, language };
}

function matchBinding(record, binding) {
  return record.client_id === binding.client_id
    && record.location_id === binding.location_id
    && record.location_key === binding.location_key
    && record.endpoint_id === binding.endpoint_id
    && record.mailbox_id === binding.mailbox_id
    && record.provider === binding.provider;
}

function tickEvidence(fields) {
  return output([
    ['status', fields.status],
    ['reason', fields.reason],
    ['operation_id', fields.operation_id || null],
    ['issuance_id', fields.issuance_id || null],
    ['state', fields.state || null],
    ['provider_invoked', fields.provider_invoked === true],
    ['create_invoked', fields.create_invoked === true],
    ['reconcile_invoked', fields.reconcile_invoked === true],
    ['send_allowed', false],
    ['journal_handoff', false],
    ['mode', CONTROLLED_DRAFTING_MODE],
  ]);
}

function createRequestFromOperation(record) {
  const request = {};
  request.client_id = record.client_id;
  request.location_id = record.location_id;
  request.location_key = record.location_key;
  request.endpoint_id = record.endpoint_id;
  request.provider = record.provider;
  request.mailbox_id = record.mailbox_id;
  request.inbound_provider_message_id = record.inbound_provider_message_id;
  request.inbound_provider_thread_id = record.inbound_provider_thread_id;
  request.recipient_address = record.recipient_address;
  request.subject = record.canonical_subject;
  request.body_text = record.canonical_body;
  request.subject_digest = record.subject_digest;
  request.body_digest = record.body_digest;
  request.issuance_id = record.issuance_id;
  request.operation_id = record.operation_id;
  return request;
}

function reconcileRequestFromOperation(record) {
  const request = {};
  request.client_id = record.client_id;
  request.location_id = record.location_id;
  request.location_key = record.location_key;
  request.endpoint_id = record.endpoint_id;
  request.provider = record.provider;
  request.mailbox_id = record.mailbox_id;
  request.inbound_provider_message_id = record.inbound_provider_message_id;
  request.inbound_provider_thread_id = record.inbound_provider_thread_id;
  request.recipient_address = record.recipient_address;
  request.subject_digest = record.subject_digest;
  request.body_digest = record.body_digest;
  request.issuance_id = record.issuance_id;
  request.operation_id = record.operation_id;
  request.provider_draft_id = record.provider_draft_id;
  return request;
}

function acknowledgementFromCreate(result) {
  const ack = {};
  for (let i = 0; i < ACK_KEYS.length; i += 1) {
    const key = ACK_KEYS[i];
    if (key === 'is_draft') ack[key] = true;
    else ack[key] = ownData(result, key);
  }
  return ack;
}

function observationFromReconcile(result, record) {
  const outcome = ownData(result, 'outcome');
  if (outcome === 'draft_present' && ownData(result, 'is_draft') === true) {
    return {
      kind: 'exact',
      provider_draft_id: ownData(result, 'provider_draft_id'),
      is_draft: true,
      subject_digest: record.subject_digest,
      body_digest: record.body_digest,
    };
  }
  if (outcome === 'draft_modified' && ownData(result, 'is_draft') === true) {
    return {
      kind: 'modified_by_staff',
      provider_draft_id: record.provider_draft_id,
      is_draft: true,
    };
  }
  if (outcome === 'draft_not_found') {
    if (record.provider_draft_id && (record.state === 'provider_draft_reconciled_exact'
        || record.state === 'provider_draft_modified_by_staff')) {
      return { kind: 'removed_by_staff', provider_draft_id: record.provider_draft_id };
    }
    return { kind: 'not_found' };
  }
  if (outcome === 'draft_mismatch') {
    return { kind: 'provider_mismatch' };
  }
  throw invalid();
}

function createEmailLunaControlledDraftingSunsetStagingRuntimeComposition(dependencies) {
  if (arguments.length !== 1) throw invalid();
  refuseForbiddenCreateKeys(dependencies);
  const allowed = [];
  for (let i = 0; i < CREATE_KEYS.length; i += 1) allowed.push(CREATE_KEYS[i]);
  for (let i = 0; i < OPTIONAL_CREATE_KEYS.length; i += 1) allowed.push(OPTIONAL_CREATE_KEYS[i]);
  const deps = subsetPlain(dependencies, objectFreeze(allowed));
  for (let i = 0; i < CREATE_KEYS.length; i += 1) {
    if (!objectHasOwn(deps, CREATE_KEYS[i])) throw invalid();
  }
  const env = deps.env;
  const readiness = resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness(env);
  if (!readiness || readiness.runtime_activation !== true) throw disabledError();
  const binding = readBinding(env);
  if (!bindingComplete(binding)) throw disabledError();
  const producerLoaner = deps.producerWithTransactionClient;
  const workerLoaner = deps.workerWithTransactionClient;
  if (typeof producerLoaner !== 'function' || isProxySurface(producerLoaner)) throw invalid();
  if (typeof workerLoaner !== 'function' || isProxySurface(workerLoaner)) throw invalid();
  const provider = closedProvider(deps.provider);
  let crashSeams = null;
  if (objectHasOwn(deps, 'crashSeams')) {
    crashSeams = subsetPlain(deps.crashSeams, CRASH_SEAM_KEYS);
  }
  const producerStore = createEmailLunaControlledDraftingOperationStore({
    withTransactionClient: producerLoaner,
  });
  const workerStore = createEmailLunaControlledDraftingOperationStore({
    withTransactionClient: workerLoaner,
  });
  const issuanceStore = objectHasOwn(deps, 'issuanceStore')
    ? deps.issuanceStore
    : createEmailLunaAutomationIssuanceMaterialStore({ withTransactionClient: producerLoaner });
  if (!issuanceStore || typeof issuanceStore !== 'object' || isProxySurface(issuanceStore)) throw invalid();
  if (typeof issuanceStore.assertAuthenticLoadedMaterial !== 'function'
      || typeof issuanceStore.recoverAutomationIssuance !== 'function'
      || isProxySurface(issuanceStore.assertAuthenticLoadedMaterial)
      || isProxySurface(issuanceStore.recoverAutomationIssuance)) {
    throw invalid();
  }
  if (objectHasOwn(issuanceStore, 'send') || objectHasOwn(producerStore, 'send')
      || objectHasOwn(workerStore, 'send')) {
    throw invalid();
  }

  let ticking = false;

  function currentEnabled() {
    const snapshot = resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness(env);
    return snapshot && snapshot.runtime_activation === true;
  }

  async function reserveControlledDraft(input) {
    if (arguments.length !== 1) throw invalid();
    if (!currentEnabled()) throw disabledError();
    const request = exactPlain(input, RESERVE_INPUT_KEYS);
    let material;
    try {
      material = issuanceStore.assertAuthenticLoadedMaterial(request.material);
    } catch (error) {
      rethrowAsRuntime(error);
    }
    if (ownData(material, 'client_id') !== binding.client_id
        || ownData(material, 'location_id') !== binding.location_id
        || ownData(material, 'location_key') !== binding.location_key
        || ownData(material, 'endpoint_id') !== binding.endpoint_id) {
      throw invalid();
    }
    let recovered;
    try {
      recovered = issuanceStore.recoverAutomationIssuance({ material });
    } catch (error) {
      rethrowAsRuntime(error);
    }
    if (!recovered || ownData(recovered, 'status') !== 'recovered') throw invalid();
    const recoveredRecord = ownData(recovered, 'record');
    const canonical = readDraftCanonical(ownData(recoveredRecord, 'draft'));
    let reserved;
    try {
      reserved = await producerStore.reserveControlledDraft({
        operation_id: ownData(material, 'operation_id'),
        issuance_id: ownData(material, 'issuance_id'),
        canonical_subject: canonical.subject,
        canonical_body: canonical.body,
        language: canonical.language,
      });
    } catch (error) {
      rethrowAsRuntime(error);
    }
    return reserved;
  }

  async function reconcileKnown(record) {
    if (!currentEnabled()) {
      return tickEvidence({
        status: 'blocked_disabled',
        reason: 'disablement_no_provider_calls',
        operation_id: record.operation_id,
        issuance_id: record.issuance_id,
        state: record.state,
      });
    }
    if (!record.provider_draft_id) throw invalid();
    let result;
    try {
      result = await provider.reconcileDraft(reconcileRequestFromOperation(record));
    } catch (error) {
      rethrowAsRuntime(error);
    }
    const observation = observationFromReconcile(result, record);
    let reconciled;
    try {
      reconciled = await workerStore.reconcileProviderDraft({
        operation_id: record.operation_id,
        issuance_id: record.issuance_id,
        expected_generation: record.state_generation,
        observation,
      });
    } catch (error) {
      rethrowAsRuntime(error);
    }
    return tickEvidence({
      status: ownData(reconciled, 'status'),
      reason: 'reconciled',
      operation_id: record.operation_id,
      issuance_id: record.issuance_id,
      state: ownData(ownData(reconciled, 'record'), 'state'),
      provider_invoked: true,
      reconcile_invoked: true,
    });
  }

  async function createFromClaim(claimedRecord) {
    fireCrash(crashSeams, 'after_claim_before_provider');
    if (!currentEnabled()) {
      return tickEvidence({
        status: 'create_dispatched_outcome_unknown',
        reason: 'disablement_after_claim_no_create',
        operation_id: claimedRecord.operation_id,
        issuance_id: claimedRecord.issuance_id,
        state: 'create_dispatched_outcome_unknown',
      });
    }
    const createPromise = provider.createReplyDraft(createRequestFromOperation(claimedRecord));
    try {
      fireCrash(crashSeams, 'during_provider');
    } catch (error) {
      throw error;
    }
    let created;
    try {
      created = await createPromise;
    } catch (_) {
      return tickEvidence({
        status: 'create_dispatched_outcome_unknown',
        reason: 'provider_create_unknown',
        operation_id: claimedRecord.operation_id,
        issuance_id: claimedRecord.issuance_id,
        state: 'create_dispatched_outcome_unknown',
        provider_invoked: true,
        create_invoked: true,
      });
    }
    fireCrash(crashSeams, 'after_provider_before_record');
    if (ownData(created, 'outcome') !== 'draft_created') throw invalid();
    let recorded;
    try {
      recorded = await workerStore.recordProviderCreate({
        operation_id: claimedRecord.operation_id,
        issuance_id: claimedRecord.issuance_id,
        expected_generation: claimedRecord.state_generation,
        acknowledgement: acknowledgementFromCreate(created),
      });
    } catch (error) {
      rethrowAsRuntime(error);
    }
    fireCrash(crashSeams, 'after_record');
    return tickEvidence({
      status: ownData(recorded, 'status'),
      reason: 'create_recorded',
      operation_id: claimedRecord.operation_id,
      issuance_id: claimedRecord.issuance_id,
      state: ownData(ownData(recorded, 'record'), 'state'),
      provider_invoked: true,
      create_invoked: true,
    });
  }

  async function tick(input) {
    if (arguments.length !== 1) throw invalid();
    if (ticking) {
      return tickEvidence({ status: 'overlap_skipped', reason: 'overlap_skipped' });
    }
    ticking = true;
    try {
      const request = exactPlain(input, TICK_INPUT_KEYS);
      let operation;
      try {
        operation = workerStore.assertAuthenticLoadedOperation(request.operation);
      } catch (error) {
        rethrowAsRuntime(error);
      }
      if (!matchBinding(operation, binding)) throw invalid();
      if (!currentEnabled()) {
        return tickEvidence({
          status: 'blocked_disabled',
          reason: 'disablement_no_provider_calls',
          operation_id: operation.operation_id,
          issuance_id: operation.issuance_id,
          state: operation.state,
        });
      }
      if (operation.state === 'provider_draft_modified_by_staff'
          || operation.state === 'provider_draft_removed_by_staff'
          || operation.state === 'provider_mismatch_blocked') {
        return tickEvidence({
          status: operation.state,
          reason: 'terminal_staff_or_mismatch',
          operation_id: operation.operation_id,
          issuance_id: operation.issuance_id,
          state: operation.state,
        });
      }
      if (operation.state === 'provider_draft_reconciled_exact') {
        return reconcileKnown(operation);
      }
      if (operation.state === 'create_dispatched_outcome_unknown') {
        if (!operation.provider_draft_id) {
          return tickEvidence({
            status: 'unknown_create_unobservable',
            reason: 'unknown_create_unobservable',
            operation_id: operation.operation_id,
            issuance_id: operation.issuance_id,
            state: operation.state,
          });
        }
        return reconcileKnown(operation);
      }
      if (operation.state !== 'reserved') throw invalid();
      fireCrash(crashSeams, 'before_claim');
      if (!currentEnabled()) {
        return tickEvidence({
          status: 'blocked_disabled',
          reason: 'disablement_no_provider_calls',
          operation_id: operation.operation_id,
          issuance_id: operation.issuance_id,
          state: operation.state,
        });
      }
      let claimed;
      try {
        claimed = await workerStore.claimCreateDispatch({
          operation_id: operation.operation_id,
          issuance_id: operation.issuance_id,
          expected_generation: operation.state_generation,
        });
      } catch (error) {
        rethrowAsRuntime(error);
      }
      const claimedRecord = ownData(claimed, 'record');
      const claimedStatus = ownData(claimed, 'status');
      if (claimedStatus === 'replayed') {
        if (!ownData(claimedRecord, 'provider_draft_id')) {
          return tickEvidence({
            status: 'unknown_create_unobservable',
            reason: 'unknown_create_unobservable',
            operation_id: operation.operation_id,
            issuance_id: operation.issuance_id,
            state: ownData(claimedRecord, 'state'),
          });
        }
        if (ownData(claimedRecord, 'state') === 'provider_draft_reconciled_exact') {
          return reconcileKnown(claimedRecord);
        }
        return tickEvidence({
          status: ownData(claimedRecord, 'state'),
          reason: 'claim_replayed',
          operation_id: operation.operation_id,
          issuance_id: operation.issuance_id,
          state: ownData(claimedRecord, 'state'),
        });
      }
      if (claimedStatus !== 'create_dispatched_outcome_unknown') {
        return tickEvidence({
          status: claimedStatus,
          reason: 'claim_not_create_authority',
          operation_id: operation.operation_id,
          issuance_id: operation.issuance_id,
          state: ownData(claimedRecord, 'state'),
        });
      }
      return createFromClaim(claimedRecord);
    } finally {
      ticking = false;
    }
  }

  return freeze({
    reserveControlledDraft,
    tick,
    getReadiness: () => resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness(env),
    getBinding: () => freeze({
      client_id: binding.client_id,
      location_id: binding.location_id,
      location_key: SUNSET_LOCATION_KEY,
      endpoint_id: binding.endpoint_id,
      mailbox_id: binding.mailbox_id,
      provider: EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER,
    }),
    getUnknownCreatePolicy: () => EMAIL_LUNA_CONTROLLED_DRAFTING_UNKNOWN_CREATE_POLICY,
  });
}

module.exports = objectFreeze({
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_WIRED,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ACTIVATION,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_LOGGING_FORBIDDEN,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_SEND_ALLOWED,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_JOURNAL_HANDOFF,
  EMAIL_LUNA_CONTROLLED_DRAFTING_UNKNOWN_CREATE_POLICY,
  ENV_COMPOSITION_ENABLED,
  ENV_CLIENT_ID,
  ENV_LOCATION_ID,
  ENV_LOCATION_KEY,
  ENV_ENDPOINT_ID,
  ENV_MAILBOX_ID,
  ENV_PROVIDER,
  ENV_AUTO_SEND,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  SUNSET_LOCATION_KEY,
  CONTROLLED_DRAFTING_MODE,
  ERROR_CODE,
  ERROR_MESSAGE,
  DISABLED_CODE,
  DISABLED_MESSAGE,
  CRASH_SEAM_KEYS,
  resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness,
  createEmailLunaControlledDraftingSunsetStagingRuntimeComposition,
});

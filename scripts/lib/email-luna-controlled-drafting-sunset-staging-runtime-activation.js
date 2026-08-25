'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4A.
 *
 * Staff API-owned, default-off Sunset staging activation around the
 * Chapter 3 reserve/tick composition. Import is inert. Explicit start()
 * after exact independent flags, Sunset binding, 097/principal preflight,
 * and dedicated producer/worker LOGIN pair. Live Graph stays a separate
 * exact gate and is blocked unless a closed Chapter 1 provider is supplied.
 *
 * Replica topology is fail-closed: EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_REPLICA_COUNT
 * must be the exact string '1'.
 */

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const runtimeIsProxy = require('node:util').types.isProxy.bind(undefined);
const {
  isProxySurface,
  ownData,
  exactOwnData,
  subsetOwnData,
  isCanonUuid,
} = require('./email-luna-controlled-drafting-closed-data');
const {
  createEmailLunaControlledDraftingSunsetStagingRuntimeComposition,
  bindProducerWithTransactionClient,
  bindWorkerWithTransactionClient,
  resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness:
    resolveChapter3Readiness,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_WIRED,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ACTIVATION,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_SEND_ALLOWED,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_JOURNAL_HANDOFF,
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
} = require('./email-luna-controlled-drafting-sunset-staging-runtime-composition');
const {
  createEmailLunaControlledDraftingProvider,
  createEmailLunaControlledDraftingFakeTransport,
  createEmailLunaControlledDraftingGraphDraftTransport,
  pickEmailLunaControlledDraftingTransportMethods,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_WIRED,
  EMAIL_LUNA_CONTROLLED_DRAFTING_ACTIVATION,
  EMAIL_LUNA_CONTROLLED_DRAFTING_CAPABILITY_MANIFEST,
  EMAIL_MS_CONTROLLED_DRAFTING_SCOPE_PROFILE,
  EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER,
  EMAIL_LUNA_CONTROLLED_DRAFTING_SCOPE_VERSION,
} = require('./email-luna-controlled-drafting-provider-contract');
const {
  isClosedControlledDraftingTokenLoan,
  bindControlledDraftingTokenLoanKillSwitch,
} = require('./email-luna-controlled-drafting-token-loan');
const {
  createEmailLunaControlledDraftingOperationStore,
  EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_RUNTIME_WIRED,
} = require('./email-luna-controlled-drafting-operation-store');
const {
  createEmailLunaAutomationIssuanceMaterialStore,
} = require('./email-luna-draft-policy');
const {
  inspectEmailLunaControlledDraftingSession,
  proveEmailLunaControlledDraftingStagingTestAuthorization,
  consumeEmailLunaControlledDraftingStagingTestAuthorization,
  MIGRATION_097_ID,
  MIGRATION_098_ID,
} = require('./email-luna-controlled-drafting-session-proof');
const {
  resolveEmailLunaControlledDraftingPrincipalConnectionConfig,
  ENV_PRODUCER_DATABASE_URL,
  ENV_WORKER_DATABASE_URL,
} = require('./email-luna-controlled-drafting-principal-connection');

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
const stringTrim = uncurryThis(String.prototype.trim);
const stringToLowerCase = uncurryThis(String.prototype.toLowerCase);
const regexpTest = uncurryThis(RegExp.prototype.test);
const nativeSetTimeout = setTimeout;

const EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ACTIVATION_WIRED = true;
const EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ACTIVATION = false;
const EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ACTIVATION_LOGGING_FORBIDDEN = true;
const EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_CONCURRENCY = 1;
const EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_MIN_INTERVAL_MS = 60000;
const EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_MAX_INTERVAL_MS = 120000;
const EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_STOP_DRAIN_TIMEOUT_MS = 5000;

const ENV_RUNTIME_ENABLED = 'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED';
const ENV_PRODUCER_INTAKE_ENABLED = 'EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_INTAKE_ENABLED';
const ENV_WORKER_TICK_ENABLED = 'EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_TICK_ENABLED';
const ENV_LIVE_PROVIDER_DRAFT_ENABLED = 'EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_PROVIDER_DRAFT_ENABLED';
const ENV_REPLICA_COUNT = 'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_REPLICA_COUNT';
const ENV_TEST_OPERATION_ID = 'EMAIL_LUNA_CONTROLLED_DRAFTING_TEST_OPERATION_ID';
const ENV_TEST_ISSUANCE_ID = 'EMAIL_LUNA_CONTROLLED_DRAFTING_TEST_ISSUANCE_ID';
const ENV_TEST_RECIPIENT_ADDRESS = 'EMAIL_LUNA_CONTROLLED_DRAFTING_TEST_RECIPIENT_ADDRESS';
const ENV_TEST_AUTHORIZATION_ID = 'EMAIL_LUNA_CONTROLLED_DRAFTING_TEST_AUTHORIZATION_ID';
const ENV_DEPLOYMENT = 'LUNA_DEPLOYMENT';
const ENV_TENANT = 'DEFAULT_CLIENT_SLUG';
const ENV_DRAFT_RUNTIME = 'EMAIL_LUNA_DRAFT_RUNTIME_ENABLED';
const ENV_SHADOW = 'EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ENABLED';
const ENV_OUTREACH = 'CUSTOMER_OUTREACH_WHATSAPP_ENABLED';
const ENV_CAMPAIGN = 'STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED';

const ERROR_CODE = 'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ACTIVATION_INVALID';
const ERROR_MESSAGE = 'Email Luna controlled drafting runtime activation failed.';
const DISABLED_CODE = 'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ACTIVATION_DISABLED';
const DISABLED_MESSAGE = 'Email Luna controlled drafting runtime activation disabled.';

const CREATE_KEYS = objectFreeze([
  'env', 'producerWithTransactionClient', 'workerWithTransactionClient', 'timers', 'intervalMs',
]);
const OPTIONAL_CREATE_KEYS = objectFreeze([
  'provider', 'issuanceStore', 'crashSeams', 'tokenLoan', 'httpsImpl',
]);
const TIMER_KEYS = objectFreeze(['setTimeout', 'clearTimeout']);
const FORBIDDEN_CREATE_KEYS = objectFreeze([
  'send', 'onSend', 'graph', 'callback', 'fetch', 'authorize_send', 'journal',
  'accessToken', 'sendDraft', 'sendMail',
]);
const FORBIDDEN_FIELD_NAMES = objectFreeze([
  'access_token', 'refresh_token', 'id_token', 'accessToken', 'refreshToken',
  'Authorization', 'authorization', 'token', 'client_secret', 'password',
  'api_key', 'raw_secret', 'subject', 'body', 'canonical_subject', 'canonical_body',
]);
const SAFE_STATES = objectFreeze([
  'reserved',
  'create_dispatched_outcome_unknown',
  'provider_draft_reconciled_exact',
  'provider_draft_modified_by_staff',
  'provider_draft_removed_by_staff',
  'provider_mismatch_blocked',
]);
const RECIPIENT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

if (EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ACTIVATION_WIRED !== true
    || EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ACTIVATION !== false
    || EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_WIRED !== true
    || EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ACTIVATION !== false
    || EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_WIRED !== false
    || EMAIL_LUNA_CONTROLLED_DRAFTING_ACTIVATION !== false
    || EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_RUNTIME_WIRED !== false
    || EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_SEND_ALLOWED !== false
    || EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_JOURNAL_HANDOFF !== false) {
  throw new Error('controlled_drafting_runtime_activation_unexpected');
}
if (EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_CONCURRENCY !== 1) {
  throw new Error('controlled_drafting_runtime_activation_concurrency_unexpected');
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

function envFlag(env, key) {
  return ownData(env, key) === 'true';
}

function isConflictTruthy(raw) {
  if (raw === true) return true;
  if (typeof raw !== 'string') return false;
  const value = stringToLowerCase(stringTrim(raw));
  return value === 'true' || value === '1' || value === 'yes' || value === 'on';
}

function parseUuid(raw) {
  if (typeof raw !== 'string' || stringTrim(raw) !== raw) return null;
  const id = stringToLowerCase(raw);
  return isCanonUuid(id) ? id : null;
}

function sendAutomationRefused(env) {
  return isConflictTruthy(ownData(env, ENV_AUTO_SEND))
    || isConflictTruthy(ownData(env, ENV_OUTREACH))
    || isConflictTruthy(ownData(env, ENV_CAMPAIGN));
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

function bindingComplete(binding) {
  return Boolean(binding.client_id && binding.location_id && binding.endpoint_id
    && binding.mailbox_id && binding.location_key === SUNSET_LOCATION_KEY
    && binding.provider === EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER);
}

function flagsExact(env) {
  return envFlag(env, ENV_RUNTIME_ENABLED)
    && envFlag(env, ENV_COMPOSITION_ENABLED)
    && ownData(env, ENV_DEPLOYMENT) === SUNSET_DEPLOYMENT
    && ownData(env, ENV_TENANT) === SUNSET_TENANT
    && ownData(env, ENV_LOCATION_KEY) === SUNSET_LOCATION_KEY
    && ownData(env, ENV_PROVIDER) === EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER
    && ownData(env, ENV_REPLICA_COUNT) === '1';
}

function substituteAttempt(env) {
  if (envFlag(env, ENV_RUNTIME_ENABLED) && envFlag(env, ENV_COMPOSITION_ENABLED)) return false;
  return envFlag(env, ENV_DRAFT_RUNTIME) || envFlag(env, ENV_SHADOW);
}

function presentRuntimeFlag(env) {
  return ownData(env, ENV_RUNTIME_ENABLED) === undefined ? 0 : 1;
}

function principalConnectionOk(env) {
  try {
    const cfg = resolveEmailLunaControlledDraftingPrincipalConnectionConfig({
      env,
      appConnectionString: ownData(env, 'WOLFHOUSE_DATABASE_URL') || ownData(env, 'DATABASE_URL'),
    });
    return Boolean(cfg && cfg.ok === true);
  } catch (_) {
    return false;
  }
}

function testScopeFromEnv(env) {
  const operationId = parseUuid(ownData(env, ENV_TEST_OPERATION_ID));
  const issuanceId = parseUuid(ownData(env, ENV_TEST_ISSUANCE_ID));
  const authorizationId = parseUuid(ownData(env, ENV_TEST_AUTHORIZATION_ID));
  const recipient = ownData(env, ENV_TEST_RECIPIENT_ADDRESS);
  if (!operationId || !issuanceId || !authorizationId) return null;
  if (typeof recipient !== 'string' || stringTrim(recipient) !== recipient) return null;
  if (!regexpTest(RECIPIENT_RE, recipient) || recipient !== stringToLowerCase(recipient)) return null;
  return freeze({
    operation_id: operationId,
    issuance_id: issuanceId,
    authorization_id: authorizationId,
    recipient_configured: true,
    recipient_address: recipient,
  });
}

function liveProviderBlockReason(env, extras) {
  if (!envFlag(env, ENV_LIVE_PROVIDER_DRAFT_ENABLED)) {
    return 'live_provider_draft_disabled';
  }
  if (EMAIL_MS_CONTROLLED_DRAFTING_SCOPE_PROFILE.graph_delegated.join(' ') !== 'User.Read Mail.ReadWrite') {
    return 'controlled_drafting_scope_mismatch';
  }
  if (EMAIL_LUNA_CONTROLLED_DRAFTING_CAPABILITY_MANIFEST.capabilities.send !== false) {
    return 'send_capability_not_absent';
  }
  if (!extras || extras.hasClosedProvider !== true) {
    return 'no_controlled_drafting_v1_token_loan';
  }
  return null;
}

function evidenceBase(reason, extra) {
  const liveBlock = extra && extra.live_provider_block_reason
    ? extra.live_provider_block_reason
    : null;
  return output([
    ['ok', extra && extra.ok === true],
    ['runtime_activation', extra && extra.runtime_activation === true],
    ['composition_wired', true],
    ['provider_capability', extra && extra.provider_capability === true],
    ['producer_intake', extra && extra.producer_intake === true],
    ['worker_tick', extra && extra.worker_tick === true],
    ['live_provider_draft', extra && extra.live_provider_draft === true],
    ['live_provider_block_reason', liveBlock],
    ['create_capability', extra && extra.provider_capability === true],
    ['send_allowed', false],
    ['journal_handoff', false],
    ['mode', CONTROLLED_DRAFTING_MODE],
    ['reason', reason],
  ]);
}

function resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness(env) {
  const inert = evidenceBase('default_off', { ok: true, runtime_activation: false });
  try {
    if (!env || typeof env !== 'object' || isProxySurface(env) || arrayIsArray(env)) {
      return evidenceBase('invalid_env', { ok: false, runtime_activation: false });
    }
    if (sendAutomationRefused(env)) {
      return evidenceBase('send_automation_refused', {
        ok: false,
        runtime_activation: false,
        live_provider_block_reason: 'send_automation_refused',
      });
    }
    const binding = readBinding(env);
    const chapter3 = resolveChapter3Readiness(env);
    if (!flagsExact(env) || !bindingComplete(binding) || !chapter3 || chapter3.runtime_activation !== true) {
      const flagsAbsent = presentRuntimeFlag(env) === 0 && ownData(env, ENV_COMPOSITION_ENABLED) === undefined;
      const reason = flagsAbsent
        ? 'default_off'
        : (substituteAttempt(env) ? 'flag_substitution' : 'partial_or_mismatched_gates');
      return evidenceBase(reason, {
        ok: flagsAbsent,
        runtime_activation: false,
      });
    }
    if (!principalConnectionOk(env)) {
      return evidenceBase('principal_connection_required', { ok: false, runtime_activation: false });
    }
    const liveBlock = liveProviderBlockReason(env, { hasClosedProvider: false });
    return evidenceBase('exact_sunset_gates', {
      ok: true,
      runtime_activation: true,
      provider_capability: true,
      producer_intake: envFlag(env, ENV_PRODUCER_INTAKE_ENABLED),
      worker_tick: envFlag(env, ENV_WORKER_TICK_ENABLED),
      live_provider_draft: liveBlock === null,
      live_provider_block_reason: liveBlock,
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

function closedOfflineProvider(authority) {
  const fake = createEmailLunaControlledDraftingFakeTransport({ classify: true });
  return createEmailLunaControlledDraftingProvider({
    authority,
    transport: pickEmailLunaControlledDraftingTransportMethods({
      createReplyDraft: fake.createReplyDraft,
      reconcileDraft: fake.reconcileDraft,
    }),
  });
}

function assembleLiveProvider(authority, tokenLoan, httpsImpl, timers) {
  if (!isClosedControlledDraftingTokenLoan(tokenLoan)) {
    return { ok: false, reason: 'no_controlled_drafting_v1_token_loan' };
  }
  try {
    const attestation = tokenLoan.attest();
    if (!attestation
        || attestation.ok !== true
        || attestation.send_capable !== false
        || attestation.mail_send !== false
        || attestation.scope_profile_id !== EMAIL_LUNA_CONTROLLED_DRAFTING_SCOPE_VERSION) {
      return { ok: false, reason: 'no_controlled_drafting_v1_token_loan' };
    }
    const transport = createEmailLunaControlledDraftingGraphDraftTransport({
      httpsImpl,
      tokenLoan,
      timers,
    });
    const picked = pickEmailLunaControlledDraftingTransportMethods({
      createReplyDraft: ownData(transport, 'createReplyDraft'),
      reconcileDraft: ownData(transport, 'reconcileDraft'),
    });
    const provider = createEmailLunaControlledDraftingProvider({
      authority,
      transport: picked,
    });
    const attest = provider.attest();
    const caps = ownData(attest, 'capabilities') || (attest && attest.capabilities);
    if (!attest || !caps || caps.create_reply_draft !== true || caps.reconcile_draft !== true) {
      return { ok: false, reason: 'provider_manifest_mismatch' };
    }
    if (caps.send === true || caps.send_draft === true || caps.send_mail === true
        || caps.access_token_export === true) {
      return { ok: false, reason: 'send_like_capability_rejected' };
    }
    return { ok: true, provider };
  } catch (_) {
    return { ok: false, reason: 'live_provider_assembly_failed' };
  }
}

function emptyCounts() {
  const counts = objectCreate(null);
  for (let i = 0; i < SAFE_STATES.length; i += 1) {
    counts[SAFE_STATES[i]] = 0;
  }
  return freeze(counts);
}

function incrementCount(counts, state) {
  if (!arrayIncludes(SAFE_STATES, state)) return counts;
  const next = objectCreate(null);
  for (let i = 0; i < SAFE_STATES.length; i += 1) {
    const key = SAFE_STATES[i];
    next[key] = key === state ? counts[key] + 1 : counts[key];
  }
  return freeze(next);
}

function sanitizeStatus(fields) {
  const keys = safeOwnKeys(fields);
  for (let i = 0; i < keys.length; i += 1) {
    if (arrayIncludes(FORBIDDEN_FIELD_NAMES, keys[i])) throw invalid();
  }
  return output([
    ['enabled', fields.enabled === true],
    ['configured', fields.configured === true],
    ['ready', fields.ready === true],
    ['running', fields.running === true],
    ['paused', fields.paused === true],
    ['schema', fields.schema || null],
    ['principal', fields.principal || null],
    ['circuit', fields.circuit || 'closed'],
    ['mode', CONTROLLED_DRAFTING_MODE],
    ['reason', fields.reason || null],
    ['send_allowed', false],
    ['journal_handoff', false],
    ['live_provider_draft', fields.live_provider_draft === true],
    ['live_provider_block_reason', fields.live_provider_block_reason || null],
    ['test_scope_configured', fields.test_scope_configured === true],
    ['counts', fields.counts || emptyCounts()],
  ]);
}

function createEmailLunaControlledDraftingSunsetStagingRuntimeActivation(dependencies) {
  if (arguments.length !== 1) throw invalid();
  refuseForbiddenCreateKeys(dependencies);
  const allowed = [];
  for (let i = 0; i < CREATE_KEYS.length; i += 1) allowed.push(CREATE_KEYS[i]);
  for (let i = 0; i < OPTIONAL_CREATE_KEYS.length; i += 1) allowed.push(OPTIONAL_CREATE_KEYS[i]);
  const deps = subsetOwnData(dependencies, objectFreeze(allowed));
  if (!deps) throw invalid();
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
  let brandedProducer;
  let brandedWorker;
  try {
    brandedProducer = bindProducerWithTransactionClient(producerLoaner);
    brandedWorker = bindWorkerWithTransactionClient(workerLoaner);
  } catch (_) {
    throw invalid();
  }
  const timers = exactOwnData(deps.timers, TIMER_KEYS);
  if (!timers || typeof timers.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function') {
    throw invalid();
  }
  if (isProxySurface(timers.setTimeout) || isProxySurface(timers.clearTimeout)) throw invalid();
  const intervalMs = deps.intervalMs;
  if (!Number.isInteger(intervalMs)
      || intervalMs < EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_MIN_INTERVAL_MS
      || intervalMs > EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_MAX_INTERVAL_MS) {
    throw invalid();
  }

  const authority = freeze({
    client_id: binding.client_id,
    location_id: binding.location_id,
    location_key: SUNSET_LOCATION_KEY,
    endpoint_id: binding.endpoint_id,
    provider: EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER,
    mailbox_id: binding.mailbox_id,
  });

  const killState = { stopped: true };
  let provider = ownData(deps, 'provider');
  let liveBlock = liveProviderBlockReason(env, { hasClosedProvider: Boolean(provider) });
  if (envFlag(env, ENV_LIVE_PROVIDER_DRAFT_ENABLED)) {
    if (!provider) {
      const tokenLoan = ownData(deps, 'tokenLoan');
      if (isClosedControlledDraftingTokenLoan(tokenLoan)) {
        bindControlledDraftingTokenLoanKillSwitch(tokenLoan, () => killState.stopped === true);
      }
      const assembled = assembleLiveProvider(
        authority,
        tokenLoan,
        ownData(deps, 'httpsImpl'),
        timers,
      );
      if (!assembled.ok) {
        throw disabledError();
      }
      provider = assembled.provider;
      liveBlock = null;
    }
  } else {
    if (!provider) provider = closedOfflineProvider(authority);
  }

  let issuanceStore = ownData(deps, 'issuanceStore');
  if (!issuanceStore) {
    // 092 load is a worker EXECUTE grant. Producer persist is separate.
    // Authentic loaded material is branded by this store instance, then
    // Chapter 3 producer reserve consumes it. No 086 scan; exact test scope only.
    const persistMod = require('./email-luna-automation-issuance-material-store');
    const persisted = persistMod.createEmailLunaAutomationIssuanceMaterialPersistence({
      withTransactionClient: brandedWorker,
    });
    const policyStore = createEmailLunaAutomationIssuanceMaterialStore({
      withTransactionClient: brandedWorker,
    });
    issuanceStore = freeze({
      loadAutomationIssuanceMaterial: policyStore.loadAutomationIssuanceMaterial,
      recoverAutomationIssuance: policyStore.recoverAutomationIssuance,
      assertAuthenticLoadedMaterial: persisted.assertAuthenticLoadedMaterial,
    });
  }
  if (!issuanceStore || typeof issuanceStore !== 'object' || isProxySurface(issuanceStore)) throw invalid();
  if (typeof issuanceStore.recoverAutomationIssuance !== 'function'
      || typeof issuanceStore.loadAutomationIssuanceMaterial !== 'function') {
    throw invalid();
  }
  if (typeof issuanceStore.assertAuthenticLoadedMaterial !== 'function') {
    const persistMod = require('./email-luna-automation-issuance-material-store');
    const persisted = persistMod.createEmailLunaAutomationIssuanceMaterialPersistence({
      withTransactionClient: brandedWorker,
    });
    issuanceStore = freeze({
      loadAutomationIssuanceMaterial: issuanceStore.loadAutomationIssuanceMaterial,
      recoverAutomationIssuance: issuanceStore.recoverAutomationIssuance,
      assertAuthenticLoadedMaterial: persisted.assertAuthenticLoadedMaterial,
    });
  }
  if (typeof issuanceStore.assertAuthenticLoadedMaterial !== 'function') throw invalid();

  const crashSeams = objectHasOwn(deps, 'crashSeams') ? ownData(deps, 'crashSeams') : undefined;
  const compositionInput = {
    env,
    producerWithTransactionClient: brandedProducer,
    workerWithTransactionClient: brandedWorker,
    provider,
    issuanceStore,
  };
  if (crashSeams !== undefined) compositionInput.crashSeams = crashSeams;
  let composition;
  let workerStore;
  try {
    composition = createEmailLunaControlledDraftingSunsetStagingRuntimeComposition(compositionInput);
    workerStore = createEmailLunaControlledDraftingOperationStore({
      withTransactionClient: brandedWorker,
    });
  } catch (error) {
    if (error && error.code === DISABLED_CODE) throw error;
    throw invalid();
  }

  let schemaVerified = false;
  let started = false;
  let stopped = true;
  let epoch = 0;
  let timer = null;
  let inflight = null;
  let counts = emptyCounts();
  let circuit = 'closed';
  let lastReason = 'not_started';

  function currentReadiness() {
    return resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness(env);
  }

  function killSwitched() {
    const snapshot = currentReadiness();
    return !snapshot || snapshot.runtime_activation !== true || sendAutomationRefused(env);
  }

  async function verifySchema() {
    if (schemaVerified) return;
    const producerProof = await brandedProducer(async (client) => (
      inspectEmailLunaControlledDraftingSession(client, {
        client_id: binding.client_id,
        location_id: binding.location_id,
        location_key: SUNSET_LOCATION_KEY,
      }, 'producer')
    ));
    const workerProof = await brandedWorker(async (client) => (
      inspectEmailLunaControlledDraftingSession(client, {
        client_id: binding.client_id,
        location_id: binding.location_id,
        location_key: SUNSET_LOCATION_KEY,
      }, 'worker')
    ));
    if (!producerProof || producerProof.ok !== true || producerProof.inspect_failed === true) {
      throw invalid();
    }
    if (!workerProof || workerProof.ok !== true || workerProof.inspect_failed === true) {
      throw invalid();
    }
    if (producerProof.schema_applied !== true || workerProof.schema_applied !== true) throw invalid();
    if (producerProof.checksum_ok !== true || workerProof.checksum_ok !== true) throw invalid();
    schemaVerified = true;
  }

  async function maybeReserve() {
    if (!envFlag(env, ENV_PRODUCER_INTAKE_ENABLED)) {
      lastReason = 'producer_intake_disabled';
      return output([['status', 'skipped'], ['reason', 'producer_intake_disabled'], ['provider_invoked', false]]);
    }
    const scope = testScopeFromEnv(env);
    if (!scope) {
      lastReason = 'controlled_test_scope_required';
      return output([['status', 'blocked'], ['reason', 'controlled_test_scope_required'], ['provider_invoked', false]]);
    }
    if (killSwitched()) {
      lastReason = 'kill_switch';
      circuit = 'open';
      return output([['status', 'blocked_disabled'], ['reason', 'kill_switch'], ['provider_invoked', false]]);
    }
    const proven = await brandedProducer(async (client) => (
      proveEmailLunaControlledDraftingStagingTestAuthorization(client, {
        authorization_id: scope.authorization_id,
        operation_id: scope.operation_id,
        issuance_id: scope.issuance_id,
        recipient_address: scope.recipient_address,
      })
    ));
    if (!proven || proven.ok !== true || proven.status !== 'authorized') {
      lastReason = (proven && proven.reason) || 'authorization_unproven';
      return output([['status', 'blocked'], ['reason', lastReason], ['provider_invoked', false]]);
    }
    const loaded = await issuanceStore.loadAutomationIssuanceMaterial({
      operation_id: scope.operation_id,
      issuance_id: scope.issuance_id,
    });
    if (!loaded || ownData(loaded, 'status') !== 'loaded') {
      lastReason = 'test_scope_issuance_missing';
      return output([['status', 'blocked'], ['reason', 'test_scope_issuance_missing'], ['provider_invoked', false]]);
    }
    const material = issuanceStore.assertAuthenticLoadedMaterial(ownData(loaded, 'record'));
    if (ownData(material, 'recipient_address') !== scope.recipient_address) {
      lastReason = 'test_scope_recipient_mismatch';
      return output([['status', 'blocked'], ['reason', 'test_scope_recipient_mismatch'], ['provider_invoked', false]]);
    }
    if (ownData(material, 'client_id') !== binding.client_id
        || ownData(material, 'location_id') !== binding.location_id
        || ownData(material, 'endpoint_id') !== binding.endpoint_id) {
      throw invalid();
    }
    const reserved = await composition.reserveControlledDraft({ material });
    await brandedProducer(async (client) => (
      consumeEmailLunaControlledDraftingStagingTestAuthorization(client, {
        authorization_id: scope.authorization_id,
        operation_id: scope.operation_id,
        issuance_id: scope.issuance_id,
      })
    ));
    const state = ownData(ownData(reserved, 'record'), 'state') || ownData(reserved, 'status');
    if (arrayIncludes(SAFE_STATES, state)) counts = incrementCount(counts, state);
    lastReason = 'reserved';
    return output([
      ['status', ownData(reserved, 'status') || 'reserved'],
      ['reason', 'reserved'],
      ['provider_invoked', false],
    ]);
  }

  async function maybeTick() {
    if (!envFlag(env, ENV_WORKER_TICK_ENABLED)) {
      lastReason = 'worker_tick_disabled';
      return output([['status', 'skipped'], ['reason', 'worker_tick_disabled'], ['provider_invoked', false]]);
    }
    if (!envFlag(env, ENV_LIVE_PROVIDER_DRAFT_ENABLED) && !ownData(deps, 'provider')) {
      lastReason = 'live_provider_draft_disabled';
      return output([
        ['status', 'blocked'],
        ['reason', 'live_provider_draft_disabled'],
        ['provider_invoked', false],
      ]);
    }
    const scope = testScopeFromEnv(env);
    if (!scope) {
      lastReason = 'controlled_test_scope_required';
      return output([['status', 'blocked'], ['reason', 'controlled_test_scope_required'], ['provider_invoked', false]]);
    }
    if (killSwitched()) {
      lastReason = 'kill_switch';
      circuit = 'open';
      return output([['status', 'blocked_disabled'], ['reason', 'kill_switch'], ['provider_invoked', false]]);
    }
    const proven = await brandedWorker(async (client) => (
      proveEmailLunaControlledDraftingStagingTestAuthorization(client, {
        authorization_id: scope.authorization_id,
        operation_id: scope.operation_id,
        issuance_id: scope.issuance_id,
        recipient_address: scope.recipient_address,
      })
    ));
    if (!proven || proven.ok !== true) {
      lastReason = (proven && proven.reason) || 'authorization_unproven';
      return output([['status', 'blocked'], ['reason', lastReason], ['provider_invoked', false]]);
    }
    const loaded = await workerStore.loadControlledDraft({
      operation_id: scope.operation_id,
      issuance_id: scope.issuance_id,
    });
    if (!loaded || ownData(loaded, 'status') !== 'loaded') {
      lastReason = 'test_scope_operation_missing';
      return output([['status', 'blocked'], ['reason', 'test_scope_operation_missing'], ['provider_invoked', false]]);
    }
    const tickResult = await composition.tick({ operation: ownData(loaded, 'record') });
    const state = ownData(tickResult, 'state');
    if (arrayIncludes(SAFE_STATES, state)) counts = incrementCount(counts, state);
    lastReason = ownData(tickResult, 'reason') || 'ticked';
    return tickResult;
  }

  async function processOnce() {
    if (killSwitched()) {
      lastReason = 'kill_switch';
      circuit = 'open';
      return output([['status', 'blocked_disabled'], ['reason', 'kill_switch'], ['provider_invoked', false]]);
    }
    circuit = 'closed';
    const reserved = await maybeReserve();
    const ticked = await maybeTick();
    return ticked || reserved;
  }

  async function tick() {
    if (arguments.length !== 0) throw invalid();
    if (!started || stopped) {
      return output([
        ['status', 'stopped'],
        ['reason', 'not_started'],
        ['mode', CONTROLLED_DRAFTING_MODE],
        ['provider_invoked', false],
        ['journal_handoff', false],
        ['send_allowed', false],
      ]);
    }
    if (inflight) {
      return output([
        ['status', 'overlap_skipped'],
        ['reason', 'overlap_skipped'],
        ['mode', CONTROLLED_DRAFTING_MODE],
        ['provider_invoked', false],
        ['journal_handoff', false],
        ['send_allowed', false],
      ]);
    }
    inflight = Promise.resolve(processOnce());
    try {
      return await inflight;
    } finally {
      inflight = null;
    }
  }

  function arm(ownedEpoch) {
    if (stopped || ownedEpoch !== epoch) return;
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
    timer = timers.setTimeout(async () => {
      if (stopped || ownedEpoch !== epoch) return;
      try {
        await tick();
      } catch (_) {
        /* logging forbidden */
      } finally {
        if (!stopped && ownedEpoch === epoch) arm(ownedEpoch);
      }
    }, intervalMs);
  }

  async function start() {
    if (started) return;
    await verifySchema();
    started = true;
    stopped = false;
    killState.stopped = false;
    epoch += 1;
    lastReason = 'running';
    arm(epoch);
  }

  async function stop() {
    stopped = true;
    killState.stopped = true;
    started = false;
    epoch += 1;
    lastReason = 'paused';
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
    const current = inflight;
    if (!current) return;
    await Promise.race([
      current.then(() => {}, () => {}),
      new Promise((resolve) => {
        const handle = nativeSetTimeout(resolve, EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_STOP_DRAIN_TIMEOUT_MS);
        if (handle && typeof handle.unref === 'function') handle.unref();
      }),
    ]);
  }

  function getStatus() {
    const snapshot = currentReadiness();
    return sanitizeStatus({
      enabled: snapshot.runtime_activation === true,
      configured: bindingComplete(binding) && principalConnectionOk(env),
      ready: schemaVerified === true && snapshot.runtime_activation === true,
      running: started === true && stopped === false,
      paused: started === false || stopped === true,
      schema: schemaVerified ? MIGRATION_097_ID : null,
      principal: schemaVerified ? 'mapped_direct_login' : null,
      circuit,
      reason: lastReason,
      live_provider_draft: liveBlock === null && envFlag(env, ENV_LIVE_PROVIDER_DRAFT_ENABLED),
      live_provider_block_reason: liveBlock,
      test_scope_configured: Boolean(testScopeFromEnv(env)),
      counts,
    });
  }

  return freeze({
    start,
    stop,
    tick,
    getReadiness: () => currentReadiness(),
    getStatus,
    getBinding: () => freeze({
      client_id: binding.client_id,
      location_id: binding.location_id,
      location_key: SUNSET_LOCATION_KEY,
      endpoint_id: binding.endpoint_id,
      mailbox_id: binding.mailbox_id,
      provider: EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER,
    }),
  });
}

module.exports = objectFreeze({
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ACTIVATION_WIRED,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ACTIVATION,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ACTIVATION_LOGGING_FORBIDDEN,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_CONCURRENCY,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_MIN_INTERVAL_MS,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_MAX_INTERVAL_MS,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_STOP_DRAIN_TIMEOUT_MS,
  ENV_RUNTIME_ENABLED,
  ENV_COMPOSITION_ENABLED,
  ENV_PRODUCER_INTAKE_ENABLED,
  ENV_WORKER_TICK_ENABLED,
  ENV_LIVE_PROVIDER_DRAFT_ENABLED,
  ENV_CLIENT_ID,
  ENV_LOCATION_ID,
  ENV_LOCATION_KEY,
  ENV_ENDPOINT_ID,
  ENV_MAILBOX_ID,
  ENV_PROVIDER,
  ENV_REPLICA_COUNT,
  ENV_TEST_OPERATION_ID,
  ENV_TEST_ISSUANCE_ID,
  ENV_TEST_RECIPIENT_ADDRESS,
  ENV_TEST_AUTHORIZATION_ID,
  MIGRATION_098_ID,
  ENV_PRODUCER_DATABASE_URL,
  ENV_WORKER_DATABASE_URL,
  ENV_AUTO_SEND,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  SUNSET_LOCATION_KEY,
  CONTROLLED_DRAFTING_MODE,
  MIGRATION_097_ID,
  ERROR_CODE,
  ERROR_MESSAGE,
  DISABLED_CODE,
  DISABLED_MESSAGE,
  resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness,
  createEmailLunaControlledDraftingSunsetStagingRuntimeActivation,
  bindProducerWithTransactionClient,
  bindWorkerWithTransactionClient,
});

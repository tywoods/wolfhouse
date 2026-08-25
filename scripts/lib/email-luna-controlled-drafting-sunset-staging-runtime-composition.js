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

const {
  createEmailLunaControlledDraftingOperationStore,
  ACK_KEYS,
  EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_RUNTIME_WIRED,
} = require('./email-luna-controlled-drafting-operation-store');
const {
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_WIRED,
  EMAIL_LUNA_CONTROLLED_DRAFTING_ACTIVATION,
  EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER,
  EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_KEY,
  EMAIL_LUNA_CONTROLLED_DRAFTING_CAPABILITY_MANIFEST,
  readControlledDraftingKnownCreateDraftId,
} = require('./email-luna-controlled-drafting-provider-contract');
const {
  readTrustedControlledDraftingTokenLoanFailure,
} = require('./email-luna-controlled-drafting-token-loan');
const {
  isProxySurface,
  ownData,
  exactOwnData,
  subsetOwnData,
  isCanonUuid,
} = require('./email-luna-controlled-drafting-closed-data');

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const arrayIncludes = uncurryThis(Array.prototype.includes);
const objectCreate = Object.create;
const objectDefineProperty = Object.defineProperty;
const objectFreeze = Object.freeze;
const objectHasOwn = Object.hasOwn;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectPrototype = Object.prototype;
const reflectOwnKeys = Reflect.ownKeys;
const arrayIsArray = Array.isArray;
const stringTrim = uncurryThis(String.prototype.trim);
const stringToLowerCase = uncurryThis(String.prototype.toLowerCase);
const PRODUCER_LOANERS = new WeakMap();
const WORKER_LOANERS = new WeakMap();
const SOURCE_KIND = new WeakMap();

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
  'env', 'producerWithTransactionClient', 'workerWithTransactionClient', 'provider', 'issuanceStore',
]);
const OPTIONAL_CREATE_KEYS = objectFreeze([
  'crashSeams',
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
  const snapshot = exactOwnData(value, keys);
  if (!snapshot || !rejectForbiddenFields(snapshot)) throw invalid();
  return snapshot;
}

function subsetPlain(value, allowed) {
  const snapshot = subsetOwnData(value, allowed);
  if (!snapshot || !rejectForbiddenFields(snapshot)) throw invalid();
  return snapshot;
}

function parseUuid(raw) {
  if (typeof raw !== 'string' || stringTrim(raw) !== raw) return null;
  const id = stringToLowerCase(raw);
  return isCanonUuid(id) ? id : null;
}

function bindProducerWithTransactionClient(fn) {
  if (typeof fn !== 'function' || isProxySurface(fn)
      || PRODUCER_LOANERS.has(fn) || WORKER_LOANERS.has(fn)) {
    throw invalid();
  }
  const existing = SOURCE_KIND.get(fn);
  if (existing && existing !== 'producer') throw invalid();
  async function producerWithTransactionClient(work) {
    return fn(work);
  }
  SOURCE_KIND.set(fn, 'producer');
  PRODUCER_LOANERS.set(producerWithTransactionClient, fn);
  return producerWithTransactionClient;
}

function bindWorkerWithTransactionClient(fn) {
  if (typeof fn !== 'function' || isProxySurface(fn)
      || PRODUCER_LOANERS.has(fn) || WORKER_LOANERS.has(fn)) {
    throw invalid();
  }
  const existing = SOURCE_KIND.get(fn);
  if (existing && existing !== 'worker') throw invalid();
  async function workerWithTransactionClient(work) {
    return fn(work);
  }
  SOURCE_KIND.set(fn, 'worker');
  WORKER_LOANERS.set(workerWithTransactionClient, fn);
  return workerWithTransactionClient;
}

function producerFacade(store) {
  return freeze({
    reserveControlledDraft: ownData(store, 'reserveControlledDraft'),
    loadControlledDraft: ownData(store, 'loadControlledDraft'),
    assertAuthenticLoadedOperation: ownData(store, 'assertAuthenticLoadedOperation'),
  });
}

function workerFacade(store) {
  return freeze({
    loadControlledDraft: ownData(store, 'loadControlledDraft'),
    assertAuthenticLoadedOperation: ownData(store, 'assertAuthenticLoadedOperation'),
    claimCreateDispatch: ownData(store, 'claimCreateDispatch'),
    recordProviderCreate: ownData(store, 'recordProviderCreate'),
    reconcileProviderDraft: ownData(store, 'reconcileProviderDraft'),
  });
}

const PRINCIPAL_AUTHORIZED_REG =
  'public.tenant_email_luna_automation_principal_authorized(text, uuid, uuid, text)';
const RESERVE_REG =
  'public.tenant_email_luna_controlled_draft_reserve(uuid, uuid, text, text, text, text, text, text)';
const CLAIM_REG = 'public.tenant_email_luna_controlled_draft_claim_create(uuid, uuid, integer)';
const RECORD_REG = 'public.tenant_email_luna_controlled_draft_record_create(uuid, uuid, integer, jsonb)';
const RECONCILE_REG = 'public.tenant_email_luna_controlled_draft_reconcile(uuid, uuid, integer, jsonb)';
const LOAD_REG = 'public.tenant_email_luna_controlled_draft_load(uuid, uuid)';
const ATTEST_KEYS = objectFreeze([
  'session_user',
  'current_user',
  'table_owner',
  'session_distinct_from_owner',
  'session_matches_current',
  'mapping_ok',
  'login_contract_ok',
  'execute_ok',
]);

function privilegeSql(reg) {
  return [
    'CASE',
    `  WHEN pg_catalog.to_regprocedure('${reg}') IS NULL THEN FALSE`,
    '  ELSE pg_catalog.has_function_privilege(',
    '    session_user,',
    `    '${reg}'::pg_catalog.regprocedure,`,
    "    'EXECUTE'",
    '  )',
    'END',
  ].join('\n');
}

function mappingSql(kindLiteral) {
  return [
    'CASE',
    `  WHEN pg_catalog.to_regprocedure('${PRINCIPAL_AUTHORIZED_REG}') IS NULL THEN FALSE`,
    `  WHEN NOT pg_catalog.has_function_privilege(`,
    '    session_user,',
    `    '${PRINCIPAL_AUTHORIZED_REG}'::pg_catalog.regprocedure,`,
    "    'EXECUTE'",
    '  ) THEN FALSE',
    `  ELSE public.tenant_email_luna_automation_principal_authorized('${kindLiteral}', $1::uuid, $2::uuid, $3::text)`,
    'END',
  ].join('\n');
}

function attestSql(kindLiteral, executeRegs) {
  if (kindLiteral !== 'producer' && kindLiteral !== 'worker') {
    throw new Error('controlled_drafting_attest_sql_kind');
  }
  const executeParts = [];
  for (let i = 0; i < executeRegs.length; i += 1) {
    if (i > 0) executeParts.push(' AND ');
    executeParts.push('(\n', privilegeSql(executeRegs[i]), '\n)');
  }
  return [
    'SELECT',
    '  session_user::text AS session_user,',
    '  current_user::text AS current_user,',
    '  owner.rolname::text AS table_owner,',
    '  (',
    '    session_user IS NOT NULL',
    '    AND owner.rolname IS NOT NULL',
    '    AND session_user::text IS DISTINCT FROM owner.rolname::text',
    '  ) AS session_distinct_from_owner,',
    '  (',
    '    session_user IS NOT NULL',
    '    AND session_user::text IS NOT DISTINCT FROM current_user::text',
    '  ) AS session_matches_current,',
    `  (\n${mappingSql(kindLiteral)}\n  ) AS mapping_ok,`,
    '  EXISTS (',
    '    SELECT 1',
    '      FROM pg_catalog.pg_roles r',
    '     WHERE r.rolname = session_user',
    '       AND r.rolcanlogin IS TRUE',
    '       AND r.rolsuper IS FALSE',
    '       AND r.rolcreatedb IS FALSE',
    '       AND r.rolcreaterole IS FALSE',
    '       AND r.rolreplication IS FALSE',
    '       AND r.rolbypassrls IS FALSE',
    '  ) AS login_contract_ok,',
    `  (\n${executeParts.join('')}\n  ) AS execute_ok`,
    'FROM (',
    '  SELECT r.rolname',
    '    FROM pg_catalog.pg_roles r',
    '    JOIN pg_catalog.pg_class c ON c.relowner = r.oid',
    '    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace',
    "   WHERE n.nspname = 'public'",
    "     AND c.relname = 'tenant_email_luna_automation_queue'",
    "     AND c.relkind = 'r'",
    ') AS owner',
  ].join('\n');
}

// Fixed producer/worker variants. expectedKind only selects between these;
// caller strings are never concatenated into SQL or regprocedure literals.
// Mapping is SECURITY DEFINER principal_authorized (088/092): mapped LOGINs
// have no SELECT on principals. Table-owner bypass of that function is refused.
const PRODUCER_ATTEST_SQL = attestSql('producer', objectFreeze([RESERVE_REG, LOAD_REG]));
const WORKER_ATTEST_SQL = attestSql('worker', objectFreeze([CLAIM_REG, RECORD_REG, RECONCILE_REG, LOAD_REG]));

function readAttestRow(result) {
  if (!result || typeof result !== 'object' || isProxySurface(result) || arrayIsArray(result)) {
    throw invalid();
  }
  const rows = ownData(result, 'rows');
  if (!arrayIsArray(rows) || rows.length !== 1 || isProxySurface(rows)) throw invalid();
  const row = ownData(rows, 0);
  if (!row || typeof row !== 'object' || isProxySurface(row) || arrayIsArray(row)) throw invalid();
  const parsed = exactOwnData(row, ATTEST_KEYS);
  if (!parsed) throw invalid();
  return parsed;
}

function closedAttestBinding(binding) {
  if (!binding || typeof binding !== 'object' || isProxySurface(binding) || arrayIsArray(binding)) {
    throw invalid();
  }
  const clientId = ownData(binding, 'client_id');
  const locationId = ownData(binding, 'location_id');
  const locationKey = ownData(binding, 'location_key');
  if (!isCanonUuid(clientId) || !isCanonUuid(locationId)) throw invalid();
  if (typeof locationKey !== 'string' || locationKey !== SUNSET_LOCATION_KEY) throw invalid();
  return objectFreeze({
    client_id: clientId,
    location_id: locationId,
    location_key: locationKey,
  });
}

function resolveQuery(client) {
  if (!client || (typeof client !== 'object' && typeof client !== 'function') || isProxySurface(client)) {
    return null;
  }
  const own = objectGetOwnPropertyDescriptor(client, 'query');
  if (own) {
    return objectHasOwn(own, 'value') && typeof own.value === 'function' && !own.get && !own.set
      ? own.value
      : null;
  }
  let proto = objectGetPrototypeOf(client);
  let depth = 0;
  while (proto && proto !== objectPrototype && depth < 8) {
    if (isProxySurface(proto)) return null;
    const descriptor = objectGetOwnPropertyDescriptor(proto, 'query');
    if (descriptor) {
      return objectHasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
        && !descriptor.get && !descriptor.set
        ? descriptor.value
        : null;
    }
    proto = objectGetPrototypeOf(proto);
    depth += 1;
  }
  return null;
}

function acceptAttestRow(row) {
  const sessionUser = ownData(row, 'session_user');
  const currentUser = ownData(row, 'current_user');
  const tableOwner = ownData(row, 'table_owner');
  if (typeof sessionUser !== 'string' || sessionUser.length < 1) throw invalid();
  if (typeof currentUser !== 'string' || currentUser.length < 1) throw invalid();
  if (typeof tableOwner !== 'string' || tableOwner.length < 1) throw invalid();
  if (sessionUser !== currentUser) throw invalid();
  if (sessionUser === tableOwner) throw invalid();
  if (ownData(row, 'session_distinct_from_owner') !== true) throw invalid();
  if (ownData(row, 'session_matches_current') !== true) throw invalid();
  if (ownData(row, 'mapping_ok') !== true) throw invalid();
  if (ownData(row, 'login_contract_ok') !== true) throw invalid();
  if (ownData(row, 'execute_ok') !== true) throw invalid();
}

async function attestMappedPrincipal(loaner, expectedKind, binding) {
  let sql;
  if (expectedKind === 'producer') sql = PRODUCER_ATTEST_SQL;
  else if (expectedKind === 'worker') sql = WORKER_ATTEST_SQL;
  else throw invalid();
  const closed = closedAttestBinding(binding);
  return loaner(async (client) => {
    if (!client || typeof client !== 'object' || isProxySurface(client) || arrayIsArray(client)) {
      throw invalid();
    }
    const queryFn = resolveQuery(client);
    if (typeof queryFn !== 'function' || isProxySurface(queryFn)) throw invalid();
    let result;
    try {
      result = await queryFn.call(client, sql, [closed.client_id, closed.location_id, closed.location_key]);
    } catch (_) {
      throw invalid();
    }
    acceptAttestRow(readAttestRow(result));
  });
}

function failedMappedPrincipalInspect() {
  return freeze({
    ok: false,
    inspect_failed: true,
    login_ok: false,
    mapping_ok: false,
    execute_ok: false,
    principal_applied: false,
    session_user: null,
    reason: 'inspect_failed',
  });
}

async function inspectEmailLunaControlledDraftingMappedPrincipal(client, binding, kind) {
  if (kind !== 'producer' && kind !== 'worker') return failedMappedPrincipalInspect();
  let closed;
  try {
    closed = closedAttestBinding(binding);
  } catch (_) {
    return failedMappedPrincipalInspect();
  }
  const queryFn = resolveQuery(client);
  if (typeof queryFn !== 'function' || isProxySurface(queryFn)) return failedMappedPrincipalInspect();
  const sql = kind === 'producer' ? PRODUCER_ATTEST_SQL : WORKER_ATTEST_SQL;
  let result;
  try {
    result = await queryFn.call(client, sql, [closed.client_id, closed.location_id, closed.location_key]);
  } catch (_) {
    return failedMappedPrincipalInspect();
  }
  try {
    const row = readAttestRow(result);
    acceptAttestRow(row);
    return freeze({
      ok: true,
      inspect_failed: false,
      login_ok: true,
      mapping_ok: true,
      execute_ok: true,
      principal_applied: true,
      session_user: null,
      reason: 'ready',
    });
  } catch (_) {
    let mappingOk = false;
    let executeOk = false;
    let loginOk = false;
    try {
      const row = readAttestRow(result);
      mappingOk = ownData(row, 'mapping_ok') === true;
      executeOk = ownData(row, 'execute_ok') === true;
      loginOk = ownData(row, 'session_matches_current') === true
        && ownData(row, 'session_distinct_from_owner') === true
        && ownData(row, 'login_contract_ok') === true;
    } catch (__) { /* unreadable */ }
    return freeze({
      ok: false,
      inspect_failed: false,
      login_ok: loginOk,
      mapping_ok: mappingOk,
      execute_ok: executeOk,
      principal_applied: mappingOk,
      session_user: null,
      reason: 'principal_unproven',
    });
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
    ['provider_draft_id', fields.provider_draft_id || null],
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
  const observedId = ownData(result, 'provider_draft_id');
  const observedDraft = ownData(result, 'is_draft');
  const observedSubject = ownData(result, 'subject_digest');
  const observedBody = ownData(result, 'body_digest');
  if (outcome === 'draft_present' && observedDraft === true
      && typeof observedId === 'string'
      && typeof observedSubject === 'string' && typeof observedBody === 'string') {
    return {
      kind: 'exact',
      provider_draft_id: observedId,
      is_draft: true,
      subject_digest: observedSubject,
      body_digest: observedBody,
    };
  }
  if (outcome === 'draft_modified' && observedDraft === true && typeof observedId === 'string') {
    return {
      kind: 'modified_by_staff',
      provider_draft_id: observedId,
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
  if (producerLoaner === workerLoaner) throw invalid();
  if (!PRODUCER_LOANERS.has(producerLoaner) || !WORKER_LOANERS.has(workerLoaner)) throw invalid();
  if (PRODUCER_LOANERS.get(producerLoaner) === WORKER_LOANERS.get(workerLoaner)) throw invalid();
  const provider = closedProvider(deps.provider);
  let crashSeams = null;
  if (objectHasOwn(deps, 'crashSeams')) {
    crashSeams = subsetPlain(deps.crashSeams, CRASH_SEAM_KEYS);
  }
  const producerStore = producerFacade(createEmailLunaControlledDraftingOperationStore({
    withTransactionClient: producerLoaner,
  }));
  const workerStore = workerFacade(createEmailLunaControlledDraftingOperationStore({
    withTransactionClient: workerLoaner,
  }));
  const issuanceStore = deps.issuanceStore;
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
    await attestMappedPrincipal(producerLoaner, 'producer', binding);
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
    } catch (error) {
      const knownId = readControlledDraftingKnownCreateDraftId(error);
      const tokenFail = readTrustedControlledDraftingTokenLoanFailure(error);
      if (tokenFail && !knownId) {
        return tickEvidence({
          status: 'create_dispatched_outcome_unknown',
          reason: 'token_loan_failed_after_claim_no_provider_post',
          operation_id: claimedRecord.operation_id,
          issuance_id: claimedRecord.issuance_id,
          state: 'create_dispatched_outcome_unknown',
          provider_invoked: false,
          create_invoked: false,
        });
      }
      return tickEvidence({
        status: 'create_dispatched_outcome_unknown',
        reason: knownId
          ? 'create_outcome_unknown_known_id_not_durable'
          : 'provider_create_unknown',
        operation_id: claimedRecord.operation_id,
        issuance_id: claimedRecord.issuance_id,
        state: 'create_dispatched_outcome_unknown',
        provider_invoked: true,
        create_invoked: true,
        provider_draft_id: knownId,
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
      await attestMappedPrincipal(workerLoaner, 'worker', binding);
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
  bindProducerWithTransactionClient,
  bindWorkerWithTransactionClient,
  inspectEmailLunaControlledDraftingMappedPrincipal,
});

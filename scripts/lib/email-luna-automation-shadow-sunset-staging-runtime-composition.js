'use strict';

/**
 * FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B5: default-off Sunset-staging
 * runtime composition for B2+B3+B4 shadow comparison.
 *
 * Canonical process owner is Staff API. This module is the smallest
 * import-inert adapter around the existing provider-inert worker loop.
 * RUNTIME_WIRED is true for composition code only. Activation remains
 * default-off: explicit start() after exact independent flags + Sunset
 * tenant/location/endpoint/environment gates. Provider-inert:
 * no dispatch authorization, no journal handoff.
 *
 * Replica topology is fail-closed: EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_REPLICA_COUNT
 * must be the exact string '1'. Process concurrency=1 plus SKIP LOCKED prevents
 * duplicate claims on one replica; enabling this composition on multiple Staff API
 * replicas still starts multiple workers. That is not global concurrency=1.
 */

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const runtimeIsProxy = require('node:util').types.isProxy.bind(undefined);
const nodeCrypto = require('node:crypto');
const {
  createEmailLunaAutomationShadowWorkerKernel,
  createEmailLunaAutomationShadowWorkerLoop,
  isEmailLunaAutomationShadowWorkerEnabled,
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_RUNTIME_WIRED,
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_CONCURRENCY,
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_MIN_INTERVAL_MS,
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_MAX_INTERVAL_MS,
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_STOP_DRAIN_TIMEOUT_MS,
  ENV_SHADOW_WORKER_ENABLED,
} = require('./email-luna-automation-shadow-worker');
const {
  ENV_WORKER_DATABASE_URL,
  resolveEmailLunaAutomationShadowWorkerConnectionConfig,
} = require('./email-luna-automation-shadow-worker-connection');
const {
  isEmailLunaAutomationShadowEnabled,
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_WIRED,
  ENV_SHADOW_ENABLED,
} = require('./email-luna-automation-shadow-orchestration');
const {
  EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_RUNTIME_WIRED,
  EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH,
} = require('./email-luna-automation-shadow-outcome-store');

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
const cryptoRandomUUID = typeof nodeCrypto.randomUUID === 'function' ? nodeCrypto.randomUUID.bind(nodeCrypto) : null;

const EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_WIRED = true;
const EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ACTIVATION = false;
const EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_LOGGING_FORBIDDEN = true;
const ENV_COMPOSITION_ENABLED = 'EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ENABLED';
const ENV_CLIENT_ID = 'EMAIL_LUNA_AUTOMATION_SHADOW_CLIENT_ID';
const ENV_LOCATION_ID = 'EMAIL_LUNA_AUTOMATION_SHADOW_LOCATION_ID';
const ENV_LOCATION_KEY = 'EMAIL_LUNA_AUTOMATION_SHADOW_LOCATION_KEY';
const ENV_ENDPOINT_ID = 'EMAIL_LUNA_AUTOMATION_SHADOW_ENDPOINT_ID';
const ENV_DEPLOYMENT = 'LUNA_DEPLOYMENT';
const ENV_TENANT = 'DEFAULT_CLIENT_SLUG';
const ENV_AUTO_SEND = 'LUNA_AUTO_SEND_ENABLED';
const ENV_OUTBOUND = 'EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED';
const ENV_DRAFT_RUNTIME = 'EMAIL_LUNA_DRAFT_RUNTIME_ENABLED';
const ENV_REPLICA_COUNT = 'EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_REPLICA_COUNT';
const nativeSetTimeout = setTimeout;
const SUNSET_DEPLOYMENT = 'sunset-staging';
const SUNSET_TENANT = 'sunset';
const SUNSET_LOCATION_KEY = 'sunset-somo';
const SHADOW_MODE = 'shadow';
const MIGRATION_093_ID = '093_tenant_email_luna_automation_shadow_outcomes';
const MIGRATION_094_ID = '094_tenant_email_luna_automation_shadow_outcome_identity_match';
const MIGRATION_095_ID = '095_tenant_email_luna_automation_claim_scoped';
const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ERROR_CODE = 'EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_INVALID';
const DISABLED_CODE = 'EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_DISABLED';

const COMPOSITION_ENV_KEYS = objectFreeze([
  ENV_DEPLOYMENT,
  ENV_TENANT,
  ENV_COMPOSITION_ENABLED,
  ENV_SHADOW_ENABLED,
  ENV_SHADOW_WORKER_ENABLED,
  ENV_CLIENT_ID,
  ENV_LOCATION_ID,
  ENV_LOCATION_KEY,
  ENV_ENDPOINT_ID,
  ENV_REPLICA_COUNT,
]);
const CREATE_KEYS = objectFreeze(['env', 'withTransactionClient', 'timers', 'intervalMs']);
const TIMER_KEYS = objectFreeze(['setTimeout', 'clearTimeout']);
const FORBIDDEN_INPUT_KEYS = objectFreeze([
  'status', 'would_send', 'would_not_send', 'send', 'provider', 'callback', 'onSend',
  'authorize_dispatch', 'authorize_create', 'authorize_update', 'claim', 'handoff',
  'https', 'graph', 'transport', 'capability',
  'auto_send_allowed', 'provider_invoked', 'journal_handoff',
]);
const SCHEMA_SQL = [
  'SELECT',
  '  EXISTS (',
  '    SELECT 1 FROM pg_catalog.pg_class c',
  '    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace',
  "    WHERE n.nspname = 'public'",
  "      AND c.relname = 'tenant_email_luna_automation_shadow_outcomes'",
  "      AND c.relkind = 'r'",
  '  ) AS outcomes_table,',
  "  pg_catalog.to_regprocedure('public.tenant_email_luna_automation_capture_shadow(uuid, uuid)') IS NOT NULL AS capture_fn,",
  "  pg_catalog.to_regprocedure('public.tenant_email_luna_automation_shadow_outcome_load(uuid, uuid)') IS NOT NULL AS load_fn,",
  "  pg_catalog.to_regprocedure('public.tenant_email_luna_automation_shadow_outcome_project(uuid, uuid)') IS NOT NULL AS project_fn,",
  "  pg_catalog.to_regprocedure('public.tenant_email_luna_automation_claim_scoped(uuid, uuid, uuid, text, uuid)') IS NOT NULL AS scoped_claim_fn,",
  '  session_user::text AS session_user,',
  '  (',
  '    SELECT r.rolname::text',
  '      FROM pg_catalog.pg_roles r',
  '      JOIN pg_catalog.pg_class c ON c.relowner = r.oid',
  '      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace',
  "     WHERE n.nspname = 'public'",
  "       AND c.relname = 'tenant_email_luna_automation_queue'",
  "       AND c.relkind = 'r'",
  '  ) AS table_owner,',
  '  CASE',
  "    WHEN pg_catalog.to_regprocedure('public.tenant_email_luna_automation_shadow_outcome_project(uuid, uuid)') IS NULL THEN NULL",
  "    ELSE pg_catalog.pg_get_functiondef('public.tenant_email_luna_automation_shadow_outcome_project(uuid, uuid)'::pg_catalog.regprocedure)",
  '  END AS project_def',
].join('\n');

if (EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_WIRED !== true
    || EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ACTIVATION !== false
    || EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_RUNTIME_WIRED !== false
    || EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_WIRED !== false
    || EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_RUNTIME_WIRED !== false) {
  throw new Error('email_luna_automation_shadow_runtime_composition_activation_unexpected');
}
if (EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_CONCURRENCY !== 1) {
  throw new Error('email_luna_automation_shadow_runtime_composition_concurrency_unexpected');
}

function invalid() {
  const error = new Error('Email Luna automation shadow runtime composition failed.');
  error.code = ERROR_CODE;
  return error;
}

function disabledError() {
  const error = new Error('Email Luna automation shadow runtime composition disabled.');
  error.code = DISABLED_CODE;
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

function exactPlain(value, keys) {
  if (value === null || typeof value !== 'object' || runtimeIsProxy(value) || arrayIsArray(value)) throw invalid();
  try {
    if (objectGetPrototypeOf(value) !== objectPrototype) throw invalid();
    const ownKeys = safeOwnKeys(value);
    if (ownKeys.length !== keys.length) throw invalid();
    const snapshot = objectCreate(null);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (!arrayIncludes(ownKeys, key)) throw invalid();
      const descriptor = objectGetOwnPropertyDescriptor(value, key);
      if (!descriptor || !objectHasOwn(descriptor, 'value') || !descriptor.enumerable) throw invalid();
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
    if (!value || typeof value !== 'object' || runtimeIsProxy(value) || arrayIsArray(value)) return undefined;
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

function refuseForbiddenKeys(value) {
  const ownKeys = safeOwnKeys(value);
  for (let index = 0; index < ownKeys.length; index += 1) {
    if (arrayIncludes(FORBIDDEN_INPUT_KEYS, ownKeys[index])) throw invalid();
  }
}

function mintOwnerToken() {
  if (typeof cryptoRandomUUID !== 'function') throw invalid();
  const token = parseUuid(cryptoRandomUUID());
  if (!token) throw invalid();
  return token;
}

function readBinding(env) {
  const clientId = parseUuid(ownData(env, ENV_CLIENT_ID));
  const locationId = parseUuid(ownData(env, ENV_LOCATION_ID));
  const endpointId = parseUuid(ownData(env, ENV_ENDPOINT_ID));
  const locationKey = ownData(env, ENV_LOCATION_KEY);
  return {
    client_id: clientId,
    location_id: locationId,
    location_key: locationKey,
    endpoint_id: endpointId,
  };
}

function isConflictTruthy(raw) {
  if (raw === true) return true;
  if (typeof raw !== 'string') return false;
  const value = stringToLowerCase(stringTrim(raw));
  return value === 'true' || value === '1' || value === 'yes' || value === 'on';
}

function refusedCapabilities(env) {
  return isConflictTruthy(ownData(env, ENV_AUTO_SEND))
    || isConflictTruthy(ownData(env, ENV_OUTBOUND));
}

function replicaCountExact(env) {
  return ownData(env, ENV_REPLICA_COUNT) === '1';
}

function workerConnectionReady(env) {
  try {
    const config = resolveEmailLunaAutomationShadowWorkerConnectionConfig({
      env,
      appConnectionString: ownData(env, 'WOLFHOUSE_DATABASE_URL') || ownData(env, 'DATABASE_URL'),
    });
    return Boolean(config && config.ok === true);
  } catch (_) {
    return false;
  }
}

function flagsExact(env) {
  return envFlag(env, ENV_COMPOSITION_ENABLED)
    && envFlag(env, ENV_SHADOW_ENABLED)
    && envFlag(env, ENV_SHADOW_WORKER_ENABLED)
    && ownData(env, ENV_DEPLOYMENT) === SUNSET_DEPLOYMENT
    && ownData(env, ENV_TENANT) === SUNSET_TENANT
    && ownData(env, ENV_LOCATION_KEY) === SUNSET_LOCATION_KEY;
}

function bindingComplete(binding) {
  return Boolean(binding.client_id && binding.location_id && binding.endpoint_id
    && binding.location_key === SUNSET_LOCATION_KEY);
}

function childGatesEnabled(env, binding) {
  const authority = {
    client_id: binding.client_id,
    location_id: binding.location_id,
    location_key: SUNSET_LOCATION_KEY,
  };
  const producerGate = {
    client_id: binding.client_id,
    location_id: binding.location_id,
    location_key: SUNSET_LOCATION_KEY,
    shadow_enabled: true,
  };
  const workerGate = {
    client_id: binding.client_id,
    location_id: binding.location_id,
    location_key: SUNSET_LOCATION_KEY,
    shadow_enabled: true,
    endpoint_id: binding.endpoint_id,
  };
  return isEmailLunaAutomationShadowEnabled({
    env: { LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT, [ENV_SHADOW_ENABLED]: 'true' },
    tenant_location_gate: producerGate,
    authority,
  }) === true
    && isEmailLunaAutomationShadowWorkerEnabled({
      env: { LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT, [ENV_SHADOW_WORKER_ENABLED]: 'true' },
      tenant_location_gate: workerGate,
      authority,
    }) === true;
}

function substituteAttempt(env) {
  if (envFlag(env, ENV_COMPOSITION_ENABLED)) return false;
  return envFlag(env, ENV_SHADOW_ENABLED)
    || envFlag(env, ENV_SHADOW_WORKER_ENABLED)
    || envFlag(env, ENV_DRAFT_RUNTIME);
}

function presentFlagCount(env) {
  let count = 0;
  if (ownData(env, ENV_COMPOSITION_ENABLED) !== undefined) count += 1;
  if (ownData(env, ENV_SHADOW_ENABLED) !== undefined) count += 1;
  if (ownData(env, ENV_SHADOW_WORKER_ENABLED) !== undefined) count += 1;
  return count;
}

function resolveEmailLunaAutomationShadowSunsetStagingRuntimeReadiness(env) {
  const inert = output([
    ['ok', true],
    ['runtime_activation', false],
    ['composition_wired', true],
    ['provider_capability', false],
    ['journal_handoff', false],
    ['mode', SHADOW_MODE],
    ['comparison_state_label', EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.unique_human_would_send],
    ['comparison_kind', EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.unique_human_kind],
    ['reason', 'default_off'],
  ]);
  try {
    if (!env || typeof env !== 'object' || runtimeIsProxy(env) || arrayIsArray(env)) {
      return output([
        ['ok', false],
        ['runtime_activation', false],
        ['composition_wired', true],
        ['provider_capability', false],
        ['journal_handoff', false],
        ['mode', SHADOW_MODE],
        ['comparison_state_label', EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.unique_human_would_send],
        ['comparison_kind', EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.unique_human_kind],
        ['reason', 'invalid_env'],
      ]);
    }
    if (refusedCapabilities(env)) {
      return output([
        ['ok', false],
        ['runtime_activation', false],
        ['composition_wired', true],
        ['provider_capability', false],
        ['journal_handoff', false],
        ['mode', SHADOW_MODE],
        ['comparison_state_label', EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.unique_human_would_send],
        ['comparison_kind', EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.unique_human_kind],
        ['reason', 'provider_capability_refused'],
      ]);
    }
    const binding = readBinding(env);
    if (!flagsExact(env) || !bindingComplete(binding) || !childGatesEnabled(env, binding)) {
      const flagsAbsent = presentFlagCount(env) === 0;
      const reason = flagsAbsent
        ? 'default_off'
        : (substituteAttempt(env) ? 'flag_substitution' : 'partial_or_mismatched_gates');
      return output([
        ['ok', flagsAbsent],
        ['runtime_activation', false],
        ['composition_wired', true],
        ['provider_capability', false],
        ['journal_handoff', false],
        ['mode', SHADOW_MODE],
        ['comparison_state_label', EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.unique_human_would_send],
        ['comparison_kind', EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.unique_human_kind],
        ['reason', reason],
      ]);
    }
    if (!replicaCountExact(env)) {
      return output([
        ['ok', false],
        ['runtime_activation', false],
        ['composition_wired', true],
        ['provider_capability', false],
        ['journal_handoff', false],
        ['mode', SHADOW_MODE],
        ['comparison_state_label', EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.unique_human_would_send],
        ['comparison_kind', EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.unique_human_kind],
        ['reason', 'replica_topology_unproven'],
      ]);
    }
    if (!workerConnectionReady(env)) {
      return output([
        ['ok', false],
        ['runtime_activation', false],
        ['composition_wired', true],
        ['provider_capability', false],
        ['journal_handoff', false],
        ['mode', SHADOW_MODE],
        ['comparison_state_label', EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.unique_human_would_send],
        ['comparison_kind', EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.unique_human_kind],
        ['reason', 'worker_connection_required'],
      ]);
    }
    return output([
      ['ok', true],
      ['runtime_activation', true],
      ['composition_wired', true],
      ['provider_capability', false],
      ['journal_handoff', false],
      ['mode', SHADOW_MODE],
      ['comparison_state_label', EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.unique_human_would_send],
      ['comparison_kind', EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH.unique_human_kind],
      ['reason', 'exact_sunset_gates'],
    ]);
  } catch (_) {
    return inert;
  }
}

function projectDefSafe(def) {
  if (typeof def !== 'string') return false;
  return def.indexOf("matched := 'staff_action_observed'") !== -1
    && def.indexOf("matched := 'agreement'") === -1;
}

function createEmailLunaAutomationShadowSunsetStagingRuntimeComposition(dependencies) {
  if (arguments.length !== 1) throw invalid();
  refuseForbiddenKeys(dependencies);
  const deps = exactPlain(dependencies, CREATE_KEYS);
  const withTransactionClient = deps.withTransactionClient;
  if (typeof withTransactionClient !== 'function' || runtimeIsProxy(withTransactionClient)) throw invalid();
  const timers = exactPlain(deps.timers, TIMER_KEYS);
  if (typeof timers.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function') throw invalid();
  if (runtimeIsProxy(timers.setTimeout) || runtimeIsProxy(timers.clearTimeout)) throw invalid();
  const intervalMs = deps.intervalMs;
  if (!Number.isInteger(intervalMs)
      || intervalMs < EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_MIN_INTERVAL_MS
      || intervalMs > EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_MAX_INTERVAL_MS) {
    throw invalid();
  }
  const env = deps.env;
  const readiness = resolveEmailLunaAutomationShadowSunsetStagingRuntimeReadiness(env);
  if (!readiness || readiness.runtime_activation !== true) throw disabledError();
  const binding = readBinding(env);
  const ownerToken = mintOwnerToken();
  const kernel = createEmailLunaAutomationShadowWorkerKernel({
    withTransactionClient,
    env: {
      LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      [ENV_SHADOW_WORKER_ENABLED]: 'true',
    },
    tenant_location_gate: {
      client_id: binding.client_id,
      location_id: binding.location_id,
      location_key: SUNSET_LOCATION_KEY,
      shadow_enabled: true,
      endpoint_id: binding.endpoint_id,
    },
    owner_token: ownerToken,
  });
  const loop = createEmailLunaAutomationShadowWorkerLoop({
    kernel,
    timers: deps.timers,
    intervalMs,
  });

  let schemaVerified = false;
  let tickPromise = null;
  let started = false;

  async function verifySchema() {
    if (schemaVerified) return;
    const row = await withTransactionClient(async (client) => {
      if (!client || typeof client !== 'object' || runtimeIsProxy(client) || typeof client.query !== 'function') {
        throw invalid();
      }
      const result = await Promise.resolve(client.query(SCHEMA_SQL, []));
      const rows = result && arrayIsArray(result.rows) ? result.rows : [];
      if (rows.length !== 1) throw invalid();
      return rows[0];
    });
    if (!row || row.outcomes_table !== true || row.capture_fn !== true || row.load_fn !== true || row.project_fn !== true) {
      throw invalid();
    }
    if (row.scoped_claim_fn !== true) throw invalid();
    if (typeof row.session_user !== 'string' || typeof row.table_owner !== 'string') throw invalid();
    if (row.session_user === row.table_owner) throw invalid();
    if (!projectDefSafe(row.project_def)) throw invalid();
    schemaVerified = true;
  }

  async function tick() {
    if (arguments.length !== 0) throw invalid();
    if (!started) {
      return output([
        ['status', 'stopped'],
        ['reason', 'not_started'],
        ['mode', SHADOW_MODE],
        ['provider_invoked', false],
        ['journal_handoff', false],
        ['send_allowed', false],
      ]);
    }
    if (tickPromise) {
      return output([
        ['status', 'overlap_skipped'],
        ['reason', null],
        ['mode', SHADOW_MODE],
        ['provider_invoked', false],
        ['journal_handoff', false],
        ['send_allowed', false],
      ]);
    }
    tickPromise = Promise.resolve(loop.tick());
    try {
      return await tickPromise;
    } finally {
      tickPromise = null;
    }
  }

  async function start() {
    if (started) return;
    await verifySchema();
    started = true;
    loop.start();
  }

  async function stop() {
    started = false;
    const loopStop = Promise.resolve(loop.stop());
    const currentTick = tickPromise;
    await Promise.race([
      Promise.all([
        loopStop,
        currentTick ? currentTick.then(() => {}, () => {}) : Promise.resolve(),
      ]),
      new Promise((resolve) => {
        const handle = nativeSetTimeout(resolve, EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_STOP_DRAIN_TIMEOUT_MS);
        if (handle && typeof handle.unref === 'function') handle.unref();
      }),
    ]);
  }

  return freeze({
    start,
    stop,
    tick,
    getReadiness: () => readiness,
    getBinding: () => freeze({
      client_id: binding.client_id,
      location_id: binding.location_id,
      location_key: SUNSET_LOCATION_KEY,
      endpoint_id: binding.endpoint_id,
    }),
  });
}

module.exports = objectFreeze({
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_WIRED,
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ACTIVATION,
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_LOGGING_FORBIDDEN,
  ENV_COMPOSITION_ENABLED,
  ENV_CLIENT_ID,
  ENV_LOCATION_ID,
  ENV_LOCATION_KEY,
  ENV_ENDPOINT_ID,
  ENV_REPLICA_COUNT,
  ENV_WORKER_DATABASE_URL,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  SUNSET_LOCATION_KEY,
  SHADOW_MODE,
  MIGRATION_093_ID,
  MIGRATION_094_ID,
  MIGRATION_095_ID,
  SCHEMA_SQL,
  COMPOSITION_ENV_KEYS,
  ERROR_CODE,
  DISABLED_CODE,
  resolveEmailLunaAutomationShadowSunsetStagingRuntimeReadiness,
  createEmailLunaAutomationShadowSunsetStagingRuntimeComposition,
});

'use strict';

/**
 * Email-delta runtime config adapter (default-off; worker/admin activation-impossible).
 *
 * Exact independent booleans (default false; only the string `'true'` enables a flag):
 *   LUNA_EMAIL_DELTA_RUNTIME_COMPOSITION_ENABLED
 *   LUNA_EMAIL_DELTA_WORKER_ENABLED
 *   LUNA_EMAIL_DELTA_ADMIN_ENABLED
 *
 * Semantics for this PR:
 *   - All absent/false → disabled (ok, inert).
 *   - Composition alone (`true`) + exact deployment/tenant/worker/migration064/KV pins
 *     → composition_inert (structurally ready; no scheduler/admin/run).
 *   - Worker or admin `'true'` → fail closed (`activation_rejected`) — activation
 *     impossible; no runnable worker/admin surface may be produced.
 *   - Composition true with invalid deployment/tenant/identity/migration/KV pins
 *     → fail closed (`config_invalid`).
 *
 * Trusted deployment binding only (never request-selected):
 *   LUNA_DEPLOYMENT=sunset-staging
 *   DEFAULT_CLIENT_SLUG=sunset
 *   Canonical bounded worker id (module pin)
 *   Migration 064 readiness contract (ledger id + query_version pin)
 *   Existing Sunset Azure KV grant-envelope env pins (parse only; no SDK)
 *
 * Side-effect-free: no DB checkout/query, no Pool, no Azure credential/KV SDK,
 * no crypto unwrap, no Graph, no timer, no lease, no migration/DDL.
 *
 * @module email-delta-runtime-config
 */

const util = require('util');

const {
  parseEmailGrantEnvelopeAzureKvSunsetStagingRuntimeConfig,
  SUNSET_STAGING_TRUSTED_HOST,
  SUNSET_STAGING_KEK_KEY_NAME,
  SUNSET_STAGING_KEK_KEY_VERSION,
  SUNSET_STAGING_VERSIONED_KEY_ID,
  SUNSET_STAGING_MI_CLIENT_ID,
  ENV_COMPOSITION_ENABLED: ENV_KV_COMPOSITION_ENABLED,
  ENV_TRUSTED_HOST: ENV_KV_TRUSTED_HOST,
  ENV_VERSIONED_KEY_ID: ENV_KV_VERSIONED_KEY_ID,
} = require('./email-grant-envelope-azure-kv-sunset-staging-runtime-composition');
const {
  DEFAULT_QUERY_VERSION,
} = require('./email-inbound-delta-state-store');

const ERROR_CODE = 'EMAIL_DELTA_RUNTIME_CONFIG_INVALID';
const ERROR_MESSAGE = 'Email delta runtime config failed.';

const SUNSET_DEPLOYMENT = 'sunset-staging';
const SUNSET_TENANT = 'sunset';

/** Canonical bounded worker identity (matches delta-state parseWorkerId bounds). */
const WORKER_ID = 'sunset-email-delta-worker';
const WORKER_ID_MIN_LEN = 1;
const WORKER_ID_MAX_LEN = 128;

/** Migration 064 readiness contract (ledger + store pin; not applied by this module). */
const MIGRATION_064_ID = '064_tenant_email_inbound_delta_states';
const MIGRATION_064_FILENAME = '064_tenant_email_inbound_delta_states.sql';
const MIGRATION_064_TABLE = 'tenant_email_inbound_delta_states';
const QUERY_VERSION = DEFAULT_QUERY_VERSION;

const ENV_COMPOSITION_ENABLED = 'LUNA_EMAIL_DELTA_RUNTIME_COMPOSITION_ENABLED';
const ENV_WORKER_ENABLED = 'LUNA_EMAIL_DELTA_WORKER_ENABLED';
const ENV_ADMIN_ENABLED = 'LUNA_EMAIL_DELTA_ADMIN_ENABLED';
const ENV_DEPLOYMENT = 'LUNA_DEPLOYMENT';
const ENV_TENANT = 'DEFAULT_CLIENT_SLUG';

const ENV_FLAG_KEYS = Object.freeze([
  ENV_COMPOSITION_ENABLED,
  ENV_WORKER_ENABLED,
  ENV_ADMIN_ENABLED,
]);

const CONFIG_STATUS = Object.freeze({
  DISABLED: 'disabled',
  COMPOSITION_INERT: 'composition_inert',
  ACTIVATION_REJECTED: 'activation_rejected',
  CONFIG_INVALID: 'config_invalid',
});

const READINESS_KEYS = Object.freeze([
  'ok',
  'status',
  'composition_enabled',
  'worker_enabled',
  'admin_enabled',
  'worker_activation_possible',
  'admin_activation_possible',
  'runtime_activation',
  'scheduler_present',
  'admin_route_present',
  'deployment_boundary',
  'tenant_bound',
  'worker_id',
  'migration_064_id',
  'query_version',
  'kv_pins_valid',
  'code',
]);

/**
 * Future exclusive transaction-client adapter contract (NOT active this PR).
 *
 * Document only: when a later PR enables a worker path, exclusive loan must
 * preserve pg-connect outer release ownership:
 *   - Prefer outer `withPgClient` loan; factory-fix `withTransactionClient`
 *     to invoke work on that same pinned client (no second checkout/release).
 *   - Never pass `getPool` where exclusive loan is required.
 *   - Never call `closePgPool` / end the application pool from delta code.
 *   - Never call `client.release` inside store/operation code — outer
 *     `withPgClient` owns release (and discard-required release(true)).
 */
const FUTURE_PINNED_TRANSACTION_CLIENT_ADAPTER_CONTRACT = Object.freeze({
  active_in_this_pr: false,
  exclusive_loan_required: true,
  outer_release_owner: 'pg-connect.withPgClient',
  forbid_getPool_for_exclusive_loan: true,
  forbid_close_application_pool: true,
  forbid_inner_client_release: true,
  document_only: true,
});

const MIGRATION_064_READINESS_CONTRACT = Object.freeze({
  id: MIGRATION_064_ID,
  filename: MIGRATION_064_FILENAME,
  table: MIGRATION_064_TABLE,
  query_version: QUERY_VERSION,
  applied_by_this_module: false,
  ddl_allowed: false,
});

const CANONICAL_WORKER_CONFIG = Object.freeze({
  worker_id: WORKER_ID,
  min_len: WORKER_ID_MIN_LEN,
  max_len: WORKER_ID_MAX_LEN,
  no_whitespace: true,
});

// Module-init pin: ambient isProxy monkeypatch after load must not weaken detection.
const PINNED_UTIL_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_UTIL_TYPES && typeof PINNED_UTIL_TYPES.isProxy === 'function'
  ? PINNED_UTIL_TYPES.isProxy
  : null;

if (typeof QUERY_VERSION !== 'string' || QUERY_VERSION !== 'ms_messages_delta_v1') {
  throw new Error('email_delta_runtime_config_query_version_unexpected');
}
if (typeof WORKER_ID !== 'string'
    || WORKER_ID.length < WORKER_ID_MIN_LEN
    || WORKER_ID.length > WORKER_ID_MAX_LEN
    || /\s/.test(WORKER_ID)) {
  throw new Error('email_delta_runtime_config_worker_id_unexpected');
}

function failure() {
  const error = new Error(ERROR_MESSAGE);
  Object.defineProperty(error, 'name', { value: 'EmailDeltaRuntimeConfigError' });
  Object.defineProperty(error, 'code', { value: ERROR_CODE, enumerable: true });
  return Object.freeze(error);
}

function isProxySurface(value) {
  try {
    if (typeof PINNED_IS_PROXY !== 'function' || !PINNED_UTIL_TYPES) return true;
    return Reflect.apply(PINNED_IS_PROXY, PINNED_UTIL_TYPES, [value]) === true;
  } catch {
    return true;
  }
}

/**
 * Own-data string env read only (reject accessor/symbol/nonenumerable traps).
 * @returns {{ ok: false } | { ok: true, present: false } | { ok: true, present: true, value: string }}
 */
function readEnvString(env, key) {
  try {
    if (env == null || (typeof env !== 'object' && typeof env !== 'function')) {
      return { ok: false };
    }
    if (isProxySurface(env)) return { ok: false };
    if (!Object.prototype.hasOwnProperty.call(env, key)) {
      return { ok: true, present: false };
    }
    const desc = Object.getOwnPropertyDescriptor(env, key);
    if (!desc) return { ok: false };
    if (typeof desc.get === 'function' || typeof desc.set === 'function') return { ok: false };
    if (!Object.prototype.hasOwnProperty.call(desc, 'value')) return { ok: false };
    if (typeof desc.value !== 'string') return { ok: false };
    return { ok: true, present: true, value: desc.value };
  } catch {
    return { ok: false };
  }
}

/** Exact string `'true'` only; absent/other → false. Invalid surface → null (fail closed). */
function readExactTrueFlag(env, key) {
  const r = readEnvString(env, key);
  if (!r.ok) return null;
  if (!r.present) return false;
  return r.value === 'true';
}

function frozenReadiness(fields) {
  const out = {};
  for (const key of READINESS_KEYS) {
    out[key] = fields[key];
  }
  return Object.freeze(out);
}

function disabledReadiness() {
  return frozenReadiness({
    ok: true,
    status: CONFIG_STATUS.DISABLED,
    composition_enabled: false,
    worker_enabled: false,
    admin_enabled: false,
    worker_activation_possible: false,
    admin_activation_possible: false,
    runtime_activation: false,
    scheduler_present: false,
    admin_route_present: false,
    deployment_boundary: SUNSET_DEPLOYMENT,
    tenant_bound: false,
    worker_id: WORKER_ID,
    migration_064_id: MIGRATION_064_ID,
    query_version: QUERY_VERSION,
    kv_pins_valid: false,
    code: 'email_delta_runtime_disabled',
  });
}

function rejectedReadiness(flags) {
  return frozenReadiness({
    ok: false,
    status: CONFIG_STATUS.ACTIVATION_REJECTED,
    composition_enabled: flags.composition === true,
    worker_enabled: flags.worker === true,
    admin_enabled: flags.admin === true,
    worker_activation_possible: false,
    admin_activation_possible: false,
    runtime_activation: false,
    scheduler_present: false,
    admin_route_present: false,
    deployment_boundary: SUNSET_DEPLOYMENT,
    tenant_bound: false,
    worker_id: WORKER_ID,
    migration_064_id: MIGRATION_064_ID,
    query_version: QUERY_VERSION,
    kv_pins_valid: false,
    code: 'email_delta_activation_rejected',
  });
}

function invalidReadiness(flags, code) {
  return frozenReadiness({
    ok: false,
    status: CONFIG_STATUS.CONFIG_INVALID,
    composition_enabled: flags.composition === true,
    worker_enabled: flags.worker === true,
    admin_enabled: flags.admin === true,
    worker_activation_possible: false,
    admin_activation_possible: false,
    runtime_activation: false,
    scheduler_present: false,
    admin_route_present: false,
    deployment_boundary: SUNSET_DEPLOYMENT,
    tenant_bound: false,
    worker_id: WORKER_ID,
    migration_064_id: MIGRATION_064_ID,
    query_version: QUERY_VERSION,
    kv_pins_valid: false,
    code: code || 'email_delta_runtime_config_invalid',
  });
}

function compositionInertReadiness() {
  return frozenReadiness({
    ok: true,
    status: CONFIG_STATUS.COMPOSITION_INERT,
    composition_enabled: true,
    worker_enabled: false,
    admin_enabled: false,
    worker_activation_possible: false,
    admin_activation_possible: false,
    runtime_activation: false,
    scheduler_present: false,
    admin_route_present: false,
    deployment_boundary: SUNSET_DEPLOYMENT,
    tenant_bound: true,
    worker_id: WORKER_ID,
    migration_064_id: MIGRATION_064_ID,
    query_version: QUERY_VERSION,
    kv_pins_valid: true,
    code: 'email_delta_composition_inert',
  });
}

/**
 * Validate migration 064 readiness contract pins (no DDL / no DB).
 * @returns {boolean}
 */
function migration064ContractValid() {
  try {
    if (MIGRATION_064_ID !== '064_tenant_email_inbound_delta_states') return false;
    if (MIGRATION_064_FILENAME !== '064_tenant_email_inbound_delta_states.sql') return false;
    if (MIGRATION_064_TABLE !== 'tenant_email_inbound_delta_states') return false;
    if (QUERY_VERSION !== 'ms_messages_delta_v1') return false;
    if (MIGRATION_064_READINESS_CONTRACT.applied_by_this_module !== false) return false;
    if (MIGRATION_064_READINESS_CONTRACT.ddl_allowed !== false) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate canonical bounded worker identity pin (no env override).
 * @returns {boolean}
 */
function workerIdentityValid() {
  try {
    if (typeof WORKER_ID !== 'string') return false;
    if (WORKER_ID.length < WORKER_ID_MIN_LEN || WORKER_ID.length > WORKER_ID_MAX_LEN) {
      return false;
    }
    if (/\s/.test(WORKER_ID)) return false;
    if (CANONICAL_WORKER_CONFIG.worker_id !== WORKER_ID) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse email-delta runtime config from a trusted env object.
 * Never throws attacker-controlled messages; returns frozen readiness only.
 *
 * @param {object} [env]
 * @returns {Readonly<object>} exact READINESS_KEYS surface
 */
function parseEmailDeltaRuntimeConfig(env) {
  try {
    if (env == null || (typeof env !== 'object' && typeof env !== 'function')
        || Array.isArray(env) || isProxySurface(env)) {
      return invalidReadiness(
        { composition: false, worker: false, admin: false },
        'email_delta_runtime_config_invalid',
      );
    }

    const composition = readExactTrueFlag(env, ENV_COMPOSITION_ENABLED);
    const worker = readExactTrueFlag(env, ENV_WORKER_ENABLED);
    const admin = readExactTrueFlag(env, ENV_ADMIN_ENABLED);
    if (composition === null || worker === null || admin === null) {
      return invalidReadiness(
        { composition: false, worker: false, admin: false },
        'email_delta_runtime_config_invalid',
      );
    }

    const flags = { composition, worker, admin };

    // Independent flags: worker/admin true always rejected (activation-impossible).
    if (worker === true || admin === true) {
      return rejectedReadiness(flags);
    }

    if (composition !== true) {
      return disabledReadiness();
    }

    // Composition-enabled path: exact deployment + tenant + contract pins.
    if (!migration064ContractValid() || !workerIdentityValid()) {
      return invalidReadiness(flags, 'email_delta_runtime_config_invalid');
    }

    const deployment = readEnvString(env, ENV_DEPLOYMENT);
    if (!deployment.ok || !deployment.present || deployment.value !== SUNSET_DEPLOYMENT) {
      return invalidReadiness(flags, 'email_delta_deployment_mismatch');
    }

    const tenant = readEnvString(env, ENV_TENANT);
    if (!tenant.ok || !tenant.present || tenant.value !== SUNSET_TENANT) {
      return invalidReadiness(flags, 'email_delta_tenant_mismatch');
    }

    // Existing pinned envelope/KV settings — parse only (no SDK construction).
    let kv;
    try {
      kv = parseEmailGrantEnvelopeAzureKvSunsetStagingRuntimeConfig(env);
    } catch {
      return invalidReadiness(flags, 'email_delta_kv_pins_invalid');
    }
    if (!kv || kv.ok !== true || kv.composition_enabled !== true) {
      return invalidReadiness(flags, 'email_delta_kv_pins_invalid');
    }
    if (kv.trusted_host !== SUNSET_STAGING_TRUSTED_HOST
        || kv.versioned_key_id !== SUNSET_STAGING_VERSIONED_KEY_ID
        || kv.kek_key_name !== SUNSET_STAGING_KEK_KEY_NAME
        || kv.kek_key_version !== SUNSET_STAGING_KEK_KEY_VERSION
        || kv.managed_identity_client_id !== SUNSET_STAGING_MI_CLIENT_ID) {
      return invalidReadiness(flags, 'email_delta_kv_pins_invalid');
    }

    return compositionInertReadiness();
  } catch {
    return invalidReadiness(
      { composition: false, worker: false, admin: false },
      'email_delta_runtime_config_invalid',
    );
  }
}

/**
 * Whether composition flag is exact true AND worker/admin are not true.
 * Does not validate deployment/tenant/KV pins (use parseEmailDeltaRuntimeConfig).
 */
function isEmailDeltaCompositionFlagEnabled(env) {
  try {
    const composition = readExactTrueFlag(env, ENV_COMPOSITION_ENABLED);
    const worker = readExactTrueFlag(env, ENV_WORKER_ENABLED);
    const admin = readExactTrueFlag(env, ENV_ADMIN_ENABLED);
    if (composition !== true) return false;
    if (worker === true || admin === true) return false;
    if (worker === null || admin === null) return false;
    return true;
  } catch {
    return false;
  }
}

module.exports = Object.freeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  WORKER_ID,
  WORKER_ID_MIN_LEN,
  WORKER_ID_MAX_LEN,
  MIGRATION_064_ID,
  MIGRATION_064_FILENAME,
  MIGRATION_064_TABLE,
  QUERY_VERSION,
  ENV_COMPOSITION_ENABLED,
  ENV_WORKER_ENABLED,
  ENV_ADMIN_ENABLED,
  ENV_DEPLOYMENT,
  ENV_TENANT,
  ENV_FLAG_KEYS,
  ENV_KV_COMPOSITION_ENABLED,
  ENV_KV_TRUSTED_HOST,
  ENV_KV_VERSIONED_KEY_ID,
  CONFIG_STATUS,
  READINESS_KEYS,
  MIGRATION_064_READINESS_CONTRACT,
  CANONICAL_WORKER_CONFIG,
  FUTURE_PINNED_TRANSACTION_CLIENT_ADAPTER_CONTRACT,
  parseEmailDeltaRuntimeConfig,
  isEmailDeltaCompositionFlagEnabled,
  failure,
});

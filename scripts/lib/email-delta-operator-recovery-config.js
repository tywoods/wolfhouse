'use strict';

/**
 * Email-delta operator recovery config (Sunset-staging; default-off).
 *
 * Exact independent flag (default false; only the string `'true'` enables):
 *   LUNA_EMAIL_DELTA_OPERATOR_RECOVERY_ENABLED
 *
 * Full enable gate (ALL required; fail closed otherwise):
 *   - LUNA_EMAIL_DELTA_OPERATOR_RECOVERY_ENABLED === 'true' (byte-exact)
 *   - LUNA_EMAIL_DELTA_RUNTIME_COMPOSITION_ENABLED === 'true'
 *   - LUNA_EMAIL_DELTA_ADMIN_ENABLED === 'true'
 *   - LUNA_EMAIL_DELTA_WORKER_ENABLED !== 'true' (worker true impossible)
 *   - LUNA_DEPLOYMENT === 'sunset-staging'
 *   - DEFAULT_CLIENT_SLUG === 'sunset'
 *   - Existing exact Azure KV grant-envelope env pins (raw byte-exact)
 *   - Migration 064/065 readiness pins (ledger ids + query_version; not applied)
 *
 * Composition alone / admin alone / operator alone / wrong tenant / wrong
 * deployment / malformed / hostile env → disabled (concealed 404 before
 * auth/body/DB/owner load). Worker true always fails closed.
 *
 * PR411 inert composition remains activation-impossible for worker/scheduler
 * run surfaces; this module is the only admin recovery activation path and
 * only under the full gate above.
 *
 * Side-effect-free: no DB/Pool/KV SDK/Graph/timer/lease/migration/DDL on
 * import, gate, or readiness. Never loads #410 owners / recovery store /
 * route handlers on this module path.
 *
 * @module email-delta-operator-recovery-config
 */

const util = require('util');

const ERROR_CODE = 'EMAIL_DELTA_OPERATOR_RECOVERY_CONFIG_INVALID';
const ERROR_MESSAGE = 'Email delta operator recovery config failed.';

const SUNSET_DEPLOYMENT = 'sunset-staging';
const SUNSET_TENANT = 'sunset';

const MIGRATION_065_ID = '065_tenant_email_delta_recovery_operations';
const MIGRATION_065_FILENAME = '065_tenant_email_delta_recovery_operations.sql';
const MIGRATION_065_TABLE = 'tenant_email_delta_recovery_operations';
const MIGRATION_064_ID = '064_tenant_email_inbound_delta_states';
const MIGRATION_064_FILENAME = '064_tenant_email_inbound_delta_states.sql';
const MIGRATION_064_TABLE = 'tenant_email_inbound_delta_states';
const QUERY_VERSION = 'ms_messages_delta_v1';

const ENV_OPERATOR_RECOVERY_ENABLED = 'LUNA_EMAIL_DELTA_OPERATOR_RECOVERY_ENABLED';
const ENV_COMPOSITION_ENABLED = 'LUNA_EMAIL_DELTA_RUNTIME_COMPOSITION_ENABLED';
const ENV_WORKER_ENABLED = 'LUNA_EMAIL_DELTA_WORKER_ENABLED';
const ENV_ADMIN_ENABLED = 'LUNA_EMAIL_DELTA_ADMIN_ENABLED';
const ENV_DEPLOYMENT = 'LUNA_DEPLOYMENT';
const ENV_TENANT = 'DEFAULT_CLIENT_SLUG';

const ENV_KV_COMPOSITION_ENABLED = 'EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED';
const ENV_KV_TRUSTED_HOST = 'EMAIL_GRANT_ENVELOPE_AZURE_KV_TRUSTED_HOST';
const ENV_KV_VERSIONED_KEY_ID = 'EMAIL_GRANT_ENVELOPE_AZURE_KV_VERSIONED_KEY_ID';

const SUNSET_STAGING_TRUSTED_HOST = 'luna-sunset-staging-kv.vault.azure.net';
const SUNSET_STAGING_KEK_KEY_NAME = 'luna-email-grant-kek';
const SUNSET_STAGING_KEK_KEY_VERSION = 'fde9704bd37b45fabe1f12a6a615b032';
const SUNSET_STAGING_VERSIONED_KEY_ID = (
  `https://${SUNSET_STAGING_TRUSTED_HOST}`
  + `/keys/${SUNSET_STAGING_KEK_KEY_NAME}/${SUNSET_STAGING_KEK_KEY_VERSION}`
);
const SUNSET_STAGING_MI_CLIENT_ID = '0e05fbe3-e8c5-48aa-a914-30aed284e6f7';

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

const CONFIG_STATUS = pinnedFreeze({
  DISABLED: 'disabled',
  ENABLED: 'enabled',
  ACTIVATION_REJECTED: 'activation_rejected',
  CONFIG_INVALID: 'config_invalid',
});

const READINESS_KEYS = pinnedFreeze([
  'ok',
  'status',
  'operator_recovery_enabled',
  'composition_enabled',
  'admin_enabled',
  'worker_enabled',
  'worker_activation_possible',
  'admin_recovery_activation_possible',
  'routes_present',
  'scheduler_present',
  'deployment_boundary',
  'tenant_bound',
  'migration_065_id',
  'migration_064_id',
  'query_version',
  'kv_pins_valid',
  'code',
]);

const MIGRATION_065_READINESS_CONTRACT = pinnedFreeze({
  id: MIGRATION_065_ID,
  filename: MIGRATION_065_FILENAME,
  table: MIGRATION_065_TABLE,
  query_version: QUERY_VERSION,
  prior_sibling_id: MIGRATION_064_ID,
  applied_by_this_module: false,
  ddl_allowed: false,
});

const MIGRATION_064_READINESS_CONTRACT = pinnedFreeze({
  id: MIGRATION_064_ID,
  filename: MIGRATION_064_FILENAME,
  table: MIGRATION_064_TABLE,
  query_version: QUERY_VERSION,
  applied_by_this_module: false,
  ddl_allowed: false,
  readiness_tip: false,
});

if (typeof QUERY_VERSION !== 'string' || QUERY_VERSION !== 'ms_messages_delta_v1') {
  throw new Error('email_delta_operator_recovery_config_query_version_unexpected');
}

function failure() {
  const error = new Error(ERROR_MESSAGE);
  Object.defineProperty(error, 'name', { value: 'EmailDeltaOperatorRecoveryConfigError' });
  Object.defineProperty(error, 'code', { value: ERROR_CODE, enumerable: true });
  return pinnedFreeze(error);
}

function safeHasOwn(object, key) {
  try {
    if (!PINNED_HAS_OWN || object == null) return false;
    return PINNED_HAS_OWN.call(object, key) === true;
  } catch {
    return false;
  }
}

function isProxySurface(value) {
  try {
    if (!PINNED_INTRINSICS_READY) return true;
    return PINNED_REFLECT_APPLY.call(Reflect, PINNED_IS_PROXY, PINNED_UTIL_TYPES, [value]) === true;
  } catch {
    return true;
  }
}

function envOwnKeyDescriptorSurfaceAccepted(env) {
  try {
    if (env == null || (typeof env !== 'object' && typeof env !== 'function')) {
      return false;
    }
    if (!PINNED_INTRINSICS_READY) return false;
    if (isProxySurface(env)) return false;
    const keys = PINNED_REFLECT_OWN_KEYS.call(Reflect, env);
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (typeof key === 'symbol') return false;
      if (typeof key !== 'string') return false;
      const desc = PINNED_GET_OWN_PROPERTY_DESCRIPTOR.call(Object, env, key);
      if (!desc || typeof desc !== 'object') return false;
      if (typeof desc.get === 'function' || typeof desc.set === 'function') return false;
      if (!safeHasOwn(desc, 'value')) return false;
      if (desc.enumerable !== true) return false;
      if (typeof desc.value !== 'string') return false;
    }
    return true;
  } catch {
    return false;
  }
}

function readEnvString(env, key) {
  try {
    if (env == null || (typeof env !== 'object' && typeof env !== 'function')) {
      return { ok: false };
    }
    if (!PINNED_INTRINSICS_READY) return { ok: false };
    if (isProxySurface(env)) return { ok: false };
    if (!safeHasOwn(env, key)) {
      return { ok: true, present: false };
    }
    const desc = PINNED_GET_OWN_PROPERTY_DESCRIPTOR.call(Object, env, key);
    if (!desc || typeof desc !== 'object') return { ok: false };
    if (typeof desc.get === 'function' || typeof desc.set === 'function') return { ok: false };
    if (!safeHasOwn(desc, 'value')) return { ok: false };
    if (desc.enumerable !== true) return { ok: false };
    if (typeof desc.value !== 'string') return { ok: false };
    return { ok: true, present: true, value: desc.value };
  } catch {
    return { ok: false };
  }
}

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
  return pinnedFreeze(out);
}

function disabledReadiness(code) {
  return frozenReadiness({
    ok: true,
    status: CONFIG_STATUS.DISABLED,
    operator_recovery_enabled: false,
    composition_enabled: false,
    admin_enabled: false,
    worker_enabled: false,
    worker_activation_possible: false,
    admin_recovery_activation_possible: false,
    routes_present: false,
    scheduler_present: false,
    deployment_boundary: SUNSET_DEPLOYMENT,
    tenant_bound: false,
    migration_065_id: MIGRATION_065_ID,
    migration_064_id: MIGRATION_064_ID,
    query_version: QUERY_VERSION,
    kv_pins_valid: false,
    code: code || 'email_delta_operator_recovery_disabled',
  });
}

function rejectedReadiness(flags, code) {
  return frozenReadiness({
    ok: false,
    status: CONFIG_STATUS.ACTIVATION_REJECTED,
    operator_recovery_enabled: flags.operator === true,
    composition_enabled: flags.composition === true,
    admin_enabled: flags.admin === true,
    worker_enabled: flags.worker === true,
    worker_activation_possible: false,
    admin_recovery_activation_possible: false,
    routes_present: false,
    scheduler_present: false,
    deployment_boundary: SUNSET_DEPLOYMENT,
    tenant_bound: false,
    migration_065_id: MIGRATION_065_ID,
    migration_064_id: MIGRATION_064_ID,
    query_version: QUERY_VERSION,
    kv_pins_valid: false,
    code: code || 'email_delta_operator_recovery_activation_rejected',
  });
}

function invalidReadiness(flags, code) {
  return frozenReadiness({
    ok: false,
    status: CONFIG_STATUS.CONFIG_INVALID,
    operator_recovery_enabled: flags.operator === true,
    composition_enabled: flags.composition === true,
    admin_enabled: flags.admin === true,
    worker_enabled: flags.worker === true,
    worker_activation_possible: false,
    admin_recovery_activation_possible: false,
    routes_present: false,
    scheduler_present: false,
    deployment_boundary: SUNSET_DEPLOYMENT,
    tenant_bound: false,
    migration_065_id: MIGRATION_065_ID,
    migration_064_id: MIGRATION_064_ID,
    query_version: QUERY_VERSION,
    kv_pins_valid: false,
    code: code || 'email_delta_operator_recovery_config_invalid',
  });
}

function enabledReadiness() {
  return frozenReadiness({
    ok: true,
    status: CONFIG_STATUS.ENABLED,
    operator_recovery_enabled: true,
    composition_enabled: true,
    admin_enabled: true,
    worker_enabled: false,
    worker_activation_possible: false,
    admin_recovery_activation_possible: true,
    routes_present: true,
    scheduler_present: false,
    deployment_boundary: SUNSET_DEPLOYMENT,
    tenant_bound: true,
    migration_065_id: MIGRATION_065_ID,
    migration_064_id: MIGRATION_064_ID,
    query_version: QUERY_VERSION,
    kv_pins_valid: true,
    code: 'email_delta_operator_recovery_enabled',
  });
}

function migrationPinsValid() {
  try {
    if (MIGRATION_065_ID !== '065_tenant_email_delta_recovery_operations') return false;
    if (MIGRATION_065_FILENAME !== '065_tenant_email_delta_recovery_operations.sql') return false;
    if (MIGRATION_065_TABLE !== 'tenant_email_delta_recovery_operations') return false;
    if (MIGRATION_064_ID !== '064_tenant_email_inbound_delta_states') return false;
    if (MIGRATION_064_FILENAME !== '064_tenant_email_inbound_delta_states.sql') return false;
    if (MIGRATION_064_TABLE !== 'tenant_email_inbound_delta_states') return false;
    if (QUERY_VERSION !== 'ms_messages_delta_v1') return false;
    if (MIGRATION_065_READINESS_CONTRACT.applied_by_this_module !== false) return false;
    if (MIGRATION_065_READINESS_CONTRACT.ddl_allowed !== false) return false;
    if (MIGRATION_065_READINESS_CONTRACT.prior_sibling_id !== MIGRATION_064_ID) return false;
    if (MIGRATION_064_READINESS_CONTRACT.applied_by_this_module !== false) return false;
    if (MIGRATION_064_READINESS_CONTRACT.ddl_allowed !== false) return false;
    return true;
  } catch {
    return false;
  }
}

function kvPinsValidExact(env) {
  try {
    const en = readEnvString(env, ENV_KV_COMPOSITION_ENABLED);
    if (!en.ok) return false;
    if (!en.present || en.value !== 'true') return false;

    const host = readEnvString(env, ENV_KV_TRUSTED_HOST);
    const kid = readEnvString(env, ENV_KV_VERSIONED_KEY_ID);
    if (!host.ok || !host.present || host.value !== SUNSET_STAGING_TRUSTED_HOST) return false;
    if (!kid.ok || !kid.present || kid.value !== SUNSET_STAGING_VERSIONED_KEY_ID) return false;

    if (SUNSET_STAGING_KEK_KEY_NAME !== 'luna-email-grant-kek') return false;
    if (SUNSET_STAGING_KEK_KEY_VERSION !== 'fde9704bd37b45fabe1f12a6a615b032') return false;
    if (SUNSET_STAGING_MI_CLIENT_ID !== '0e05fbe3-e8c5-48aa-a914-30aed284e6f7') return false;
    if (SUNSET_STAGING_VERSIONED_KEY_ID
        !== `https://${SUNSET_STAGING_TRUSTED_HOST}`
          + `/keys/${SUNSET_STAGING_KEK_KEY_NAME}/${SUNSET_STAGING_KEK_KEY_VERSION}`) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Full enable gate for operator recovery routes.
 * Hostile/malformed env → false. Never loads owner graph / DB / KV SDK.
 *
 * @param {object} [env]
 * @returns {boolean}
 */
function isEmailDeltaOperatorRecoveryEnabled(env) {
  try {
    if (env == null || (typeof env !== 'object' && typeof env !== 'function')
        || Array.isArray(env)
        || !envOwnKeyDescriptorSurfaceAccepted(env)) {
      return false;
    }
    const operator = readExactTrueFlag(env, ENV_OPERATOR_RECOVERY_ENABLED);
    const composition = readExactTrueFlag(env, ENV_COMPOSITION_ENABLED);
    const admin = readExactTrueFlag(env, ENV_ADMIN_ENABLED);
    const worker = readExactTrueFlag(env, ENV_WORKER_ENABLED);
    if (operator !== true || composition !== true || admin !== true) return false;
    if (worker === true || worker === null || admin === null
        || composition === null || operator === null) {
      return false;
    }
    if (!migrationPinsValid()) return false;
    const deployment = readEnvString(env, ENV_DEPLOYMENT);
    if (!deployment.ok || !deployment.present || deployment.value !== SUNSET_DEPLOYMENT) {
      return false;
    }
    const tenant = readEnvString(env, ENV_TENANT);
    if (!tenant.ok || !tenant.present || tenant.value !== SUNSET_TENANT) {
      return false;
    }
    if (!kvPinsValidExact(env)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse operator recovery config into frozen readiness.
 * Never throws attacker-controlled messages; never constructs owners/DB/KV SDK.
 *
 * @param {object} [env]
 * @returns {Readonly<object>}
 */
function parseEmailDeltaOperatorRecoveryConfig(env) {
  try {
    if (env == null || (typeof env !== 'object' && typeof env !== 'function')
        || Array.isArray(env)) {
      return invalidReadiness(
        { operator: false, composition: false, admin: false, worker: false },
        'email_delta_operator_recovery_config_invalid',
      );
    }
    if (!envOwnKeyDescriptorSurfaceAccepted(env)) {
      return invalidReadiness(
        { operator: false, composition: false, admin: false, worker: false },
        'email_delta_operator_recovery_config_invalid',
      );
    }

    const operator = readExactTrueFlag(env, ENV_OPERATOR_RECOVERY_ENABLED);
    const composition = readExactTrueFlag(env, ENV_COMPOSITION_ENABLED);
    const admin = readExactTrueFlag(env, ENV_ADMIN_ENABLED);
    const worker = readExactTrueFlag(env, ENV_WORKER_ENABLED);
    if (operator === null || composition === null || admin === null || worker === null) {
      return invalidReadiness(
        { operator: false, composition: false, admin: false, worker: false },
        'email_delta_operator_recovery_config_invalid',
      );
    }

    const flags = { operator, composition, admin, worker };

    // Worker true is always impossible for this surface.
    if (worker === true) {
      return rejectedReadiness(flags, 'email_delta_operator_recovery_worker_impossible');
    }

    // Incomplete activation (any partial flag true without full gate) → rejected.
    // Composition alone / admin alone / operator alone remain inert/rejected.
    const anyPartial = operator === true || composition === true || admin === true;
    if (!anyPartial) {
      return disabledReadiness();
    }

    if (operator !== true || composition !== true || admin !== true) {
      return rejectedReadiness(flags, 'email_delta_operator_recovery_activation_rejected');
    }

    if (!migrationPinsValid()) {
      return invalidReadiness(flags, 'email_delta_operator_recovery_config_invalid');
    }

    const deployment = readEnvString(env, ENV_DEPLOYMENT);
    if (!deployment.ok || !deployment.present || deployment.value !== SUNSET_DEPLOYMENT) {
      return invalidReadiness(flags, 'email_delta_operator_recovery_deployment_mismatch');
    }

    const tenant = readEnvString(env, ENV_TENANT);
    if (!tenant.ok || !tenant.present || tenant.value !== SUNSET_TENANT) {
      return invalidReadiness(flags, 'email_delta_operator_recovery_tenant_mismatch');
    }

    if (!kvPinsValidExact(env)) {
      return invalidReadiness(flags, 'email_delta_operator_recovery_kv_pins_invalid');
    }

    return enabledReadiness();
  } catch {
    return invalidReadiness(
      { operator: false, composition: false, admin: false, worker: false },
      'email_delta_operator_recovery_config_invalid',
    );
  }
}

module.exports = pinnedFreeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  MIGRATION_065_ID,
  MIGRATION_065_FILENAME,
  MIGRATION_065_TABLE,
  MIGRATION_064_ID,
  MIGRATION_064_FILENAME,
  MIGRATION_064_TABLE,
  QUERY_VERSION,
  ENV_OPERATOR_RECOVERY_ENABLED,
  ENV_COMPOSITION_ENABLED,
  ENV_WORKER_ENABLED,
  ENV_ADMIN_ENABLED,
  ENV_DEPLOYMENT,
  ENV_TENANT,
  ENV_KV_COMPOSITION_ENABLED,
  ENV_KV_TRUSTED_HOST,
  ENV_KV_VERSIONED_KEY_ID,
  SUNSET_STAGING_TRUSTED_HOST,
  SUNSET_STAGING_KEK_KEY_NAME,
  SUNSET_STAGING_KEK_KEY_VERSION,
  SUNSET_STAGING_VERSIONED_KEY_ID,
  SUNSET_STAGING_MI_CLIENT_ID,
  CONFIG_STATUS,
  READINESS_KEYS,
  MIGRATION_065_READINESS_CONTRACT,
  MIGRATION_064_READINESS_CONTRACT,
  isEmailDeltaOperatorRecoveryEnabled,
  parseEmailDeltaOperatorRecoveryConfig,
  failure,
});

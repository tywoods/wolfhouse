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
 * Self-contained: does NOT require/load #410 durable-operation owners, Graph
 * transport, delta store, grant session, KV provider/composition constructors,
 * withPgClient, or dependency bags on import, readiness, factory, or hard-fail
 * paths. Production-exact query_version and Sunset KV pin constants are
 * module-local. Delta enforces raw byte-exact `'true'` on the existing KV
 * composition-enabled env *before* any existing-parser semantics (existing
 * module uses trim+toLowerCase for other callers and is never required here —
 * stays backward-compatible). Non-exact values (TRUE/1/yes/etc.) fail closed
 * with zero SDK/owner load.
 *
 * Side-effect-free: no DB checkout/query, no Pool, no Azure credential/KV SDK,
 * no crypto unwrap, no Graph, no timer, no lease, no migration/DDL.
 *
 * Hostile env fail-closed (before selected config reads): complete own-key/
 * descriptor surface via pinned Reflect.ownKeys + getOwnPropertyDescriptor —
 * reject any symbol own key, non-enumerable own property, accessor, or
 * malformed descriptor. Normal process.env string enumerable data props and
 * unknown ordinary string env vars remain accepted. Module-init pins include
 * Object.freeze alongside isFrozen; all errors/readiness/constants freeze via
 * the pinned callable (post-require ambient freeze replacement cannot unfreeze).
 *
 * @module email-delta-runtime-config
 */

const util = require('util');

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
/** Production-exact text pin (byte-identical to migration 064 + #410 store). */
const QUERY_VERSION = 'ms_messages_delta_v1';

const ENV_COMPOSITION_ENABLED = 'LUNA_EMAIL_DELTA_RUNTIME_COMPOSITION_ENABLED';
const ENV_WORKER_ENABLED = 'LUNA_EMAIL_DELTA_WORKER_ENABLED';
const ENV_ADMIN_ENABLED = 'LUNA_EMAIL_DELTA_ADMIN_ENABLED';
const ENV_DEPLOYMENT = 'LUNA_DEPLOYMENT';
const ENV_TENANT = 'DEFAULT_CLIENT_SLUG';

/** Existing Sunset Azure KV grant-envelope env keys (names only; no owner load). */
const ENV_KV_COMPOSITION_ENABLED = 'EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED';
const ENV_KV_TRUSTED_HOST = 'EMAIL_GRANT_ENVELOPE_AZURE_KV_TRUSTED_HOST';
const ENV_KV_VERSIONED_KEY_ID = 'EMAIL_GRANT_ENVELOPE_AZURE_KV_VERSIONED_KEY_ID';

/**
 * Sunset-staging canary KV pin constants (byte-identical to 2F-C2 composition).
 * Duplicated deliberately so this config never requires the KV owner graph.
 */
const SUNSET_STAGING_TRUSTED_HOST = 'luna-sunset-staging-kv.vault.azure.net';
const SUNSET_STAGING_KEK_KEY_NAME = 'luna-email-grant-kek';
const SUNSET_STAGING_KEK_KEY_VERSION = 'fde9704bd37b45fabe1f12a6a615b032';
const SUNSET_STAGING_VERSIONED_KEY_ID = (
  `https://${SUNSET_STAGING_TRUSTED_HOST}`
  + `/keys/${SUNSET_STAGING_KEK_KEY_NAME}/${SUNSET_STAGING_KEK_KEY_VERSION}`
);
const SUNSET_STAGING_MI_CLIENT_ID = '0e05fbe3-e8c5-48aa-a914-30aed284e6f7';

/* ── Module-init pins (security-critical intrinsics) ────────────────────────
 * Ambient global/prototype monkeypatches after load must not weaken hostile
 * boundary checks. All own-data / prototype / freeze / proxy paths use pins.
 * Object.freeze is pinned alongside isFrozen so post-require ambient freeze
 * replacement cannot leave errors/readiness/surfaces unfrozen.
 */
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

/** Pinned freeze — never ambient Object.freeze after module init. */
function pinnedFreeze(value) {
  return PINNED_OBJECT_FREEZE.call(Object, value);
}

const ENV_FLAG_KEYS = pinnedFreeze([
  ENV_COMPOSITION_ENABLED,
  ENV_WORKER_ENABLED,
  ENV_ADMIN_ENABLED,
]);

const CONFIG_STATUS = pinnedFreeze({
  DISABLED: 'disabled',
  COMPOSITION_INERT: 'composition_inert',
  ACTIVATION_REJECTED: 'activation_rejected',
  CONFIG_INVALID: 'config_invalid',
});

const READINESS_KEYS = pinnedFreeze([
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
 * This PR never exports/returns withPgClient, getPool, or any DB dependency bag.
 */
const FUTURE_PINNED_TRANSACTION_CLIENT_ADAPTER_CONTRACT = pinnedFreeze({
  active_in_this_pr: false,
  exclusive_loan_required: true,
  outer_release_owner: 'pg-connect.withPgClient',
  forbid_getPool_for_exclusive_loan: true,
  forbid_close_application_pool: true,
  forbid_inner_client_release: true,
  document_only: true,
});

const MIGRATION_064_READINESS_CONTRACT = pinnedFreeze({
  id: MIGRATION_064_ID,
  filename: MIGRATION_064_FILENAME,
  table: MIGRATION_064_TABLE,
  query_version: QUERY_VERSION,
  applied_by_this_module: false,
  ddl_allowed: false,
});

const CANONICAL_WORKER_CONFIG = pinnedFreeze({
  worker_id: WORKER_ID,
  min_len: WORKER_ID_MIN_LEN,
  max_len: WORKER_ID_MAX_LEN,
  no_whitespace: true,
});

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
  return pinnedFreeze(error);
}

/** Pinned Object.prototype.hasOwnProperty.call — never ambient rebinding. */
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

/**
 * Fail-closed complete env own-key/descriptor surface (before selected config reads).
 *
 * Uses only pinned Reflect.ownKeys + getOwnPropertyDescriptor (bounded; no
 * ambient get that would invoke accessors). Rejects:
 *   - any symbol own key
 *   - any non-enumerable own property
 *   - any accessor descriptor (get/set)
 *   - any malformed descriptor (missing data value, non-string env value)
 *
 * Accepts normal process.env-like surfaces: ordinary string keys with
 * enumerable string data props. Unknown ordinary string env vars remain allowed.
 *
 * @param {object} env
 * @returns {boolean}
 */
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
      // Accessors fail closed without invoking get/set.
      if (typeof desc.get === 'function' || typeof desc.set === 'function') return false;
      // Data descriptor with own value required (malformed otherwise).
      if (!safeHasOwn(desc, 'value')) return false;
      // Non-enumerable own properties fail closed anywhere on env.
      if (desc.enumerable !== true) return false;
      // process.env contract: values are strings.
      if (typeof desc.value !== 'string') return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Own-data string env read only (reject accessor/nonenumerable/malformed).
 * Selected-key path; complete surface is validated first.
 * @returns {{ ok: false } | { ok: true, present: false } | { ok: true, present: true, value: string }}
 */
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
  return pinnedFreeze(out);
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
 * Delta-required KV pin validation (self-contained; zero owner-graph load).
 *
 * Enforces raw byte-exact `'true'` on EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED
 * *before* any existing-KV-parser semantics would accept loose TRUE/1/yes values.
 * Existing KV module is never required from this path (keeps trim+toLowerCase for
 * other callers; delta is intentionally stricter and activation-impossible).
 *
 * After exact enabled, validates exact pinned trusted host + versioned key id
 * (byte-identical to 2F-C2 Sunset canary). No Azure SDK, no KV crypto client, no MI
 * credential construction, no require of KV composition/provider modules.
 *
 * @param {object} env
 * @returns {boolean}
 */
function kvPinsValidExact(env) {
  try {
    // Gate 1: raw byte-exact enabled — reject TRUE/True/1/yes/" true " with zero load.
    // Sits *before* any existing KV parser path (which would accept trim+toLowerCase).
    const en = readEnvString(env, ENV_KV_COMPOSITION_ENABLED);
    if (!en.ok) return false;
    if (!en.present || en.value !== 'true') return false;

    // Gate 2: exact pinned host + versioned key id (self-contained; no require).
    const host = readEnvString(env, ENV_KV_TRUSTED_HOST);
    const kid = readEnvString(env, ENV_KV_VERSIONED_KEY_ID);
    if (!host.ok || !host.present || host.value !== SUNSET_STAGING_TRUSTED_HOST) return false;
    if (!kid.ok || !kid.present || kid.value !== SUNSET_STAGING_VERSIONED_KEY_ID) return false;

    // Local pin integrity (module constants must stay aligned with 2F-C2).
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
 * Parse email-delta runtime config from a trusted env object.
 * Never throws attacker-controlled messages; returns frozen readiness only.
 * Never constructs/returns owner constructors, KV SDK, Pool, or dependency bags.
 *
 * @param {object} [env]
 * @returns {Readonly<object>} exact READINESS_KEYS surface
 */
function parseEmailDeltaRuntimeConfig(env) {
  try {
    if (env == null || (typeof env !== 'object' && typeof env !== 'function')
        || Array.isArray(env)) {
      return invalidReadiness(
        { composition: false, worker: false, admin: false },
        'email_delta_runtime_config_invalid',
      );
    }

    // Complete own-key/descriptor surface before any selected config reads.
    // Proxy / symbol / nonenumerable / accessor / malformed → fail closed.
    if (!envOwnKeyDescriptorSurfaceAccepted(env)) {
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
    // No KV/owner load on rejected path.
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

    // Existing pinned envelope/KV settings — raw-exact (zero owner load).
    if (!kvPinsValidExact(env)) {
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
 * Never loads owner graph. Hostile complete env surface → false.
 */
function isEmailDeltaCompositionFlagEnabled(env) {
  try {
    if (env == null || (typeof env !== 'object' && typeof env !== 'function')
        || Array.isArray(env)
        || !envOwnKeyDescriptorSurfaceAccepted(env)) {
      return false;
    }
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

module.exports = pinnedFreeze({
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
  SUNSET_STAGING_TRUSTED_HOST,
  SUNSET_STAGING_KEK_KEY_NAME,
  SUNSET_STAGING_KEK_KEY_VERSION,
  SUNSET_STAGING_VERSIONED_KEY_ID,
  SUNSET_STAGING_MI_CLIENT_ID,
  CONFIG_STATUS,
  READINESS_KEYS,
  MIGRATION_064_READINESS_CONTRACT,
  CANONICAL_WORKER_CONFIG,
  FUTURE_PINNED_TRANSACTION_CLIENT_ADAPTER_CONTRACT,
  parseEmailDeltaRuntimeConfig,
  isEmailDeltaCompositionFlagEnabled,
  failure,
});

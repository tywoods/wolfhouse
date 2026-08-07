'use strict';

/**
 * Staff admin email-delta operator recovery routes (Sunset-staging; default-off).
 *
 * Paths:
 *   GET  /staff/admin/email-settings/delta/recovery/status
 *   POST /staff/admin/email-settings/delta/recovery/restart-generation
 *   POST /staff/admin/email-settings/delta/recovery/reconcile
 *
 * Full gate (composition-owned isEmailDeltaOperatorRecoveryEnabled) evaluated
 * before auth/body/DB/owner load. Disabled/malformed/wrong tenant/deployment →
 * exact concealed 404 { success:false, error:'not_found' }.
 *
 * Auth: requireAuth admin (router) + explicit Sunset ACL + exact route authz.
 * Tenant fixed from deployment resolve (never HTTP). Actor from auth only.
 * Canonical selectors: location_id (slug) + endpoint_id (uuid).
 * Provider tenant/mailbox private (service-owned; never HTTP/DTO/log).
 *
 * One withPgClient loan per request; outer owns release; factory transaction
 * store on same exclusive client; no getPool/second checkout/nested release.
 *
 * HTTP mapping (bounded):
 *   200 success DTO
 *   400 invalid_request
 *   403 forbidden
 *   404 not_found / endpoint_not_found
 *   409 conflict outcomes (CAS/lease/mismatch/evidence_unavailable)
 *   503 uncertain / unavailable (commit_outcome_unknown never success)
 *
 * PII-free allowlisted logs only (operation correlation IDs). No bodies/errors/
 * mailbox/cursor/tokens/content.
 *
 * @module staff-email-delta-operator-recovery-routes
 */

const {
  isEmailDeltaOperatorRecoveryEnabled,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  ENV_OPERATOR_RECOVERY_ENABLED,
  ENV_COMPOSITION_ENABLED,
  ENV_WORKER_ENABLED,
  ENV_ADMIN_ENABLED,
  ENV_DEPLOYMENT,
  ENV_TENANT,
  ENV_KV_COMPOSITION_ENABLED,
  ENV_KV_TRUSTED_HOST,
  ENV_KV_VERSIONED_KEY_ID,
} = require('./email-delta-operator-recovery-config');
const {
  createEmailDeltaOperatorRecoverySunsetStagingRuntime,
  SERVICE_OUTCOME,
} = require('./email-delta-operator-recovery-sunset-staging-runtime-composition');
const {
  RECOVERY_STATUS_KEYS,
  RECOVERY_RESULT_KEYS,
} = require('./email-delta-recovery-operation-store');

const RECOVERY_STATUS_PATH =
  '/staff/admin/email-settings/delta/recovery/status';
const RECOVERY_RESTART_PATH =
  '/staff/admin/email-settings/delta/recovery/restart-generation';
const RECOVERY_RECONCILE_PATH =
  '/staff/admin/email-settings/delta/recovery/reconcile';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_RE_CI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCATION_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const STATUS_QUERY_KEYS = Object.freeze(['location_id', 'endpoint_id']);
const RESTART_BODY_KEYS = Object.freeze([
  'operation_id',
  'location_id',
  'endpoint_id',
  'expected_generation',
  'expected_state_version',
]);
const RECONCILE_BODY_KEYS = Object.freeze([
  'operation_id',
  'location_id',
  'endpoint_id',
  'expected_generation',
  'expected_state_version',
  'target_operation_id',
]);

const STATUS_SUCCESS_KEYS = Object.freeze([
  'success',
  ...RECOVERY_STATUS_KEYS,
]);

const OPERATION_SUCCESS_KEYS = Object.freeze([
  'success',
  ...RECOVERY_RESULT_KEYS,
]);

const OPERATION_CONFLICT_KEYS = Object.freeze([
  'success',
  'error',
  ...RECOVERY_RESULT_KEYS,
]);

const RESOLVE_ROW_KEYS = Object.freeze(['client_id', 'location_id', 'endpoint_id']);
const RESOLVE_ROW_KEY_SET = new Set(RESOLVE_ROW_KEYS);

const UNAVAILABLE_ERROR = 'operator_recovery_unavailable';

/**
 * Trusted resolve: Sunset + active location + verified Microsoft delegated
 * endpoint with grant. Params: [location_slug, endpoint_id]. Never body client.
 */
const SQL_RESOLVE_OPERATOR_RECOVERY_BINDING = `
SELECT c.id::text AS client_id,
       l.id::text AS location_id,
       e.id::text AS endpoint_id
  FROM clients c
  INNER JOIN tenant_locations l
    ON l.client_id = c.id
  INNER JOIN tenant_channel_endpoints e
    ON e.client_id = c.id
   AND e.location_id = l.location_id
   AND e.id = $2::uuid
  INNER JOIN tenant_email_delegated_grants g
    ON g.client_id = c.id
   AND g.endpoint_id = e.id
 WHERE c.slug = 'sunset'
   AND l.location_id = $1
   AND l.active = true
   AND e.provider = 'microsoft_graph'
   AND e.auth_mode = 'delegated_authorization_code'
   AND e.connector_mode = 'microsoft_delegated_oauth'
   AND e.binding_status = 'verified'
   AND e.public_address IS NOT NULL
   AND btrim(e.public_address) <> ''`.replace(/\s+/g, ' ').trim();

/** Frozen gate env snapshot keys (router + handler TOCTOU-resistant). */
const GATE_ENV_KEYS = Object.freeze([
  ENV_DEPLOYMENT,
  ENV_TENANT,
  ENV_OPERATOR_RECOVERY_ENABLED,
  ENV_COMPOSITION_ENABLED,
  ENV_ADMIN_ENABLED,
  ENV_WORKER_ENABLED,
  ENV_KV_COMPOSITION_ENABLED,
  ENV_KV_TRUSTED_HOST,
  ENV_KV_VERSIONED_KEY_ID,
]);

/**
 * Snapshot gate-relevant env values once (enumerable string data only).
 * @param {object} env
 * @returns {Readonly<object>}
 */
function snapshotOperatorRecoveryGateEnv(env) {
  const out = Object.create(null);
  const src = env && typeof env === 'object' ? env : {};
  for (const key of GATE_ENV_KEYS) {
    const v = src[key];
    if (typeof v === 'string') out[key] = v;
  }
  return Object.freeze(out);
}

function snapshotExactOwnData(body, keys) {
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const proto = Object.getPrototypeOf(body);
    if (proto !== Object.prototype && proto !== null) return null;
    const actual = Reflect.ownKeys(body);
    if (actual.length !== keys.length) return null;
    for (let i = 0; i < keys.length; i += 1) {
      if (actual[i] !== keys[i] || typeof actual[i] !== 'string') return null;
    }
    const out = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(body, key);
      if (!descriptor
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || descriptor.get
          || descriptor.set
          || !descriptor.enumerable) {
        return null;
      }
      out[key] = descriptor.value;
    }
    return out;
  } catch {
    return null;
  }
}

function snapshotStatusQuery(query) {
  try {
    if (!query || typeof query !== 'object' || Array.isArray(query)) return null;
    // Query objects from url.parse may have null prototype or Object.prototype.
    const locationId = query.location_id;
    const endpointId = query.endpoint_id;
    if (typeof locationId !== 'string' || !LOCATION_SLUG_RE.test(locationId)) return null;
    if (typeof endpointId !== 'string' || !UUID_RE.test(endpointId)) return null;
    if (endpointId !== endpointId.toLowerCase()) return null;
    // Reject client/provider fields if present as own enumerable data.
    const forbidden = [
      'client_id', 'client_slug', 'client', 'provider_tenant_id',
      'provider_mailbox_id', 'actor_staff_user_id', 'operation_id',
    ];
    for (const f of forbidden) {
      if (Object.prototype.hasOwnProperty.call(query, f)
          && query[f] !== undefined
          && query[f] !== null
          && query[f] !== '') {
        return null;
      }
    }
    return Object.freeze({
      location_id: locationId,
      endpoint_id: endpointId,
    });
  } catch {
    return null;
  }
}

function snapshotRestartBody(body) {
  const out = snapshotExactOwnData(body, RESTART_BODY_KEYS);
  if (!out) return null;
  if (typeof out.operation_id !== 'string' || !UUID_RE.test(out.operation_id)) return null;
  if (out.operation_id !== out.operation_id.toLowerCase()) return null;
  if (typeof out.location_id !== 'string' || !LOCATION_SLUG_RE.test(out.location_id)) return null;
  if (typeof out.endpoint_id !== 'string' || !UUID_RE.test(out.endpoint_id)) return null;
  if (out.endpoint_id !== out.endpoint_id.toLowerCase()) return null;
  if (!Number.isInteger(out.expected_generation) || out.expected_generation < 1
      || out.expected_generation > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  if (!Number.isInteger(out.expected_state_version) || out.expected_state_version < 1
      || out.expected_state_version > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  return Object.freeze({
    operation_id: out.operation_id,
    location_id: out.location_id,
    endpoint_id: out.endpoint_id,
    expected_generation: out.expected_generation,
    expected_state_version: out.expected_state_version,
  });
}

function snapshotReconcileBody(body) {
  const out = snapshotExactOwnData(body, RECONCILE_BODY_KEYS);
  if (!out) return null;
  if (typeof out.operation_id !== 'string' || !UUID_RE.test(out.operation_id)) return null;
  if (out.operation_id !== out.operation_id.toLowerCase()) return null;
  if (typeof out.target_operation_id !== 'string' || !UUID_RE.test(out.target_operation_id)) {
    return null;
  }
  if (out.target_operation_id !== out.target_operation_id.toLowerCase()) return null;
  if (out.operation_id === out.target_operation_id) return null;
  if (typeof out.location_id !== 'string' || !LOCATION_SLUG_RE.test(out.location_id)) return null;
  if (typeof out.endpoint_id !== 'string' || !UUID_RE.test(out.endpoint_id)) return null;
  if (out.endpoint_id !== out.endpoint_id.toLowerCase()) return null;
  if (!Number.isInteger(out.expected_generation) || out.expected_generation < 1
      || out.expected_generation > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  if (!Number.isInteger(out.expected_state_version) || out.expected_state_version < 1
      || out.expected_state_version > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  return Object.freeze({
    operation_id: out.operation_id,
    location_id: out.location_id,
    endpoint_id: out.endpoint_id,
    expected_generation: out.expected_generation,
    expected_state_version: out.expected_state_version,
    target_operation_id: out.target_operation_id,
  });
}

function snapshotExactResolveRow(row) {
  try {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const keys = Reflect.ownKeys(row);
    if (keys.length !== RESOLVE_ROW_KEYS.length) return null;
    for (let i = 0; i < RESOLVE_ROW_KEYS.length; i += 1) {
      if (keys[i] !== RESOLVE_ROW_KEYS[i]) return null;
    }
    const out = Object.create(null);
    for (const key of RESOLVE_ROW_KEYS) {
      const desc = Object.getOwnPropertyDescriptor(row, key);
      if (!desc
          || !Object.prototype.hasOwnProperty.call(desc, 'value')
          || desc.get
          || desc.set
          || !desc.enumerable
          || typeof desc.value !== 'string'
          || !UUID_RE.test(desc.value.toLowerCase())) {
        return null;
      }
      out[key] = desc.value.toLowerCase();
    }
    return Object.freeze(out);
  } catch {
    return null;
  }
}

function snapshotResolveQueryResult(result) {
  try {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return Object.freeze({ kind: 'invalid' });
    }
    const rootKeys = Reflect.ownKeys(result);
    let rowsDesc = null;
    for (let i = 0; i < rootKeys.length; i += 1) {
      const key = rootKeys[i];
      if (typeof key === 'symbol') return Object.freeze({ kind: 'invalid' });
      const desc = Object.getOwnPropertyDescriptor(result, key);
      if (!desc
          || !Object.prototype.hasOwnProperty.call(desc, 'value')
          || desc.get
          || desc.set) {
        return Object.freeze({ kind: 'invalid' });
      }
      if (key === 'rows') {
        if (rowsDesc) return Object.freeze({ kind: 'invalid' });
        rowsDesc = desc;
      }
    }
    if (!rowsDesc) return Object.freeze({ kind: 'invalid' });
    const rows = rowsDesc.value;
    if (!Array.isArray(rows)) return Object.freeze({ kind: 'invalid' });
    if (Object.getPrototypeOf(rows) !== Array.prototype) {
      return Object.freeze({ kind: 'invalid' });
    }
    const lengthDesc = Object.getOwnPropertyDescriptor(rows, 'length');
    if (!lengthDesc
        || !Object.prototype.hasOwnProperty.call(lengthDesc, 'value')
        || typeof lengthDesc.value !== 'number'
        || !Number.isInteger(lengthDesc.value)
        || lengthDesc.value < 0) {
      return Object.freeze({ kind: 'invalid' });
    }
    const n = lengthDesc.value;
    if (n === 0) return Object.freeze({ kind: 'empty' });
    if (n === 1) {
      const indexDesc = Object.getOwnPropertyDescriptor(rows, '0');
      if (!indexDesc
          || !Object.prototype.hasOwnProperty.call(indexDesc, 'value')
          || indexDesc.get
          || indexDesc.set) {
        return Object.freeze({ kind: 'invalid' });
      }
      const rowSnap = snapshotExactResolveRow(indexDesc.value);
      if (!rowSnap) return Object.freeze({ kind: 'invalid' });
      return Object.freeze({ kind: 'one', row: rowSnap });
    }
    return Object.freeze({ kind: 'invalid' });
  } catch {
    return Object.freeze({ kind: 'invalid' });
  }
}

function buildStatusSuccessJson(value) {
  try {
    if (!value || typeof value !== 'object') return null;
    const dto = {};
    dto.success = true;
    for (const key of RECOVERY_STATUS_KEYS) {
      dto[key] = value[key];
    }
    const keys = Reflect.ownKeys(dto);
    if (keys.length !== STATUS_SUCCESS_KEYS.length
        || keys.join(',') !== STATUS_SUCCESS_KEYS.join(',')) {
      return null;
    }
    return Object.freeze(dto);
  } catch {
    return null;
  }
}

function buildOperationSuccessJson(value) {
  try {
    if (!value || typeof value !== 'object') return null;
    const dto = {};
    dto.success = true;
    for (const key of RECOVERY_RESULT_KEYS) {
      dto[key] = value[key];
    }
    const keys = Reflect.ownKeys(dto);
    if (keys.length !== OPERATION_SUCCESS_KEYS.length
        || keys.join(',') !== OPERATION_SUCCESS_KEYS.join(',')) {
      return null;
    }
    return Object.freeze(dto);
  } catch {
    return null;
  }
}

function buildOperationConflictJson(value, errorCode) {
  try {
    const dto = {};
    dto.success = false;
    dto.error = typeof errorCode === 'string' && errorCode ? errorCode : 'conflict';
    if (value && typeof value === 'object') {
      for (const key of RECOVERY_RESULT_KEYS) {
        dto[key] = value[key] !== undefined ? value[key] : null;
      }
    } else {
      for (const key of RECOVERY_RESULT_KEYS) {
        dto[key] = null;
      }
    }
    return Object.freeze(dto);
  } catch {
    return Object.freeze({ success: false, error: 'conflict' });
  }
}

function mapServiceToHttp(sendJSON, res, result) {
  if (!result || typeof result !== 'object') {
    return sendJSON(res, 503, { success: false, error: UNAVAILABLE_ERROR });
  }
  if (result.ok === true && result.kind === SERVICE_OUTCOME.SUCCESS) {
    if (result.value && Object.prototype.hasOwnProperty.call(result.value, 'state_present')) {
      const json = buildStatusSuccessJson(result.value);
      if (!json) return sendJSON(res, 503, { success: false, error: UNAVAILABLE_ERROR });
      return sendJSON(res, 200, json);
    }
    const json = buildOperationSuccessJson(result.value);
    if (!json) return sendJSON(res, 503, { success: false, error: UNAVAILABLE_ERROR });
    return sendJSON(res, 200, json);
  }
  if (result.kind === SERVICE_OUTCOME.CONFLICT) {
    const err = typeof result.error === 'string' ? result.error : 'conflict';
    // Prefer outcome field when full DTO present.
    const outcomeErr = result.value && result.value.outcome
      ? String(result.value.outcome)
      : err;
    if (result.value && result.value.operation_id) {
      return sendJSON(res, 409, buildOperationConflictJson(result.value, outcomeErr));
    }
    return sendJSON(res, 409, { success: false, error: outcomeErr === 'operation_id_conflict'
      ? 'operation_id_conflict'
      : (outcomeErr || 'conflict') });
  }
  if (result.kind === SERVICE_OUTCOME.UNCERTAIN) {
    // Sanitized 503 — never success, never new operation id mint.
    return sendJSON(res, 503, { success: false, error: 'commit_outcome_unknown' });
  }
  if (result.kind === SERVICE_OUTCOME.NOT_FOUND) {
    return sendJSON(res, 404, { success: false, error: 'endpoint_not_found' });
  }
  if (result.kind === SERVICE_OUTCOME.INVALID) {
    return sendJSON(res, 400, { success: false, error: 'invalid_request' });
  }
  return sendJSON(res, 503, { success: false, error: UNAVAILABLE_ERROR });
}

/**
 * Allowlisted PII-free log helper (operation correlation id only).
 * Never logs bodies/errors/mailbox/cursor/tokens/content.
 */
function logSafe(logger, event, operationId) {
  try {
    if (!logger || typeof logger.info !== 'function') return;
    const payload = { event };
    if (typeof operationId === 'string' && UUID_RE.test(operationId)) {
      payload.operation_id = operationId;
    }
    logger.info(payload);
  } catch {
    // never throw from log
  }
}

function buildRuntime(env, pg) {
  async function withTransactionClient(work) {
    return work(pg);
  }
  return createEmailDeltaOperatorRecoverySunsetStagingRuntime(Object.freeze({
    env,
    pgClient: pg,
    withTransactionClient,
  }));
}

/**
 * @param {{
 *   sendJSON: Function,
 *   withPgClient: Function,
 *   assertStaffClientAccess: Function,
 *   authorizeAuthenticatedStaffRoute: Function,
 *   runtimeEnv?: object,
 *   logger?: object,
 * }} deps
 */
function createStaffEmailDeltaOperatorRecoveryRoutes(deps) {
  const env = deps.runtimeEnv || process.env;
  const logger = deps.logger || null;

  function gateOff(gateEnv) {
    return !isEmailDeltaOperatorRecoveryEnabled(gateEnv);
  }

  function authAdminSunset(user, res, method, pathname) {
    if (!user || user.client_slug !== 'sunset'
        || !UUID_RE_CI.test(user.staff_user_id || '')
        || !UUID_RE_CI.test(user.session_id || '')) {
      deps.sendJSON(res, 403, { success: false, error: 'forbidden' });
      return null;
    }
    if (!deps.assertStaffClientAccess(user, 'sunset', res)) return null;
    const authz = deps.authorizeAuthenticatedStaffRoute({
      clientSlug: 'sunset',
      method,
      pathname,
      env,
    });
    if (!authz.ok) {
      deps.sendJSON(res, authz.status || 403, authz.body || { success: false, error: 'forbidden' });
      return null;
    }
    return {
      actorStaffUserId: String(user.staff_user_id).toLowerCase(),
    };
  }

  async function handleStatus(query, req, res, user, gateEnv = env) {
    if (gateOff(gateEnv)) {
      return deps.sendJSON(res, 404, { success: false, error: 'not_found' });
    }
    const actor = authAdminSunset(user, res, 'GET', RECOVERY_STATUS_PATH);
    if (!actor) return undefined;
    const q = snapshotStatusQuery(query);
    if (!q) {
      return deps.sendJSON(res, 400, { success: false, error: 'invalid_request' });
    }
    try {
      return await deps.withPgClient(async (pg) => {
        const found = await pg.query(SQL_RESOLVE_OPERATOR_RECOVERY_BINDING, [
          q.location_id,
          q.endpoint_id,
        ]);
        const resolved = snapshotResolveQueryResult(found);
        if (resolved.kind === 'empty') {
          return deps.sendJSON(res, 404, { success: false, error: 'endpoint_not_found' });
        }
        if (resolved.kind !== 'one') {
          return deps.sendJSON(res, 503, { success: false, error: UNAVAILABLE_ERROR });
        }
        const row = resolved.row;
        if (row.endpoint_id !== q.endpoint_id) {
          return deps.sendJSON(res, 503, { success: false, error: UNAVAILABLE_ERROR });
        }
        const runtime = buildRuntime(env, pg);
        const result = await runtime.getStatus(Object.freeze({
          clientId: row.client_id,
          locationId: row.location_id,
          endpointId: row.endpoint_id,
        }));
        return mapServiceToHttp(deps.sendJSON, res, result);
      });
    } catch (_) {
      return deps.sendJSON(res, 503, { success: false, error: UNAVAILABLE_ERROR });
    }
  }

  async function handleRestartGeneration(body, req, res, user, gateEnv = env) {
    if (gateOff(gateEnv)) {
      return deps.sendJSON(res, 404, { success: false, error: 'not_found' });
    }
    const actor = authAdminSunset(user, res, 'POST', RECOVERY_RESTART_PATH);
    if (!actor) return undefined;
    const b = snapshotRestartBody(body);
    if (!b) {
      return deps.sendJSON(res, 400, { success: false, error: 'invalid_request' });
    }
    try {
      return await deps.withPgClient(async (pg) => {
        const found = await pg.query(SQL_RESOLVE_OPERATOR_RECOVERY_BINDING, [
          b.location_id,
          b.endpoint_id,
        ]);
        const resolved = snapshotResolveQueryResult(found);
        if (resolved.kind === 'empty') {
          return deps.sendJSON(res, 404, { success: false, error: 'endpoint_not_found' });
        }
        if (resolved.kind !== 'one') {
          return deps.sendJSON(res, 503, { success: false, error: UNAVAILABLE_ERROR });
        }
        const row = resolved.row;
        if (row.endpoint_id !== b.endpoint_id) {
          return deps.sendJSON(res, 503, { success: false, error: UNAVAILABLE_ERROR });
        }
        const runtime = buildRuntime(env, pg);
        const result = await runtime.restartGeneration(Object.freeze({
          operationId: b.operation_id,
          clientId: row.client_id,
          locationId: row.location_id,
          endpointId: row.endpoint_id,
          actorStaffUserId: actor.actorStaffUserId,
          expectedGeneration: b.expected_generation,
          expectedStateVersion: b.expected_state_version,
        }));
        logSafe(logger, 'email_delta_operator_recovery_restart', b.operation_id);
        return mapServiceToHttp(deps.sendJSON, res, result);
      });
    } catch (_) {
      return deps.sendJSON(res, 503, { success: false, error: UNAVAILABLE_ERROR });
    }
  }

  async function handleReconcile(body, req, res, user, gateEnv = env) {
    if (gateOff(gateEnv)) {
      return deps.sendJSON(res, 404, { success: false, error: 'not_found' });
    }
    const actor = authAdminSunset(user, res, 'POST', RECOVERY_RECONCILE_PATH);
    if (!actor) return undefined;
    const b = snapshotReconcileBody(body);
    if (!b) {
      return deps.sendJSON(res, 400, { success: false, error: 'invalid_request' });
    }
    try {
      return await deps.withPgClient(async (pg) => {
        const found = await pg.query(SQL_RESOLVE_OPERATOR_RECOVERY_BINDING, [
          b.location_id,
          b.endpoint_id,
        ]);
        const resolved = snapshotResolveQueryResult(found);
        if (resolved.kind === 'empty') {
          return deps.sendJSON(res, 404, { success: false, error: 'endpoint_not_found' });
        }
        if (resolved.kind !== 'one') {
          return deps.sendJSON(res, 503, { success: false, error: UNAVAILABLE_ERROR });
        }
        const row = resolved.row;
        if (row.endpoint_id !== b.endpoint_id) {
          return deps.sendJSON(res, 503, { success: false, error: UNAVAILABLE_ERROR });
        }
        const runtime = buildRuntime(env, pg);
        const result = await runtime.reconcilePageCommit(Object.freeze({
          operationId: b.operation_id,
          targetOperationId: b.target_operation_id,
          clientId: row.client_id,
          locationId: row.location_id,
          endpointId: row.endpoint_id,
          actorStaffUserId: actor.actorStaffUserId,
          expectedGeneration: b.expected_generation,
          expectedStateVersion: b.expected_state_version,
        }));
        logSafe(logger, 'email_delta_operator_recovery_reconcile', b.operation_id);
        return mapServiceToHttp(deps.sendJSON, res, result);
      });
    } catch (_) {
      return deps.sendJSON(res, 503, { success: false, error: UNAVAILABLE_ERROR });
    }
  }

  return Object.freeze({
    handleStatus,
    handleRestartGeneration,
    handleReconcile,
  });
}

module.exports = {
  RECOVERY_STATUS_PATH,
  RECOVERY_RESTART_PATH,
  RECOVERY_RECONCILE_PATH,
  STATUS_QUERY_KEYS,
  RESTART_BODY_KEYS,
  RECONCILE_BODY_KEYS,
  STATUS_SUCCESS_KEYS,
  OPERATION_SUCCESS_KEYS,
  SQL_RESOLVE_OPERATOR_RECOVERY_BINDING,
  GATE_ENV_KEYS,
  UNAVAILABLE_ERROR,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  snapshotOperatorRecoveryGateEnv,
  snapshotStatusQuery,
  snapshotRestartBody,
  snapshotReconcileBody,
  snapshotResolveQueryResult,
  buildStatusSuccessJson,
  buildOperationSuccessJson,
  createStaffEmailDeltaOperatorRecoveryRoutes,
  isEmailDeltaOperatorRecoveryEnabled,
};

'use strict';

const https = require('https');
const crypto = require('crypto');
const {
  createMicrosoftOAuthTransactionService,
  createPostgresOAuthTransactionRepository,
  isStartEnabled,
  isCallbackEnabled,
  INPUT_KEYS,
} = require('./email-microsoft-oauth-transaction-service');
const {
  createSunsetStagingMicrosoftOAuthCallbackRuntime,
  DEPENDENCY_KEYS,
} = require('./email-microsoft-oauth-sunset-staging-runtime-composition');
const {
  createSunsetStagingMicrosoftDelegatedRefreshRuntime,
  isRefreshHealthEnabled,
} = require('./email-microsoft-delegated-refresh-sunset-staging-runtime-composition');
const {
  createSunsetStagingMicrosoftDelegatedReadRuntime,
  isReadHealthEnabled,
} = require('./email-microsoft-delegated-read-sunset-staging-runtime-composition');
const {
  createSunsetStagingMicrosoftDelegatedInboundDiagnosticRuntime,
  isInboundDiagnosticEnabled,
  INTERNAL_STATUS_SUCCESS: INBOUND_DIAGNOSTIC_INTERNAL_STATUS_SUCCESS,
  INTERNAL_DURABLY_PROCESSED: INBOUND_DIAGNOSTIC_INTERNAL_DURABLY_PROCESSED,
  MAX_COUNT: INBOUND_DIAGNOSTIC_MAX_COUNT,
} = require('./email-microsoft-delegated-inbound-diagnostic-sunset-staging-runtime-composition');
const {
  createSunsetMicrosoftEndpointPrepare,
  INPUT_KEYS: PREPARE_DOMAIN_INPUT_KEYS,
  ERROR_CODE: PREPARE_ERROR_CODE,
} = require('./email-sunset-microsoft-endpoint-prepare');
const {
  createCallbackEmailOAuthStageTelemetry,
  createNoopEmailOAuthStageTelemetry,
  defaultEmailOAuthStageLogger,
} = require('./email-microsoft-oauth-stage-telemetry');
const {
  GRAPH_STAGES,
} = require('./email-microsoft-graph-delegated-messages-transport');

const OAUTH_START_PATH = '/staff/admin/email-settings/oauth/microsoft/start';
/** Exact prepare path — endpoint creation prerequisite for Microsoft OAuth. */
const OAUTH_PREPARE_PATH = '/staff/admin/email-settings/oauth/microsoft/endpoint';
/** Admin-only delegated refresh-health (rotation proof); default-off. */
const OAUTH_REFRESH_HEALTH_PATH = '/staff/admin/email-settings/oauth/microsoft/refresh-health';
/** Admin-only delegated read-health (refresh + bounded Graph envelopes); default-off. */
const OAUTH_READ_HEALTH_PATH = '/staff/admin/email-settings/oauth/microsoft/read-health';
/**
 * Admin-only delegated inbound diagnostic (authority-bound ImmutableId page +
 * batch handoff; default-off). Separate path/flag from read-health.
 */
const OAUTH_INBOUND_DIAGNOSTIC_PATH = '/staff/admin/email-settings/oauth/microsoft/inbound-diagnostic';
const OAUTH_CALLBACK_PATH = '/staff/email/oauth/microsoft/callback';
/** Canonical lowercase UUID (start body endpoint_id + ordinary SQL row ids). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Session/staff UUIDs may arrive mixed-case from auth surface. */
const UUID_RE_CI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCATION_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Exact ordered own-data start body keys (location_id then endpoint_id). */
const START_BODY_KEYS = Object.freeze(['location_id', 'endpoint_id']);
/** Exact ordered own-data prepare body keys (location_id then public_address). */
const PREPARE_BODY_KEYS = Object.freeze(['location_id', 'public_address']);
/** Exact ordered own-data refresh-health body keys (location_id then endpoint_id). */
const REFRESH_HEALTH_BODY_KEYS = Object.freeze(['location_id', 'endpoint_id']);
/** Exact ordered own-data read-health body keys (location_id then endpoint_id). */
const READ_HEALTH_BODY_KEYS = Object.freeze(['location_id', 'endpoint_id']);
/** Exact ordered own-data inbound-diagnostic body keys (location_id then endpoint_id). */
const INBOUND_DIAGNOSTIC_BODY_KEYS = Object.freeze(['location_id', 'endpoint_id']);
/** Exact ordered prepare success JSON keys (no mailbox echo). */
const PREPARE_SUCCESS_KEYS = Object.freeze(['success', 'endpoint_id']);
/** Exact ordered refresh-health success JSON keys (sanitized status only). */
const REFRESH_HEALTH_SUCCESS_KEYS = Object.freeze([
  'success',
  'status',
  'grant_generation',
  'grant_status',
  'reconcile_state',
  'reauthorization_required',
]);
/** Exact ordered read-health success JSON keys (sanitized status + allowlisted stage). */
const READ_HEALTH_SUCCESS_KEYS = Object.freeze([
  'success',
  'status',
  'grant_generation',
  'graph_reachable',
  'message_count_bounded',
  'graph_stage',
]);
/**
 * Exact ordered inbound-diagnostic success JSON keys.
 * Public diagnostic vocabulary is deliberately observation-only and explicitly
 * non-durable. Never expose internal processed/delivered vocabulary, IDs, PII,
 * stage, or generation.
 */
const INBOUND_DIAGNOSTIC_SUCCESS_KEYS = Object.freeze([
  'success',
  'status',
  'observed_count',
  'unique_in_batch_count',
  'duplicate_in_batch_count',
  'durably_processed',
]);
const INBOUND_DIAGNOSTIC_PUBLIC_STATUS = 'diagnostic_observed';
const READ_HEALTH_GRAPH_STAGE_SET = new Set(GRAPH_STAGES);
const PREPARE_ERROR = 'endpoint_prepare_unavailable';
const REFRESH_HEALTH_ERROR = 'refresh_health_unavailable';
const READ_HEALTH_ERROR = 'read_health_unavailable';
const INBOUND_DIAGNOSTIC_ERROR = 'inbound_diagnostic_unavailable';
/** Exact ordered own-data resolve SQL row keys (matches SELECT aliases / order). */
const RESOLVE_ROW_KEYS = Object.freeze(['client_id', 'location_id', 'endpoint_id']);
const RESOLVE_ROW_KEY_SET = new Set(RESOLVE_ROW_KEYS);
/** Exact ordered own-data Sunset client row keys for prepare resolve. */
const PREPARE_CLIENT_ROW_KEYS = Object.freeze(['client_id']);
const PREPARE_CLIENT_ROW_KEY_SET = new Set(PREPARE_CLIENT_ROW_KEYS);

/**
 * Production native surfaces: capture node:https.request, node:crypto
 * createPublicKey/verify, and global setTimeout/clearTimeout exactly once at
 * module initialization. Module._load test doubles for https must be installed
 * before re-require so this capture binds the test module. Post-route method
 * replacement on modules/globals must not be observed by wrappers.
 */
const PRODUCTION_HTTPS = https;
const PRODUCTION_HTTPS_REQUEST = https.request;
const PRODUCTION_CRYPTO = crypto;
const PRODUCTION_CRYPTO_CREATE_PUBLIC_KEY = crypto.createPublicKey;
const PRODUCTION_CRYPTO_VERIFY = crypto.verify;
const PRODUCTION_TIMERS_OWNER = globalThis;
const PRODUCTION_SET_TIMEOUT = globalThis.setTimeout;
const PRODUCTION_CLEAR_TIMEOUT = globalThis.clearTimeout;

/**
 * Trusted Sunset client resolve for prepare — slug pinned in SQL text.
 * Route snapshots the exact row once and passes clientId into domain input;
 * body never supplies client. Domain re-proves slug+id before insert.
 */
const SQL_RESOLVE_SUNSET_CLIENT_FOR_PREPARE = `
SELECT id::text AS client_id
  FROM clients
 WHERE slug = 'sunset'
 LIMIT 1`.replace(/\s+/g, ' ').trim();

/**
 * One tenant-safe resolve: Sunset client + active location + exact eligible
 * Microsoft delegated endpoint by explicit endpoint_id. Zero rows on miss;
 * multi-row must not occur under PK but is still fail-closed.
 * Filters match transaction INSERT eligibility (provider/auth/connector/status)
 * and require public_address present. Params: [location_id, endpoint_id].
 */
const SQL_RESOLVE_START_BINDING = `
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
 WHERE c.slug = 'sunset'
   AND l.location_id = $1
   AND l.active = true
   AND e.provider = 'microsoft_graph'
   AND e.auth_mode = 'delegated_authorization_code'
   AND e.connector_mode = 'microsoft_delegated_oauth'
   AND e.binding_status IN ('unverified_offline', 'pending_manual_validation')
   AND e.public_address IS NOT NULL
   AND btrim(e.public_address) <> ''`.replace(/\s+/g, ' ').trim();

/**
 * Trusted resolve for refresh-health / read-health: Sunset + active location +
 * verified-or-reauth Microsoft delegated endpoint that already holds a grant.
 * Params: [location_id, endpoint_id]. Never trust body client_id.
 */
const SQL_RESOLVE_REFRESH_HEALTH_BINDING = `
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
   AND e.binding_status IN ('verified', 'reauthorization_required')
   AND e.public_address IS NOT NULL
   AND btrim(e.public_address) <> ''`.replace(/\s+/g, ' ').trim();

/** Same trusted binding resolve as refresh-health (grant present). */
const SQL_RESOLVE_READ_HEALTH_BINDING = SQL_RESOLVE_REFRESH_HEALTH_BINDING;

/**
 * Same trusted binding resolve as read-health / refresh-health (grant present).
 * Inbound diagnostic uses resolved DB UUIDs — never caller slug identity.
 */
const SQL_RESOLVE_INBOUND_DIAGNOSTIC_BINDING = SQL_RESOLVE_REFRESH_HEALTH_BINDING;

/**
 * Descriptor-safe start body snapshot: all reflection once.
 * Exact ordered own-data { location_id, endpoint_id } only —
 * no symbols/accessors/extras/unsafe protos. Each descriptor value is read
 * exactly once; returns a fresh frozen snapshot or null.
 * Never re-reads the caller after return (handler must not validate-then-reread).
 */
function snapshotStartBody(body) {
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const proto = Object.getPrototypeOf(body);
    if (proto !== Object.prototype && proto !== null) return null;
    const actual = Reflect.ownKeys(body);
    if (actual.length !== START_BODY_KEYS.length) return null;
    for (let i = 0; i < START_BODY_KEYS.length; i += 1) {
      if (actual[i] !== START_BODY_KEYS[i] || typeof actual[i] !== 'string') return null;
    }
    const out = Object.create(null);
    for (const key of START_BODY_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(body, key);
      if (!descriptor
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || descriptor.get
          || descriptor.set
          || !descriptor.enumerable) {
        return null;
      }
      // Read descriptor.value exactly once per key.
      out[key] = descriptor.value;
    }
    if (typeof out.location_id !== 'string' || !LOCATION_SLUG_RE.test(out.location_id)) {
      return null;
    }
    if (typeof out.endpoint_id !== 'string' || !UUID_RE.test(out.endpoint_id)) {
      return null;
    }
    // Canonical lowercase UUID only (reject uppercase mixed forms).
    if (out.endpoint_id !== out.endpoint_id.toLowerCase()) return null;
    return Object.freeze({
      location_id: out.location_id,
      endpoint_id: out.endpoint_id,
    });
  } catch {
    return null;
  }
}

/** Compatibility wrapper — never use for validate-then-reread in the handler. */
function validBody(body) {
  return Boolean(snapshotStartBody(body));
}

/**
 * Descriptor-safe prepare body snapshot: exact ordered own-data
 * { location_id, public_address } only — no symbols/accessors/extras.
 * Each descriptor value is read exactly once; returns frozen snapshot or null.
 * Does not canonicalize the mailbox here (domain owns that); only type/shape.
 */
function snapshotPrepareBody(body) {
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const proto = Object.getPrototypeOf(body);
    if (proto !== Object.prototype && proto !== null) return null;
    const actual = Reflect.ownKeys(body);
    if (actual.length !== PREPARE_BODY_KEYS.length) return null;
    for (let i = 0; i < PREPARE_BODY_KEYS.length; i += 1) {
      if (actual[i] !== PREPARE_BODY_KEYS[i] || typeof actual[i] !== 'string') return null;
    }
    const out = Object.create(null);
    for (const key of PREPARE_BODY_KEYS) {
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
    if (typeof out.location_id !== 'string' || !LOCATION_SLUG_RE.test(out.location_id)) {
      return null;
    }
    if (typeof out.public_address !== 'string') return null;
    return Object.freeze({
      location_id: out.location_id,
      public_address: out.public_address,
    });
  } catch {
    return null;
  }
}

/** Exact ordered prepare success DTO — success then endpoint_id; no mailbox. */
function buildPrepareSuccessJson(endpointId) {
  const dto = {};
  dto.success = true;
  dto.endpoint_id = endpointId;
  return Object.freeze(dto);
}

/** Exact ordered refresh-health success DTO — sanitized status fields only. */
function buildRefreshHealthSuccessJson(result) {
  try {
    if (!result || typeof result !== 'object') return null;
    const status = result.status;
    const grantGeneration = result.grant_generation;
    const grantStatus = result.grant_status;
    const reconcileState = result.reconcile_state;
    const reauth = result.reauthorization_required;
    if (typeof status !== 'string'
        || !['healthy', 'reauthorization_required', 'uncertain', 'unavailable'].includes(status)) {
      return null;
    }
    if (grantGeneration != null && (!Number.isInteger(grantGeneration) || grantGeneration < 1)) {
      return null;
    }
    if (grantStatus != null && typeof grantStatus !== 'string') return null;
    if (reconcileState != null && typeof reconcileState !== 'string') return null;
    if (typeof reauth !== 'boolean') return null;
    const dto = {};
    dto.success = true;
    dto.status = status;
    dto.grant_generation = grantGeneration == null ? null : grantGeneration;
    dto.grant_status = grantStatus == null ? null : grantStatus;
    dto.reconcile_state = reconcileState == null ? null : reconcileState;
    dto.reauthorization_required = reauth;
    return Object.freeze(dto);
  } catch {
    return null;
  }
}

/** Exact ordered read-health success DTO — no message/content fields. */
function buildReadHealthSuccessJson(result) {
  try {
    if (!result || typeof result !== 'object') return null;
    const status = result.status;
    const grantGeneration = result.grant_generation;
    const graphReachable = result.graph_reachable;
    const messageCount = result.message_count_bounded;
    const graphStage = result.graph_stage;
    if (typeof status !== 'string'
        || !['healthy', 'reauthorization_required', 'uncertain', 'unavailable'].includes(status)) {
      return null;
    }
    if (grantGeneration != null && (!Number.isInteger(grantGeneration) || grantGeneration < 1)) {
      return null;
    }
    if (typeof graphReachable !== 'boolean') return null;
    if (messageCount != null && (!Number.isInteger(messageCount) || messageCount < 0 || messageCount > 5)) {
      return null;
    }
    if (graphStage != null
        && (typeof graphStage !== 'string' || !READ_HEALTH_GRAPH_STAGE_SET.has(graphStage))) {
      return null;
    }
    const dto = {};
    dto.success = true;
    dto.status = status;
    dto.grant_generation = grantGeneration == null ? null : grantGeneration;
    dto.graph_reachable = graphReachable;
    dto.message_count_bounded = messageCount == null ? null : messageCount;
    dto.graph_stage = graphStage == null ? null : graphStage;
    return Object.freeze(dto);
  } catch {
    return null;
  }
}

/** Refresh-health body shares start shape: exact ordered location_id + endpoint_id. */
function snapshotRefreshHealthBody(body) {
  return snapshotStartBody(body);
}

/** Read-health body shares start shape: exact ordered location_id + endpoint_id. */
function snapshotReadHealthBody(body) {
  return snapshotStartBody(body);
}

/** Inbound-diagnostic body shares start shape: exact ordered location_id + endpoint_id. */
function snapshotInboundDiagnosticBody(body) {
  return snapshotStartBody(body);
}

/**
 * Exact ordered inbound-diagnostic success DTO.
 * Accepts the runtime result or authority-bound internal DTO and emits the exact
 * observation-only public contract. Max-5; observed = unique + duplicate.
 */
function buildInboundDiagnosticSuccessJson(result) {
  try {
    if (!result || typeof result !== 'object') return null;
    const status = result.status;
    let inputCount;
    let deliveredCount;
    let duplicateCount;
    if (status === INBOUND_DIAGNOSTIC_INTERNAL_STATUS_SUCCESS
        && result.durably_processed === INBOUND_DIAGNOSTIC_INTERNAL_DURABLY_PROCESSED
        && Number.isInteger(result.input_count)) {
      // Runtime public vocabulary (preferred).
      inputCount = result.input_count;
      deliveredCount = result.delivered_count;
      duplicateCount = result.duplicate_count;
    } else if (status === 'processed' && Number.isInteger(result.input_count)) {
      // Authority-bound internal DTO — map at route boundary (same count names).
      inputCount = result.input_count;
      deliveredCount = result.delivered_count;
      duplicateCount = result.duplicate_count;
    } else {
      return null;
    }
    if (!Number.isInteger(inputCount) || inputCount < 0
        || inputCount > INBOUND_DIAGNOSTIC_MAX_COUNT) {
      return null;
    }
    if (!Number.isInteger(deliveredCount) || deliveredCount < 0
        || deliveredCount > inputCount) {
      return null;
    }
    // observed = unique + duplicate  (input = delivered + duplicate)
    if (!Number.isInteger(duplicateCount) || duplicateCount < 0
        || duplicateCount !== inputCount - deliveredCount) {
      return null;
    }
    const dto = {};
    dto.success = true;
    dto.status = INBOUND_DIAGNOSTIC_PUBLIC_STATUS;
    dto.observed_count = inputCount;
    dto.unique_in_batch_count = deliveredCount;
    dto.duplicate_in_batch_count = duplicateCount;
    dto.durably_processed = false;
    return Object.freeze(dto);
  } catch {
    return null;
  }
}

/**
 * Exact own-data Sunset client row for prepare: { client_id } only.
 * Descriptor-safe; returns canonical lowercase UUID string or null.
 */
function snapshotPrepareClientRow(row) {
  try {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const proto = Object.getPrototypeOf(row);
    if (proto !== Object.prototype && proto !== null) return null;
    const actual = Reflect.ownKeys(row);
    if (actual.length !== PREPARE_CLIENT_ROW_KEYS.length) return null;
    for (let i = 0; i < PREPARE_CLIENT_ROW_KEYS.length; i += 1) {
      if (actual[i] !== PREPARE_CLIENT_ROW_KEYS[i] || typeof actual[i] !== 'string') {
        return null;
      }
      if (!PREPARE_CLIENT_ROW_KEY_SET.has(actual[i])) return null;
    }
    const out = Object.create(null);
    for (const key of PREPARE_CLIENT_ROW_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(row, key);
      if (!descriptor
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || descriptor.get
          || descriptor.set
          || !descriptor.enumerable) {
        return null;
      }
      out[key] = descriptor.value;
    }
    if (typeof out.client_id !== 'string' || !UUID_RE.test(out.client_id)
        || out.client_id !== out.client_id.toLowerCase()) {
      return null;
    }
    return out.client_id;
  } catch {
    return null;
  }
}

/**
 * Snapshot one-row Sunset client resolve result for prepare.
 *
 * Root: accept realistic node-postgres Result prototypes (Result.prototype)
 * as well as ordinary Object.prototype / null-proto bags. Never trust
 * inherited properties — inspect own data descriptors only. Ordinary pg
 * Result metadata (command, rowCount, oid, fields, _parsers, …) may appear
 * as own data properties; exactly one own data `rows` descriptor is
 * captured once. Accessors/symbols on the root → null. Inherited-only
 * rows (no own rows descriptor) → null.
 *
 * Rows: actual Array with Array.prototype; Reflect.ownKeys once; reject
 * symbols / extras / sparse forms. Length via own data descriptor read
 * exactly once (never a direct property get of length). Exactly one row
 * required: own keys ['0','length'], index-0 descriptor once; multi/empty/
 * malformed → null. Row contract is not loosened (see snapshotPrepareClientRow).
 * Every observation is copied once and never reread.
 */
function snapshotPrepareClientResolve(result) {
  try {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
    // Intentionally no Object.prototype|null-only rootProto gate: production
    // node-postgres returns Result instances whose prototype is Result.prototype.
    // Own-data inspection below is the sole trust boundary for rows/metadata.

    const rootKeys = Reflect.ownKeys(result);
    let rowsDesc = null;
    for (let i = 0; i < rootKeys.length; i += 1) {
      const key = rootKeys[i];
      if (typeof key === 'symbol') return null;
      const desc = Object.getOwnPropertyDescriptor(result, key);
      if (!desc
          || !Object.prototype.hasOwnProperty.call(desc, 'value')
          || desc.get
          || desc.set) {
        return null;
      }
      if (key === 'rows') {
        // Capture the single own data rows descriptor exactly once.
        if (rowsDesc) return null;
        rowsDesc = desc;
      }
      // Other own data keys: permitted as ordinary pg Result metadata (unused).
    }
    if (!rowsDesc) return null;

    const rows = rowsDesc.value;
    if (!Array.isArray(rows)) return null;
    if (Object.getPrototypeOf(rows) !== Array.prototype) return null;

    const rowKeys = Reflect.ownKeys(rows);
    for (let i = 0; i < rowKeys.length; i += 1) {
      if (typeof rowKeys[i] === 'symbol') return null;
    }
    const lengthDesc = Object.getOwnPropertyDescriptor(rows, 'length');
    if (!lengthDesc
        || !Object.prototype.hasOwnProperty.call(lengthDesc, 'value')
        || lengthDesc.get
        || lengthDesc.set
        || typeof lengthDesc.value !== 'number'
        || !Number.isInteger(lengthDesc.value)
        || lengthDesc.value < 0) {
      return null;
    }
    if (lengthDesc.value !== 1) return null;
    if (rowKeys.length !== 2 || rowKeys[0] !== '0' || rowKeys[1] !== 'length') {
      return null;
    }
    const indexDesc = Object.getOwnPropertyDescriptor(rows, '0');
    if (!indexDesc
        || !Object.prototype.hasOwnProperty.call(indexDesc, 'value')
        || indexDesc.get
        || indexDesc.set) {
      return null;
    }
    return snapshotPrepareClientRow(indexDesc.value);
  } catch {
    return null;
  }
}

/** Prepare gate: exact START flag + Sunset deployment (callback may stay false). */
function isPrepareEnabled(env) {
  return !!env
    && env.LUNA_EMAIL_OAUTH_START_ENABLED === 'true'
    && env.LUNA_DEPLOYMENT === 'sunset-staging';
}

/**
 * Exact own-data resolve row surface: Object.prototype or null only;
 * exact ordered keys client_id, location_id, endpoint_id; enumerable data
 * descriptors only; each value read once. Returns fresh frozen null-proto
 * record or null.
 */
function snapshotExactResolveRow(row) {
  try {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const proto = Object.getPrototypeOf(row);
    if (proto !== Object.prototype && proto !== null) return null;
    const actual = Reflect.ownKeys(row);
    if (actual.length !== RESOLVE_ROW_KEYS.length) return null;
    for (let i = 0; i < RESOLVE_ROW_KEYS.length; i += 1) {
      if (actual[i] !== RESOLVE_ROW_KEYS[i] || typeof actual[i] !== 'string') return null;
      if (!RESOLVE_ROW_KEY_SET.has(actual[i])) return null;
    }
    const out = Object.create(null);
    for (const key of RESOLVE_ROW_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(row, key);
      if (!descriptor
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || descriptor.get
          || descriptor.set
          || !descriptor.enumerable) {
        return null;
      }
      out[key] = descriptor.value;
    }
    if (typeof out.client_id !== 'string' || !UUID_RE.test(out.client_id)
        || out.client_id !== out.client_id.toLowerCase()) {
      return null;
    }
    if (typeof out.location_id !== 'string' || !UUID_RE.test(out.location_id)
        || out.location_id !== out.location_id.toLowerCase()) {
      return null;
    }
    if (typeof out.endpoint_id !== 'string' || !UUID_RE.test(out.endpoint_id)
        || out.endpoint_id !== out.endpoint_id.toLowerCase()) {
      return null;
    }
    return Object.freeze({
      client_id: out.client_id,
      location_id: out.location_id,
      endpoint_id: out.endpoint_id,
    });
  } catch {
    return null;
  }
}

/**
 * One-read descriptor snapshot of a pg-style resolve QueryResult for start.
 *
 * Root: accept realistic node-postgres Result prototypes (Result.prototype)
 * as well as ordinary Object.prototype / null-proto bags. Never trust
 * inherited properties — inspect own data descriptors only. Ordinary pg
 * Result metadata (command, rowCount, oid, fields, _parsers, …) may appear
 * as own data properties; exactly one own data `rows` descriptor is
 * captured once. Accessors/symbols on the root → invalid. Inherited-only
 * rows (no own rows descriptor) → invalid.
 *
 * Rows: actual Array with Array.prototype; Reflect.ownKeys once; reject
 * symbols / extras / sparse forms. Length via own data descriptor read
 * exactly once (never a direct property get of length). Empty → exact keys
 * ['length']. One row → exact keys ['0','length'], index-0 descriptor once.
 * Multi/other → invalid. Every observation is copied once and never reread.
 * Row contract is not loosened (see snapshotExactResolveRow).
 */
function snapshotResolveQueryResult(result) {
  try {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return Object.freeze({ kind: 'invalid' });
    }
    // Intentionally no Object.prototype|null-only rootProto gate: production
    // node-postgres returns Result instances whose prototype is Result.prototype.
    // Own-data inspection below is the sole trust boundary for rows/metadata.

    // Snapshot root own keys once; reject symbols.
    const rootKeys = Reflect.ownKeys(result);
    let rowsDesc = null;
    for (let i = 0; i < rootKeys.length; i += 1) {
      const key = rootKeys[i];
      if (typeof key === 'symbol') {
        return Object.freeze({ kind: 'invalid' });
      }
      // One descriptor read per key; reject any accessor / trap throw.
      const desc = Object.getOwnPropertyDescriptor(result, key);
      if (!desc
          || !Object.prototype.hasOwnProperty.call(desc, 'value')
          || desc.get
          || desc.set) {
        return Object.freeze({ kind: 'invalid' });
      }
      if (key === 'rows') {
        // Capture the single own data rows descriptor exactly once.
        if (rowsDesc) return Object.freeze({ kind: 'invalid' });
        rowsDesc = desc;
      }
      // Other own data keys: permitted as ordinary pg Result metadata (unused).
    }
    if (!rowsDesc) return Object.freeze({ kind: 'invalid' });

    const rows = rowsDesc.value;
    if (!Array.isArray(rows)) return Object.freeze({ kind: 'invalid' });
    const rowsProto = Object.getPrototypeOf(rows);
    if (rowsProto !== Array.prototype) return Object.freeze({ kind: 'invalid' });

    // Snapshot array own keys once.
    const rowKeys = Reflect.ownKeys(rows);
    for (let i = 0; i < rowKeys.length; i += 1) {
      if (typeof rowKeys[i] === 'symbol') {
        return Object.freeze({ kind: 'invalid' });
      }
    }

    // Length: exact own data descriptor once — never a direct property get.
    const lengthDesc = Object.getOwnPropertyDescriptor(rows, 'length');
    if (!lengthDesc
        || !Object.prototype.hasOwnProperty.call(lengthDesc, 'value')
        || lengthDesc.get
        || lengthDesc.set
        || typeof lengthDesc.value !== 'number'
        || !Number.isInteger(lengthDesc.value)
        || lengthDesc.value < 0) {
      return Object.freeze({ kind: 'invalid' });
    }
    const n = lengthDesc.value;

    if (n === 0) {
      // Empty ordinary array: exact own keys must be only 'length'.
      if (rowKeys.length !== 1 || rowKeys[0] !== 'length') {
        return Object.freeze({ kind: 'invalid' });
      }
      return Object.freeze({ kind: 'empty' });
    }

    if (n === 1) {
      // One-element ordinary array: exact own keys '0' then 'length'.
      if (rowKeys.length !== 2
          || rowKeys[0] !== '0'
          || rowKeys[1] !== 'length') {
        return Object.freeze({ kind: 'invalid' });
      }
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

    // Multi-row / other lengths are fail-closed (no insert).
    return Object.freeze({ kind: 'invalid' });
  } catch {
    return Object.freeze({ kind: 'invalid' });
  }
}

/**
 * Production native surfaces only: frozen wrappers that Reflect.apply the
 * module-init-captured functions to their captured original owners. Never
 * dynamically dereference https.request, crypto methods, or globals during
 * callback. Route deps cannot substitute Microsoft network/crypto.
 */
function productionNativeSurfaces() {
  return Object.freeze({
    https: Object.freeze({
      request(...args) {
        return Reflect.apply(PRODUCTION_HTTPS_REQUEST, PRODUCTION_HTTPS, args);
      },
    }),
    crypto: Object.freeze({
      createPublicKey(...args) {
        return Reflect.apply(
          PRODUCTION_CRYPTO_CREATE_PUBLIC_KEY,
          PRODUCTION_CRYPTO,
          args,
        );
      },
      verify(...args) {
        return Reflect.apply(PRODUCTION_CRYPTO_VERIFY, PRODUCTION_CRYPTO, args);
      },
    }),
    timers: Object.freeze({
      setTimeout(...args) {
        return Reflect.apply(
          PRODUCTION_SET_TIMEOUT,
          PRODUCTION_TIMERS_OWNER,
          args,
        );
      },
      clearTimeout(...args) {
        return Reflect.apply(
          PRODUCTION_CLEAR_TIMEOUT,
          PRODUCTION_TIMERS_OWNER,
          args,
        );
      },
    }),
  });
}

/**
 * Build per-callback stage telemetry with a server-generated UUIDv4.
 * Correlation is internal to telemetry stages (pinned native randomUUID) and
 * independent of attacker-supplied / ALS HTTP x-request-id. Generation
 * failure → noop telemetry (OAuth path must not fail closed for logging).
 */
function buildCallbackStageTelemetry() {
  return createCallbackEmailOAuthStageTelemetry(defaultEmailOAuthStageLogger);
}

function buildCallbackRuntime(env, pg, stageTelemetry) {
  const natives = productionNativeSurfaces();
  // Production-only dependency bag: always Azure KV Sunset staging envelope
  // from validated env. Route deps cannot substitute the envelope surface.
  // stageTelemetry is server-generated per callback and owner-preserving.
  const tel = stageTelemetry || createNoopEmailOAuthStageTelemetry();
  return createSunsetStagingMicrosoftOAuthCallbackRuntime(Object.freeze({
    env,
    pgClient: pg,
    https: natives.https,
    crypto: natives.crypto,
    timers: natives.timers,
    stageTelemetry: tel,
  }));
}

function buildRefreshHealthRuntime(env, pg) {
  const natives = productionNativeSurfaces();
  return createSunsetStagingMicrosoftDelegatedRefreshRuntime(Object.freeze({
    env,
    pgClient: pg,
    https: natives.https,
    timers: natives.timers,
  }));
}

function buildReadHealthRuntime(env, pg) {
  const natives = productionNativeSurfaces();
  return createSunsetStagingMicrosoftDelegatedReadRuntime(Object.freeze({
    env,
    pgClient: pg,
    https: natives.https,
    timers: natives.timers,
  }));
}

function buildInboundDiagnosticRuntime(env, pg) {
  const natives = productionNativeSurfaces();
  return createSunsetStagingMicrosoftDelegatedInboundDiagnosticRuntime(Object.freeze({
    env,
    pgClient: pg,
    https: natives.https,
    timers: natives.timers,
  }));
}

function createStaffEmailOAuthRoutes(deps) {
  const env = deps.runtimeEnv || process.env;

  /**
   * POST prepare — create one disabled Sunset Microsoft delegated endpoint.
   * Gate: START flag + sunset-staging. Auth: Sunset admin owner session.
   * One fixed sanitized error; no mailbox echo; no raw SQL/error logs.
   */
  async function handlePrepare(body, req, res, user) {
    if (!isPrepareEnabled(env)) {
      return deps.sendJSON(res, 404, { success: false, error: 'not_found' });
    }
    if (!user || user.client_slug !== 'sunset'
        || !UUID_RE_CI.test(user.staff_user_id || '')
        || !UUID_RE_CI.test(user.session_id || '')) {
      return deps.sendJSON(res, 403, { success: false, error: 'forbidden' });
    }
    if (!deps.assertStaffClientAccess(user, 'sunset', res)) return;
    const authz = deps.authorizeAuthenticatedStaffRoute({
      clientSlug: 'sunset',
      method: 'POST',
      pathname: OAUTH_PREPARE_PATH,
      env,
    });
    if (!authz.ok) {
      return deps.sendJSON(res, authz.status || 403, authz.body || { success: false, error: 'forbidden' });
    }
    const bodySnap = snapshotPrepareBody(body);
    if (!bodySnap) {
      return deps.sendJSON(res, 400, { success: false, error: 'invalid_request' });
    }
    try {
      return await deps.withPgClient(async (pg) => {
        // Resolve trusted Sunset client UUID once; snapshot exact row; pass it.
        // Never trust body client — prepare body has no client field.
        const clientRes = await pg.query(SQL_RESOLVE_SUNSET_CLIENT_FOR_PREPARE);
        const trustedClientId = snapshotPrepareClientResolve(clientRes);
        if (!trustedClientId) {
          return deps.sendJSON(res, 503, { success: false, error: PREPARE_ERROR });
        }
        // Exact ordered domain input: clientId first, then location/public/actor.
        const domainInput = {};
        domainInput[PREPARE_DOMAIN_INPUT_KEYS[0]] = trustedClientId;
        domainInput[PREPARE_DOMAIN_INPUT_KEYS[1]] = bodySnap.location_id;
        domainInput[PREPARE_DOMAIN_INPUT_KEYS[2]] = bodySnap.public_address;
        domainInput[PREPARE_DOMAIN_INPUT_KEYS[3]] = String(user.staff_user_id).toLowerCase();
        const ordered = Object.freeze(domainInput);
        const prepare = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: pg }));
        const ack = await prepare.prepareDisabledDelegatedEndpoint(ordered);
        // Domain ack is exact frozen { endpointId } only (no status/prepared).
        if (!ack || typeof ack !== 'object'
            || Reflect.ownKeys(ack).length !== 1
            || Reflect.ownKeys(ack)[0] !== 'endpointId'
            || typeof ack.endpointId !== 'string'
            || !UUID_RE.test(ack.endpointId)) {
          return deps.sendJSON(res, 503, { success: false, error: PREPARE_ERROR });
        }
        const json = buildPrepareSuccessJson(ack.endpointId);
        // Descriptor-safe order: success then endpoint_id only.
        if (Reflect.ownKeys(json).length !== PREPARE_SUCCESS_KEYS.length
            || Reflect.ownKeys(json)[0] !== PREPARE_SUCCESS_KEYS[0]
            || Reflect.ownKeys(json)[1] !== PREPARE_SUCCESS_KEYS[1]) {
          return deps.sendJSON(res, 503, { success: false, error: PREPARE_ERROR });
        }
        return deps.sendJSON(res, 200, json);
      });
    } catch (err) {
      // One fixed sanitized error — never leak address, SQLSTATE, or domain text.
      if (err && err.code === PREPARE_ERROR_CODE) {
        return deps.sendJSON(res, 503, { success: false, error: PREPARE_ERROR });
      }
      return deps.sendJSON(res, 503, { success: false, error: PREPARE_ERROR });
    }
  }

  async function handleStart(body, req, res, user) {
    if (!isStartEnabled(env)) {
      return deps.sendJSON(res, 404, { success: false, error: 'not_found' });
    }
    if (!user || user.client_slug !== 'sunset'
        || !UUID_RE_CI.test(user.staff_user_id || '')
        || !UUID_RE_CI.test(user.session_id || '')) {
      return deps.sendJSON(res, 403, { success: false, error: 'forbidden' });
    }
    if (!deps.assertStaffClientAccess(user, 'sunset', res)) return;
    const authz = deps.authorizeAuthenticatedStaffRoute({
      clientSlug: 'sunset',
      method: 'POST',
      pathname: OAUTH_START_PATH,
      env,
    });
    if (!authz.ok) {
      return deps.sendJSON(res, authz.status || 403, authz.body || { success: false, error: 'forbidden' });
    }
    // Exactly one descriptor-safe snapshot; never validate then reread body.
    const bodySnap = snapshotStartBody(body);
    if (!bodySnap) {
      return deps.sendJSON(res, 400, { success: false, error: 'invalid_request' });
    }
    try {
      return await deps.withPgClient(async (pg) => {
        const found = await pg.query(SQL_RESOLVE_START_BINDING, [
          bodySnap.location_id,
          bodySnap.endpoint_id,
        ]);
        // Snapshot query result once; never re-read found.rows / row fields.
        const resolved = snapshotResolveQueryResult(found);
        if (resolved.kind === 'empty') {
          return deps.sendJSON(res, 404, { success: false, error: 'location_not_found' });
        }
        if (resolved.kind !== 'one') {
          // Ambiguous / multi-row / proxy / hostile row — fail closed, no insert.
          return deps.sendJSON(res, 503, { success: false, error: 'oauth_start_unavailable' });
        }
        const rowSnap = resolved.row;
        // Endpoint must equal body snapshot; location consistency is via SQL
        // params (slug $1 + endpoint $2) plus row UUIDs from that join.
        if (rowSnap.endpoint_id !== bodySnap.endpoint_id) {
          return deps.sendJSON(res, 503, { success: false, error: 'oauth_start_unavailable' });
        }
        // Exact ordered transaction start INPUT_KEYS (endpointId third).
        // Use only frozen row + body snapshots — never re-read driver row.
        const startInput = {
          clientId: rowSnap.client_id,
          locationId: rowSnap.location_id,
          endpointId: rowSnap.endpoint_id,
          staffUserId: user.staff_user_id,
          authSessionId: user.session_id,
        };
        // Maintain exact key order for service snapshot contract.
        const ordered = {};
        for (const key of INPUT_KEYS) ordered[key] = startInput[key];
        const service = createMicrosoftOAuthTransactionService({
          repository: createPostgresOAuthTransactionRepository(pg),
          env,
        });
        const dto = await service.start(ordered);
        return deps.sendJSON(res, 200, dto);
      });
    } catch (_) {
      return deps.sendJSON(res, 503, { success: false, error: 'oauth_start_unavailable' });
    }
  }

  /**
   * POST refresh-health — lease/open/MS refresh/reseal/CAS for Sunset grant.
   * Gate: LUNA_EMAIL_OAUTH_REFRESH_HEALTH_ENABLED + sunset-staging composition.
   * Auth: Sunset admin. Sanitized status only; never tokens/envelopes/raw errors.
   * Does not flip start/callback flags or endpoint activation.
   */
  async function handleRefreshHealth(body, req, res, user) {
    if (!isRefreshHealthEnabled(env)) {
      return deps.sendJSON(res, 404, { success: false, error: 'not_found' });
    }
    if (!user || user.client_slug !== 'sunset'
        || !UUID_RE_CI.test(user.staff_user_id || '')
        || !UUID_RE_CI.test(user.session_id || '')) {
      return deps.sendJSON(res, 403, { success: false, error: 'forbidden' });
    }
    if (!deps.assertStaffClientAccess(user, 'sunset', res)) return;
    const authz = deps.authorizeAuthenticatedStaffRoute({
      clientSlug: 'sunset',
      method: 'POST',
      pathname: OAUTH_REFRESH_HEALTH_PATH,
      env,
    });
    if (!authz.ok) {
      return deps.sendJSON(res, authz.status || 403, authz.body || { success: false, error: 'forbidden' });
    }
    const bodySnap = snapshotRefreshHealthBody(body);
    if (!bodySnap) {
      return deps.sendJSON(res, 400, { success: false, error: 'invalid_request' });
    }
    try {
      return await deps.withPgClient(async (pg) => {
        const found = await pg.query(SQL_RESOLVE_REFRESH_HEALTH_BINDING, [
          bodySnap.location_id,
          bodySnap.endpoint_id,
        ]);
        const resolved = snapshotResolveQueryResult(found);
        if (resolved.kind === 'empty') {
          return deps.sendJSON(res, 404, { success: false, error: 'endpoint_not_found' });
        }
        if (resolved.kind !== 'one') {
          return deps.sendJSON(res, 503, { success: false, error: REFRESH_HEALTH_ERROR });
        }
        const rowSnap = resolved.row;
        if (rowSnap.endpoint_id !== bodySnap.endpoint_id) {
          return deps.sendJSON(res, 503, { success: false, error: REFRESH_HEALTH_ERROR });
        }
        const service = buildRefreshHealthRuntime(env, pg);
        const result = await service.runRefreshHealth(Object.freeze({
          clientId: rowSnap.client_id,
          endpointId: rowSnap.endpoint_id,
        }));
        const json = buildRefreshHealthSuccessJson(result);
        if (!json
            || Reflect.ownKeys(json).length !== REFRESH_HEALTH_SUCCESS_KEYS.length
            || Reflect.ownKeys(json)[0] !== REFRESH_HEALTH_SUCCESS_KEYS[0]) {
          return deps.sendJSON(res, 503, { success: false, error: REFRESH_HEALTH_ERROR });
        }
        return deps.sendJSON(res, 200, json);
      });
    } catch (_) {
      return deps.sendJSON(res, 503, { success: false, error: REFRESH_HEALTH_ERROR });
    }
  }

  /**
   * POST read-health — refresh/CAS then one bounded Graph Mail.ReadBasic list.
   * Gate: LUNA_EMAIL_OAUTH_READ_HEALTH_ENABLED + sunset-staging composition.
   * Auth: Sunset admin. Sanitized count/status only; never message content.
   */
  async function handleReadHealth(body, req, res, user) {
    if (!isReadHealthEnabled(env)) {
      return deps.sendJSON(res, 404, { success: false, error: 'not_found' });
    }
    if (!user || user.client_slug !== 'sunset'
        || !UUID_RE_CI.test(user.staff_user_id || '')
        || !UUID_RE_CI.test(user.session_id || '')) {
      return deps.sendJSON(res, 403, { success: false, error: 'forbidden' });
    }
    if (!deps.assertStaffClientAccess(user, 'sunset', res)) return;
    const authz = deps.authorizeAuthenticatedStaffRoute({
      clientSlug: 'sunset',
      method: 'POST',
      pathname: OAUTH_READ_HEALTH_PATH,
      env,
    });
    if (!authz.ok) {
      return deps.sendJSON(res, authz.status || 403, authz.body || { success: false, error: 'forbidden' });
    }
    const bodySnap = snapshotReadHealthBody(body);
    if (!bodySnap) {
      return deps.sendJSON(res, 400, { success: false, error: 'invalid_request' });
    }
    try {
      return await deps.withPgClient(async (pg) => {
        const found = await pg.query(SQL_RESOLVE_READ_HEALTH_BINDING, [
          bodySnap.location_id,
          bodySnap.endpoint_id,
        ]);
        const resolved = snapshotResolveQueryResult(found);
        if (resolved.kind === 'empty') {
          return deps.sendJSON(res, 404, { success: false, error: 'endpoint_not_found' });
        }
        if (resolved.kind !== 'one') {
          return deps.sendJSON(res, 503, { success: false, error: READ_HEALTH_ERROR });
        }
        const rowSnap = resolved.row;
        if (rowSnap.endpoint_id !== bodySnap.endpoint_id) {
          return deps.sendJSON(res, 503, { success: false, error: READ_HEALTH_ERROR });
        }
        const service = buildReadHealthRuntime(env, pg);
        const result = await service.runReadHealth(Object.freeze({
          clientId: rowSnap.client_id,
          endpointId: rowSnap.endpoint_id,
        }));
        const json = buildReadHealthSuccessJson(result);
        if (!json
            || Reflect.ownKeys(json).length !== READ_HEALTH_SUCCESS_KEYS.length
            || Reflect.ownKeys(json)[0] !== READ_HEALTH_SUCCESS_KEYS[0]) {
          return deps.sendJSON(res, 503, { success: false, error: READ_HEALTH_ERROR });
        }
        return deps.sendJSON(res, 200, json);
      });
    } catch (_) {
      return deps.sendJSON(res, 503, { success: false, error: READ_HEALTH_ERROR });
    }
  }

  /**
   * POST inbound-diagnostic — authority-bound ImmutableId page + batch handoff.
   * Gate: LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED + sunset-staging only.
   * Auth: Sunset admin (same ACL/authz pattern as read-health). Body/binding
   * resolver reused; operation input uses resolved DB UUIDs only (never caller
   * slug identity). Sanitized identity-free observation DTO only; never message
   * content, IDs, PII, stage, generation, or durability claims.
   * Failures: 404 disabled/unresolved, 400 malformed body, 503 operation fail.
   * No cron/poller/startup; flag never in manifests/defaults.
   */
  async function handleInboundDiagnostic(body, req, res, user, gateEnv = env) {
    // Concealed 404 before DB/runtime/network when flag absent/other or non-sunset.
    // The top-level router passes its frozen pre-auth snapshot. The default keeps
    // direct unit invocation fail-closed without creating a second predicate.
    if (!isInboundDiagnosticEnabled(gateEnv)) {
      return deps.sendJSON(res, 404, { success: false, error: 'not_found' });
    }
    if (!user || user.client_slug !== 'sunset'
        || !UUID_RE_CI.test(user.staff_user_id || '')
        || !UUID_RE_CI.test(user.session_id || '')) {
      return deps.sendJSON(res, 403, { success: false, error: 'forbidden' });
    }
    if (!deps.assertStaffClientAccess(user, 'sunset', res)) return;
    const authz = deps.authorizeAuthenticatedStaffRoute({
      clientSlug: 'sunset',
      method: 'POST',
      pathname: OAUTH_INBOUND_DIAGNOSTIC_PATH,
      env,
    });
    if (!authz.ok) {
      return deps.sendJSON(res, authz.status || 403, authz.body || { success: false, error: 'forbidden' });
    }
    const bodySnap = snapshotInboundDiagnosticBody(body);
    if (!bodySnap) {
      return deps.sendJSON(res, 400, { success: false, error: 'invalid_request' });
    }
    try {
      return await deps.withPgClient(async (pg) => {
        const found = await pg.query(SQL_RESOLVE_INBOUND_DIAGNOSTIC_BINDING, [
          bodySnap.location_id,
          bodySnap.endpoint_id,
        ]);
        const resolved = snapshotResolveQueryResult(found);
        if (resolved.kind === 'empty') {
          return deps.sendJSON(res, 404, { success: false, error: 'endpoint_not_found' });
        }
        if (resolved.kind !== 'one') {
          return deps.sendJSON(res, 503, { success: false, error: INBOUND_DIAGNOSTIC_ERROR });
        }
        const rowSnap = resolved.row;
        if (rowSnap.endpoint_id !== bodySnap.endpoint_id) {
          return deps.sendJSON(res, 503, { success: false, error: INBOUND_DIAGNOSTIC_ERROR });
        }
        // Operation input: exact resolved DB UUIDs (client/location/endpoint).
        // Never caller client_slug or body client_id.
        const service = buildInboundDiagnosticRuntime(env, pg);
        const result = await service.runInboundDiagnostic(Object.freeze({
          clientId: rowSnap.client_id,
          locationId: rowSnap.location_id,
          endpointId: rowSnap.endpoint_id,
        }));
        const json = buildInboundDiagnosticSuccessJson(result);
        if (!json
            || Reflect.ownKeys(json).length !== INBOUND_DIAGNOSTIC_SUCCESS_KEYS.length
            || Reflect.ownKeys(json)[0] !== INBOUND_DIAGNOSTIC_SUCCESS_KEYS[0]
            || Reflect.ownKeys(json).join(',') !== INBOUND_DIAGNOSTIC_SUCCESS_KEYS.join(',')) {
          return deps.sendJSON(res, 503, { success: false, error: INBOUND_DIAGNOSTIC_ERROR });
        }
        return deps.sendJSON(res, 200, json);
      });
    } catch (_) {
      return deps.sendJSON(res, 503, { success: false, error: INBOUND_DIAGNOSTIC_ERROR });
    }
  }

  function terminal(res, statusCode, status) {
    const messages = {
      authorization_received: 'Authorization response received. You may close this window.',
      authorization_declined: 'Authorization was declined. You may close this window.',
      invalid_or_expired: 'This authorization request could not be accepted.',
    };
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>Authorization status</title></head>`
      + `<body><main><h1>Authorization status</h1><p>${messages[status] || messages.invalid_or_expired}</p>`
      + `</main></body></html>`,
    );
  }

  async function handleCallback(query, req, res, user) {
    if (!isCallbackEnabled(env)) {
      return terminal(res, 404, 'invalid_or_expired');
    }
    if (!user || user.client_slug !== 'sunset'
        || !UUID_RE_CI.test(user.client_id || '')
        || !UUID_RE_CI.test(user.session_id || '')) {
      return terminal(res, 400, 'invalid_or_expired');
    }
    // Snapshot server-generated stage telemetry once per callback (shared by
    // all stages). Logger failures never affect OAuth; no ALS/x-request-id.
    const stageTelemetry = buildCallbackStageTelemetry();
    try {
      const result = await deps.withPgClient(async (pg) => {
        // Completing callback only when flag true (gate above). Concrete
        // merged completion chain via runtime factory — not legacy receive-only
        // service. Construction fails closed if readiness missing.
        // Natives always from production wrap of node:https / node:crypto /
        // global timers — never route DI substitution.
        const service = buildCallbackRuntime(env, pg, stageTelemetry);
        return service.accept(query, {
          clientId: user.client_id,
          authSessionId: user.session_id,
        });
      });
      return terminal(
        res,
        result && result.status === 'invalid_or_expired' ? 400 : 200,
        result && result.status ? result.status : 'invalid_or_expired',
      );
    } catch (_) {
      return terminal(res, 400, 'invalid_or_expired');
    }
  }

  return Object.freeze({
    handleStart,
    handlePrepare,
    handleRefreshHealth,
    handleReadHealth,
    handleInboundDiagnostic,
    handleCallback,
  });
}

module.exports = {
  OAUTH_START_PATH,
  OAUTH_PREPARE_PATH,
  OAUTH_REFRESH_HEALTH_PATH,
  OAUTH_READ_HEALTH_PATH,
  OAUTH_INBOUND_DIAGNOSTIC_PATH,
  OAUTH_CALLBACK_PATH,
  SQL_RESOLVE_START_BINDING,
  SQL_RESOLVE_REFRESH_HEALTH_BINDING,
  SQL_RESOLVE_READ_HEALTH_BINDING,
  SQL_RESOLVE_INBOUND_DIAGNOSTIC_BINDING,
  SQL_RESOLVE_SUNSET_CLIENT_FOR_PREPARE,
  START_BODY_KEYS,
  PREPARE_BODY_KEYS,
  REFRESH_HEALTH_BODY_KEYS,
  READ_HEALTH_BODY_KEYS,
  INBOUND_DIAGNOSTIC_BODY_KEYS,
  PREPARE_SUCCESS_KEYS,
  REFRESH_HEALTH_SUCCESS_KEYS,
  READ_HEALTH_SUCCESS_KEYS,
  INBOUND_DIAGNOSTIC_SUCCESS_KEYS,
  PREPARE_ERROR,
  REFRESH_HEALTH_ERROR,
  READ_HEALTH_ERROR,
  INBOUND_DIAGNOSTIC_ERROR,
  RESOLVE_ROW_KEYS,
  PREPARE_CLIENT_ROW_KEYS,
  validBody,
  snapshotStartBody,
  snapshotPrepareBody,
  snapshotRefreshHealthBody,
  snapshotReadHealthBody,
  snapshotInboundDiagnosticBody,
  snapshotPrepareClientResolve,
  snapshotResolveQueryResult,
  isPrepareEnabled,
  buildPrepareSuccessJson,
  buildRefreshHealthSuccessJson,
  buildReadHealthSuccessJson,
  buildInboundDiagnosticSuccessJson,
  createStaffEmailOAuthRoutes,
  // Re-export production dependency key constant for offline verifiers (no secrets).
  RUNTIME_DEPENDENCY_KEYS: DEPENDENCY_KEYS,
};

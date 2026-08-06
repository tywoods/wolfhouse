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
  createSunsetMicrosoftEndpointPrepare,
  INPUT_KEYS: PREPARE_DOMAIN_INPUT_KEYS,
  ERROR_CODE: PREPARE_ERROR_CODE,
} = require('./email-sunset-microsoft-endpoint-prepare');

const OAUTH_START_PATH = '/staff/admin/email-settings/oauth/microsoft/start';
/** Exact prepare path — endpoint creation prerequisite for Microsoft OAuth. */
const OAUTH_PREPARE_PATH = '/staff/admin/email-settings/oauth/microsoft/endpoint';
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
/** Exact ordered prepare success JSON keys (no mailbox echo). */
const PREPARE_SUCCESS_KEYS = Object.freeze(['success', 'endpoint_id']);
const PREPARE_ERROR = 'endpoint_prepare_unavailable';
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

function buildCallbackRuntime(env, pg) {
  const natives = productionNativeSurfaces();
  // Production-only dependency bag: always Azure KV Sunset staging envelope
  // from validated env. Route deps cannot substitute the envelope surface.
  return createSunsetStagingMicrosoftOAuthCallbackRuntime(Object.freeze({
    env,
    pgClient: pg,
    https: natives.https,
    crypto: natives.crypto,
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
    try {
      const result = await deps.withPgClient(async (pg) => {
        // Completing callback only when flag true (gate above). Concrete
        // merged completion chain via runtime factory — not legacy receive-only
        // service. Construction fails closed if readiness missing.
        // Natives always from production wrap of node:https / node:crypto /
        // global timers — never route DI substitution.
        const service = buildCallbackRuntime(env, pg);
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

  return Object.freeze({ handleStart, handlePrepare, handleCallback });
}

module.exports = {
  OAUTH_START_PATH,
  OAUTH_PREPARE_PATH,
  OAUTH_CALLBACK_PATH,
  SQL_RESOLVE_START_BINDING,
  SQL_RESOLVE_SUNSET_CLIENT_FOR_PREPARE,
  START_BODY_KEYS,
  PREPARE_BODY_KEYS,
  PREPARE_SUCCESS_KEYS,
  PREPARE_ERROR,
  RESOLVE_ROW_KEYS,
  PREPARE_CLIENT_ROW_KEYS,
  validBody,
  snapshotStartBody,
  snapshotPrepareBody,
  snapshotPrepareClientResolve,
  snapshotResolveQueryResult,
  isPrepareEnabled,
  buildPrepareSuccessJson,
  createStaffEmailOAuthRoutes,
  // Re-export production dependency key constant for offline verifiers (no secrets).
  RUNTIME_DEPENDENCY_KEYS: DEPENDENCY_KEYS,
};

/**
 * Staff email-registry READ routes — Luna email Slice 1C-beta.
 *
 * Admin-only inventory over the empty tenant email registry:
 *
 *   GET /staff/admin/email-registry/locations
 *   GET /staff/admin/email-registry/channel-endpoints
 *
 * Auth is NOT enforced here. The Staff API router must call
 * requireAuth(req, res, 'admin') before dispatching handlers from this module
 * (role gate + home-tenant admin_db_read as defense in depth).
 *
 * After ACL on the *requested* client slug, handlers re-invoke the existing
 * authorizeAuthenticatedStaffRoute for THAT requested clientSlug + GET + exact
 * admin pathname so a multi-client admin cannot use tenant A admin_db_read to
 * read tenant B when B has admin_db_read disabled.
 *
 * Tenant scope:
 *   - client slug from query.client | query.client_slug | DEFAULT_CLIENT
 *   - assertStaffClientAccess (cross-client ACL) before any list
 *   - authorizeAuthenticatedStaffRoute(requested clientSlug) before UUID/list
 *   - client UUID resolved only via parameterized `clients.slug` lookup
 *   - query/body `client_id` is never trusted or used for scoping
 *
 * include_inactive:
 *   - omit → true (return all registry rows; useful admin inventory default —
 *     endpoints are created inactive/disabled until a later activation slice)
 *   - exact `true` | `false` (case-insensitive after trim)
 *   - any other value → 400
 *
 * Response DTOs are explicit allowlists. `secret_ref` is ALWAYS omitted for every
 * role (including admin); only `secret_ref_present` boolean is returned. Never log
 * secret_ref values. Endpoint capabilities are fail-closed: rebuilt from the Slice
 * 1A eight-boolean allowlist; malformed rows fail the whole request as 500.
 *
 * Errors: log only bounded category + sanitized code allowlist — never err.message
 * or attacker-controlled detail strings.
 *
 * @module staff-email-registry-routes
 */

'use strict';

const registry = require('./email-tenant-channel-registry');
const {
  EMAIL_MAILBOX_CAPABILITY_KEYS,
  validateEmailMailboxCapabilities,
} = require('./email-mailbox-adapter-contract');

const EMAIL_REGISTRY_LOCATIONS_PATH = '/staff/admin/email-registry/locations';
const EMAIL_REGISTRY_ENDPOINTS_PATH = '/staff/admin/email-registry/channel-endpoints';
const EMAIL_REGISTRY_MIN_ROLE = 'admin';

const LOCATION_DTO_KEYS = Object.freeze([
  'id',
  'location_id',
  'display_name',
  'active',
  'created_at',
  'updated_at',
]);

/** Endpoint DTO keys excluding capabilities (rebuilt separately) and secret_ref_present. */
const ENDPOINT_DTO_SCALAR_KEYS = Object.freeze([
  'id',
  'location_id',
  'channel',
  'provider',
  'public_address',
  'provider_resource_id',
  'inbound_enabled',
  'outbound_enabled',
  'default_automation_mode',
  'active',
  'created_at',
  'updated_at',
]);

const ENDPOINT_DTO_KEYS = Object.freeze([
  ...ENDPOINT_DTO_SCALAR_KEYS,
  'capabilities',
  'secret_ref_present',
]);

/** Stable audit error codes only — never arbitrary repository/injected text. */
const AUDIT_ERROR_CODE_ALLOWLIST = new Set([
  'db_error',
  'capabilities_invalid',
  'read_failed',
  'client_slug_lookup_failed',
]);

/** Sanitized log codes (node/pg connectivity + internal categories). */
const LOG_CODE_ALLOWLIST = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNRESET',
  'EPIPE',
  'EAI_AGAIN',
  'db_error',
  'capabilities_invalid',
  'client_slug_lookup_failed',
  'pg_error',
  'unknown',
]);

/**
 * Strict query parser for include_inactive.
 * Default true (all registry records) for admin inventory — documented above.
 *
 * @param {object} query
 * @returns {{ ok: true, value: boolean } | { ok: false, error: string }}
 */
function parseEmailRegistryIncludeInactive(query) {
  const q = query && typeof query === 'object' ? query : {};
  if (q.include_inactive == null || q.include_inactive === '') {
    return { ok: true, value: true };
  }
  const raw = String(q.include_inactive).trim().toLowerCase();
  if (raw === 'true') return { ok: true, value: true };
  if (raw === 'false') return { ok: true, value: false };
  return { ok: false, error: 'include_inactive must be true or false' };
}

function pickKeys(row, keys) {
  const out = {};
  for (const k of keys) {
    if (k === 'secret_ref_present' || k === 'capabilities') continue;
    out[k] = row && Object.prototype.hasOwnProperty.call(row, k) ? row[k] : null;
  }
  return out;
}

function toAuditErrorCode(raw) {
  const c = raw != null ? String(raw) : 'db_error';
  return AUDIT_ERROR_CODE_ALLOWLIST.has(c) ? c : 'db_error';
}

/**
 * Classify errors for logs: bounded category + allowlisted/normalized code only.
 * Never returns err.message or attacker-controlled detail strings.
 * @param {unknown} err
 * @param {string} [fallbackCategory]
 * @returns {{ category: string, code: string }}
 */
function classifyEmailRegistryError(err, fallbackCategory) {
  const category = fallbackCategory && String(fallbackCategory).trim()
    ? String(fallbackCategory).trim()
    : 'internal_error';
  const raw = err && err.code != null ? String(err.code) : '';
  if (LOG_CODE_ALLOWLIST.has(raw)) {
    return { category, code: raw };
  }
  // Known PG SQLSTATE shape → normalize; do not echo arbitrary codes.
  if (/^[0-9A-Z]{5}$/.test(raw)) {
    return { category: 'db_error', code: 'pg_error' };
  }
  return { category, code: 'unknown' };
}

function logEmailRegistryFailure(scope, err, fallbackCategory) {
  const { category, code } = classifyEmailRegistryError(err, fallbackCategory || scope);
  // Stable format only — never err.message / stack / details.
  console.error(`[email-registry.${scope}] failed category=${category} code=${code}`);
}

/**
 * Rebuild capabilities from Slice 1A allowlist only. Never copy arbitrary JSON.
 * @param {unknown} capabilities
 * @returns {{ ok: true, value: Record<string, boolean> } | { ok: false, error: string }}
 */
function rebuildEndpointCapabilitiesDto(capabilities) {
  const checked = validateEmailMailboxCapabilities(capabilities);
  if (!checked.ok) {
    return { ok: false, error: 'capabilities_invalid' };
  }
  const fresh = {};
  for (const key of EMAIL_MAILBOX_CAPABILITY_KEYS) {
    fresh[key] = checked.value[key] === true;
  }
  return { ok: true, value: fresh };
}

function mapLocationDto(row) {
  return pickKeys(row, LOCATION_DTO_KEYS);
}

/**
 * Map endpoint row → DTO. Fail-closed on malformed capabilities.
 * @returns {{ ok: true, value: object } | { ok: false, error: 'capabilities_invalid' }}
 */
function mapEndpointDto(row) {
  const caps = rebuildEndpointCapabilitiesDto(row && row.capabilities);
  if (!caps.ok) {
    return { ok: false, error: 'capabilities_invalid' };
  }
  const dto = pickKeys(row, ENDPOINT_DTO_SCALAR_KEYS);
  dto.capabilities = caps.value;
  const ref = row && row.secret_ref;
  dto.secret_ref_present = ref != null && String(ref).trim() !== '';
  return { ok: true, value: dto };
}

/**
 * Resolve client UUID from slug via parameterized lookup. Never invent IDs.
 * @param {{ query: Function }} pg
 * @param {string} clientSlug
 * @returns {Promise<string|null>}
 */
async function resolveClientUuidBySlug(pg, clientSlug) {
  const res = await pg.query(
    'SELECT id::text AS client_id FROM clients WHERE slug = $1 LIMIT 1',
    [clientSlug],
  );
  const row = res && res.rows && res.rows[0];
  return row && row.client_id ? String(row.client_id) : null;
}

/**
 * @typedef {object} EmailRegistryRouteDeps
 * @property {(res: import('http').ServerResponse, status: number, body: object) => unknown} sendJSON
 * @property {(res: import('http').ServerResponse, message: string) => unknown} send400
 * @property {(user: object|null, clientSlug: string, res: import('http').ServerResponse) => boolean} assertStaffClientAccess
 * @property {(opts: { clientSlug: string, method: string, pathname: string, env?: object }) => { ok: boolean, status?: number, body?: object, mode?: string }} authorizeAuthenticatedStaffRoute
 * @property {(entry: object) => void} appendAuditLog
 * @property {(fn: (pg: object) => Promise<any>) => Promise<any>} withPgClient
 * @property {string} DEFAULT_CLIENT
 * @property {RegExp} SQL_INJECT_RE
 * @property {object} [runtimeEnv] Optional env for authorizer (defaults to process.env)
 * @property {typeof registry.listTenantLocations} [listTenantLocations]
 * @property {typeof registry.listTenantChannelEndpoints} [listTenantChannelEndpoints]
 */

/**
 * Build handlers bound to monolith helpers. Role auth stays in the Staff API router;
 * requested-tenant admin_db_read is re-checked here via injected authorizer.
 *
 * @param {EmailRegistryRouteDeps} deps
 */
function createEmailRegistryRoutes(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new Error('createEmailRegistryRoutes: deps required');
  }
  const {
    sendJSON,
    send400,
    assertStaffClientAccess,
    authorizeAuthenticatedStaffRoute,
    appendAuditLog,
    withPgClient,
    DEFAULT_CLIENT,
    SQL_INJECT_RE,
  } = deps;

  if (typeof authorizeAuthenticatedStaffRoute !== 'function') {
    throw new Error('createEmailRegistryRoutes: authorizeAuthenticatedStaffRoute required');
  }
  if (typeof assertStaffClientAccess !== 'function') {
    throw new Error('createEmailRegistryRoutes: assertStaffClientAccess required');
  }

  const runtimeEnv = deps.runtimeEnv && typeof deps.runtimeEnv === 'object'
    ? deps.runtimeEnv
    : process.env;

  const listTenantLocations = typeof deps.listTenantLocations === 'function'
    ? deps.listTenantLocations
    : registry.listTenantLocations;
  const listTenantChannelEndpoints = typeof deps.listTenantChannelEndpoints === 'function'
    ? deps.listTenantChannelEndpoints
    : registry.listTenantChannelEndpoints;

  function resolveClientSlug(query) {
    // Never trust query.client_id / body client_id for scoping.
    const raw = query && (query.client != null ? query.client : query.client_slug);
    const slug = String(raw != null && String(raw).trim() !== '' ? raw : DEFAULT_CLIENT).trim();
    return slug;
  }

  /**
   * Shared pre-list gate: slug, inject check, ACL, requested-tenant authz,
   * include_inactive, client UUID. UUID/list only after authz allows.
   *
   * @param {object} query
   * @param {import('http').ServerResponse} res
   * @param {object|null} user
   * @param {string} routePathname Exact admin route pathname for authorizer
   * @returns {Promise<null | { clientSlug: string, clientId: string, includeInactive: boolean }>}
   */
  async function prepareListScope(query, res, user, routePathname) {
    const clientSlug = resolveClientSlug(query);
    if (SQL_INJECT_RE.test(clientSlug)) {
      send400(res, 'invalid client slug');
      return null;
    }
    if (!assertStaffClientAccess(user, clientSlug, res)) return null;

    // Requested-tenant permission gate (admin_db_read for GET /staff/admin/...).
    // Uses the same authorizer + runtime env convention as requireAuth; re-scoped
    // to the ACL-approved requested clientSlug (not home tenant alone).
    const decision = authorizeAuthenticatedStaffRoute({
      clientSlug,
      method: 'GET',
      pathname: routePathname,
      env: runtimeEnv,
    });
    if (!decision || decision.ok !== true) {
      const status = decision && decision.status ? decision.status : 403;
      const body = decision && decision.body && typeof decision.body === 'object'
        ? decision.body
        : { success: false, error: 'tenant_route_forbidden' };
      sendJSON(res, status, body);
      return null;
    }

    const include = parseEmailRegistryIncludeInactive(query);
    if (!include.ok) {
      send400(res, include.error);
      return null;
    }

    let clientId;
    try {
      clientId = await withPgClient((pg) => resolveClientUuidBySlug(pg, clientSlug));
    } catch (err) {
      logEmailRegistryFailure('client_slug_lookup', err, 'client_slug_lookup_failed');
      sendJSON(res, 500, { success: false, error: 'read failed' });
      return null;
    }
    if (!clientId) {
      sendJSON(res, 404, { success: false, error: 'client_not_found' });
      return null;
    }
    return { clientSlug, clientId, includeInactive: include.value };
  }

  async function handleLocationsGet(query, req, res, user) {
    const started = Date.now();
    const scope = await prepareListScope(query, res, user, EMAIL_REGISTRY_LOCATIONS_PATH);
    if (!scope) return;

    try {
      const result = await withPgClient(async (pg) => listTenantLocations(
        { clientId: scope.clientId, includeInactive: scope.includeInactive },
        { db: pg },
      ));
      if (!result || result.ok !== true) {
        appendAuditLog({
          ts: new Date().toISOString(),
          intent: 'api:admin.email_registry.locations.list',
          category: 'admin_api',
          client_slug: scope.clientSlug,
          success: false,
          error: toAuditErrorCode(result && result.error),
          staff_user_id: user ? user.staff_user_id : null,
          elapsed_ms: Date.now() - started,
        });
        // Never surface raw PG / repository details.
        return sendJSON(res, 500, { success: false, error: 'read failed' });
      }
      const locations = (result.value || []).map(mapLocationDto);
      appendAuditLog({
        ts: new Date().toISOString(),
        intent: 'api:admin.email_registry.locations.list',
        category: 'admin_api',
        client_slug: scope.clientSlug,
        success: true,
        row_count: locations.length,
        include_inactive: scope.includeInactive,
        staff_user_id: user ? user.staff_user_id : null,
        elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, 200, {
        success: true,
        client_slug: scope.clientSlug,
        include_inactive: scope.includeInactive,
        locations,
        elapsed_ms: Date.now() - started,
      });
    } catch (err) {
      logEmailRegistryFailure('locations', err, 'internal_error');
      return sendJSON(res, 500, { success: false, error: 'read failed' });
    }
  }

  async function handleChannelEndpointsGet(query, req, res, user) {
    const started = Date.now();
    const scope = await prepareListScope(query, res, user, EMAIL_REGISTRY_ENDPOINTS_PATH);
    if (!scope) return;

    try {
      const result = await withPgClient(async (pg) => listTenantChannelEndpoints(
        { clientId: scope.clientId, includeInactive: scope.includeInactive },
        { db: pg },
      ));
      if (!result || result.ok !== true) {
        appendAuditLog({
          ts: new Date().toISOString(),
          intent: 'api:admin.email_registry.channel_endpoints.list',
          category: 'admin_api',
          client_slug: scope.clientSlug,
          success: false,
          error: toAuditErrorCode(result && result.error),
          staff_user_id: user ? user.staff_user_id : null,
          elapsed_ms: Date.now() - started,
        });
        return sendJSON(res, 500, { success: false, error: 'read failed' });
      }

      const endpoints = [];
      for (const row of result.value || []) {
        const mapped = mapEndpointDto(row);
        if (!mapped.ok) {
          appendAuditLog({
            ts: new Date().toISOString(),
            intent: 'api:admin.email_registry.channel_endpoints.list',
            category: 'admin_api',
            client_slug: scope.clientSlug,
            success: false,
            error: toAuditErrorCode(mapped.error),
            staff_user_id: user ? user.staff_user_id : null,
            elapsed_ms: Date.now() - started,
          });
          // Fail closed: do not return partial/malformed rows or hostile keys.
          return sendJSON(res, 500, { success: false, error: 'read failed' });
        }
        endpoints.push(mapped.value);
      }

      appendAuditLog({
        ts: new Date().toISOString(),
        intent: 'api:admin.email_registry.channel_endpoints.list',
        category: 'admin_api',
        client_slug: scope.clientSlug,
        success: true,
        row_count: endpoints.length,
        include_inactive: scope.includeInactive,
        staff_user_id: user ? user.staff_user_id : null,
        elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, 200, {
        success: true,
        client_slug: scope.clientSlug,
        include_inactive: scope.includeInactive,
        endpoints,
        elapsed_ms: Date.now() - started,
      });
    } catch (err) {
      logEmailRegistryFailure('channel_endpoints', err, 'internal_error');
      return sendJSON(res, 500, { success: false, error: 'read failed' });
    }
  }

  const routes = Object.freeze([
    {
      method: 'GET',
      path: EMAIL_REGISTRY_LOCATIONS_PATH,
      minRole: EMAIL_REGISTRY_MIN_ROLE,
      handler: handleLocationsGet,
    },
    {
      method: 'GET',
      path: EMAIL_REGISTRY_ENDPOINTS_PATH,
      minRole: EMAIL_REGISTRY_MIN_ROLE,
      handler: handleChannelEndpointsGet,
    },
  ]);

  /**
   * Path+method match. Returns { handler, minRole, path, method } or null.
   * Caller is responsible for requireAuth(..., minRole).
   */
  function match(pathname, method) {
    const m = String(method || '').toUpperCase();
    for (const r of routes) {
      if (r.path === pathname && r.method === m) return r;
    }
    return null;
  }

  return {
    PATHS: Object.freeze({
      locations: EMAIL_REGISTRY_LOCATIONS_PATH,
      endpoints: EMAIL_REGISTRY_ENDPOINTS_PATH,
    }),
    LOCATIONS_PATH: EMAIL_REGISTRY_LOCATIONS_PATH,
    ENDPOINTS_PATH: EMAIL_REGISTRY_ENDPOINTS_PATH,
    MIN_ROLE: EMAIL_REGISTRY_MIN_ROLE,
    routes,
    match,
    handleLocationsGet,
    handleChannelEndpointsGet,
    parseEmailRegistryIncludeInactive,
    mapLocationDto,
    mapEndpointDto,
  };
}

module.exports = {
  EMAIL_REGISTRY_LOCATIONS_PATH,
  EMAIL_REGISTRY_ENDPOINTS_PATH,
  EMAIL_REGISTRY_MIN_ROLE,
  parseEmailRegistryIncludeInactive,
  mapLocationDto,
  mapEndpointDto,
  rebuildEndpointCapabilitiesDto,
  classifyEmailRegistryError,
  toAuditErrorCode,
  createEmailRegistryRoutes,
};

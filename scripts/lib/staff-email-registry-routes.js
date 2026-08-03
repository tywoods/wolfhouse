/**
 * Staff email-registry routes — Luna email Slice 1C-beta (READ) + 1C-gamma (WRITE).
 *
 * Admin-only inventory and kill-switched registration over the empty tenant email registry:
 *
 *   GET  /staff/admin/email-registry/locations
 *   GET  /staff/admin/email-registry/channel-endpoints
 *   POST /staff/admin/email-registry/locations
 *   POST /staff/admin/email-registry/channel-endpoints
 *
 * Auth is NOT enforced here. The Staff API router must call
 * requireAuth(req, res, 'admin') before dispatching handlers from this module
 * (role gate + home-tenant admin_db_read / admin_writes as defense in depth).
 *
 * After ACL on the *requested* client slug, handlers re-invoke the existing
 * authorizeAuthenticatedStaffRoute for THAT requested clientSlug + method + exact
 * admin pathname so a multi-client admin cannot use tenant A flags to access
 * tenant B when B has the corresponding permission disabled.
 *
 * Tenant scope:
 *   - client slug from query.client | query.client_slug | DEFAULT_CLIENT
 *   - assertStaffClientAccess (cross-client ACL) before any list/write
 *   - authorizeAuthenticatedStaffRoute(requested clientSlug) before UUID/list/write
 *   - client UUID resolved only via parameterized `clients.slug` lookup
 *   - query/body `client_id` is never trusted or used for scoping
 *
 * Write kill switch (1C-gamma):
 *   - EMAIL_REGISTRY_WRITES_ENABLED must be exact case-insensitive `true`
 *   - omitted / false / 1 / yes → 403 email_registry_writes_disabled (fail-closed)
 *   - Gate before UUID lookup and domain write
 *
 * include_inactive (GET only):
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
 * Writes:
 *   - Location body allowlist: location_id, display_name, optional active (default true)
 *   - Endpoint body allowlist: location_id, provider, public_address, provider_resource_id,
 *     capabilities, secret_ref — domain forces disabled/off; never accept activation keys
 *   - Trusted clientId from slug UUID; trusted actor from user.staff_user_id (UUID only)
 *   - Domain writes via `{ client }` on the borrowed withPgClient PoolClient
 *   - Domain owns BEGIN/COMMIT; routes never nest transactions
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

const LOCATION_POST_ALLOWLIST = Object.freeze(['location_id', 'display_name', 'active']);
const ENDPOINT_POST_ALLOWLIST = Object.freeze([
  'location_id',
  'provider',
  'public_address',
  'provider_resource_id',
  'capabilities',
  'secret_ref',
]);

/** Stable audit error codes only — never arbitrary repository/injected text. */
const AUDIT_ERROR_CODE_ALLOWLIST = new Set([
  'db_error',
  'capabilities_invalid',
  'read_failed',
  'write_failed',
  'client_slug_lookup_failed',
  'location_already_exists',
  'endpoint_already_exists',
  'location_not_authorized',
  'email_registry_writes_disabled',
  'validation_error',
  'unknown_field',
  'body_required',
  'invalid_json',
  'body_must_be_object',
  'actor_required',
  'actor_invalid',
  'transaction_client_required',
  'location_id_invalid',
  'display_name_invalid',
  'active_invalid',
  'provider_invalid',
  'public_address_invalid',
  'secret_ref_invalid',
  'capabilities_invalid',
  'endpoint_invalid',
  'endpoint_forbidden_field',
  'endpoint_unknown_field',
  'endpoint_activation_forbidden',
  'client_id_invalid',
  'actor_staff_user_id_invalid',
  'location_invalid',
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
  'write_failed',
  'transaction_client_required',
]);

/**
 * Global write kill switch. Exact case-insensitive `true` only.
 * Omitted / false / 1 / yes / anything else → disabled (fail-closed).
 *
 * @param {object} [env]
 * @returns {boolean}
 */
function isEmailRegistryWritesEnabled(env) {
  const src = env && typeof env === 'object' ? env : process.env;
  const raw = src.EMAIL_REGISTRY_WRITES_ENABLED;
  if (raw == null) return false;
  return String(raw).trim().toLowerCase() === 'true';
}

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
 * Trusted actor from authenticated session only. Never from request body/query.
 * @param {object|null} user
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
function resolveActorStaffUserId(user) {
  const raw = user && user.staff_user_id;
  if (raw == null || String(raw).trim() === '') {
    return { ok: false, error: 'actor_required' };
  }
  const v = String(raw).trim();
  if (!UUID_RE.test(v)) {
    return { ok: false, error: 'actor_invalid' };
  }
  return { ok: true, value: v.toLowerCase() };
}

/**
 * Parse JSON body as a plain object (not array). Never trust types from Content-Type alone.
 * @param {string} raw
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
function parseJsonObjectBody(raw) {
  if (raw == null || String(raw).trim() === '') {
    return { ok: false, error: 'body_required' };
  }
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (_) {
    return { ok: false, error: 'invalid_json' };
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'body_must_be_object' };
  }
  const proto = Object.getPrototypeOf(parsed);
  if (proto !== Object.prototype && proto !== null) {
    return { ok: false, error: 'body_must_be_object' };
  }
  return { ok: true, value: parsed };
}

/**
 * Strict location create body allowlist.
 * @param {object} body
 * @returns {{ ok: true, value: { location_id: string, display_name: string, active: boolean } } | { ok: false, error: string, field?: string }}
 */
function parseLocationCreateBody(body) {
  for (const key of Object.keys(body)) {
    if (!LOCATION_POST_ALLOWLIST.includes(key)) {
      return { ok: false, error: 'unknown_field', field: key };
    }
  }
  if (body.location_id == null || typeof body.location_id !== 'string' || !String(body.location_id).trim()) {
    return { ok: false, error: 'location_id_invalid', field: 'location_id' };
  }
  if (body.display_name == null || typeof body.display_name !== 'string') {
    return { ok: false, error: 'display_name_invalid', field: 'display_name' };
  }
  const displayName = String(body.display_name).trim();
  if (!displayName) {
    return { ok: false, error: 'display_name_invalid', field: 'display_name' };
  }
  let active = true;
  if (Object.prototype.hasOwnProperty.call(body, 'active')) {
    if (typeof body.active !== 'boolean') {
      return { ok: false, error: 'active_invalid', field: 'active' };
    }
    active = body.active;
  }
  // Domain createTenantLocation always inserts active=true; inactive create is not supported
  // without a domain change. Reject false so the API does not silently ignore the flag.
  if (active !== true) {
    return { ok: false, error: 'active_invalid', field: 'active' };
  }
  return {
    ok: true,
    value: {
      location_id: String(body.location_id).trim(),
      display_name: displayName,
      active: true,
    },
  };
}

/**
 * Strict endpoint create body allowlist. Activation / authority keys rejected.
 * @param {object} body
 * @returns {{ ok: true, value: object } | { ok: false, error: string, field?: string }}
 */
function parseEndpointCreateBody(body) {
  for (const key of Object.keys(body)) {
    if (!ENDPOINT_POST_ALLOWLIST.includes(key)) {
      return { ok: false, error: 'unknown_field', field: key };
    }
  }
  if (body.location_id == null || typeof body.location_id !== 'string' || !String(body.location_id).trim()) {
    return { ok: false, error: 'location_id_invalid', field: 'location_id' };
  }
  if (body.provider == null || typeof body.provider !== 'string' || !String(body.provider).trim()) {
    return { ok: false, error: 'provider_invalid', field: 'provider' };
  }
  if (body.public_address == null || typeof body.public_address !== 'string' || !String(body.public_address).trim()) {
    return { ok: false, error: 'public_address_invalid', field: 'public_address' };
  }
  if (body.secret_ref == null || typeof body.secret_ref !== 'string' || !String(body.secret_ref).trim()) {
    return { ok: false, error: 'secret_ref_invalid', field: 'secret_ref' };
  }
  if (body.capabilities == null || typeof body.capabilities !== 'object' || Array.isArray(body.capabilities)) {
    return { ok: false, error: 'capabilities_invalid', field: 'capabilities' };
  }
  const out = {
    location_id: String(body.location_id).trim(),
    provider: String(body.provider).trim(),
    public_address: String(body.public_address).trim(),
    secret_ref: String(body.secret_ref).trim(),
    capabilities: body.capabilities,
  };
  if (Object.prototype.hasOwnProperty.call(body, 'provider_resource_id')) {
    if (body.provider_resource_id != null && typeof body.provider_resource_id !== 'string') {
      return { ok: false, error: 'validation_error', field: 'provider_resource_id' };
    }
    if (body.provider_resource_id != null) {
      out.provider_resource_id = String(body.provider_resource_id);
    }
  }
  return { ok: true, value: out };
}

/**
 * Map domain write failure → HTTP status + sanitized public error (no details).
 * @param {{ ok?: boolean, error?: string }} result
 * @returns {{ status: number, error: string, audit: string }}
 */
function mapDomainWriteFailure(result) {
  const code = result && result.error != null ? String(result.error) : 'db_error';
  if (code === 'location_already_exists' || code === 'endpoint_already_exists') {
    return { status: 409, error: code, audit: code };
  }
  if (code === 'location_not_authorized') {
    // Indistinguishable missing / inactive / cross-tenant.
    return { status: 404, error: 'location_not_authorized', audit: 'location_not_authorized' };
  }
  if (
    code === 'transaction_client_required'
    || code === 'transaction_client_invalid'
    || code === 'db_error'
    || code === 'db_required'
    || code === 'db_invalid'
  ) {
    const audit = code === 'db_error' ? 'db_error' : 'transaction_client_required';
    return { status: 500, error: 'write failed', audit };
  }
  // Validation-style domain / 1A codes → stable 400; never leak details objects.
  if (AUDIT_ERROR_CODE_ALLOWLIST.has(code)) {
    return { status: 400, error: code, audit: code };
  }
  if (/_invalid$|_forbidden|_required$|unknown_field|activation|not_authorized/.test(code)) {
    return { status: 400, error: 'validation_error', audit: 'validation_error' };
  }
  return { status: 500, error: 'write failed', audit: 'db_error' };
}

/**
 * @typedef {object} EmailRegistryRouteDeps
 * @property {(res: import('http').ServerResponse, status: number, body: object) => unknown} sendJSON
 * @property {(res: import('http').ServerResponse, message: string) => unknown} send400
 * @property {(req: import('http').IncomingMessage) => Promise<string>} [readBody]
 * @property {(user: object|null, clientSlug: string, res: import('http').ServerResponse) => boolean} assertStaffClientAccess
 * @property {(opts: { clientSlug: string, method: string, pathname: string, env?: object }) => { ok: boolean, status?: number, body?: object, mode?: string }} authorizeAuthenticatedStaffRoute
 * @property {(entry: object) => void} appendAuditLog
 * @property {(fn: (pg: object) => Promise<any>) => Promise<any>} withPgClient
 * @property {string} DEFAULT_CLIENT
 * @property {RegExp} SQL_INJECT_RE
 * @property {object} [runtimeEnv] Optional env for authorizer + kill switch (defaults to process.env)
 * @property {typeof registry.listTenantLocations} [listTenantLocations]
 * @property {typeof registry.listTenantChannelEndpoints} [listTenantChannelEndpoints]
 * @property {typeof registry.createTenantLocation} [createTenantLocation]
 * @property {typeof registry.createDisabledTenantChannelEndpoint} [createDisabledTenantChannelEndpoint]
 */

/**
 * Build handlers bound to monolith helpers. Role auth stays in the Staff API router;
 * requested-tenant permissions are re-checked here via injected authorizer.
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

  const readBody = typeof deps.readBody === 'function'
    ? deps.readBody
    : async function defaultReadBody(req) {
      if (req && req._cachedBody !== undefined) return req._cachedBody;
      return new Promise((resolve, reject) => {
        const chunks = [];
        if (!req || typeof req.on !== 'function') {
          resolve('');
          return;
        }
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const s = Buffer.concat(chunks).toString('utf8');
          if (req) req._cachedBody = s;
          resolve(s);
        });
        req.on('error', reject);
      });
    };

  const runtimeEnv = deps.runtimeEnv && typeof deps.runtimeEnv === 'object'
    ? deps.runtimeEnv
    : process.env;

  const listTenantLocations = typeof deps.listTenantLocations === 'function'
    ? deps.listTenantLocations
    : registry.listTenantLocations;
  const listTenantChannelEndpoints = typeof deps.listTenantChannelEndpoints === 'function'
    ? deps.listTenantChannelEndpoints
    : registry.listTenantChannelEndpoints;
  const createTenantLocation = typeof deps.createTenantLocation === 'function'
    ? deps.createTenantLocation
    : registry.createTenantLocation;
  const createDisabledTenantChannelEndpoint = typeof deps.createDisabledTenantChannelEndpoint === 'function'
    ? deps.createDisabledTenantChannelEndpoint
    : registry.createDisabledTenantChannelEndpoint;

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

  /**
   * Shared pre-write security gates (no UUID / domain yet):
   * slug → ACL → authorize(POST, requested tenant) → kill switch.
   *
   * @returns {Promise<null | { clientSlug: string }>}
   */
  async function prepareWriteGates(query, res, user, routePathname) {
    const clientSlug = resolveClientSlug(query);
    if (SQL_INJECT_RE.test(clientSlug)) {
      send400(res, 'invalid client slug');
      return null;
    }
    if (!assertStaffClientAccess(user, clientSlug, res)) return null;

    const decision = authorizeAuthenticatedStaffRoute({
      clientSlug,
      method: 'POST',
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

    if (!isEmailRegistryWritesEnabled(runtimeEnv)) {
      sendJSON(res, 403, { success: false, error: 'email_registry_writes_disabled' });
      return null;
    }

    return { clientSlug };
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

  async function handleLocationsPost(query, req, res, user) {
    const started = Date.now();
    const gates = await prepareWriteGates(query, res, user, EMAIL_REGISTRY_LOCATIONS_PATH);
    if (!gates) return;

    let rawBody;
    try {
      rawBody = await readBody(req);
    } catch (err) {
      logEmailRegistryFailure('locations_create_body', err, 'internal_error');
      return sendJSON(res, 400, { success: false, error: 'body_required' });
    }
    const parsed = parseJsonObjectBody(rawBody);
    if (!parsed.ok) {
      appendAuditLog({
        ts: new Date().toISOString(),
        intent: 'api:admin.email_registry.locations.create',
        category: 'admin_api',
        client_slug: gates.clientSlug,
        success: false,
        error: toAuditErrorCode(parsed.error),
        staff_user_id: user ? user.staff_user_id : null,
        elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, 400, { success: false, error: parsed.error });
    }
    const body = parseLocationCreateBody(parsed.value);
    if (!body.ok) {
      appendAuditLog({
        ts: new Date().toISOString(),
        intent: 'api:admin.email_registry.locations.create',
        category: 'admin_api',
        client_slug: gates.clientSlug,
        success: false,
        error: toAuditErrorCode(body.error),
        staff_user_id: user ? user.staff_user_id : null,
        elapsed_ms: Date.now() - started,
      });
      const resp = { success: false, error: body.error };
      if (body.field) resp.field = body.field;
      return sendJSON(res, 400, resp);
    }

    const actor = resolveActorStaffUserId(user);
    if (!actor.ok) {
      appendAuditLog({
        ts: new Date().toISOString(),
        intent: 'api:admin.email_registry.locations.create',
        category: 'admin_api',
        client_slug: gates.clientSlug,
        success: false,
        error: toAuditErrorCode(actor.error),
        staff_user_id: null,
        elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, 400, { success: false, error: actor.error });
    }

    try {
      const outcome = await withPgClient(async (client) => {
        const clientId = await resolveClientUuidBySlug(client, gates.clientSlug);
        if (!clientId) return { kind: 'client_not_found' };
        const result = await createTenantLocation(
          {
            clientId,
            actorStaffUserId: actor.value,
            locationId: body.value.location_id,
            displayName: body.value.display_name,
          },
          { client },
        );
        return { kind: 'domain', result, clientId };
      });

      if (outcome.kind === 'client_not_found') {
        appendAuditLog({
          ts: new Date().toISOString(),
          intent: 'api:admin.email_registry.locations.create',
          category: 'admin_api',
          client_slug: gates.clientSlug,
          success: false,
          error: 'client_slug_lookup_failed',
          staff_user_id: actor.value,
          elapsed_ms: Date.now() - started,
        });
        return sendJSON(res, 404, { success: false, error: 'client_not_found' });
      }

      const result = outcome.result;
      if (!result || result.ok !== true) {
        const mapped = mapDomainWriteFailure(result || { error: 'db_error' });
        appendAuditLog({
          ts: new Date().toISOString(),
          intent: 'api:admin.email_registry.locations.create',
          category: 'admin_api',
          client_slug: gates.clientSlug,
          success: false,
          error: toAuditErrorCode(mapped.audit),
          staff_user_id: actor.value,
          elapsed_ms: Date.now() - started,
        });
        return sendJSON(res, mapped.status, { success: false, error: mapped.error });
      }

      const location = mapLocationDto(result.value);
      appendAuditLog({
        ts: new Date().toISOString(),
        intent: 'api:admin.email_registry.locations.create',
        category: 'admin_api',
        client_slug: gates.clientSlug,
        success: true,
        location_id: location.location_id,
        staff_user_id: actor.value,
        elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, 201, {
        success: true,
        client_slug: gates.clientSlug,
        location,
        elapsed_ms: Date.now() - started,
      });
    } catch (err) {
      logEmailRegistryFailure('locations_create', err, 'internal_error');
      appendAuditLog({
        ts: new Date().toISOString(),
        intent: 'api:admin.email_registry.locations.create',
        category: 'admin_api',
        client_slug: gates.clientSlug,
        success: false,
        error: 'write_failed',
        staff_user_id: actor.value,
        elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, 500, { success: false, error: 'write failed' });
    }
  }

  async function handleChannelEndpointsPost(query, req, res, user) {
    const started = Date.now();
    const gates = await prepareWriteGates(query, res, user, EMAIL_REGISTRY_ENDPOINTS_PATH);
    if (!gates) return;

    let rawBody;
    try {
      rawBody = await readBody(req);
    } catch (err) {
      logEmailRegistryFailure('endpoints_create_body', err, 'internal_error');
      return sendJSON(res, 400, { success: false, error: 'body_required' });
    }
    const parsed = parseJsonObjectBody(rawBody);
    if (!parsed.ok) {
      appendAuditLog({
        ts: new Date().toISOString(),
        intent: 'api:admin.email_registry.channel_endpoints.create',
        category: 'admin_api',
        client_slug: gates.clientSlug,
        success: false,
        error: toAuditErrorCode(parsed.error),
        staff_user_id: user ? user.staff_user_id : null,
        elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, 400, { success: false, error: parsed.error });
    }
    const body = parseEndpointCreateBody(parsed.value);
    if (!body.ok) {
      appendAuditLog({
        ts: new Date().toISOString(),
        intent: 'api:admin.email_registry.channel_endpoints.create',
        category: 'admin_api',
        client_slug: gates.clientSlug,
        success: false,
        error: toAuditErrorCode(body.error),
        staff_user_id: user ? user.staff_user_id : null,
        elapsed_ms: Date.now() - started,
      });
      const resp = { success: false, error: body.error };
      if (body.field) resp.field = body.field;
      return sendJSON(res, 400, resp);
    }

    const actor = resolveActorStaffUserId(user);
    if (!actor.ok) {
      appendAuditLog({
        ts: new Date().toISOString(),
        intent: 'api:admin.email_registry.channel_endpoints.create',
        category: 'admin_api',
        client_slug: gates.clientSlug,
        success: false,
        error: toAuditErrorCode(actor.error),
        staff_user_id: null,
        elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, 400, { success: false, error: actor.error });
    }

    try {
      const outcome = await withPgClient(async (client) => {
        const clientId = await resolveClientUuidBySlug(client, gates.clientSlug);
        if (!clientId) return { kind: 'client_not_found' };
        // Domain owns active-location SELECT + preloaded authority + forced disabled INSERT.
        // Never construct request-supplied locationAuthority.
        const domainInput = {
          clientId,
          actorStaffUserId: actor.value,
          location_id: body.value.location_id,
          provider: body.value.provider,
          public_address: body.value.public_address,
          secret_ref: body.value.secret_ref,
          capabilities: body.value.capabilities,
        };
        if (body.value.provider_resource_id !== undefined) {
          domainInput.provider_resource_id = body.value.provider_resource_id;
        }
        const result = await createDisabledTenantChannelEndpoint(domainInput, { client });
        return { kind: 'domain', result, clientId };
      });

      if (outcome.kind === 'client_not_found') {
        appendAuditLog({
          ts: new Date().toISOString(),
          intent: 'api:admin.email_registry.channel_endpoints.create',
          category: 'admin_api',
          client_slug: gates.clientSlug,
          success: false,
          error: 'client_slug_lookup_failed',
          staff_user_id: actor.value,
          elapsed_ms: Date.now() - started,
        });
        return sendJSON(res, 404, { success: false, error: 'client_not_found' });
      }

      const result = outcome.result;
      if (!result || result.ok !== true) {
        const mapped = mapDomainWriteFailure(result || { error: 'db_error' });
        appendAuditLog({
          ts: new Date().toISOString(),
          intent: 'api:admin.email_registry.channel_endpoints.create',
          category: 'admin_api',
          client_slug: gates.clientSlug,
          success: false,
          error: toAuditErrorCode(mapped.audit),
          staff_user_id: actor.value,
          elapsed_ms: Date.now() - started,
        });
        return sendJSON(res, mapped.status, { success: false, error: mapped.error });
      }

      const mappedDto = mapEndpointDto(result.value);
      if (!mappedDto.ok) {
        appendAuditLog({
          ts: new Date().toISOString(),
          intent: 'api:admin.email_registry.channel_endpoints.create',
          category: 'admin_api',
          client_slug: gates.clientSlug,
          success: false,
          error: 'capabilities_invalid',
          staff_user_id: actor.value,
          elapsed_ms: Date.now() - started,
        });
        return sendJSON(res, 500, { success: false, error: 'write failed' });
      }

      appendAuditLog({
        ts: new Date().toISOString(),
        intent: 'api:admin.email_registry.channel_endpoints.create',
        category: 'admin_api',
        client_slug: gates.clientSlug,
        success: true,
        location_id: mappedDto.value.location_id,
        public_address: mappedDto.value.public_address,
        staff_user_id: actor.value,
        elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, 201, {
        success: true,
        client_slug: gates.clientSlug,
        endpoint: mappedDto.value,
        elapsed_ms: Date.now() - started,
      });
    } catch (err) {
      logEmailRegistryFailure('channel_endpoints_create', err, 'internal_error');
      appendAuditLog({
        ts: new Date().toISOString(),
        intent: 'api:admin.email_registry.channel_endpoints.create',
        category: 'admin_api',
        client_slug: gates.clientSlug,
        success: false,
        error: 'write_failed',
        staff_user_id: actor.value,
        elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, 500, { success: false, error: 'write failed' });
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
    {
      method: 'POST',
      path: EMAIL_REGISTRY_LOCATIONS_PATH,
      minRole: EMAIL_REGISTRY_MIN_ROLE,
      handler: handleLocationsPost,
    },
    {
      method: 'POST',
      path: EMAIL_REGISTRY_ENDPOINTS_PATH,
      minRole: EMAIL_REGISTRY_MIN_ROLE,
      handler: handleChannelEndpointsPost,
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
    handleLocationsPost,
    handleChannelEndpointsPost,
    parseEmailRegistryIncludeInactive,
    mapLocationDto,
    mapEndpointDto,
    isEmailRegistryWritesEnabled,
    parseLocationCreateBody,
    parseEndpointCreateBody,
    resolveActorStaffUserId,
    mapDomainWriteFailure,
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
  isEmailRegistryWritesEnabled,
  parseLocationCreateBody,
  parseEndpointCreateBody,
  resolveActorStaffUserId,
  mapDomainWriteFailure,
  createEmailRegistryRoutes,
};

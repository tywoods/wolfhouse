'use strict';

/**
 * Email tenant channel registry — Luna email Slice 1C-alpha.
 *
 * Pure domain / repository layer over tenant_locations + tenant_channel_endpoints
 * for future Staff API routes. No HTTP routes, auth roles, activation paths,
 * provider SDKs, or live DSN/config.
 *
 * Trusted dependencies (callers inject; this module never opens a global connection):
 * - Reads (`listTenantLocations`, `listTenantChannelEndpoints`): `{ db }` —
 *   any single-query executor with `query(text, params)`. A Pool is fine for
 *   one SELECT.
 * - Writes (`createTenantLocation`, `createDisabledTenantChannelEndpoint`):
 *   `{ client }` — an explicitly pinned transaction client whose `query` is
 *   used for the full BEGIN…COMMIT/ROLLBACK sequence. Do not pass a Pool or
 *   generic `{ db }`; writes reject with `transaction_client_required` before
 *   any SQL. Future Staff API `withPgClient` will supply the pinned client.
 *
 * Location authority for Slice 1A:
 *   async SELECT active (client_id, location_id) inside a transaction, then
 *   buildPreloadedLocationAuthority(...) → synchronous callback for
 *   validateTenantChannelEndpointInput. Never pass a Promise-returning authority.
 *
 * @module email-tenant-channel-registry
 */

const {
  validateTenantChannelEndpointInput,
  validateCanonicalLocationId,
  normalizeEmailPublicAddress,
} = require('./email-mailbox-adapter-contract');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISPLAY_NAME_MAX = 200;

/** Allowed untrusted field keys for disabled endpoint create (plus trusted clientId/actor). */
const ENDPOINT_CREATE_ALLOWED_KEYS = new Set([
  'clientId',
  'actorStaffUserId',
  'location_id',
  'locationId',
  'provider',
  'public_address',
  'publicAddress',
  'secret_ref',
  'secretRef',
  'provider_resource_id',
  'providerResourceId',
  'capabilities',
  // Explicit disabled flags may be supplied only as false / 'off' (enabling rejected).
  'inbound_enabled',
  'outbound_enabled',
  'active',
  'default_automation_mode',
  'channel',
]);

const FORBIDDEN_ENDPOINT_KEYS = new Set([
  'id',
  'created_by',
  'updated_by',
  'created_at',
  'updated_at',
  'client_id',
  'client_id_body',
  'location_authority',
  'locationAuthority',
  'authority',
]);

function fail(error, details) {
  const out = { ok: false, error: String(error) };
  if (details !== undefined) out.details = details;
  return out;
}

function ok(value) {
  return value === undefined ? { ok: true } : { ok: true, value };
}

function isPlainObject(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function requireDb(deps) {
  if (!deps || typeof deps !== 'object' || typeof deps.db !== 'object' || deps.db == null) {
    return fail('db_required');
  }
  if (typeof deps.db.query !== 'function') {
    return fail('db_invalid', { reason: 'query_function_required' });
  }
  return ok(deps.db);
}

/**
 * Detect obvious node-pg Pool shapes without relying on constructor.name.
 * Pool exposes connect + connection counters; a pinned Client does not.
 */
function looksLikePgPool(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (typeof obj.connect !== 'function') return false;
  if (typeof obj.totalCount === 'number') return true;
  if (typeof obj.idleCount === 'number') return true;
  if (typeof obj.waitingCount === 'number') return true;
  return false;
}

/**
 * Writes require an explicitly pinned transaction client.
 * Reject generic `{ db }` / Pool-only deps with transaction_client_required
 * before any query. No Pool acquisition or release ownership here.
 *
 * @param {{ client?: { query: Function } }} deps
 * @returns {{ ok: true, value: { query: Function } } | { ok: false, error: string, details?: object }}
 */
function requireTransactionClient(deps) {
  if (!deps || typeof deps !== 'object') {
    return fail('transaction_client_required');
  }
  // Explicit API: only `{ client }` is accepted for multi-statement transactions.
  // Supplying only `{ db }` (including pool-like executors) is rejected up front.
  if (deps.client == null) {
    return fail('transaction_client_required');
  }
  if (typeof deps.client !== 'object' || typeof deps.client.query !== 'function') {
    return fail('transaction_client_invalid', { reason: 'query_function_required' });
  }
  if (looksLikePgPool(deps.client)) {
    return fail('transaction_client_invalid', { reason: 'pool_not_allowed' });
  }
  return ok(deps.client);
}

async function rollbackQuiet(client) {
  try {
    await client.query('ROLLBACK');
  } catch (_) {
    /* ignore */
  }
}

function parseUuid(raw, field) {
  if (raw == null || typeof raw !== 'string') {
    return fail(`${field}_invalid`, { reason: 'must_be_string' });
  }
  const v = raw.trim();
  if (!v || !UUID_RE.test(v)) {
    return fail(`${field}_invalid`);
  }
  return ok(v.toLowerCase());
}

/**
 * Build a synchronous locationAuthority callback from a trusted preloaded pair
 * or immutable Set of authorized pairs.
 *
 * Accepted forms:
 * - `{ clientId, locationId }` — single authorized pair
 * - `Set<string>` where each entry is `${clientId}\0${locationId}`
 * - frozen/plain array of `{ clientId, locationId }`
 *
 * Returns `(clientId, locationId) => boolean` immediately (never a Promise).
 * Compares exact canonical string values — no case-folding or trimming.
 *
 * @param {{clientId:string,locationId:string}|Set<string>|ReadonlyArray<{clientId:string,locationId:string}>} source
 * @returns {(clientId: string, locationId: string) => boolean}
 */
function buildPreloadedLocationAuthority(source) {
  const authorized = new Set();

  if (source instanceof Set) {
    for (const entry of source) {
      if (typeof entry === 'string') authorized.add(entry);
    }
  } else if (Array.isArray(source)) {
    for (const item of source) {
      if (item && typeof item === 'object') {
        const c = item.clientId != null ? item.clientId : item.client_id;
        const l = item.locationId != null ? item.locationId : item.location_id;
        if (typeof c === 'string' && typeof l === 'string') {
          authorized.add(`${c}\0${l}`);
        }
      }
    }
  } else if (source && typeof source === 'object') {
    const c = source.clientId != null ? source.clientId : source.client_id;
    const l = source.locationId != null ? source.locationId : source.location_id;
    if (typeof c === 'string' && typeof l === 'string') {
      authorized.add(`${c}\0${l}`);
    }
  }

  // Frozen snapshot — callback closes over Set contents only.
  const frozen = new Set(authorized);

  function locationAuthority(clientId, locationId) {
    if (typeof clientId !== 'string' || typeof locationId !== 'string') return false;
    return frozen.has(`${clientId}\0${locationId}`);
  }

  return locationAuthority;
}

function mapUniqueViolation(err, kind) {
  const code = err && err.code ? String(err.code) : '';
  if (code === '23505') {
    if (kind === 'location') return fail('location_already_exists');
    return fail('endpoint_already_exists');
  }
  return null;
}

function mapDbError(err, kind) {
  const mapped = mapUniqueViolation(err, kind);
  if (mapped) return mapped;
  // Never surface raw PG / secret-looking content.
  return fail('db_error');
}

/**
 * List locations for a trusted tenant.
 * Always WHERE client_id = $1. Deterministic ORDER BY location_id ASC.
 *
 * @param {{ clientId: string, includeInactive?: boolean }} args
 * @param {{ db: { query: Function } }} deps
 */
async function listTenantLocations(args, deps) {
  const dbCheck = requireDb(deps);
  if (!dbCheck.ok) return dbCheck;

  const clientId = parseUuid(args && args.clientId, 'client_id');
  if (!clientId.ok) return clientId;

  const includeInactive = !args || args.includeInactive !== false;
  const db = dbCheck.value;

  let text;
  let params;
  if (includeInactive) {
    text = `
      SELECT id, client_id, location_id, display_name, active,
             created_at, updated_at, created_by, updated_by
        FROM tenant_locations
       WHERE client_id = $1
       ORDER BY location_id ASC`;
    params = [clientId.value];
  } else {
    text = `
      SELECT id, client_id, location_id, display_name, active,
             created_at, updated_at, created_by, updated_by
        FROM tenant_locations
       WHERE client_id = $1
         AND active = true
       ORDER BY location_id ASC`;
    params = [clientId.value];
  }

  try {
    const res = await db.query(text, params);
    return ok(res.rows || []);
  } catch (err) {
    return mapDbError(err, 'location');
  }
}

/**
 * List channel endpoints for a trusted tenant.
 * Always tenant-scoped. May return opaque secret_ref to trusted callers;
 * never resolves or logs secret values.
 *
 * @param {{ clientId: string, includeInactive?: boolean }} args
 * @param {{ db: { query: Function } }} deps
 */
async function listTenantChannelEndpoints(args, deps) {
  const dbCheck = requireDb(deps);
  if (!dbCheck.ok) return dbCheck;

  const clientId = parseUuid(args && args.clientId, 'client_id');
  if (!clientId.ok) return clientId;

  const includeInactive = !args || args.includeInactive !== false;
  const db = dbCheck.value;

  let text;
  let params;
  if (includeInactive) {
    text = `
      SELECT id, client_id, location_id, channel, provider, public_address,
             secret_ref, provider_resource_id, capabilities,
             inbound_enabled, outbound_enabled, default_automation_mode, active,
             created_at, updated_at, created_by, updated_by
        FROM tenant_channel_endpoints
       WHERE client_id = $1
       ORDER BY location_id ASC, public_address ASC, id ASC`;
    params = [clientId.value];
  } else {
    text = `
      SELECT id, client_id, location_id, channel, provider, public_address,
             secret_ref, provider_resource_id, capabilities,
             inbound_enabled, outbound_enabled, default_automation_mode, active,
             created_at, updated_at, created_by, updated_by
        FROM tenant_channel_endpoints
       WHERE client_id = $1
         AND active = true
       ORDER BY location_id ASC, public_address ASC, id ASC`;
    params = [clientId.value];
  }

  try {
    const res = await db.query(text, params);
    return ok(res.rows || []);
  } catch (err) {
    return mapDbError(err, 'endpoint');
  }
}

/**
 * Create a tenant location (default active=true). No upsert.
 * Unique conflicts → location_already_exists (no raw PG leakage).
 *
 * Requires a pinned transaction `{ client }` (not a Pool / generic `{ db }`).
 *
 * @param {{
 *   clientId: string,
 *   actorStaffUserId: string,
 *   locationId: string,
 *   displayName: string,
 * }} input
 * @param {{ client: { query: Function } }} deps
 */
async function createTenantLocation(input, deps) {
  const clientCheck = requireTransactionClient(deps);
  if (!clientCheck.ok) return clientCheck;
  const client = clientCheck.value;

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return fail('location_invalid', { reason: 'must_be_object' });
  }

  const clientId = parseUuid(input.clientId, 'client_id');
  if (!clientId.ok) return clientId;

  const actor = parseUuid(input.actorStaffUserId, 'actor_staff_user_id');
  if (!actor.ok) return actor;

  const location = validateCanonicalLocationId(input.locationId);
  if (!location.ok) return location;

  if (input.displayName == null || typeof input.displayName !== 'string') {
    return fail('display_name_invalid', { reason: 'must_be_string' });
  }
  const displayName = input.displayName.trim();
  if (!displayName) {
    return fail('display_name_invalid', { reason: 'empty' });
  }
  if (displayName.length > DISPLAY_NAME_MAX) {
    return fail('display_name_invalid', { reason: 'too_long' });
  }

  // Reject mass-assignment of identity / audit fields from untrusted extras.
  // Trusted values come only from clientId / actorStaffUserId above.

  let began = false;
  try {
    await client.query('BEGIN');
    began = true;
    const res = await client.query(
      `INSERT INTO tenant_locations (
         client_id, location_id, display_name, active, created_by, updated_by
       ) VALUES ($1::uuid, $2, $3, true, $4::uuid, $4::uuid)
       RETURNING id, client_id, location_id, display_name, active,
                 created_at, updated_at, created_by, updated_by`,
      [clientId.value, location.value, displayName, actor.value],
    );
    await client.query('COMMIT');
    return ok(res.rows[0]);
  } catch (err) {
    if (began) {
      await rollbackQuiet(client);
    }
    return mapDbError(err, 'location');
  }
}

/**
 * Validate untrusted endpoint create fields for disabled-only creation.
 * Rejects unknown keys, forbidden identity fields, and any attempt to enable
 * traffic / registry activation / non-off automation.
 */
function validateDisabledEndpointCreateInput(input) {
  if (!isPlainObject(input)) {
    return fail('endpoint_invalid', { reason: 'must_be_object' });
  }

  for (const key of Object.keys(input)) {
    if (FORBIDDEN_ENDPOINT_KEYS.has(key)) {
      return fail('endpoint_forbidden_field', { field: key });
    }
    if (!ENDPOINT_CREATE_ALLOWED_KEYS.has(key)) {
      return fail('endpoint_unknown_field', { field: key });
    }
  }

  // Activation / traffic must not be enabled via this API.
  if (Object.prototype.hasOwnProperty.call(input, 'active') && input.active !== false) {
    return fail('endpoint_activation_forbidden', { field: 'active' });
  }
  if (Object.prototype.hasOwnProperty.call(input, 'inbound_enabled') && input.inbound_enabled !== false) {
    return fail('endpoint_activation_forbidden', { field: 'inbound_enabled' });
  }
  if (Object.prototype.hasOwnProperty.call(input, 'outbound_enabled') && input.outbound_enabled !== false) {
    return fail('endpoint_activation_forbidden', { field: 'outbound_enabled' });
  }
  if (Object.prototype.hasOwnProperty.call(input, 'default_automation_mode')) {
    const mode = input.default_automation_mode;
    if (mode !== 'off') {
      return fail('endpoint_activation_forbidden', { field: 'default_automation_mode' });
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, 'channel')) {
    const ch = String(input.channel == null ? '' : input.channel).trim().toLowerCase();
    if (ch !== 'email') {
      return fail('endpoint_forbidden_field', { field: 'channel' });
    }
  }

  const clientId = parseUuid(input.clientId, 'client_id');
  if (!clientId.ok) return clientId;

  const actor = parseUuid(input.actorStaffUserId, 'actor_staff_user_id');
  if (!actor.ok) return actor;

  const locationRaw = input.location_id != null ? input.location_id : input.locationId;
  const location = validateCanonicalLocationId(locationRaw);
  if (!location.ok) return location;

  const provider = input.provider;
  const publicAddressRaw = input.public_address != null ? input.public_address : input.publicAddress;
  const secretRefRaw = input.secret_ref != null ? input.secret_ref : input.secretRef;
  const providerResourceRaw = input.provider_resource_id != null
    ? input.provider_resource_id
    : input.providerResourceId;

  return ok({
    clientId: clientId.value,
    actorStaffUserId: actor.value,
    locationId: location.value,
    provider,
    publicAddressRaw,
    secretRefRaw,
    providerResourceRaw,
    capabilities: input.capabilities,
  });
}

/**
 * Create a disabled email channel endpoint for a trusted tenant.
 *
 * Requires a pinned transaction `{ client }` (not a Pool / generic `{ db }`).
 *
 * Flow:
 *  1. Strict allowlist / reject activation mass-assignment
 *  2. BEGIN (inside guarded try; began-tracked)
 *  3. SELECT exact active tenant location (client_id, location_id) [FOR SHARE]
 *  4. buildPreloadedLocationAuthority (sync)
 *  5. validateTenantChannelEndpointInput with forced disabled flags
 *  6. Race-safe same-tenant public_address uniqueness (advisory xact lock + SELECT)
 *  7. INSERT with forced channel=email, inbound=false, outbound=false,
 *     automation=off, active=false
 *  8. COMMIT / ROLLBACK on the same pinned client
 *
 * Cross-tenant / missing / inactive locations → location_not_authorized
 * (indistinguishable). No upsert.
 *
 * @param {object} input
 * @param {{ client: { query: Function } }} deps
 */
async function createDisabledTenantChannelEndpoint(input, deps) {
  const clientCheck = requireTransactionClient(deps);
  if (!clientCheck.ok) return clientCheck;
  const client = clientCheck.value;

  const parsed = validateDisabledEndpointCreateInput(input);
  if (!parsed.ok) return parsed;

  const {
    clientId,
    actorStaffUserId,
    locationId,
    provider,
    publicAddressRaw,
    secretRefRaw,
    providerResourceRaw,
    capabilities,
  } = parsed.value;

  let began = false;
  try {
    await client.query('BEGIN');
    began = true;

    // Active location only; FOR SHARE so concurrent deactivation serializes with us.
    const locRes = await client.query(
      `SELECT client_id, location_id, active, display_name
         FROM tenant_locations
        WHERE client_id = $1::uuid
          AND location_id = $2
          AND active = true
        FOR SHARE`,
      [clientId, locationId],
    );

    if (!locRes.rows || locRes.rows.length === 0) {
      await rollbackQuiet(client);
      // Missing, inactive, and cross-tenant are indistinguishable.
      return fail('location_not_authorized', {
        client_id: clientId,
        location_id: locationId,
      });
    }

    const row = locRes.rows[0];
    // Defense in depth: exact pair match after load.
    if (String(row.client_id) !== clientId || String(row.location_id) !== locationId) {
      await rollbackQuiet(client);
      return fail('location_not_authorized', {
        client_id: clientId,
        location_id: locationId,
      });
    }

    // Synchronous preloaded authority — never async / Promise.
    const locationAuthority = buildPreloadedLocationAuthority({
      clientId,
      locationId,
    });

    // Build 1A input with trusted client_id and forced disabled state.
    const endpointInput = {
      client_id: clientId,
      location_id: locationId,
      channel: 'email',
      provider,
      public_address: publicAddressRaw,
      secret_ref: secretRefRaw,
      capabilities,
      inbound_enabled: false,
      outbound_enabled: false,
      default_automation_mode: 'off',
      active: false,
    };
    if (providerResourceRaw !== undefined) {
      endpointInput.provider_resource_id = providerResourceRaw;
    }

    const validated = validateTenantChannelEndpointInput(endpointInput, {
      locationAuthority,
    });
    if (!validated.ok) {
      await rollbackQuiet(client);
      return validated;
    }

    const v = validated.value;
    const normalizedAddress = normalizeEmailPublicAddress(v.public_address);

    // Same-tenant public_address uniqueness for inactive rows too.
    // DB only constrains active duplicates globally; service enforces tenant-wide
    // address reservation via transaction-scoped advisory lock + existence check.
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [clientId, `email-ep-addr:${normalizedAddress}`],
    );

    const dup = await client.query(
      `SELECT id
         FROM tenant_channel_endpoints
        WHERE client_id = $1::uuid
          AND lower(public_address) = lower($2)
        LIMIT 1
        FOR UPDATE`,
      [clientId, normalizedAddress],
    );
    if (dup.rows && dup.rows.length > 0) {
      await rollbackQuiet(client);
      return fail('endpoint_already_exists');
    }

    // INSERT with forced disabled params (never trust validated active flags for enablement —
    // they are already forced false, but SQL params hardcode the disabled state).
    const ins = await client.query(
      `INSERT INTO tenant_channel_endpoints (
         client_id,
         location_id,
         channel,
         provider,
         public_address,
         secret_ref,
         provider_resource_id,
         capabilities,
         inbound_enabled,
         outbound_enabled,
         default_automation_mode,
         active,
         created_by,
         updated_by
       ) VALUES (
         $1::uuid,
         $2,
         $3,
         $4,
         $5,
         $6,
         $7,
         $8::jsonb,
         $9,
         $10,
         $11,
         $12,
         $13::uuid,
         $13::uuid
       )
       RETURNING id, client_id, location_id, channel, provider, public_address,
                 secret_ref, provider_resource_id, capabilities,
                 inbound_enabled, outbound_enabled, default_automation_mode, active,
                 created_at, updated_at, created_by, updated_by`,
      [
        clientId, // $1 trusted
        v.location_id, // $2
        'email', // $3 forced channel
        v.provider, // $4
        v.public_address, // $5 already normalized by 1A
        v.secret_ref, // $6 opaque ref only
        v.provider_resource_id, // $7
        JSON.stringify(v.capabilities), // $8
        false, // $9 inbound forced
        false, // $10 outbound forced
        'off', // $11 automation forced
        false, // $12 active forced
        actorStaffUserId, // $13 actor
      ],
    );

    await client.query('COMMIT');
    return ok(ins.rows[0]);
  } catch (err) {
    if (began) {
      await rollbackQuiet(client);
    }
    return mapDbError(err, 'endpoint');
  }
}

module.exports = {
  buildPreloadedLocationAuthority,
  listTenantLocations,
  listTenantChannelEndpoints,
  createTenantLocation,
  createDisabledTenantChannelEndpoint,
};

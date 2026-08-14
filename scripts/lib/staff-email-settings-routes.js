'use strict';

const registry = require('./email-tenant-channel-registry');

const EMAIL_SETTINGS_PATH = '/staff/admin/email-settings';
const SUNSET_CLIENT_SLUG = 'sunset';
/** Independently owned disconnect gate env (matches oauth disconnect route). */
const DISCONNECT_ENABLED_ENV = 'LUNA_EMAIL_OAUTH_DISCONNECT_ENABLED';
/** Independently owned Phase B reauth start gate env (matches B3a2a; not imported). */
const PHASE_B_REAUTH_START_ENABLED_ENV = 'LUNA_EMAIL_PHASE_B_REAUTH_START_ENABLED';

/**
 * Hard cardinality bound for set-based Phase B reauth eligibility rows.
 * Aligned with registry-scale tenant endpoint counts; max+1 SQL LIMIT fail-closed.
 */
const PHASE_B_REAUTH_ELIGIBILITY_MAX_ENDPOINTS = 100;

/**
 * Set-based atomic eligibility SELECT for Phase B reauth (one statement snapshot).
 * Returns every eligibility fact for all endpoints of a client UUID from the same
 * statement: endpoint provider/auth/connector/binding/active/address/location,
 * tenant_locations ownership + location_active, and grant present/status/reconcile/
 * scope_version/generation + lease-null facts.
 * Never projected into public DTO (scope/lease/generation stay server-local).
 * Params: [client_id] only. No browser authority.
 * LIMIT max+1 so callers can fail closed when cardinality is exceeded.
 */
const SQL_PHASE_B_REAUTH_ELIGIBILITY_FACTS = `
SELECT e.id::text AS endpoint_id,
       e.location_id::text AS location_id,
       e.provider::text AS provider,
       e.auth_mode::text AS auth_mode,
       e.connector_mode::text AS connector_mode,
       e.binding_status::text AS binding_status,
       e.public_address AS public_address,
       e.active AS endpoint_active,
       l.active AS location_active,
       (g.endpoint_id IS NOT NULL) AS grant_present,
       g.grant_status::text AS grant_status,
       g.reconcile_state::text AS reconcile_state,
       g.scope_version::text AS scope_version,
       g.grant_generation AS grant_generation,
       (g.grant_status = 'lease_held' AND g.grant_lease_token IS NOT NULL) AS has_active_lease,
       (g.grant_lease_token IS NULL) AS lease_token_null,
       (g.grant_lease_owner IS NULL) AS lease_owner_null,
       (g.grant_lease_until IS NULL) AS lease_until_null
  FROM tenant_channel_endpoints e
  LEFT JOIN tenant_locations l
    ON l.client_id = e.client_id
   AND l.location_id = e.location_id
  LEFT JOIN tenant_email_delegated_grants g
    ON g.client_id = e.client_id
   AND g.endpoint_id = e.id
 WHERE e.client_id = $1::uuid
 ORDER BY e.id ASC
 LIMIT ${PHASE_B_REAUTH_ELIGIBILITY_MAX_ENDPOINTS + 1}`.replace(/\s+/g, ' ').trim();

/** Exact own-data keys expected on an atomic eligibility row (order fixed for authority checks). */
const ATOMIC_ELIGIBILITY_OWN_KEYS = Object.freeze([
  'endpoint_id',
  'location_id',
  'provider',
  'auth_mode',
  'connector_mode',
  'binding_status',
  'public_address',
  'endpoint_active',
  'location_active',
  'grant_present',
  'grant_status',
  'reconcile_state',
  'scope_version',
  'grant_generation',
  'has_active_lease',
  'lease_token_null',
  'lease_owner_null',
  'lease_until_null',
]);

function isSunsetEmailSettingsUiEnabled(env) {
  const src = env && typeof env === 'object' ? env : process.env;
  return src.SUNSET_EMAIL_SETTINGS_UI_ENABLED === 'true';
}

function isSunsetEmailOAuthStartEnabled(env) {
  const src = env && typeof env === 'object' ? env : process.env;
  return src.LUNA_EMAIL_OAUTH_START_ENABLED === 'true' && src.LUNA_DEPLOYMENT === 'sunset-staging';
}

function isSunsetEmailGoogleOAuthStartEnabled(env) {
  const src = env && typeof env === 'object' ? env : process.env;
  return src.SUNSET_EMAIL_SETTINGS_UI_ENABLED === 'true'
    && src.LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED === 'true'
    && src.LUNA_DEPLOYMENT === 'sunset-staging';
}

/**
 * Exact dual gate for Settings reauthorize action projection:
 * settings UI on + Phase B reauth start on (sunset-staging + exact true).
 * Default-off; never broad truthy.
 */
function isPhaseBReauthSettingsActionEnabled(env) {
  try {
    if (!env || typeof env !== 'object') return false;
    if (env.SUNSET_EMAIL_SETTINGS_UI_ENABLED !== 'true') return false;
    if (env.LUNA_DEPLOYMENT !== 'sunset-staging') return false;
    if (env[PHASE_B_REAUTH_START_ENABLED_ENV] !== 'true') return false;
    return true;
  } catch (_) {
    return false;
  }
}

function isDisconnectSettingsActionEnabled(env) {
  try {
    if (!env || typeof env !== 'object') return false;
    if (env.SUNSET_EMAIL_SETTINGS_UI_ENABLED !== 'true') return false;
    if (env.LUNA_DEPLOYMENT !== 'sunset-staging') return false;
    if (env[DISCONNECT_ENABLED_ENV] !== 'true') return false;
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Eligible for OAuth start (existing prepare product): Microsoft delegated modes
 * + pre-verified binding + non-empty public_address. Matches start resolve SQL.
 */
function isEligibleMicrosoftEndpoint(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.provider !== 'microsoft_graph') return false;
  if (row.auth_mode !== 'delegated_authorization_code') return false;
  if (row.connector_mode !== 'microsoft_delegated_oauth') return false;
  if (row.binding_status !== 'unverified_offline'
      && row.binding_status !== 'pending_manual_validation') {
    return false;
  }
  const addr = row.public_address;
  return typeof addr === 'string' && addr.trim() !== '';
}

function isEligibleGmailEndpoint(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.provider !== 'gmail_api') return false;
  if (row.auth_mode !== 'delegated_authorization_code') return false;
  if (row.connector_mode !== 'google_delegated_oauth') return false;
  if (row.binding_status !== 'unverified_offline'
      && row.binding_status !== 'pending_manual_validation') return false;
  return typeof row.public_address === 'string' && row.public_address.trim() !== '';
}

function isEligibleUnverifiedDelegatedEndpoint(row) {
  return isEligibleMicrosoftEndpoint(row) || isEligibleGmailEndpoint(row);
}

function isEligibleDisconnectEndpoint(row, grantFact) {
  try {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
    if (!grantFact || typeof grantFact !== 'object' || Array.isArray(grantFact)) return false;
    // Registry activation is independent of grant revocability. A verified active
    // grant must remain disconnectable even while routing is intentionally inactive.
    if (row.location_active !== true) return false;
    if (row.provider !== 'microsoft_graph') return false;
    if (row.auth_mode !== 'delegated_authorization_code') return false;
    if (row.connector_mode !== 'microsoft_delegated_oauth') return false;
    if (row.binding_status !== 'verified' && row.binding_status !== 'reauthorization_required') return false;
    if (typeof row.public_address !== 'string' || row.public_address.trim() === '') return false;
    if (grantFact.grant_present !== true) return false;
    if (grantFact.grant_status === 'revoked') return false;
    if (grantFact.grant_status !== 'active' && grantFact.grant_status !== 'reauthorization_required') return false;
    if (grantFact.reconcile_state !== 'clean') return false;
    if (grantFact.has_active_lease === true) return false;
    if (grantFact.lease_clear !== true) return false;
    if (isEligibleUnverifiedDelegatedEndpoint(row) === true) return false;
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Phase B reauthorize eligibility — retired (single-consent connect).
 * Kept for call-site stability; always false on live path.
 */
function isEligiblePhaseBReauthorizeEndpoint(_row, _grantFact) {
  return false;
}

/**
 * Snapshot grant fact for eligibility from a pure fact object (tests / pure path).
 * Never returns secrets; scope/lease used only for boolean eligibility.
 * Malformed/extra/proxy shapes fail closed (lease_clear false, scope null).
 * Production eligibility uses grantFactFromAtomicEligibilityRow (single SQL row).
 */
function snapshotPhaseBReauthGrantFact(publicGrant, internalRow) {
  try {
    if (!publicGrant || typeof publicGrant !== 'object' || Array.isArray(publicGrant)) {
      return Object.freeze({
        grant_present: false,
        grant_status: null,
        reconcile_state: null,
        has_active_lease: false,
        grant_generation: null,
        scope_version: null,
        lease_clear: false,
      });
    }
    const present = publicGrant.grant_present === true;
    let gen = null;
    if (typeof publicGrant.grant_generation === 'number'
        && Number.isInteger(publicGrant.grant_generation)
        && publicGrant.grant_generation >= 1) {
      gen = publicGrant.grant_generation;
    }
    let scope_version = null;
    let lease_clear = false;
    if (present && internalRow && typeof internalRow === 'object' && !Array.isArray(internalRow)) {
      if (typeof internalRow.scope_version === 'string') {
        scope_version = internalRow.scope_version;
      }
      if (internalRow.lease_token_null === true
          && internalRow.lease_owner_null === true
          && internalRow.lease_until_null === true) {
        lease_clear = true;
      }
      if (gen == null && internalRow.grant_generation != null) {
        const n = Number(internalRow.grant_generation);
        if (Number.isInteger(n) && n >= 1) gen = n;
      }
    }
    return Object.freeze({
      grant_present: present,
      grant_status: present ? (publicGrant.grant_status || null) : null,
      reconcile_state: present ? (publicGrant.reconcile_state || null) : null,
      has_active_lease: publicGrant.has_active_lease === true,
      grant_generation: gen,
      scope_version,
      lease_clear,
    });
  } catch (_) {
    return Object.freeze({
      grant_present: false,
      grant_status: null,
      reconcile_state: null,
      has_active_lease: false,
      grant_generation: null,
      scope_version: null,
      lease_clear: false,
    });
  }
}

/**
 * Build eligibility grant fact solely from one atomic SQL row.
 * Fail-closed: never mixes prior public status or a second snapshot.
 */
function grantFactFromAtomicEligibilityRow(atomicRow) {
  try {
    if (!atomicRow || typeof atomicRow !== 'object' || Array.isArray(atomicRow)) {
      return Object.freeze({
        grant_present: false,
        grant_status: null,
        reconcile_state: null,
        has_active_lease: false,
        grant_generation: null,
        scope_version: null,
        lease_clear: false,
      });
    }
    const present = atomicRow.grant_present === true;
    let gen = null;
    if (atomicRow.grant_generation != null) {
      const n = Number(atomicRow.grant_generation);
      if (Number.isInteger(n) && n >= 1) gen = n;
    }
    const lease_clear = present
      && atomicRow.lease_token_null === true
      && atomicRow.lease_owner_null === true
      && atomicRow.lease_until_null === true;
    return Object.freeze({
      grant_present: present,
      grant_status: present && typeof atomicRow.grant_status === 'string' ? atomicRow.grant_status : null,
      reconcile_state: present && typeof atomicRow.reconcile_state === 'string' ? atomicRow.reconcile_state : null,
      has_active_lease: atomicRow.has_active_lease === true,
      grant_generation: gen,
      scope_version: present && typeof atomicRow.scope_version === 'string' ? atomicRow.scope_version : null,
      lease_clear: lease_clear === true,
    });
  } catch (_) {
    return Object.freeze({
      grant_present: false,
      grant_status: null,
      reconcile_state: null,
      has_active_lease: false,
      grant_generation: null,
      scope_version: null,
      lease_clear: false,
    });
  }
}

/**
 * Public connection-state grant view from the same atomic row (display only).
 * Eligibility must never use this alone without grantFactFromAtomicEligibilityRow.
 */
function publicGrantFromAtomicEligibilityRow(atomicRow) {
  try {
    if (!atomicRow || typeof atomicRow !== 'object' || Array.isArray(atomicRow)) {
      return Object.freeze({
        grant_present: false,
        grant_generation: null,
        grant_status: null,
        reconcile_state: null,
        has_active_lease: false,
      });
    }
    if (atomicRow.grant_present !== true) {
      return Object.freeze({
        grant_present: false,
        grant_generation: null,
        grant_status: null,
        reconcile_state: null,
        has_active_lease: false,
      });
    }
    let gen = null;
    if (atomicRow.grant_generation != null) {
      const n = Number(atomicRow.grant_generation);
      if (Number.isInteger(n) && n >= 1) gen = n;
    }
    return Object.freeze({
      grant_present: true,
      grant_generation: gen,
      grant_status: typeof atomicRow.grant_status === 'string' ? atomicRow.grant_status : null,
      reconcile_state: typeof atomicRow.reconcile_state === 'string' ? atomicRow.reconcile_state : null,
      has_active_lease: atomicRow.has_active_lease === true,
    });
  } catch (_) {
    return Object.freeze({
      grant_present: false,
      grant_generation: null,
      grant_status: null,
      reconcile_state: null,
      has_active_lease: false,
    });
  }
}

/**
 * Endpoint-shaped eligibility input taken only from the atomic row (same snapshot).
 * Includes location_active from the joined tenant_locations ownership fact.
 */
function endpointRowFromAtomicEligibility(atomicRow) {
  try {
    if (!atomicRow || typeof atomicRow !== 'object' || Array.isArray(atomicRow)) return null;
    return Object.freeze({
      id: typeof atomicRow.endpoint_id === 'string' ? atomicRow.endpoint_id : null,
      location_id: typeof atomicRow.location_id === 'string' ? atomicRow.location_id : null,
      provider: typeof atomicRow.provider === 'string' ? atomicRow.provider : null,
      auth_mode: typeof atomicRow.auth_mode === 'string' ? atomicRow.auth_mode : null,
      connector_mode: typeof atomicRow.connector_mode === 'string' ? atomicRow.connector_mode : null,
      binding_status: typeof atomicRow.binding_status === 'string' ? atomicRow.binding_status : null,
      public_address: typeof atomicRow.public_address === 'string' ? atomicRow.public_address : null,
      active: atomicRow.endpoint_active === true,
      location_active: atomicRow.location_active === true,
    });
  } catch (_) {
    return null;
  }
}

/**
 * Validate one SQL result row as an exact immutable own-data snapshot.
 * Exact own string key set only — no missing OR extra keys.
 * Rejects proxies, symbols, accessors, non-enumerable props, non-plain prototypes.
 * Extra secret_ref (or any unknown key) fails closed before projection.
 * Returns frozen plain own-data object or null (fail-closed).
 */
function normalizeAtomicEligibilityRow(raw) {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    // Proxy brand check (native when available).
    try {
      const util = require('util');
      if (util && util.types && typeof util.types.isProxy === 'function' && util.types.isProxy(raw)) {
        return null;
      }
    } catch (_) { /* ignore util pin miss */ }
    const proto = Object.getPrototypeOf(raw);
    if (proto !== Object.prototype && proto !== null) return null;
    const keys = Reflect.ownKeys(raw);
    const stringKeys = [];
    for (let i = 0; i < keys.length; i += 1) {
      if (typeof keys[i] === 'symbol') return null;
      if (typeof keys[i] !== 'string') return null;
      stringKeys.push(keys[i]);
    }
    // Exact own string key set: no missing and no extras (e.g. secret_ref).
    if (stringKeys.length !== ATOMIC_ELIGIBILITY_OWN_KEYS.length) return null;
    const expected = new Set(ATOMIC_ELIGIBILITY_OWN_KEYS);
    for (let i = 0; i < stringKeys.length; i += 1) {
      if (!expected.has(stringKeys[i])) return null;
    }
    const out = Object.create(null);
    for (let i = 0; i < ATOMIC_ELIGIBILITY_OWN_KEYS.length; i += 1) {
      const key = ATOMIC_ELIGIBILITY_OWN_KEYS[i];
      const desc = Object.getOwnPropertyDescriptor(raw, key);
      if (!desc
          || !Object.prototype.hasOwnProperty.call(desc, 'value')
          || desc.get
          || desc.set
          || desc.enumerable !== true) {
        return null;
      }
      out[key] = desc.value;
    }
    if (typeof out.endpoint_id !== 'string' || !out.endpoint_id) return null;
    // Canonical location_id required non-null for ownership join fact.
    if (typeof out.location_id !== 'string' || !out.location_id) return null;
    return Object.freeze(out);
  } catch (_) {
    return null;
  }
}

/**
 * Exact-map atomic rows by endpoint_id for the listed endpoint set.
 * Fail-closed on cardinality exceed, duplicate, missing, extra, mutable/proxy/accessor/symbol rows.
 * Requires exact one normalized row per listed endpoint (no duplicates/missing/extras).
 * @returns {{ ok: true, map: ReadonlyMap<string, object> } | { ok: false }}
 */
function indexAtomicEligibilityRows(atomicRows, expectedEndpointIds) {
  try {
    if (!Array.isArray(atomicRows) || !Array.isArray(expectedEndpointIds)) {
      return { ok: false };
    }
    if (atomicRows.length > PHASE_B_REAUTH_ELIGIBILITY_MAX_ENDPOINTS) {
      return { ok: false };
    }
    if (expectedEndpointIds.length > PHASE_B_REAUTH_ELIGIBILITY_MAX_ENDPOINTS) {
      return { ok: false };
    }
    const expected = new Set();
    for (let i = 0; i < expectedEndpointIds.length; i += 1) {
      const id = expectedEndpointIds[i];
      if (typeof id !== 'string' || !id) return { ok: false };
      if (expected.has(id)) return { ok: false }; // duplicate expected ids
      expected.add(id);
    }
    // Exact cardinality: one atomic row per listed endpoint.
    if (atomicRows.length !== expectedEndpointIds.length) {
      return { ok: false };
    }
    const map = new Map();
    for (let i = 0; i < atomicRows.length; i += 1) {
      const norm = normalizeAtomicEligibilityRow(atomicRows[i]);
      if (!norm) return { ok: false };
      if (map.has(norm.endpoint_id)) return { ok: false }; // duplicate atomic
      if (!expected.has(norm.endpoint_id)) return { ok: false }; // extra
      map.set(norm.endpoint_id, norm);
    }
    for (const id of expected) {
      if (!map.has(id)) return { ok: false }; // missing
    }
    return { ok: true, map };
  } catch (_) {
    return { ok: false };
  }
}

/**
 * Load set-based atomic eligibility facts for one client UUID.
 * One SQL statement; never composes two snapshots.
 * Fail-closed when result length exceeds PHASE_B_REAUTH_ELIGIBILITY_MAX_ENDPOINTS
 * (SQL LIMIT max+1 makes over-bound visible before normalization).
 */
async function loadPhaseBReauthEligibilityFacts(pg, clientId) {
  try {
    if (!pg || typeof pg.query !== 'function') return null;
    if (typeof clientId !== 'string' || !clientId) return null;
    const found = await pg.query(SQL_PHASE_B_REAUTH_ELIGIBILITY_FACTS, [clientId]);
    if (!found || !Array.isArray(found.rows)) return null;
    if (found.rows.length > PHASE_B_REAUTH_ELIGIBILITY_MAX_ENDPOINTS) return null;
    return found.rows;
  } catch (_) {
    return null;
  }
}

function publicState(endpoint, grant) {
  if (!endpoint) return 'disconnected';
  if (!grant || grant.grant_present !== true) return 'registered_not_connected';
  if (grant.grant_status === 'revoked') return 'revoked';
  if (grant.grant_status === 'reauthorization_required' || endpoint.binding_status === 'reauthorization_required') return 'reauth_required';
  if (grant.grant_status === 'active' || grant.grant_status === 'lease_held') return 'connected_health';
  return 'error';
}

/**
 * Public endpoint DTO. reauthorize_eligible is a boolean fact only — never
 * generation, scope strings, lease internals, tokens, or provider payloads.
 * When options.atomicRow is provided, eligibility is built solely from that row.
 */
function endpointDto(row, grant, options) {
  const reauthGateOn = options && options.reauthGateOn === true;
  const disconnectGateOn = options && options.disconnectGateOn === true;
  const atomicRow = options && options.atomicRow ? options.atomicRow : null;
  const startEligible = isEligibleUnverifiedDelegatedEndpoint(row) === true;
  let reauthorizeEligible = false;
  let disconnectEligible = false;
  let publicGrant = grant;
  if (atomicRow) {
    // Eligibility depends solely on the atomic immutable own-data snapshot.
    const atomicEndpoint = endpointRowFromAtomicEligibility(atomicRow);
    const grantFact = grantFactFromAtomicEligibilityRow(atomicRow);
    publicGrant = publicGrantFromAtomicEligibilityRow(atomicRow);
    if (reauthGateOn && startEligible !== true && atomicEndpoint) {
      reauthorizeEligible = isEligiblePhaseBReauthorizeEndpoint(atomicEndpoint, grantFact) === true;
    }
    if (disconnectGateOn && startEligible !== true && atomicEndpoint) {
      disconnectEligible = isEligibleDisconnectEndpoint(atomicEndpoint, grantFact) === true;
    }
  } else {
    // Pure/unit path without atomic SQL (tests of DTO projection only).
    const grantFact = options && options.grantFact
      ? options.grantFact
      : snapshotPhaseBReauthGrantFact(grant, null);
    if (reauthGateOn && startEligible !== true) {
      reauthorizeEligible = isEligiblePhaseBReauthorizeEndpoint(row, grantFact) === true;
    }
    if (disconnectGateOn && startEligible !== true) {
      disconnectEligible = isEligibleDisconnectEndpoint(row, grantFact) === true;
    }
  }
  return Object.freeze({
    endpoint_id: row.id,
    location_id: row.location_id,
    provider: row.provider,
    public_address: row.public_address,
    connection_state: publicState(row, publicGrant),
    grant_status: publicGrant && publicGrant.grant_present ? publicGrant.grant_status : null,
    reconcile_state: publicGrant && publicGrant.grant_present ? publicGrant.reconcile_state : null,
    endpoint_active: false,
    inbound_enabled: false,
    outbound_enabled: false,
    automation_enabled: false,
    start_eligible: startEligible,
    reauthorize_eligible: reauthorizeEligible === true,
    disconnect_eligible: disconnectEligible === true,
  });
}

/**
 * Compute prepare vs connect vs reauthorize actions.
 * - prepare: start gate on + active location with no endpoint
 * - connect: start gate on + existing eligible unverified delegated endpoint
 * - reauthorize: Phase B settings dual gate on + eligible verified Phase A grant
 * Never both prepare/connect and reauthorize for the same endpoint (binding
 * status disjoint). Never auto-creates endpoints.
 */
function providerActions(startOn, reauthOn, disconnectOn, provider, locations, endpoints) {
  const providerEndpoints = endpoints.filter((endpoint) => endpoint.provider === provider);
  const hasEligible = startOn && providerEndpoints.some((endpoint) => endpoint.start_eligible === true);
  const hasActiveLocationWithoutEndpoint = locations.some((location) => location.active === true
    && !providerEndpoints.some((endpoint) => endpoint.location_id === location.location_id));
  const hasReauth = provider === 'microsoft_graph' && reauthOn
    && providerEndpoints.some((endpoint) => endpoint.reauthorize_eligible === true);
  const hasDisconnect = provider === 'microsoft_graph' && disconnectOn
    && providerEndpoints.some((endpoint) => endpoint.disconnect_eligible === true);
  return Object.freeze({ prepare: startOn && hasActiveLocationWithoutEndpoint && !hasEligible,
    connect: hasEligible, disconnect: hasDisconnect, reauthorize: hasReauth });
}

function computeProviderEmailSettingsActions(runtimeEnv, locations, endpoints) {
  const eps = Array.isArray(endpoints) ? endpoints : [];
  const locs = Array.isArray(locations) ? locations : [];
  return Object.freeze({
    microsoft_graph: providerActions(isSunsetEmailOAuthStartEnabled(runtimeEnv),
      isPhaseBReauthSettingsActionEnabled(runtimeEnv),
      isDisconnectSettingsActionEnabled(runtimeEnv), 'microsoft_graph', locs, eps),
    gmail_api: providerActions(isSunsetEmailGoogleOAuthStartEnabled(runtimeEnv), false, false,
      'gmail_api', locs, eps),
  });
}

function computeEmailSettingsActions(runtimeEnv, locations, endpoints) {
  return computeProviderEmailSettingsActions(runtimeEnv, locations, endpoints).microsoft_graph;
}

function createEmailSettingsRoutes(deps) {
  const listLocations = deps.listTenantLocations || registry.listTenantLocations;
  const listEndpoints = deps.listTenantChannelEndpoints || registry.listTenantChannelEndpoints;
  const loadAtomicFacts = deps.loadPhaseBReauthEligibilityFacts || loadPhaseBReauthEligibilityFacts;
  const runtimeEnv = deps.runtimeEnv || process.env;

  async function handleGet(query, req, res, user) {
    if (!isSunsetEmailSettingsUiEnabled(runtimeEnv)) return deps.sendJSON(res, 404, { success: false, error: 'not_found' });
    const slug = String((query && (query.client || query.client_slug)) || '').trim();
    if (slug !== SUNSET_CLIENT_SLUG) return deps.sendJSON(res, 404, { success: false, error: 'not_found' });
    if (!deps.assertStaffClientAccess(user, slug, res)) return;
    const authz = deps.authorizeAuthenticatedStaffRoute({ clientSlug: slug, method: 'GET', pathname: EMAIL_SETTINGS_PATH, env: runtimeEnv });
    if (!authz.ok) return deps.sendJSON(res, authz.status || 403, authz.body || { success: false, error: 'forbidden' });
    try {
      return await deps.withPgClient(async (pg) => {
        const found = await pg.query('SELECT id::text AS client_id FROM clients WHERE slug=$1 LIMIT 1', [slug]);
        const clientId = found.rows && found.rows[0] && String(found.rows[0].client_id || '');
        if (!clientId) return deps.sendJSON(res, 404, { success: false, error: 'not_found' });
        const [locationsResult, endpointsResult] = await Promise.all([
          listLocations({ clientId, includeInactive: true }, { db: pg }),
          listEndpoints({ clientId, includeInactive: true }, { db: pg }),
        ]);
        if (!locationsResult.ok || !endpointsResult.ok) throw new Error('aggregate_failed');
        const reauthGateOn = isPhaseBReauthSettingsActionEnabled(runtimeEnv);
        const disconnectGateOn = isDisconnectSettingsActionEnabled(runtimeEnv);
        const endpointRows = Array.isArray(endpointsResult.value) ? endpointsResult.value : [];
        if (endpointRows.length > PHASE_B_REAUTH_ELIGIBILITY_MAX_ENDPOINTS) {
          throw new Error('aggregate_failed');
        }
        const expectedIds = endpointRows.map((row) => String(row.id));

        // ONE set-based atomic statement for all endpoints (no per-endpoint two-read merge).
        let atomicIndex = null;
        if (endpointRows.length > 0) {
          const atomicRows = await loadAtomicFacts(pg, clientId);
          if (!Array.isArray(atomicRows)) throw new Error('aggregate_failed');
          if (atomicRows.length > PHASE_B_REAUTH_ELIGIBILITY_MAX_ENDPOINTS) {
            throw new Error('aggregate_failed');
          }
          const indexed = indexAtomicEligibilityRows(atomicRows, expectedIds);
          if (!indexed.ok) throw new Error('aggregate_failed');
          atomicIndex = indexed.map;
        }

        const endpoints = [];
        for (const row of endpointRows) {
          const atomicRow = atomicIndex ? atomicIndex.get(String(row.id)) : null;
          if (endpointRows.length > 0 && !atomicRow) throw new Error('aggregate_failed');
          // Public display + reauthorize_eligible both derive from the same atomic row.
          // Eligibility is computed inside endpointDto solely from atomicRow when present.
          const publicGrant = atomicRow
            ? publicGrantFromAtomicEligibilityRow(atomicRow)
            : Object.freeze({
              grant_present: false,
              grant_generation: null,
              grant_status: null,
              reconcile_state: null,
              has_active_lease: false,
            });
          endpoints.push(endpointDto(row, publicGrant, { atomicRow, reauthGateOn, disconnectGateOn }));
        }
        const locations = locationsResult.value.map((row) => Object.freeze({
          location_id: row.location_id, display_name: row.display_name, active: row.active === true,
        }));
        const providerActionsDto = computeProviderEmailSettingsActions(runtimeEnv, locations, endpoints);
        const actions = providerActionsDto.microsoft_graph;
        return deps.sendJSON(res, 200, {
          success: true,
          client: SUNSET_CLIENT_SLUG,
          read_only: true,
          actions,
          provider_actions: providerActionsDto,
          locations,
          endpoints,
        });
      });
    } catch (_) {
      return deps.sendJSON(res, 500, { success: false, error: 'email_settings_unavailable' });
    }
  }
  return { handleGet };
}

module.exports = {
  EMAIL_SETTINGS_PATH,
  SUNSET_CLIENT_SLUG,
  DISCONNECT_ENABLED_ENV,
  PHASE_B_REAUTH_START_ENABLED_ENV,
  PHASE_B_REAUTH_ELIGIBILITY_MAX_ENDPOINTS,
  SQL_PHASE_B_REAUTH_ELIGIBILITY_FACTS,
  ATOMIC_ELIGIBILITY_OWN_KEYS,
  isSunsetEmailSettingsUiEnabled,
  isSunsetEmailOAuthStartEnabled,
  isSunsetEmailGoogleOAuthStartEnabled,
  isPhaseBReauthSettingsActionEnabled,
  isDisconnectSettingsActionEnabled,
  isEligibleDisconnectEndpoint,
  isEligibleUnverifiedDelegatedEndpoint,
  isEligibleMicrosoftEndpoint,
  isEligibleGmailEndpoint,
  isEligiblePhaseBReauthorizeEndpoint,
  snapshotPhaseBReauthGrantFact,
  grantFactFromAtomicEligibilityRow,
  publicGrantFromAtomicEligibilityRow,
  endpointRowFromAtomicEligibility,
  normalizeAtomicEligibilityRow,
  indexAtomicEligibilityRows,
  loadPhaseBReauthEligibilityFacts,
  computeEmailSettingsActions,
  computeProviderEmailSettingsActions,
  publicState,
  endpointDto,
  createEmailSettingsRoutes,
};

'use strict';

const registry = require('./email-tenant-channel-registry');
const grants = require('./email-delegated-grant-custodian');

const EMAIL_SETTINGS_PATH = '/staff/admin/email-settings';
const SUNSET_CLIENT_SLUG = 'sunset';

function isSunsetEmailSettingsUiEnabled(env) {
  const src = env && typeof env === 'object' ? env : process.env;
  return src.SUNSET_EMAIL_SETTINGS_UI_ENABLED === 'true';
}

function isSunsetEmailOAuthStartEnabled(env) {
  const src = env && typeof env === 'object' ? env : process.env;
  return src.LUNA_EMAIL_OAUTH_START_ENABLED === 'true' && src.LUNA_DEPLOYMENT === 'sunset-staging';
}

/**
 * Eligible for OAuth start (existing prepare product): Microsoft delegated modes
 * + pre-verified binding + non-empty public_address. Matches start resolve SQL.
 */
function isEligibleUnverifiedDelegatedEndpoint(row) {
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

function publicState(endpoint, grant) {
  if (!endpoint) return 'disconnected';
  if (!grant || grant.grant_present !== true) return 'registered_not_connected';
  if (grant.grant_status === 'revoked') return 'revoked';
  if (grant.grant_status === 'reauthorization_required' || endpoint.binding_status === 'reauthorization_required') return 'reauth_required';
  if (grant.grant_status === 'active' || grant.grant_status === 'lease_held') return 'connected_health';
  return 'error';
}

function endpointDto(row, grant) {
  return Object.freeze({
    endpoint_id: row.id,
    location_id: row.location_id,
    provider: row.provider,
    public_address: row.public_address,
    connection_state: publicState(row, grant),
    grant_status: grant && grant.grant_present ? grant.grant_status : null,
    reconcile_state: grant && grant.grant_present ? grant.reconcile_state : null,
    endpoint_active: false,
    inbound_enabled: false,
    outbound_enabled: false,
    automation_enabled: false,
    start_eligible: isEligibleUnverifiedDelegatedEndpoint(row) === true,
  });
}

/**
 * Compute prepare vs connect actions (never both true for the same location).
 * - prepare: start gate on + active location with no endpoint
 * - connect: start gate on + existing eligible unverified delegated endpoint
 * Never auto-creates endpoints.
 */
function computeEmailSettingsActions(runtimeEnv, locations, endpoints) {
  const startOn = isSunsetEmailOAuthStartEnabled(runtimeEnv);
  if (!startOn) {
    return Object.freeze({ prepare: false, connect: false, disconnect: false });
  }
  const eps = Array.isArray(endpoints) ? endpoints : [];
  const locs = Array.isArray(locations) ? locations : [];
  const hasEligible = eps.some((endpoint) => endpoint.start_eligible === true);
  const hasActiveLocationWithoutEndpoint = locs.some((location) =>
    location.active === true
    && !eps.some((endpoint) => endpoint.location_id === location.location_id));
  return Object.freeze({
    prepare: hasActiveLocationWithoutEndpoint && !hasEligible,
    connect: hasEligible,
    disconnect: false,
  });
}

function createEmailSettingsRoutes(deps) {
  const listLocations = deps.listTenantLocations || registry.listTenantLocations;
  const listEndpoints = deps.listTenantChannelEndpoints || registry.listTenantChannelEndpoints;
  const getGrantStatus = deps.getDelegatedGrantPublicStatus || grants.getDelegatedGrantPublicStatus;
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
        const endpoints = [];
        for (const row of endpointsResult.value) {
          const grantResult = await getGrantStatus({ clientId, endpointId: row.id }, { db: pg });
          if (!grantResult.ok) throw new Error('aggregate_failed');
          endpoints.push(endpointDto(row, grantResult.value));
        }
        const locations = locationsResult.value.map((row) => Object.freeze({
          location_id: row.location_id, display_name: row.display_name, active: row.active === true,
        }));
        const actions = computeEmailSettingsActions(runtimeEnv, locations, endpoints);
        return deps.sendJSON(res, 200, {
          success: true,
          client: SUNSET_CLIENT_SLUG,
          read_only: true,
          actions,
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
  isSunsetEmailSettingsUiEnabled,
  isSunsetEmailOAuthStartEnabled,
  isEligibleUnverifiedDelegatedEndpoint,
  computeEmailSettingsActions,
  publicState,
  endpointDto,
  createEmailSettingsRoutes,
};

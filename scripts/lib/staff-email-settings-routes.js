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
        const connect = isSunsetEmailOAuthStartEnabled(runtimeEnv) && locations.some((location) =>
          location.active && !endpoints.some((endpoint) => endpoint.location_id === location.location_id));
        return deps.sendJSON(res, 200, {
          success: true,
          client: SUNSET_CLIENT_SLUG,
          read_only: true,
          actions: { connect, disconnect: false },
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

module.exports = { EMAIL_SETTINGS_PATH, SUNSET_CLIENT_SLUG, isSunsetEmailSettingsUiEnabled, isSunsetEmailOAuthStartEnabled, publicState, endpointDto, createEmailSettingsRoutes };

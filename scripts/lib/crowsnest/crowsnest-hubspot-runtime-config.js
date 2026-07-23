'use strict';

/**
 * Narrow server-only HubSpot Service Key boundary for approved CRM sync.
 *
 * Reads HUBSPOT_SERVICE_KEY only when invoked at request execution time.
 * Never logs, stringifies for HTML, or exports credentials into page/store/audit.
 * Callers must inject the returned accessToken into the adapter — the adapter
 * itself must not read process.env.
 */

function resolveHubSpotServiceKeyAccess(env = process.env) {
  const accessToken = env && env.HUBSPOT_SERVICE_KEY != null
    ? String(env.HUBSPOT_SERVICE_KEY).trim()
    : '';

  if (!accessToken) {
    return {
      ok: false,
      configured: false,
      status: 503,
      code: 'hubspot_not_configured',
      error: 'HubSpot sync is unavailable.',
    };
  }

  return {
    ok: true,
    configured: true,
    accessToken,
  };
}

module.exports = {
  resolveHubSpotServiceKeyAccess,
};

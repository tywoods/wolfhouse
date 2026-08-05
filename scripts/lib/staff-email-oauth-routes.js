'use strict';
const {
  createMicrosoftOAuthTransactionService,
  createPostgresOAuthTransactionRepository,
  isStartEnabled,
} = require('./email-microsoft-oauth-transaction-service');

const OAUTH_START_PATH = '/staff/admin/email-settings/oauth/microsoft/start';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.getPrototypeOf(body) !== Object.prototype) return false;
  const keys = Object.keys(body);
  return keys.length === 1 && keys[0] === 'location_id' && typeof body.location_id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.location_id);
}
function createStaffEmailOAuthRoutes(deps) {
  const env = deps.runtimeEnv || process.env;
  async function handleStart(body, req, res, user) {
    if (!isStartEnabled(env)) return deps.sendJSON(res, 404, { success:false, error:'not_found' });
    if (!user || user.client_slug !== 'sunset' || !UUID_RE.test(user.staff_user_id || '') || !UUID_RE.test(user.session_id || '')) {
      return deps.sendJSON(res, 403, { success:false, error:'forbidden' });
    }
    if (!deps.assertStaffClientAccess(user, 'sunset', res)) return;
    const authz = deps.authorizeAuthenticatedStaffRoute({ clientSlug:'sunset', method:'POST', pathname:OAUTH_START_PATH, env });
    if (!authz.ok) return deps.sendJSON(res, authz.status || 403, authz.body || { success:false, error:'forbidden' });
    if (!validBody(body)) return deps.sendJSON(res, 400, { success:false, error:'invalid_request' });
    try {
      return await deps.withPgClient(async (pg) => {
        const found = await pg.query(
          `SELECT c.id::text AS client_id, l.id::text AS location_id
             FROM clients c JOIN tenant_locations l ON l.client_id=c.id
            WHERE c.slug='sunset' AND l.location_id=$1 AND l.active=true LIMIT 1`, [body.location_id]);
        const row = found.rows && found.rows[0];
        if (!row) return deps.sendJSON(res, 404, { success:false, error:'location_not_found' });
        const service = createMicrosoftOAuthTransactionService({ repository:createPostgresOAuthTransactionRepository(pg), env });
        const dto = await service.start({ clientId:row.client_id, locationId:row.location_id, staffUserId:user.staff_user_id, authSessionId:user.session_id });
        return deps.sendJSON(res, 200, dto);
      });
    } catch (_) {
      return deps.sendJSON(res, 503, { success:false, error:'oauth_start_unavailable' });
    }
  }
  return Object.freeze({ handleStart });
}
module.exports = { OAUTH_START_PATH, validBody, createStaffEmailOAuthRoutes };

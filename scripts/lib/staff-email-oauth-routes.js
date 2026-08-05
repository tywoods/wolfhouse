'use strict';
const {
  createMicrosoftOAuthTransactionService,
  createPostgresOAuthTransactionRepository,
  isStartEnabled,
  isCallbackEnabled,
  createMicrosoftOAuthCallbackService,
} = require('./email-microsoft-oauth-transaction-service');

const OAUTH_START_PATH = '/staff/admin/email-settings/oauth/microsoft/start';
const OAUTH_CALLBACK_PATH = '/staff/email/oauth/microsoft/callback';
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
  function terminal(res, statusCode, status) {
    const messages = { authorization_received:'Authorization response received. You may close this window.', authorization_declined:'Authorization was declined. You may close this window.', invalid_or_expired:'This authorization request could not be accepted.' };
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Authorization status</title></head><body><main><h1>Authorization status</h1><p>${messages[status] || messages.invalid_or_expired}</p></main></body></html>`);
  }
  async function handleCallback(query, req, res, user) {
    if (!isCallbackEnabled(env)) return terminal(res, 404, 'invalid_or_expired');
    if (!user || user.client_slug !== 'sunset' || !UUID_RE.test(user.client_id || '') || !UUID_RE.test(user.session_id || '')) return terminal(res, 400, 'invalid_or_expired');
    try {
      const result = await deps.withPgClient(async (pg) => createMicrosoftOAuthCallbackService({ repository:createPostgresOAuthTransactionRepository(pg), env }).accept(query, { clientId:user.client_id, authSessionId:user.session_id }));
      return terminal(res, result.status === 'invalid_or_expired' ? 400 : 200, result.status);
    } catch (_) { return terminal(res, 400, 'invalid_or_expired'); }
  }
  return Object.freeze({ handleStart, handleCallback });
}
module.exports = { OAUTH_START_PATH, OAUTH_CALLBACK_PATH, validBody, createStaffEmailOAuthRoutes };

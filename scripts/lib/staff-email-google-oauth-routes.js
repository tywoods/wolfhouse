'use strict';

const { types: utilTypes } = require('node:util');

const isProxy = utilTypes.isProxy;
const objectGetPrototypeOf = Object.getPrototypeOf;
const authenticPlainObjectPrototype = objectGetPrototypeOf({});
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectHasOwn = Object.hasOwn;
const objectIsFrozen = Object.isFrozen;
const objectFreeze = Object.freeze;
const objectCreate = Object.create;
const reflectOwnKeys = Reflect.ownKeys;
const GOOGLE_OAUTH_START_PATH='/staff/admin/email-settings/oauth/google/start';
const GOOGLE_OAUTH_CALLBACK_PATH='/staff/email/google/callback';
const GOOGLE_OAUTH_DISCONNECT_PATH='/staff/admin/email-settings/oauth/google/disconnect';
const START_FLAG = 'LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED';
const CALLBACK_FLAG = 'LUNA_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED';
const DISCONNECT_FLAG = 'LUNA_EMAIL_OAUTH_DISCONNECT_ENABLED';
const DISCONNECT_ERROR = 'oauth_disconnect_unavailable';
const DISCONNECT_SUCCESS_KEYS = Object.freeze([
  'success', 'status', 'grant_generation', 'grant_status', 'reconcile_state',
]);
const {
  tryRemoveRegisteredNotConnectedEndpoint,
} = require('./email-registered-endpoint-remove');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCATION = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STATE = /^[A-Za-z0-9_-]{43}$/;
const SQL_RESOLVE_GOOGLE_START_BINDING = `
SELECT c.id::text AS client_id, l.id::text AS location_id, e.id::text AS endpoint_id
FROM clients c
JOIN tenant_locations l ON l.client_id = c.id
JOIN tenant_channel_endpoints e ON e.client_id = c.id AND e.location_id = l.location_id AND e.id = $2::uuid
WHERE c.slug = 'sunset' AND l.location_id = $1 AND l.active = true
AND e.provider = 'gmail_api' AND e.auth_mode = 'delegated_authorization_code'
AND e.connector_mode = 'google_delegated_oauth'
AND e.binding_status IN ('unverified_offline', 'pending_manual_validation')
AND e.public_address IS NOT NULL AND btrim(e.public_address) <> ''`.replace(/\s+/g, ' ').trim();
function own(value, key) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) return undefined;
  const descriptor = objectGetOwnPropertyDescriptor(value, key);
  return descriptor && objectHasOwn(descriptor, 'value') && !descriptor.get && !descriptor.set ? descriptor.value : undefined;
}
function enabled(env, flag) {
  try { return own(env, 'LUNA_DEPLOYMENT') === 'sunset-staging' && own(env, flag) === 'true'; } catch (_) { return false; }
}
function isGoogleOAuthStartEnabled(env) { return enabled(env, START_FLAG); }
function isGoogleOAuthCallbackEnabled(env) { return enabled(env, CALLBACK_FLAG); }
function isGoogleOAuthDisconnectEnabled(env) {
  try {
    return own(env, 'LUNA_DEPLOYMENT') === 'sunset-staging'
      && own(env, 'SUNSET_EMAIL_SETTINGS_UI_ENABLED') === 'true'
      && own(env, DISCONNECT_FLAG) === 'true';
  } catch (_) { return false; }
}
function buildGoogleDisconnectSuccessJson(result) {
  try {
    if (!result || typeof result !== 'object') return null;
    if (result.status !== 'disconnected') return null;
    if (result.grant_generation != null) return null;
    if (result.grant_status != null) return null;
    if (result.reconcile_state != null) return null;
    const dto = {};
    dto.success = true;
    dto.status = 'disconnected';
    dto.grant_generation = null;
    dto.grant_status = null;
    dto.reconcile_state = null;
    return objectFreeze(dto);
  } catch (_) { return null; }
}
function isTrustedGateSnapshot(value) {
  try {
    if (!value || typeof value !== 'object' || isProxy(value) || objectGetPrototypeOf(value) !== authenticPlainObjectPrototype || !objectIsFrozen(value)) return false;
    const keys = reflectOwnKeys(value);
    const expected = ['LUNA_DEPLOYMENT','LUNA_EMAIL_GOOGLE_OAUTH_ENDPOINT_ENABLED','LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED','LUNA_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED'];
    return keys.length === expected.length && keys.every((key,index) => key === expected[index] && exactDataDescriptor(value,key));
  } catch (_) { return false; }
}
function exactDataDescriptor(value,key) {
  const descriptor=objectGetOwnPropertyDescriptor(value,key);
  return descriptor && descriptor.enumerable === true && descriptor.writable === false && descriptor.configurable === false
    && objectHasOwn(descriptor,'value') && !objectHasOwn(descriptor,'get') && !objectHasOwn(descriptor,'set');
}

function identity(user, callback) {
  return own(user, 'client_slug') === 'sunset' && UUID.test(own(user, callback ? 'client_id' : 'staff_user_id') || '')
    && UUID.test(own(user, 'session_id') || '');
}
function bodySnapshot(body) {
  try {
    if (!body || typeof body !== 'object' || utilTypes.isProxy(body) || objectGetPrototypeOf(body) !== authenticPlainObjectPrototype
        || !objectIsFrozen(body) || reflectOwnKeys(body).join(',') !== 'location_id,endpoint_id') return null;
    const location = own(body, 'location_id'); const endpoint = own(body, 'endpoint_id');
    return typeof location === 'string' && LOCATION.test(location) && typeof endpoint === 'string' && UUID.test(endpoint)
      ? objectFreeze({ location_id: location, endpoint_id: endpoint }) : null;
  } catch (_) { return null; }
}
function callbackQuery(url, req) {
  try {
    if (!(url instanceof URL) || url.pathname !== GOOGLE_OAUTH_CALLBACK_PATH || url.hash !== ''
        || !req || req.method !== 'GET' || typeof req.url !== 'string'
        || req.url.length < GOOGLE_OAUTH_CALLBACK_PATH.length + 2 || req.url.includes('#')
        || !req.url.startsWith(`${GOOGLE_OAUTH_CALLBACK_PATH}?`)
        || req.url.indexOf('?') !== GOOGLE_OAUTH_CALLBACK_PATH.length) return null;
    const raw = req.url.slice(GOOGLE_OAUTH_CALLBACK_PATH.length + 1);
    if (url.search !== `?${raw}`) return null;
    const parts = raw.split('&'); const values = objectCreate(null);
    const allowed = new Set(['state', 'code', 'error', 'scope', 'authuser', 'prompt']);
    for (const part of parts) {
      const at = part.indexOf('=');
      if (at < 1 || at !== part.lastIndexOf('=')) return null;
      const key = part.slice(0, at); const encoded = part.slice(at + 1);
      if (!allowed.has(key) || objectHasOwn(values, key) || encoded.length < 1 || /\+/.test(encoded)) return null;
      values[key] = decodeURIComponent(encoded);
    }
    if (!STATE.test(values.state || '')) return null;
    const success = typeof values.code === 'string' && values.error === undefined;
    const decline = values.error === 'access_denied' && values.code === undefined;
    if (!success && !decline) return null;
    if (success && (values.code.length < 1 || values.code.length > 8192)) return null;
    if (!success && (values.scope !== undefined || values.authuser !== undefined || values.prompt !== undefined)) return null;
    if (values.scope !== undefined && !/^[A-Za-z0-9._~:/ -]{1,2048}$/.test(values.scope)) return null;
    if (values.authuser !== undefined && !/^\d{1,3}$/.test(values.authuser)) return null;
    if (values.prompt !== undefined && !/^[A-Za-z_ -]{1,64}$/.test(values.prompt)) return null;
    return `state=${encodeURIComponent(values.state)}&${success ? `code=${encodeURIComponent(values.code)}` : 'error=access_denied'}`;
  } catch (_) { return null; }
}
function isAuthenticReceived(output) {
  try {
    if (output === null || typeof output !== 'object' || isProxy(output)
        || objectGetPrototypeOf(output) !== authenticPlainObjectPrototype || !objectIsFrozen(output)) return false;
    const keys = reflectOwnKeys(output);
    if (keys.length !== 1 || keys[0] !== 'status') return false;
    const descriptor = objectGetOwnPropertyDescriptor(output, 'status');
    return descriptor !== undefined && descriptor.value === 'received' && descriptor.enumerable === true
      && descriptor.writable === false && descriptor.configurable === false
      && !objectHasOwn(descriptor, 'get') && !objectHasOwn(descriptor, 'set');
  } catch (_) { return false; }
}
function createStaffEmailGoogleOAuthRoutes(deps) {
  const candidateGateSnapshot = own(deps, 'trustedGateSnapshot');
  const trustedGateSnapshot = isTrustedGateSnapshot(candidateGateSnapshot) ? candidateGateSnapshot : null;
  const startAuthorizer = own(deps, 'authorizeProductionStart');
  const hasStartAuthorizer = startAuthorizer !== undefined
    || own(deps, 'startCapability') !== undefined || own(deps, 'trustedStartAuthorization') !== undefined;
  const env = trustedGateSnapshot || own(deps, 'runtimeEnv') || {};
  async function handleStart(body, req, res, user) {
    if (!trustedGateSnapshot && !isGoogleOAuthStartEnabled(env)) return deps.sendJSON(res, 404, { success:false, error:'not_found' });
    if (!identity(user, false)) return deps.sendJSON(res, 403, { success:false, error:'forbidden' });
    if (!req || req.method !== 'POST') return deps.sendJSON(res, 400, { success:false, error:'invalid_request' });
    let trusted = false;
    if (trustedGateSnapshot && typeof startAuthorizer === 'function') {
      try { trusted = startAuthorizer(trustedGateSnapshot, req, user) === true; } catch (_) { trusted = false; }
    }
    if (!trusted) {
      if (hasStartAuthorizer) return deps.sendJSON(res, 403, { success:false, error:'forbidden' });
      if (!deps.assertStaffClientAccess(user, 'sunset', res)) return;
      const authz = deps.authorizeAuthenticatedStaffRoute({ clientSlug:'sunset', method:'POST', pathname:GOOGLE_OAUTH_START_PATH, env });
      if (!authz.ok) return deps.sendJSON(res, authz.status || 403, authz.body || { success:false, error:'forbidden' });
    }
    const input = bodySnapshot(body); if (!input) return deps.sendJSON(res, 400, { success:false, error:'invalid_request' });
    try { return await deps.withPgClient(async pg => {
      const result = await pg.query(SQL_RESOLVE_GOOGLE_START_BINDING, [input.location_id, input.endpoint_id]);
      if (!result || !Array.isArray(result.rows) || result.rows.length !== 1) return deps.sendJSON(res, 404, {success:false,error:'not_found'});
      const row = result.rows[0];
      if (!UUID.test(row.client_id||'') || !UUID.test(row.location_id||'') || row.endpoint_id !== input.endpoint_id) throw Error('binding');
      const start = deps.createStart(pg); const dto = await start.start(objectFreeze({clientId:row.client_id,locationId:row.location_id,endpointId:row.endpoint_id,staffUserId:own(user,'staff_user_id').toLowerCase(),authSessionId:own(user,'session_id').toLowerCase()}));
      return deps.sendJSON(res, 200, dto);
    }); } catch (_) { return deps.sendJSON(res, 503, {success:false,error:'oauth_start_unavailable'}); }
  }
  async function handleCallback(req, res) {
    if (!trustedGateSnapshot && !isGoogleOAuthCallbackEnabled(env)) return deps.sendHTML(res, 404, '<!doctype html><title>Not found</title>');
    let url; try { url = new URL(req.url, 'https://staff-staging.lunafrontdesk.com'); } catch (_) { url = null; }
    const query = callbackQuery(url, req); if (!query) return deps.sendHTML(res, 400, '<!doctype html><title>Connection failed</title>');
    try { const output = await deps.withPgClient(pg => deps.createCallbackRuntime(pg).completeCallback(objectFreeze({query})));
      if (!isAuthenticReceived(output)) return deps.sendHTML(res, 400, '<!doctype html><title>Connection failed</title><p>Gmail connection could not be completed.</p>');
      return deps.sendHTML(res, 200, '<!doctype html><title>Gmail connected</title><p>Gmail connection completed. You may close this window.</p>');
    } catch (_) { return deps.sendHTML(res, 400, '<!doctype html><title>Connection failed</title><p>Gmail connection could not be completed.</p>'); }
  }
  async function handleDisconnect(body, req, res, user, gateEnv = env) {
    // Prefer caller-frozen disconnect gate snapshot when production integration
    // supplies one; trusted Google OAuth gate does not carry the disconnect flag.
    if (!isGoogleOAuthDisconnectEnabled(gateEnv)) {
      return deps.sendJSON(res, 404, { success: false, error: 'not_found' });
    }
    if (!identity(user, false)) return deps.sendJSON(res, 403, { success: false, error: 'forbidden' });
    if (!req || req.method !== 'POST') return deps.sendJSON(res, 400, { success: false, error: 'invalid_request' });
    if (!deps.assertStaffClientAccess(user, 'sunset', res)) return;
    const authz = deps.authorizeAuthenticatedStaffRoute({
      clientSlug: 'sunset',
      method: 'POST',
      pathname: GOOGLE_OAUTH_DISCONNECT_PATH,
      env: gateEnv,
    });
    if (!authz.ok) {
      return deps.sendJSON(res, authz.status || 403, authz.body || { success: false, error: 'forbidden' });
    }
    const input = bodySnapshot(body);
    if (!input) return deps.sendJSON(res, 400, { success: false, error: 'invalid_request' });
    try {
      return await deps.withPgClient(async (pg) => {
        const removed = await tryRemoveRegisteredNotConnectedEndpoint(pg, objectFreeze({
          locationId: input.location_id,
          endpointId: input.endpoint_id,
          provider: 'gmail_api',
        }));
        if (removed.kind === 'removed') {
          const json = buildGoogleDisconnectSuccessJson(removed.result);
          if (!json
              || reflectOwnKeys(json).length !== DISCONNECT_SUCCESS_KEYS.length
              || reflectOwnKeys(json)[0] !== DISCONNECT_SUCCESS_KEYS[0]) {
            return deps.sendJSON(res, 503, { success: false, error: DISCONNECT_ERROR });
          }
          return deps.sendJSON(res, 200, json);
        }
        if (removed.kind === 'not_applicable') {
          return deps.sendJSON(res, 404, { success: false, error: 'endpoint_not_found' });
        }
        return deps.sendJSON(res, 503, { success: false, error: DISCONNECT_ERROR });
      });
    } catch (_) {
      return deps.sendJSON(res, 503, { success: false, error: DISCONNECT_ERROR });
    }
  }
  return objectFreeze({ handleStart, handleCallback, handleDisconnect });
}
module.exports = objectFreeze({
  createStaffEmailGoogleOAuthRoutes,
  GOOGLE_OAUTH_START_PATH,
  GOOGLE_OAUTH_CALLBACK_PATH,
  GOOGLE_OAUTH_DISCONNECT_PATH,
  START_FLAG,
  CALLBACK_FLAG,
  DISCONNECT_FLAG,
  DISCONNECT_ERROR,
  DISCONNECT_SUCCESS_KEYS,
  isGoogleOAuthStartEnabled,
  isGoogleOAuthCallbackEnabled,
  isGoogleOAuthDisconnectEnabled,
  SQL_RESOLVE_GOOGLE_START_BINDING,
});

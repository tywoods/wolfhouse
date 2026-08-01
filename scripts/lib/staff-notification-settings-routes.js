/**
 * Staff WhatsApp notification-settings routes — extracted from staff-query-api.js.
 *
 * Slice 1 of Staff API route decomposition (zero-risk cut / extraction template).
 *
 *   GET  /staff/notification-settings
 *   PUT  /staff/notification-settings
 *
 * Auth is NOT enforced here. The Staff API router must call
 * requireAuth(req, res, 'admin') before dispatching handlers from this module.
 *
 * @module staff-notification-settings-routes
 */

'use strict';

const {
  getNotificationSettings,
  putNotificationSettings,
  isStaffNotificationsEnabled,
  isStaffNotificationsDryRun,
} = require('./staff-whatsapp-notifications');
const { normalizeSunsetLocationId } = require('./sunset-school-locations');

const NOTIFICATION_SETTINGS_PATH = '/staff/notification-settings';
const NOTIFICATION_SETTINGS_MIN_ROLE = 'admin';

/**
 * Resolve optional location scope from query and/or body.
 * Pure helper — no auth, no DB.
 *
 * @param {object} query
 * @param {object|null|undefined} body
 * @returns {string|null}
 */
function resolveNotificationSettingsLocationId(query, body) {
  const fromBody = body && (body.location_id || body.location);
  const raw = fromBody != null && String(fromBody).trim() !== '' ? fromBody : query.location;
  if (raw == null || String(raw).trim() === '') return null;
  return normalizeSunsetLocationId(raw);
}

/**
 * @typedef {object} NotificationSettingsRouteDeps
 * @property {(res: import('http').ServerResponse, status: number, body: object) => unknown} sendJSON
 * @property {(res: import('http').ServerResponse, message: string) => unknown} send400
 * @property {(req: import('http').IncomingMessage) => Promise<string>} readBody
 * @property {(user: object|null, clientSlug: string, res: import('http').ServerResponse) => boolean} assertStaffClientAccess
 * @property {(entry: object) => void} appendAuditLog
 * @property {(fn: (pg: object) => Promise<any>) => Promise<any>} withPgClient
 * @property {string} DEFAULT_CLIENT
 * @property {RegExp} SQL_INJECT_RE
 */

/**
 * Build handlers bound to monolith helpers (sendJSON, withPgClient seam, etc.).
 * Returns a small register/handler map for the Staff API router.
 *
 * @param {NotificationSettingsRouteDeps} deps
 */
function createNotificationSettingsRoutes(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new Error('createNotificationSettingsRoutes: deps required');
  }
  const {
    sendJSON,
    send400,
    readBody,
    assertStaffClientAccess,
    appendAuditLog,
    withPgClient,
    DEFAULT_CLIENT,
    SQL_INJECT_RE,
  } = deps;

  async function handleNotificationSettingsGet(query, req, res, user) {
    const started = Date.now();
    const clientSlug = (String(query.client || query.client_slug || DEFAULT_CLIENT)).trim();
    if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
    if (!assertStaffClientAccess(user, clientSlug, res)) return;
    const locationId = resolveNotificationSettingsLocationId(query, null);
    try {
      const settings = await withPgClient((pg) => getNotificationSettings(pg, { clientSlug, locationId }));
      appendAuditLog({
        ts: new Date().toISOString(),
        intent: 'api:staff.notification_settings.get',
        category: 'admin_api',
        client_slug: clientSlug,
        location_id: locationId,
        success: true,
        staff_user_id: user ? user.staff_user_id : null,
        elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, 200, {
        success: true,
        ...settings,
        server_notifications_enabled: isStaffNotificationsEnabled(process.env),
        server_notifications_dry_run: isStaffNotificationsDryRun(process.env),
        elapsed_ms: Date.now() - started,
      });
    } catch (err) {
      console.error('[notification-settings.get] failed:', err && err.code, '|', err && err.message);
      return sendJSON(res, 500, { success: false, error: 'read failed' });
    }
  }

  async function handleNotificationSettingsPut(query, req, res, user) {
    const started = Date.now();
    const clientSlug = (String(query.client || query.client_slug || DEFAULT_CLIENT)).trim();
    if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
    if (!assertStaffClientAccess(user, clientSlug, res)) return;
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (_) { return send400(res, 'invalid JSON body'); }
    const locationId = resolveNotificationSettingsLocationId(query, body);
    try {
      const r = await withPgClient((pg) => putNotificationSettings(pg, {
        clientSlug,
        locationId,
        settings: {
          new_conversation: body.new_conversation,
          human_needed: body.human_needed,
        },
        actor: user,
      }));
      appendAuditLog({
        ts: new Date().toISOString(),
        intent: 'api:staff.notification_settings.put',
        category: 'admin_api',
        client_slug: clientSlug,
        location_id: locationId,
        success: r.ok,
        staff_user_id: user ? user.staff_user_id : null,
        elapsed_ms: Date.now() - started,
      });
      if (!r.ok) return sendJSON(res, r.status || 400, { success: false, error: r.error });
      return sendJSON(res, 200, { success: true, ...r.settings, elapsed_ms: Date.now() - started });
    } catch (err) {
      console.error('[notification-settings.put] failed:', err && err.code, '|', err && err.message);
      return sendJSON(res, 500, { success: false, error: 'write failed' });
    }
  }

  /** Method → handler map (auth not applied). */
  const handlers = Object.freeze({
    GET: handleNotificationSettingsGet,
    PUT: handleNotificationSettingsPut,
  });

  /** Explicit route table for registration/introspection. */
  const routes = Object.freeze([
    {
      method: 'GET',
      path: NOTIFICATION_SETTINGS_PATH,
      minRole: NOTIFICATION_SETTINGS_MIN_ROLE,
      handler: handleNotificationSettingsGet,
    },
    {
      method: 'PUT',
      path: NOTIFICATION_SETTINGS_PATH,
      minRole: NOTIFICATION_SETTINGS_MIN_ROLE,
      handler: handleNotificationSettingsPut,
    },
  ]);

  function getHandler(method) {
    const m = String(method || '').toUpperCase();
    return handlers[m] || null;
  }

  /**
   * Path+method match only. Returns handler or null.
   * Caller is responsible for requireAuth(..., minRole).
   *
   * @param {string} pathname
   * @param {string} method
   * @returns {Function|null}
   */
  function match(pathname, method) {
    if (pathname !== NOTIFICATION_SETTINGS_PATH) return null;
    return getHandler(method);
  }

  return {
    PATH: NOTIFICATION_SETTINGS_PATH,
    MIN_ROLE: NOTIFICATION_SETTINGS_MIN_ROLE,
    handlers,
    routes,
    getHandler,
    match,
    handleNotificationSettingsGet,
    handleNotificationSettingsPut,
    resolveNotificationSettingsLocationId,
  };
}

module.exports = {
  NOTIFICATION_SETTINGS_PATH,
  NOTIFICATION_SETTINGS_MIN_ROLE,
  resolveNotificationSettingsLocationId,
  createNotificationSettingsRoutes,
};

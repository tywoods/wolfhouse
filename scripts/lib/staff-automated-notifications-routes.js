/**
 * Staff automated-notifications collection routes — extracted from staff-query-api.js.
 *
 * Slice 5 of Staff API route decomposition (DI factory).
 *
 *   GET  /staff/automated-notifications  — admin
 *   POST /staff/automated-notifications  — admin (create scheduled prompt)
 *
 * PUT/DELETE /staff/automated-notifications/:id remain inline in staff-query-api.js
 * (path-param sub-routes; same pattern as whatsapp-numbers DELETE).
 *
 * Auth is NOT enforced here. Router must requireAuth(req, res, 'admin').
 *
 * Shared helpers:
 *   - location scope: resolveNotificationSettingsLocationId (Slice 1 module)
 *   - CRUD: scripts/lib/staff-automated-notifications.js (injected for POST/GET write/list)
 * Do not touch staff-notification-settings-routes.js handlers.
 *
 * @module staff-automated-notifications-routes
 */

'use strict';

const {
  resolveNotificationSettingsLocationId,
} = require('./staff-notification-settings-routes');

const AUTOMATED_NOTIFICATIONS_PATH = '/staff/automated-notifications';
const AUTOMATED_NOTIFICATIONS_MIN_ROLE = 'admin';

/**
 * Same location scope as notification-settings (query/body.location(_id)).
 * Pure helper — no auth, no DB.
 */
function resolveAutomatedNotificationsLocationId(query, body) {
  return resolveNotificationSettingsLocationId(query, body);
}

/**
 * Canonical route table — minRole must match router requireAuth exactly.
 * Collection GET/POST only; :id PUT/DELETE stay in the monolith this slice.
 */
const AUTOMATED_NOTIFICATIONS_ROUTE_TABLE = Object.freeze([
  { id: 'list', method: 'GET', path: AUTOMATED_NOTIFICATIONS_PATH, match: 'exact', minRole: 'admin' },
  { id: 'create', method: 'POST', path: AUTOMATED_NOTIFICATIONS_PATH, match: 'exact', minRole: 'admin' },
]);

/**
 * @param {object} deps
 * @param {Function} deps.ensureStaffAutomatedNotificationsTables
 * @param {Function} deps.listStaffAutomatedNotifications
 * @param {Function} deps.createStaffAutomatedNotification — POST create path (byte-identical)
 */
function createAutomatedNotificationsRoutes(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new Error('createAutomatedNotificationsRoutes: deps required');
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
    ensureStaffAutomatedNotificationsTables,
    listStaffAutomatedNotifications,
    createStaffAutomatedNotification,
  } = deps;

  if (typeof ensureStaffAutomatedNotificationsTables !== 'function') {
    throw new Error('createAutomatedNotificationsRoutes: ensureStaffAutomatedNotificationsTables dep required');
  }
  if (typeof listStaffAutomatedNotifications !== 'function') {
    throw new Error('createAutomatedNotificationsRoutes: listStaffAutomatedNotifications dep required');
  }
  if (typeof createStaffAutomatedNotification !== 'function') {
    throw new Error('createAutomatedNotificationsRoutes: createStaffAutomatedNotification dep required');
  }

  async function handleAutomatedNotificationsGet(query, req, res, user) {
    const started = Date.now();
    const clientSlug = (String(query.client || query.client_slug || DEFAULT_CLIENT)).trim();
    if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
    if (!assertStaffClientAccess(user, clientSlug, res)) return;
    const locationId = resolveAutomatedNotificationsLocationId(query, null);
    try {
      const notifications = await withPgClient(async (pg) => {
        await ensureStaffAutomatedNotificationsTables(pg);
        return listStaffAutomatedNotifications(pg, { clientSlug, locationId });
      });
      appendAuditLog({
        ts: new Date().toISOString(),
        intent: 'api:staff.automated_notifications.list',
        category: 'admin_api',
        client_slug: clientSlug,
        location_id: locationId,
        success: true,
        staff_user_id: user ? user.staff_user_id : null,
        elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, 200, {
        success: true,
        client_slug: clientSlug,
        location_id: locationId,
        notifications,
        elapsed_ms: Date.now() - started,
      });
    } catch (err) {
      console.error('[automated-notifications.get] failed:', err && err.code, '|', err && err.message);
      return sendJSON(res, 500, { success: false, error: 'read failed' });
    }
  }

  async function handleAutomatedNotificationsPost(query, req, res, user) {
    const started = Date.now();
    const clientSlug = (String(query.client || query.client_slug || DEFAULT_CLIENT)).trim();
    if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
    if (!assertStaffClientAccess(user, clientSlug, res)) return;
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (_) { return send400(res, 'invalid JSON body'); }
    const locationId = resolveAutomatedNotificationsLocationId(query, body);
    try {
      const r = await withPgClient((pg) => createStaffAutomatedNotification(pg, {
        clientSlug,
        locationId,
        input: body,
        actor: user,
      }));
      appendAuditLog({
        ts: new Date().toISOString(),
        intent: 'api:staff.automated_notifications.create',
        category: 'admin_api',
        client_slug: clientSlug,
        location_id: locationId,
        success: r.ok,
        staff_user_id: user ? user.staff_user_id : null,
        elapsed_ms: Date.now() - started,
      });
      if (!r.ok) return sendJSON(res, r.status || 400, { success: false, error: r.error });
      return sendJSON(res, 200, { success: true, notification: r.notification, elapsed_ms: Date.now() - started });
    } catch (err) {
      console.error('[automated-notifications.post] failed:', err && err.code, '|', err && err.message);
      return sendJSON(res, 500, { success: false, error: 'write failed' });
    }
  }

  const handlers = Object.freeze({
    list: handleAutomatedNotificationsGet,
    create: handleAutomatedNotificationsPost,
  });

  const routes = Object.freeze(AUTOMATED_NOTIFICATIONS_ROUTE_TABLE.map((row) => ({
    ...row,
    handler: handlers[row.id],
  })));

  return {
    PATH: AUTOMATED_NOTIFICATIONS_PATH,
    MIN_ROLE: AUTOMATED_NOTIFICATIONS_MIN_ROLE,
    AUTOMATED_NOTIFICATIONS_PATH,
    AUTOMATED_NOTIFICATIONS_MIN_ROLE,
    AUTOMATED_NOTIFICATIONS_ROUTE_TABLE,
    handlers,
    routes,
    handleAutomatedNotificationsGet,
    handleAutomatedNotificationsPost,
    resolveAutomatedNotificationsLocationId,
  };
}

module.exports = {
  AUTOMATED_NOTIFICATIONS_PATH,
  AUTOMATED_NOTIFICATIONS_MIN_ROLE,
  AUTOMATED_NOTIFICATIONS_ROUTE_TABLE,
  resolveAutomatedNotificationsLocationId,
  createAutomatedNotificationsRoutes,
};

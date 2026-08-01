/**
 * Staff & Owner WhatsApp numbers routes — extracted from staff-query-api.js.
 *
 * Slice 2 of Staff API route decomposition (mirrors Slice 1 DI template).
 *
 *   GET  /staff/whatsapp-numbers
 *   POST /staff/whatsapp-numbers
 *
 * DELETE /staff/whatsapp-numbers/:id stays in staff-query-api.js for this slice.
 *
 * Auth is NOT enforced here. The Staff API router must call
 * requireAuth(req, res, 'admin') before dispatching handlers from this module.
 *
 * DB helpers: scripts/lib/luna-staff-whatsapp-numbers.js
 * Recognition sync: scripts/lib/staff-phone-access.js
 *
 * @module staff-whatsapp-numbers-routes
 */

'use strict';

const {
  listStaffWhatsappNumbers,
  upsertStaffWhatsappNumber,
  ensureStaffWhatsappNumbersTable,
} = require('./luna-staff-whatsapp-numbers');
const { upsertStaffPhoneAccess } = require('./staff-phone-access');

const WHATSAPP_NUMBERS_PATH = '/staff/whatsapp-numbers';
const WHATSAPP_NUMBERS_MIN_ROLE = 'admin';

/**
 * @typedef {object} WhatsappNumbersRouteDeps
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
 * @param {WhatsappNumbersRouteDeps} deps
 */
function createWhatsappNumbersRoutes(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new Error('createWhatsappNumbersRoutes: deps required');
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

  async function handleStaffWhatsappNumbersGet(query, req, res, user) {
    const started = Date.now();
    const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
    if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
    if (!assertStaffClientAccess(user, clientSlug, res)) return;

    try {
      const numbers = await withPgClient(async (pg) => {
        await ensureStaffWhatsappNumbersTable(pg);
        return listStaffWhatsappNumbers(pg, clientSlug);
      });
      appendAuditLog({
        ts: new Date().toISOString(),
        intent: 'api:staff.whatsapp_numbers.list',
        category: 'admin_api',
        client_slug: clientSlug,
        success: true,
        staff_user_id: user ? user.staff_user_id : null,
        elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, 200, { success: true, client_slug: clientSlug, numbers, elapsed_ms: Date.now() - started });
    } catch (err) {
      return sendJSON(res, 500, { success: false, error: 'read failed' });
    }
  }

  async function handleStaffWhatsappNumbersPost(query, req, res, user) {
    const started = Date.now();
    const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
    if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
    if (!assertStaffClientAccess(user, clientSlug, res)) return;

    let body;
    try {
      body = JSON.parse(await readBody(req) || '{}');
    } catch (_) {
      return send400(res, 'invalid JSON body');
    }

    try {
      const result = await withPgClient(async (pg) => {
        await ensureStaffWhatsappNumbersTable(pg);
        const up = await upsertStaffWhatsappNumber(pg, {
          clientSlug,
          phone: body.phone,
          permissionGroup: body.permission_group,
          displayName: body.display_name,
          active: body.active,
        });
        // Sync into staff_phone_access (the table WhatsApp recognition reads) so the number
        // is recognized over WhatsApp: owner -> owner Command Center (owner insights + ops),
        // staff -> operator ops. Best-effort; never fails the portal save.
        if (up.ok) {
          try {
            await upsertStaffPhoneAccess(pg, {
              client_slug: clientSlug,
              phone: body.phone,
              display_name: body.display_name,
              role: body.permission_group === 'owner' ? 'owner' : 'operator',
              channel: 'whatsapp',
              is_active: body.active !== false,
            });
            up._whatsapp_synced = true;
          } catch (syncErr) {
            console.error('[staff.whatsapp_numbers.sync] failed:', syncErr && syncErr.message);
            up._whatsapp_synced = false;
          }
        }
        return up;
      });
      appendAuditLog({
        ts: new Date().toISOString(),
        intent: 'api:staff.whatsapp_numbers.upsert',
        category: 'admin_api',
        client_slug: clientSlug,
        success: result.ok,
        staff_user_id: user ? user.staff_user_id : null,
        elapsed_ms: Date.now() - started,
      });
      if (!result.ok) return sendJSON(res, 400, { success: false, error: result.error, elapsed_ms: Date.now() - started });
      return sendJSON(res, 200, { success: true, number: result.row, whatsapp_recognition: result._whatsapp_synced === true, elapsed_ms: Date.now() - started });
    } catch (err) {
      return sendJSON(res, 500, { success: false, error: 'write failed' });
    }
  }

  /** Method → handler map (auth not applied). Collection path only (GET/POST). */
  const handlers = Object.freeze({
    GET: handleStaffWhatsappNumbersGet,
    POST: handleStaffWhatsappNumbersPost,
  });

  /** Explicit route table for registration/introspection. */
  const routes = Object.freeze([
    {
      method: 'GET',
      path: WHATSAPP_NUMBERS_PATH,
      minRole: WHATSAPP_NUMBERS_MIN_ROLE,
      handler: handleStaffWhatsappNumbersGet,
    },
    {
      method: 'POST',
      path: WHATSAPP_NUMBERS_PATH,
      minRole: WHATSAPP_NUMBERS_MIN_ROLE,
      handler: handleStaffWhatsappNumbersPost,
    },
  ]);

  function getHandler(method) {
    const m = String(method || '').toUpperCase();
    return handlers[m] || null;
  }

  /**
   * Path+method match only for the collection path. Returns handler or null.
   * Caller is responsible for requireAuth(..., minRole).
   * Does not match DELETE /staff/whatsapp-numbers/:id (still monolith-owned).
   *
   * @param {string} pathname
   * @param {string} method
   * @returns {Function|null}
   */
  function match(pathname, method) {
    if (pathname !== WHATSAPP_NUMBERS_PATH) return null;
    return getHandler(method);
  }

  return {
    PATH: WHATSAPP_NUMBERS_PATH,
    MIN_ROLE: WHATSAPP_NUMBERS_MIN_ROLE,
    handlers,
    routes,
    getHandler,
    match,
    handleStaffWhatsappNumbersGet,
    handleStaffWhatsappNumbersPost,
  };
}

module.exports = {
  WHATSAPP_NUMBERS_PATH,
  WHATSAPP_NUMBERS_MIN_ROLE,
  createWhatsappNumbersRoutes,
};

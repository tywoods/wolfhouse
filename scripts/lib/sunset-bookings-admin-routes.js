'use strict';

/**
 * Sunset Admin Bookings routes — list / CSV export / manual refund.
 * Auth is enforced by staff-query-api.js (requireAuth) before dispatch.
 *
 * @module sunset-bookings-admin-routes
 */

const {
  resolveBookingsAdminScope,
  listSunsetBookingsAdmin,
  exportSunsetBookingsAdminCsv,
  recordSunsetBookingRefund,
} = require('./sunset-bookings-admin-data');
const { BookingsAdminError } = require('./sunset-bookings-admin');

const BOOKINGS_LIST_PATH = '/staff/admin/bookings';
const BOOKINGS_EXPORT_PATH = '/staff/admin/bookings/export.csv';
const BOOKING_REFUND_RE = /^\/staff\/admin\/bookings\/([0-9a-f-]{36})\/refunds$/i;

const BOOKINGS_ROUTE_TABLE = Object.freeze([
  { id: 'list', method: 'GET', path: BOOKINGS_LIST_PATH, minRole: 'viewer' },
  { id: 'export', method: 'GET', path: BOOKINGS_EXPORT_PATH, minRole: 'viewer' },
  { id: 'record_refund', method: 'POST', path: '/staff/admin/bookings/:bookingId/refunds', minRole: 'operator' },
]);

function createBookingsAdminRoutes(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new Error('createBookingsAdminRoutes: deps required');
  }
  const {
    sendJSON,
    send400,
    readBody,
    assertStaffClientAccess,
    appendAuditLog,
    withPgClient,
    SQL_INJECT_RE,
  } = deps;

  function sendCsv(res, filename, csvText, meta) {
    const body = String(csvText || '');
    const headers = {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    };
    if (meta && meta.truncated) {
      headers['X-Bookings-Export-Truncated'] = 'true';
      headers['X-Bookings-Export-Row-Count'] = String(meta.row_count != null ? meta.row_count : '');
      headers['X-Bookings-Export-Total-Matching'] = String(meta.total_matching != null ? meta.total_matching : '');
    }
    res.writeHead(200, headers);
    res.end(body);
  }

  async function handleList(query, res, user) {
    const started = Date.now();
    const scope = resolveBookingsAdminScope(query, { sqlInjectRe: SQL_INJECT_RE });
    if (!scope.ok) return sendJSON(res, scope.status, { success: false, error: scope.error });
    if (!assertStaffClientAccess(user, scope.clientSlug, res)) return;

    const auditBase = {
      ts: new Date().toISOString(),
      intent: 'api:admin.bookings.list',
      category: 'admin_bookings',
      client_slug: scope.clientSlug,
      location_id: scope.locationId,
      staff_user_id: user ? user.staff_user_id : null,
    };

    try {
      const result = await withPgClient((pg) => listSunsetBookingsAdmin(pg, scope, query));
      appendAuditLog({
        ...auditBase,
        success: true,
        row_count: result.total_count,
        elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, 200, { ...result, elapsed_ms: Date.now() - started });
    } catch (err) {
      if (err instanceof BookingsAdminError) {
        return sendJSON(res, err.status || 400, { success: false, error: err.code });
      }
      appendAuditLog({
        ...auditBase,
        success: false,
        error: err && err.message,
        elapsed_ms: Date.now() - started,
      });
      console.error('[admin.bookings.list] read failed:', err && err.code, err && err.message);
      return sendJSON(res, 500, { success: false, error: 'read failed' });
    }
  }

  async function handleExport(query, res, user) {
    const started = Date.now();
    const scope = resolveBookingsAdminScope(query, { sqlInjectRe: SQL_INJECT_RE });
    if (!scope.ok) return sendJSON(res, scope.status, { success: false, error: scope.error });
    if (!assertStaffClientAccess(user, scope.clientSlug, res)) return;

    try {
      const result = await withPgClient((pg) => exportSunsetBookingsAdminCsv(pg, scope, query));
      appendAuditLog({
        ts: new Date().toISOString(),
        intent: 'api:admin.bookings.export',
        category: 'admin_bookings',
        client_slug: scope.clientSlug,
        location_id: scope.locationId,
        success: true,
        row_count: result.row_count,
        total_matching: result.total_matching,
        truncated: !!result.truncated,
        staff_user_id: user ? user.staff_user_id : null,
        elapsed_ms: Date.now() - started,
      });
      return sendCsv(res, `sunset-bookings-${scope.locationId}.csv`, result.csv, {
        truncated: !!result.truncated,
        row_count: result.row_count,
        total_matching: result.total_matching,
      });
    } catch (err) {
      console.error('[admin.bookings.export] failed:', err && err.code, err && err.message);
      return sendJSON(res, 500, { success: false, error: 'export failed' });
    }
  }

  async function handleRecordRefund(bookingId, query, req, res, user) {
    const started = Date.now();
    let body = {};
    try {
      body = JSON.parse(await readBody(req) || '{}');
    } catch (_e) {
      return send400(res, 'invalid JSON body');
    }

    const scope = resolveBookingsAdminScope(query, {
      sqlInjectRe: SQL_INJECT_RE,
      bodyLocation: body.location_id || body.location,
    });
    if (!scope.ok) return sendJSON(res, scope.status, { success: false, error: scope.error });
    if (!assertStaffClientAccess(user, scope.clientSlug, res)) return;

    const result = await withPgClient((pg) => recordSunsetBookingRefund(pg, {
      clientSlug: scope.clientSlug,
      locationId: scope.locationId,
      bookingId,
      body,
      actor: {
        staff_user_id: user && user.staff_user_id,
        email: user && user.email,
        role: user && (user.role || user.staff_role),
      },
    }));

    appendAuditLog({
      ts: new Date().toISOString(),
      intent: 'api:admin.bookings.record_refund',
      category: 'admin_bookings',
      client_slug: scope.clientSlug,
      location_id: scope.locationId,
      booking_id: bookingId,
      success: !!(result && result.ok),
      staff_user_id: user ? user.staff_user_id : null,
      elapsed_ms: Date.now() - started,
      error: result && !result.ok ? (result.body && result.body.error) : undefined,
    });

    return sendJSON(res, result.status, {
      ...(result.body || { success: false, error: 'write failed' }),
      elapsed_ms: Date.now() - started,
    });
  }

  /**
   * @returns {boolean} true if handled
   */
  async function dispatch(req, res, pathname, method, query, user) {
    if (pathname === BOOKINGS_LIST_PATH && method === 'GET') {
      await handleList(query, res, user);
      return true;
    }
    if (pathname === BOOKINGS_EXPORT_PATH && method === 'GET') {
      await handleExport(query, res, user);
      return true;
    }
    const refundMatch = BOOKING_REFUND_RE.exec(pathname);
    if (refundMatch && method === 'POST') {
      await handleRecordRefund(refundMatch[1], query, req, res, user);
      return true;
    }
    return false;
  }

  return {
    dispatch,
    handleList,
    handleExport,
    handleRecordRefund,
    routes: BOOKINGS_ROUTE_TABLE,
  };
}

module.exports = {
  createBookingsAdminRoutes,
  BOOKINGS_LIST_PATH,
  BOOKINGS_EXPORT_PATH,
  BOOKING_REFUND_RE,
  BOOKINGS_ROUTE_TABLE,
};

/**
 * Staff Inbox Phase 4 — email-first segment broadcast routes.
 *
 *   POST /staff/broadcasts              — operator; create an email draft
 *   GET  /staff/broadcasts/:id          — operator; read draft + recipients
 *   POST /staff/broadcasts/:id/send     — operator; snapshot view members,
 *                                         exclude do_not_contact, persist
 *                                         recipient rows. BROADCAST_EMAIL_SEND_ENABLED
 *                                         fail-closed: unset/false → 501 (zero Graph);
 *                                         "true" → sendMail on the existing Graph transport.
 *
 * Auth is NOT enforced here. The Staff API router must call requireAuth with
 * the minRole from BROADCAST_ROUTE_TABLE before dispatching; handlers then
 * apply assertStaffClientAccess before any Postgres access.
 *
 * @module staff-broadcast-routes
 */

'use strict';

const {
  ERROR_WHATSAPP_NOT_SUPPORTED,
  ERROR_SEND_NOT_IMPLEMENTED,
  ERROR_SEND_UNAVAILABLE,
  SQL_INSERT_BROADCAST,
  SQL_SELECT_BROADCAST,
  parseBroadcastCreateBody,
  executeCreateBroadcast,
  executeGetBroadcast,
  executeSendBroadcast,
} = require('./staff-broadcasts');

const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const BROADCASTS_COLLECTION_PATH = '/staff/broadcasts';
const BROADCAST_ID_PATH = '/staff/broadcasts/:id';
const BROADCAST_SEND_PATH = '/staff/broadcasts/:id/send';
const BROADCAST_ID_RE = new RegExp(`^/staff/broadcasts/(${UUID_RE})$`, 'i');
const BROADCAST_SEND_RE = new RegExp(`^/staff/broadcasts/(${UUID_RE})/send$`, 'i');
const BROADCAST_MIN_ROLE = 'operator';

const BROADCAST_ROUTE_TABLE = Object.freeze([
  { id: 'broadcast_create', method: 'POST', path: BROADCASTS_COLLECTION_PATH, match: 'exact', minRole: BROADCAST_MIN_ROLE },
  { id: 'broadcast_get', method: 'GET', path: BROADCAST_ID_PATH, match: 'id', minRole: BROADCAST_MIN_ROLE },
  { id: 'broadcast_send', method: 'POST', path: BROADCAST_SEND_PATH, match: 'send', minRole: BROADCAST_MIN_ROLE },
]);

const REQUIRED_DEPS = Object.freeze([
  'sendJSON',
  'send400',
  'readBody',
  'assertStaffClientAccess',
  'appendAuditLog',
  'withPgClient',
  'DEFAULT_CLIENT',
  'SQL_INJECT_RE',
]);

function parseUuid(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!new RegExp(`^${UUID_RE}$`).test(s)) return null;
  return s;
}

function createBroadcastRoutes(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new Error('createBroadcastRoutes: deps required');
  }
  for (const key of REQUIRED_DEPS) {
    if (deps[key] == null) {
      throw new Error(`createBroadcastRoutes: ${key} required`);
    }
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
  const STAFF_ACTIONS_ENABLED = deps.STAFF_ACTIONS_ENABLED !== false;
  const runtimeEnv = deps.runtimeEnv && typeof deps.runtimeEnv === 'object' ? deps.runtimeEnv : process.env;
  const injectedSendMail = typeof deps.sendMail === 'function' ? deps.sendMail : null;
  const createSendMail = typeof deps.createSendMail === 'function' ? deps.createSendMail : null;

  function resolveRequestClient(query, res, user) {
    const clientSlug = String((query && query.client) || DEFAULT_CLIENT).trim();
    if (!clientSlug || SQL_INJECT_RE.test(clientSlug)) {
      send400(res, 'invalid client slug');
      return null;
    }
    if (!assertStaffClientAccess(user, clientSlug, res)) return null;
    return clientSlug;
  }

  async function parseJsonBody(req, res) {
    let raw;
    try {
      raw = await readBody(req);
    } catch (_err) {
      send400(res, 'invalid json body');
      return null;
    }
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        send400(res, 'invalid json body');
        return null;
      }
      return parsed;
    } catch (_err) {
      send400(res, 'invalid json body');
      return null;
    }
  }

  function failWriteDisabled(res) {
    return sendJSON(res, 403, {
      success: false,
      error: 'staff_actions_disabled',
      detail: 'Staff write actions are disabled. Set STAFF_ACTIONS_ENABLED=true to enable.',
    });
  }

  async function handleBroadcastCreate(query, req, res, user) {
    if (!STAFF_ACTIONS_ENABLED) return failWriteDisabled(res);
    const started = Date.now();
    const clientSlug = resolveRequestClient(query, res, user);
    if (clientSlug === null) return undefined;

    const body = await parseJsonBody(req, res);
    if (body === null) return undefined;

    const parsed = parseBroadcastCreateBody(body);
    const auditBase = {
      ts: new Date().toISOString(),
      intent: 'api:broadcasts.create',
      category: 'broadcast_api',
      client_slug: clientSlug,
      staff_user_id: user && user.staff_user_id ? user.staff_user_id : null,
    };
    if (!parsed.ok) {
      appendAuditLog({ ...auditBase, success: false, error: parsed.error, elapsed_ms: Date.now() - started });
      const payload = { success: false, error: parsed.error };
      if (parsed.error === ERROR_WHATSAPP_NOT_SUPPORTED) {
        payload.detail = 'Broadcasts are email-only for promotions. WhatsApp is restricted to operational messages to currently checked-in guests inside Meta\'s 24-hour window, and that path is not in this API.';
      }
      if (parsed.viewId) payload.view_id = parsed.viewId;
      return sendJSON(res, 400, payload);
    }

    try {
      const outcome = await withPgClient((pg) => executeCreateBroadcast(pg, {
        clientSlug,
        body,
        staffUserId: user && user.staff_user_id ? user.staff_user_id : null,
      }));
      const elapsed = Date.now() - started;
      if (!outcome.ok) {
        appendAuditLog({ ...auditBase, success: false, error: outcome.error, elapsed_ms: elapsed });
        const payload = { success: false, error: outcome.error };
        if (outcome.error === ERROR_WHATSAPP_NOT_SUPPORTED) {
          payload.detail = 'Broadcasts are email-only for promotions. WhatsApp is restricted to operational messages to currently checked-in guests inside Meta\'s 24-hour window, and that path is not in this API.';
        }
        if (outcome.viewId) payload.view_id = outcome.viewId;
        return sendJSON(res, outcome.status || 400, payload);
      }
      appendAuditLog({
        ...auditBase,
        success: true,
        broadcast_id: outcome.body.broadcast.id,
        view_id: outcome.body.broadcast.view_id,
        elapsed_ms: elapsed,
      });
      return sendJSON(res, outcome.status, outcome.body);
    } catch (_err) {
      appendAuditLog({ ...auditBase, success: false, error: 'create_failed', elapsed_ms: Date.now() - started });
      return sendJSON(res, 500, { success: false, error: 'create_failed' });
    }
  }

  async function handleBroadcastGet(broadcastId, query, res, user) {
    const started = Date.now();
    const id = parseUuid(broadcastId);
    if (!id) return send400(res, 'invalid broadcast id');
    const clientSlug = resolveRequestClient(query, res, user);
    if (clientSlug === null) return undefined;

    const auditBase = {
      ts: new Date().toISOString(),
      intent: 'api:broadcasts.get',
      category: 'broadcast_api',
      client_slug: clientSlug,
      broadcast_id: id,
      staff_user_id: user && user.staff_user_id ? user.staff_user_id : null,
    };

    try {
      const outcome = await withPgClient((pg) => executeGetBroadcast(pg, {
        clientSlug,
        broadcastId: id,
      }));
      const elapsed = Date.now() - started;
      if (!outcome.ok) {
        appendAuditLog({ ...auditBase, success: false, error: outcome.error, elapsed_ms: elapsed });
        return sendJSON(res, outcome.status || 404, { success: false, error: outcome.error });
      }
      appendAuditLog({ ...auditBase, success: true, elapsed_ms: elapsed });
      return sendJSON(res, outcome.status, outcome.body);
    } catch (_err) {
      appendAuditLog({ ...auditBase, success: false, error: 'query_failed', elapsed_ms: Date.now() - started });
      return sendJSON(res, 500, { success: false, error: 'query_failed' });
    }
  }

  async function handleBroadcastSend(broadcastId, query, req, res, user) {
    if (!STAFF_ACTIONS_ENABLED) return failWriteDisabled(res);
    const started = Date.now();
    const id = parseUuid(broadcastId);
    if (!id) return send400(res, 'invalid broadcast id');
    const clientSlug = resolveRequestClient(query, res, user);
    if (clientSlug === null) return undefined;

    const auditBase = {
      ts: new Date().toISOString(),
      intent: 'api:broadcasts.send',
      category: 'broadcast_api',
      client_slug: clientSlug,
      broadcast_id: id,
      staff_user_id: user && user.staff_user_id ? user.staff_user_id : null,
    };

    try {
      const outcome = await withPgClient((pg) => executeSendBroadcast(pg, {
        clientSlug,
        broadcastId: id,
        query,
        env: runtimeEnv,
        sendMail: injectedSendMail,
        createSendMail,
      }));
      const elapsed = Date.now() - started;
      if (!outcome.ok) {
        appendAuditLog({ ...auditBase, success: false, error: outcome.error, elapsed_ms: elapsed });
        const payload = { success: false, error: outcome.error };
        if (outcome.error === ERROR_WHATSAPP_NOT_SUPPORTED) {
          payload.detail = 'Broadcasts are email-only for promotions. WhatsApp is restricted to operational messages to currently checked-in guests inside Meta\'s 24-hour window, and that path is not in this API.';
        }
        if (outcome.error === ERROR_SEND_UNAVAILABLE && outcome.body && outcome.body.detail) {
          payload.detail = outcome.body.detail;
        }
        if (outcome.summary) payload.summary = outcome.summary;
        if (outcome.body && outcome.body.summary) payload.summary = outcome.body.summary;
        if (outcome.viewId) payload.view_id = outcome.viewId;
        return sendJSON(res, outcome.status || 400, payload);
      }
      if (outcome.status === 200) {
        const summary = outcome.body && outcome.body.summary ? outcome.body.summary : {};
        appendAuditLog({
          ...auditBase,
          success: outcome.body && outcome.body.success === true,
          sent: summary.sent,
          error: summary.error,
          skipped: summary.skipped,
          elapsed_ms: elapsed,
        });
        return sendJSON(res, 200, outcome.body);
      }
      appendAuditLog({
        ...auditBase,
        success: false,
        error: ERROR_SEND_NOT_IMPLEMENTED,
        recipients_pending: outcome.body && outcome.body.summary && outcome.body.summary.pending,
        elapsed_ms: elapsed,
      });
      return sendJSON(res, outcome.status, outcome.body);
    } catch (_err) {
      appendAuditLog({ ...auditBase, success: false, error: 'send_failed', elapsed_ms: Date.now() - started });
      return sendJSON(res, 500, { success: false, error: 'send_failed' });
    }
  }

  const handlers = Object.freeze({
    broadcast_create: handleBroadcastCreate,
    broadcast_get: handleBroadcastGet,
    broadcast_send: handleBroadcastSend,
  });

  return {
    BROADCASTS_COLLECTION_PATH,
    BROADCAST_ID_RE,
    BROADCAST_SEND_RE,
    BROADCAST_ROUTE_TABLE,
    handlers,
    handleBroadcastCreate,
    handleBroadcastGet,
    handleBroadcastSend,
  };
}

module.exports = {
  BROADCASTS_COLLECTION_PATH,
  BROADCAST_ID_PATH,
  BROADCAST_SEND_PATH,
  BROADCAST_ID_RE,
  BROADCAST_SEND_RE,
  BROADCAST_MIN_ROLE,
  BROADCAST_ROUTE_TABLE,
  SQL_INSERT_BROADCAST,
  SQL_SELECT_BROADCAST,
  createBroadcastRoutes,
};

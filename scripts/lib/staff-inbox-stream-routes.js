/**
 * Inbox live-activity SSE route (Phase 3, `docs/INBOX-PORTAL-REDESIGN.md`).
 *
 *   GET /staff/inbox/stream?client=  — heartbeat + conversation-updated events
 *
 * Auth is NOT enforced here. The Staff API router must call requireAuth with
 * the minRole from INBOX_STREAM_ROUTE_TABLE before dispatching; the handler
 * then applies the same assertStaffClientAccess check the other inbox GETs
 * apply. The stream never queries Postgres: it only forwards in-process
 * events for the authenticated client_slug.
 *
 * @module staff-inbox-stream-routes
 */

'use strict';

const {
  INBOX_LIVE_EVENT_HEARTBEAT,
  INBOX_LIVE_EVENT_CONVERSATION_UPDATED,
  formatSseEvent,
  createInboxLiveHub,
  emitInboxConversationUpdated,
  subscribeInboxLive,
} = require('./staff-inbox-live-events');

const INBOX_STREAM_PATH = '/staff/inbox/stream';
const SSE_CONTENT_TYPE = 'text/event-stream';
const INBOX_STREAM_HEARTBEAT_MS = 15000;
const INBOX_STREAM_RETRY_MS = 5000;

const INBOX_STREAM_ROUTE_TABLE = Object.freeze([
  { id: 'inbox_stream', method: 'GET', path: INBOX_STREAM_PATH, match: 'exact', minRole: 'viewer' },
]);

const SSE_HEADERS = Object.freeze({
  'Content-Type': SSE_CONTENT_TYPE,
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
});

function writeSse(res, chunk) {
  if (!res || res.writableEnded || res.destroyed) return false;
  try {
    return res.write(chunk);
  } catch (_err) {
    return false;
  }
}

function writeSseEvent(res, event, data) {
  const frame = formatSseEvent(event, data);
  if (!frame) return false;
  return writeSse(res, frame);
}

/**
 * @param {object} deps
 */
function createInboxStreamRoutes(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new Error('createInboxStreamRoutes: deps required');
  }
  const {
    sendJSON,
    send400,
    assertStaffClientAccess,
    DEFAULT_CLIENT,
    SQL_INJECT_RE,
  } = deps;
  if (typeof sendJSON !== 'function') {
    throw new Error('createInboxStreamRoutes: sendJSON required');
  }
  if (typeof send400 !== 'function') {
    throw new Error('createInboxStreamRoutes: send400 required');
  }
  if (typeof assertStaffClientAccess !== 'function') {
    throw new Error('createInboxStreamRoutes: assertStaffClientAccess required');
  }
  if (!SQL_INJECT_RE) {
    throw new Error('createInboxStreamRoutes: SQL_INJECT_RE required');
  }

  const hub = deps.inboxLiveHub || null;
  const subscribe = hub
    ? hub.subscribeInboxLive.bind(hub)
    : subscribeInboxLive;
  const setIntervalFn = typeof deps.setInterval === 'function' ? deps.setInterval : setInterval;
  const clearIntervalFn = typeof deps.clearInterval === 'function' ? deps.clearInterval : clearInterval;
  const heartbeatMs = Number.isFinite(deps.heartbeatMs) ? deps.heartbeatMs : INBOX_STREAM_HEARTBEAT_MS;
  const now = typeof deps.now === 'function' ? deps.now : () => new Date().toISOString();
  const appendAuditLog = typeof deps.appendAuditLog === 'function' ? deps.appendAuditLog : null;

  function resolveRequestClient(query, res, user) {
    const clientSlug = String((query && query.client) || DEFAULT_CLIENT || '').trim();
    if (!clientSlug || SQL_INJECT_RE.test(clientSlug)) {
      send400(res, 'invalid client slug');
      return null;
    }
    if (!assertStaffClientAccess(user, clientSlug, res)) return null;
    return clientSlug;
  }

  function heartbeatPayload(clientSlug) {
    return { event: INBOX_LIVE_EVENT_HEARTBEAT, client_slug: clientSlug, ts: now() };
  }

  /**
   * @param {import('http').IncomingMessage} req
   * @param {object} query
   * @param {import('http').ServerResponse} res
   * @param {object|null} user
   * @returns {Promise<void>|undefined}
   */
  function handleInboxStream(req, query, res, user) {
    const clientSlug = resolveRequestClient(query, res, user);
    if (clientSlug === null) return undefined;

    res.writeHead(200, { ...SSE_HEADERS });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    writeSse(res, `retry: ${INBOX_STREAM_RETRY_MS}\n\n`);
    writeSse(res, ': connected\n\n');
    writeSseEvent(res, INBOX_LIVE_EVENT_HEARTBEAT, heartbeatPayload(clientSlug));

    if (appendAuditLog) {
      appendAuditLog({
        ts: now(),
        intent: 'api:inbox.stream',
        category: 'conversation_api',
        client_slug: clientSlug,
        staff_user_id: user && user.staff_user_id,
      });
    }

    const unsubscribe = subscribe(clientSlug, function onInboxLiveEvent(payload) {
      if (!payload || payload.client_slug !== clientSlug) return;
      if (payload.event !== INBOX_LIVE_EVENT_CONVERSATION_UPDATED) return;
      writeSseEvent(res, INBOX_LIVE_EVENT_CONVERSATION_UPDATED, {
        event: INBOX_LIVE_EVENT_CONVERSATION_UPDATED,
        client_slug: clientSlug,
        conversation_id: payload.conversation_id,
        ts: payload.ts || now(),
      });
    });

    const heartbeat = setIntervalFn(function inboxStreamHeartbeat() {
      if (!writeSseEvent(res, INBOX_LIVE_EVENT_HEARTBEAT, heartbeatPayload(clientSlug))) {
        cleanup();
      }
    }, heartbeatMs);

    let cleaned = false;
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      clearIntervalFn(heartbeat);
      unsubscribe();
    }

    if (req && typeof req.on === 'function') req.on('close', cleanup);
    if (res && typeof res.on === 'function') res.on('close', cleanup);

    return new Promise(function waitForStreamClose(resolve) {
      const done = function done() {
        cleanup();
        resolve();
      };
      if (req && typeof req.on === 'function') req.on('close', done);
      if (res && typeof res.on === 'function') res.on('close', done);
    });
  }

  return {
    routes: INBOX_STREAM_ROUTE_TABLE,
    handleInboxStream,
  };
}

module.exports = {
  INBOX_STREAM_PATH,
  SSE_CONTENT_TYPE,
  INBOX_STREAM_HEARTBEAT_MS,
  INBOX_STREAM_RETRY_MS,
  INBOX_STREAM_ROUTE_TABLE,
  SSE_HEADERS,
  formatSseEvent,
  createInboxLiveHub,
  emitInboxConversationUpdated,
  createInboxStreamRoutes,
};

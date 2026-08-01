/**
 * Staff Inbox routes — extracted from staff-query-api.js.
 *
 * Slice 4 of Staff API route decomposition (DI factory; mixed per-route roles).
 *
 *   GET  /staff/inbox                         — deep-link 302 → /staff/ui (no auth)
 *   GET  /staff/inbox/message-events          — viewer
 *   GET  /staff/inbox/handoffs                — viewer
 *   POST /staff/inbox/handoffs/:id/review     — operator
 *   POST /staff/inbox/send-reply              — operator (outbound WhatsApp/Luna path)
 *
 * Auth is NOT enforced here (except deep-link which is intentionally unauthenticated).
 * The Staff API router must call requireAuth with the exact minRole from
 * INBOX_ROUTE_TABLE before dispatching authenticated handlers.
 *
 * Send-reply outbound contract: evaluateGuestReplySendRouteWithPause is injected
 * via deps (byte-identical call site) — do not reimplement send logic here.
 *
 * @module staff-inbox-routes
 */

'use strict';

const {
  parseMessageEventsQuery,
  listGuestMessageEvents,
  parseHandoffQueueQuery,
  listGuestMessageHandoffQueue,
} = require('./luna-guest-message-events-read');
const {
  parseHandoffReviewInput,
  markGuestMessageEventHandoffReviewed,
} = require('./luna-guest-message-event-review');
const {
  parseInboxSendReplyInput,
  buildStaffInboxGuestReplyBody,
  resolveConversationGuestPhone,
} = require('./luna-staff-inbox-send-reply');
const {
  persistStaffInboxSentThreadMessage,
} = require('./luna-staff-inbox-thread-message');

const INBOX_PATH = '/staff/inbox';
const INBOX_MESSAGE_EVENTS_PATH = '/staff/inbox/message-events';
const INBOX_HANDOFFS_PATH = '/staff/inbox/handoffs';
const INBOX_SEND_REPLY_PATH = '/staff/inbox/send-reply';

const INBOX_HANDOFF_REVIEW_RE = /^\/staff\/inbox\/handoffs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/review$/i;

/**
 * Canonical route table — minRole must match router requireAuth exactly.
 * deep_link has minRole null (no auth; 302 redirect only).
 * Auth stays in staff-query-api.js for authenticated routes.
 */
const INBOX_ROUTE_TABLE = Object.freeze([
  { id: 'deep_link', method: 'GET', path: INBOX_PATH, match: 'exact', minRole: null },
  { id: 'message_events', method: 'GET', path: INBOX_MESSAGE_EVENTS_PATH, match: 'exact', minRole: 'viewer' },
  { id: 'handoffs', method: 'GET', path: INBOX_HANDOFFS_PATH, match: 'exact', minRole: 'viewer' },
  { id: 'handoff_review', method: 'POST', path: '/staff/inbox/handoffs/:id/review', match: 'handoff_review', minRole: 'operator' },
  { id: 'send_reply', method: 'POST', path: INBOX_SEND_REPLY_PATH, match: 'exact', minRole: 'operator' },
]);

/**
 * @param {object} deps
 * @param {Function} deps.evaluateGuestReplySendRouteWithPause — outbound send path (required)
 */
function createInboxRoutes(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new Error('createInboxRoutes: deps required');
  }
  const {
    sendJSON,
    send400,
    readBody,
    appendAuditLog,
    withPgClient,
    SQL_INJECT_RE,
    evaluateGuestReplySendRouteWithPause,
  } = deps;

  if (typeof evaluateGuestReplySendRouteWithPause !== 'function') {
    throw new Error('createInboxRoutes: evaluateGuestReplySendRouteWithPause dep required');
  }

  /**
   * GET /staff/inbox — deep-link entry for staff inbox notifications.
   * No auth; preserves query string onto /staff/ui.
   */
  function handleInboxDeepLink(parsed, res) {
    const qs = (parsed && parsed.search) || '';
    res.writeHead(302, { Location: `/staff/ui${qs}` });
    return res.end();
  }

  async function handleInboxMessageEvents(query, res, user) {
    const started = Date.now();
    const parsed = parseMessageEventsQuery(query);
    if (!parsed.ok) return send400(res, parsed.error);

    const filters = parsed.filters;
    if (SQL_INJECT_RE.test(filters.client_slug)) return send400(res, 'invalid client_slug');
    if (filters.next_action && SQL_INJECT_RE.test(filters.next_action)) {
      return send400(res, 'invalid next_action');
    }

    const auditBase = {
      ts:            new Date().toISOString(),
      intent:        'api:inbox.message-events',
      category:      'inbox_message_events_api',
      client_slug:   filters.client_slug,
      staff_user_id: user ? user.staff_user_id : null,
    };

    try {
      const result = await withPgClient((pg) => listGuestMessageEvents(pg, filters));
      const elapsed = Date.now() - started;

      appendAuditLog({
        ...auditBase,
        success: true,
        total_returned: result.events.length,
        table_missing: result.table_missing === true,
        elapsed_ms: elapsed,
      });

      const payload = {
        success: true,
        client_slug: filters.client_slug,
        events: result.events,
        total_returned: result.events.length,
        elapsed_ms: elapsed,
      };
      if (result.table_missing) {
        payload.table_missing = true;
      }
      return sendJSON(res, 200, payload);
    } catch (err) {
      appendAuditLog({
        ...auditBase,
        success: false,
        error: err.message,
        elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, 500, { success: false, error: 'query failed', detail: err.message });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Phase 23b — Meta-native handoff queue (read-only)
  //
  // GET /staff/inbox/handoffs?client_slug=...&from_phone=...&since=...
  //   Returns guest_message_events rows matching operational handoff queue criteria.
  //
  // Safety: SELECT-only on guest_message_events. Staff session auth (viewer+).
  // Does NOT read staff_handoffs or conversations for v1.
  // ─────────────────────────────────────────────────────────────────────────────

  async function handleInboxHandoffs(query, res, user) {
    const started = Date.now();
    const parsed = parseHandoffQueueQuery(query);
    if (!parsed.ok) return send400(res, parsed.error);

    const filters = parsed.filters;
    if (SQL_INJECT_RE.test(filters.client_slug)) return send400(res, 'invalid client_slug');

    const auditBase = {
      ts:            new Date().toISOString(),
      intent:        'api:inbox.handoffs',
      category:      'inbox_handoffs_api',
      client_slug:   filters.client_slug,
      staff_user_id: user ? user.staff_user_id : null,
    };

    try {
      const result = await withPgClient((pg) => listGuestMessageHandoffQueue(pg, filters));
      const elapsed = Date.now() - started;

      appendAuditLog({
        ...auditBase,
        success: true,
        total_returned: result.items.length,
        table_missing: result.table_missing === true,
        elapsed_ms: elapsed,
      });

      const payload = {
        success: true,
        client_slug: filters.client_slug,
        items: result.items,
        total_returned: result.items.length,
        elapsed_ms: elapsed,
      };
      if (result.table_missing) {
        payload.table_missing = true;
      }
      return sendJSON(res, 200, payload);
    } catch (err) {
      appendAuditLog({
        ...auditBase,
        success: false,
        error: err.message,
        elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, 500, { success: false, error: 'query failed', detail: err.message });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Phase 23c.1 — Mark Meta handoff queue item reviewed
  //
  // POST /staff/inbox/handoffs/:id/review
  //   Updates guest_message_events.normalized.handoff_review only.
  //
  // Safety: no staff_handoffs, no WhatsApp, no raw_payload mutation. Operator+ auth.
  // ─────────────────────────────────────────────────────────────────────────────

  async function handleInboxHandoffReview(eventId, req, res, user) {
    const started = Date.now();
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (_) {
      return send400(res, 'invalid JSON body');
    }

    const parsed = parseHandoffReviewInput(body);
    if (!parsed.ok) return send400(res, parsed.error);

    const clientSlug = parsed.input.client_slug;
    if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client_slug');

    const reviewedBy = user && (user.email || user.staff_user_id)
      ? String(user.email || user.staff_user_id)
      : 'unknown';

    const auditBase = {
      ts:            new Date().toISOString(),
      intent:        'action:api:inbox.handoff.review',
      category:      'inbox_handoff_review',
      client_slug:   clientSlug,
      event_id:      eventId,
      staff_user_id: user ? user.staff_user_id : null,
    };

    try {
      const result = await withPgClient((pg) => markGuestMessageEventHandoffReviewed(pg, {
        client_slug: clientSlug,
        event_id: eventId,
        reviewed_by: reviewedBy,
        review_note: parsed.input.review_note,
      }));

      const elapsed = Date.now() - started;

      if (!result.ok) {
        appendAuditLog({
          ...auditBase,
          success: false,
          error: result.error,
          elapsed_ms: elapsed,
        });
        return sendJSON(res, result.status || 500, {
          success: false,
          error: result.error || 'review failed',
        });
      }

      appendAuditLog({
        ...auditBase,
        success: true,
        already_reviewed: result.already_reviewed === true,
        elapsed_ms: elapsed,
      });

      return sendJSON(res, 200, {
        success: true,
        event_id: eventId,
        already_reviewed: result.already_reviewed === true,
        handoff_review: result.handoff_review,
        no_whatsapp: true,
        no_staff_handoffs_write: true,
        elapsed_ms: elapsed,
      });
    } catch (err) {
      appendAuditLog({
        ...auditBase,
        success: false,
        error: err.message,
        elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, 500, { success: false, error: 'review failed', detail: err.message });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Phase 23d — Staff Inbox explicit reply send
  //
  // POST /staff/inbox/send-reply
  //   Delegates to evaluateGuestReplySendRouteWithPause (guest_message_sends audit path).
  // ─────────────────────────────────────────────────────────────────────────────

  async function handleInboxSendReply(req, res, user) {
    const started = Date.now();
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (_) {
      return send400(res, 'invalid JSON body');
    }

    const parsed = parseInboxSendReplyInput(body);
    if (!parsed.ok) return send400(res, parsed.error);

    const input = parsed.input;
    if (SQL_INJECT_RE.test(input.client_slug)) return send400(res, 'invalid client_slug');

    const actorId = user ? user.staff_user_id : null;
    const auditBase = {
      ts:              new Date().toISOString(),
      intent:          'action:api:inbox.send_reply',
      category:        'inbox_send_reply',
      client_slug:     input.client_slug,
      conversation_id: input.conversation_id,
      staff_user_id:   actorId,
    };

    try {
      const evaluated = await withPgClient(async (pg) => {
        let sendInput = { ...input };
        if (!sendInput.to) {
          const phone = await resolveConversationGuestPhone(pg, input.client_slug, input.conversation_id);
          if (!phone.ok) {
            return { error: phone.error, status: phone.status || 404 };
          }
          sendInput.to = phone.to;
        }
        const sendBody = buildStaffInboxGuestReplyBody(sendInput);
        const out = await evaluateGuestReplySendRouteWithPause(sendBody, { pg, env: process.env });
        const thread = await persistStaffInboxSentThreadMessage(pg, sendInput, out.result);
        return { sendBody, out, thread };
      });

      if (evaluated.error) {
        appendAuditLog({ ...auditBase, success: false, error: evaluated.error, elapsed_ms: Date.now() - started });
        return sendJSON(res, evaluated.status || 404, { success: false, error: evaluated.error });
      }

      const elapsed = Date.now() - started;
      const result = evaluated.out.result;
      const thread = evaluated.thread || {};

      appendAuditLog({
        ...auditBase,
        success:                      result.success === true,
        send_performed:               result.send_performed === true,
        sends_whatsapp:               result.sends_whatsapp === true,
        would_send_whatsapp:          result.would_send_whatsapp === true,
        send_kind:                    result.send_kind || 'staff_reply',
        idempotency_key:              result.idempotency_key || input.idempotency_key,
        blocked_reasons:              result.blocked_reasons || [],
        duplicate:                    result.duplicate === true,
        idempotent_replay:            result.idempotent_replay === true,
        guest_message_send_id:        result.guest_message_send_id || null,
        guest_message_send_status:    result.guest_message_send_status || null,
        thread_message_persisted:   thread.persisted === true,
        thread_message_id:            thread.message_id || null,
        elapsed_ms:                   elapsed,
      });

      return sendJSON(res, evaluated.out.status, {
        ...result,
        conversation_id: input.conversation_id,
        thread_message: thread.persisted || thread.duplicate ? {
          message_id: thread.message_id || null,
          persisted: thread.persisted === true,
          duplicate: thread.duplicate === true,
          whatsapp_message_id: thread.whatsapp_message_id || result.whatsapp_message_id || null,
        } : null,
        elapsed_ms: elapsed,
      });
    } catch (err) {
      appendAuditLog({
        ...auditBase,
        success: false,
        error: err.message,
        elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, 500, { success: false, error: 'send failed', detail: err.message });
    }
  }

  const handlers = Object.freeze({
    deep_link: handleInboxDeepLink,
    message_events: handleInboxMessageEvents,
    handoffs: handleInboxHandoffs,
    handoff_review: handleInboxHandoffReview,
    send_reply: handleInboxSendReply,
  });

  const routes = Object.freeze(INBOX_ROUTE_TABLE.map((row) => ({
    ...row,
    handler: handlers[row.id],
  })));

  return {
    INBOX_PATH,
    INBOX_MESSAGE_EVENTS_PATH,
    INBOX_HANDOFFS_PATH,
    INBOX_SEND_REPLY_PATH,
    INBOX_HANDOFF_REVIEW_RE,
    INBOX_ROUTE_TABLE,
    handlers,
    routes,
    handleInboxDeepLink,
    handleInboxMessageEvents,
    handleInboxHandoffs,
    handleInboxHandoffReview,
    handleInboxSendReply,
  };
}

module.exports = {
  INBOX_PATH,
  INBOX_MESSAGE_EVENTS_PATH,
  INBOX_HANDOFFS_PATH,
  INBOX_SEND_REPLY_PATH,
  INBOX_HANDOFF_REVIEW_RE,
  INBOX_ROUTE_TABLE,
  createInboxRoutes,
};

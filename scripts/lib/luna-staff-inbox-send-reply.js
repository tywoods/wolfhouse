'use strict';

/**
 * Phase 23d — Staff Inbox explicit reply send (delegates to guest-reply-send path).
 */

const { getConversationDetailQuery } = require('./staff-conversation-queries');

const DEFAULT_CLIENT_SLUG = 'wolfhouse-somo';
const STAFF_REPLY_SOURCE = 'staff_inbox_reply';
const STAFF_REPLY_KIND = 'staff_reply';

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function simpleDraftHash(text) {
  const s = trimStr(text);
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

function buildStaffReplyIdempotencyKey(clientSlug, conversationId, messageText) {
  const client = trimStr(clientSlug) || DEFAULT_CLIENT_SLUG;
  const convId = trimStr(conversationId);
  const hash = simpleDraftHash(messageText);
  return `staff-reply:${client}:${convId}:${hash}`;
}

function normalizeGuestPhone(phone) {
  const raw = trimStr(phone);
  if (!raw) return '';
  if (raw.startsWith('+')) return raw;
  const digits = raw.replace(/[^\d]/g, '');
  return digits ? `+${digits}` : '';
}

/**
 * @returns {{ ok: boolean, error?: string, status?: number, input?: object }}
 */
function parseInboxSendReplyInput(body) {
  const src = body || {};
  const clientSlug = trimStr(src.client_slug) || DEFAULT_CLIENT_SLUG;
  const conversationId = trimStr(src.conversation_id);
  const messageText = trimStr(src.message_text);
  let to = normalizeGuestPhone(src.to);
  let idempotencyKey = trimStr(src.idempotency_key);

  if (!conversationId) {
    return { ok: false, status: 400, error: 'conversation_id required' };
  }
  if (!messageText) {
    return { ok: false, status: 400, error: 'message_text required' };
  }

  if (!idempotencyKey) {
    idempotencyKey = buildStaffReplyIdempotencyKey(clientSlug, conversationId, messageText);
  }

  return {
    ok: true,
    input: {
      client_slug: clientSlug,
      conversation_id: conversationId,
      to,
      message_text: messageText,
      idempotency_key: idempotencyKey,
    },
  };
}

/**
 * Build body for evaluateGuestReplySendRouteWithPause.
 */
function buildStaffInboxGuestReplyBody(input) {
  const i = input || {};
  return {
    client_slug: i.client_slug,
    to: i.to,
    suggested_reply: i.message_text,
    send_kind: STAFF_REPLY_KIND,
    idempotency_key: i.idempotency_key,
    source: STAFF_REPLY_SOURCE,
    draft: {},
    send_eligibility: {
      send_allowed_later: true,
      requires_staff: false,
      auto_send_ready: true,
    },
  };
}

async function resolveConversationGuestPhone(pg, clientSlug, conversationId) {
  const r = await pg.query(getConversationDetailQuery(), [clientSlug, conversationId]);
  const row = r.rows[0];
  if (!row) return { ok: false, status: 404, error: 'conversation not found' };
  const to = normalizeGuestPhone(row.phone);
  if (!to) return { ok: false, status: 400, error: 'conversation phone missing' };
  return { ok: true, to };
}

module.exports = {
  DEFAULT_CLIENT_SLUG,
  STAFF_REPLY_SOURCE,
  STAFF_REPLY_KIND,
  simpleDraftHash,
  buildStaffReplyIdempotencyKey,
  parseInboxSendReplyInput,
  buildStaffInboxGuestReplyBody,
  resolveConversationGuestPhone,
};

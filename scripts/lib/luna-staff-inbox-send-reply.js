'use strict';

/**
 * Phase 23d — Staff Inbox explicit reply send (delegates to guest-reply-send path).
 *
 * Production WhatsApp boundary (Sunset Email Slice 2):
 *   - Always load the authoritative conversation under tenant ownership
 *     (client_slug + conversation_id) before any evaluate/audit/provider send.
 *   - Never trust caller-supplied `to` as channel or destination authority.
 *   - Reject channel=email and emailv1:/legacy email: phone namespaces so they
 *     never enter WhatsApp evaluation, guest_message_sends audit, or provider send.
 *   - Reject forged `to` that does not match the conversation phone.
 *   - Preserve existing WhatsApp telephone send behavior.
 *
 * Namespace contract matches migration 067 customer-sync skip and the email
 * inbound → Inbox bridge opaque identity (`emailv1:` / legacy `email:`). This
 * module does **not** import the bridge — projection remains runtime-unwired.
 */

const { getConversationDetailQuery, isEmailInboundSubjectSchemaError } = require('./staff-conversation-queries');

const DEFAULT_CLIENT_SLUG = 'wolfhouse-somo';
const STAFF_REPLY_SOURCE = 'staff_inbox_reply';
const STAFF_REPLY_KIND = 'staff_reply';

/** Matches 067 sync_customer_from_touch skip + bridge opaque identity keys. */
const EMAIL_CHANNEL_PHONE_NAMESPACE_RE = /^(emailv1|email):/i;

const EMAIL_CHANNEL_SEND_NOT_SUPPORTED = 'email_channel_send_not_supported';
const FORGED_TO_REJECTED = 'to does not match conversation';

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

/**
 * True when a conversations.phone (or caller `to`) is an email-channel identity
 * and must never be treated as a telephone/WhatsApp destination.
 *
 * @param {unknown} phone
 * @returns {boolean}
 */
function isEmailChannelPhoneNamespace(phone) {
  if (phone == null) return false;
  const s = String(phone).trim();
  return s.length > 0 && EMAIL_CHANNEL_PHONE_NAMESPACE_RE.test(s);
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
  // Never digit-normalize email-channel identities into a fake E.164.
  if (isEmailChannelPhoneNamespace(raw)) return '';
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
  const rawTo = trimStr(src.to);
  // Keep email-namespace strings intact for boundary detection; normalize phones only.
  let to = '';
  if (rawTo) {
    to = isEmailChannelPhoneNamespace(rawTo) ? rawTo : normalizeGuestPhone(rawTo);
  }
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

/**
 * Load the authoritative conversation for Staff Inbox send under tenant ownership.
 * Does not trust caller-supplied `to` for destination or channel.
 *
 * @param {object} pg
 * @param {string} clientSlug
 * @param {string} conversationId
 * @param {string} [callerTo] optional caller-supplied `to` (forge-checked only)
 * @returns {Promise<{
 *   ok: boolean,
 *   status?: number,
 *   error?: string,
 *   code?: string,
 *   to?: string,
 *   channel?: string,
 *   conversation_id?: string,
 *   boundary_rejected?: boolean,
 * }>}
 */
async function resolveAuthoritativeInboxSendTarget(pg, clientSlug, conversationId, callerTo) {
  let r;
  try {
    r = await pg.query(getConversationDetailQuery(), [clientSlug, conversationId]);
  } catch (err) {
    if (!isEmailInboundSubjectSchemaError(err)) throw err;
    r = await pg.query(
      getConversationDetailQuery({ includeEmailSubject: false }),
      [clientSlug, conversationId],
    );
  }
  const row = r && r.rows && r.rows[0];
  if (!row) {
    return { ok: false, status: 404, error: 'conversation not found' };
  }

  const rawPhone = row.phone == null ? '' : String(row.phone).trim();
  const channelRaw = row.channel == null ? '' : String(row.channel).trim().toLowerCase();
  const channel = channelRaw || 'whatsapp';

  // Email channel or email-namespace identity: hard-stop before WhatsApp path.
  if (channel === 'email' || isEmailChannelPhoneNamespace(rawPhone)) {
    return {
      ok: false,
      status: 409,
      error: EMAIL_CHANNEL_SEND_NOT_SUPPORTED,
      code: EMAIL_CHANNEL_SEND_NOT_SUPPORTED,
      boundary_rejected: true,
      channel: 'email',
    };
  }

  const authoritativeTo = normalizeGuestPhone(rawPhone);
  if (!authoritativeTo) {
    return { ok: false, status: 400, error: 'conversation phone missing' };
  }

  const callerRaw = callerTo == null ? '' : String(callerTo).trim();
  if (callerRaw) {
    if (isEmailChannelPhoneNamespace(callerRaw)) {
      return {
        ok: false,
        status: 400,
        error: FORGED_TO_REJECTED,
        code: 'forged_to_rejected',
        boundary_rejected: true,
      };
    }
    const callerNorm = normalizeGuestPhone(callerRaw);
    if (!callerNorm || callerNorm !== authoritativeTo) {
      return {
        ok: false,
        status: 400,
        error: FORGED_TO_REJECTED,
        code: 'forged_to_rejected',
        boundary_rejected: true,
      };
    }
  }

  return {
    ok: true,
    to: authoritativeTo,
    channel,
    conversation_id: row.conversation_id || conversationId,
  };
}

/**
 * Resolve guest phone for a conversation (tenant-scoped).
 * Rejects email-channel / email-namespace identities (WhatsApp path only).
 */
async function resolveConversationGuestPhone(pg, clientSlug, conversationId) {
  const target = await resolveAuthoritativeInboxSendTarget(pg, clientSlug, conversationId, '');
  if (!target.ok) {
    return {
      ok: false,
      status: target.status || 404,
      error: target.error,
      code: target.code,
      boundary_rejected: target.boundary_rejected === true,
    };
  }
  return { ok: true, to: target.to };
}

module.exports = {
  DEFAULT_CLIENT_SLUG,
  STAFF_REPLY_SOURCE,
  STAFF_REPLY_KIND,
  EMAIL_CHANNEL_PHONE_NAMESPACE_RE,
  EMAIL_CHANNEL_SEND_NOT_SUPPORTED,
  FORGED_TO_REJECTED,
  simpleDraftHash,
  buildStaffReplyIdempotencyKey,
  normalizeGuestPhone,
  isEmailChannelPhoneNamespace,
  parseInboxSendReplyInput,
  buildStaffInboxGuestReplyBody,
  resolveAuthoritativeInboxSendTarget,
  resolveConversationGuestPhone,
};

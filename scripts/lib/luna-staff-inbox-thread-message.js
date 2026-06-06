'use strict';

/**
 * Phase 23e — Persist staff Inbox sent replies into messages thread (after send success only).
 */

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function shouldPersistStaffInboxThreadMessage(sendResult) {
  const r = sendResult || {};
  if (r.guest_message_send_status === 'blocked') return false;
  if (r.send_performed === true) return true;
  if (r.idempotent_replay === true && r.success === true && r.whatsapp_message_id) return true;
  if (r.idempotent_replay === true && r.guest_message_send_status === 'sent') return true;
  return false;
}

async function findStaffInboxThreadMessage(pg, clientSlug, conversationId, keys) {
  const k = keys || {};
  const params = [clientSlug, conversationId];
  const clauses = [];

  if (k.whatsapp_message_id) {
    params.push(k.whatsapp_message_id);
    clauses.push(`m.whatsapp_message_id = $${params.length}`);
  }
  if (k.guest_message_send_id) {
    params.push(k.guest_message_send_id);
    clauses.push(`m.metadata->>'guest_message_send_id' = $${params.length}`);
  }
  if (k.idempotency_key) {
    params.push(k.idempotency_key);
    clauses.push(`m.metadata->>'idempotency_key' = $${params.length}`);
  }
  if (!clauses.length) return null;

  const r = await pg.query(
    `SELECT m.id::text AS message_id, m.whatsapp_message_id, m.source, m.direction::text AS direction
       FROM messages m
      INNER JOIN conversations conv ON conv.id = m.conversation_id
      INNER JOIN clients c ON c.id = conv.client_id
      WHERE c.slug = $1
        AND m.conversation_id = $2::uuid
        AND (${clauses.join(' OR ')})
      LIMIT 1`,
    params,
  );
  return r.rows[0] || null;
}

/**
 * @param {object} pg
 * @param {{ client_slug: string, conversation_id: string, message_text: string, idempotency_key?: string }} input
 * @param {object} sendResult — evaluateGuestReplySendRouteWithPause result
 */
async function persistStaffInboxSentThreadMessage(pg, input, sendResult) {
  const payload = input || {};
  const result = sendResult || {};
  const clientSlug = trimStr(payload.client_slug);
  const conversationId = trimStr(payload.conversation_id);
  const messageText = trimStr(payload.message_text);

  if (!shouldPersistStaffInboxThreadMessage(result)) {
    return { ok: true, persisted: false, reason: 'not_sent' };
  }
  if (!clientSlug || !conversationId || !messageText) {
    return { ok: false, persisted: false, reason: 'missing_fields' };
  }

  const waId = trimStr(result.whatsapp_message_id) || null;
  const guestSendId = trimStr(result.guest_message_send_id) || null;
  const idemKey = trimStr(result.idempotency_key || payload.idempotency_key) || null;

  const existing = await findStaffInboxThreadMessage(pg, clientSlug, conversationId, {
    whatsapp_message_id: waId,
    guest_message_send_id: guestSendId,
    idempotency_key: idemKey,
  });
  if (existing) {
    return {
      ok: true,
      persisted: false,
      duplicate: true,
      message_id: existing.message_id,
      whatsapp_message_id: existing.whatsapp_message_id || waId,
    };
  }

  const conv = await pg.query(
    `SELECT conv.id, conv.client_id
       FROM conversations conv
      INNER JOIN clients c ON c.id = conv.client_id
      WHERE c.slug = $1 AND conv.id = $2::uuid
      LIMIT 1`,
    [clientSlug, conversationId],
  );
  if (!conv.rows[0]) {
    return { ok: true, persisted: false, reason: 'conversation_not_found' };
  }

  const clientId = conv.rows[0].client_id;
  const metadata = {
    staff_inbox_send: true,
    send_kind: 'staff_reply',
    guest_message_send_id: guestSendId,
    idempotency_key: idemKey,
  };

  let insert;
  try {
    insert = await pg.query(
      `INSERT INTO messages (
         client_id, conversation_id, direction, message_text, message_type,
         source, whatsapp_message_id, route, metadata
       ) VALUES ($1, $2, 'outbound', $3, 'text', 'staff_inbox_reply', $4, 'staff_portal', $5::jsonb)
       RETURNING id::text AS message_id, whatsapp_message_id, source, direction::text AS direction`,
      [clientId, conversationId, messageText, waId, JSON.stringify(metadata)],
    );
  } catch (err) {
    if (err && err.code === '23505' && waId) {
      const raced = await findStaffInboxThreadMessage(pg, clientSlug, conversationId, {
        whatsapp_message_id: waId,
      });
      return {
        ok: true,
        persisted: false,
        duplicate: true,
        message_id: raced && raced.message_id,
        whatsapp_message_id: waId,
      };
    }
    throw err;
  }

  if (insert.rows[0]) {
    return {
      ok: true,
      persisted: true,
      duplicate: false,
      message_id: insert.rows[0].message_id,
      whatsapp_message_id: insert.rows[0].whatsapp_message_id || waId,
      source: insert.rows[0].source,
      direction: insert.rows[0].direction,
    };
  }

  const raced = await findStaffInboxThreadMessage(pg, clientSlug, conversationId, {
    whatsapp_message_id: waId,
    guest_message_send_id: guestSendId,
    idempotency_key: idemKey,
  });
  return {
    ok: true,
    persisted: false,
    duplicate: true,
    message_id: raced && raced.message_id,
    whatsapp_message_id: waId,
  };
}

module.exports = {
  shouldPersistStaffInboxThreadMessage,
  findStaffInboxThreadMessage,
  persistStaffInboxSentThreadMessage,
};

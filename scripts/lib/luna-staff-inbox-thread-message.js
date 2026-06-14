'use strict';

/**
 * Phase 23e / Stage 28h — Persist Inbox-visible thread messages (staff sends + open-demo Meta).
 */

const OPEN_DEMO_INBOUND_SOURCE = 'open_demo_whatsapp_inbound';
const OPEN_DEMO_LIVE_REPLY_SOURCE = 'luna_open_demo_live_reply';
const HERMES_LUNA_INBOUND_SOURCE = 'hermes_luna_whatsapp_inbound';
const HERMES_LUNA_OUTBOUND_SOURCE = 'hermes_luna_whatsapp_reply';

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
async function loadConversationClientId(pg, clientSlug, conversationId) {
  const conv = await pg.query(
    `SELECT conv.id, conv.client_id
       FROM conversations conv
      INNER JOIN clients c ON c.id = conv.client_id
      WHERE c.slug = $1 AND conv.id = $2::uuid
      LIMIT 1`,
    [clientSlug, conversationId],
  );
  return conv.rows[0] || null;
}

/**
 * @param {object} pg
 * @param {{ client_slug: string, conversation_id: string, message_text: string, whatsapp_message_id?: string, wamid?: string, inbound_message_id?: string }} input
 */
async function persistOpenDemoInboundThreadMessage(pg, input) {
  const payload = input || {};
  const clientSlug = trimStr(payload.client_slug);
  const conversationId = trimStr(payload.conversation_id);
  const messageText = trimStr(payload.message_text);
  const waId = trimStr(payload.whatsapp_message_id || payload.wamid || payload.inbound_message_id) || null;

  if (!clientSlug || !conversationId || !messageText || !waId) {
    return { ok: false, persisted: false, reason: 'missing_fields' };
  }

  const existing = await findStaffInboxThreadMessage(pg, clientSlug, conversationId, {
    whatsapp_message_id: waId,
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

  const conv = await loadConversationClientId(pg, clientSlug, conversationId);
  if (!conv) {
    return { ok: true, persisted: false, reason: 'conversation_not_found' };
  }

  const metadata = {
    open_demo_inbound: true,
    inbound_message_id: waId,
    ...(payload.open_phone_testing === true ? { open_phone_testing: true } : {}),
    ...(trimStr(payload.guest_tester_class)
      ? { guest_tester_class: trimStr(payload.guest_tester_class) }
      : {}),
  };

  try {
    const insert = await pg.query(
      `INSERT INTO messages (
         client_id, conversation_id, direction, message_text, message_type,
         source, whatsapp_message_id, route, metadata
       ) VALUES ($1, $2, 'inbound', $3, 'text', $4, $5, 'whatsapp', $6::jsonb)
       RETURNING id::text AS message_id, whatsapp_message_id, source, direction::text AS direction`,
      [conv.client_id, conversationId, messageText, OPEN_DEMO_INBOUND_SOURCE, waId, JSON.stringify(metadata)],
    );
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
  } catch (err) {
    if (err && err.code === '23505') {
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

  return { ok: true, persisted: false, reason: 'insert_no_row' };
}

async function persistOutboundThreadMessage(pg, input, sendResult, options = {}) {
  const payload = input || {};
  const result = sendResult || {};
  const opts = options || {};
  const source = trimStr(opts.source) || 'staff_inbox_reply';
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

  const conv = await loadConversationClientId(pg, clientSlug, conversationId);
  if (!conv) {
    return { ok: true, persisted: false, reason: 'conversation_not_found' };
  }

  const metadata = {
    send_kind: opts.send_kind || 'staff_reply',
    guest_message_send_id: guestSendId,
    idempotency_key: idemKey,
  };
  if (source === 'staff_inbox_reply') metadata.staff_inbox_send = true;
  if (source === OPEN_DEMO_LIVE_REPLY_SOURCE) metadata.open_demo_live_reply = true;

  let insert;
  try {
    insert = await pg.query(
      `INSERT INTO messages (
         client_id, conversation_id, direction, message_text, message_type,
         source, whatsapp_message_id, route, metadata
       ) VALUES ($1, $2, 'outbound', $3, 'text', $4, $5, $6, $7::jsonb)
       RETURNING id::text AS message_id, whatsapp_message_id, source, direction::text AS direction`,
      [
        conv.client_id,
        conversationId,
        messageText,
        source,
        waId,
        opts.route || 'staff_portal',
        JSON.stringify(metadata),
      ],
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

async function persistStaffInboxSentThreadMessage(pg, input, sendResult) {
  return persistOutboundThreadMessage(pg, input, sendResult, {
    source: 'staff_inbox_reply',
    route: 'staff_portal',
    send_kind: 'staff_reply',
  });
}

async function persistOpenDemoLiveReplyThreadMessage(pg, input, sendResult) {
  return persistOutboundThreadMessage(pg, input, sendResult, {
    source: OPEN_DEMO_LIVE_REPLY_SOURCE,
    route: 'whatsapp',
    send_kind: 'luna_auto_reply',
  });
}

async function persistHermesLunaInboundThreadMessage(pg, input) {
  const payload = input || {};
  const clientSlug = trimStr(payload.client_slug);
  const conversationId = trimStr(payload.conversation_id);
  const messageText = trimStr(payload.message_text);
  const waId = trimStr(payload.whatsapp_message_id || payload.wamid) || null;

  if (!clientSlug || !conversationId || !messageText) {
    return { ok: false, persisted: false, reason: 'missing_fields' };
  }

  if (waId) {
    const existing = await findStaffInboxThreadMessage(pg, clientSlug, conversationId, {
      whatsapp_message_id: waId,
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
  }

  const conv = await loadConversationClientId(pg, clientSlug, conversationId);
  if (!conv) return { ok: true, persisted: false, reason: 'conversation_not_found' };

  const metadata = {
    hermes_luna_inbound: true,
    ...(waId ? { inbound_message_id: waId } : {}),
  };

  try {
    const insert = await pg.query(
      `INSERT INTO messages (
         client_id, conversation_id, direction, message_text, message_type,
         source, whatsapp_message_id, route, metadata
       ) VALUES ($1, $2, 'inbound', $3, 'text', $4, $5, 'whatsapp', $6::jsonb)
       RETURNING id::text AS message_id, whatsapp_message_id, source, direction::text AS direction`,
      [conv.client_id, conversationId, messageText, HERMES_LUNA_INBOUND_SOURCE, waId, JSON.stringify(metadata)],
    );
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

  return { ok: true, persisted: false, reason: 'insert_no_row' };
}

async function persistHermesLunaOutboundThreadMessage(pg, input, options) {
  const payload = input || {};
  const opts = options || {};
  const clientSlug = trimStr(payload.client_slug);
  const conversationId = trimStr(payload.conversation_id);
  const messageText = trimStr(payload.message_text);
  const waId = trimStr(payload.whatsapp_message_id) || null;
  const idemKey = trimStr(opts.idempotency_key || payload.idempotency_key) || null;

  if (!clientSlug || !conversationId || !messageText) {
    return { ok: false, persisted: false, reason: 'missing_fields' };
  }

  const existing = await findStaffInboxThreadMessage(pg, clientSlug, conversationId, {
    whatsapp_message_id: waId,
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

  const conv = await loadConversationClientId(pg, clientSlug, conversationId);
  if (!conv) return { ok: true, persisted: false, reason: 'conversation_not_found' };

  const metadata = {
    hermes_luna_reply: true,
    send_kind: 'luna_auto_reply',
    ...(idemKey ? { idempotency_key: idemKey } : {}),
  };

  try {
    const insert = await pg.query(
      `INSERT INTO messages (
         client_id, conversation_id, direction, message_text, message_type,
         source, whatsapp_message_id, route, metadata
       ) VALUES ($1, $2, 'outbound', $3, 'text', $4, $5, 'whatsapp', $6::jsonb)
       RETURNING id::text AS message_id, whatsapp_message_id, source, direction::text AS direction`,
      [
        conv.client_id,
        conversationId,
        messageText,
        HERMES_LUNA_OUTBOUND_SOURCE,
        waId,
        JSON.stringify(metadata),
      ],
    );
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
  } catch (err) {
    if (err && err.code === '23505') {
      const raced = await findStaffInboxThreadMessage(pg, clientSlug, conversationId, {
        whatsapp_message_id: waId,
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
    throw err;
  }

  return { ok: true, persisted: false, reason: 'insert_no_row' };
}

module.exports = {
  OPEN_DEMO_INBOUND_SOURCE,
  OPEN_DEMO_LIVE_REPLY_SOURCE,
  HERMES_LUNA_INBOUND_SOURCE,
  HERMES_LUNA_OUTBOUND_SOURCE,
  shouldPersistStaffInboxThreadMessage,
  findStaffInboxThreadMessage,
  persistOpenDemoInboundThreadMessage,
  persistOpenDemoLiveReplyThreadMessage,
  persistHermesLunaInboundThreadMessage,
  persistHermesLunaOutboundThreadMessage,
  persistStaffInboxSentThreadMessage,
};

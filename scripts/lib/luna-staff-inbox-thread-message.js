'use strict';

/**
 * Phase 23e / Stage 28h — Persist Inbox-visible thread messages (staff sends + open-demo Meta).
 */

const crypto = require('node:crypto');
const { emitInboxConversationUpdated } = require('./staff-inbox-live-events');
const { clearConfirmationOwedOnDelivery } = require('./staff-booking-confirmation-owed');
const { SUNSET_CLIENT_SLUG, sqlConversationLocationExpr } = require('./sunset-school-locations');

const OPEN_DEMO_INBOUND_SOURCE = 'open_demo_whatsapp_inbound';
const OPEN_DEMO_LIVE_REPLY_SOURCE = 'luna_open_demo_live_reply';
const HERMES_LUNA_INBOUND_SOURCE = 'hermes_luna_whatsapp_inbound';
const HERMES_LUNA_OUTBOUND_SOURCE = 'hermes_luna_whatsapp_reply';
const CROWSNEST_SYNTHETIC_CONFIRMATION_SOURCE = 'crowsnest_simulator_confirmation';
const CROWSNEST_SYNTHETIC_INTERVENTION_SOURCE = 'crowsnest_simulator_staff_intervention';

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function deterministicThreadMessageId(clientSlug, conversationId, source, idempotencyKey) {
  if (!idempotencyKey) return null;
  const hex = crypto.createHash('sha256')
    .update([clientSlug, conversationId, source, idempotencyKey].join('\u001f'))
    .digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

function notifyInboxIfPersisted(input, result) {
  if (!result || result.persisted !== true) return result;
  emitInboxConversationUpdated(
    trimStr(input && input.client_slug),
    trimStr(input && input.conversation_id),
  );
  return result;
}

function withInboxLiveNotify(fn) {
  return async function inboxLiveNotifyWrap(pg, input, ...rest) {
    const result = await fn(pg, input, ...rest);
    return notifyInboxIfPersisted(input, result);
  };
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
      WHERE (c.slug = $1 OR (c.slug = '${SUNSET_CLIENT_SLUG}' AND ${sqlConversationLocationExpr('conv')} = $1))
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
      WHERE (c.slug = $1 OR (c.slug = '${SUNSET_CLIENT_SLUG}' AND ${sqlConversationLocationExpr('conv')} = $1))
        AND conv.id = $2::uuid
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

  const deterministicId = deterministicThreadMessageId(clientSlug, conversationId, source, idemKey);
  let insert;
  try {
    const insertSql = deterministicId
      ? `INSERT INTO messages (
         client_id, conversation_id, direction, message_text, message_type,
         source, whatsapp_message_id, route, metadata, id
       ) VALUES ($1, $2, 'outbound', $3, 'text', $4, $5, $6, $7::jsonb, $8::uuid)
       ON CONFLICT (id) DO NOTHING
       RETURNING id::text AS message_id, whatsapp_message_id, source, direction::text AS direction`
      : `INSERT INTO messages (
         client_id, conversation_id, direction, message_text, message_type,
         source, whatsapp_message_id, route, metadata
       ) VALUES ($1, $2, 'outbound', $3, 'text', $4, $5, $6, $7::jsonb)
       RETURNING id::text AS message_id, whatsapp_message_id, source, direction::text AS direction`;
    const insertParams = [
      conv.client_id,
      conversationId,
      messageText,
      source,
      waId,
      opts.route || 'staff_portal',
      JSON.stringify(metadata),
    ];
    if (deterministicId) insertParams.push(deterministicId);
    insert = await pg.query(insertSql, insertParams);
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

async function persistCrowsnestSyntheticInterventionThreadMessage(pg, input) {
  return persistOutboundThreadMessage(pg, input, {
    success: true,
    send_performed: true,
    idempotency_key: input && input.idempotency_key,
  }, {
    source: CROWSNEST_SYNTHETIC_INTERVENTION_SOURCE,
    route: 'staff_portal',
    send_kind: 'simulator_staff_intervention',
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
      const messageId = insert.rows[0].message_id;
      let initialAlertEventKey = null;
      let initialAlertClaimError = false;
      try {
        const claimed = await pg.query(
          `UPDATE conversations conv
              SET first_eligible_inbound_message_id = $3::uuid,
                  updated_at = NOW()
             FROM clients c, messages m
            WHERE conv.client_id = c.id
              AND c.slug = $1
              AND conv.id = $2::uuid
              AND conv.first_eligible_inbound_message_id IS NULL
              AND m.id = $3::uuid
              AND m.conversation_id = conv.id
              AND m.client_id = conv.client_id
              AND m.direction = 'inbound'
              AND m.source = 'hermes_luna_whatsapp_inbound'
              AND COALESCE((conv.metadata->>'simulator_synthetic')::boolean, FALSE) = FALSE
          RETURNING conv.first_eligible_inbound_message_id::text AS initial_alert_event_key`,
          [clientSlug, conversationId, messageId],
        );
        initialAlertEventKey = claimed.rows[0] && claimed.rows[0].initial_alert_event_key || null;
      } catch (_) {
        initialAlertClaimError = true;
      }
      return {
        ok: true,
        persisted: true,
        duplicate: false,
        message_id: messageId,
        initial_alert_event_key: initialAlertEventKey,
        initial_alert_claim_error: initialAlertClaimError,
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

  if (!waId) {
    return { ok: true, persisted: false, reason: 'missing_whatsapp_message_id' };
  }

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

/** Persist a simulator-only Staff Inbox bubble without pretending Meta sent it. */
async function persistCrowsnestSyntheticConfirmationThreadMessage(pg, input) {
  const payload = input || {};
  const clientSlug = trimStr(payload.client_slug);
  const conversationId = trimStr(payload.conversation_id);
  const messageText = trimStr(payload.message_text);
  const idemKey = trimStr(payload.idempotency_key);
  if (!clientSlug || !conversationId || !messageText || !idemKey) {
    return { ok: false, persisted: false, reason: 'missing_synthetic_fields' };
  }

  // Session lock serializes the tenant/conversation/key read+insert pair even when
  // this owner is called outside a DB transaction. No provider ID is manufactured.
  const lockKey = `${clientSlug}:${conversationId}:${idemKey}`;
  await pg.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
  try {
    const existing = await findStaffInboxThreadMessage(pg, clientSlug, conversationId, {
      idempotency_key: idemKey,
    });
    if (existing) {
      return {
        ok: true, persisted: false, duplicate: true, message_id: existing.message_id,
        source: existing.source || CROWSNEST_SYNTHETIC_CONFIRMATION_SOURCE,
      };
    }
    const conv = await loadConversationClientId(pg, clientSlug, conversationId);
    if (!conv) return { ok: true, persisted: false, reason: 'conversation_not_found' };
    const metadata = {
      idempotency_key: idemKey,
      simulator_synthetic: true,
      provider_send_performed: false,
      audit_source: CROWSNEST_SYNTHETIC_CONFIRMATION_SOURCE,
      booking_id: trimStr(payload.booking_id) || null,
    };
    const insert = await pg.query(
      `INSERT INTO messages (
         client_id, conversation_id, direction, message_text, message_type,
         source, whatsapp_message_id, route, metadata
       ) VALUES ($1, $2, 'outbound', $3, 'text', $4, NULL, 'staff_portal', $5::jsonb)
       RETURNING id::text AS message_id, source, direction::text AS direction`,
      [conv.client_id, conversationId, messageText, CROWSNEST_SYNTHETIC_CONFIRMATION_SOURCE,
        JSON.stringify(metadata)],
    );
    const row = insert.rows[0];
    return row
      ? {
        ok: true, persisted: true, duplicate: false, message_id: row.message_id,
        source: row.source, direction: row.direction,
      }
      : { ok: true, persisted: false, reason: 'insert_no_row' };
  } finally {
    await pg.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]);
  }
}

/** Atomically receipt only the exact simulator row owned by this tenant/thread. */
async function receiptCrowsnestSyntheticConfirmationThreadMessage(pg, input) {
  const payload = input || {};
  const clientSlug = trimStr(payload.client_slug);
  const conversationId = trimStr(payload.conversation_id);
  const messageId = trimStr(payload.message_id);
  if (!clientSlug || !conversationId || !messageId) {
    return { ok: false, status: 400, error: 'receipt_identity_required' };
  }
  const args = [clientSlug, conversationId, messageId, CROWSNEST_SYNTHETIC_CONFIRMATION_SOURCE];
  const changed = await pg.query(
    `UPDATE messages m
        SET metadata = COALESCE(m.metadata, '{}'::jsonb)
          || jsonb_build_object('consumer_receipt', true, 'consumer_receipted_at', to_jsonb(NOW()))
       FROM conversations conv JOIN clients c ON c.id = conv.client_id
      WHERE m.id = $3::uuid AND m.conversation_id = conv.id AND conv.id = $2::uuid
        AND m.client_id = c.id AND c.slug = $1 AND m.source = $4
        AND COALESCE(m.metadata->>'consumer_receipt', '') IS DISTINCT FROM 'true'
      RETURNING m.id::text AS message_id, m.conversation_id::text AS conversation_id, m.source, m.metadata`,
    args,
  );
  if (changed.rows[0]) {
    const message = changed.rows[0];
    const bookingId = trimStr(message.metadata && message.metadata.booking_id);
    let reconciled = { cleared: false, reason: 'not_booking_confirmation' };
    if (bookingId) {
      reconciled = await clearConfirmationOwedOnDelivery(pg, {
        provider_message_id: `simulator:${message.message_id}`,
        delivery_status: 'delivered',
        booking_id: bookingId,
        client_slug: clientSlug,
      });
    }
    return {
      ok: true,
      changed: true,
      message,
      confirmation_owed_cleared: reconciled.cleared === true,
    };
  }
  const exact = await pg.query(
    `SELECT m.id::text AS message_id, m.conversation_id::text AS conversation_id, m.source, m.metadata
       FROM messages m JOIN conversations conv ON conv.id = m.conversation_id
       JOIN clients c ON c.id = conv.client_id
      WHERE c.slug = $1 AND conv.id = $2::uuid AND m.id = $3::uuid
        AND m.client_id = c.id AND m.source = $4 LIMIT 1`, args);
  if (!exact.rows[0]) return { ok: false, status: 404, error: 'simulator_message_not_found' };
  return { ok: true, changed: false, message: exact.rows[0], confirmation_owed_cleared: false };
}

module.exports = {
  OPEN_DEMO_INBOUND_SOURCE,
  OPEN_DEMO_LIVE_REPLY_SOURCE,
  HERMES_LUNA_INBOUND_SOURCE,
  HERMES_LUNA_OUTBOUND_SOURCE,
  CROWSNEST_SYNTHETIC_CONFIRMATION_SOURCE,
  CROWSNEST_SYNTHETIC_INTERVENTION_SOURCE,
  shouldPersistStaffInboxThreadMessage,
  findStaffInboxThreadMessage,
  persistOpenDemoInboundThreadMessage: withInboxLiveNotify(persistOpenDemoInboundThreadMessage),
  persistOpenDemoLiveReplyThreadMessage: withInboxLiveNotify(persistOpenDemoLiveReplyThreadMessage),
  persistHermesLunaInboundThreadMessage: withInboxLiveNotify(persistHermesLunaInboundThreadMessage),
  persistHermesLunaOutboundThreadMessage: withInboxLiveNotify(persistHermesLunaOutboundThreadMessage),
  persistCrowsnestSyntheticConfirmationThreadMessage:
    withInboxLiveNotify(persistCrowsnestSyntheticConfirmationThreadMessage),
  receiptCrowsnestSyntheticConfirmationThreadMessage,
  persistStaffInboxSentThreadMessage: withInboxLiveNotify(persistStaffInboxSentThreadMessage),
  persistCrowsnestSyntheticInterventionThreadMessage:
    withInboxLiveNotify(persistCrowsnestSyntheticInterventionThreadMessage),
};

'use strict';

/**
 * Mirror Hermes Agent Luna WhatsApp turns into Staff Portal inbox (messages table).
 * Called by POST /staff/bot/whatsapp-thread-mirror (bot token auth).
 */

const {
  persistHermesLunaInboundThreadMessage,
  persistHermesLunaOutboundThreadMessage,
} = require('./luna-staff-inbox-thread-message');
const {
  mergeSunsetInboundLocationMetadata,
  extractSunsetChannelHintsFromNormalized,
} = require('./sunset-inbox-channel-config');
const {
  maybeNotifyNewConversation,
  maybeNotifyHumanNeeded,
  extractLocationFromMetadata,
} = require('./staff-whatsapp-notifications');

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function normalizeGuestPhone(phone) {
  const raw = trimStr(phone);
  if (!raw) return '';
  if (raw.startsWith('+')) return raw;
  const digits = raw.replace(/[^\d]/g, '');
  return digits ? `+${digits}` : '';
}

function toBool(v) {
  if (v === true) return true;
  if (v === false || v == null) return false;
  const s = trimStr(v).toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

/** WhatsApp does not render markdown links — flatten before mirror persist. */
function normalizeWhatsAppMessageText(text) {
  const raw = trimStr(text);
  if (!raw) return raw;
  return raw.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi, (_, label, url) => {
    const l = trimStr(label);
    const u = trimStr(url);
    if (!u) return _;
    if (!l || l === u) return u;
    return `${l}: ${u}`;
  });
}

function parseHermesWhatsAppThreadMirrorBody(body) {
  const src = body || {};
  const clientSlug = trimStr(src.client_slug) || 'wolfhouse-somo';
  const guestPhone = normalizeGuestPhone(src.guest_phone || src.phone || src.from);
  const direction = trimStr(src.direction).toLowerCase();
  let messageText = trimStr(src.message_text);
  if (direction === 'outbound') messageText = normalizeWhatsAppMessageText(messageText);
  const whatsappMessageId = trimStr(src.whatsapp_message_id || src.wamid || src.inbound_message_id) || null;
  const idempotencyKey = trimStr(src.idempotency_key) || null;
  const contactName = trimStr(src.contact_name || src.profile_name) || null;
  const receivingWhatsappNumber = trimStr(
    src.receiving_whatsapp_number || src.display_phone_number || src.whatsapp_number,
  ) || null;
  const phoneNumberId = trimStr(src.phone_number_id) || null;
  const needsHuman = toBool(src.needs_human);
  const handoffReason = trimStr(src.handoff_reason || src.needs_human_reason) || null;

  if (!guestPhone) return { ok: false, status: 400, error: 'guest_phone required' };
  if (!messageText) return { ok: false, status: 400, error: 'message_text required' };
  if (direction !== 'inbound' && direction !== 'outbound') {
    return { ok: false, status: 400, error: 'direction must be inbound or outbound' };
  }

  return {
    ok: true,
    input: {
      client_slug: clientSlug,
      guest_phone: guestPhone,
      direction,
      message_text: messageText,
      whatsapp_message_id: whatsappMessageId,
      idempotency_key: idempotencyKey,
      contact_name: contactName,
      receiving_whatsapp_number: receivingWhatsappNumber,
      phone_number_id: phoneNumberId,
      needs_human: needsHuman,
      handoff_reason: handoffReason,
    },
  };
}

async function ensureConversationForGuestPhone(pg, clientSlug, guestPhone, contactName, previewText, channelHints) {
  const phone = normalizeGuestPhone(guestPhone);
  const clientR = await pg.query('SELECT id FROM clients WHERE slug = $1 LIMIT 1', [clientSlug]);
  if (!clientR.rows[0]) return null;
  const clientId = clientR.rows[0].id;
  const preview = trimStr(previewText) || trimStr(contactName) || phone;
  const metadata = mergeSunsetInboundLocationMetadata(
    { channel: 'whatsapp', hermes_luna: true },
    extractSunsetChannelHintsFromNormalized({
      channel: 'whatsapp',
      receiving_whatsapp_number: channelHints && channelHints.receiving_whatsapp_number,
      phone_number_id: channelHints && channelHints.phone_number_id,
    }),
    clientSlug,
  );
  const existing = await pg.query(
    `SELECT id::text AS conversation_id FROM conversations WHERE client_id = $1 AND phone = $2 LIMIT 1`,
    [clientId, phone],
  );
  const created = existing.rows.length === 0;
  const ins = await pg.query(
    `INSERT INTO conversations (
       client_id, phone, status, bot_mode, conversation_stage, metadata, last_message_preview
     ) VALUES (
       $1, $2, 'open'::conversation_status, 'bot'::bot_mode, 'guest_whatsapp_inbound',
       $3::jsonb, $4
     )
     ON CONFLICT (client_id, phone) DO UPDATE SET
       metadata = conversations.metadata || EXCLUDED.metadata,
       last_message_preview = EXCLUDED.last_message_preview,
       updated_at = NOW()
     RETURNING id::text AS conversation_id`,
    [clientId, phone, JSON.stringify(metadata), preview.slice(0, 500)],
  );
  const conversationId = ins.rows[0] && ins.rows[0].conversation_id;
  if (!conversationId) return null;
  return {
    conversation_id: conversationId,
    created,
    metadata,
    guest_phone: phone,
    guest_name: trimStr(contactName) || null,
    location_id: extractLocationFromMetadata(metadata),
  };
}

async function mirrorHermesWhatsAppThreadMessage(pg, input, opts = {}) {
  const i = input || {};
  const env = (opts && opts.env) || process.env;
  const notifyContext = (opts && opts.notify_context) || {};
  const ensured = await ensureConversationForGuestPhone(
    pg,
    i.client_slug,
    i.guest_phone,
    i.contact_name,
    i.message_text,
    {
      receiving_whatsapp_number: i.receiving_whatsapp_number,
      phone_number_id: i.phone_number_id,
    },
  );
  if (!ensured || !ensured.conversation_id) {
    return { ok: false, persisted: false, reason: 'conversation_not_found' };
  }
  const conversationId = ensured.conversation_id;

  const base = {
    client_slug: i.client_slug,
    conversation_id: conversationId,
    message_text: i.message_text,
    whatsapp_message_id: i.whatsapp_message_id,
    idempotency_key: i.idempotency_key,
  };

  let staff_notification = null;

  if (i.direction === 'inbound') {
    const thread = await persistHermesLunaInboundThreadMessage(pg, base);
    staff_notification = await maybeNotifyNewConversation(pg, env, {
      created: ensured.created === true,
      client_slug: i.client_slug,
      location_id: ensured.location_id,
      conversation_id: conversationId,
      guest_phone: ensured.guest_phone,
      guest_name: ensured.guest_name,
    }, notifyContext);
    return {
      ok: true,
      conversation_id: conversationId,
      direction: 'inbound',
      thread,
      staff_notification,
    };
  }

  const thread = await persistHermesLunaOutboundThreadMessage(pg, base, {
    idempotency_key: i.idempotency_key,
  });
  if (i.needs_human === true) {
    const reason = trimStr(i.handoff_reason) || 'luna_team_review_reply';
    const handoffAt = new Date().toISOString();
    const prior = await pg.query(
      `SELECT needs_human FROM conversations WHERE id = $1::uuid LIMIT 1`,
      [conversationId],
    );
    const wasNeedsHuman = prior.rows[0] && prior.rows[0].needs_human === true;
    await pg.query(
      `UPDATE conversations
          SET needs_human = TRUE,
              metadata = COALESCE(metadata, '{}'::jsonb)
                || jsonb_build_object('needs_human_reason', $2::text, 'luna_handoff_at', to_jsonb($3::text)),
              updated_at = NOW()
        WHERE id = $1`,
      [conversationId, reason, handoffAt],
    );
    if (!wasNeedsHuman) {
      staff_notification = await maybeNotifyHumanNeeded(pg, env, {
        transitioned: true,
        handoff_event_key: handoffAt,
        client_slug: i.client_slug,
        location_id: ensured.location_id,
        conversation_id: conversationId,
        guest_phone: ensured.guest_phone,
        guest_name: ensured.guest_name,
        reason,
      }, notifyContext);
    }
  }
  return {
    ok: true,
    conversation_id: conversationId,
    direction: 'outbound',
    thread,
    staff_notification,
  };
}

module.exports = {
  parseHermesWhatsAppThreadMirrorBody,
  ensureConversationForGuestPhone,
  mirrorHermesWhatsAppThreadMessage,
};

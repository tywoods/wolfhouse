'use strict';

/**
 * Stage 56i — Persist Luna handoff state (needs_human) when staff handoff reply is sent.
 */

const {
  maybeNotifyHumanNeeded,
  extractLocationFromMetadata,
} = require('./staff-whatsapp-notifications');

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function parseMetadata(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

/** True for composer/personality staff handoff copy — not gate-blocked pause messages. */
function isGenuineLunaHandoffReply(text) {
  const t = String(text || '');
  return /looping in our(?:\s+Wolfhouse)?\s+team/i.test(t)
    || /passing this to our team/i.test(t)
    || /connect you with our team/i.test(t)
    || /(?:wolfhouse|our)\s+team.*(?:follow up|help with|next step)/i.test(t);
}

function conversationHasLunaAutoHandoff(convRow) {
  if (!convRow || convRow.needs_human !== true) return false;
  const meta = parseMetadata(convRow.metadata);
  return !!(meta.luna_handoff_at || meta.luna_handoff_reason);
}

/** Guest explicitly starts a new booking — resume Luna after auto handoff only. */
function detectNewBookingStartMessage(messageText) {
  const t = String(messageText || '').trim().toLowerCase();
  if (!t) return false;
  return /\b(?:book(?:\s+a)?\s+(?:room|stay|bed|spot|trip|package)|lets?\s+book|i\s+(?:want|would like)\s+to\s+book|looking\s+to\s+book|make\s+a\s+booking|reserve\s+a\s+(?:room|stay|bed))\b/i.test(t);
}

/** Resume Luna after a mistaken auto-handoff when the guest re-opens naturally. */
function detectHandoffResumeMessage(messageText) {
  if (detectNewBookingStartMessage(messageText)) return true;
  try {
    const { isGreetingOnlyMessage } = require('./luna-guest-message-router');
    if (isGreetingOnlyMessage(messageText)) return true;
  } catch (_) { /* noop */ }
  return false;
}

/**
 * @param {import('pg').Client} pg
 * @param {{ conversation_id?: string, client_slug: string, phone?: string, guest_phone?: string, reason?: string, handoff_reasons?: string[] }} input
 */
async function markConversationNeedsHumanByPhone(pg, input, opts = {}) {
  const inp = input || {};
  const clientSlug = trimStr(inp.client_slug) || 'wolfhouse-somo';
  const phone = trimStr(inp.phone || inp.guest_phone);
  const digits = phone.replace(/\D/g, '');
  if (!digits || digits.length < 9) {
    return { ok: false, needs_human: false, reason: 'phone_invalid_or_too_short' };
  }
  const suffix = digits.slice(-9);
  const reasons = Array.isArray(inp.handoff_reasons) ? inp.handoff_reasons : [];
  const reasonCode = trimStr(inp.reason)
    || (reasons.length ? String(reasons[0]) : 'luna_safe_handoff');

  const find = await pg.query(
    `SELECT conv.id::text AS conversation_id
       FROM conversations conv
      INNER JOIN clients c ON c.id = conv.client_id
      WHERE c.slug = $1
        AND (
          regexp_replace(conv.phone, '\\D', '', 'g') = $3
          OR regexp_replace(conv.phone, '\\D', '', 'g') LIKE $2
        )
      ORDER BY conv.updated_at DESC
      LIMIT 1`,
    [clientSlug, `%${suffix}`, digits],
  );
  if (!find.rows[0]) {
    return { ok: false, needs_human: false, reason: 'conversation_not_found_for_phone' };
  }
  return markConversationNeedsHuman(pg, {
    conversation_id: find.rows[0].conversation_id,
    client_slug: clientSlug,
    reason: reasonCode,
    handoff_reasons: inp.handoff_reasons,
  }, opts);
}

/**
 * Resolve conversation from UUID id or WhatsApp phone and flag needs_human.
 *
 * @param {import('pg').Client} pg
 * @param {{ conversation_id?: string, client_slug: string, phone?: string, guest_phone?: string, reason?: string, handoff_reasons?: string[], uuid_validate_re?: RegExp }} input
 */
async function resolveAndMarkConversationNeedsHuman(pg, input) {
  const inp = input || {};
  const convIdRaw = trimStr(inp.conversation_id);
  const uuidRe = inp.uuid_validate_re || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (convIdRaw && uuidRe.test(convIdRaw)) {
    return markConversationNeedsHuman(pg, {
      conversation_id: convIdRaw,
      client_slug: inp.client_slug,
      reason: inp.reason,
      handoff_reasons: inp.handoff_reasons,
    });
  }
  return markConversationNeedsHumanByPhone(pg, inp);
}

/**
 * @param {import('pg').Client} pg
 * @param {{ conversation_id: string, client_slug: string, reason?: string, handoff_reasons?: string[] }} input
 */
async function markConversationNeedsHuman(pg, input, opts = {}) {
  const inp = input || {};
  const conversationId = trimStr(inp.conversation_id);
  const clientSlug = trimStr(inp.client_slug) || 'wolfhouse-somo';
  const env = (opts && opts.env) || process.env;
  const notifyContext = (opts && opts.notify_context) || {};
  if (!pg || !conversationId) {
    return { ok: false, needs_human: false, reason: 'missing_pg_or_conversation_id' };
  }

  const reasons = Array.isArray(inp.handoff_reasons) ? inp.handoff_reasons : [];
  const reasonCode = trimStr(inp.reason)
    || (reasons.length ? String(reasons[0]) : 'luna_safe_handoff');

  const prior = await pg.query(
    `SELECT conv.needs_human, conv.phone, conv.display_name, conv.metadata
       FROM conversations conv
       JOIN clients c ON c.id = conv.client_id
      WHERE c.slug = $1 AND conv.id = $2::uuid
      LIMIT 1`,
    [clientSlug, conversationId],
  );
  const priorRow = prior.rows[0];
  if (!priorRow) {
    return { ok: false, needs_human: false, reason: 'conversation_not_found' };
  }
  const wasNeedsHuman = priorRow.needs_human === true;
  const handoffAt = new Date().toISOString();

  const res = await pg.query(
    `UPDATE conversations conv
        SET needs_human = TRUE,
            updated_at = NOW(),
            metadata = COALESCE(conv.metadata, '{}'::jsonb)
              || jsonb_build_object(
                'luna_handoff_at', to_jsonb($4::text),
                'luna_handoff_reason', to_jsonb($3::text)
              )
       FROM clients c
      WHERE conv.client_id = c.id
        AND c.slug = $1
        AND conv.id = $2::uuid
      RETURNING conv.id::text AS conversation_id, conv.needs_human`,
    [clientSlug, conversationId, reasonCode.slice(0, 200), handoffAt],
  );

  const row = res.rows[0];
  if (!row) {
    return { ok: false, needs_human: false, reason: 'conversation_not_found' };
  }

  let staff_notification = null;
  if (!wasNeedsHuman) {
    const locationId = extractLocationFromMetadata(priorRow.metadata);
    staff_notification = await maybeNotifyHumanNeeded(pg, env, {
      transitioned: true,
      handoff_event_key: handoffAt,
      client_slug: clientSlug,
      location_id: locationId,
      conversation_id: row.conversation_id,
      guest_phone: priorRow.phone,
      guest_name: priorRow.display_name,
      reason: reasonCode,
    }, notifyContext);
  }

  return {
    ok: true,
    needs_human: row.needs_human === true,
    conversation_id: row.conversation_id,
    handoff_reason: reasonCode,
    staff_notification,
  };
}

/**
 * Clear needs_human when guest explicitly restarts booking (e.g. "book a room").
 * Only clears rows that Luna auto-flagged — staff manual inbox toggles are left alone.
 *
 * @param {import('pg').Client} pg
 * @param {{ conversation_id: string, client_slug: string, conv_row?: object }} input
 */
async function clearLunaAutoHandoffIfPresent(pg, input) {
  const inp = input || {};
  const conversationId = trimStr(inp.conversation_id);
  const clientSlug = trimStr(inp.client_slug) || 'wolfhouse-somo';
  const convRow = inp.conv_row;
  if (!pg || !conversationId) {
    return { cleared: false, reason: 'missing_pg_or_conversation_id' };
  }
  if (!convRow || convRow.needs_human !== true) {
    return { cleared: false, reason: 'not_needs_human' };
  }
  if (!conversationHasLunaAutoHandoff(convRow)) {
    return { cleared: false, reason: 'staff_manual_needs_human' };
  }

  const res = await pg.query(
    `UPDATE conversations conv
        SET needs_human = FALSE,
            updated_at = NOW(),
            metadata = COALESCE(conv.metadata, '{}'::jsonb)
              - 'luna_handoff_at'
              - 'luna_handoff_reason'
       FROM clients c
      WHERE conv.client_id = c.id
        AND c.slug = $1
        AND conv.id = $2::uuid
        AND conv.needs_human = TRUE
      RETURNING conv.id::text AS conversation_id, conv.needs_human`,
    [clientSlug, conversationId],
  );

  const row = res.rows[0];
  if (!row) {
    return { cleared: false, reason: 'not_updated' };
  }
  return { cleared: true, needs_human: row.needs_human === false, conversation_id: row.conversation_id };
}

module.exports = {
  isGenuineLunaHandoffReply,
  conversationHasLunaAutoHandoff,
  detectNewBookingStartMessage,
  detectHandoffResumeMessage,
  markConversationNeedsHuman,
  markConversationNeedsHumanByPhone,
  resolveAndMarkConversationNeedsHuman,
  clearLunaAutoHandoffIfPresent,
};

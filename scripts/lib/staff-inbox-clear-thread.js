/**
 * Inbox Clear — conversation-scoped Luna/Hermes session reset.
 *
 * Binding: selected conversations.id + client slug → WhatsApp phone digits →
 * the live Hermes session_key for that source. Shared-memory deletion and
 * phone-wide session listing are out of scope (see reset_session_key_only).
 *
 * needs_human is conversation session state and is cleared only after the
 * Hermes session-key reset succeeds, and only for this conversation.
 *
 * @module staff-inbox-clear-thread
 */

'use strict';

const SQL_LOOKUP_CONVERSATION = `
SELECT conv.id::text AS conversation_id,
       conv.phone,
       conv.email,
       conv.display_name,
       conv.status,
       conv.needs_human
  FROM conversations conv
  INNER JOIN clients c ON c.id = conv.client_id
 WHERE c.slug = $1
   AND conv.id = $2::uuid
 LIMIT 1`;

const SQL_SIBLING_SAME_PHONE = `
SELECT conv.id::text AS conversation_id,
       c.slug AS client_slug
  FROM conversations conv
  INNER JOIN clients c ON c.id = conv.client_id
 WHERE regexp_replace(COALESCE(conv.phone, ''), '\\D', '', 'g') = $1
   AND conv.id <> $2::uuid`;

const SQL_CLEAR_NEEDS_HUMAN = `
UPDATE conversations conv
   SET needs_human = FALSE,
       updated_at = NOW(),
       metadata = COALESCE(conv.metadata, '{}'::jsonb)
         - 'luna_handoff_at'
         - 'luna_handoff_reason'
         - 'needs_human_reason'
  FROM clients c
 WHERE conv.client_id = c.id
   AND c.slug = $1
   AND conv.id = $2::uuid
 RETURNING conv.id::text AS conversation_id, conv.needs_human`;

function digitsOf(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function isWhatsAppSessionPhone(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return false;
  if (/^(emailv1|email|emailcust1):/i.test(raw)) return false;
  if (raw.includes('@') || raw.includes(':')) return false;
  const digits = digitsOf(raw);
  return digits.length >= 6 && digits.length <= 20;
}

function toGuestPhone(phone) {
  const digits = digitsOf(phone);
  return digits ? `+${digits}` : null;
}

async function lookupInboxClearThreadBinding(pg, clientSlug, convId) {
  if (!pg || !clientSlug || !convId) {
    return { found: false, ok: false, reason: 'missing_args' };
  }
  const sel = await pg.query(SQL_LOOKUP_CONVERSATION, [clientSlug, convId]);
  if (!sel.rows.length) {
    return { found: false, ok: false, reason: 'conversation_not_found' };
  }
  const row = sel.rows[0];
  const phone = row.phone || null;
  if (!isWhatsAppSessionPhone(phone)) {
    return {
      found: true,
      ok: false,
      reason: 'not_whatsapp_session',
      conversation_id: row.conversation_id,
      guest_phone: phone,
      needs_human: row.needs_human === true,
    };
  }
  const digits = digitsOf(phone);
  const siblings = await pg.query(SQL_SIBLING_SAME_PHONE, [digits, convId]);
  if (siblings.rows.length) {
    return {
      found: true,
      ok: false,
      reason: 'shared_session_binding',
      conversation_id: row.conversation_id,
      guest_phone: toGuestPhone(phone),
      digits,
      needs_human: row.needs_human === true,
      siblings: siblings.rows,
    };
  }
  return {
    found: true,
    conversation_id: row.conversation_id,
    guest_phone: toGuestPhone(phone),
    digits,
    needs_human: row.needs_human === true,
    identity: {
      phone: row.phone,
      email: row.email,
      display_name: row.display_name,
      status: row.status,
    },
  };
}

async function clearInboxClearThreadNeedsHuman(pg, clientSlug, convId) {
  const upd = await pg.query(SQL_CLEAR_NEEDS_HUMAN, [clientSlug, convId]);
  const row = upd.rows[0];
  if (!row) return { ok: false, reason: 'not_updated' };
  return { ok: true, conversation_id: row.conversation_id, needs_human: row.needs_human === true };
}

async function performInboxClearThreadReset(opts) {
  const input = opts || {};
  const binding = await lookupInboxClearThreadBinding(input.pg, input.clientSlug, input.convId);
  if (!binding.found || binding.ok === false) {
    return Object.assign({ hermes_session_reset: { attempted: false }, needs_human_cleared: false }, binding);
  }
  if (typeof input.resetHermesConversationSession !== 'function') {
    return Object.assign({}, binding, {
      ok: false,
      reason: 'missing_hermes_reset',
      hermes_session_reset: { attempted: false },
      needs_human_cleared: false,
    });
  }
  const hermes = await input.resetHermesConversationSession(binding.guest_phone, {
    conversation_id: input.convId,
    scope: 'session_key',
  });
  if (!hermes || hermes.ok !== true) {
    return Object.assign({}, binding, {
      ok: false,
      reason: (hermes && (hermes.reason || hermes.error)) || 'hermes_reset_failed',
      hermes_session_reset: hermes || { attempted: true, ok: false },
      needs_human_cleared: false,
    });
  }
  let needsHumanCleared = false;
  if (binding.needs_human === true) {
    const cleared = await clearInboxClearThreadNeedsHuman(input.pg, input.clientSlug, input.convId);
    needsHumanCleared = !!(cleared && cleared.ok);
  }
  return Object.assign({}, binding, {
    ok: true,
    hermes_session_reset: hermes,
    needs_human_cleared: needsHumanCleared,
    needs_human: false,
  });
}

module.exports = {
  SQL_LOOKUP_CONVERSATION,
  SQL_SIBLING_SAME_PHONE,
  SQL_CLEAR_NEEDS_HUMAN,
  isWhatsAppSessionPhone,
  lookupInboxClearThreadBinding,
  clearInboxClearThreadNeedsHuman,
  performInboxClearThreadReset,
};

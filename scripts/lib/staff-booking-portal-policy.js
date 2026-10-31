'use strict';

/**
 * Strict Wolfhouse automatic-booking admission projected from existing portal
 * owners. This is an adapter, not a policy store. It must run inside the same
 * transaction as booking create so the locked client row serializes channel
 * mode changes with final admission.
 */
const WOLFHOUSE_CLIENT_SLUG = 'wolfhouse-somo';

const SQL_WOLFHOUSE_AUTOMATIC_BOOKING_ADMISSION = `
WITH tenant AS (
  SELECT c.id,
         lower(btrim(c.settings->'inbox_channel_modes'->>'whatsapp')) AS whatsapp_mode
    FROM clients c
   WHERE c.slug=$1
   FOR SHARE
), matched_conversations AS (
  SELECT conv.id::text AS conversation_id, conv.needs_human,
         (regexp_replace(COALESCE(conv.phone, ''), '\\D', '', 'g') ~ '^999[0-9]{12}$') AS simulator_synthetic,
         (conv.last_staff_reply_at IS NOT NULL) AS staff_replied
    FROM conversations conv
    JOIN tenant t ON t.id=conv.client_id
   WHERE ($2::text IS NOT NULL AND conv.id::text=$2)
      OR ($2::text IS NULL AND $3::text IS NOT NULL
          AND regexp_replace(COALESCE(conv.phone,''), '\\D', '', 'g')
              = regexp_replace($3, '\\D', '', 'g'))
   FOR SHARE
), bound_conversation AS (
  SELECT CASE WHEN count(*)=1 THEN min(conversation_id) END AS conversation_id,
         count(*)::int AS match_count,
         bool_or(needs_human IS TRUE) AS needs_human,
         bool_or(simulator_synthetic IS TRUE) AS simulator_synthetic,
         bool_or(staff_replied IS TRUE) AS staff_replied
    FROM matched_conversations
), pauses AS (
  SELECT EXISTS (
    SELECT 1 FROM bot_pause_states b
     WHERE b.client_slug=$1 AND b.paused=TRUE
       AND b.conversation_id='__luna_global_pause__'
  ) AS global_paused,
  EXISTS (
    SELECT 1 FROM bot_pause_states b, bound_conversation bc
     WHERE b.client_slug=$1 AND b.paused=TRUE
       AND bc.conversation_id IS NOT NULL
       AND (b.conversation_id=bc.conversation_id
            OR ($3::text IS NOT NULL
                AND regexp_replace(COALESCE(b.guest_phone,''), '\\D', '', 'g')
                    = regexp_replace($3, '\\D', '', 'g')))
  ) AS conversation_paused,
  EXISTS (
    SELECT 1 FROM bot_pause_states b, bound_conversation bc
     WHERE b.client_slug=$1 AND b.paused=TRUE
       AND b.paused_by='luna_flag_needs_human'
       AND bc.conversation_id IS NOT NULL
       AND (b.conversation_id=bc.conversation_id
            OR ($3::text IS NOT NULL
                AND regexp_replace(COALESCE(b.guest_phone,''), '\\D', '', 'g')
                    = regexp_replace($3, '\\D', '', 'g')))
  ) AS luna_handoff_paused,
  EXISTS (
    SELECT 1 FROM bot_pause_states b, bound_conversation bc
     WHERE b.client_slug=$1 AND b.paused=TRUE
       AND b.paused_by<>'luna_flag_needs_human'
       AND bc.conversation_id IS NOT NULL
       AND (b.conversation_id=bc.conversation_id
            OR ($3::text IS NOT NULL
                AND regexp_replace(COALESCE(b.guest_phone,''), '\\D', '', 'g')
                    = regexp_replace($3, '\\D', '', 'g')))
  ) AS staff_conversation_paused
)
SELECT t.id::text AS client_id, t.whatsapp_mode,
       bc.conversation_id, bc.match_count, COALESCE(bc.needs_human,FALSE) AS needs_human,
       COALESCE(bc.simulator_synthetic,FALSE) AS simulator_synthetic,
       COALESCE(bc.staff_replied,FALSE) AS staff_replied,
       p.global_paused, p.conversation_paused, p.luna_handoff_paused,
       p.staff_conversation_paused
  FROM tenant t CROSS JOIN bound_conversation bc CROSS JOIN pauses p
`.replace(/\s+/g, ' ').trim();

function deny(reason, source, unavailable = false, extra = {}) {
  return Object.freeze({ allowed: false, reason, source, unavailable, ...extra });
}

function sqlBool(value) {
  return value === true || value === 'true' || value === 't' || value === 1;
}

async function resolveWolfhouseAutomaticBookingAdmission(pg, input = {}) {
  const clientSlug = String(input.client_slug || '').trim();
  if (clientSlug !== WOLFHOUSE_CLIENT_SLUG) {
    return deny('booking_policy_wrong_tenant', 'portal_policy', false);
  }
  const conversationId = input.conversation_id == null
    ? null : String(input.conversation_id).trim() || null;
  const guestPhone = input.guest_phone == null
    ? null : String(input.guest_phone).trim() || null;
  if (!conversationId && !guestPhone) {
    return deny('booking_context_unbound', 'portal_policy', false);
  }

  let result;
  try {
    // Final admission shares the pause table for the duration of the booking
    // transaction. Committed pause writes win; concurrent setters wait until
    // this create commits or rolls back.
    await pg.query('LOCK TABLE bot_pause_states IN SHARE MODE');
    result = await pg.query(SQL_WOLFHOUSE_AUTOMATIC_BOOKING_ADMISSION, [
      clientSlug, conversationId, guestPhone,
    ]);
  } catch (_) {
    return deny('booking_policy_unavailable', 'portal_policy_lookup', true);
  }
  const row = result && result.rows && result.rows[0];
  if (!row) return deny('booking_tenant_unconfigured', 'portal_policy_lookup', true);
  if (row.whatsapp_mode == null) {
    return deny('booking_channel_unconfigured', 'inbox_channel_modes', true);
  }
  if (!['auto', 'draft', 'off'].includes(row.whatsapp_mode)) {
    return deny('booking_channel_invalid', 'inbox_channel_modes', true);
  }
  if (Number(row.match_count) !== 1 || !row.conversation_id) {
    return deny('booking_context_unbound', 'conversations', false);
  }
  // Luna's own handover hold is lifted when the guest comes back to book
  // (this create). Staff Pause and a staff reply always keep booking blocked.
  // Same rule for TEST simulator chats and real WhatsApp.
  const resumeLunaOwnHandover = (
    sqlBool(row.luna_handoff_paused)
    && !sqlBool(row.staff_conversation_paused)
    && !sqlBool(row.staff_replied)
  );
  if (sqlBool(row.global_paused)) return deny('booking_global_paused', 'bot_pause_states');
  if (sqlBool(row.conversation_paused) && !resumeLunaOwnHandover) {
    return deny('booking_conversation_paused', 'bot_pause_states');
  }
  if (sqlBool(row.staff_replied)) {
    return deny('booking_needs_human', 'conversations');
  }
  if (sqlBool(row.needs_human) && !resumeLunaOwnHandover) {
    return deny('booking_needs_human', 'conversations');
  }
  if (row.whatsapp_mode === 'off') return deny('booking_channel_off', 'inbox_channel_modes');
  if (row.whatsapp_mode === 'draft') return deny('booking_channel_draft', 'inbox_channel_modes');
  return Object.freeze({
    allowed: true,
    reason: 'booking_portal_auto',
    source: 'inbox_channel_modes+bot_pause_states+conversations',
    unavailable: false,
    client_id: row.client_id,
    conversation_id: row.conversation_id,
    whatsapp_channel_mode: 'auto',
  });
}

module.exports = {
  WOLFHOUSE_CLIENT_SLUG,
  SQL_WOLFHOUSE_AUTOMATIC_BOOKING_ADMISSION,
  resolveWolfhouseAutomaticBookingAdmission,
};

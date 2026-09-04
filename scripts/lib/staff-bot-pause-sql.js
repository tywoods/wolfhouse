/**
 * Phase 9.4b — bot_pause_states SQL helpers (Luna guest pause/resume).
 * Source of truth: bot_pause_states — NOT conversations.bot_mode.
 *
 * @module staff-bot-pause-sql
 */

'use strict';

/** Reserved conversation_id for client-wide Luna guest automation pause. */
const GLOBAL_LUNA_PAUSE_CONVERSATION_ID = '__luna_global_pause__';

const SELECT_PAUSE_STATE_COLS = `
  id::text,
  client_slug,
  guest_phone,
  conversation_id,
  booking_id::text,
  booking_code,
  paused,
  pause_reason,
  paused_by,
  paused_at,
  resumed_by,
  resumed_at,
  metadata,
  created_at,
  updated_at
`;

function isMissingBotPauseStatesTable(err) {
  if (!err) return false;
  if (err.code === '42P01') return true;
  const msg = String(err.message || '');
  return /bot_pause_states/.test(msg) && /does not exist|undefined table/i.test(msg);
}

function normalizeScope(input) {
  const clientSlug = String(input.client_slug || '').trim();
  const conversationId = input.conversation_id != null
    ? String(input.conversation_id).trim() || null
    : null;
  const guestPhone = input.guest_phone != null
    ? String(input.guest_phone).trim() || null
    : null;
  const bookingCode = input.booking_code != null
    ? String(input.booking_code).trim() || null
    : null;
  return { clientSlug, conversationId, guestPhone, bookingCode };
}

function formatPauseStateRow(row) {
  if (!row) return null;
  return {
    id:              row.id,
    client_slug:     row.client_slug,
    guest_phone:     row.guest_phone,
    conversation_id: row.conversation_id,
    booking_id:      row.booking_id,
    booking_code:    row.booking_code,
    paused:          row.paused === true,
    pause_reason:    row.pause_reason,
    paused_by:       row.paused_by,
    paused_at:       row.paused_at,
    resumed_by:      row.resumed_by,
    resumed_at:      row.resumed_at,
    metadata:        row.metadata || {},
    created_at:      row.created_at,
    updated_at:      row.updated_at,
  };
}

async function getGlobalPauseState(pg, clientSlug) {
  const slug = String(clientSlug || '').trim();
  if (!slug) return { row: null, source: 'default_active' };

  try {
    const r = await pg.query(
      `SELECT ${SELECT_PAUSE_STATE_COLS}
         FROM bot_pause_states
        WHERE client_slug = $1
          AND conversation_id = $2
          AND paused = TRUE
        ORDER BY paused_at DESC
        LIMIT 1`,
      [slug, GLOBAL_LUNA_PAUSE_CONVERSATION_ID],
    );
    if (r.rows[0]) return { row: r.rows[0], source: 'bot_pause_states_global' };
    return { row: null, source: 'default_active' };
  } catch (err) {
    if (isMissingBotPauseStatesTable(err)) {
      return { row: null, source: 'default_active', table_missing: true };
    }
    throw err;
  }
}

async function pauseGlobalLuna(pg, input) {
  const clientSlug = String(input.client_slug || '').trim();
  const pausedBy = String(input.paused_by || '').trim();
  const pauseReason = input.pause_reason != null
    ? String(input.pause_reason).trim().slice(0, 500) || null
    : null;

  const existing = await getGlobalPauseState(pg, clientSlug);
  if (existing.table_missing) return { row: null, table_missing: true };
  if (existing.row) return { row: existing.row, idempotent: true };

  try {
    const r = await pg.query(
      `INSERT INTO bot_pause_states (
         client_slug, guest_phone, conversation_id, booking_id, booking_code,
         paused, pause_reason, paused_by, paused_at, metadata
       ) VALUES (
         $1, NULL, $2, NULL, NULL,
         TRUE, $3, $4, NOW(), '{"scope":"global"}'::jsonb
       )
       RETURNING ${SELECT_PAUSE_STATE_COLS}`,
      [clientSlug, GLOBAL_LUNA_PAUSE_CONVERSATION_ID, pauseReason, pausedBy],
    );
    return { row: r.rows[0], idempotent: false };
  } catch (err) {
    if (err.code === '23505') {
      const again = await getGlobalPauseState(pg, clientSlug);
      if (again.row) return { row: again.row, idempotent: true };
    }
    if (isMissingBotPauseStatesTable(err)) {
      return { row: null, table_missing: true };
    }
    throw err;
  }
}

async function resumeGlobalLuna(pg, input) {
  const clientSlug = String(input.client_slug || '').trim();
  const resumedBy = String(input.resumed_by || '').trim();

  const active = await getGlobalPauseState(pg, clientSlug);
  if (active.table_missing) return { row: null, table_missing: true };
  if (!active.row) return { row: null, idempotent: true };

  try {
    const r = await pg.query(
      `UPDATE bot_pause_states
          SET paused = FALSE,
              resumed_by = $2,
              resumed_at = NOW(),
              updated_at = NOW()
        WHERE id = $1::uuid
          AND client_slug = $3
          AND paused = TRUE
        RETURNING ${SELECT_PAUSE_STATE_COLS}`,
      [active.row.id, resumedBy, clientSlug],
    );
    return { row: r.rows[0] || null, idempotent: false };
  } catch (err) {
    if (isMissingBotPauseStatesTable(err)) {
      return { row: null, table_missing: true };
    }
    throw err;
  }
}

async function getPauseState(pg, input) {
  const { clientSlug, conversationId, guestPhone, bookingCode } = normalizeScope(input);

  try {
    const globalPause = await getGlobalPauseState(pg, clientSlug);
    if (globalPause.row) {
      return {
        row: globalPause.row,
        source: 'bot_pause_states_global',
        global_pause: true,
      };
    }

    if (conversationId) {
      const r = await pg.query(
        `SELECT ${SELECT_PAUSE_STATE_COLS}
           FROM bot_pause_states
          WHERE client_slug = $1
            AND conversation_id = $2
            AND paused = TRUE
          ORDER BY paused_at DESC
          LIMIT 1`,
        [clientSlug, conversationId],
      );
      if (r.rows[0]) return { row: r.rows[0], source: 'bot_pause_states' };
    }

    if (guestPhone) {
      // Match phone-scoped rows AND conversation-scoped pauses whose thread phone
      // matches (portal pause often writes conversation_id only).
      const digits = String(guestPhone).replace(/\D/g, '');
      const suffix = digits.length >= 9 ? digits.slice(-9) : digits;
      const r = await pg.query(
        `SELECT ${SELECT_PAUSE_STATE_COLS}
           FROM bot_pause_states bps
          WHERE bps.client_slug = $1
            AND bps.paused = TRUE
            AND bps.conversation_id IS DISTINCT FROM $4
            AND (
              bps.guest_phone = $2
              OR (
                NULLIF(bps.guest_phone, '') IS NOT NULL
                AND regexp_replace(bps.guest_phone, '\\D', '', 'g') = $3
              )
              OR (
                bps.conversation_id IS NOT NULL
                AND EXISTS (
                  SELECT 1
                    FROM conversations conv
                    JOIN clients c ON c.id = conv.client_id
                   WHERE c.slug = $1
                     AND conv.id::text = bps.conversation_id
                     AND (
                       regexp_replace(COALESCE(conv.phone, ''), '\\D', '', 'g') = $3
                       OR (
                         length($5) >= 9
                         AND regexp_replace(COALESCE(conv.phone, ''), '\\D', '', 'g') LIKE ('%' || $5)
                       )
                     )
                )
              )
            )
          ORDER BY bps.paused_at DESC
          LIMIT 1`,
        [clientSlug, guestPhone, digits, GLOBAL_LUNA_PAUSE_CONVERSATION_ID, suffix],
      );
      if (r.rows[0]) return { row: r.rows[0], source: 'bot_pause_states' };
    }

    if (bookingCode) {
      const r = await pg.query(
        `SELECT ${SELECT_PAUSE_STATE_COLS}
           FROM bot_pause_states
          WHERE client_slug = $1
            AND booking_code = $2
            AND paused = TRUE
          ORDER BY paused_at DESC
          LIMIT 1`,
        [clientSlug, bookingCode],
      );
      if (r.rows[0]) return { row: r.rows[0], source: 'bot_pause_states' };
    }

    return { row: null, source: 'default_active' };
  } catch (err) {
    if (isMissingBotPauseStatesTable(err)) {
      return { row: null, source: 'default_active', table_missing: true };
    }
    throw err;
  }
}

async function resolveConversationGuestPhone(pg, clientSlug, conversationId) {
  const slug = String(clientSlug || '').trim();
  const convId = String(conversationId || '').trim();
  if (!slug || !convId) return null;
  try {
    const r = await pg.query(
      `SELECT conv.phone
         FROM conversations conv
         JOIN clients c ON c.id = conv.client_id
        WHERE c.slug = $1
          AND conv.id::text = $2
        LIMIT 1`,
      [slug, convId],
    );
    const phone = r.rows[0] && r.rows[0].phone != null
      ? String(r.rows[0].phone).trim()
      : '';
    return phone || null;
  } catch (_) {
    return null;
  }
}

async function pauseConversation(pg, input) {
  const { clientSlug, conversationId, guestPhone, bookingCode } = normalizeScope(input);
  const pausedBy = String(input.paused_by || '').trim();
  const pauseReason = input.pause_reason != null
    ? String(input.pause_reason).trim().slice(0, 500) || null
    : null;
  const bookingId = input.booking_id != null
    ? String(input.booking_id).trim() || null
    : null;

  let resolvedPhone = guestPhone;
  if (!resolvedPhone && conversationId) {
    resolvedPhone = await resolveConversationGuestPhone(pg, clientSlug, conversationId);
  }

  // Idempotent on an existing conversation/phone pause even when global pause is
  // also active (getPauseState prefers global and would otherwise mislead us).
  try {
    if (conversationId) {
      const existingConv = await pg.query(
        `SELECT ${SELECT_PAUSE_STATE_COLS}
           FROM bot_pause_states
          WHERE client_slug = $1
            AND conversation_id = $2
            AND paused = TRUE
          ORDER BY paused_at DESC
          LIMIT 1`,
        [clientSlug, conversationId],
      );
      if (existingConv.rows[0]) {
        return { row: existingConv.rows[0], idempotent: true, guest_phone: resolvedPhone };
      }
    } else if (resolvedPhone) {
      const existingPhone = await getPauseState(pg, {
        client_slug: clientSlug,
        guest_phone: resolvedPhone,
      });
      if (existingPhone.table_missing) {
        return { row: null, table_missing: true };
      }
      if (existingPhone.row && !existingPhone.global_pause) {
        return { row: existingPhone.row, idempotent: true, guest_phone: resolvedPhone };
      }
    }
  } catch (err) {
    if (isMissingBotPauseStatesTable(err)) {
      return { row: null, table_missing: true };
    }
    throw err;
  }

  try {
    const r = await pg.query(
      `INSERT INTO bot_pause_states (
         client_slug, guest_phone, conversation_id, booking_id, booking_code,
         paused, pause_reason, paused_by, paused_at, metadata
       ) VALUES (
         $1, $2, $3, $4::uuid, $5,
         TRUE, $6, $7, NOW(), '{}'::jsonb
       )
       RETURNING ${SELECT_PAUSE_STATE_COLS}`,
      [clientSlug, resolvedPhone, conversationId, bookingId, bookingCode, pauseReason, pausedBy],
    );
    return { row: r.rows[0], idempotent: false, guest_phone: resolvedPhone };
  } catch (err) {
    if (err.code === '23505') {
      const again = await getPauseState(pg, {
        client_slug:     clientSlug,
        conversation_id: conversationId,
        guest_phone:     resolvedPhone,
      });
      if (again.row) return { row: again.row, idempotent: true, guest_phone: resolvedPhone };
    }
    if (isMissingBotPauseStatesTable(err)) {
      return { row: null, table_missing: true };
    }
    throw err;
  }
}

async function resumeConversation(pg, input) {
  const { clientSlug, conversationId, guestPhone } = normalizeScope(input);
  const resumedBy = String(input.resumed_by || '').trim();
  const conversationOnly = input.conversation_only === true;

  let active;
  if (conversationOnly && conversationId) {
    try {
      const r = await pg.query(
        `SELECT ${SELECT_PAUSE_STATE_COLS}
           FROM bot_pause_states
          WHERE client_slug = $1
            AND conversation_id = $2
            AND paused = TRUE
          ORDER BY paused_at DESC
          LIMIT 1`,
        [clientSlug, conversationId],
      );
      active = { row: r.rows[0] || null, source: r.rows[0] ? 'bot_pause_states' : 'default_active' };
    } catch (err) {
      if (isMissingBotPauseStatesTable(err)) return { row: null, table_missing: true };
      throw err;
    }
  } else {
    active = await getPauseState(pg, {
      client_slug:     clientSlug,
      conversation_id: conversationId,
      guest_phone:     guestPhone,
    });
  }
  if (active.table_missing) {
    return { row: null, table_missing: true };
  }
  if (!active.row) {
    return { row: null, idempotent: true };
  }

  try {
    const r = await pg.query(
      `UPDATE bot_pause_states
          SET paused = FALSE,
              resumed_by = $2,
              resumed_at = NOW(),
              updated_at = NOW()
        WHERE id = $1::uuid
          AND client_slug = $3
          AND paused = TRUE
        RETURNING ${SELECT_PAUSE_STATE_COLS}`,
      [active.row.id, resumedBy, clientSlug],
    );
    return { row: r.rows[0] || null, idempotent: false };
  } catch (err) {
    if (isMissingBotPauseStatesTable(err)) {
      return { row: null, table_missing: true };
    }
    throw err;
  }
}

module.exports = {
  GLOBAL_LUNA_PAUSE_CONVERSATION_ID,
  getPauseState,
  getGlobalPauseState,
  pauseConversation,
  resumeConversation,
  pauseGlobalLuna,
  resumeGlobalLuna,
  formatPauseStateRow,
  isMissingBotPauseStatesTable,
  resolveConversationGuestPhone,
};

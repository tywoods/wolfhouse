/**
 * Phase 9.4b — bot_pause_states SQL helpers (Luna guest pause/resume).
 * Source of truth: bot_pause_states — NOT conversations.bot_mode.
 *
 * @module staff-bot-pause-sql
 */

'use strict';

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

async function getPauseState(pg, input) {
  const { clientSlug, conversationId, guestPhone, bookingCode } = normalizeScope(input);

  try {
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
      const r = await pg.query(
        `SELECT ${SELECT_PAUSE_STATE_COLS}
           FROM bot_pause_states
          WHERE client_slug = $1
            AND guest_phone = $2
            AND conversation_id IS NULL
            AND paused = TRUE
          ORDER BY paused_at DESC
          LIMIT 1`,
        [clientSlug, guestPhone],
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

async function pauseConversation(pg, input) {
  const { clientSlug, conversationId, guestPhone, bookingCode } = normalizeScope(input);
  const pausedBy = String(input.paused_by || '').trim();
  const pauseReason = input.pause_reason != null
    ? String(input.pause_reason).trim().slice(0, 500) || null
    : null;
  const bookingId = input.booking_id != null
    ? String(input.booking_id).trim() || null
    : null;

  const existing = await getPauseState(pg, {
    client_slug:     clientSlug,
    conversation_id: conversationId,
    guest_phone:     guestPhone,
  });
  if (existing.table_missing) {
    return { row: null, table_missing: true };
  }
  if (existing.row) {
    return { row: existing.row, idempotent: true };
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
      [clientSlug, guestPhone, conversationId, bookingId, bookingCode, pauseReason, pausedBy],
    );
    return { row: r.rows[0], idempotent: false };
  } catch (err) {
    if (err.code === '23505') {
      const again = await getPauseState(pg, {
        client_slug:     clientSlug,
        conversation_id: conversationId,
        guest_phone:     guestPhone,
      });
      if (again.row) return { row: again.row, idempotent: true };
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

  const active = await getPauseState(pg, {
    client_slug:     clientSlug,
    conversation_id: conversationId,
    guest_phone:     guestPhone,
  });
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
  getPauseState,
  pauseConversation,
  resumeConversation,
  formatPauseStateRow,
  isMissingBotPauseStatesTable,
};

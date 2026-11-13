'use strict';

const FAILURE_SUMMARY = 'Guest handoff note failed after two attempts (60-second retry). Staff follow-up required.';

/** Internal delivery evidence only: never re-open a handoff, pause, or send. */
async function reportHandoffNoteFailure(pg, { client_slug: clientSlug, phone }) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!clientSlug || digits.length < 9 || /^999[0-9]{12}$/.test(digits)) return { ok: false };
  const result = await pg.query(`
    WITH scoped AS (
      SELECT conv.id FROM conversations conv JOIN clients c ON c.id = conv.client_id
      WHERE c.slug = $1 AND regexp_replace(COALESCE(conv.phone, ''), '\\D', '', 'g') = $2
        AND COALESCE(conv.metadata->>'simulator_synthetic', 'false') <> 'true'
    ), annotated AS (
      UPDATE conversations conv SET metadata = COALESCE(conv.metadata, '{}'::jsonb)
        || jsonb_build_object('luna_handoff_guest_note',
             jsonb_build_object('status', 'failed', 'attempts', 2, 'staff_action_required', true,
                                'updated_at', NOW()))
      FROM scoped WHERE conv.id = scoped.id RETURNING conv.id
    ), handoffs AS (
      UPDATE staff_handoffs h SET summary =
        CASE WHEN strpos(COALESCE(h.summary, ''), $3) > 0 THEN h.summary
          ELSE LEFT(COALESCE(h.summary, ''), 350) || E'\n' || $3 END
      FROM scoped WHERE h.conversation_id = scoped.id AND h.status::text IN ('open', 'acknowledged')
      RETURNING h.id
    ) SELECT id FROM annotated`, [clientSlug, digits, FAILURE_SUMMARY]);
  return { ok: result.rows.length > 0, note_failure_recorded: result.rows.length > 0 };
}

module.exports = { reportHandoffNoteFailure, FAILURE_SUMMARY };

'use strict';

/** Server-authoritative spam state. Stored on the tenant-owned conversation row. */
function normalizeSpamSelection(value) {
  return String(value || '').trim().toLowerCase() === 'spam';
}

function buildConversationSpamPredicate(opts = {}) {
  const truth = "lower(btrim(COALESCE(conv.metadata->>'is_spam', ''))) IN ('true', 't', '1', 'yes', 'on')";
  return opts.spamSelected ? truth : `NOT (${truth})`;
}

function conversationSpamSelectExpr(alias = 'conv') {
  return `lower(btrim(COALESCE(${alias}.metadata->>'is_spam', ''))) IN ('true', 't', '1', 'yes', 'on')`;
}

const SQL_SET_CONVERSATION_SPAM = `
UPDATE conversations conv
   SET metadata = jsonb_set(COALESCE(conv.metadata, '{}'::jsonb), '{is_spam}', to_jsonb($3::boolean), true),
       updated_at = NOW()
  FROM clients c
 WHERE conv.client_id = c.id
   AND conv.id = $1::uuid
   AND c.slug = $2
 RETURNING conv.id::text AS conversation_id,
           ${conversationSpamSelectExpr('conv')} AS is_spam,
           conv.phone`;

async function setConversationSpam(pg, input, pauseConversation) {
  const conversationId = String(input.conversation_id || '').trim();
  const clientSlug = String(input.client_slug || '').trim();
  const isSpam = input.is_spam === true;
  const actor = String(input.actor || 'staff_portal');
  await pg.query('BEGIN');
  try {
    const changed = await pg.query(SQL_SET_CONVERSATION_SPAM, [conversationId, clientSlug, isSpam]);
    const row = changed.rows && changed.rows[0];
    if (!row) {
      await pg.query('ROLLBACK');
      return { ok: false, reason: 'conversation_not_found' };
    }
    let pause = null;
    if (isSpam) {
      // Use the canonical pause owner in the same transaction. It deterministically
      // updates an existing tenant/thread pause or inserts one when absent.
      pause = await pauseConversation(pg, {
        client_slug: clientSlug,
        conversation_id: conversationId,
        guest_phone: row.phone || null,
        pause_reason: 'conversation_spam',
        paused_by: actor,
      });
      if (!pause || pause.table_missing || !pause.row) throw new Error('spam_luna_pause_failed');
    }
    await pg.query('COMMIT');
    return { ok: true, conversation_id: conversationId, is_spam: isSpam, luna_paused: isSpam ? true : undefined };
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch (_e) { /* preserve original */ }
    throw err;
  }
}

module.exports = {
  normalizeSpamSelection,
  buildConversationSpamPredicate,
  conversationSpamSelectExpr,
  SQL_SET_CONVERSATION_SPAM,
  setConversationSpam,
};

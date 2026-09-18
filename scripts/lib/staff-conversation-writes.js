/**
 * Staff conversation write helpers (fresh-start context reset, clear thread, hard delete).
 *
 * @module staff-conversation-writes
 */

'use strict';

/** Metadata keys cleared by Fresh Start — Luna intake/quote/payment cache only. */
const LUNA_FRESH_START_METADATA_KEYS = [
  'luna_guest_context',
  'luna_inbound_reviews',
  'guest_context',
  'last_inbound_message_id',
  'last_inbound_at',
];

function parseConversationMetadata(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return { ...raw };
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? { ...parsed } : {};
  } catch (_) {
    return {};
  }
}

function stripLunaContextFromMetadata(metadata) {
  const meta = parseConversationMetadata(metadata);
  for (const key of LUNA_FRESH_START_METADATA_KEYS) {
    delete meta[key];
  }
  if (meta.source === 'luna_inbound_review_dry_run') {
    delete meta.source;
  }
  if (meta.channel === 'whatsapp' && Object.keys(meta).length === 0) {
    return {};
  }
  return meta;
}

async function clearConversationMessages(pg, clientSlug, convId) {
  await pg.query('BEGIN');
  try {
    const del = await pg.query(
      `DELETE FROM messages m
         USING conversations conv
         INNER JOIN clients c ON c.id = conv.client_id
        WHERE m.conversation_id = conv.id
          AND c.slug = $1
          AND conv.id = $2::uuid`,
      [clientSlug, convId],
    );
    const upd = await pg.query(
      `UPDATE conversations conv
          SET last_message_preview = NULL,
              staff_reply_draft = NULL,
              last_bot_reply = NULL,
              pending_action = NULL,
              conversation_summary = NULL,
              updated_at = NOW()
         FROM clients c
        WHERE conv.client_id = c.id
          AND c.slug = $1
          AND conv.id = $2::uuid
        RETURNING conv.id::text AS conversation_id`,
      [clientSlug, convId],
    );
    if (!upd.rows.length) {
      await pg.query('ROLLBACK');
      return { found: false, messages_deleted: 0 };
    }
    await pg.query('COMMIT');
    return { found: true, messages_deleted: del.rowCount || 0 };
  } catch (err) {
    await pg.query('ROLLBACK');
    throw err;
  }
}

/**
 * Fresh Start — clear Luna active context on a conversation.
 * @param {object} opts
 * @param {boolean} [opts.clearMessages=false] - also delete message history (staging only)
 */
async function resetLunaConversationContext(pg, clientSlug, convId, opts) {
  const options = opts || {};
  await pg.query('BEGIN');
  try {
    const sel = await pg.query(
      `SELECT conv.id::text AS conversation_id, conv.metadata, conv.phone
         FROM conversations conv
         INNER JOIN clients c ON c.id = conv.client_id
        WHERE c.slug = $1 AND conv.id = $2::uuid`,
      [clientSlug, convId],
    );
    if (!sel.rows.length) {
      await pg.query('ROLLBACK');
      return { found: false, context_cleared: false };
    }

    const priorMeta = parseConversationMetadata(sel.rows[0].metadata);
    const hadLunaContext = !!(
      priorMeta.luna_guest_context
      || priorMeta.luna_inbound_reviews
      || priorMeta.guest_context
    );
    const nextMeta = stripLunaContextFromMetadata(priorMeta);

    const upd = await pg.query(
      `UPDATE conversations conv
          SET metadata = $3::jsonb,
              staff_reply_draft = NULL,
              last_bot_reply = NULL,
              pending_action = NULL,
              last_message_preview = NULL,
              conversation_summary = NULL,
              updated_at = NOW()
         FROM clients c
        WHERE conv.client_id = c.id
          AND c.slug = $1
          AND conv.id = $2::uuid
        RETURNING conv.id::text AS conversation_id`,
      [clientSlug, convId, JSON.stringify(nextMeta)],
    );

    let messagesDeleted = 0;
    if (options.clearMessages) {
      const del = await pg.query(
        `DELETE FROM messages WHERE conversation_id = $1::uuid`,
        [convId],
      );
      messagesDeleted = del.rowCount || 0;
    } else {
      const msgCount = await pg.query(
        `SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1::uuid`,
        [convId],
      );
      messagesDeleted = msgCount.rows[0]?.n ?? 0;
    }

    await pg.query('COMMIT');
    return {
      found: true,
      guest_phone: sel.rows[0].phone || null,
      context_cleared: hadLunaContext || upd.rows.length > 0,
      messages_deleted: options.clearMessages ? messagesDeleted : 0,
      messages_preserved: options.clearMessages ? 0 : messagesDeleted,
      metadata_keys_cleared: LUNA_FRESH_START_METADATA_KEYS.filter(
        (k) => Object.prototype.hasOwnProperty.call(priorMeta, k),
      ),
    };
  } catch (err) {
    await pg.query('ROLLBACK');
    throw err;
  }
}

async function deleteOptionalConversationRows(pg, tableName, whereSql, params) {
  const exists = await pg.query('SELECT to_regclass($1) AS regclass', [`public.${tableName}`]);
  if (!exists.rows[0]?.regclass) return 0;
  const del = await pg.query(`DELETE FROM ${tableName} ${whereSql}`, params);
  return del.rowCount || 0;
}

async function deleteConversationHard(pg, clientSlug, convId) {
  await pg.query('BEGIN');
  try {
    const exists = await pg.query(
      `SELECT conv.id::text AS conversation_id, conv.phone, conv.client_id::text AS client_id
         FROM conversations conv
         INNER JOIN clients c ON c.id = conv.client_id
        WHERE c.slug = $1 AND conv.id = $2::uuid`,
      [clientSlug, convId],
    );
    if (!exists.rows.length) {
      await pg.query('ROLLBACK');
      return { found: false };
    }
    const phone = exists.rows[0].phone;
    const childDeletes = {};

    // Remove conversation-owned children that deliberately RESTRICT the parent row.
    // Plain WhatsApp rows usually only cascade messages, but Sunset email / draft rows
    // can otherwise make the Inbox delete button look like a no-op with "delete failed".
    const byClientConversation = `
      WHERE client_id = (SELECT id FROM clients WHERE slug = $1)
        AND conversation_id = $2::uuid`;
    const childTables = [
      'tenant_email_luna_automation_queue',
      'tenant_email_luna_automation_issuance_material',
      'tenant_email_luna_automation_shadow_outcomes',
      'tenant_email_same_desk_auto_send_claims',
      'tenant_email_outbound_send_journal',
      'tenant_email_reply_approvals',
      'luna_outbound_approvals',
      'tenant_email_luna_policy_audit',
      'tenant_email_inbound_inbox_projections',
    ];
    for (const tableName of childTables) {
      childDeletes[tableName] = await deleteOptionalConversationRows(
        pg,
        tableName,
        byClientConversation,
        [clientSlug, convId],
      );
    }

    const pauseDelete = await pg.query(
      `DELETE FROM bot_pause_states bps
        WHERE bps.client_slug = $1
          AND (
            bps.conversation_id = $2
            OR (
              NULLIF($3, '') IS NOT NULL
              AND bps.guest_phone = $3
              AND NOT EXISTS (
                SELECT 1
                  FROM conversations sibling
                  JOIN clients sibling_client ON sibling_client.id = sibling.client_id
                 WHERE sibling_client.slug = $1
                   AND sibling.id <> $2::uuid
                   AND sibling.phone = $3
              )
            )
          )`,
      [clientSlug, convId, phone],
    );
    const del = await pg.query(
      `DELETE FROM conversations conv
         USING clients c
        WHERE conv.client_id = c.id
          AND c.slug = $1
          AND conv.id = $2::uuid
        RETURNING conv.id::text AS conversation_id`,
      [clientSlug, convId],
    );
    await pg.query('COMMIT');
    return {
      found: del.rows.length > 0,
      conversation_id: del.rows[0]?.conversation_id || null,
      pause_states_deleted: pauseDelete.rowCount || 0,
      child_rows_deleted: childDeletes,
    };
  } catch (err) {
    await pg.query('ROLLBACK');
    throw err;
  }
}

module.exports = {
  clearConversationMessages,
  resetLunaConversationContext,
  stripLunaContextFromMetadata,
  LUNA_FRESH_START_METADATA_KEYS,
  deleteConversationHard,
};

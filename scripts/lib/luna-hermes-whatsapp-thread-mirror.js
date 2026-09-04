'use strict';

/**
 * Mirror Hermes Agent Luna WhatsApp turns into Staff Portal inbox (messages table).
 * Called by POST /staff/bot/whatsapp-thread-mirror (bot token auth).
 *
 * When WhatsApp channel autonomy is Draft, outbound mirrors stage a pending
 * luna_outbound_approvals row instead of an Inbox "sent" bubble — staff must
 * Approve / Send reply before Meta delivery.
 */

const crypto = require('crypto');
const { resolvePortalDeployClient } = require('./staff-portal-clients');
const {
  persistHermesLunaInboundThreadMessage,
  persistHermesLunaOutboundThreadMessage,
} = require('./luna-staff-inbox-thread-message');
const {
  mergeSunsetInboundLocationMetadata,
  extractSunsetChannelHintsFromNormalized,
} = require('./sunset-inbox-channel-config');
const {
  SUNSET_CLIENT_SLUG,
  isSunsetLocationId,
  normalizeSunsetLocationId,
} = require('./sunset-school-locations');
const {
  maybeNotifyNewConversation,
  maybeNotifyHumanNeeded,
  extractLocationFromMetadata,
} = require('./staff-whatsapp-notifications');
const {
  normalizeCustomerPhone,
  upsertCustomerFromInboundTouch,
} = require('./staff-customer-queries');
const { emitInboxConversationUpdated } = require('./staff-inbox-live-events');

const SQL_CLIENT_WHATSAPP_MODE = `
SELECT c.id::text AS client_id,
  lower(btrim(COALESCE(c.settings->'inbox_channel_modes'->>'whatsapp', 'auto'))) AS whatsapp_mode
FROM clients c
WHERE c.slug = $1
LIMIT 1
`.replace(/\s+/g, ' ').trim();

const SQL_UPSERT_HERMES_DRAFT = `
INSERT INTO luna_outbound_approvals (
  id, client_id, conversation_id, channel, draft_text, edited_text, status,
  tool_trace, created_by_run_id, created_by_staff_user_id
) VALUES (
  $1::uuid, $2::uuid, $3::uuid, 'whatsapp', $4, NULL, 'pending',
  $5::jsonb, $6, NULL
)
ON CONFLICT (client_id, conversation_id, channel) WHERE status = 'pending'
DO UPDATE SET
  draft_text = EXCLUDED.draft_text,
  tool_trace = EXCLUDED.tool_trace,
  created_by_run_id = EXCLUDED.created_by_run_id
RETURNING id::text AS approval_id, conversation_id::text AS conversation_id,
  channel, draft_text, status, created_by_run_id
`.replace(/\s+/g, ' ').trim();

const SQL_EXPIRE_PENDING_WHATSAPP_DRAFT = `
UPDATE luna_outbound_approvals
SET status = 'expired'
WHERE client_id = $1::uuid
  AND conversation_id = $2::uuid
  AND channel = 'whatsapp'
  AND status = 'pending'
RETURNING id::text AS approval_id
`.replace(/\s+/g, ' ').trim();

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function normalizeGuestPhone(phone) {
  return normalizeCustomerPhone(phone);
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

function mintUuid() {
  return String(crypto.randomUUID()).toLowerCase();
}

async function loadClientWhatsAppChannelMode(pg, clientSlug) {
  const slug = trimStr(clientSlug);
  if (!slug) return { client_id: null, whatsapp_mode: 'auto' };
  try {
    const res = await pg.query(SQL_CLIENT_WHATSAPP_MODE, [slug]);
    const row = res.rows[0];
    if (!row) return { client_id: null, whatsapp_mode: 'auto' };
    const mode = trimStr(row.whatsapp_mode).toLowerCase();
    return {
      client_id: row.client_id || null,
      whatsapp_mode: (mode === 'auto' || mode === 'draft' || mode === 'off') ? mode : 'auto',
    };
  } catch (_err) {
    return { client_id: null, whatsapp_mode: 'auto' };
  }
}

/**
 * Stage a Hermes outbound reply as a pending WhatsApp draft (no sent bubble).
 */
async function stageHermesWhatsAppOutboundDraft(pg, input) {
  const i = input || {};
  const clientId = trimStr(i.client_id);
  const conversationId = trimStr(i.conversation_id);
  const draftText = normalizeWhatsAppMessageText(i.message_text);
  if (!clientId || !conversationId || !draftText) {
    return { ok: false, staged: false, reason: 'missing_draft_fields' };
  }
  const runId = trimStr(i.idempotency_key || i.created_by_run_id).slice(0, 128) || null;
  const toolTrace = {
    source: 'hermes_luna_whatsapp_draft',
    staged_at: new Date().toISOString(),
  };
  try {
    const upsert = await pg.query(SQL_UPSERT_HERMES_DRAFT, [
      mintUuid(),
      clientId,
      conversationId,
      draftText.slice(0, 64000),
      JSON.stringify(toolTrace),
      runId,
    ]);
    const row = upsert.rows[0];
    if (!row) return { ok: false, staged: false, reason: 'draft_upsert_failed' };
    emitInboxConversationUpdated(trimStr(i.client_slug), conversationId);
    return {
      ok: true,
      staged: true,
      approval_id: row.approval_id,
      draft_text: row.draft_text,
      status: row.status,
      created_by_run_id: row.created_by_run_id || null,
    };
  } catch (err) {
    return {
      ok: false,
      staged: false,
      reason: 'draft_upsert_error',
      detail: err && err.message ? String(err.message) : 'unknown',
    };
  }
}

async function deletePendingWhatsAppDraftForConversation(pg, clientId, conversationId) {
  const cid = trimStr(clientId);
  const conv = trimStr(conversationId);
  if (!cid || !conv) return { expired: 0 };
  try {
    const res = await pg.query(SQL_EXPIRE_PENDING_WHATSAPP_DRAFT, [cid, conv]);
    return { expired: (res.rows || []).length };
  } catch (_err) {
    return { expired: 0 };
  }
}
// Existing callers expire on successful send; explicit Delete uses the same
// tenant+conversation+pending-only CAS semantics.
const expirePendingWhatsAppDraftForConversation = deletePendingWhatsAppDraftForConversation;

function parseHermesWhatsAppThreadMirrorBody(body) {
  const src = body || {};
  const clientSlug = trimStr(src.client_slug);
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
  const locationId = trimStr(src.location_id) || null;
  const messageType = trimStr(src.message_type) || null;
  const messageTimestamp = trimStr(src.message_timestamp || src.timestamp) || null;
  const needsHuman = toBool(src.needs_human);
  const handoffReason = trimStr(src.handoff_reason || src.needs_human_reason) || null;

  if (!clientSlug) return { ok: false, status: 400, error: 'client_slug required' };
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
      location_id: locationId,
      message_type: messageType,
      message_timestamp: messageTimestamp,
      needs_human: needsHuman,
      handoff_reason: handoffReason,
    },
  };
}

/**
 * Enforce deployment tenant isolation for Hermes WhatsApp inbox mirrors.
 * Sunset staging rejects Wolfhouse payloads (and vice versa).
 */
function assertHermesMirrorTenantScope(input, env) {
  const i = input || {};
  const srcEnv = env && typeof env === 'object' ? env : process.env;
  const prev = process.env.DEFAULT_CLIENT_SLUG;
  let deployClient;
  try {
    if (srcEnv !== process.env && Object.prototype.hasOwnProperty.call(srcEnv, 'DEFAULT_CLIENT_SLUG')) {
      if (srcEnv.DEFAULT_CLIENT_SLUG == null || srcEnv.DEFAULT_CLIENT_SLUG === '') {
        delete process.env.DEFAULT_CLIENT_SLUG;
      } else {
        process.env.DEFAULT_CLIENT_SLUG = String(srcEnv.DEFAULT_CLIENT_SLUG);
      }
    }
    deployClient = resolvePortalDeployClient({});
  } finally {
    if (srcEnv !== process.env && Object.prototype.hasOwnProperty.call(srcEnv, 'DEFAULT_CLIENT_SLUG')) {
      if (prev == null) delete process.env.DEFAULT_CLIENT_SLUG;
      else process.env.DEFAULT_CLIENT_SLUG = prev;
    }
  }

  const clientSlug = trimStr(i.client_slug);
  if (!clientSlug) {
    return { ok: false, status: 400, error: 'client_slug required' };
  }
  if (clientSlug !== deployClient) {
    return {
      ok: false,
      status: 403,
      error: 'tenant_mismatch',
      client_slug: clientSlug,
      expected_tenant: deployClient,
    };
  }

  if (clientSlug === SUNSET_CLIENT_SLUG) {
    const locRaw = trimStr(i.location_id);
    if (!locRaw) {
      return { ok: false, status: 400, error: 'location_id required', client_slug: clientSlug };
    }
    if (!isSunsetLocationId(locRaw)) {
      return {
        ok: false,
        status: 400,
        error: 'invalid_location',
        client_slug: clientSlug,
        location_id: locRaw,
      };
    }
    return {
      ok: true,
      client_slug: clientSlug,
      location_id: normalizeSunsetLocationId(locRaw),
      expected_tenant: deployClient,
    };
  }

  return {
    ok: true,
    client_slug: clientSlug,
    location_id: trimStr(i.location_id) || null,
    expected_tenant: deployClient,
  };
}

async function ensureConversationForGuestPhone(pg, clientSlug, guestPhone, contactName, previewText, channelHints) {
  const phone = normalizeGuestPhone(guestPhone);
  const clientR = await pg.query('SELECT id FROM clients WHERE slug = $1 LIMIT 1', [clientSlug]);
  if (!clientR.rows[0]) return null;
  const clientId = clientR.rows[0].id;
  const preview = trimStr(previewText) || trimStr(contactName) || phone;
  const displayName = trimStr(contactName) || null;
  const hints = extractSunsetChannelHintsFromNormalized({
    channel: 'whatsapp',
    receiving_whatsapp_number: channelHints && channelHints.receiving_whatsapp_number,
    phone_number_id: channelHints && channelHints.phone_number_id,
    location_id: channelHints && channelHints.location_id,
  });
  if (channelHints && channelHints.location_id) {
    hints.location_id = channelHints.location_id;
  }
  const metadata = mergeSunsetInboundLocationMetadata(
    { channel: 'whatsapp', hermes_luna: true },
    hints,
    clientSlug,
  );
  const existing = await pg.query(
    `SELECT id::text AS conversation_id FROM conversations WHERE client_id = $1 AND phone = $2 LIMIT 1`,
    [clientId, phone],
  );
  const created = existing.rows.length === 0;
  const ins = await pg.query(
    `INSERT INTO conversations (
       client_id, phone, display_name, status, bot_mode, conversation_stage, metadata, last_message_preview
     ) VALUES (
       $1, $2, $3, 'open'::conversation_status, 'bot'::bot_mode, 'guest_whatsapp_inbound',
       $4::jsonb, $5
     )
     ON CONFLICT (client_id, phone) DO UPDATE SET
       display_name = COALESCE(NULLIF(EXCLUDED.display_name, ''), conversations.display_name),
       metadata = conversations.metadata || EXCLUDED.metadata,
       last_message_preview = EXCLUDED.last_message_preview,
       updated_at = NOW()
     RETURNING id::text AS conversation_id`,
    [clientId, phone, displayName, JSON.stringify(metadata), preview.slice(0, 500)],
  );
  const conversationId = ins.rows[0] && ins.rows[0].conversation_id;
  if (!conversationId) return null;

  const locationId = extractLocationFromMetadata(metadata);
  await upsertCustomerFromInboundTouch(pg, {
    client_slug: clientSlug,
    client_id: clientId,
    phone,
    display_name: displayName,
    location_id: locationId,
    conversation_id: conversationId,
  });

  return {
    conversation_id: conversationId,
    created,
    metadata,
    guest_phone: phone,
    guest_name: trimStr(contactName) || null,
    location_id: extractLocationFromMetadata(metadata),
    client_id: clientId,
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
      location_id: i.location_id,
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
    message_type: i.message_type,
    message_timestamp: i.message_timestamp,
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

  const modeInfo = await loadClientWhatsAppChannelMode(pg, i.client_slug);
  const whatsappMode = modeInfo.whatsapp_mode || 'auto';
  const clientId = modeInfo.client_id || ensured.client_id;

  // Off: suppress both sent-bubble and draft staging.
  if (whatsappMode === 'off') {
    return {
      ok: true,
      conversation_id: conversationId,
      direction: 'outbound',
      whatsapp_channel_mode: 'off',
      thread: {
        persisted: false,
        duplicate: false,
        suppressed: true,
        reason: 'inbox_channel_mode_off',
        source: 'hermes_luna_whatsapp_reply',
      },
      draft: null,
      staff_notification: null,
    };
  }

  // Draft: stage pending approval for portal review; do not insert a sent bubble.
  if (whatsappMode === 'draft') {
    const staged = await stageHermesWhatsAppOutboundDraft(pg, {
      client_id: clientId,
      client_slug: i.client_slug,
      conversation_id: conversationId,
      message_text: i.message_text,
      idempotency_key: i.idempotency_key,
    });
    return {
      ok: staged.ok === true,
      conversation_id: conversationId,
      direction: 'outbound',
      whatsapp_channel_mode: 'draft',
      thread: {
        persisted: false,
        duplicate: false,
        draft_staged: staged.staged === true,
        reason: staged.staged ? 'inbox_channel_mode_draft' : (staged.reason || 'draft_stage_failed'),
        source: 'hermes_luna_whatsapp_draft',
        approval_id: staged.approval_id || null,
      },
      draft: staged.staged
        ? {
          approval_id: staged.approval_id,
          draft_text: staged.draft_text,
          status: staged.status || 'pending',
          draft_available: true,
        }
        : null,
      staff_notification: null,
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
    whatsapp_channel_mode: 'auto',
    thread,
    staff_notification,
  };
}

module.exports = {
  parseHermesWhatsAppThreadMirrorBody,
  assertHermesMirrorTenantScope,
  ensureConversationForGuestPhone,
  mirrorHermesWhatsAppThreadMessage,
  loadClientWhatsAppChannelMode,
  stageHermesWhatsAppOutboundDraft,
  expirePendingWhatsAppDraftForConversation,
  SQL_CLIENT_WHATSAPP_MODE,
  SQL_UPSERT_HERMES_DRAFT,
  SQL_EXPIRE_PENDING_WHATSAPP_DRAFT,
};

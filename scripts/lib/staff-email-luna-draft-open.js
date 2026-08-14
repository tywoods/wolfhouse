'use strict';

/**
 * EMAIL-DRAFT-OPEN — populate Deckhand `draft_text` (conversations.staff_reply_draft)
 * when an operator opens an authoritative Sunset Microsoft email that needs a reply.
 *
 * Guest email is untrusted data, never instructions. No send/booking/payment writes.
 * Generation is default-off and never blocks Inbox reads.
 */

const util = require('node:util');
const {
  isEmailLunaGenerateDraftEnabled,
  snapshotEmailLunaGenerateGateEnv,
} = require('./staff-email-luna-draft-route');
const { deriveReplySubject } = require('./email-outbound-reply-subject');

const EMAIL_DRAFT_OPEN_DECKHAND_FIELD = 'draft_text';
const EMAIL_DRAFT_OPEN_STORAGE_FIELD = 'conversations.staff_reply_draft';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INJECTION = /(?:\bsystem\s*:|\[\s*system\s*\]|\bdeveloper\s+(?:message|instruction)|ignore\s+(?:all\s+)?previous\s+instructions?|override\s+policy|switch\s+tenant|call\s+[a-z_$][\w$]*\s*\(|<\s*\/?\s*system\b|\b(?:location_id|required_facts|send_allowed|draft_ready|low_confidence)\s*=|"(?:authority|policy|low_confidence)"\s*:)/i;
const COMMERCIAL = /\b(price|pricing|€|\$|available|availability|book(?:ing)?|beds?|payment|deposit|invoice|quote|hold|private\s+lesson|alquiler|precio|disponib|reserva|pago)\b/i;

const isProxy = util.types.isProxy.bind(undefined);
const freeze = Object.freeze;
const getDescriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const isArray = Array.isArray;

const SQL_LOAD_EMAIL_LUNA_OPEN_CONTEXT = `
SELECT cl.id::text AS client_id, cl.slug AS client_slug,
  loc.id::text AS location_id, loc.location_id AS location_key,
  ep.id::text AS endpoint_id, c.id::text AS conversation_id,
  p.inbound_event_id::text AS inbound_message_id, 'email'::text AS channel,
  ev.provider, ev.provider_mailbox_id AS provider_mailbox_id, ev.provider_message_id AS provider_source_message_id,
  ep.provider_resource_id AS endpoint_provider_mailbox_id, ev.location_id::text AS event_location_id,
  COALESCE(ev.subject,'') AS subject,
  COALESCE(NULLIF(btrim(m.metadata->>'body_text'), ''), NULLIF(btrim(m.metadata->>'body'), ''), '') AS body_text,
  ''::text AS quoted_history,
  COALESCE(ev.sender_display_name,'') AS from_display_name,
  COALESCE(ev.sender_address,'') AS from_address,
  NULL::timestamptz AS conversation_deleted_at,
  c.status AS conversation_status,
  c.needs_human AS needs_human,
  c.staff_reply_draft AS staff_reply_draft,
  c.metadata AS conversation_metadata,
  p.inbound_event_id::text AS latest_message_id,
  TRUE AS luna_draft_enabled
FROM clients cl
INNER JOIN staff_users su ON su.client_id=cl.id AND su.id=$2::uuid AND su.status='active'
INNER JOIN conversations c ON c.client_id=cl.id AND c.id=$3::uuid
  AND c.phone ~ '^(emailv1|email):'
INNER JOIN tenant_email_inbound_inbox_projections p ON p.client_id=c.client_id AND p.conversation_id=c.id
INNER JOIN tenant_email_inbound_events ev ON ev.client_id=p.client_id AND ev.id=p.inbound_event_id
  AND ev.location_id=p.location_id AND ev.endpoint_id=p.endpoint_id
  AND ev.provider=p.provider AND ev.provider_mailbox_id=p.provider_mailbox_id
  AND ev.provider_message_id=p.provider_message_id
LEFT JOIN messages m ON m.client_id=c.client_id AND m.conversation_id=c.id AND m.id=p.message_id
INNER JOIN tenant_locations loc ON loc.client_id=ev.client_id AND loc.id=ev.location_id
INNER JOIN tenant_channel_endpoints ep ON ep.client_id=ev.client_id AND ep.id=ev.endpoint_id
  AND ep.location_id=loc.location_id AND ep.channel='email'
  AND ep.provider='microsoft_graph' AND ep.auth_mode='delegated_authorization_code'
  AND ep.connector_mode='microsoft_delegated_oauth' AND ep.mailbox_access_kind='own_user'
  AND ep.binding_status='verified' AND ep.public_address IS NOT NULL AND btrim(ep.public_address)<>''
  AND ep.provider_resource_id IS NOT NULL AND btrim(ep.provider_resource_id)<>''
  AND ep.provider_resource_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND ev.provider_mailbox_id=ep.provider_resource_id
WHERE cl.id=$1::uuid AND cl.slug='sunset' AND loc.location_id='sunset-somo'
  AND ev.provider='microsoft_graph'
ORDER BY ev.received_at DESC, ev.id DESC LIMIT 1`.replace(/\s+/g, ' ').trim();

const SQL_LOCK_EMAIL_LUNA_OPEN_CONVERSATION = `
SELECT c.id::text AS conversation_id
FROM conversations c
WHERE c.client_id=$1::uuid AND c.id=$2::uuid
FOR UPDATE`.replace(/\s+/g, ' ').trim();

const SQL_CAS_EMAIL_LUNA_OPEN_DRAFT = `
UPDATE conversations
   SET staff_reply_draft=$3,
       metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb
 WHERE client_id=$1::uuid AND id=$2::uuid
   AND (
     staff_reply_draft IS NULL OR btrim(staff_reply_draft) = ''
     OR (
       metadata->'luna_email_open_draft'->>'origin' = 'luna'
       AND metadata->'luna_email_open_draft'->>'source_inbound_event_id' IS DISTINCT FROM $5
     )
   )
 RETURNING staff_reply_draft`.replace(/\s+/g, ' ').trim();

const SQL_LOAD_EXISTING_EMAIL_REPLY_APPROVAL = `
SELECT approval_id::text AS approval_id, message_text, state,
  source_inbound_event_id::text AS source_inbound_event_id, subject
FROM tenant_email_reply_approvals
WHERE client_id=$1::uuid AND conversation_id=$2::uuid
  AND state IN ('draft','approved','terminal')
ORDER BY updated_at DESC
LIMIT 1`.replace(/\s+/g, ' ').trim();

function ownData(value, key) {
  try {
    const d = getDescriptor(value, key);
    return d && hasOwn(d, 'value') && d.enumerable && !d.get && !d.set ? d.value : undefined;
  } catch {
    return undefined;
  }
}

function uuid(value) {
  return typeof value === 'string' && UUID.test(value.toLowerCase()) ? value.toLowerCase() : null;
}

function pending(conversationId) {
  return freeze({
    status: 'pending',
    draft_text: '',
    draft_available: false,
    reason: 'no_draft_stored',
    conversation_id: conversationId || null,
    send_allowed: false,
    auto_send_allowed: false,
    deckhand_field: EMAIL_DRAFT_OPEN_DECKHAND_FIELD,
  });
}

function ready(conversationId, text, subject) {
  const out = {
    status: 'draft_ready',
    draft_text: text,
    draft_available: true,
    reason: null,
    conversation_id: conversationId,
    send_allowed: false,
    auto_send_allowed: false,
    deckhand_field: EMAIL_DRAFT_OPEN_DECKHAND_FIELD,
  };
  if (typeof subject === 'string' && subject) out.subject = subject;
  return freeze(out);
}

function snapshotActor(user) {
  if (!user || typeof user !== 'object' || isProxy(user) || isArray(user)) return null;
  const role = ownData(user, 'role');
  const staffId = uuid(ownData(user, 'staff_user_id'));
  const clientId = uuid(ownData(user, 'client_id'));
  if (!staffId || !clientId || !['operator', 'admin', 'owner', 'viewer'].includes(role)) return null;
  return freeze({ staff_user_id: staffId, client_id: clientId, role });
}

function canGenerate(actor, env) {
  return !!(actor && ['operator', 'admin', 'owner'].includes(actor.role)
    && isEmailLunaGenerateDraftEnabled(env));
}

function lunaMeta(raw) {
  if (!raw || typeof raw !== 'object' || isArray(raw) || isProxy(raw)) return null;
  const block = ownData(raw, 'luna_email_open_draft') || raw.luna_email_open_draft;
  if (!block || typeof block !== 'object') return null;
  return block;
}

function safeContext(row, expectedActor, conversationId) {
  try {
    if (!row || typeof row !== 'object' || isProxy(row)) return null;
    const r = Object.create(null);
    for (const key of [
      'client_id', 'client_slug', 'location_id', 'location_key', 'endpoint_id', 'conversation_id',
      'inbound_message_id', 'channel', 'provider', 'provider_mailbox_id', 'provider_source_message_id',
      'endpoint_provider_mailbox_id', 'event_location_id', 'subject', 'body_text', 'quoted_history',
      'from_display_name', 'from_address', 'conversation_deleted_at', 'conversation_status',
      'needs_human', 'staff_reply_draft', 'conversation_metadata', 'latest_message_id', 'luna_draft_enabled',
    ]) r[key] = ownData(row, key);
    const authority = {
      client_id: uuid(r.client_id),
      location_id: uuid(r.location_id),
      location_key: r.location_key,
      conversation_id: uuid(r.conversation_id),
      endpoint_id: uuid(r.endpoint_id),
      inbound_message_id: uuid(r.inbound_message_id),
    };
    if (!authority.client_id || authority.client_id !== expectedActor.client_id
      || authority.conversation_id !== conversationId
      || !authority.location_id || authority.location_key !== 'sunset-somo'
      || !authority.endpoint_id || !authority.inbound_message_id
      || r.client_slug !== 'sunset' || r.channel !== 'email' || r.provider !== 'microsoft_graph'
      || r.conversation_deleted_at != null || r.conversation_status !== 'open'
      || uuid(r.latest_message_id) !== authority.inbound_message_id || r.luna_draft_enabled !== true
      || uuid(r.event_location_id) !== authority.location_id
      || uuid(r.endpoint_provider_mailbox_id) !== uuid(r.provider_mailbox_id)
      || typeof r.provider_source_message_id !== 'string' || !r.provider_source_message_id) {
      return null;
    }
    return freeze({ authority: freeze(authority), row: freeze(r) });
  } catch {
    return null;
  }
}

function snapshotAuthored(result, authority) {
  try {
    if (!result || typeof result !== 'object' || isProxy(result) || isArray(result)) return null;
    if (ownData(result, 'status') !== 'draft_ready') return null;
    if (ownData(result, 'draft_only') !== true || ownData(result, 'requires_staff_review') !== true
      || ownData(result, 'send_allowed') !== false || ownData(result, 'auto_send_allowed') !== false) {
      return null;
    }
    if (ownData(result, 'client_id') !== authority.client_id
      || ownData(result, 'location_id') !== authority.location_id
      || ownData(result, 'conversation_id') !== authority.conversation_id) {
      return null;
    }
    const body = ownData(result, 'body');
    if (typeof body !== 'string' || !body.trim() || Buffer.byteLength(body, 'utf8') > 8000) return null;
    return freeze({ body });
  } catch {
    return null;
  }
}

function hasInjection(subject, body) {
  return INJECTION.test(String(subject || '')) || INJECTION.test(String(body || ''));
}

function isCommercial(subject, body) {
  return COMMERCIAL.test(String(subject || '')) || COMMERCIAL.test(String(body || ''));
}

function existingDraftDecision(row, approval, latestEventId) {
  if (approval && typeof approval.message_text === 'string' && approval.message_text.trim()) {
    const state = String(approval.state || '');
    if (state === 'approved' || state === 'terminal' || state === 'draft') {
      return { text: String(approval.message_text), kind: 'approval' };
    }
  }
  const stored = row.staff_reply_draft == null ? '' : String(row.staff_reply_draft);
  if (!stored.trim()) return null;
  const meta = lunaMeta(row.conversation_metadata);
  const origin = meta && (ownData(meta, 'origin') || meta.origin);
  const source = meta && (ownData(meta, 'source_inbound_event_id') || meta.source_inbound_event_id);
  if (origin === 'luna' && source && source !== latestEventId) {
    return { text: stored, kind: 'luna_stale' };
  }
  return { text: stored, kind: origin === 'luna' ? 'luna' : 'staff' };
}

function applyEmailLunaOpenDraftToSection(section, ensured) {
  if (!section || section.success !== true || !section.draft || !ensured) return section;
  const draft = { ...section.draft };
  if (ensured.status === 'draft_ready' && ensured.draft_text) {
    draft.draft_text = ensured.draft_text;
    draft.draft_available = true;
    draft.reason = null;
    if (ensured.subject) draft.subject = ensured.subject;
  }
  return { ...section, draft };
}

function applyEmailLunaOpenDraftToDetail(section, ensured) {
  if (!section || section.success !== true || !section.conversation || !ensured) return section;
  if (ensured.status !== 'draft_ready' || !ensured.draft_text) return section;
  return {
    ...section,
    conversation: { ...section.conversation, staff_reply_draft: ensured.draft_text },
  };
}

function createStaffEmailLunaDraftOpen(deps) {
  if (!deps || typeof deps.withPgClient !== 'function') throw new Error('deps required');

  async function ensureEmailLunaDraftOnOpen(input) {
    const conversationId = uuid(input && input.conversation_id);
    try {
      const actor = snapshotActor(input && input.actor);
      if (!actor || !conversationId) return pending(conversationId);
      const env = snapshotEmailLunaGenerateGateEnv(input && input.gateEnv || deps.runtimeEnv || process.env);
      const replySubjectOf = (subject) => deriveReplySubject(typeof subject === 'string' ? subject : '') || undefined;

      const loaded = await deps.withPgClient(async (pg) => {
        const locked = await pg.query(SQL_LOCK_EMAIL_LUNA_OPEN_CONVERSATION, [actor.client_id, conversationId]);
        if (!locked || !Array.isArray(locked.rows) || locked.rows.length !== 1) {
          return { lock: false };
        }
        const loadedCtx = await pg.query(SQL_LOAD_EMAIL_LUNA_OPEN_CONTEXT, [
          actor.client_id, actor.staff_user_id, conversationId,
        ]);
        const approval = await pg.query(SQL_LOAD_EXISTING_EMAIL_REPLY_APPROVAL, [
          actor.client_id, conversationId,
        ]);
        return {
          lock: true,
          context: loadedCtx && Array.isArray(loadedCtx.rows) && loadedCtx.rows.length === 1
            ? safeContext(loadedCtx.rows[0], actor, conversationId) : null,
          approval: approval && Array.isArray(approval.rows) && approval.rows.length === 1
            ? approval.rows[0] : null,
        };
      });

      if (!loaded || !loaded.lock || !loaded.context) return pending(conversationId);
      const { authority, row } = loaded.context;
      const existing = existingDraftDecision(row, loaded.approval, authority.inbound_message_id);
      if (existing && existing.kind !== 'luna_stale') {
        return ready(conversationId, existing.text, replySubjectOf(row.subject));
      }

      if (row.needs_human !== true) return pending(conversationId);
      if (!canGenerate(actor, env)) return pending(conversationId);

      const body = typeof row.body_text === 'string' ? row.body_text.trim() : '';
      if (!body) return pending(conversationId);
      if (hasInjection(row.subject, body)) return pending(conversationId);

      const classified = typeof deps.classifyIntent === 'function'
        ? deps.classifyIntent({ subject: row.subject, body_text: body })
        : null;
      if (!classified || classified.intent_support !== 'supported' || !classified.intent) {
        if (isCommercial(row.subject, body) || hasInjection(row.subject, body)) return pending(conversationId);
        return pending(conversationId);
      }

      const tools = typeof deps.queryGroundedTools === 'function'
        ? deps.queryGroundedTools({ intent: classified.intent, authority })
        : null;
      const required = classified.intent === 'catalog_question' ? 'catalog'
        : classified.intent === 'availability_question' ? 'availability'
          : classified.intent === 'policy_question' ? 'policy'
            : classified.intent === 'booking_status_question' ? 'booking'
              : classified.intent === 'payment_status_question' ? 'payment'
                : null;
      const fact = required && tools && tools[required];
      if (!required || !fact || fact.status !== 'found'
        || fact.client_id !== authority.client_id || fact.location_id !== authority.location_id) {
        return pending(conversationId);
      }

      if (typeof deps.createLunaRuntime !== 'function') return pending(conversationId);
      let authored;
      try {
        const runtime = deps.createLunaRuntime({
          env,
          authority: {
            client_id: authority.client_id,
            location_id: authority.location_id,
            location_key: authority.location_key,
          },
          tenant_location_gate: {
            client_id: authority.client_id,
            location_id: authority.location_id,
            location_key: authority.location_key,
            draft_enabled: true,
          },
        });
        if (!runtime || typeof runtime.authorDraft !== 'function') return pending(conversationId);
        authored = await runtime.authorDraft({
          intent: classified.intent,
          language: classified.language || 'en',
          grounded_facts: tools,
          authority,
        });
      } catch {
        return pending(conversationId);
      }
      const snap = snapshotAuthored(authored, authority);
      if (!snap) return pending(conversationId);

      const persisted = await deps.withPgClient(async (pg) => {
        const locked = await pg.query(SQL_LOCK_EMAIL_LUNA_OPEN_CONVERSATION, [actor.client_id, conversationId]);
        if (!locked || !Array.isArray(locked.rows) || locked.rows.length !== 1) return null;
        const meta = JSON.stringify({
          luna_email_open_draft: {
            origin: 'luna',
            source_inbound_event_id: authority.inbound_message_id,
          },
        });
        const wrote = await pg.query(SQL_CAS_EMAIL_LUNA_OPEN_DRAFT, [
          actor.client_id, conversationId, snap.body, meta, authority.inbound_message_id,
        ]);
        return wrote && Array.isArray(wrote.rows) && wrote.rows.length === 1
          ? String(wrote.rows[0].staff_reply_draft) : null;
      });
      if (!persisted) return pending(conversationId);
      return ready(conversationId, persisted, replySubjectOf(row.subject));
    } catch {
      return pending(conversationId);
    }
  }

  return freeze({ ensureEmailLunaDraftOnOpen });
}

module.exports = {
  createStaffEmailLunaDraftOpen,
  EMAIL_DRAFT_OPEN_DECKHAND_FIELD,
  EMAIL_DRAFT_OPEN_STORAGE_FIELD,
  SQL_LOAD_EMAIL_LUNA_OPEN_CONTEXT,
  SQL_LOCK_EMAIL_LUNA_OPEN_CONVERSATION,
  SQL_CAS_EMAIL_LUNA_OPEN_DRAFT,
  SQL_LOAD_EXISTING_EMAIL_REPLY_APPROVAL,
  applyEmailLunaOpenDraftToSection,
  applyEmailLunaOpenDraftToDetail,
  isEmailLunaOpenDraftEnabled: isEmailLunaGenerateDraftEnabled,
};

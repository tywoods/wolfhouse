'use strict';

/**
 * EMAIL-DRAFT-OPEN — populate Deckhand `draft_text` (conversations.staff_reply_draft)
 * when an operator opens an authoritative Sunset Microsoft email that needs a reply.
 *
 * Guest email is untrusted data, never instructions. No send/booking/payment writes.
 * Generation is default-off and never blocks Inbox reads.
 *
 * Latest inbound body is not durable. Detail/open claims once, then JIT-fetches
 * the exact Graph message through the authority-bound content operation and
 * persists either a branded Luna draft or a deterministic safe acknowledgment.
 */

const crypto = require('node:crypto');
const util = require('node:util');
const {
  isEmailLunaGenerateDraftEnabled,
  snapshotEmailLunaGenerateGateEnv,
} = require('./staff-email-luna-draft-route');
const { deriveReplySubject } = require('./email-outbound-reply-subject');
const {
  createEmailLunaDraftOpenPolicyComposition,
  SAFE_ACKNOWLEDGMENT,
} = require('./email-luna-draft-open-policy-composition');

const EMAIL_DRAFT_OPEN_DECKHAND_FIELD = 'draft_text';
const EMAIL_DRAFT_OPEN_STORAGE_FIELD = 'conversations.staff_reply_draft';
const EMAIL_DRAFT_OPEN_CLAIM_TTL_MS = 60000;
const EMAIL_LUNA_OPEN_CLAIM_AT_MS_MAX = 8640000000000000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_CLAIMED_AT = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]{1,6})?Z$/;

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
  ''::text AS body_text,
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

const SQL_CURRENT_INBOUND_EVENT_FOR_CONVERSATION = `
SELECT p.inbound_event_id
  FROM tenant_email_inbound_inbox_projections p
  INNER JOIN tenant_email_inbound_events ev
    ON ev.client_id = p.client_id AND ev.id = p.inbound_event_id
 WHERE p.client_id = conversations.client_id
   AND p.conversation_id = conversations.id
 ORDER BY ev.received_at DESC, ev.id DESC
 LIMIT 1`.replace(/\s+/g, ' ').trim();

// Deployed Sunset Postgres is 15 — no pg_input_is_valid (PG 16+). Never cast
// metadata text to timestamptz: COALESCE(text::timestamptz) throws forever on
// malformed claimed_at. Nested CASE avoids evaluating casts unless a predicate
// has already proven the text is digits or a calendar-valid ISO-8601 Z string.
function sqlNoCurrentSourceEmailReplyApproval(eventSql) {
  return `NOT EXISTS ( SELECT 1 FROM tenant_email_reply_approvals a WHERE a.client_id = conversations.client_id AND a.conversation_id = conversations.id AND a.source_inbound_event_id = ${eventSql}::uuid AND a.state IN ('draft','approved','terminal') )`;
}

function sqlEmailLunaOpenDraftClaimExpired(metadataSql, ttlSql) {
  const msText = `(${metadataSql}->'luna_email_open_draft'->>'claimed_at_ms')`;
  const isoText = `(${metadataSql}->'luna_email_open_draft'->>'claimed_at')`;
  const nowMs = '(EXTRACT(EPOCH FROM now()) * 1000)';
  const ttl = `((${ttlSql})::numeric)`;
  const y = `SUBSTRING(${isoText}, 1, 4)::int`;
  const mo = `SUBSTRING(${isoText}, 6, 2)::int`;
  const d = `SUBSTRING(${isoText}, 9, 2)::int`;
  const h = `SUBSTRING(${isoText}, 12, 2)::int`;
  const mi = `SUBSTRING(${isoText}, 15, 2)::int`;
  const sec = `SUBSTRING(${isoText}, 18, 2)::int`;
  const frac = `COALESCE(('0' || SUBSTRING(${isoText} FROM '\\.[0-9]{1,6}'))::numeric, 0)`;
  const leap = `((${y} % 400 = 0) OR (${y} % 4 = 0 AND ${y} % 100 <> 0))`;
  const dim = `(CASE ${mo} WHEN 1 THEN 31 WHEN 2 THEN CASE WHEN ${leap} THEN 29 ELSE 28 END WHEN 3 THEN 31 WHEN 4 THEN 30 WHEN 5 THEN 31 WHEN 6 THEN 30 WHEN 7 THEN 31 WHEN 8 THEN 31 WHEN 9 THEN 30 WHEN 10 THEN 31 WHEN 11 THEN 30 WHEN 12 THEN 31 ELSE 0 END)`;
  // Year 0000 matches the 4-digit ISO regex but make_timestamptz(0, ...) throws.
  // Reject it in the calendar predicate so the expired branch never casts.
  const calendarOk = `(${y} BETWEEN 1 AND 9999 AND ${mo} BETWEEN 1 AND 12 AND ${d} BETWEEN 1 AND ${dim} AND ${h} BETWEEN 0 AND 23 AND ${mi} BETWEEN 0 AND 59 AND ${sec} BETWEEN 0 AND 59)`;
  const isoMs = `(EXTRACT(EPOCH FROM make_timestamptz(${y}, ${mo}, ${d}, ${h}, ${mi}, (${sec}::numeric + ${frac}), 'UTC')) * 1000)`;
  return `(CASE WHEN ${msText} ~ '^[0-9]{1,16}$' THEN CASE WHEN ${msText}::numeric >= 0 AND ${msText}::numeric <= ${EMAIL_LUNA_OPEN_CLAIM_AT_MS_MAX} THEN ${msText}::numeric <= (${nowMs} - ${ttl}) ELSE TRUE END WHEN ${isoText} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?Z$' THEN CASE WHEN ${calendarOk} THEN ${isoMs} <= (${nowMs} - ${ttl}) ELSE TRUE END ELSE TRUE END)`;
}

const SQL_EMAIL_LUNA_OPEN_DRAFT_CLAIM_EXPIRED = sqlEmailLunaOpenDraftClaimExpired('metadata', '$5');

// Shared serialization with staff save (staff-email-inbox-routes SQL_RESOLVE):
// same join order, FOR UPDATE OF c,p,ev,ep. Short READ COMMITTED tx only —
// never hold this lock across Graph or the model. The following claim/CAS
// UPDATE is a separate statement so its snapshot is taken after the lock.
const SQL_LOCK_EMAIL_LUNA_OPEN_CONVERSATION = `
SELECT c.id::text AS conversation_id,
  p.inbound_event_id::text AS inbound_event_id,
  ev.provider AS provider,
  ev.location_id::text AS event_location_id,
  loc.location_id AS location_key,
  ev.provider_mailbox_id AS provider_mailbox_id,
  ep.provider_resource_id AS endpoint_provider_mailbox_id
FROM clients cl
INNER JOIN staff_users su ON su.client_id=cl.id AND su.id=$2::uuid AND su.status='active'
  AND su.role IN ('operator','admin','owner')
INNER JOIN conversations c ON c.client_id=cl.id AND c.id=$3::uuid
  AND c.phone ~ '^(emailv1|email):'
INNER JOIN tenant_email_inbound_inbox_projections p ON p.client_id=cl.id AND p.conversation_id=c.id
INNER JOIN tenant_email_inbound_events ev ON ev.client_id=p.client_id AND ev.id=p.inbound_event_id
  AND ev.location_id=p.location_id AND ev.endpoint_id=p.endpoint_id
  AND ev.provider=p.provider AND ev.provider_mailbox_id=p.provider_mailbox_id
  AND ev.provider_message_id=p.provider_message_id
INNER JOIN tenant_locations loc ON loc.client_id=ev.client_id AND loc.id=ev.location_id
INNER JOIN tenant_channel_endpoints ep ON ep.client_id=ev.client_id AND ep.id=ev.endpoint_id
  AND ep.location_id=loc.location_id AND ep.channel='email'
  AND ep.provider='microsoft_graph'
WHERE cl.id=$1::uuid AND loc.location_id='sunset-somo' AND ev.provider='microsoft_graph'
ORDER BY ev.received_at DESC, ev.id DESC
LIMIT 1
FOR UPDATE OF c,p,ev,ep`.replace(/\s+/g, ' ').trim();

const SQL_EMAIL_LUNA_OPEN_TX_BEGIN = 'BEGIN';
const SQL_EMAIL_LUNA_OPEN_TX_COMMIT = 'COMMIT';
const SQL_EMAIL_LUNA_OPEN_TX_ROLLBACK = 'ROLLBACK';
const PG_CLIENT_DISCARD_REQUIRED = Symbol.for('wolfhouse.pgClient.discardRequired');

const SQL_CLAIM_EMAIL_LUNA_OPEN_DRAFT = `
UPDATE conversations
   SET metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
 WHERE client_id=$1::uuid AND id=$2::uuid
   AND $4::uuid = (${SQL_CURRENT_INBOUND_EVENT_FOR_CONVERSATION})
   AND (
     (
       (staff_reply_draft IS NULL OR btrim(staff_reply_draft) = '')
       AND ($7::text IS NULL OR btrim($7::text) = '')
     )
     OR (
       metadata->'luna_email_open_draft'->>'origin' = 'luna'
       AND metadata->'luna_email_open_draft'->>'source_inbound_event_id' IS DISTINCT FROM $4::text
       AND metadata->'luna_email_open_draft'->>'generated_body_sha256' IS NOT NULL
       AND metadata->'luna_email_open_draft'->>'generated_body_sha256' = $6
       AND staff_reply_draft IS NOT DISTINCT FROM $7
     )
   )
   AND (
     metadata->'luna_email_open_draft'->>'state' IS DISTINCT FROM 'in_progress'
     OR ${SQL_EMAIL_LUNA_OPEN_DRAFT_CLAIM_EXPIRED}
   )
   AND ${sqlNoCurrentSourceEmailReplyApproval('$4')}
 RETURNING id::text AS conversation_id`.replace(/\s+/g, ' ').trim();

const SQL_CAS_EMAIL_LUNA_OPEN_DRAFT = `
UPDATE conversations
   SET staff_reply_draft=$3,
       metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb
 WHERE client_id=$1::uuid AND id=$2::uuid
   AND metadata->'luna_email_open_draft'->>'claim_id' = $5
   AND metadata->'luna_email_open_draft'->>'state' = 'in_progress'
   AND $6::uuid = (${SQL_CURRENT_INBOUND_EVENT_FOR_CONVERSATION})
   AND staff_reply_draft IS NOT DISTINCT FROM $7
   AND ${sqlNoCurrentSourceEmailReplyApproval('$6')}
 RETURNING staff_reply_draft`.replace(/\s+/g, ' ').trim();

const SQL_RELEASE_EMAIL_LUNA_OPEN_CLAIM = `
UPDATE conversations
   SET metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
 WHERE client_id=$1::uuid AND id=$2::uuid
   AND metadata->'luna_email_open_draft'->>'claim_id' = $4
   AND metadata->'luna_email_open_draft'->>'state' = 'in_progress'
 RETURNING id::text AS conversation_id`.replace(/\s+/g, ' ').trim();

const SQL_LOAD_EXISTING_EMAIL_REPLY_APPROVAL = `
SELECT approval_id::text AS approval_id, message_text, state,
  source_inbound_event_id::text AS source_inbound_event_id, subject
FROM tenant_email_reply_approvals
WHERE client_id=$1::uuid AND conversation_id=$2::uuid
  AND source_inbound_event_id = $3::uuid
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

function digestGeneratedEmailLunaDraftBody(text) {
  if (typeof text !== 'string') return null;
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function daysInClaimMonth(year, month) {
  if (month === 2) {
    return (year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0)) ? 29 : 28;
  }
  return [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] || 0;
}

function parseIsoClaimedAtMs(text) {
  if (typeof text !== 'string') return NaN;
  const match = ISO_CLAIMED_AT.exec(text);
  if (!match) return NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)
    || !Number.isInteger(hour) || !Number.isInteger(minute) || !Number.isInteger(second)) {
    return NaN;
  }
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > daysInClaimMonth(year, month)
    || hour > 23 || minute > 59 || second > 59) {
    return NaN;
  }
  let millis = 0;
  if (match[7]) {
    millis = Number(match[7].slice(1).padEnd(3, '0').slice(0, 3));
    if (!Number.isInteger(millis)) return NaN;
  }
  const ms = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  return Number.isFinite(ms) ? ms : NaN;
}

function parseClaimedAtMsValue(raw) {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw >= 0 && raw <= EMAIL_LUNA_OPEN_CLAIM_AT_MS_MAX
      ? raw : NaN;
  }
  if (typeof raw === 'string' && /^[0-9]{1,16}$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= EMAIL_LUNA_OPEN_CLAIM_AT_MS_MAX ? n : NaN;
  }
  return NaN;
}

function parseEmailLunaOpenDraftClaimedAtMs(meta) {
  if (!meta || typeof meta !== 'object' || isArray(meta) || isProxy(meta)) return NaN;
  const block = ownData(meta, 'luna_email_open_draft') || meta.luna_email_open_draft || meta;
  if (!block || typeof block !== 'object' || isArray(block) || isProxy(block)) return NaN;
  const fromMs = parseClaimedAtMsValue(ownData(block, 'claimed_at_ms') ?? block.claimed_at_ms);
  if (Number.isFinite(fromMs)) return fromMs;
  return parseIsoClaimedAtMs(ownData(block, 'claimed_at') || block.claimed_at);
}

function digestsEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
  } catch {
    return false;
  }
}

function expectedStoredDraft(value) {
  if (value == null) return null;
  return String(value);
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

function existingDraftDecision(row, approval, latestEventId, nowMs, ttlMs) {
  const latest = uuid(latestEventId);
  const approvalText = approval && typeof approval.message_text === 'string'
    ? String(approval.message_text) : '';
  const approvalSource = approval
    ? uuid(ownData(approval, 'source_inbound_event_id') || approval.source_inbound_event_id)
    : null;
  const approvalState = approval ? String(approval.state || '') : '';
  const approvalForCurrent = !!(
    approvalText.trim()
    && latest
    && approvalSource === latest
    && (approvalState === 'draft' || approvalState === 'approved' || approvalState === 'terminal')
  );
  if (approvalForCurrent && approvalState === 'draft') {
    return { text: approvalText, kind: 'approval' };
  }
  if (approvalForCurrent) {
    return { text: approvalText, kind: 'approval_terminal' };
  }
  const stored = row.staff_reply_draft == null ? '' : String(row.staff_reply_draft);
  const meta = lunaMeta(row.conversation_metadata);
  const origin = meta && (ownData(meta, 'origin') || meta.origin);
  const source = meta && (ownData(meta, 'source_inbound_event_id') || meta.source_inbound_event_id);
  const state = meta && (ownData(meta, 'state') || meta.state);
  const proof = meta && (ownData(meta, 'generated_body_sha256') || meta.generated_body_sha256);
  if (state === 'in_progress') {
    const claimedMs = parseEmailLunaOpenDraftClaimedAtMs(meta);
    const expired = !Number.isFinite(claimedMs) || (nowMs - claimedMs) >= ttlMs;
    if (!expired) return { text: stored, kind: 'in_progress' };
  }
  if (!stored.trim()) return null;
  const computed = digestGeneratedEmailLunaDraftBody(stored);
  const lunaOwned = origin === 'luna' && digestsEqual(proof, computed);
  if (lunaOwned && source && source !== latestEventId) {
    return { text: stored, kind: 'luna_stale', digest: proof };
  }
  if (lunaOwned && source === latestEventId) {
    return { text: stored, kind: 'luna', digest: proof };
  }
  return { text: stored, kind: 'staff' };
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

function claimPayload(eventId, claimId, claimedAt, claimedAtMs) {
  const parsedMs = Number.isFinite(claimedAtMs) ? claimedAtMs : parseIsoClaimedAtMs(claimedAt);
  const block = {
    state: 'in_progress',
    origin: 'luna',
    source_inbound_event_id: eventId,
    claimed_at: claimedAt,
    claim_id: claimId,
  };
  if (Number.isFinite(parsedMs) && parsedMs >= 0 && parsedMs <= EMAIL_LUNA_OPEN_CLAIM_AT_MS_MAX) {
    block.claimed_at_ms = String(Math.trunc(parsedMs));
  }
  return JSON.stringify({
    luna_email_open_draft: block,
  });
}

function persistPayload(eventId, claimId, kind, generatedBodySha256) {
  return JSON.stringify({
    luna_email_open_draft: {
      state: 'ready',
      origin: 'luna',
      source_inbound_event_id: eventId,
      claim_id: claimId,
      kind,
      generated_body_sha256: generatedBodySha256,
    },
  });
}

function releasePayload(eventId, claimId) {
  return JSON.stringify({
    luna_email_open_draft: {
      state: 'failed',
      origin: 'luna',
      source_inbound_event_id: eventId,
      claim_id: claimId,
    },
  });
}

function createStaffEmailLunaDraftOpen(deps) {
  if (!deps || typeof deps.withPgClient !== 'function') throw new Error('deps required');
  const nowFn = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const uuidFn = typeof deps.randomUUID === 'function' ? deps.randomUUID : () => crypto.randomUUID();
  const ttlMs = Number.isSafeInteger(deps.claimTtlMs) && deps.claimTtlMs > 0
    ? deps.claimTtlMs
    : EMAIL_DRAFT_OPEN_CLAIM_TTL_MS;
  const policy = createEmailLunaDraftOpenPolicyComposition({
    classifyIntent: deps.classifyIntent,
    queryOwners: deps.queryOwners,
    createLunaRuntime: deps.createLunaRuntime,
  });

  function markDiscard(client) {
    if (typeof deps.markPgClientDiscardRequired === 'function') {
      deps.markPgClientDiscardRequired(client);
      return;
    }
    if (client && typeof client === 'object') {
      client[PG_CLIENT_DISCARD_REQUIRED] = true;
    }
  }

  async function rollbackOrDiscard(pg) {
    try {
      await pg.query(SQL_EMAIL_LUNA_OPEN_TX_ROLLBACK);
    } catch {
      markDiscard(pg);
      const err = new Error('transaction_cleanup_failed');
      err.code = 'transaction_cleanup_failed';
      throw err;
    }
  }

  // BEGIN → SELECT conversation FOR UPDATE → separate claim/CAS UPDATE → COMMIT.
  // Snapshot of the UPDATE is acquired after the lock under READ COMMITTED.
  async function lockThenWrite(actor, conversationId, expectedEventId, writeFn) {
    return deps.withPgClient(async (pg) => {
      let began = false;
      let settled = false;
      try {
        await pg.query(SQL_EMAIL_LUNA_OPEN_TX_BEGIN);
        began = true;
        const locked = await pg.query(SQL_LOCK_EMAIL_LUNA_OPEN_CONVERSATION, [
          actor.client_id, actor.staff_user_id, conversationId,
        ]);
        const row = locked && Array.isArray(locked.rows) && locked.rows.length === 1
          ? locked.rows[0] : null;
        const lockedEvent = row ? uuid(row.inbound_event_id) : null;
        if (!row || lockedEvent !== expectedEventId
          || row.provider !== 'microsoft_graph'
          || row.location_key !== 'sunset-somo') {
          await rollbackOrDiscard(pg);
          settled = true;
          return null;
        }
        const wrote = await writeFn(pg);
        await pg.query(SQL_EMAIL_LUNA_OPEN_TX_COMMIT);
        settled = true;
        return wrote;
      } catch (error) {
        if (began && !settled) {
          try {
            await pg.query(SQL_EMAIL_LUNA_OPEN_TX_ROLLBACK);
          } catch {
            markDiscard(pg);
          }
        }
        throw error;
      }
    });
  }

  async function loadOpenContext(actor, conversationId) {
    return deps.withPgClient(async (pg) => {
      const loadedCtx = await pg.query(SQL_LOAD_EMAIL_LUNA_OPEN_CONTEXT, [
        actor.client_id, actor.staff_user_id, conversationId,
      ]);
      const context = loadedCtx && Array.isArray(loadedCtx.rows) && loadedCtx.rows.length === 1
        ? safeContext(loadedCtx.rows[0], actor, conversationId) : null;
      let approval = null;
      if (context && context.authority && context.authority.inbound_message_id) {
        const loadedApproval = await pg.query(SQL_LOAD_EXISTING_EMAIL_REPLY_APPROVAL, [
          actor.client_id, conversationId, context.authority.inbound_message_id,
        ]);
        approval = loadedApproval && Array.isArray(loadedApproval.rows) && loadedApproval.rows.length === 1
          ? loadedApproval.rows[0] : null;
      }
      return { context, approval };
    });
  }

  async function releaseClaim(actor, conversationId, eventId, claimId) {
    try {
      await deps.withPgClient(async (pg) => {
        await pg.query(SQL_RELEASE_EMAIL_LUNA_OPEN_CLAIM, [
          actor.client_id, conversationId, releasePayload(eventId, claimId), claimId,
        ]);
      });
    } catch {
      // Recovery TTL reclaims a stuck in-progress row.
    }
  }

  async function fetchAuthoritativeBody(authority) {
    const input = {
      clientId: authority.client_id,
      locationId: authority.location_id,
      eventId: authority.inbound_message_id,
    };
    if (typeof deps.fetchCurrentMessageContent === 'function') {
      return deps.fetchCurrentMessageContent(input);
    }
    if (typeof deps.createContentFetcher !== 'function') return null;
    return deps.withPgClient(async (pg) => {
      const fetcher = deps.createContentFetcher(pg);
      if (!fetcher || typeof fetcher.getCurrentMessageContent !== 'function') return null;
      return fetcher.getCurrentMessageContent(input);
    });
  }

  async function ensureEmailLunaDraftOnOpen(input) {
    const conversationId = uuid(input && input.conversation_id);
    try {
      const actor = snapshotActor(input && input.actor);
      if (!actor || !conversationId) return pending(conversationId);
      const env = snapshotEmailLunaGenerateGateEnv(input && input.gateEnv || deps.runtimeEnv || process.env);
      const replySubjectOf = (subject) => deriveReplySubject(typeof subject === 'string' ? subject : '') || undefined;

      const loaded = await loadOpenContext(actor, conversationId);
      if (!loaded || !loaded.context) return pending(conversationId);
      const { authority, row } = loaded.context;
      const existing = existingDraftDecision(
        row, loaded.approval, authority.inbound_message_id, nowFn(), ttlMs,
      );
      if (existing && (existing.kind === 'in_progress' || existing.kind === 'approval_terminal')) {
        return pending(conversationId);
      }
      if (existing && existing.kind !== 'luna_stale') {
        return ready(conversationId, existing.text, replySubjectOf(row.subject));
      }

      if (row.needs_human !== true) return pending(conversationId);
      if (!canGenerate(actor, env)) return pending(conversationId);

      const claimId = uuidFn();
      const claimedAtMs = nowFn();
      const claimedAt = new Date(claimedAtMs).toISOString();
      const expectedOldText = existing && existing.kind === 'luna_stale'
        ? expectedStoredDraft(existing.text)
        : expectedStoredDraft(row.staff_reply_draft);
      const expectedDigest = existing && existing.kind === 'luna_stale' && existing.digest
        ? String(existing.digest) : '';
      const claimed = await lockThenWrite(
        actor, conversationId, authority.inbound_message_id, async (pg) => {
          const wrote = await pg.query(SQL_CLAIM_EMAIL_LUNA_OPEN_DRAFT, [
            actor.client_id,
            conversationId,
            claimPayload(authority.inbound_message_id, claimId, claimedAt, claimedAtMs),
            authority.inbound_message_id,
            ttlMs,
            expectedDigest,
            expectedOldText,
          ]);
          return !!(wrote && Array.isArray(wrote.rows) && wrote.rows.length === 1);
        },
      );
      if (!claimed) {
        const again = await loadOpenContext(actor, conversationId);
        if (again && again.context) {
          const retryExisting = existingDraftDecision(
            again.context.row, again.approval, again.context.authority.inbound_message_id, nowFn(), ttlMs,
          );
          if (retryExisting && retryExisting.kind !== 'luna_stale' && retryExisting.kind !== 'in_progress'
              && retryExisting.kind !== 'approval_terminal'
              && retryExisting.text && String(retryExisting.text).trim()) {
            return ready(conversationId, retryExisting.text, replySubjectOf(again.context.row.subject));
          }
        }
        return pending(conversationId);
      }

      let latestText = '';
      try {
        const content = await fetchAuthoritativeBody(authority);
        const text = content && (ownData(content, 'latest_text') || content.latest_text);
        if (typeof text !== 'string' || !text.trim()) {
          await releaseClaim(actor, conversationId, authority.inbound_message_id, claimId);
          return pending(conversationId);
        }
        latestText = text.trim();
      } catch {
        await releaseClaim(actor, conversationId, authority.inbound_message_id, claimId);
        return pending(conversationId);
      }

      const composed = await policy.compose({
        authority,
        untrusted_content: {
          subject: typeof row.subject === 'string' ? row.subject : '',
          body_text: latestText,
          quoted_history: '',
          from_display_name: typeof row.from_display_name === 'string' ? row.from_display_name : '',
          from_address: typeof row.from_address === 'string' ? row.from_address : '',
        },
        env,
        callModel: deps.callModel,
        timeoutMs: deps.timeoutMs,
      });
      const body = composed && typeof composed.body === 'string' ? composed.body.trim() : '';
      if (!body || Buffer.byteLength(body, 'utf8') > 8000) {
        await releaseClaim(actor, conversationId, authority.inbound_message_id, claimId);
        return pending(conversationId);
      }

      const generatedDigest = digestGeneratedEmailLunaDraftBody(body);
      const persisted = await lockThenWrite(
        actor, conversationId, authority.inbound_message_id, async (pg) => {
          const wrote = await pg.query(SQL_CAS_EMAIL_LUNA_OPEN_DRAFT, [
            actor.client_id,
            conversationId,
            body,
            persistPayload(
              authority.inbound_message_id,
              claimId,
              composed.kind || 'safe_acknowledgment',
              generatedDigest,
            ),
            claimId,
            authority.inbound_message_id,
            expectedOldText,
          ]);
          return wrote && Array.isArray(wrote.rows) && wrote.rows.length === 1
            ? String(wrote.rows[0].staff_reply_draft) : null;
        },
      );
      if (!persisted) {
        await releaseClaim(actor, conversationId, authority.inbound_message_id, claimId);
        const again = await loadOpenContext(actor, conversationId);
        if (again && again.context) {
          const retryExisting = existingDraftDecision(
            again.context.row, again.approval, again.context.authority.inbound_message_id, nowFn(), ttlMs,
          );
          if (retryExisting && retryExisting.text && String(retryExisting.text).trim()
              && retryExisting.kind !== 'in_progress' && retryExisting.kind !== 'luna_stale'
              && retryExisting.kind !== 'approval_terminal') {
            return ready(conversationId, retryExisting.text, replySubjectOf(again.context.row.subject));
          }
        }
        return pending(conversationId);
      }
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
  EMAIL_DRAFT_OPEN_CLAIM_TTL_MS,
  EMAIL_LUNA_OPEN_CLAIM_AT_MS_MAX,
  SQL_LOAD_EMAIL_LUNA_OPEN_CONTEXT,
  SQL_LOCK_EMAIL_LUNA_OPEN_CONVERSATION,
  SQL_EMAIL_LUNA_OPEN_TX_BEGIN,
  SQL_EMAIL_LUNA_OPEN_TX_COMMIT,
  SQL_EMAIL_LUNA_OPEN_TX_ROLLBACK,
  SQL_CLAIM_EMAIL_LUNA_OPEN_DRAFT,
  SQL_CAS_EMAIL_LUNA_OPEN_DRAFT,
  SQL_RELEASE_EMAIL_LUNA_OPEN_CLAIM,
  SQL_LOAD_EXISTING_EMAIL_REPLY_APPROVAL,
  SQL_CURRENT_INBOUND_EVENT_FOR_CONVERSATION,
  SQL_EMAIL_LUNA_OPEN_DRAFT_CLAIM_EXPIRED,
  sqlNoCurrentSourceEmailReplyApproval,
  sqlEmailLunaOpenDraftClaimExpired,
  parseEmailLunaOpenDraftClaimedAtMs,
  digestGeneratedEmailLunaDraftBody,
  applyEmailLunaOpenDraftToSection,
  applyEmailLunaOpenDraftToDetail,
  isEmailLunaOpenDraftEnabled: isEmailLunaGenerateDraftEnabled,
  SAFE_ACKNOWLEDGMENT,
};

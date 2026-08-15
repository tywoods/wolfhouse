'use strict';

/**
 * Email inbound → Staff Inbox bridge (Slice 2).
 *
 * Projects durable `tenant_email_inbound_events` into the existing
 * conversations/messages Inbox model with channel=email and location preserved.
 *
 * - Conversation key: UNIQUE(client_id, phone) uses an **opaque** email-channel
 *   identity `emailv1:<match-key>` — never raw sender email in the phone
 *   namespace. EMAIL-MATCH-001 match-key is mailbox + normalized From via the
 *   PR #592 helper API only (`emailconv-from`). Helpers are required
 *   intrinsically; there is no helper-absent fallback key. Real email lives
 *   only in conversations.email (staff contact).
 * - Migration 067 updates sync_customer_from_touch to skip `emailv1:`/`email:`
 *   phones so projections never create customers.phone or merge with WhatsApp.
 * - Location sticks via conversations.metadata.location_id (text kebab from
 *   tenant_locations.location_id resolved from authority UUID).
 * - Exactly-once via tenant_email_inbound_inbox_projections journal (067).
 * - Same sender + same Sunset mailbox → one conversation; distinct messages
 *   per event. Different mailboxes never share a conversation. RFC 5322
 *   In-Reply-To / References threading is deferred: Graph / envelope / 063
 *   event rows do not persist those headers.
 * - Exact same-tenant guests.email bind → conversations.guest_id; unknown /
 *   ambiguous From stays null. Never INSERT guests. Existing email / display
 *   name / guest_id are not overwritten by a later different From.
 * - PII minimization: subject only in message_text + last_message_preview (no
 *   redundant email_subject metadata copies).
 * - Import-inert / default-off: no routes, cron, send, Luna, or activation.
 *
 * @module email-inbound-inbox-bridge
 */

const crypto = require('crypto');
const util = require('util');
const {
  resolveInboundMatchConversationIdentity,
  bindSunsetGuestByExactInboundEmail,
  persistConversationGuestBind,
} = require('./email-inbound-match-ingest');

const FAILURE_CODE = 'inbound_inbox_bridge_failed';
const FAILURE_MESSAGE = 'Inbound email inbox bridge operation failed.';

/** Bridge module is not wired into routes/startup/pollers by itself. */
const EMAIL_INBOUND_INBOX_BRIDGE_RUNTIME_WIRED = false;

/** Must never log envelope/PII field values. */
const EMAIL_INBOUND_INBOX_BRIDGE_LOGGING_FORBIDDEN = true;

const AUTHORITY_KEYS = Object.freeze(['clientId', 'locationId', 'endpointId']);
const STORE_DEPENDENCY_KEYS = Object.freeze(['withTransactionClient']);

const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const PROVIDER_SET = new Set(['microsoft_graph', 'gmail_api', 'imap_smtp']);
const MESSAGE_SOURCE = 'email_inbound';
const MESSAGE_ROUTE = 'email';
const CHANNEL = 'email';
const CONVERSATION_STAGE = 'guest_email_inbound';
const NO_SUBJECT = '(no subject)';
/** Opaque phone-namespace prefix — never a telephone/WhatsApp destination. */
const EMAIL_CHANNEL_IDENTITY_PREFIX = 'emailv1';
const EMAIL_CHANNEL_IDENTITY_DIGEST_VERSION = 'email-inbound-v1';
/** Matches 067 customer-sync skip + this module's identity keys. */
const EMAIL_CHANNEL_PHONE_NAMESPACE_RE = /^(emailv1|email):/;

const PINNED_UTIL_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_UTIL_TYPES && typeof PINNED_UTIL_TYPES.isProxy === 'function'
  ? PINNED_UTIL_TYPES.isProxy
  : null;

const SQL_SELECT_EVENT_BY_ID = `
SELECT
  id::text AS id,
  client_id::text AS client_id,
  location_id::text AS location_id,
  endpoint_id::text AS endpoint_id,
  provider,
  provider_mailbox_id,
  provider_message_id,
  received_at,
  subject,
  sender_display_name,
  sender_address,
  is_read,
  conversation_id,
  internet_message_id
FROM tenant_email_inbound_events e
WHERE e.client_id = $1::uuid
  AND e.location_id = $2::uuid
  AND e.endpoint_id = $3::uuid
  AND e.id = $4::uuid
LIMIT 1
`.replace(/\s+/g, ' ').trim();

const SQL_SELECT_EVENT_BY_IDENTITY = `
SELECT
  id::text AS id,
  client_id::text AS client_id,
  location_id::text AS location_id,
  endpoint_id::text AS endpoint_id,
  provider,
  provider_mailbox_id,
  provider_message_id,
  received_at,
  subject,
  sender_display_name,
  sender_address,
  is_read,
  conversation_id,
  internet_message_id
FROM tenant_email_inbound_events e
WHERE e.client_id = $1::uuid
  AND e.location_id = $2::uuid
  AND e.endpoint_id = $3::uuid
  AND e.provider = $4
  AND e.provider_mailbox_id = $5
  AND e.provider_message_id = $6
LIMIT 1
`.replace(/\s+/g, ' ').trim();

const SQL_SELECT_PROJECTION = `
SELECT
  conversation_id::text AS conversation_id,
  message_id::text AS message_id,
  inbound_event_id::text AS inbound_event_id
FROM tenant_email_inbound_inbox_projections
WHERE client_id = $1::uuid
  AND provider = $2
  AND provider_mailbox_id = $3
  AND provider_message_id = $4
LIMIT 1
`.replace(/\s+/g, ' ').trim();

const SQL_SELECT_LOCATION_TEXT = `
SELECT location_id
FROM tenant_locations
WHERE client_id = $1::uuid
  AND id = $2::uuid
LIMIT 1
`.replace(/\s+/g, ' ').trim();

const SQL_UPSERT_CONVERSATION = `
INSERT INTO conversations (
  client_id, phone, display_name, email, status, bot_mode, conversation_stage,
  last_message_preview, metadata, session_state, needs_human
) VALUES (
  $1::uuid, $2, $3, $4, $5::conversation_status, $6::bot_mode, $7,
  $8, $9::jsonb, $10::jsonb, $11::boolean
)
ON CONFLICT (client_id, phone) DO UPDATE SET
  display_name = COALESCE(NULLIF(conversations.display_name, ''), EXCLUDED.display_name),
  email = COALESCE(conversations.email, EXCLUDED.email),
  last_message_preview = EXCLUDED.last_message_preview,
  metadata = conversations.metadata || EXCLUDED.metadata,
  session_state = conversations.session_state || EXCLUDED.session_state,
  conversation_stage = COALESCE(conversations.conversation_stage, EXCLUDED.conversation_stage),
  needs_human = CASE WHEN EXCLUDED.needs_human THEN TRUE ELSE conversations.needs_human END,
  updated_at = NOW()
RETURNING id::text AS conversation_id,
  (xmax = 0) AS created
`.replace(/\s+/g, ' ').trim();

const SQL_INSERT_MESSAGE = `
INSERT INTO messages (
  client_id, conversation_id, direction, message_text, message_type,
  source, route, metadata
) VALUES (
  $1::uuid, $2::uuid, $3::message_direction, $4, $5,
  $6, $7, $8::jsonb
)
RETURNING id::text AS message_id
`.replace(/\s+/g, ' ').trim();

const SQL_INSERT_PROJECTION = `
INSERT INTO tenant_email_inbound_inbox_projections (
  client_id,
  location_id,
  endpoint_id,
  inbound_event_id,
  provider,
  provider_mailbox_id,
  provider_message_id,
  conversation_id,
  message_id
) VALUES (
  $1::uuid, $2::uuid, $3::uuid, $4::uuid,
  $5, $6, $7,
  $8::uuid, $9::uuid
)
ON CONFLICT (provider, provider_mailbox_id, provider_message_id) DO NOTHING
RETURNING id::text AS id
`.replace(/\s+/g, ' ').trim();

function failure(code) {
  const error = new Error(FAILURE_MESSAGE);
  Object.defineProperty(error, 'name', { value: 'InboundEmailInboxBridgeError' });
  Object.defineProperty(error, 'code', {
    value: typeof code === 'string' && code ? code : FAILURE_CODE,
    enumerable: true,
  });
  return Object.freeze(error);
}

function isProxySurface(value) {
  try {
    if (typeof PINNED_IS_PROXY !== 'function' || !PINNED_UTIL_TYPES) return true;
    return Reflect.apply(PINNED_IS_PROXY, PINNED_UTIL_TYPES, [value]) === true;
  } catch {
    return true;
  }
}

function ownData(object, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor
      && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      && !descriptor.get
      && !descriptor.set
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function exactPlainData(object, keys) {
  try {
    if (!object || typeof object !== 'object' || Array.isArray(object)) return false;
    if (isProxySurface(object)) return false;
    if (Object.getPrototypeOf(object) !== Object.prototype) return false;
    const actual = Reflect.ownKeys(object);
    if (actual.length !== keys.length
        || actual.some((key) => typeof key !== 'string'
          || DANGEROUS_KEYS.has(key)
          || !keys.includes(key))) {
      return false;
    }
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      return Boolean(
        descriptor
        && Object.prototype.hasOwnProperty.call(descriptor, 'value')
        && descriptor.enumerable
        && !descriptor.get
        && !descriptor.set,
      );
    });
  } catch {
    return false;
  }
}

function exactFrozenData(object, keys) {
  return Object.isFrozen(object) && exactPlainData(object, keys);
}

function resolvePgLikeQueryMethod(surface) {
  try {
    if (!surface || (typeof surface !== 'object' && typeof surface !== 'function')) {
      return null;
    }
    if (isProxySurface(surface)) return null;
    const own = Object.getOwnPropertyDescriptor(surface, 'query');
    if (own) {
      if (Object.prototype.hasOwnProperty.call(own, 'value')
          && typeof own.value === 'function'
          && !own.get
          && !own.set) {
        return own.value;
      }
      return null;
    }
    let proto = Object.getPrototypeOf(surface);
    let depth = 0;
    while (proto && proto !== Object.prototype && depth < 8) {
      if (isProxySurface(proto)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'query');
      if (descriptor) {
        if (Object.prototype.hasOwnProperty.call(descriptor, 'value')
            && typeof descriptor.value === 'function'
            && !descriptor.get
            && !descriptor.set) {
          return descriptor.value;
        }
        return null;
      }
      proto = Object.getPrototypeOf(proto);
      depth += 1;
    }
    return null;
  } catch {
    return null;
  }
}

function resolveExclusiveClient(client) {
  try {
    if (client == null || (typeof client !== 'object' && typeof client !== 'function')) {
      return null;
    }
    if (isProxySurface(client)) return null;
    const capturedQuery = resolvePgLikeQueryMethod(client);
    if (typeof capturedQuery !== 'function' || isProxySurface(capturedQuery)) return null;
    const trustedReceiver = client;
    return Object.freeze({
      query(...args) {
        return Reflect.apply(capturedQuery, trustedReceiver, args);
      },
    });
  } catch {
    return null;
  }
}

function resolveWithTransactionClient(raw) {
  try {
    if (typeof raw !== 'function' || isProxySurface(raw)) return null;
    const captured = raw;
    return async function pinnedWithTransactionClient(work) {
      if (typeof work !== 'function' || isProxySurface(work)) {
        throw failure();
      }
      return Reflect.apply(captured, undefined, [
        async function exclusiveLoan(client) {
          const exclusive = resolveExclusiveClient(client);
          if (!exclusive) throw failure();
          return work(exclusive);
        },
      ]);
    };
  } catch {
    return null;
  }
}

function snapshotAuthority(authority) {
  try {
    if (!exactPlainData(authority, AUTHORITY_KEYS)
        && !exactFrozenData(authority, AUTHORITY_KEYS)) {
      // Allow frozen or plain exact keys.
      if (!authority || typeof authority !== 'object' || Array.isArray(authority)) return null;
      if (isProxySurface(authority)) return null;
      if (Object.getPrototypeOf(authority) !== Object.prototype) return null;
      const keys = Reflect.ownKeys(authority).filter((k) => typeof k === 'string');
      if (keys.length !== AUTHORITY_KEYS.length) return null;
      if (!AUTHORITY_KEYS.every((k) => keys.includes(k))) return null;
      if (keys.some((k) => DANGEROUS_KEYS.has(k) || !AUTHORITY_KEYS.includes(k))) return null;
    }
    const clientId = ownData(authority, 'clientId');
    const locationId = ownData(authority, 'locationId');
    const endpointId = ownData(authority, 'endpointId');
    if (typeof clientId !== 'string' || !UUID_CANON.test(clientId)) return null;
    if (typeof locationId !== 'string' || !UUID_CANON.test(locationId)) return null;
    if (typeof endpointId !== 'string' || !UUID_CANON.test(endpointId)) return null;
    return Object.freeze({ clientId, locationId, endpointId });
  } catch {
    return null;
  }
}

function normalizeSenderEmail(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.length > 2048) return null;
  if (!trimmed.includes('@')) return null;
  return trimmed;
}

/**
 * True when a conversations.phone value is an email-channel identity key
 * (must never be treated as a telephone/WhatsApp destination or customer phone).
 *
 * @param {unknown} phone
 * @returns {boolean}
 */
function isEmailChannelPhoneNamespace(phone) {
  return typeof phone === 'string' && EMAIL_CHANNEL_PHONE_NAMESPACE_RE.test(phone);
}

/**
 * Deterministic opaque conversation identity for UNIQUE(client_id, phone).
 * Encodes location + sender as sha256 so the same guest at two beaches never
 * shares a thread, without placing raw sender email in the phone namespace.
 *
 * Format: emailv1:<location_kebab>:<64-hex-sha256>
 *
 * @param {string} locationText kebab location_id (e.g. sunset-somo)
 * @param {string} senderEmail raw or normalized sender address
 * @returns {string|null}
 */
function buildEmailConversationIdentityKey(locationText, senderEmail) {
  const loc = typeof locationText === 'string' ? locationText.trim().toLowerCase() : '';
  const email = normalizeSenderEmail(senderEmail);
  if (!loc || !email) return null;
  if (loc.length > 128 || email.length > 2048) return null;
  const digest = crypto
    .createHash('sha256')
    .update(`${EMAIL_CHANNEL_IDENTITY_DIGEST_VERSION}\0${loc}\0${email}`, 'utf8')
    .digest('hex');
  return `${EMAIL_CHANNEL_IDENTITY_PREFIX}:${loc}:${digest}`;
}

/**
 * @deprecated Use buildEmailConversationIdentityKey. Kept as a stable alias;
 * returns the same opaque emailv1 key (never raw email).
 */
function buildEmailConversationPhoneKey(locationText, senderEmail) {
  return buildEmailConversationIdentityKey(locationText, senderEmail);
}

/**
 * Staff-visible message text from inbound event (no body in event store).
 * @param {string|null|undefined} subject
 * @returns {string}
 */
function buildEmailMessageText(subject) {
  if (subject == null) return NO_SUBJECT;
  if (typeof subject !== 'string') return NO_SUBJECT;
  const t = subject.trim();
  if (!t) return NO_SUBJECT;
  return t.length > 4000 ? t.slice(0, 4000) : t;
}

function rejected(reason) {
  return Object.freeze({ status: 'rejected', reason });
}

function uncertain(reason) {
  return Object.freeze({ status: 'uncertain', reason });
}

function alreadyProjected(conversationId, messageId) {
  return Object.freeze({
    status: 'already_projected',
    conversation_id: conversationId,
    message_id: messageId,
    created_conversation: false,
  });
}

function projected(conversationId, messageId, createdConversation) {
  return Object.freeze({
    status: 'projected',
    conversation_id: conversationId,
    message_id: messageId,
    created_conversation: createdConversation === true,
  });
}

async function attemptRollback(client) {
  try {
    await client.query('ROLLBACK');
  } catch {
    // no rollback claim
  }
}

function parseProjectInput(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    if (isProxySurface(input)) return null;
    if (Object.getPrototypeOf(input) !== Object.prototype) return null;

    const clientId = ownData(input, 'clientId');
    const locationId = ownData(input, 'locationId');
    const endpointId = ownData(input, 'endpointId');
    if (typeof clientId !== 'string' || !UUID_CANON.test(clientId)) return null;
    if (typeof locationId !== 'string' || !UUID_CANON.test(locationId)) return null;
    if (typeof endpointId !== 'string' || !UUID_CANON.test(endpointId)) return null;

    const inboundEventId = ownData(input, 'inboundEventId');
    const provider = ownData(input, 'provider');
    const providerMailboxId = ownData(input, 'providerMailboxId');
    const providerMessageId = ownData(input, 'providerMessageId');

    const hasEventId = typeof inboundEventId === 'string' && UUID_CANON.test(inboundEventId);
    const hasIdentity = typeof provider === 'string'
      && PROVIDER_SET.has(provider)
      && typeof providerMailboxId === 'string'
      && providerMailboxId.length >= 1
      && providerMailboxId.length <= 2048
      && typeof providerMessageId === 'string'
      && providerMessageId.length >= 1
      && providerMessageId.length <= 2048;

    if (!hasEventId && !hasIdentity) return null;

    // Reject unknown dangerous keys only; allow optional identity fields.
    const keys = Reflect.ownKeys(input).filter((k) => typeof k === 'string');
    const allowed = new Set([
      'clientId', 'locationId', 'endpointId',
      'inboundEventId', 'provider', 'providerMailboxId', 'providerMessageId',
    ]);
    for (const k of keys) {
      if (DANGEROUS_KEYS.has(k) || !allowed.has(k)) return null;
      const desc = Object.getOwnPropertyDescriptor(input, k);
      if (!desc || desc.get || desc.set || !desc.enumerable) return null;
    }

    return Object.freeze({
      clientId,
      locationId,
      endpointId,
      inboundEventId: hasEventId ? inboundEventId : null,
      provider: hasIdentity ? provider : null,
      providerMailboxId: hasIdentity ? providerMailboxId : null,
      providerMessageId: hasIdentity ? providerMessageId : null,
    });
  } catch {
    return null;
  }
}

function rowField(row, key) {
  try {
    if (!row || typeof row !== 'object') return undefined;
    if (isProxySurface(row)) return undefined;
    return ownData(row, key);
  } catch {
    return undefined;
  }
}

function normalizeEventRow(row) {
  if (!row || typeof row !== 'object' || isProxySurface(row)) return null;
  const id = rowField(row, 'id');
  const clientId = rowField(row, 'client_id');
  const locationId = rowField(row, 'location_id');
  const endpointId = rowField(row, 'endpoint_id');
  const provider = rowField(row, 'provider');
  const mailbox = rowField(row, 'provider_mailbox_id');
  const messageId = rowField(row, 'provider_message_id');
  const sender = rowField(row, 'sender_address');
  if (typeof id !== 'string' || !UUID_CANON.test(id)) return null;
  if (typeof clientId !== 'string' || !UUID_CANON.test(clientId)) return null;
  if (typeof locationId !== 'string' || !UUID_CANON.test(locationId)) return null;
  if (typeof endpointId !== 'string' || !UUID_CANON.test(endpointId)) return null;
  if (typeof provider !== 'string' || !PROVIDER_SET.has(provider)) return null;
  if (typeof mailbox !== 'string' || !mailbox) return null;
  if (typeof messageId !== 'string' || !messageId) return null;

  let receivedAt = rowField(row, 'received_at');
  if (receivedAt instanceof Date) {
    receivedAt = receivedAt.toISOString();
  } else if (receivedAt != null && typeof receivedAt !== 'string') {
    receivedAt = String(receivedAt);
  }

  return Object.freeze({
    id,
    client_id: clientId,
    location_id: locationId,
    endpoint_id: endpointId,
    provider,
    provider_mailbox_id: mailbox,
    provider_message_id: messageId,
    received_at: receivedAt == null ? null : String(receivedAt),
    subject: rowField(row, 'subject') == null ? null : String(rowField(row, 'subject')),
    sender_display_name: rowField(row, 'sender_display_name') == null
      ? null
      : String(rowField(row, 'sender_display_name')),
    sender_address: sender == null ? null : String(sender),
    is_read: rowField(row, 'is_read') === true,
    conversation_id: rowField(row, 'conversation_id') == null
      ? null
      : String(rowField(row, 'conversation_id')),
    internet_message_id: rowField(row, 'internet_message_id') == null
      ? null
      : String(rowField(row, 'internet_message_id')),
  });
}

/**
 * Run one projection inside an exclusive-client transaction.
 *
 * @param {{query: Function}} client
 * @param {object} parsed
 * @returns {Promise<object>}
 */
async function runProjectTransaction(client, parsed) {
  let begun = false;
  let commitSent = false;
  try {
    await client.query('BEGIN');
    begun = true;

    // 1) Load durable inbound event under authority scope.
    let eventResult;
    if (parsed.inboundEventId) {
      eventResult = await client.query(SQL_SELECT_EVENT_BY_ID, [
        parsed.clientId,
        parsed.locationId,
        parsed.endpointId,
        parsed.inboundEventId,
      ]);
    } else {
      eventResult = await client.query(SQL_SELECT_EVENT_BY_IDENTITY, [
        parsed.clientId,
        parsed.locationId,
        parsed.endpointId,
        parsed.provider,
        parsed.providerMailboxId,
        parsed.providerMessageId,
      ]);
    }

    const eventRows = eventResult && Array.isArray(eventResult.rows) ? eventResult.rows : [];
    if (!eventRows.length) {
      await attemptRollback(client);
      return rejected('event_not_found');
    }
    const event = normalizeEventRow(eventRows[0]);
    if (!event) {
      await attemptRollback(client);
      return rejected('event_invalid');
    }
    if (
      event.client_id !== parsed.clientId
      || event.location_id !== parsed.locationId
      || event.endpoint_id !== parsed.endpointId
    ) {
      await attemptRollback(client);
      return rejected('authority_mismatch');
    }

    // 2) Exactly-once: journal hit → replay without mutation.
    const prior = await client.query(SQL_SELECT_PROJECTION, [
      parsed.clientId,
      event.provider,
      event.provider_mailbox_id,
      event.provider_message_id,
    ]);
    const priorRows = prior && Array.isArray(prior.rows) ? prior.rows : [];
    if (priorRows.length) {
      const p = priorRows[0];
      const conversationId = rowField(p, 'conversation_id');
      const messageId = rowField(p, 'message_id');
      await client.query('COMMIT');
      commitSent = true;
      if (typeof conversationId === 'string' && typeof messageId === 'string') {
        return alreadyProjected(conversationId, messageId);
      }
      return rejected('projection_corrupt');
    }

    // 3) Require sender for conversation keying.
    const senderNorm = normalizeSenderEmail(event.sender_address);
    if (!senderNorm) {
      await attemptRollback(client);
      return rejected('sender_required');
    }

    // 4) Resolve text location_id (kebab) for conversation metadata.
    const locResult = await client.query(SQL_SELECT_LOCATION_TEXT, [
      parsed.clientId,
      parsed.locationId,
    ]);
    const locRows = locResult && Array.isArray(locResult.rows) ? locResult.rows : [];
    if (!locRows.length) {
      await attemptRollback(client);
      return rejected('location_not_found');
    }
    const locationText = rowField(locRows[0], 'location_id');
    if (typeof locationText !== 'string' || !locationText.trim()) {
      await attemptRollback(client);
      return rejected('location_invalid');
    }
    const locationKebab = locationText.trim().toLowerCase();

    const resolvedIdentity = resolveInboundMatchConversationIdentity({
      providerMailboxId: event.provider_mailbox_id,
      fromAddress: senderNorm,
    });
    const identityKey = resolvedIdentity && resolvedIdentity.conversation_key;
    if (!identityKey || !isEmailChannelPhoneNamespace(identityKey)) {
      await attemptRollback(client);
      return rejected('conversation_key_invalid');
    }
    // Defense: opaque key must never embed the raw sender address.
    if (identityKey.toLowerCase().includes(senderNorm)) {
      await attemptRollback(client);
      return rejected('conversation_key_invalid');
    }

    const messageText = buildEmailMessageText(event.subject);
    const preview = messageText.slice(0, 500);
    const displayName = event.sender_display_name
      ? String(event.sender_display_name).trim().slice(0, 500) || null
      : null;

    // Channel + location only — subject is not duplicated into metadata (PII min).
    const convMetadata = {
      channel: CHANNEL,
      location_id: locationKebab,
      channel_location_source: 'email_inbound_event',
      provider: event.provider,
      endpoint_id: event.endpoint_id,
    };
    if (event.conversation_id) {
      convMetadata.provider_conversation_id = event.conversation_id;
    }

    const sessionState = {
      channel: CHANNEL,
      location_id: locationKebab,
    };

    // 5) Upsert conversation (opaque email-channel identity key in phone column).
    // conversations.email holds the real address for staff; phone is never a
    // WhatsApp destination. 067 customer sync skips emailv1:/email: phones.
    // Microsoft inbound only: set needs_human so generate-on-open can persist
    // the safe no-claims draft. Other providers leave the existing flag.
    const convResult = await client.query(SQL_UPSERT_CONVERSATION, [
      parsed.clientId,
      identityKey,
      displayName,
      senderNorm,
      'open',
      'bot',
      CONVERSATION_STAGE,
      preview,
      JSON.stringify(convMetadata),
      JSON.stringify(sessionState),
      event.provider === 'microsoft_graph',
    ]);
    const convRows = convResult && Array.isArray(convResult.rows) ? convResult.rows : [];
    if (!convRows.length) {
      await attemptRollback(client);
      return rejected('conversation_upsert_failed');
    }
    const conversationId = rowField(convRows[0], 'conversation_id');
    const createdConversation = rowField(convRows[0], 'created') === true
      || rowField(convRows[0], 'created') === 't'
      || rowField(convRows[0], 'created') === true;
    if (typeof conversationId !== 'string' || !conversationId) {
      await attemptRollback(client);
      return rejected('conversation_upsert_failed');
    }

    const guestBind = await bindSunsetGuestByExactInboundEmail(client, {
      clientId: parsed.clientId,
      fromAddress: senderNorm,
    });
    if (guestBind && guestBind.status === 'matched' && guestBind.guest_id) {
      await persistConversationGuestBind(client, {
        clientId: parsed.clientId,
        conversationId,
        guestId: guestBind.guest_id,
        fromAddress: senderNorm,
      });
    }

    // 6) Insert inbound message.
    // Subject lives in message_text only (staff-visible). Metadata keeps
    // channel/provider identity for routing — no redundant email_subject copy.
    const msgMetadata = {
      channel: CHANNEL,
      provider: event.provider,
      provider_mailbox_id: event.provider_mailbox_id,
      provider_message_id: event.provider_message_id,
      inbound_event_id: event.id,
      internet_message_id: event.internet_message_id || null,
      received_at: event.received_at || null,
      location_id: locationKebab,
    };
    if (event.conversation_id) {
      msgMetadata.provider_conversation_id = event.conversation_id;
    }

    const msgResult = await client.query(SQL_INSERT_MESSAGE, [
      parsed.clientId,
      conversationId,
      'inbound',
      messageText,
      'email',
      MESSAGE_SOURCE,
      MESSAGE_ROUTE,
      JSON.stringify(msgMetadata),
    ]);
    const msgRows = msgResult && Array.isArray(msgResult.rows) ? msgResult.rows : [];
    if (!msgRows.length) {
      await attemptRollback(client);
      return rejected('message_insert_failed');
    }
    const messageId = rowField(msgRows[0], 'message_id');
    if (typeof messageId !== 'string' || !messageId) {
      await attemptRollback(client);
      return rejected('message_insert_failed');
    }

    // 7) Journal projection (exactly-once fence).
    const projResult = await client.query(SQL_INSERT_PROJECTION, [
      parsed.clientId,
      parsed.locationId,
      parsed.endpointId,
      event.id,
      event.provider,
      event.provider_mailbox_id,
      event.provider_message_id,
      conversationId,
      messageId,
    ]);
    const projRows = projResult && Array.isArray(projResult.rows) ? projResult.rows : [];
    if (!projRows.length) {
      // Concurrent winner holds the journal. ROLLBACK this TX so the loser's
      // conversation/message writes never become durable (exactly-once).
      await attemptRollback(client);
      begun = false;
      // Read-only lookup of the winner outside the aborted TX.
      const raced = await client.query(SQL_SELECT_PROJECTION, [
        parsed.clientId,
        event.provider,
        event.provider_mailbox_id,
        event.provider_message_id,
      ]);
      const racedRows = raced && Array.isArray(raced.rows) ? raced.rows : [];
      if (racedRows.length) {
        const conversationIdR = rowField(racedRows[0], 'conversation_id');
        const messageIdR = rowField(racedRows[0], 'message_id');
        if (typeof conversationIdR === 'string' && typeof messageIdR === 'string') {
          return alreadyProjected(conversationIdR, messageIdR);
        }
      }
      return rejected('projection_conflict');
    }

    commitSent = true;
    await client.query('COMMIT');
    return projected(conversationId, messageId, createdConversation === true);
  } catch {
    if (begun && !commitSent) {
      await attemptRollback(client);
    }
    return uncertain(
      commitSent
        ? 'inbound_inbox_bridge_commit_outcome_unknown'
        : 'inbound_inbox_bridge_write_failed',
    );
  }
}

/**
 * @param {{ withTransactionClient: Function }} deps
 * @returns {{ projectInboundEvent: Function }}
 */
function createEmailInboundInboxBridge(deps) {
  let withTransactionClient;
  try {
    if (!exactPlainData(deps, STORE_DEPENDENCY_KEYS)
        && !exactFrozenData(deps, STORE_DEPENDENCY_KEYS)) {
      throw failure('inbound_inbox_bridge_deps_invalid');
    }
    withTransactionClient = resolveWithTransactionClient(
      ownData(deps, 'withTransactionClient'),
    );
    if (!withTransactionClient) throw failure('inbound_inbox_bridge_deps_invalid');
  } catch (err) {
    if (err && err.code) throw err;
    throw failure('inbound_inbox_bridge_deps_invalid');
  }

  /**
   * Project one durable inbound event into the Inbox.
   *
   * Input (exact own-data keys only):
   *   clientId, locationId, endpointId (required UUIDs)
   *   inboundEventId (UUID) OR provider + providerMailboxId + providerMessageId
   *
   * @param {object} input
   * @returns {Promise<{status:string, conversation_id?:string, message_id?:string, reason?:string, created_conversation?:boolean}>}
   */
  async function projectInboundEvent(input) {
    const parsed = parseProjectInput(input);
    if (!parsed) return rejected('invalid_input');

    try {
      return await withTransactionClient(async (client) => (
        runProjectTransaction(client, parsed)
      ));
    } catch (err) {
      if (err && err.code === FAILURE_CODE) {
        return uncertain(FAILURE_CODE);
      }
      return uncertain('inbound_inbox_bridge_write_failed');
    }
  }

  return Object.freeze({ projectInboundEvent });
}

module.exports = Object.freeze({
  FAILURE_CODE,
  FAILURE_MESSAGE,
  EMAIL_INBOUND_INBOX_BRIDGE_RUNTIME_WIRED,
  EMAIL_INBOUND_INBOX_BRIDGE_LOGGING_FORBIDDEN,
  AUTHORITY_KEYS,
  STORE_DEPENDENCY_KEYS,
  MESSAGE_SOURCE,
  MESSAGE_ROUTE,
  CHANNEL,
  CONVERSATION_STAGE,
  EMAIL_CHANNEL_IDENTITY_PREFIX,
  EMAIL_CHANNEL_PHONE_NAMESPACE_RE,
  SQL_SELECT_EVENT_BY_ID,
  SQL_SELECT_EVENT_BY_IDENTITY,
  SQL_SELECT_PROJECTION,
  SQL_SELECT_LOCATION_TEXT,
  SQL_UPSERT_CONVERSATION,
  SQL_INSERT_MESSAGE,
  SQL_INSERT_PROJECTION,
  createEmailInboundInboxBridge,
  buildEmailConversationIdentityKey,
  buildEmailConversationPhoneKey,
  isEmailChannelPhoneNamespace,
  buildEmailMessageText,
  normalizeSenderEmail,
  snapshotAuthority,
  parseProjectInput,
});

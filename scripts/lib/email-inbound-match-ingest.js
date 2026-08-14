'use strict';

/**
 * EMAIL-MATCH-001 ingest owner — attach inbound Sunset Microsoft Graph mail
 * to one Staff Inbox conversation and bind an existing same-tenant guest.
 *
 * Canonical conversation key (phone namespace) comes only from PR #592:
 *   emailv1:<resolveInboundConversationKey({providerMailboxId,fromAddress}).conversation_key>
 *   → emailv1:emailconv-from:<mailbox>:<sha256>
 *
 * Helpers are required intrinsically. This module must not load — and must not
 * invent a second key algorithm — when PR #592 is absent. Durable keys never
 * change merely because helper files appear.
 *
 * Graph → envelope → 063 event store does not persist In-Reply-To / References
 * (EMAIL-M1-020 $select omits internetMessageHeaders; envelope keys exclude
 * headers; tenant_email_inbound_events has no in_reply_to column). Standards
 * threading is deferred until that upstream data exists. Grouping is mailbox
 * + normalized From only. No Graph history scrape, no second Graph call.
 *
 * Guest bind SQL (exact, same tenant, fail closed):
 *   SELECT id::text AS guest_id
 *   FROM guests
 *   WHERE client_id = $1::uuid
 *     AND email IS NOT NULL
 *     AND lower(btrim(email)) = $2
 *   $2 is already trim+lower. Exactly one row → UPDATE conversations.guest_id
 *   when currently null AND conversation email equals that From. Zero or 2+
 *   rows → unmatched (projection may commit). Never INSERT guests.
 *   Thrown/rejected guest SELECT or UPDATE errors propagate to the bridge TX
 *   (rollback + sanitized uncertain). Do not swallow them as unmatched/false —
 *   that would journal the message and lose the bind on already_projected retry.
 *   UPDATE rowCount 0 (guest_id already non-null) is nonfatal and does not
 *   overwrite.
 *
 * @module email-inbound-match-ingest
 */

const util = require('util');
const {
  resolveInboundConversationKey,
  buildFromConversationKey,
  normalizeInboundEmailAddress,
} = require('./email-inbound-conversation-identity');
const {
  matchSunsetGuestByInboundEmail,
} = require('./email-inbound-guest-email-match');

const EMAIL_INBOUND_MATCH_INGEST_VERSION = 'email-inbound-match-ingest-v1';
const EMAIL_INBOUND_MATCH_HELPERS_DEPENDENCY =
  'Requires PR #592 scripts/lib/email-inbound-conversation-identity.js '
  + 'and scripts/lib/email-inbound-guest-email-match.js. Canonical keys come '
  + 'only from those APIs. RFC 5322 In-Reply-To/References threading is '
  + 'deferred until Graph/envelope/event-store persist those headers.';
const EMAIL_CHANNEL_IDENTITY_PREFIX = 'emailv1';
const MAILBOX_MAX = 2048;

const SQL_SELECT_SUNSET_GUESTS_BY_EXACT_EMAIL = `
SELECT id::text AS guest_id
FROM guests
WHERE client_id = $1::uuid
  AND email IS NOT NULL
  AND lower(btrim(email)) = $2
`.replace(/\s+/g, ' ').trim();

const SQL_UPDATE_CONVERSATION_GUEST = `
UPDATE conversations
SET guest_id = $3::uuid,
    updated_at = NOW()
WHERE client_id = $1::uuid
  AND id = $2::uuid
  AND guest_id IS NULL
  AND email IS NOT NULL
  AND lower(btrim(email)) = $4
RETURNING id::text AS conversation_id
`.replace(/\s+/g, ' ').trim();

const PINNED_UTIL_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_UTIL_TYPES && typeof PINNED_UTIL_TYPES.isProxy === 'function'
  ? PINNED_UTIL_TYPES.isProxy
  : null;

function isProxySurface(value) {
  try {
    if (typeof PINNED_IS_PROXY !== 'function' || !PINNED_UTIL_TYPES) return true;
    return Reflect.apply(PINNED_IS_PROXY, PINNED_UTIL_TYPES, [value]) === true;
  } catch {
    return true;
  }
}

function normalizeProviderMailboxId(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.length > MAILBOX_MAX) return null;
  return trimmed;
}

function toEmailChannelPhoneKey(conversationKey) {
  if (typeof conversationKey !== 'string') return null;
  const key = conversationKey.trim();
  if (!key) return null;
  if (key.startsWith(`${EMAIL_CHANNEL_IDENTITY_PREFIX}:`) || key.startsWith('email:')) {
    return key;
  }
  return `${EMAIL_CHANNEL_IDENTITY_PREFIX}:${key}`;
}

/**
 * Resolve the Staff Inbox conversation identity for one inbound message.
 * Mailbox + From only — never pass In-Reply-To/References (not persisted).
 *
 * @param {object} input
 * @returns {{ conversation_key: string, strategy: string, thread_anchor: null }|null}
 */
function resolveInboundMatchConversationIdentity(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || isProxySurface(input)) {
      return null;
    }
    const providerMailboxId = input.providerMailboxId;
    const fromAddress = input.fromAddress;
    const mailbox = normalizeProviderMailboxId(providerMailboxId);
    const from = normalizeInboundEmailAddress(fromAddress);
    if (!mailbox || !from) return null;

    const resolved = resolveInboundConversationKey({
      providerMailboxId,
      fromAddress,
    });
    if (!resolved || typeof resolved.conversation_key !== 'string') return null;
    if (resolved.strategy !== 'from') return null;

    const expected = buildFromConversationKey(providerMailboxId, fromAddress);
    if (!expected || resolved.conversation_key !== expected) return null;

    const phoneKey = toEmailChannelPhoneKey(resolved.conversation_key);
    if (!phoneKey) return null;
    return Object.freeze({
      conversation_key: phoneKey,
      strategy: 'from',
      thread_anchor: null,
    });
  } catch {
    return null;
  }
}

function rowField(row, key) {
  try {
    if (!row || typeof row !== 'object' || isProxySurface(row)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(row, key);
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

/**
 * @param {{query:Function}} client
 * @param {{clientId:string,fromAddress:string}} input
 */
async function bindSunsetGuestByExactInboundEmail(client, input) {
  const unmatched = Object.freeze({ status: 'unmatched' });
  if (!client || typeof client.query !== 'function' || isProxySurface(client)) {
    return unmatched;
  }
  if (!input || typeof input !== 'object') return unmatched;
  const clientId = input.clientId;
  const normalizedFrom = normalizeInboundEmailAddress(input.fromAddress);
  if (typeof clientId !== 'string' || !normalizedFrom) return unmatched;
  const result = await client.query(SQL_SELECT_SUNSET_GUESTS_BY_EXACT_EMAIL, [
    clientId,
    normalizedFrom,
  ]);
  const rows = result && Array.isArray(result.rows) ? result.rows : [];
  if (rows.length !== 1) return unmatched;

  const guestId = rowField(rows[0], 'guest_id');
  if (typeof guestId !== 'string' || !guestId.trim()) return unmatched;

  const helperResult = matchSunsetGuestByInboundEmail(input.fromAddress, [{
    guest_id: guestId,
    email: normalizedFrom,
  }]);
  if (!helperResult
      || helperResult.status !== 'matched'
      || helperResult.guest_id !== guestId) {
    return unmatched;
  }
  return Object.freeze({ status: 'matched', guest_id: guestId });
}

/**
 * @param {{query:Function}} client
 * @param {{clientId:string,conversationId:string,guestId:string,fromAddress:string}} input
 */
async function persistConversationGuestBind(client, input) {
  if (!client || typeof client.query !== 'function' || isProxySurface(client)) {
    return false;
  }
  if (!input || typeof input !== 'object') return false;
  const from = normalizeInboundEmailAddress(input.fromAddress);
  if (typeof input.clientId !== 'string'
      || typeof input.conversationId !== 'string'
      || typeof input.guestId !== 'string'
      || !from) {
    return false;
  }
  const result = await client.query(SQL_UPDATE_CONVERSATION_GUEST, [
    input.clientId,
    input.conversationId,
    input.guestId,
    from,
  ]);
  if (result && typeof result.rowCount === 'number') {
    return result.rowCount === 1;
  }
  const rows = result && Array.isArray(result.rows) ? result.rows : [];
  return rows.length === 1;
}

module.exports = Object.freeze({
  EMAIL_INBOUND_MATCH_INGEST_VERSION,
  EMAIL_INBOUND_MATCH_HELPERS_DEPENDENCY,
  EMAIL_CHANNEL_IDENTITY_PREFIX,
  SQL_SELECT_SUNSET_GUESTS_BY_EXACT_EMAIL,
  SQL_UPDATE_CONVERSATION_GUEST,
  normalizeInboundEmailAddress,
  normalizeProviderMailboxId,
  resolveInboundMatchConversationIdentity,
  bindSunsetGuestByExactInboundEmail,
  persistConversationGuestBind,
  toEmailChannelPhoneKey,
});

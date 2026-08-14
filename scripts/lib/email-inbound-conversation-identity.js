'use strict';

/**
 * EMAIL-MATCH-001 — inbound email conversation identity (offline helper).
 *
 * Pure functions for deterministic Staff Inbox conversation keys:
 * - same mailbox + same normalized From → same key (new threads)
 * - In-Reply-To / References join an existing thread when the anchor is registered
 *
 * Does not query DB, persist, or wire into ingest/delta/worker paths.
 * Skipper imports when attaching live inbound mail to conversations.
 *
 * @module email-inbound-conversation-identity
 */

const crypto = require('crypto');

const EMAIL_INBOUND_CONVERSATION_IDENTITY_VERSION = 'email-inbound-conversation-v1';
const KEY_PREFIX_FROM = 'emailconv-from';
const KEY_PREFIX_THREAD = 'emailconv-thread';

function normalizeInboundEmailAddress(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || !trimmed.includes('@') || trimmed.length > 320) return null;
  return trimmed;
}

function normalizeProviderMailboxId(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.length > 2048) return null;
  return trimmed;
}

/** RFC 5322 Message-ID normalization: trim, lowercase, strip surrounding <> */
function normalizeMessageId(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  let value = raw.trim();
  if (value.startsWith('<') && value.endsWith('>') && value.length >= 2) {
    value = value.slice(1, -1).trim();
  }
  value = value.toLowerCase();
  if (!value || value.length > 998) return null;
  return value;
}

/** Parse References header into ordered normalized message-ids (oldest first). */
function parseReferencesHeader(raw) {
  if (raw == null || typeof raw !== 'string') return [];
  const out = [];
  const pattern = /<([^>]+)>|([^\s<][^\s>]*@[^\s>]+)/g;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    const id = normalizeMessageId(match[1] || match[2]);
    if (id) out.push(id);
  }
  return out;
}

/**
 * Pick thread anchor from In-Reply-To / References.
 * References wins (first id); else In-Reply-To.
 */
function pickInboundThreadAnchor({ inReplyTo, references }) {
  const refs = Array.isArray(references)
    ? references.map(normalizeMessageId).filter(Boolean)
    : parseReferencesHeader(references);
  if (refs.length > 0) return refs[0];
  return normalizeMessageId(inReplyTo);
}

function digestKey(mailbox, kind, material) {
  const hash = crypto
    .createHash('sha256')
    .update(`${EMAIL_INBOUND_CONVERSATION_IDENTITY_VERSION}\0${kind}\0${mailbox}\0${material}`, 'utf8')
    .digest('hex');
  return `${kind}:${mailbox}:${hash}`;
}

function buildFromConversationKey(providerMailboxId, fromAddress) {
  const mailbox = normalizeProviderMailboxId(providerMailboxId);
  const from = normalizeInboundEmailAddress(fromAddress);
  if (!mailbox || !from) return null;
  return digestKey(mailbox, KEY_PREFIX_FROM, from);
}

function buildThreadAnchorConversationKey(providerMailboxId, threadAnchorMessageId) {
  const mailbox = normalizeProviderMailboxId(providerMailboxId);
  const anchor = normalizeMessageId(threadAnchorMessageId);
  if (!mailbox || !anchor) return null;
  return digestKey(mailbox, KEY_PREFIX_THREAD, anchor);
}

/**
 * Resolve conversation key for one inbound message.
 *
 * @param {object} input
 * @param {string} input.providerMailboxId
 * @param {string} input.fromAddress
 * @param {string} [input.inReplyTo]
 * @param {string|string[]} [input.references]
 * @param {Map<string,string>|Record<string,string>} [input.threadAnchorKeys]
 *   Optional registry: normalized message-id → conversation_key from prior projections.
 * @returns {{ conversation_key: string, strategy: 'from'|'thread_join'|'thread_anchor', thread_anchor: string|null }|null}
 */
function resolveInboundConversationKey(input) {
  if (!input || typeof input !== 'object') return null;
  const mailbox = normalizeProviderMailboxId(input.providerMailboxId);
  const from = normalizeInboundEmailAddress(input.fromAddress);
  if (!mailbox || !from) return null;

  const anchor = pickInboundThreadAnchor({
    inReplyTo: input.inReplyTo,
    references: input.references,
  });

  if (anchor) {
    const registry = input.threadAnchorKeys;
    if (registry) {
      const mapped = registry instanceof Map
        ? registry.get(anchor)
        : registry[anchor];
      if (typeof mapped === 'string' && mapped.length > 0) {
        return Object.freeze({
          conversation_key: mapped,
          strategy: 'thread_join',
          thread_anchor: anchor,
        });
      }
    }
    const threaded = buildThreadAnchorConversationKey(mailbox, anchor);
    if (!threaded) return null;
    return Object.freeze({
      conversation_key: threaded,
      strategy: 'thread_anchor',
      thread_anchor: anchor,
    });
  }

  const fromKey = buildFromConversationKey(mailbox, from);
  if (!fromKey) return null;
  return Object.freeze({
    conversation_key: fromKey,
    strategy: 'from',
    thread_anchor: null,
  });
}

/**
 * Register a message internet Message-ID for future thread joins.
 *
 * @param {Map<string,string>|Record<string,string>} threadAnchorKeys
 * @param {string} messageId
 * @param {string} conversationKey
 * @returns {boolean}
 */
function registerInboundThreadAnchor(threadAnchorKeys, messageId, conversationKey) {
  if (!threadAnchorKeys) return false;
  const id = normalizeMessageId(messageId);
  const key = typeof conversationKey === 'string' ? conversationKey.trim() : '';
  if (!id || !key) return false;
  if (threadAnchorKeys instanceof Map) {
    threadAnchorKeys.set(id, key);
    return true;
  }
  if (typeof threadAnchorKeys === 'object') {
    threadAnchorKeys[id] = key;
    return true;
  }
  return false;
}

module.exports = Object.freeze({
  EMAIL_INBOUND_CONVERSATION_IDENTITY_VERSION,
  normalizeInboundEmailAddress,
  normalizeProviderMailboxId,
  normalizeMessageId,
  parseReferencesHeader,
  pickInboundThreadAnchor,
  buildFromConversationKey,
  buildThreadAnchorConversationKey,
  resolveInboundConversationKey,
  registerInboundThreadAnchor,
});

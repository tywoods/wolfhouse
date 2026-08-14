'use strict';

/**
 * EMAIL-MATCH-001 — inbound email conversation identity (offline helper).
 *
 * Pure functions for deterministic Staff Inbox conversation keys:
 * - same mailbox + same normalized From → same key (new threads)
 * - In-Reply-To / References join an existing thread when the anchor is registered
 *   (registry keys are scoped to mailbox + Message-ID)
 * - References search registered anchors newest→oldest before From-key fallback
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
const THREAD_ANCHOR_REGISTRY_SEP = '\0';

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
 * Thread anchor candidates newest→oldest.
 * References supply the chain; In-Reply-To is used only when References are absent.
 */
function listInboundThreadAnchorsNewestFirst({ inReplyTo, references }) {
  const refs = Array.isArray(references)
    ? references.map(normalizeMessageId).filter(Boolean)
    : parseReferencesHeader(references);
  if (refs.length > 0) return refs.slice().reverse();
  const reply = normalizeMessageId(inReplyTo);
  return reply ? [reply] : [];
}

/**
 * @deprecated Use listInboundThreadAnchorsNewestFirst. Kept for offline gates.
 */
function pickInboundThreadAnchor({ inReplyTo, references }) {
  const anchors = listInboundThreadAnchorsNewestFirst({ inReplyTo, references });
  return anchors.length > 0 ? anchors[anchors.length - 1] : null;
}

function buildThreadAnchorRegistryKey(providerMailboxId, messageId) {
  const mailbox = normalizeProviderMailboxId(providerMailboxId);
  const id = normalizeMessageId(messageId);
  if (!mailbox || !id) return null;
  return `${mailbox}${THREAD_ANCHOR_REGISTRY_SEP}${id}`;
}

function lookupRegisteredThreadAnchor(registry, providerMailboxId, messageId) {
  if (!registry) return null;
  const registryKey = buildThreadAnchorRegistryKey(providerMailboxId, messageId);
  if (!registryKey) return null;
  const mapped = registry instanceof Map
    ? registry.get(registryKey)
    : registry[registryKey];
  if (typeof mapped !== 'string' || mapped.length === 0) return null;
  return mapped;
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
 *   Optional registry: mailbox-scoped Message-ID → conversation_key from prior projections.
 * @returns {{ conversation_key: string, strategy: 'from'|'thread_join', thread_anchor: string|null }|null}
 */
function resolveInboundConversationKey(input) {
  if (!input || typeof input !== 'object') return null;
  const mailbox = normalizeProviderMailboxId(input.providerMailboxId);
  const from = normalizeInboundEmailAddress(input.fromAddress);
  if (!mailbox || !from) return null;

  const anchorsNewestFirst = listInboundThreadAnchorsNewestFirst({
    inReplyTo: input.inReplyTo,
    references: input.references,
  });

  if (anchorsNewestFirst.length > 0) {
    const registry = input.threadAnchorKeys;
    for (const anchor of anchorsNewestFirst) {
      const mapped = lookupRegisteredThreadAnchor(registry, mailbox, anchor);
      if (mapped) {
        return Object.freeze({
          conversation_key: mapped,
          strategy: 'thread_join',
          thread_anchor: anchor,
        });
      }
    }
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
 * @param {string} providerMailboxId
 * @param {string} messageId
 * @param {string} conversationKey
 * @returns {boolean}
 */
function registerInboundThreadAnchor(threadAnchorKeys, providerMailboxId, messageId, conversationKey) {
  if (!threadAnchorKeys) return false;
  const registryKey = buildThreadAnchorRegistryKey(providerMailboxId, messageId);
  const key = typeof conversationKey === 'string' ? conversationKey.trim() : '';
  if (!registryKey || !key) return false;
  if (threadAnchorKeys instanceof Map) {
    threadAnchorKeys.set(registryKey, key);
    return true;
  }
  if (typeof threadAnchorKeys === 'object') {
    threadAnchorKeys[registryKey] = key;
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
  listInboundThreadAnchorsNewestFirst,
  pickInboundThreadAnchor,
  buildThreadAnchorRegistryKey,
  buildFromConversationKey,
  buildThreadAnchorConversationKey,
  resolveInboundConversationKey,
  registerInboundThreadAnchor,
});

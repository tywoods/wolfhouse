'use strict';

/**
 * Phase 19g.1 — Meta WhatsApp Cloud inbound webhook helpers.
 *
 * GET hub challenge verification + POST payload normalization.
 * No Graph API, no guest-reply-send, no DB writes.
 */

const crypto = require('crypto');

const DEFAULT_CLIENT_SLUG = 'wolfhouse-somo';
const DEFAULT_META_WHATSAPP_VERIFY_TOKEN = 'wolfhouse_verify_token';

const WEBHOOK_SAFETY_FLAGS = {
  preview_only: true,
  no_write_performed: true,
  sends_whatsapp: false,
  calls_graph_api: false,
  calls_n8n: false,
  creates_booking: false,
  creates_payment: false,
  creates_stripe_link: false,
};

const SUPPORTED_MESSAGE_TYPES = new Set(['text']);

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function resolveMetaWhatsAppVerifyToken(env = process.env) {
  const fromEnv = trimStr(env.META_WHATSAPP_VERIFY_TOKEN);
  if (fromEnv) return fromEnv;
  return DEFAULT_META_WHATSAPP_VERIFY_TOKEN;
}

function resolveMetaAppSecret(env = process.env) {
  return trimStr(env.META_APP_SECRET);
}

/**
 * Meta GET webhook verification (hub challenge).
 * @returns {{ ok: boolean, challenge?: string, status: number, error?: string }}
 */
function verifyMetaHubChallenge(query, env = process.env) {
  const mode = trimStr(query['hub.mode'] || query.hub_mode);
  const token = trimStr(query['hub.verify_token'] || query.hub_verify_token);
  const challenge = query['hub.challenge'] ?? query.hub_challenge;
  const expected = resolveMetaWhatsAppVerifyToken(env);

  if (mode !== 'subscribe') {
    return { ok: false, status: 403, error: 'invalid_hub_mode' };
  }
  if (!token || token !== expected) {
    return { ok: false, status: 403, error: 'invalid_verify_token' };
  }
  if (challenge == null || String(challenge).length === 0) {
    return { ok: false, status: 400, error: 'missing_hub_challenge' };
  }
  return { ok: true, status: 200, challenge: String(challenge) };
}

/**
 * Verify Meta X-Hub-Signature-256 when app secret is configured.
 * @returns {{ verified: boolean, skipped: boolean, error?: string }}
 */
function verifyMetaHubSignature256(rawBody, signatureHeader, env = process.env) {
  const appSecret = resolveMetaAppSecret(env);
  const sig = trimStr(signatureHeader);

  if (!appSecret) {
    return { verified: false, skipped: true };
  }
  if (!sig) {
    return { verified: false, skipped: true, error: 'missing_signature_header' };
  }

  const expectedPrefix = 'sha256=';
  if (!sig.startsWith(expectedPrefix)) {
    return { verified: false, skipped: false, error: 'invalid_signature_format' };
  }
  const provided = sig.slice(expectedPrefix.length);
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf8');
  const expected = crypto.createHmac('sha256', appSecret).update(body).digest('hex');

  try {
    const a = Buffer.from(provided, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { verified: false, skipped: false, error: 'signature_mismatch' };
    }
    return { verified: true, skipped: false };
  } catch (_) {
    return { verified: false, skipped: false, error: 'signature_compare_failed' };
  }
}

function buildRawSummary(body) {
  const entryCount = Array.isArray(body.entry) ? body.entry.length : 0;
  let changeCount = 0;
  let messageCount = 0;
  if (Array.isArray(body.entry)) {
    for (const entry of body.entry) {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      changeCount += changes.length;
      for (const change of changes) {
        const msgs = change && change.value && Array.isArray(change.value.messages)
          ? change.value.messages
          : [];
        messageCount += msgs.length;
      }
    }
  }
  return {
    object: body.object || null,
    entry_count: entryCount,
    change_count: changeCount,
    message_count: messageCount,
  };
}

function findFirstInboundMessage(body) {
  if (!body || !Array.isArray(body.entry)) return null;

  for (const entry of body.entry) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change && change.value ? change.value : {};
      const messages = Array.isArray(value.messages) ? value.messages : [];
      if (messages.length === 0) continue;

      const msg = messages[0];
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      const contact = contacts.find((c) => trimStr(c.wa_id) === trimStr(msg.from)) || contacts[0] || null;
      const profileName = contact && contact.profile ? trimStr(contact.profile.name) || null : null;
      const metadata = value.metadata || {};

      return {
        phone_number_id: trimStr(metadata.phone_number_id) || null,
        from: trimStr(msg.from) || null,
        wa_message_id: trimStr(msg.id) || null,
        timestamp: msg.timestamp != null ? String(msg.timestamp) : null,
        message_type: trimStr(msg.type) || 'unknown',
        message_text: msg.type === 'text' && msg.text ? trimStr(msg.text.body) || null : null,
        profile_name: profileName,
        raw_message: msg,
        field: trimStr(change.field) || null,
      };
    }
  }
  return null;
}

/**
 * Normalize Meta WhatsApp webhook POST body.
 * @param {object} body - parsed JSON webhook payload
 * @param {{ client_slug?: string }} [options]
 */
function normalizeMetaWhatsAppWebhook(body, options = {}) {
  const clientSlug = trimStr(options.client_slug) || DEFAULT_CLIENT_SLUG;
  const rawSummary = buildRawSummary(body || {});
  const inbound = findFirstInboundMessage(body || {});

  if (!inbound) {
    return {
      client_slug: clientSlug,
      channel: 'whatsapp',
      phone_number_id: null,
      from: null,
      wa_message_id: null,
      timestamp: null,
      message_type: null,
      message_text: null,
      profile_name: null,
      supported: false,
      unsupported_reason: 'no_inbound_message',
      raw_summary: rawSummary,
    };
  }

  const supported = SUPPORTED_MESSAGE_TYPES.has(inbound.message_type);
  let unsupportedReason = null;
  if (!supported) {
    unsupportedReason = `unsupported_message_type:${inbound.message_type}`;
  } else if (!inbound.message_text) {
    unsupportedReason = 'missing_text_body';
  }

  return {
    client_slug: clientSlug,
    channel: 'whatsapp',
    phone_number_id: inbound.phone_number_id,
    from: inbound.from,
    wa_message_id: inbound.wa_message_id,
    timestamp: inbound.timestamp,
    message_type: inbound.message_type,
    message_text: supported ? inbound.message_text : null,
    profile_name: inbound.profile_name,
    supported,
    unsupported_reason: unsupportedReason,
    raw_summary: rawSummary,
  };
}

/**
 * Build POST webhook JSON response envelope.
 */
function buildMetaWhatsAppWebhookPostResponse(normalized, signatureMeta = {}) {
  return {
    success: true,
    received: true,
    normalized,
    signature_verified: signatureMeta.verified === true,
    signature_verification_skipped: signatureMeta.skipped === true,
    ...WEBHOOK_SAFETY_FLAGS,
  };
}

module.exports = {
  DEFAULT_CLIENT_SLUG,
  DEFAULT_META_WHATSAPP_VERIFY_TOKEN,
  WEBHOOK_SAFETY_FLAGS,
  SUPPORTED_MESSAGE_TYPES,
  resolveMetaWhatsAppVerifyToken,
  resolveMetaAppSecret,
  verifyMetaHubChallenge,
  verifyMetaHubSignature256,
  normalizeMetaWhatsAppWebhook,
  buildMetaWhatsAppWebhookPostResponse,
  buildRawSummary,
  findFirstInboundMessage,
};

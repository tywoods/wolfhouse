'use strict';

/**
 * EMAIL-IMAP-001 — Provider-neutral IMAP inbound helper (scaffolding).
 *
 * Reads config from environment, validates it, and exposes a fail-closed
 * inbound-fetch entrypoint. This module NEVER opens a live socket by itself:
 * all network I/O goes through an injected transport (second argument). That
 * keeps the unit offline-testable and makes "no live mailbox tonight" a
 * structural guarantee, not a promise.
 *
 * Fail-closed rule: without IMAP_HOST, IMAP_USER, and IMAP_PASSWORD the config
 * resolver returns { configured:false } and the fetch entrypoint refuses to run.
 *
 * Idempotency: inbound messages are keyed by RFC 5322 Message-ID (internet
 * message id), normalized. Callers dedupe on messageId; this helper marks each
 * mapped envelope with a stable dedupeKey so re-fetching the same message twice
 * produces the same key.
 *
 * Scope guard (do NOT extend here): Microsoft Graph, Gmail API, Azure Key Vault,
 * Mailbridge, and the Skipper send path are explicitly out of scope. This file
 * touches none of them.
 *
 * @module email-imap-inbound-scaffold
 */

const IMAP_ENV_KEYS = Object.freeze(['IMAP_HOST', 'IMAP_USER', 'IMAP_PASSWORD']);
const DEFAULT_IMAP_PORT = 993;
const DEFAULT_IMAP_MAILBOX = 'INBOX';

/** RFC 5322 Message-ID, angle brackets optional; bounded, no whitespace inside. */
const MESSAGE_ID_RE = /^<?[^\s<>@]+@[^\s<>@]+>?$/;

function readPort(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_IMAP_PORT;
  }
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return { error: 'invalid_imap_port' };
  }
  return n;
}

function parseBoolEnv(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return fallback;
}

/**
 * Resolve IMAP config from an env-like object. Fail-closed: any missing required
 * secret yields { configured:false } with the list of what is missing. Never
 * returns or logs the password value; callers pass the resolved config into an
 * injected transport that reads config.auth.password at connect time only.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {{configured:false, missing:string[]} | {configured:false, error:string} | {configured:true, config:object}}
 */
function resolveImapConfig(env) {
  const source = env && typeof env === 'object' ? env : {};
  const missing = IMAP_ENV_KEYS.filter((k) => {
    const val = source[k];
    return val === undefined || val === null || String(val).trim() === '';
  });
  if (missing.length > 0) {
    return { configured: false, missing };
  }

  const port = readPort(source.IMAP_PORT);
  if (port && typeof port === 'object' && port.error) {
    return { configured: false, error: port.error };
  }

  const config = Object.freeze({
    host: String(source.IMAP_HOST).trim(),
    port,
    tls: parseBoolEnv(source.IMAP_TLS, true),
    mailbox: source.IMAP_MAILBOX ? String(source.IMAP_MAILBOX).trim() : DEFAULT_IMAP_MAILBOX,
    auth: Object.freeze({
      user: String(source.IMAP_USER).trim(),
      // Present so the transport can authenticate; never logged or returned upward.
      password: String(source.IMAP_PASSWORD),
    }),
  });

  return { configured: true, config };
}

/** Normalize a Message-ID for stable idempotency keys (strip angle brackets, lowercase host is not assumed). */
function normalizeMessageId(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!MESSAGE_ID_RE.test(trimmed)) return null;
  return trimmed.replace(/^</, '').replace(/>$/, '');
}

/**
 * Map a raw transport message row into a minimal provider-neutral inbound record
 * with a deterministic dedupe key. Bodies/attachments are intentionally excluded
 * (scaffolding only). Returns null if the message has no usable Message-ID.
 *
 * @param {{messageId?:string, from?:string, subject?:string, receivedAt?:string, uid?:number|string}} raw
 * @param {{mailbox:string}} ctx
 */
function mapInboundMessage(raw, ctx) {
  if (!raw || typeof raw !== 'object') return null;
  const messageId = normalizeMessageId(raw.messageId);
  if (!messageId) return null;
  return Object.freeze({
    provider: 'imap_smtp',
    dedupeKey: `imap_smtp:${ctx && ctx.mailbox ? ctx.mailbox : DEFAULT_IMAP_MAILBOX}:${messageId}`,
    messageId,
    from: typeof raw.from === 'string' ? raw.from : null,
    subject: typeof raw.subject === 'string' ? raw.subject : null,
    receivedAt: typeof raw.receivedAt === 'string' ? raw.receivedAt : null,
    uid: raw.uid !== undefined ? raw.uid : null,
  });
}

/**
 * Fetch inbound messages through an injected transport. Fail-closed on missing
 * config; never connects on its own. Deduplicates within the batch by dedupeKey.
 *
 * @param {object} deps
 * @param {Record<string,string|undefined>} [deps.env]
 * @param {(config:object) => Promise<Array<object>> | Array<object>} deps.transportFetch
 *   Injected. Receives the resolved config and returns raw message rows. In
 *   production this wraps a real IMAP client; in tests it is a fake. This module
 *   supplies no default transport, so it cannot connect to a live mailbox.
 * @returns {Promise<{ok:false,reason:string,missing?:string[]} | {ok:true,messages:object[],skippedDuplicates:number}>}
 */
async function fetchInbound(deps) {
  const { env, transportFetch } = deps || {};
  const resolved = resolveImapConfig(env);
  if (!resolved.configured) {
    return { ok: false, reason: 'imap_not_configured', missing: resolved.missing || [], error: resolved.error };
  }
  if (typeof transportFetch !== 'function') {
    return { ok: false, reason: 'no_transport_injected' };
  }

  const rows = await transportFetch(resolved.config);
  const seen = new Set();
  const messages = [];
  let skippedDuplicates = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const mapped = mapInboundMessage(row, { mailbox: resolved.config.mailbox });
    if (!mapped) continue;
    if (seen.has(mapped.dedupeKey)) {
      skippedDuplicates += 1;
      continue;
    }
    seen.add(mapped.dedupeKey);
    messages.push(mapped);
  }
  return { ok: true, messages, skippedDuplicates };
}

module.exports = {
  IMAP_ENV_KEYS,
  DEFAULT_IMAP_PORT,
  DEFAULT_IMAP_MAILBOX,
  resolveImapConfig,
  normalizeMessageId,
  mapInboundMessage,
  fetchInbound,
};

'use strict';

/**
 * EMAIL-IMAP-001 — Provider-neutral SMTP outbound helper (scaffolding).
 *
 * Resolves SMTP config from environment, validates a single staff reply, and
 * hands it to an injected transport. Like the IMAP helper, this module opens no
 * socket on its own: all network I/O is an injected function, so "no live
 * mailbox tonight" is structural.
 *
 * Fail-closed rule: without SMTP_HOST, SMTP_USER, and SMTP_PASSWORD the config
 * resolver returns { configured:false } and send refuses.
 *
 * Auto-send OFF: this helper only sends a single explicit staff reply passed in
 * by a caller. There is no queue, no loop, no automatic guest reply, and no
 * enablement flag that turns automatic sending on. Automatic outbound is out of
 * scope for this slice by construction.
 *
 * Scope guard (do NOT extend here): Microsoft Graph, Gmail API, Azure Key Vault,
 * Mailbridge, and the Skipper send path are explicitly out of scope.
 *
 * @module email-smtp-outbound-scaffold
 */

const SMTP_ENV_KEYS = Object.freeze(['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD']);
const DEFAULT_SMTP_PORT = 587;

const ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readPort(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_SMTP_PORT;
  }
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return { error: 'invalid_smtp_port' };
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
 * Resolve SMTP config from an env-like object. Fail-closed on any missing
 * required secret. Never logs or returns the password upward except inside the
 * frozen config the injected transport consumes at connect time.
 *
 * @param {Record<string,string|undefined>} [env]
 */
function resolveSmtpConfig(env) {
  const source = env && typeof env === 'object' ? env : {};
  const missing = SMTP_ENV_KEYS.filter((k) => {
    const val = source[k];
    return val === undefined || val === null || String(val).trim() === '';
  });
  if (missing.length > 0) {
    return { configured: false, missing };
  }

  const port = readPort(source.SMTP_PORT);
  if (port && typeof port === 'object' && port.error) {
    return { configured: false, error: port.error };
  }

  const config = Object.freeze({
    host: String(source.SMTP_HOST).trim(),
    port,
    // STARTTLS on the submission port by default; direct TLS if explicitly set.
    starttls: parseBoolEnv(source.SMTP_STARTTLS, true),
    from: source.SMTP_FROM ? String(source.SMTP_FROM).trim() : String(source.SMTP_USER).trim(),
    auth: Object.freeze({
      user: String(source.SMTP_USER).trim(),
      password: String(source.SMTP_PASSWORD),
    }),
  });

  return { configured: true, config };
}

/**
 * Validate a single staff reply message. Bodies are plain text only in this
 * scaffold. Returns a normalized message or a field-level error.
 *
 * @param {{to?:string, subject?:string, text?:string, inReplyTo?:string}} message
 */
function validateStaffReply(message) {
  if (!message || typeof message !== 'object') {
    return { ok: false, error: 'reply_not_object' };
  }
  const to = typeof message.to === 'string' ? message.to.trim() : '';
  if (!ADDRESS_RE.test(to)) {
    return { ok: false, error: 'invalid_to_address' };
  }
  const subject = typeof message.subject === 'string' ? message.subject : '';
  const text = typeof message.text === 'string' ? message.text : '';
  if (text.trim() === '') {
    return { ok: false, error: 'empty_reply_body' };
  }
  return {
    ok: true,
    message: Object.freeze({
      to,
      subject,
      text,
      inReplyTo: typeof message.inReplyTo === 'string' && message.inReplyTo.trim() !== ''
        ? message.inReplyTo.trim()
        : null,
    }),
  };
}

/**
 * Send exactly one staff reply through an injected transport. Fail-closed on
 * missing config, missing transport, or invalid message. Sends one message and
 * returns; there is no batching or automatic sending.
 *
 * @param {object} deps
 * @param {Record<string,string|undefined>} [deps.env]
 * @param {{to:string,subject:string,text:string,inReplyTo?:string}} deps.reply
 * @param {(config:object, message:object) => Promise<object> | object} deps.transportSend
 *   Injected. This module supplies no default transport, so it cannot reach a
 *   live SMTP server.
 * @returns {Promise<{ok:false,reason:string,missing?:string[]} | {ok:true,result:object}>}
 */
async function sendStaffReply(deps) {
  const { env, reply, transportSend } = deps || {};
  const resolved = resolveSmtpConfig(env);
  if (!resolved.configured) {
    return { ok: false, reason: 'smtp_not_configured', missing: resolved.missing || [], error: resolved.error };
  }
  if (typeof transportSend !== 'function') {
    return { ok: false, reason: 'no_transport_injected' };
  }
  const validated = validateStaffReply(reply);
  if (!validated.ok) {
    return { ok: false, reason: 'invalid_reply', error: validated.error };
  }

  const result = await transportSend(resolved.config, validated.message);
  return { ok: true, result: result || null };
}

module.exports = {
  SMTP_ENV_KEYS,
  DEFAULT_SMTP_PORT,
  resolveSmtpConfig,
  validateStaffReply,
  sendStaffReply,
};

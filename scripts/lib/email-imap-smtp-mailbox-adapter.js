'use strict';

/**
 * EMAIL-IMAP-002 — Fail-closed IMAP/SMTP mailbox adapter (scaffolding).
 *
 * Implements the provider-neutral mailbox adapter contract
 * (email-mailbox-adapter-contract.js) for the generic 'imap_smtp' provider,
 * composing the EMAIL-IMAP-001 inbound/outbound scaffolds. Like those, it opens
 * no socket on its own: all network I/O is injected (transportFetch /
 * transportSend). No injected transport = no live connect, by construction.
 *
 * Fail-closed rules:
 *   - Adapter identity must satisfy the contract (provider imap_smtp, valid
 *     public_address, valid capabilities) or createImapSmtpMailboxAdapter fails.
 *   - reply capability must be advertised or outbound is refused.
 *   - Inbound requires IMAP_HOST/IMAP_USER/IMAP_PASSWORD; outbound requires
 *     SMTP_HOST/SMTP_USER/SMTP_PASSWORD. Missing → fail closed.
 *
 * Auto-send OFF: sendReply forwards exactly one explicit staff reply. There is
 * no queue, loop, automatic guest reply, or enablement flag.
 *
 * Scope guard (untouched): Microsoft Graph, Gmail API (#594), inbox-thread.js,
 * inbox-context.js, delta poller, Azure Key Vault, Skipper send path,
 * Mailbridge (#544). This module imports none of them.
 *
 * @module email-imap-smtp-mailbox-adapter
 */

const {
  validateEmailMailboxAdapterIdentity,
  EMAIL_MAILBOX_CAPABILITY_KEYS,
} = require('./email-mailbox-adapter-contract');
const imapInbound = require('./email-imap-inbound-scaffold');
const smtpOutbound = require('./email-smtp-outbound-scaffold');

const CAPABILITY_SET = new Set(EMAIL_MAILBOX_CAPABILITY_KEYS);
const PROVIDER = 'imap_smtp';

/**
 * Create a fail-closed IMAP/SMTP mailbox adapter.
 *
 * @param {object} params
 * @param {string} params.public_address  Mailbox public address (contract-validated).
 * @param {Record<string,boolean>} params.capabilities  Advertised capabilities.
 * @param {Record<string,string|undefined>} [params.env]  Env-like source for secrets.
 * @param {object} [transports]  Injected network transports (second argument only).
 * @param {function} [transports.transportFetch]  IMAP inbound fetch.
 * @param {function} [transports.transportSend]  SMTP outbound send.
 * @returns {{ok:false,error:string,details?:unknown}|{ok:true,adapter:object}}
 */
function createImapSmtpMailboxAdapter(params, transports) {
  const p = params && typeof params === 'object' ? params : {};

  const identityResult = validateEmailMailboxAdapterIdentity({
    provider: PROVIDER,
    public_address: p.public_address,
    capabilities: p.capabilities,
  });
  if (!identityResult.ok) {
    return { ok: false, error: identityResult.error, details: identityResult.details };
  }
  const identity = identityResult.value;
  const capabilities = identity.capabilities;

  const env = p.env && typeof p.env === 'object' ? p.env : {};
  const t = transports && typeof transports === 'object' ? transports : {};
  const transportFetch = typeof t.transportFetch === 'function' ? t.transportFetch : undefined;
  const transportSend = typeof t.transportSend === 'function' ? t.transportSend : undefined;

  const adapter = Object.freeze({
    kind: 'imap_smtp',
    provider: PROVIDER,

    getIdentity() { return identity; },
    getCapabilities() { return capabilities; },
    describe() {
      return Object.freeze({
        kind: 'imap_smtp',
        provider: PROVIDER,
        public_address: identity.public_address,
        capabilities: { ...capabilities },
      });
    },

    /** Known keys → boolean; unknown key throws (typo protection). */
    supports(capabilityKey) {
      if (typeof capabilityKey !== 'string' || !CAPABILITY_SET.has(capabilityKey)) {
        const err = new Error('unknown_capability_key');
        err.code = 'unknown_capability_key';
        err.capability_key = capabilityKey;
        throw err;
      }
      return capabilities[capabilityKey] === true;
    },

    /** Readiness probes — fail closed, never connect. */
    inboundReady() {
      const r = imapInbound.resolveImapConfig(env);
      return r.configured === true && typeof transportFetch === 'function';
    },
    outboundReady() {
      const r = smtpOutbound.resolveSmtpConfig(env);
      return r.configured === true && typeof transportSend === 'function' && capabilities.reply === true;
    },

    /**
     * Fetch inbound mail via the IMAP scaffold. Fail-closed on missing config or
     * transport (handled by the scaffold).
     */
    async fetchInbound() {
      return imapInbound.fetchInbound({ env, transportFetch });
    },

    /**
     * Send exactly one staff reply via the SMTP scaffold. Refuses if the adapter
     * does not advertise the reply capability, then defers config/transport
     * fail-closed checks to the scaffold. Auto-send stays off.
     */
    async sendReply(reply) {
      if (capabilities.reply !== true) {
        return { ok: false, reason: 'reply_capability_not_advertised' };
      }
      return smtpOutbound.sendStaffReply({ env, reply, transportSend });
    },
  });

  return { ok: true, adapter };
}

module.exports = {
  PROVIDER,
  createImapSmtpMailboxAdapter,
};

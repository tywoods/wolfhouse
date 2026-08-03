'use strict';

/**
 * Deterministic in-memory email mailbox adapter for focused tests only.
 *
 * Proves the provider-neutral contract can represent Microsoft Graph, Gmail API,
 * and generic IMAP/SMTP capability combinations without provider SDK imports and
 * without forcing consumers to branch on provider id.
 *
 * Not for production ingress/egress. No network I/O.
 *
 * @module email-mailbox-fake-adapter
 */

const {
  EMAIL_MAILBOX_CAPABILITY_KEYS,
  validateEmailMailboxAdapterIdentity,
} = require('./email-mailbox-adapter-contract');

const CAPABILITY_SET = new Set(EMAIL_MAILBOX_CAPABILITY_KEYS);

/**
 * @param {{ provider: string, public_address: string, capabilities: Record<string, boolean> }} profile
 * @returns {{ok:true,adapter:object}|{ok:false,error:string,details?:unknown}}
 */
function createFakeEmailMailboxAdapter(profile) {
  const identityResult = validateEmailMailboxAdapterIdentity(profile || {});
  if (!identityResult.ok) {
    return {
      ok: false,
      error: identityResult.error,
      details: identityResult.details,
    };
  }

  const identity = identityResult.value;
  const capabilities = identity.capabilities;

  const adapter = Object.freeze({
    kind: 'fake_in_memory',
    getIdentity() {
      return identity;
    },
    getCapabilities() {
      return capabilities;
    },
    describe() {
      return Object.freeze({
        kind: 'fake_in_memory',
        provider: identity.provider,
        public_address: identity.public_address,
        capabilities: { ...capabilities },
      });
    },
    /**
     * Capability probe used by tests/consumers — no provider switches.
     * Known keys return a boolean. Unknown keys fail closed (throw) so
     * consumer typos are not silently treated as unsupported=false.
     * @param {string} capabilityKey
     * @returns {boolean}
     */
    supports(capabilityKey) {
      if (typeof capabilityKey !== 'string' || !CAPABILITY_SET.has(capabilityKey)) {
        const err = new Error('unknown_capability_key');
        err.code = 'unknown_capability_key';
        err.capability_key = capabilityKey;
        throw err;
      }
      return capabilities[capabilityKey] === true;
    },
  });

  return { ok: true, adapter };
}

module.exports = {
  createFakeEmailMailboxAdapter,
};

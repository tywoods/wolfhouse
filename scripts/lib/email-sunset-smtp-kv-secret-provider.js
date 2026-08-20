'use strict';

/** Sunset-staging Key Vault secret reader using the established pinned managed identity. */
const {
  SUNSET_STAGING_MI_CLIENT_ID,
  SUNSET_STAGING_TRUSTED_HOST,
} = require('./email-grant-envelope-azure-kv-sunset-staging-runtime-composition');
const VAULT = `https://${SUNSET_STAGING_TRUSTED_HOST}`;
const MI_CLIENT_ID = SUNSET_STAGING_MI_CLIENT_ID;
const ALLOWED = new Set(['sunset-smtp-host', 'sunset-smtp-port', 'sunset-smtp-tls-mode',
  'sunset-smtp-username', 'sunset-smtp-password']);
function createSunsetSmtpKvSecretProvider(deps = {}) {
  let credential = deps.credential;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  return Object.freeze({
    async resolveSecret(ref) {
      const name = typeof ref === 'string' && ref.startsWith('kv:') ? ref.slice(3) : '';
      if (!ALLOWED.has(name) || typeof fetchImpl !== 'function') throw new Error('smtp_secret_resolve_failed');
      try {
        if (!credential) {
          const { ManagedIdentityCredential } = require('@azure/identity');
          credential = new ManagedIdentityCredential(MI_CLIENT_ID);
        }
        const token = await credential.getToken('https://vault.azure.net/.default');
        const response = await fetchImpl(`${VAULT}/secrets/${encodeURIComponent(name)}?api-version=7.4`, {
          method: 'GET', headers: { authorization: ['Bearer', token.token].join(' ') },
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error('status');
        const body = await response.json();
        if (!body || typeof body.value !== 'string' || !body.value) throw new Error('shape');
        return body.value;
      } catch (_) { throw new Error('smtp_secret_resolve_failed'); }
    },
  });
}
module.exports = Object.freeze({ createSunsetSmtpKvSecretProvider });

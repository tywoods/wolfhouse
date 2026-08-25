'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4C — Staff API live token-loan
 * assembly. Import is inert. Construction does not mint or refresh tokens.
 * Reuses Sunset KV envelope, OAuth client-secret provider, and token HTTP
 * transport. Does not construct Gate 3 send-capable adapters.
 *
 * @module email-luna-controlled-drafting-sunset-staging-token-loan
 */

const {
  isProxySurface,
  ownData,
  exactOwnData,
  isCanonUuid,
} = require('./email-luna-controlled-drafting-closed-data');
const {
  createEmailLunaControlledDraftingTokenLoan,
  SUNSET_DEPLOYMENT,
  WORKER_ID_DEFAULT,
} = require('./email-luna-controlled-drafting-token-loan');
const {
  createSunsetMicrosoftOAuthClientSecretProvider,
} = require('./sunset-microsoft-oauth-provider');
const {
  createMicrosoftTokenHttpTransport,
} = require('./email-microsoft-token-http-transport');
const {
  createActiveEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition,
} = require('./email-grant-envelope-azure-kv-sunset-staging-runtime-composition');
const {
  validateEmailGrantEnvelopeProvider,
} = require('./email-grant-envelope-provider-contract');
const {
  createMicrosoftOidcJwksSignatureVerifier,
} = require('./email-microsoft-oidc-jwks-verifier');

const objectFreeze = Object.freeze;

const ERROR_CODE = 'EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_TOKEN_LOAN_INVALID';
const ERROR_MESSAGE = 'Email Luna controlled drafting live token loan failed.';
const SUNSET_TENANT = 'sunset';
const SUNSET_LOCATION_KEY = 'sunset-somo';
const LIVE_FACTORY_KEYS = objectFreeze(['env', 'withPgClient', 'https', 'crypto', 'timers']);
const HTTPS_KEYS = objectFreeze(['request']);
const CRYPTO_KEYS = objectFreeze(['createPublicKey', 'verify']);
const TIMER_KEYS = objectFreeze(['setTimeout', 'clearTimeout']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function failure() {
  const error = new Error(ERROR_MESSAGE);
  error.code = ERROR_CODE;
  objectFreeze(error);
  return error;
}

function envFlag(env, key) {
  return ownData(env, key) === 'true';
}

function envString(env, key) {
  const value = ownData(env, key);
  return typeof value === 'string' ? value : undefined;
}

function pinMethodBag(raw, keys) {
  const parsed = exactOwnData(raw, keys);
  if (parsed) {
    const out = {};
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (typeof parsed[key] !== 'function' || isProxySurface(parsed[key])) return null;
      out[key] = parsed[key];
    }
    return objectFreeze(out);
  }
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const fn = raw[key];
    if (typeof fn !== 'function' || isProxySurface(fn)) return null;
    out[key] = fn.bind(raw);
  }
  return objectFreeze(out);
}

function createEmailLunaControlledDraftingSunsetStagingLiveTokenLoan(dependencies) {
  try {
    const deps = exactOwnData(dependencies, LIVE_FACTORY_KEYS);
    if (!deps) throw failure();
    const env = deps.env;
    if (!env || typeof env !== 'object' || isProxySurface(env)) throw failure();
    if (envString(env, 'LUNA_DEPLOYMENT') !== SUNSET_DEPLOYMENT) throw failure();
    if (envString(env, 'DEFAULT_CLIENT_SLUG') !== SUNSET_TENANT) throw failure();
    if (envFlag(env, 'LUNA_AUTO_SEND_ENABLED')) throw failure();
    if (envString(env, 'EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_PROVIDER_DRAFT_ENABLED') !== 'true') {
      throw failure();
    }
    if (envString(env, 'EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_KEY') !== SUNSET_LOCATION_KEY) {
      throw failure();
    }
    if (envString(env, 'EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER') !== 'microsoft_graph') {
      throw failure();
    }
    const applicationClientId = envString(env, 'LUNA_EMAIL_OAUTH_CLIENT_ID');
    if (typeof applicationClientId !== 'string' || !UUID_RE.test(applicationClientId)) throw failure();
    const clientId = envString(env, 'EMAIL_LUNA_CONTROLLED_DRAFTING_CLIENT_ID');
    const locationId = envString(env, 'EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_ID');
    const endpointId = envString(env, 'EMAIL_LUNA_CONTROLLED_DRAFTING_ENDPOINT_ID');
    const mailboxId = envString(env, 'EMAIL_LUNA_CONTROLLED_DRAFTING_MAILBOX_ID');
    if (!isCanonUuid(clientId) || !isCanonUuid(locationId) || !isCanonUuid(endpointId) || !isCanonUuid(mailboxId)) {
      throw failure();
    }
    if (typeof deps.withPgClient !== 'function' || isProxySurface(deps.withPgClient)) throw failure();

    const httpsPinned = pinMethodBag(deps.https, HTTPS_KEYS)
      || (typeof deps.https === 'function' ? objectFreeze({ request: deps.https }) : null);
    const cryptoPinned = pinMethodBag(deps.crypto, CRYPTO_KEYS);
    const timersPinned = pinMethodBag(deps.timers, TIMER_KEYS);
    if (!httpsPinned || !cryptoPinned || !timersPinned) throw failure();

    const kv = createActiveEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(env);
    const validated = kv && validateEmailGrantEnvelopeProvider(kv.provider);
    if (!kv || kv.ok !== true || !validated || validated.ok !== true) throw failure();

    const tokenTransport = createMicrosoftTokenHttpTransport(objectFreeze({
      httpsImpl: ownData(httpsPinned, 'request'),
      timers: timersPinned,
    }));

    return createEmailLunaControlledDraftingTokenLoan({
      deployment: SUNSET_DEPLOYMENT,
      applicationClientId: applicationClientId.toLowerCase(),
      withPgClient: deps.withPgClient,
      envelopeProvider: validated.value,
      createSecretProvider: () => createSunsetMicrosoftOAuthClientSecretProvider(objectFreeze({
        deployment: SUNSET_DEPLOYMENT,
        env,
      })),
      transport: tokenTransport,
      workerId: WORKER_ID_DEFAULT,
      createSignatureVerifier: () => createMicrosoftOidcJwksSignatureVerifier(objectFreeze({
        https: httpsPinned,
        crypto: cryptoPinned,
        timers: timersPinned,
      })),
      binding: {
        clientId: clientId.toLowerCase(),
        locationId: locationId.toLowerCase(),
        endpointId: endpointId.toLowerCase(),
        mailboxId: mailboxId.toLowerCase(),
      },
    });
  } catch (err) {
    if (err && err.code === ERROR_CODE) throw err;
    throw failure();
  }
}

module.exports = objectFreeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  LIVE_FACTORY_KEYS,
  createEmailLunaControlledDraftingSunsetStagingLiveTokenLoan,
});

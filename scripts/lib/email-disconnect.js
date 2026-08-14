'use strict';

/**
 * Sunset-staging Microsoft email disconnect runtime (default-off).
 * Wires grant-revoke orchestrator with KV envelope + token transport.
 *
 * @module email-disconnect
 */

const {
  createSunsetMicrosoftOAuthClientSecretProvider,
  SUNSET_DEPLOYMENT: SECRET_SUNSET,
} = require('./sunset-microsoft-oauth-provider');
const {
  createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition,
} = require('./email-grant-envelope-azure-kv-sunset-staging-runtime-composition');
const { validateEmailGrantEnvelopeProvider } = require('./email-grant-envelope-provider-contract');
const { createMicrosoftTokenHttpTransport } = require('./email-microsoft-token-http-transport');
const {
  createDelegatedGrantRevokeService,
  SUNSET_DEPLOYMENT: REVOKE_SUNSET,
} = require('./email-grant-revoke');

const ERROR_CODE = 'EMAIL_DISCONNECT_SUNSET_STAGING_RUNTIME_INVALID';
const ERROR_MESSAGE = 'Email disconnect sunset-staging runtime failed.';
const SUNSET_DEPLOYMENT = 'sunset-staging';
const ENV_DISCONNECT_ENABLED = 'LUNA_EMAIL_OAUTH_DISCONNECT_ENABLED';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEPENDENCY_KEYS = Object.freeze(['env', 'pgClient', 'https', 'timers']);
const HTTPS_KEYS = Object.freeze(['request']);
const TIMERS_KEYS = Object.freeze(['setTimeout', 'clearTimeout']);

if (SECRET_SUNSET !== SUNSET_DEPLOYMENT || REVOKE_SUNSET !== SUNSET_DEPLOYMENT) {
  throw new Error('email_disconnect_runtime_sunset_deployment_mismatch');
}

function isDisconnectEnabled(env) {
  return !!env
    && env.LUNA_DEPLOYMENT === SUNSET_DEPLOYMENT
    && env.LUNA_EMAIL_OAUTH_DISCONNECT_ENABLED === 'true';
}

function failure() {
  const error = new Error(ERROR_MESSAGE);
  Object.defineProperty(error, 'name', { value: 'EmailDisconnectRuntimeError' });
  Object.defineProperty(error, 'code', { value: ERROR_CODE, enumerable: true });
  return Object.freeze(error);
}

function ownData(object, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && !descriptor.get && !descriptor.set ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function createSunsetStagingEmailDisconnectRuntime(deps) {
  try {
    if (!deps || typeof deps !== 'object') throw failure();
    const env = ownData(deps, 'env');
    const pgClient = ownData(deps, 'pgClient');
    const https = ownData(deps, 'https');
    const timers = ownData(deps, 'timers');
    if (!isDisconnectEnabled(env) || !pgClient || typeof pgClient.query !== 'function') throw failure();
    const appId = env.LUNA_EMAIL_OAUTH_CLIENT_ID;
    if (typeof appId !== 'string' || !UUID_RE.test(appId)) throw failure();
    const kvComposition = createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(env);
    const envelopeProvider = kvComposition.provider;
    const envelopeValid = validateEmailGrantEnvelopeProvider(envelopeProvider);
    if (!envelopeValid.ok) throw failure();
    const secretProvider = createSunsetMicrosoftOAuthClientSecretProvider(Object.freeze({
      deployment: SUNSET_DEPLOYMENT,
      env,
    }));
    const transport = createMicrosoftTokenHttpTransport(Object.freeze({ httpsImpl: https, timers }));
    return createDelegatedGrantRevokeService(Object.freeze({
      deployment: SUNSET_DEPLOYMENT,
      applicationClientId: appId.toLowerCase(),
      client: pgClient,
      envelopeProvider,
      secretProvider,
      transport,
    }));
  } catch (_) {
    throw failure();
  }
}

module.exports = Object.freeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  SUNSET_DEPLOYMENT,
  ENV_DISCONNECT_ENABLED,
  DEPENDENCY_KEYS,
  HTTPS_KEYS,
  TIMERS_KEYS,
  isDisconnectEnabled,
  createSunsetStagingEmailDisconnectRuntime,
});

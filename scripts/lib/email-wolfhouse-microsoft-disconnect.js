'use strict';

/**
 * Wolfhouse staff-staging Microsoft email disconnect runtime (default-off).
 * Wires grant-revoke orchestrator with KV envelope + token transport.
 *
 * @module email-wolfhouse-microsoft-disconnect
 */

const {
  createWolfhouseMicrosoftOAuthClientSecretProvider,
} = require('./wolfhouse-microsoft-oauth-provider');
const {
  createActiveWolfhouseStaffStagingEnvelopeComposition,
} = require('./email-grant-envelope-azure-kv-wolfhouse-staff-staging-runtime-composition');
const { validateEmailGrantEnvelopeProvider } = require('./email-grant-envelope-provider-contract');
const { createMicrosoftTokenHttpTransport } = require('./email-microsoft-token-http-transport');
const {
  createDelegatedGrantRevokeService,
  WOLFHOUSE_DEPLOYMENT: REVOKE_WOLFHOUSE,
} = require('./email-grant-revoke');

const ERROR_CODE = 'EMAIL_DISCONNECT_WOLFHOUSE_STAFF_STAGING_RUNTIME_INVALID';
const ERROR_MESSAGE = 'Email disconnect Wolfhouse staff-staging runtime failed.';
const WOLFHOUSE_DEPLOYMENT = 'staff-staging';
const ENV_DISCONNECT_ENABLED = 'WOLFHOUSE_EMAIL_OAUTH_DISCONNECT_ENABLED';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEPENDENCY_KEYS = Object.freeze(['env', 'pgClient', 'https', 'timers']);
const HTTPS_KEYS = Object.freeze(['request']);
const TIMERS_KEYS = Object.freeze(['setTimeout', 'clearTimeout']);

if (REVOKE_WOLFHOUSE !== WOLFHOUSE_DEPLOYMENT) {
  throw new Error('email_disconnect_runtime_wolfhouse_deployment_mismatch');
}

function isDisconnectEnabled(env) {
  return !!env
    && env.LUNA_DEPLOYMENT === WOLFHOUSE_DEPLOYMENT
    && env[ENV_DISCONNECT_ENABLED] === 'true';
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

function createWolfhouseStaffStagingMicrosoftDisconnectRuntime(deps) {
  try {
    if (!deps || typeof deps !== 'object') throw failure();
    const env = ownData(deps, 'env');
    const pgClient = ownData(deps, 'pgClient');
    const https = ownData(deps, 'https');
    const timers = ownData(deps, 'timers');
    if (!isDisconnectEnabled(env) || !pgClient || typeof pgClient.query !== 'function') throw failure();
    const appId = env.WOLFHOUSE_EMAIL_MICROSOFT_OAUTH_CLIENT_ID;
    if (typeof appId !== 'string' || !UUID_RE.test(appId)) throw failure();
    const kvComposition = createActiveWolfhouseStaffStagingEnvelopeComposition(env);
    const envelopeProvider = kvComposition.provider;
    const envelopeValid = validateEmailGrantEnvelopeProvider(envelopeProvider);
    if (!envelopeValid.ok) throw failure();
    const secretProvider = createWolfhouseMicrosoftOAuthClientSecretProvider(Object.freeze({
      deployment: WOLFHOUSE_DEPLOYMENT,
      env,
    }));
    const transport = createMicrosoftTokenHttpTransport(Object.freeze({ httpsImpl: https, timers }));
    return createDelegatedGrantRevokeService(Object.freeze({
      deployment: WOLFHOUSE_DEPLOYMENT,
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
  WOLFHOUSE_DEPLOYMENT,
  ENV_DISCONNECT_ENABLED,
  DEPENDENCY_KEYS,
  HTTPS_KEYS,
  TIMERS_KEYS,
  isDisconnectEnabled,
  createWolfhouseStaffStagingMicrosoftDisconnectRuntime,
});

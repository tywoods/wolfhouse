'use strict';

/**
 * Production content fetcher for EMAIL-DRAFT-OPEN.
 *
 * Wires the reviewed authority-bound JIT Microsoft message-content operation
 * to the current Mail.ReadWrite-capable delegated grant session. Does not
 * change OAuth scopes, grant records, or Gmail. One token loan and one
 * Graph GET per constructed operation.
 */

const https = require('node:https');
const {
  createAuthorityBoundCurrentMessageContentOperation,
  EMAIL_AUTHORITY_BOUND_CURRENT_MESSAGE_CONTENT_RUNTIME_WIRED,
} = require('./email-authority-bound-current-message-content-operation');
const { createMicrosoftGraphMessageContentTransport } = require('./email-microsoft-graph-message-content-transport');
const { createCurrentMessageContentAuthorityResolver } = require('./email-current-message-content-authority-resolver');
const {
  createDelegatedGrantAccessSession,
  EMAIL_DELEGATED_GRANT_ACCESS_SESSION_RUNTIME_WIRED,
  SUNSET_DEPLOYMENT: ACCESS_SUNSET,
} = require('./email-delegated-grant-access-session');
const {
  createSunsetMicrosoftOAuthClientSecretProvider,
  SUNSET_DEPLOYMENT: SECRET_SUNSET,
} = require('./sunset-microsoft-oauth-provider');
const {
  createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition,
  parseEmailGrantEnvelopeAzureKvSunsetStagingRuntimeConfig,
} = require('./email-grant-envelope-azure-kv-sunset-staging-runtime-composition');
const { validateEmailGrantEnvelopeProvider } = require('./email-grant-envelope-provider-contract');
const { createMicrosoftTokenHttpTransport } = require('./email-microsoft-token-http-transport');

const SUNSET_DEPLOYMENT = 'sunset-staging';
const WORKER_ID = 'sunset-email-luna-draft-open';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (SECRET_SUNSET !== SUNSET_DEPLOYMENT || ACCESS_SUNSET !== SUNSET_DEPLOYMENT) {
  throw new Error('email_luna_draft_open_content_sunset_deployment_mismatch');
}
if (EMAIL_AUTHORITY_BOUND_CURRENT_MESSAGE_CONTENT_RUNTIME_WIRED !== false
    || EMAIL_DELEGATED_GRANT_ACCESS_SESSION_RUNTIME_WIRED !== false) {
  throw new Error('email_luna_draft_open_content_owner_safety_unexpected');
}

function fail() {
  const error = new Error('authority_bound_current_message_content_failed');
  error.code = 'authority_bound_current_message_content_failed';
  return error;
}

function ownData(object, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      && !descriptor.get && !descriptor.set
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function pinHttpsTimers(httpsRaw, timersRaw) {
  const request = httpsRaw && typeof httpsRaw.request === 'function'
    ? httpsRaw.request.bind(httpsRaw)
    : null;
  const setTimeoutFn = timersRaw && typeof timersRaw.setTimeout === 'function'
    ? timersRaw.setTimeout
    : null;
  const clearTimeoutFn = timersRaw && typeof timersRaw.clearTimeout === 'function'
    ? timersRaw.clearTimeout
    : null;
  if (!request || !setTimeoutFn || !clearTimeoutFn) return null;
  return Object.freeze({
    https: Object.freeze({ request }),
    timers: Object.freeze({ setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn }),
  });
}

function snapshotGrantReadiness(env) {
  try {
    if (!env || typeof env !== 'object') return null;
    if (ownData(env, 'LUNA_DEPLOYMENT') !== SUNSET_DEPLOYMENT) return null;
    const appId = ownData(env, 'LUNA_EMAIL_OAUTH_CLIENT_ID');
    if (typeof appId !== 'string' || !UUID_RE.test(appId)) return null;
    const kv = parseEmailGrantEnvelopeAzureKvSunsetStagingRuntimeConfig(env);
    if (!kv.ok || kv.composition_enabled !== true) return null;
    return Object.freeze({ env, applicationClientId: appId.toLowerCase() });
  } catch {
    return null;
  }
}

/**
 * Build a one-shot content fetcher, or null when grant custody cannot be composed.
 * Live Mail.ReadWrite grants can GET /messages/{id}?$select=id,body; this factory
 * does not invent Mail.Read-only reauthorization or weaken scope validation.
 */
function createEmailLunaDraftOpenContentFetcher(deps) {
  try {
    if (!deps || typeof deps !== 'object') return null;
    const env = ownData(deps, 'env') || deps.env;
    const pgClient = ownData(deps, 'pgClient') || deps.pgClient;
    const httpsRaw = ownData(deps, 'https') || deps.https || https;
    const timersRaw = ownData(deps, 'timers') || deps.timers || { setTimeout, clearTimeout };
    const ready = snapshotGrantReadiness(env);
    if (!ready) return null;
    if (!pgClient || typeof pgClient !== 'object' || typeof pgClient.query !== 'function') return null;
    if (typeof pgClient.connect === 'function'
        && (typeof pgClient.totalCount === 'number' || typeof pgClient.idleCount === 'number')) {
      return null;
    }
    const natives = pinHttpsTimers(httpsRaw, timersRaw);
    if (!natives) return null;

    const secretProvider = createSunsetMicrosoftOAuthClientSecretProvider(Object.freeze({
      deployment: SUNSET_DEPLOYMENT,
      env: ready.env,
    }));
    const composition = createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(ready.env);
    if (!composition || composition.ok !== true || composition.composition_enabled !== true
        || !composition.provider) {
      return null;
    }
    const prov = validateEmailGrantEnvelopeProvider(composition.provider);
    if (!prov.ok) return null;
    const tokenTransport = createMicrosoftTokenHttpTransport(Object.freeze({
      httpsImpl: natives.https,
      timers: natives.timers,
    }));
    const grantSession = createDelegatedGrantAccessSession(Object.freeze({
      deployment: SUNSET_DEPLOYMENT,
      applicationClientId: ready.applicationClientId,
      client: pgClient,
      envelopeProvider: prov.value,
      secretProvider,
      transport: tokenTransport,
      workerId: WORKER_ID,
    }));
    const transport = createMicrosoftGraphMessageContentTransport(Object.freeze({
      httpsImpl: natives.https,
      timers: natives.timers,
    }));
    const operation = createAuthorityBoundCurrentMessageContentOperation({
      buildAuthorityResolver: createCurrentMessageContentAuthorityResolver({ db: pgClient }),
      grantSession,
      transport,
    });
    return Object.freeze({
      getCurrentMessageContent: operation.getCurrentMessageContent,
    });
  } catch {
    return null;
  }
}

module.exports = Object.freeze({
  SUNSET_DEPLOYMENT,
  WORKER_ID,
  createEmailLunaDraftOpenContentFetcher,
  snapshotGrantReadiness,
  fail,
});

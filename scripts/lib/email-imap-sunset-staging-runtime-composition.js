'use strict';

/**
 * Sunset-staging IMAP inbound runtime composition. Import is inert.
 * runtime_activation is true only when sunset-staging poll/inbound/worker
 * flags are exact 'true'. Auto stays refused. Graph staff outbound
 * composition may coexist; IMAP still never sends.
 *
 * @module email-imap-sunset-staging-runtime-composition
 */

const { types } = require('node:util');
const contract = require('./email-sunset-imap-secret-ref-contract');
const { createEmailImapSunsetStagingWorker } = require('./email-imap-sunset-staging-worker');
const { createSunsetImapInboundPoll } = require('./email-sunset-imap-inbound-poll');
const { createSunsetImapKvSecretProvider } = require('./email-sunset-imap-kv-secret-provider');
const { createSunsetImapImapsTransport } = require('./email-sunset-imap-imaps-transport');

const PINNED_IS_PROXY = types && typeof types.isProxy === 'function'
  ? types.isProxy.bind(types)
  : null;
const SUNSET_DEPLOYMENT = 'sunset-staging';
const SUNSET_TENANT = 'sunset';
const ERROR_CODE = 'EMAIL_IMAP_SUNSET_STAGING_RUNTIME_COMPOSITION_INVALID';

function ownData(obj, key) {
  try {
    if (!obj || typeof obj !== 'object') return undefined;
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    return desc && Object.hasOwn(desc, 'value') && !desc.get && !desc.set
      ? desc.value
      : undefined;
  } catch (_) {
    return undefined;
  }
}

function isProxySurface(value) {
  try {
    if (typeof PINNED_IS_PROXY !== 'function') return true;
    return PINNED_IS_PROXY(value) === true;
  } catch (_) {
    return true;
  }
}

function fail() {
  const err = new Error('Email IMAP sunset-staging runtime composition failed.');
  Object.defineProperty(err, 'code', { value: ERROR_CODE, enumerable: true });
  return Object.freeze(err);
}

function resolveEmailImapSunsetStagingRuntimeReadiness(env) {
  try {
    if (!env || typeof env !== 'object' || Array.isArray(env) || isProxySurface(env)) {
      return Object.freeze({ ok: false, runtime_activation: false });
    }
    if (ownData(env, 'LUNA_AUTO_SEND_ENABLED') === 'true') {
      return Object.freeze({ ok: false, runtime_activation: false });
    }
    if (ownData(env, 'LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED') === 'true') {
      return Object.freeze({ ok: false, runtime_activation: false });
    }
    const structurallyReady = contract.isSunsetEmailImapPollEnabled(env)
      && contract.isSunsetEmailImapInboundEnabled(env)
      && ownData(env, contract.IMAP_RUNTIME_COMPOSITION_ENABLED_ENV) === 'true'
      && ownData(env, contract.IMAP_WORKER_ENABLED_ENV) === 'true'
      && ownData(env, 'LUNA_DEPLOYMENT') === SUNSET_DEPLOYMENT
      && ownData(env, 'DEFAULT_CLIENT_SLUG') === SUNSET_TENANT;
    if (!structurallyReady) {
      return Object.freeze({ ok: false, runtime_activation: false });
    }
    return Object.freeze({ ok: true, runtime_activation: true });
  } catch (_) {
    return Object.freeze({ ok: false, runtime_activation: false });
  }
}

function createEmailImapSunsetStagingRuntimeComposition(deps) {
  const readiness = resolveEmailImapSunsetStagingRuntimeReadiness(deps && deps.env);
  if (!readiness || readiness.runtime_activation !== true) throw fail();
  const worker = createEmailImapSunsetStagingWorker({
    timers: deps.timers,
    intervalMs: deps.intervalMs,
    query: async (sql, args) => deps.withPgClient((client) => client.query(sql, args)),
    pollOnce: async () => deps.withPgClient(async (client) => {
      const poller = createSunsetImapInboundPoll(Object.freeze({
        client: Object.freeze({ query: client.query.bind(client) }),
        env: deps.env,
        secretProvider: deps.secretProvider || createSunsetImapKvSecretProvider(),
        imapTransport: deps.imapTransport || createSunsetImapImapsTransport(),
        withTransactionClient: async (work) => work(client),
      }));
      return poller.pollEligibleSunsetImapInbox();
    }),
  });
  return Object.freeze({
    start: () => worker.start(),
    stop: () => worker.stop(),
    tick: () => worker.tick(),
    getReadiness: () => readiness,
  });
}

module.exports = Object.freeze({
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  ERROR_CODE,
  resolveEmailImapSunsetStagingRuntimeReadiness,
  createEmailImapSunsetStagingRuntimeComposition,
});

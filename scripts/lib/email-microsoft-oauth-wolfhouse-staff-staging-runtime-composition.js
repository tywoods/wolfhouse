'use strict';
/** Wolfhouse-only Microsoft OAuth composition. All gates are exact and default-off. */
const { createMicrosoftOAuthTransactionService, createPostgresOAuthTransactionRepository } = require('./email-microsoft-oauth-transaction-service');
const { createWolfhouseStaffStagingMicrosoftOAuthCallbackRuntime } = require('./email-microsoft-oauth-wolfhouse-callback-runtime');
const tenant = require('./email-wolfhouse-tenant');

function failure() {
  const error = new Error('Wolfhouse Microsoft OAuth runtime unavailable.');
  error.code = 'WOLFHOUSE_MICROSOFT_OAUTH_RUNTIME_UNAVAILABLE';
  throw Object.freeze(error);
}

function createWolfhouseStaffStagingMicrosoftOAuthComposition(deps) {
  const env = deps && deps.env;
  if (!env || env.LUNA_DEPLOYMENT !== 'staff-staging') throw failure();
  return Object.freeze({
    createStart(pgClient) {
      if (!tenant.isWolfhouseEmailMicrosoftOAuthStartEnabled(env)) throw failure();
      return createMicrosoftOAuthTransactionService({
        repository: createPostgresOAuthTransactionRepository(pgClient), env,
      });
    },
    createCallbackRuntime(pgClient, stageTelemetry) {
      if (!tenant.isWolfhouseEmailMicrosoftOAuthCallbackEnabled(env)) throw failure();
      const natives = deps.nativeSurfaces;
      if (!natives) throw failure();
      return createWolfhouseStaffStagingMicrosoftOAuthCallbackRuntime(Object.freeze({
        env, pgClient, https: natives.https, crypto: natives.crypto,
        timers: natives.timers, stageTelemetry,
      }));
    },
  });
}

module.exports = Object.freeze({
  DEPLOYMENT: 'staff-staging', createWolfhouseStaffStagingMicrosoftOAuthComposition,
});

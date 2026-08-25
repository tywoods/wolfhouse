'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4A.
 *
 * Thin composition over the Stage 1 direct-LOGIN pool owner. Two distinct
 * principals, database pinned to sunset_staging, no parallel DSN parser.
 */

const runtimeIsProxy = require('node:util').types.isProxy.bind(undefined);
const { isProxySurface, ownData } = require('./email-luna-controlled-drafting-closed-data');
const {
  resolveEmailLunaDirectLoginPairConfig,
  createEmailLunaDirectLoginConnectionPair,
  drainEmailLunaAutomationShadowRuntimePair,
  isAuthenticEmailLunaDirectLoginConnection,
  isAuthenticEmailLunaDirectLoginConnectionPair,
  EXPECTED_DATABASE_SUNSET_STAGING,
  DIRECT_LOGIN_CONNECTION_TIMEOUT_MS,
  PRE_CONNECT_DISTINCTNESS_IS_NOT_LIVE_SESSION_PROOF,
} = require('./email-luna-automation-shadow-worker-connection');

const objectFreeze = Object.freeze;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectPrototype = Object.prototype;
const reflectOwnKeys = Reflect.ownKeys;
const arrayIsArray = Array.isArray;

const ENV_PRODUCER_DATABASE_URL = 'EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_DATABASE_URL';
const ENV_WORKER_DATABASE_URL = 'EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_DATABASE_URL';
const ERROR_CODE = 'EMAIL_LUNA_CONTROLLED_DRAFTING_PRINCIPAL_CONNECTION_INVALID';
const CREATE_KEYS = objectFreeze(['env', 'appConnectionString']);
const CLOSE_TIMEOUT_MS = DIRECT_LOGIN_CONNECTION_TIMEOUT_MS;
const STOP_DRAIN_TIMEOUT_MS = DIRECT_LOGIN_CONNECTION_TIMEOUT_MS;
const EXPECTED_DATABASE = EXPECTED_DATABASE_SUNSET_STAGING;

function invalid() {
  const error = new Error('Email Luna controlled drafting principal connection failed.');
  error.code = ERROR_CODE;
  return error;
}

function pairInput(input) {
  if (arguments.length !== 1) throw invalid();
  if (!input || typeof input !== 'object' || runtimeIsProxy(input) || isProxySurface(input) || arrayIsArray(input)) {
    throw invalid();
  }
  if (objectGetPrototypeOf(input) !== objectPrototype) throw invalid();
  let own;
  try { own = reflectOwnKeys(input); } catch (_) { throw invalid(); }
  for (let index = 0; index < own.length; index += 1) {
    if (own[index] !== 'env' && own[index] !== 'appConnectionString') throw invalid();
  }
  const env = ownData(input, 'env');
  const appConnectionString = ownData(input, 'appConnectionString');
  return {
    env,
    appConnectionString,
    producerEnvKey: ENV_PRODUCER_DATABASE_URL,
    workerEnvKey: ENV_WORKER_DATABASE_URL,
    expectedDatabase: EXPECTED_DATABASE,
  };
}

function resolveEmailLunaControlledDraftingPrincipalConnectionConfig(input) {
  return resolveEmailLunaDirectLoginPairConfig(pairInput(input));
}

function createEmailLunaControlledDraftingPrincipalConnectionPair(input) {
  return createEmailLunaDirectLoginConnectionPair(pairInput(input));
}

function drainEmailLunaControlledDraftingRuntimePair(input) {
  return drainEmailLunaAutomationShadowRuntimePair(input);
}

function isAuthenticEmailLunaControlledDraftingPrincipalConnection(value) {
  return isAuthenticEmailLunaDirectLoginConnection(value);
}

function isAuthenticEmailLunaControlledDraftingPrincipalConnectionPair(value) {
  return isAuthenticEmailLunaDirectLoginConnectionPair(value);
}

module.exports = objectFreeze({
  ENV_PRODUCER_DATABASE_URL,
  ENV_WORKER_DATABASE_URL,
  ERROR_CODE,
  CREATE_KEYS,
  PRE_CONNECT_DISTINCTNESS_IS_NOT_LIVE_SESSION_PROOF,
  CLOSE_TIMEOUT_MS,
  STOP_DRAIN_TIMEOUT_MS,
  EXPECTED_DATABASE,
  resolveEmailLunaControlledDraftingPrincipalConnectionConfig,
  createEmailLunaControlledDraftingPrincipalConnectionPair,
  drainEmailLunaControlledDraftingRuntimePair,
  isAuthenticEmailLunaControlledDraftingPrincipalConnection,
  isAuthenticEmailLunaControlledDraftingPrincipalConnectionPair,
});

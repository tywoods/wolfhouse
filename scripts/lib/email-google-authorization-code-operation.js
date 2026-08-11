'use strict';

const {
  createGoogleVerifiedGrantComposition,
} = require('./email-google-verified-grant-composition');
const {
  createGoogleTokenResponseCustody,
} = require('./email-google-token-response-custody');
const {
  createGoogleTokenExchangeCustody,
} = require('./email-google-token-exchange-custody');
const {
  createGoogleAuthorizationCodeRequest,
} = require('./email-google-authorization-code-request');

const CONFIG_KEYS = Object.freeze([
  'clientId',
  'endpointId',
  'operationId',
  'actorStaffUserId',
  'expectedNonce',
  'expectedClientId',
  'applicationClientId',
  'redirectUri',
]);
const DEPENDENCY_KEYS = Object.freeze([
  'https',
  'crypto',
  'timers',
  'envelopeProvider',
  'clock',
  'installer',
]);
const OWNER_METHODS = Object.freeze({
  https: Object.freeze(['request']),
  crypto: Object.freeze(['createPublicKey', 'verify']),
  timers: Object.freeze(['setTimeout', 'clearTimeout']),
  envelopeProvider: Object.freeze(['sealGrantPayload', 'openGrantPayload', 'rewrapGrantDek']),
  clock: Object.freeze(['nowEpochSeconds']),
  installer: Object.freeze(['installVerifiedGrant']),
});
const FAILURE_CODE = 'GOOGLE_AUTHORIZATION_CODE_OPERATION_FAILED';
const FAILURE = new Error(FAILURE_CODE);
Object.defineProperty(FAILURE, 'name', { value: 'GoogleAuthorizationCodeOperationError' });
Object.defineProperty(FAILURE, 'code', { value: FAILURE_CODE, enumerable: true });
Object.freeze(FAILURE);

function exactFrozenRecord(value, keys) {
  try {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || !Object.isFrozen(value)) return null;
    const actual = Reflect.ownKeys(value);
    if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) return null;
    const record = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable
          || descriptor.writable || descriptor.configurable) return null;
      record[key] = descriptor.value;
    }
    return record;
  } catch (_) {
    return null;
  }
}

function methodOwner(value, methods) {
  const record = exactFrozenRecord(value, methods);
  if (!record || methods.some((method) => typeof record[method] !== 'function')) return null;
  return record;
}

function createGoogleAuthorizationCodeOperation(configuration, dependencies) {
  try {
    const config = exactFrozenRecord(configuration, CONFIG_KEYS);
    const dependency = exactFrozenRecord(dependencies, DEPENDENCY_KEYS);
    if (!config || !dependency || config.expectedClientId !== config.applicationClientId) throw FAILURE;
    for (const key of DEPENDENCY_KEYS) {
      if (!methodOwner(dependency[key], OWNER_METHODS[key])) throw FAILURE;
    }

    const verifiedComposition = createGoogleVerifiedGrantComposition(Object.freeze({
      clientId: config.clientId,
      endpointId: config.endpointId,
      operationId: config.operationId,
      actorStaffUserId: config.actorStaffUserId,
      expectedNonce: config.expectedNonce,
      expectedClientId: config.expectedClientId,
    }), dependencies);
    if (!methodOwner(verifiedComposition, ['acceptValidatedTokens'])) throw FAILURE;

    const responseCustody = createGoogleTokenResponseCustody(Object.freeze({
      custody: verifiedComposition,
    }));
    if (!methodOwner(responseCustody, ['acceptTokenResponse'])) throw FAILURE;

    const exchangeCustody = createGoogleTokenExchangeCustody(Object.freeze({
      https: dependency.https,
      timers: dependency.timers,
      responseCustody,
    }));
    if (!methodOwner(exchangeCustody, ['exchangeAndCustody'])) throw FAILURE;

    const request = createGoogleAuthorizationCodeRequest(Object.freeze({
      applicationClientId: config.applicationClientId,
      redirectUri: config.redirectUri,
      exchangeCustody,
    }));
    if (!methodOwner(request, ['exchangeAuthorizationCode'])) throw FAILURE;
    return request;
  } catch (_) {
    throw FAILURE;
  }
}

module.exports = Object.freeze({ createGoogleAuthorizationCodeOperation });

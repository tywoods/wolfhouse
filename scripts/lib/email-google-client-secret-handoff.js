'use strict';

const {
  validateEmailMailboxSecretRef,
} = require('./email-mailbox-adapter-contract');
const { resolveOptionalStageTelemetry, safeEmitStage } = require('./email-microsoft-oauth-stage-telemetry');

const apply = Reflect.apply;
const ownKeys = Reflect.ownKeys;
const freeze = Object.freeze;
const isFrozen = Object.isFrozen;
const getPrototypeOf = Object.getPrototypeOf;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const create = Object.create;
const objectPrototype = Object.prototype;
const regexTest = RegExp.prototype.test;
const promisePrototype = Promise.prototype;
const promiseThen = Promise.prototype.then;
const visiblePattern = /^[\x21-\x7e]+$/;
const verifierPattern = /^[A-Za-z0-9._~-]+$/;
const FAILURE_CODE = 'GOOGLE_CLIENT_SECRET_HANDOFF_FAILED';
const FAILURE = new Error(FAILURE_CODE);
Object.defineProperty(FAILURE, 'name', { value: 'GoogleClientSecretHandoffError' });
Object.defineProperty(FAILURE, 'code', { value: FAILURE_CODE, enumerable: true });
freeze(FAILURE);

function snapshot(value, keys) {
  try {
    if (value === null || typeof value !== 'object'
        || getPrototypeOf(value) !== objectPrototype
        || !isFrozen(value)) return null;
    const actual = ownKeys(value);
    if (actual.length !== keys.length) return null;
    const copy = create(null);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (actual[index] !== key) return null;
      const descriptor = getOwnPropertyDescriptor(value, key);
      if (!descriptor || !hasOwn(descriptor, 'value') || !descriptor.enumerable
          || descriptor.writable || descriptor.configurable) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch (_) {
    return null;
  }
}

function validationValue(result, expected) {
  try {
    if (result === null || typeof result !== 'object') return false;
    const ok = getOwnPropertyDescriptor(result, 'ok');
    const value = getOwnPropertyDescriptor(result, 'value');
    return !!ok && hasOwn(ok, 'value') && ok.value === true
      && !!value && hasOwn(value, 'value') && value.value === expected;
  } catch (_) {
    return false;
  }
}

function visible(value, minimum, maximum) {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum
    && apply(regexTest, visiblePattern, [value]);
}

function nativeChain(value, fulfilled) {
  let chained;
  try {
    if (getPrototypeOf(value) !== promisePrototype) throw FAILURE;
    chained = apply(promiseThen, value, [fulfilled, () => { throw FAILURE; }]);
    return apply(promiseThen, chained, [result => result, () => { throw FAILURE; }]);
  } catch (_) {
    throw FAILURE;
  }
}

function createGoogleClientSecretHandoff(configuration, dependencies) {
  try {
    const config = snapshot(configuration, ['secretRef']);
    if (!config) throw FAILURE;
    const checked = validateEmailMailboxSecretRef(config.secretRef);
    if (!validationValue(checked, config.secretRef)) throw FAILURE;

    const telemetryResolution = resolveOptionalStageTelemetry(dependencies, ['secretProvider', 'operation']);
    const dependency = snapshot(dependencies, ['secretProvider', 'operation', 'stageTelemetry'])
      || snapshot(dependencies, ['secretProvider', 'operation']);
    if (!dependency || !telemetryResolution.ok) throw FAILURE;
    const stageTelemetry = telemetryResolution.stageTelemetry;
    const provider = snapshot(dependency.secretProvider, ['resolveClientSecret']);
    const operation = snapshot(dependency.operation, ['exchangeAuthorizationCode']);
    if (!provider || !operation || typeof provider.resolveClientSecret !== 'function'
        || typeof operation.exchangeAuthorizationCode !== 'function') throw FAILURE;

    const providerOwner = dependency.secretProvider;
    const operationOwner = dependency.operation;
    const resolveClientSecret = provider.resolveClientSecret;
    const exchangeAuthorizationCode = operation.exchangeAuthorizationCode;
    const secretRef = config.secretRef;
    let used = false;

    function completeAuthorization(value) {
      if (used) throw FAILURE;
      used = true;
      try {
        const request = snapshot(value, ['authorizationCode', 'codeVerifier']);
        if (!request || !visible(request.authorizationCode, 1, 8192)
            || typeof request.codeVerifier !== 'string'
            || request.codeVerifier.length < 43 || request.codeVerifier.length > 128
            || !apply(regexTest, verifierPattern, [request.codeVerifier])) throw FAILURE;

        const finish = secretOutput => {
          try {
            const selected = snapshot(secretOutput, ['clientSecret']);
            if (!selected || !visible(selected.clientSecret, 1, 4096)) throw FAILURE;
            safeEmitStage(stageTelemetry, 'google_provider_returned');
            safeEmitStage(stageTelemetry, 'google_exchange_started');
            const output = apply(exchangeAuthorizationCode, operationOwner, [freeze({
              authorizationCode: request.authorizationCode,
              codeVerifier: request.codeVerifier,
              clientSecret: selected.clientSecret,
            })]);
            const accept = acknowledgement => {
              safeEmitStage(stageTelemetry, 'google_exchange_returned');
              const record = snapshot(acknowledgement, ['status']);
              if (!record || record.status !== 'custodied') throw FAILURE;
              return acknowledgement;
            };
            const direct = snapshot(output, ['status']);
            return direct ? accept(output) : nativeChain(output, accept);
          } catch (_) {
            throw FAILURE;
          }
        };

        safeEmitStage(stageTelemetry, 'google_provider_started');
        const output = apply(resolveClientSecret, providerOwner, [freeze({ secretRef })]);
        const direct = snapshot(output, ['clientSecret']);
        return direct ? finish(output) : nativeChain(output, finish);
      } catch (_) {
        throw FAILURE;
      }
    }

    return freeze({ completeAuthorization });
  } catch (_) {
    throw FAILURE;
  }
}

module.exports = freeze({ createGoogleClientSecretHandoff });

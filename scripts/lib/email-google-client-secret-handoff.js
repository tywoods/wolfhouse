'use strict';

const {
  validateEmailMailboxSecretRef,
} = require('./email-mailbox-adapter-contract');

const apply = Reflect.apply;
const promisePrototype = Promise.prototype;
const promiseThen = Promise.prototype.then;
const FAILURE_CODE = 'GOOGLE_CLIENT_SECRET_HANDOFF_FAILED';
const FAILURE = new Error(FAILURE_CODE);
Object.defineProperty(FAILURE, 'name', { value: 'GoogleClientSecretHandoffError' });
Object.defineProperty(FAILURE, 'code', { value: FAILURE_CODE, enumerable: true });
Object.freeze(FAILURE);

function snapshot(value, keys) {
  try {
    if (value === null || typeof value !== 'object'
        || Object.getPrototypeOf(value) !== Object.prototype
        || !Object.isFrozen(value)) return null;
    const actual = Reflect.ownKeys(value);
    if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) return null;
    const copy = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable
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
    const ok = Object.getOwnPropertyDescriptor(result, 'ok');
    const value = Object.getOwnPropertyDescriptor(result, 'value');
    return !!ok && Object.hasOwn(ok, 'value') && ok.value === true
      && !!value && Object.hasOwn(value, 'value') && value.value === expected;
  } catch (_) {
    return false;
  }
}

function visible(value, minimum, maximum) {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum
    && /^[\x21-\x7e]+$/.test(value);
}

function nativeChain(value, fulfilled) {
  let chained;
  try {
    if (Object.getPrototypeOf(value) !== promisePrototype) throw FAILURE;
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

    const dependency = snapshot(dependencies, ['secretProvider', 'operation']);
    if (!dependency) throw FAILURE;
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
            || !/^[A-Za-z0-9._~-]+$/.test(request.codeVerifier)) throw FAILURE;

        const finish = secretOutput => {
          try {
            const selected = snapshot(secretOutput, ['clientSecret']);
            if (!selected || !visible(selected.clientSecret, 1, 4096)) throw FAILURE;
            const output = apply(exchangeAuthorizationCode, operationOwner, [Object.freeze({
              authorizationCode: request.authorizationCode,
              codeVerifier: request.codeVerifier,
              clientSecret: selected.clientSecret,
            })]);
            const accept = acknowledgement => {
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

        const output = apply(resolveClientSecret, providerOwner, [Object.freeze({ secretRef })]);
        const direct = snapshot(output, ['clientSecret']);
        return direct ? finish(output) : nativeChain(output, finish);
      } catch (_) {
        throw FAILURE;
      }
    }

    return Object.freeze({ completeAuthorization });
  } catch (_) {
    throw FAILURE;
  }
}

module.exports = Object.freeze({ createGoogleClientSecretHandoff });

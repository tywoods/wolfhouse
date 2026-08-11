'use strict';

const {
  createGoogleOidcJwksVerifier,
} = require('./email-google-oidc-jwks-verifier');
const {
  createGoogleOidcVerifiedIdentity,
} = require('./email-google-oidc-id-token');
const {
  CONFIG_KEYS,
  createGoogleVerifiedGrantCustodyAdapter,
} = require('./email-google-verified-grant-custody');

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
  envelopeProvider: Object.freeze([
    'sealGrantPayload',
    'openGrantPayload',
    'rewrapGrantDek',
  ]),
  clock: Object.freeze(['nowEpochSeconds']),
  installer: Object.freeze(['installVerifiedGrant']),
});

function failure() {
  const error = new Error('Google verified grant composition failed.');
  Object.defineProperty(error, 'name', {
    value: 'GoogleVerifiedGrantCompositionError',
  });
  Object.defineProperty(error, 'code', {
    value: 'GOOGLE_VERIFIED_GRANT_COMPOSITION_FAILED',
    enumerable: true,
  });
  return Object.freeze(error);
}

function readExactFrozenRecord(value, keys) {
  try {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype
        || !Object.isFrozen(value)) return null;
    const actual = Reflect.ownKeys(value);
    if (actual.length !== keys.length
        || actual.some((key, index) => key !== keys[index])) return null;
    const record = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')
          || !descriptor.enumerable || descriptor.writable
          || descriptor.configurable) return null;
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return null;
  }
}

function readMethodOwner(value, methods) {
  const record = readExactFrozenRecord(value, methods);
  if (!record || methods.some((method) => typeof record[method] !== 'function')) {
    return null;
  }
  return record;
}

function createGoogleVerifiedGrantComposition(config, dependencies) {
  let dependencyRecord;
  try {
    if (!readExactFrozenRecord(config, CONFIG_KEYS)) throw failure();
    dependencyRecord = readExactFrozenRecord(dependencies, DEPENDENCY_KEYS);
    if (!dependencyRecord) throw failure();
    for (const key of DEPENDENCY_KEYS) {
      if (!readMethodOwner(dependencyRecord[key], OWNER_METHODS[key])) throw failure();
    }
  } catch {
    throw failure();
  }

  let custody;
  let acceptValidatedTokens;
  try {
    const signatureVerifier = createGoogleOidcJwksVerifier(Object.freeze({
      https: dependencyRecord.https,
      crypto: dependencyRecord.crypto,
      timers: dependencyRecord.timers,
    }));
    if (!readMethodOwner(signatureVerifier, ['verifySignature'])) throw failure();

    const verifiedIdentity = createGoogleOidcVerifiedIdentity(Object.freeze({
      signatureVerifier,
    }));
    if (!readMethodOwner(verifiedIdentity, ['verifyIdentity'])) throw failure();

    custody = createGoogleVerifiedGrantCustodyAdapter(config, Object.freeze({
      verifiedIdentity,
      envelopeProvider: dependencyRecord.envelopeProvider,
      clock: dependencyRecord.clock,
      installer: dependencyRecord.installer,
    }));
    const custodyRecord = readMethodOwner(custody, ['acceptValidatedTokens']);
    if (!custodyRecord) throw failure();
    acceptValidatedTokens = custodyRecord.acceptValidatedTokens;
  } catch {
    throw failure();
  }

  async function accept(input) {
    try {
      const acknowledgement = await Reflect.apply(acceptValidatedTokens, custody, [input]);
      const record = readExactFrozenRecord(acknowledgement, ['status']);
      if (!record || record.status !== 'accepted') throw failure();
      return acknowledgement;
    } catch {
      throw failure();
    }
  }

  return Object.freeze({ acceptValidatedTokens: accept });
}

module.exports = Object.freeze({ createGoogleVerifiedGrantComposition });

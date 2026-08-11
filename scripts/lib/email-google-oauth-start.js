'use strict';

const { GOOGLE_PHASE_A_SCOPES } = require('./email-google-verified-grant-custody');

const apply = Reflect.apply;
const ownKeys = Reflect.ownKeys;
const freeze = Object.freeze;
const isFrozen = Object.isFrozen;
const getPrototypeOf = Object.getPrototypeOf;
const getDescriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const createObject = Object.create;
const defineProperty = Object.defineProperty;
const objectPrototype = Object.prototype;
const arrayIsArray = Array.isArray;
const regexpTest = RegExp.prototype.test;
const promisePrototype = Promise.prototype;
const promiseThen = Promise.prototype.then;
const DateConstructor = Date;
const dateParse = Date.parse;
const dateToISOString = Date.prototype.toISOString;
const finite = Number.isFinite;
const URLConstructor = URL;
const URLSearchParamsConstructor = URLSearchParams;
const paramsToString = URLSearchParams.prototype.toString;
const bufferIsBuffer = Buffer.isBuffer;
const bufferToString = Buffer.prototype.toString;

const FAILURE = 'GOOGLE_OAUTH_START_FAILED';
const CONFIG_KEYS = freeze(['enabled', 'applicationClientId', 'redirectUri']);
const DEPENDENCY_KEYS = freeze(['cryptography', 'clock', 'repository']);
const CRYPTOGRAPHY_KEYS = freeze(['randomUUID', 'randomBytes', 'sha256Ascii']);
const CLOCK_KEYS = freeze(['now']);
const REPOSITORY_KEYS = freeze(['create']);
const INPUT_KEYS = freeze(['clientId', 'locationId', 'endpointId', 'staffUserId', 'authSessionId']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLIENT_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CLIENT_SUFFIX = '.apps.googleusercontent.com';
const AUTHORITY = 'https://accounts.google.com/o/oauth2/v2/auth';

const failure = new Error(FAILURE);
defineProperty(failure, 'name', { value: 'GoogleOAuthStartError' });
defineProperty(failure, 'code', { value: FAILURE, enumerable: true });
freeze(failure);

function fail() { throw failure; }
function test(pattern, value) { return apply(regexpTest, pattern, [value]); }

function snapshot(value, keys) {
  if (value === null || typeof value !== 'object' || arrayIsArray(value)
      || getPrototypeOf(value) !== objectPrototype || !isFrozen(value)) return null;
  const actual = ownKeys(value);
  if (actual.length !== keys.length) return null;
  const result = createObject(null);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (actual[index] !== key) return null;
    const descriptor = getDescriptor(value, key);
    if (!descriptor || !hasOwn(descriptor, 'value') || !descriptor.enumerable
        || descriptor.writable || descriptor.configurable) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function visible(value, minimum, maximum) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 33 || unit > 126) return false;
  }
  return true;
}

function validClientId(value) {
  return visible(value, CLIENT_SUFFIX.length + 1, 255) && value.endsWith(CLIENT_SUFFIX)
    && test(CLIENT_PREFIX, value.slice(0, -CLIENT_SUFFIX.length));
}

function validRedirect(value) {
  if (!visible(value, 1, 2048)) return false;
  try {
    const parsed = new URLConstructor(value);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === ''
      && parsed.hash === '' && parsed.search === '' && parsed.port === ''
      && parsed.hostname !== '' && parsed.href === value;
  } catch (_) { return false; }
}

function timestamp(value) {
  if (typeof value !== 'string' || !test(TIMESTAMP, value)) return null;
  const parsed = apply(dateParse, DateConstructor, [value]);
  if (!finite(parsed) || apply(dateToISOString, new DateConstructor(parsed), []) !== value) return null;
  return parsed;
}

function validAck(value, operationId, expiresAt) {
  const ack = snapshot(value, ['operationId', 'expiresAt']);
  return ack && ack.operationId === operationId && ack.expiresAt === expiresAt;
}

function createGoogleOAuthStart(configuration, dependencies) {
  try {
    const config = snapshot(configuration, CONFIG_KEYS);
    if (!config || config.enabled !== true || !validClientId(config.applicationClientId)
        || !validRedirect(config.redirectUri)) fail();
    const owners = snapshot(dependencies, DEPENDENCY_KEYS);
    const cryptography = owners && snapshot(owners.cryptography, CRYPTOGRAPHY_KEYS);
    const clock = owners && snapshot(owners.clock, CLOCK_KEYS);
    const repository = owners && snapshot(owners.repository, REPOSITORY_KEYS);
    if (!cryptography || !clock || !repository
        || typeof cryptography.randomUUID !== 'function' || typeof cryptography.randomBytes !== 'function'
        || typeof cryptography.sha256Ascii !== 'function' || typeof clock.now !== 'function'
        || typeof repository.create !== 'function') fail();

    const randomUUID = cryptography.randomUUID;
    const randomBytes = cryptography.randomBytes;
    const sha256Ascii = cryptography.sha256Ascii;
    const now = clock.now;
    const repositoryCreate = repository.create;
    const cryptographyOwner = owners.cryptography;
    const clockOwner = owners.clock;
    const repositoryOwner = owners.repository;

    function complete(ack, operationId, expiresAt, values) {
      if (!validAck(ack, operationId, expiresAt)) fail();
      const params = new URLSearchParamsConstructor([
        ['client_id', config.applicationClientId], ['response_type', 'code'],
        ['redirect_uri', config.redirectUri], ['response_mode', 'query'],
        ['scope', GOOGLE_PHASE_A_SCOPES.join(' ')], ['state', values.state],
        ['nonce', values.nonce], ['code_challenge', values.challenge],
        ['code_challenge_method', 'S256'], ['prompt', 'consent'],
      ]);
      return freeze({ authorizationUrl: `${AUTHORITY}?${apply(paramsToString, params, [])}`, expiresAt });
    }

    function start(value) {
      try {
        const input = snapshot(value, INPUT_KEYS);
        if (!input) fail();
        for (let index = 0; index < INPUT_KEYS.length; index += 1) {
          if (typeof input[INPUT_KEYS[index]] !== 'string' || !test(UUID, input[INPUT_KEYS[index]])) fail();
        }
        const operationId = apply(randomUUID, cryptographyOwner, []);
        if (typeof operationId !== 'string' || !test(UUID, operationId)) fail();
        const encoded = [];
        for (let index = 0; index < 3; index += 1) {
          const bytes = apply(randomBytes, cryptographyOwner, [32]);
          if (!apply(bufferIsBuffer, Buffer, [bytes]) || bytes.length !== 32) fail();
          const text = apply(bufferToString, bytes, ['base64url']);
          if (!test(TOKEN, text)) fail();
          encoded.push(text);
        }
        const state = encoded[0]; const nonce = encoded[1]; const codeVerifier = encoded[2];
        const stateDigest = apply(sha256Ascii, cryptographyOwner, [state]);
        const verifierDigest = apply(sha256Ascii, cryptographyOwner, [codeVerifier]);
        if (!apply(bufferIsBuffer, Buffer, [stateDigest]) || stateDigest.length !== 32
            || !apply(bufferIsBuffer, Buffer, [verifierDigest]) || verifierDigest.length !== 32) fail();
        const stateHash = apply(bufferToString, stateDigest, ['hex']);
        const challenge = apply(bufferToString, verifierDigest, ['base64url']);
        if (!test(DIGEST, stateHash) || !test(TOKEN, challenge)) fail();
        const issuedAt = apply(now, clockOwner, []);
        const issuedMilliseconds = timestamp(issuedAt);
        if (issuedMilliseconds === null) fail();
        const expiresAt = apply(dateToISOString, new DateConstructor(issuedMilliseconds + 600000), []);
        if (timestamp(expiresAt) === null) fail();
        const dto = freeze({ clientId: input.clientId, locationId: input.locationId,
          endpointId: input.endpointId, staffUserId: input.staffUserId, authSessionId: input.authSessionId,
          operationId, stateHash, codeVerifier, nonce, issuedAt, expiresAt });
        const output = apply(repositoryCreate, repositoryOwner, [dto]);
        const values = { state, nonce, challenge };
        if (output !== null && typeof output === 'object' && getPrototypeOf(output) === promisePrototype) {
          return apply(promiseThen, output, [
            ack => complete(ack, operationId, expiresAt, values),
            () => fail(),
          ]);
        }
        return complete(output, operationId, expiresAt, values);
      } catch (_) { fail(); }
    }
    return freeze({ start });
  } catch (_) { fail(); }
}

module.exports = freeze({ createGoogleOAuthStart });

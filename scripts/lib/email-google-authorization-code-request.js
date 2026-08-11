'use strict';

const FAILURE = 'GOOGLE_AUTHORIZATION_CODE_REQUEST_FAILED';
const FAILURE_PROTOTYPE = Object.freeze(Object.assign(Object.create(Error.prototype), { code: FAILURE }));
const FAILURE_ERROR = new Error(FAILURE);
Object.setPrototypeOf(FAILURE_ERROR, FAILURE_PROTOTYPE);
Object.freeze(FAILURE_ERROR);

function fail() {
  throw FAILURE_ERROR;
}

function exactRecord(value, keys) {
  if (value === null || typeof value !== 'object') return false;
  if (Object.getPrototypeOf(value) !== Object.prototype || !Object.isFrozen(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || !ownKeys.every((key, index) => key === keys[index])) return false;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true ||
        descriptor.configurable !== false || descriptor.writable !== false) return false;
  }
  return true;
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
  const ending = '.apps.googleusercontent.com';
  return visible(value, ending.length + 1, 255) && value.endsWith(ending) &&
    value.length > ending.length;
}

function validRedirect(value) {
  if (!visible(value, 1, 2048)) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    return false;
  }
  return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' &&
    parsed.hash === '' && parsed.search === '' && parsed.port === '' && parsed.hostname !== '' &&
    parsed.href === value;
}

function validVerifier(value) {
  if (typeof value !== 'string' || value.length < 43 || value.length > 128) return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    const allowed = (unit >= 65 && unit <= 90) || (unit >= 97 && unit <= 122) ||
      (unit >= 48 && unit <= 57) || unit === 45 || unit === 46 || unit === 95 || unit === 126;
    if (!allowed) return false;
  }
  return true;
}

function validAcknowledgement(value) {
  return exactRecord(value, ['status']) && value.status === 'custodied';
}

function createGoogleAuthorizationCodeRequest(configuration) {
  try {
    if (!exactRecord(configuration, ['applicationClientId', 'redirectUri', 'exchangeCustody'])) fail();
    const applicationClientId = configuration.applicationClientId;
    const redirectUri = configuration.redirectUri;
    const exchangeCustody = configuration.exchangeCustody;
    if (!validClientId(applicationClientId) || !validRedirect(redirectUri) ||
        !exactRecord(exchangeCustody, ['exchangeAndCustody'])) fail();
    const exchangeAndCustody = exchangeCustody.exchangeAndCustody;
    if (typeof exchangeAndCustody !== 'function') fail();

    let burned = false;
    async function exchangeAuthorizationCode(input) {
      if (burned) fail();
      burned = true;
      try {
        if (!exactRecord(input, ['authorizationCode', 'codeVerifier', 'clientSecret'])) fail();
        const authorizationCode = input.authorizationCode;
        const codeVerifier = input.codeVerifier;
        const clientSecret = input.clientSecret;
        if (!visible(authorizationCode, 1, 8192) || !validVerifier(codeVerifier) ||
            !visible(clientSecret, 1, 4096)) fail();
        const body = new URLSearchParams([
          ['client_id', applicationClientId],
          ['client_secret', clientSecret],
          ['grant_type', 'authorization_code'],
          ['code', authorizationCode],
          ['redirect_uri', redirectUri],
          ['code_verifier', codeVerifier],
        ]).toString();
        if (body.length > 32768) fail();
        let acknowledgement = exchangeAndCustody.call(exchangeCustody, Object.freeze({ body }));
        if (acknowledgement !== null && typeof acknowledgement === 'object' &&
            Object.getPrototypeOf(acknowledgement) === Promise.prototype) {
          acknowledgement = await acknowledgement;
        }
        if (!validAcknowledgement(acknowledgement)) fail();
        return acknowledgement;
      } catch (_) {
        fail();
      }
    }

    return Object.freeze({ exchangeAuthorizationCode });
  } catch (_) {
    fail();
  }
}

module.exports = Object.freeze({ createGoogleAuthorizationCodeRequest });

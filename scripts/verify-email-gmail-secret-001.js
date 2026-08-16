'use strict';
const assert = require('node:assert/strict');
const {
  SECRET_REF, SECRET_ENV, createSunsetGoogleOAuthClientSecretProvider,
} = require('./lib/sunset-google-oauth-provider');

const CODE = 'GOOGLE_OAUTH_CLIENT_SECRET_PROVIDER_INVALID';
const DUMMY_SECRET = 'dummy-secret-value-only-001';
function frozen(value) { return Object.freeze(value); }
function provider() {
  return createSunsetGoogleOAuthClientSecretProvider(frozen({
    deployment: 'sunset-staging', env: frozen({ [SECRET_ENV]: DUMMY_SECRET }),
  }));
}
function request() { return frozen({ secretRef: SECRET_REF }); }
function rejected(input, owner = provider()) {
  assert.throws(() => owner.resolveClientSecret(input), error => {
    assert.equal(error && error.name, 'GoogleOAuthClientSecretProviderError');
    assert.equal(error && error.code, CODE);
    assert.equal(error && error.message, 'Google OAuth client secret provider failed.');
    assert.equal(error && error.stack, undefined);
    assert(Object.isFrozen(error));
    assert(!JSON.stringify(error).includes(DUMMY_SECRET));
    return true;
  });
}

const owner = provider();
const result = owner.resolveClientSecret(request());
assert.deepEqual(Reflect.ownKeys(result), ['clientSecret']);
assert.equal(Object.getPrototypeOf(result), Object.prototype);
assert.deepEqual(Object.getOwnPropertyDescriptor(result, 'clientSecret'), {
  value: DUMMY_SECRET, writable: false, enumerable: true, configurable: false,
});
assert(Object.isFrozen(result));
rejected(request(), owner);
rejected(request(), owner);

rejected(SECRET_REF);
rejected(frozen({ secretRef: 'secret-ref:email/google/wrong' }));
rejected({ secretRef: SECRET_REF });
const accessor = {};
Object.defineProperty(accessor, 'secretRef', { get() { throw new Error('must not run'); }, enumerable: true });
rejected(frozen(accessor));
rejected(frozen({ secretRef: SECRET_REF, extra: true }));
rejected(frozen({ extra: true, secretRef: SECRET_REF }));
const symbol = Symbol('extra');
rejected(frozen({ secretRef: SECRET_REF, [symbol]: true }));
const custom = Object.create(null);
Object.defineProperty(custom, 'secretRef', { value: SECRET_REF, enumerable: true });
rejected(frozen(custom));

let traps = 0;
const hostile = new Proxy(frozen({ secretRef: SECRET_REF }), {
  ownKeys() { traps += 1; throw new Error('trap'); },
  getOwnPropertyDescriptor() { traps += 1; throw new Error('trap'); },
  getPrototypeOf() { traps += 1; throw new Error('trap'); },
  isExtensible() { traps += 1; throw new Error('trap'); },
});
rejected(hostile);
assert.equal(traps, 0, 'native Proxy rejection must precede reflection');
const revoked = Proxy.revocable({ secretRef: SECRET_REF }, {});
revoked.revoke();
rejected(revoked.proxy);

console.log('EMAIL-GMAIL-SECRET-001: PASS');

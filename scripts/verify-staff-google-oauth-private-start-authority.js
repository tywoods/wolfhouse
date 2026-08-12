'use strict';
const assert = require('node:assert/strict');

const publicCapability = require('./lib/staff-google-oauth-start-capability');
const production = require('./lib/staff-google-oauth-production-integration');
const routes = require('./lib/staff-email-google-oauth-routes');

function assertNoAuthoritySurface(value, label) {
  assert(value && typeof value === 'object', `${label} must be an object`);
  for (const key of Reflect.ownKeys(value)) {
    const member = Object.getOwnPropertyDescriptor(value, key)?.value;
    assert.notEqual(typeof member, 'function', `${label}.${String(key)} must not mint, issue, register, or consume start authority`);
    assert(!/mint|issu|capabil|authori|registr|consume/i.test(String(key)), `${label}.${String(key)} exposes an authority surface`);
  }
}

assertNoAuthoritySurface(publicCapability, 'public capability module');
assert.equal(publicCapability.mintStartCapability, undefined);
assert.equal(publicCapability.consumeStartCapability, undefined);
assert.equal(production.mintStartCapability, undefined);
assert.equal(routes.mintStartCapability, undefined);
assert.equal(routes.consumeStartCapability, undefined);

console.log('PASS Google OAuth start authority has no public mint/issuer/registry');

'use strict';

const assert = require('assert/strict');
const {
  PHASE_B_SCOPE_REJECTION_CATEGORIES,
  classifyAndNormalizePhaseBTokenResponseScope,
  validateAndNormalizePhaseBTokenResponseScope,
} = require('./lib/email-microsoft-phase-b-token-response-scope');

const VALID = 'openid profile offline_access User.Read Mail.ReadWrite Mail.Send';
const EXPECTED_CATEGORIES = Object.freeze([
  'invalid', 'duplicate', 'dangerous', 'phase_a_mixed', 'unknown', 'missing_required',
]);

function rejected(scope, category) {
  const result = classifyAndNormalizePhaseBTokenResponseScope(scope);
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(Reflect.ownKeys(result), ['value', 'rejectionCategory']);
  assert.equal(result.value, null);
  assert.equal(result.rejectionCategory, category);
  assert.equal(validateAndNormalizePhaseBTokenResponseScope(scope), null);
}

assert.equal(Object.isFrozen(PHASE_B_SCOPE_REJECTION_CATEGORIES), true);
assert.deepEqual(PHASE_B_SCOPE_REJECTION_CATEGORIES, EXPECTED_CATEGORIES);

for (const scope of [undefined, null, 7, {}, [], '', 'x'.repeat(513),
  `User.Read  Mail.ReadWrite Mail.Send`, ` User.Read Mail.ReadWrite Mail.Send`,
  `User.Read Mail.ReadWrite Mail.Send `]) rejected(scope, 'invalid');

for (const scope of [
  'User.Read User.Read Mail.ReadWrite Mail.Send',
  'Mail.Send User.Read Mail.ReadWrite Mail.Send',
]) rejected(scope, 'duplicate');
for (const scope of [
  'User.Read Mail.ReadWrite Mail.Send Mail.Read.Shared',
  'User.Read Mail.ReadWrite Mail.Send /.default',
  'User.Read Mail.ReadWrite Mail.Send graph/.default',
  'User.Read Mail.ReadWrite Mail.Send Application Role',
  'User.Read Mail.ReadWrite Mail.Send User.Read.All',
]) rejected(scope, 'dangerous');
for (const scope of [
  'User.Read Mail.ReadWrite Mail.Send Mail.ReadBasic',
  'Mail.Read User.Read Mail.ReadWrite Mail.Send',
]) rejected(scope, 'phase_a_mixed');
for (const scope of [
  'User.Read Mail.ReadWrite Mail.Send Calendars.Read',
  'user.read Mail.ReadWrite Mail.Send',
]) rejected(scope, 'unknown');
for (const scope of [
  'User.Read Mail.ReadWrite', 'Mail.Send User.Read', 'openid profile',
]) rejected(scope, 'missing_required');

// Existing first-failure order: malformed > duplicate > dangerous > Phase A > unknown > missing.
rejected('User.Read  User.Read Mail.ReadWrite Mail.Send User.Read.All Mail.ReadBasic Unknown', 'invalid');
rejected('User.Read User.Read Mail.ReadWrite Mail.Send User.Read.All Mail.ReadBasic Unknown', 'duplicate');
rejected('User.Read User.Read.All Mail.ReadBasic Unknown', 'dangerous');
rejected('User.Read Mail.ReadBasic Unknown', 'phase_a_mixed');
rejected('User.Read Unknown', 'unknown');

let getterCalls = 0;
const hostile = {};
Object.defineProperty(hostile, 'length', { get() { getterCalls += 1; throw new Error('SECRET'); } });
rejected(hostile, 'invalid');
assert.equal(getterCalls, 0);

for (const [raw, normalized] of [
  [VALID, VALID],
  ['Mail.Send openid User.Read Mail.ReadWrite profile offline_access', VALID],
  ['email User.Read Mail.Send Mail.ReadWrite openid', 'openid email User.Read Mail.ReadWrite Mail.Send'],
  ['User.Read Mail.ReadWrite Mail.Send', 'User.Read Mail.ReadWrite Mail.Send'],
]) {
  const result = classifyAndNormalizePhaseBTokenResponseScope(raw);
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(result, { value: normalized, rejectionCategory: null });
  assert.equal(validateAndNormalizePhaseBTokenResponseScope(raw), normalized);
}

assert.equal(validateAndNormalizePhaseBTokenResponseScope.length, 1);
console.log('PASS Phase B token scope closed-enum diagnostic classification');

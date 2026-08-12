'use strict';

const { types: utilTypes } = require('node:util');
const { createGoogleGmailProfileRequest } = require('./email-google-gmail-profile-request');
const { deriveGoogleMailboxAuthority } = require('./email-google-mailbox-authority-contract');

const ObjectFreeze = Object.freeze;
const ObjectIsFrozen = Object.isFrozen;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectCreate = Object.create;
const ObjectSetPrototypeOf = Object.setPrototypeOf;
const ObjectHasOwn = Object.hasOwn.bind(Object);
const ReflectOwnKeys = Reflect.ownKeys.bind(Reflect);
const ReflectApply = Reflect.apply.bind(Reflect);
const ArraySome = Array.prototype.some;
const PinnedIsProxy = utilTypes.isProxy.bind(utilTypes);
const ErrorConstructor = Error;
const PromiseReject = Promise.reject;
const PromiseConstructor = Promise;

const CONFIG_KEYS = ObjectFreeze(['expectedAudience', 'expectedNonce', 'requestTimeoutMs', 'responseBytesMax']);
const DEPENDENCY_KEYS = ObjectFreeze(['https', 'timers']);
const OPERATION_KEYS = ObjectFreeze(['accessToken', 'verifiedIdentity']);
const IDENTITY_KEYS = ObjectFreeze(['providerTenantId', 'providerPrincipalId', 'mailboxAddress', 'displayName']);
const PROFILE_KEYS = ObjectFreeze(['emailAddress', 'historyId']);
const SERVICE_KEYS = ObjectFreeze(['getProfile']);
const CANONICAL_ISSUER = 'https://accounts.google.com';
const FAILURE_CODE = 'GOOGLE_MAILBOX_AUTHORITY_COMPOSITION_FAILED';
const FAILURE_PROTOTYPE = ObjectCreate(Error.prototype);
Object.defineProperty(FAILURE_PROTOTYPE, 'name', { value: 'GoogleMailboxAuthorityCompositionError' });
ObjectFreeze(FAILURE_PROTOTYPE);

function failure() {
  const error = new ErrorConstructor('Google mailbox authority composition failed.');
  ObjectSetPrototypeOf(error, FAILURE_PROTOTYPE);
  Object.defineProperty(error, 'code', { value: FAILURE_CODE, enumerable: true });
  return ObjectFreeze(error);
}
function proxy(value) { try { return PinnedIsProxy(value); } catch { return true; } }
function exactFrozenRecord(value, keys) {
  try {
    if (!value || proxy(value) || ObjectGetPrototypeOf(value) !== Object.prototype || !ObjectIsFrozen(value)) return null;
    const actual = ReflectOwnKeys(value);
    if (actual.length !== keys.length || ReflectApply(ArraySome, actual, [(key, index) => key !== keys[index]])) return null;
    const record = ObjectCreate(null);
    for (const key of keys) {
      const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
      if (!descriptor || !ObjectHasOwn(descriptor, 'value') || !descriptor.enumerable || descriptor.writable || descriptor.configurable) return null;
      record[key] = descriptor.value;
    }
    return record;
  } catch { return null; }
}
function boundedAscii(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max && /^[\x21-\x7e]+$/.test(value); }
function email(value) { return boundedAscii(value, 320) && /^[^@]+@[^@]+$/.test(value); }
function readConfig(value) {
  const record = exactFrozenRecord(value, CONFIG_KEYS);
  if (!record || !boundedAscii(record.expectedAudience, 2048) || !boundedAscii(record.expectedNonce, 2048)
      || record.requestTimeoutMs !== 5000 || record.responseBytesMax !== 16384) throw failure();
  return ObjectFreeze({ expectedAudience: record.expectedAudience, expectedNonce: record.expectedNonce,
    requestTimeoutMs: 5000, responseBytesMax: 16384 });
}
function readIdentity(value) {
  const record = exactFrozenRecord(value, IDENTITY_KEYS);
  if (!record || record.providerTenantId !== CANONICAL_ISSUER || !boundedAscii(record.providerPrincipalId, 255)
      || !email(record.mailboxAddress) || typeof record.displayName !== 'string' || record.displayName.length > 256) throw failure();
  return ObjectFreeze({ providerTenantId: record.providerTenantId, providerPrincipalId: record.providerPrincipalId,
    mailboxAddress: record.mailboxAddress, displayName: record.displayName });
}

function createGoogleMailboxAuthorityComposition(configuration, dependencies) {
  const config = readConfig(configuration);
  if (!exactFrozenRecord(dependencies, DEPENDENCY_KEYS)) throw failure();
  let profileOwner;
  try {
    profileOwner = createGoogleGmailProfileRequest(ObjectFreeze({ requestTimeoutMs: config.requestTimeoutMs,
      responseBytesMax: config.responseBytesMax }), dependencies);
    if (!exactFrozenRecord(profileOwner, SERVICE_KEYS)) throw failure();
  } catch { throw failure(); }
  const getProfile = ObjectGetOwnPropertyDescriptor(profileOwner, 'getProfile').value;

  async function deriveAuthority(input) {
    try {
      const operation = exactFrozenRecord(input, OPERATION_KEYS);
      if (!operation) throw failure();
      const identity = readIdentity(operation.verifiedIdentity);
      const profile = await ReflectApply(getProfile, profileOwner, [ObjectFreeze({ accessToken: operation.accessToken })]);
      const profileSnapshot = exactFrozenRecord(profile, PROFILE_KEYS);
      if (!profileSnapshot) throw failure();
      const contract = deriveGoogleMailboxAuthority(ObjectFreeze({
        expected_audience: config.expectedAudience,
        expected_nonce: config.expectedNonce,
        oidc_claims: ObjectFreeze({ iss: identity.providerTenantId, aud: config.expectedAudience,
          sub: identity.providerPrincipalId, nonce: config.expectedNonce, email: identity.mailboxAddress,
          email_verified: true }),
        gmail_profile: ObjectFreeze({ emailAddress: profileSnapshot.emailAddress, historyId: profileSnapshot.historyId }),
      }));
      if (!contract || contract.ok !== true || !contract.value || profileSnapshot.emailAddress !== identity.mailboxAddress) throw failure();
      const authority = ObjectFreeze({ ...contract.value, binding_status: 'verified_profile_match',
        cryptographically_verified: true, activation_enabled: false });
      const evidence = ObjectFreeze({ provider: 'gmail_api', profile_email_address: profileSnapshot.emailAddress,
        gmail_history_id: profileSnapshot.historyId, evidence_role: 'profile_match_and_sync_cursor_not_authorization' });
      return ObjectFreeze({ authority, evidence });
    } catch { throw failure(); }
  }
  return ObjectFreeze({ deriveAuthority });
}

module.exports = ObjectFreeze({ createGoogleMailboxAuthorityComposition });

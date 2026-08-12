'use strict';
/** Pure offline Google OIDC + Gmail getProfile authority-shape contract (G2b). */
const { types: utilTypes } = require('node:util');
const ObjectConstructor = Object;
const ObjectPrototype = Object.prototype;
const freeze = Object.freeze.bind(Object);
const getPrototypeOf = Object.getPrototypeOf.bind(Object);
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor.bind(Object);
const create = Object.create.bind(Object);
const ownKeys = Reflect.ownKeys.bind(Reflect);
const reflectApply = Reflect.apply.bind(Reflect);
const isProxy = utilTypes.isProxy.bind(utilTypes);
const hasOwnProperty = Object.prototype.hasOwnProperty;
const stringTrim = String.prototype.trim;
const stringLower = String.prototype.toLowerCase;
const regexpTest = RegExp.prototype.test;
const ASCII_RE = /^[\x21-\x7e]+$/;
const EMAIL_RE = /^[^@]+@[^@]+$/;
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HISTORY_RE = /^(?:0|[1-9][0-9]*)$/;
const GOOGLE_CANONICAL_ISSUER = 'https://accounts.google.com';
const ROOT_KEYS = freeze(['expected_audience', 'expected_nonce', 'oidc_claims', 'gmail_profile']);
const CLAIM_REQUIRED_KEYS = freeze(['iss', 'aud', 'sub', 'nonce', 'email', 'email_verified']);
const PROFILE_KEYS = freeze(['emailAddress', 'historyId']);
const apply = (fn, receiver, args) => reflectApply(fn, receiver, args);
const contains = (array, value) => { for (let i = 0; i < array.length; i += 1) if (array[i] === value) return true; return false; };
function failure(reason) { return freeze({ ok: false, error: 'google_mailbox_authority_invalid', reason }); }
function snapshotRecord(raw, required, optional = []) {
  if (raw === null || typeof raw !== 'object' || isProxy(raw)) return null;
  let proto; let keys;
  try { proto = getPrototypeOf(raw); keys = ownKeys(raw); } catch { return null; }
  if (proto !== ObjectPrototype) return null;
  for (let i = 0; i < keys.length; i += 1) if (typeof keys[i] !== 'string') return null;
  if (keys.length < required.length || keys.length > required.length + optional.length) return null;
  for (let i = 0; i < keys.length; i += 1) if (!contains(required, keys[i]) && !contains(optional, keys[i])) return null;
  for (let i = 0; i < required.length; i += 1) if (!contains(keys, required[i])) return null;
  const out = create(null);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]; let descriptor;
    try { descriptor = getOwnPropertyDescriptor(raw, key); } catch { return null; }
    if (!descriptor || !descriptor.enumerable || !apply(hasOwnProperty, descriptor, ['value'])) return null;
    out[key] = descriptor.value;
  }
  return out;
}
const nonemptyExact = value => typeof value === 'string' && value.length > 0 && value === apply(stringTrim, value, []) && value.length <= 2048;
const matches = (regex, value) => typeof value === 'string' && apply(regexpTest, regex, [value]);
const ascii = value => matches(ASCII_RE, value);
const emailShape = value => nonemptyExact(value) && ascii(value) && value.length <= 320 && matches(EMAIL_RE, value);
const hostedDomainShape = value => typeof value === 'string' && value.length <= 253
  && value === apply(stringLower, value, []) && matches(DOMAIN_RE, value);
function deriveGoogleMailboxAuthority(input) {
  try {
    const root = snapshotRecord(input, ROOT_KEYS); if (!root) return failure('input_shape');
    if (!nonemptyExact(root.expected_audience) || !ascii(root.expected_audience)) return failure('expected_audience');
    if (!nonemptyExact(root.expected_nonce) || !ascii(root.expected_nonce)) return failure('expected_nonce');
    const claims = snapshotRecord(root.oidc_claims, CLAIM_REQUIRED_KEYS, ['hd']); if (!claims) return failure('oidc_claims_shape');
    const profile = snapshotRecord(root.gmail_profile, PROFILE_KEYS); if (!profile) return failure('gmail_profile_shape');
    if (claims.iss !== GOOGLE_CANONICAL_ISSUER) return failure('issuer');
    if (claims.aud !== root.expected_audience) return failure('audience');
    if (claims.nonce !== root.expected_nonce) return failure('nonce');
    if (typeof claims.sub !== 'string' || claims.sub.length < 1 || claims.sub.length > 255 || !ascii(claims.sub)) return failure('sub');
    if (claims.email_verified !== true || !emailShape(claims.email)) return failure('oidc_email');
    if (!emailShape(profile.emailAddress) || profile.emailAddress !== claims.email) return failure('profile_email');
    if (!matches(HISTORY_RE, profile.historyId)) return failure('history_id');
    const hasHostedDomain = apply(hasOwnProperty, claims, ['hd']); const hd = hasHostedDomain ? claims.hd : null;
    if (hasHostedDomain && !hostedDomainShape(hd)) return failure('hosted_domain');
    const value = freeze({ provider: 'gmail_api', auth_mode: 'delegated_authorization_code', connector_mode: 'google_delegated_oauth',
      provider_tenant_id: GOOGLE_CANONICAL_ISSUER, provider_resource_id: claims.sub, public_address: claims.email, hosted_domain: hd,
      hosted_domain_role: 'optional_workspace_metadata_not_tenant_ownership', durable_identity_source: 'oidc_sub',
      public_address_role: 'mutable_routing_metadata_not_identity', gmail_history_id_role: 'sync_cursor_not_identity',
      binding_status: 'unverified_offline', cryptographically_verified: false, activation_enabled: false });
    return freeze({ ok: true, value });
  } catch { return failure('reflection_failed'); }
}
module.exports = freeze({ GOOGLE_CANONICAL_ISSUER, deriveGoogleMailboxAuthority });

'use strict';
/**
 * Pure offline Google OIDC + Gmail getProfile authority-shape contract (G2b).
 * This module compares already supplied data only. It does not verify signatures,
 * call Google, activate a connector, persist a binding, or confer mailbox access.
 */
const { types: utilTypes } = require('node:util');

const isProxy = utilTypes.isProxy.bind(utilTypes);
const freeze = Object.freeze.bind(Object);
const GOOGLE_CANONICAL_ISSUER = 'https://accounts.google.com';
const ROOT_KEYS = freeze(['expected_audience', 'expected_nonce', 'oidc_claims', 'gmail_profile']);
const CLAIM_REQUIRED_KEYS = freeze(['iss', 'aud', 'sub', 'nonce', 'email', 'email_verified']);
const PROFILE_KEYS = freeze(['emailAddress', 'historyId']);

function failure(reason) {
  return freeze({ ok: false, error: 'google_mailbox_authority_invalid', reason });
}

function snapshotRecord(raw, required, optional = []) {
  if (raw === null || typeof raw !== 'object' || isProxy(raw)) return null;
  let proto;
  let keys;
  try {
    proto = Object.getPrototypeOf(raw);
    keys = Reflect.ownKeys(raw);
  } catch { return null; }
  if (proto !== Object.prototype || keys.some(key => typeof key !== 'string')) return null;
  const allowed = new Set([...required, ...optional]);
  if (keys.length < required.length || keys.length > required.length + optional.length
    || keys.some(key => !allowed.has(key)) || required.some(key => !keys.includes(key))) return null;
  const out = Object.create(null);
  for (const key of keys) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(raw, key); } catch { return null; }
    if (!descriptor || !descriptor.enumerable
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
    out[key] = descriptor.value;
  }
  return out;
}

const nonemptyExact = value => typeof value === 'string' && value.length > 0
  && value === value.trim() && value.length <= 2048;
const ascii = value => typeof value === 'string' && /^[\x21-\x7e]+$/.test(value);
const emailShape = value => nonemptyExact(value) && ascii(value) && value.length <= 320
  && /^[^@]+@[^@]+$/.test(value);
const hostedDomainShape = value => typeof value === 'string' && value.length <= 253
  && value === value.toLowerCase() && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);

function deriveGoogleMailboxAuthority(input) {
  try {
    const root = snapshotRecord(input, ROOT_KEYS);
    if (!root) return failure('input_shape');
    if (!nonemptyExact(root.expected_audience) || !ascii(root.expected_audience)) return failure('expected_audience');
    if (!nonemptyExact(root.expected_nonce) || !ascii(root.expected_nonce)) return failure('expected_nonce');

    const claims = snapshotRecord(root.oidc_claims, CLAIM_REQUIRED_KEYS, ['hd']);
    if (!claims) return failure('oidc_claims_shape');
    const profile = snapshotRecord(root.gmail_profile, PROFILE_KEYS);
    if (!profile) return failure('gmail_profile_shape');
    if (claims.iss !== GOOGLE_CANONICAL_ISSUER) return failure('issuer');
    if (claims.aud !== root.expected_audience) return failure('audience');
    if (claims.nonce !== root.expected_nonce) return failure('nonce');
    if (typeof claims.sub !== 'string' || claims.sub.length < 1 || claims.sub.length > 255
      || !/^[\x21-\x7e]+$/.test(claims.sub)) return failure('sub');
    if (claims.email_verified !== true || !emailShape(claims.email)) return failure('oidc_email');
    if (!emailShape(profile.emailAddress) || profile.emailAddress !== claims.email) return failure('profile_email');
    if (typeof profile.historyId !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(profile.historyId)) return failure('history_id');
    const hasHostedDomain = Object.prototype.hasOwnProperty.call(claims, 'hd');
    const hd = hasHostedDomain ? claims.hd : null;
    if (hasHostedDomain && !hostedDomainShape(hd)) return failure('hosted_domain');

    const value = freeze({
      provider: 'gmail_api',
      auth_mode: 'delegated_authorization_code',
      connector_mode: 'google_delegated_oauth',
      provider_tenant_id: GOOGLE_CANONICAL_ISSUER,
      provider_resource_id: claims.sub,
      public_address: claims.email,
      hosted_domain: hd,
      hosted_domain_role: 'optional_workspace_metadata_not_tenant_ownership',
      durable_identity_source: 'oidc_sub',
      public_address_role: 'mutable_routing_metadata_not_identity',
      gmail_history_id_role: 'sync_cursor_not_identity',
      binding_status: 'unverified_offline',
      cryptographically_verified: false,
      activation_enabled: false,
    });
    return freeze({ ok: true, value });
  } catch {
    return failure('reflection_failed');
  }
}

module.exports = freeze({ GOOGLE_CANONICAL_ISSUER, deriveGoogleMailboxAuthority });

'use strict';
/**
 * Pure Google delegated OAuth + Gmail mailbox-authority declaration contract.
 *
 * Offline only: no Google SDK, network, DB, environment, routes, token exchange,
 * mailbox access, draft creation, or send capability. Runtime activation remains
 * a later, separately reviewed stage.
 */
const { types: utilTypes } = require('node:util');
const { validateEmailMailboxSecretRef } = require('./email-mailbox-adapter-contract');

const isProxy = utilTypes.isProxy.bind(utilTypes);
const ownKeys = Reflect.ownKeys.bind(Reflect);
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor.bind(Object);
const getPrototypeOf = Object.getPrototypeOf.bind(Object);
const freeze = Object.freeze.bind(Object);

const GOOGLE_EMAIL_PROVIDER = 'gmail_api';
const GOOGLE_EMAIL_AUTH_MODE = 'delegated_authorization_code';
const GOOGLE_EMAIL_CONNECTOR_MODE = 'google_delegated_oauth';
const GOOGLE_EMAIL_OIDC_SCOPES = freeze(['openid', 'email']);
const GOOGLE_EMAIL_GMAIL_SCOPES = freeze([
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
]);

const INPUT_KEYS = freeze([
  'provider', 'auth_mode', 'connector_mode', 'oauth_client_type', 'pkce_method',
  'authorization_origin', 'token_origin', 'redirect_id', 'oidc_scopes', 'gmail_scopes',
  'access_type', 'include_granted_scopes', 'server_owned_state', 'server_owned_nonce',
  'mailbox_binding_status', 'secret_ref', 'network_enabled', 'inbound_enabled',
  'outbound_enabled', 'automation_mode', 'staff_approval_required', 'luna_send_capability',
]);

function fail(reason) {
  return freeze({ ok: false, error: 'google_delegated_oauth_declaration_invalid', reason });
}
function exactDataRecord(input) {
  if (input == null || typeof input !== 'object' || isProxy(input)) return null;
  if (getPrototypeOf(input) !== Object.prototype) return null;
  let keys;
  try { keys = ownKeys(input); } catch { return null; }
  if (keys.length !== INPUT_KEYS.length || keys.some((key, i) => key !== INPUT_KEYS[i])) return null;
  const values = {};
  for (const key of INPUT_KEYS) {
    let descriptor;
    try { descriptor = getOwnPropertyDescriptor(input, key); } catch { return null; }
    if (!descriptor || !descriptor.enumerable || !descriptor.configurable || !descriptor.writable
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
    values[key] = descriptor.value;
  }
  return values;
}
function exactStringArray(value, expected) {
  if (!Array.isArray(value) || isProxy(value) || getPrototypeOf(value) !== Array.prototype) return false;
  let keys;
  try { keys = ownKeys(value); } catch { return false; }
  if (keys.length !== expected.length + 1 || keys[keys.length - 1] !== 'length') return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (keys[i] !== String(i)) return false;
    const descriptor = getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || !descriptor.enumerable || descriptor.value !== expected[i]) return false;
  }
  return true;
}

function validateGoogleDelegatedOAuthDeclaration(input) {
  let v;
  try { v = exactDataRecord(input); } catch { v = null; }
  if (!v) return fail('input_shape');

  const exact = [
    ['provider', GOOGLE_EMAIL_PROVIDER],
    ['auth_mode', GOOGLE_EMAIL_AUTH_MODE],
    ['connector_mode', GOOGLE_EMAIL_CONNECTOR_MODE],
    ['oauth_client_type', 'confidential_web'],
    ['pkce_method', 'S256'],
    ['authorization_origin', 'https://accounts.google.com'],
    ['token_origin', 'https://oauth2.googleapis.com'],
    ['redirect_id', 'gmail_oauth_callback_v1'],
    ['access_type', 'offline'],
    ['include_granted_scopes', false],
    ['server_owned_state', true],
    ['server_owned_nonce', true],
    ['mailbox_binding_status', 'unverified_offline'],
    ['network_enabled', false],
    ['inbound_enabled', false],
    ['outbound_enabled', false],
    ['automation_mode', 'off'],
    ['staff_approval_required', true],
    ['luna_send_capability', false],
  ];
  for (const [key, expected] of exact) {
    if (v[key] !== expected) return fail(key);
  }
  if (!exactStringArray(v.oidc_scopes, GOOGLE_EMAIL_OIDC_SCOPES)) return fail('oidc_scopes');
  if (!exactStringArray(v.gmail_scopes, GOOGLE_EMAIL_GMAIL_SCOPES)) return fail('gmail_scopes');

  let secretRefResult;
  try { secretRefResult = validateEmailMailboxSecretRef(v.secret_ref); } catch { return fail('secret_ref'); }
  if (!secretRefResult || secretRefResult.ok !== true) return fail('secret_ref');

  const value = freeze({
    provider: GOOGLE_EMAIL_PROVIDER,
    auth_mode: GOOGLE_EMAIL_AUTH_MODE,
    connector_mode: GOOGLE_EMAIL_CONNECTOR_MODE,
    oauth_client_type: 'confidential_web',
    pkce_method: 'S256',
    authorization_origin: 'https://accounts.google.com',
    token_origin: 'https://oauth2.googleapis.com',
    redirect_id: 'gmail_oauth_callback_v1',
    oidc_scopes: GOOGLE_EMAIL_OIDC_SCOPES,
    gmail_scopes: GOOGLE_EMAIL_GMAIL_SCOPES,
    access_type: 'offline',
    include_granted_scopes: false,
    server_owned_state: true,
    server_owned_nonce: true,
    mailbox_binding_status: 'unverified_offline',
    secret_ref_present: true,
    network_enabled: false,
    inbound_enabled: false,
    outbound_enabled: false,
    automation_mode: 'off',
    staff_approval_required: true,
    luna_send_capability: false,
    ready_for_live_oauth: false,
  });
  return freeze({ ok: true, value });
}

module.exports = freeze({
  GOOGLE_EMAIL_PROVIDER,
  GOOGLE_EMAIL_AUTH_MODE,
  GOOGLE_EMAIL_CONNECTOR_MODE,
  GOOGLE_EMAIL_OIDC_SCOPES,
  GOOGLE_EMAIL_GMAIL_SCOPES,
  validateGoogleDelegatedOAuthDeclaration,
});

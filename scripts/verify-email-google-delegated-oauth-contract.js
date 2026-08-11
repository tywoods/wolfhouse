'use strict';
/**
 * Stage 5 / G1 RED — pure Google delegated OAuth + Gmail mailbox authority contract.
 * No network, DB, SDK, credentials, routes, runtime wiring, activation, drafts, or sends.
 */
const assert = require('node:assert/strict');

const {
  GOOGLE_EMAIL_PROVIDER,
  GOOGLE_EMAIL_AUTH_MODE,
  GOOGLE_EMAIL_CONNECTOR_MODE,
  GOOGLE_EMAIL_OIDC_SCOPES,
  GOOGLE_EMAIL_GMAIL_SCOPES,
  validateGoogleDelegatedOAuthDeclaration,
} = require('./lib/email-google-delegated-oauth-contract');

const VALID = Object.freeze({
  provider: 'gmail_api',
  auth_mode: 'delegated_authorization_code',
  connector_mode: 'google_delegated_oauth',
  oauth_client_type: 'confidential_web',
  pkce_method: 'S256',
  authorization_origin: 'https://accounts.google.com',
  token_origin: 'https://oauth2.googleapis.com',
  redirect_id: 'gmail_oauth_callback_v1',
  oidc_scopes: Object.freeze(['openid', 'email']),
  gmail_scopes: Object.freeze([
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
  ]),
  access_type: 'offline',
  include_granted_scopes: false,
  server_owned_state: true,
  server_owned_nonce: true,
  mailbox_binding_status: 'unverified_offline',
  secret_ref: 'kv:email/google/oauth-client',
  network_enabled: false,
  inbound_enabled: false,
  outbound_enabled: false,
  automation_mode: 'off',
  staff_approval_required: true,
  luna_send_capability: false,
});

function clone(overrides = {}) {
  return { ...VALID, oidc_scopes: [...VALID.oidc_scopes], gmail_scopes: [...VALID.gmail_scopes], ...overrides };
}
function expectReject(value, reason) {
  const result = validateGoogleDelegatedOAuthDeclaration(value);
  assert.equal(result.ok, false, reason);
  assert.equal(Object.isFrozen(result), true, `${reason}: result frozen`);
  assert.equal(JSON.stringify(result).includes('secret_ref'), false, `${reason}: secret ref not exposed`);
}

assert.equal(GOOGLE_EMAIL_PROVIDER, 'gmail_api');
assert.equal(GOOGLE_EMAIL_AUTH_MODE, 'delegated_authorization_code');
assert.equal(GOOGLE_EMAIL_CONNECTOR_MODE, 'google_delegated_oauth');
assert.deepEqual(GOOGLE_EMAIL_OIDC_SCOPES, ['openid', 'email']);
assert.deepEqual(GOOGLE_EMAIL_GMAIL_SCOPES, [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
]);
assert.equal(Object.isFrozen(GOOGLE_EMAIL_OIDC_SCOPES), true);
assert.equal(Object.isFrozen(GOOGLE_EMAIL_GMAIL_SCOPES), true);

const accepted = validateGoogleDelegatedOAuthDeclaration(clone());
assert.equal(accepted.ok, true);
assert.equal(Object.isFrozen(accepted), true);
assert.equal(Object.isFrozen(accepted.value), true);
assert.deepEqual(Object.keys(accepted.value), [
  'provider', 'auth_mode', 'connector_mode', 'oauth_client_type', 'pkce_method',
  'authorization_origin', 'token_origin', 'redirect_id', 'oidc_scopes', 'gmail_scopes',
  'access_type', 'include_granted_scopes', 'server_owned_state', 'server_owned_nonce',
  'mailbox_binding_status', 'secret_ref_present', 'network_enabled', 'inbound_enabled',
  'outbound_enabled', 'automation_mode', 'staff_approval_required', 'luna_send_capability',
  'ready_for_live_oauth',
]);
assert.equal(accepted.value.secret_ref_present, true);
assert.equal(accepted.value.ready_for_live_oauth, false);
assert.equal(JSON.stringify(accepted).includes(VALID.secret_ref), false);

for (const [name, value] of [
  ['provider authority', { provider: 'microsoft_graph' }],
  ['auth mode', { auth_mode: 'application_client_credentials' }],
  ['connector mode', { connector_mode: 'microsoft_delegated_oauth' }],
  ['public client forbidden', { oauth_client_type: 'public_native' }],
  ['PKCE required', { pkce_method: 'plain' }],
  ['authorization origin pinned', { authorization_origin: 'https://evil.example' }],
  ['token origin pinned', { token_origin: 'https://evil.example' }],
  ['redirect identity pinned', { redirect_id: 'caller_url' }],
  ['incremental scopes forbidden', { include_granted_scopes: true }],
  ['state server-owned', { server_owned_state: false }],
  ['nonce server-owned', { server_owned_nonce: false }],
  ['mailbox cannot be preverified', { mailbox_binding_status: 'verified' }],
  ['network default off', { network_enabled: true }],
  ['inbound default off', { inbound_enabled: true }],
  ['outbound default off', { outbound_enabled: true }],
  ['automation default off', { automation_mode: 'draft_only' }],
  ['staff approval mandatory', { staff_approval_required: false }],
  ['Luna cannot send', { luna_send_capability: true }],
  ['raw Google token rejected', { secret_ref: 'ya29.raw-google-access-token' }],
  ['scope escalation rejected', { gmail_scopes: [...VALID.gmail_scopes, 'https://mail.google.com/'] }],
]) expectReject(clone(value), name);

expectReject({ ...clone(), extra: true }, 'extra key');
expectReject(Object.assign(Object.create({ provider: 'gmail_api' }), clone()), 'custom prototype');
expectReject(new Proxy(clone(), { ownKeys() { throw new Error('trap'); } }), 'proxy');
const accessor = clone();
Object.defineProperty(accessor, 'provider', { enumerable: true, get() { throw new Error('trap'); } });
expectReject(accessor, 'accessor');

const source = require('node:fs').readFileSync(require.resolve('./lib/email-google-delegated-oauth-contract'), 'utf8');
for (const forbidden of ['googleapis', 'fetch(', 'https.request', 'nodemailer', 'imapflow', 'process.env', 'staff-query-api']) {
  assert.equal(source.includes(forbidden), false, `forbidden runtime capability: ${forbidden}`);
}

console.log('PASS verify:email-google-delegated-oauth-contract');

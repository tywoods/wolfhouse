'use strict';
/** G2b RED: pure offline Google mailbox authority / identity-shape contract. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  GOOGLE_CANONICAL_ISSUER,
  deriveGoogleMailboxAuthority,
} = require('./lib/email-google-mailbox-authority-contract');

const base = () => ({
  expected_audience: 'luna-google-client-id.apps.googleusercontent.com',
  expected_nonce: 'server-owned-nonce-0123456789',
  oidc_claims: {
    iss: 'https://accounts.google.com',
    aud: 'luna-google-client-id.apps.googleusercontent.com',
    sub: '109876543210987654321',
    nonce: 'server-owned-nonce-0123456789',
    email: 'Support.Example@gmail.com',
    email_verified: true,
    hd: null,
  },
  gmail_profile: { emailAddress: 'Support.Example@gmail.com', historyId: '987654321' },
});
const reject = (input, label) => {
  const r = deriveGoogleMailboxAuthority(input);
  assert.equal(r.ok, false, label);
  assert.equal(Object.isFrozen(r), true, `${label}: frozen`);
  assert.deepEqual(Object.keys(r), ['ok', 'error', 'reason']);
};

assert.equal(GOOGLE_CANONICAL_ISSUER, 'https://accounts.google.com');
const result = deriveGoogleMailboxAuthority(base());
assert.equal(result.ok, true);
assert.equal(Object.isFrozen(result), true);
assert.equal(Object.isFrozen(result.value), true);
assert.deepEqual(result.value, {
  provider: 'gmail_api',
  auth_mode: 'delegated_authorization_code',
  connector_mode: 'google_delegated_oauth',
  provider_tenant_id: 'https://accounts.google.com',
  provider_resource_id: '109876543210987654321',
  public_address: 'Support.Example@gmail.com',
  hosted_domain: null,
  hosted_domain_role: 'optional_workspace_metadata_not_tenant_ownership',
  durable_identity_source: 'oidc_sub',
  public_address_role: 'mutable_routing_metadata_not_identity',
  gmail_history_id_role: 'sync_cursor_not_identity',
  binding_status: 'unverified_offline',
  cryptographically_verified: false,
  activation_enabled: false,
});
assert.equal(JSON.stringify(result).includes('server-owned-nonce'), false);
assert.equal(JSON.stringify(result).includes('apps.googleusercontent.com'), false);

const workspace = base(); workspace.oidc_claims.hd = 'example.com';
assert.equal(deriveGoogleMailboxAuthority(workspace).value.hosted_domain, 'example.com');
for (const [label, mutate] of [
  ['issuer alias', x => { x.oidc_claims.iss = 'accounts.google.com'; }],
  ['aud mismatch', x => { x.oidc_claims.aud = 'other-client'; }],
  ['nonce mismatch', x => { x.oidc_claims.nonce = 'other-nonce'; }],
  ['missing expected audience', x => { x.expected_audience = ''; }],
  ['missing expected nonce', x => { x.expected_nonce = ''; }],
  ['email unverified', x => { x.oidc_claims.email_verified = false; }],
  ['profile mismatch', x => { x.gmail_profile.emailAddress = 'support.example@gmail.com'; }],
  ['sub empty', x => { x.oidc_claims.sub = ''; }],
  ['sub too long', x => { x.oidc_claims.sub = 'a'.repeat(256); }],
  ['sub non-ascii', x => { x.oidc_claims.sub = 'abcé'; }],
  ['history cursor malformed', x => { x.gmail_profile.historyId = '1e3'; }],
  ['hd empty', x => { x.oidc_claims.hd = ''; }],
  ['extra claim', x => { x.oidc_claims.name = 'PII'; }],
  ['extra profile field', x => { x.gmail_profile.messagesTotal = 1; }],
]) { const x = base(); mutate(x); reject(x, label); }

reject({ ...base(), extra: true }, 'extra root key');
reject(new Proxy(base(), {}), 'root proxy');
const nestedProxy = base(); nestedProxy.oidc_claims = new Proxy(nestedProxy.oidc_claims, {}); reject(nestedProxy, 'nested proxy');
const accessor = base(); Object.defineProperty(accessor.oidc_claims, 'sub', { enumerable: true, get() { throw Error('leak'); } }); reject(accessor, 'accessor');
const symbol = base(); symbol.gmail_profile[Symbol('x')] = true; reject(symbol, 'symbol');

const source = fs.readFileSync(require.resolve('./lib/email-google-mailbox-authority-contract'), 'utf8');
for (const pattern of [/\bfetch\s*\(/, /\bhttps\.(?:get|request)\s*\(/, /\bprocess\.env\b/, /googleapis/, /\bcrypto\b/]) {
  assert.equal(pattern.test(source), false, `offline/no crypto implementation: ${pattern}`);
}
console.log('PASS verify:email-google-mailbox-authority-contract');

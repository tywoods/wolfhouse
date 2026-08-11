'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const MIG = path.join(ROOT, 'database/migrations');
const UP = '073_tenant_channel_endpoint_google_identity.sql';
const DOWN = '073_tenant_channel_endpoint_google_identity_down.sql';
const {
  validateEmailChannelEndpointIdentityModePair: pair,
  validateEmailChannelEndpointBindingIdentity: bind,
} = require('./lib/email-channel-endpoint-identity-contract');
const { loadManifest, sha256CanonicalLfV1File } = require('./lib/migration-integrity');
const ISSUER = 'https://accounts.google.com';
const SUB = 'Google-Sub_123:CaseSensitive';
const gmail = (extra = {}) => ({
  provider: 'gmail_api', auth_mode: 'delegated_authorization_code',
  connector_mode: 'google_delegated_oauth', provider_tenant_id: ISSUER,
  provider_principal_oid: SUB, provider_resource_id: SUB, mailbox_kind: 'user',
  mailbox_access_kind: 'own_user', binding_status: 'verified', ...extra,
});
assert.equal(pair({ provider: 'gmail_api', auth_mode: 'delegated_authorization_code', connector_mode: 'google_delegated_oauth' }).ok, true);
const gmailNullPair = pair({ provider: 'gmail_api', auth_mode: null, connector_mode: null });
assert.equal(gmailNullPair.ok, true);
assert.equal(gmailNullPair.value.provider, 'gmail_api');
const good = bind(gmail());
assert.equal(good.ok, true);
assert.equal(good.value.principal_is_mailbox_identity, true);
assert.ok(Object.isFrozen(good) && Object.isFrozen(good.value) && Object.isFrozen(good.value.ownership));
for (const bad of [
  { provider_tenant_id: 'https://accounts.google.com/' },
  { provider_tenant_id: 'HTTPS://accounts.google.com' },
  { provider_principal_oid: 'other' },
  { provider_resource_id: 'other' },
  { provider_principal_oid: '' }, { provider_principal_oid: ' x ' },
  { provider_principal_oid: 'é' }, { provider_principal_oid: 'x'.repeat(256) },
  { mailbox_kind: 'shared' }, { mailbox_access_kind: 'application' },
]) assert.equal(bind(gmail(bad)).ok, false, JSON.stringify(bad));
assert.equal(bind(gmail({ provider_principal_oid: 'x y', provider_resource_id: 'x y' })).ok, false);
assert.equal(bind(gmail({ binding_status: 'pending_manual_validation', provider_principal_oid: null })).ok, false);
assert.equal(bind(gmail({ binding_status: 'pending_manual_validation', provider_resource_id: null })).ok, false);
assert.equal(bind(gmail({ binding_status: 'reauthorization_required' })).ok, true);
assert.equal(bind(gmail({ auth_mode: null, connector_mode: null })).ok, false);
assert.equal(bind({ provider: 'gmail_api' }).ok, true);
const hostile = gmail(); hostile[Symbol('x')] = 1; assert.equal(bind(hostile).ok, false);
const accessor = gmail(); Object.defineProperty(accessor, 'provider_tenant_id', { enumerable: true, get() { throw new Error('no'); } });
assert.equal(bind(accessor).ok, false);
const ms = bind({ provider: 'microsoft_graph', auth_mode: 'delegated_authorization_code', connector_mode: 'microsoft_delegated_oauth', provider_tenant_id: '11111111-1111-1111-1111-111111111111', provider_principal_oid: '22222222-2222-2222-2222-222222222222', provider_resource_id: 'AAMk', mailbox_kind: 'user', mailbox_access_kind: 'own_user', binding_status: 'verified' });
assert.equal(ms.ok, true); assert.equal(ms.value.principal_is_mailbox_identity, false);
const upPath = path.join(MIG, UP); const downPath = path.join(MIG, DOWN);
assert.ok(fs.existsSync(upPath) && fs.existsSync(downPath));
const up = fs.readFileSync(upPath, 'utf8'); const down = fs.readFileSync(downPath, 'utf8');
assert.match(up, /https:\/\/accounts\.google\.com/);
assert.match(up, /google_delegated_oauth/);
assert.match(up, /COLLATE "C"/);
assert.match(up, /provider_principal_oid\s+COLLATE "C"\s*=\s*provider_resource_id\s+COLLATE "C"/);
assert.doesNotMatch(up.replace(/--[^\n]*/g, ''), /\b(INSERT|UPDATE|DELETE)\b/i);
assert.match(down, /RAISE EXCEPTION/);
assert.match(down, /gmail_api/);
assert.doesNotMatch(down, /DELETE|UPDATE\s+tenant_channel_endpoints/i);
const manifest = loadManifest(path.join(MIG, 'canonical-manifest.json'));
const ue = manifest.entries.find((e) => e.filename === UP);
const de = manifest.entries.find((e) => e.filename === DOWN);
assert.ok(ue && ue.order === 72 && ue.inForwardChain === true && ue.sha256 === sha256CanonicalLfV1File(upPath));
assert.ok(de && de.inForwardChain === false && de.pairsWith === UP && de.sha256 === sha256CanonicalLfV1File(downPath));
console.log('PASS verify:email-google-endpoint-identity');

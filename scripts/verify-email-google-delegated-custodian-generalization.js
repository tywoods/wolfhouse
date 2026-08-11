'use strict';

/**
 * RED contract: generalize the existing 2F-A delegated-grant custodian to the
 * exact Gmail delegated endpoint identity. Offline hostile mock-PG only.
 *
 * Expected at the Task 1 base: the exact Gmail acceptance cases fail with
 * grant_custody_not_applicable at the custodian's Microsoft-only mode guard.
 */

const assert = require('assert/strict');
const crypto = require('crypto');
const custodian = require('./lib/email-delegated-grant-custodian');

const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENDPOINT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GOOGLE_ISSUER = 'https://accounts.google.com';
const GOOGLE_SUB = 'Google-Sub_123:CaseSensitive';

function envelope(operationId) {
  return {
    envelope_version: 'v1',
    aead_alg: 'AES-256-GCM',
    kek_wrap_alg: 'A256KW',
    kek_key_name: 'offline-test-kek',
    kek_key_version: 'v1-test-0001',
    nonce: crypto.randomBytes(12),
    ciphertext: crypto.randomBytes(24),
    auth_tag: crypto.randomBytes(16),
    wrapped_dek: crypto.randomBytes(40),
    operation_id: operationId,
  };
}

function microsoftEndpoint(overrides = {}) {
  return {
    id: ENDPOINT,
    client_id: CLIENT,
    provider: 'microsoft_graph',
    auth_mode: 'delegated_authorization_code',
    connector_mode: 'microsoft_delegated_oauth',
    binding_status: 'verified',
    provider_tenant_id: '11111111-1111-1111-1111-111111111111',
    provider_principal_oid: '22222222-2222-2222-2222-222222222222',
    provider_resource_id: 'AAMkMicrosoftMailboxId',
    mailbox_kind: 'user',
    mailbox_access_kind: 'own_user',
    ...overrides,
  };
}

function gmailEndpoint(overrides = {}) {
  return {
    id: ENDPOINT,
    client_id: CLIENT,
    provider: 'gmail_api',
    auth_mode: 'delegated_authorization_code',
    connector_mode: 'google_delegated_oauth',
    binding_status: 'verified',
    provider_tenant_id: GOOGLE_ISSUER,
    provider_principal_oid: GOOGLE_SUB,
    provider_resource_id: GOOGLE_SUB,
    mailbox_kind: 'user',
    mailbox_access_kind: 'own_user',
    ...overrides,
  };
}

function mockTransactionClient(endpoint) {
  const queries = [];
  return {
    queries,
    async query(sql) {
      const text = String(sql);
      queries.push(text);
      if (/FROM tenant_channel_endpoints/i.test(text)) {
        return { rows: [endpoint], rowCount: 1 };
      }
      if (/INSERT INTO tenant_email_delegated_grants/i.test(text)) {
        return {
          rows: [{
            client_id: CLIENT,
            endpoint_id: ENDPOINT,
            grant_generation: 1,
            grant_status: 'active',
            reconcile_state: 'clean',
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

async function install(endpoint) {
  const operationId = crypto.randomUUID();
  const client = mockTransactionClient(endpoint);
  const result = await custodian.installInitialDelegatedGrant({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    operationId,
    envelope: envelope(operationId),
  }, { client });
  return { result, client };
}

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name} — ${error.message}`);
  }
}

async function accepts(name, endpoint) {
  await check(name, async () => {
    const { result, client } = await install(endpoint);
    assert.equal(result.ok, true, `expected acceptance, got ${JSON.stringify(result)}`);
    assert.equal(result.value.grant_present, true);
    assert.equal(result.value.grant_generation, 1);
    assert.equal(client.queries.some((sql) => /INSERT INTO tenant_email_delegated_grants/i.test(sql)), true);
  });
}

async function rejects(name, endpoint) {
  await check(name, async () => {
    const { result, client } = await install(endpoint);
    assert.deepEqual(result, { ok: false, error: 'grant_custody_not_applicable' });
    assert.equal(client.queries.some((sql) => /INSERT INTO tenant_email_delegated_grants/i.test(sql)), false);
  });
}

async function main() {
  console.log('verify:email-google-delegated-custodian-generalization');

  // Explicit Microsoft delegated regression: same accepted endpoint and public DTO.
  await accepts('preserves exact Microsoft delegated custody behavior', microsoftEndpoint());

  // The only new accepted class: exact G2c issuer and byte-identical, case-sensitive sub pair.
  await accepts('accepts exact Gmail delegated G2c endpoint', gmailEndpoint());
  await accepts('accepts case-sensitive Gmail sub without UUID normalization', gmailEndpoint({
    provider_principal_oid: 'AbC-123',
    provider_resource_id: 'AbC-123',
  }));

  // Gmail app-only and non-delegated transports remain outside this custodian.
  await rejects('rejects Gmail app-only endpoint', gmailEndpoint({
    auth_mode: 'application_client_credentials',
    connector_mode: 'google_service_account',
    mailbox_access_kind: 'application',
  }));
  await rejects('rejects IMAP endpoint', gmailEndpoint({
    provider: 'imap_smtp',
    auth_mode: 'password_or_app_password',
    connector_mode: 'imap_smtp_basic',
  }));

  // Provider/auth/connector must be one exact closed tuple; no cross-provider mix.
  await rejects('rejects Gmail provider with Microsoft delegated connector', gmailEndpoint({
    connector_mode: 'microsoft_delegated_oauth',
  }));
  await rejects('rejects Microsoft provider with Google delegated connector', microsoftEndpoint({
    connector_mode: 'google_delegated_oauth',
  }));

  // G2c identity is part of applicability, not caller metadata or a partial hint.
  await rejects('rejects noncanonical Google issuer', gmailEndpoint({
    provider_tenant_id: 'https://accounts.google.com/',
  }));
  await rejects('rejects mismatched Gmail principal/resource sub pair', gmailEndpoint({
    provider_resource_id: 'different-sub',
  }));
  await rejects('rejects partial Gmail identity missing issuer', gmailEndpoint({
    provider_tenant_id: null,
  }));
  await rejects('rejects partial Gmail identity missing principal sub', gmailEndpoint({
    provider_principal_oid: null,
  }));
  await rejects('rejects partial Gmail identity missing resource sub', gmailEndpoint({
    provider_resource_id: null,
  }));
  await rejects('rejects malformed Gmail sub', gmailEndpoint({
    provider_principal_oid: ' sub-with-space ',
    provider_resource_id: ' sub-with-space ',
  }));
  await rejects('rejects unverified Gmail binding', gmailEndpoint({
    binding_status: 'pending_manual_validation',
  }));
  await rejects('rejects non-user Gmail mailbox kind', gmailEndpoint({
    mailbox_kind: 'shared',
  }));
  await rejects('rejects non-own-user Gmail mailbox access', gmailEndpoint({
    mailbox_access_kind: 'application',
  }));
  await rejects('rejects unclassified Gmail endpoint identity', gmailEndpoint({
    auth_mode: null,
    connector_mode: null,
    binding_status: null,
    provider_tenant_id: null,
    provider_principal_oid: null,
    provider_resource_id: null,
    mailbox_kind: null,
    mailbox_access_kind: null,
  }));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error('verifier crashed', error && error.stack ? error.stack : error);
  process.exitCode = 2;
});

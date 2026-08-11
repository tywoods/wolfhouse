'use strict';

/**
 * Focused offline tracer for the shared provider-neutral atomic Gmail install owner.
 * No Google/OIDC/network/token exchange/routes/activation.
 */

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OWNER_REL = 'scripts/lib/email-verified-grant-installer.js';
const OWNER_PATH = path.join(ROOT, OWNER_REL);
const VERIFY_REL = 'scripts/verify-email-verified-grant-installer.js';

const CLIENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ENDPOINT_ID = '11111111-2222-4333-8444-555555555555';
const OPERATION_ID = '99999999-8888-4777-8666-555555555555';
const ACTOR_ID = 'abcdef01-2345-4678-89ab-cdef01234567';
const ISSUER = 'https://accounts.google.com';
const SUBJECT = 'Google-Sub_123:CaseSensitive';
const PUBLIC_ADDRESS = 'Owner.Case+Grant@Example.COM';
const SECRET_SENTINELS = Object.freeze([
  'RAW_REFRESH_TOKEN_MUST_NEVER_APPEAR',
  'RAW_ACCESS_TOKEN_MUST_NEVER_APPEAR',
  'RAW_ID_TOKEN_MUST_NEVER_APPEAR',
]);

function envelope() {
  return Object.freeze({
    envelope_version: 'v1',
    aead_alg: 'AES-256-GCM',
    kek_wrap_alg: 'A256KW',
    kek_key_name: 'fake-luna-grant-kek',
    kek_key_version: 'v1-test-0001',
    nonce: Buffer.alloc(12, 1),
    ciphertext: Buffer.alloc(32, 2),
    auth_tag: Buffer.alloc(16, 3),
    wrapped_dek: Buffer.alloc(40, 4),
    operation_id: OPERATION_ID,
  });
}

function installInput() {
  return Object.freeze({
    clientId: CLIENT_ID,
    endpointId: ENDPOINT_ID,
    operationId: OPERATION_ID,
    actorStaffUserId: ACTOR_ID,
    identity: Object.freeze({
      providerTenantId: ISSUER,
      providerPrincipalId: SUBJECT,
      mailboxAddress: PUBLIC_ADDRESS,
      displayName: null,
    }),
    envelope: envelope(),
  });
}

function kind(sql) {
  if (/^\s*BEGIN\b/i.test(sql)) return 'BEGIN';
  if (/FOR\s+UPDATE/i.test(sql) && /tenant_channel_endpoints/i.test(sql)) return 'SELECT_ENDPOINT_FOR_UPDATE';
  if (/INSERT\s+INTO\s+tenant_email_delegated_grants/i.test(sql)) return 'INSERT_ENCRYPTED_GRANT_GENERATION_1';
  if (/UPDATE\s+tenant_channel_endpoints/i.test(sql)) return 'UPDATE_ENDPOINT_GMAIL_VERIFIED';
  if (/^\s*COMMIT\b/i.test(sql)) return 'COMMIT';
  if (/^\s*ROLLBACK\b/i.test(sql)) return 'ROLLBACK';
  return 'UNEXPECTED';
}

function createPinnedTraceClient(endpointPatch = {}, options = {}) {
  const trace = [];
  const client = {
    async query(rawSql, rawParams) {
      const sql = String(rawSql);
      const params = Array.isArray(rawParams) ? rawParams.slice() : [];
      trace.push(Object.freeze({ sql, params: Object.freeze(params) }));
      switch (kind(sql)) {
        case 'BEGIN':
        case 'COMMIT':
        case 'ROLLBACK':
          return { rows: [], rowCount: 0 };
        case 'SELECT_ENDPOINT_FOR_UPDATE':
          assert.deepEqual(params, [CLIENT_ID, ENDPOINT_ID]);
          return {
            rows: [{
              id: ENDPOINT_ID,
              client_id: CLIENT_ID,
              provider: 'gmail_api',
              auth_mode: 'delegated_authorization_code',
              connector_mode: 'google_delegated_oauth',
              binding_status: 'unverified_offline',
              public_address: PUBLIC_ADDRESS,
              ...endpointPatch,
            }],
            rowCount: 1,
          };
        case 'INSERT_ENCRYPTED_GRANT_GENERATION_1':
          if (options.failInsert) throw new Error('fake insert failure');
          assert.match(sql, /grant_generation[\s\S]*VALUES\s*\([^)]*1\s*,\s*'active'/i);
          assert.deepEqual(params.slice(0, 3), [CLIENT_ID, ENDPOINT_ID, OPERATION_ID]);
          assert.equal(params[3], 'v1');
          assert.equal(Buffer.isBuffer(params[8]), true);
          assert.equal(Buffer.isBuffer(params[9]), true);
          assert.equal(Buffer.isBuffer(params[10]), true);
          assert.equal(Buffer.isBuffer(params[11]), true);
          assert.equal(params[12], ACTOR_ID);
          return {
            rows: [{
              client_id: CLIENT_ID,
              endpoint_id: ENDPOINT_ID,
              grant_generation: 1,
              grant_status: 'active',
              reconcile_state: 'clean',
            }],
            rowCount: 1,
          };
        case 'UPDATE_ENDPOINT_GMAIL_VERIFIED':
          assert.match(sql, /provider\s*=\s*'gmail_api'/i);
          assert.match(sql, /connector_mode\s*=\s*'google_delegated_oauth'/i);
          assert.match(sql, /binding_status\s*=\s*'verified'/i);
          assert.deepEqual(params, [
            CLIENT_ID, ENDPOINT_ID, ISSUER, SUBJECT, SUBJECT, ACTOR_ID,
            'unverified_offline', PUBLIC_ADDRESS,
          ]);
          return {
            rows: [{
              id: ENDPOINT_ID,
              client_id: CLIENT_ID,
              binding_status: 'verified',
              provider_tenant_id: ISSUER,
              provider_principal_oid: SUBJECT,
              provider_resource_id: SUBJECT,
              mailbox_kind: 'user',
              mailbox_access_kind: 'own_user',
              public_address: PUBLIC_ADDRESS,
            }],
            rowCount: 1,
          };
        default:
          assert.fail(`unexpected SQL in provider-neutral installer: ${sql}`);
      }
    },
  };
  return Object.freeze({ client, trace });
}

function assertNoRawTokensOrAad(value, label) {
  const seen = new Set();
  function visit(node) {
    if (node == null || typeof node !== 'object' || Buffer.isBuffer(node) || seen.has(node)) return;
    seen.add(node);
    for (const key of Reflect.ownKeys(node)) {
      assert.equal(typeof key, 'string', `${label}: symbol forbidden`);
      assert.equal(/^(refreshToken|accessToken|idToken|refresh_token|access_token|id_token|aad)$/i.test(key), false,
        `${label}: raw token/AAD key ${key} forbidden`);
      visit(node[key]);
    }
  }
  visit(value);
  const rendered = JSON.stringify(value, (_key, item) => (Buffer.isBuffer(item) ? '<sealed-buffer>' : item));
  for (const sentinel of SECRET_SENTINELS) assert.equal(rendered.includes(sentinel), false, `${label}: secret leaked`);
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['verify:email-verified-grant-installer'], `node ${VERIFY_REL}`);

  assert.equal(
    fs.existsSync(OWNER_PATH),
    true,
    `RED: provider-neutral owner ${OWNER_REL} is absent; current installer is Microsoft-only`,
  );
  // This require is intentionally reached only after the explicit ownership assertion.
  const owner = require('./lib/email-verified-grant-installer');
  assert.equal(typeof owner.createVerifiedGrantInstaller, 'function',
    'RED: createVerifiedGrantInstaller provider-neutral factory is absent');

  const input = installInput();
  assert.deepEqual(Reflect.ownKeys(input), [
    'clientId', 'endpointId', 'operationId', 'actorStaffUserId', 'identity', 'envelope',
  ]);
  assert.deepEqual(input.identity, Object.freeze({
    providerTenantId: ISSUER,
    providerPrincipalId: SUBJECT,
    mailboxAddress: PUBLIC_ADDRESS,
    displayName: null,
  }));
  assertNoRawTokensOrAad(input, 'input');

  const fake = createPinnedTraceClient();
  const installer = owner.createVerifiedGrantInstaller(Object.freeze({ client: fake.client }));
  const result = await installer.installVerifiedGrant(input);

  assert.deepEqual(result, Object.freeze({ status: 'installed' }));
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(fake.trace.map((entry) => kind(entry.sql)), [
    'BEGIN',
    'SELECT_ENDPOINT_FOR_UPDATE',
    'UPDATE_ENDPOINT_GMAIL_VERIFIED',
    'INSERT_ENCRYPTED_GRANT_GENERATION_1',
    'COMMIT',
  ]);
  assertNoRawTokensOrAad(fake.trace, 'SQL trace');
  assertNoRawTokensOrAad(result, 'output');

  const insertFailure = createPinnedTraceClient({}, { failInsert: true });
  const insertFailureInstaller = owner.createVerifiedGrantInstaller(
    Object.freeze({ client: insertFailure.client }),
  );
  await assert.rejects(() => insertFailureInstaller.installVerifiedGrant(installInput()),
    (error) => error && error.code === owner.ERROR_CODE);
  assert.deepEqual(insertFailure.trace.map((entry) => kind(entry.sql)), [
    'BEGIN', 'SELECT_ENDPOINT_FOR_UPDATE', 'UPDATE_ENDPOINT_GMAIL_VERIFIED',
    'INSERT_ENCRYPTED_GRANT_GENERATION_1', 'ROLLBACK',
  ]);

  const crossed = createPinnedTraceClient({
    provider: 'microsoft_graph', connector_mode: 'microsoft_delegated_oauth',
  });
  const crossedInstaller = owner.createVerifiedGrantInstaller(Object.freeze({ client: crossed.client }));
  await assert.rejects(() => crossedInstaller.installVerifiedGrant(installInput()),
    (error) => error && error.code === owner.ERROR_CODE);
  assert.deepEqual(crossed.trace.map((entry) => kind(entry.sql)), [
    'BEGIN', 'SELECT_ENDPOINT_FOR_UPDATE', 'ROLLBACK',
  ]);

  const microsoft = require('./lib/email-microsoft-verified-grant-installer');
  const gmailForWrapper = createPinnedTraceClient();
  const wrapped = microsoft.createMicrosoftVerifiedGrantInstaller(
    Object.freeze({ client: gmailForWrapper.client }),
  );
  await assert.rejects(() => wrapped.installVerifiedGrant(installInput()),
    (error) => error && error.code === microsoft.ERROR_CODE);
  assert.deepEqual(gmailForWrapper.trace.map((entry) => kind(entry.sql)), [
    'BEGIN', 'SELECT_ENDPOINT_FOR_UPDATE', 'ROLLBACK',
  ]);
  console.log('PASS provider-neutral exact Gmail verified-grant atomic install');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});

'use strict';

/**
 * RED-only offline contract for Google verified-grant custody.
 *
 * This verifier intentionally names the smallest Google adapter API. It injects
 * cryptographic identity authority; it neither implements nor substitutes Google
 * OIDC/JWKS verification. No network, SDK, token exchange, DB, route, or runtime.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  buildGrantEnvelopeAadV1,
  parseGrantEnvelopeAadV1,
  validateGrantEnvelopeRecordV1,
} = require('./lib/email-grant-envelope-provider-contract');

// Authentic RED: this Google wrapper/shared custody owner does not exist at base.
const googleCustody = require('./lib/email-google-verified-grant-custody');
const {
  ERROR_CODE, ERROR_MESSAGE, GOOGLE_PHASE_A_SCOPES, SELECTED_KEYS, CONFIG_KEYS,
  INSTALL_KEYS, INSTALLER_METHOD, SEALED_ACK,
  createGoogleVerifiedGrantCustodyAdapter,
} = googleCustody;

const CLIENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ENDPOINT = '11111111-2222-4333-8444-555555555555';
const OPERATION = '99999999-8888-4777-8666-555555555555';
const ACTOR = 'abcdef01-2345-4678-89ab-cdef01234567';
const ISSUER = 'https://accounts.google.com';
const SUBJECT = 'Google-Sub_123:CaseSensitive';
const MAILBOX = 'Owner.Case+Grant@Example.COM';
const NONCE = 'GOOGLE_NONCE_SECRET_NEVER_LEAK';
const EXPECTED_CLIENT = 'google-confidential-web-client';
const ACCESS = 'GOOGLE_ACCESS_SECRET_NEVER_LEAK';
const REFRESH = 'GOOGLE_REFRESH_SECRET_NEVER_LEAK';
const ID_TOKEN = 'GOOGLE_ID_TOKEN_SECRET_NEVER_LEAK.header.payload.sig';
const LEAK = 'HOSTILE_DEPENDENCY_SECRET_NEVER_LEAK';
const NOW = 1_900_000_000;
const SCOPE = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
].join(' ');

function config(patch = {}) {
  return Object.freeze({
    clientId: CLIENT, endpointId: ENDPOINT, operationId: OPERATION,
    actorStaffUserId: ACTOR, expectedNonce: NONCE, expectedClientId: EXPECTED_CLIENT,
    ...patch,
  });
}
function selected(patch = {}) {
  // Existing response-custody selected-token vocabulary is camelCase. This is
  // the exact six-field Google token response selected by the future handoff.
  return Object.freeze({
    accessToken: ACCESS, refreshToken: REFRESH, tokenType: 'Bearer', expiresIn: 3600,
    scope: SCOPE, idToken: ID_TOKEN, ...patch,
  });
}
function identity(patch = {}) {
  return Object.freeze({
    providerTenantId: ISSUER, providerPrincipalId: SUBJECT,
    mailboxAddress: MAILBOX, displayName: null, ...patch,
  });
}
function envelope(operationId = OPERATION) {
  return Object.freeze({
    envelope_version: 'v1', aead_alg: 'AES-256-GCM', kek_wrap_alg: 'A256KW',
    kek_key_name: 'offline-test-kek', kek_key_version: 'v1-test-0001',
    nonce: Buffer.alloc(12, 1), ciphertext: Buffer.alloc(32, 2),
    auth_tag: Buffer.alloc(16, 3), wrapped_dek: Buffer.alloc(40, 4),
    operation_id: operationId,
  });
}
function composition(spec = {}) {
  const order = [];
  const calls = { verify: [], seal: [], install: [], open: 0, rewrap: 0 };
  const verifiedIdentity = Object.freeze({
    async verifyIdentity(input) {
      order.push('verify'); calls.verify.push({ input, receiver: this });
      if (spec.verifyThrow) throw new Error(`${LEAK}:verify`);
      return Object.prototype.hasOwnProperty.call(spec, 'verifyResult')
        ? spec.verifyResult : identity();
    },
  });
  const envelopeProvider = {
    async sealGrantPayload(input) {
      order.push('seal'); calls.seal.push({ input, receiver: this });
      if (spec.sealThrow) throw new Error(`${LEAK}:seal`);
      return Object.prototype.hasOwnProperty.call(spec, 'sealResult')
        ? spec.sealResult : envelope();
    },
    async openGrantPayload() { calls.open += 1; throw new Error('must not open'); },
    async rewrapGrantDek() { calls.rewrap += 1; throw new Error('must not rewrap'); },
  };
  const installer = Object.freeze({
    async installVerifiedGrant(input) {
      order.push('install'); calls.install.push({ input, receiver: this });
      if (spec.installThrow) throw new Error(`${LEAK}:install`);
      return Object.prototype.hasOwnProperty.call(spec, 'installResult')
        ? spec.installResult : Object.freeze({ status: 'installed' });
    },
  });
  const clock = Object.freeze({ nowEpochSeconds() { return NOW; } });
  const deps = Object.freeze({ verifiedIdentity, envelopeProvider, clock, installer });
  return {
    adapter: createGoogleVerifiedGrantCustodyAdapter(config(), deps),
    calls, order, deps,
  };
}
async function sanitized(action) {
  await assert.rejects(Promise.resolve().then(action), (error) => {
    assert.equal(error.name, 'GoogleVerifiedGrantCustodyError');
    assert.equal(error.code, ERROR_CODE);
    assert.equal(error.message, ERROR_MESSAGE);
    assert.equal(Object.isFrozen(error), true);
    const rendered = `${error}\n${error.stack || ''}`;
    for (const secret of [ACCESS, REFRESH, ID_TOKEN, NONCE, LEAK]) {
      assert.equal(rendered.includes(secret), false);
    }
    return true;
  });
}
function assertSecretFree(value) {
  const rendered = JSON.stringify(value, (_key, item) => Buffer.isBuffer(item) ? '<sealed>' : item);
  for (const secret of [ACCESS, REFRESH, ID_TOKEN, NONCE, LEAK]) assert.equal(rendered.includes(secret), false);
  for (const key of ['accessToken', 'refreshToken', 'idToken', 'aad', 'refresh_token']) {
    assert.equal(key in value, false);
  }
}

const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('exports the smallest frozen Google custody API', async () => {
  assert.equal(Object.isFrozen(googleCustody), true);
  assert.deepEqual(Object.keys(googleCustody), [
    'ERROR_CODE', 'ERROR_MESSAGE', 'GOOGLE_PHASE_A_SCOPES', 'SELECTED_KEYS',
    'CONFIG_KEYS', 'INSTALL_KEYS', 'INSTALLER_METHOD', 'SEALED_ACK',
    'createGoogleVerifiedGrantCustodyAdapter',
  ]);
  assert.equal(ERROR_CODE, 'GOOGLE_VERIFIED_GRANT_CUSTODY_INVALID');
  assert.equal(ERROR_MESSAGE, 'Google verified grant custody failed.');
  assert.deepEqual([...GOOGLE_PHASE_A_SCOPES], [
    'openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
  ]);
  assert.deepEqual([...SELECTED_KEYS], [
    'accessToken', 'refreshToken', 'tokenType', 'expiresIn', 'scope', 'idToken',
  ]);
  assert.deepEqual([...CONFIG_KEYS], [
    'clientId', 'endpointId', 'operationId', 'actorStaffUserId',
    'expectedNonce', 'expectedClientId',
  ]);
  assert.deepEqual([...INSTALL_KEYS], [
    'clientId', 'endpointId', 'operationId', 'actorStaffUserId', 'identity', 'envelope',
  ]);
  assert.equal(INSTALLER_METHOD, 'installVerifiedGrant');
  assert.deepEqual(SEALED_ACK, { status: 'accepted' });
  assert.equal(Object.isFrozen(SEALED_ACK), true);
});

test('returns a frozen one-method response-custody adapter', async () => {
  const { adapter } = composition();
  assert.deepEqual(Reflect.ownKeys(adapter), ['acceptValidatedTokens']);
  assert.equal(Object.isFrozen(adapter), true);
});

test('requires injected cryptographic verifiedIdentity before seal and install', async () => {
  const { adapter, calls, order } = composition();
  const ack = await adapter.acceptValidatedTokens(selected());
  assert.deepEqual(order, ['verify', 'seal', 'install']);
  assert.equal(calls.verify.length, 1);
  assert.equal(calls.seal.length, 1);
  assert.equal(calls.install.length, 1);
  assert.deepEqual(ack, { status: 'accepted' });
  assert.equal(Object.isFrozen(ack), true);
  assertSecretFree(ack);
});

test('passes exact token/config/time verification request but never refresh token', async () => {
  const { adapter, calls } = composition();
  await adapter.acceptValidatedTokens(selected());
  const request = calls.verify[0].input;
  assert.deepEqual(Reflect.ownKeys(request), [
    'idToken', 'accessToken', 'expectedNonce', 'expectedClientId', 'nowEpochSeconds',
  ]);
  assert.deepEqual(request, Object.freeze({
    idToken: ID_TOKEN, accessToken: ACCESS, expectedNonce: NONCE,
    expectedClientId: EXPECTED_CLIENT, nowEpochSeconds: NOW,
  }));
  assert.equal('refreshToken' in request, false);
});

test('accepts only cryptographic verifier identity DTO, never G2b unverified authority', async () => {
  const unverifiedOffline = Object.freeze({
    provider: 'gmail_api', auth_mode: 'delegated_authorization_code',
    connector_mode: 'google_delegated_oauth', provider_tenant_id: ISSUER,
    provider_resource_id: SUBJECT, public_address: MAILBOX, hosted_domain: null,
    hosted_domain_role: 'optional_workspace_metadata_not_tenant_ownership',
    durable_identity_source: 'oidc_sub',
    public_address_role: 'mutable_routing_metadata_not_identity',
    gmail_history_id_role: 'sync_cursor_not_identity', binding_status: 'unverified_offline',
    cryptographically_verified: false, activation_enabled: false,
  });
  const c = composition({ verifyResult: unverifiedOffline });
  await sanitized(() => c.adapter.acceptValidatedTokens(selected()));
  assert.deepEqual(c.order, ['verify']);
});

test('seals refresh only under canonical generation-1 client+endpoint+operation AAD', async () => {
  const { adapter, calls } = composition();
  await adapter.acceptValidatedTokens(selected());
  const input = calls.seal[0].input;
  assert.deepEqual(Reflect.ownKeys(input), ['refresh_token', 'aad', 'operation_id']);
  assert.equal(input.refresh_token, REFRESH);
  assert.equal(input.operation_id, OPERATION);
  const parsed = parseGrantEnvelopeAadV1(input.aad);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, Object.freeze({
    client_id: CLIENT, endpoint_id: ENDPOINT, grant_generation: 1n,
    operation_id: OPERATION,
  }));
  assert.equal(input.aad.equals(buildGrantEnvelopeAadV1({
    clientId: CLIENT, endpointId: ENDPOINT, grantGeneration: 1, operationId: OPERATION,
  })), true);
  assert.equal('accessToken' in input, false);
  assert.equal('idToken' in input, false);
});

test('installs exact minimized six-field identity+envelope DTO', async () => {
  const { adapter, calls } = composition();
  await adapter.acceptValidatedTokens(selected());
  const request = calls.install[0].input;
  assert.deepEqual(Reflect.ownKeys(request), [...INSTALL_KEYS]);
  assert.equal(Object.isFrozen(request), true);
  assert.deepEqual(request.identity, identity());
  assert.equal(Object.isFrozen(request.identity), true);
  assert.equal(validateGrantEnvelopeRecordV1(request.envelope).ok, true);
  assert.equal(request.envelope.operation_id, OPERATION);
  assertSecretFree(request);
});

test('preserves dependency receivers and never opens or rewraps', async () => {
  const { adapter, calls, deps } = composition();
  await adapter.acceptValidatedTokens(selected());
  assert.equal(calls.verify[0].receiver, deps.verifiedIdentity);
  assert.equal(calls.seal[0].receiver, deps.envelopeProvider);
  assert.equal(calls.install[0].receiver, deps.installer);
  assert.equal(calls.open, 0);
  assert.equal(calls.rewrap, 0);
});

test('identity failure prevents seal and install', async () => {
  const c = composition({ verifyThrow: true });
  await sanitized(() => c.adapter.acceptValidatedTokens(selected()));
  assert.deepEqual(c.order, ['verify']);
});

test('seal failure prevents install', async () => {
  const c = composition({ sealThrow: true });
  await sanitized(() => c.adapter.acceptValidatedTokens(selected()));
  assert.deepEqual(c.order, ['verify', 'seal']);
});

test('rejects malformed verifier output before seal', async () => {
  for (const result of [
    null,
    Object.freeze({ ...identity(), providerTenantId: 'workspace.example' }),
    Object.freeze({ ...identity(), providerPrincipalId: ' sub ' }),
    Object.freeze({ ...identity(), extra: true }),
  ]) {
    const c = composition({ verifyResult: result });
    await sanitized(() => c.adapter.acceptValidatedTokens(selected()));
    assert.deepEqual(c.order, ['verify']);
  }
});

test('rejects an unpaired surrogate display name before seal', async () => {
  const c = composition({ verifyResult: identity({ displayName: 'bad\ud800name' }) });
  await sanitized(() => c.adapter.acceptValidatedTokens(selected()));
  assert.deepEqual(c.order, ['verify']);
});

test('rejects hostile selected input before any dependency call', async () => {
  for (const input of [
    { ...selected() },
    Object.freeze({ ...selected(), extra: true }),
    Object.freeze({ ...selected(), tokenType: 'mac' }),
    Object.freeze({ ...selected(), expiresIn: 0 }),
    Object.freeze({ ...selected(), scope: `${SCOPE} https://mail.google.com/` }),
    new Proxy(selected(), { ownKeys() { throw new Error(LEAK); } }),
  ]) {
    const c = composition();
    await sanitized(() => c.adapter.acceptValidatedTokens(input));
    assert.deepEqual(c.order, []);
  }
});

test('rejects hostile dependencies and does not accept authority-shape comparator as verifier', async () => {
  const valid = composition().deps;
  for (const deps of [
    Object.freeze({ ...valid, verifiedIdentity: Object.freeze({ deriveGoogleMailboxAuthority() {} }) }),
    Object.freeze({ ...valid, verifiedIdentity: Object.freeze({ verifyIdentity() {}, extra() {} }) }),
    Object.freeze({ ...valid, installer: Object.freeze({ installInitialDelegatedGrant() {} }) }),
    Object.freeze({ ...valid, installer: Object.freeze({ install() {} }) }),
  ]) {
    assert.throws(() => createGoogleVerifiedGrantCustodyAdapter(config(), deps),
      error => error && error.code === ERROR_CODE);
  }
});

test('rejects Microsoft stage telemetry injection without emitting Google telemetry', async () => {
  const valid = composition().deps;
  let emitCount = 0;
  const stageTelemetry = Object.freeze({ emit() { emitCount += 1; } });
  const dependencies = Object.freeze({
    verifiedIdentity: valid.verifiedIdentity,
    envelopeProvider: valid.envelopeProvider,
    clock: valid.clock,
    installer: valid.installer,
    stageTelemetry,
  });
  assert.throws(
    () => createGoogleVerifiedGrantCustodyAdapter(config(), dependencies),
    error => error && error.name === 'GoogleVerifiedGrantCustodyError'
      && error.code === ERROR_CODE && error.message === ERROR_MESSAGE,
  );
  assert.equal(emitCount, 0);
});

test('one-shot burns atomically on malformed, failed, concurrent, and successful first calls', async () => {
  for (const first of [selected({ tokenType: 'mac' }), selected()]) {
    const c = composition();
    await Promise.allSettled([
      c.adapter.acceptValidatedTokens(first), c.adapter.acceptValidatedTokens(selected()),
    ]);
    await sanitized(() => c.adapter.acceptValidatedTokens(selected()));
    assert.ok(c.order.length <= 3);
  }
});

test('sanitizes hostile dependency failures and emits no logs', async () => {
  const seen = [];
  const originals = [console.log, console.info, console.warn, console.error];
  [console.log, console.info, console.warn, console.error] = originals.map(() => (...args) => seen.push(args));
  try {
    const c = composition({ installThrow: true });
    await sanitized(() => c.adapter.acceptValidatedTokens(selected()));
    assert.deepEqual(c.order, ['verify', 'seal', 'install']);
    assert.deepEqual(seen, []);
  } finally {
    [console.log, console.info, console.warn, console.error] = originals;
  }
});

test('Google wrapper contains no provider verification, network, credentials, DB, routes, or logs', async () => {
  const source = fs.readFileSync(require.resolve('./lib/email-google-verified-grant-custody'), 'utf8');
  assert.equal(source.includes("'https://www.googleapis.com/auth/gmail.readonly'"), true);
  assert.equal(source.includes("'https://www.googleapis.com/auth/gmail.compose'"), true);
  for (const forbidden of [
    /require\s*\(\s*['"]googleapis['"]\s*\)/,
    /require\s*\(\s*['"]@googleapis\//,
    /\bfrom\s*['"](?:googleapis|@googleapis\/)/,
    /\bimport\s*\(\s*['"](?:googleapis|@googleapis\/)/,
    /\bfetch\s*\(/, /\bhttps\.(?:get|request)\s*\(/, /jwks/i,
    /verify.*signature/i, /token[_-]?exchange/i, /process\.env/, /\bpg\b/,
    /staff-query-api/, /console\.(?:log|info|warn|error)/,
    /deriveGoogleMailboxAuthority/,
  ]) assert.equal(forbidden.test(source), false, `forbidden capability ${forbidden}`);
});

(async () => {
  let passed = 0;
  for (const { name, run } of tests) {
    await run();
    passed += 1;
    console.log(`ok - ${name}`);
  }
  console.log(`PASS verify:email-google-verified-grant-custody (${passed} offline tests)`);
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});

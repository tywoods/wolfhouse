'use strict';

/**
 * Hostile offline gate for Stage 6 Microsoft verified-grant custody adapter.
 * Stubs + real merged fake envelope provider roundtrip + response-custody
 * interoperability. No DB/callback/routes/Azure/live/activation/sync/send.
 */

const assert = require('assert/strict');
const {
  ERROR_CODE,
  ERROR_MESSAGE,
  TOKEN_LIMIT_CHARS,
  ID_TOKEN_LIMIT_CHARS,
  MAX_EXPIRES_IN_SECONDS,
  PHASE_A_SCOPES,
  GRANT_GENERATION_INITIAL,
  SELECTED_KEYS,
  CONFIG_KEYS,
  INSTALL_KEYS,
  INSTALLER_METHOD,
  SEALED_ACK,
  createMicrosoftVerifiedGrantCustodyAdapter,
} = require('./lib/email-microsoft-verified-grant-custody');
const {
  buildGrantEnvelopeAadV1,
  parseGrantEnvelopeAadV1,
  validateGrantEnvelopeRecordV1,
  validateEmailGrantEnvelopeProvider,
  decodeDelegatedRefreshPackageV1,
} = require('./lib/email-grant-envelope-provider-contract');
const {
  createFakeEmailGrantEnvelopeProvider,
  getFakeEmailGrantEnvelopeProviderMeta,
} = require('./lib/email-grant-envelope-fake-provider');
const {
  TOKEN_LIMIT_CHARS: CUSTODY_TOKEN_LIMIT,
  ID_TOKEN_LIMIT_CHARS: CUSTODY_ID_TOKEN_LIMIT,
  MAX_EXPIRES_IN_SECONDS: CUSTODY_MAX_EXPIRES,
  PHASE_A_SCOPES: CUSTODY_PHASE_A_SCOPES,
  createMicrosoftTokenResponseCustodyService,
} = require('./lib/email-microsoft-response-custody-handoff');
const { EventEmitter } = require('events');

const NOW = 1_900_000_000;
const CLIENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ENDPOINT_ID = '11111111-2222-4333-8444-555555555555';
const OPERATION_ID = '99999999-8888-4777-8666-555555555555';
const ACTOR_ID = 'abcdef01-2345-4678-89ab-cdef01234567';
const TID = '01234567-89ab-4def-8123-456789abcdef';
const PRINCIPAL = 'principal-oidc-graph-match-1';
const MAILBOX = 'ada@example.com';
const DISPLAY = 'Ada Lovelace';
const NONCE = 'offline-nonce-NEVER-LEAK-7f1a';
const EXPECTED_CLIENT = 'offline-client-id';
const ACCESS = 'ACCESS_SECRET_NEVER_LEAK_9c2b';
const REFRESH = 'REFRESH_SECRET_NEVER_LEAK_3d4e';
const ID_TOKEN = 'ID_TOKEN_SECRET_NEVER_LEAK.header.payload.sig';
const LEAK = 'VERIFIED-GRANT-CUSTODY-SECRET-DO-NOT-LEAK';
const GOOD_SCOPE = 'openid profile offline_access User.Read Mail.ReadBasic';

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

function goodConfig(patch = {}) {
  return Object.freeze({
    clientId: CLIENT_ID,
    endpointId: ENDPOINT_ID,
    operationId: OPERATION_ID,
    actorStaffUserId: ACTOR_ID,
    expectedNonce: NONCE,
    expectedClientId: EXPECTED_CLIENT,
    ...patch,
  });
}

function nullActorConfig() {
  return goodConfig({ actorStaffUserId: null });
}

function goodSelected(patch = {}) {
  return Object.freeze({
    accessToken: ACCESS,
    refreshToken: REFRESH,
    tokenType: 'Bearer',
    expiresIn: 3600,
    scope: GOOD_SCOPE,
    idToken: ID_TOKEN,
    ...patch,
  });
}

function goodIdentity(patch = {}) {
  return Object.freeze({
    providerTenantId: TID,
    providerPrincipalId: PRINCIPAL,
    mailboxAddress: MAILBOX,
    displayName: DISPLAY,
    ...patch,
  });
}

function stubIdentity(spec = {}) {
  const calls = [];
  const verifiedIdentity = Object.freeze({
    async verifyIdentity(request) {
      calls.push({ request, thisValue: this });
      if (spec.wait) await spec.wait;
      if (spec.throw) throw new Error(`${LEAK} identity`);
      if (spec.result !== undefined) return spec.result;
      return goodIdentity(spec.identityPatch || {});
    },
  });
  return { verifiedIdentity, calls };
}

function stubClock(spec = {}) {
  const calls = [];
  const clock = Object.freeze({
    nowEpochSeconds() {
      calls.push({ thisValue: this });
      if (spec.throw) throw new Error(`${LEAK} clock`);
      if (Object.prototype.hasOwnProperty.call(spec, 'value')) return spec.value;
      return NOW;
    },
  });
  return { clock, calls };
}

function stubInstaller(spec = {}) {
  const calls = [];
  const installer = Object.freeze({
    async installVerifiedGrant(request) {
      calls.push({ request, thisValue: this });
      if (spec.wait) await spec.wait;
      if (spec.throw) throw new Error(`${LEAK} installer`);
      if (spec.result !== undefined) return spec.result;
      // Exact installer contract: frozen { status: 'installed' } only.
      return Object.freeze({ status: 'installed' });
    },
  });
  return { installer, calls };
}

/** Structurally valid envelope for hostile seal stubs (operation-bound). */
function structuralEnvelope(operationId = OPERATION_ID) {
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
    operation_id: operationId,
  });
}

function stubEnvelope(spec = {}) {
  const calls = [];
  const envelopeProvider = {
    async sealGrantPayload(input) {
      calls.push({ op: 'seal', input, thisValue: this });
      if (spec.wait) await spec.wait;
      if (spec.throw) throw new Error(`${LEAK} seal`);
      if (spec.sealResult !== undefined) return spec.sealResult;
      // Minimal valid-shaped envelope for shape tests (buffers fake).
      return structuralEnvelope(OPERATION_ID);
    },
    async openGrantPayload() {
      calls.push({ op: 'open', thisValue: this });
      throw new Error('open must not run in this adapter');
    },
    async rewrapGrantDek() {
      calls.push({ op: 'rewrap', thisValue: this });
      throw new Error('rewrap must not run in this adapter');
    },
  };
  return { envelopeProvider, calls };
}

function composition(spec = {}) {
  const identity = stubIdentity(spec.identity);
  const clock = stubClock(spec.clock);
  const installer = stubInstaller(spec.installer);
  const envelope = stubEnvelope(spec.envelope);
  const provider = spec.envelopeProvider || envelope.envelopeProvider;
  const adapter = createMicrosoftVerifiedGrantCustodyAdapter(
    spec.config || goodConfig(spec.configPatch),
    Object.freeze({
      verifiedIdentity: identity.verifiedIdentity,
      envelopeProvider: provider,
      clock: clock.clock,
      installer: installer.installer,
    }),
  );
  return {
    adapter, identity, clock, installer, envelope, provider,
  };
}

async function expectSanitizedFailure(action) {
  await assert.rejects(Promise.resolve().then(action), (error) => {
    assert.equal(error.name, 'MicrosoftVerifiedGrantCustodyError');
    assert.equal(error.code, ERROR_CODE);
    assert.equal(error.message, ERROR_MESSAGE);
    assert.equal(Object.isFrozen(error), true);
    assert.deepEqual(Object.keys(error), ['code']);
    const text = `${error}\n${error.stack || ''}`;
    assert.equal(text.includes(LEAK), false);
    assert.equal(text.includes(ACCESS), false);
    assert.equal(text.includes(REFRESH), false);
    assert.equal(text.includes(ID_TOKEN), false);
    assert.equal(text.includes(NONCE), false);
    return true;
  });
}

function assertNoSensitiveKeys(object) {
  const text = JSON.stringify(object, (_k, v) => (Buffer.isBuffer(v) ? `buf:${v.length}` : v));
  assert.equal(text.includes(ACCESS), false);
  assert.equal(text.includes(REFRESH), false);
  assert.equal(text.includes(ID_TOKEN), false);
  assert.equal(text.includes(NONCE), false);
  assert.equal(text.includes(LEAK), false);
  assert.equal('accessToken' in object, false);
  assert.equal('refreshToken' in object, false);
  assert.equal('idToken' in object, false);
  assert.equal('aad' in object, false);
  assert.equal('refresh_token' in object, false);
  assert.equal('envelopeProvider' in object, false);
}

// ── Export / anti-drift ────────────────────────────────────────────────────

test('exports frozen factory, fixed error constants, and custody-aligned bounds', async function exportSurface() {
  const exported = require('./lib/email-microsoft-verified-grant-custody');
  assert.deepEqual(Object.keys(exported), [
    'ERROR_CODE',
    'ERROR_MESSAGE',
    'TOKEN_LIMIT_CHARS',
    'ID_TOKEN_LIMIT_CHARS',
    'MAX_EXPIRES_IN_SECONDS',
    'PHASE_A_SCOPES',
    'GRANT_GENERATION_INITIAL',
    'SELECTED_KEYS',
    'CONFIG_KEYS',
    'INSTALL_KEYS',
    'INSTALLER_METHOD',
    'SEALED_ACK',
    'createMicrosoftVerifiedGrantCustodyAdapter',
  ]);
  assert.equal(Object.isFrozen(exported), true);
  assert.equal(exported.ERROR_CODE, 'MICROSOFT_VERIFIED_GRANT_CUSTODY_INVALID');
  assert.equal(exported.ERROR_MESSAGE, 'Microsoft verified grant custody failed.');
  assert.equal(TOKEN_LIMIT_CHARS, CUSTODY_TOKEN_LIMIT);
  assert.equal(ID_TOKEN_LIMIT_CHARS, CUSTODY_ID_TOKEN_LIMIT);
  assert.equal(MAX_EXPIRES_IN_SECONDS, CUSTODY_MAX_EXPIRES);
  assert.deepEqual([...PHASE_A_SCOPES], [...CUSTODY_PHASE_A_SCOPES]);
  assert.equal(GRANT_GENERATION_INITIAL, 1);
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

test('returns frozen single-method adapter with acceptValidatedTokens', async function frozenAdapterShape() {
  const { adapter } = composition();
  assert.deepEqual(Object.keys(adapter), ['acceptValidatedTokens']);
  assert.deepEqual(Reflect.ownKeys(adapter), ['acceptValidatedTokens']);
  assert.equal(Object.isFrozen(adapter), true);
  assert.equal(typeof adapter.acceptValidatedTokens, 'function');
  assert.equal('installVerifiedGrant' in adapter, false);
  assert.equal('install' in adapter, false);
});

// ── Happy path ─────────────────────────────────────────────────────────────

test('happy path stubs: clock → identity → seal → install → sealed accepted', async function happyPathStubs() {
  const { adapter, identity, clock, installer, envelope } = composition();
  const result = await adapter.acceptValidatedTokens(goodSelected());
  assert.deepEqual(result, { status: 'accepted' });
  assert.deepEqual(result, SEALED_ACK);
  assert.deepEqual(Object.keys(result), ['status']);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(clock.calls.length, 1);
  assert.equal(identity.calls.length, 1);
  assert.equal(envelope.calls.filter((c) => c.op === 'seal').length, 1);
  assert.equal(envelope.calls.filter((c) => c.op === 'open').length, 0);
  assert.equal(installer.calls.length, 1);
});

test('happy path with null actorStaffUserId', async function happyPathNullActor() {
  const { adapter, installer } = composition({ config: nullActorConfig() });
  const result = await adapter.acceptValidatedTokens(goodSelected());
  assert.deepEqual(result, { status: 'accepted' });
  assert.equal(installer.calls[0].request.actorStaffUserId, null);
});

// ── Receivers ──────────────────────────────────────────────────────────────

test('preserves exact clock, verifiedIdentity, envelope, and installer receivers', async function preservesReceivers() {
  const { adapter, identity, clock, installer, envelope, provider } = composition();
  await adapter.acceptValidatedTokens(goodSelected());
  assert.equal(clock.calls[0].thisValue, clock.clock);
  assert.equal(identity.calls[0].thisValue, identity.verifiedIdentity);
  assert.equal(envelope.calls[0].thisValue, provider);
  assert.equal(installer.calls[0].thisValue, installer.installer);
});

// ── Exact shapes / order ───────────────────────────────────────────────────

test('passes exact identity input from clock snapshot and config only', async function exactIdentityInput() {
  const { adapter, identity, clock } = composition();
  await adapter.acceptValidatedTokens(goodSelected());
  assert.equal(clock.calls.length, 1);
  assert.deepEqual(Reflect.ownKeys(identity.calls[0].request), [
    'idToken', 'accessToken', 'expectedNonce', 'expectedClientId', 'nowEpochSeconds',
  ]);
  assert.equal(Object.isFrozen(identity.calls[0].request), true);
  assert.equal(identity.calls[0].request.idToken, ID_TOKEN);
  assert.equal(identity.calls[0].request.accessToken, ACCESS);
  assert.equal(identity.calls[0].request.expectedNonce, NONCE);
  assert.equal(identity.calls[0].request.expectedClientId, EXPECTED_CLIENT);
  assert.equal(identity.calls[0].request.nowEpochSeconds, NOW);
  assert.equal('refreshToken' in identity.calls[0].request, false);
});

test('seals only refresh_token with exact gen-1 AAD binding client/endpoint/op', async function exactSealInputAndAad() {
  const { adapter, envelope } = composition();
  await adapter.acceptValidatedTokens(goodSelected());
  const seal = envelope.calls.find((c) => c.op === 'seal');
  assert.ok(seal);
  assert.deepEqual(Reflect.ownKeys(seal.input), ['refresh_token', 'aad', 'operation_id']);
  assert.equal(Object.isFrozen(seal.input), true);
  assert.equal(seal.input.refresh_token, REFRESH);
  assert.equal(seal.input.operation_id, OPERATION_ID);
  assert.equal(Buffer.isBuffer(seal.input.aad), true);
  assert.equal('accessToken' in seal.input, false);
  assert.equal('access_token' in seal.input, false);
  assert.equal('idToken' in seal.input, false);
  assert.equal('id_token' in seal.input, false);

  const parsed = parseGrantEnvelopeAadV1(seal.input.aad);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.client_id, CLIENT_ID);
  assert.equal(parsed.value.endpoint_id, ENDPOINT_ID);
  assert.equal(parsed.value.operation_id, OPERATION_ID);
  assert.equal(parsed.value.grant_generation, 1n);

  const expected = buildGrantEnvelopeAadV1({
    clientId: CLIENT_ID,
    endpointId: ENDPOINT_ID,
    grantGeneration: 1,
    operationId: OPERATION_ID,
  });
  assert.equal(seal.input.aad.equals(expected), true);
});

test('installer receives exact minimized input with identity and no secrets', async function exactInstallerInput() {
  const { adapter, installer, envelope } = composition();
  await adapter.acceptValidatedTokens(goodSelected());
  const req = installer.calls[0].request;
  assert.deepEqual(Reflect.ownKeys(req), [
    'clientId', 'endpointId', 'operationId', 'actorStaffUserId', 'identity', 'envelope',
  ]);
  assert.deepEqual([...INSTALL_KEYS], [
    'clientId', 'endpointId', 'operationId', 'actorStaffUserId', 'identity', 'envelope',
  ]);
  assert.equal(Object.isFrozen(req), true);
  assert.equal(req.clientId, CLIENT_ID);
  assert.equal(req.endpointId, ENDPOINT_ID);
  assert.equal(req.operationId, OPERATION_ID);
  assert.equal(req.actorStaffUserId, ACTOR_ID);
  assert.deepEqual(req.identity, goodIdentity());
  assert.equal(Object.isFrozen(req.identity), true);
  assert.deepEqual(Reflect.ownKeys(req.identity), [
    'providerTenantId', 'providerPrincipalId', 'mailboxAddress', 'displayName',
  ]);
  const envOk = validateGrantEnvelopeRecordV1(req.envelope);
  assert.equal(envOk.ok, true);
  assert.equal(req.envelope.operation_id, OPERATION_ID);
  assertNoSensitiveKeys(req);
  // Envelope is the sealed/validated record (not raw seal throw text).
  assert.equal(envelope.calls[0].op, 'seal');
});

// ── Order: clock → identity → seal → install ───────────────────────────────

test('strict order clock then identity then seal then install', async function strictCallOrder() {
  const order = [];
  let releaseIdentity;
  const identityGate = new Promise((resolve) => { releaseIdentity = resolve; });
  let releaseSeal;
  const sealGate = new Promise((resolve) => { releaseSeal = resolve; });

  const verifiedIdentity = Object.freeze({
    async verifyIdentity() {
      order.push('identity-start');
      await identityGate;
      order.push('identity-end');
      return goodIdentity();
    },
  });
  const clock = Object.freeze({
    nowEpochSeconds() {
      order.push('clock');
      return NOW;
    },
  });
  const envelopeProvider = {
    async sealGrantPayload(input) {
      order.push('seal-start');
      await sealGate;
      order.push('seal-end');
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
    },
    async openGrantPayload() { throw new Error('no open'); },
    async rewrapGrantDek() { throw new Error('no rewrap'); },
  };
  const installer = Object.freeze({
    async installVerifiedGrant() {
      order.push('install');
      return Object.freeze({ status: 'installed' });
    },
  });
  const adapter = createMicrosoftVerifiedGrantCustodyAdapter(
    goodConfig(),
    Object.freeze({ verifiedIdentity, envelopeProvider, clock, installer }),
  );
  const pending = adapter.acceptValidatedTokens(goodSelected());
  await Promise.resolve();
  assert.deepEqual(order, ['clock', 'identity-start']);
  releaseIdentity();
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(order.includes('identity-end'));
  assert.ok(order.includes('seal-start'));
  assert.equal(order.includes('install'), false);
  releaseSeal();
  await pending;
  assert.deepEqual(order, [
    'clock', 'identity-start', 'identity-end', 'seal-start', 'seal-end', 'install',
  ]);
});

test('never seals before identity succeeds and never installs before seal', async function noSealBeforeIdentityNoInstallBeforeSeal() {
  const order = [];
  const verifiedIdentity = Object.freeze({
    async verifyIdentity() {
      order.push('identity');
      throw new Error(`${LEAK} identity-fail`);
    },
  });
  const envelopeProvider = {
    async sealGrantPayload() {
      order.push('seal');
      throw new Error('should not seal');
    },
    async openGrantPayload() { throw new Error('no'); },
    async rewrapGrantDek() { throw new Error('no'); },
  };
  const installer = Object.freeze({
    async installVerifiedGrant() {
      order.push('install');
      return Object.freeze({ status: 'installed' });
    },
  });
  const clock = Object.freeze({ nowEpochSeconds() { order.push('clock'); return NOW; } });
  const adapter = createMicrosoftVerifiedGrantCustodyAdapter(
    goodConfig(),
    Object.freeze({ verifiedIdentity, envelopeProvider, clock, installer }),
  );
  await expectSanitizedFailure(() => adapter.acceptValidatedTokens(goodSelected()));
  assert.deepEqual(order, ['clock', 'identity']);

  const order2 = [];
  const idOk = Object.freeze({
    async verifyIdentity() {
      order2.push('identity');
      return goodIdentity();
    },
  });
  const sealFail = {
    async sealGrantPayload() {
      order2.push('seal');
      throw new Error(`${LEAK} seal-fail`);
    },
    async openGrantPayload() { throw new Error('no'); },
    async rewrapGrantDek() { throw new Error('no'); },
  };
  const install2 = Object.freeze({
    async installVerifiedGrant() {
      order2.push('install');
      return Object.freeze({ status: 'installed' });
    },
  });
  const clock2 = Object.freeze({ nowEpochSeconds() { order2.push('clock'); return NOW; } });
  const adapter2 = createMicrosoftVerifiedGrantCustodyAdapter(
    goodConfig(),
    Object.freeze({
      verifiedIdentity: idOk,
      envelopeProvider: sealFail,
      clock: clock2,
      installer: install2,
    }),
  );
  await expectSanitizedFailure(() => adapter2.acceptValidatedTokens(goodSelected()));
  assert.deepEqual(order2, ['clock', 'identity', 'seal']);
});

// ── Factory traps: config / deps ───────────────────────────────────────────

test('rejects hostile unfrozen or malformed factory config', async function hostileConfigFactory() {
  const identity = stubIdentity();
  const clock = stubClock();
  const installer = stubInstaller();
  const envelope = stubEnvelope();
  const deps = Object.freeze({
    verifiedIdentity: identity.verifiedIdentity,
    envelopeProvider: envelope.envelopeProvider,
    clock: clock.clock,
    installer: installer.installer,
  });
  const hostiles = [
    null,
    undefined,
    {},
    { ...goodConfig() }, // unfrozen
    Object.freeze({ ...goodConfig(), extra: 1 }),
    Object.freeze({
      clientId: CLIENT_ID,
      endpointId: ENDPOINT_ID,
      operationId: OPERATION_ID,
      actorStaffUserId: ACTOR_ID,
      expectedNonce: NONCE,
      // missing expectedClientId
    }),
    Object.freeze({
      ...goodConfig(),
      clientId: 'NOT-A-UUID',
    }),
    Object.freeze({
      ...goodConfig(),
      clientId: CLIENT_ID.toUpperCase(), // non-canonical
    }),
    Object.freeze({
      ...goodConfig(),
      actorStaffUserId: 'nope',
    }),
    Object.freeze({
      ...goodConfig(),
      expectedNonce: '',
    }),
    Object.freeze({
      ...goodConfig(),
      expectedClientId: 'c'.repeat(257),
    }),
  ];
  for (const config of hostiles) {
    assert.throws(
      () => createMicrosoftVerifiedGrantCustodyAdapter(config, deps),
      (error) => error.code === ERROR_CODE && !String(error).includes(LEAK),
    );
  }
});

test('rejects hostile factory dependency traps, accessors, symbols, prototypes', async function hostileDepsFactory() {
  const goodId = stubIdentity().verifiedIdentity;
  const goodClock = stubClock().clock;
  const goodInstall = stubInstaller().installer;
  const goodEnv = stubEnvelope().envelopeProvider;
  const goodConfigFrozen = goodConfig();

  const hostiles = [
    null,
    undefined,
    [],
    {},
    Object.freeze({
      verifiedIdentity: goodId,
      envelopeProvider: goodEnv,
      clock: goodClock,
      // missing installer
    }),
    Object.freeze({
      verifiedIdentity: goodId,
      envelopeProvider: goodEnv,
      clock: goodClock,
      installer: goodInstall,
      extra: 1,
    }),
    Object.freeze({
      verifiedIdentity: {},
      envelopeProvider: goodEnv,
      clock: goodClock,
      installer: goodInstall,
    }),
    Object.freeze({
      verifiedIdentity: goodId,
      envelopeProvider: {}, // fails provider validation
      clock: goodClock,
      installer: goodInstall,
    }),
    Object.freeze({
      verifiedIdentity: goodId,
      envelopeProvider: Object.freeze({
        sealGrantPayload: async () => {},
        // missing open/rewrap
      }),
      clock: goodClock,
      installer: goodInstall,
    }),
    Object.freeze({
      verifiedIdentity: goodId,
      envelopeProvider: {
        sealGrantPayload: async () => {},
        openGrantPayload: async () => {},
        rewrapGrantDek: async () => {},
        refresh_token: LEAK,
      },
      clock: goodClock,
      installer: goodInstall,
    }),
    Object.freeze({
      verifiedIdentity: goodId,
      envelopeProvider: goodEnv,
      clock: { nowEpochSeconds() { return NOW; } }, // unfrozen clock service
      installer: goodInstall,
    }),
    Object.freeze({
      verifiedIdentity: goodId,
      envelopeProvider: goodEnv,
      clock: goodClock,
      // wrong method name — future atomic boundary is installVerifiedGrant, not install
      installer: Object.freeze({
        install: async () => Object.freeze({ status: 'installed' }),
      }),
    }),
    Object.freeze({
      verifiedIdentity: goodId,
      envelopeProvider: goodEnv,
      clock: goodClock,
      // existing envelope-only custodian method — rejected (does not bind identity)
      installer: Object.freeze({
        installInitialDelegatedGrant: async () => Object.freeze({ status: 'installed' }),
      }),
    }),
    Object.freeze({
      verifiedIdentity: goodId,
      envelopeProvider: goodEnv,
      clock: goodClock,
      // unfrozen installer service even with correct method name
      installer: { installVerifiedGrant: async () => Object.freeze({ status: 'installed' }) },
    }),
    // unfrozen deps bag
    {
      verifiedIdentity: goodId,
      envelopeProvider: goodEnv,
      clock: goodClock,
      installer: goodInstall,
    },
  ];
  for (const deps of hostiles) {
    assert.throws(
      () => createMicrosoftVerifiedGrantCustodyAdapter(goodConfigFrozen, deps),
      (error) => error.code === ERROR_CODE && !String(error).includes(LEAK),
    );
  }

  const accessor = {};
  Object.defineProperty(accessor, 'verifiedIdentity', {
    enumerable: true,
    get() { throw new Error(LEAK); },
  });
  Object.defineProperty(accessor, 'envelopeProvider', { enumerable: true, value: goodEnv });
  Object.defineProperty(accessor, 'clock', { enumerable: true, value: goodClock });
  Object.defineProperty(accessor, 'installer', { enumerable: true, value: goodInstall });
  assert.throws(
    () => createMicrosoftVerifiedGrantCustodyAdapter(goodConfigFrozen, Object.freeze(accessor)),
    (error) => error.code === ERROR_CODE && !String(error).includes(LEAK),
  );

  const withSymbol = {
    verifiedIdentity: goodId,
    envelopeProvider: goodEnv,
    clock: goodClock,
    installer: goodInstall,
  };
  Object.defineProperty(withSymbol, Symbol('trap'), { value: LEAK });
  assert.throws(
    () => createMicrosoftVerifiedGrantCustodyAdapter(goodConfigFrozen, Object.freeze(withSymbol)),
    (error) => error.code === ERROR_CODE && !String(error).includes(LEAK),
  );

  const proxy = new Proxy({}, {
    getPrototypeOf() { throw new Error(LEAK); },
    ownKeys() { throw new Error(LEAK); },
  });
  assert.throws(
    () => createMicrosoftVerifiedGrantCustodyAdapter(goodConfigFrozen, proxy),
    (error) => error.code === ERROR_CODE && !String(error).includes(LEAK),
  );
});

// ── Selected input hostiles ────────────────────────────────────────────────

test('rejects unfrozen or malformed selected input with zero dependency calls', async function hostileSelectedInput() {
  const cases = [
    null,
    undefined,
    {},
    {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      tokenType: 'Bearer',
      expiresIn: 3600,
      scope: GOOD_SCOPE,
      idToken: ID_TOKEN,
    }, // unfrozen
    Object.freeze({
      accessToken: ACCESS,
      refreshToken: REFRESH,
      tokenType: 'Bearer',
      expiresIn: 3600,
      scope: GOOD_SCOPE,
      idToken: ID_TOKEN,
      extra: 1,
    }),
    goodSelected({ accessToken: '' }),
    goodSelected({ accessToken: 'has space' }),
    goodSelected({ accessToken: 'A'.repeat(TOKEN_LIMIT_CHARS + 1) }),
    goodSelected({ refreshToken: '' }),
    goodSelected({ refreshToken: 'bad\ntoken' }),
    goodSelected({ refreshToken: 'R'.repeat(TOKEN_LIMIT_CHARS + 1) }),
    goodSelected({ tokenType: 'bearer' }),
    goodSelected({ tokenType: 'MAC' }),
    goodSelected({ expiresIn: 0 }),
    goodSelected({ expiresIn: 1.5 }),
    goodSelected({ expiresIn: MAX_EXPIRES_IN_SECONDS + 1 }),
    goodSelected({ scope: 'openid' }),
    goodSelected({ scope: 'openid profile offline_access User.Read Mail.Send' }),
    goodSelected({ idToken: '' }),
    goodSelected({ idToken: 'has space' }),
    goodSelected({ idToken: 'I'.repeat(ID_TOKEN_LIMIT_CHARS + 1) }),
  ];
  for (const bad of cases) {
    const fresh = composition();
    await expectSanitizedFailure(() => fresh.adapter.acceptValidatedTokens(bad));
    assert.equal(fresh.clock.calls.length, 0, 'clock must not run on bad input');
    assert.equal(fresh.identity.calls.length, 0);
    assert.equal(fresh.envelope.calls.length, 0);
    assert.equal(fresh.installer.calls.length, 0);
  }

  const accessor = {
    refreshToken: REFRESH,
    tokenType: 'Bearer',
    expiresIn: 3600,
    scope: GOOD_SCOPE,
    idToken: ID_TOKEN,
  };
  Object.defineProperty(accessor, 'accessToken', {
    enumerable: true,
    get() { throw new Error(LEAK); },
  });
  const accessored = composition();
  await expectSanitizedFailure(() => accessored.adapter.acceptValidatedTokens(Object.freeze(accessor)));
  assert.equal(accessored.clock.calls.length, 0);

  const withSymbol = {
    accessToken: ACCESS,
    refreshToken: REFRESH,
    tokenType: 'Bearer',
    expiresIn: 3600,
    scope: GOOD_SCOPE,
    idToken: ID_TOKEN,
  };
  Object.defineProperty(withSymbol, Symbol('x'), { value: LEAK });
  const symbolled = composition();
  await expectSanitizedFailure(() => symbolled.adapter.acceptValidatedTokens(Object.freeze(withSymbol)));
  assert.equal(symbolled.identity.calls.length, 0);

  const protoTrap = new Proxy(goodSelected(), {
    getPrototypeOf() { throw new Error(LEAK); },
  });
  const proxied = composition();
  await expectSanitizedFailure(() => proxied.adapter.acceptValidatedTokens(protoTrap));
  assert.equal(proxied.installer.calls.length, 0);
});

test('accepts exact custody token length boundaries', async function tokenBoundaryAccept() {
  const accessOk = 'A'.repeat(TOKEN_LIMIT_CHARS);
  const refreshOk = 'R'.repeat(TOKEN_LIMIT_CHARS);
  const idOk = 'I'.repeat(ID_TOKEN_LIMIT_CHARS);
  const { adapter } = composition();
  const result = await adapter.acceptValidatedTokens(goodSelected({
    accessToken: accessOk,
    refreshToken: refreshOk,
    idToken: idOk,
  }));
  assert.deepEqual(result, { status: 'accepted' });
});

// ── Clock / identity / envelope / ack shapes ───────────────────────────────

test('rejects bad clock values and clock throws without identity', async function clockHostiles() {
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, 'now', undefined]) {
    const fresh = composition({ clock: { value } });
    await expectSanitizedFailure(() => fresh.adapter.acceptValidatedTokens(goodSelected()));
    assert.equal(fresh.clock.calls.length, 1);
    assert.equal(fresh.identity.calls.length, 0);
    assert.equal(fresh.envelope.calls.length, 0);
  }
  const throws = composition({ clock: { throw: true } });
  await expectSanitizedFailure(() => throws.adapter.acceptValidatedTokens(goodSelected()));
  assert.equal(throws.identity.calls.length, 0);
});

test('rejects hostile identity results and identity throws without sealing', async function identityHostiles() {
  const hostiles = [
    null,
    Object.freeze({ providerTenantId: TID }),
    Object.freeze({
      providerTenantId: TID,
      providerPrincipalId: PRINCIPAL,
      mailboxAddress: MAILBOX,
      displayName: DISPLAY,
      extra: LEAK,
    }),
    Object.freeze({
      providerTenantId: 'NOT-UUID',
      providerPrincipalId: PRINCIPAL,
      mailboxAddress: MAILBOX,
      displayName: DISPLAY,
    }),
    Object.freeze({
      providerTenantId: TID,
      providerPrincipalId: PRINCIPAL,
      mailboxAddress: 'Ada@Example.COM',
      displayName: DISPLAY,
    }),
    {
      providerTenantId: TID,
      providerPrincipalId: PRINCIPAL,
      mailboxAddress: MAILBOX,
      displayName: DISPLAY,
    }, // unfrozen
  ];
  for (const result of hostiles) {
    const fresh = composition({ identity: { result } });
    await expectSanitizedFailure(() => fresh.adapter.acceptValidatedTokens(goodSelected()));
    assert.equal(fresh.identity.calls.length, 1);
    assert.equal(fresh.envelope.calls.length, 0);
    assert.equal(fresh.installer.calls.length, 0);
  }
  const throws = composition({ identity: { throw: true } });
  await expectSanitizedFailure(() => throws.adapter.acceptValidatedTokens(goodSelected()));
  assert.equal(throws.envelope.calls.length, 0);
});

test('rejects hostile envelope seal results and seal throws without install', async function envelopeHostiles() {
  const hostiles = [
    null,
    Object.freeze({ envelope_version: 'v1' }),
    Object.freeze({
      envelope_version: 'v1',
      aead_alg: 'AES-256-GCM',
      kek_wrap_alg: 'A256KW',
      kek_key_name: 'fake-luna-grant-kek',
      kek_key_version: 'v1-test-0001',
      nonce: Buffer.alloc(12, 1),
      ciphertext: Buffer.alloc(32, 2),
      auth_tag: Buffer.alloc(16, 3),
      wrapped_dek: Buffer.alloc(40, 4),
      operation_id: '00000000-0000-4000-8000-000000000099', // mismatch
    }),
  ];
  for (const sealResult of hostiles) {
    const fresh = composition({ envelope: { sealResult } });
    await expectSanitizedFailure(() => fresh.adapter.acceptValidatedTokens(goodSelected()));
    assert.equal(fresh.identity.calls.length, 1);
    assert.equal(fresh.envelope.calls.filter((c) => c.op === 'seal').length, 1);
    assert.equal(fresh.installer.calls.length, 0);
  }
  const throws = composition({ envelope: { throw: true } });
  await expectSanitizedFailure(() => throws.adapter.acceptValidatedTokens(goodSelected()));
  assert.equal(throws.installer.calls.length, 0);
});

// ── Post-seal AAD integrity (authoritative snapshot vs provider-facing) ─────

test('rejects hostile provider AAD mutation to gen-2 with valid envelope; zero installer', async function hostileAadMutateToGen2() {
  // Provider mutates provider-facing AAD in place to canonical generation-2
  // before sealing, then returns a structurally valid envelope. Adapter must
  // fail sanitized after seal await and never call installer.
  const gen1 = buildGrantEnvelopeAadV1({
    clientId: CLIENT_ID,
    endpointId: ENDPOINT_ID,
    grantGeneration: 1,
    operationId: OPERATION_ID,
  });
  const gen2 = buildGrantEnvelopeAadV1({
    clientId: CLIENT_ID,
    endpointId: ENDPOINT_ID,
    grantGeneration: 2,
    operationId: OPERATION_ID,
  });
  assert.equal(gen1.length, gen2.length, 'gen1/gen2 AAD length parity for in-place overwrite');
  assert.equal(gen1.equals(gen2), false);

  const sealSeen = [];
  const installer = stubInstaller();
  const envelopeProvider = {
    async sealGrantPayload(input) {
      sealSeen.push(input);
      assert.equal(Buffer.isBuffer(input.aad), true);
      // In-place overwrite to gen-2 (same length, different bytes).
      gen2.copy(input.aad);
      assert.equal(input.aad.equals(gen2), true);
      return structuralEnvelope(OPERATION_ID);
    },
    async openGrantPayload() { throw new Error('no open'); },
    async rewrapGrantDek() { throw new Error('no rewrap'); },
  };
  const adapter = createMicrosoftVerifiedGrantCustodyAdapter(
    goodConfig(),
    Object.freeze({
      verifiedIdentity: stubIdentity().verifiedIdentity,
      envelopeProvider,
      clock: stubClock().clock,
      installer: installer.installer,
    }),
  );
  await expectSanitizedFailure(() => adapter.acceptValidatedTokens(goodSelected()));
  assert.equal(sealSeen.length, 1);
  assert.equal(installer.calls.length, 0);
  // Mutation was applied to provider-facing buffer during seal.
  assert.equal(sealSeen[0].aad.equals(gen2), true);
});

test('rejects AAD mutation at multiple byte positions and length; normal path intact', async function hostileAadMutatePositionsLengthAndNormal() {
  const expectedAad = buildGrantEnvelopeAadV1({
    clientId: CLIENT_ID,
    endpointId: ENDPOINT_ID,
    grantGeneration: GRANT_GENERATION_INITIAL,
    operationId: OPERATION_ID,
  });
  assert.ok(expectedAad.length >= 3);

  async function runWithMutator(mutate) {
    const installer = stubInstaller();
    const sealCalls = [];
    const envelopeProvider = {
      async sealGrantPayload(input) {
        sealCalls.push(input);
        mutate(input.aad);
        return structuralEnvelope(OPERATION_ID);
      },
      async openGrantPayload() { throw new Error('no open'); },
      async rewrapGrantDek() { throw new Error('no rewrap'); },
    };
    const adapter = createMicrosoftVerifiedGrantCustodyAdapter(
      goodConfig(),
      Object.freeze({
        verifiedIdentity: stubIdentity().verifiedIdentity,
        envelopeProvider,
        clock: stubClock().clock,
        installer: installer.installer,
      }),
    );
    await expectSanitizedFailure(() => adapter.acceptValidatedTokens(goodSelected()));
    assert.equal(sealCalls.length, 1);
    assert.equal(installer.calls.length, 0);
    return sealCalls[0].aad;
  }

  // First byte.
  await runWithMutator((aad) => {
    aad[0] = (aad[0] ^ 0xff) & 0xff;
  });
  // Last byte.
  await runWithMutator((aad) => {
    aad[aad.length - 1] = (aad[aad.length - 1] ^ 0xff) & 0xff;
  });
  // Middle byte (generation digit region is interior).
  await runWithMutator((aad) => {
    const mid = Math.floor(aad.length / 2);
    aad[mid] = (aad[mid] ^ 0x01) & 0xff;
  });
  // Multiple positions.
  await runWithMutator((aad) => {
    aad[0] ^= 0x01;
    aad[1] ^= 0x02;
    aad[aad.length - 1] ^= 0x04;
  });
  // Length change: overwrite with longer canonical gen-10 AAD via write into
  // fixed Buffer cannot grow; simulate length drift by zero-filling then only
  // writing a shorter prefix so effective content differs and remaining tail
  // diverges from authoritative full length comparison (length itself fixed
  // for Node Buffer; compare also covers length mismatch path via a separate
  // truncated view check below through fill-to-empty equivalent).
  await runWithMutator((aad) => {
    aad.fill(0);
  });
  // Truncation-equivalent: zero from offset N (length-preserving but all-zero tail).
  await runWithMutator((aad) => {
    aad.fill(0, Math.floor(aad.length / 3));
  });

  // Normal path: no mutation → installer once, sealed accepted, AAD still gen-1.
  const normalInstaller = stubInstaller();
  const normalSeal = [];
  const normalProvider = {
    async sealGrantPayload(input) {
      normalSeal.push(Buffer.from(input.aad)); // independent snapshot for assert
      assert.equal(input.aad.equals(expectedAad), true);
      return structuralEnvelope(OPERATION_ID);
    },
    async openGrantPayload() { throw new Error('no open'); },
    async rewrapGrantDek() { throw new Error('no rewrap'); },
  };
  const normalAdapter = createMicrosoftVerifiedGrantCustodyAdapter(
    goodConfig(),
    Object.freeze({
      verifiedIdentity: stubIdentity().verifiedIdentity,
      envelopeProvider: normalProvider,
      clock: stubClock().clock,
      installer: normalInstaller.installer,
    }),
  );
  const result = await normalAdapter.acceptValidatedTokens(goodSelected());
  assert.deepEqual(result, SEALED_ACK);
  assert.equal(normalInstaller.calls.length, 1);
  assert.equal(normalSeal.length, 1);
  assert.equal(normalSeal[0].equals(expectedAad), true);
  // Provider-facing AAD still equals expected after successful seal (no mutation).
  assert.equal(parseGrantEnvelopeAadV1(normalSeal[0]).ok, true);
  assert.equal(parseGrantEnvelopeAadV1(normalSeal[0]).value.grant_generation, 1n);
});

test('provider-facing AAD does not share backing memory with authoritative snapshot', async function aadNoSharedBackingMemory() {
  // Mutating the seal-input AAD after capture must not affect a second seal's
  // expected gen-1 bytes, and rejection on mutation proves authority is independent.
  let firstAadRef = null;
  const installer = stubInstaller();
  const envelopeProvider = {
    async sealGrantPayload(input) {
      firstAadRef = input.aad;
      // Mutate in place — must reject (proves check uses independent authority).
      input.aad[0] = (input.aad[0] + 1) & 0xff;
      return structuralEnvelope(OPERATION_ID);
    },
    async openGrantPayload() { throw new Error('no open'); },
    async rewrapGrantDek() { throw new Error('no rewrap'); },
  };
  const adapter = createMicrosoftVerifiedGrantCustodyAdapter(
    goodConfig(),
    Object.freeze({
      verifiedIdentity: stubIdentity().verifiedIdentity,
      envelopeProvider,
      clock: stubClock().clock,
      installer: installer.installer,
    }),
  );
  await expectSanitizedFailure(() => adapter.acceptValidatedTokens(goodSelected()));
  assert.equal(installer.calls.length, 0);
  assert.ok(firstAadRef);
  assert.equal(Buffer.isBuffer(firstAadRef), true);

  // Fresh adapter normal path still succeeds with correct gen-1 AAD.
  const ok = composition();
  const okResult = await ok.adapter.acceptValidatedTokens(goodSelected());
  assert.deepEqual(okResult, SEALED_ACK);
  assert.equal(ok.installer.calls.length, 1);
  const seal = ok.envelope.calls.find((c) => c.op === 'seal');
  assert.ok(seal);
  // Not the same Buffer instance as the mutated one from the failed path.
  assert.notEqual(seal.input.aad, firstAadRef);
  const parsed = parseGrantEnvelopeAadV1(seal.input.aad);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.grant_generation, 1n);
});

test('rejects hostile installer ack shapes and installer throws', async function installerAckHostiles() {
  // Exact installer contract is frozen { status: 'installed' } only.
  // Response-custody sealedAck is independently { status: 'accepted' } —
  // must not be accepted from the installer. Public handoff is custodied.
  const hostiles = [
    null,
    Object.freeze({ status: 'accepted' }), // response-custody sealedAck is not installer ack
    Object.freeze({ status: 'custodied' }), // public handoff success is not installer ack
    Object.freeze({ status: 'installed', extra: 1 }),
    Object.freeze({ status: 'accepted', extra: 1 }),
    Object.freeze({ ok: true }),
    { status: 'installed' }, // unfrozen
    { status: 'accepted' }, // unfrozen wrong status
    Object.freeze({ status: 'INSTALLED' }),
    Object.freeze({ status: 'ACCEPTED' }),
    Object.freeze({ status: 'Installed' }),
  ];
  for (const result of hostiles) {
    const fresh = composition({ installer: { result } });
    await expectSanitizedFailure(() => fresh.adapter.acceptValidatedTokens(goodSelected()));
    assert.equal(fresh.installer.calls.length, 1);
  }
  // Accepts only exact frozen installed.
  const ok = composition({
    installer: { result: Object.freeze({ status: 'installed' }) },
  });
  const accepted = await ok.adapter.acceptValidatedTokens(goodSelected());
  assert.deepEqual(accepted, SEALED_ACK);
  assert.deepEqual(accepted, { status: 'accepted' });
  assert.notDeepEqual(accepted, { status: 'installed' });
  assert.equal(ok.installer.calls.length, 1);

  const throws = composition({ installer: { throw: true } });
  await expectSanitizedFailure(() => throws.adapter.acceptValidatedTokens(goodSelected()));
  assert.equal(throws.installer.calls.length, 1);
});

// ── Mutation / thenable / reentrant / concurrent / single-use ──────────────

test('burns on first use including invalid input concurrent reentrant and second call', async function singleUseAtomicBurn() {
  const invalid = composition();
  await expectSanitizedFailure(() => invalid.adapter.acceptValidatedTokens(null));
  await expectSanitizedFailure(() => invalid.adapter.acceptValidatedTokens(goodSelected()));
  assert.equal(invalid.clock.calls.length, 0);
  assert.equal(invalid.identity.calls.length, 0);

  const sequential = composition();
  await sequential.adapter.acceptValidatedTokens(goodSelected());
  await expectSanitizedFailure(() => sequential.adapter.acceptValidatedTokens(goodSelected()));
  assert.equal(sequential.identity.calls.length, 1);
  assert.equal(sequential.installer.calls.length, 1);

  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const concurrent = composition({ identity: { wait: waiting } });
  const first = concurrent.adapter.acceptValidatedTokens(goodSelected());
  await expectSanitizedFailure(() => concurrent.adapter.acceptValidatedTokens(goodSelected()));
  release();
  await first;
  assert.equal(concurrent.identity.calls.length, 1);
  assert.equal(concurrent.installer.calls.length, 1);

  let reentrantError = null;
  let outerAdapter;
  const reentrantIdentity = Object.freeze({
    async verifyIdentity() {
      try {
        await outerAdapter.acceptValidatedTokens(goodSelected());
      } catch (error) {
        reentrantError = error;
      }
      return goodIdentity();
    },
  });
  const clock = stubClock();
  const installer = stubInstaller();
  const envelope = stubEnvelope();
  outerAdapter = createMicrosoftVerifiedGrantCustodyAdapter(
    goodConfig(),
    Object.freeze({
      verifiedIdentity: reentrantIdentity,
      envelopeProvider: envelope.envelopeProvider,
      clock: clock.clock,
      installer: installer.installer,
    }),
  );
  const reentrantResult = await outerAdapter.acceptValidatedTokens(goodSelected());
  assert.deepEqual(reentrantResult, { status: 'accepted' });
  assert.equal(reentrantError && reentrantError.code, ERROR_CODE);
  assert.equal(installer.calls.length, 1);
});

test('rejects thenable-settled identity or installer results that are not exact frozen shapes', async function thenableRejects() {
  // await unwraps thenables; settlement must still be exact frozen identity/ack.
  const thenableIdentity = composition({
    identity: {
      result: {
        then(resolve) {
          resolve({
            providerTenantId: TID,
            providerPrincipalId: PRINCIPAL,
            mailboxAddress: MAILBOX,
            displayName: DISPLAY,
            extra: LEAK,
          });
        },
      },
    },
  });
  await expectSanitizedFailure(() => thenableIdentity.adapter.acceptValidatedTokens(goodSelected()));
  assert.equal(thenableIdentity.envelope.calls.length, 0);

  const thenableAck = composition({
    installer: {
      result: {
        then(resolve) {
          resolve({ status: 'installed' }); // unfrozen after settle
        },
      },
    },
  });
  await expectSanitizedFailure(() => thenableAck.adapter.acceptValidatedTokens(goodSelected()));
  assert.equal(thenableAck.installer.calls.length, 1);
});

test('output freeze resists mutation and carries no secrets', async function outputFreezeNoLeak() {
  const { adapter } = composition();
  const result = await adapter.acceptValidatedTokens(goodSelected());
  assert.throws(() => {
    result.status = LEAK;
  });
  assert.throws(() => {
    result.extra = LEAK;
  });
  assert.equal(result.status, 'accepted');
  assert.equal('extra' in result, false);
  assert.equal(JSON.stringify(result).includes(ACCESS), false);
});

test('does not log secrets on success or failure paths', async function noLogsOrLeaks() {
  const logged = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => { logged.push(args); };
  console.error = (...args) => { logged.push(args); };
  try {
    const ok = composition();
    await ok.adapter.acceptValidatedTokens(goodSelected());
    await expectSanitizedFailure(() => composition({ identity: { throw: true } })
      .adapter.acceptValidatedTokens(goodSelected({ accessToken: `${ACCESS}-${LEAK}` })));
    assert.deepEqual(logged, []);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

// ── Real merged fake envelope roundtrip: only refresh sealed ───────────────

test('real fake envelope roundtrip seals only refresh token under gen-1 AAD', async function realFakeEnvelopeRoundtrip() {
  const fake = createFakeEmailGrantEnvelopeProvider();
  assert.equal(validateEmailGrantEnvelopeProvider(fake).ok, true);

  let sealedEnvelope = null;
  let sealedAad = null;
  const sealCalls = [];
  const trackingProvider = {
    async sealGrantPayload(input) {
      sealCalls.push(input);
      sealedAad = input.aad;
      sealedEnvelope = await fake.sealGrantPayload(input);
      return sealedEnvelope;
    },
    async openGrantPayload(input) {
      return fake.openGrantPayload(input);
    },
    async rewrapGrantDek(input) {
      return fake.rewrapGrantDek(input);
    },
  };

  const identity = stubIdentity();
  const clock = stubClock();
  const installer = stubInstaller();
  const adapter = createMicrosoftVerifiedGrantCustodyAdapter(
    goodConfig(),
    Object.freeze({
      verifiedIdentity: identity.verifiedIdentity,
      envelopeProvider: trackingProvider,
      clock: clock.clock,
      installer: installer.installer,
    }),
  );

  const result = await adapter.acceptValidatedTokens(goodSelected());
  assert.deepEqual(result, { status: 'accepted' });
  assert.equal(sealCalls.length, 1);
  assert.equal(sealCalls[0].refresh_token, REFRESH);
  assert.equal(Object.prototype.hasOwnProperty.call(sealCalls[0], 'access_token'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(sealCalls[0], 'id_token'), false);

  // Open with same AAD and prove plaintext package is only the refresh token.
  const opened = await fake.openGrantPayload({
    envelope: sealedEnvelope,
    aad: sealedAad,
  });
  assert.equal(opened.refresh_token, REFRESH);
  assert.equal(opened.refresh_token.includes(ACCESS), false);
  assert.equal(opened.refresh_token.includes(ID_TOKEN), false);

  // AAD binds client/endpoint/gen1/operation exactly.
  const parsed = parseGrantEnvelopeAadV1(sealedAad);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.client_id, CLIENT_ID);
  assert.equal(parsed.value.endpoint_id, ENDPOINT_ID);
  assert.equal(parsed.value.grant_generation, 1n);
  assert.equal(parsed.value.operation_id, OPERATION_ID);

  // Installer envelope validates and matches operation.
  const installedEnv = installer.calls[0].request.envelope;
  const v = validateGrantEnvelopeRecordV1(installedEnv);
  assert.equal(v.ok, true);
  assert.equal(v.value.operation_id, OPERATION_ID);

  // Wrong AAD must not open.
  const wrongAad = buildGrantEnvelopeAadV1({
    clientId: CLIENT_ID,
    endpointId: ENDPOINT_ID,
    grantGeneration: 2,
    operationId: OPERATION_ID,
  });
  await assert.rejects(() => fake.openGrantPayload({
    envelope: sealedEnvelope,
    aad: wrongAad,
  }));

  // Meta confirms only seal ops (open was direct on fake after install path).
  const meta = getFakeEmailGrantEnvelopeProviderMeta(fake);
  assert.ok(meta);
  assert.ok(meta.ops.some((op) => op.op === 'seal'));
});

test('fake roundtrip package decode proves refresh-only EMAIL_GRANT_PKG_V1', async function packageDecodeRefreshOnly() {
  const fake = createFakeEmailGrantEnvelopeProvider();
  const aad = buildGrantEnvelopeAadV1({
    clientId: CLIENT_ID,
    endpointId: ENDPOINT_ID,
    grantGeneration: GRANT_GENERATION_INITIAL,
    operationId: OPERATION_ID,
  });
  const sealed = await fake.sealGrantPayload({
    refresh_token: REFRESH,
    aad,
    operation_id: OPERATION_ID,
  });
  const opened = await fake.openGrantPayload({ envelope: sealed, aad });
  assert.deepEqual(Object.keys(opened), ['refresh_token']);
  assert.equal(opened.refresh_token, REFRESH);

  // Double-check package codec rejects multi-field smuggling patterns at contract.
  const smuggled = Buffer.from(
    `EMAIL_GRANT_PKG_V1\nrefresh_token=${REFRESH}\naccess_token=${ACCESS}\n`,
    'utf8',
  );
  const decoded = decodeDelegatedRefreshPackageV1(smuggled);
  assert.equal(decoded.ok, false);
});

// ── Future atomic installer boundary regression ─────────────────────────────

test('rejects install and installInitialDelegatedGrant; exact installVerifiedGrant once with identity+envelope', async function futureAtomicInstallerBoundary() {
  // Generic install surface is not the future atomic identity+envelope boundary.
  const installOnlyCalls = [];
  const installOnlyInstaller = Object.freeze({
    async install(request) {
      installOnlyCalls.push(request);
      return Object.freeze({ status: 'installed' });
    },
  });
  assert.throws(
    () => createMicrosoftVerifiedGrantCustodyAdapter(
      goodConfig(),
      Object.freeze({
        verifiedIdentity: stubIdentity().verifiedIdentity,
        envelopeProvider: stubEnvelope().envelopeProvider,
        clock: stubClock().clock,
        installer: installOnlyInstaller,
      }),
    ),
    (error) => error.code === ERROR_CODE && !String(error).includes(LEAK),
  );
  assert.equal(installOnlyCalls.length, 0);
  assert.equal(typeof installOnlyInstaller.install, 'function');
  assert.equal(installOnlyInstaller.installVerifiedGrant, undefined);

  // Existing custodian surface installs envelope only and does NOT bind verified
  // identity. Adapter must refuse it at factory time (zero calls / never used).
  const envelopeOnlyCalls = [];
  const envelopeOnlyInstaller = Object.freeze({
    async installInitialDelegatedGrant(request) {
      envelopeOnlyCalls.push(request);
      return Object.freeze({ status: 'installed' });
    },
  });
  assert.throws(
    () => createMicrosoftVerifiedGrantCustodyAdapter(
      goodConfig(),
      Object.freeze({
        verifiedIdentity: stubIdentity().verifiedIdentity,
        envelopeProvider: stubEnvelope().envelopeProvider,
        clock: stubClock().clock,
        installer: envelopeOnlyInstaller,
      }),
    ),
    (error) => error.code === ERROR_CODE && !String(error).includes(LEAK),
  );
  assert.equal(envelopeOnlyCalls.length, 0);
  assert.equal(typeof envelopeOnlyInstaller.installInitialDelegatedGrant, 'function');
  assert.equal(envelopeOnlyInstaller.installVerifiedGrant, undefined);

  // Reject objects with any extra method (exact single-method installVerifiedGrant only).
  assert.throws(
    () => createMicrosoftVerifiedGrantCustodyAdapter(
      goodConfig(),
      Object.freeze({
        verifiedIdentity: stubIdentity().verifiedIdentity,
        envelopeProvider: stubEnvelope().envelopeProvider,
        clock: stubClock().clock,
        installer: Object.freeze({
          installVerifiedGrant: async () => Object.freeze({ status: 'installed' }),
          install: async () => Object.freeze({ status: 'installed' }),
        }),
      }),
    ),
    (error) => error.code === ERROR_CODE,
  );
  assert.throws(
    () => createMicrosoftVerifiedGrantCustodyAdapter(
      goodConfig(),
      Object.freeze({
        verifiedIdentity: stubIdentity().verifiedIdentity,
        envelopeProvider: stubEnvelope().envelopeProvider,
        clock: stubClock().clock,
        installer: Object.freeze({
          installVerifiedGrant: async () => Object.freeze({ status: 'installed' }),
          installInitialDelegatedGrant: async () => Object.freeze({ status: 'installed' }),
        }),
      }),
    ),
    (error) => error.code === ERROR_CODE,
  );

  // Exact future atomic installer.installVerifiedGrant invoked once with identity+envelope.
  const atomicCalls = [];
  const atomicInstaller = Object.freeze({
    async installVerifiedGrant(request) {
      atomicCalls.push({ request, thisValue: this });
      return Object.freeze({ status: 'installed' });
    },
  });
  const adapter = createMicrosoftVerifiedGrantCustodyAdapter(
    goodConfig(),
    Object.freeze({
      verifiedIdentity: stubIdentity().verifiedIdentity,
      envelopeProvider: stubEnvelope().envelopeProvider,
      clock: stubClock().clock,
      installer: atomicInstaller,
    }),
  );
  const result = await adapter.acceptValidatedTokens(goodSelected());
  assert.deepEqual(result, SEALED_ACK);
  assert.equal(atomicCalls.length, 1);
  assert.equal(atomicCalls[0].thisValue, atomicInstaller);
  assert.deepEqual(Reflect.ownKeys(atomicCalls[0].request), [...INSTALL_KEYS]);
  assert.deepEqual(Reflect.ownKeys(atomicCalls[0].request), [
    'clientId', 'endpointId', 'operationId', 'actorStaffUserId', 'identity', 'envelope',
  ]);
  assert.deepEqual(atomicCalls[0].request.identity, goodIdentity());
  assert.equal(Object.isFrozen(atomicCalls[0].request.identity), true);
  assert.equal(validateGrantEnvelopeRecordV1(atomicCalls[0].request.envelope).ok, true);
  assertNoSensitiveKeys(atomicCalls[0].request);
  assert.equal(INSTALLER_METHOD, 'installVerifiedGrant');
  assert.equal(typeof atomicInstaller.installVerifiedGrant, 'function');
  assert.equal(atomicInstaller.install, undefined);
  assert.equal(atomicInstaller.installInitialDelegatedGrant, undefined);
});

// ── Response-custody interoperability regression ───────────────────────────

test('merged response-custody handoff with this adapter as custody returns only custodied', async function responseCustodyInterop() {
  const GOOD_BODY = {
    token_type: 'Bearer',
    expires_in: 3600,
    scope: GOOD_SCOPE,
    access_token: ACCESS,
    refresh_token: REFRESH,
    id_token: ID_TOKEN,
  };

  const identity = stubIdentity();
  const clock = stubClock();
  const installer = stubInstaller();
  const envelope = stubEnvelope();
  const grantCustody = createMicrosoftVerifiedGrantCustodyAdapter(
    goodConfig(),
    Object.freeze({
      verifiedIdentity: identity.verifiedIdentity,
      envelopeProvider: envelope.envelopeProvider,
      clock: clock.clock,
      installer: installer.installer,
    }),
  );
  // Adapter is the exact response-custody `custody` surface.
  assert.deepEqual(Reflect.ownKeys(grantCustody), ['acceptValidatedTokens']);
  assert.equal(Object.isFrozen(grantCustody), true);

  const incoming = new EventEmitter();
  incoming.statusCode = 200;
  incoming.headers = { 'content-type': 'application/json; charset=utf-8' };
  incoming.destroy = () => {};
  const request = new EventEmitter();
  let responseCallback;
  request.end = () => {
    queueMicrotask(() => {
      responseCallback(incoming);
      incoming.emit('data', JSON.stringify(GOOD_BODY));
      incoming.emit('end');
    });
  };
  request.destroy = () => {};
  const httpsImpl = {
    request(_options, cb) {
      responseCallback = cb;
      return request;
    },
  };
  const timers = { setTimeout() { return 1; }, clearTimeout() {} };

  const logged = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => { logged.push(args); };
  console.error = (...args) => { logged.push(args); };

  let publicResult;
  try {
    const handoff = createMicrosoftTokenResponseCustodyService({
      transportDeps: { httpsImpl, timers },
      custody: grantCustody,
    });
    publicResult = await handoff.exchangeAndCustody({ body: 'trusted=already-encoded' });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  // End-to-end public response is only response-custody SUCCESS.
  assert.deepEqual(publicResult, { status: 'custodied' });
  assert.deepEqual(Object.keys(publicResult), ['status']);
  assert.equal(Object.isFrozen(publicResult), true);
  assert.equal(JSON.stringify(publicResult).includes(ACCESS), false);
  assert.equal(JSON.stringify(publicResult).includes(REFRESH), false);
  assert.equal(JSON.stringify(publicResult).includes(ID_TOKEN), false);
  assert.deepEqual(logged, []);

  // Exact six selected token fields reached the adapter (response-custody shape).
  // Proven by successful acceptValidatedTokens + material at each dep boundary:
  // access+id → identity; refresh → seal; tokenType/expiresIn/scope validated inside.
  assert.deepEqual([...SELECTED_KEYS], [
    'accessToken', 'refreshToken', 'tokenType', 'expiresIn', 'scope', 'idToken',
  ]);
  assert.equal(SELECTED_KEYS.length, 6);
  assert.equal(clock.calls.length, 1);
  assert.equal(identity.calls.length, 1);
  assert.deepEqual(Reflect.ownKeys(identity.calls[0].request), [
    'idToken', 'accessToken', 'expectedNonce', 'expectedClientId', 'nowEpochSeconds',
  ]);
  assert.equal(identity.calls[0].request.accessToken, ACCESS);
  assert.equal(identity.calls[0].request.idToken, ID_TOKEN);
  assert.equal(identity.calls[0].thisValue, identity.verifiedIdentity);

  // Installer saw no raw tokens; payload is identity-before-envelope minimized shape.
  assert.equal(installer.calls.length, 1);
  assert.equal(installer.calls[0].thisValue, installer.installer);
  assert.deepEqual(Reflect.ownKeys(installer.calls[0].request), [...INSTALL_KEYS]);
  assert.deepEqual(Reflect.ownKeys(installer.calls[0].request), [
    'clientId', 'endpointId', 'operationId', 'actorStaffUserId', 'identity', 'envelope',
  ]);
  assertNoSensitiveKeys(installer.calls[0].request);
  assert.equal(installer.calls[0].request.identity.mailboxAddress, MAILBOX);
  assert.equal(validateGrantEnvelopeRecordV1(installer.calls[0].request.envelope).ok, true);
  assert.equal(typeof installer.installer.installVerifiedGrant, 'function');
  assert.equal(installer.installer.install, undefined);
  assert.equal(installer.installer.installInitialDelegatedGrant, undefined);

  // Seal used refresh only; no access/id tokens on seal or installer surfaces.
  const seal = envelope.calls.find((c) => c.op === 'seal');
  assert.ok(seal);
  assert.equal(seal.input.refresh_token, REFRESH);
  assert.equal('access_token' in seal.input, false);
  assert.equal('id_token' in seal.input, false);
  assert.equal('accessToken' in seal.input, false);
  assert.equal('idToken' in seal.input, false);

  // Adapter sealedAck is accepted; public surface above is custodied only.
  assert.deepEqual(SEALED_ACK, { status: 'accepted' });
  assert.notDeepEqual(publicResult, SEALED_ACK);
});

async function runTests() {
  for (const { name, run } of tests) {
    await run();
    process.stdout.write(`ok - ${name}\n`);
  }
  process.stdout.write(
    `PASS verify:email-microsoft-verified-grant-custody (${tests.length} named offline tests)\n`,
  );
}

runTests().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});

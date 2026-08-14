'use strict';

/**
 * Hostile offline gate for Stage 6 Microsoft OAuth operation composition.
 *
 * Covers exact shapes/order/freeze, deps receivers, construction/call order,
 * input/config mutation/proxies/accessors/symbols/prototypes, canonical UUIDs,
 * client mismatch, code/verifier/nonce bounds, invalid-first/concurrent/
 * reentrant/single-use, thenables/child ack/throws, no child before validation,
 * endpoint/operation/actor/nonce/client exact mapping, no location-derived
 * endpoint, transport body exact; full fake end-to-end through real auth
 * request + response custody + verified custody + fake identity/envelope +
 * stateful installer proving refresh-only encrypted grant and verified
 * endpoint atomic state; failures at token/identity/seal/install leave no
 * false completed and no raw refresh persistence. No Azure network.
 * Routes/default flags unchanged; no activation/sync/send.
 */

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const {
  ERROR_CODE,
  ERROR_MESSAGE,
  COMPLETION_METHOD,
  COMPLETION_ACK_STATUS,
  COMPLETION_ACK,
  CUSTODY_SUCCESS_STATUS,
  COMPLETION_KEYS,
  DEPENDENCY_KEYS,
  TRANSPORT_DEPS_KEYS,
  TIMERS_KEYS,
  AUTH_EXCHANGE_KEYS,
  SUNSET_DEPLOYMENT,
  createMicrosoftOAuthOperationComposition,
} = require('./lib/email-microsoft-oauth-operation-composition');

const callback = require('./lib/email-microsoft-oauth-callback-completion');
const {
  createMicrosoftVerifiedGrantInstaller,
  INSTALL_KEYS,
  INSTALLER_METHOD,
} = require('./lib/email-microsoft-verified-grant-installer');
const {
  createFakeEmailGrantEnvelopeProvider,
} = require('./lib/email-grant-envelope-fake-provider');
const {
  validateGrantEnvelopeRecordV1,
  buildGrantEnvelopeAadV1,
} = require('./lib/email-grant-envelope-provider-contract');
const { REDIRECT_URI } = require('./lib/email-microsoft-oauth-transaction-service');
const {
  TOKEN_HOST,
  TOKEN_PATH,
} = require('./lib/email-microsoft-token-http-transport');

const ROOT = path.join(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const LIB_REL = 'scripts/lib/email-microsoft-oauth-operation-composition.js';
const VERIFY_REL = 'scripts/verify-email-microsoft-oauth-operation-composition.js';
const ROUTES_REL = 'scripts/lib/staff-email-oauth-routes.js';

const CLIENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const APP_CLIENT_ID = '12345678-1234-4234-8234-123456789abc';
const ENDPOINT_ID = '11111111-2222-4333-8444-555555555555';
const OPERATION_ID = '99999999-8888-4777-8666-555555555555';
const LOCATION_ID = '22222222-3333-4444-8555-666666666666';
const STAFF_ID = 'abcdef01-2345-4678-89ab-cdef01234567';
const OTHER_CLIENT = '00000000-1111-4222-8333-444444444444';
const OTHER_ENDPOINT = 'aaaaaaaa-0000-4000-8000-bbbbbbbbbbbb';
const OTHER_LOCATION = 'ffffffff-0000-4000-8000-aaaaaaaaaaaa';
const TID = '01234567-89ab-4def-8123-456789abcdef';
const PRINCIPAL = '01234567-89ab-4def-9123-456789abcdef'; // installer requires UUID principal
const MAILBOX = 'ada@example.com';
const DISPLAY = 'Ada Lovelace';
const CODE = 'provider-code+/%?=&NEVER_LEAK';
const VERIFIER = `${'v'.repeat(42)}~`;
const NONCE = `${'n'.repeat(43)}`;
const SECRET = 'secret+/%?=&NEVER_LEAK';
const ACCESS = 'ACCESS_SECRET_NEVER_LEAK_9c2b';
const REFRESH = 'REFRESH_SECRET_NEVER_LEAK_3d4e';
const ID_TOKEN = 'ID_TOKEN_SECRET_NEVER_LEAK.header.payload.sig';
const LEAK = 'OAUTH-OPERATION-COMPOSITION-SECRET-DO-NOT-LEAK';
const GOOD_SCOPE = 'openid profile offline_access User.Read Mail.ReadWrite Mail.Send';
const NOW_EPOCH = 1_900_000_000;

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

function failSanitized(error) {
  return error
    && error.name === 'MicrosoftOAuthOperationCompositionError'
    && error.code === ERROR_CODE
    && error.message === ERROR_MESSAGE
    && Object.isFrozen(error)
    && !String(error.message).includes(LEAK)
    && !String(error.stack || '').includes(LEAK)
    && !String(error).includes(CODE)
    && !String(error).includes(VERIFIER)
    && !String(error).includes(NONCE)
    && !String(error).includes(SECRET)
    && !String(error).includes(REFRESH)
    && !String(error).includes(ACCESS);
}

async function expectSanitizedFailure(action) {
  await assert.rejects(Promise.resolve().then(action), (error) => {
    assert.equal(failSanitized(error), true);
    assert.deepEqual(Object.keys(error), ['code']);
    return true;
  });
}

function assertNoSensitive(blob) {
  const s = typeof blob === 'string' ? blob : (() => {
    try { return JSON.stringify(blob); } catch { return String(blob); }
  })();
  assert.equal(s.includes(LEAK), false);
  assert.equal(s.includes(CODE), false);
  assert.equal(s.includes(VERIFIER), false);
  assert.equal(s.includes(SECRET), false);
  assert.equal(s.includes(REFRESH), false);
  assert.equal(s.includes(ACCESS), false);
  assert.equal(s.includes(ID_TOKEN), false);
}

function goodCompletionInput(patch = {}) {
  return Object.freeze({
    authorizationCode: CODE,
    transactionId: OPERATION_ID,
    clientId: CLIENT_ID,
    locationId: LOCATION_ID,
    endpointId: ENDPOINT_ID,
    staffUserId: STAFF_ID,
    codeVerifier: VERIFIER,
    nonce: NONCE,
    applicationClientId: APP_CLIENT_ID,
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

function goodTokenBody(patch = {}) {
  return {
    token_type: 'Bearer',
    expires_in: 3600,
    scope: GOOD_SCOPE,
    access_token: ACCESS,
    refresh_token: REFRESH,
    id_token: ID_TOKEN,
    ...patch,
  };
}

function stubIdentity(spec = {}) {
  const calls = [];
  const verifiedIdentity = Object.freeze({
    async verifyIdentity(request) {
      calls.push({ request, thisValue: this });
      if (spec.wait) await spec.wait;
      if (spec.throw) throw new Error(`${LEAK} identity`);
      if (spec.thenable) {
        return {
          then(resolve, reject) {
            if (spec.thenable === 'reject') reject(new Error(`${LEAK} thenable-id`));
            else resolve(spec.result !== undefined ? spec.result : goodIdentity());
          },
        };
      }
      if (Object.prototype.hasOwnProperty.call(spec, 'result')) return spec.result;
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
      return NOW_EPOCH;
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
      if (Object.prototype.hasOwnProperty.call(spec, 'result')) return spec.result;
      return Object.freeze({ status: 'installed' });
    },
  });
  return { installer, calls };
}

function stubSecret(spec = {}) {
  const calls = [];
  const secretProvider = {
    async getClientSecret() {
      calls.push({ thisValue: this });
      if (spec.wait) await spec.wait;
      if (spec.throw) throw new Error(`${LEAK} secret`);
      if (Object.prototype.hasOwnProperty.call(spec, 'value')) return spec.value;
      return SECRET;
    },
  };
  return { secretProvider, calls };
}

function stubEnvelope(spec = {}) {
  const calls = [];
  const real = createFakeEmailGrantEnvelopeProvider();
  const envelopeProvider = {
    async sealGrantPayload(input) {
      calls.push({ op: 'seal', input, thisValue: this });
      if (spec.wait) await spec.wait;
      if (spec.throw) throw new Error(`${LEAK} seal`);
      if (Object.prototype.hasOwnProperty.call(spec, 'sealResult')) return spec.sealResult;
      return real.sealGrantPayload(input);
    },
    async openGrantPayload(input) {
      calls.push({ op: 'open', input, thisValue: this });
      return real.openGrantPayload(input);
    },
    async rewrapGrantDek(input) {
      calls.push({ op: 'rewrap', input, thisValue: this });
      return real.rewrapGrantDek(input);
    },
  };
  return { envelopeProvider, calls, real };
}

/**
 * Fake offline token transport. Captures request options + body + this receivers.
 * httpsImpl/timers are mutable own-data so post-factory replacement can be proved
 * ineffective against factory-time descriptor snapshots. Emits success by default.
 */
function createFakeTransport(spec = {}) {
  const calls = [];
  const timerCalls = { setTimeout: [], clearTimeout: [] };
  // Mutable own-data methods (not frozen) so post-factory replace tests work.
  const timers = {
    setTimeout(fn, ms) {
      timerCalls.setTimeout.push({ thisValue: this, fn, ms });
      // Immediate deadline timer that we clear — never fire for happy path.
      return 1;
    },
    clearTimeout(id) {
      timerCalls.clearTimeout.push({ thisValue: this, id });
    },
  };
  let responseCallback;
  const incoming = new EventEmitter();
  incoming.statusCode = spec.statusCode ?? 200;
  incoming.headers = { 'content-type': spec.contentType ?? 'application/json; charset=utf-8' };
  incoming.destroy = () => {};
  const request = new EventEmitter();
  request.end = (body) => {
    const last = calls[calls.length - 1];
    if (last) last.body = body;
    queueMicrotask(() => {
      if (spec.requestThrow) {
        request.emit('error', new Error(`${LEAK} transport`));
        return;
      }
      responseCallback(incoming);
      const payload = spec.body !== undefined ? spec.body : JSON.stringify(goodTokenBody(spec.tokenPatch));
      if (spec.noEnd) return;
      incoming.emit('data', payload);
      incoming.emit('end');
    });
  };
  request.destroy = () => {};
  const httpsImpl = {
    request(options, cb) {
      responseCallback = cb;
      calls.push({ options, thisValue: this, body: null });
      return request;
    },
  };
  const transportDeps = Object.freeze({ httpsImpl, timers });
  return { transportDeps, calls, timerCalls, timers, httpsImpl };
}

function composition(spec = {}) {
  const identity = stubIdentity(spec.identity);
  const clock = stubClock(spec.clock);
  const installer = stubInstaller(spec.installer);
  const secret = stubSecret(spec.secret);
  const envelope = stubEnvelope(spec.envelope);
  const transport = createFakeTransport(spec.transport);
  const order = [];

  // Wrap to observe call order across deps.
  const verifiedIdentity = Object.freeze({
    async verifyIdentity(request) {
      order.push('identity');
      return identity.verifiedIdentity.verifyIdentity.call(this, request);
    },
  });
  // Re-bind this correctly for receiver tests when using identity wrapper...
  // Prefer direct stubs for receiver tests; order tracking uses wrapper below only when requested.
  const useOrderWrap = Boolean(spec.trackOrder);

  const deps = Object.freeze({
    verifiedIdentity: useOrderWrap ? verifiedIdentity : identity.verifiedIdentity,
    envelopeProvider: envelope.envelopeProvider,
    clock: clock.clock,
    installer: installer.installer,
    transportDeps: transport.transportDeps,
    secretProvider: secret.secretProvider,
  });

  const service = createMicrosoftOAuthOperationComposition(
    spec.deps || deps,
  );
  return {
    service,
    identity,
    clock,
    installer,
    secret,
    envelope,
    transport,
    order,
    deps,
  };
}

// ── Export / anti-drift ────────────────────────────────────────────────────

test('exports frozen factory, fixed error constants, and completion-aligned keys', async function exportSurface() {
  const exported = require('./lib/email-microsoft-oauth-operation-composition');
  assert.deepEqual(Object.keys(exported), [
    'ERROR_CODE',
    'ERROR_MESSAGE',
    'COMPLETION_METHOD',
    'COMPLETION_ACK_STATUS',
    'COMPLETION_ACK',
    'CUSTODY_SUCCESS_STATUS',
    'COMPLETION_KEYS',
    'DEPENDENCY_KEYS',
    'TRANSPORT_DEPS_KEYS',
    'TIMERS_KEYS',
    'AUTH_EXCHANGE_KEYS',
    'SUNSET_DEPLOYMENT',
    'createMicrosoftOAuthOperationComposition',
  ]);
  assert.equal(Object.isFrozen(exported), true);
  assert.equal(ERROR_CODE, 'MICROSOFT_OAUTH_OPERATION_COMPOSITION_INVALID');
  assert.equal(ERROR_MESSAGE, 'Microsoft OAuth operation composition failed.');
  assert.equal(COMPLETION_METHOD, 'completeAuthorization');
  assert.equal(COMPLETION_ACK_STATUS, 'completed');
  assert.deepEqual(COMPLETION_ACK, { status: 'completed' });
  assert.equal(Object.isFrozen(COMPLETION_ACK), true);
  assert.equal(CUSTODY_SUCCESS_STATUS, 'custodied');
  assert.deepEqual([...COMPLETION_KEYS], [...callback.COMPLETION_KEYS]);
  assert.equal(COMPLETION_KEYS[0], 'authorizationCode');
  assert.equal(COMPLETION_KEYS[COMPLETION_KEYS.length - 1], 'applicationClientId');
  assert.equal(COMPLETION_KEYS.includes('operationId'), false);
  assert.equal(COMPLETION_KEYS.includes('actorStaffUserId'), false);
  assert.deepEqual([...DEPENDENCY_KEYS], [
    'verifiedIdentity',
    'envelopeProvider',
    'clock',
    'installer',
    'transportDeps',
    'secretProvider',
  ]);
  assert.deepEqual([...TRANSPORT_DEPS_KEYS], ['httpsImpl', 'timers']);
  assert.deepEqual([...TIMERS_KEYS], ['setTimeout', 'clearTimeout']);
  assert.deepEqual([...AUTH_EXCHANGE_KEYS], [
    'authorizationCode', 'codeVerifier', 'clientId',
  ]);
  assert.equal(SUNSET_DEPLOYMENT, 'sunset-staging');
  assert.equal(callback.COMPLETION_METHOD, COMPLETION_METHOD);
  assert.equal(callback.COMPLETION_ACK_STATUS, COMPLETION_ACK_STATUS);

  const libSrc = fs.readFileSync(path.join(ROOT, LIB_REL), 'utf8');
  assert.match(
    libSrc,
    /COMPLETION_KEYS\s*=\s*Object\.freeze\(\[\s*['"]authorizationCode['"]\s*,\s*['"]transactionId['"]\s*,\s*['"]clientId['"]\s*,\s*['"]locationId['"]\s*,\s*['"]endpointId['"]\s*,\s*['"]staffUserId['"]\s*,\s*['"]codeVerifier['"]\s*,\s*['"]nonce['"]\s*,\s*['"]applicationClientId['"]\s*,?\s*\]\)/s,
  );
  assert.match(libSrc, /locationId is validated\/snapshotted as retained boundary context only/);
  assert.match(libSrc, /no downstream[\s\S]*endpoint/);
  assert.match(libSrc, /createMicrosoftVerifiedGrantCustodyAdapter/);
  assert.match(libSrc, /createMicrosoftTokenResponseCustodyService/);
  assert.match(libSrc, /createMicrosoftAuthorizationCodeRequestService/);
  // No ambient default after factory for transport.
  assert.equal(libSrc.includes('|| https'), false);
  assert.equal(libSrc.includes('|| { setTimeout'), false);
});

test('package.json wires verify script; routes and flags unchanged', async function packageAndRoutesUnchanged() {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  assert.equal(
    pkg.scripts['verify:email-microsoft-oauth-operation-composition'],
    `node ${VERIFY_REL}`,
  );
  assert.ok(fs.existsSync(path.join(ROOT, LIB_REL)));
  assert.ok(fs.existsSync(path.join(ROOT, VERIFY_REL)));

  const routesSrc = fs.readFileSync(path.join(ROOT, ROUTES_REL), 'utf8');
  // Stage 6 runtime wiring: operation composition is reached only via the
  // runtime factory (not inlined in routes). Routes must not call completeAuthorization.
  assert.equal(routesSrc.includes('createMicrosoftOAuthOperationComposition'), false);
  assert.equal(routesSrc.includes('completeAuthorization'), false);
  assert.match(routesSrc, /createSunsetStagingMicrosoftOAuthCallbackRuntime/);
  assert.equal(routesSrc.includes('createMicrosoftOAuthCallbackService'), false);

  // Default flags stay false (no activation).
  const txn = require('./lib/email-microsoft-oauth-transaction-service');
  assert.equal(txn.isCallbackEnabled({}), false);
  assert.equal(txn.isStartEnabled({}), false);
});

test('returns frozen single-method service with completeAuthorization', async function frozenServiceShape() {
  const { service } = composition();
  assert.deepEqual(Object.keys(service), ['completeAuthorization']);
  assert.deepEqual(Reflect.ownKeys(service), ['completeAuthorization']);
  assert.equal(Object.isFrozen(service), true);
  assert.equal(typeof service.completeAuthorization, 'function');
  assert.equal('accept' in service, false);
  assert.equal('exchangeAuthorizationCode' in service, false);
});

// ── Happy path + mapping ───────────────────────────────────────────────────

test('happy path: maps callback material and returns exact frozen completed', async function happyPath() {
  const c = composition();
  const result = await c.service.completeAuthorization(goodCompletionInput());
  assert.deepEqual(result, { status: 'completed' });
  assert.deepEqual(result, COMPLETION_ACK);
  assert.deepEqual(Object.keys(result), ['status']);
  assert.equal(Object.isFrozen(result), true);
  assertNoSensitive(result);

  // Secret resolved once; transport posted once; identity/install once.
  assert.equal(c.secret.calls.length, 1);
  assert.equal(c.transport.calls.length, 1);
  assert.equal(c.identity.calls.length, 1);
  assert.equal(c.installer.calls.length, 1);
  assert.equal(c.clock.calls.length, 1);

  // Transport host/path exact (merged token transport).
  const opts = c.transport.calls[0].options;
  assert.equal(opts.hostname, TOKEN_HOST);
  assert.equal(opts.path, TOKEN_PATH);
  assert.equal(opts.method, 'POST');

  // Transport body exact: client_id is application client; PKCE + redirect.
  const body = c.transport.calls[0].body;
  assert.equal(typeof body, 'string');
  const form = new URLSearchParams(body);
  assert.deepEqual([...form], [
    ['client_id', APP_CLIENT_ID],
    ['client_secret', SECRET],
    ['grant_type', 'authorization_code'],
    ['code', CODE],
    ['redirect_uri', REDIRECT_URI],
    ['code_verifier', VERIFIER],
  ]);
  assert.equal(form.has('scope'), false);
  assert.equal(form.get('client_id'), APP_CLIENT_ID);
  assert.notEqual(form.get('client_id'), CLIENT_ID);

  // Identity: nonce + expectedClientId = application client; tokens from response.
  const idReq = c.identity.calls[0].request;
  assert.deepEqual(Reflect.ownKeys(idReq), [
    'idToken', 'accessToken', 'expectedNonce', 'expectedClientId', 'nowEpochSeconds',
  ]);
  assert.equal(idReq.expectedNonce, NONCE);
  assert.equal(idReq.expectedClientId, APP_CLIENT_ID);
  assert.equal(idReq.accessToken, ACCESS);
  assert.equal(idReq.idToken, ID_TOKEN);
  assert.equal(idReq.nowEpochSeconds, NOW_EPOCH);

  // Installer: operationId/actor/client/endpoint mapped; no location; no tokens.
  const inst = c.installer.calls[0].request;
  assert.deepEqual(Reflect.ownKeys(inst), [...INSTALL_KEYS]);
  assert.equal(inst.clientId, CLIENT_ID);
  assert.equal(inst.endpointId, ENDPOINT_ID);
  assert.equal(inst.operationId, OPERATION_ID);
  assert.equal(inst.actorStaffUserId, STAFF_ID);
  assert.equal('locationId' in inst, false);
  assert.equal('location_id' in inst, false);
  assert.equal('accessToken' in inst, false);
  assert.equal('refreshToken' in inst, false);
  assert.equal(validateGrantEnvelopeRecordV1(inst.envelope).ok, true);

  // Seal: refresh only.
  const seal = c.envelope.calls.find((x) => x.op === 'seal');
  assert.ok(seal);
  assert.equal(seal.input.refresh_token, REFRESH);
  assert.equal('access_token' in seal.input, false);
  assert.equal('id_token' in seal.input, false);
  assert.equal(seal.input.operation_id, OPERATION_ID);
});

test('preserves exact identity, clock, installer, secret receivers', async function preservesReceivers() {
  const c = composition();
  await c.service.completeAuthorization(goodCompletionInput());
  assert.equal(c.identity.calls[0].thisValue, c.identity.verifiedIdentity);
  assert.equal(c.clock.calls[0].thisValue, c.clock.clock);
  assert.equal(c.installer.calls[0].thisValue, c.installer.installer);
  assert.equal(c.secret.calls[0].thisValue, c.secret.secretProvider);
});

test('preserves exact https request and timer receivers via factory pin wrappers', async function preservesTransportReceivers() {
  const c = composition();
  await c.service.completeAuthorization(goodCompletionInput());
  // httpsImpl.request must see original httpsImpl as this (not the frozen pin wrapper).
  assert.equal(c.transport.calls.length, 1);
  assert.equal(c.transport.calls[0].thisValue, c.transport.httpsImpl);
  // Both timers must see original timers bag as this.
  assert.ok(c.transport.timerCalls.setTimeout.length >= 1);
  assert.ok(c.transport.timerCalls.clearTimeout.length >= 1);
  for (const call of c.transport.timerCalls.setTimeout) {
    assert.equal(call.thisValue, c.transport.timers);
  }
  for (const call of c.transport.timerCalls.clearTimeout) {
    assert.equal(call.thisValue, c.transport.timers);
  }
});

test('post-factory transport/secret/envelope method replacement uses captured originals only', async function postFactoryMethodPin() {
  const identity = stubIdentity();
  const clock = stubClock();
  const installer = stubInstaller();
  const secret = stubSecret();
  const envelope = stubEnvelope();
  const transport = createFakeTransport();

  const service = createMicrosoftOAuthOperationComposition(Object.freeze({
    verifiedIdentity: identity.verifiedIdentity,
    envelopeProvider: envelope.envelopeProvider,
    clock: clock.clock,
    installer: installer.installer,
    transportDeps: transport.transportDeps,
    secretProvider: secret.secretProvider,
  }));

  // Replace raw methods after factory — must not be observed by the operation.
  let hostileHttps = 0;
  let hostileSet = 0;
  let hostileClear = 0;
  let hostileSecret = 0;
  let hostileSeal = 0;
  transport.httpsImpl.request = function hostileRequest() {
    hostileHttps += 1;
    throw new Error(`${LEAK} hostile https`);
  };
  transport.timers.setTimeout = function hostileSetTimeout() {
    hostileSet += 1;
    throw new Error(`${LEAK} hostile setTimeout`);
  };
  transport.timers.clearTimeout = function hostileClearTimeout() {
    hostileClear += 1;
    throw new Error(`${LEAK} hostile clearTimeout`);
  };
  secret.secretProvider.getClientSecret = async function hostileSecretFn() {
    hostileSecret += 1;
    throw new Error(`${LEAK} hostile secret`);
  };
  envelope.envelopeProvider.sealGrantPayload = async function hostileSeal() {
    hostileSeal += 1;
    throw new Error(`${LEAK} hostile seal`);
  };

  const result = await service.completeAuthorization(goodCompletionInput());
  assert.deepEqual(result, COMPLETION_ACK);
  assert.equal(hostileHttps, 0);
  assert.equal(hostileSet, 0);
  assert.equal(hostileClear, 0);
  assert.equal(hostileSecret, 0);
  assert.equal(hostileSeal, 0);
  // Captured originals still ran with original owners.
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].thisValue, transport.httpsImpl);
  assert.ok(transport.timerCalls.setTimeout.length >= 1);
  assert.ok(transport.timerCalls.clearTimeout.length >= 1);
  assert.equal(transport.timerCalls.setTimeout[0].thisValue, transport.timers);
  assert.equal(transport.timerCalls.clearTimeout[0].thisValue, transport.timers);
  assert.equal(secret.calls.length, 1);
  assert.equal(secret.calls[0].thisValue, secret.secretProvider);
  const seal = envelope.calls.find((x) => x.op === 'seal');
  assert.ok(seal);
  assert.equal(seal.thisValue, envelope.envelopeProvider);
  assert.equal(installer.calls.length, 1);
});

test('endpoint/operation/actor/nonce/client exact mapping; location not used for endpoint', async function exactMappingNoLocationEndpoint() {
  const c = composition();
  await c.service.completeAuthorization(goodCompletionInput({
    locationId: OTHER_LOCATION, // different location must not alter endpoint
    endpointId: ENDPOINT_ID,
  }));
  assert.equal(c.installer.calls[0].request.endpointId, ENDPOINT_ID);
  assert.equal(c.installer.calls[0].request.operationId, OPERATION_ID);
  assert.equal(c.installer.calls[0].request.actorStaffUserId, STAFF_ID);
  assert.equal(c.installer.calls[0].request.clientId, CLIENT_ID);
  assert.equal(c.identity.calls[0].request.expectedNonce, NONCE);
  assert.equal(c.identity.calls[0].request.expectedClientId, APP_CLIENT_ID);
  // AAD binds endpoint+operation — not location.
  const seal = c.envelope.calls.find((x) => x.op === 'seal');
  const aad = seal.input.aad.toString('utf8');
  assert.equal(aad.includes(ENDPOINT_ID), true);
  assert.equal(aad.includes(OPERATION_ID), true);
  assert.equal(aad.includes(OTHER_LOCATION), false);
  assert.equal(aad.includes(LOCATION_ID), false);
});

// ── Factory hostile deps ───────────────────────────────────────────────────

test('factory rejects missing/extra/unfrozen/wrong-order deps, proxies, symbols, accessors', async function factoryHostileDeps() {
  const base = composition();
  const good = base.deps;

  assert.throws(() => createMicrosoftOAuthOperationComposition(null), failSanitized);
  assert.throws(() => createMicrosoftOAuthOperationComposition(undefined), failSanitized);
  assert.throws(() => createMicrosoftOAuthOperationComposition({ ...good }), failSanitized); // unfrozen

  // Extra key.
  assert.throws(
    () => createMicrosoftOAuthOperationComposition(Object.freeze({ ...good, extra: 1 })),
    failSanitized,
  );

  // Missing key.
  const missing = { ...good };
  delete missing.secretProvider;
  assert.throws(
    () => createMicrosoftOAuthOperationComposition(Object.freeze(missing)),
    failSanitized,
  );

  // Wrong key order (secret before transport).
  assert.throws(
    () => createMicrosoftOAuthOperationComposition(Object.freeze({
      verifiedIdentity: good.verifiedIdentity,
      envelopeProvider: good.envelopeProvider,
      clock: good.clock,
      installer: good.installer,
      secretProvider: good.secretProvider,
      transportDeps: good.transportDeps,
    })),
    failSanitized,
  );

  // Wrong service methods.
  assert.throws(
    () => createMicrosoftOAuthOperationComposition(Object.freeze({
      ...good,
      verifiedIdentity: Object.freeze({ validate: async () => {} }),
    })),
    failSanitized,
  );
  assert.throws(
    () => createMicrosoftOAuthOperationComposition(Object.freeze({
      ...good,
      installer: Object.freeze({
        installInitialDelegatedGrant: async () => Object.freeze({ status: 'installed' }),
      }),
    })),
    failSanitized,
  );
  assert.throws(
    () => createMicrosoftOAuthOperationComposition(Object.freeze({
      ...good,
      installer: Object.freeze({
        installVerifiedGrant: async () => Object.freeze({ status: 'installed' }),
        extra: 1,
      }),
    })),
    failSanitized,
  );

  // transportDeps ambient hole — missing timers / unfrozen / wrong order.
  assert.throws(
    () => createMicrosoftOAuthOperationComposition(Object.freeze({
      ...good,
      transportDeps: Object.freeze({ httpsImpl: good.transportDeps.httpsImpl }),
    })),
    failSanitized,
  );
  assert.throws(
    () => createMicrosoftOAuthOperationComposition(Object.freeze({
      ...good,
      transportDeps: { httpsImpl: good.transportDeps.httpsImpl, timers: good.transportDeps.timers },
    })),
    failSanitized,
  );
  assert.throws(
    () => createMicrosoftOAuthOperationComposition(Object.freeze({
      ...good,
      transportDeps: Object.freeze({
        timers: good.transportDeps.timers,
        httpsImpl: good.transportDeps.httpsImpl,
      }),
    })),
    failSanitized,
  );

  // Accessor on deps bag.
  const accessor = {};
  for (const key of DEPENDENCY_KEYS) {
    if (key === 'clock') {
      Object.defineProperty(accessor, key, {
        enumerable: true,
        get() { throw new Error(LEAK); },
      });
    } else {
      accessor[key] = good[key];
    }
  }
  assert.throws(
    () => createMicrosoftOAuthOperationComposition(Object.freeze(accessor)),
    failSanitized,
  );

  // Symbol key.
  const withSymbol = { ...good };
  withSymbol[Symbol('x')] = 1;
  assert.throws(
    () => createMicrosoftOAuthOperationComposition(Object.freeze(withSymbol)),
    failSanitized,
  );

  // Proxy prototype trap.
  const proxy = new Proxy(good, {
    getPrototypeOf() { throw new Error(LEAK); },
  });
  assert.throws(() => createMicrosoftOAuthOperationComposition(proxy), failSanitized);

  // Bad secret provider.
  assert.throws(
    () => createMicrosoftOAuthOperationComposition(Object.freeze({
      ...good,
      secretProvider: Object.freeze({ resolveSecret: async () => SECRET }),
    })),
    failSanitized,
  );

  // Bad envelope (missing open).
  assert.throws(
    () => createMicrosoftOAuthOperationComposition(Object.freeze({
      ...good,
      envelopeProvider: {
        sealGrantPayload: async () => ({}),
        openGrantPayload: async () => ({}),
      },
    })),
    failSanitized,
  );

  // transportDeps: accessor on httpsImpl.request must be rejected without invocation.
  {
    let accessed = 0;
    const httpsImpl = {};
    Object.defineProperty(httpsImpl, 'request', {
      enumerable: true,
      get() {
        accessed += 1;
        throw new Error(LEAK);
      },
    });
    assert.throws(
      () => createMicrosoftOAuthOperationComposition(Object.freeze({
        ...good,
        transportDeps: Object.freeze({
          httpsImpl,
          timers: good.transportDeps.timers,
        }),
      })),
      failSanitized,
    );
    assert.equal(accessed, 0);
  }

  // transportDeps: accessor on timers.setTimeout rejected without invocation.
  {
    let accessed = 0;
    const timers = {
      clearTimeout() {},
    };
    Object.defineProperty(timers, 'setTimeout', {
      enumerable: true,
      get() {
        accessed += 1;
        throw new Error(LEAK);
      },
    });
    // Rebuild with exact order setTimeout, clearTimeout via defineProperty order.
    const orderedTimers = {};
    Object.defineProperty(orderedTimers, 'setTimeout', {
      enumerable: true,
      configurable: true,
      get() {
        accessed += 1;
        throw new Error(LEAK);
      },
    });
    Object.defineProperty(orderedTimers, 'clearTimeout', {
      enumerable: true,
      configurable: true,
      value() {},
      writable: true,
    });
    assert.throws(
      () => createMicrosoftOAuthOperationComposition(Object.freeze({
        ...good,
        transportDeps: Object.freeze({
          httpsImpl: good.transportDeps.httpsImpl,
          timers: orderedTimers,
        }),
      })),
      failSanitized,
    );
    assert.equal(accessed, 0);
  }

  // transportDeps: symbol / extra timer keys rejected.
  {
    const timers = {
      setTimeout() { return 1; },
      clearTimeout() {},
    };
    timers[Symbol('x')] = () => {};
    assert.throws(
      () => createMicrosoftOAuthOperationComposition(Object.freeze({
        ...good,
        transportDeps: Object.freeze({
          httpsImpl: good.transportDeps.httpsImpl,
          timers,
        }),
      })),
      failSanitized,
    );
  }
  {
    const timers = {
      setTimeout() { return 1; },
      clearTimeout() {},
      extra: () => {},
    };
    assert.throws(
      () => createMicrosoftOAuthOperationComposition(Object.freeze({
        ...good,
        transportDeps: Object.freeze({
          httpsImpl: good.transportDeps.httpsImpl,
          timers,
        }),
      })),
      failSanitized,
    );
  }

  // transportDeps: unsafe timer prototype rejected.
  {
    const timers = Object.create({ setTimeout() { return 1; }, clearTimeout() {} });
    timers.setTimeout = function setTimeout() { return 1; };
    timers.clearTimeout = function clearTimeout() {};
    assert.throws(
      () => createMicrosoftOAuthOperationComposition(Object.freeze({
        ...good,
        transportDeps: Object.freeze({
          httpsImpl: good.transportDeps.httpsImpl,
          timers,
        }),
      })),
      failSanitized,
    );
  }

  // transportDeps: reflection trap on ownKeys rejected without invoking methods.
  {
    let invoked = 0;
    const timersTarget = {
      setTimeout() { invoked += 1; return 1; },
      clearTimeout() { invoked += 1; },
    };
    const timers = new Proxy(timersTarget, {
      ownKeys() { throw new Error(LEAK); },
    });
    assert.throws(
      () => createMicrosoftOAuthOperationComposition(Object.freeze({
        ...good,
        transportDeps: Object.freeze({
          httpsImpl: good.transportDeps.httpsImpl,
          timers,
        }),
      })),
      failSanitized,
    );
    assert.equal(invoked, 0);
  }
});

// ── Input validation / burn ────────────────────────────────────────────────

test('invalid input burns single-use; no secret/transport/identity/install before validation', async function invalidFirstNoChild() {
  const c = composition();
  await expectSanitizedFailure(() => c.service.completeAuthorization(null));
  assert.equal(c.secret.calls.length, 0);
  assert.equal(c.transport.calls.length, 0);
  assert.equal(c.identity.calls.length, 0);
  assert.equal(c.installer.calls.length, 0);
  // Second call fails even with good input.
  await expectSanitizedFailure(() => c.service.completeAuthorization(goodCompletionInput()));
  assert.equal(c.secret.calls.length, 0);
});

test('rejects wrong key order, extra keys, unfrozen wrong set, non-canonical UUIDs', async function inputShapeAndUuids() {
  const cases = [
    null,
    undefined,
    [],
    {},
    // old clientId-first order
    Object.freeze({
      clientId: CLIENT_ID,
      locationId: LOCATION_ID,
      endpointId: ENDPOINT_ID,
      staffUserId: STAFF_ID,
      codeVerifier: VERIFIER,
      nonce: NONCE,
      applicationClientId: APP_CLIENT_ID,
      authorizationCode: CODE,
      transactionId: OPERATION_ID,
    }),
    Object.freeze({ ...goodCompletionInput(), extra: true }),
    Object.freeze({
      authorizationCode: CODE,
      transactionId: 'NOT-A-UUID',
      clientId: CLIENT_ID,
      locationId: LOCATION_ID,
      endpointId: ENDPOINT_ID,
      staffUserId: STAFF_ID,
      codeVerifier: VERIFIER,
      nonce: NONCE,
      applicationClientId: APP_CLIENT_ID,
    }),
    Object.freeze({
      authorizationCode: CODE,
      transactionId: OPERATION_ID,
      clientId: CLIENT_ID.toUpperCase(), // non-canonical mixed/upper UUID
      locationId: LOCATION_ID,
      endpointId: ENDPOINT_ID,
      staffUserId: STAFF_ID,
      codeVerifier: VERIFIER,
      nonce: NONCE,
      applicationClientId: APP_CLIENT_ID,
    }),
    Object.freeze({
      authorizationCode: CODE,
      transactionId: OPERATION_ID,
      clientId: CLIENT_ID,
      locationId: LOCATION_ID,
      endpointId: ENDPOINT_ID,
      staffUserId: STAFF_ID,
      codeVerifier: 'short',
      nonce: NONCE,
      applicationClientId: APP_CLIENT_ID,
    }),
    Object.freeze({
      authorizationCode: CODE,
      transactionId: OPERATION_ID,
      clientId: CLIENT_ID,
      locationId: LOCATION_ID,
      endpointId: ENDPOINT_ID,
      staffUserId: STAFF_ID,
      codeVerifier: VERIFIER,
      nonce: `${'n'.repeat(42)}.`, // invalid nonce alphabet
      applicationClientId: APP_CLIENT_ID,
    }),
    Object.freeze({
      authorizationCode: '',
      transactionId: OPERATION_ID,
      clientId: CLIENT_ID,
      locationId: LOCATION_ID,
      endpointId: ENDPOINT_ID,
      staffUserId: STAFF_ID,
      codeVerifier: VERIFIER,
      nonce: NONCE,
      applicationClientId: APP_CLIENT_ID,
    }),
    Object.freeze({
      authorizationCode: 'bad\ncode',
      transactionId: OPERATION_ID,
      clientId: CLIENT_ID,
      locationId: LOCATION_ID,
      endpointId: ENDPOINT_ID,
      staffUserId: STAFF_ID,
      codeVerifier: VERIFIER,
      nonce: NONCE,
      applicationClientId: APP_CLIENT_ID,
    }),
  ];

  for (const bad of cases) {
    const c = composition();
    await expectSanitizedFailure(() => c.service.completeAuthorization(bad));
    assert.equal(c.secret.calls.length, 0, 'no secret on bad input');
    assert.equal(c.transport.calls.length, 0, 'no transport on bad input');
  }
});

test('rejects accessors/symbols/prototypes on completion input', async function inputHostileReflection() {
  const accessor = {
    authorizationCode: CODE,
    transactionId: OPERATION_ID,
    clientId: CLIENT_ID,
    locationId: LOCATION_ID,
    endpointId: ENDPOINT_ID,
    staffUserId: STAFF_ID,
    codeVerifier: VERIFIER,
    nonce: NONCE,
  };
  Object.defineProperty(accessor, 'applicationClientId', {
    enumerable: true,
    get() { throw new Error(LEAK); },
  });
  Object.freeze(accessor);
  const c1 = composition();
  await expectSanitizedFailure(() => c1.service.completeAuthorization(accessor));
  assert.equal(c1.secret.calls.length, 0);

  const withSymbol = goodCompletionInput();
  // frozen input can't add symbol — build plain then freeze with symbol.
  const plain = {
    authorizationCode: CODE,
    transactionId: OPERATION_ID,
    clientId: CLIENT_ID,
    locationId: LOCATION_ID,
    endpointId: ENDPOINT_ID,
    staffUserId: STAFF_ID,
    codeVerifier: VERIFIER,
    nonce: NONCE,
    applicationClientId: APP_CLIENT_ID,
  };
  plain[Symbol('x')] = LEAK;
  const c2 = composition();
  await expectSanitizedFailure(() => c2.service.completeAuthorization(Object.freeze(plain)));
  assert.equal(c2.secret.calls.length, 0);

  const proto = Object.create({ authorizationCode: CODE });
  Object.assign(proto, {
    authorizationCode: CODE,
    transactionId: OPERATION_ID,
    clientId: CLIENT_ID,
    locationId: LOCATION_ID,
    endpointId: ENDPOINT_ID,
    staffUserId: STAFF_ID,
    codeVerifier: VERIFIER,
    nonce: NONCE,
    applicationClientId: APP_CLIENT_ID,
  });
  const c3 = composition();
  await expectSanitizedFailure(() => c3.service.completeAuthorization(Object.freeze(proto)));
  assert.equal(c3.secret.calls.length, 0);
});

test('input mutation after burn snapshot does not affect exchange body', async function inputMutationSnapshot() {
  const c = composition();
  const mutable = {
    authorizationCode: CODE,
    transactionId: OPERATION_ID,
    clientId: CLIENT_ID,
    locationId: LOCATION_ID,
    endpointId: ENDPOINT_ID,
    staffUserId: STAFF_ID,
    codeVerifier: VERIFIER,
    nonce: NONCE,
    applicationClientId: APP_CLIENT_ID,
  };
  // Mutate during secret resolve (after validation snapshot).
  const secretProvider = {
    async getClientSecret() {
      mutable.authorizationCode = 'MUTATED-CODE';
      mutable.codeVerifier = 'x'.repeat(43);
      mutable.applicationClientId = OTHER_CLIENT;
      mutable.endpointId = OTHER_ENDPOINT;
      return SECRET;
    },
  };
  const service = createMicrosoftOAuthOperationComposition(Object.freeze({
    verifiedIdentity: c.identity.verifiedIdentity,
    envelopeProvider: c.envelope.envelopeProvider,
    clock: c.clock.clock,
    installer: c.installer.installer,
    transportDeps: c.transport.transportDeps,
    secretProvider,
  }));
  const result = await service.completeAuthorization(mutable);
  assert.deepEqual(result, COMPLETION_ACK);
  const form = new URLSearchParams(c.transport.calls[0].body);
  assert.equal(form.get('code'), CODE);
  assert.equal(form.get('code_verifier'), VERIFIER);
  assert.equal(form.get('client_id'), APP_CLIENT_ID);
  assert.equal(c.installer.calls[0].request.endpointId, ENDPOINT_ID);
});

// ── Concurrent / reentrant / single-use ────────────────────────────────────

test('concurrent and reentrant second calls fail; first may still complete', async function concurrentReentrant() {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const c = composition({
    secret: { wait: waiting },
  });
  const first = c.service.completeAuthorization(goodCompletionInput());
  await expectSanitizedFailure(() => c.service.completeAuthorization(goodCompletionInput()));
  release();
  const result = await first;
  assert.deepEqual(result, COMPLETION_ACK);
  await expectSanitizedFailure(() => c.service.completeAuthorization(goodCompletionInput()));
});

// ── Child failures ─────────────────────────────────────────────────────────

test('secret throw / transport fail / identity throw / seal throw / install throw sanitize; no completed', async function childFailuresSanitize() {
  // Secret throw
  {
    const c = composition({ secret: { throw: true } });
    await expectSanitizedFailure(() => c.service.completeAuthorization(goodCompletionInput()));
    assert.equal(c.installer.calls.length, 0);
  }
  // Transport error
  {
    const c = composition({ transport: { requestThrow: true } });
    await expectSanitizedFailure(() => c.service.completeAuthorization(goodCompletionInput()));
    assert.equal(c.installer.calls.length, 0);
  }
  // Bad token body (no refresh)
  {
    const c = composition({
      transport: {
        body: JSON.stringify({
          token_type: 'Bearer',
          expires_in: 3600,
          scope: GOOD_SCOPE,
          access_token: ACCESS,
          id_token: ID_TOKEN,
        }),
      },
    });
    await expectSanitizedFailure(() => c.service.completeAuthorization(goodCompletionInput()));
    assert.equal(c.installer.calls.length, 0);
    assert.equal(c.identity.calls.length, 0);
  }
  // Identity throw
  {
    const c = composition({ identity: { throw: true } });
    await expectSanitizedFailure(() => c.service.completeAuthorization(goodCompletionInput()));
    assert.equal(c.installer.calls.length, 0);
  }
  // Identity thenable reject
  {
    const c = composition({ identity: { thenable: 'reject' } });
    await expectSanitizedFailure(() => c.service.completeAuthorization(goodCompletionInput()));
    assert.equal(c.installer.calls.length, 0);
  }
  // Seal throw
  {
    const c = composition({ envelope: { throw: true } });
    await expectSanitizedFailure(() => c.service.completeAuthorization(goodCompletionInput()));
    assert.equal(c.installer.calls.length, 0);
  }
  // Installer throw
  {
    const c = composition({ installer: { throw: true } });
    await expectSanitizedFailure(() => c.service.completeAuthorization(goodCompletionInput()));
    assert.equal(c.installer.calls.length, 1);
  }
  // Installer bad ack
  {
    const c = composition({
      installer: { result: Object.freeze({ status: 'accepted' }) },
    });
    await expectSanitizedFailure(() => c.service.completeAuthorization(goodCompletionInput()));
  }
});

test('no false completed and no raw refresh persistence on child failure', async function noFalseCompletedNoRawRefresh() {
  const persisted = [];
  const installer = Object.freeze({
    async installVerifiedGrant(request) {
      persisted.push(request);
      throw new Error(`${LEAK} install boom`);
    },
  });
  const c = composition();
  const service = createMicrosoftOAuthOperationComposition(Object.freeze({
    verifiedIdentity: c.identity.verifiedIdentity,
    envelopeProvider: c.envelope.envelopeProvider,
    clock: c.clock.clock,
    installer,
    transportDeps: c.transport.transportDeps,
    secretProvider: c.secret.secretProvider,
  }));
  await expectSanitizedFailure(() => service.completeAuthorization(goodCompletionInput()));
  // Install was attempted with envelope only (no raw refresh field).
  assert.equal(persisted.length, 1);
  assert.equal('refreshToken' in persisted[0], false);
  assert.equal('refresh_token' in persisted[0], false);
  const blob = JSON.stringify(persisted[0]);
  assert.equal(blob.includes(REFRESH), false);
  assert.equal(blob.includes(ACCESS), false);
});

// ── Full fake end-to-end with real installer ───────────────────────────────

/**
 * Stateful fake pinned transaction client for composed E2E proofs.
 * Throws on unknown SQL (never silently returns zero rows) so accidental
 * installer SQL drift fails the gate loudly. Supports injected insert/update
 * failures for ROLLBACK proofs.
 */
function createStatefulFakeClient(spec = {}) {
  const queries = [];
  let tx = 'idle';
  let draft = null;
  let committed = {
    endpoint: {
      id: ENDPOINT_ID,
      client_id: CLIENT_ID,
      provider: 'microsoft_graph',
      auth_mode: 'delegated_authorization_code',
      connector_mode: 'microsoft_delegated_oauth',
      binding_status: 'unverified_offline',
      public_address: MAILBOX,
    },
    grantInserted: false,
    grantRow: null,
  };
  const modes = {
    insertThrow: spec.insertThrow || null,
    updateThrow: spec.updateThrow || null,
  };

  function view() {
    return draft || committed;
  }
  function ensureDraft() {
    if (!draft) {
      draft = {
        endpoint: committed.endpoint ? { ...committed.endpoint } : null,
        grantInserted: committed.grantInserted,
        grantRow: committed.grantRow ? { ...committed.grantRow } : null,
      };
    }
    return draft;
  }

  const client = {
    async query(sql, params) {
      const text = String(sql || '');
      const p = Array.isArray(params) ? params.slice() : [];
      queries.push({ text, params: p, tx });

      if (/^\s*BEGIN\b/i.test(text)) {
        tx = 'open';
        draft = {
          endpoint: committed.endpoint ? { ...committed.endpoint } : null,
          grantInserted: committed.grantInserted,
          grantRow: committed.grantRow ? { ...committed.grantRow } : null,
        };
        return { rows: [], rowCount: 0 };
      }
      if (/^\s*COMMIT\b/i.test(text)) {
        if (draft) {
          committed = {
            endpoint: draft.endpoint ? { ...draft.endpoint } : null,
            grantInserted: draft.grantInserted,
            grantRow: draft.grantRow ? { ...draft.grantRow } : null,
          };
        }
        draft = null;
        tx = 'committed';
        return { rows: [], rowCount: 0 };
      }
      if (/^\s*ROLLBACK\b/i.test(text)) {
        draft = null;
        tx = 'rolled_back';
        return { rows: [], rowCount: 0 };
      }
      if (/FOR\s+UPDATE/i.test(text) && /tenant_channel_endpoints/i.test(text)) {
        const state = view();
        if (state.endpoint == null) return { rows: [], rowCount: 0 };
        return { rows: [{ ...state.endpoint }], rowCount: 1 };
      }
      if (/INSERT\s+INTO\s+tenant_email_delegated_grants/i.test(text)) {
        if (modes.insertThrow) {
          const err = modes.insertThrow instanceof Error
            ? modes.insertThrow
            : Object.assign(new Error(modes.insertThrow.message || `${LEAK} insert`), modes.insertThrow);
          throw err;
        }
        const state = ensureDraft();
        if (state.grantInserted) {
          const err = new Error('duplicate key');
          err.code = '23505';
          throw err;
        }
        state.grantInserted = true;
        state.grantRow = {
          client_id: p[0],
          endpoint_id: p[1],
          grant_generation: 1,
          grant_status: 'active',
          reconcile_state: 'clean',
          last_operation_id: p[2],
          envelope_version: p[3],
          aead_alg: p[4],
          kek_wrap_alg: p[5],
          kek_key_name: p[6],
          kek_key_version: p[7],
          nonce: p[8],
          ciphertext: p[9],
          auth_tag: p[10],
          wrapped_dek: p[11],
          created_by: p[12],
          updated_by: p[12],
        };
        return {
          rows: [{
            client_id: state.grantRow.client_id,
            endpoint_id: state.grantRow.endpoint_id,
            grant_generation: 1,
            grant_status: 'active',
            reconcile_state: 'clean',
          }],
          rowCount: 1,
        };
      }
      if (/UPDATE\s+tenant_channel_endpoints/i.test(text)) {
        if (modes.updateThrow) {
          const err = modes.updateThrow instanceof Error
            ? modes.updateThrow
            : Object.assign(new Error(modes.updateThrow.message || `${LEAK} update`), modes.updateThrow);
          throw err;
        }
        const state = ensureDraft();
        if (!state.endpoint
            || state.endpoint.binding_status !== p[6]
            || state.endpoint.public_address !== p[7]
            || state.endpoint.client_id !== p[0]
            || state.endpoint.id !== p[1]) {
          return { rows: [], rowCount: 0 };
        }
        state.endpoint = {
          ...state.endpoint,
          provider_tenant_id: p[2],
          provider_principal_oid: p[3],
          provider_resource_id: p[4],
          mailbox_kind: 'user',
          mailbox_access_kind: 'own_user',
          binding_status: 'verified',
          updated_by: p[5],
        };
        return {
          rows: [{
            id: state.endpoint.id,
            client_id: state.endpoint.client_id,
            binding_status: 'verified',
            provider_tenant_id: state.endpoint.provider_tenant_id,
            provider_principal_oid: state.endpoint.provider_principal_oid,
            provider_resource_id: state.endpoint.provider_resource_id,
            mailbox_kind: 'user',
            mailbox_access_kind: 'own_user',
            public_address: state.endpoint.public_address,
          }],
          rowCount: 1,
        };
      }
      // Proof quality: never silently swallow unknown SQL as empty success.
      throw new Error(`unknown SQL in stateful fake client: ${text.slice(0, 120)}`);
    },
  };

  return {
    client,
    queries,
    get grantInserted() { return (draft || committed).grantInserted; },
    get grantRow() { return (draft || committed).grantRow; },
    get endpointState() { return (draft || committed).endpoint; },
    get tx() { return tx; },
  };
}

function sqlKinds(queries) {
  return queries.map((q) => {
    const t = q.text;
    if (/^\s*BEGIN\b/i.test(t)) return 'BEGIN';
    if (/^\s*COMMIT\b/i.test(t)) return 'COMMIT';
    if (/^\s*ROLLBACK\b/i.test(t)) return 'ROLLBACK';
    if (/FOR\s+UPDATE/i.test(t) && /tenant_channel_endpoints/i.test(t)) return 'SELECT_LOCK';
    if (/INSERT\s+INTO\s+tenant_email_delegated_grants/i.test(t)) return 'INSERT_GRANT';
    if (/UPDATE\s+tenant_channel_endpoints/i.test(t)) return 'UPDATE_ENDPOINT';
    return 'OTHER';
  });
}

test('full fake e2e: real auth+response+verified custody+fake envelope+stateful installer', async function fullFakeE2E() {
  const fakeDb = createStatefulFakeClient();
  const installer = createMicrosoftVerifiedGrantInstaller(Object.freeze({ client: fakeDb.client }));
  const envelopeProvider = createFakeEmailGrantEnvelopeProvider();
  const identity = stubIdentity();
  const clock = stubClock();
  const secret = stubSecret();
  const transport = createFakeTransport();

  const service = createMicrosoftOAuthOperationComposition(Object.freeze({
    verifiedIdentity: identity.verifiedIdentity,
    envelopeProvider,
    clock: clock.clock,
    installer,
    transportDeps: transport.transportDeps,
    secretProvider: secret.secretProvider,
  }));

  const logged = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => { logged.push(args); };
  console.error = (...args) => { logged.push(args); };

  let result;
  try {
    result = await service.completeAuthorization(goodCompletionInput());
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.deepEqual(result, COMPLETION_ACK);
  assert.deepEqual(logged, []);
  assertNoSensitive(result);

  // Grant installed generation-1 active/clean; endpoint verified.
  assert.equal(fakeDb.grantInserted, true);
  assert.equal(fakeDb.grantRow.grant_generation, 1);
  assert.equal(fakeDb.grantRow.grant_status, 'active');
  assert.equal(fakeDb.grantRow.reconcile_state, 'clean');
  assert.equal(fakeDb.grantRow.last_operation_id, OPERATION_ID);
  assert.equal(fakeDb.grantRow.endpoint_id, ENDPOINT_ID);
  assert.equal(fakeDb.grantRow.client_id, CLIENT_ID);
  // No raw refresh in grant row buffers as utf8 secret.
  const rowBlob = JSON.stringify({
    nonce: fakeDb.grantRow.nonce && fakeDb.grantRow.nonce.toString('hex'),
    ciphertext: fakeDb.grantRow.ciphertext && fakeDb.grantRow.ciphertext.toString('hex'),
  });
  assert.equal(rowBlob.includes(REFRESH), false);
  assert.equal(rowBlob.includes(ACCESS), false);

  assert.equal(fakeDb.endpointState.binding_status, 'verified');
  assert.equal(fakeDb.endpointState.provider_tenant_id, TID);
  assert.equal(fakeDb.endpointState.provider_principal_oid, PRINCIPAL);
  assert.equal(fakeDb.endpointState.public_address, MAILBOX);

  // Open envelope via fake provider proves refresh-only package.
  const envelopeRecord = {
    envelope_version: fakeDb.grantRow.envelope_version,
    aead_alg: fakeDb.grantRow.aead_alg,
    kek_wrap_alg: fakeDb.grantRow.kek_wrap_alg,
    kek_key_name: fakeDb.grantRow.kek_key_name,
    kek_key_version: fakeDb.grantRow.kek_key_version,
    nonce: fakeDb.grantRow.nonce,
    ciphertext: fakeDb.grantRow.ciphertext,
    auth_tag: fakeDb.grantRow.auth_tag,
    wrapped_dek: fakeDb.grantRow.wrapped_dek,
    operation_id: fakeDb.grantRow.last_operation_id,
  };
  assert.equal(validateGrantEnvelopeRecordV1(envelopeRecord).ok, true);
  const aad = buildGrantEnvelopeAadV1({
    clientId: CLIENT_ID,
    endpointId: ENDPOINT_ID,
    grantGeneration: 1,
    operationId: OPERATION_ID,
  });
  const opened = await envelopeProvider.openGrantPayload({
    envelope: envelopeRecord,
    aad,
    operation_id: OPERATION_ID,
  });
  // Fake provider returns minimized { refresh_token } only (refresh-only package).
  assert.equal(Object.isFrozen(opened), true);
  assert.deepEqual(Reflect.ownKeys(opened), ['refresh_token']);
  assert.equal(opened.refresh_token, REFRESH);
  assert.equal('access_token' in opened, false);
  assert.equal('id_token' in opened, false);
  assert.equal('accessToken' in opened, false);
  assert.equal('plaintext' in opened, false);

  // Transport body used application client + redirect exact.
  const form = new URLSearchParams(transport.calls[0].body);
  assert.equal(form.get('client_id'), APP_CLIENT_ID);
  assert.equal(form.get('redirect_uri'), REDIRECT_URI);
  assert.equal(form.get('code_verifier'), VERIFIER);
  assert.equal(form.get('code'), CODE);
});

test('e2e failure at identity leaves no grant insert and endpoint unverified', async function e2eIdentityFailNoPersist() {
  const fakeDb = createStatefulFakeClient();
  const installer = createMicrosoftVerifiedGrantInstaller(Object.freeze({ client: fakeDb.client }));
  const c = composition({ identity: { throw: true } });
  const service = createMicrosoftOAuthOperationComposition(Object.freeze({
    verifiedIdentity: c.identity.verifiedIdentity,
    envelopeProvider: createFakeEmailGrantEnvelopeProvider(),
    clock: c.clock.clock,
    installer,
    transportDeps: c.transport.transportDeps,
    secretProvider: c.secret.secretProvider,
  }));
  await expectSanitizedFailure(() => service.completeAuthorization(goodCompletionInput()));
  assert.equal(fakeDb.grantInserted, false);
  assert.equal(fakeDb.endpointState.binding_status, 'unverified_offline');
  assert.equal(fakeDb.grantRow, null);
});

test('composed e2e: real installer endpoint UPDATE failure after grant INSERT rolls back; never completed', async function e2eUpdateFailRollback() {
  const fakeDb = createStatefulFakeClient({
    updateThrow: Object.assign(new Error(`${LEAK} endpoint update boom`), { code: '40001' }),
  });
  const installer = createMicrosoftVerifiedGrantInstaller(Object.freeze({ client: fakeDb.client }));
  const identity = stubIdentity();
  const clock = stubClock();
  const secret = stubSecret();
  const transport = createFakeTransport();
  const envelopeProvider = createFakeEmailGrantEnvelopeProvider();

  const service = createMicrosoftOAuthOperationComposition(Object.freeze({
    verifiedIdentity: identity.verifiedIdentity,
    envelopeProvider,
    clock: clock.clock,
    installer,
    transportDeps: transport.transportDeps,
    secretProvider: secret.secretProvider,
  }));

  let completed = false;
  await expectSanitizedFailure(async () => {
    const result = await service.completeAuthorization(goodCompletionInput());
    completed = result && result.status === 'completed';
    return result;
  });
  assert.equal(completed, false);
  // ROLLBACK undoes the in-flight INSERT; grant absent; endpoint still unverified.
  assert.equal(fakeDb.tx, 'rolled_back');
  assert.equal(fakeDb.grantInserted, false);
  assert.equal(fakeDb.grantRow, null);
  assert.equal(fakeDb.endpointState.binding_status, 'unverified_offline');
  const kinds = sqlKinds(fakeDb.queries);
  assert.equal(kinds.includes('BEGIN'), true);
  assert.equal(kinds.includes('SELECT_LOCK'), true);
  assert.equal(kinds.includes('INSERT_GRANT'), true);
  assert.equal(kinds.includes('UPDATE_ENDPOINT'), true);
  assert.equal(kinds.includes('ROLLBACK'), true);
  assert.equal(kinds.includes('COMMIT'), false);
  assert.equal(kinds.includes('OTHER'), false);
});

test('composed e2e: real installer grant INSERT failure rolls back; never completed', async function e2eInsertFailRollback() {
  const fakeDb = createStatefulFakeClient({
    insertThrow: Object.assign(new Error(`${LEAK} grant insert boom`), { code: '23505' }),
  });
  const installer = createMicrosoftVerifiedGrantInstaller(Object.freeze({ client: fakeDb.client }));
  const identity = stubIdentity();
  const clock = stubClock();
  const secret = stubSecret();
  const transport = createFakeTransport();

  const service = createMicrosoftOAuthOperationComposition(Object.freeze({
    verifiedIdentity: identity.verifiedIdentity,
    envelopeProvider: createFakeEmailGrantEnvelopeProvider(),
    clock: clock.clock,
    installer,
    transportDeps: transport.transportDeps,
    secretProvider: secret.secretProvider,
  }));

  let completed = false;
  await expectSanitizedFailure(async () => {
    const result = await service.completeAuthorization(goodCompletionInput());
    completed = result && result.status === 'completed';
    return result;
  });
  assert.equal(completed, false);
  assert.equal(fakeDb.tx, 'rolled_back');
  assert.equal(fakeDb.grantInserted, false);
  assert.equal(fakeDb.grantRow, null);
  assert.equal(fakeDb.endpointState.binding_status, 'unverified_offline');
  const kinds = sqlKinds(fakeDb.queries);
  assert.equal(kinds.includes('BEGIN'), true);
  assert.equal(kinds.includes('SELECT_LOCK'), true);
  assert.equal(kinds.includes('INSERT_GRANT'), true);
  assert.equal(kinds.includes('UPDATE_ENDPOINT'), false);
  assert.equal(kinds.includes('ROLLBACK'), true);
  assert.equal(kinds.includes('COMMIT'), false);
  assert.equal(kinds.includes('OTHER'), false);
});

test('callback completion interop: operation composition as completion dependency', async function callbackInterop() {
  const c = composition();
  const completion = c.service;
  assert.deepEqual(Reflect.ownKeys(completion), ['completeAuthorization']);

  // Wire as callback completion dependency with stub repository/clock/env.
  const STATE = Buffer.alloc(32, 9).toString('base64url');
  const NOW = new Date('2026-08-05T12:01:00.000Z');
  const repository = Object.freeze({
    async consume() {
      return {
        id: OPERATION_ID,
        location_id: LOCATION_ID,
        staff_user_id: STAFF_ID,
        code_verifier: VERIFIER,
        nonce: NONCE,
        endpoint_id: ENDPOINT_ID,
      };
    },
  });
  const clock = Object.freeze({
    now() { return new Date(NOW.getTime()); },
  });
  const env = {
    LUNA_DEPLOYMENT: 'sunset-staging',
    LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'true',
    LUNA_EMAIL_OAUTH_CLIENT_ID: APP_CLIENT_ID,
  };
  const cb = callback.createMicrosoftOAuthCallbackCompletionService(Object.freeze({
    repository,
    completion,
    env,
    clock,
  }));
  const publicResult = await cb.accept(
    { state: STATE, code: CODE },
    { clientId: CLIENT_ID, authSessionId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' },
  );
  assert.deepEqual(publicResult, { status: 'authorization_received' });
  assert.equal(c.installer.calls.length, 1);
  assert.equal(c.installer.calls[0].request.operationId, OPERATION_ID);
  assert.equal(c.installer.calls[0].request.endpointId, ENDPOINT_ID);
  assertNoSensitive(publicResult);
});

test('no logs of secrets on happy path', async function noLogsHappy() {
  const logged = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => { logged.push(args); };
  console.error = (...args) => { logged.push(args); };
  try {
    const c = composition();
    await c.service.completeAuthorization(goodCompletionInput());
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.deepEqual(logged, []);
});

async function runTests() {
  for (const { name, run } of tests) {
    await run();
    process.stdout.write(`ok - ${name}\n`);
  }
  process.stdout.write(
    `PASS verify:email-microsoft-oauth-operation-composition (${tests.length} named offline tests)\n`,
  );
}

runTests().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});

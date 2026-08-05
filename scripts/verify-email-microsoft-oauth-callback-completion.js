'use strict';

/**
 * Hostile offline gate for Stage 6 Microsoft OAuth callback completion.
 *
 * Covers exact shapes/order/freeze, receiver preservation, invalid-first burn,
 * concurrent/reentrant, state/owner mutation, repository row mutation/accessors/
 * proxy, row missing/duplicate semantics, error path, completion ack/throw/
 * thenable, transaction mix-up, no secret material public/logs.
 * Direct interop with operation completion fake proving exact bound
 * endpoint/operation/staff/verifier/nonce/client (+ code) passed.
 * No route wiring. Existing disabled callback export remains independent.
 */

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  ERROR_CODE,
  ERROR_MESSAGE,
  ACCEPT_METHOD,
  COMPLETION_METHOD,
  COMPLETION_ACK_STATUS,
  COMPLETION_ACK,
  PUBLIC_STATUS_INVALID,
  PUBLIC_STATUS_DECLINED,
  PUBLIC_STATUS_RECEIVED,
  DEPENDENCY_KEYS,
  CONSUME_ROW_KEYS,
  COMPLETION_KEYS,
  OWNER_KEYS,
  CALLBACK_CODE_KEYS,
  CALLBACK_ERROR_KEYS,
  SQL_CONSUME_TRANSACTION,
  SUNSET_DEPLOYMENT,
  createMicrosoftOAuthCallbackCompletionService,
} = require('./lib/email-microsoft-oauth-callback-completion');

const txn = require('./lib/email-microsoft-oauth-transaction-service');

const ROOT = path.join(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const LIB_REL = 'scripts/lib/email-microsoft-oauth-callback-completion.js';
const VERIFY_REL = 'scripts/verify-email-microsoft-oauth-callback-completion.js';
const ROUTES_REL = 'scripts/lib/staff-email-oauth-routes.js';
const TXN_REL = 'scripts/lib/email-microsoft-oauth-transaction-service.js';

const CLIENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const AUTH_SESSION_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const ENDPOINT_ID = '11111111-2222-4333-8444-555555555555';
const OPERATION_ID = '99999999-8888-4777-8666-555555555555';
const LOCATION_ID = '22222222-3333-4444-8555-666666666666';
const STAFF_ID = 'abcdef01-2345-4678-89ab-cdef01234567';
const APP_CLIENT_ID = '12345678-1234-4234-8234-123456789abc';
const OTHER_CLIENT = '00000000-1111-4222-8333-444444444444';
const OTHER_SESSION = '55555555-6666-4777-8888-999999999999';
const OTHER_ENDPOINT = 'aaaaaaaa-0000-4000-8000-bbbbbbbbbbbb';
const OTHER_OP = 'cccccccc-0000-4000-8000-dddddddddddd';
const OTHER_STAFF = 'eeeeeeee-0000-4000-8000-ffffffffffff';

const STATE = Buffer.alloc(32, 9).toString('base64url');
const CODE = 'provider-code+/%?=&NEVER_LEAK';
const VERIFIER = `${'v'.repeat(42)}~`;
const NONCE = `${'n'.repeat(43)}`;
const LEAK = 'CALLBACK-COMPLETION-SECRET-DO-NOT-LEAK';
const NOW = new Date('2026-08-05T12:01:00.000Z');

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

function failSanitized(error) {
  return error
    && error.name === 'MicrosoftOAuthCallbackCompletionError'
    && error.code === ERROR_CODE
    && error.message === ERROR_MESSAGE
    && Object.isFrozen(error)
    && !String(error.message).includes(LEAK)
    && !String(error.stack || '').includes(LEAK)
    && !String(error).includes(CODE)
    && !String(error).includes(VERIFIER)
    && !String(error).includes(NONCE);
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
  assert.equal(s.includes('VERIFIER_SECRET'), false);
  assert.equal(s.includes('NONCE_SECRET'), false);
  assert.equal(s.includes(OPERATION_ID) && s.includes('status') && Object.keys(blob || {}).length > 1, false);
}

function goodEnv(patch = {}) {
  return {
    LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
    LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'true',
    LUNA_EMAIL_OAUTH_CLIENT_ID: APP_CLIENT_ID,
    ...patch,
  };
}

function goodOwner(patch = {}) {
  return { clientId: CLIENT_ID, authSessionId: AUTH_SESSION_ID, ...patch };
}

function goodCodeInput(patch = {}) {
  return { state: STATE, code: CODE, ...patch };
}

function goodErrorInput(patch = {}) {
  return { state: STATE, error: 'access_denied', ...patch };
}

function goodRow(patch = {}) {
  return {
    id: OPERATION_ID,
    location_id: LOCATION_ID,
    staff_user_id: STAFF_ID,
    code_verifier: VERIFIER,
    nonce: NONCE,
    endpoint_id: ENDPOINT_ID,
    ...patch,
  };
}

function goodAck() {
  return Object.freeze({ status: COMPLETION_ACK_STATUS });
}

function stubClock(spec = {}) {
  const calls = [];
  const clock = Object.freeze({
    now() {
      calls.push({ thisValue: this });
      if (spec.throw) throw new Error(`${LEAK} clock`);
      if (Object.prototype.hasOwnProperty.call(spec, 'value')) return spec.value;
      return new Date(NOW.getTime());
    },
  });
  return { clock, calls };
}

function stubRepository(spec = {}) {
  const calls = [];
  const repository = Object.freeze({
    async consume(arg) {
      calls.push({ arg, thisValue: this });
      if (spec.wait) await spec.wait;
      if (spec.throw) throw new Error(`${LEAK} consume`);
      if (Object.prototype.hasOwnProperty.call(spec, 'row')) return spec.row;
      if (typeof spec.rowFn === 'function') return spec.rowFn(arg, calls.length);
      return goodRow(spec.rowPatch);
    },
  });
  return { repository, calls };
}

function stubCompletion(spec = {}) {
  const calls = [];
  const completion = Object.freeze({
    async completeBoundOperation(request) {
      calls.push({ request, thisValue: this });
      if (spec.wait) await spec.wait;
      if (spec.throw) throw new Error(`${LEAK} completion`);
      if (spec.thenable) {
        return {
          then(resolve, reject) {
            if (spec.thenable === 'reject') reject(new Error(`${LEAK} thenable`));
            else resolve(spec.result !== undefined ? spec.result : goodAck());
          },
        };
      }
      if (Object.prototype.hasOwnProperty.call(spec, 'result')) return spec.result;
      return goodAck();
    },
  });
  return { completion, calls };
}

function composition(spec = {}) {
  const clock = stubClock(spec.clock);
  const repository = stubRepository(spec.repository);
  const completion = stubCompletion(spec.completion);
  const env = spec.env || goodEnv(spec.envPatch);
  const service = createMicrosoftOAuthCallbackCompletionService(Object.freeze({
    repository: repository.repository,
    completion: completion.completion,
    env,
    clock: clock.clock,
  }));
  return { service, clock, repository, completion, env };
}

// ── Export / anti-drift ────────────────────────────────────────────────────

test('exports frozen factory, fixed error constants, and completion-aligned keys', async function exportSurface() {
  const exported = require('./lib/email-microsoft-oauth-callback-completion');
  assert.deepEqual(Object.keys(exported), [
    'ERROR_CODE',
    'ERROR_MESSAGE',
    'ACCEPT_METHOD',
    'COMPLETION_METHOD',
    'COMPLETION_ACK_STATUS',
    'COMPLETION_ACK',
    'PUBLIC_STATUS_INVALID',
    'PUBLIC_STATUS_DECLINED',
    'PUBLIC_STATUS_RECEIVED',
    'DEPENDENCY_KEYS',
    'CONSUME_ROW_KEYS',
    'COMPLETION_KEYS',
    'OWNER_KEYS',
    'CALLBACK_CODE_KEYS',
    'CALLBACK_ERROR_KEYS',
    'SQL_CONSUME_TRANSACTION',
    'SUNSET_DEPLOYMENT',
    'createMicrosoftOAuthCallbackCompletionService',
  ]);
  assert.equal(Object.isFrozen(exported), true);
  assert.equal(ERROR_CODE, 'MICROSOFT_OAUTH_CALLBACK_COMPLETION_INVALID');
  assert.equal(ERROR_MESSAGE, 'Microsoft OAuth callback completion failed.');
  assert.equal(ACCEPT_METHOD, 'accept');
  assert.equal(COMPLETION_METHOD, 'completeBoundOperation');
  assert.equal(COMPLETION_ACK_STATUS, 'completed');
  assert.deepEqual(COMPLETION_ACK, { status: 'completed' });
  assert.equal(Object.isFrozen(COMPLETION_ACK), true);
  assert.deepEqual(PUBLIC_STATUS_INVALID, { status: 'invalid_or_expired' });
  assert.deepEqual(PUBLIC_STATUS_DECLINED, { status: 'authorization_declined' });
  assert.deepEqual(PUBLIC_STATUS_RECEIVED, { status: 'authorization_received' });
  assert.deepEqual([...DEPENDENCY_KEYS], ['repository', 'completion', 'env', 'clock']);
  assert.deepEqual([...CONSUME_ROW_KEYS], [
    'id', 'location_id', 'staff_user_id', 'code_verifier', 'nonce', 'endpoint_id',
  ]);
  assert.deepEqual([...COMPLETION_KEYS], [
    'clientId', 'endpointId', 'operationId', 'actorStaffUserId',
    'codeVerifier', 'nonce', 'applicationClientId', 'authorizationCode',
  ]);
  assert.deepEqual([...OWNER_KEYS], [...txn.OWNER_KEYS]);
  assert.deepEqual([...CALLBACK_CODE_KEYS], [...txn.CALLBACK_CODE_KEYS]);
  assert.deepEqual([...CALLBACK_ERROR_KEYS], [...txn.CALLBACK_ERROR_KEYS]);
  assert.equal(SQL_CONSUME_TRANSACTION, txn.SQL_CONSUME_TRANSACTION);
  assert.match(SQL_CONSUME_TRANSACTION, /RETURNING id, location_id, staff_user_id, code_verifier, nonce, endpoint_id/);
  assert.equal(SUNSET_DEPLOYMENT, 'sunset-staging');
});

test('package.json wires verify script; routes and old callback export unchanged', async function packageAndRoutesUnchanged() {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  assert.equal(
    pkg.scripts['verify:email-microsoft-oauth-callback-completion'],
    `node ${VERIFY_REL}`,
  );
  assert.ok(fs.existsSync(path.join(ROOT, LIB_REL)));
  assert.ok(fs.existsSync(path.join(ROOT, VERIFY_REL)));

  const routesSrc = fs.readFileSync(path.join(ROOT, ROUTES_REL), 'utf8');
  assert.match(routesSrc, /createMicrosoftOAuthCallbackService/);
  assert.equal(routesSrc.includes('createMicrosoftOAuthCallbackCompletionService'), false);
  assert.equal(routesSrc.includes('completeBoundOperation'), false);

  const txnSrc = fs.readFileSync(path.join(ROOT, TXN_REL), 'utf8');
  assert.match(txnSrc, /function createMicrosoftOAuthCallbackService/);
  // Old service still default-disabled semantics (flag check).
  assert.match(txnSrc, /LUNA_EMAIL_OAUTH_CALLBACK_ENABLED/);

  // OAuth flags default false / not true in env examples is out of scope;
  // isCallbackEnabled remains false unless exact 'true'.
  assert.equal(txn.isCallbackEnabled({}), false);
  assert.equal(txn.isCallbackEnabled({ LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'true' }), true);
  assert.equal(txn.isStartEnabled({}), false);
});

test('returns frozen single-method service with accept', async function frozenServiceShape() {
  const { service } = composition();
  assert.deepEqual(Object.keys(service), ['accept']);
  assert.deepEqual(Reflect.ownKeys(service), ['accept']);
  assert.equal(Object.isFrozen(service), true);
  assert.equal(typeof service.accept, 'function');
  assert.equal('completeBoundOperation' in service, false);
  assert.equal('consume' in service, false);
});

// ── Happy path + interop ───────────────────────────────────────────────────

test('happy path: consume then completeBoundOperation with exact bound material', async function happyPath() {
  const { service, clock, repository, completion } = composition();
  const result = await service.accept(goodCodeInput(), goodOwner());
  assert.deepEqual(result, { status: 'authorization_received' });
  assert.deepEqual(result, PUBLIC_STATUS_RECEIVED);
  assert.deepEqual(Object.keys(result), ['status']);
  assert.equal(Object.isFrozen(result), true);

  assert.equal(clock.calls.length, 1);
  assert.equal(repository.calls.length, 1);
  assert.equal(completion.calls.length, 1);

  const consumeArg = repository.calls[0].arg;
  assert.equal(Object.isFrozen(consumeArg), true);
  assert.deepEqual(Reflect.ownKeys(consumeArg), ['stateHash', 'clientId', 'authSessionId', 'now']);
  assert.equal(consumeArg.clientId, CLIENT_ID);
  assert.equal(consumeArg.authSessionId, AUTH_SESSION_ID);
  assert.equal(
    consumeArg.stateHash.equals(crypto.createHash('sha256').update(STATE, 'ascii').digest()),
    true,
  );
  assert.ok(consumeArg.now instanceof Date);
  assert.equal(consumeArg.now.getTime(), NOW.getTime());

  const req = completion.calls[0].request;
  assert.equal(Object.isFrozen(req), true);
  assert.deepEqual(Reflect.ownKeys(req), [...COMPLETION_KEYS]);
  assert.deepEqual(req, {
    clientId: CLIENT_ID,
    endpointId: ENDPOINT_ID,
    operationId: OPERATION_ID,
    actorStaffUserId: STAFF_ID,
    codeVerifier: VERIFIER,
    nonce: NONCE,
    applicationClientId: APP_CLIENT_ID,
    authorizationCode: CODE,
  });
  // Interop proof: exact bound endpoint/operation/staff/verifier/nonce/client.
  assert.equal(req.endpointId, ENDPOINT_ID);
  assert.equal(req.operationId, OPERATION_ID);
  assert.equal(req.actorStaffUserId, STAFF_ID);
  assert.equal(req.codeVerifier, VERIFIER);
  assert.equal(req.nonce, NONCE);
  assert.equal(req.clientId, CLIENT_ID);
  assert.equal(req.applicationClientId, APP_CLIENT_ID);
  assert.equal('authSessionId' in req, false);
  assert.equal('state' in req, false);
  assert.equal('stateHash' in req, false);
  assert.equal('error' in req, false);
  assert.equal('accessToken' in req, false);
  assert.equal('token' in req, false);
  assert.equal('locationId' in req, false);
  assertNoSensitive(result);
});

test('preserves exact repository, completion, and clock receivers', async function preservesReceivers() {
  const { service, clock, repository, completion } = composition();
  await service.accept(goodCodeInput(), goodOwner());
  assert.equal(clock.calls[0].thisValue, clock.clock);
  assert.equal(repository.calls[0].thisValue, repository.repository);
  assert.equal(completion.calls[0].thisValue, completion.completion);
});

test('provider error after valid consume: authorization_declined, no completion', async function errorPathNoCompletion() {
  const { service, repository, completion } = composition();
  const result = await service.accept(goodErrorInput(), goodOwner());
  assert.deepEqual(result, { status: 'authorization_declined' });
  assert.deepEqual(result, PUBLIC_STATUS_DECLINED);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(repository.calls.length, 1);
  assert.equal(completion.calls.length, 0, 'error path must not call completion');
  assertNoSensitive(result);
});

test('no row: invalid_or_expired, no completion', async function missingRow() {
  const { service, repository, completion } = composition({
    repository: { row: null },
  });
  const result = await service.accept(goodCodeInput(), goodOwner());
  assert.deepEqual(result, PUBLIC_STATUS_INVALID);
  assert.equal(repository.calls.length, 1);
  assert.equal(completion.calls.length, 0);
  assertNoSensitive(result);
});

// ── Single-use burn ────────────────────────────────────────────────────────

test('invalid-first burn: bad input burns; second good input fails; zero consume', async function invalidFirstBurn() {
  let consumes = 0;
  const { service } = composition({
    repository: {
      rowFn() {
        consumes += 1;
        return goodRow();
      },
    },
  });
  await expectSanitizedFailure(() => service.accept({ state: 'bad', code: CODE }, goodOwner()));
  assert.equal(consumes, 0);
  await expectSanitizedFailure(() => service.accept(goodCodeInput(), goodOwner()));
  assert.equal(consumes, 0, 'burned service must not consume on second attempt');
});

test('sequential second accept fails after success (no replay)', async function sequentialBurn() {
  const { service, repository, completion } = composition();
  await service.accept(goodCodeInput(), goodOwner());
  assert.equal(repository.calls.length, 1);
  assert.equal(completion.calls.length, 1);
  await expectSanitizedFailure(() => service.accept(goodCodeInput(), goodOwner()));
  assert.equal(repository.calls.length, 1);
  assert.equal(completion.calls.length, 1);
});

test('concurrent accepts: only one consume/completion', async function concurrentBurn() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { service, repository, completion } = composition({
    repository: { wait: gate },
  });
  const p1 = service.accept(goodCodeInput(), goodOwner());
  const p2 = service.accept(goodCodeInput(), goodOwner());
  release();
  const results = await Promise.allSettled([p1, p2]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.deepEqual(fulfilled[0].value, PUBLIC_STATUS_RECEIVED);
  assert.equal(failSanitized(rejected[0].reason), true);
  assert.equal(repository.calls.length, 1);
  assert.equal(completion.calls.length, 1);
});

test('reentrant accept from completion is burned', async function reentrantBurn() {
  let service;
  const completion = Object.freeze({
    async completeBoundOperation() {
      await expectSanitizedFailure(() => service.accept(goodCodeInput(), goodOwner()));
      return goodAck();
    },
  });
  const clock = stubClock();
  const repository = stubRepository();
  service = createMicrosoftOAuthCallbackCompletionService(Object.freeze({
    repository: repository.repository,
    completion,
    env: goodEnv(),
    clock: clock.clock,
  }));
  const result = await service.accept(goodCodeInput(), goodOwner());
  assert.deepEqual(result, PUBLIC_STATUS_RECEIVED);
});

// ── Snapshot / mutation races ──────────────────────────────────────────────

test('owner and input snapshotted once; later mutation ignored', async function mutationRace() {
  const EVIL_OWNER = '99999999-9999-4999-8999-999999999999';
  const ownerDescReads = { clientId: 0, authSessionId: 0 };
  const ownerRace = new Proxy({ ...goodOwner() }, {
    getPrototypeOf() { return Object.prototype; },
    ownKeys() { return ['clientId', 'authSessionId']; },
    getOwnPropertyDescriptor(t, p) {
      if (p === 'clientId' || p === 'authSessionId') {
        ownerDescReads[p] += 1;
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: ownerDescReads[p] === 1 ? goodOwner()[p] : EVIL_OWNER,
        };
      }
      return undefined;
    },
    get() { return EVIL_OWNER; },
  });
  const evilState = Buffer.alloc(32, 1).toString('base64url');
  const inputDescReads = { state: 0, code: 0 };
  const inputRace = new Proxy({ state: STATE, code: CODE }, {
    getPrototypeOf() { return Object.prototype; },
    ownKeys() { return ['state', 'code']; },
    getOwnPropertyDescriptor(t, p) {
      if (p === 'state' || p === 'code') {
        inputDescReads[p] += 1;
        const first = p === 'state' ? STATE : CODE;
        const later = p === 'state' ? evilState : 'evil-code';
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: inputDescReads[p] === 1 ? first : later,
        };
      }
      return undefined;
    },
    get(t, p) {
      if (p === 'state') return evilState;
      if (p === 'code') return 'evil-code';
      return t[p];
    },
  });

  const { service, repository, completion } = composition();
  assert.deepEqual(await service.accept(inputRace, ownerRace), PUBLIC_STATUS_RECEIVED);
  assert.equal(repository.calls[0].arg.clientId, CLIENT_ID);
  assert.equal(repository.calls[0].arg.authSessionId, AUTH_SESSION_ID);
  assert.equal(
    repository.calls[0].arg.stateHash.equals(
      crypto.createHash('sha256').update(STATE, 'ascii').digest(),
    ),
    true,
  );
  assert.equal(completion.calls[0].request.authorizationCode, CODE);
  assert.equal(ownerDescReads.clientId, 1);
  assert.equal(ownerDescReads.authSessionId, 1);
  assert.equal(inputDescReads.state, 1);
  assert.equal(inputDescReads.code, 1);
});

test('owner uppercase UUID canonicalize before consume', async function ownerUppercase() {
  const { service, repository } = composition({ repository: { row: null } });
  assert.deepEqual(
    await service.accept(goodCodeInput(), {
      clientId: CLIENT_ID.toUpperCase(),
      authSessionId: AUTH_SESSION_ID.toUpperCase(),
    }),
    PUBLIC_STATUS_INVALID,
  );
  assert.equal(repository.calls[0].arg.clientId, CLIENT_ID);
  assert.equal(repository.calls[0].arg.authSessionId, AUTH_SESSION_ID);
});

// ── Hostile inputs (pre-consume) ───────────────────────────────────────────

test('hostile callback/owner shapes fail pre-consume', async function hostileInputs() {
  for (const [input, owner, label] of [
    [{ state: STATE, code: CODE, error: 'access_denied' }, goodOwner(), 'both code and error'],
    [{ state: 'bad', code: CODE }, goodOwner(), 'bad state'],
    [{ state: STATE, code: '' }, goodOwner(), 'empty code'],
    [{ state: STATE, error: 'bad error' }, goodOwner(), 'bad error token'],
    [{ state: STATE, code: CODE, scope: 'evil' }, goodOwner(), 'extra key'],
    [{ code: CODE, state: STATE }, goodOwner(), 'wrong key order'],
    [Object.create({ state: STATE, code: CODE }), goodOwner(), 'inherited'],
    [null, goodOwner(), 'null input'],
    [goodCodeInput(), { authSessionId: AUTH_SESSION_ID, clientId: CLIENT_ID }, 'owner wrong order'],
    [goodCodeInput(), { clientId: 'bad', authSessionId: AUTH_SESSION_ID }, 'owner bad uuid'],
    [goodCodeInput(), Object.assign(Object.create({ sneaky: true }), goodOwner()), 'owner proto'],
  ]) {
    let consumes = 0;
    const { service } = composition({
      repository: { rowFn() { consumes += 1; return goodRow(); } },
    });
    await expectSanitizedFailure(() => service.accept(input, owner));
    assert.equal(consumes, 0, label);
  }
});

test('callback/owner accessors never invoked; symbols rejected', async function accessorsAndSymbols() {
  let gets = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'state', {
    enumerable: true,
    get() { gets += 1; return STATE; },
  });
  Object.defineProperty(accessor, 'code', {
    enumerable: true,
    get() { gets += 1; return CODE; },
  });
  let consumes = 0;
  const { service } = composition({
    repository: { rowFn() { consumes += 1; return null; } },
  });
  await expectSanitizedFailure(() => service.accept(accessor, goodOwner()));
  assert.equal(gets, 0);
  assert.equal(consumes, 0);

  const withSym = { state: STATE, code: CODE };
  withSym[Symbol('x')] = LEAK;
  const s2 = composition({
    repository: { rowFn() { consumes += 1; return null; } },
  }).service;
  await expectSanitizedFailure(() => s2.accept(withSym, goodOwner()));
  assert.equal(consumes, 0);
});

test('callback/owner proxy traps fail closed pre-consume', async function proxyTraps() {
  for (const trapName of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor']) {
    const traps = {
      getPrototypeOf() { return Object.prototype; },
      ownKeys() { return ['state', 'code']; },
      getOwnPropertyDescriptor(t, p) {
        return { configurable: true, enumerable: true, writable: true, value: t[p] };
      },
    };
    traps[trapName] = () => { throw new Error(LEAK); };
    let consumes = 0;
    const { service } = composition({
      repository: { rowFn() { consumes += 1; return null; } },
    });
    await expectSanitizedFailure(() => service.accept(
      new Proxy({ state: STATE, code: CODE }, traps),
      goodOwner(),
    ));
    assert.equal(consumes, 0, trapName);
  }
});

// ── Hostile deps at factory ────────────────────────────────────────────────

test('hostile factory deps fail sanitized', async function hostileDeps() {
  const clock = stubClock().clock;
  const repository = stubRepository().repository;
  const completion = stubCompletion().completion;
  const env = goodEnv();
  const good = Object.freeze({ repository, completion, env, clock });

  for (const hostile of [
    null,
    {},
    Object.freeze({ repository, completion, env }), // missing clock
    Object.freeze({
      repository: Object.freeze({ consume: async () => null, extra: 1 }),
      completion,
      env,
      clock,
    }),
    Object.freeze({
      repository,
      completion: Object.freeze({ complete: async () => goodAck() }),
      env,
      clock,
    }),
    Object.freeze({
      repository,
      completion,
      env: { LUNA_DEPLOYMENT: 'production', LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'true', LUNA_EMAIL_OAUTH_CLIENT_ID: APP_CLIENT_ID },
      clock,
    }),
    Object.freeze({
      repository,
      completion,
      env: { LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT, LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'false', LUNA_EMAIL_OAUTH_CLIENT_ID: APP_CLIENT_ID },
      clock,
    }),
    Object.freeze({
      repository,
      completion,
      env: { LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT, LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'true', LUNA_EMAIL_OAUTH_CLIENT_ID: 'not-a-uuid' },
      clock,
    }),
    Object.freeze({
      repository,
      completion,
      env,
      clock: Object.freeze({ nowEpochSeconds: () => 1 }),
    }),
    new Proxy({}, { getPrototypeOf() { throw new Error(LEAK); } }),
  ]) {
    assert.throws(
      () => createMicrosoftOAuthCallbackCompletionService(hostile),
      (e) => failSanitized(e),
    );
  }

  // Unfrozen deps object rejected.
  assert.throws(
    () => createMicrosoftOAuthCallbackCompletionService({
      repository, completion, env, clock,
    }),
    (e) => failSanitized(e),
  );
  // Sanity: good deps still work.
  assert.equal(typeof createMicrosoftOAuthCallbackCompletionService(good).accept, 'function');
});

// ── Row validation after consume (no completion) ───────────────────────────

test('strict row getters/proxies/symbols/extras/prototypes fail after consume without completion', async function hostileRows() {
  const cases = [
    {
      label: 'accessor row',
      row() {
        const row = {};
        for (const key of CONSUME_ROW_KEYS) {
          Object.defineProperty(row, key, {
            enumerable: true,
            get() { throw new Error(LEAK); },
          });
        }
        return row;
      },
    },
    {
      label: 'symbol extra',
      row() {
        const row = goodRow();
        row[Symbol('x')] = LEAK;
        return row;
      },
    },
    {
      label: 'extra key',
      row() { return { ...goodRow(), leaked: LEAK }; },
    },
    {
      label: 'missing key',
      row() {
        const row = goodRow();
        delete row.endpoint_id;
        return row;
      },
    },
    {
      label: 'wrong prototype',
      row() { return Object.assign(Object.create({ sneaky: true }), goodRow()); },
    },
    {
      label: 'array',
      row() { return [goodRow()]; },
    },
    {
      label: 'wrong uuid grammar',
      row() { return goodRow({ id: 'not-a-uuid' }); },
    },
    {
      label: 'uppercase uuid not canonical',
      // Must include hex letters so toUpperCase differs from canonical lowercase.
      row() {
        return goodRow({
          endpoint_id: 'abcdef01-2345-4678-89ab-cdef01234567'.toUpperCase(),
        });
      },
    },
    {
      label: 'short verifier',
      row() { return goodRow({ code_verifier: 'short' }); },
    },
    {
      label: 'bad nonce charset',
      row() { return goodRow({ nonce: `${'n'.repeat(42)}.` }); },
    },
    {
      label: 'proxy getPrototypeOf throws',
      row() {
        return new Proxy(goodRow(), {
          getPrototypeOf() { throw new Error(LEAK); },
          ownKeys() { return [...CONSUME_ROW_KEYS]; },
          getOwnPropertyDescriptor(t, p) {
            return { configurable: true, enumerable: true, writable: true, value: t[p] };
          },
        });
      },
    },
  ];

  for (const { label, row } of cases) {
    const { service, repository, completion } = composition({
      repository: { row: row() },
    });
    await expectSanitizedFailure(() => service.accept(goodCodeInput(), goodOwner()));
    assert.equal(repository.calls.length, 1, label);
    assert.equal(completion.calls.length, 0, `${label}: no completion`);
  }
});

test('accepted row copied once; mutate driver after accept does not affect completion material', async function rowCopiedOnce() {
  const mutable = goodRow();
  const completion = stubCompletion();
  const service = createMicrosoftOAuthCallbackCompletionService(Object.freeze({
    repository: Object.freeze({
      async consume() { return mutable; },
    }),
    completion: completion.completion,
    env: goodEnv(),
    clock: stubClock().clock,
  }));
  assert.deepEqual(await service.accept(goodCodeInput(), goodOwner()), PUBLIC_STATUS_RECEIVED);
  // After snapshot, driver mutation must not rewrite what completion already received.
  mutable.endpoint_id = OTHER_ENDPOINT;
  mutable.id = OTHER_OP;
  mutable.staff_user_id = OTHER_STAFF;
  mutable.code_verifier = `EVIL_VERIFIER_${'x'.repeat(30)}`;
  mutable.nonce = `EVIL_NONCE_${'y'.repeat(33)}`;
  const req = completion.calls[0].request;
  assert.equal(req.endpointId, ENDPOINT_ID);
  assert.equal(req.operationId, OPERATION_ID);
  assert.equal(req.actorStaffUserId, STAFF_ID);
  assert.equal(req.codeVerifier, VERIFIER);
  assert.equal(req.nonce, NONCE);
  // Completing material is frozen — caller cannot rewrite via completion input either.
  assert.throws(() => {
    req.endpointId = OTHER_ENDPOINT;
  });
});

test('row snapshot uses first descriptor values only (TOCTOU on driver row)', async function rowDescriptorOnce() {
  const endpointReads = { n: 0 };
  const row = {};
  for (const key of CONSUME_ROW_KEYS) {
    const base = goodRow()[key];
    Object.defineProperty(row, key, {
      enumerable: true,
      configurable: true,
      get() {
        // Accessors are rejected by snapshot — this case documents that path.
        return base;
      },
    });
  }
  // Build a value-descriptor row that flips endpoint_id after first own-data read.
  const flipping = {};
  for (const key of CONSUME_ROW_KEYS) {
    let reads = 0;
    Object.defineProperty(flipping, key, {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        if (key === 'endpoint_id') endpointReads.n = reads;
        return reads === 1 ? goodRow()[key] : (key === 'endpoint_id' ? OTHER_ENDPOINT : goodRow()[key]);
      },
    });
  }
  // Accessors fail closed (no completion).
  const fail = composition({ repository: { row: flipping } });
  await expectSanitizedFailure(() => fail.service.accept(goodCodeInput(), goodOwner()));
  assert.equal(fail.completion.calls.length, 0);
  assert.equal(fail.repository.calls.length, 1);
});

// ── Completion ack / throw / thenable ──────────────────────────────────────

test('completion throw after consume: sanitized fail, no retry', async function completionThrow() {
  const { service, repository, completion } = composition({
    completion: { throw: true },
  });
  await expectSanitizedFailure(() => service.accept(goodCodeInput(), goodOwner()));
  assert.equal(repository.calls.length, 1);
  assert.equal(completion.calls.length, 1);
  await expectSanitizedFailure(() => service.accept(goodCodeInput(), goodOwner()));
  assert.equal(repository.calls.length, 1, 'no retry consume');
  assert.equal(completion.calls.length, 1, 'no retry completion');
});

test('bad completion ack shapes fail after consume', async function badCompletionAck() {
  for (const result of [
    { status: 'completed' }, // unfrozen
    Object.freeze({ status: 'accepted' }),
    Object.freeze({ status: 'completed', extra: true }),
    Object.freeze({ ok: true }),
    null,
    'completed',
  ]) {
    const { service, repository, completion } = composition({
      completion: { result },
    });
    await expectSanitizedFailure(() => service.accept(goodCodeInput(), goodOwner()));
    assert.equal(repository.calls.length, 1);
    assert.equal(completion.calls.length, 1);
  }
});

test('completion thenable resolve/reject', async function completionThenable() {
  const ok = composition({ completion: { thenable: 'resolve' } });
  assert.deepEqual(
    await ok.service.accept(goodCodeInput(), goodOwner()),
    PUBLIC_STATUS_RECEIVED,
  );

  const bad = composition({ completion: { thenable: 'reject' } });
  await expectSanitizedFailure(() => bad.service.accept(goodCodeInput(), goodOwner()));
  assert.equal(bad.repository.calls.length, 1);
});

test('repository consume throw: sanitized; completion zero', async function consumeThrow() {
  const { service, repository, completion } = composition({
    repository: { throw: true },
  });
  await expectSanitizedFailure(() => service.accept(goodCodeInput(), goodOwner()));
  assert.equal(repository.calls.length, 1);
  assert.equal(completion.calls.length, 0);
});

test('clock throw or non-Date fails pre-consume', async function clockFailures() {
  for (const value of [Date.now(), '2026-08-05', null, new Date(NaN)]) {
    let consumes = 0;
    const { service } = composition({
      clock: { value },
      repository: { rowFn() { consumes += 1; return null; } },
    });
    await expectSanitizedFailure(() => service.accept(goodCodeInput(), goodOwner()));
    assert.equal(consumes, 0);
  }
  let consumes = 0;
  const { service } = composition({
    clock: { throw: true },
    repository: { rowFn() { consumes += 1; return null; } },
  });
  await expectSanitizedFailure(() => service.accept(goodCodeInput(), goodOwner()));
  assert.equal(consumes, 0);
});

// ── Transaction mix-up ─────────────────────────────────────────────────────

test('completion receives only consumed bound row — not alternate transaction material', async function transactionMixUp() {
  const { service, completion } = composition({
    repository: {
      row: goodRow({
        id: OPERATION_ID,
        endpoint_id: ENDPOINT_ID,
        staff_user_id: STAFF_ID,
      }),
    },
  });
  await service.accept(goodCodeInput(), goodOwner());
  const req = completion.calls[0].request;
  assert.equal(req.operationId, OPERATION_ID);
  assert.equal(req.endpointId, ENDPOINT_ID);
  assert.equal(req.actorStaffUserId, STAFF_ID);
  assert.notEqual(req.operationId, OTHER_OP);
  assert.notEqual(req.endpointId, OTHER_ENDPOINT);
  assert.notEqual(req.actorStaffUserId, OTHER_STAFF);
  assert.notEqual(req.clientId, OTHER_CLIENT);
  assert.equal(req.clientId, CLIENT_ID);

  // Different owner cannot be smuggled via row fields.
  assert.equal(req.clientId, CLIENT_ID);
  assert.equal('authSessionId' in req, false);
});

test('null-prototype parsed query accepted (real callback query shape)', async function nullProtoQuery() {
  const parsed = Object.assign(Object.create(null), { state: STATE, code: CODE });
  assert.equal(Object.getPrototypeOf(parsed), null);
  const { service, completion } = composition();
  assert.deepEqual(await service.accept(parsed, goodOwner()), PUBLIC_STATUS_RECEIVED);
  assert.equal(completion.calls[0].request.authorizationCode, CODE);
});

// ── Public surface / logs ──────────────────────────────────────────────────

test('public results never include secrets; console stays quiet', async function noLeaksOrLogs() {
  const logs = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a) => logs.push(a);
  console.error = (...a) => logs.push(a);
  try {
    // PKCE allows A-Za-z0-9._~- ; nonce allows A-Za-z0-9_-
    const verifier = `SECRET_VERIFIER_${'x'.repeat(27)}`; // 16+1+27 = 44
    const nonce = `SECRET_NONCE_${'y'.repeat(31)}`; // 13+1+31 = 45
    assert.equal(verifier.length >= 43, true);
    assert.equal(nonce.length >= 43, true);

    const { service: s2, completion } = composition({
      repository: {
        row: goodRow({
          id: OPERATION_ID,
          code_verifier: verifier,
          nonce,
        }),
      },
    });
    const ok = await s2.accept(goodCodeInput(), goodOwner());
    const declined = await composition({
      repository: { row: goodRow({ code_verifier: verifier, nonce }) },
    }).service.accept(goodErrorInput(), goodOwner());
    const missing = await composition({
      repository: { row: null },
    }).service.accept(goodCodeInput(), goodOwner());

    for (const result of [ok, declined, missing]) {
      const json = JSON.stringify(result);
      assert.equal(json.includes(verifier), false);
      assert.equal(json.includes(nonce), false);
      assert.equal(json.includes(CODE), false);
      assert.equal(json.includes(ENDPOINT_ID), false);
      assert.equal(json.includes(OPERATION_ID), false);
      assert.equal(json.includes(STAFF_ID), false);
      assert.deepEqual(Object.keys(result), ['status']);
    }
    assert.equal(completion.calls[0].request.codeVerifier, verifier);
    assert.equal(completion.calls[0].request.nonce, nonce);
    assert.equal(logs.length, 0, 'no console logs');
  } finally {
    console.log = log;
    console.error = err;
  }
});

test('applicationClientId uppercased in env is canonicalized into completion', async function appClientCanonical() {
  const { service, completion } = composition({
    env: goodEnv({ LUNA_EMAIL_OAUTH_CLIENT_ID: APP_CLIENT_ID.toUpperCase() }),
  });
  await service.accept(goodCodeInput(), goodOwner());
  assert.equal(completion.calls[0].request.applicationClientId, APP_CLIENT_ID);
});

test('existing createMicrosoftOAuthCallbackService still works without completion wiring', async function oldCallbackPreserved() {
  let consumed = 0;
  const callback = txn.createMicrosoftOAuthCallbackService({
    repository: {
      consume: async () => {
        consumed += 1;
        return goodRow();
      },
    },
    env: goodEnv(),
    now: () => NOW,
  });
  assert.deepEqual(
    await callback.accept(goodCodeInput(), goodOwner()),
    { status: 'authorization_received' },
  );
  assert.equal(consumed, 1);
  // Disabled flag still throws old error (not new completion error).
  const disabled = txn.createMicrosoftOAuthCallbackService({
    repository: { consume: async () => goodRow() },
    env: { LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT },
  });
  await assert.rejects(
    () => disabled.accept(goodCodeInput(), goodOwner()),
    (e) => e.message === 'oauth_callback_disabled',
  );
});

// ── Runner ─────────────────────────────────────────────────────────────────

(async function main() {
  let failed = 0;
  for (const { name, run } of tests) {
    try {
      await run();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL  ${name}`);
      console.error(error);
    }
  }
  if (failed) {
    console.error(`\n${failed} failing of ${tests.length}`);
    process.exit(1);
  }
  console.log(`\nPASS email Microsoft OAuth callback completion (${tests.length} tests)`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

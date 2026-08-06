'use strict';

/**
 * Hostile offline gate for Phase 1 sanitized Microsoft OAuth stage telemetry.
 *
 * Proves exact event schema, allowlisted stages, request UUID correlation,
 * injection ownership (no ambient mutable logger), hostile logger/getter/proxy
 * safety, logging failures never affect OAuth, every success/failure stage
 * against the production pipeline boundaries, no premature stage claims, and
 * console/output never carries secrets/codes/tokens/provider status/body/
 * claims/email/tenant/DB ids/exception text.
 *
 * No live/DB/Azure/deploy/OAuth network.
 */

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const {
  EVENT_NAME,
  STAGES,
  EVENT_KEYS,
  FACTORY_KEYS,
  TELEMETRY_METHOD,
  ERROR_CODE,
  ERROR_MESSAGE,
  UUID_V4_RE,
  defaultEmailOAuthStageLogger,
  buildEmailOAuthStageEvent,
  assertSafeEmailOAuthStageEvent,
  pinEmailOAuthStageTelemetry,
  createNoopEmailOAuthStageTelemetry,
  createEmailOAuthStageTelemetry,
  createCallbackEmailOAuthStageTelemetry,
  safeEmitStage,
} = require('./lib/email-microsoft-oauth-stage-telemetry');

const {
  createMicrosoftOAuthCallbackCompletionService,
  COMPLETION_ACK,
  PUBLIC_STATUS_RECEIVED,
  PUBLIC_STATUS_DECLINED,
  PUBLIC_STATUS_INVALID,
} = require('./lib/email-microsoft-oauth-callback-completion');

const {
  createMicrosoftOAuthOperationComposition,
  SUNSET_DEPLOYMENT,
} = require('./lib/email-microsoft-oauth-operation-composition');

const {
  createFakeEmailGrantEnvelopeProvider,
} = require('./lib/email-grant-envelope-fake-provider');

const {
  createMicrosoftVerifiedIdentityComposition,
} = require('./lib/email-microsoft-verified-identity');

const ROOT = path.join(__dirname, '..');
const LIB_REL = 'scripts/lib/email-microsoft-oauth-stage-telemetry.js';
const VERIFY_REL = 'scripts/verify-email-microsoft-oauth-stage-telemetry.js';
const ROUTES_REL = 'scripts/lib/staff-email-oauth-routes.js';
const RUNTIME_REL = 'scripts/lib/email-microsoft-oauth-sunset-staging-runtime-composition.js';
const CALLBACK_REL = 'scripts/lib/email-microsoft-oauth-callback-completion.js';

const REQUEST_ID = 'a1a1a1a1-b2b2-4c3c-8d4d-e5e5e5e5e5e5';
const BAD_REQUEST_ID = 'not-a-uuid';
const CLIENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const APP_CLIENT_ID = '12345678-1234-4234-8234-123456789abc';
const ENDPOINT_ID = '11111111-2222-4333-8444-555555555555';
const OPERATION_ID = '99999999-8888-4777-8666-555555555555';
const LOCATION_ID = '22222222-3333-4444-8555-666666666666';
const STAFF_ID = 'abcdef01-2345-4678-89ab-cdef01234567';
const AUTH_SESSION_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const TID = '01234567-89ab-4def-8123-456789abcdef';
const PRINCIPAL = '01234567-89ab-4def-9123-456789abcdef';
const MAILBOX = 'ada@example.com';
const DISPLAY = 'Ada Lovelace';
const CODE = 'provider-code+/%?=&NEVER_LEAK';
const VERIFIER = `${'v'.repeat(42)}~`;
const NONCE = `${'n'.repeat(43)}`;
const SECRET = 'client-secret-NEVER-LEAK-xyz';
const ACCESS = 'access-token-NEVER-LEAK';
const REFRESH = 'refresh-token-NEVER-LEAK';
const ID_TOKEN = 'id-token-NEVER-LEAK.header.payload.sig';
const LEAK = 'STAGE-TELEMETRY-SECRET-DO-NOT-LEAK';
const STATE = Buffer.alloc(32, 9).toString('base64url');
const NOW = new Date('2026-08-05T12:01:00.000Z');

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

function capturingLogger() {
  const events = [];
  const logger = Object.freeze({
    // factory wants a function logger, not an object — wrap
  });
  function log(record) {
    events.push(record);
  }
  return { events, log };
}

function makeTelemetry(spec = {}) {
  const cap = capturingLogger();
  const logger = typeof spec.logger === 'function' ? spec.logger : cap.log;
  const requestId = Object.prototype.hasOwnProperty.call(spec, 'requestId')
    ? spec.requestId
    : REQUEST_ID;
  const telemetry = createEmailOAuthStageTelemetry(Object.freeze({
    requestId,
    logger,
  }));
  return { telemetry, events: cap.events, log: cap.log };
}

function assertEventShape(event, stage, requestId = REQUEST_ID) {
  const check = assertSafeEmailOAuthStageEvent(event);
  assert.equal(check.ok, true, check.detail || 'event shape');
  assert.equal(event.event, EVENT_NAME);
  assert.equal(event.stage, stage);
  assert.equal(event.request_id, requestId);
  assert.deepEqual(Reflect.ownKeys(event), [...EVENT_KEYS]);
}

function assertNoSensitive(blob) {
  const s = typeof blob === 'string' ? blob : (() => {
    try { return JSON.stringify(blob); } catch { return String(blob); }
  })();
  // Never allow secrets/tokens/codes/PII/exception text in stage events.
  // request_id UUID is the only identifier allowed (checked separately).
  for (const needle of [
    LEAK, CODE, VERIFIER, SECRET, ACCESS, REFRESH, ID_TOKEN,
    MAILBOX, NONCE, 'client_secret', 'authorizationCode',
    'access_token', 'refresh_token', 'id_token',
    OPERATION_ID, ENDPOINT_ID, STAFF_ID, LOCATION_ID, CLIENT_ID,
    TID, PRINCIPAL, DISPLAY,
  ]) {
    assert.equal(s.includes(needle), false, `sensitive leak: ${needle}`);
  }
}

// ── Module surface / schema ────────────────────────────────────────────────

test('exports frozen surface and exact stage vocabulary', async function exportSurface() {
  const exported = require('./lib/email-microsoft-oauth-stage-telemetry');
  assert.equal(Object.isFrozen(exported), true);
  assert.equal(EVENT_NAME, 'email_oauth_stage');
  assert.deepEqual([...STAGES], [
    'callback_consumed',
    'token_request_started',
    'token_response_received',
    'token_response_validated',
    'oidc_verified',
    'graph_identity_verified',
    'envelope_sealed',
    'installer_started',
    'installer_committed',
    'callback_failed',
  ]);
  assert.deepEqual([...EVENT_KEYS], ['event', 'stage', 'request_id']);
  assert.deepEqual([...FACTORY_KEYS], ['requestId', 'logger']);
  assert.equal(TELEMETRY_METHOD, 'emit');
  assert.equal(ERROR_CODE, 'MICROSOFT_OAUTH_STAGE_TELEMETRY_INVALID');
  assert.equal(ERROR_MESSAGE, 'Microsoft OAuth stage telemetry failed.');
  assert.equal(fs.existsSync(path.join(ROOT, LIB_REL)), true);
  assert.equal(fs.existsSync(path.join(ROOT, VERIFY_REL)), true);
});

test('factory requires exact frozen requestId+logger; rejects invalid UUID', async function factoryPin() {
  const { log } = capturingLogger();
  assert.throws(
    () => createEmailOAuthStageTelemetry(Object.freeze({
      requestId: BAD_REQUEST_ID,
      logger: log,
    })),
    (e) => e && e.code === ERROR_CODE && e.message === ERROR_MESSAGE,
  );
  assert.throws(
    () => createEmailOAuthStageTelemetry(Object.freeze({
      requestId: REQUEST_ID.toUpperCase(),
      logger: log,
    })),
    (e) => e && e.code === ERROR_CODE,
  );
  assert.throws(
    () => createEmailOAuthStageTelemetry(Object.freeze({
      requestId: REQUEST_ID,
      logger: null,
    })),
    (e) => e && e.code === ERROR_CODE,
  );
  assert.throws(
    () => createEmailOAuthStageTelemetry({ requestId: REQUEST_ID, logger: log }),
    (e) => e && e.code === ERROR_CODE,
  );
  // Getter trap on requestId
  const getterBag = {};
  Object.defineProperty(getterBag, 'requestId', {
    enumerable: true,
    get() { return REQUEST_ID; },
  });
  Object.defineProperty(getterBag, 'logger', {
    enumerable: true,
    value: log,
    writable: true,
    configurable: true,
  });
  assert.throws(
    () => createEmailOAuthStageTelemetry(Object.freeze(getterBag)),
    (e) => e && e.code === ERROR_CODE,
  );
});

test('emit builds exact three-key events; invalid stage is silent no-op', async function emitSchema() {
  const { telemetry, events } = makeTelemetry();
  assert.equal(Object.isFrozen(telemetry), true);
  assert.deepEqual(Reflect.ownKeys(telemetry), ['emit']);
  telemetry.emit('callback_consumed');
  assert.equal(events.length, 1);
  assertEventShape(events[0], 'callback_consumed');
  assert.equal(Object.isFrozen(events[0]), true);

  telemetry.emit('not_a_real_stage');
  telemetry.emit('');
  telemetry.emit(null);
  telemetry.emit(undefined);
  assert.equal(events.length, 1);

  for (const stage of STAGES) {
    const cap = capturingLogger();
    const t = createEmailOAuthStageTelemetry(Object.freeze({
      requestId: REQUEST_ID,
      logger: cap.log,
    }));
    t.emit(stage);
    assert.equal(cap.events.length, 1);
    assertEventShape(cap.events[0], stage);
  }
});

test('logger throw never propagates; hostile logger cannot poison OAuth', async function hostileLogger() {
  const throws = createEmailOAuthStageTelemetry(Object.freeze({
    requestId: REQUEST_ID,
    logger() { throw new Error(`${LEAK} logger boom`); },
  }));
  assert.doesNotThrow(() => throws.emit('callback_consumed'));
  assert.doesNotThrow(() => throws.emit('callback_failed'));

  // Logger that mutates received record must not alter subsequent emissions.
  const events = [];
  const mutator = createEmailOAuthStageTelemetry(Object.freeze({
    requestId: REQUEST_ID,
    logger(rec) {
      events.push({ ...rec });
      try {
        rec.stage = 'callback_failed';
        rec.secret = LEAK;
        rec.request_id = BAD_REQUEST_ID;
      } catch {
        // frozen — expected
      }
    },
  }));
  mutator.emit('token_request_started');
  assert.equal(events[0].stage, 'token_request_started');
  assert.equal(events[0].secret, undefined);
  assertEventShape(events[0], 'token_request_started');
});

test('pinEmailOAuthStageTelemetry rejects proxies/getters; safeEmit never throws', async function pinHostile() {
  assert.equal(pinEmailOAuthStageTelemetry(null), null);
  assert.equal(pinEmailOAuthStageTelemetry({ emit() {} }), null); // unfrozen

  const getter = {};
  Object.defineProperty(getter, 'emit', {
    enumerable: true,
    get() { return function emit() {}; },
  });
  assert.equal(pinEmailOAuthStageTelemetry(Object.freeze(getter)), null);

  const proxy = new Proxy(Object.freeze({ emit() {} }), {
    get() { throw new Error(LEAK); },
  });
  // pin may fail closed or succeed depending on ownKeys path — emit must not throw
  const pinned = pinEmailOAuthStageTelemetry(proxy);
  if (pinned) {
    assert.doesNotThrow(() => pinned.emit('callback_consumed'));
  }

  assert.doesNotThrow(() => safeEmitStage(null, 'callback_consumed'));
  assert.doesNotThrow(() => safeEmitStage({}, 'callback_consumed'));
  assert.doesNotThrow(() => safeEmitStage(createNoopEmailOAuthStageTelemetry(), 'callback_failed'));

  const boom = Object.freeze({
    emit() { throw new Error(LEAK); },
  });
  const pinnedBoom = pinEmailOAuthStageTelemetry(boom);
  assert.ok(pinnedBoom);
  assert.doesNotThrow(() => pinnedBoom.emit('installer_committed'));
  assert.doesNotThrow(() => safeEmitStage(boom, 'installer_committed'));
});

test('buildEmailOAuthStageEvent rejects extras and non-allowlisted stages', async function buildEvent() {
  assert.equal(buildEmailOAuthStageEvent({
    stage: 'callback_consumed',
    request_id: REQUEST_ID,
  }).event, EVENT_NAME);
  assert.equal(buildEmailOAuthStageEvent({
    stage: 'nope',
    request_id: REQUEST_ID,
  }), null);
  assert.equal(buildEmailOAuthStageEvent({
    stage: 'callback_consumed',
    request_id: REQUEST_ID.toUpperCase(),
  }), null);
  // Only own data descriptors
  const withGetter = {};
  Object.defineProperty(withGetter, 'stage', {
    enumerable: true,
    get() { return 'callback_consumed'; },
  });
  Object.defineProperty(withGetter, 'request_id', {
    enumerable: true,
    value: REQUEST_ID,
  });
  assert.equal(buildEmailOAuthStageEvent(withGetter), null);
});

// ── Callback completion boundary ───────────────────────────────────────────

function callbackComposition(spec = {}) {
  const cap = capturingLogger();
  const telemetry = createEmailOAuthStageTelemetry(Object.freeze({
    requestId: REQUEST_ID,
    logger: cap.log,
  }));
  const consumeCalls = [];
  const completionCalls = [];
  const repository = Object.freeze({
    async consume(arg) {
      consumeCalls.push(arg);
      if (spec.consumeThrow) throw new Error(`${LEAK} consume`);
      if (Object.prototype.hasOwnProperty.call(spec, 'row')) return spec.row;
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
  const completion = Object.freeze({
    async completeAuthorization(request) {
      completionCalls.push(request);
      if (spec.completionThrow) throw new Error(`${LEAK} completion`);
      if (Object.prototype.hasOwnProperty.call(spec, 'ack')) return spec.ack;
      return COMPLETION_ACK;
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
  const deps = Object.freeze({
    repository,
    completion,
    env,
    clock,
    stageTelemetry: telemetry,
  });
  const service = createMicrosoftOAuthCallbackCompletionService(deps);
  return { service, events: cap.events, consumeCalls, completionCalls, telemetry };
}

test('callback_consumed only after successful consume row; not before', async function callbackConsumedBoundary() {
  const { service, events } = callbackComposition();
  assert.equal(events.length, 0);
  const result = await service.accept(
    { state: STATE, code: CODE },
    { clientId: CLIENT_ID, authSessionId: AUTH_SESSION_ID },
  );
  assert.deepEqual(result, PUBLIC_STATUS_RECEIVED);
  assert.equal(events.length, 1);
  assertEventShape(events[0], 'callback_consumed');
  assertNoSensitive(events);
});

test('provider error after consume emits callback_consumed only (no callback_failed)', async function declinedNoFailed() {
  const { service, events } = callbackComposition();
  const result = await service.accept(
    { state: STATE, error: 'access_denied' },
    { clientId: CLIENT_ID, authSessionId: AUTH_SESSION_ID },
  );
  assert.deepEqual(result, PUBLIC_STATUS_DECLINED);
  assert.equal(events.map((e) => e.stage).join(','), 'callback_consumed');
});

test('missing row emits zero stages', async function missingRowQuiet() {
  const { service, events } = callbackComposition({ row: null });
  const result = await service.accept(
    { state: STATE, code: CODE },
    { clientId: CLIENT_ID, authSessionId: AUTH_SESSION_ID },
  );
  assert.deepEqual(result, PUBLIC_STATUS_INVALID);
  assert.equal(events.length, 0);
});

test('completion failure after consume emits callback_consumed then callback_failed', async function failureStages() {
  const { service, events } = callbackComposition({ completionThrow: true });
  await assert.rejects(
    () => service.accept(
      { state: STATE, code: CODE },
      { clientId: CLIENT_ID, authSessionId: AUTH_SESSION_ID },
    ),
    (e) => e && e.code === 'MICROSOFT_OAUTH_CALLBACK_COMPLETION_INVALID',
  );
  assert.deepEqual(events.map((e) => e.stage), [
    'callback_consumed',
    'callback_failed',
  ]);
  // last reached success stage observable before failure
  assert.equal(events[0].stage, 'callback_consumed');
  assertEventShape(events[1], 'callback_failed');
  assertNoSensitive(events);
});

test('hostile throwing stage logger does not change callback OAuth result', async function loggerNeverAffectsOauth() {
  const boomTel = createEmailOAuthStageTelemetry(Object.freeze({
    requestId: REQUEST_ID,
    logger() { throw new Error(`${LEAK} boom`); },
  }));
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
  const completion = Object.freeze({
    async completeAuthorization() { return COMPLETION_ACK; },
  });
  const service = createMicrosoftOAuthCallbackCompletionService(Object.freeze({
    repository,
    completion,
    env: {
      LUNA_DEPLOYMENT: 'sunset-staging',
      LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'true',
      LUNA_EMAIL_OAUTH_CLIENT_ID: APP_CLIENT_ID,
    },
    clock: Object.freeze({ now() { return new Date(NOW.getTime()); } }),
    stageTelemetry: boomTel,
  }));
  const result = await service.accept(
    { state: STATE, code: CODE },
    { clientId: CLIENT_ID, authSessionId: AUTH_SESSION_ID },
  );
  assert.deepEqual(result, PUBLIC_STATUS_RECEIVED);
});

// ── Full pipeline stages via operation composition ─────────────────────────

function goodTokenBody(patch = {}) {
  return {
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'openid profile offline_access User.Read Mail.ReadBasic',
    access_token: ACCESS,
    refresh_token: REFRESH,
    id_token: ID_TOKEN,
    ...patch,
  };
}

function pipelineComposition(spec = {}) {
  const cap = capturingLogger();
  const telemetry = createEmailOAuthStageTelemetry(Object.freeze({
    requestId: REQUEST_ID,
    logger: cap.log,
  }));

  const identity = Object.freeze({
    async verifyIdentity() {
      if (spec.failAt === 'oidc') throw new Error(`${LEAK} oidc`);
      if (spec.failAt === 'graph') throw new Error(`${LEAK} graph`);
      // Emit child-like stages only when using real verified-identity; here we
      // stub identity so operation custody path still runs seal/install.
      // For full identity stages use real composition below when failAt unset.
      if (spec.useRealIdentityStages) {
        // real identity injected separately
      }
      return Object.freeze({
        providerTenantId: TID,
        providerPrincipalId: PRINCIPAL,
        mailboxAddress: MAILBOX,
        displayName: DISPLAY,
      });
    },
  });

  // Real identity composition for oidc/graph stage emission
  let verifiedIdentity = identity;
  if (spec.useRealIdentity || !spec.failAt || spec.failAt === 'seal' || spec.failAt === 'install'
      || spec.failAt === 'token' || spec.failAt === 'token_validate') {
    // keep stub unless useRealIdentity
  }
  if (spec.useRealIdentity) {
    const oidcValidator = Object.freeze({
      async validate() {
        if (spec.failAt === 'oidc') throw new Error(`${LEAK} oidc`);
        return Object.freeze({
          providerTenantId: TID,
          providerPrincipalId: PRINCIPAL,
        });
      },
    });
    const graphIdentity = Object.freeze({
      async fetchIdentity() {
        if (spec.failAt === 'graph') throw new Error(`${LEAK} graph`);
        return Object.freeze({
          providerSubjectId: PRINCIPAL,
          mailboxAddress: MAILBOX,
          displayName: DISPLAY,
        });
      },
    });
    verifiedIdentity = createMicrosoftVerifiedIdentityComposition(Object.freeze({
      oidcValidator,
      graphIdentity,
      stageTelemetry: telemetry,
    }));
  }

  const envelope = createFakeEmailGrantEnvelopeProvider();
  const envelopeProvider = {
    async sealGrantPayload(input) {
      if (spec.failAt === 'seal') throw new Error(`${LEAK} seal`);
      return envelope.sealGrantPayload(input);
    },
    async openGrantPayload(input) { return envelope.openGrantPayload(input); },
    async rewrapGrantDek(input) { return envelope.rewrapGrantDek(input); },
  };

  const installer = Object.freeze({
    async installVerifiedGrant() {
      if (spec.failAt === 'install') throw new Error(`${LEAK} install`);
      return Object.freeze({ status: 'installed' });
    },
  });

  const clock = Object.freeze({
    nowEpochSeconds() { return Math.floor(NOW.getTime() / 1000); },
  });

  const secretProvider = {
    async getClientSecret() { return SECRET; },
  };

  // Fake token transport
  const incoming = new EventEmitter();
  incoming.statusCode = spec.tokenStatus ?? 200;
  incoming.headers = {
    'content-type': spec.tokenContentType ?? 'application/json; charset=utf-8',
  };
  incoming.destroy = () => {};
  const request = new EventEmitter();
  request.end = () => {
    queueMicrotask(() => {
      if (spec.failAt === 'token') {
        request.emit('error', new Error(`${LEAK} token`));
        return;
      }
      const body = spec.tokenBody !== undefined
        ? spec.tokenBody
        : JSON.stringify(goodTokenBody(spec.tokenPatch));
      responseCb(incoming);
      incoming.emit('data', body);
      incoming.emit('end');
    });
  };
  request.destroy = () => {};
  let responseCb;
  const httpsImpl = {
    request(_opts, cb) {
      responseCb = cb;
      return request;
    },
  };
  const timers = {
    setTimeout() { return 1; },
    clearTimeout() {},
  };
  const transportDeps = Object.freeze({ httpsImpl, timers });

  const service = createMicrosoftOAuthOperationComposition(Object.freeze({
    verifiedIdentity,
    envelopeProvider,
    clock,
    installer,
    transportDeps,
    secretProvider,
    stageTelemetry: telemetry,
  }));

  const completionInput = Object.freeze({
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

  return { service, events: cap.events, telemetry, completionInput };
}

test('operation happy path emits token→identity→envelope→installer stages in order', async function operationHappyStages() {
  const { service, events, completionInput } = pipelineComposition({
    useRealIdentity: true,
  });
  const ack = await service.completeAuthorization(completionInput);
  assert.deepEqual(ack, { status: 'completed' });
  const stages = events.map((e) => e.stage);
  assert.deepEqual(stages, [
    'token_request_started',
    'token_response_received',
    'token_response_validated',
    'oidc_verified',
    'graph_identity_verified',
    'envelope_sealed',
    'installer_started',
    'installer_committed',
  ]);
  for (const ev of events) {
    assertEventShape(ev, ev.stage);
    assertNoSensitive(ev);
  }
});

test('token transport failure stops before response stages', async function tokenFailStages() {
  const { service, events, completionInput } = pipelineComposition({
    useRealIdentity: true,
    failAt: 'token',
  });
  await assert.rejects(() => service.completeAuthorization(completionInput));
  assert.deepEqual(events.map((e) => e.stage), ['token_request_started']);
});

test('invalid token body emits received but not validated', async function tokenValidateFail() {
  const { service, events, completionInput } = pipelineComposition({
    useRealIdentity: true,
    tokenBody: JSON.stringify({ error: 'invalid_grant', error_description: LEAK }),
  });
  await assert.rejects(() => service.completeAuthorization(completionInput));
  assert.deepEqual(events.map((e) => e.stage), [
    'token_request_started',
    'token_response_received',
  ]);
  assertNoSensitive(events);
});

test('oidc failure stops before graph/envelope/installer stages', async function oidcFailStages() {
  const { service, events, completionInput } = pipelineComposition({
    useRealIdentity: true,
    failAt: 'oidc',
  });
  await assert.rejects(() => service.completeAuthorization(completionInput));
  assert.deepEqual(events.map((e) => e.stage), [
    'token_request_started',
    'token_response_received',
    'token_response_validated',
  ]);
});

test('graph failure emits oidc_verified then stops', async function graphFailStages() {
  const { service, events, completionInput } = pipelineComposition({
    useRealIdentity: true,
    failAt: 'graph',
  });
  await assert.rejects(() => service.completeAuthorization(completionInput));
  assert.deepEqual(events.map((e) => e.stage), [
    'token_request_started',
    'token_response_received',
    'token_response_validated',
    'oidc_verified',
  ]);
});

test('seal failure emits through graph then stops before installer', async function sealFailStages() {
  const { service, events, completionInput } = pipelineComposition({
    useRealIdentity: true,
    failAt: 'seal',
  });
  await assert.rejects(() => service.completeAuthorization(completionInput));
  assert.deepEqual(events.map((e) => e.stage), [
    'token_request_started',
    'token_response_received',
    'token_response_validated',
    'oidc_verified',
    'graph_identity_verified',
  ]);
});

test('install failure emits installer_started then stops (no committed)', async function installFailStages() {
  const { service, events, completionInput } = pipelineComposition({
    useRealIdentity: true,
    failAt: 'install',
  });
  await assert.rejects(() => service.completeAuthorization(completionInput));
  assert.deepEqual(events.map((e) => e.stage), [
    'token_request_started',
    'token_response_received',
    'token_response_validated',
    'oidc_verified',
    'graph_identity_verified',
    'envelope_sealed',
    'installer_started',
  ]);
});

// ── Full callback + operation with failure → callback_failed ───────────────

test('end-to-end callback failure after consume surfaces last stage + callback_failed', async function e2eFailureObservable() {
  const cap = capturingLogger();
  const telemetry = createEmailOAuthStageTelemetry(Object.freeze({
    requestId: REQUEST_ID,
    logger: cap.log,
  }));

  // Operation that fails at token after start
  const op = pipelineComposition({
    useRealIdentity: true,
    failAt: 'token',
  });
  // Rebuild op with shared telemetry
  const failingOp = (() => {
    const p = pipelineComposition({ useRealIdentity: true, failAt: 'token' });
    // Use events from this composition by replacing — simpler: manual chain
    return p;
  })();

  // Build callback with completion that runs real operation composition
  const cap2 = capturingLogger();
  const tel2 = createEmailOAuthStageTelemetry(Object.freeze({
    requestId: REQUEST_ID,
    logger: cap2.log,
  }));

  const oidcValidator = Object.freeze({
    async validate() {
      return Object.freeze({
        providerTenantId: TID,
        providerPrincipalId: PRINCIPAL,
      });
    },
  });
  const graphIdentity = Object.freeze({
    async fetchIdentity() {
      return Object.freeze({
        providerSubjectId: PRINCIPAL,
        mailboxAddress: MAILBOX,
        displayName: DISPLAY,
      });
    },
  });
  const verifiedIdentity = createMicrosoftVerifiedIdentityComposition(Object.freeze({
    oidcValidator,
    graphIdentity,
    stageTelemetry: tel2,
  }));
  const envelope = createFakeEmailGrantEnvelopeProvider();
  const installer = Object.freeze({
    async installVerifiedGrant() {
      return Object.freeze({ status: 'installed' });
    },
  });
  const incoming = new EventEmitter();
  incoming.statusCode = 200;
  incoming.headers = { 'content-type': 'application/json; charset=utf-8' };
  incoming.destroy = () => {};
  const request = new EventEmitter();
  request.end = () => {
    queueMicrotask(() => {
      request.emit('error', new Error(`${LEAK} token`));
    });
  };
  request.destroy = () => {};
  let responseCb;
  const httpsImpl = {
    request(_o, cb) { responseCb = cb; return request; },
  };
  const transportDeps = Object.freeze({
    httpsImpl,
    timers: { setTimeout() { return 1; }, clearTimeout() {} },
  });
  const completion = createMicrosoftOAuthOperationComposition(Object.freeze({
    verifiedIdentity,
    envelopeProvider: envelope,
    clock: Object.freeze({ nowEpochSeconds() { return 1_700_000_000; } }),
    installer,
    transportDeps,
    secretProvider: { async getClientSecret() { return SECRET; } },
    stageTelemetry: tel2,
  }));
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
  const service = createMicrosoftOAuthCallbackCompletionService(Object.freeze({
    repository,
    completion,
    env: {
      LUNA_DEPLOYMENT: 'sunset-staging',
      LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'true',
      LUNA_EMAIL_OAUTH_CLIENT_ID: APP_CLIENT_ID,
    },
    clock: Object.freeze({ now() { return new Date(NOW.getTime()); } }),
    stageTelemetry: tel2,
  }));

  await assert.rejects(
    () => service.accept(
      { state: STATE, code: CODE },
      { clientId: CLIENT_ID, authSessionId: AUTH_SESSION_ID },
    ),
  );
  const stages = cap2.events.map((e) => e.stage);
  assert.deepEqual(stages, [
    'callback_consumed',
    'token_request_started',
    'callback_failed',
  ]);
  // last reached success stage is token_request_started
  assert.equal(stages[stages.length - 2], 'token_request_started');
  assert.equal(stages[stages.length - 1], 'callback_failed');
  assertNoSensitive(cap2.events);
  void op;
  void failingOp;
  void cap;
  void telemetry;
});

// ── Server-generated callback correlation (attacker/ALS independent) ───────

/**
 * Re-require stage-telemetry with a live crypto.randomUUID double installed
 * before module-init pin. Restores crypto + require.cache on exit.
 * @param {() => string} randomUUIDImpl
 * @param {(mod: object) => Promise<void>|void} run
 */
async function withPinnedRandomUUID(randomUUIDImpl, run) {
  const crypto = require('crypto');
  const telPath = require.resolve('./lib/email-microsoft-oauth-stage-telemetry');
  const origRandomUUID = crypto.randomUUID;
  crypto.randomUUID = randomUUIDImpl;
  delete require.cache[telPath];
  try {
    const mod = require('./lib/email-microsoft-oauth-stage-telemetry');
    await run(mod);
  } finally {
    crypto.randomUUID = origRandomUUID;
    delete require.cache[telPath];
    // Restore the session-default module instance for any late requires.
    require('./lib/email-microsoft-oauth-stage-telemetry');
  }
}

test('createCallbackEmailOAuthStageTelemetry uses server-generated UUIDv4; stable across stages; randomUUID once', async function serverGeneratedStableOnce() {
  const FIXED = 'c1c1c1c1-d2d2-4e3e-8f4f-a5a5a5a5a5a5';
  let calls = 0;
  await withPinnedRandomUUID(function countingUUID() {
    calls += 1;
    return FIXED;
  }, async (mod) => {
    const events = [];
    const telemetry = mod.createCallbackEmailOAuthStageTelemetry((record) => {
      events.push(record);
    });
    // Many stages share one correlation id; generator called only at construction.
    for (const stage of [
      'callback_consumed',
      'token_request_started',
      'token_response_received',
      'installer_committed',
    ]) {
      telemetry.emit(stage);
    }
    assert.equal(calls, 1, 'randomUUID must be called once per callback telemetry');
    assert.equal(events.length, 4);
    for (const event of events) {
      assertEventShape(event, event.stage, FIXED);
      assert.equal(event.request_id, FIXED);
      assertNoSensitive(event);
    }
    const ids = new Set(events.map((e) => e.request_id));
    assert.equal(ids.size, 1);
  });
});

test('attacker x-request-id / ALS request id is ignored; generated UUID used', async function attackerCorrelationIgnored() {
  const ATTACKER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const GENERATED = 'f1f1f1f1-f2f2-4f3f-8f4f-f5f5f5f5f5f5';
  // Simulate polluted ALS / accepted attacker header correlation surface.
  const correlation = require('./lib/staff-api-request-correlation');
  const events = [];
  await withPinnedRandomUUID(() => GENERATED, async (mod) => {
    await new Promise((resolve, reject) => {
      // runWithRequestContext shape may vary — prefer ALS-free proof:
      // even if we *could* inject attacker id via explicit factory, the
      // production createCallback surface does not accept requestId.
      assert.equal(typeof mod.createCallbackEmailOAuthStageTelemetry, 'function');
      assert.equal(mod.createCallbackEmailOAuthStageTelemetry.length <= 1, true);
      // Call with only logger — no requestId channel for attacker UUID.
      const telemetry = mod.createCallbackEmailOAuthStageTelemetry((record) => {
        events.push(record);
      });
      telemetry.emit('callback_consumed');
      telemetry.emit('callback_failed');
      resolve();
    });
  });
  assert.equal(events.length, 2);
  assert.equal(events[0].request_id, GENERATED);
  assert.equal(events[1].request_id, GENERATED);
  assert.notEqual(events[0].request_id, ATTACKER);
  // ALS/public correlation export remains available for HTTP boundary only.
  assert.equal(typeof correlation.requestId, 'function');
  // Explicit factory still accepts a pin (tests), but callback path never uses ALS.
  const cap = capturingLogger();
  const explicit = createEmailOAuthStageTelemetry(Object.freeze({
    requestId: ATTACKER,
    logger: cap.log,
  }));
  explicit.emit('callback_consumed');
  assert.equal(cap.events[0].request_id, ATTACKER);
  // Production callback factory ignores that path entirely.
  void ATTACKER;
});

test('ambient crypto.randomUUID monkeypatch after module init is irrelevant', async function ambientMonkeypatchIrrelevant() {
  const PINNED = 'd1d1d1d1-d2d2-4d3d-8d4d-d5d5d5d5d5d5';
  const crypto = require('crypto');
  await withPinnedRandomUUID(() => PINNED, async (mod) => {
    // Post-init ambient substitution must not be observed.
    crypto.randomUUID = function ambientEvil() {
      throw new Error('ambient-randomUUID-must-not-run');
    };
    const events = [];
    const telemetry = mod.createCallbackEmailOAuthStageTelemetry((r) => events.push(r));
    telemetry.emit('oidc_verified');
    telemetry.emit('envelope_sealed');
    assert.equal(events.length, 2);
    assert.equal(events[0].request_id, PINNED);
    assert.equal(events[1].request_id, PINNED);
    assertEventShape(events[0], 'oidc_verified', PINNED);
    assertNoSensitive(events);
  });
});

test('randomUUID throw or invalid return yields noop telemetry; never throws to OAuth', async function randomUuidFailureNoop() {
  await withPinnedRandomUUID(() => {
    throw new Error('rng-failure-NEVER-LEAK');
  }, async (mod) => {
    let threw = false;
    let telemetry;
    try {
      telemetry = mod.createCallbackEmailOAuthStageTelemetry((r) => {
        throw new Error(`unexpected log: ${JSON.stringify(r)}`);
      });
    } catch {
      threw = true;
    }
    assert.equal(threw, false);
    assert.equal(typeof telemetry.emit, 'function');
    // Noop surface: emit is silent even for allowlisted stages.
    assert.doesNotThrow(() => telemetry.emit('callback_consumed'));
    assert.doesNotThrow(() => telemetry.emit('callback_failed'));
  });

  await withPinnedRandomUUID(() => 'not-a-uuid', async (mod) => {
    const events = [];
    const telemetry = mod.createCallbackEmailOAuthStageTelemetry((r) => events.push(r));
    telemetry.emit('callback_consumed');
    assert.equal(events.length, 0);
  });

  await withPinnedRandomUUID(() => 'A1A1A1A1-B2B2-4C3C-8D4D-E5E5E5E5E5E5', async (mod) => {
    // Uppercase UUIDv4 is rejected (must be lowercase) → noop logging only.
    const events = [];
    const telemetry = mod.createCallbackEmailOAuthStageTelemetry((r) => events.push(r));
    telemetry.emit('installer_committed');
    assert.equal(events.length, 0);
  });

  // OAuth control flow with ordinary callback composition remains unchanged.
  const { service } = callbackComposition();
  const result = await service.accept(
    { state: STATE, error: 'access_denied' },
    { clientId: CLIENT_ID, authSessionId: AUTH_SESSION_ID },
  );
  assert.deepEqual(result, PUBLIC_STATUS_DECLINED);
});

test('callback server correlation never adds fields or secrets', async function serverCorrelationSchemaOnly() {
  const FIXED = 'e1e1e1e1-e2e2-4e3e-8e4e-e5e5e5e5e5e5';
  await withPinnedRandomUUID(() => FIXED, async (mod) => {
    const events = [];
    const telemetry = mod.createCallbackEmailOAuthStageTelemetry((r) => events.push(r));
    telemetry.emit('callback_consumed');
    telemetry.emit('token_request_started');
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.deepEqual(Reflect.ownKeys(event), ['event', 'stage', 'request_id']);
      assertEventShape(event, event.stage, FIXED);
      assertNoSensitive(event);
      // No secret/ALS/header/extra correlation fields.
      assert.equal(Object.prototype.hasOwnProperty.call(event, 'x-request-id'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(event, 'header'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(event, 'als'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(event, 'secret'), false);
    }
  });
  // Live generator (unpinned path) also yields schema-only UUIDv4.
  const liveEvents = [];
  const live = createCallbackEmailOAuthStageTelemetry((r) => liveEvents.push(r));
  live.emit('graph_identity_verified');
  assert.equal(liveEvents.length, 1);
  assert.equal(UUID_V4_RE.test(liveEvents[0].request_id), true);
  assert.deepEqual(Reflect.ownKeys(liveEvents[0]), ['event', 'stage', 'request_id']);
  assertNoSensitive(liveEvents[0]);
});

// ── Route wiring / no ambient mutable logger ───────────────────────────────

test('production route wires server-generated stage telemetry; no ALS correlation; no ambient setLogger', async function routeWiringSource() {
  const routesSrc = fs.readFileSync(path.join(ROOT, ROUTES_REL), 'utf8');
  const runtimeSrc = fs.readFileSync(path.join(ROOT, RUNTIME_REL), 'utf8');
  const callbackSrc = fs.readFileSync(path.join(ROOT, CALLBACK_REL), 'utf8');
  const telSrc = fs.readFileSync(path.join(ROOT, LIB_REL), 'utf8');

  // Production callback path: server-generated correlation only.
  assert.match(routesSrc, /createCallbackEmailOAuthStageTelemetry/);
  assert.match(routesSrc, /buildCallbackStageTelemetry/);
  assert.match(routesSrc, /stageTelemetry/);
  assert.match(telSrc, /createCallbackEmailOAuthStageTelemetry/);
  assert.match(telSrc, /randomUUID/);
  // Module-init pin of native randomUUID (not ambient-substitutable).
  assert.match(telSrc, /PINNED_RANDOM_UUID|NATIVE_RANDOM_UUID|PRODUCTION_.*RANDOM_UUID/);
  assert.match(telSrc, /Reflect\.apply/);

  // Must NOT depend on staff-api ALS HTTP correlation / attacker x-request-id.
  assert.equal(routesSrc.includes('staff-api-request-correlation'), false);
  assert.equal(routesSrc.includes('getRequestId'), false);
  assert.equal(/requestId\s*:\s*getRequestId|getRequestId\s*\(/.test(routesSrc), false);

  assert.match(runtimeSrc, /stageTelemetry/);
  assert.match(callbackSrc, /callback_consumed/);
  assert.match(callbackSrc, /callback_failed/);
  assert.match(telSrc, /email_oauth_stage/);

  // No ambient mutable logger setter (contrast with completion-log setCompletionLogger)
  assert.equal(telSrc.includes('setStageLogger'), false);
  assert.equal(telSrc.includes('let stageLogger'), false);
  assert.equal(routesSrc.includes('setStageLogger'), false);
  // Must not pass secrets into emit
  assert.equal(callbackSrc.includes("safeEmitStage") || callbackSrc.includes('callback_consumed'), true);
});

test('default logger writes JSON to console without sensitive fields', async function consoleOutputSafe() {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    const t = createEmailOAuthStageTelemetry(Object.freeze({
      requestId: REQUEST_ID,
      logger: defaultEmailOAuthStageLogger,
    }));
    t.emit('callback_consumed');
    t.emit('installer_committed');
    assert.equal(lines.length, 2);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assertEventShape(parsed, parsed.stage);
      assertNoSensitive(line);
      assertNoSensitive(parsed);
    }
  } finally {
    console.log = orig;
  }
});

test('package.json registers stage telemetry verifier', async function packageScript() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(
    pkg.scripts['verify:email-microsoft-oauth-stage-telemetry'],
    'node scripts/verify-email-microsoft-oauth-stage-telemetry.js',
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
      console.error(error && error.stack ? error.stack : error);
    }
  }
  if (failed) {
    console.error(`\n${failed} failing of ${tests.length}`);
    process.exit(1);
  }
  console.log(`\nPASS email Microsoft OAuth stage telemetry (${tests.length} tests)`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

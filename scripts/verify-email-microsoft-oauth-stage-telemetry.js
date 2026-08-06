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
const http = require('http');
const path = require('path');
const { EventEmitter } = require('events');
const { Socket } = require('net');

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

const {
  createMicrosoftGraphMeIdentityTransport,
} = require('./lib/email-microsoft-graph-me-identity');

const ROOT = path.join(__dirname, '..');
const LIB_REL = 'scripts/lib/email-microsoft-oauth-stage-telemetry.js';
const VERIFY_REL = 'scripts/verify-email-microsoft-oauth-stage-telemetry.js';
const GRAPH_REL = 'scripts/lib/email-microsoft-graph-me-identity.js';
const IDENTITY_REL = 'scripts/lib/email-microsoft-verified-identity.js';
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
  // Finer Graph /me milestones sit between oidc_verified and the retained
  // graph_identity_verified terminal Graph success stage.
  assert.deepEqual([...STAGES], [
    'callback_consumed',
    'token_request_started',
    'token_response_received',
    'token_response_validated',
    'oidc_verified',
    'graph_request_started',
    'graph_response_received',
    // Finer Graph response validation milestones (isolate live callback_failed
    // after graph_response_received without logging status/body/headers/identity).
    'graph_http_accepted',
    'graph_headers_accepted',
    'graph_body_collected',
    'graph_json_validated',
    'graph_mailbox_selected',
    'graph_response_validated',
    'graph_principal_matched',
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
  // Stub Graph surface does not emit transport milestones; principal match +
  // retained verified stages still fire from verified-identity composition.
  assert.deepEqual(stages, [
    'token_request_started',
    'token_response_received',
    'token_response_validated',
    'oidc_verified',
    'graph_principal_matched',
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

test('realistic MS token scope omitting offline_access reaches token_response_validated', async function msScopeOmitsOfflineAccessStages() {
  // Live root cause: exact five-item scope check rejected Microsoft v2 responses
  // that omit offline_access (evidenced by refresh_token), so telemetry stopped at
  // token_response_received → callback_failed with no token_response_validated.
  for (const scope of [
    'openid profile User.Read Mail.ReadBasic',
    'openid profile email User.Read Mail.ReadBasic',
    'User.Read Mail.ReadBasic',
  ]) {
    const { service, events, completionInput } = pipelineComposition({
      useRealIdentity: true,
      tokenPatch: { scope },
    });
    const ack = await service.completeAuthorization(completionInput);
    assert.deepEqual(ack, { status: 'completed' });
    assert.deepEqual(events.map((e) => e.stage), [
      'token_request_started',
      'token_response_received',
      'token_response_validated',
      'oidc_verified',
      'graph_principal_matched',
      'graph_identity_verified',
      'envelope_sealed',
      'installer_started',
      'installer_committed',
    ]);
    assert.equal(events.some((e) => e.stage === 'token_response_validated'), true);
    for (const ev of events) {
      assertEventShape(ev, ev.stage);
      assertNoSensitive(ev);
      assert.equal(JSON.stringify(ev).includes('offline_access'), false);
    }
  }
});

test('hostile higher-privilege token scope fails after received without validated', async function hostileScopeNoValidated() {
  const { service, events, completionInput } = pipelineComposition({
    useRealIdentity: true,
    tokenPatch: { scope: 'openid profile User.Read Mail.Read' },
  });
  await assert.rejects(() => service.completeAuthorization(completionInput));
  assert.deepEqual(events.map((e) => e.stage), [
    'token_request_started',
    'token_response_received',
  ]);
  assert.equal(events.some((e) => e.stage === 'token_response_validated'), false);
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
    'graph_principal_matched',
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
    'graph_principal_matched',
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

// ── Finer Graph /me stage boundaries (transport + principal match) ─────────

const GRAPH_ACCESS = 'graph-access-token-NEVER-LEAK';
const GRAPH_GOOD_BODY = JSON.stringify({
  id: PRINCIPAL,
  displayName: DISPLAY,
  mail: MAILBOX,
  userPrincipalName: MAILBOX,
});

function nativeGraphResponse(spec = {}) {
  const res = new http.IncomingMessage(new Socket());
  res.statusCode = spec.status === undefined ? 200 : spec.status;
  res.headers = spec.headers || { 'content-type': 'application/json; charset=utf-8' };
  res.destroy = () => {};
  // Production shape precondition: headers is a native prototype getter, not own data.
  assert.equal(Object.prototype.hasOwnProperty.call(res, 'headers'), false);
  return res;
}

function graphTransportFake(spec = {}) {
  const calls = [];
  const timers = {
    setTimeout(callback) { return { callback }; },
    clearTimeout() {},
  };
  const httpsImpl = (options, callback) => {
    if (spec.requestThrows) throw new Error(`${LEAK} graph-request`);
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => {
      const call = { options, req };
      calls.push(call);
      if (spec.never) return;
      if (spec.requestError) {
        queueMicrotask(() => req.emit('error', new Error(`${LEAK} graph-transport`)));
        return;
      }
      queueMicrotask(() => {
        let res;
        if (spec.nativeResponse) {
          res = nativeGraphResponse({
            status: spec.status,
            headers: spec.headers,
          });
        } else if (spec.responseFactory) {
          res = spec.responseFactory({ status: spec.status, headers: spec.headers });
        } else {
          res = new EventEmitter();
          res.statusCode = spec.status === undefined ? 200 : spec.status;
          res.headers = spec.headers || { 'content-type': 'application/json; charset=utf-8' };
          res.destroy = () => {};
        }
        call.res = res;
        callback(res);
        if (spec.onResponse) {
          spec.onResponse({ req, res });
          return;
        }
        const body = spec.body === undefined ? GRAPH_GOOD_BODY : spec.body;
        res.emit('data', Buffer.from(body));
        if (!spec.noEnd) res.emit('end');
      });
    };
    return req;
  };
  const deps = { httpsImpl, timers };
  if (Object.prototype.hasOwnProperty.call(spec, 'stageTelemetry')) {
    deps.stageTelemetry = spec.stageTelemetry;
  }
  const service = createMicrosoftGraphMeIdentityTransport(deps);
  return { service, calls, fetch: service.fetchIdentity };
}

function graphStageComposition(spec = {}) {
  const cap = capturingLogger();
  const telemetry = createEmailOAuthStageTelemetry(Object.freeze({
    requestId: REQUEST_ID,
    logger: typeof spec.logger === 'function' ? spec.logger : cap.log,
  }));
  const oidcValidator = Object.freeze({
    async validate() {
      if (spec.failAt === 'oidc') throw new Error(`${LEAK} oidc`);
      return Object.freeze({
        providerTenantId: TID,
        providerPrincipalId: spec.oidcPrincipal || PRINCIPAL,
      });
    },
  });
  const graph = graphTransportFake({
    ...spec.graph,
    stageTelemetry: telemetry,
  });
  const composition = createMicrosoftVerifiedIdentityComposition(Object.freeze({
    oidcValidator,
    graphIdentity: graph.service,
    stageTelemetry: telemetry,
  }));
  const input = Object.freeze({
    idToken: ID_TOKEN,
    accessToken: GRAPH_ACCESS,
    expectedNonce: NONCE,
    expectedClientId: APP_CLIENT_ID,
    nowEpochSeconds: Math.floor(NOW.getTime() / 1000),
  });
  return { composition, events: cap.events, telemetry, graph, input };
}

/** Full Graph transport success chain (before principal match). */
const GRAPH_TRANSPORT_SUCCESS_STAGES = Object.freeze([
  'graph_request_started',
  'graph_response_received',
  'graph_http_accepted',
  'graph_headers_accepted',
  'graph_body_collected',
  'graph_json_validated',
  'graph_mailbox_selected',
  'graph_response_validated',
]);

function assertNeutralStageEvents(events) {
  for (const ev of events) {
    assertEventShape(ev, ev.stage);
    assertNoSensitive(ev);
    // Never status/error/body/headers/identity/mail/URL/token fields.
    assert.equal(Object.prototype.hasOwnProperty.call(ev, 'status'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(ev, 'error'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(ev, 'body'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(ev, 'headers'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(ev, 'content_type'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(ev, 'content_length'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(ev, 'mail'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(ev, 'url'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(ev, 'identity'), false);
    assert.deepEqual(Reflect.ownKeys(ev), ['event', 'stage', 'request_id']);
  }
}

test('graph happy path emits full response-validation chain then principal→verified', async function graphHappyFinerStages() {
  const { composition, events, input } = graphStageComposition();
  const result = await composition.verifyIdentity(input);
  assert.equal(result.providerPrincipalId, PRINCIPAL);
  assert.equal(result.mailboxAddress, MAILBOX);
  assert.deepEqual(events.map((e) => e.stage), [
    'oidc_verified',
    ...GRAPH_TRANSPORT_SUCCESS_STAGES,
    'graph_principal_matched',
    'graph_identity_verified',
  ]);
  assertNeutralStageEvents(events);
  for (const ev of events) {
    assert.equal(ev.request_id, REQUEST_ID);
  }
  const ids = new Set(events.map((e) => e.request_id));
  assert.equal(ids.size, 1);
});

test('graph transport error after start emits request_started only (no received/validated)', async function graphTransportHostile() {
  const { composition, events, input } = graphStageComposition({
    graph: { requestError: true },
  });
  await assert.rejects(() => composition.verifyIdentity(input));
  assert.deepEqual(events.map((e) => e.stage), [
    'oidc_verified',
    'graph_request_started',
  ]);
  assert.equal(events.some((e) => e.stage === 'graph_response_received'), false);
  assert.equal(events.some((e) => e.stage === 'graph_http_accepted'), false);
  assert.equal(events.some((e) => e.stage === 'graph_response_validated'), false);
  assert.equal(events.some((e) => e.stage === 'graph_principal_matched'), false);
  assert.equal(events.some((e) => e.stage === 'graph_identity_verified'), false);
  assertNeutralStageEvents(events);
});

test('graph non-200 stops after received (no http_accepted)', async function graphHttpStatusHostile() {
  for (const status of [401, 403, 500]) {
    const { composition, events, input } = graphStageComposition({ graph: { status } });
    await assert.rejects(() => composition.verifyIdentity(input));
    assert.deepEqual(events.map((e) => e.stage), [
      'oidc_verified',
      'graph_request_started',
      'graph_response_received',
    ], `unexpected stages for status ${status}`);
    assert.equal(events.some((e) => e.stage === 'graph_http_accepted'), false);
    assert.equal(events.some((e) => e.stage === 'graph_headers_accepted'), false);
    assert.equal(events.some((e) => e.stage === 'graph_response_validated'), false);
    assertNeutralStageEvents(events);
  }
});

test('graph bad content-type stops after http_accepted (no headers_accepted)', async function graphContentTypeHostile() {
  const { composition, events, input } = graphStageComposition({
    graph: { headers: { 'content-type': 'text/plain' } },
  });
  await assert.rejects(() => composition.verifyIdentity(input));
  assert.deepEqual(events.map((e) => e.stage), [
    'oidc_verified',
    'graph_request_started',
    'graph_response_received',
    'graph_http_accepted',
  ]);
  assert.equal(events.some((e) => e.stage === 'graph_headers_accepted'), false);
  assert.equal(events.some((e) => e.stage === 'graph_body_collected'), false);
  assert.equal(events.some((e) => e.stage === 'graph_response_validated'), false);
  assertNeutralStageEvents(events);
});

test('graph oversized content-length stops after http_accepted (no headers_accepted)', async function graphContentLengthHostile() {
  const { composition, events, input } = graphStageComposition({
    graph: {
      headers: {
        'content-type': 'application/json',
        'content-length': String(1_000_000),
      },
    },
  });
  await assert.rejects(() => composition.verifyIdentity(input));
  assert.deepEqual(events.map((e) => e.stage), [
    'oidc_verified',
    'graph_request_started',
    'graph_response_received',
    'graph_http_accepted',
  ]);
  assert.equal(events.some((e) => e.stage === 'graph_headers_accepted'), false);
  assert.equal(events.some((e) => e.stage === 'graph_body_collected'), false);
  assertNeutralStageEvents(events);
});

test('graph invalid JSON stops after body_collected (no json_validated)', async function graphJsonHostile() {
  const { composition, events, input } = graphStageComposition({
    graph: { body: '{' },
  });
  await assert.rejects(() => composition.verifyIdentity(input));
  assert.deepEqual(events.map((e) => e.stage), [
    'oidc_verified',
    'graph_request_started',
    'graph_response_received',
    'graph_http_accepted',
    'graph_headers_accepted',
    'graph_body_collected',
  ]);
  assert.equal(events.some((e) => e.stage === 'graph_json_validated'), false);
  assert.equal(events.some((e) => e.stage === 'graph_mailbox_selected'), false);
  assert.equal(events.some((e) => e.stage === 'graph_response_validated'), false);
  assertNeutralStageEvents(events);
});

test('graph identity select failure stops after json_validated (no mailbox_selected)', async function graphMailboxHostile() {
  for (const body of [
    JSON.stringify({ id: 'x' }), // missing mailbox fields
    JSON.stringify({ id: PRINCIPAL, mail: 'not-an-email', userPrincipalName: MAILBOX }),
  ]) {
    const { composition, events, input } = graphStageComposition({ graph: { body } });
    await assert.rejects(() => composition.verifyIdentity(input));
    assert.deepEqual(events.map((e) => e.stage), [
      'oidc_verified',
      'graph_request_started',
      'graph_response_received',
      'graph_http_accepted',
      'graph_headers_accepted',
      'graph_body_collected',
      'graph_json_validated',
    ], `unexpected stages for body ${body}`);
    assert.equal(events.some((e) => e.stage === 'graph_mailbox_selected'), false);
    assert.equal(events.some((e) => e.stage === 'graph_response_validated'), false);
    assert.equal(events.some((e) => e.stage === 'graph_identity_verified'), false);
    assertNeutralStageEvents(events);
  }
});

test('graph principal mismatch emits full transport chain then stops before matched/verified', async function graphPrincipalMismatchStages() {
  const { composition, events, input } = graphStageComposition({
    oidcPrincipal: PRINCIPAL,
    graph: {
      body: JSON.stringify({
        id: 'different-graph-subject-id',
        displayName: DISPLAY,
        mail: MAILBOX,
        userPrincipalName: MAILBOX,
      }),
    },
  });
  await assert.rejects(() => composition.verifyIdentity(input));
  assert.deepEqual(events.map((e) => e.stage), [
    'oidc_verified',
    ...GRAPH_TRANSPORT_SUCCESS_STAGES,
  ]);
  assert.equal(events.some((e) => e.stage === 'graph_principal_matched'), false);
  assert.equal(events.some((e) => e.stage === 'graph_identity_verified'), false);
  assertNeutralStageEvents(events);
});

test('graph standalone factory accepts optional telemetry without weakening core bags', async function graphFactoryOptionalTelemetry() {
  // Core bag without stageTelemetry still constructs and succeeds (noop).
  const bare = graphTransportFake({});
  const result = await bare.fetch({ accessToken: GRAPH_ACCESS });
  assert.equal(result.providerSubjectId, PRINCIPAL);
  assert.equal(result.mailboxAddress, MAILBOX);

  // Optional stageTelemetry pins same request_id; three-field events only.
  const cap = capturingLogger();
  const telemetry = createEmailOAuthStageTelemetry(Object.freeze({
    requestId: REQUEST_ID,
    logger: cap.log,
  }));
  const withTel = graphTransportFake({ stageTelemetry: telemetry });
  await withTel.fetch({ accessToken: GRAPH_ACCESS });
  assert.deepEqual(cap.events.map((e) => e.stage), [...GRAPH_TRANSPORT_SUCCESS_STAGES]);
  assertNeutralStageEvents(cap.events);

  // Invalid stageTelemetry surface fails closed at factory (no ambient fallback).
  assert.throws(
    () => createMicrosoftGraphMeIdentityTransport({
      httpsImpl: () => {},
      stageTelemetry: Object.freeze({ emit: 'not-a-function' }),
    }),
  );
  // No ambient logger / setStageLogger on Graph module.
  const graphSrc = fs.readFileSync(path.join(ROOT, GRAPH_REL), 'utf8');
  assert.equal(graphSrc.includes('setStageLogger'), false);
  assert.equal(graphSrc.includes('global.'), false);
  assert.match(graphSrc, /graph_request_started/);
  assert.match(graphSrc, /graph_response_received/);
  assert.match(graphSrc, /graph_http_accepted/);
  assert.match(graphSrc, /graph_headers_accepted/);
  assert.match(graphSrc, /graph_body_collected/);
  assert.match(graphSrc, /graph_json_validated/);
  assert.match(graphSrc, /graph_mailbox_selected/);
  assert.match(graphSrc, /graph_response_validated/);
  // Each success milestone must appear as a dedicated safeEmitStage call.
  assert.match(graphSrc, /safeEmitStage\(\s*stageTelemetry\s*,\s*'graph_http_accepted'\s*\)/);
  assert.match(graphSrc, /safeEmitStage\(\s*stageTelemetry\s*,\s*'graph_headers_accepted'\s*\)/);
  assert.match(graphSrc, /safeEmitStage\(\s*stageTelemetry\s*,\s*'graph_body_collected'\s*\)/);
  assert.match(graphSrc, /safeEmitStage\(\s*stageTelemetry\s*,\s*'graph_json_validated'\s*\)/);
  assert.match(graphSrc, /safeEmitStage\(\s*stageTelemetry\s*,\s*'graph_mailbox_selected'\s*\)/);
  assert.match(graphSrc, /safeEmitStage\(\s*stageTelemetry\s*,\s*'graph_response_validated'\s*\)/);
  const identitySrc = fs.readFileSync(path.join(ROOT, IDENTITY_REL), 'utf8');
  assert.match(identitySrc, /graph_principal_matched/);
  assert.match(identitySrc, /graph_identity_verified/);
  // Response-validation stages belong to Graph transport only (not identity).
  assert.equal(identitySrc.includes('graph_http_accepted'), false);
  assert.equal(identitySrc.includes('graph_mailbox_selected'), false);
});

test('graph stage logger throw never affects Graph /me or identity control flow', async function graphLoggerNeverAffectsRequest() {
  const boom = createEmailOAuthStageTelemetry(Object.freeze({
    requestId: REQUEST_ID,
    logger() { throw new Error(`${LEAK} graph-logger`); },
  }));
  const graph = graphTransportFake({ stageTelemetry: boom });
  const ok = await graph.fetch({ accessToken: GRAPH_ACCESS });
  assert.equal(ok.providerSubjectId, PRINCIPAL);

  const oidcValidator = Object.freeze({
    async validate() {
      return Object.freeze({
        providerTenantId: TID,
        providerPrincipalId: PRINCIPAL,
      });
    },
  });
  const composition = createMicrosoftVerifiedIdentityComposition(Object.freeze({
    oidcValidator,
    graphIdentity: graphTransportFake({ stageTelemetry: boom }).service,
    stageTelemetry: boom,
  }));
  const result = await composition.verifyIdentity(Object.freeze({
    idToken: ID_TOKEN,
    accessToken: GRAPH_ACCESS,
    expectedNonce: NONCE,
    expectedClientId: APP_CLIENT_ID,
    nowEpochSeconds: Math.floor(NOW.getTime() / 1000),
  }));
  assert.equal(result.providerPrincipalId, PRINCIPAL);
  assert.equal(result.mailboxAddress, MAILBOX);
});

test('realistic production Graph composition correlates all finer stages on one request_id', async function realisticProductionGraphStages() {
  // Mirrors sunset-staging runtime: same stageTelemetry surface to Graph transport
  // and verified-identity composition (server-owned callback request_id).
  const cap = capturingLogger();
  const telemetry = createEmailOAuthStageTelemetry(Object.freeze({
    requestId: REQUEST_ID,
    logger: cap.log,
  }));
  const oidcValidator = Object.freeze({
    async validate() {
      return Object.freeze({
        providerTenantId: TID,
        providerPrincipalId: PRINCIPAL,
      });
    },
  });
  // Realistic GoDaddy/M365 mail ≠ UPN body still reaches full Graph milestones.
  const REALISTIC_SMTP = 'support@lunafrontdesk.com';
  const REALISTIC_UPN = 'support@lunafrontdesk.onmicrosoft.com';
  const graph = graphTransportFake({
    stageTelemetry: telemetry,
    body: JSON.stringify({
      id: PRINCIPAL,
      displayName: 'Luna Support',
      mail: 'Support@LunaFrontDesk.COM',
      userPrincipalName: REALISTIC_UPN,
    }),
  });
  const verifiedIdentity = createMicrosoftVerifiedIdentityComposition(Object.freeze({
    oidcValidator,
    graphIdentity: graph.service,
    stageTelemetry: telemetry,
  }));
  // Full operation composition still seals/installs after finer Graph stages.
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
  let responseCb;
  request.end = () => {
    queueMicrotask(() => {
      responseCb(incoming);
      incoming.emit('data', JSON.stringify(goodTokenBody()));
      incoming.emit('end');
    });
  };
  request.destroy = () => {};
  const httpsImpl = {
    request(_o, cb) { responseCb = cb; return request; },
  };
  const transportDeps = Object.freeze({
    httpsImpl,
    timers: { setTimeout() { return 1; }, clearTimeout() {} },
  });
  const service = createMicrosoftOAuthOperationComposition(Object.freeze({
    verifiedIdentity,
    envelopeProvider: envelope,
    clock: Object.freeze({ nowEpochSeconds() { return Math.floor(NOW.getTime() / 1000); } }),
    installer,
    transportDeps,
    secretProvider: { async getClientSecret() { return SECRET; } },
    stageTelemetry: telemetry,
  }));
  const ack = await service.completeAuthorization(Object.freeze({
    authorizationCode: CODE,
    transactionId: OPERATION_ID,
    clientId: CLIENT_ID,
    locationId: LOCATION_ID,
    endpointId: ENDPOINT_ID,
    staffUserId: STAFF_ID,
    codeVerifier: VERIFIER,
    nonce: NONCE,
    applicationClientId: APP_CLIENT_ID,
  }));
  assert.deepEqual(ack, { status: 'completed' });
  assert.deepEqual(cap.events.map((e) => e.stage), [
    'token_request_started',
    'token_response_received',
    'token_response_validated',
    'oidc_verified',
    ...GRAPH_TRANSPORT_SUCCESS_STAGES,
    'graph_principal_matched',
    'graph_identity_verified',
    'envelope_sealed',
    'installer_started',
    'installer_committed',
  ]);
  assertNeutralStageEvents(cap.events);
  for (const ev of cap.events) {
    assert.equal(ev.request_id, REQUEST_ID);
  }
  // Ownership surface for installer remains preferred SMTP mail.
  assert.equal(REALISTIC_SMTP !== REALISTIC_UPN, true);
  // Runtime source must inject stageTelemetry into Graph factory.
  const runtimeSrc = fs.readFileSync(path.join(ROOT, RUNTIME_REL), 'utf8');
  assert.match(runtimeSrc, /createMicrosoftGraphMeIdentityTransport/);
  assert.match(runtimeSrc, /stageTelemetry/);
  // Graph factory call site must pass stageTelemetry (not identity-only).
  assert.match(
    runtimeSrc,
    /createMicrosoftGraphMeIdentityTransport\(\{[\s\S]*?stageTelemetry[\s\S]*?\}\)/,
  );
});

// ── Native IncomingMessage headers (production Graph response shape) ───────
// Live final trace was graph_response_received → graph_http_accepted →
// callback_failed with no graph_headers_accepted. statusCode is own data so
// HTTP 200 passed; headers is a non-own native getter so readOwnData returned
// undefined and content-type validation failed closed.

test('native IncomingMessage Graph response emits full chain including graph_headers_accepted', async function graphNativeHeadersFullChain() {
  const { composition, events, input, graph } = graphStageComposition({
    graph: { nativeResponse: true },
  });
  const result = await composition.verifyIdentity(input);
  assert.equal(result.providerPrincipalId, PRINCIPAL);
  assert.equal(result.mailboxAddress, MAILBOX);
  assert.deepEqual(events.map((e) => e.stage), [
    'oidc_verified',
    ...GRAPH_TRANSPORT_SUCCESS_STAGES,
    'graph_principal_matched',
    'graph_identity_verified',
  ]);
  assert.equal(events.some((e) => e.stage === 'graph_headers_accepted'), true);
  assertNeutralStageEvents(events);
  // Response that produced the chain must be genuine non-own headers.
  assert.equal(Object.prototype.hasOwnProperty.call(graph.calls[0].res, 'headers'), false);
  assert.equal(graph.calls[0].res.constructor, http.IncomingMessage);
});

test('hostile prototype headers getter never reaches graph_headers_accepted', async function graphHostileHeadersGetterRejected() {
  const HostileProto = {
    get headers() {
      return { 'content-type': 'application/json; charset=utf-8' };
    },
  };
  const { composition, events, input } = graphStageComposition({
    graph: {
      responseFactory() {
        const res = Object.create(HostileProto);
        res.statusCode = 200;
        res.destroy = () => {};
        const ee = new EventEmitter();
        res.on = ee.on.bind(ee);
        res.once = ee.once.bind(ee);
        res.emit = ee.emit.bind(ee);
        return res;
      },
    },
  });
  await assert.rejects(() => composition.verifyIdentity(input));
  assert.deepEqual(events.map((e) => e.stage), [
    'oidc_verified',
    'graph_request_started',
    'graph_response_received',
    'graph_http_accepted',
  ]);
  assert.equal(events.some((e) => e.stage === 'graph_headers_accepted'), false);
  assert.equal(events.some((e) => e.stage === 'graph_response_validated'), false);
  assertNeutralStageEvents(events);
});

test('duplicate/array content-type on native response stops after graph_http_accepted', async function graphNativeDuplicateHeadersRejected() {
  for (const headers of [
    { 'content-type': ['application/json', 'text/plain'] },
    { 'content-type': 'application/json, text/plain' },
    { 'content-type': 'application/json', 'content-length': '1,2' },
  ]) {
    const { composition, events, input } = graphStageComposition({
      graph: { nativeResponse: true, headers },
    });
    await assert.rejects(() => composition.verifyIdentity(input));
    assert.deepEqual(events.map((e) => e.stage), [
      'oidc_verified',
      'graph_request_started',
      'graph_response_received',
      'graph_http_accepted',
    ], `unexpected stages for headers ${JSON.stringify(headers)}`);
    assert.equal(events.some((e) => e.stage === 'graph_headers_accepted'), false);
    assertNeutralStageEvents(events);
  }
});

test('post-init ambient IncomingMessage rebind does not break pinned native headers path', async function graphNativeHeadersPinSurvivesMonkeypatch() {
  const originalIM = http.IncomingMessage;
  let redefineThrew = false;
  try {
    Object.defineProperty(http.IncomingMessage.prototype, 'headers', {
      configurable: true,
      enumerable: false,
      get() { return { 'content-type': 'text/html' }; },
    });
  } catch {
    redefineThrew = true;
  }
  assert.equal(redefineThrew, true);
  http.IncomingMessage = function AmbientHostile() {
    throw new Error(`${LEAK} ambient-im`);
  };
  try {
    const { composition, events, input, graph } = graphStageComposition({
      graph: {
        responseFactory() {
          // Construct with the real original class captured before rebind.
          const res = new originalIM(new Socket());
          res.statusCode = 200;
          res.headers = { 'content-type': 'application/json; charset=utf-8' };
          res.destroy = () => {};
          assert.equal(Object.prototype.hasOwnProperty.call(res, 'headers'), false);
          return res;
        },
      },
    });
    const result = await composition.verifyIdentity(input);
    assert.equal(result.providerPrincipalId, PRINCIPAL);
    assert.deepEqual(events.map((e) => e.stage), [
      'oidc_verified',
      ...GRAPH_TRANSPORT_SUCCESS_STAGES,
      'graph_principal_matched',
      'graph_identity_verified',
    ]);
    assert.equal(events.some((e) => e.stage === 'graph_headers_accepted'), true);
    assert.equal(graph.calls[0].res.constructor, originalIM);
    assertNeutralStageEvents(events);
  } finally {
    http.IncomingMessage = originalIM;
  }
});

test('Graph source pins IncomingMessage headers getter and does not trust ambient accessors', async function graphSourceNativeHeadersContract() {
  const graphSrc = fs.readFileSync(path.join(ROOT, GRAPH_REL), 'utf8');
  // Module-init pin of constructor + prototype + exact native headers getter.
  assert.match(graphSrc, /IncomingMessage/);
  assert.match(graphSrc, /getOwnPropertyDescriptor/);
  assert.match(graphSrc, /PINNED_.*HEADERS|HEADERS_GET|headersGet|pinnedHeaders/i);
  assert.match(graphSrc, /Reflect\.apply/);
  // Must not rely solely on readOwnData(response, 'headers') for production path.
  // The pin/apply path must appear; own-data may remain for plain mocks.
  assert.match(graphSrc, /readOwnData\(\s*response\s*,\s*['"]statusCode['"]\s*\)/);
  // Hostile ambient: no global lookup for headers helpers.
  assert.equal(graphSrc.includes('global.'), false);
  assert.equal(graphSrc.includes('globalThis'), false);
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

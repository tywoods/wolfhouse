'use strict';

const assert = require('assert/strict');
const Module = require('module');
const { EventEmitter } = require('events');
const { createFakeEmailGrantEnvelopeProvider } = require('./lib/email-grant-envelope-fake-provider');
const { createEmailOAuthStageTelemetry } = require('./lib/email-microsoft-oauth-stage-telemetry');

const ACCESS = 'access-token-NEVER-LOG';
const REFRESH = 'refresh-token-NEVER-LOG';
const ID_TOKEN = 'id-token-NEVER-LOG';
const SCOPE = 'openid profile offline_access User.Read Mail.ReadWrite Mail.Send';
const LEAKS = [ACCESS, REFRESH, ID_TOKEN, SCOPE, 'Bearer', 'Mail.Send', 'invalid_grant', 'PLANTED'];
const IDS = Object.freeze({
  transactionId: '99999999-8888-4777-8666-555555555555',
  clientId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  locationId: '22222222-3333-4444-8555-666666666666',
  endpointId: '11111111-2222-4333-8444-555555555555',
  staffUserId: 'abcdef01-2345-4678-89ab-cdef01234567',
  applicationClientId: '12345678-1234-4234-8234-123456789abc',
});
const input = Object.freeze({
  authorizationCode: 'provider-code', transactionId: IDS.transactionId, clientId: IDS.clientId,
  locationId: IDS.locationId, endpointId: IDS.endpointId, staffUserId: IDS.staffUserId,
  codeVerifier: `${'v'.repeat(42)}~`, nonce: 'n'.repeat(43), applicationClientId: IDS.applicationClientId,
  expectedPriorGrantGeneration: '11',
});

let nextResponse;
let custodyCalls = 0;
const realLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === './email-microsoft-token-http-transport'
      && parent && /email-microsoft-phase-b-oauth-operation-composition\.js$/.test(parent.filename)) {
    return Object.freeze({
      REQUEST_LIMIT_BYTES: 65_536,
      createMicrosoftTokenHttpTransport() {
        return Object.freeze({ async postTokenForm() { return nextResponse; } });
      },
    });
  }
  if (request === './email-microsoft-phase-b-verified-grant-replacer'
      && parent && /email-microsoft-phase-b-oauth-operation-composition\.js$/.test(parent.filename)) {
    return Object.freeze({
      CONFIG_KEYS: Object.freeze(['clientId', 'endpointId', 'operationId', 'actorStaffUserId',
        'expectedNonce', 'expectedClientId', 'expectedPriorGrantGeneration']),
      OUTCOME_UNKNOWN: 'outcome_unknown',
      SEALED_ACK: Object.freeze({ status: 'accepted' }),
      createMicrosoftPhaseBVerifiedGrantCustodyAdapter() {
        return Object.freeze({
          async acceptValidatedTokens() { custodyCalls += 1; return Object.freeze({ status: 'accepted' }); },
        });
      },
    });
  }
  return realLoad(request, parent, isMain);
};
const { createMicrosoftPhaseBOauthOperationComposition } = require('./lib/email-microsoft-phase-b-oauth-operation-composition');
Module._load = realLoad;

function tokenBody(patch = {}) {
  return JSON.stringify({ token_type: 'Bearer', expires_in: 3600, scope: SCOPE,
    access_token: ACCESS, refresh_token: REFRESH, id_token: ID_TOKEN, ...patch });
}
function response(overrides = {}) {
  return { statusCode: 200, contentType: 'application/json; charset=utf-8', body: tokenBody(), ...overrides };
}
function makeOperation(events, logger = (event) => { events.push(event); }) {
  const stageTelemetry = createEmailOAuthStageTelemetry(Object.freeze({
    requestId: 'a1a1a1a1-b2b2-4c3c-8d4d-e5e5e5e5e5e5',
    logger,
  }));
  return createMicrosoftPhaseBOauthOperationComposition(Object.freeze({
    verifiedIdentity: Object.freeze({ async verifyIdentity() { throw new Error('provider downstream must not run'); } }),
    envelopeProvider: createFakeEmailGrantEnvelopeProvider(),
    clock: Object.freeze({ nowEpochSeconds() { return 1_700_000_000; } }),
    replacer: Object.freeze({ async replaceVerifiedGrant() { throw new Error('provider downstream must not run'); } }),
    transportDeps: Object.freeze({
      httpsImpl: Object.freeze({ request() { throw new Error('intercepted transport only'); } }),
      timers: Object.freeze({ setTimeout() {}, clearTimeout() {} }),
    }),
    secretProvider: Object.freeze({ async getClientSecret() { return 'fixed-secret'; } }),
    stageTelemetry,
  }));
}
function assertSafe(events) {
  const serialized = JSON.stringify(events);
  for (const leak of LEAKS) assert.equal(serialized.includes(leak), false, `leaked ${leak}`);
  for (const event of events) assert.deepEqual(Reflect.ownKeys(event), ['event', 'stage', 'request_id']);
}
async function rejectsAt(name, rawResponse, expected, extraCheck, logger) {
  custodyCalls = 0;
  nextResponse = rawResponse;
  const events = [];
  const operation = makeOperation(events, logger);
  await assert.rejects(() => operation.completeAuthorization(input),
    (error) => error && error.code === 'MICROSOFT_PHASE_B_OAUTH_OPERATION_COMPOSITION_INVALID');
  assert.deepEqual(events.map((event) => event.stage), expected, name);
  assert.equal(custodyCalls, 0, `${name}: zero custody/provider downstream work`);
  if (extraCheck) extraCheck();
  assertSafe(events);
}

(async () => {
  const received = ['token_request_started', 'token_response_received'];
  await rejectsAt('response status envelope', response({ statusCode: 500 }), received);
  await rejectsAt('response content-type envelope', response({ contentType: 'text/json' }), received);
  await rejectsAt('response body structure envelope', response({ body: 7 }), received);

  const hostileProxy = new Proxy(response(), {});
  await rejectsAt('transparent response proxy', hostileProxy, received);
  let getterCalls = 0;
  const hostileAccessor = response();
  Object.defineProperty(hostileAccessor, 'statusCode', { enumerable: true, get() { getterCalls += 1; throw new Error('PLANTED'); } });
  await rejectsAt('response accessor rejected without invocation', hostileAccessor, received, () => assert.equal(getterCalls, 0));

  const envelope = [...received, 'token_response_envelope_validated'];
  await rejectsAt('duplicate decoded JSON key', response({ body: `{"token_type":"Bearer","token\\u005ftype":"Bearer"}` }), envelope);
  await rejectsAt('JSON parse', response({ body: '{"token_type":' }), envelope);
  await rejectsAt('JSON object-key acceptance', response({ body: '{"__proto__":null}' }), envelope);

  const json = [...envelope, 'token_response_json_validated'];
  await rejectsAt('required token field shape', response({ body: tokenBody({ refresh_token: '' }) }), json);

  const fields = [...json, 'token_response_fields_validated'];
  const scopeCases = [
    ['invalid shape', 7, 'token_response_scope_rejected_invalid'],
    ['invalid spacing', 'User.Read  Mail.ReadWrite Mail.Send', 'token_response_scope_rejected_invalid'],
    ['duplicate', 'User.Read User.Read Mail.ReadWrite Mail.Send', 'token_response_scope_rejected_duplicate'],
    ['dangerous shared', 'User.Read Mail.ReadWrite Mail.Send Mail.Read.Shared', 'token_response_scope_rejected_dangerous'],
    ['dangerous broad', 'User.Read Mail.ReadWrite Mail.Send User.Read.All', 'token_response_scope_rejected_dangerous'],
    ['dangerous default', 'User.Read Mail.ReadWrite Mail.Send /.default', 'token_response_scope_rejected_dangerous'],
    ['dangerous application role', 'User.Read Mail.ReadWrite Mail.Send Application Role', 'token_response_scope_rejected_dangerous'],
    ['Phase A mixed', 'openid profile User.Read Mail.ReadBasic', 'token_response_scope_rejected_phase_a_mixed'],
    ['unknown', 'User.Read Mail.ReadWrite Mail.Send Calendars.Read', 'token_response_scope_rejected_unknown'],
    ['missing resource', 'openid profile User.Read Mail.ReadWrite', 'token_response_scope_rejected_missing_required'],
    ['overlap duplicate first', 'User.Read User.Read User.Read.All Mail.ReadBasic Unknown', 'token_response_scope_rejected_duplicate'],
    ['permuted Phase A first', 'Mail.Read Unknown User.Read', 'token_response_scope_rejected_phase_a_mixed'],
    ['permuted unknown first', 'Unknown Mail.Read User.Read', 'token_response_scope_rejected_unknown'],
  ];
  for (const [name, scope, stage] of scopeCases) {
    await rejectsAt(name, response({ body: tokenBody({ scope }) }), [...fields, stage]);
  }

  let loggerCalls = 0;
  await rejectsAt('logger throw preserves rejection and zero downstream',
    response({ body: tokenBody({ scope: 'User.Read User.Read Mail.Send' }) }), [],
    () => assert.equal(loggerCalls > 0, true), () => { loggerCalls += 1; throw new Error('PLANTED'); });

  custodyCalls = 0;
  nextResponse = response();
  const events = [];
  const ack = await makeOperation(events).completeAuthorization(input);
  assert.deepEqual(ack, { status: 'completed' });
  assert.equal(custodyCalls, 1);
  assert.deepEqual(events.map((event) => event.stage), [
    ...fields, 'token_response_scope_validated', 'token_response_validated',
  ]);
  assertSafe(events);
  console.log('PASS phase-b token validation sanitized sub-stage telemetry');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});

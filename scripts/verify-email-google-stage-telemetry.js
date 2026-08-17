'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { STAGES } = require('./lib/email-microsoft-oauth-stage-telemetry');
const { createGoogleStateFirstCallbackRuntime } = require('./lib/email-google-state-first-callback-runtime');
const { createGoogleTransactionCompletionFactory } = require('./lib/email-google-transaction-completion-factory');

const freeze = Object.freeze;
const EXPECTED = freeze([
  'google_consume_started', 'google_consume_returned', 'google_consume_matched',
  'google_authority_started', 'google_authority_returned', 'google_authority_matched',
  'google_factory_started', 'google_factory_returned',
  'google_provider_started', 'google_provider_returned',
  'google_exchange_started', 'google_exchange_returned',
]);
const IDS = freeze([
  'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', '99999999-8888-4777-8666-555555555555',
  '11111111-2222-4333-8444-555555555555', '66666666-7777-4888-8999-aaaaaaaaaaaa',
  'abcdef01-2345-4678-89ab-cdef01234567',
]);
const APP = '123-dummy.apps.googleusercontent.com';
const REDIRECT = 'https://sunset-staging.lunafrontdesk.com/staff/email/google/callback';
const REF = 'secret-ref:email/google/sunset-staging-oauth-client';
const PRIVATE = freeze(['dummy-code-never-log', 'V'.repeat(43), 'dummy-secret-never-log', 'private-query-never-log']);

function method(name, fn) { return freeze({ [name]: fn }); }
function telemetry(events) { return freeze({ emit(stage) { events.push(stage); } }); }

(async () => {
  for (const stage of EXPECTED) assert.ok(STAGES.includes(stage), `missing allowlisted stage ${stage}`);
  const events = []; let posts = 0;
  const response = new EventEmitter(); response.statusCode = 400; response.headers = { 'content-type': 'application/json' }; response.destroy = () => {};
  const request = new EventEmitter(); request.destroy = () => {}; request.end = () => {
    response.emit('data', Buffer.from('{"error":"invalid_grant"}')); response.emit('end');
  };
  const https = method('request', (options, callback) => { posts += 1; queueMicrotask(() => callback(response)); return request; });
  const factory = createGoogleTransactionCompletionFactory(freeze({
    https,
    crypto: freeze({ createPublicKey() { throw new Error('unused'); }, verify() { throw new Error('unused'); } }),
    timers: freeze({ setTimeout, clearTimeout }),
    envelopeProvider: freeze({ sealGrantPayload() { throw new Error('unused'); }, openGrantPayload() { throw new Error('unused'); }, rewrapGrantDek() { throw new Error('unused'); } }),
    clock: method('nowEpochSeconds', () => 1900000000),
    installer: method('installVerifiedGrant', () => { throw new Error('unused'); }),
    stageTelemetry: telemetry(events),
  }));
  const consumed = freeze({ clientId: IDS[0], authSessionId: IDS[1], operationId: IDS[1], locationId: IDS[2],
    endpointId: IDS[3], staffUserId: IDS[4], codeVerifier: PRIVATE[1], nonce: 'N'.repeat(43) });
  const runtime = createGoogleStateFirstCallbackRuntime(freeze({ tenantSlug: 'sunset', locationKey: 'sunset-somo',
    applicationClientId: APP, redirectUri: REDIRECT, callbackEnabled: true }), freeze({
    cryptography: method('sha256Ascii', () => Buffer.alloc(32)),
    clock: method('now', () => '2030-03-17T00:00:00.000Z'),
    repository: method('consume', () => consumed),
    endpointAuthorityResolver: method('resolveConsumedEndpointAuthority', () => freeze({ tenantSlug: 'sunset', clientId: IDS[0],
      locationKey: 'sunset-somo', locationId: IDS[2], endpointId: IDS[3], secretRef: REF })),
    transactionCompletionFactory: factory,
    secretProvider: method('resolveClientSecret', () => freeze({ clientSecret: PRIVATE[2] })),
    stageTelemetry: telemetry(events),
  }));
  const state = Buffer.alloc(32).toString('base64url');
  await assert.rejects(() => runtime.completeCallback(freeze({ query: `state=${state}&code=${encodeURIComponent(PRIVATE[0])}` })));
  assert.equal(posts, 1, `stopped after stages: ${events.join(',')}`);
  assert.deepEqual(events, EXPECTED.slice(0, -1));
  const rendered = JSON.stringify(events);
  for (const value of PRIVATE) assert.equal(rendered.includes(value), false);
  process.stdout.write('PASS verify:email-google-stage-telemetry (payload-free live-path stages)\n');
})().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });

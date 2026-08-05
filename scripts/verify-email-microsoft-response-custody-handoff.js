'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { FAILURE_CODE, createMicrosoftTokenResponseCustodyService } = require('./lib/email-microsoft-response-custody-handoff');

const SECRET = 'ACCESS_SECRET_NEVER_LEAK';
const REFRESH = 'REFRESH_SECRET_NEVER_LEAK';
const GOOD = { token_type: 'Bearer', expires_in: 3600, scope: 'openid profile offline_access User.Read Mail.ReadBasic', access_token: SECRET, refresh_token: REFRESH, id_token: 'discarded.id.token' };
function harness(spec, accept) {
  const incoming = new EventEmitter(); incoming.statusCode = spec.statusCode ?? 200;
  incoming.headers = { 'content-type': spec.contentType ?? 'application/json; charset=utf-8' };
  incoming.destroy = () => {};
  const request = new EventEmitter(); request.end = () => {
    queueMicrotask(() => { callback(incoming); incoming.emit('data', spec.body ?? JSON.stringify(GOOD)); incoming.emit('end'); });
  }; request.destroy = () => {};
  let callback;
  const httpsImpl = { request(_options, cb) { callback = cb; return request; } };
  const timers = { setTimeout() { return 1; }, clearTimeout() {} };
  return createMicrosoftTokenResponseCustodyService({ transportDeps: { httpsImpl, timers }, custody: { acceptValidatedTokens: accept } });
}
async function fails(spec, accept = async () => Object.freeze({ status: 'accepted' })) {
  try { await harness(spec, accept).exchangeAndCustody({ body: 'trusted=already-encoded' }); assert.fail('expected failure'); }
  catch (error) {
    assert.equal(error.code, FAILURE_CODE); assert.equal(error.message, FAILURE_CODE);
    assert.equal(JSON.stringify(error).includes(SECRET), false); assert.equal(JSON.stringify(error).includes(REFRESH), false);
  }
}
async function main() {
  const logged = []; const original = console.log; const originalError = console.error;
  console.log = console.error = (...args) => logged.push(args);
  try {
    await fails({ statusCode: 400, body: JSON.stringify({ error_description: `provider ${SECRET}` }) });
    await fails({ contentType: 'text/html', body: SECRET });
    await fails({ body: '{bad json ' + SECRET });
    for (const patch of [
      null, [], { token_type: 'bearer' }, { expires_in: 0 }, { expires_in: 1.5 },
      { access_token: '' }, { access_token: 'bad\ntoken' }, { refresh_token: '' },
      { scope: 'openid' }, { scope: 'openid Mail.Send' }, { scope: 'openid  profile' },
    ]) {
      const value = patch === null ? null : Array.isArray(patch) ? patch : { ...GOOD, ...patch };
      await fails({ body: JSON.stringify(value) });
    }
    const duplicateTailValid = JSON.stringify(GOOD).replace('"token_type":"Bearer"', '"token_type":"Basic","token_type":"Bearer"');
    const duplicateTailInvalid = JSON.stringify(GOOD).replace('"token_type":"Bearer"', '"token_type":"Bearer","token_type":"Basic"');
    await fails({ body: duplicateTailValid });
    await fails({ body: duplicateTailInvalid });
    let unknownSelected;
    const unknownResult = await harness({ body: JSON.stringify({ ...GOOD, client_info: 'opaque', future_extension: { nested: ['ignored'] } }) }, async (value) => {
      unknownSelected = value;
      return Object.freeze({ status: 'accepted' });
    }).exchangeAndCustody({ body: 'trusted=already-encoded' });
    assert.deepEqual(unknownResult, { status: 'custodied' });
    assert.equal(Object.hasOwn(unknownSelected, 'client_info'), false);
    assert.equal(Object.hasOwn(unknownSelected, 'future_extension'), false);
    for (const hostile of [
      new Proxy({}, { getPrototypeOf() { throw new Error('SECRET deps'); } }),
      new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('SECRET descriptor'); } }),
      { custody: new Proxy({}, { getPrototypeOf() { throw new Error('SECRET custody'); } }) },
    ]) {
      assert.throws(() => createMicrosoftTokenResponseCustodyService(hostile), (error) => error.code === FAILURE_CODE && !String(error).includes('SECRET'));
    }
    let thisBound = false;
    const boundAccept = async function boundAccept() {
      thisBound = this && this.acceptValidatedTokens === boundAccept;
      return Object.freeze({ status: 'accepted' });
    };
    await harness({}, boundAccept).exchangeAndCustody({ body: 'trusted=already-encoded' });
    assert.equal(thisBound, true);
    await fails({ body: JSON.stringify(GOOD) }, async () => { throw new Error(`custody leak ${REFRESH}`); });
    await fails({ body: JSON.stringify(GOOD) }, async () => ({ status: 'accepted' }));
    let selected;
    const service = harness({}, async (value) => { selected = value; return Object.freeze({ status: 'accepted' }); });
    const result = await service.exchangeAndCustody({ body: 'trusted=already-encoded' });
    assert.deepEqual(selected, { accessToken: SECRET, refreshToken: REFRESH, tokenType: 'Bearer', expiresIn: 3600, scope: GOOD.scope });
    assert.equal(Object.isFrozen(selected), true); assert.equal(Object.hasOwn(selected, 'idToken'), false);
    assert.deepEqual(result, { status: 'custodied' }); assert.equal(Object.isFrozen(result), true);
    await assert.rejects(service.exchangeAndCustody({ body: 'again=x' }), (error) => error.code === FAILURE_CODE);
    assert.deepEqual(logged, []);
  } finally { console.log = original; console.error = originalError; }
  original('verify:email-microsoft-response-custody-handoff: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

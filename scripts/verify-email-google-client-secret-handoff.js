'use strict';

/**
 * RED-only offline contract for the narrow Google client-secret handoff owner.
 * The production module is intentionally absent. No environment, database, route,
 * network, SDK, deployment, live credential, logging, or send capability exists here.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');

// Authentic RED: GREEN must provide this sole typed handoff owner.
const owner = require('./lib/email-google-client-secret-handoff');
const { createGoogleClientSecretHandoff } = owner;

const REF = 'secret-ref:email/google/oauth-client';
const CODE = '4/0A+GOOGLE_CODE_NEVER_LOG';
const VERIFIER = `${'V'.repeat(41)}-._~`;
const SECRET = 'GOOGLE_CLIENT_SECRET_NEVER_LOG+/%?=&!';
const LEAK = 'HOSTILE_HANDOFF_VALUE_NEVER_LOG';
const ACK = Object.freeze({ status: 'custodied' });
const freeze = Object.freeze;

function config(patch = {}) { return freeze({ secretRef: REF, ...patch }); }
function input(patch = {}) { return freeze({ authorizationCode: CODE, codeVerifier: VERIFIER, ...patch }); }
function provider(fn = function resolveClientSecret() { return freeze({ clientSecret: SECRET }); }) {
  return freeze({ resolveClientSecret: fn });
}
function operation(fn = function exchangeAuthorizationCode() { return ACK; }) {
  return freeze({ exchangeAuthorizationCode: fn });
}
function deps(secretProvider = provider(), operationOwner = operation()) {
  return freeze({ secretProvider, operation: operationOwner });
}
function create(secretProvider, operationOwner, cfg = config()) {
  return createGoogleClientSecretHandoff(cfg, deps(secretProvider, operationOwner));
}
function assertClean(error) {
  assert.equal(error.name, 'GoogleClientSecretHandoffError');
  assert.equal(error.code, 'GOOGLE_CLIENT_SECRET_HANDOFF_FAILED');
  assert.equal(error.message, 'GOOGLE_CLIENT_SECRET_HANDOFF_FAILED');
  assert.equal(Object.isFrozen(error), true);
  assert.deepEqual(Object.keys(error), ['code']);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  const rendered = `${error}\n${error.stack || ''}\n${JSON.stringify(error)}`;
  for (const value of [CODE, VERIFIER, SECRET, LEAK]) assert.equal(rendered.includes(value), false);
  return true;
}
async function rejects(action) { await assert.rejects(Promise.resolve().then(action), assertClean); }
const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('exports only the frozen factory and constructs exact frozen one-shot surface without effects', async () => {
  let providerCalls = 0; let operationCalls = 0;
  const service = create(provider(() => { providerCalls += 1; return freeze({ clientSecret: SECRET }); }),
    operation(() => { operationCalls += 1; return ACK; }));
  assert.equal(Object.isFrozen(owner), true);
  assert.deepEqual(Reflect.ownKeys(owner), ['createGoogleClientSecretHandoff']);
  assert.equal(Object.isFrozen(service), true);
  assert.deepEqual(Reflect.ownKeys(service), ['completeAuthorization']);
  await Promise.resolve(); assert.equal(providerCalls, 0); assert.equal(operationCalls, 0);
});

test('resolves the exact secret reference then hands exact typed DTO to operation and returns ack identity', async () => {
  const calls = [];
  const secretProvider = provider(function resolveClientSecret(dto) {
    calls.push({ stage: 'provider', dto, receiver: this }); return freeze({ clientSecret: SECRET });
  });
  const operationOwner = operation(function exchangeAuthorizationCode(dto) {
    calls.push({ stage: 'operation', dto, receiver: this }); return ACK;
  });
  const result = await create(secretProvider, operationOwner).completeAuthorization(input());
  assert.strictEqual(result, ACK); assert.deepEqual(calls.map(x => x.stage), ['provider', 'operation']);
  assert.strictEqual(calls[0].receiver, secretProvider); assert.strictEqual(calls[1].receiver, operationOwner);
  assert.equal(Object.isFrozen(calls[0].dto), true); assert.deepEqual(Reflect.ownKeys(calls[0].dto), ['secretRef']);
  assert.deepEqual(calls[0].dto, { secretRef: REF });
  assert.equal(Object.isFrozen(calls[1].dto), true);
  assert.deepEqual(Reflect.ownKeys(calls[1].dto), ['authorizationCode', 'codeVerifier', 'clientSecret']);
  assert.deepEqual(calls[1].dto, { authorizationCode: CODE, codeVerifier: VERIFIER, clientSecret: SECRET });
  assert.equal('clientSecret' in input(), false); assert.equal('secretRef' in result, false); assert.equal('clientSecret' in result, false);
});

test('accepts genuine native promise outputs while preserving the final acknowledgement identity', async () => {
  const service = create(provider(() => Promise.resolve(freeze({ clientSecret: SECRET }))),
    operation(() => Promise.resolve(ACK)));
  assert.strictEqual(await service.completeAuthorization(input()), ACK);
});

test('requires exact frozen ordered canonical secret-ref configuration', async () => {
  const good = config(); const bad = [undefined, null, {}, { ...good }, freeze({ ...good, extra: true }),
    freeze({ secretRef: 'KV:email/google' }), freeze({ secretRef: SECRET }),
    freeze(Object.assign(Object.create(null), good)), freeze({ secretRef: REF, [Symbol('x')]: true }),
    new Proxy(good, { ownKeys() { throw new Error(LEAK); } })];
  const accessor = {}; Object.defineProperty(accessor, 'secretRef', { enumerable: true, get() { throw new Error(LEAK); } }); freeze(accessor); bad.push(accessor);
  for (const cfg of bad) assert.throws(() => createGoogleClientSecretHandoff(cfg, deps()), assertClean);
});

test('requires exact frozen ordered dependency and nested provider/operation owners', async () => {
  const p = provider(); const o = operation(); const good = deps(p, o);
  const bad = [undefined, null, {}, { ...good }, freeze({ ...good, extra: true }),
    freeze({ operation: o, secretProvider: p }), freeze({ secretProvider: freeze({ resolveClientSecret() {}, extra: true }), operation: o }),
    freeze({ secretProvider: p, operation: freeze({ exchangeAuthorizationCode() {}, extra: true }) }),
    freeze({ secretProvider: { resolveClientSecret() {} }, operation: o }),
    freeze(Object.assign(Object.create(null), good)), new Proxy(good, { getPrototypeOf() { throw new Error(LEAK); } })];
  for (const value of bad) assert.throws(() => createGoogleClientSecretHandoff(config(), value), assertClean);
});

test('pins dependency functions and receivers and defeats function-owned call/apply', async () => {
  let pCalls = 0; let oCalls = 0; let traps = 0; let pThis; let oThis;
  function resolve() { pCalls += 1; pThis = this; return freeze({ clientSecret: SECRET }); }
  function exchange() { oCalls += 1; oThis = this; return ACK; }
  Object.defineProperties(resolve, { call: { value() { traps += 1; } }, apply: { value() { traps += 1; } } });
  Object.defineProperties(exchange, { call: { value() { traps += 1; } }, apply: { value() { traps += 1; } } });
  const p = provider(resolve); const o = operation(exchange); await create(p, o).completeAuthorization(input());
  assert.equal(pCalls, 1); assert.equal(oCalls, 1); assert.equal(traps, 0); assert.strictEqual(pThis, p); assert.strictEqual(oThis, o);
});

test('burns before hostile input reflection and permanently rejects reuse', async () => {
  let calls = 0; const service = create(provider(() => { calls += 1; return freeze({ clientSecret: SECRET }); }));
  const hostile = new Proxy(input(), { getPrototypeOf() { throw new Error(`${LEAK}:${SECRET}`); } });
  await rejects(() => service.completeAuthorization(hostile));
  await rejects(() => service.completeAuthorization(input())); assert.equal(calls, 0);
});

test('requires exact frozen ordered input and downstream-compatible bounds without client secret', async () => {
  const bad = [undefined, null, {}, { ...input() }, freeze({ ...input(), extra: true }),
    freeze({ codeVerifier: VERIFIER, authorizationCode: CODE }), freeze(Object.assign(Object.create(null), input())),
    freeze({ authorizationCode: CODE, codeVerifier: VERIFIER, [Symbol('x')]: true }),
    input({ authorizationCode: '' }), input({ authorizationCode: 'a'.repeat(8193) }), input({ authorizationCode: 'bad\n' }),
    input({ codeVerifier: 'A'.repeat(42) }), input({ codeVerifier: 'A'.repeat(129) }), input({ codeVerifier: `${'A'.repeat(42)}+` })];
  for (const value of bad) { let calls = 0; await rejects(() => create(provider(() => { calls += 1; return freeze({ clientSecret: SECRET }); })).completeAuthorization(value)); assert.equal(calls, 0); }
  await create().completeAuthorization(input({ authorizationCode: 'a'.repeat(8192), codeVerifier: `${'A'.repeat(124)}-._~` }));
});

test('rejects malformed provider output and validates visible ASCII secret length 1..4096 before operation', async () => {
  const malformed = [undefined, null, {}, { clientSecret: SECRET }, freeze({ clientSecret: SECRET, extra: true }),
    freeze(Object.assign(Object.create(null), { clientSecret: SECRET })), freeze({ clientSecret: '' }),
    freeze({ clientSecret: 'bad\n' }), freeze({ clientSecret: 'é' }), freeze({ clientSecret: 'x'.repeat(4097) })];
  for (const value of malformed) { let calls = 0; await rejects(() => create(provider(() => value), operation(() => { calls += 1; return ACK; })).completeAuthorization(input())); assert.equal(calls, 0); }
  await create(provider(() => freeze({ clientSecret: 'x'.repeat(4096) }))).completeAuthorization(input());
});

test('rejects custom/proxy/spoof thenables from both children without invoking then', async () => {
  let invoked = 0;
  function specimens() {
    return [freeze({ then() { invoked += 1; } }),
      new Proxy({ then() { invoked += 1; } }, { getPrototypeOf() { return Promise.prototype; } })];
  }
  for (const value of specimens()) await rejects(() => create(provider(() => value)).completeAuthorization(input()));
  for (const value of specimens()) await rejects(() => create(provider(), operation(() => value)).completeAuthorization(input()));
  assert.equal(invoked, 0);
});

test('pins reflection and freezing intrinsics across hostile child execution', async () => {
  const saved = {
    freeze: Object.freeze,
    isFrozen: Object.isFrozen,
    getPrototypeOf: Object.getPrototypeOf,
    getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
    hasOwn: Object.hasOwn,
    create: Object.create,
    ownKeys: Reflect.ownKeys,
    regexTest: RegExp.prototype.test,
  };
  let operationDto; let result;
  const poison = () => {
    Object.freeze = value => value;
    Object.isFrozen = () => false;
    Object.getPrototypeOf = () => { throw new Error(LEAK); };
    Object.getOwnPropertyDescriptor = () => { throw new Error(LEAK); };
    Object.hasOwn = () => false;
    Object.create = () => { throw new Error(LEAK); };
    Reflect.ownKeys = () => { throw new Error(LEAK); };
    RegExp.prototype.test = () => { throw new Error(LEAK); };
  };
  try {
    const p = provider(() => { const output = saved.freeze({ clientSecret: SECRET }); poison(); return output; });
    const o = operation(dto => { operationDto = dto; poison(); return ACK; });
    result = await create(p, o).completeAuthorization(input());
  } finally {
    Object.freeze = saved.freeze;
    Object.isFrozen = saved.isFrozen;
    Object.getPrototypeOf = saved.getPrototypeOf;
    Object.getOwnPropertyDescriptor = saved.getOwnPropertyDescriptor;
    Object.hasOwn = saved.hasOwn;
    Object.create = saved.create;
    Reflect.ownKeys = saved.ownKeys;
    RegExp.prototype.test = saved.regexTest;
  }
  assert.strictEqual(result, ACK);
  assert.equal(saved.isFrozen(operationDto), true);
  assert.deepEqual(saved.ownKeys(operationDto), ['authorizationCode', 'codeVerifier', 'clientSecret']);
});

test('requires exact frozen custodied acknowledgement and masks operation ambiguity', async () => {
  const malformed = [undefined, null, {}, { status: 'custodied' }, freeze({ status: 'wrong' }),
    freeze({ status: 'custodied', extra: true }), freeze(Object.assign(Object.create(null), { status: 'custodied' })),
    freeze({ then() { throw new Error(LEAK); } })];
  for (const value of malformed) await rejects(() => create(provider(), operation(() => value)).completeAuthorization(input()));
});

test('sanitizes sync/async child failures, emits no logs, and never retries either child', async () => {
  const originals = [console.log, console.info, console.warn, console.error]; const logs = [];
  [console.log, console.info, console.warn, console.error] = originals.map(() => (...args) => logs.push(args));
  try {
    for (const [p, o] of [[provider(() => { throw new Error(`${LEAK}:${SECRET}`); }), operation()],
      [provider(() => Promise.reject(new Error(`${LEAK}:${SECRET}`))), operation()],
      [provider(), operation(() => { throw new Error(`${LEAK}:${SECRET}`); })],
      [provider(), operation(() => Promise.reject(new Error(`${LEAK}:${SECRET}`)))]]) {
      await rejects(() => create(p, o).completeAuthorization(input()));
    }
    assert.deepEqual(logs, []);
  } finally { [console.log, console.info, console.warn, console.error] = originals; }
});

test('rejects concurrent and reentrant calls while invoking provider and operation at most once', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let pCalls = 0; let oCalls = 0; let service;
  const p = provider(async () => { pCalls += 1; await rejects(() => service.completeAuthorization(input())); await gate; return freeze({ clientSecret: SECRET }); });
  const o = operation(() => { oCalls += 1; return ACK; }); service = create(p, o);
  const first = service.completeAuthorization(input()); await rejects(() => service.completeAuthorization(input())); release();
  assert.strictEqual(await first, ACK); assert.equal(pCalls, 1); assert.equal(oCalls, 1);
});

test('structurally imports only the canonical mailbox secret-ref validator and no ambient capability', async () => {
  const source = fs.readFileSync(require.resolve('./lib/email-google-client-secret-handoff'), 'utf8');
  const imports = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1]);
  assert.deepEqual(imports, ['./email-mailbox-adapter-contract']);
  assert.match(source, /validateEmailMailboxSecretRef/);
  for (const forbidden of [/email-secret-provider-contract/, /sunset-microsoft-oauth-provider/, /process\.env/,
    /node:https|googleapis|@googleapis\//, /\b(?:database|postgres|sql|router|route|express|deploy|credential)\b/i,
    /console\.(?:log|info|warn|error)/, /\bfetch\s*\(/]) assert.equal(forbidden.test(source), false, `${forbidden}`);
});

(async () => {
  for (const { name, run } of tests) { await run(); process.stdout.write(`ok - ${name}\n`); }
  assert.equal(tests.length, 15);
  process.stdout.write('PASS verify:email-google-client-secret-handoff (15 named offline tests)\n');
})().catch(error => { process.stderr.write(`${error && error.stack ? error.stack : error}\n`); process.exitCode = 1; });
